import { describe, expect, it, vi } from 'vitest'
import { CaptureAddonLoadError } from '../../src/main/capture'
import {
  classifyAddonLoadFailure, enforceAddonStartupGate, type AddonStartupGateDeps
} from '../../src/main/addon-startup-gate'

const mismatch = () => new CaptureAddonLoadError('older or different checkout', true,
  'provenance-mismatch', { checkout: 'aaa', addon: 'bbb' })
const missing = () => new CaptureAddonLoadError('metadata is not available', true, 'metadata-missing')
const other = () => new CaptureAddonLoadError('Could not load singz-capture.node (ABI)', true)

describe('classifyAddonLoadFailure', () => {
  it('blocks a dev provenance mismatch and missing metadata', () => {
    expect(classifyAddonLoadFailure(mismatch(), false)).toEqual({ action: 'block-dev', kind: 'provenance-mismatch' })
    expect(classifyAddonLoadFailure(missing(), false)).toEqual({ action: 'block-dev', kind: 'metadata-missing' })
  })
  it('treats the same failures in a packaged build as a corrupt install', () => {
    expect(classifyAddonLoadFailure(mismatch(), true).action).toBe('block-corrupt-install')
    expect(classifyAddonLoadFailure(missing(), true).action).toBe('block-corrupt-install')
  })
  it('leaves every other failure alone (negative control)', () => {
    for (const packaged of [false, true]) {
      expect(classifyAddonLoadFailure(other(), packaged).action).toBe('continue')
      expect(classifyAddonLoadFailure(new Error('older or different checkout'), packaged).action).toBe('continue')
      expect(classifyAddonLoadFailure(null, packaged).action).toBe('continue')
    }
  })
})

function gate(error: unknown, over: { packaged?: boolean; env?: Record<string, string> } = {}) {
  const app = { isPackaged: over.packaged ?? false, exit: vi.fn() }
  const dialog = { showErrorBox: vi.fn() }
  const stderr = vi.fn()
  const log = vi.fn()
  const deps: AddonStartupGateDeps = {
    check: () => { if (error) throw error }, app, dialog, env: over.env ?? {}, log, stderr, target: 'darwin-arm64'
  }
  return { proceed: enforceAddonStartupGate(deps), app, dialog, stderr, log }
}

describe('enforceAddonStartupGate', () => {
  it('proceeds without side effects when the addon matches', () => {
    const r = gate(null)
    expect(r.proceed).toBe(true)
    expect(r.dialog.showErrorBox).not.toHaveBeenCalled()
    expect(r.app.exit).not.toHaveBeenCalled()
  })
  it('shows one dialog with the fix command and fingerprints, then exits non-zero', () => {
    const r = gate(mismatch())
    expect(r.proceed).toBe(false)
    expect(r.dialog.showErrorBox).toHaveBeenCalledTimes(1)
    const body = r.dialog.showErrorBox.mock.calls[0][1] as string
    expect(body).toContain('npm run capture:addon -- darwin-arm64, then restart')
    expect(body).toContain('aaa')
    expect(body).toContain('bbb')
    expect(body).not.toMatch(/\bat .*:\d+/)
    expect(r.app.exit).toHaveBeenCalledTimes(1)
    expect(r.app.exit.mock.calls[0][0]).not.toBe(0)
    expect(r.log).toHaveBeenCalledWith(expect.stringContaining('provenance-mismatch'), 'error')
  })
  it('blocks on missing dev metadata', () => {
    expect(gate(missing()).proceed).toBe(false)
  })
  it('headless runs skip the dialog, write the reason to stderr and exit 1', () => {
    const r = gate(mismatch(), { env: { SINGZ_E2E_HIDDEN: '1' } })
    expect(r.proceed).toBe(false)
    expect(r.dialog.showErrorBox).not.toHaveBeenCalled()
    expect(r.stderr).toHaveBeenCalledWith(expect.stringContaining('older or different checkout'))
    expect(r.app.exit).toHaveBeenCalledWith(1)
  })
  it('honours SINGZ_ALLOW_STALE_ADDON=1 in development only', () => {
    const dev = gate(mismatch(), { env: { SINGZ_ALLOW_STALE_ADDON: '1' } })
    expect(dev.proceed).toBe(true)
    expect(dev.app.exit).not.toHaveBeenCalled()
    expect(dev.log).toHaveBeenCalledWith(expect.stringContaining('SINGZ_ALLOW_STALE_ADDON'), 'warn')
    const packaged = gate(mismatch(), { packaged: true, env: { SINGZ_ALLOW_STALE_ADDON: '1' } })
    expect(packaged.proceed).toBe(false)
    expect(packaged.app.exit).toHaveBeenCalledWith(1)
    // only the exact value 1 opts out
    expect(gate(mismatch(), { env: { SINGZ_ALLOW_STALE_ADDON: '0' } }).proceed).toBe(false)
  })
  it('packaged mismatch shows the reinstall message, not the rebuild command', () => {
    const r = gate(mismatch(), { packaged: true })
    const body = r.dialog.showErrorBox.mock.calls[0][1] as string
    expect(body).toContain('Reinstall SingZ')
    expect(body).not.toContain('npm run capture:addon -- darwin')
  })
  it('does not block or exit on other load failures', () => {
    const r = gate(other())
    expect(r.proceed).toBe(true)
    expect(r.dialog.showErrorBox).not.toHaveBeenCalled()
    expect(r.app.exit).not.toHaveBeenCalled()
  })
})

import {
  checkCaptureAddonProvenance, developmentSourceFingerprint, readCaptureManifestForGate
} from '../../src/main/capture'

const errno = (code: string) => Object.assign(new Error(code), { code })

describe('what may gate startup (false refusal of a healthy app is worse)', () => {
  const read = (e: unknown) => () => readCaptureManifestForGate('/x/current.json', () => { throw e })
  it('gates a manifest that is absent or not JSON', () => {
    for (const e of [errno('ENOENT'), new SyntaxError('bad json')])
      expect(read(e)).toThrow(expect.objectContaining({ kind: 'metadata-missing' }))
  })
  it('does not gate other manifest read errors', () => {
    for (const code of ['EIO', 'EBUSY', 'EACCES']) {
      try { read(errno(code))(); throw new Error('no throw') }
      catch (e) { expect(e).not.toBeInstanceOf(CaptureAddonLoadError) }
    }
  })
  it('does not gate EIO / ENOENT-on-a-source-file / EBUSY during the fingerprint walk, and retries once', () => {
    for (const code of ['EIO', 'ENOENT', 'EBUSY']) {
      let calls = 0
      const flaky = () => { if (calls++ === 0) throw errno(code); return 'a'.repeat(40) }
      expect(developmentSourceFingerprint(`/r-${code}`, 'e', flaky, {})).toBe('a'.repeat(40))
      expect(calls).toBe(2)
      const dead = () => { throw errno(code) }
      let thrown: unknown
      try { developmentSourceFingerprint(`/d-${code}`, 'e', dead, {}) } catch (e) { thrown = e }
      expect(thrown).toBeInstanceOf(Error)
      expect(classifyAddonLoadFailure(thrown, false).action).toBe('continue')
    }
  })
  it('negative control: the old catch-all would have gated these', () => {
    const oldCatchAll = (e: unknown) => new CaptureAddonLoadError(String(e), true, 'metadata-missing')
    expect(classifyAddonLoadFailure(oldCatchAll(errno('EIO')), false).action).toBe('block-dev')
    expect(classifyAddonLoadFailure(errno('EIO'), false).action).toBe('continue')
  })
  it('reuses one walk per launch, including via the inherited env', () => {
    let calls = 0
    const compute = () => { calls++; return 'b'.repeat(40) }
    developmentSourceFingerprint('/once', 'e', compute, {})
    developmentSourceFingerprint('/once', 'e', compute, {})
    expect(calls).toBe(1)
    const child = { SINGZ_AUDIO_PROCESS: '1', SINGZ_AUDIO_PACKAGED: '0', SINGZ_VERIFIED_SOURCE_STAMP: `/child\ne\n${'c'.repeat(40)}` }
    expect(developmentSourceFingerprint('/child', 'e', compute, child)).toBe('c'.repeat(40))
    expect(calls).toBe(1)
  })
  it('only the dev audio process honours an inherited stamp, and only a 40-hex one', () => {
    const stamp = (v: string) => `/h\ne\n${v}`
    const cases: [string, Record<string, string>][] = [
      ['main ignores it', { SINGZ_VERIFIED_SOURCE_STAMP: stamp('c'.repeat(40)) }],
      ['packaged ignores it', { SINGZ_AUDIO_PROCESS: '1', SINGZ_AUDIO_PACKAGED: '1', SINGZ_VERIFIED_SOURCE_STAMP: stamp('c'.repeat(40)) }],
      ['malformed ignored', { SINGZ_AUDIO_PROCESS: '1', SINGZ_AUDIO_PACKAGED: '0', SINGZ_VERIFIED_SOURCE_STAMP: stamp('xyz') }],
      ['uppercase/short ignored', { SINGZ_AUDIO_PROCESS: '1', SINGZ_AUDIO_PACKAGED: '0', SINGZ_VERIFIED_SOURCE_STAMP: stamp('C'.repeat(39)) }]
    ]
    for (const [i, [name, env]] of cases.entries()) {
      let calls = 0
      const root = `/h${i}`
      const e = { ...env, SINGZ_VERIFIED_SOURCE_STAMP: env.SINGZ_VERIFIED_SOURCE_STAMP.replace('/h', root) }
      expect(developmentSourceFingerprint(root, 'e', () => { calls++; return 'd'.repeat(40) }, e), name).toBe('d'.repeat(40))
      expect(calls, name).toBe(1)
    }
  })
  it('checkCaptureAddonProvenance is exported for the gate', () => {
    expect(typeof checkCaptureAddonProvenance).toBe('function')
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configureBoxAudioHostProfile, withBoxAudioHostAuthority, type BoxAudioHostAuthority } from '../../src/main/box-audio/profile'
import { loadBoxAudioHostBinding, loadCaptureBinding, CaptureAddonLoadError } from '../../src/main/capture'

const originalProcess = process
afterEach(() => vi.unstubAllGlobals())
function role(type: string, argv = ['electron', '--box-audio-host'], extra: Record<string, unknown> = {}): void {
  vi.stubGlobal('process', { ...originalProcess, type, argv, parentPort: undefined, ...extra })
}
describe('native headless host authority', () => {
  it('admits only a profile-established locked browser host capability and preserves the Desktop gate', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'box-authority-'))
    const paths = new Map<string, string>()
    let lock = true
    const app = {
      setName: () => {}, getPath: (name: string) => paths.get(name) ?? directory,
      setPath: (name: string, path: string) => { paths.set(name, path) },
      requestSingleInstanceLock: () => lock, hasSingleInstanceLock: () => lock
    }
    const load = vi.fn(() => 'strict artifact resolver reached')
    try {
      role('browser')
      const authority = configureBoxAudioHostProfile(app, {})!
      expect(withBoxAudioHostAuthority(authority, load)).toBe('strict artifact resolver reached')
      expect(load).toHaveBeenCalledTimes(1)
      role('browser', ['electron', '--box-audio-host'], { env: { ...originalProcess.env, SINGZ_CAPTURE_ADDON: join(directory, 'missing.node') } })
      // Legitimate authority reaches the same strict resolver; missing immutable
      // metadata is still rejected before any native module can initialize.
      expect(() => loadBoxAudioHostBinding(authority)).toThrow(CaptureAddonLoadError)
      expect(() => loadCaptureBinding()).toThrow('dedicated audio process')
      expect(() => loadBoxAudioHostBinding({} as BoxAudioHostAuthority)).toThrow('profile authority')
      expect(() => withBoxAudioHostAuthority({ ...authority }, load)).toThrow('profile authority')
      role('browser', ['electron'])
      expect(() => withBoxAudioHostAuthority(authority, load)).toThrow('profile authority')
      role('utility')
      expect(() => withBoxAudioHostAuthority(authority, load)).toThrow('profile authority')
      role('browser')
      paths.set('userData', directory)
      expect(() => withBoxAudioHostAuthority(authority, load)).toThrow('profile authority')
      paths.set('userData', paths.get('sessionData')!)
      lock = false
      expect(() => withBoxAudioHostAuthority(authority, load)).toThrow('profile authority')
      expect(configureBoxAudioHostProfile(app, {})).toBeNull()
      expect(load).toHaveBeenCalledTimes(1)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  it('retains the utility-process loading path with its existing parent-port requirement', () => {
    role('utility', ['electron'], {
      parentPort: {}, env: { ...originalProcess.env, SINGZ_AUDIO_PROCESS: '1', SINGZ_CAPTURE_ADDON: '/missing-box-authority-test.node' }
    })
    // The role is admitted, then immutable artifact resolution fails normally.
    expect(() => loadCaptureBinding()).toThrow(CaptureAddonLoadError)
  })
  it('does not convert an environment flag into either native loading authority', () => {
    role('browser', ['electron', '--box-audio-host'], { env: { ...originalProcess.env, SINGZ_AUDIO_PROCESS: '1' } })
    expect(() => loadCaptureBinding()).toThrow('dedicated audio process')
    expect(() => loadBoxAudioHostBinding(null as unknown as BoxAudioHostAuthority)).toThrow('profile authority')
  })
})

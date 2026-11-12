import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  NATIVE_HANDOVER_MAX_BYTES,
  buildNativeHandover,
  compareSemver,
  nativeOfferEnabled,
  nativeTarget,
  pickNativeOffer,
  type NativeHandoverReport
} from '../../src/shared/native-handover'
import { writeNativeHandover } from '../../src/main/native-handover-file'

const dirs: string[] = []
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'singz-handover-')); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

/** Device ids match native's migrate_tests inventory ("mic", "speaker"). */
const REPORT: NativeHandoverReport = {
  audio: {
    outputId: 'chromium-hash', inputId: 'chromium-input', nativeInputUid: 'mic', inputChannel: 1,
    nativeMonitorOutputUid: 'speaker', nativeMonitorOutputChannels: [1, 0], monitorGainDb: -12,
    trainingSound: 'guitar', referenceVolume: 0.8, nativePlayback: true
  },
  metronome: { click: true, countInBars: 1, volume: 0.4, accent: false, grid: true },
  karaoke: true,
  trainingPractice: { pitchWindowCents: 15 },
  trainingProgram: { level: 'developing', startedAt: 1700000000000 }
}

describe('native handover export contract', () => {
  it('maps renderer preferences to the C-44 contract and drops what native must not read', () => {
    expect(buildNativeHandover(REPORT)).toEqual({
      formatVersion: 1,
      product: 'desktop',
      audio: { nativeInputUid: 'mic', inputChannel: 1, nativeMonitorOutputUid: 'speaker', nativeMonitorOutputChannels: [1, 0], monitorGainDb: -12 },
      metronome: { click: true, countInBars: 1, volume: 0.4, accent: false, grid: true },
      karaoke: true,
      trainingControls: { formatVersion: 1, sound: 2, volume: 0.8, tolerance: 2, focus: 0, program: { level: 1, startedAt: 1700000000000 } }
    })
  })
  it('never relabels a Chromium id as native and only passes Linux native: outputs', () => {
    const plain = buildNativeHandover({ audio: { outputId: 'chromium-hash', inputId: 'x' } }) as { audio?: unknown }
    expect(plain.audio).toBeUndefined()
    const linux = buildNativeHandover({ audio: { outputId: 'native:alsa-1' } }) as { audio?: Record<string, unknown> }
    expect(linux.audio).toEqual({ outputId: 'native:alsa-1' })
    expect(JSON.stringify(buildNativeHandover(REPORT))).not.toMatch(/nativeOutputUid|chromium|nativePlayback/)
  })
  it('omits invalid items so native records them as skipped, and still exports complete controls', () => {
    const doc = buildNativeHandover({
      audio: { nativeMonitorOutputUid: 'speaker', nativeMonitorOutputChannels: [1, 1], monitorGainDb: 6 },
      metronome: { click: true, countInBars: 3, volume: 0.4, accent: true, grid: false },
      karaoke: 'yes', trainingProgram: { level: 'expert', startedAt: 1 }
    }) as Record<string, unknown>
    expect(doc).toEqual({
      formatVersion: 1, product: 'desktop',
      trainingControls: { formatVersion: 1, sound: 0, volume: 0.65, tolerance: 1, focus: 0, program: null }
    })
  })
  it('writes atomically in the profile, leaves no temp file, and replaces the old export', () => {
    const dir = tmp()
    expect(writeNativeHandover(dir, REPORT)).toEqual({ ok: true, path: join(dir, 'native-handover.json') })
    expect(readdirSync(dir)).toEqual(['native-handover.json'])
    expect(JSON.parse(readFileSync(join(dir, 'native-handover.json'), 'utf8'))).toEqual(buildNativeHandover(REPORT))
    expect(statSync(join(dir, 'native-handover.json')).size).toBeLessThan(NATIVE_HANDOVER_MAX_BYTES)
    if (process.platform !== 'win32') expect(statSync(join(dir, 'native-handover.json')).mode & 0o777).toBe(0o600)
    writeNativeHandover(dir, { karaoke: false })
    expect(JSON.parse(readFileSync(join(dir, 'native-handover.json'), 'utf8')).karaoke).toBe(false)
  })
  it('keeps the old export and no temp file when publishing fails', () => {
    const dir = tmp()
    mkdirSync(join(dir, 'native-handover.json')) // a rename over a directory fails
    const result = writeNativeHandover(dir, REPORT)
    expect(result.ok).toBe(false)
    expect(readdirSync(dir)).toEqual(['native-handover.json'])
  })
  // Round trip: the committed fixture is what native's reader test consumes
  // (experiments/gpui-player/src/migrate_tests.rs reads it). It must be exactly
  // what this writer produces; regenerate with UPDATE_HANDOVER_FIXTURE=1.
  it('produces the fixture native imports', () => {
    const dir = tmp()
    writeNativeHandover(dir, REPORT)
    const produced = readFileSync(join(dir, 'native-handover.json'), 'utf8')
    const fixture = join(__dirname, '../../experiments/gpui-player/tests/fixtures/electron-native-handover.json')
    if (process.env.UPDATE_HANDOVER_FIXTURE === '1') { mkdirSync(dirname(fixture), { recursive: true }); writeFileSync(fixture, produced) }
    expect(existsSync(fixture)).toBe(true)
    expect(readFileSync(fixture, 'utf8')).toBe(produced)
  })
})

describe('native offer', () => {
  const asset = (name: string): { name: string } => ({ name })
  const url = (tag: string): string => `https://github.com/lexasoft123/SingZ/releases/tag/${tag}`
  const releases = [
    { tag_name: 'v0.26.0', html_url: url('v0.26.0'), prerelease: false, assets: [asset('SingZ.dmg')] },
    { tag_name: 'v0.27.0-beta.2', html_url: url('v0.27.0-beta.2'), prerelease: true, assets: [asset('singz-native-macos-arm64.update.json')] },
    { tag_name: 'v0.27.0-beta.10', html_url: url('v0.27.0-beta.10'), prerelease: true, assets: [asset('singz-native-macos-arm64.update.json')] }
  ]
  it('is off unless enabled, and never on the Box surface', () => {
    expect(nativeOfferEnabled('desktop', {})).toBe(false)
    expect(nativeOfferEnabled('desktop', { SINGZ_NATIVE_OFFER: '1' })).toBe(true)
    expect(nativeOfferEnabled('desktop', {}, true)).toBe(true)
    expect(nativeOfferEnabled('desktop', { SINGZ_NATIVE_OFFER: '0' }, true)).toBe(false)
    expect(nativeOfferEnabled('box', { SINGZ_NATIVE_OFFER: '1' }, true)).toBe(false)
  })
  it('offers the highest release carrying this platform manifest; prerelease only is the quiet beta entry', () => {
    expect(pickNativeOffer(releases, 'macos-arm64')).toEqual({ available: true, channel: 'beta', version: '0.27.0-beta.10', url: url('v0.27.0-beta.10') })
    expect(pickNativeOffer(releases, 'windows-x64')).toEqual({ available: false })
    expect(pickNativeOffer(releases, nativeTarget('linux', 'x64'))).toEqual({ available: false })
  })
  it('a stable release carrying native turns the offer into the stable chip', () => {
    const stable = { tag_name: 'v0.27.0', html_url: url('v0.27.0'), prerelease: false, assets: [asset('singz-native-macos-arm64.update.json')] }
    expect(pickNativeOffer([...releases, stable], 'macos-arm64')).toMatchObject({ channel: 'stable', version: '0.27.0' })
  })
  it('ignores drafts and release pages outside the SingZ repository', () => {
    const rel = (extra: object) => ({ tag_name: 'v0.28.0', html_url: url('v0.28.0'), assets: [asset('singz-native-macos-arm64.update.json')], ...extra })
    expect(pickNativeOffer([rel({ draft: true })], 'macos-arm64').available).toBe(false)
    expect(pickNativeOffer([rel({ html_url: 'https://evil.example/x' })], 'macos-arm64').available).toBe(false)
  })
  it('opens the platform installer when the release lists it, else the release page', () => {
    const dl = (name: string): string => `https://github.com/lexasoft123/SingZ/releases/download/v0.27.0/${name}`
    const rel = (names: string[]): object[] => [{
      tag_name: 'v0.27.0', html_url: url('v0.27.0'), prerelease: false,
      assets: names.map((name) => ({ name, browser_download_url: dl(name) }))
    }]
    const manifest = (t: string): string => `singz-native-${t}.update.json`
    expect(pickNativeOffer(rel([manifest('macos-arm64'), 'SingZ-native-0.27.0-macos-arm64.dmg']), 'macos-arm64'))
      .toMatchObject({ url: dl('SingZ-native-0.27.0-macos-arm64.dmg') })
    expect(pickNativeOffer(rel([manifest('macos-x64'), 'SingZ-native-0.27.0-macos-arm64.dmg']), 'macos-x64'))
      .toMatchObject({ url: url('v0.27.0') })
    expect(pickNativeOffer(rel([manifest('windows-x64'), 'SingZ-native-0.27.0-windows-x64-setup.exe']), 'windows-x64'))
      .toMatchObject({ url: dl('SingZ-native-0.27.0-windows-x64-setup.exe') })
    expect(pickNativeOffer(rel([manifest('windows-x64')]), 'windows-x64')).toMatchObject({ url: url('v0.27.0') })
  })
  it('orders prerelease identifiers by semver, not as numbers that drop the suffix', () => {
    expect(compareSemver('0.27.0-beta.2', '0.27.0')).toBe(-1)
    expect(compareSemver('0.27.0-beta.10', '0.27.0-beta.2')).toBe(1)
    expect(compareSemver('v0.27.0', '0.27.0')).toBe(0)
  })
})

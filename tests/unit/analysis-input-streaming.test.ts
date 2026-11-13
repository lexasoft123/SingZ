// Media is streamed, never decoded whole, while native playback and the native
// analyzer are healthy. A 30-minute six-stem song once peaked the renderer at
// 3.5 GB because the combined auto-analysis decoded every stem eagerly
// (provideMl -> analysisStems). These tests count decodeAudioData calls through
// a fake decoder, with negative controls that prove the counter would catch
// the old behaviour.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  analysisStems,
  BEATS_STEM_NEED,
  fallbackNeed,
  KEY_STEM_NEED,
  melodyInput,
  runCombinedCore,
  withFallbackStems,
  type StemDecodeHost
} from '../../src/renderer/src/audio/analysis-input'
import {
  recordRendererDecode,
  rendererDecodeStats,
  resetRendererDecodeStats,
  setNativeSongHealthy
} from '../../src/renderer/src/audio/decode-guard'
import { BEAT_DETECT_VERSION, KEY_DETECT_VERSION } from '../../src/renderer/src/audio/analysis-contract'
import { PITCH_DETECT_VERSION } from '../../src/renderer/src/audio/melody'

const PATHS = {
  vocals: '/s/vocals.flac',
  drums: '/s/drums.flac',
  bass: '/s/bass.flac',
  guitar: '/s/guitar.flac',
  piano: '/s/piano.flac'
}
const IDS = Object.keys(PATHS)
const FRAMES = 44100 * 60 // 60 s stereo per stem in the fake — 21 MB each

/** A minimal FLAC header the real stemSampleRate accepts (44.1 kHz). */
function flacBytes(): ArrayBuffer {
  const b = new Uint8Array(64)
  b.set([0x66, 0x4c, 0x61, 0x43], 0) // fLaC
  b[4] = 0 // STREAMINFO, not last
  // sample rate: 20 bits at byte 18 (44100 = 0x0AC44)
  b[18] = 0x0a
  b[19] = 0xc4
  b[20] = 0x40
  return b.buffer
}

function fakeHost(): { host: StemDecodeHost; reads: string[]; decodes: number } {
  const state = { reads: [] as string[], decodes: 0 }
  const host: StemDecodeHost = {
    readAudio: async (p) => {
      state.reads.push(p)
      return flacBytes()
    },
    decode: async (_bytes, sampleRate) => {
      state.decodes++
      return {
        length: FRAMES,
        numberOfChannels: 2,
        sampleRate,
        getChannelData: () => new Float32Array(8) // content is irrelevant; the ledger counts length
      } as unknown as AudioBuffer
    }
  }
  return { host, get reads() { return state.reads }, get decodes() { return state.decodes } }
}

const goodBeats = { ok: true, detVersion: BEAT_DETECT_VERSION, beats: [0.5, 1, 1.5], bpm: 120, beatsPerBar: 4, downbeat: 0 }
const goodKey = { ok: true, detVersion: KEY_DETECT_VERSION, pc: 2, minor: false }
const goodMelody = { ok: true, detVersion: PITCH_DETECT_VERSION, f0: new Float32Array(4), hopSec: 0.01 }

function stubWindow(result: Record<string, unknown>): void {
  vi.stubGlobal('window', {
    singz: {
      melodyNativeAvailable: async () => ({ ok: true, available: true }),
      analyzeNative: async () => ({ ok: true, ...result }),
      analyzeProvideMl: async () => undefined
    }
  })
}

/** What App's prepMelody does after the cut: provideMl fetches the lattice
 *  only; stems are decoded lazily, per part, and dropped. */
async function songOpenAnalysis(
  fake: ReturnType<typeof fakeHost>,
  opts: { eagerProvideMl?: boolean } = {}
): Promise<{ usedStems: string[] }> {
  const core = await runCombinedCore(
    { melody: true, key: true, beats: true },
    PATHS,
    IDS,
    async () => {
      // negative control: the pre-fix provideMl decoded here
      if (opts.eagerProvideMl) await analysisStems(PATHS, IDS, async () => null, BEATS_STEM_NEED, fake.host)
      return { ml: null, lineStarts: null, words: null }
    }
  )
  const need = fallbackNeed({ beats: true, key: true }, core, true)
  const usedStems: string[] = []
  await withFallbackStems(
    need,
    (n) => analysisStems(PATHS, IDS, async () => null, n, fake.host),
    (stems) => {
      if (stems?.drums) usedStems.push('drums')
      if (stems?.bass) usedStems.push('bass')
      if (stems?.vocals) usedStems.push('vocals')
      if (stems) usedStems.push(...stems.inst.map(() => 'inst'))
    }
  )
  return { usedStems }
}

beforeEach(() => {
  resetRendererDecodeStats()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('healthy native song open + analysis', () => {
  it('performs ZERO full-stem decodes and reads no stem bytes in the renderer', async () => {
    stubWindow({ melody: goodMelody, key: goodKey, beats: goodBeats })
    const fake = fakeHost()
    const { usedStems } = await songOpenAnalysis(fake)
    expect(fake.decodes).toBe(0)
    expect(fake.reads).toEqual([])
    expect(usedStems).toEqual([])
    expect(rendererDecodeStats()).toEqual({ decodes: 0, totalBytes: 0, liveBytes: 0 })
  })

  it('NEGATIVE CONTROL: a provideMl that decodes eagerly (the old code) is caught by the counter', async () => {
    stubWindow({ melody: goodMelody, key: goodKey, beats: goodBeats })
    const fake = fakeHost()
    await songOpenAnalysis(fake, { eagerProvideMl: true })
    expect(fake.decodes).toBe(IDS.length) // every stem, for nothing
    expect(rendererDecodeStats().liveBytes).toBeGreaterThan(0)
  })

  it('REGRESSION: prepMelody\'s provideMl callback does not touch analysisStems', () => {
    const src = readFileSync(resolve(__dirname, '../../src/renderer/src/App.tsx'), 'utf8')
    const start = src.indexOf('{ melody: true, key: wantKey, beats: wantBeats }')
    const end = src.indexOf('unsub()', start)
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const provideMl = src.slice(start, end)
    expect(provideMl).toContain('fetchMlGridRef.current')
    expect(provideMl).not.toMatch(/analysisStems|decodeStemAtFileRate|melodyInput|laneSamples/)
    // and nothing stashes stems for the beat block any more
    expect(src).not.toMatch(/stashStems/)
  })
})

describe('per-part native failure decodes only what that part needs, then releases', () => {
  it('beats failed, key + melody fine: the beat detector\'s stems only', async () => {
    stubWindow({ melody: goodMelody, key: goodKey, beats: { ok: false, error: 'boom' } })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const fake = fakeHost()
    const { usedStems } = await songOpenAnalysis(fake)
    expect(fake.decodes).toBe(5) // drums, bass, vocals, guitar, piano
    expect(usedStems.sort()).toEqual(['bass', 'drums', 'inst', 'inst', 'vocals'])
    expect(rendererDecodeStats().liveBytes).toBe(0) // released
  })

  it('key failed, beats + melody fine: only bass + harmonic stems, never drums or vocals', async () => {
    stubWindow({ melody: goodMelody, key: { ok: false, error: 'boom' }, beats: goodBeats })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const fake = fakeHost()
    const { usedStems } = await songOpenAnalysis(fake)
    expect(fake.decodes).toBe(3) // bass, guitar, piano
    expect(fake.reads).not.toContain(PATHS.drums)
    expect(fake.reads).not.toContain(PATHS.vocals)
    expect(usedStems.sort()).toEqual(['bass', 'inst', 'inst'])
    expect(rendererDecodeStats().liveBytes).toBe(0)
  })

  it('whole analyzer failed: the union decode, still released', async () => {
    vi.stubGlobal('window', {
      singz: {
        melodyNativeAvailable: async () => ({ ok: true, available: true }),
        analyzeNative: async () => ({ ok: false, error: 'spawn failed' }),
        analyzeProvideMl: async () => undefined
      }
    })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const fake = fakeHost()
    await songOpenAnalysis(fake)
    expect(fake.decodes).toBe(5)
    expect(rendererDecodeStats().liveBytes).toBe(0)
  })

  it('releases even when the detector throws, and decodes at the FILE rate', async () => {
    const fake = fakeHost()
    await expect(
      withFallbackStems(
        KEY_STEM_NEED,
        (n) => analysisStems(PATHS, IDS, async () => null, n, fake.host),
        (stems) => {
          expect(stems?.bass?.sampleRate).toBe(44100) // the rate the file states
          throw new Error('detector blew up')
        }
      )
    ).rejects.toThrow('detector blew up')
    expect(rendererDecodeStats().liveBytes).toBe(0)
  })

  it('fallbackNeed: each part independent, nothing owed when the key is already stored', () => {
    expect(fallbackNeed({ beats: true, key: true }, { beats: null, key: { pc: 1, minor: true } }, true)).toBeNull()
    expect(fallbackNeed({ beats: true, key: true }, { key: { pc: 1, minor: true } }, true)).toBe(BEATS_STEM_NEED)
    expect(fallbackNeed({ beats: true, key: true }, { beats: null }, true)).toBe(KEY_STEM_NEED)
    expect(fallbackNeed({ beats: true, key: true }, { beats: null }, false)).toBeNull()
    expect(fallbackNeed({ beats: false, key: false }, {}, true)).toBeNull()
  })

  it('melody fallback decodes only the vocals and releases the decode after the mono fold', async () => {
    const fake = fakeHost()
    const src = await melodyInput(PATHS.vocals, async () => null, fake.host)
    expect(src?.sampleRate).toBe(44100)
    expect(fake.reads).toEqual([PATHS.vocals])
    expect(fake.decodes).toBe(1)
    expect(rendererDecodeStats().liveBytes).toBe(0)
  })
})

describe('the runtime guard', () => {
  it('logs (never throws) "renderer decoded N MB of PCM during song open" on a healthy native song', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    setNativeSongHealthy(true)
    expect(() => recordRendererDecode({ length: 44100 * 60, numberOfChannels: 2 }, '/s/drums.flac')).not.toThrow()
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^renderer decoded 20 MB of PCM during song open/))
  })

  it('stays silent when the song is not on the native path (a legitimate decode)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    setNativeSongHealthy(false)
    recordRendererDecode({ length: 44100 * 60, numberOfChannels: 2 }, '/s/drums.flac')
    expect(warn).not.toHaveBeenCalled()
    expect(rendererDecodeStats().decodes).toBe(1) // still booked
  })

  it('healthy-song fallback decode through analysisStems is logged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    setNativeSongHealthy(true)
    const fake = fakeHost()
    await analysisStems(PATHS, IDS, async () => null, KEY_STEM_NEED, fake.host)
    expect(warn.mock.calls.filter((c) => /renderer decoded \d+ MB of PCM during song open/.test(String(c[0])))).toHaveLength(3)
  })
})

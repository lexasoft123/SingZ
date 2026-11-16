import { readFileSync } from 'node:fs'
/** Native open metadata rejects unsupported or unreadable lanes without a browser playback decode. */
import { describe, expect, it, vi } from 'vitest'

import {
  desktopLaneMeasureApplies,
  laneMeasureRequest,
  laneReadFromBuffer,
  measureLanes,
  readLanes,
  readOptionalLanes,
  sampledRms,
  SILENT_LANE_RMS,
  type LaneMeasureHost
} from '../../src/renderer/src/audio/lane-measure'
import { LANE_ENVELOPE_BUCKETS } from '../../src/renderer/src/audio/lane-envelope'
import { bucketsFor, PEAKS_MAXIMUM, PEAKS_MINIMUM, PEAKS_PER_SECOND } from '../../src/renderer/src/audio/peaks'
import {
  DESKTOP_PLAYBACK_CAPABILITY,
  DESKTOP_PLAYBACK_CODEC_BASE_EXTENSIONS,
  DESKTOP_PLAYBACK_CODEC_BASE_MASK,
  DESKTOP_PLAYBACK_CODEC_BASE_TAG,
  type DesktopPlaybackLaneMeasure,
  type DesktopPlaybackLaneMeasureRequest,
  type DesktopPlaybackRuntimeCapability
} from '../../src/shared/types'

/** A stand-in for AudioBuffer with what the read asks of one. */
function buffer(channels: Float32Array[], sampleRate = 44100): AudioBuffer {
  const length = channels[0]?.length ?? 0
  return {
    length,
    numberOfChannels: channels.length,
    sampleRate,
    duration: length / sampleRate,
    getChannelData: (c: number) => channels[c]
  } as unknown as AudioBuffer
}

const tone = (frames: number, amplitude: number, hz = 440, rate = 44100): Float32Array =>
  Float32Array.from({ length: frames }, (_, i) => amplitude * Math.sin((2 * Math.PI * hz * i) / rate))

const baseRuntime = (): DesktopPlaybackRuntimeCapability => ({
  available: true,
  playbackCapability: DESKTOP_PLAYBACK_CAPABILITY,
  mediaCodec: {
    abiVersion: 1,
    formatMask: DESKTOP_PLAYBACK_CODEC_BASE_MASK,
    dynamicallyLinkedFfmpeg: false,
    runtimeVersion: '',
    capabilityTag: DESKTOP_PLAYBACK_CODEC_BASE_TAG,
    profile: '',
    target: '',
    extensions: [...DESKTOP_PLAYBACK_CODEC_BASE_EXTENSIONS]
  }
})

const measured = (id: string, over: Partial<DesktopPlaybackLaneMeasure> = {}): DesktopPlaybackLaneMeasure => ({
  id,
  ok: true,
  error: 'ok',
  sampleRate: 44100,
  channels: 2,
  frameCount: 44100 * 3,
  durationSeconds: 3,
  rms: 0.2,
  peaks: Float32Array.from({ length: 3000 }, (_, i) => (i % 2 === 0 ? 0.5 : 0.25)),
  envelope: new Float32Array(LANE_ENVELOPE_BUCKETS).fill(0.2),
  ...over
})

const host = (over: Partial<LaneMeasureHost['api']> = {}, platform: LaneMeasureHost['platform'] = 'darwin'): LaneMeasureHost => ({
  platform,
  api: {
    desktopPlaybackCapability: async () => baseRuntime(),
    measureDesktopPlaybackLanes: async (request) => ({
      ok: true,
      error: '',
      lanes: request.lanes.map((lane) => measured(lane.id))
    }),
    ...over
  }
})

const flacLanes = [
  { id: 'vocals', path: '/lib/song/stems/vocals.flac' },
  { id: 'drums', path: '/lib/song/stems/drums.flac' }
]

describe('sampledRms and laneReadFromBuffer', () => {
  it('reads silence as silence and a tone as its RMS', () => {
    expect(sampledRms(buffer([new Float32Array(44100)]))).toBe(0)
    expect(sampledRms(buffer([tone(44100, 0.5)]))).toBeCloseTo(0.5 / Math.SQRT2, 2)
    expect(sampledRms(buffer([]))).toBe(0)
  })

  it('is the decode path in one object: peaks at bucketsFor, the envelope, the buffer kept', () => {
    const b = buffer([tone(44100 * 3, 0.4), tone(44100 * 3, 0.1)])
    const read = laneReadFromBuffer(b)
    expect(read.duration).toBe(3)
    expect(read.peaks.length).toBe(bucketsFor(3))
    expect(read.peaks.length).toBe(3000)
    expect(read.envelope.length).toBe(LANE_ENVELOPE_BUCKETS)
    expect(read.buffer).toBe(b)
    expect(read.rms).toBeGreaterThan(SILENT_LANE_RMS)
    // Normalized: the loudest bucket reads full height.
    expect(Math.max(...read.peaks)).toBeCloseTo(1, 5)
    expect(read.scale).toBeCloseTo(1 / 0.4, 3)
  })
})

describe('laneMeasureRequest', () => {
  it('sends the renderer peak policy with the lanes', () => {
    expect(laneMeasureRequest(flacLanes)).toEqual({
      lanes: flacLanes,
      peaksPerSecond: PEAKS_PER_SECOND,
      minimumPeaks: PEAKS_MINIMUM,
      maximumPeaks: PEAKS_MAXIMUM
    })
    expect(PEAKS_PER_SECOND).toBe(1000)
    expect(PEAKS_MINIMUM).toBe(2400)
    expect(PEAKS_MAXIMUM).toBe(400_000)
  })
})

describe('desktopLaneMeasureApplies', () => {
  it('is the facade backend decision with neutral controls', async () => {
    expect(await desktopLaneMeasureApplies(flacLanes, host())).toBe(true)
    expect(await desktopLaneMeasureApplies(flacLanes, host({}, 'win32'))).toBe(true)
  })

  it('rejects a platform without a native provider', async () => { await expect(desktopLaneMeasureApplies(flacLanes, host({}, 'other'))).rejects.toMatchObject({ failure: { code: 'provider-unavailable' } }) })

  it('names unavailable native runtimes and unsupported lane formats', async () => {
 await expect(desktopLaneMeasureApplies(flacLanes, host({ desktopPlaybackCapability: async () => ({ ...baseRuntime(), available: false }) }))).rejects.toMatchObject({ failure: { code: 'addon-unavailable' } })
 await expect(desktopLaneMeasureApplies(flacLanes, host({ desktopPlaybackCapability: async () => { throw new Error('no addon') } }))).rejects.toMatchObject({ failure: { code: 'addon-unavailable' } })
 await expect(desktopLaneMeasureApplies([...flacLanes, { id: 'custom-riff', path: '/lib/custom.mp3' }], host())).rejects.toMatchObject({ failure: { code: 'graph-rejected', laneId: 'custom-riff', format: 'mp3' } })
 })
})

describe('measureLanes', () => {
  it('returns the lanes the core measured, normalized for drawing', async () => {
    const { lanes: reads, superseded } = await measureLanes(flacLanes, host())
    expect(superseded).toBe(false)
    expect([...reads.keys()]).toEqual(['vocals', 'drums'])
    const vocals = reads.get('vocals')!
    expect(vocals.duration).toBe(3)
    expect(vocals.buffer).toBeNull()
    expect(vocals.rms).toBe(0.2)
    expect(vocals.envelope).toHaveLength(LANE_ENVELOPE_BUCKETS)
    expect(vocals.envelope[0]).toBeCloseTo(0.2, 6)
    // normalizePeaks: 0.5 is the loudest bucket, lifted to 1 at scale 2.
    expect(vocals.scale).toBe(2)
    expect(vocals.peaks[0]).toBe(1)
    expect(vocals.peaks[1]).toBe(0.5)
  })

  it('keeps refused lanes out of drawing metadata', async () => {
    const { lanes: reads } = await measureLanes(
      flacLanes,
      host({
        measureDesktopPlaybackLanes: async (request) => ({
          ok: true,
          error: '',
          lanes: request.lanes.map((lane) =>
            lane.id === 'drums'
              ? measured(lane.id, { ok: false, error: 'unsupported-format', peaks: new Float32Array(0), envelope: new Float32Array(0) })
              : measured(lane.id)
          )
        })
      })
    )
    expect([...reads.keys()]).toEqual(['vocals'])
  })

  it('refuses a wrongly shaped lane rather than drawing it', async () => {
    const wrong: Partial<DesktopPlaybackLaneMeasure>[] = [
      { envelope: new Float32Array(95) },
      { peaks: new Float32Array(0) },
      { durationSeconds: 0 },
      { durationSeconds: Number.NaN },
      { rms: Number.NaN },
      { peaks: [0.5, 0.5] as unknown as Float32Array }
    ]
    for (const over of wrong) {
      const { lanes: reads } = await measureLanes(
        [flacLanes[0]],
        host({
          measureDesktopPlaybackLanes: async () => ({ ok: true, error: '', lanes: [measured('vocals', over)] })
        })
      )
      expect(reads.size, JSON.stringify(Object.keys(over))).toBe(0)
    }
  })

  it('publishes a typed preparation failure when measurement is unavailable', async () => {
 await expect(measureLanes(flacLanes, host({ measureDesktopPlaybackLanes: async () => { throw new Error('ipc down') } }))).rejects.toMatchObject({ failure: { code: 'prepare-failed' } })
 await expect(measureLanes(flacLanes, host({ measureDesktopPlaybackLanes: async () => ({ ok: false, error: 'no addon', lanes: [] }) }))).rejects.toMatchObject({ failure: { code: 'prepare-failed', detail: 'no addon' } })
 })

  it('asks nothing when the measure does not apply, or there is nothing to measure', async () => { const measure=vi.fn(); await expect(measureLanes(flacLanes,host({measureDesktopPlaybackLanes:measure},'other'))).rejects.toThrow(); expect((await measureLanes([],host({measureDesktopPlaybackLanes:measure}))).lanes.size).toBe(0); expect(measure).not.toHaveBeenCalled() })

  it('takes the song-wide gate over its own, in both directions', async () => {
    const measure = vi.fn(async (request: DesktopPlaybackLaneMeasureRequest) => ({
      ok: true,
      error: '',
      lanes: request.lanes.map((lane) => measured(lane.id))
    }))
    // Six FLAC stems on their own would say native; the song also has an mp3
    // custom track, so the caller decided "legacy" over all seven and the
    // stems must not be measured — Play would refuse native and decode them
    // in front of the first sound.
    expect((await measureLanes(flacLanes, { ...host({ measureDesktopPlaybackLanes: measure }), applies: false })).lanes.size).toBe(0)
    expect(measure).not.toHaveBeenCalled()
    // And a caller that decided "native" over the whole song is not second-
    // guessed over a part of it.
    expect((await measureLanes(flacLanes, { ...host({ measureDesktopPlaybackLanes: measure }), applies: true })).lanes.size).toBe(2)
  })

  it('reports a superseded measure rather than decoding the song being left', async () => {
    const outcome = await measureLanes(
      flacLanes,
      host({
        measureDesktopPlaybackLanes: async (request) => ({
          ok: true,
          error: '',
          lanes: request.lanes.map((lane) =>
            measured(lane.id, { ok: false, error: 'cancelled', peaks: new Float32Array(0), envelope: new Float32Array(0) })
          )
        })
      })
    )
    expect(outcome.superseded).toBe(true)
    expect(outcome.lanes.size).toBe(0)
    const decode = vi.fn()
    const read = await readLanes(
      flacLanes,
      decode,
      host({
        measureDesktopPlaybackLanes: async (request) => ({
          ok: true,
          error: '',
          lanes: request.lanes.map((lane) =>
            measured(lane.id, { ok: false, error: 'cancelled', peaks: new Float32Array(0), envelope: new Float32Array(0) })
          )
        })
      })
    )
    expect(read.superseded).toBe(true)
    expect(decode).not.toHaveBeenCalled()
  })
})

describe('readLanes', () => {
  it('uses native measurement for supported ALSA lanes on Linux without Chromium decoding', async () => {
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => key === 'singz.desktop.native-playback' ? '1' : null
    })
    try {
      const decode = vi.fn(async () => buffer([tone(44100, 0.5)]))
      const measure = vi.fn(async (request: DesktopPlaybackLaneMeasureRequest) => ({
        ok: true,
        error: '',
        lanes: request.lanes.map((lane) => measured(lane.id))
      }))
      const { reads, errors, superseded } = await readLanes(
        flacLanes,
        decode,
        host({ measureDesktopPlaybackLanes: measure }, 'linux')
      )
      expect(superseded).toBe(false)
      expect(errors.size).toBe(0)
      expect([...reads.keys()]).toEqual(['vocals', 'drums'])
      expect(measure).toHaveBeenCalledTimes(1)
      expect(measure).toHaveBeenCalledWith(laneMeasureRequest(flacLanes))
      expect(decode).not.toHaveBeenCalled()
      expect([...reads.values()].every((lane) => lane.buffer === null)).toBe(true)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('reports each refused native lane without decoding it in Chromium', async () => {
 const decode=vi.fn(async()=>buffer([tone(4410,.5)]))
 const {reads,errors}=await readLanes(flacLanes,decode,host({measureDesktopPlaybackLanes:async request=>({ok:true,error:'',lanes:request.lanes.map(lane=>measured(lane.id,lane.id==='vocals'?{}:{ok:false,error:'io-error'}))})}))
 expect([...reads.keys()]).toEqual(['vocals']); expect([...errors.keys()]).toEqual(['drums']); expect(errors.get('drums')).toMatchObject({failure:{code:'io-error',laneId:'drums'}}); expect(decode).not.toHaveBeenCalled()
 })

  it('refuses unavailable native measurement without decoding any lane', async () => { const decode=vi.fn(async()=>buffer([tone(4410,.5)])); await expect(readLanes(flacLanes,decode,host({},'other'))).rejects.toMatchObject({failure:{code:'provider-unavailable'}}); expect(decode).not.toHaveBeenCalled() })
})


describe('optional custom lane admission', () => {
  it('opens required FLAC stems while dropping unsupported MP3 and M4A custom tracks', async () => {
    const measure = vi.fn(async (request: DesktopPlaybackLaneMeasureRequest) => ({
      ok: true, error: '', lanes: request.lanes.map(lane => measured(lane.id))
    }))
    const api = host({ measureDesktopPlaybackLanes: measure })
    const decode = vi.fn(async () => { throw new Error('Browser decode is forbidden') })
    expect(await desktopLaneMeasureApplies(flacLanes, api)).toBe(true)
    const stems = await readLanes(flacLanes, decode, { ...api, applies: true })
    const extras = await readOptionalLanes([
      { id: 'harmony', path: '/song/harmony.mp3' },
      { id: 'reference', path: '/song/reference.m4a' },
      { id: 'guide', path: '/song/guide.wav' }
    ], decode, api, flacLanes)
    expect([...stems.reads.keys()]).toEqual(['vocals', 'drums'])
    expect([...extras.reads.keys()]).toEqual(['guide'])
    expect([...extras.errors.keys()]).toEqual(['harmony', 'reference'])
    for (const id of ['harmony', 'reference']) expect(extras.errors.get(id)).toMatchObject({
      failure: { code: 'graph-rejected', laneId: id }
    })
    expect(measure.mock.calls.map(([request]) => request.lanes.map(lane => lane.id))).toEqual([
      ['vocals', 'drums'], ['guide']
    ])
    expect(decode).not.toHaveBeenCalled()
  })

  it('still rejects an unsupported required stem instead of dropping it', async () => {
    await expect(desktopLaneMeasureApplies([{ id: 'vocals', path: '/song/vocals.m4a' }], host()))
      .rejects.toMatchObject({ failure: { code: 'graph-rejected', laneId: 'vocals' } })
  })

  it('drops an optional track that would exceed the native lane limit', async () => {
    const required = Array.from({ length: 15 }, (_, index) => ({ id: `stem-${index}`, path: `/song/${index}.flac` }))
    const read = await readOptionalLanes([
      { id: 'first', path: '/song/first.wav' }, { id: 'overflow', path: '/song/overflow.wav' }
    ], vi.fn(), host(), required)
    expect([...read.errors.keys()]).toEqual(['overflow'])
    expect(read.errors.get('overflow')).toMatchObject({ failure: { code: 'graph-rejected' } })
  })
})


it('wires project open and post-split stem admission independently of optional custom tracks', () => {
  const app = readFileSync('src/renderer/src/App.tsx', 'utf8')
  const requiredCalls = [...app.matchAll(/desktopLaneMeasureApplies\(\[([\s\S]*?)\]\)/g)]
  expect(requiredCalls.length).toBe(3)
  for (const [, lanes] of requiredCalls) {
    expect(lanes).not.toContain('.custom')
    expect(lanes).not.toContain('kept.map')
  }
  expect(app.match(/await (?:checked\()?readOptionalLanes\(/g)).toHaveLength(2)
  expect(app).toContain("setNotice(t('app.load.laneMissing'")
})

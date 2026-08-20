import {
  BEAT_MODELS,
  MIN_SPLIT_MEM_MB,
  PHONE_MODELS_TAG,
  SPLIT_MODEL,
  cancelModelDownload,
  ensureModel,
  splitCapability
} from '../src/analysis/models'

describe('phone model table', () => {
  it('pins every asset by name and hash — the asset is what cannot change', () => {
    for (const m of [SPLIT_MODEL, ...BEAT_MODELS]) {
      expect(m.url).toContain(`/releases/download/${PHONE_MODELS_TAG}/`)
      expect(m.url.endsWith(`/${m.file}`)).toBe(true)
      expect(m.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(m.bytes).toBeGreaterThan(0)
    }
  })

  it('names the exact files the engine and the build script expect', () => {
    expect(SPLIT_MODEL.file).toBe('htdemucs_6s_fp16weights.onnx')
    expect(BEAT_MODELS.map((m) => m.file).sort()).toEqual(['beat_this.onnx', 'logmel.onnx'])
  })
})

describe('splitCapability', () => {
  it('gates a small phone with honest copy naming the desktop path', () => {
    const r = splitCapability(3700)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toMatch(/memory/i)
      expect(r.reason).toMatch(/computer/i)
    }
  })

  it('passes the measured 6 GB class and above', () => {
    expect(splitCapability(5600).ok).toBe(true)
    expect(splitCapability(11500).ok).toBe(true)
    expect(splitCapability(MIN_SPLIT_MEM_MB).ok).toBe(true)
  })

  it('lets an unknown reading through — isolation makes a wrong yes cheap', () => {
    expect(splitCapability(undefined).ok).toBe(true)
  })

  it('force overrides the floor (dev sideload path)', () => {
    expect(splitCapability(2048, true).ok).toBe(true)
  })
})

/**
 * The native downloader is ONE instance with ONE cancel flag (and on iOS one
 * progress pair). Two cards asking at once — the splitter and the beat
 * models — must not run concurrently or cancel each other: found in review
 * as "my split download stopped by itself". Gated here against a fake
 * native that records every call, because no device can make two taps land
 * in the same millisecond on demand.
 */
describe('model downloads are single-flight, and cancel is addressed by name', () => {
  const { NativeModules } = require('react-native') as { NativeModules: Record<string, Record<string, unknown>> }
  let calls: string[]
  let release: Array<() => void>
  beforeEach(() => {
    calls = []
    release = []
    NativeModules.FolderAccess.downloadFile = (name: string) =>
      new Promise((res) => {
        calls.push(`start ${name}`)
        release.push(() => { calls.push(`end ${name}`); res({ path: `/m/${name}`, downloaded: true }) })
      })
    NativeModules.FolderAccess.cancelDownload = async () => { calls.push('NATIVE CANCEL'); return true }
  })

  it('runs two ensureModel calls one after the other, never overlapped', async () => {
    const a = { file: 'a.onnx', bytes: 1, sha256: '0'.repeat(64), url: 'u' }
    const b = { file: 'b.onnx', bytes: 1, sha256: '0'.repeat(64), url: 'u' }
    const pa = ensureModel(a)
    const pb = ensureModel(b)
    await new Promise((r) => setTimeout(r, 10))
    expect(calls).toEqual(['start a.onnx'])          // b has NOT started
    release[0]()
    await pa
    await new Promise((r) => setTimeout(r, 10))
    expect(calls).toEqual(['start a.onnx', 'end a.onnx', 'start b.onnx'])
    release[1]()
    await pb
  })

  it('cancelling the QUEUED one drops it without touching the native; the in-flight one keeps going', async () => {
    const a = { file: 'a.onnx', bytes: 1, sha256: '0'.repeat(64), url: 'u' }
    const b = { file: 'b.onnx', bytes: 1, sha256: '0'.repeat(64), url: 'u' }
    const pa = ensureModel(a)
    const pb = ensureModel(b)
    await new Promise((r) => setTimeout(r, 10))
    expect(await cancelModelDownload('b.onnx')).toBe(true)
    expect(calls).toEqual(['start a.onnx'])          // no NATIVE CANCEL — a is untouched
    release[0]()
    await expect(pa).resolves.toBe('/m/a.onnx')
    await expect(pb).rejects.toMatchObject({ code: 'cancelled' })
    expect(calls).not.toContain('NATIVE CANCEL')
  })

  it('cancelling the IN-FLIGHT one reaches the native; a name that is neither is a no-op', async () => {
    const a = { file: 'a.onnx', bytes: 1, sha256: '0'.repeat(64), url: 'u' }
    const pa = ensureModel(a)
    await new Promise((r) => setTimeout(r, 10))
    expect(await cancelModelDownload('nobody.onnx')).toBe(false)
    expect(calls).toEqual(['start a.onnx'])
    expect(await cancelModelDownload('a.onnx')).toBe(true)
    expect(calls).toContain('NATIVE CANCEL')
    release[0]()
    await pa
  })

  it('a failed download does not wedge the queue behind it', async () => {
    NativeModules.FolderAccess.downloadFile = async (name: string) => {
      calls.push(`start ${name}`)
      if (name === 'bad.onnx') throw new Error('network')
      return { path: `/m/${name}`, downloaded: true }
    }
    const bad = { file: 'bad.onnx', bytes: 1, sha256: '0'.repeat(64), url: 'u' }
    const ok = { file: 'ok.onnx', bytes: 1, sha256: '0'.repeat(64), url: 'u' }
    const pb = ensureModel(bad)
    const po = ensureModel(ok)
    await expect(pb).rejects.toThrow('network')
    await expect(po).resolves.toBe('/m/ok.onnx')
  })
})

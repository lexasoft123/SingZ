import {
  BEAT_MODELS,
  MIN_SPLIT_MEM_MB,
  PHONE_MODELS_TAG,
  SPLIT_MODEL,
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

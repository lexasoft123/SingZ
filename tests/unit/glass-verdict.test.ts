/*
 * Which Windows GPUs get the glass back (src/main/glass.ts). The field
 * laptop's adapters are named exactly as its Chromium reported them in
 * `getGPUInfo('complete')`; the fleet's are the names its logs carry; the rest
 * are the edges of each tier — the parts a loose pattern would wave through.
 * A strong GPU judged weak only loses a look, so every doubtful name is weak.
 */
import { describe, expect, it } from 'vitest'
import { judgeGlass, withdrawnGlass, type GpuAdapter } from '../../src/main/glass'

const NVIDIA = 0x10de
const AMD = 0x1002
const INTEL = 0x8086

const judge = (adapters: GpuAdapter[], extra: { compositing?: string; override?: string; platform?: string } = {}) =>
  judgeGlass({ platform: 'win32', compositing: 'enabled', adapters, ...extra })
const only = (vendorId: number, deviceString: string): GpuAdapter[] => [{ active: true, vendorId, deviceString }]

// The field laptop, three adapters, as `complete` lists them.
const FIELD_LAPTOP: GpuAdapter[] = [
  { vendorId: NVIDIA, deviceString: 'NVIDIA GeForce GT 750M' },
  { vendorId: INTEL, deviceString: 'Intel(R) HD Graphics 4600' },
  { vendorId: 0x1414, deviceString: 'Microsoft Basic Render Driver' }
]
const activate = (adapters: GpuAdapter[], index: number): GpuAdapter[] =>
  adapters.map((a, i) => ({ ...a, active: i === index }))

describe('glass on Windows', () => {
  it.each([
    [NVIDIA, 'NVIDIA GeForce RTX 3070'],
    [NVIDIA, 'NVIDIA GeForce RTX 4060 Ti'],
    [NVIDIA, 'NVIDIA GeForce RTX 3060 Laptop GPU'],
    [NVIDIA, 'NVIDIA GeForce RTX 5090'],
    [NVIDIA, 'NVIDIA GeForce GTX 1650'],
    [NVIDIA, 'NVIDIA GeForce GTX 1060 6GB'],
    [NVIDIA, 'NVIDIA GeForce GTX 1660 Ti'],
    [NVIDIA, 'NVIDIA RTX A2000 12GB'],
    [NVIDIA, 'Quadro RTX 4000'],
    [NVIDIA, 'NVIDIA TITAN Xp'],
    [AMD, 'AMD Radeon RX 6600'],
    [AMD, 'AMD Radeon RX 580 2048SP'],
    [AMD, 'AMD Radeon RX 7900 XTX'],
    [AMD, 'AMD Radeon RX 6600M'],
    [AMD, 'AMD Radeon Pro W7600'],
    [AMD, 'AMD Radeon RX 6400'],
    [AMD, 'AMD Radeon RX 5500M'],
    [AMD, 'AMD Radeon Pro 5500M'],
    [INTEL, 'Intel(R) Arc(TM) A770 Graphics'],
    [INTEL, 'Intel(R) Arc(TM) A370M Graphics'],
    [INTEL, 'Intel(R) Arc(TM) B580 Graphics'],
    [INTEL, 'Intel(R) Arc(TM) Pro A40 Graphics'],
    // Panther Lake's integrated Arc: an iGPU, and a strong one.
    [INTEL, 'Intel(R) Arc(TM) B390 GPU']
  ])('keeps the glass on %#: %s', (vendorId, name) => {
    expect(judge(only(vendorId, name))).toEqual({ glass: true, reason: `${name} composites` })
  })

  it.each([
    [NVIDIA, 'NVIDIA GeForce GT 750M'],
    [NVIDIA, 'NVIDIA GeForce GT 1030'],
    [NVIDIA, 'NVIDIA GeForce MX150'],
    [NVIDIA, 'NVIDIA GeForce MX450'],
    [NVIDIA, 'NVIDIA GeForce GTX 960M'],
    [NVIDIA, 'NVIDIA GeForce GTX 750 Ti'],
    [NVIDIA, 'NVIDIA Quadro P620'],
    // GP108 — the GT 1030's die under a GTX name.
    [NVIDIA, 'NVIDIA GeForce GTX 1010'],
    [AMD, 'AMD Radeon(TM) Graphics'],
    [AMD, 'AMD Radeon(TM) Vega 8 Graphics'],
    [AMD, 'AMD Radeon RX Vega 10 Graphics'],
    [AMD, 'AMD Radeon 780M Graphics'],
    [AMD, 'AMD Radeon R7 M340'],
    // Polaris 12, the MX150's class under an RX name.
    [AMD, 'AMD Radeon RX 540'],
    [AMD, 'AMD Radeon RX 550'],
    [AMD, 'AMD Radeon RX 550X'],
    [AMD, 'AMD Radeon RX 640'],
    // Boot Camp Pros: a GT 750M's bandwidth behind a Retina panel.
    [AMD, 'AMD Radeon Pro 450'],
    [AMD, 'AMD Radeon Pro 555X'],
    [AMD, 'AMD Radeon Pro WX 3100'],
    [INTEL, 'Intel(R) HD Graphics 4600'],
    [INTEL, 'Intel(R) UHD Graphics 620'],
    [INTEL, 'Intel(R) Iris(R) Xe Graphics'],
    [INTEL, 'Intel(R) Arc(TM) Graphics'],
    [INTEL, 'Intel(R) Arc(TM) 140V GPU (16GB)'],
    [0x1414, 'Microsoft Basic Render Driver'],
    [0x15ad, 'VMware SVGA 3D'],
    [0x4d4f4351, 'Qualcomm(R) Adreno(TM) X1-85 GPU'],
    // A name only counts under its own vendor.
    [INTEL, 'NVIDIA GeForce RTX 4090']
  ])('stays solid on %#: %s', (vendorId, name) => {
    const verdict = judge(only(vendorId, name))
    expect(verdict.glass).toBe(false)
    expect(verdict.reason).toContain(name)
  })

  it('judges the adapter that composites, not the strongest one present', () => {
    // A field laptop: its Vega 8 draws every frame while an RTX 3060 sits idle.
    const hybrid: GpuAdapter[] = [
      { vendorId: AMD, deviceString: 'AMD Radeon(TM) Graphics' },
      { vendorId: NVIDIA, deviceString: 'NVIDIA GeForce RTX 3060 Laptop GPU' }
    ]
    expect(judge(activate(hybrid, 0)).glass).toBe(false)
    expect(judge(activate(hybrid, 1)).glass).toBe(true)
    // The field laptop solid on both of its GPUs: Chromium's default (the GT
    // 750M) and --force_low_power_gpu (the HD 4600).
    expect(judge(activate(FIELD_LAPTOP, 0))).toEqual({
      glass: false,
      reason: 'NVIDIA GeForce GT 750M composites, and is not a GPU this trusts with blur'
    })
    expect(judge(activate(FIELD_LAPTOP, 1)).glass).toBe(false)
  })

  it('stays solid when nothing says which adapter composites', () => {
    // What `basic` reports on Windows: every adapter named, none active.
    expect(judge(FIELD_LAPTOP)).toEqual({ glass: false, reason: 'no active GPU reported' })
    expect(judge([])).toEqual({ glass: false, reason: 'no active GPU reported' })
    // A fleet machine whose enumeration came back as vendor 0, device 0.
    expect(judge([{ active: true, vendorId: 0 }])).toEqual({
      glass: false,
      reason: 'vendor 0x0 composites, and is not a GPU this trusts with blur'
    })
  })

  it('stays solid on software compositing, whatever the GPU', () => {
    const rtx = only(NVIDIA, 'NVIDIA GeForce RTX 3070')
    expect(judge(rtx, { compositing: 'disabled_software' })).toEqual({
      glass: false,
      reason: 'compositing is disabled_software'
    })
    expect(judge(rtx, { compositing: undefined }).glass).toBe(false)
  })

  it('lets SINGZ_GLASS decide either way', () => {
    expect(judge(activate(FIELD_LAPTOP, 0), { override: '1' })).toEqual({ glass: true, reason: 'forced on by SINGZ_GLASS' })
    expect(judge(activate(FIELD_LAPTOP, 0), { override: 'on' }).glass).toBe(true)
    expect(judge(only(NVIDIA, 'NVIDIA GeForce RTX 3070'), { override: '0' })).toEqual({
      glass: false,
      reason: 'forced off by SINGZ_GLASS'
    })
    expect(judge(only(NVIDIA, 'NVIDIA GeForce RTX 3070'), { override: 'off' }).glass).toBe(false)
    // Anything else is no override at all.
    expect(judge(only(NVIDIA, 'NVIDIA GeForce RTX 3070'), { override: 'maybe' }).glass).toBe(true)
  })

  it('takes the glass back only when compositing leaves the GPU', () => {
    const glass = { glass: true, reason: 'NVIDIA GeForce RTX 3070 composites' }
    expect(withdrawnGlass(glass, 'enabled')).toBeNull()
    expect(withdrawnGlass(glass, 'enabled_on')).toBeNull()
    expect(withdrawnGlass(glass, 'disabled_software')).toEqual({
      glass: false,
      reason: 'compositing fell back to disabled_software'
    })
    // Nothing to take back from a solid verdict.
    expect(withdrawnGlass({ glass: false, reason: 'x' }, 'disabled_software')).toBeNull()
  })

  it('leaves every other platform to its glass', () => {
    expect(judge([], { platform: 'darwin' })).toEqual({ glass: true, reason: 'not Windows' })
    expect(judge([], { platform: 'linux', compositing: 'disabled_software' }).glass).toBe(true)
  })
})

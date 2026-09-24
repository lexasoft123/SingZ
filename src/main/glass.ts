import { app, BrowserWindow } from 'electron'
import type { GlassVerdict } from '../shared/types'
import { log } from './log'

/**
 * Glass or solid on Windows: can the GPU Chromium composites on afford a
 * backdrop blur?
 *
 * A `backdrop-filter` re-runs over its whole box whenever anything under or
 * inside it is damaged, and most of the Windows fleet composites on a GPU
 * that pays for it with most of its 3D engine — the field laptop's GPU time
 * under the drop overlay went from 64% to 95% (summed over its two GPUs) with
 * the blur on over a playing song. So `body.win` gets every surface in solid
 * (styles.css, plus the kit's modal scrim), unless this says the machine's
 * GPU shrugs a blur off: then the renderer adds `body.glass` and Windows
 * looks the way the Mac does.
 *
 * Judged on the ACTIVE adapter of `getGPUInfo('complete')`. 'basic' names
 * every adapter but marks none of them active on Windows, and a hybrid
 * laptop's idle dGPU says nothing about the iGPU that draws every frame (a
 * field RTX 3060 laptop composites on its Vega 8; the field laptop above on
 * its GT 750M or, with `--force_low_power_gpu`, its HD 4600). And by NAME,
 * not device ID: a table of IDs per vendor and generation would rot, while
 * the adapter's own name says what tier it is. The list is deliberately
 * short — a strong GPU left solid loses a look, a weak one given glass loses
 * frames.
 *
 * This module never reads the GPU itself: `complete` has the GPU process
 * collect driver information on the thread that rasters, composites and
 * presents, so the launch's one read waits until the window has been on
 * screen for a moment (index.ts; hwinfo.ts logs the adapters from the same
 * answer) and is handed to `settleGlass`.
 */

/** The fields of one `getGPUInfo('complete').gpuDevice` entry read here. */
export type GpuAdapter = { active?: boolean; vendorId?: number; deviceString?: string }

/** GPUs that composite a blur for free. Anything not matched stays solid. */
const STRONG: ReadonlyArray<{ vendorId: number; name: RegExp }> = [
  // NVIDIA: any RTX (GeForce, Quadro, the A/Ada workstation parts), GTX
  // 1050-1080 and 1650-1660, the TITANs — never GT, MX, the GP108 "GTX 1010"
  // or a GTX 9xx and older.
  { vendorId: 0x10de, name: /\bRTX|\bGTX\s*1(?:0[5-8]|6[56])\d\b|\bTITAN\b/i },
  // AMD: a Radeon RX with a model number (RX 580, RX 6600M) that is not a
  // Polaris 12 (RX 540/550/550X/640), or a four-digit Radeon Pro (W7600,
  // 5500M) — never the APUs ("Radeon(TM) Graphics", "Vega 8", "780M") nor the
  // three-digit Boot Camp Pros (Pro 450/555/560, a GT 750M's bandwidth
  // behind a Retina panel).
  { vendorId: 0x1002, name: /\bRadeon(?:\(TM\))?\s+(?:RX\s*(?!5[45]0X?\b|640\b)\d{3,4}|Pro\s+W?\d{4})/i },
  // Intel: the Arc A- and B-series — the discrete cards (A380, A770M, B580)
  // and Panther Lake's integrated B370/B390, both strong — never the older
  // Arc-branded iGPUs ("Arc(TM) Graphics", "Arc(TM) 140V").
  { vendorId: 0x8086, name: /\bArc(?:\(TM\))?\s+(?:Pro\s+)?[AB]\d{2,3}/i }
]

/** SINGZ_GLASS: 1/on or 0/off overrides the judgement (tests, field support); anything else is none. */
const forced = (override?: string): boolean | undefined => {
  const v = override?.trim().toLowerCase()
  return v === '1' || v === 'on' ? true : v === '0' || v === 'off' ? false : undefined
}

export function judgeGlass(input: {
  platform: string
  override?: string
  /** `getGPUFeatureStatus().gpu_compositing` — anything but enabled is software. */
  compositing?: string
  adapters: ReadonlyArray<GpuAdapter>
}): GlassVerdict {
  if (input.platform !== 'win32') return { glass: true, reason: 'not Windows' }
  const force = forced(input.override)
  if (force !== undefined) return { glass: force, reason: `forced ${force ? 'on' : 'off'} by SINGZ_GLASS` }
  if (!input.compositing?.startsWith('enabled')) {
    return { glass: false, reason: `compositing is ${input.compositing ?? 'unknown'}` }
  }
  const active = input.adapters.find((a) => a.active)
  if (!active) return { glass: false, reason: 'no active GPU reported' }
  const name = active.deviceString?.trim() || `vendor 0x${(active.vendorId ?? 0).toString(16)}`
  return STRONG.some((tier) => tier.vendorId === active.vendorId && tier.name.test(name))
    ? { glass: true, reason: `${name} composites` }
    : { glass: false, reason: `${name} composites, and is not a GPU this trusts with blur` }
}

/**
 * The glass taken back once Chromium falls to software compositing mid-launch
 * (its GPU process crashed too often): the software compositor would run every
 * blur on the CPU. Null while there is nothing to take back. SINGZ_GLASS=1
 * does not hold it — the override judges the GPU, and this is no longer one.
 */
export function withdrawnGlass(current: GlassVerdict, compositing: string): GlassVerdict | null {
  return current.glass && !compositing.startsWith('enabled')
    ? { glass: false, reason: `compositing fell back to ${compositing}` }
    : null
}

let current: GlassVerdict | null = null
let settleFirst!: (verdict: GlassVerdict) => void
const first = new Promise<GlassVerdict>((resolve) => {
  settleFirst = resolve
})

/** What the renderer asks for — settled once the launch's GPU read is judged. */
export function glassVerdict(): Promise<GlassVerdict> {
  return current ? Promise.resolve(current) : first
}

/** Judge the launch's one `complete` read (null when it failed), log it and answer anyone waiting. */
export function settleGlass(info: unknown): void {
  if (current) return
  const adapters = (info as { gpuDevice?: GpuAdapter[] } | null)?.gpuDevice ?? []
  current = judgeGlass({
    platform: process.platform,
    override: process.env.SINGZ_GLASS,
    compositing: app.getGPUFeatureStatus().gpu_compositing,
    adapters
  })
  log('hw', `glass ${current.glass ? 'on' : 'off'} — ${current.reason}`)
  settleFirst(current)
  if (process.platform !== 'win32' || !current.glass) return
  // Only Windows is judged, so only Windows has glass to take back.
  const watch = (): void => {
    const withdrawn = current && withdrawnGlass(current, app.getGPUFeatureStatus().gpu_compositing)
    if (!withdrawn) return
    current = withdrawn
    log('hw', `glass off — ${withdrawn.reason}`)
    app.off('gpu-info-update', watch)
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('gpu:glass', withdrawn)
    }
  }
  app.on('gpu-info-update', watch)
}

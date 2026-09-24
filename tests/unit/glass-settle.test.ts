/*
 * The glass verdict's wiring (src/main/glass.ts): the renderer's question is
 * answered only once main has judged the launch's one GPU read, a second read
 * never re-judges, and a fall to software compositing takes the glass back and
 * tells the window — once. A GPU process that crashes often enough is how a
 * strong machine ends up running every blur on its CPU, and no driver can make
 * that happen on demand, so the watcher is proven here against a stand-in app.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlassVerdict } from '../../src/shared/types'

const electron = vi.hoisted(() => ({
  compositing: 'enabled',
  sent: [] as Array<[string, unknown]>,
  listeners: new Map<string, Set<() => void>>()
}))

vi.mock('electron', () => {
  const app = {
    getGPUFeatureStatus: () => ({ gpu_compositing: electron.compositing }),
    on: (event: string, fn: () => void) => {
      if (!electron.listeners.has(event)) electron.listeners.set(event, new Set())
      electron.listeners.get(event)!.add(fn)
    },
    off: (event: string, fn: () => void) => electron.listeners.get(event)?.delete(fn),
    getPath: () => '/nonexistent',
    getVersion: () => '0.0.0-test',
    getName: () => 'SingZ'
  }
  const win = { isDestroyed: () => false, webContents: { send: (ch: string, v: unknown) => electron.sent.push([ch, v]) } }
  return { app, BrowserWindow: { getAllWindows: () => [win], getFocusedWindow: () => win }, dialog: {} }
})

const emit = (event: string): void => {
  for (const fn of [...(electron.listeners.get(event) ?? [])]) fn()
}
const pushed = (): unknown[] => electron.sent.filter(([ch]) => ch === 'gpu:glass').map(([, v]) => v)
const rtx = { gpuDevice: [{ active: true, vendorId: 0x10de, deviceString: 'NVIDIA GeForce RTX 3070' }] }
const gt750m = { gpuDevice: [{ active: true, vendorId: 0x10de, deviceString: 'NVIDIA GeForce GT 750M' }] }

const realPlatform = process.platform
const onPlatform = (platform: string): void => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}
/** A fresh module, so each test starts before the launch's verdict. */
const load = async () => {
  vi.resetModules()
  return import('../../src/main/glass')
}

beforeEach(() => {
  electron.compositing = 'enabled'
  electron.sent.length = 0
  electron.listeners.clear()
  delete process.env.SINGZ_GLASS
  onPlatform('win32')
})
afterEach(() => onPlatform(realPlatform))

describe('the glass verdict, settled once per launch', () => {
  it('answers the renderer only after the read is judged, and judges once', async () => {
    const glass = await load()
    let answer: GlassVerdict | null = null
    void glass.glassVerdict().then((v) => (answer = v))
    await Promise.resolve()
    expect(answer).toBeNull()
    glass.settleGlass(rtx)
    await Promise.resolve()
    expect(answer).toEqual({ glass: true, reason: 'NVIDIA GeForce RTX 3070 composites' })
    glass.settleGlass(gt750m)
    expect(await glass.glassVerdict()).toEqual({ glass: true, reason: 'NVIDIA GeForce RTX 3070 composites' })
  })

  it('takes the glass back when compositing falls to software, and tells the window once', async () => {
    const glass = await load()
    glass.settleGlass(rtx)
    emit('gpu-info-update')
    expect(pushed()).toEqual([])
    electron.compositing = 'disabled_software'
    emit('gpu-info-update')
    emit('gpu-info-update')
    const withdrawn = { glass: false, reason: 'compositing fell back to disabled_software' }
    expect(pushed()).toEqual([withdrawn])
    expect(await glass.glassVerdict()).toEqual(withdrawn)
    // The watcher retires with the glass it guarded.
    expect(electron.listeners.get('gpu-info-update')?.size ?? 0).toBe(0)
  })

  it('withdraws a forced glass too — the override judges a GPU, and there is none left', async () => {
    process.env.SINGZ_GLASS = '1'
    const glass = await load()
    glass.settleGlass(gt750m)
    expect(await glass.glassVerdict()).toEqual({ glass: true, reason: 'forced on by SINGZ_GLASS' })
    electron.compositing = 'disabled_software'
    emit('gpu-info-update')
    expect(pushed()).toEqual([{ glass: false, reason: 'compositing fell back to disabled_software' }])
  })

  it('watches nothing when there is no glass to take back', async () => {
    const solid = await load()
    solid.settleGlass(gt750m)
    expect(electron.listeners.get('gpu-info-update')?.size ?? 0).toBe(0)
    onPlatform('darwin')
    const mac = await load()
    mac.settleGlass(rtx)
    expect(await mac.glassVerdict()).toEqual({ glass: true, reason: 'not Windows' })
    expect(electron.listeners.get('gpu-info-update')?.size ?? 0).toBe(0)
  })

  it('settles solid when the read failed', async () => {
    const glass = await load()
    glass.settleGlass(null)
    expect(await glass.glassVerdict()).toEqual({ glass: false, reason: 'no active GPU reported' })
  })
})

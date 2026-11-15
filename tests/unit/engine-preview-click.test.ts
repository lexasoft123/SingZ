import { afterEach, describe, expect, it, vi } from 'vitest'
import { MultitrackEngine } from '../../src/renderer/src/audio/engine'
import type { DesktopPreviewClickResult } from '../../src/shared/types'

function engineFixture() {
  // Isolate preview from the constructor's temporary legacy graph. A native
  // preview must never touch any context field, even when no song is loaded.
  const engine = Object.create(MultitrackEngine.prototype) as MultitrackEngine
  const scheduleClick = vi.fn()
  Object.assign(engine, { met: { volume: .37 }, masterVol: .2, teardownStarted: false,
    nativeMonitorLease: false, nativePlayback: null, scheduleClick,
    ctx: new Proxy({}, { get() { throw new Error('Chromium output was touched') } }) })
  return { engine, scheduleClick }
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
describe('native idle click preview', () => {
  it.each([false, true])('uses the shared native client, accent=%s, with no song', async accent => {
    const preview = vi.fn(async (): Promise<DesktopPreviewClickResult> => ({ ok: true }))
    vi.stubGlobal('window', { singz: { previewDesktopClick: preview } })
    const { engine, scheduleClick } = engineFixture()
    expect(await engine.previewClick(accent)).toEqual({ ok: true })
    expect(preview).toHaveBeenCalledWith(accent, .37) // Master is applied exactly once by the service.
    expect(scheduleClick).not.toHaveBeenCalled()
  })
  it('also previews while native song/monitor output owns the device', async () => {
    const preview = vi.fn(async () => ({ ok: true }))
    vi.stubGlobal('window', { singz: { previewDesktopClick: preview } })
    const { engine } = engineFixture()
    Object.assign(engine, { nativeMonitorLease: true, nativePlayback: { active: true } })
    expect(await engine.previewClick()).toEqual({ ok: true })
    expect(preview).toHaveBeenCalledOnce()
  })
  it.each(['refused', 'rejected', 'missing'] as const)('returns a typed %s failure without touching Chromium', async mode => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failure = { ok: false, errorCode: 'queue-full', error: 'queue full' } as const
    const preview = mode === 'missing' ? undefined : vi.fn(() => mode === 'rejected'
      ? Promise.reject(new Error('device lost')) : Promise.resolve(failure))
    vi.stubGlobal('window', { singz: { previewDesktopClick: preview } })
    const { engine, scheduleClick } = engineFixture()
    Object.assign(engine, { nativePlayback: { active: true } })
    expect(await engine.previewClick()).toMatchObject({ ok: false, errorCode: mode === 'refused'
      ? 'queue-full' : mode === 'missing' ? 'addon-unavailable' : 'output-unavailable' })
    expect(report).toHaveBeenCalledOnce()
    expect(scheduleClick).not.toHaveBeenCalled()
  })
  it('refuses a missing native preview even without a song owner', async () => {
    vi.stubGlobal('window', { singz: {} })
    const { engine, scheduleClick } = engineFixture()
    Object.assign(engine, { ctx: { state: 'running', currentTime: 12 } })
    await expect(engine.previewClick(true)).resolves.toMatchObject({ ok: false, errorCode: 'addon-unavailable' })
    expect(scheduleClick).not.toHaveBeenCalled()
  })
})

import { afterEach, expect, it, vi } from 'vitest'
import { releaseRetainedPlayback } from '../../src/renderer/src/components/RetainedAudioControl'
afterEach(() => vi.unstubAllGlobals())
function fixture() {
  const status = vi.fn(async () => ({ generation: '17', state: 'running' }))
  const unload = vi.fn(async (_generation: string) => ({ ok: true, cleanupComplete: true, error: '' }))
  vi.stubGlobal('window', { singz: { desktopPlaybackStatus: status, unloadDesktopPlayback: unload } })
  return { status, unload }
}
it('releases the exact retained generation on a deliberate new file open', async () => {
  const { unload } = fixture()
  expect(await releaseRetainedPlayback(() => true)).toBeNull()
  expect(unload).toHaveBeenCalledExactlyOnceWith('17')
})
it('does not retire playback for a stale file request', async () => {
  const { status, unload } = fixture()
  let current = true
  status.mockImplementationOnce(async () => { current = false; return { generation: '17', state: 'running' } })
  expect(await releaseRetainedPlayback(() => current)).toBeNull()
  expect(unload).not.toHaveBeenCalled()
})
it('refuses replacement without a cleanup receipt while audio remains owned', async () => {
  const { unload } = fixture()
  unload.mockResolvedValueOnce({ ok: true, cleanupComplete: false, error: 'still retained' })
  expect(await releaseRetainedPlayback(() => true)).toBe('still retained')
})
it('accepts proof that another cleanup already retired the retained session', async () => {
  const { status, unload } = fixture()
  unload.mockResolvedValueOnce({ ok: false, cleanupComplete: false, error: 'generation gone' })
  status.mockResolvedValueOnce({ generation: '17', state: 'running' }).mockResolvedValueOnce({ generation: '0', state: 'unloaded' })
  expect(await releaseRetainedPlayback(() => true)).toBeNull()
})

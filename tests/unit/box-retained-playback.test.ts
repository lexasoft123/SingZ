import { describe, expect, it, vi } from 'vitest'
import { RetainedPlaybackController } from '../../src/renderer/src/box/retained-playback'
import { retainedPlaybackSnapshot } from '../../src/shared/box-retained-playback'
import type { BoxResult, BoxRetainedPlaybackSnapshot } from '../../src/shared/box-contract'
import type { SingzApi } from '../../src/shared/types'
const snapshot = (generation = '1', epoch = 'epoch-a', playing = true): BoxResult<BoxRetainedPlaybackSnapshot> => ({ ok: true, value: { epoch, playback: { generation, state: generation === '0' ? 'unloaded' : 'running', transportState: playing ? 'playing' : 'paused' } } })
function fixture() {
  const read = vi.fn(async () => snapshot())
  const stop = vi.fn(async () => snapshot('0'))
  const api = { boxAudioPersistent: true, box: { retainedPlaybackSnapshot: read, stopRetainedPlayback: stop } } as unknown as Pick<SingzApi, 'boxAudioPersistent' | 'box'>
  return { api, read, stop, controller: new RetainedPlaybackController(api) }
}
describe('retained song controls', () => {
  it('rereads exact epoch/generation before explicit Stop and confirms released status before hiding', async () => {
    const { controller, stop } = fixture()
    await controller.refresh(); await controller.stop()
    expect(stop).toHaveBeenCalledWith({ epoch: 'epoch-a', generation: '1' })
    expect(controller.getSnapshot().generation).toBeNull()
  })
  it('cannot stop a replacement generation or reused counter in a new service epoch', async () => {
    for (const replacement of [snapshot('2'), snapshot('1', 'epoch-b')]) {
      const { controller, read, stop } = fixture()
      await controller.refresh()
      read.mockResolvedValueOnce(replacement)
      await controller.stop()
      expect(stop).not.toHaveBeenCalled()
      expect(controller.getSnapshot().error).toContain('song changed')
    }
  })
  it('keeps uncertain unload visible until an explicit recovery snapshot confirms unloaded', async () => {
    const { controller, stop, read } = fixture()
    await controller.refresh()
    stop.mockRejectedValueOnce(new Error('outcome uncertain'))
    await controller.stop()
    expect(controller.getSnapshot()).toMatchObject({ generation: '1', error: 'outcome uncertain' })
    await controller.refresh()
    expect(controller.getSnapshot().generation).toBe('1')
    read.mockResolvedValueOnce(snapshot('0'))
    await controller.refresh()
    expect(controller.getSnapshot()).toMatchObject({ generation: null, error: '' })
  })
  it('rejects cleanup acknowledgement without released readback', async () => {
    const { controller, stop } = fixture()
    stop.mockResolvedValueOnce(snapshot())
    await controller.refresh(); await controller.stop()
    expect(controller.getSnapshot().generation).toBe('1')
    expect(controller.getSnapshot().error).toContain('not confirmed')
  })
  it('does not unload after unmount while the stop preflight is pending', async () => {
    const { controller, read, stop } = fixture()
    await controller.refresh()
    let resolve!: (value: BoxResult<BoxRetainedPlaybackSnapshot>) => void
    read.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const stopping = controller.stop()
    controller.dispose(); controller.resume(); resolve(snapshot())
    await stopping
    expect(stop).not.toHaveBeenCalled()
  })
  it('does not query or mutate ordinary Box/Desktop audio', async () => {
    const { api, read, stop } = fixture()
    const controller = new RetainedPlaybackController({ ...api, boxAudioPersistent: false })
    await controller.refresh(); await controller.stop()
    expect(read).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled()
  })
  it('validates retained reply shape and projects only relevant native fields', () => {
    expect(() => retainedPlaybackSnapshot({ epoch: '', playback: null })).toThrow('epoch')
    expect(() => retainedPlaybackSnapshot({ epoch: 'e', playback: { generation: 9007199254740993, state: 'running', transportState: 'playing' } })).toThrow('status')
    expect(() => retainedPlaybackSnapshot({ epoch: 'e', playback: { generation: '1', state: 'bogus', transportState: 'playing' } })).toThrow('status')
    expect(retainedPlaybackSnapshot({ epoch: 'e', playback: { generation: '1', state: 'running', transportState: 'playing', secret: 'ignored' }, routing: 'ignored' })).toEqual({ epoch: 'e', playback: { generation: '1', state: 'running', transportState: 'playing' } })
  })
})

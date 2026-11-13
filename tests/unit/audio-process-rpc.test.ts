import { afterEach, describe, expect, it, vi } from 'vitest'
import { AUDIO_RPC_BYTES, AUDIO_RPC_LIMIT, AUDIO_RPC_TIMEOUT_MS, AudioProcessRpc, audioMessageBytes, audioMethodAllowed, type AudioRequest } from '../../src/main/audio-process-rpc'

afterEach(() => vi.useRealTimers())

function fixture(timeout = 1000) {
  const sent: AudioRequest[] = []
  const endpoint = { postMessage: vi.fn((message: unknown) => sent.push(message as AudioRequest)), kill: vi.fn(() => true) }
  const failure = vi.fn()
  return { sent, endpoint, failure, rpc: new AudioProcessRpc('epoch-a', endpoint, timeout, failure) }
}

describe('dedicated audio process control channel', () => {
  it('fences stale epochs and ignores duplicated or unknown replies', async () => {
    const { rpc, sent } = fixture()
    const result = rpc.request('owner', 'pausePlayback', [1, '8'])
    rpc.receive({ type: 'reply', epoch: 'epoch-old', id: sent[0].id, ok: true, value: 'wrong' })
    rpc.receive({ type: 'reply', epoch: 'epoch-a', id: 999, ok: true, value: 'wrong' })
    expect(rpc.outstanding).toBe(1)
    rpc.receive({ type: 'reply', epoch: 'epoch-a', id: sent[0].id, ok: true, value: { ok: true, generation: '8' } })
    expect(await result).toEqual({ ok: true, generation: '8' })
    rpc.receive({ type: 'reply', epoch: 'epoch-a', id: sent[0].id, ok: true, value: 'duplicate' })
    expect(rpc.outstanding).toBe(0)
    expect(rpc.outstandingBytes).toBe(0)
  })

  it('bounds outstanding work and releases budget on failure', async () => {
    const { rpc, sent } = fixture()
    const pending = Array.from({ length: AUDIO_RPC_LIMIT }, () => rpc.request('owner', 'playbackStatus', []).catch(error => error.message))
    await expect(rpc.request('owner', 'startPlayback', [1, '8'])).rejects.toThrow('full')
    expect(sent).toHaveLength(AUDIO_RPC_LIMIT)
    rpc.fail(new Error('helper exited'))
    expect(await Promise.all(pending)).toEqual(Array(AUDIO_RPC_LIMIT).fill('helper exited'))
    expect(rpc.outstanding).toBe(0)
    expect(rpc.outstandingBytes).toBe(0)
    await expect(rpc.request('owner', 'resumePlayback', [1, '8'])).rejects.toThrow('helper exited')
  })

  it('accounts PCM bytes without copying and rejects oversized or cyclic data before sending', async () => {
    const { rpc, sent } = fixture()
    const pcm = new Float32Array(480)
    expect(audioMessageBytes(pcm)).toBe(pcm.byteLength + 32)
    const cycle: unknown[] = []; cycle.push(cycle)
    await expect(rpc.request('binding', 'scheduleTrainingCue', [cycle])).rejects.toThrow('Cyclic')
    await expect(rpc.request('binding', 'scheduleTrainingCue', [new Uint8Array(AUDIO_RPC_BYTES)])).rejects.toThrow('limit')
    expect(sent).toHaveLength(0)
  })

  it('kills a timed-out lifetime and refuses late successful replies', async () => {
    vi.useFakeTimers()
    const { rpc, sent, endpoint, failure } = fixture(30)
    const starting = rpc.request('owner', 'startPlayback', [1, '8'])
    const cancelling = rpc.request('owner', 'unloadPlayback', [1, '8'])
    const settled = Promise.allSettled([starting, cancelling])
    await vi.advanceTimersByTimeAsync(30)
    expect((await settled).map(value => value.status)).toEqual(['rejected', 'rejected'])
    expect(endpoint.kill).toHaveBeenCalledOnce()
    expect(failure).toHaveBeenCalledOnce()
    rpc.receive({ type: 'reply', epoch: 'epoch-a', id: sent[0].id, ok: true, value: { ok: true } })
    await expect(rpc.request('owner', 'playbackStatus', [])).rejects.toThrow('timed out')
  })

  it('gives streaming conform its bounded longer deadline while preserving explicit timeouts', async () => {
    vi.useFakeTimers()
    const { rpc, sent, endpoint } = fixture(AUDIO_RPC_TIMEOUT_MS)
    const work = rpc.request('binding', 'conformTake', ['input', 'output', {}, 'job'])
    await vi.advanceTimersByTimeAsync(AUDIO_RPC_TIMEOUT_MS)
    expect(endpoint.kill).not.toHaveBeenCalled()
    rpc.receive({ type: 'reply', epoch: 'epoch-a', id: sent[0].id, ok: true, value: { ok: true } })
    await expect(work).resolves.toEqual({ ok: true })
    const custom = fixture(30)
    const bounded = expect(custom.rpc.request('binding', 'conformTake', [])).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(30); await bounded; expect(custom.endpoint.kill).toHaveBeenCalledOnce()
  })
  it('terminates the lifetime on a malformed successful reply', async () => {
    const { rpc, sent, endpoint } = fixture()
    const pending = rpc.request('owner', 'playbackStatus', [])
    const checked = expect(pending).rejects.toThrow('malformed')
    rpc.receive({ type: 'reply', epoch: 'epoch-a', id: sent[0].id, ok: 'yes', value: null } as never)
    await checked
    expect(endpoint.kill).toHaveBeenCalledOnce()
    expect(rpc.outstanding).toBe(0)
  })

  it('lets cancellation reach a helper while prepare is pending', async () => {
    const { rpc, sent } = fixture()
    const preparing = rpc.request('owner', 'preparePlayback', [1, {}, []])
    const cancelling = rpc.request('owner', 'unloadPlayback', [1, '9'])
    expect(sent.map(message => message.method)).toEqual(['preparePlayback', 'unloadPlayback'])
    rpc.receive({ type: 'reply', epoch: 'epoch-a', id: sent[1].id, ok: true, value: { ok: true, cleanupComplete: true } })
    expect(await cancelling).toMatchObject({ cleanupComplete: true })
    rpc.receive({ type: 'reply', epoch: 'epoch-a', id: sent[0].id, ok: true, value: { ok: false, error: 'cancelled' } })
    expect(await preparing).toMatchObject({ ok: false })
  })

  it('rejects all work and kills the helper when send fails', async () => {
    const { rpc, endpoint } = fixture()
    endpoint.postMessage.mockImplementation(() => { throw new Error('port closed') })
    await expect(rpc.request('owner', 'startPlayback', [1, '9'])).rejects.toThrow('send failed')
    expect(endpoint.kill).toHaveBeenCalledOnce()
    expect(rpc.outstandingBytes).toBe(0)
  })
})


it('allowlists native output intent only through validated ownership', () => {
  expect(audioMethodAllowed('owner', 'setPlaybackOutputCurrent')).toBe(true)
  expect(audioMethodAllowed('binding', 'setPlaybackOutputCurrent')).toBe(false)
  expect(audioMethodAllowed('owner', 'setPlaybackOutputCurrentUnsafe')).toBe(false)
})

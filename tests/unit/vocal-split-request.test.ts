import { describe, expect, it, vi } from 'vitest'
import { type CheckedAwait, canResplitVocals, restartPendingLyrics, runVocalSplitRequest, settleCancelledLyrics, VocalSplitRequests } from '../../src/renderer/src/vocal-split-request'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const paths = { ok: true as const, lead: 'lead.wav', backing: 'backing.wav' }
function operations() {
  return {
    separate: vi.fn(async () => paths),
    read: vi.fn(async () => new ArrayBuffer(8)),
    decode: vi.fn(async () => ({ samples: 8 })),
    prepare: vi.fn(async (_checked: CheckedAwait): Promise<void> => {}),
    commit: vi.fn(),
    recover: vi.fn()
  }
}

describe('whole vocal split request ownership', () => {
  it('disowns successful main output when cancel lands during an opaque lead decode', async () => {
    const requests = new VocalSplitRequests(), ops = operations()
    const started = deferred<void>(), decode = deferred<{ samples: number }>()
    ops.decode.mockImplementationOnce(() => { started.resolve(); return decode.promise })
    const result = runVocalSplitRequest(requests.begin(), ops)
    await started.promise
    requests.cancel()
    decode.resolve({ samples: 100 })
    expect(await result).toBe('discarded')
    expect(ops.commit).not.toHaveBeenCalled()
    expect(ops.prepare).not.toHaveBeenCalled()
    expect(ops.read).toHaveBeenCalledTimes(1) // backing work never starts
  })

  it('disowns a deferred backing decode on a song switch', async () => {
    const requests = new VocalSplitRequests(), ops = operations()
    const started = deferred<void>(), decode = deferred<{ samples: number }>()
    ops.decode.mockImplementationOnce(async () => ({ samples: 8 }))
      .mockImplementationOnce(() => { started.resolve(); return decode.promise })
    const result = runVocalSplitRequest(requests.begin(), ops)
    await started.promise
    requests.begin() // the next song owns all later work
    decode.resolve({ samples: 8 })
    expect(await result).toBe('discarded')
    expect(ops.commit).not.toHaveBeenCalled()
  })

  it('recovers stopped analyses if cancel lands while final preparation is awaiting IPC', async () => {
    const requests = new VocalSplitRequests(), ops = operations()
    const started = deferred<void>(), cancelledNative = deferred<void>()
    ops.prepare = vi.fn(async () => { started.resolve(); await cancelledNative.promise })
    const result = runVocalSplitRequest(requests.begin(), ops)
    await started.promise
    requests.cancel(); cancelledNative.resolve()
    expect(await result).toBe('discarded')
    expect(ops.commit).not.toHaveBeenCalled()
    expect(ops.recover).toHaveBeenCalledOnce()
  })

  it('restarts concurrent lyrics under the new song revision, then allows their result to land', async () => {
    const requests = new VocalSplitRequests(), ops = operations()
    let loadSeq = 1, lyrics: string = 'loading'
    const oldSeq = loadSeq
    const oldLookup = deferred<string>(), newLookup = deferred<string>()
    const oldResult = oldLookup.promise.then(value => { if (loadSeq === oldSeq) lyrics = value })
    let newResult = Promise.resolve()
    ops.commit = vi.fn(() => {
      ++loadSeq
      restartPendingLyrics(lyrics === 'loading', () => { lyrics = 'idle' }, () => {
        expect(lyrics).toBe('idle') // bypass the existing loading guard
        const seq = loadSeq
        lyrics = 'loading'
        newResult = newLookup.promise.then(value => { if (loadSeq === seq) lyrics = value })
      })
    })
    expect(await runVocalSplitRequest(requests.begin(), ops)).toBe('committed')
    oldLookup.resolve('old result'); await oldResult
    expect(lyrics).toBe('loading')
    newLookup.resolve('ready'); await newResult
    expect(lyrics).toBe('ready')
    expect(ops.commit).toHaveBeenCalledOnce()
  })

  it('keeps ready lyrics and blocks re-split for pending or saved separated vocals', () => {
    const reset = vi.fn(), start = vi.fn()
    restartPendingLyrics(false, reset, start)
    expect(reset).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
    expect(canResplitVocals('lead.wav', false, false)).toBe(false)
    expect(canResplitVocals(null, true, false)).toBe(false)
    expect(canResplitVocals(null, false, false)).toBe(true)
    expect(canResplitVocals(null, false, true)).toBe(false)
  })

  it('waits for delayed lyrics cancellation to release busy before commit or recovery restarts', async () => {
    for (const discard of [false, true]) {
      const requests = new VocalSplitRequests(), ops = operations()
      const childExited = deferred<void>(), cancelSent = deferred<void>()
      let busy = true, oldResultApplied = false, lyricsRevision = 1
      const oldRevision = lyricsRevision
      const oldLookup = childExited.promise.then(() => {
        busy = false
        if (lyricsRevision === oldRevision) oldResultApplied = true
      })
      ops.prepare = vi.fn(async checked => {
        ++lyricsRevision
        await checked(settleCancelledLyrics(async () => { cancelSent.resolve() }, oldLookup))
      })
      const restart = vi.fn(() => { expect(busy).toBe(false) })
      ops.commit = restart; ops.recover = restart
      const result = runVocalSplitRequest(requests.begin(), ops)
      await cancelSent.promise
      if (discard) requests.cancel()
      await Promise.resolve()
      expect(restart).not.toHaveBeenCalled()
      expect(busy).toBe(true)
      childExited.resolve()
      expect(await result).toBe(discard ? 'discarded' : 'committed')
      expect(oldResultApplied).toBe(false)
      expect(restart).toHaveBeenCalledOnce()
    }
  })

})


describe('missing vocal models', () => {
  it('opens model setup without touching audio or cancelling analyses', async () => {
    const ops = { ...operations(),
      separate: vi.fn(async () => ({ ok: false as const, error: 'Download models', needsModels: ['backing-vocals' as const] })),
      modelsRequired: vi.fn(async () => {})
    }
    expect(await runVocalSplitRequest(() => true, ops)).toBe('discarded')
    expect(ops.modelsRequired).toHaveBeenCalledExactlyOnceWith(['backing-vocals'])
    expect(ops.read).not.toHaveBeenCalled()
    expect(ops.prepare).not.toHaveBeenCalled()
    expect(ops.commit).not.toHaveBeenCalled()
  })
  it('does not open model setup for a request cancelled before the result arrives', async () => {
    const requests = new VocalSplitRequests()
    const response = deferred<{ ok: false; error: string; needsModels: ['backing-vocals'] }>()
    const ops = { ...operations(), separate: () => response.promise, modelsRequired: vi.fn(async () => {}) }
    const result = runVocalSplitRequest(requests.begin(), ops)
    requests.cancel()
    response.resolve({ ok: false, error: 'Download models', needsModels: ['backing-vocals'] })
    expect(await result).toBe('discarded')
    expect(ops.modelsRequired).not.toHaveBeenCalled()
  })
})

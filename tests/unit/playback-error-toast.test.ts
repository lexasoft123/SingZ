import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import type { EnginePlaybackError } from '../../src/renderer/src/audio/engine'
import { playbackErrorToast } from '../../src/renderer/src/playback-error-toast'

const providerError: EnginePlaybackError = {
  reason: 'toggle',
  code: 'provider-cleanup-incomplete',
  provider: 'asio',
  message: 'ASIO cleanup is incomplete.',
  cause: null
}

describe('scoped playback error toast', () => {
  it('clears immediately on successful retry without consuming an unrelated app error', () => {
    const failed = playbackErrorToast(providerError)
    expect(failed).toEqual({
      source: 'engine-playback',
      message: 'Playback could not start: ASIO cleanup is incomplete.'
    })

    const unrelatedAppError = 'Could not save the project.'
    const retried = playbackErrorToast(null)
    expect(retried).toBeNull()
    expect(unrelatedAppError ?? retried?.message).toBe(unrelatedAppError)
  })

  it('wires the engine null transition to its own subscriber state and renders scoped priority', () => {
    const source = readFileSync('src/renderer/src/App.tsx', 'utf8')
    expect(source).toContain('setEnginePlaybackToast(playbackErrorToast(playbackError))')
    expect(source).toContain('const visibleError = error ?? enginePlaybackToast?.message ?? null')
    expect(source).not.toContain('if (playbackError) setError(')
  })
})

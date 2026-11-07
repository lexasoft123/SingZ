import { describe, expect, it } from 'vitest'
import { shouldDeferBoxApplicationQuit, shouldResumeBoxApplicationQuit } from '../../src/main/box-close-policy'

describe('Box application quit completion', () => {
  it('defers only an unfinished Box quit and never changes Desktop behavior', () => {
    expect(shouldDeferBoxApplicationQuit('box', false)).toBe(true)
    expect(shouldDeferBoxApplicationQuit('box', true)).toBe(false)
    expect(shouldDeferBoxApplicationQuit('desktop', false)).toBe(false)
    expect(shouldDeferBoxApplicationQuit('desktop', true)).toBe(false)
  })

  it('resumes after acknowledgement or bounded timeout, not after an ordinary window close', () => {
    expect(shouldResumeBoxApplicationQuit(true, 0, 1)).toBe(false)
    expect(shouldResumeBoxApplicationQuit(true, 1, 1)).toBe(true)
    expect(shouldResumeBoxApplicationQuit(true, 2, 2)).toBe(true)
    expect(shouldResumeBoxApplicationQuit(true, 0, 0)).toBe(true)
    expect(shouldResumeBoxApplicationQuit(false, 1, 1)).toBe(false)
  })
})

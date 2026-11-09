import { describe, expect, it } from 'vitest'
import { shouldDeferBoxApplicationQuit } from '../../src/main/box-close-policy'

describe('Box application quit completion', () => {
  it('defers only an unfinished Box quit and never changes Desktop behavior', () => {
    expect(shouldDeferBoxApplicationQuit('box', false)).toBe(true)
    expect(shouldDeferBoxApplicationQuit('box', true)).toBe(false)
    expect(shouldDeferBoxApplicationQuit('desktop', false)).toBe(false)
    expect(shouldDeferBoxApplicationQuit('desktop', true)).toBe(false)
  })
})

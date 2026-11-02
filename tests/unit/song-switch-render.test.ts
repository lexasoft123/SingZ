import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// A catalog → song switch must go from the catalog straight to the loading
// screen. The render shows the player whenever the phase is 'ready' and the
// catalog is closed, so a loader that closed the catalog before
// setPhase('loading') mounted the whole player of the song being LEFT: on the
// Windows field laptop, visible (2026-09-27), every switch spent ~50 ms of
// the renderer on it and painted it to the screen for a frame or two. Held
// at the source, like the loader's other orderings: no headless suite renders
// the app, and the E2E drivers switch songs without looking at the frames.
describe('switching songs from the catalog', () => {
  const source = readFileSync('src/renderer/src/App.tsx', 'utf8')
  const loadPath = source.slice(source.indexOf('const loadPath:'), source.indexOf('const loadFile ='))

  // Comments stripped, since the ones beside these calls name them too; no
  // string in loadPath holds a `//`. Unanchored, so `x;y` on one line counts.
  const code = loadPath.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  const found = (re: RegExp): number[] => [...code.matchAll(re)].map((m) => m.index ?? -1)

  it('closes the catalog only in the synchronous block that shows the loading screen', () => {
    const [loading, ...more] = found(/\bsetPhase\('loading'\)/g)
    const closes = found(/\bsetShowCatalog\(false\)/g)
    expect(more).toEqual([])
    expect(loading).toBeGreaterThan(-1)
    expect(closes.length).toBeGreaterThan(0)
    for (const at of closes) {
      expect(at).toBeGreaterThan(loading)
      expect(code.slice(loading, at)).not.toMatch(/\bawait\b/)
    }
  })

  it('is guarding the render it was written for: the player only when ready and the catalog closed', () => {
    expect(source).toContain(") : phase === 'ready' && !showCatalog ? (")
  })
})

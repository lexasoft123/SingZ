/*
 * No layer the playhead crosses may carry a `filter` that moves pixels.
 *
 * A `drop-shadow` or `blur` makes the compositor widen any damage touching
 * the filtered layer to the WHOLE layer, and the playhead crosses every lane
 * on every device pixel it moves. The kit's 2px lane glow, written as a CSS
 * drop-shadow on the six resting canvases, took the playing player from 20%
 * to 57% of the field laptop's GPU and added 34 points of DWM on top: every
 * step re-composited the entire lane stack. @singz/ui draws that glow into
 * the canvas since v1.7.1; colour filters (`saturate`, `brightness`) move no
 * pixels and are fine. This reads the kit's sheet and the app's and fails on
 * a pixel-moving filter on any of the player's lane layers. Textual on
 * purpose, like windows-no-blur.test.ts.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/** The lane stack and everything drawn inside it that the playhead crosses. */
const LANE_LAYERS = /\.(stack|ruler|lane-wave|wave|wave-base|wave-bright|beat-lines|scrub-overlay|playhead|playhead-cap)(?![\w-])/
const FILTER_PROPS = ['filter', '-webkit-filter']
const MOVES_PIXELS = /\b(drop-shadow|blur)\s*\(/

type Rule = { selector: string; decls: Map<string, string> }

/** Rules of a stylesheet, descending into @media/@supports/@layer blocks;
 *  @keyframes and @font-face bodies are not selectors and are skipped, and a
 *  top-level statement (`@layer a, b;`, `@import …;`) ends at its semicolon
 *  rather than gluing itself onto the next rule's selector. */
function rules(css: string): Rule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const out: Rule[] = []
  const walk = (src: string): void => {
    let i = 0
    while (i < src.length) {
      const open = src.indexOf('{', i)
      if (open < 0) return
      const prelude = src.slice(i, open).split(';').pop()!.trim()
      let depth = 1
      let j = open + 1
      for (; j < src.length && depth > 0; j++) {
        if (src[j] === '{') depth++
        else if (src[j] === '}') depth--
      }
      const body = src.slice(open + 1, j - 1)
      if (/^@(media|supports|layer)\b/.test(prelude)) walk(body)
      else if (!prelude.startsWith('@')) {
        const decls = new Map<string, string>()
        for (const d of body.split(';')) {
          const colon = d.indexOf(':')
          if (colon > 0) decls.set(d.slice(0, colon).trim().toLowerCase(), d.slice(colon + 1).trim())
        }
        out.push({ selector: prelude, decls })
      }
      i = j
    }
  }
  walk(text)
  return out
}

const sheets = (): Array<{ name: string; css: string }> => {
  const req = createRequire(resolve('src/renderer/src/main.tsx'))
  return [
    { name: '@singz/ui/kit.css', css: readFileSync(req.resolve('@singz/ui/kit.css'), 'utf8') },
    { name: 'styles.css', css: readFileSync(resolve('src/renderer/src/styles.css'), 'utf8') }
  ]
}

describe('the lanes carry no pixel-moving filter', () => {
  it('sees the kit\'s own wave rules, not just the app\'s (the walk reads what it guards)', () => {
    // Per sheet: the app's stylesheet names .wave-base/.wave-bright too (the
    // muted-lane rule), so a pooled check stays green even if the walk stops
    // seeing the kit's sheet — which is where the halo lived.
    const [kit, app] = sheets()
    const selectorsOf = (css: string): string =>
      rules(css)
        .filter((r) => LANE_LAYERS.test(r.selector))
        .map((r) => r.selector)
        .join('\n')
    expect(selectorsOf(kit.css)).toMatch(/(^|\n|,\s*)\.wave-base\s*($|\n|,)/)
    expect(selectorsOf(kit.css)).toMatch(/(^|\n|,\s*)\.wave-bright\s*($|\n|,)/)
    expect(selectorsOf(app.css)).toContain('.playhead')
  })

  it('reads a sheet whose rules sit inside @layer', () => {
    const layered = `@layer base, kit;
      @layer kit {
        .wave-base { filter: saturate(1.15) drop-shadow(0 0 2px white); }
      }`
    const hit = rules(layered).filter((r) => LANE_LAYERS.test(r.selector) && MOVES_PIXELS.test(r.decls.get('filter') ?? ''))
    expect(hit.map((r) => r.selector)).toEqual(['.wave-base'])
  })

  it('has no drop-shadow or blur filter on a layer the playhead crosses', () => {
    const offenders: string[] = []
    for (const { name, css } of sheets()) {
      for (const r of rules(css)) {
        if (!LANE_LAYERS.test(r.selector)) continue
        for (const p of FILTER_PROPS) {
          const v = r.decls.get(p)
          if (v && MOVES_PIXELS.test(v)) offenders.push(`${name}: ${r.selector} { ${p}: ${v} }`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('catches the halo as the kit used to write it', () => {
    const v170 = `.wave-base {
      filter: saturate(1.15) drop-shadow(0 0 2px color-mix(in srgb, var(--stem, #fff) 20%, transparent));
    }`
    const hit = rules(v170).filter((r) => LANE_LAYERS.test(r.selector) && MOVES_PIXELS.test(r.decls.get('filter') ?? ''))
    expect(hit).toHaveLength(1)
  })
})

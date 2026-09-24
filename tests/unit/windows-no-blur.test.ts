/*
 * The weak-GPU rule, enforced: every surface that blurs what is behind it
 * has a Windows twin that does not — unless main vouched for the machine's
 * GPU (`body.glass`, src/main/glass.ts), which gets the glass back.
 *
 * A `backdrop-filter` re-runs over its whole box whenever anything under or
 * inside it is damaged, and the fleet's QHD+ field laptop paid 15-18 points
 * of GPU for the transport's blur alone while a song played. Four
 * blurs got a twin — two after a field report (.modal-scrim, .transport), two
 * written alongside their glass (.vt-cleanup-gate, the lyrics editor's card)
 * — and three never did: the drop overlay, as old as the app, and the vocal
 * training session's head and dock. The rule lived only in
 * CLAUDE.md, so nothing noticed. This reads every stylesheet the renderer
 * imports and fails on a blur with no twin.
 *
 * A twin is an unconditional rule with `body.win:not(.glass)` added to the
 * glass rule's selector — as an ancestor, or joined onto a selector that
 * already starts at <body> (`body.modal-open .x` →
 * `body.win:not(.glass).modal-open .x`) — that sets every blurring property
 * to `none`, `!important` where the glass is, and a fill of its own: dropping
 * the blur without replacing the fill leaves a see-through surface over a
 * sharp background, which is a different design rather than the same one in
 * solid. A twin keyed on plain `body.win` is solid on every Windows machine,
 * so it needs a `body.win.glass` restore carrying the glass exactly — the
 * kit's own .modal-scrim twin is one, which styles.css restores, and a kit
 * that changed its glass would leave that restore behind. Every spelling
 * outranks the glass whatever order the rules appear in. Textual on purpose,
 * like the other CSS assertions here.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

type Decl = { value: string; important: boolean }
type Rule = { selectors: string[]; decls: Map<string, Decl>; media: string }

const BLUR_PROPS = ['backdrop-filter', '-webkit-backdrop-filter']
const RENDERER = 'src/renderer/src'

const scripts = (root: string, ext: RegExp): string[] =>
  readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((f) => ext.test(f))
    .map((f) => join(root, f))

/** Every stylesheet the renderer loads. Today that is main.tsx's four side-
 *  effect imports — two font packages (@font-face only), the kit's sheet, then
 *  the app's — and a fifth is read the day it is imported, without anyone
 *  having to remember this file: a side-effect import counts when it resolves
 *  to CSS (the font packages name none in their specifier), a named or
 *  dynamic one when its specifier does (`?inline` and the like included).
 *  A CSS module is refused, since its `:global` escapes are not read here. */
function rendererSheets(): string[] {
  const sheets = new Set<string>()
  for (const file of scripts(RENDERER, /\.tsx?$/)) {
    const req = createRequire(resolve(file))
    const source = readFileSync(file, 'utf8')
    const specs = [
      ...[...source.matchAll(/^import\s+['"]([^'"]+)['"]/gm)].map((m) => ({ spec: m[1], sideEffect: true })),
      ...[...source.matchAll(/^import\s[^'"]*?\sfrom\s+['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/gm)].map(
        (m) => ({ spec: m[1] ?? m[2], sideEffect: false })
      )
    ]
    for (const { spec, sideEffect } of specs) {
      const bare = spec.replace(/\?.*$/, '')
      // Named imports are judged by their text: resolving every one would trip
      // over packages that export for `import` only.
      if (!sideEffect && !bare.endsWith('.css')) continue
      if (bare.endsWith('.module.css')) throw new Error(`${file} imports the CSS module ${spec}, which this test cannot read`)
      const path = bare.startsWith('.') ? resolve(dirname(file), bare) : req.resolve(bare)
      if (path.endsWith('.css')) sheets.add(path)
    }
  }
  return [...sheets]
}

/** Split at top-level separators only — never inside parens or quotes, so
 *  `:is(.a, .b)` stays one selector and a data: URL stays one value. */
function splitTop(text: string, sep: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote = ''
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === quote && text[i - 1] !== '\\') quote = ''
    } else if (c === '"' || c === "'") quote = c
    else if (c === '(') depth++
    else if (c === ')') depth--
    else if (c === sep && depth === 0) {
      parts.push(text.slice(start, i))
      start = i + 1
    }
  }
  parts.push(text.slice(start))
  return parts.map((p) => p.trim().replace(/\s+/g, ' ')).filter(Boolean)
}

/** Style rules with the @media/@supports prelude they sit under ('' when
 *  unconditional). @keyframes and @font-face hold no selectors and are
 *  skipped; anything else — another at-rule, a statement such as @import,
 *  nesting, a brace out of place — throws instead of being passed over,
 *  because a rule the walker skips is a rule it cannot check. */
function parseSheet(css: string, path: string): Rule[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const refuse = (why: string): never => {
    throw new Error(`${path}: ${why} — teach this walker before trusting it`)
  }
  const out: Rule[] = []
  let i = 0
  const skipBlock = (): void => {
    let depth = 1
    for (; depth > 0 && i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') depth--
    }
    if (depth > 0) refuse('an unclosed block')
  }
  const walk = (media: string, nested: boolean): void => {
    for (;;) {
      const open = src.indexOf('{', i)
      const close = src.indexOf('}', i)
      const blockEnds = close !== -1 && (open === -1 || close < open)
      if (blockEnds || open === -1) {
        // This block (or the sheet) ends here, and nothing may be left before it.
        const until = blockEnds ? close : src.length
        const rest = src.slice(i, until).trim()
        if (rest) refuse(`text no rule owns: "${rest.replace(/\s+/g, ' ').slice(0, 60)}"`)
        if (!blockEnds) {
          if (nested) refuse('an unclosed block')
          return
        }
        if (!nested) refuse('a "}" that closes nothing')
        i = close + 1
        return
      }
      const prelude = src.slice(i, open).trim()
      i = open + 1
      if (prelude.includes(';')) refuse(`a statement before "${prelude.replace(/\s+/g, ' ').slice(0, 60)}"`)
      if (prelude.startsWith('@')) {
        const name = /^@([\w-]+)/.exec(prelude)?.[1]
        if (name === 'media' || name === 'supports') walk(`${media} ${prelude}`.trim(), true)
        else if (name === 'keyframes' || name === 'font-face') skipBlock()
        else refuse(`@${name}, which is neither read nor skipped`)
        continue
      }
      const end = src.indexOf('}', i)
      if (end === -1) refuse(`an unclosed rule "${prelude}"`)
      const body = src.slice(i, end)
      if (body.includes('{')) refuse(`a rule nested under "${prelude}"`)
      i = end + 1
      const decls = new Map<string, Decl>()
      for (const d of splitTop(body, ';')) {
        const colon = d.indexOf(':')
        if (colon <= 0) continue
        const value = d.slice(colon + 1).trim()
        const important = /!\s*important$/i.test(value)
        decls.set(d.slice(0, colon).trim().toLowerCase(), { value: value.replace(/!\s*important$/i, '').trim(), important })
      }
      out.push({ selectors: splitTop(prelude, ','), decls, media })
    }
  }
  walk('', false)
  return out
}

const blurring = (rule: Rule): string[] =>
  BLUR_PROPS.filter((p) => {
    const d = rule.decls.get(p)
    return d !== undefined && d.value !== 'none'
  })
const fill = (rule: Rule): string | undefined => (rule.decls.get('background') ?? rule.decls.get('background-color'))?.value

/** `body.win` + `state` (':not(.glass)', '' or '.glass') added to a glass
 *  selector: joined onto one that already starts at <body>, prefixed as its
 *  ancestor otherwise. Null when it starts above <body>, where no spelling
 *  names the same element. */
const spell = (selector: string, state: string): string | null =>
  /^body(?![\w-])/.test(selector)
    ? `body.win${state}${selector.slice(4)}`
    : /^(?:html|:root)(?![\w-])/.test(selector)
      ? null
      : `body.win${state} ${selector}`

/** The unconditional rule written as `spelled` that sets every one of `props`
 *  to what `want` says — `!important` wherever the glass is. */
const ruleSetting = (spelled: string, glassRule: Rule, props: string[], want: (glass: Decl) => string): Rule | undefined =>
  all.find(
    (r) =>
      !r.media &&
      r.selectors.includes(spelled) &&
      props.every((p) => {
        const glassDecl = glassRule.decls.get(p)!
        const d = r.decls.get(p)
        return d?.value === want(glassDecl) && (d.important || !glassDecl.important)
      })
  )

const sheets = rendererSheets()
const bySheet = sheets.map((path) => ({ path, rules: parseSheet(readFileSync(path, 'utf8'), path) }))
const all = bySheet.flatMap((s) => s.rules)
const glass = all.flatMap((rule) =>
  blurring(rule).length ? rule.selectors.map((selector) => ({ selector, rule })) : []
)

describe('Windows gets every blur in solid', () => {
  it('reads every sheet the renderer imports and finds the blurs it is meant to guard', () => {
    // A walker that silently parsed nothing would pass everything below.
    expect(sheets.map((p) => basename(p))).toEqual(expect.arrayContaining(['kit.css', 'styles.css']))
    for (const sheet of bySheet.filter((s) => /(?:^|[\\/])(?:kit|styles)\.css$/.test(s.path))) {
      expect(sheet.rules.length, sheet.path).toBeGreaterThan(40)
    }
    expect(glass.map((g) => g.selector)).toEqual(
      expect.arrayContaining([
        '.modal-scrim',
        '.transport',
        '.drop-overlay',
        '.vt-cleanup-gate',
        '.vt-session-head',
        '.vt-transport',
        '.modal-card.lyed-card'
      ])
    )
  })

  it('gives every blur an unconditional Windows twin with a fill of its own', () => {
    const problems: string[] = []
    for (const { selector, rule } of glass) {
      // Glass scoped to the mac never reaches Windows in the first place, and
      // a body.win.glass rule IS the restore — the next check reads those.
      if (/^body\.(?:mac|win\.glass)(?![\w-])/.test(selector)) continue
      const yielding = spell(selector, ':not(.glass)')
      const always = spell(selector, '')
      if (!yielding || !always) {
        problems.push(`${selector}: starts above <body>, where no body.win twin can name it`)
        continue
      }
      const props = blurring(rule)
      const twin = ruleSetting(yielding, rule, props, () => 'none') ?? ruleSetting(always, rule, props, () => 'none')
      if (!twin) {
        const blur = props.map((p) => `${p}: ${rule.decls.get(p)?.value}${rule.decls.get(p)?.important ? ' !important' : ''}`)
        problems.push(`${selector}: ${blur.join('; ')} has no \`${yielding}\` twin that sets it to none`)
        continue
      }
      const own = fill(twin)
      if (!own || own === fill(rule)) problems.push(`${selector}: its Windows twin drops the blur but keeps the glass fill`)
    }
    expect(problems).toEqual([])
  })

  it('gives a GPU main vouched for the same glass as the Mac', () => {
    const problems: string[] = []
    const answered = new Set<string>()
    for (const { selector, rule } of glass) {
      if (/^body\.(?:mac|win\.glass)(?![\w-])/.test(selector)) continue
      const always = spell(selector, '')
      const restore = spell(selector, '.glass')
      if (!always || !restore) continue // reported by the twin check
      const props = blurring(rule)
      // A twin keyed on body.win:not(.glass) steps aside by itself; one keyed
      // on plain body.win (the kit's scrim) is solid on EVERY Windows machine
      // until a body.win.glass rule puts the glass back — value for value, or a
      // strong GPU gets a blur the Mac does not, and `!important` wherever the
      // glass or that twin is, or the twin still wins.
      const plain = ruleSetting(always, rule, props, () => 'none')
      if (!plain) continue
      answered.add(restore)
      const back = all.find(
        (r) =>
          !r.media &&
          r.selectors.includes(restore) &&
          props.every((p) => {
            const d = r.decls.get(p)
            return d?.value === rule.decls.get(p)!.value && (d.important || !(rule.decls.get(p)!.important || plain.decls.get(p)!.important))
          })
      )
      if (!back) problems.push(`${selector}: its twin is solid on every Windows GPU and no \`${restore}\` rule restores the glass`)
      else if (fill(back) !== fill(rule)) {
        problems.push(`${selector}: \`${restore}\` restores the blur with fill ${fill(back)}, the glass has ${fill(rule)}`)
      }
    }
    // And no restore outlives the twin it answers: once a twin yields to
    // body.glass by itself, a leftover restore would drift with nothing to
    // check it against.
    for (const r of all) {
      for (const s of r.selectors) {
        if (/^body\.win\.glass(?![\w-])/.test(s) && !answered.has(s)) {
          problems.push(`${s}: restores a glass that no plain body.win twin takes away`)
        }
      }
    }
    expect(problems).toEqual([])
  })

  it('sets no blur inline, where no body.win rule could reach it', () => {
    const kitDist = dirname(createRequire(import.meta.url).resolve('@singz/ui/kit.css'))
    const sources = [...scripts(RENDERER, /\.tsx?$/), ...scripts(kitDist, /\.js$/)]
    expect(sources.length).toBeGreaterThan(20)
    expect(sources.filter((f) => /[bB]ackdropFilter/.test(readFileSync(f, 'utf8')))).toEqual([])
  })
})

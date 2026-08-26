import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '@babel/parser'

/**
 * Nothing scrollable may sit inside a touchable.
 *
 * Every bottom sheet used to be written the obvious way — a Pressable scrim
 * wrapped around a Pressable panel wrapped around the ScrollView — and on iOS
 * that silently stops the panel scrolling.
 * `RCTScrollViewComponentView._shouldDisableScrollInteraction` walks a scroll
 * view's native superviews and, on finding one that is the JS responder, makes
 * `touchesShouldCancelInContentView:` return NO, so the pan never begins.
 * Measured on a tap-opened Practice sheet: three swipes, three touches
 * delivered to the ScrollView, zero drags, and Trim unreachable on every song.
 * It read as intermittent — "the FIRST swipe is swallowed" — only because
 * `setIsJSResponder` lands on the main queue and can lose the race with the
 * first gesture after a fresh mount.
 *
 * No headless suite can swipe, so the rule is guarded at the source, and
 * across the whole tree rather than at the three sheets that had it: the next
 * scrollable written the old way is the same bug again, wherever it lands.
 * Native-stack form sheets satisfy it structurally: UIKit/Android own the
 * scrim and gesture outside React, while `Sheet` is a plain content View.
 *
 * This PARSES rather than pattern-matching, because the tags are not
 * separable from the rest of the language by eye: a hand-rolled scan read the
 * `>` of `onPress={() => close()}` as the end of an opening tag and every
 * `useState<TrackState>` as an element, which both failed correct code and
 * passed a genuinely nested one.
 */
type Node = { type?: string; [k: string]: unknown }

const nameOf = (n: Node): string =>
  n.type === 'JSXIdentifier'
    ? String(n.name)
    : n.type === 'JSXMemberExpression'
      ? `${nameOf(n.object as Node)}.${nameOf(n.property as Node)}`
      : ''

const TOUCHABLE = /^(Pressable|Touchable\w*)$/
const SCROLLABLE = /^(SheetScrollView|(Animated\.)?(ScrollView|FlatList|SectionList|VirtualizedList))$/

/**
 * Every scrollable ELEMENT in one file, with the elements open around it.
 *
 * An element passed as an attribute (`ListHeaderComponent={<Header />}`) is
 * walked as its own root: whoever receives the prop decides where it renders,
 * so the tag it was written inside is not its ancestor in any touch hierarchy.
 */
function scrollablesWithAncestors(src: string): { tag: string; ancestors: string[] }[] {
  const ast = parse(src, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
  const found: { tag: string; ancestors: string[] }[] = []
  const walk = (node: unknown, stack: string[]): void => {
    if (Array.isArray(node)) {
      for (const n of node) walk(n, stack)
      return
    }
    if (!node || typeof node !== 'object') return
    const n = node as Node
    if (n.type === 'JSXElement') {
      const tag = nameOf((n.openingElement as Node).name as Node)
      if (SCROLLABLE.test(tag)) found.push({ tag, ancestors: [...stack] })
      walk((n.openingElement as Node).attributes, [])
      walk(n.children, [...stack, tag])
      return
    }
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'leadingComments' || k === 'trailingComments') continue
      walk(n[k], stack)
    }
  }
  walk(ast.program.body, [])
  return found
}

/** Every .tsx the app renders from. */
const ROOT = join(__dirname, '..')
const tsxUnder = (dir: string): string[] =>
  readdirSync(dir).flatMap((e) => {
    const p = join(dir, e)
    return statSync(p).isDirectory() ? tsxUnder(p) : p.endsWith('.tsx') ? [p] : []
  })
const files = [join(ROOT, 'App.tsx'), ...tsxUnder(join(ROOT, 'src'))]

test('the scan reads nesting, arrows and generics the way a parser does', () => {
  // the helper is the whole test, so it is checked before it is trusted
  const nested = scrollablesWithAncestors('const A = () => (<Pressable onPress={() => x()}><View><ScrollView><Text/></ScrollView></View></Pressable>)')
  expect(nested).toEqual([{ tag: 'ScrollView', ancestors: ['Pressable', 'View'] }])

  // the shape Sheet recommends — a sibling scrim, written with an inline arrow
  const sibling = scrollablesWithAncestors("const B = () => (<View><Pressable onPress={() => close()} /><View><ScrollView/></View></View>)")
  expect(sibling).toEqual([{ tag: 'ScrollView', ancestors: ['View', 'View'] }])

  // a generic is not an element, and an element in an attribute is not an ancestor
  const noise = scrollablesWithAncestors('const r = useRef<ScrollView>(null)\nconst C = () => (<Pressable onPress={f} icon={<Icon />}><ScrollView/></Pressable>)')
  expect(noise).toEqual([{ tag: 'ScrollView', ancestors: ['Pressable'] }])
})

test('the scan finds the scrollables that are actually there', () => {
  // a scan that silently matched nothing would pass every file for the wrong reason
  const all = files.flatMap((f) => scrollablesWithAncestors(readFileSync(f, 'utf8')))
  expect(all.length).toBeGreaterThanOrEqual(8)
  // every one of these is an ELEMENT: a `useRef<ScrollView>` type parameter no
  // longer counts, which is what made the old count larger than the truth
  expect(all.some((s) => s.tag === 'Animated.ScrollView')).toBe(true)
})

test.each(files.map((f) => [f.slice(ROOT.length + 1), f]))('%s puts no scrollable inside a touchable', (_name, file) => {
  const offenders = scrollablesWithAncestors(readFileSync(file, 'utf8'))
    .map((s) => ({ ...s, blocking: s.ancestors.filter((a) => TOUCHABLE.test(a)) }))
    .filter((s) => s.blocking.length > 0)
    .map((s) => `${s.tag} inside ${s.blocking.join(' > ')}`)
  expect(offenders).toEqual([])
})

test('the player presents its Sheet content through native-stack form sheets', () => {
  const player = readFileSync(join(ROOT, 'src', 'ui', 'PlayerScreen.tsx'), 'utf8')
  expect(player).toMatch(/<Sheet\b/)
  expect(player).toMatch(/presentation: 'formSheet'/)
  expect(player).not.toMatch(/<Modal\b/)
})

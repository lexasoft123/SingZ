// Extractors that read the THREE native-playback bridges' own sources and
// return the surface each one actually publishes: method names with their JS
// arity, the key sets of every object crossing the boundary, and the enum
// string tables.
//
// The point is that no expectation is written twice. Every consumer — the two
// mobile packaging suites, the desktop addon suite, the arity gate — extracts
// from source with these functions and compares against ONE pinned file,
// tests/shared/native-playback-bridge-manifest.json. A key added to one
// bridge and forgotten on another fails the manifest, which is the drift the
// contract exists to stop; the alternative (a hand-kept list per suite) is
// how the Android list came to be missing three methods and thirteen JNI
// symbols while reading green.
//
// Deliberately textual. These run in jest and vitest with no compiler and no
// device, so they parse rather than execute — which is also why every
// extractor below is anchored on a named function and fails loudly when it
// cannot find it, instead of quietly returning an empty set that every
// `toContain` would pass.

/** Body of `name`, brace-balanced, starting after its opening `{`. */
export function functionBody(source: string, signature: string): string {
  const at = source.indexOf(signature)
  if (at < 0) throw new Error(`source does not contain ${signature}`)
  const open = source.indexOf('{', at + signature.length)
  if (open < 0) throw new Error(`${signature} has no body`)
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    const character = source[index]
    if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open + 1, index)
    }
  }
  throw new Error(`${signature} body is unbalanced`)
}

/**
 * Removes C, C++ and Objective-C comments while respecting string and
 * character literals. Every key extractor runs on the stripped text: a
 * comment sitting between two dictionary entries otherwise breaks the
 * key-position rule below, which is how `graphStatusCode` — a field iOS
 * plainly publishes, with a comment above it explaining why — first read as
 * an Android-only key.
 */
export function stripComments(source: string): string {
  let output = ''
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (character === '"' || character === "'") {
      const quote = character
      let end = index + 1
      while (end < source.length && source[end] !== quote) end += source[end] === '\\' ? 2 : 1
      output += source.slice(index, Math.min(end + 1, source.length))
      index = end
      continue
    }
    if (character === '/' && source[index + 1] === '/') {
      const end = source.indexOf('\n', index)
      index = end < 0 ? source.length : end - 1
      continue
    }
    if (character === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2)
      index = end < 0 ? source.length : end + 1
      continue
    }
    output += character
  }
  return output
}

export interface BridgeMethod {
  name: string
  /** Arguments JavaScript passes, promise pair excluded. */
  arity: number
  /**
   * Answers on the JS thread instead of resolving a promise —
   * `RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD` on iOS,
   * `@ReactMethod(isBlockingSynchronousMethod = true)` on Android. It changes
   * how arity is counted (there is no promise pair to exclude), so it is part
   * of the method's identity rather than a footnote.
   */
  synchronous: boolean
}

/**
 * RCT_EXPORT_METHOD / RCT_REMAP_METHOD, with arity counted from the SELECTOR
 * rather than from anything a human wrote down. A native method whose arity
 * disagrees with JS is never dispatched and never says so, so the count has
 * to come from the same place the bridge reads it.
 */
export function iosBridgeMethods(source: string): BridgeMethod[] {
  const methods: BridgeMethod[] = []
  const macro = /RCT_(EXPORT_BLOCKING_SYNCHRONOUS_METHOD|EXPORT_METHOD|REMAP_METHOD)\(/g
  let match = macro.exec(source)
  while (match !== null) {
    const open = match.index + match[0].length - 1
    let depth = 0
    let close = -1
    for (let index = open; index < source.length; index += 1) {
      if (source[index] === '(') depth += 1
      else if (source[index] === ')') {
        depth -= 1
        if (depth === 0) {
          close = index
          break
        }
      }
    }
    if (close < 0) throw new Error(`unbalanced ${match[0]} at ${match.index}`)
    const declaration = source.slice(open + 1, close)
    const remapped = match[1] === 'REMAP_METHOD'
    const synchronous = match[1] === 'EXPORT_BLOCKING_SYNCHRONOUS_METHOD'
    // REMAP names the JS method first, then repeats it as the first selector
    // segment; EXPORT has the selector alone; the synchronous macro takes a
    // bare name when the method has no arguments.
    const selector = remapped ? declaration.slice(declaration.indexOf(',') + 1) : declaration
    const name = remapped
      ? declaration.slice(0, declaration.indexOf(',')).trim()
      : (selector.match(/^\s*([A-Za-z0-9_]+)\s*[:)]?/)?.[1] ?? '')
    if (name === '') throw new Error(`could not name the method at ${match.index}`)
    // Segments are `label:` at paren depth 0 of the selector — the argument
    // types are parenthesized, so their own colons never count.
    let parenthesis = 0
    let segments = 0
    for (let index = 0; index < selector.length; index += 1) {
      const character = selector[index]
      if (character === '(') parenthesis += 1
      else if (character === ')') parenthesis -= 1
      else if (character === ':' && parenthesis === 0) segments += 1
    }
    // A synchronous method returns rather than resolving, so there is no
    // resolver/rejecter pair to discount.
    methods.push({ name, arity: synchronous ? segments : segments - 2, synchronous })
    match = macro.exec(source)
  }
  return methods.sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * Kotlin `@ReactMethod fun name(a: A, b: B, promise: Promise)`. The trailing
 * promise is the resolver/rejecter pair iOS spells as two selector segments,
 * so both sides report the same number: what JS passes.
 */
export function androidBridgeMethods(source: string): BridgeMethod[] {
  const methods: BridgeMethod[] = []
  const declaration = /@ReactMethod\s*(\([^)]*\)\s*)?fun\s+([A-Za-z0-9_]+)\s*\(/g
  let match = declaration.exec(source)
  while (match !== null) {
    const open = match.index + match[0].length - 1
    let depth = 0
    let close = -1
    for (let index = open; index < source.length; index += 1) {
      if (source[index] === '(') depth += 1
      else if (source[index] === ')') {
        depth -= 1
        if (depth === 0) {
          close = index
          break
        }
      }
    }
    if (close < 0) throw new Error(`unbalanced parameter list for ${match[2]}`)
    const parameters = source.slice(open + 1, close).trim()
    let count = 0
    if (parameters !== '') {
      let depths = 0
      count = 1
      for (let index = 0; index < parameters.length; index += 1) {
        const character = parameters[index]
        if (character === '(' || character === '<') depths += 1
        else if (character === ')' || character === '>') depths -= 1
        else if (character === ',' && depths === 0) count += 1
      }
    }
    const synchronous = /isBlockingSynchronousMethod\s*=\s*true/.test(match[1] ?? '')
    // Everything else must take the promise this counts out; a synchronous
    // method must not, and a method that lost its Promise by accident would
    // otherwise read as one.
    if (!synchronous && !/\bpromise\s*:\s*Promise\b/.test(parameters))
      throw new Error(`${match[2]} does not take a Promise`)
    if (synchronous && /\bPromise\b/.test(parameters))
      throw new Error(`${match[2]} is synchronous but takes a Promise`)
    methods.push({
      name: match[2],
      arity: synchronous ? count : count - 1,
      synchronous
    })
    match = declaration.exec(source)
  }
  return methods.sort((left, right) => left.name.localeCompare(right.name))
}

/** `external fun name(` in SingzCore.kt, in source order. */
export function kotlinExternalFunctions(source: string): string[] {
  return [...source.matchAll(/external\s+fun\s+([A-Za-z0-9_]+)\s*\(/g)].map(match => match[1])
}

/**
 * The names in the `JNINativeMethod` table — the strings `RegisterNatives`
 * resolves against, which is a DIFFERENT list from the C functions below.
 * Change the table string alone and the C symbol pin still passes while
 * JNI_OnLoad returns JNI_ERR at app start, so the table is what has to be
 * compared against Kotlin's externals.
 */
export function jniRegisteredNames(source: string): string[] {
  const table = stripComments(source)
  const start = table.indexOf('kNativePlaybackMethods[] = {')
  if (start < 0) throw new Error('no kNativePlaybackMethods table')
  const end = table.indexOf('\n};', start)
  if (end < 0) throw new Error('kNativePlaybackMethods table is unterminated')
  // Name AND implementation. A table entry naming one method while pointing at
  // another's function registers cleanly and then runs the wrong code — the one
  // form of this mistake that is silent instead of a JNI_ERR at app start.
  const entries = [
    ...table
      .slice(start, end)
      .matchAll(
        /\{\s*const_cast<char \*>\("([A-Za-z0-9_]+)"\)[\s\S]*?reinterpret_cast<void \*>\(\s*([A-Za-z0-9_]+)\s*\)/g
      )
  ]
  for (const entry of entries)
    if (entry[1] !== entry[2])
      throw new Error(`JNI table registers ${entry[1]} against ${entry[2]}`)
  return entries.map(entry => entry[1])
}

/** `static jstring nativePlaybackX(` plus the macro-generated JNI entry points. */
export function jniPlaybackSymbols(source: string): string[] {
  const declared = [...source.matchAll(/\bstatic\s+j\w+\s+(nativePlayback[A-Za-z0-9_]*)\s*\(/g)].map(
    match => match[1]
  )
  const generated = [...source.matchAll(/SINGZ_PLAYBACK_\w*JNI\(\s*(nativePlayback[A-Za-z0-9_]*)/g)].map(
    match => match[1]
  )
  return [...new Set([...declared, ...generated])].sort()
}

/** The names registered on the desktop addon's exports object, in order. */
export function addonExportNames(source: string): string[] {
  const body = stripComments(functionBody(source, 'void definePlaybackExports('))
  const at = body.indexOf('properties[] = {')
  if (at < 0) throw new Error('definePlaybackExports declares no properties table')
  const block = body.slice(at)
  return [...block.matchAll(/\{\s*"([A-Za-z0-9_]+)"\s*,/g)].map(match => match[1])
}

export interface ObjectKeys {
  /** Keys of the object itself. */
  keys: string[]
  /** Keys of an object nested directly under one of them, arrays seen through. */
  nested: Record<string, string[]>
}

/**
 * Walks a key/container stream and separates a document's own keys from those
 * of anything nested under them. Arrays are transparent: `lanes: [{ id … }]`
 * reports `id` under `lanes`, which is what the parser on the other side
 * actually sees.
 */
class ShapeWalker {
  private readonly stack: { label: string | null; bracket: string }[] = []
  private pending: string | null = null
  readonly keys: string[] = []
  readonly nested: Record<string, string[]> = {}

  open(bracket: string): void {
    this.stack.push({ label: this.stack.length === 0 ? null : this.pending, bracket })
    this.pending = null
  }

  /** True once the document closes. A bracket that did not open a container
   * here — a message send, a subscript — must not close one, or the walk ends
   * inside the very object it is reading. */
  opened(bracket: string): boolean {
    return this.stack.length > 0 && this.stack[this.stack.length - 1].bracket === bracket
  }

  close(): boolean {
    this.stack.pop()
    return this.stack.length === 0
  }

  key(name: string): void {
    this.pending = name
    if (this.stack.length === 1) {
      this.keys.push(name)
      return
    }
    const container = [...this.stack].reverse().find(entry => entry.label !== null)
    const label = container?.label
    if (label === undefined || label === null) return
    this.nested[label] = this.nested[label] ?? []
    this.nested[label].push(name)
  }

  get depth(): number {
    return this.stack.length
  }

  shape(): ObjectKeys {
    return { keys: this.keys, nested: this.nested }
  }
}

/**
 * Keys of the Objective-C dictionary literal that `anchor` introduces inside
 * `signature`. The anchor matters: `statusDictionary` builds its lane
 * dictionaries before the one it returns, so "the first literal in the
 * function" would report a lane's six keys as the whole session block — which
 * is exactly the kind of silently-empty pin this file exists to avoid.
 */
export function objectiveCDictionaryKeys(
  source: string,
  signature: string,
  anchor = 'return @{'
): ObjectKeys {
  const body = stripComments(functionBody(source, signature))
  const start = body.indexOf(anchor)
  if (start < 0) throw new Error(`${signature} contains no ${anchor}`)
  const walker = new ShapeWalker()
  // A key is a string literal in KEY POSITION — right after the brace that
  // opened the dictionary or after a comma. Matching `@"…" :` alone reads the
  // colon of a ternary (`runtimeVersion == nullptr ? @"" : …`) as an empty
  // key, which is how this extractor first reported a sixth mediaCodec field
  // that does not exist.
  let previous = ''
  for (let index = start + anchor.length - 2; index < body.length; index += 1) {
    const character = body[index]
    if (character === '@' && body[index + 1] === '{') {
      walker.open('{')
      previous = '{'
      index += 1
      continue
    }
    if (character === '[' && walker.depth > 0 && /^\[\s*@\{/.test(body.slice(index))) {
      walker.open('[')
      previous = '{'
      continue
    }
    if (character === '}' && walker.opened('{')) {
      if (walker.close()) break
      previous = character
      continue
    }
    if (character === ']' && walker.opened('[')) {
      if (walker.close()) break
      previous = character
      continue
    }
    const literal = /^@"([^"]*)"\s*:/.exec(body.slice(index))
    if (literal !== null && walker.depth > 0 && (previous === '{' || previous === ',')) {
      walker.key(literal[1])
      index += literal[0].length - 1
      previous = ':'
      continue
    }
    if (!/\s/.test(character)) previous = character
  }
  return walker.shape()
}

/**
 * Keys of the JSON the Android JNI builds by string concatenation. Every
 * string literal and single-character `push_back` in the function is
 * concatenated into the document's skeleton, which is then walked with real
 * brace depth — so `latency` and `lanes` report as nested rather than as more
 * top-level keys, exactly as the parser on the other side sees them.
 */
export function jniJsonKeys(source: string, signature: string): ObjectKeys {
  const body = stripComments(functionBody(source, signature))
  let skeleton = ''
  const token = /"((?:[^"\\]|\\.)*)"|push_back\('(.)'\)/g
  let match = token.exec(body)
  while (match !== null) {
    skeleton += match[1] !== undefined ? match[1].replace(/\\"/g, '"') : match[2]
    match = token.exec(body)
  }
  const walker = new ShapeWalker()
  let previous = ''
  for (let index = 0; index < skeleton.length; index += 1) {
    const character = skeleton[index]
    if (character === '{' || character === '[') {
      walker.open(character)
      previous = '{'
      continue
    }
    if ((character === '}' && walker.opened('{')) || (character === ']' && walker.opened('['))) {
      walker.close()
      previous = character
      continue
    }
    const literal = /^"([^"]*)"\s*:/.exec(skeleton.slice(index))
    if (literal !== null && walker.depth > 0 && (previous === '{' || previous === ',')) {
      walker.key(literal[1])
      index += literal[0].length - 1
      previous = ':'
      continue
    }
    previous = character
  }
  return walker.shape()
}

/**
 * Keys the desktop addon sets on one N-API object. `target` names the C++
 * variable, so a nested object built into its own variable is asked for by
 * name instead of contaminating the parent.
 */
export function addonObjectKeys(source: string, signature: string, target: string): string[] {
  const body = stripComments(functionBody(source, signature))
  const scalar = new RegExp(
    `set(?:Value|Counter|SignedCounter)\\(\\s*env\\s*,\\s*${target}\\s*,\\s*"([^"]+)"`,
    'g'
  )
  // `format` and `latency` are attached by their own helpers rather than by a
  // named setter, so a scalar-only sweep reports them as declared-but-never-
  // emitted — the opposite of the truth, and the wrong half of the desktop
  // status to go looking at.
  const helper = new RegExp(`set([A-Z][A-Za-z]*)\\(\\s*env\\s*,\\s*${target}\\s*,`, 'g')
  const keys: { key: string; at: number }[] = []
  for (const match of body.matchAll(scalar)) keys.push({ key: match[1], at: match.index ?? 0 })
  for (const match of body.matchAll(helper)) {
    if (['Value', 'Counter', 'SignedCounter'].includes(match[1])) continue
    keys.push({
      key: match[1][0].toLowerCase() + match[1].slice(1),
      at: match.index ?? 0
    })
  }
  // A function with two return paths sets the same key twice (lanePeaks has
  // an invalid-generation path and a real one); the set it emits is one copy.
  return [...new Set(keys.sort((left, right) => left.at - right.at).map(entry => entry.key))]
}

export interface StringTable {
  /** `case X: return "y"`, in enumerator order. */
  cases: string[]
  /** The value returned when the switch falls through, or null when it cannot. */
  fallback: string | null
}

/** Every string literal in a function body, in order. */
export function stringLiterals(source: string, signature: string): string[] {
  const body = stripComments(functionBody(source, signature))
  return [...body.matchAll(/@?"((?:[^"\\]|\\.)*)"/g)].map(match => match[1])
}

/**
 * The `case X: return "y";` table of a C or Objective-C switch, in order,
 * with the fallthrough return reported separately. The fallthrough is part of
 * the contract and not a formality: the core falls back to `host-failure`
 * where the TypeScript parser falls back to `provider-failure`, and a table
 * pin that dropped the last line would call those two identical.
 */
export function switchStringTable(source: string, signature: string): StringTable {
  const body = stripComments(functionBody(source, signature))
  // Case labels are qualified (`singz::NativePlaybackError::None`), so the
  // label pattern has to admit colons and lean on the `: return "…"` anchor.
  const cases = [...body.matchAll(/case\s+[^;{}]*?:\s*return\s+@?"([^"]*)"/g)].map(
    match => match[1]
  )
  // The fallthrough is whatever the function returns after the switch. It is
  // often ALSO one of the cases (both phones fall through to "terminal", which
  // is a state in its own right), so this must not be filtered against them.
  const trailing = /return\s+@?"([^"]*)"\s*;\s*$/.exec(body.trimEnd())
  return { cases, fallback: trailing !== null ? trailing[1] : null }
}

/**
 * Keys a Kotlin function puts on a `WritableMap`, in order. React Native's
 * map builder is the Android counterpart of an Objective-C dictionary
 * literal, and `positionNow` is built this way on one platform and as a
 * literal on the other — so both need reading to compare them.
 */
export function writableMapKeys(source: string, signature: string): string[] {
  const body = stripComments(functionBody(source, signature))
  // One ordered pass, deduplicated: a key can be put more than once (an early
  // return sets `available` on its own before the real payload is built), and
  // what the other side sees is one copy of each in first-appearance order.
  return [
    ...new Set(
      [...body.matchAll(/\.put[A-Za-z]*\(\s*"([A-Za-z0-9_]+)"/g)].map(match => match[1])
    )
  ]
}

/** The `X -> "y"` table of a Kotlin `when`, in order. */
export function kotlinWhenTable(source: string, signature: string): string[] {
  const body = stripComments(functionBody(source, signature))
  return [...body.matchAll(/->\s*"([^"]*)"/g)].map(match => match[1])
}

/** Names of a C++ enum class's enumerators, in declaration order. */
export function enumerators(source: string, name: string): string[] {
  const declaration = new RegExp(`enum\\s+class\\s+${name}\\b[^{]*\\{`)
  const match = declaration.exec(source)
  if (match === null) throw new Error(`no enum class ${name}`)
  const open = match.index + match[0].length - 1
  const body = stripComments(source.slice(open + 1, source.indexOf('}', open)))
  return body
    .split(',')
    .map(entry => entry.trim().split(/\s*=\s*/)[0].trim())
    .filter(entry => /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry))
}

/** Keys of a TypeScript `interface Name { … }`, ignoring nested literals. */
export function interfaceKeys(source: string, name: string): string[] {
  const body = stripComments(functionBody(source, `interface ${name}`))
  const keys: string[] = []
  let depth = 0
  const lines = body.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (depth === 0) {
      const key = /^([A-Za-z_][A-Za-z0-9_]*)\??\s*:/.exec(trimmed)
      if (key !== null) keys.push(key[1])
    }
    for (const character of trimmed) {
      if (character === '{') depth += 1
      else if (character === '}') depth -= 1
    }
  }
  return keys
}

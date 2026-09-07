/** Local JavaScript edges emitted by Rollup. Both static and dynamic imports
 * matter: a poisoned shared child URL defeats recovery regardless of which
 * syntax caused Chromium to fetch it. */
export function localJsDependencies(source) {
  const dependencies = new Set()
  const patterns = [
    /\bfrom\s*["']\.\/([^"']+\.js)["']/g,
    /\bimport\s*["']\.\/([^"']+\.js)["']/g
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) dependencies.add(match[1])
  }
  for (const match of source.matchAll(/\bimport\s*\(\s*([^)]*?)\s*\)/g)) {
    const expression = match[1].trim()
    const literal = expression.match(/^(["'])([^"']+)\1$/)
    if (!literal) {
      throw new Error(
        'Renderer split check: recovery closure contains a non-literal dynamic import that cannot be proven disjoint.'
      )
    }
    const specifier = literal[2]
    const local = specifier.match(/^\.\/([^"']+\.js)$/)
    if (local) dependencies.add(local[1])
  }
  return [...dependencies]
}

export async function localDependencyClosure({
  root,
  entryFile,
  files,
  readSource
}) {
  const available = files instanceof Set ? files : new Set(files)
  const closure = new Set([root])
  const pending = [root]
  while (pending.length > 0) {
    const current = pending.pop()
    const source = await readSource(current)
    for (const dependency of localJsDependencies(source)) {
      // Shared React/app-shell exports legitimately point back to the entry.
      // Do not traverse it: its dynamic imports are other independent routes.
      if (dependency === entryFile || closure.has(dependency)) continue
      if (!available.has(dependency)) {
        throw new Error(`Renderer split check: ${current} imports missing chunk ${dependency}.`)
      }
      closure.add(dependency)
      pending.push(dependency)
    }
  }
  return closure
}

export async function assertDisjointLocalClosures({
  name,
  roots,
  entryFile,
  files,
  readSource
}) {
  const primary = await localDependencyClosure({
    root: roots[0], entryFile, files, readSource
  })
  const recovery = await localDependencyClosure({
    root: roots[1], entryFile, files, readSource
  })
  const shared = [...primary].filter((file) => recovery.has(file))
  if (shared.length > 0) {
    throw new Error(
      `Renderer split check: ${name} primary/recovery local import closures intersect at ${shared.join(', ')}.`
    )
  }
}

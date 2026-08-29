/**
 * Resolve @singz/ui, which jest otherwise cannot find.
 *
 * Every entry in that package's `exports` map offers `types` and `import` and
 * nothing else, and the package is `"type": "module"`. Jest resolves under
 * CommonJS conditions, matches neither, and reports
 * `Cannot find module '@singz/ui/stems'` — a resolution failure wearing the
 * face of a missing file, since the file is sitting right there on disk. Nine
 * suites stopped running the day the phone stopped carrying its own copy of
 * the kit, among them every assertion about what the training screen says
 * when the microphone goes quiet.
 *
 * The obvious one-line fix — `customExportConditions: ['import']` — is a trap:
 * conditions are global, so adding `import` for this package also switches
 * React Native and half of node_modules onto their ESM builds, none of which
 * `transformIgnorePatterns` exempts. Measured: 33 of 33 suites then fail on
 * `Unexpected token 'export'`. So this is scoped to the one package that needs
 * it and defers to jest for literally everything else.
 *
 * It reads the package's own map rather than pointing at dist/ paths, because
 * the three subpaths the phone imports do not share a shape (`./stems` is
 * dist/tokens/stems.js, `./native` is dist/native/index.js) — a regex mapper
 * would have to hardcode the kit's internal layout and would rot silently the
 * first time the kit moved a file. A subpath the map does not name falls
 * through to the default resolver, so it still fails loudly.
 */
const fs = require('fs')
const path = require('path')

const PKG = '@singz/ui'

// Node's own lookup: walk up from the importing file, checking node_modules at
// each level. Nothing here assumes the package sits in mobile/node_modules —
// npm is free to hoist it anywhere above.
const packageRoot = (from) => {
  let dir = from
  for (;;) {
    const candidate = path.join(dir, 'node_modules', PKG)
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

module.exports = (request, options) => {
  if (request === PKG || request.startsWith(`${PKG}/`)) {
    const root = packageRoot(options.basedir || options.rootDir)
    if (root) {
      const { exports: map } = JSON.parse(
        fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
      )
      const key = request === PKG ? '.' : `.${request.slice(PKG.length)}`
      const entry = map && map[key]
      const target = typeof entry === 'string' ? entry : entry && entry.import
      // Only a string is a path. A nested condition object
      // (`"import": { "default": "./x.js" }`) is a shape this does not read,
      // and falling through to jest is right — path.resolve would throw
      // ERR_INVALID_ARG_TYPE and blame the wrong thing entirely.
      if (typeof target === 'string') return path.resolve(root, target)
    }
  }
  return options.defaultResolver(request, options)
}

/*
 * Keep React Native's Xcode ccache configuration portable across worktrees.
 * RN uses CCACHE_CONFIGPATH, so machine-only ccache settings do not reach these
 * builds. Preserve RN's module/PCH settings and generate checkout-local path
 * normalization. Explicit CCACHE_DIR/MAXSIZE overrides are baked for GUI builds
 * too; without overrides ccache retains its normal per-user directory and cap.
 */
const fs = require('node:fs')
const path = require('node:path')

const BEGIN = '# >>> SingZ (scripts/ccache-xcode-conf.js) — cross-worktree hits'
const END = '# <<< SingZ'
const WRAPPER_BEGIN = '# >>> SingZ compiler wrapper'
const WRAPPER_END = '# <<< SingZ compiler wrapper'
const UPSTREAM_CONFIG_EXPORT = 'export CCACHE_CONFIGPATH="${CCACHE_CONFIGPATH:-$REACT_NATIVE_CCACHE_CONFIGPATH}"'

function executable(file) {
  try {
    if (!fs.statSync(file).isFile()) return false
    fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch { return false }
}

function findCcache(env) {
  const requested = env.CCACHE_BINARY
  if (requested && /[\r\n]/.test(requested)) throw new Error('CCACHE_BINARY cannot contain a newline')
  const names = requested ? [requested] : (process.platform === 'win32' ? ['ccache.exe', 'ccache'] : ['ccache'])
  for (const name of names) {
    const candidates = path.isAbsolute(name) || name.includes('/') || name.includes('\\')
      ? [path.resolve(name)]
      : (env.PATH ?? process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(directory => path.resolve(directory, name))
    const found = candidates.find(executable)
    if (found) return found
  }
  if (requested) throw new Error('CCACHE_BINARY must name an executable compiler cache')
  return ''
}

const shellQuote = value => "'" + value.replace(/'/g, "'\\''") + "'"

function compilerBlock(binary, compiler, preserveModulePaths = true) {
  const lines = [WRAPPER_BEGIN, '# configured ccache: ' + JSON.stringify(binary),
    'singz_ccache_binary=' + shellQuote(binary),
    'if [ -n "${CCACHE_BINARY:-}" ]; then singz_ccache_binary=$CCACHE_BINARY; fi',
    'if [ -n "$singz_ccache_binary" ]; then',
    '  if [ ! -x "$singz_ccache_binary" ]; then',
    '    echo "SingZ: configured ccache executable is unavailable; rerun mobile postinstall" >&2',
    '    exit 127',
    '  fi']
  if (preserveModulePaths) lines.push(
    // A PCH records the exact PCM path spelling. Keep module/PCH cache
    // paths absolute and hashed, including when an old uncached PCH is reused.
    // Ordinary C++ keeps base_dir rewriting and portable cross-worktree hits.
    '  singz_objc=false',
    '  singz_previous=',
    '  for singz_argument in "$@"; do',
    '    case "$singz_previous:$singz_argument" in',
    '      -x:objective-c*|*:-xobjective-c*|-x:c-header|-x:c++-header|*:-xc-header|*:-xc++-header) singz_objc=true ;;',
    '      *:-include|*:-include-pch|*:*.pch|*:*.gch) singz_objc=true ;;',
    '    esac',
    '    singz_previous=$singz_argument',
    '  done',
    '  if [ "$singz_objc" = true ]; then',
    '    singz_remaining=$#',
    '    while [ "$singz_remaining" -gt 0 ]; do',
    '      singz_argument=$1; shift',
    '      case "$singz_argument" in',
    '        -Xclang)',
    '          if [ "$singz_remaining" -gt 1 ] && [ "${1#-fmodules-cache-path=}" != "$1" ]; then',
    '            set -- "$@" --ccache-skip "$singz_argument" --ccache-skip "$1"',
    '            shift; singz_remaining=$((singz_remaining - 1))',
    '          else set -- "$@" "$singz_argument"; fi ;;',
    '        -fmodules-cache-path=*) set -- "$@" --ccache-skip "$singz_argument" ;;',
    '        *) set -- "$@" "$singz_argument" ;;',
    '      esac',
    '      singz_remaining=$((singz_remaining - 1))',
    '    done',
    '  fi')
  lines.push('  exec "$singz_ccache_binary" ' + compiler + ' "$@"',
    'fi',
    // Ccache is optional when it was absent during provisioning. A configured
    // executable that later disappears must never silently fall through.
    'exec ' + compiler + ' "$@"', WRAPPER_END)
  return lines.join('\n')
}

function patchCompilerWrapper(source, binary, compiler, filename) {
  const fail = () => { throw new Error('React Native compiler wrapper changed upstream: ' + filename) }
  if (source.split(UPSTREAM_CONFIG_EXPORT).length !== 2) fail()
  const begin = source.indexOf(WRAPPER_BEGIN), end = source.indexOf(WRAPPER_END)
  const block = compilerBlock(binary, compiler)
  if (begin !== -1 || end !== -1) {
    if (begin === -1 || end < begin || source.split(WRAPPER_BEGIN).length !== 2 || source.split(WRAPPER_END).length !== 2) fail()
    const existing = source.slice(begin, end + WRAPPER_END.length)
    let prior
    try { prior = JSON.parse(existing.split('\n')[1].replace(/^# configured ccache: /, '')) } catch { fail() }
    if (typeof prior !== 'string' || /[\r\n]/.test(prior) ||
        (existing !== compilerBlock(prior, compiler) && existing !== compilerBlock(prior, compiler, false))) fail()
    return source.slice(0, begin) + block + source.slice(end + WRAPPER_END.length)
  }
  const original = 'exec $CCACHE_BINARY ' + compiler + ' "$@"'
  if (source.split(original).length !== 2) fail()
  return source.replace(original, block)
}

function stripGeneratedBlocks(text) {
  let output = text
  for (;;) {
    const from = output.indexOf(BEGIN)
    if (from === -1) return output
    const to = output.indexOf(END, from)
    if (to === -1) return output.slice(0, from)
    output = output.slice(0, from) + output.slice(to + END.length)
  }
}

function configureXcodeCache(root, env = process.env) {
  root = path.resolve(root)
  const reactNative = path.join(root, 'mobile/node_modules/react-native')
  const conf = path.join(reactNative, 'scripts/xcode/ccache.conf')
  if (!fs.existsSync(conf)) {
    if (fs.existsSync(reactNative))
      throw new Error('React Native ccache.conf is missing; update the Xcode cache integration for this React Native version')
    return { changed: false, skipped: true }
  }
  if (/[\r\n]/.test(root)) throw new Error('Checkout root cannot contain a newline')
  const block = [BEGIN, `base_dir = ${root}`, 'hash_dir = false', 'compiler_check = content']
  if (env.CCACHE_DIR) {
    if (/[\r\n]/.test(env.CCACHE_DIR)) throw new Error('CCACHE_DIR cannot contain a newline')
    block.push(`cache_dir = ${path.resolve(env.CCACHE_DIR)}`)
  }
  if (env.CCACHE_MAXSIZE) {
    const size = env.CCACHE_MAXSIZE.trim()
    if (!/^\d+(?:\.\d+)?(?:\s*[kKmMgGtT](?:i?[bB])?)?$/.test(size))
      throw new Error('CCACHE_MAXSIZE must be a ccache size such as 750M or 5GiB')
    block.push(`max_size = ${size}`)
  }
  block.push(END)
  const binary = findCcache(env)
  const source = fs.readFileSync(conf, 'utf8')
  const next = `${stripGeneratedBlocks(source).replace(/\n+$/, '')}\n\n${block.join('\n')}\n`
  const plans = [{ filename: conf, source, next }]
  for (const compiler of ['clang', 'clang++']) {
    const filename = path.join(path.dirname(conf), `ccache-${compiler}.sh`)
    if (!fs.existsSync(filename)) throw new Error('React Native compiler wrapper is missing: ' + filename)
    const original = fs.readFileSync(filename, 'utf8')
    plans.push({ filename, source: original, next: patchCompilerWrapper(original.replace(/\r\n/g, '\n'), binary, compiler, filename) })
  }
  // Validate both pinned upstream wrapper shapes before modifying any file.
  let changed = false
  for (const plan of plans) if (plan.next !== plan.source) {
    fs.writeFileSync(plan.filename, plan.next)
    changed = true
  }
  return { changed, skipped: false, conf, ccache: binary || null }
}

module.exports = { configureXcodeCache }
if (require.main === module) {
  try {
    const result = configureXcodeCache(path.resolve(__dirname, '../..'))
    console.log(result.skipped ? 'ccache xcode conf: React Native is not installed — skipped'
      : result.changed ? 'ccache xcode conf: checkout settings updated' : 'ccache xcode conf: already current')
  } catch (error) {
    console.error(`ccache xcode conf: ${error.message}`)
    process.exitCode = 1
  }
}

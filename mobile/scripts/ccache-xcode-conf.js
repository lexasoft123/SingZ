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
  const source = fs.readFileSync(conf, 'utf8')
  const next = `${stripGeneratedBlocks(source).replace(/\n+$/, '')}\n\n${block.join('\n')}\n`
  if (next !== source) fs.writeFileSync(conf, next)
  return { changed: next !== source, skipped: false, conf }
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

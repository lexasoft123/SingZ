const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync, spawnSync } = require('node:child_process')
const source = path.resolve(__dirname, '../..')
const setupSource = process.env.SINGZ_TEST_SETUP_SCRIPT || path.join(source, 'scripts/worktree-setup.sh')
const shellTests = process.platform === 'win32' ? { skip: 'POSIX bootstrap requires bash and POSIX provisioning links' } : {}
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'singz setup '))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const main = path.join(dir, 'main'), root = path.join(dir, 'feature'), bin = path.join(dir, 'bin')
  fs.mkdirSync(main); fs.mkdirSync(bin)
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git(main, 'init', '-q'); git(main, 'config', 'user.name', 'Fixture'); git(main, 'config', 'user.email', 'fixture@example.invalid')
  fs.writeFileSync(path.join(main, '.gitignore'), 'vendor\nnode_modules\n')
  git(main, 'add', '.gitignore'); git(main, '-c', 'core.hooksPath=', 'commit', '-qm', 'fixture')
  git(main, 'worktree', 'add', '--detach', root)
  fs.mkdirSync(path.join(root, 'scripts')); fs.mkdirSync(path.join(root, '.githooks')); fs.mkdirSync(path.join(root, 'mobile/android'), { recursive: true })
  for (const name of ['native-build-lock.cjs', 'with-native-build-lock.mjs', 'assert-native-build-lock.cjs', 'install-git-hooks.cjs', 'check-staged-review.cjs'])
    fs.copyFileSync(path.join(source, 'scripts', name), path.join(root, 'scripts', name))
  for (const name of fs.readdirSync(path.join(source, '.githooks')))
    fs.copyFileSync(path.join(source, '.githooks', name), path.join(root, '.githooks', name))
  fs.copyFileSync(setupSource, path.join(root, 'scripts/worktree-setup.sh'))
  const writeScript = (file, text) => fs.writeFileSync(file, text, { mode: 0o755 })
  writeScript(path.join(root, 'scripts/analyze-source-hash.sh'), '#!/bin/sh\necho fixture-current-hash\n')
  writeScript(path.join(root, 'scripts/vendor-analyze.sh'), `#!/bin/sh
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
node "$root/scripts/assert-native-build-lock.cjs"
mkdir -p "$root/vendor/$1"
cat > "$root/vendor/$1/singz-analyze" <<'ANALYZER'
#!/bin/sh
printf '%s\\n' '{"sourceHash":"fixture-current-hash"}'
ANALYZER
chmod +x "$root/vendor/$1/singz-analyze"
printf '%s\\n' fixture-current-hash > "$root/vendor/$1/singz-analyze.source-hash"
`)
  // Cache identity itself is covered by engine-artifact.test.cjs. This stub
  // isolates bootstrap's decision to share or discard a producer's verdict.
  for (const [engine, binary] of [['llama', 'llama-server'], ['crispasr', 'crispasr']])
    writeScript(path.join(root, `scripts/vendor-${engine}.sh`), `#!/bin/sh\n[ "$1" = --check-cache ] || exit 1\n[ -f "$3/vendor/$2/${binary}" ] && [ "$(cat "$3/vendor/$2/${binary}.receipt.json" 2>/dev/null)" = valid ]\n`)
  writeScript(path.join(bin, 'npm'), `#!/bin/sh
set -eu
node "$PWD/scripts/assert-native-build-lock.cjs"
mkdir -p node_modules/electron
printf '%s\\n' electron > node_modules/electron/path.txt
`)
  writeScript(path.join(bin, 'cmake'), '#!/bin/sh\nexit 0\n')
  writeScript(path.join(bin, 'uname'), '#!/bin/sh\necho Darwin\n')
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }
  delete env.SINGZ_NATIVE_BUILD_LOCK_HELD
  const run = (args, extra = {}) => spawnSync('/bin/bash', [path.join(root, 'scripts/worktree-setup.sh'), ...args], { cwd: root, env: { ...env, ...extra }, encoding: 'utf8' })
  return { main, root, bin, dir, git, env, run }
}
test('bootstrap rejects unsupported modes before modifying dependencies or Git config', shellTests, t => {
  const f = fixture(t), result = f.run(['--typo'])
  assert.equal(result.status, 2, result.stderr)
  assert.match(result.stderr, /Usage:/)
  assert.equal(fs.existsSync(path.join(f.root, 'node_modules')), false)
  assert.equal(spawnSync('git', ['-C', f.root, 'config', '--get', 'core.hooksPath']).status, 1)
})
test('macOS mobile setup refuses missing CocoaPods before npm ci', shellTests, t => {
  const f = fixture(t), isolated = path.join(f.dir, 'no-pod-bin')
  fs.mkdirSync(isolated)
  for (const name of ['bash', 'dirname', 'git', 'node', 'head', 'sed']) {
    const executable = execFileSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim()
    fs.symlinkSync(executable, path.join(isolated, name))
  }
  for (const name of ['npm', 'cmake', 'uname']) fs.copyFileSync(path.join(f.bin, name), path.join(isolated, name))
  const result = f.run([], { PATH: isolated })
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /CocoaPods is required/)
  assert.equal(fs.existsSync(path.join(f.root, 'node_modules')), false)
})
test('desktop setup locks npm, installs hooks, verifies local analyzer, and snapshots only valid engines', shellTests, t => {
  const f = fixture(t), target = `${process.platform}-${process.arch}`
  const mainVendor = path.join(f.main, 'vendor', target), localVendor = path.join(f.root, 'vendor', target)
  fs.mkdirSync(mainVendor, { recursive: true })
  fs.writeFileSync(path.join(mainVendor, 'llama-server'), 'main engine')
  fs.writeFileSync(path.join(mainVendor, 'llama-server.receipt.json'), 'valid')
  fs.writeFileSync(path.join(mainVendor, 'singz-analyze'), 'main analyzer must never run')
  fs.writeFileSync(path.join(mainVendor, 'unknown-engine'), 'unvalidated')
  fs.mkdirSync(path.join(f.main, 'vendor/packs'), { recursive: true })
  let result = f.run(['--desktop-only'])
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.match(result.stdout, /Mobile was not provisioned/)
  assert.equal(f.git(f.root, 'config', '--get', 'core.hooksPath'), '.githooks')
  assert.equal(fs.lstatSync(path.join(localVendor, 'llama-server')).isSymbolicLink(), false)
  assert.equal(fs.lstatSync(path.join(localVendor, 'singz-analyze')).isSymbolicLink(), false)
  assert.equal(fs.existsSync(path.join(localVendor, 'unknown-engine')), false)
  assert.equal(fs.existsSync(path.join(f.root, 'vendor/packs')), false)
  assert.equal(fs.readFileSync(path.join(mainVendor, 'singz-analyze'), 'utf8'), 'main analyzer must never run')
  fs.writeFileSync(path.join(mainVendor, 'llama-server'), 'different main revision')
  assert.equal(fs.readFileSync(path.join(localVendor, 'llama-server'), 'utf8'), 'main engine')
  result = f.run(['--desktop-only'])
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.equal(fs.readFileSync(path.join(localVendor, 'llama-server'), 'utf8'), 'main engine')
  fs.unlinkSync(path.join(localVendor, 'llama-server'))
  fs.symlinkSync(path.join(mainVendor, 'llama-server'), path.join(localVendor, 'llama-server'))
  fs.writeFileSync(path.join(mainVendor, 'llama-server.receipt.json'), 'invalid')
  result = f.run(['--desktop-only'])
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.equal(fs.existsSync(path.join(localVendor, 'llama-server')), false)
  fs.symlinkSync(mainVendor, path.join(f.root, 'vendor/obsolete-target'))
  fs.rmSync(path.join(f.main, 'vendor'), { recursive: true })
  result = f.run(['--desktop-only'])
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.equal(fs.existsSync(path.join(f.root, 'vendor/obsolete-target')), false)
})

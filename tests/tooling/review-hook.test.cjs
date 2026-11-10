const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { test } = require('node:test')

const sourceRoot = resolve(__dirname, '../..')
const { installGitHooks } = require(join(sourceRoot, 'scripts/install-git-hooks.cjs'))

function fixture(t) {
  const parent = mkdtempSync(join(tmpdir(), 'singz hook test '))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const root = join(parent, 'main checkout')
  mkdirSync(root)
  // Git for Windows does not accept Node's \\.\nul device spelling as a
  // config file. Ordinary fixture-owned paths isolate configuration and
  // bootstrap hooks on every platform without special-device semantics.
  const globalConfig = join(parent, 'empty global config')
  const disabledHooks = join(parent, 'empty hooks')
  writeFileSync(globalConfig, '')
  mkdirSync(disabledHooks)
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: globalConfig }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'SINGZ_SKIP_REVIEW']) delete env[key]
  env.GIT_EDITOR = 'true'
  const run = (args, cwd = root, extraEnv = {}) => spawnSync('git', args, {
    cwd, env: { ...env, ...extraEnv }, encoding: 'utf8'
  })
  const git = (args, cwd = root) => {
    const result = run(args, cwd)
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`)
    return result.stdout.trim()
  }
  git(['init', '-q'])
  git(['config', 'user.name', 'Hook Test'])
  git(['config', 'user.email', 'hook-test@example.invalid'])
  git(['config', 'commit.gpgsign', 'false'])
  for (const relative of ['.gitattributes', '.githooks/pre-commit', '.githooks/prepare-commit-msg', 'scripts/check-staged-review.cjs']) {
    mkdirSync(join(root, relative, '..'), { recursive: true })
    copyFileSync(join(sourceRoot, relative), join(root, relative))
  }
  chmodSync(join(root, '.githooks/pre-commit'), 0o755)
  chmodSync(join(root, '.githooks/prepare-commit-msg'), 0o755)
  writeFileSync(join(root, 'file.txt'), 'initial\n')
  writeFileSync(join(root, 'other.txt'), 'initial\n')
  git(['add', '.'])
  git(['-c', 'core.hooksPath=' + disabledHooks, 'commit', '-qm', 'fixture'])
  const approve = (cwd = root) => {
    writeFileSync(join(git(['rev-parse', '--absolute-git-dir'], cwd), 'singz-reviewed'), `${git(['write-tree'], cwd)}\n`)
  }
  const stage = (text, name = 'file.txt', cwd = root) => {
    writeFileSync(join(cwd, name), text)
    git(['add', name], cwd)
  }
  return { root, parent, env, run, git, approve, stage }
}

test('installed hook refuses unreviewed commits and accepts the approved staged tree in paths with spaces', (t) => {
  const f = fixture(t)
  assert.equal(installGitHooks(f.root, f.env), '.githooks')
  assert.equal(installGitHooks(f.root, f.env), '.githooks')
  f.stage('changed\n')
  const denied = f.run(['commit', '-qm', 'unreviewed'])
  assert.notEqual(denied.status, 0)
  assert.match(denied.stderr, /Not reviewed yet/)
  f.approve()
  assert.equal(f.run(['commit', '-qm', 'approved']).status, 0)
})

test('staging again invalidates approval and an explicit bypass is visible', (t) => {
  const f = fixture(t)
  installGitHooks(f.root, f.env)
  f.stage('first\n')
  f.approve()
  f.stage('second\n')
  const denied = f.run(['commit', '-qm', 'stale'])
  assert.notEqual(denied.status, 0)
  assert.match(denied.stderr, /staged tree changed/)
  const bypassed = f.run(['commit', '-qm', 'explicit bypass'], f.root, { SINGZ_SKIP_REVIEW: '1' })
  assert.equal(bypassed.status, 0, bypassed.stderr)
  assert.match(bypassed.stderr, /BYPASSED.*SINGZ_SKIP_REVIEW=1/)
})

test('a linked worktree cannot borrow the main worktree approval', (t) => {
  const f = fixture(t)
  installGitHooks(f.root, f.env)
  f.approve()
  const sibling = join(f.parent, 'sibling checkout')
  f.git(['worktree', 'add', '-q', '-b', 'sibling', sibling])
  assert.equal(installGitHooks(sibling, f.env), '.githooks')
  // Same tree as main, but approvals belong to the committing worktree.
  const denied = f.run(['commit', '--allow-empty', '-qm', 'unreviewed sibling'], sibling)
  assert.notEqual(denied.status, 0)
  assert.match(denied.stderr, /Not reviewed yet/)
  f.approve(sibling)
  const approved = f.run(['commit', '--allow-empty', '-qm', 'approved sibling'], sibling)
  assert.equal(approved.status, 0, approved.stderr)
})

test('partial commits are checked against Git\'s temporary commit index', (t) => {
  const f = fixture(t)
  installGitHooks(f.root, f.env)
  f.stage('first\n')
  f.stage('other\n', 'other.txt')
  f.approve()
  const denied = f.run(['commit', '--only', 'file.txt', '-qm', 'different commit tree'])
  assert.notEqual(denied.status, 0)
  assert.match(denied.stderr, /staged tree changed/)
  assert.equal(f.run(['commit', '-qm', 'whole approved tree']).status, 0)
})

test('installer preserves unrelated configured hooks', (t) => {
  const f = fixture(t)
  f.git(['config', '--local', 'core.hooksPath', '/custom hooks'])
  assert.throws(() => installGitHooks(f.root, f.env), /Refusing to replace existing core.hooksPath/)
  assert.equal(f.git(['config', '--get', 'core.hooksPath']), '/custom hooks')
})

test('installer refuses to hide an active legacy hook', (t) => {
  const f = fixture(t)
  const legacy = join(f.git(['rev-parse', '--absolute-git-dir']), 'hooks', 'post-commit')
  writeFileSync(legacy, '#!/bin/sh\nexit 0\n')
  chmodSync(legacy, 0o755)
  assert.throws(() => installGitHooks(f.root, f.env), /Refusing to disable existing Git hooks: post-commit/)
  assert.equal(f.run(['config', '--get', 'core.hooksPath']).status, 1)
  assert.match(readFileSync(legacy, 'utf8'), /exit 0/)
})

function conflictingBranches(f) {
  const base = f.git(['branch', '--show-current'])
  f.git(['checkout', '-qb', 'feature'])
  f.stage('feature\n')
  f.git(['commit', '-qm', 'feature'])
  f.git(['checkout', '-q', base])
  f.stage('base\n')
  f.git(['commit', '-qm', 'base'])
  return base
}

test('cherry-pick continuation requires review of the resolved tree', (t) => {
  const f = fixture(t)
  conflictingBranches(f)
  installGitHooks(f.root, f.env)
  const conflict = f.run(['cherry-pick', 'feature'])
  assert.notEqual(conflict.status, 0)
  assert.match(conflict.stdout + conflict.stderr, /CONFLICT/)
  f.stage('resolved cherry-pick\n')
  const denied = f.run(['cherry-pick', '--continue'])
  assert.notEqual(denied.status, 0)
  assert.match(denied.stderr, /Not reviewed yet/)
  f.approve()
  const approved = f.run(['cherry-pick', '--continue'])
  assert.equal(approved.status, 0, approved.stderr)
})

test('rebase continuation requires review of the resolved tree', (t) => {
  const f = fixture(t)
  const base = conflictingBranches(f)
  f.git(['checkout', '-q', 'feature'])
  installGitHooks(f.root, f.env)
  const conflict = f.run(['rebase', base])
  assert.notEqual(conflict.status, 0)
  assert.match(conflict.stdout + conflict.stderr, /CONFLICT/)
  f.stage('resolved rebase\n')
  const denied = f.run(['rebase', '--continue'])
  assert.notEqual(denied.status, 0)
  assert.match(denied.stderr, /Not reviewed yet/)
  f.approve()
  const approved = f.run(['rebase', '--continue'])
  assert.equal(approved.status, 0, approved.stderr)
})

test('prepare-commit-msg still gates a commit that omits pre-commit with --no-verify', (t) => {
  const f = fixture(t)
  installGitHooks(f.root, f.env)
  f.stage('changed\n')
  const denied = f.run(['commit', '--no-verify', '-qm', 'unreviewed'])
  assert.notEqual(denied.status, 0)
  assert.match(denied.stderr, /Not reviewed yet/)
  f.approve()
  assert.equal(f.run(['commit', '--no-verify', '-qm', 'reviewed']).status, 0)
})

test('CRLF-configured checkouts preserve executable LF review hooks', (t) => {
  const f = fixture(t)
  f.git(['config', 'core.autocrlf', 'true'])
  // Remove files to bypass Git's unchanged-stat optimization and force a
  // real checkout through the configured line-ending conversion.
  rmSync(join(f.root, 'file.txt'))
  rmSync(join(f.root, '.githooks'), { recursive: true })
  f.git(['checkout-index', '--all', '--force'])
  assert.match(readFileSync(join(f.root, 'file.txt'), 'utf8'), /\r\n/,
    'the fixture must exercise actual CRLF checkout conversion')
  for (const name of ['pre-commit', 'prepare-commit-msg']) {
    const hook = readFileSync(join(f.root, '.githooks', name), 'utf8')
    assert.ok(hook.startsWith('#!/bin/sh\n'), `${name} must retain an LF shebang`)
    assert.ok(!hook.includes('\r'), `${name} must remain LF throughout`)
  }
  installGitHooks(f.root, f.env)
  f.stage('first\n')
  const denied = f.run(['commit', '-qm', 'unreviewed CRLF checkout'])
  assert.notEqual(denied.status, 0)
  assert.match(denied.stderr, /Not reviewed yet/)
  f.approve()
  const approved = f.run(['commit', '-qm', 'approved CRLF checkout'])
  assert.equal(approved.status, 0, approved.stderr)
  f.stage('second\n')
  const stale = f.run(['commit', '--no-verify', '-qm', 'stale CRLF checkout'])
  assert.notEqual(stale.status, 0)
  assert.match(stale.stderr, /staged tree changed/)
  f.approve()
  const continued = f.run(['commit', '--no-verify', '-qm', 'approved prepare hook'])
  assert.equal(continued.status, 0, continued.stderr)
})

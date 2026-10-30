'use strict'

const assert = require('node:assert/strict')
const { execFileSync, spawnSync } = require('node:child_process')
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { test } = require('node:test')

const repoRoot = resolve(__dirname, '../..')
const verifier = join(repoRoot, 'scripts', 'verify-zcore-submodule.py')
const analyzerHash = join(repoRoot, 'scripts', 'analyze-source-hash.sh')
const submodulePath = 'third_party/zcore'
const fixtureEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
}

function git(cwd, args, options = {}) {
  return execFileSync('git', [
    ...(options.fileProtocol ? ['-c', 'protocol.file.allow=always'] : []),
    '-C', cwd, ...args
  ], {
    encoding: 'utf8',
    env: fixtureEnv,
    input: options.input,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim()
}

function createFixture(t, { hashInputs = false } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'singz-zcore-submodule-'))
  t.after(() => rmSync(scratch, { recursive: true, force: true }))
  const parent = join(scratch, 'consumer')
  const source = join(scratch, 'zcore-origin')
  mkdirSync(parent)
  mkdirSync(join(source, 'third_party', 'native', 'flac', 'src'), { recursive: true })
  writeFileSync(join(source, 'CMakeLists.txt'), '# fixture zCore\n')
  writeFileSync(join(source, 'third_party', 'native', 'flac', 'src', 'stream_decoder.c'),
    '/* pinned source */\n')
  git(source, ['init', '-q'])
  git(source, ['add', '.'])
  git(source, ['commit', '-qm', 'initial zCore source'])
  const firstRevision = git(source, ['rev-parse', 'HEAD'])
  git(source, ['commit', '--allow-empty', '-qm', 'same tree, new pin'])
  const secondRevision = git(source, ['rev-parse', 'HEAD'])

  git(parent, ['init', '-q'])
  if (hashInputs) prepareHashInputs(parent)
  git(parent, ['submodule', 'add', source, submodulePath], { fileProtocol: true })
  git(join(parent, submodulePath), ['checkout', '--detach', firstRevision])
  git(parent, ['add', submodulePath])
  git(parent, ['add', '-A'])
  git(parent, ['commit', '-qm', 'consumer fixture'])
  return {
    scratch,
    parent,
    child: join(parent, submodulePath),
    source,
    firstRevision,
    secondRevision,
  }
}

function prepareHashInputs(root) {
  const dirs = [
    'zcore', 'zdsp', 'third_party/native', 'tools/native', 'cmake', 'scripts'
  ]
  for (const dir of dirs) mkdirSync(join(root, dir), { recursive: true })
  writeFileSync(join(root, 'zcore', 'product.cpp'), '// retained product code\n')
  writeFileSync(join(root, 'zdsp', 'product.cpp'), '// retained product DSP\n')
  writeFileSync(join(root, 'third_party/native', 'library.c'), '/* fixture */\n')
  writeFileSync(join(root, 'tools/native', 'tool.cpp'), '// fixture\n')
  writeFileSync(join(root, 'cmake', 'policy.cmake'), '# fixture\n')
  writeFileSync(join(root, 'CMakeLists.txt'), '# fixture\n')
  for (const name of [
    'vendor-analyze.sh', 'engine-artifact.cjs', 'ccache-launcher.sh',
    'ccache-launcher.ps1', 'analyze-source-hash.sh', 'verify-zcore-submodule.py',
    'zcore-gitlink.cjs'
  ]) {
    writeFileSync(join(root, 'scripts', name), readFileSync(join(repoRoot, 'scripts', name)))
  }
}

function invokeVerifier(root, { printRevision = false } = {}) {
  const python = process.platform === 'win32' ? 'python' : 'python3'
  return spawnSync(python, [
    verifier, '--root', root, '--path', submodulePath,
    ...(printRevision ? ['--print-revision'] : [])
  ], { encoding: 'utf8', env: fixtureEnv })
}

function assertRejected(root, pattern) {
  const result = invokeVerifier(root)
  assert.notEqual(result.status, 0, `expected verifier rejection, got: ${result.stdout}`)
  assert.match(result.stderr, pattern)
}

test('verifies the parent gitlink and prints only its revision', (t) => {
  const fixture = createFixture(t)
  const result = invokeVerifier(fixture.parent, { printRevision: true })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, `${fixture.firstRevision}\n`)
  assert.equal(result.stderr, '')
  const human = invokeVerifier(fixture.parent)
  assert.equal(human.status, 0, human.stderr)
  assert.match(human.stdout, new RegExp(`verified: third_party/zcore at ${fixture.firstRevision}`))
})

test('rejects an uninitialized gitlink with an actionable command', (t) => {
  const fixture = createFixture(t)
  rmSync(fixture.child, { recursive: true, force: true })
  const result = invokeVerifier(fixture.parent)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /git submodule update --init -- third_party\/zcore/)
})

test('rejects a child checked out at the wrong commit even when clean', (t) => {
  const fixture = createFixture(t)
  git(fixture.child, ['checkout', '--detach', fixture.secondRevision])
  assertRejected(fixture.parent, /does not match parent gitlink/)
})

test('rejects unstaged, staged, and untracked child changes', (t) => {
  for (const kind of ['unstaged', 'staged', 'untracked']) {
    const fixture = createFixture(t)
    const file = join(fixture.child, 'zcore-edit.txt')
    writeFileSync(file, 'edited\n')
    if (kind === 'staged') git(fixture.child, ['add', 'zcore-edit.txt'])
    if (kind === 'unstaged') {
      writeFileSync(join(fixture.child, 'CMakeLists.txt'), '# dirty\n')
    }
    assertRejected(fixture.parent, /is dirty/)
  }
})

test('rejects an unmerged parent gitlink index', (t) => {
  const fixture = createFixture(t)
  git(fixture.parent, ['update-index', '--force-remove', submodulePath])
  const stages = [1, 2, 3].map(stage =>
    `160000 ${fixture.firstRevision} ${stage}\t${submodulePath}\0`).join('')
  git(fixture.parent, ['update-index', '-z', '--index-info'], { input: stages })
  assertRejected(fixture.parent, /exactly one stage-0 mode-160000 gitlink entry/)
})

test('rejects a copied plain folder that resolves to the consumer repository', (t) => {
  const fixture = createFixture(t)
  rmSync(join(fixture.child, '.git'), { force: true })
  assertRejected(fixture.parent, /different repository/)
})

test('analyzer fingerprint binds pin-only changes and ignores .git metadata paths', (t) => {
  const fixture = createFixture(t, { hashInputs: true })
  const hash = root => execFileSync('bash', [analyzerHash, root], {
    encoding: 'utf8', env: fixtureEnv
  }).trim()
  const before = hash(fixture.parent)
  // The child tree is byte-identical; only its commit and the parent gitlink move.
  git(fixture.child, ['checkout', '--detach', fixture.secondRevision])
  git(fixture.parent, ['add', submodulePath])
  const afterPin = hash(fixture.parent)
  assert.notEqual(afterPin, before)
  git(fixture.parent, ['commit', '-qm', 'advance zCore gitlink'])

  const clone = join(fixture.scratch, 'fresh-clone')
  execFileSync('git', ['-c', 'protocol.file.allow=always', 'clone', '--quiet',
    '--recurse-submodules', fixture.parent, clone], { env: fixtureEnv, stdio: 'ignore' })
  const worktree = join(fixture.scratch, 'linked-worktree')
  git(fixture.parent, ['worktree', 'add', '--quiet', '--detach', worktree, 'HEAD'])
  git(worktree, ['submodule', 'update', '--init', '--', submodulePath], { fileProtocol: true })
  assert.equal(hash(clone), afterPin)
  assert.equal(hash(worktree), afterPin)
})

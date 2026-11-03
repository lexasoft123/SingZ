const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync, symlinkSync, lstatSync, existsSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { spawnSync } = require('node:child_process')
const { assertBuildTarget, artifactPaths, checkArtifact, producerHash, stampArtifact, prepareOutput, atomicCopy } = require('../../scripts/engine-artifact.cjs')

const repository = resolve(__dirname, '../..')
const commit = 'a'.repeat(40)
const target = process.platform + '-' + process.arch
const posixOnly = { skip: process.platform === 'win32'
  ? 'Producer fixtures use POSIX shebang tools and shell executables; helper checks run on every host'
  : false }

function requireSymlinks(t, directory) {
  if (process.platform !== 'win32') return true
  const source = join(directory, 'symlink-capability-source')
  const link = join(directory, 'symlink-capability-link')
  writeFileSync(source, 'probe')
  try { symlinkSync(source, link) }
  catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error
    t.skip('Windows symlink privilege is unavailable')
    return false
  }
  rmSync(link)
  rmSync(source)
  return true
}
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'singz-engine-policy-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const root = join(directory, 'checkout')
  mkdirSync(join(root, 'scripts'), { recursive: true })
  for (const file of ['engine-artifact.cjs', 'vendor-analyze.sh', 'vendor-llama.sh', 'vendor-crispasr.sh', 'assert-portable-binary.sh'])
    copyFileSync(join(repository, 'scripts', file), join(root, 'scripts', file))
  return { directory, root }
}

function install(root, engine, ref = 'v1') {
  const { name, binary } = artifactPaths(root, engine, target)
  prepareOutput(root, target, name)
  writeFileSync(binary, 'fixture executable')
  stampArtifact(root, engine, target, ref, commit)
  return artifactPaths(root, engine, target)
}

test('build compatibility allows native hosts and Darwin slices, rejecting unsupported toolchains', () => {
  const hosts = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64']
  for (const host of hosts) {
    for (const requested of hosts) {
      if (host === requested || (host.startsWith('darwin-') && requested.startsWith('darwin-')))
        assert.doesNotThrow(() => assertBuildTarget(requested, host))
      else assert.throws(() => assertBuildTarget(requested, host), /Cannot build/)
    }
  }
})

for (const engine of ['llama', 'crispasr']) {
  test(`${engine} receipts reject missing evidence, stale revision, changed bytes and producer drift`, t => {
    const { root } = fixture(t)
    const paths = artifactPaths(root, engine, target)
    mkdirSync(join(root, 'vendor', target), { recursive: true })
    writeFileSync(paths.binary, 'unreceipted executable')
    assert.equal(checkArtifact(root, engine, target, 'v1'), false)
    install(root, engine)
    assert.equal(checkArtifact(root, engine, target, 'v1'), true)
    assert.equal(checkArtifact(root, engine, target, 'v2'), false)
    assert.equal(checkArtifact(root, engine, target === 'linux-arm64' ? 'linux-x64' : 'linux-arm64', 'v1'), false)
    writeFileSync(paths.binary, 'corrupt executable')
    assert.equal(checkArtifact(root, engine, target, 'v1'), false)
    install(root, engine)
    for (const name of [`vendor-${engine}.sh`, 'engine-artifact.cjs', 'assert-portable-binary.sh']) {
      const file = join(root, 'scripts', name)
      const original = readFileSync(file)
      const expectedProducerHash = producerHash(root, engine)
      writeFileSync(file, Buffer.concat([original, Buffer.from('\n# producer change\n')]))
      assert.equal(checkArtifact(root, engine, target, 'v1'), false, name)
      assert.throws(() => stampArtifact(root, engine, target, 'v1', commit, expectedProducerHash), /producer inputs changed/)
      writeFileSync(file, original)
    }
    const receipt = JSON.parse(readFileSync(paths.receipt, 'utf8'))
    writeFileSync(paths.receipt, JSON.stringify({ ...receipt, sourceCommit: 'not-a-commit' }))
    assert.equal(checkArtifact(root, engine, target, 'v1'), false)
    assert.throws(() => stampArtifact(root, engine, target, 'b'.repeat(40), commit), /differs/)
  })
}

test('shared artifacts are validated against the consuming checkout producer', t => {
  const { directory, root } = fixture(t)
  install(root, 'llama')
  const consumer = join(directory, 'consumer')
  mkdirSync(join(consumer, 'scripts'), { recursive: true })
  for (const file of ['engine-artifact.cjs', 'vendor-llama.sh', 'assert-portable-binary.sh'])
    copyFileSync(join(root, 'scripts', file), join(consumer, 'scripts', file))
  assert.equal(checkArtifact(root, 'llama', target, 'v1', consumer), true)
  writeFileSync(join(consumer, 'scripts/vendor-llama.sh'), 'different branch producer')
  assert.equal(checkArtifact(root, 'llama', target, 'v1', consumer), false)
})

for (const linkKind of ['vendor', 'target', 'binary']) {
  test(`publication detaches ${linkKind} links without modifying a sibling`, t => {
    const { directory, root } = fixture(t)
    if (!requireSymlinks(t, directory)) return
    const sibling = join(directory, 'sibling')
    const shared = artifactPaths(sibling, 'llama', target)
    mkdirSync(join(sibling, 'vendor', target), { recursive: true })
    writeFileSync(shared.binary, 'sibling original')
    writeFileSync(shared.receipt, 'sibling receipt')
    const paths = artifactPaths(root, 'llama', target)
    if (linkKind === 'vendor') symlinkSync(join(sibling, 'vendor'), join(root, 'vendor'), 'dir')
    else {
      mkdirSync(join(root, 'vendor'), { recursive: true })
      if (linkKind === 'target') symlinkSync(join(sibling, 'vendor', target), join(root, 'vendor', target), 'dir')
      else {
        mkdirSync(join(root, 'vendor', target))
        symlinkSync(shared.binary, paths.binary)
        symlinkSync(shared.receipt, paths.receipt)
        assert.throws(() => stampArtifact(root, 'llama', target, 'v1', commit), /shared output/)
      }
    }
    const input = join(directory, 'new-binary')
    writeFileSync(input, 'this branch executable')
    atomicCopy(input, prepareOutput(root, target, paths.name))
    stampArtifact(root, 'llama', target, 'v1', commit)
    assert.equal(lstatSync(paths.binary).isSymbolicLink(), false)
    assert.equal(checkArtifact(root, 'llama', target, 'v1'), true)
    assert.equal(readFileSync(shared.binary, 'utf8'), 'sibling original')
    assert.equal(readFileSync(shared.receipt, 'utf8'), 'sibling receipt')
  })
}

// Run real producer shell scripts against fake git/cmake executables. No
// network, compiler, native lock, or checkout outside the fixture is touched.
function toolFixture(t) {
  const fixtureState = fixture(t)
  const { directory, root } = fixtureState
  const bin = join(directory, 'tools')
  mkdirSync(bin)
  const log = join(directory, 'tools.log')
  // Portability is independently tested; these fake executables are not Mach-O.
  writeFileSync(join(root, 'scripts/assert-portable-binary.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  writeFileSync(join(root, 'scripts/assert-native-build-lock.cjs'), `if (!process.env.SINGZ_NATIVE_BUILD_LOCK_HELD) process.exit(19)\n`)
  writeFileSync(join(root, 'scripts/analyze-source-hash.sh'), '#!/bin/sh\ncat "$(dirname "$0")/../source-hash"\n', { mode: 0o755 })
  writeFileSync(join(root, 'source-hash'), 'fixture-current-hash\n')
  writeFileSync(join(bin, 'git'), `#!${process.execPath}
const fs = require('node:fs'); const args = process.argv.slice(2);
fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify(['git', ...args]) + '\\n');
if (args.includes('hash-object')) { process.stdin.resume(); process.stdin.on('end', () => console.log('0123456789abcdef')); }
else if (args.includes('rev-parse')) console.log('${commit}');
else if (args.includes('status') && (process.env.FIXTURE_DIRTY_SOURCE || fs.existsSync(require('node:path').join(process.env.FIXTURE_ROOT, '.dirty-after-build')))) console.log(' M source.cpp');
`, { mode: 0o755 })
  writeFileSync(join(bin, 'cmake'), `#!${process.execPath}
const fs=require('node:fs'); const path=require('node:path'); const args=process.argv.slice(2);
fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify(['cmake', ...args]) + '\\n');
if (args.includes('-B')) {
 const dir=args[args.indexOf('-B')+1]; fs.mkdirSync(dir,{recursive:true});
 const hash=args.find(a=>a.startsWith('-DSINGZ_SOURCE_HASH=')); if(hash) fs.writeFileSync(path.join(dir,'fixture-hash'),hash.split('=')[1]);
} else {
 const dir=args[args.indexOf('--build')+1]; const name=args[args.indexOf('--target')+1];
 if(name==='singz-analyze') {
  const hash=fs.readFileSync(path.join(dir,'fixture-hash'),'utf8');
  const identity=process.env.FIXTURE_BAD_ANALYZER === 'malformed' ? 'not JSON' : JSON.stringify({sourceHash:process.env.FIXTURE_BAD_ANALYZER === 'wrong' ? 'wrong-source-hash' : hash});
  fs.writeFileSync(path.join(dir,'singz-analyze'), "#!/bin/sh\\necho '" + identity + "'\\n", {mode:0o755});
  if(process.env.FIXTURE_UNEXECUTABLE_ANALYZER) { fs.writeFileSync(path.join(dir,'singz-analyze'),'unexecutable cross-target binary'); fs.chmodSync(path.join(dir,'singz-analyze'),0o644); }
 } else { fs.mkdirSync(path.join(dir,'bin'),{recursive:true}); fs.writeFileSync(path.join(dir,'bin',name==='crispasr-cli'?'crispasr':name),'rebuilt fixture executable'); }
 if(process.env.FIXTURE_CHANGE_SOURCE) { fs.writeFileSync(path.join(process.env.FIXTURE_ROOT,'source-hash'),'changed-during-build\\n'); fs.writeFileSync(path.join(process.env.FIXTURE_ROOT,'.dirty-after-build'),'changed'); }
}
`, { mode: 0o755 })
  const environment = {
    ...process.env, PATH: `${bin}${require('node:path').delimiter}${process.env.PATH}`,
    TMPDIR: directory, SINGZ_NATIVE_BUILD_LOCK_HELD: 'fixture-inherited-lock-token',
    FIXTURE_LOG: log, FIXTURE_ROOT: root,
  }
  delete environment.SINGZ_NATIVE_JOBS
  return { ...fixtureState, environment, log }
}

for (const engine of ['llama', 'crispasr']) {
  test(`${engine} producer rebuilds a stale linked binary locally and honors the requested pin`, posixOnly, t => {
    const { root, directory, environment, log } = toolFixture(t)
    const source = engine === 'llama' ? 'llama.cpp' : 'CrispASR'
    mkdirSync(join(root, '.engines-src', source), { recursive: true })
    const shared = join(directory, 'shared-binary')
    writeFileSync(shared, 'sibling original')
    const paths = artifactPaths(root, engine, target)
    mkdirSync(join(root, 'vendor', target), { recursive: true })
    symlinkSync(shared, paths.binary)
    environment[engine === 'llama' ? 'SINGZ_LLAMA_REF' : 'SINGZ_CRISPASR_REF'] = 'requested-v2'
    const run = spawnSync('bash', [join(root, 'scripts', `vendor-${engine}.sh`), target], { env: environment, encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr)
    assert.equal(checkArtifact(root, engine, target, 'requested-v2'), true)
    assert.equal(readFileSync(shared, 'utf8'), 'sibling original')
    const commands = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse)
    assert.ok(commands.some(args => args.includes('fetch') && args.at(-1) === 'requested-v2'))
    assert.ok(commands.some(args => args.includes('checkout') && args.at(-1) === 'FETCH_HEAD'))
    assert.ok(commands.some(args => args.includes('--parallel') && args[args.indexOf('--parallel') + 1] === '4'))
    rmSync(log)
    const cached = spawnSync('bash', [join(root, 'scripts', `vendor-${engine}.sh`), '--check-cache', target, root], { env: { ...environment, SINGZ_NATIVE_BUILD_LOCK_HELD: '' }, encoding: 'utf8' })
    assert.equal(cached.status, 0, cached.stderr)
    assert.equal(existsSync(log), false, 'cache check must not run git, build, or lock commands')
    environment[engine === 'llama' ? 'SINGZ_LLAMA_REF' : 'SINGZ_CRISPASR_REF'] = 'requested-v3'
    assert.equal(spawnSync('bash', [join(root, 'scripts', `vendor-${engine}.sh`), '--check-cache', target, root], { env: environment }).status, 1)
  })
}

test('analyzer rejects a lying sidecar, rebuilds locally, and refuses edits during build', posixOnly, t => {
  const { root, directory, environment, log } = toolFixture(t)
  const hostTarget = process.platform + '-' + process.arch
  const out = join(root, 'vendor', hostTarget, 'singz-analyze')
  mkdirSync(join(root, 'vendor', hostTarget), { recursive: true })
  writeFileSync(out, '#!/bin/sh\nprintf \'%s\\n\' \'{"sourceHash":"old-hash"}\'\n', { mode: 0o755 })
  writeFileSync(`${out}.source-hash`, 'fixture-current-hash\n')
  const args = [join(root, 'scripts/vendor-analyze.sh'), hostTarget]
  const result = spawnSync('bash', args, { env: environment, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /built:/)
  assert.match(readFileSync(log, 'utf8'), /--parallel.*4/)
  assert.match(spawnSync(out, ['build-info'], { encoding: 'utf8' }).stdout, /fixture-current-hash/)
  rmSync(log)
  assert.match(spawnSync('bash', args, { env: environment, encoding: 'utf8' }).stdout, /cached:/)
  assert.equal(existsSync(log), false)
  writeFileSync(join(root, 'source-hash'), 'next-source-hash\n')
  const failed = spawnSync('bash', args, { env: { ...environment, FIXTURE_CHANGE_SOURCE: '1' }, encoding: 'utf8' })
  assert.notEqual(failed.status, 0)
  assert.match(failed.stderr, /changed during the build/)
  assert.equal(readFileSync(`${out}.source-hash`, 'utf8'), 'fixture-current-hash\n')
})

test('cross-target analyzers build without an emulator but cannot reuse a sidecar-only cache', { skip: process.platform !== 'darwin' }, t => {
  const { root, environment, log } = toolFixture(t)
  const crossTarget = process.arch === 'arm64' ? 'darwin-x64' : 'darwin-arm64'
  const args = [join(root, 'scripts/vendor-analyze.sh'), crossTarget]
  const env = { ...environment, FIXTURE_UNEXECUTABLE_ANALYZER: '1' }
  for (let run = 0; run < 2; run++) {
    const result = spawnSync('bash', args, { env, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stderr, /verify build-info on/)
    assert.match(result.stdout, /built:/)
    assert.match(readFileSync(log, 'utf8'), /cmake/)
    rmSync(log)
  }
})

test('an unexecutable host analyzer is refused and loses its success sidecar', posixOnly, t => {
  const { root, environment } = toolFixture(t)
  const hostTarget = process.platform + '-' + process.arch
  const result = spawnSync('bash', [join(root, 'scripts/vendor-analyze.sh'), hostTarget], {
    env: { ...environment, FIXTURE_UNEXECUTABLE_ANALYZER: '1' }, encoding: 'utf8',
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /does not report the expected source fingerprint/)
  assert.equal(existsSync(join(root, 'vendor', hostTarget, 'singz-analyze.source-hash')), false)
})

for (const badIdentity of ['wrong', 'malformed']) {
  test(`an executable cross-target analyzer with ${badIdentity} identity is refused`, { skip: process.platform !== 'darwin' }, t => {
    const { root, environment } = toolFixture(t)
    const crossTarget = process.arch === 'arm64' ? 'darwin-x64' : 'darwin-arm64'
    const result = spawnSync('bash', [join(root, 'scripts/vendor-analyze.sh'), crossTarget], {
      env: { ...environment, FIXTURE_BAD_ANALYZER: badIdentity }, encoding: 'utf8',
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /does not report the expected source fingerprint/)
    assert.doesNotMatch(result.stderr, /verify build-info on/)
    assert.equal(existsSync(join(root, 'vendor', crossTarget, 'singz-analyze.source-hash')), false)
  })
}

for (const engine of ['analyze', 'llama', 'crispasr']) {
  test(`${engine} refuses a cross-OS request before accepting a cached binary or building`, posixOnly, t => {
    const { root, environment, log } = toolFixture(t)
    const crossTarget = process.platform === 'win32' ? 'linux-x64' : 'win32-x64'
    const run = spawnSync('bash', [join(root, 'scripts', `vendor-${engine}.sh`), crossTarget], { env: environment, encoding: 'utf8' })
    assert.notEqual(run.status, 0)
    assert.match(run.stderr, /Cannot build/)
    assert.equal(existsSync(log), false)
    assert.equal(existsSync(join(root, '.engines-src')), false)
  })

  test(`${engine} producer rejects excessive/invalid jobs before invoking build tools`, posixOnly, t => {
    const { root, environment, log } = toolFixture(t)
    for (const jobs of ['0', '5', '16', '-1', 'garbage', '2.5']) {
      const run = spawnSync('bash', [join(root, 'scripts', `vendor-${engine}.sh`), target], { env: { ...environment, SINGZ_NATIVE_JOBS: jobs }, encoding: 'utf8' })
      assert.notEqual(run.status, 0, jobs)
      assert.match(run.stderr, /integer from 1 through 4/)
      assert.equal(existsSync(log), false)
    }
  })
}

for (const engine of ['llama', 'crispasr']) {
  test(`${engine} read-only cache inspection supports a foreign target without building`, posixOnly, t => {
    const { root, environment, log } = toolFixture(t)
    const crossTarget = process.platform === 'win32' ? 'linux-x64' : 'win32-x64'
    const { name, binary } = artifactPaths(root, engine, crossTarget)
    writeFileSync(prepareOutput(root, crossTarget, name), 'foreign executable fixture')
    const ref = 'foreign-v1'
    stampArtifact(root, engine, crossTarget, ref, commit)
    environment[engine === 'llama' ? 'SINGZ_LLAMA_REF' : 'SINGZ_CRISPASR_REF'] = ref
    const run = spawnSync('bash', [join(root, 'scripts', `vendor-${engine}.sh`), '--check-cache', crossTarget, root], { env: environment, encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr)
    assert.equal(existsSync(log), false)
    assert.equal(readFileSync(binary, 'utf8'), 'foreign executable fixture')
  })
}

for (const engine of ['llama', 'crispasr']) {
  test(`${engine} refuses dirty sources and edits racing a build before publication`, posixOnly, t => {
    const { root, environment, log } = toolFixture(t)
    mkdirSync(join(root, '.engines-src', engine === 'llama' ? 'llama.cpp' : 'CrispASR'), { recursive: true })
    const args = [join(root, 'scripts', `vendor-${engine}.sh`), target]
    const dirty = spawnSync('bash', args, { env: { ...environment, FIXTURE_DIRTY_SOURCE: '1' }, encoding: 'utf8' })
    assert.notEqual(dirty.status, 0)
    assert.match(dirty.stderr, /modified third-party source tree/)
    const commands = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(commands.some(args => args.includes('cmake') || args.includes('fetch') || args.includes('checkout')), false)
    const raced = spawnSync('bash', args, { env: { ...environment, FIXTURE_CHANGE_SOURCE: '1' }, encoding: 'utf8' })
    assert.notEqual(raced.status, 0)
    assert.match(raced.stderr, /sources changed during the build/)
    assert.equal(existsSync(artifactPaths(root, engine, target).binary), false)
    assert.equal(existsSync(artifactPaths(root, engine, target).receipt), false)
  })
}

'use strict'
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { test } = require('node:test')
const vm = require('node:vm')

const repository = path.resolve(__dirname, '../..')
const launchSmokePath = path.join(repository, 'tests/e2e/box-package-launch-smoke.cjs')
const scriptSource = process.env.SINGZ_TEST_LINUX_PACKAGE_SCRIPT ||
  path.join(repository, 'scripts/ci/linux-package.sh')
const source = fs.readFileSync(scriptSource, 'utf8')
let resolvedBash
for (const candidate of ['bash', '/opt/homebrew/bin/bash', '/usr/local/bin/bash', '/bin/bash']) {
  const result = spawnSync(candidate, ['-c', 'if ((BASH_VERSINFO[0] >= 4)); then printf "%s" "$BASH"; fi'], { encoding: 'utf8' })
  if (!result.error && result.status === 0 && result.stdout.trim()) {
    resolvedBash = result.stdout.trim()
    break
  }
}
const posixOnly = {
  skip: process.platform === 'win32'
    ? 'Linux packaging orchestration requires POSIX bash'
    : !resolvedBash ? 'Bash 4+ is required for the Linux packaging mapfile harness' : false
}

function bash() {
  return resolvedBash
}

function writeExecutable(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
  fs.chmodSync(file, 0o755)
}

function fixture(t, text = source) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join('/tmp/', 'sz-ci-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const bin = path.join(root, 'bin')
  const desktopRoot = path.join(root, 'installed/SingZ')
  const boxRoot = path.join(root, 'installed/singz-box')
  const log = path.join(root, 'calls.log')
  fs.mkdirSync(bin, { recursive: true })
  fs.mkdirSync(path.join(root, 'scripts/ci'), { recursive: true })
  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true })
  assert.ok(text.includes('/opt/SingZ') && text.includes('/opt/singz-box'), 'production install identities must remain explicit')
  const relocated = text.replaceAll('/opt/singz-box', boxRoot).replaceAll('/opt/SingZ', desktopRoot)
  const script = path.join(root, 'scripts/ci/linux-package.sh')
  fs.writeFileSync(script, relocated)

  const stub = (name, body) => writeExecutable(path.join(bin, name), `#!/bin/bash\n${body}\n`)
  stub('uname', 'case "${1-}" in -s) echo Linux;; -m) echo x86_64;; *) exit 1;; esac')
  stub('id', 'if [ "${1-}" = -u ]; then echo 1001; else command -p id "$@"; fi')
  stub('clang++-21', 'echo "Debian clang version 21.0.0"')
  for (const name of ['npm', 'cmake', 'ctest']) stub(name, `printf '${name.toUpperCase()}|%s\\n' "$*" >> "$CI_TEST_LOG"`)
  stub('node', `
printf 'NODE|stage=%s|capture=%s|boxhost=%s|e2e=%s|ozone=%s|mute=%s|nosync=%s|args=%s\\n' \\
  "$SINGZ_CI_STAGE" "$SINGZ_CAPTURE_BUILD_DIR" "$SINGZ_BOX_AUDIO_HOST_EXECUTABLE" \\
  "$E2E_PACKAGED" "$SINGZ_E2E_OZONE" "$SINGZ_MUTE" "$SINGZ_NO_SYNC" "$*" >> "$CI_TEST_LOG"
if [[ " $* " == *" node_modules/electron/install.js "* ]]; then
  mkdir -p node_modules/electron/dist
  printf 'fixture-version\n' > node_modules/electron/dist/version
  printf 'fixture sandbox\n' > node_modules/electron/dist/chrome-sandbox
fi
if [[ " $* " == *" scripts/dist.cjs "* ]]; then
  dir=dist
  artifact=SingZ-0.0.0-linux-amd64.deb
  if [[ " $* " == *" --box "* ]]; then
    dir=dist/box
    artifact=SingZ-Box-0.0.0-linux-amd64.deb
  fi
  mkdir -p "$dir"
  printf 'fixture installer\\n' > "$dir/$artifact"
fi`)
  stub('sha256sum', `
printf 'SHA256|%s\\n' "$*" >> "$CI_TEST_LOG"
for file do printf 'fixture-sha256  %s\\n' "$file"; done`)
  stub('sudo', 'printf \'SUDO|%s\\n\' "$*" >> "$CI_TEST_LOG"\nexec "$@"')
  stub('apt-get', 'printf \'APT|%s\\n\' "$*" >> "$CI_TEST_LOG"')
  stub('dpkg-deb', `
printf 'DPKG_DEB|%s\\n' "$*" >> "$CI_TEST_LOG"
if [ "$1" = -f ]; then
  case "$2" in *SingZ-Box*) package=singz-box;; *) package=singz;; esac
  case "$3" in Package) printf '%s\\n' "$package";; Architecture) echo amd64;; Depends) printf '%s\\n' "\${CI_TEST_BOX_DEPENDS-libgtk-3-0, python3, fonts-noto-cjk}";; *) exit 1;; esac
fi`)
  stub('dpkg-query', `
printf 'DPKG_QUERY|%s\\n' "$*" >> "$CI_TEST_LOG"
for last do :; done
printf '%s' "$last"`)
  stub('readlink', `
case "$2" in
  /usr/bin/singz-box) printf '%s\\n' "$CI_TEST_BOX_ROOT/singz-box";;
  /usr/bin/singz) printf '%s\\n' "$CI_TEST_DESKTOP_ROOT/singz";;
  *) exit 1;;
esac`)
  stub('cmp', 'printf \'CMP|%s\\n\' "$*" >> "$CI_TEST_LOG"\ncommand -p cmp "$@"')
  stub('pactl', 'printf \'PACTL|%s\\n\' "$*" >> "$CI_TEST_LOG"')
  stub('pulseaudio', `
for argument do
  case "$argument" in --file=*) directory=\${argument#--file=};; esac
done
directory=\${directory%/config.pa}
exec "$CI_TEST_NODE" -e '
const net = require("node:net")
const server = net.createServer()
server.listen(process.argv[1] + "/native")
process.on("SIGTERM", () => server.close(() => process.exit(0)))
setTimeout(() => process.exit(0), 30000)
' "$directory"`)
  stub('dbus-run-session', `
printf 'DBUS|%s\\n' "$*" >> "$CI_TEST_LOG"
while [ "$1" != -- ]; do shift; done
shift
exec "$@"`)
  stub('cage', `
printf 'CAGE|%s\\n' "$*" >> "$CI_TEST_LOG"
while [ "$1" != -- ]; do shift; done
shift
exec "$@"`)
  stub('xvfb-run', `
printf 'XVFB|%s\\n' "$*" >> "$CI_TEST_LOG"
while [ $# -gt 0 ]; do
  case "$1" in -a) shift;; -s) shift 2;; *) break;; esac
done
exec "$@"`)
  stub('chown', 'printf \'CHOWN|%s\\n\' "$*" >> "$CI_TEST_LOG"')
  stub('chmod', 'printf \'CHMOD|%s\\n\' "$*" >> "$CI_TEST_LOG"')
  writeExecutable(path.join(root, 'node_modules/.bin/electron'), `#!/bin/sh
printf 'ELECTRON|mute=%s|nosync=%s|args=%s\\n' "$SINGZ_MUTE" "$SINGZ_NO_SYNC" "$*" >> "$CI_TEST_LOG"
`)
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/electron': { version: 'fixture-version' } } }))
  fs.mkdirSync(path.join(root, 'node_modules/electron'), { recursive: true })
  fs.writeFileSync(path.join(root, 'node_modules/electron/package.json'), JSON.stringify({ version: 'fixture-version' }))
  writeExecutable(path.join(root, 'node_modules/.bin/asar'), `#!/bin/sh
printf 'ASAR|%s\\n' "$*" >> "$CI_TEST_LOG"
[ "$1" = list ] || exit 1
printf '%s' "\${CI_TEST_ASAR_LIST-/out/main/index.js
/package.json
}"
`)
  for (const [file, executable] of [['cec-input.py', false], ['singz-box-audio.service', false], ['singz-box-with-audio', true], ['singz-box-rtprio.conf', false]]) {
    for (const directory of [path.join(root, 'resources/linux'), path.join(boxRoot, 'resources/box-audio')]) {
      fs.mkdirSync(directory, { recursive: true })
      fs.writeFileSync(path.join(directory, file), `box audio ${file}\n`)
      if (executable) fs.chmodSync(path.join(directory, file), 0o755)
    }
  }
  writeExecutable(path.join(root, 'scripts/vendor-analyze.sh'), `#!/bin/sh
printf 'VENDOR_ANALYZE|%s\\n' "$*" >> "$CI_TEST_LOG"
`)

  const nativeFiles = [
    'singz-capture.node', 'singz-capture.manifest.json', 'singz-capture.node.sha256',
    'singz-capture.node.source-hash', 'singz-analyze', 'llama-server', 'crispasr',
    'gpu-splitter-linux-x64.tar.gz'
  ]
  for (const [product, installRoot, unpackedRoot, executable] of [
    ['desktop', desktopRoot, path.join(root, 'dist/linux-unpacked'), 'singz'],
    ['box', boxRoot, path.join(root, 'dist/box/linux-unpacked'), 'singz-box']
  ]) {
    for (const base of [installRoot, unpackedRoot]) {
      fs.mkdirSync(path.join(base, 'resources/engines'), { recursive: true })
      fs.writeFileSync(path.join(base, 'resources/app.asar'), `${product} app.asar\n`)
      for (const file of nativeFiles) fs.writeFileSync(path.join(base, 'resources/engines', file), `${product} ${file}\n`)
    }
    const launcher = `#!/bin/sh
printf '${product.toUpperCase()}_EXEC|args=%s\\n' "$*" >> "$CI_TEST_LOG"
`
    writeExecutable(path.join(installRoot, executable), launcher)
    writeExecutable(path.join(unpackedRoot, executable), launcher)
    for (const tool of ['singz-analyze', 'llama-server', 'crispasr']) {
      const engine = `#!/bin/sh
echo '${product} ${tool} fixture'
`
      writeExecutable(path.join(installRoot, 'resources/engines', tool), engine)
      writeExecutable(path.join(unpackedRoot, 'resources/engines', tool), engine)
    }
  }
  fs.writeFileSync(path.join(root, 'dist/SingZ-0.0.0-linux-amd64.deb'), 'desktop deb\n')
  fs.writeFileSync(path.join(root, 'dist/box/SingZ-Box-0.0.0-linux-amd64.deb'), 'box deb\n')

  function run(stage, extraEnv = {}) {
    const env = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      CI_TEST_LOG: log,
      CI_TEST_NODE: process.execPath,
      CI_TEST_DESKTOP_ROOT: desktopRoot,
      CI_TEST_BOX_ROOT: boxRoot,
      TMPDIR: path.join(root, 'tmp'),
      SINGZ_CI_STAGE: stage,
      SINGZ_E2E_PACKAGED: path.join(desktopRoot, 'singz'),
      ...extraEnv
    }
    delete env.E2E_PACKAGED
    delete env.SINGZ_BOX_AUDIO_HOST_EXECUTABLE
    const result = spawnSync(bash(), [script], {
      cwd: root, env, encoding: 'utf8', timeout: 15000
    })
    return { ...result, calls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' }
  }
  return { root, desktopRoot, boxRoot, log, run }
}

function output(result) {
  return `${result.stdout || ''}\n${result.stderr || ''}\n${result.calls || ''}`
}

function assertBuild(f, result) {
  assert.equal(result.status, 0, output(result))
  const dist = result.calls.split('\n').filter(line => line.startsWith('NODE|') && line.includes('scripts/dist.cjs'))
  assert.equal(dist.length, 2, 'Desktop and Box must both use the canonical dist wrapper')
  const desktop = dist.find(line => !line.includes(' --box '))
  const box = dist.find(line => line.includes(' --box '))
  assert.ok(desktop && box, result.calls)
  const capture = `capture=${path.join(f.root, 'build/native/linux-ci-clang21-x64')}`
  for (const line of [desktop, box]) {
    assert.ok(line.includes('stage=build'), line)
    assert.ok(line.includes(capture), line)
    assert.ok(line.includes('--linux --x64 --publish never'), line)
  }
  for (const file of ['dist/SHA256SUMS', 'dist/box/SHA256SUMS']) {
    assert.match(fs.readFileSync(path.join(f.root, file), 'utf8'), /linux-amd64\.deb/)
  }
}

function assertInstalled(f, result) {
  assert.equal(result.status, 0, output(result))
  assert.ok(result.calls.includes(`APT|install --reinstall --no-install-recommends -y ${path.join(f.root, 'dist/SingZ-0.0.0-linux-amd64.deb')} ${path.join(f.root, 'dist/box/SingZ-Box-0.0.0-linux-amd64.deb')}`), result.calls)
  assert.match(result.calls, /DPKG_QUERY\|-W -f=\$\{Package\} singz\n/)
  assert.match(result.calls, /DPKG_QUERY\|-W -f=\$\{Package\} singz-box\n/)
  for (const [root, unpacked, executable] of [
    [f.desktopRoot, 'dist/linux-unpacked', 'singz'],
    [f.boxRoot, 'dist/box/linux-unpacked', 'singz-box']
  ]) {
    assert.ok(result.calls.includes(`CMP|${root}/${executable} ${unpacked}/${executable}`), result.calls)
    assert.ok(result.calls.includes(`CMP|${root}/resources/app.asar ${unpacked}/resources/app.asar`), result.calls)
    assert.ok(result.calls.includes(`CMP|${root}/resources/engines/singz-capture.node ${unpacked}/resources/engines/singz-capture.node`), result.calls)
  }
  for (const file of ['cec-input.py', 'singz-box-audio.service', 'singz-box-with-audio', 'singz-box-rtprio.conf']) {
    assert.ok(result.calls.includes(`CMP|${f.boxRoot}/resources/box-audio/${file} resources/linux/${file}`),
      `installed Box resource ${file} must be verified`)
  }
  assert.ok(result.calls.includes(`DPKG_DEB|-f ${path.join(f.root, 'dist/box/SingZ-Box-0.0.0-linux-amd64.deb')} Depends`),
    'Box Depends must be checked')
  assert.ok(result.calls.includes(`ASAR|list ${f.boxRoot}/resources/app.asar`), 'installed Box asar must be listed')
  const nodes = result.calls.split('\n').filter(line => line.startsWith('NODE|'))
  const desktopUi = nodes.filter(line => line.includes('tests/e2e/linux/package-smoke.cjs'))
  assert.equal(desktopUi.length, 2, 'both existing Desktop display qualifications must remain')
  assert.ok(desktopUi.some(line => line.includes('ozone=wayland')))
  assert.ok(desktopUi.some(line => line.includes('ozone=x11')))
  const audio = nodes.find(line => line.includes('tests/e2e/box-audio-host-smoke.cjs'))
  assert.ok(audio?.includes(`boxhost=${path.join(f.boxRoot, 'singz-box')}`), 'installed Box audio-host smoke must use the Box executable')
  const box = nodes.find(line => line.includes('tests/e2e/box-package-launch-smoke.cjs'))
  assert.ok(box?.includes(`e2e=${path.join(f.boxRoot, 'singz-box')}`), 'installed Box must run its normal-launch smoke')
  assert.ok(box && !box.includes('--box'), 'packaged Box must not need a development profile argument')
  const recovery = nodes.find(line => line.includes('tests/e2e/box-retained-recovery.cjs'))
  assert.ok(recovery?.includes(`e2e=${path.join(f.boxRoot, 'singz-box')}`), 'installed Box retained recovery must use the installed UI executable')
  assert.ok(recovery?.includes(`boxhost=${path.join(f.boxRoot, 'singz-box')}`), 'installed Box retained recovery must use the installed host executable')
  assert.ok(result.calls.indexOf('tests/e2e/box-retained-recovery.cjs') > result.calls.indexOf('tests/e2e/box-cec-input-smoke.cjs'),
    'retained recovery qualification must run after the existing CEC step')
  for (const line of [audio, box, recovery]) {
    assert.ok(line.includes('mute=1') && line.includes('nosync=1'), line)
  }
  const provision = nodes.find(line => line.includes('node_modules/electron/install.js'))
  assert.ok(provision, 'Electron sandbox provision must run before CEC')
  const provisionAt = result.calls.indexOf('node_modules/electron/install.js')
  const cecAt = result.calls.indexOf('tests/e2e/box-cec-input-smoke.cjs')
  assert.ok(cecAt >= 0, 'installed Box CEC smoke must run under Electron')
  assert.ok(provisionAt >= 0 && provisionAt < cecAt, 'Electron install must precede CEC')
  const sandbox = path.join(f.root, 'node_modules/electron/dist/chrome-sandbox')
  const chownAt = result.calls.indexOf(`CHOWN|root:root ${sandbox}`)
  const chmodAt = result.calls.indexOf(`CHMOD|4755 ${sandbox}`)
  assert.ok(chownAt > provisionAt && chownAt < cecAt, 'root ownership must follow Electron install and precede CEC')
  assert.ok(chmodAt > chownAt && chmodAt < cecAt, 'sandbox mode must follow ownership and precede CEC')
  assert.ok(/ELECTRON\|mute=1\|nosync=1\|args=tests\/e2e\/box-cec-input-smoke\.cjs/.test(result.calls),
    'installed Box CEC smoke must run under Electron')
  const launchSmoke = fs.readFileSync(path.join(repository, 'tests/e2e/box-package-launch-smoke.cjs'), 'utf8')
  assert.match(launchSmoke, /executablePath:\s*executable,\s*args:\s*\[\]/, 'the fixture must launch packaged entries without arguments')
  assert.match(launchSmoke, /journey-network/, 'the fixture must assert real remote focus movement')
  assert.match(launchSmoke, /box-settings-remote-focus\.png/, 'the fixture must capture its remote-focus screenshot')
}

test('build stage packages Desktop and Box from one captured native directory', posixOnly, t => {
  const f = fixture(t)
  assertBuild(f, f.run('build'))
})

test('installed stage co-installs and qualifies both products and normal Box launch', posixOnly, t => {
  const f = fixture(t)
  assertInstalled(f, f.run('installed-test'))
})

test('installed stage strictly rejects duplicate Box installers before apt', posixOnly, t => {
  const f = fixture(t)
  fs.writeFileSync(path.join(f.root, 'dist/box/SingZ-Box-9.9.9-linux-amd64.deb'), 'duplicate\n')
  const result = f.run('installed-test')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /exactly one Desktop and one Box/)
  assert.doesNotMatch(result.calls, /^APT\|/m)
})

test('installed stage rejects a wrong-architecture Box artifact before apt', posixOnly, t => {
  const f = fixture(t)
  fs.renameSync(
    path.join(f.root, 'dist/box/SingZ-Box-0.0.0-linux-amd64.deb'),
    path.join(f.root, 'dist/box/SingZ-Box-0.0.0-linux-arm64.deb')
  )
  const result = f.run('installed-test')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /exactly one Desktop and one Box Linux amd64 installer/)
  assert.doesNotMatch(result.calls, /^APT\|/m)
})

test('co-install cannot mask a Box payload overwritten by different bytes', posixOnly, t => {
  const f = fixture(t)
  fs.writeFileSync(path.join(f.boxRoot, 'resources/app.asar'), 'overwritten\n')
  const result = f.run('installed-test')
  assert.notEqual(result.status, 0)
  assert.ok(result.calls.includes(`${f.boxRoot}/resources/app.asar`), result.calls)
  assert.doesNotMatch(result.calls, /tests\/e2e\/box-package-launch-smoke\.cjs/)
})

test('installed stage rejects missing Box audio resources and a non-executable launcher', posixOnly, t => {
  const missing = fixture(t)
  fs.rmSync(path.join(missing.boxRoot, 'resources/box-audio/cec-input.py'))
  const missingResult = missing.run('installed-test')
  assert.notEqual(missingResult.status, 0)
  assert.match(missingResult.stderr, /Missing installed Box resource: .*cec-input\.py/)
  assert.doesNotMatch(missingResult.calls, /tests\/e2e\/box-package-launch-smoke\.cjs/)

  const plain = fixture(t)
  fs.chmodSync(path.join(plain.boxRoot, 'resources/box-audio/singz-box-with-audio'), 0o644)
  const plainResult = plain.run('installed-test')
  assert.notEqual(plainResult.status, 0)
  assert.match(plainResult.stderr, /Box audio launcher is not executable/)
})

test('installed stage rejects a Box package without its python3 dependency', posixOnly, t => {
  for (const depends of ['libgtk-3-0, fonts-noto-cjk', 'libgtk-3-0, python3-minimal, fonts-noto-cjk']) {
    const f = fixture(t)
    const result = f.run('installed-test', { CI_TEST_BOX_DEPENDS: depends })
    assert.notEqual(result.status, 0, depends)
    assert.match(result.stderr, /Box package does not depend on python3/)
  }
})

test('installed stage rejects a Box asar embedding dist/ or resources/linux, and an unreadable asar', posixOnly, t => {
  for (const entry of ['/dist/SingZ-0.0.0-linux-amd64.deb', '/dist', '/resources/linux/cec-input.py']) {
    const f = fixture(t)
    const result = f.run('installed-test', { CI_TEST_ASAR_LIST: `/out/main/index.js\n${entry}\n` })
    assert.notEqual(result.status, 0, entry)
    assert.match(result.stderr, /embeds package output or duplicated Box resources/)
    assert.doesNotMatch(result.calls, /tests\/e2e\/box-package-launch-smoke\.cjs/)
  }
  const empty = fixture(t)
  const result = empty.run('installed-test', { CI_TEST_ASAR_LIST: '' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /listing is empty/)
})

function withoutStatement(text, start, endMarker) {
  const end = text.indexOf(endMarker, start)
  assert.ok(start >= 0 && end >= 0)
  return text.slice(0, start) + text.slice(end + endMarker.length)
}

test('shadow negative controls reject deleted Box dist, launch, audio-host, CEC and recovery steps', posixOnly, t => {
  const withoutDist = source.split('\n').filter(line => !line.includes('node scripts/dist.cjs --box --linux')).join('\n')
  assert.notEqual(withoutDist, source)
  const buildFixture = fixture(t, withoutDist)
  assert.throws(() => assertBuild(buildFixture, buildFixture.run('build')), /Desktop and Box must both use the canonical dist wrapper/)

  const withoutLaunch = withoutStatement(source,
    source.indexOf('  E2E_PACKAGED=/opt/singz-box/singz-box'),
    '2>&1 | tee "$report/box-package-launch-e2e.log"')
  const launchFixture = fixture(t, withoutLaunch)
  assert.throws(() => assertInstalled(launchFixture, launchFixture.run('installed-test')), /normal-launch smoke/)

  const withoutAudio = withoutStatement(source,
    source.indexOf('  SINGZ_BOX_AUDIO_HOST_EXECUTABLE='),
    '2>&1 | tee "$report/installed-box-audio-host-smoke.log"')
  const audioFixture = fixture(t, withoutAudio)
  assert.throws(() => assertInstalled(audioFixture, audioFixture.run('installed-test')), /audio-host smoke/)

  const cecStart = source.indexOf('  xvfb-run', source.indexOf('node tests/e2e/box-package-launch-smoke.cjs'))
  const withoutCec = withoutStatement(source, cecStart, '2>&1 | tee "$report/box-cec-input-smoke.log"')
  const cecFixture = fixture(t, withoutCec)
  assert.throws(() => assertInstalled(cecFixture, cecFixture.run('installed-test')), /CEC smoke/)

  const recoveryStart = source.indexOf('  E2E_PACKAGED=/opt/singz-box/singz-box',
    source.indexOf('tests/e2e/box-cec-input-smoke.cjs'))
  const withoutRecovery = withoutStatement(source, recoveryStart, '2>&1 | tee "$report/box-retained-recovery-e2e.log"')
  const recoveryFixture = fixture(t, withoutRecovery)
  assert.throws(() => assertInstalled(recoveryFixture, recoveryFixture.run('installed-test')), /retained recovery/)

  const withoutProvision = source.split('\n')
    .filter(line => !line.includes('env -u ELECTRON_SKIP_BINARY_DOWNLOAD node node_modules/electron/install.js')).join('\n')
  assert.notEqual(withoutProvision, source)
  const provisionFixture = fixture(t, withoutProvision)
  assert.throws(() => assertInstalled(provisionFixture, provisionFixture.run('installed-test')), /Electron sandbox provision/)
})

test('workflow uploads both package sets without inventing Box update metadata', () => {
  const workflow = fs.readFileSync(path.join(repository, '.github/workflows/linux.yml'), 'utf8')
  for (const entry of ['dist/*.deb', 'dist/SHA256SUMS', 'dist/box/*.deb', 'dist/box/*.sha256', 'dist/box/SHA256SUMS']) {
    assert.ok(workflow.includes(entry), entry)
  }
  assert.doesNotMatch(workflow, /dist\/box\/latest-linux/)
  assert.match(workflow, /SINGZ_CI_STAGE: installed-test/)
  assert.match(workflow, /SINGZ_E2E_PACKAGED: \/opt\/SingZ\/singz/)
})

function loadLaunchFixture(t, text = fs.readFileSync(launchSmokePath, 'utf8').replace(/\r\n/g, '\n')) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sz-box-launch-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'tmp'))
  const processEnv = {
    ...process.env,
    HOME: path.join(root, 'inherited-home'),
    XDG_CONFIG_HOME: path.join(root, 'inherited-config'),
    XDG_DATA_HOME: path.join(root, 'inherited-data'),
    XDG_CACHE_HOME: path.join(root, 'inherited-cache'),
    SINGZ_E2E_RESULTS: path.join(root, 'evidence')
  }
  const launches = []
  const page = {}
  const instrumented = text.replace(/\nrun\(\)\s*$/,
    '\nmodule.exports = { inheritedOverrides, launch, launchEnvironment, scratch }\n')
  assert.notEqual(instrumented, text, 'the fixture entry point must be replaced with bounded exports')
  const fixtureModule = { exports: {} }
  const fixtureRequire = id => {
    if (id === '../shared/watchdog.cjs') return { arm: () => ({}) }
    if (id === 'node:os') return { ...require(id), tmpdir: () => path.join(root, 'tmp') }
    if (id === 'playwright-core') {
      return {
        _electron: {
          launch: async options => {
            launches.push(options)
            return { firstWindow: async () => page }
          }
        }
      }
    }
    return require(id)
  }
  vm.runInNewContext(instrumented, {
    __dirname: path.dirname(launchSmokePath),
    __filename: launchSmokePath,
    module: fixtureModule,
    exports: fixtureModule.exports,
    process: { env: processEnv },
    require: fixtureRequire,
    console
  }, { filename: launchSmokePath })
  for (const key of fixtureModule.exports.inheritedOverrides) processEnv[key] = 'inherited'
  processEnv.SINGZ_E2E_HIDDEN = '1'
  processEnv.SINGZ_LANG = 'inherited'
  return { ...fixtureModule.exports, launches, page, processEnv }
}

async function assertLaunchEnvironment(f) {
  const page = await f.launch(process.execPath)
  assert.equal(page, f.page)
  assert.equal(f.launches.length, 1)
  const [options] = f.launches
  assert.equal(options.executablePath, process.execPath)
  assert.deepEqual(Array.from(options.args), [])
  const env = options.env
  assert.equal(env.SINGZ_E2E_HIDDEN, undefined,
    'SINGZ_E2E_HIDDEN must be absent from the visible Box package launch')
  assert.equal(Object.hasOwn(env, 'SINGZ_E2E_HIDDEN'), false)
  for (const key of f.inheritedOverrides) assert.equal(env[key], undefined, key)
  assert.equal(env.SINGZ_LANG, undefined)
  for (const [key, directory] of [
    ['HOME', 'home'],
    ['XDG_CONFIG_HOME', 'config'],
    ['XDG_DATA_HOME', 'data'],
    ['XDG_CACHE_HOME', 'cache']
  ]) {
    const expected = path.join(f.scratch, directory)
    assert.equal(env[key], expected, key)
    if (process.platform !== 'win32') assert.equal(fs.statSync(expected).mode & 0o777, 0o700, key)
  }
  assert.equal(env.SINGZ_MUTE, '1')
  assert.equal(env.SINGZ_NO_SYNC, '1')
  assert.equal(env.SINGZ_NO_SYSTEM_ENGINES, '1')
}

async function assertVisibilityGuard(text, visible) {
  const start = text.indexOf('    const window = await app.browserWindow(page)')
  const screenshotStatement =
    "    await page.screenshot({ path: path.join(evidence, 'box-settings-remote-focus.png') })"
  const end = text.indexOf(screenshotStatement, start)
  assert.ok(start >= 0 && end >= 0, 'the actual current-page visibility guard and screenshot must be present')
  const page = { screenshot: async () => { screenshotCount++ } }
  const browserWindow = { isVisible: () => { visibilityChecks++; return visible } }
  const app = {
    browserWindow: async value => {
      selectedPage = value
      return { evaluate: async callback => callback(browserWindow) }
    }
  }
  let selectedPage
  let visibilityChecks = 0
  let screenshotCount = 0
  let failure
  try {
    await vm.runInNewContext(`(async () => {\n${text.slice(start, end + screenshotStatement.length)}\n})()`, {
      app, page, assert, path, evidence: '/tmp/box-visibility-evidence'
    })
  } catch (error) {
    failure = error
  }
  assert.equal(selectedPage, page, 'the guard must resolve the BrowserWindow for the current page')
  assert.equal(visibilityChecks, 1, 'the guard must evaluate isVisible on that BrowserWindow')
  if (visible) {
    assert.ifError(failure)
    assert.equal(screenshotCount, 1)
  } else {
    assert.ok(failure instanceof assert.AssertionError)
    assert.equal(failure.actual, false)
    assert.equal(failure.expected, true)
    assert.equal(screenshotCount, 0, 'a hidden current window must fail before screenshot')
  }
}

test('Box launch executes with sanitized hidden mode, private roots and no arguments', async t => {
  await assertLaunchEnvironment(loadLaunchFixture(t))
})

test('Box launch negative control rejects in-memory restored forced HIDDEN', async t => {
  const source = fs.readFileSync(launchSmokePath, 'utf8').replace(/\r\n/g, '\n')
  const withoutHiddenOverride = source.replace(
    "  'E2E_PACKAGED', 'SINGZ_E2E_PACKAGED', 'SINGZ_E2E_HIDDEN'\n]",
    "  'E2E_PACKAGED', 'SINGZ_E2E_PACKAGED'\n]"
  )
  assert.notEqual(withoutHiddenOverride, source, 'old source must not sanitize inherited HIDDEN')
  const restoredHidden = withoutHiddenOverride.replace(
    "    SINGZ_NO_SYSTEM_ENGINES: '1'\n",
    "    SINGZ_NO_SYSTEM_ENGINES: '1',\n    SINGZ_E2E_HIDDEN: '1'\n"
  )
  assert.notEqual(restoredHidden, withoutHiddenOverride, 'old source must force HIDDEN')
  await assert.rejects(assertLaunchEnvironment(loadLaunchFixture(t, restoredHidden)), error => {
    assert.equal(error.code, 'ERR_ASSERTION')
    assert.equal(error.actual, '1')
    assert.equal(error.expected, undefined)
    assert.match(error.message, /SINGZ_E2E_HIDDEN must be absent/)
    console.log(`Negative control rejected restored forced HIDDEN: ${error.message}`)
    return true
  })
})

test('Box screenshot guard checks the current page BrowserWindow and rejects hidden windows', async () => {
  const text = fs.readFileSync(launchSmokePath, 'utf8').replace(/\r\n/g, '\n')
  await assertVisibilityGuard(text, true)
  await assertVisibilityGuard(text, false)
})

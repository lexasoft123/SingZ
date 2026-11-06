const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { test } = require('node:test')
const script = path.resolve(__dirname, '../../scripts/ci-install-apt.sh')
const unix = { skip: process.platform === 'win32' }

function fixture(t, settings = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'singz-ci-apt-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const commands = {
    'dpkg-query': 'for package in "$@"; do :; done\ncase " ${CI_TEST_INSTALLED:-} " in *" $package "*) printf "install ok installed";; *) exit 1;; esac',
    sudo: 'exec "$@"',
    timeout: 'printf "TIMEOUT %s\\n" "$*" >> "$CI_TEST_LOG"\nshift 2\nexec "$@"',
    'apt-get': 'printf "APT %s\\n" "$*" >> "$CI_TEST_LOG"\n' +
      'case " $* " in *" update "*) exit "${CI_TEST_UPDATE_EXIT:-0}";; esac\n' +
      'if [ -n "${CI_TEST_FAIL_ALWAYS:-}" ]; then exit 42; fi\n' +
      'if [ -n "${CI_TEST_FAIL_FIRST:-}" ] && [ ! -f "$CI_TEST_MARKER" ]; then : > "$CI_TEST_MARKER"; exit 124; fi',
  }
  for (const [name, body] of Object.entries(commands))
    fs.writeFileSync(path.join(dir, name), '#!/bin/sh\n' + body + '\n', { mode: 0o755 })
  const log = path.join(dir, 'calls.log')
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, CI_TEST_LOG: log,
    CI_TEST_MARKER: path.join(dir, 'first-install'), ...settings }
  const result = spawnSync('bash', [script, 'ffmpeg', 'libudev-dev'], { env, encoding: 'utf8', timeout: 5000 })
  return { ...result, calls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' }
}

test('installed CI dependencies never contact apt repositories', unix, t => {
  const r = fixture(t, { CI_TEST_INSTALLED: 'ffmpeg libudev-dev' })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.calls, '')
  assert.match(r.stdout, /already installed/)
})

test('only missing dependencies are installed, without an unnecessary index refresh', unix, t => {
  const r = fixture(t, { CI_TEST_INSTALLED: 'ffmpeg' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.calls, /install --yes --no-install-recommends libudev-dev/)
  assert.doesNotMatch(r.calls, /APT .*update|install .*ffmpeg/)
  assert.match(r.calls, /TIMEOUT --kill-after=5s 60s/)
})

test('a stalled installation gets one bounded index refresh and one bounded retry', unix, t => {
  const r = fixture(t, { CI_TEST_FAIL_FIRST: '1' })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.calls.match(/^APT .* install /gm).length, 2)
  assert.equal(r.calls.match(/^APT .* update$/gm).length, 1)
  assert.match(r.calls, /TIMEOUT --kill-after=5s 90s/)
  assert.match(r.calls, /TIMEOUT --kill-after=5s 120s/)
  for (const option of ['Acquire::Retries=2', 'Acquire::http::Timeout=15', 'Acquire::https::Timeout=15', 'DPkg::Lock::Timeout=30'])
    assert.ok(r.calls.includes(option), option)
})

test('repository and installation failures remain failures rather than a false green', unix, t => {
  const update = fixture(t, { CI_TEST_FAIL_FIRST: '1', CI_TEST_UPDATE_EXIT: '43' })
  assert.equal(update.status, 43)
  assert.equal(update.calls.match(/^APT .* install /gm).length, 1)
  const install = fixture(t, { CI_TEST_FAIL_ALWAYS: '1' })
  assert.equal(install.status, 42)
  assert.equal(install.calls.match(/^APT .* install /gm).length, 2)
})

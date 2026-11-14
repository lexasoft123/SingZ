import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { scratchProfileDir, scratchProfileEnv } = require('../shared/scratch-profile.cjs') as typeof import('../shared/scratch-profile.cjs')

/* The desktop product's userData is always <appData>/SingZ, so a driver that
 * launches the app without SINGZ_USERDATA_DIR runs in the singer's real
 * profile (settings, Drive tokens, dirty ledger, voice takes) and shares its
 * session directory with a running app. Checked at the source, like the
 * watchdog: a driver launching the app must name SINGZ_USERDATA_DIR or use
 * tests/shared/scratch-profile.cjs. */

/** Does this source launch the app (Playwright _electron.launch, or spawning
 *  Electron on out/main/index.js)? */
export function launchesApp(source: string): boolean {
  return /_electron\.launch\(/.test(source) || /out\/main\/index\.js/.test(source) && /\bspawn(Sync)?\(/.test(source)
}

/** Does it isolate the profile? */
export function isolatesProfile(source: string): boolean {
  return /SINGZ_USERDATA_DIR/.test(source) || /require\('[^']*scratch-profile\.cjs'\)/.test(source)
}

/** Launchers that deliberately do not isolate, with the reason. */
const allowlist: Record<string, string> = {
  'tests/e2e/box-package-launch-smoke.cjs':
    'strips SINGZ_USERDATA_DIR on purpose to prove the default location, but under a scratch HOME and XDG dirs, so it never touches the real profile'
}

describe('every E2E driver that launches the app isolates its profile', () => {
  const drivers = (readdirSync('tests/e2e', { recursive: true }) as string[])
    .filter(name => name.endsWith('.cjs'))
    .map(name => `tests/e2e/${name.split(sep).join('/')}`)
  const launchers = drivers.filter(path => launchesApp(readFileSync(join(process.cwd(), path), 'utf8')))

  it('finds the launching drivers', () => {
    expect(launchers.length).toBeGreaterThan(30)
    expect(launchers).toContain('tests/e2e/mac/count-in-e2e.cjs')
  })

  it('keeps the allowlist honest', () => {
    for (const path of Object.keys(allowlist)) expect(launchers).toContain(path)
  })

  it.each(launchers)('%s', path => {
    if (allowlist[path]) return
    expect(isolatesProfile(readFileSync(join(process.cwd(), path), 'utf8'))).toBe(true)
  })

  it('rejects a launcher that names no profile (negative control)', () => {
    const bad = "const app = await _electron.launch({ args: [APP], env: { ...process.env, SINGZ_MUTE: '1' } })"
    expect(launchesApp(bad)).toBe(true)
    expect(isolatesProfile(bad)).toBe(false)
    const good = bad.replace("SINGZ_MUTE: '1'", "...scratchProfileEnv()") + "\nrequire('../../shared/scratch-profile.cjs')"
    expect(isolatesProfile(good)).toBe(true)
  })
})

describe('scratch profile helper', () => {
  it('makes a fresh directory per call and seeds settings on request', () => {
    const a = scratchProfileEnv({ label: 'a' }).SINGZ_USERDATA_DIR
    const b = scratchProfileEnv({ label: 'b', projectsRoot: tmpdir() }).SINGZ_USERDATA_DIR
    expect(a).not.toBe(b)
    expect(existsSync(join(a, 'settings.json'))).toBe(false)
    expect(JSON.parse(readFileSync(join(b, 'settings.json'), 'utf8'))).toEqual({ projectsRoot: tmpdir() })
    expect(existsSync(scratchProfileDir())).toBe(true)
  })

  it('uses a given directory as is', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scratch-profile-test-'))
    expect(scratchProfileEnv({ dir }).SINGZ_USERDATA_DIR).toBe(dir)
  })
})

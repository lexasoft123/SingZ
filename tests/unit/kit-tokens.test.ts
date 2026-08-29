/*
 * One table, three ends — the same shape as tests/shared/currency-cases.json.
 *
 * The kit owns the stem colours; both apps import them straight from
 * `@singz/ui`, each resolved from its own lockfile. There is no vendored
 * copy left to rot, but the two lockfiles can still end up pinned to
 * different tags — this is what notices when they do. It is why vocals is
 * not #ff5c65 on the desktop and #ff5d66 on the phone any more.
 *
 * The drift check reads the two LOCKFILES; it does not import the phone's
 * installed copy. Both lockfiles resolve `@singz/ui` to the same GitHub
 * tarball, so equal pins mean the two node_modules trees hold the same
 * artifact — which is what lets the value assertions speak for the phone
 * even where only the desktop's tree exists. (See the note on the pin test
 * for which copies those assertions actually read, and why that differs
 * between CI and a dev machine.)
 *
 * Importing `../../mobile/node_modules/@singz/ui/…` directly, as this suite
 * briefly did, made it unrunnable anywhere the phone's dependencies are not
 * installed. `.github/workflows/checks.yml` runs `npm ci` at the root only,
 * so it failed outright in CI ("Cannot find module …"), and it fails the
 * same way in a `--desktop-only` worktree. A test that passes only on a
 * machine that happens to have run one extra install is not a gate.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { STEM_META, CUSTOM_COLORS } from '@singz/ui/stems'
import { tokens } from '@singz/ui/tokens'
import { KIT, STEM_COLORS, CUSTOM_COLORS as PHONE_CUSTOM } from '../../mobile/src/ui/tokens'

type PackageManifest = {
  dependencies?: Record<string, unknown>
  devDependencies?: Record<string, unknown>
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), 'utf8')) as T
}

function dependencySpec(manifest: PackageManifest, label: string): string {
  const spec = manifest.dependencies?.['@singz/ui'] ?? manifest.devDependencies?.['@singz/ui']
  if (typeof spec !== 'string' || spec.length === 0) {
    throw new Error(`${label} is missing an @singz/ui dependency spec`)
  }
  return spec
}

function kitPin(lockfile: string): {
  version?: string
  resolved?: string
  integrity?: string
} {
  const path = fileURLToPath(new URL(lockfile, import.meta.url))
  const lock = JSON.parse(readFileSync(path, 'utf8'))
  return lock.packages?.['node_modules/@singz/ui'] ?? {}
}

describe('kit tokens reach the phone unchanged', () => {
  it('every stem colour matches', () => {
    for (const [stem, meta] of Object.entries(STEM_META)) {
      expect(STEM_COLORS[stem], `stem "${stem}"`).toBe(meta.color)
    }
  })

  it('the phone names no stem the kit does not', () => {
    expect(Object.keys(STEM_COLORS).sort()).toEqual(Object.keys(STEM_META).sort())
  })

  it('custom lane colours match, in order', () => {
    expect(PHONE_CUSTOM).toEqual(CUSTOM_COLORS)
  })

  it('the chrome palette matches', () => {
    expect(KIT.bg).toBe(tokens.bg)
    expect(KIT.text).toBe(tokens.text)
    expect(KIT.dim).toBe(tokens.dim)
    expect(KIT.faint).toBe(tokens.faint)
    expect(KIT.accent).toBe(tokens.accent)
    expect(KIT.accentInk).toBe(tokens['accent-ink'])
    expect(KIT.danger).toBe(tokens.danger)
    expect(KIT.line).toBe(tokens.line)
    expect(KIT.surfaceRaised).toBe(tokens['surface-raised'])
  })

  it('both apps request the exact same package', () => {
    const rootManifest = readJson<PackageManifest>('../../package.json')
    const mobileManifest = readJson<PackageManifest>('../../mobile/package.json')

    expect(dependencySpec(rootManifest, 'package.json')).toBe(
      dependencySpec(mobileManifest, 'mobile/package.json')
    )
  })

  it('the accent is the desktop one — the phone had its own', () => {
    // Guards the specific drift this work existed to end.
    expect(KIT.accent).toBe('#ffa028')
    expect(STEM_COLORS.vocals).toBe('#ff5c65')
  })

  it('native glass materials match', () => {
    expect(KIT.glassFill).toBe(tokens['glass-fill'])
    expect(KIT.glassLine).toBe(tokens['glass-line'])
    expect(KIT.glassRim).toBe(tokens['glass-rim'])
    expect(KIT.controlFill).toBe(tokens['control-fill'])
    expect(KIT.controlLine).toBe(tokens['control-line'])
    expect(KIT.controlRim).toBe(tokens['control-rim'])
    expect(KIT.footerFill).toBe(tokens['footer-fill'])
    expect(KIT.shadow).toBe(tokens.shadow)
  })

  // How many copies of the kit the assertions above actually read depends on
  // where you run them, and it is worth knowing which:
  //
  //   - `mobile/src/ui/tokens.ts` re-exports `@singz/ui`, and Vite resolves
  //     from the importer outwards, so on a full dev machine `KIT` comes
  //     from mobile/node_modules while `tokens` comes from the root's. The
  //     comparisons are then a genuine cross-tree check.
  //   - In CI, and in a `--desktop-only` worktree, there is no phone tree,
  //     so both sides resolve to the root's copy and the value assertions
  //     compare it with itself.
  //
  // Which is why THIS test carries the weight in CI: it is the only part
  // that can see the phone's installed copy when the phone's tree is absent.
  // The value assertions still read the phone's SOURCE module either way, so
  // they would catch someone hardcoding a colour in mobile/src/ui/tokens.ts
  // instead of re-exporting; the two halves compose — the values prove the
  // phone's source adds no overrides, the pins prove its tree holds the same
  // bytes. (The
  // import this replaced had the failure mode the other way round — `KIT`
  // and `nativeTokens` both came from mobile/node_modules, so it was a
  // self-comparison exactly where it appeared to be doing the most work.)
  //
  // All three fields matter, and each closes a different hole: `version` is
  // the obvious drift; `resolved` because these are GitHub tarballs, where
  // two tags can carry one version string; `integrity` because the converse
  // is worse — a force-moved tag leaves both lockfiles naming v1.3.0 at one
  // URL while `npm ci` verifies each tree against its own hash and installs
  // different bytes. A benign red is possible here if GitHub ever changes
  // archive compression, and it is still worth having: it means the two
  // trees were resolved at different times against a mutable URL, which is
  // precisely what this suite exists to notice.
  it('both lockfiles pin the same kit', () => {
    const desktop = kitPin('../../package-lock.json')
    const phone = kitPin('../../mobile/package-lock.json')

    for (const [side, pin] of [
      ['desktop', desktop],
      ['phone', phone],
    ] as const) {
      expect(pin.version, `no @singz/ui version in the ${side} lockfile`).toBeTruthy()
      expect(pin.resolved, `no @singz/ui resolved URL in the ${side} lockfile`).toBeTruthy()
      expect(pin.integrity, `no @singz/ui integrity in the ${side} lockfile`).toBeTruthy()
    }

    expect(phone.version, 'phone pins a different @singz/ui version').toBe(desktop.version)
    expect(phone.resolved, 'phone pins a different @singz/ui tarball').toBe(desktop.resolved)
    expect(phone.integrity, 'phone pins different @singz/ui BYTES').toBe(desktop.integrity)
  })
})

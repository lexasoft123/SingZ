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

/*
 * The app icon is drawn, not imported, so it is the one place the stem
 * colours are written down again — a canvas in build/icon/forge.html, cut
 * into .icns/.ico by `npm run icons`. Nothing on the build path reads it,
 * which is exactly why it can rot: the drawing it replaced had the kit's
 * AMBER (#ffa028) where Guitar is #f98424, and no test could see it.
 *
 * This does NOT claim the committed .icns is current — only a re-run of
 * `npm run icons` makes that true. It claims the forge and the kit still
 * agree about what colour a lane is, which is the half a machine can check.
 * If a lane colour is meant to change, change it in the kit and re-cut here.
 */
describe('the app icon speaks the kit\'s colours', () => {
  const forge = readFileSync(fileURLToPath(new URL('../../build/icon/forge.html', import.meta.url)), 'utf8')

  it('the lanes are the stem tokens, in the drawn order', () => {
    const block = forge.match(/const LANES = \[([\s\S]*?)\n\]/)
    expect(block, 'no LANES array in the forge — did it get restructured?').toBeTruthy()
    const drawn = [...block![1].matchAll(/color: '(#[0-9a-f]{6})'/g)].map((m) => m[1])
    expect(drawn).toEqual([
      STEM_META.vocals.color,
      STEM_META.drums.color,
      STEM_META.guitar.color,
      STEM_META.bass.color,
      STEM_META.other.color,
    ])
  })

  // The recipe offers two ways in: copy glass.js into the app, or import the
  // packaged one. A copy is a second definition of the tile, the light and
  // the glass, and it would drift from the kit the moment either moved — so
  // the forge takes the tarball's own file and this says so out loud.
  it('draws with the kit itself, not a copy of it', () => {
    expect(forge).toMatch(/import \{[^}]*\} from '[^']*node_modules\/@singz\/ui\/recipes\/app-icon\/glass\.js'/)
  })

  /*
   * The phones and the desktop are cut from the same forge, but two of the
   * outputs may not carry an ALPHA CHANNEL at all — an App Store icon with
   * one is rejected, and the Play listing icon is specified the same way
   * (docs/PLAY-LISTING.md). A canvas PNG is always RGBA, so cut-mobile.cjs
   * re-encodes those two as colour type 2; this is what notices if a file
   * ever arrives from somewhere else. It reads the IHDR directly rather than
   * decoding: byte 25 of a PNG is the colour type, and 2 is truecolour with
   * no alpha.
   */
  it.each([
    ['iOS AppIcon', 'mobile/ios/SingZPlayer/Images.xcassets/AppIcon.appiconset/AppIcon.png'],
    ['Play listing icon', 'docs/play-assets/icon-512.png'],
  ])('%s carries no alpha channel', (_name, rel) => {
    const png = readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)))
    expect(png.subarray(1, 4).toString('ascii'), 'not a PNG').toBe('PNG')
    expect(png[25], 'PNG colour type (2 = RGB, 6 = RGBA)').toBe(2)
  })
})

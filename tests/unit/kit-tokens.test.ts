/*
 * One table, three ends — the same shape as tests/shared/currency-cases.json.
 *
 * The kit owns the stem colours; both apps import them straight from
 * `@singz/ui`, each resolved from its own lockfile. There is no vendored
 * copy left to rot, but the two lockfiles can still end up pinned to
 * different tags — this is what notices when they do. It is why vocals is
 * not #ff5c65 on the desktop and #ff5d66 on the phone any more.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { STEM_META, CUSTOM_COLORS } from '@singz/ui/stems'
import { tokens } from '@singz/ui/tokens'
import { KIT, STEM_COLORS, CUSTOM_COLORS as PHONE_CUSTOM } from '../../mobile/src/ui/tokens'

type PackageManifest = {
  dependencies?: Record<string, unknown>
  devDependencies?: Record<string, unknown>
}

type PackageLock = {
  packages?: Record<string, Record<string, unknown>>
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

function lockedKitMetadata(lock: PackageLock, label: string) {
  const entry = lock.packages?.['node_modules/@singz/ui']
  if (!entry) {
    throw new Error(`${label} is missing packages["node_modules/@singz/ui"]`)
  }

  const metadata = {} as { version: string; resolved: string; integrity: string }
  for (const field of ['version', 'resolved', 'integrity'] as const) {
    const value = entry[field]
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`${label} @singz/ui entry is missing ${field}`)
    }
    metadata[field] = value
  }
  return metadata
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

  it('both lockfiles pin the exact same package artifact', () => {
    const rootLock = readJson<PackageLock>('../../package-lock.json')
    const mobileLock = readJson<PackageLock>('../../mobile/package-lock.json')

    expect(lockedKitMetadata(rootLock, 'package-lock.json')).toEqual(
      lockedKitMetadata(mobileLock, 'mobile/package-lock.json')
    )
  })

  it('the accent is the desktop one — the phone had its own', () => {
    // Guards the specific drift this work existed to end.
    expect(KIT.accent).toBe('#ffa028')
    expect(STEM_COLORS.vocals).toBe('#ff5c65')
  })

  it('native glass materials match the installed package', () => {
    expect(KIT.glassFill).toBe(tokens['glass-fill'])
    expect(KIT.glassLine).toBe(tokens['glass-line'])
    expect(KIT.glassRim).toBe(tokens['glass-rim'])
    expect(KIT.controlFill).toBe(tokens['control-fill'])
    expect(KIT.controlLine).toBe(tokens['control-line'])
    expect(KIT.controlRim).toBe(tokens['control-rim'])
    expect(KIT.footerFill).toBe(tokens['footer-fill'])
    expect(KIT.shadow).toBe(tokens.shadow)
  })
})

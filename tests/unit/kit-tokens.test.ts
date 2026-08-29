/*
 * One table, three ends — the same shape as tests/shared/currency-cases.json.
 *
 * The kit owns the stem colours; both apps import them straight from
 * `@singz/ui`, each resolved from its own lockfile. There is no vendored
 * copy left to rot, but the two lockfiles can still end up pinned to
 * different tags — this is what notices when they do. It is why vocals is
 * not #ff5c65 on the desktop and #ff5d66 on the phone any more.
 */
import { describe, expect, it } from 'vitest'
import { STEM_META, CUSTOM_COLORS } from '@singz/ui/stems'
import { tokens } from '@singz/ui/tokens'
import { KIT, STEM_COLORS, CUSTOM_COLORS as PHONE_CUSTOM } from '../../mobile/src/ui/tokens'
import { tokens as nativeTokens } from '../../mobile/node_modules/@singz/ui/dist/tokens/tokens.js'

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

  it('native glass materials match between the two lockfiles', () => {
    expect(KIT.glassFill).toBe(nativeTokens['glass-fill'])
    expect(KIT.glassLine).toBe(nativeTokens['glass-line'])
    expect(KIT.glassRim).toBe(nativeTokens['glass-rim'])
    expect(KIT.controlFill).toBe(nativeTokens['control-fill'])
    expect(KIT.controlLine).toBe(nativeTokens['control-line'])
    expect(KIT.controlRim).toBe(nativeTokens['control-rim'])
    expect(KIT.footerFill).toBe(nativeTokens['footer-fill'])
    expect(KIT.shadow).toBe(nativeTokens.shadow)
  })
})

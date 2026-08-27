/*
 * GENERATED FROM @singz/ui — do not hand-edit.
 *
 * A vendored copy, not a dependency, on purpose: mobile has its own lockfile
 * and Metro does not honour the package "exports" field by default, so
 * adding a React-DOM package to the phone's dependency graph to read a
 * colour table would be a resolution failure waiting to happen.
 *
 * Instead the kit is the source of record and tests/unit/kit-tokens.test.ts
 * fails if this file drifts from it — the same shape as
 * tests/shared/currency-cases.json, one table read by three runners.
 *
 * Regenerate native kit artifacts: npm run sync:kit-native
 */

import { CUSTOM_COLORS as KIT_CUSTOM_COLORS, STEM_META } from './uikit/tokens/stems.js'
import { tokens } from './uikit/tokens/tokens.js'

/** Chrome palette. Values resolve directly from the vendored kit artifact. */
export const KIT = {
  bg: tokens.bg,
  panel: tokens.panel,
  panelDeep: tokens['panel-deep'],
  glassFill: tokens['glass-fill'],
  glassLine: tokens['glass-line'],
  glassRim: tokens['glass-rim'],
  controlFill: tokens['control-fill'],
  controlLine: tokens['control-line'],
  controlRim: tokens['control-rim'],
  footerFill: tokens['footer-fill'],
  shadow: tokens.shadow,
  line: tokens.line,
  lineStrong: tokens['line-strong'],
  text: tokens.text,
  dim: tokens.dim,
  faint: tokens.faint,
  accent: tokens.accent,
  accentDeep: tokens['accent-deep'],
  accentSoft: tokens['accent-soft'],
  accentInk: tokens['accent-ink'],
  surfaceRaised: tokens['surface-raised'],
  danger: tokens.danger,
  success: tokens.success
} as const

/** Per-stem hues. The desktop draws the same project in these. */
export const STEM_COLORS: Record<string, string> = Object.fromEntries(
  Object.entries(STEM_META).map(([id, meta]) => [id, meta.color])
)

export const CUSTOM_COLORS: string[] = [...KIT_CUSTOM_COLORS]

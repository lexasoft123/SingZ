/*
 * Mobile has its own lockfile — a separate dependency graph from the
 * desktop app — but both now resolve the same `@singz/ui` package from its
 * own `package.json` "exports", pinned to the same GitHub tag. There is no
 * vendored copy to drift: tests/unit/kit-tokens.test.ts still checks that
 * the two lockfiles agree on which tag that is.
 */

import { CUSTOM_COLORS as KIT_CUSTOM_COLORS, STEM_META } from '@singz/ui/stems'
import { tokens } from '@singz/ui/tokens'

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

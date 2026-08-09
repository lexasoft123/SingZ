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
 * Regenerate: node scripts/sync-kit-tokens.mjs
 */

/** Chrome palette. Values are the desktop's — see the kit's tokens.ts. */
export const KIT = {
  bg: '#12100d',
  panel: '#1b1814',
  panelDeep: '#0f0d0a',
  line: 'rgba(255, 240, 214, 0.08)',
  lineStrong: 'rgba(255, 240, 214, 0.2)',
  text: '#f4efe6',
  dim: '#9b917e',
  faint: '#6b6355',
  accent: '#ffa028',
  accentDeep: '#ff8a1f',
  accentSoft: 'rgba(255, 160, 40, 0.13)',
  accentInk: '#241705',
  surfaceRaised: '#1e1a15',
  danger: '#ff7a5c',
  success: '#58d68a'
} as const

/** Per-stem hues. The desktop draws the same project in these. */
export const STEM_COLORS: Record<string, string> = {
  original: '#bfb49d',
  vocals: '#ff5c65',
  drums: '#ffc53d',
  bass: '#527dff',
  guitar: '#f98424',
  piano: '#da81da',
  other: '#27e7bb'
}

export const CUSTOM_COLORS: string[] = [
  '#c7e06a',
  '#ff9ad5',
  '#6fd8ff',
  '#e8dcc0',
  '#a98cff'
]

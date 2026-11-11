import type { BoxReadiness } from './project'

/**
 * The five reasons a song cannot be sung yet. Each has its own glyph, short
 * visible word and colour class, so the meaning is on screen (the old single
 * "!" carried it only in an aria-label).
 */
export type CatalogStateKind = 'downloading' | 'download' | 'lyrics' | 'prepare' | 'repair'

export interface CatalogStateInput {
  downloading: boolean
  /** Referenced by a saved queue or Drive but in neither catalog. */
  unavailable: boolean
  /** A local copy exists. */
  local: boolean
  localHasStems: boolean
  /** Undefined until the project has been inspected. */
  readiness: BoxReadiness | undefined
}

export function catalogState(input: CatalogStateInput): CatalogStateKind | null {
  if (input.downloading) return 'downloading'
  if (input.unavailable) return 'repair'
  if (!input.local) return 'download'
  const { readiness } = input
  if (readiness === 'needs-lyrics') return 'lyrics'
  if (readiness === 'damaged' || readiness === 'unsupported' || readiness === 'error') return 'repair'
  if (readiness === 'unprepared' || (readiness === undefined && !input.localHasStems)) return 'prepare'
  return null
}

export const STATE_GLYPH: Record<CatalogStateKind, string> = {
  downloading: '↻',
  download: '↓',
  lyrics: '♪',
  prepare: '◐',
  repair: '!'
}

/** i18n keys: the long sentence (aria/tooltip-free label) and the short visible word. */
export const STATE_LABEL_KEY = {
  downloading: 'box.state.downloading',
  download: 'box.state.downloadRequired',
  lyrics: 'box.state.lyricsRequired',
  prepare: 'box.state.preparation',
  repair: 'box.state.unavailable'
} as const

export const STATE_SHORT_KEY = {
  downloading: 'box.state.short.downloading',
  download: 'box.state.short.download',
  lyrics: 'box.state.short.lyrics',
  prepare: 'box.state.short.prepare',
  repair: 'box.state.short.repair'
} as const

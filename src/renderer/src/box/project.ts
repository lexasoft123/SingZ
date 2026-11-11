import type {
  CachedLyricsResult,
  KeyInfo,
  ProjectInfo,
  ProjectListItem,
  ProjectSettings,
  RegisterResult,
  SingzApi
} from '../../../shared/types'
import { analysisIsStale, KEY_DETECT_VERSION, sanitizeKeyInfo } from '../audio/analysis-contract'
import { decodeMelody, PITCH_DETECT_VERSION } from '../audio/melody'
import { toNoteSegments } from '../audio/notes'
import { parseSongName } from './song-identity'

export type BoxReadiness = 'ready' | 'unprepared' | 'needs-lyrics' | 'damaged' | 'unsupported' | 'error'

export interface BoxProjectMetadata {
  /** Parsed from the song name (see song-identity.ts); null when it has no "Artist - Title" form. */
  artist: string | null
  title: string
  key: KeyInfo | null
  bpm: number | null
  range: [number, number] | null
  duration: number | null
}

export interface BoxProjectInspection {
  readiness: BoxReadiness
  project: ProjectInfo | null
  message: string | null
}

export interface BoxInspectionResult {
  inspection: BoxProjectInspection
  registration: RegisterResult
  lyrics: CachedLyricsResult | null
}

export function inspectRegistration(result: RegisterResult): BoxProjectInspection {
  if (!result.ok) return { readiness: 'error', project: null, message: result.error }
  if (!result.project) {
    return { readiness: 'unsupported', project: null, message: 'The project metadata could not be read.' }
  }
  if (result.project.damaged?.length) {
    return {
      readiness: 'damaged',
      project: result.project,
      message: result.project.damaged.join(', ')
    }
  }
  if (!result.project.stems || Object.keys(result.project.stems).length === 0) {
    return { readiness: 'unprepared', project: result.project, message: null }
  }
  return { readiness: 'ready', project: result.project, message: null }
}

export function inspectCachedLyrics(result: CachedLyricsResult, project: ProjectInfo): BoxProjectInspection {
  if (!result.ok) return { readiness: 'error', project, message: result.error }
  if (!result.cached || result.lines.length === 0) return { readiness: 'needs-lyrics', project, message: null }
  return { readiness: 'ready', project, message: null }
}

export async function inspectBoxProject(api: SingzApi, item: ProjectListItem): Promise<BoxInspectionResult> {
  const registration = await api.registerSource(item.songPath)
  const initial = inspectRegistration(registration)
  if (initial.readiness !== 'ready' || !registration.ok || !registration.project) {
    return { inspection: initial, registration, lyrics: null }
  }
  const lyrics = await api.getCachedLyrics(registration.path)
  return {
    inspection: inspectCachedLyrics(lyrics, registration.project),
    registration,
    lyrics
  }
}

export function projectMetadata(project: ProjectInfo, duration: number | null = null): BoxProjectMetadata {
  const storedKey = sanitizeKeyInfo(project.settings.key)
  const key = storedKey && !analysisIsStale(storedKey.detVersion, KEY_DETECT_VERSION) ? storedKey : null
  const beat = project.settings.beat
  const bpm = typeof beat?.bpm === 'number' && Number.isFinite(beat.bpm) && beat.bpm >= 30 && beat.bpm <= 300
    ? beat.bpm
    : null
  const melody = decodeMelody(project.settings.melody)
  let range: [number, number] | null = null
  if (melody && !analysisIsStale(melody.info.detVersion, PITCH_DETECT_VERSION)) {
    const notes = toNoteSegments(melody.f0, melody.info.hopSec).map(note => note.midi).sort((a, b) => a - b)
    if (notes.length > 0) {
      range = [
        notes[Math.floor(notes.length * 0.05)],
        notes[Math.min(notes.length - 1, Math.floor(notes.length * 0.95))]
      ]
    }
  }
  const identity = parseSongName(project.name)
  // An engine-measured length wins; otherwise the header read the main process
  // attached to the project, so the catalog knows it before the song is opened.
  const known = duration ?? project.durationSec ?? null
  return {
    artist: identity.artist,
    title: identity.title,
    key,
    bpm,
    range,
    duration: known !== null && Number.isFinite(known) && known > 0 ? known : null
  }
}

export function settingsWithTracks(
  settings: ProjectSettings,
  tracks: { id: string; muted: boolean; solo: boolean; volume: number }[],
  masterVolume: number,
  transpose: number,
  tempo: number
): ProjectSettings {
  return {
    ...settings,
    tracks: Object.fromEntries(tracks.map(track => [track.id, {
      muted: track.muted,
      solo: track.solo,
      volume: track.volume
    }])),
    masterVolume,
    transpose,
    tempo
  }
}

export function sameProject(a: ProjectListItem, b: ProjectListItem): boolean {
  return a.dir === b.dir
}

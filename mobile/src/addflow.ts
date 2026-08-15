import { decodeAudioData } from 'react-native-audio-api'
import {
  fixTagEncoding,
  lookupLyrics,
  metaFromFilename,
  realArtist,
  searchCandidates,
  lyricsById,
  type LookupOutcome,
  type LyricsCandidate,
  type TrackMeta
} from './lyrics/lrclib'
import { releaseStems } from './projects'
import { createProject, readMediaTags, type CreatedProject } from './writer'
import type { LyricLine } from './model'
import { log } from './log'

/**
 * The add-a-song pipeline (Phase 1, docs/PHONE-STANDALONE.md), UI-free: the
 * AddSongSheet walks these steps with cards between them, and the __test
 * driver chains them headlessly — one logic, so what the tests exercise is
 * what the singer runs. No split, no beat, no melody here: an added song
 * plays its original as one lane; the heavy lifting arrives in Phase 2+.
 */

export interface SongFacts {
  durationSec: number
  title: string
  artist?: string
  altTitle?: string
}

/**
 * Decode once for the truth about the file: its real duration (LRCLIB
 * matching needs it) and, implicitly, that this phone can play it at all —
 * an undecodable pick must fail HERE, before a project folder exists.
 * The decoded PCM is released on the spot (patch 4); only the number leaves.
 */
export async function readSongFacts(
  srcPath: string,
  fileName: string,
  sampleRate: number
): Promise<SongFacts> {
  // bare paths are APK asset names in Android release builds — always file://
  // The decode is raced against a deadline: a file the decoder wedges on
  // (first seen with an iCloud-picked song on a real phone) must become an
  // honest error, never an eternal spinner. If the decode lands after the
  // deadline anyway, its buffer is released on arrival — the loser of the
  // race must not pin a song's worth of PCM.
  const decodePromise = decodeAudioData(`file://${srcPath}`, sampleRate)
  let deadline: ReturnType<typeof setTimeout> | undefined
  const buffer = await Promise.race([
    // a decode that wins must also disarm the deadline, or the late timer
    // would release the same buffer a second time
    decodePromise.finally(() => clearTimeout(deadline)),
    new Promise<never>((_, rejectLate) => {
      deadline = setTimeout(() => {
        decodePromise.then((b) => releaseStems([{ buffer: b }])).catch(() => {})
        rejectLate(new Error('it did not open within 90 seconds'))
      }, 90_000)
    })
  ])
  const durationSec = buffer.duration
  releaseStems([{ buffer }])

  const tags = await readMediaTags(srcPath).catch(() => ({}) as Record<string, never>)
  const fromName = metaFromFilename(fileName)
  const tagTitle = fixTagEncoding(tags.title)
  const tagArtist = realArtist(fixTagEncoding(tags.artist))
  return {
    durationSec,
    title: tagTitle && tagTitle.trim() ? tagTitle.trim() : fromName.title,
    artist: tagArtist ?? fromName.artist,
    altTitle: fromName.altTitle
  }
}

export const findLyrics = (meta: TrackMeta): Promise<LookupOutcome> => lookupLyrics(meta)

export const lyricsCandidates = (
  query: { artist?: string; title?: string; free?: string },
  durationSec: number
): Promise<LyricsCandidate[]> => searchCandidates(query, durationSec)

export const lyricsForCandidate = (
  id: number,
  durationSec: number
): Promise<{ lines: LyricLine[]; credit: string } | null> =>
  lyricsById(id, durationSec) as Promise<{ lines: LyricLine[]; credit: string } | null>

export interface AddSongInput {
  srcPath: string
  fileName: string
  title: string
  durationSec: number
  lyrics?: { lines: LyricLine[]; credit?: string } | null
}

export const addSong = (input: AddSongInput): Promise<CreatedProject> =>
  createProject({
    srcPath: input.srcPath,
    fileName: input.fileName,
    name: input.title,
    durationSec: input.durationSec,
    lyrics: input.lyrics
  })

/**
 * The headless whole-flow driver (__test.addSongFrom): pick skipped (the
 * caller pushed a file into the app's own storage), lyrics outcome
 * auto-accepted — a 'down' adds without lyrics, exactly like the sheet's
 * "Add without lyrics" path.
 */
export async function addSongHeadless(
  srcPath: string,
  fileName: string,
  sampleRate: number
): Promise<{ dir: string; lyrics: boolean; outcome: string }> {
  // Step labels ride every failure: on a release phone the log line is the
  // only evidence of WHERE an add died.
  const step = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
    try {
      return await run()
    } catch (e) {
      const msg = `add-song ${name}: ${String(e instanceof Error ? (e.stack ?? e.message) : e)}`
      log('song', msg, 'error')
      throw new Error(msg)
    }
  }
  const facts = await step('read', () => readSongFacts(srcPath, fileName, sampleRate))
  const outcome = await step('lyrics', () =>
    findLyrics({
      title: facts.title,
      artist: facts.artist,
      altTitle: facts.altTitle,
      durationSec: facts.durationSec
    })
  )
  const lyrics = typeof outcome === 'object' ? outcome.hit : null
  const { dir } = await step('write', () =>
    addSong({
      srcPath,
      fileName,
      title: facts.title,
      durationSec: facts.durationSec,
      lyrics
    })
  )
  log(
    'song',
    `add-song flow done: ${dir} · lyrics ${lyrics ? 'found' : String(outcome)} · ${facts.durationSec.toFixed(0)}s`
  )
  return { dir, lyrics: Boolean(lyrics), outcome: typeof outcome === 'object' ? 'hit' : outcome }
}

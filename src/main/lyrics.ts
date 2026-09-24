import { type ChildProcess } from 'node:child_process'
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { AlignCheck, LyricLine, LyricWord, LyricsProgress, LyricsResult, LyricsSource } from '../shared/types'
import {
  alignToTranscription,
  ctcOutcome,
  globalAnchors,
  guessLanguage,
  retime,
  sanitizeHyp,
  transcriptionUsable,
  type AlignOutcome
} from './align'
import { preciseCapable, runMmsAlign } from './align-mms'
import { linesFromChunks, qwenLanguageName, QwenServer, resolveQwenServer, type QwenChunkText } from './qwen-asr'
import { alignWordsInChunks, assignWordsToChunks, resolveQwenAligner } from './qwen-align'
import { decodeVocalsMono16k, levelEnvelope, planChunks } from './vocal-chunks'
import {
  fixTagEncoding,
  lookupLyrics,
  lyricsById,
  metaFromFilename,
  realArtist,
  type TrackMeta
} from './lrclib'
import { stemsRoot } from './media'
import { log } from './log'
import { markFileDirty } from './sync-dirty'
import { t } from '../shared/i18n'
import {
  downloadFile,
  downloadQwen,
  mmsModelMb,
  mmsModelPath,
  mmsModelUrl,
  qwenInstalled,
  qwenMissingMb
} from './models'
import { projectLyricsPath } from './projects'
import { hashFile } from './separation'

/** Recorded in lyrics.json so a re-listen can tell which engine wrote a line. */
const QWEN_ENGINE_ID = 'qwen3-asr-1.7b'

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * What Qwen3-ASR heard in a song's vocals, kept in the song's cache folder.
 * Two things read it. A re-align — switching the lyrics variant, or aligning
 * a draft again after an edit — skips the listen and goes straight to the
 * aligner, which is most of what made whisper's cached transcription worth
 * having. And the Precise tier uses its words as the text check that CTC
 * scores cannot give on singing.
 *
 * Keyed to the exact vocals file, size and mtime, because separating backing
 * vocals REWRITES that file: a listen to the old combined vocal would check
 * new lyrics against a voice that is no longer in it. mtimes compare with the
 * same 2 ms tolerance as the sync ledger (iCloud rehydration truncates them).
 */
/**
 * The listening pipeline's own stamp, the way the detectors carry theirs: bump
 * it when QwenServer.transcribe changes what it answers for the same audio
 * (the prompt, the loop guard, the forced-language retry, the chunk plan), or
 * every cached listen keeps the old answer until its vocals file changes.
 */
const HEARD_VERSION = 1

interface HeardCache {
  version: number
  engine: string
  /** The language the listen was told, or null when it was left to decide. */
  language: string | null
  vocals: { size: number; mtimeMs: number }
  chunks: QwenChunkText[]
}
const HEARD_FILE = 'heard-words.json'

async function vocalsStamp(vocals: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const st = await stat(vocals)
    return { size: st.size, mtimeMs: st.mtimeMs }
  } catch {
    return null
  }
}

/** A listen of THESE vocals, or null. `language` undefined accepts any. */
export async function readHeard(
  dir: string,
  vocals: string,
  language?: string | null
): Promise<QwenChunkText[] | null> {
  try {
    const raw = JSON.parse(await readFile(join(dir, HEARD_FILE), 'utf8')) as Partial<HeardCache>
    const stamp = await vocalsStamp(vocals)
    if (
      raw.version !== HEARD_VERSION ||
      raw.engine !== QWEN_ENGINE_ID ||
      !stamp ||
      !raw.vocals ||
      raw.vocals.size !== stamp.size ||
      Math.abs(raw.vocals.mtimeMs - stamp.mtimeMs) > 2 ||
      !Array.isArray(raw.chunks) ||
      (language !== undefined && (raw.language ?? null) !== language)
    )
      return null
    return raw.chunks
  } catch {
    return null
  }
}

export async function writeHeard(
  dir: string,
  vocals: string,
  language: string | null,
  chunks: QwenChunkText[]
): Promise<void> {
  const stamp = await vocalsStamp(vocals)
  if (!stamp) return
  const cache: HeardCache = { version: HEARD_VERSION, engine: QWEN_ENGINE_ID, language, vocals: stamp, chunks }
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, HEARD_FILE), JSON.stringify(cache), 'utf8')
  } catch {
    // a listen that cannot be kept is only a slower re-align next time
  }
}

/** The cached listen of these vocals as words — the Precise tier's text check. */
async function heardWords(dir: string, vocals: string): Promise<LyricWord[]> {
  const chunks = await readHeard(dir, vocals)
  return chunks ? linesFromChunks(chunks).flatMap((l) => l.words) : []
}

/** Which chunk each word of `lines` sits in, by where its (provisional) start falls. */
export function chunkOfEachWord(lines: LyricLine[], chunks: { start: number }[]): number[] {
  const out: number[] = []
  for (const line of lines) {
    for (const word of line.words) {
      let ci = 0
      for (let i = 0; i < chunks.length; i++) if (chunks[i].start <= word.s + 1e-6) ci = i
      out.push(ci)
    }
  }
  return out
}

interface LyricsCache {
  source: LyricsSource
  credit?: string
  aligned?: boolean
  check?: AlignCheck
  /**
   * Which recogniser heard these words, when they were transcribed rather
   * than looked up. Additive and ignored by every older reader — `source`
   * still says 'whisper' for any on-device transcription (whisper was the
   * engine until Qwen3-ASR replaced it), because that is what the phones and
   * the sync format mean by it.
   */
  engine?: string
  /**
   * true: transcribed while LRCLIB was unanswering — ask again on a later
   * open. false: LRCLIB answered "no match" — settled, stop asking. Absent:
   * written before 0.10.1 tracked outages (the 2026-07-30 outage scarred a
   * day of songs with whisper lyrics) — treat as pending, never as settled.
   */
  lrclibPending?: boolean
  /**
   * Which lookup ladder settled this as "LRCLIB has nothing". Absent means a
   * ladder older than the stamp — see LRCLIB_LADDER_VERSION.
   */
  lookup?: number
  lines: LyricLine[]
  /**
   * The phrasing alignment started from — the LRC's own times, or the
   * singer's edit. Written only alongside an aligned result, and only ever
   * the ORIGINAL: aligning again re-uses the base it already had, never the
   * last alignment's output.
   *
   * `retime` fills the gaps between anchors by scaling the reference's own
   * phrasing into them, so for every line the aligner could not place, the
   * reference IS the answer. Feeding it the previous alignment therefore
   * copies that run's mistakes forward, and an unplaceable line can never be
   * repaired: measured on Wanted Dead Or Alive, where Precise put "Dead or
   * alive" 16 s late at 163.89 s and pressing Check & align again returned
   * 163.82 s, and again, for ever — while the same align from the LRC's own
   * times lands it at 147.55 s. The comment that used to sit over alignBase
   * said re-running was fine because "the global aligner never reads the
   * current timing"; that is true of the matcher and false of the retime.
   *
   * The cost, taken deliberately: the two tiers no longer compose. Check &
   * align after a good Precise run re-derives from the base rather than
   * refining Precise's timing, so a line the fast aligner cannot place falls
   * back to the LRC instead of keeping what Precise measured. A tier that
   * builds on the last one cannot tell a good run from the 16-second one
   * above, and carrying a bad run forever is the worse failure.
   *
   * Additive: older readers (and both phones) ignore it, and a file without
   * one is its own base, which is exactly right for lyrics never aligned.
   */
  base?: LyricLine[]
}

/**
 * Bump whenever the ladder in src/shared/lrclib-core.ts learns to find
 * something it used to miss — the same rule as BEAT_DETECT_VERSION and
 * PITCH_DETECT_VERSION, for the same reason: a "no match" is only as final
 * as the search that produced it, and a transcription written under a
 * blinder ladder would otherwise stand forever.
 *
 * 2 — the lead-artist rung. Files tagged "X feat. Y" missed songs LRCLIB
 * holds under "X", and every one of them settled on whisper lyrics.
 * 3 — the site-prefix rung. Rips credited "AudioCleaner_Download_X" or
 * "muzoi.net - X" missed the same way, for the same five minutes.
 */
export const LRCLIB_LADDER_VERSION = 3

/**
 * A stored base, or undefined when it does not describe the lines beside it.
 *
 * The failure this refuses is silent rather than loud: an align saves
 * retime(base), so a base left over from different words would replace the
 * file's TEXT as well as its timing. retime walks the two in lockstep by flat
 * word index, so the shape must match exactly — and the text with it, which is
 * what catches an edit that happened to keep the shape.
 */
export function readBase(raw: { lines: LyricLine[]; base?: unknown }): LyricLine[] | undefined {
  const base = raw.base
  if (!Array.isArray(base) || base.length !== raw.lines.length) return undefined
  const same = base.every(
    (l: LyricLine, i) =>
      l?.text === raw.lines[i].text && l?.words?.length === raw.lines[i].words.length
  )
  return same ? (base as LyricLine[]) : undefined
}

/**
 * Say which lines did not anchor the retime because the aligner had to force
 * them. They are not pinned — retime scales the reference phrasing between the
 * anchors either side, so they move with their neighbours. Both Precise call
 * sites report it: a stretch dropped in silence is exactly the "Check & align
 * moved nothing" a field report arrives as, and on a release build the log is
 * the only evidence there will be.
 */
function logSlipped(what: string, outcome: AlignOutcome): void {
  if (!outcome.slipped || outcome.slipped.length === 0) return
  log(
    'lyrics',
    `${what}: ${outcome.slipped.length} line(s) the aligner had to force did not anchor ` +
      `the retime — they follow their neighbours over the reference phrasing ` +
      `(${outcome.slipped.join(', ')})`
  )
}

/**
 * The phrasing an alignment must run against: the base this song was first
 * aligned from, or its current lines when it has never been aligned. Never
 * the output of the previous run — see LyricsCache.base.
 */
export function alignRef(cache: { lines: LyricLine[]; base?: LyricLine[] }): LyricLine[] {
  return cache.base ?? cache.lines
}

/** Transcribed lyrics stay provisional until the CURRENT ladder has answered. */
export function shouldReaskLrclib(c: {
  source: LyricsSource
  lrclibPending?: boolean
  lookup?: number
}): boolean {
  if (c.source !== 'whisper') return false
  return c.lrclibPending !== false || (c.lookup ?? 0) < LRCLIB_LADDER_VERSION
}

/**
 * Tag meta plus the filename reading kept separately — junk tags (placeholder
 * artists, mojibake) are common on old rips, and the filename is often the
 * only truthful copy of artist/title.
 */
export async function readTrackMeta(
  songPath: string,
  durationSec: number
): Promise<{ meta: TrackMeta; fromFile: TrackMeta }> {
  const fromFile: TrackMeta = { ...metaFromFilename(basename(songPath)), durationSec }
  try {
    const mm = await import('music-metadata')
    const parsed = await mm.parseFile(songPath, { duration: false })
    const artist = realArtist(fixTagEncoding(parsed.common.artist?.trim()))
    const title = fixTagEncoding(parsed.common.title?.trim())
    const cleaned = title ? metaFromFilename(title) : null
    const meta: TrackMeta = {
      artist: artist || cleaned?.artist || fromFile.artist,
      title: cleaned?.title || fromFile.title,
      altTitle: cleaned?.title ? cleaned.altTitle : fromFile.altTitle,
      album: fixTagEncoding(parsed.common.album?.trim()),
      durationSec
    }
    return { meta, fromFile }
  } catch {
    return { meta: fromFile, fromFile }
  }
}

/**
 * Coerce renderer-supplied lines into a clean, ordered LyricLine[] before
 * they are aligned or written to a file the phones will read. Empty lines
 * are dropped; times are clamped finite and kept monotonic per line.
 */
export function sanitizeLines(raw: unknown): LyricLine[] {
  if (!Array.isArray(raw)) return []
  const lines: LyricLine[] = []
  for (const l of raw as Partial<LyricLine>[]) {
    const text = String(l?.text ?? '').trim()
    if (!text) continue
    const start = Number.isFinite(l?.start) ? Math.max(0, Number(l!.start)) : 0
    const end = Number.isFinite(l?.end) ? Math.max(start, Number(l!.end)) : start
    const words: LyricWord[] = []
    if (Array.isArray(l?.words)) {
      for (const w of l!.words as Partial<LyricWord>[]) {
        const t = String(w?.w ?? '').trim()
        if (!t) continue
        const s = Number.isFinite(w?.s) ? Math.max(0, Number(w!.s)) : start
        const e = Number.isFinite(w?.e) ? Math.max(s, Number(w!.e)) : s
        words.push({ w: t, s, e })
      }
    }
    if (words.length === 0) {
      // a text-only line still needs word spans for karaoke — spread by length
      const parts = text.split(/\s+/).filter(Boolean)
      const total = parts.reduce((s, p) => s + p.length + 1, 0)
      let cur = start
      for (const p of parts) {
        const dur = total > 0 ? ((end - start) * (p.length + 1)) / total : 0
        words.push({ w: p, s: cur, e: cur + dur })
        cur += dur
      }
    }
    lines.push({ start, end, text, words })
  }
  lines.sort((a, b) => a.start - b.start)
  return lines
}

export class Transcriber {
  private child: ChildProcess | null = null
  private cancelled = false
  private abort: AbortController | null = null
  private qwen: QwenServer | null = null

  get busy(): boolean {
    return this.child !== null || this.abort !== null || this.qwen !== null
  }

  private async cacheDir(songPath: string): Promise<string> {
    return join(stemsRoot(), await hashFile(songPath))
  }

  /** Project songs keep lyrics next to project.json; others use the hash cache. */
  private async lyricsFile(songPath: string): Promise<string> {
    return (await projectLyricsPath(songPath)) ?? join(await this.cacheDir(songPath), 'lyrics.json')
  }

  private async readCache(file: string): Promise<LyricsCache | null> {
    try {
      const raw = JSON.parse(await readFile(file, 'utf8')) as Partial<LyricsCache>
      if (!Array.isArray(raw.lines) || raw.lines.length === 0) return null
      return {
        source: raw.source ?? 'whisper',
        credit: raw.credit,
        aligned: raw.aligned,
        check: raw.check,
        engine: raw.engine,
        lrclibPending: raw.lrclibPending,
        lookup: raw.lookup,
        lines: raw.lines,
        base: readBase({ lines: raw.lines, base: raw.base })
      }
    } catch {
      return null
    }
  }

  /**
   * Every lyrics write goes through here — LRCLIB hits, the variant picker,
   * on-device transcription, every aligner. It is also where the project is marked for Drive:
   * four of these writers used to have no sync trigger at all, so a fresh
   * LRCLIB fetch or a transcription reached the phones only when some later
   * save happened to push it.
   */
  private async writeCache(file: string, cache: LyricsCache): Promise<void> {
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, JSON.stringify(cache), 'utf8')
    markFileDirty(file, 'lyrics')
  }

  /**
   * LRCLIB by tag meta, then by the filename when the tags led elsewhere —
   * the filename is often the only truthful copy on junk-tagged rips.
   */
  private async searchOnline(
    songPath: string,
    durationSec: number
  ): Promise<{ hit?: { lines: LyricLine[]; credit: string }; down: boolean }> {
    const { meta, fromFile } = await readTrackMeta(songPath, durationSec)
    log('lyrics', `LRCLIB search: ${meta.artist ?? '?'} — ${meta.title ?? '?'} (${Math.round(durationSec)}s)`)
    let out = await lookupLyrics(meta)
    if (out === 'miss' && (fromFile.artist !== meta.artist || fromFile.title !== meta.title)) {
      log('lyrics', `LRCLIB retry from the file name: ${fromFile.artist ?? '?'} — ${fromFile.title}`)
      out = await lookupLyrics(fromFile)
    }
    if (out === 'miss') return { down: false }
    if (out === 'down') return { down: true }
    return { hit: out.hit, down: false }
  }

  /** Apply a manually chosen LRCLIB record and cache it for this song. */
  async applyById(songPath: string, id: number, durationSec: number): Promise<LyricsResult> {
    const hit = await lyricsById(id, durationSec)
    if (!hit) return { ok: false, error: t('main.error.entryNoUsableSyncedLyrics') }
    await this.writeCache(await this.lyricsFile(songPath), {
      source: 'lrclib',
      credit: hit.credit,
      lines: hit.lines
    })
    return { ok: true, cached: false, source: 'lrclib', credit: hit.credit, lines: hit.lines }
  }

  /**
   * Persist hand-edited lyrics — the editor's save. Sticky by design:
   * 'edited' is never re-asked of LRCLIB (shouldReaskLrclib is whisper-only)
   * and never superseded by a transcription, so the singer's own words
   * survive every later open. writeCache marks the project for Drive, so
   * phones pick the correction up like any other lyrics change.
   */
  async saveEdited(songPath: string, lines: LyricLine[], credit?: string): Promise<LyricsResult> {
    if (lines.length === 0) return { ok: false, error: t('main.error.noLinesToSave') }
    try {
      await this.writeCache(await this.lyricsFile(songPath), {
        source: 'edited',
        credit,
        lines
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: t('main.error.couldNotSaveLyrics', { message: msg }) }
    }
    return { ok: true, cached: false, source: 'edited', credit, lines }
  }

  /**
   * Time a draft's words against the vocals WITHOUT touching lyrics.json —
   * the editor previews the result and saves explicitly. 'align' times the
   * draft with Qwen3-ASR and its forced aligner (a cached listen of the same
   * vocals skips straight to the aligner); 'precise' runs CTC forced
   * alignment through the splitter pack. On a mismatch verdict the draft
   * comes back untouched with the check attached — the editor tells the
   * singer instead of silently scrambling their timing.
   */
  async alignDraft(
    songPath: string,
    durationSec: number,
    draft: LyricLine[],
    tier: 'align' | 'precise',
    allowDownload: boolean,
    onProgress: (p: LyricsProgress) => void
  ): Promise<LyricsResult> {
    if (this.busy) return { ok: false, error: t('main.error.lyricsJobAlreadyRunning') }
    if (draft.length === 0) return { ok: false, error: t('main.error.noLinesToAlign') }
    onProgress({ stage: 'preparing', percent: 0 })
    const dir = await this.cacheDir(songPath)
    const vocals = await this.findVocals(songPath, dir)
    if (!vocals) {
      return {
        ok: false,
        error: t('main.error.splitFirstAlign')
      }
    }
    const refCount = draft.reduce((s, l) => s + l.words.length, 0)

    if (tier === 'precise') {
      // The same ladder as preciseAlign, minus the cache write.
      if (!(await preciseCapable())) {
        return {
          ok: false,
          error: t('main.error.preciseNeedsPack')
        }
      }
      if (!(await exists(mmsModelPath()))) {
        if (!allowDownload) {
          return {
            ok: false,
            needsModel: { sizeMb: mmsModelMb(), what: 'aligner' },
            error: t('main.error.preciseNeedsAlignerModel')
          }
        }
        this.cancelled = false
        this.abort = new AbortController()
        try {
          await downloadFile(
            mmsModelUrl(),
            mmsModelPath(),
            mmsModelMb() * 1e6,
            (pct) => onProgress({ stage: 'downloading-model', percent: pct }),
            this.abort.signal
          )
        } catch (err) {
          if (this.cancelled) return { ok: false, cancelled: true, error: t('main.error.cancelled') }
          const msg = err instanceof Error ? err.message : String(err)
          return { ok: false, error: t('main.error.couldNotDownloadAlignerModel', { message: msg }) }
        } finally {
          this.abort = null
        }
      }
      this.cancelled = false
      onProgress({ stage: 'transcribing', percent: 0 })
      try {
        const run = await runMmsAlign(vocals, draft, onProgress)
        this.child = run.child
        const ctcWords = await run.done
        const outcome = ctcOutcome(draft, ctcWords, durationSec)
        logSlipped('draft precise align', outcome)
        let { check } = outcome
        // CTC scores cannot tell wrong text from hard vocals on singing —
        // when a listen of these vocals is cached, its text check speaks.
        const words = await heardWords(dir, vocals)
        if (words.length > 0 && transcriptionUsable(words, refCount) && check.verdict !== 'mismatch') {
          const textCheck = alignToTranscription(draft, words, durationSec, 'qwen').check
          check = { ...textCheck, method: 'ctc', medianShift: check.medianShift }
        }
        log(
          'lyrics',
          `draft precise align: ${check.verdict} — ${check.matchedPct}% words heard, median shift ${check.medianShift}s`
        )
        const aligned = check.verdict !== 'mismatch'
        return {
          ok: true,
          cached: false,
          source: 'edited',
          aligned,
          check,
          lines: aligned ? outcome.lines : draft
        }
      } catch (err) {
        if (this.cancelled) return { ok: false, cancelled: true, error: t('main.error.cancelled') }
        const msg = err instanceof Error ? err.message : String(err)
        return { ok: false, error: t('main.error.preciseAlignmentFailed', { message: msg }) }
      } finally {
        this.child = null
      }
    }

    // Fast tier: Qwen3-ASR hears the vocals (or a cached listen of these very
    // vocals stands in), its forced aligner times the draft's words.
    const ready = await this.ensureQwen(allowDownload, onProgress)
    if (!ready.ok) return ready.res
    const aligned = await this.alignWithQwen(vocals, dir, draft, durationSec, onProgress)
    if (!aligned.ok) return aligned.res
    const { lines, check } = aligned.outcome
    log(
      'lyrics',
      `draft align: ${check.verdict} — ${check.matchedPct}% words heard, median shift ${check.medianShift}s, ${check.badLines.length} off lines`
    )
    const fits = check.verdict !== 'mismatch'
    return {
      ok: true,
      cached: false,
      source: 'edited',
      aligned: fits,
      check,
      lines: fits ? lines : draft
    }
  }

  async resolve(
    songPath: string,
    durationSec: number,
    allowDownload: boolean,
    prefer: 'auto' | 'transcribe' | 'align' | 'precise',
    onProgress: (p: LyricsProgress) => void
  ): Promise<LyricsResult> {
    if (this.busy) return { ok: false, error: t('main.error.lyricsJobAlreadyRunning') }

    onProgress({ stage: 'preparing', percent: 0 })
    const dir = await this.cacheDir(songPath)
    const lyricsPath = await this.lyricsFile(songPath)

    const cached = await this.readCache(lyricsPath)
    // Alignment refines existing online or hand-edited lyrics; without them,
    // auto. An on-device transcription is the one source with nothing to
    // align against: the timing IS the transcription. Re-running always
    // starts from `base` — the phrasing this song was first aligned from —
    // because retime carries the reference's own timing into every gap, so
    // aligning the last alignment ratchets its mistakes in (LyricsCache.base).
    let alignBase: LyricsCache | null = null
    if (prefer === 'align' || prefer === 'precise') {
      if (cached && cached.source !== 'whisper') alignBase = cached
      else prefer = 'auto'
    }
    if (
      cached &&
      !alignBase &&
      (prefer === 'auto' || (prefer === 'transcribe' && cached.source === 'whisper'))
    ) {
      // Transcribed lyrics are provisional while the verdict behind them is: an
      // LRCLIB outage, or a lookup ladder since taught to find more. Ask
      // again now, and either upgrade to synced lyrics or settle the matter.
      if (prefer === 'auto' && shouldReaskLrclib(cached)) {
        log(
          'lyrics',
          cached.lrclibPending === false
            ? 'cached lyrics were transcribed under an older lyrics search — asking again'
            : 'cached lyrics were transcribed while LRCLIB was unanswering — asking again'
        )
        onProgress({ stage: 'searching', percent: 10 })
        const found = await this.searchOnline(songPath, durationSec)
        if (found.hit) {
          log(
            'lyrics',
            `LRCLIB answered this time: ${found.hit.credit} — synced lyrics replace the transcription`
          )
          await this.writeCache(lyricsPath, {
            source: 'lrclib',
            credit: found.hit.credit,
            lines: found.hit.lines
          })
          return {
            ok: true,
            cached: false,
            source: 'lrclib',
            credit: found.hit.credit,
            lines: found.hit.lines
          }
        }
        if (!found.down) {
          // a real miss this time — keep the transcription and stop asking
          // (false survives JSON; deleting the field would read as legacy)
          await this.writeCache(lyricsPath, {
            ...cached,
            lrclibPending: false,
            lookup: LRCLIB_LADDER_VERSION
          })
        }
      }
      log('lyrics', `using cached lyrics for ${basename(songPath)} (${cached.source}${cached.aligned ? ', aligned' : ''}) from ${lyricsPath}`)
      return {
        ok: true,
        cached: true,
        source: cached.source,
        credit: cached.credit,
        aligned: cached.aligned,
        check: cached.check,
        lines: cached.lines
      }
    }

    // 1) Online synced lyrics (no stems, no model needed)
    let lrclibDown = false
    if (prefer === 'auto' && !alignBase) {
      onProgress({ stage: 'searching', percent: 10 })
      const found = await this.searchOnline(songPath, durationSec)
      if (found.hit) {
        log('lyrics', `LRCLIB hit: ${found.hit.credit ?? 'synced lyrics'}`)
        await this.writeCache(lyricsPath, {
          source: 'lrclib',
          credit: found.hit.credit,
          lines: found.hit.lines
        })
        return { ok: true, cached: false, source: 'lrclib', credit: found.hit.credit, lines: found.hit.lines }
      }
      lrclibDown = found.down
      log(
        'lyrics',
        lrclibDown
          ? 'LRCLIB: no answer (down or unreachable from here) — will ask again another time'
          : 'LRCLIB: no match'
      )
    }

    // 2) Fallback: on-device transcription of the vocals stem
    const vocals = await this.findVocals(songPath, dir)
    if (!vocals) {
      return { ok: false, error: t('main.error.splitFirstLyrics') }
    }

    // Precise tier: CTC forced alignment through the torch splitter pack.
    if (prefer === 'precise' && alignBase) {
      return this.preciseAlign(vocals, alignBase, lyricsPath, dir, durationSec, allowDownload, onProgress)
    }

    // Everything else listens with Qwen3-ASR, which replaced whisper: it hears
    // sung words markedly better (WER 0.167 against whisper's 0.278 on songs
    // with no online lyrics, and none of the invented subtitle phrases), and
    // its forced aligner times them more tightly (median error 0.08 s against
    // 0.19 s over the catalog).
    const ready = await this.ensureQwen(allowDownload, onProgress)
    if (!ready.ok) return ready.res

    if (alignBase) {
      const aligned = await this.alignWithQwen(vocals, dir, alignRef(alignBase), durationSec, onProgress)
      if (!aligned.ok) return aligned.res
      return this.finishOutcome(alignBase, aligned.outcome, lyricsPath)
    }

    const transcribed = await this.transcribeWithQwen(vocals, dir, durationSec, onProgress)
    if (!transcribed.ok) return transcribed.res
    const lines = transcribed.lines
    try {
      await this.writeCache(lyricsPath, {
        source: 'whisper',
        engine: QWEN_ENGINE_ID,
        lines,
        // an outage is not a verdict — true makes a later open ask
        // LRCLIB again; false records that it really answered "miss"
        lrclibPending: lrclibDown,
        // ...and which ladder it answered, so a better one asks again
        lookup: LRCLIB_LADDER_VERSION
      })
    } catch (err) {
      // a failed cache write is still a failed transcription to the caller —
      // IPC handlers return { ok: false }, they never throw
      const msg = err instanceof Error ? err.message : String(err)
      log('lyrics', `transcription failed: ${msg}`, 'error')
      return { ok: false, error: t('main.error.transcriptionFailed', { message: msg }) }
    }
    return { ok: true, cached: false, source: 'whisper', lines }
  }

  /** The vocals stem the recogniser and the aligners listen to (project-local
   *  stems first — v2 projects store FLAC — then the hash cache's WAVs). */
  private async findVocals(songPath: string, dir: string): Promise<string | null> {
    const isProject = (await projectLyricsPath(songPath)) !== null
    const candidates = [
      ...(isProject
        ? [join(dirname(songPath), 'stems', 'vocals.flac'), join(dirname(songPath), 'stems', 'vocals.wav')]
        : []),
      join(dir, 'htdemucs', 'vocals.wav'),
      join(dir, 'htdemucs_6s', 'vocals.wav')
    ]
    for (const c of candidates) {
      if (await exists(c)) return c
    }
    return null
  }

  /**
   * The lyrics engine and its speech model, downloading the model when the
   * singer has agreed. Both engines ship inside the app (llama-server hears,
   * crispasr times), so a missing one is a broken build; the model is a
   * one-time download of what is still missing of its three parts.
   */
  private async ensureQwen(
    allowDownload: boolean,
    onProgress: (p: LyricsProgress) => void
  ): Promise<{ ok: true } | { ok: false; res: LyricsResult }> {
    if (!(await resolveQwenServer()) || !(await resolveQwenAligner())) {
      return {
        ok: false,
        res: {
          ok: false,
          needsEngine: true,
          error: t('main.error.lyricsEngineMissing')
        }
      }
    }
    if (await qwenInstalled()) return { ok: true }
    if (!allowDownload) {
      return {
        ok: false,
        res: {
          ok: false,
          needsModel: { sizeMb: await qwenMissingMb(), what: 'speech' },
          error: t('main.error.hearingNeedsSpeechModel')
        }
      }
    }
    this.cancelled = false
    this.abort = new AbortController()
    try {
      await downloadQwen((pct) => onProgress({ stage: 'downloading-model', percent: pct }), this.abort.signal)
      return { ok: true }
    } catch (err) {
      if (this.cancelled) return { ok: false, res: { ok: false, cancelled: true, error: t('main.error.cancelled') } }
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, res: { ok: false, error: t('main.error.couldNotDownloadSpeechModel', { message: msg }) } }
    } finally {
      this.abort = null
    }
  }

  /**
   * What Qwen3-ASR hears in these vocals, chunk by chunk — from the cache when
   * this exact vocals file was already heard in the same language, otherwise
   * by listening (and keeping the answer for next time).
   */
  private async hear(
    vocals: string,
    dir: string,
    pcm: Float32Array,
    chunks: ReturnType<typeof planChunks>,
    language: string | null,
    onProgress: (pct: number) => void,
    signal: AbortSignal
  ): Promise<QwenChunkText[]> {
    const cached = await readHeard(dir, vocals, language)
    // The chunk plan is a pure function of the audio, so a cached listen of
    // the same file lines up chunk for chunk — checked rather than assumed.
    if (
      cached &&
      cached.length === chunks.length &&
      cached.every((c, i) => Math.abs(c.start - chunks[i].start) < 1e-3)
    ) {
      log('lyrics', `qwen: reusing the cached listen of these vocals (${cached.length} chunks)`)
      onProgress(100)
      return cached
    }
    const server = new QwenServer()
    this.qwen = server
    try {
      await server.start()
      const texts = await server.transcribe(pcm, chunks, language, onProgress, signal)
      await writeHeard(dir, vocals, language, texts)
      return texts
    } finally {
      server.stop()
      this.qwen = null
    }
  }

  /**
   * Check & align: Qwen3-ASR says what is sung, its forced aligner says when
   * each lyric word is sung.
   *
   * Measured over the 19 songs whose Precise timing is stored, against the
   * whisper tier this replaced: the systematic lateness is gone (−0.04 s
   * against +0.17 s), the median error halves (0.08 s against 0.19 s), words
   * landing inside a tenth of a second nearly double (55% against 30%) and
   * phrase onsets land within 0.15 s of the voice 65% of the time against
   * 45%. It is behind in the far tail (80% of words inside half a second
   * against 86%), which is two songs: one every engine mishears, and one
   * whose verses repeat so closely that a word can be matched to the wrong
   * repetition — the failure mode of having no times from the recogniser.
   */
  private async alignWithQwen(
    vocals: string,
    dir: string,
    ref: LyricLine[],
    durationSec: number,
    onProgress: (p: LyricsProgress) => void
  ): Promise<{ ok: true; outcome: AlignOutcome } | { ok: false; res: LyricsResult }> {
    this.cancelled = false
    // The aligner runs one child per sung chunk, minutes on a slow machine.
    // Without a signal to carry Cancel into that loop the job runs to the end
    // and then WRITES the song's lyrics.json and marks it for Drive.
    this.abort = new AbortController()
    const signal = this.abort.signal
    try {
      onProgress({ stage: 'preparing', percent: 0 })
      const pcm = await decodeVocalsMono16k(vocals)
      const { env, p90 } = levelEnvelope(pcm)
      const chunks = planChunks(env, p90)
      if (chunks.length === 0) {
        return { ok: false, res: { ok: false, error: t('main.error.noSingingFound') } }
      }
      const code = guessLanguage(ref)
      const texts = await this.hear(vocals, dir, pcm, chunks, qwenLanguageName(code), (pct) =>
        onProgress({ stage: 'transcribing', percent: pct * 0.6 }), signal)
      if (this.cancelled) return { ok: false, res: { ok: false, cancelled: true, error: t('main.error.cancelled') } }

      // What was heard, as words — the verdict is a text question.
      const heard = linesFromChunks(texts).flatMap((l) => l.words)
      if (!transcriptionUsable(heard, ref.reduce((s, l) => s + l.words.length, 0))) {
        // collapsed or hallucinated — evidence of nothing; a "mismatch" here
        // would slander perfectly good lyrics
        return {
          ok: false,
          res: {
            ok: false,
            error: t('main.error.couldNotMakeOutVocals')
          }
        }
      }
      const judged = alignToTranscription(ref, heard, durationSec, 'qwen')
      if (judged.check.verdict === 'mismatch') return { ok: true, outcome: judged }

      // Where each lyric word sits comes from where it was heard; the words
      // nobody heard ride with their neighbours.
      const hyp = sanitizeHyp(heard)
      const anchors = globalAnchors(ref, hyp)
      const flatIndex = new Map<string, number>()
      let k = 0
      ref.forEach((l, li) => l.words.forEach((_, wi) => flatIndex.set(`${li}:${wi}`, k++)))
      const anchorChunk = new Map<number, number>()
      for (const a of anchors) {
        const flat = flatIndex.get(`${a.li}:${a.wi}`)
        if (flat === undefined) continue
        let ci = 0
        for (let i = 0; i < chunks.length; i++) if (chunks[i].start <= a.s) ci = i
        anchorChunk.set(flat, ci)
      }
      const chunkOfWord = assignWordsToChunks(k, anchorChunk)
      const placed = await alignWordsInChunks(
        pcm,
        chunks,
        ref,
        chunkOfWord,
        new Set(judged.check.badLines),
        code ?? 'en',
        (pct) => onProgress({ stage: 'transcribing', percent: 60 + pct * 0.4 }),
        signal
      )
      if (this.cancelled) return { ok: false, res: { ok: false, cancelled: true, error: t('main.error.cancelled') } }
      if (placed.length === 0) {
        return { ok: false, res: { ok: false, error: t('main.error.couldNotTimeWords') } }
      }
      const lines = retime(ref, placed, durationSec)
      // Only lines that carry a placement are evidence of a shift — the rest
      // were interpolated from their neighbours, and averaging those in is
      // how a median stops describing anything measured. This is very nearly
      // alignToTranscription's `perLine.got > 0`, and deliberately a shade
      // stricter: `placed` has already had the unheard lines removed, so a bad
      // line holding one stray anchor counts there and not here. Do not
      // "align" the two by loosening this one.
      const timedLines = new Set(placed.map((a) => a.li))
      const shifts = lines
        .map((l, i) => l.start - ref[i].start)
        .filter((_, i) => timedLines.has(i))
        .sort((a, b) => a - b)
      const medianShift = shifts.length > 0 ? shifts[Math.floor(shifts.length / 2)] : 0
      // Judge the timing we are about to save, not the intermediate pass that
      // only decided which words were heard: carrying that verdict over told
      // the singer "timing adjusted" about lines that had not moved at all.
      const check: AlignCheck = {
        ...judged.check,
        medianShift: Math.round(medianShift * 100) / 100,
        verdict:
          Math.abs(medianShift) <= 0.35 &&
          judged.check.badLines.length === 0 &&
          judged.check.matchedPct >= 70
            ? 'match'
            : 'retimed'
      }
      log(
        'lyrics',
        `qwen align: ${check.verdict} — ${check.matchedPct}% words heard, ${placed.length} placed, median shift ${check.medianShift}s`
      )
      return { ok: true, outcome: { lines, check } }
    } catch (err) {
      if (this.cancelled) return { ok: false, res: { ok: false, cancelled: true, error: t('main.error.cancelled') } }
      const msg = err instanceof Error ? err.message : String(err)
      log('lyrics', `qwen align failed: ${msg}`, 'error')
      return { ok: false, res: { ok: false, error: t('main.error.alignmentFailed', { message: msg }) } }
    } finally {
      this.abort = null
    }
  }

  /**
   * Transcribe a song nobody has lyrics for: Qwen3-ASR hears the words, and
   * they are timed by the Precise aligner when it is installed (the timing the
   * app treats as reference) and by Qwen's own forced aligner otherwise — or
   * when the Precise aligner cannot place them. Qwen hears words but tells no
   * time, so a transcription only lands once one of the two has timed it:
   * provisional chunk timing is not karaoke.
   */
  private async transcribeWithQwen(
    vocals: string,
    dir: string,
    durationSec: number,
    onProgress: (p: LyricsProgress) => void
  ): Promise<{ ok: true; lines: LyricLine[] } | { ok: false; res: LyricsResult }> {
    const none: { ok: false; res: LyricsResult } = {
      ok: false,
      res: { ok: false, error: t('main.error.noWordsDetected') }
    }
    this.cancelled = false
    this.abort = new AbortController()
    const signal = this.abort.signal
    try {
      onProgress({ stage: 'preparing', percent: 0 })
      const pcm = await decodeVocalsMono16k(vocals)
      const { env, p90 } = levelEnvelope(pcm)
      const chunks = planChunks(env, p90)
      if (chunks.length === 0) {
        log('lyrics', 'qwen: no sung stretch found in the vocals')
        return none
      }
      const sung = chunks.reduce((s, c) => s + (c.end - c.start), 0)
      log('lyrics', `qwen: ${chunks.length} sung stretches, ${Math.round(sung)}s of ${Math.round(durationSec)}s`)
      const texts = await this.hear(vocals, dir, pcm, chunks, null, (pct) =>
        onProgress({ stage: 'transcribing', percent: pct * 0.7 }), signal)
      if (this.cancelled) return { ok: false, res: { ok: false, cancelled: true, error: t('main.error.cancelled') } }
      const lines = linesFromChunks(texts)
      if (lines.length === 0) {
        log('lyrics', 'qwen: heard no words')
        return none
      }
      const heard = lines.reduce((s, l) => s + l.words.length, 0)
      log('lyrics', `qwen: ${heard} words in ${lines.length} lines — timing them`)

      // 1) The Precise aligner, when this machine has it. Anything short of a
      //    usable timing — a mismatch (it placed under a quarter of the
      //    words), or a run that dies (OOM, a signal, a python error) — hands
      //    the words to Qwen's own aligner, which is certainly installed here:
      //    a failure that repeats on every retry must not make a song
      //    impossible to transcribe on a machine that can time it another way.
      if ((await preciseCapable()) && (await exists(mmsModelPath()))) {
        try {
          const run = await runMmsAlign(vocals, lines, (p) =>
            onProgress({ stage: p.stage, percent: 70 + (p.percent ?? 0) * 0.3 })
          )
          this.child = run.child
          const ctc = await run.done
          this.child = null
          if (this.cancelled) return { ok: false, res: { ok: false, cancelled: true, error: t('main.error.cancelled') } }
          const outcome = ctcOutcome(lines, ctc, durationSec)
          log('lyrics', `qwen: precise timing ${outcome.check.verdict} — ${outcome.check.matchedPct}% of the words placed`)
          if (outcome.check.verdict !== 'mismatch') return { ok: true, lines: outcome.lines }
        } catch (err) {
          this.child = null
          if (this.cancelled) return { ok: false, res: { ok: false, cancelled: true, error: t('main.error.cancelled') } }
          const msg = err instanceof Error ? err.message : String(err)
          log('lyrics', `qwen: precise timing failed (${msg}) — timing with Qwen's aligner`, 'warn')
        }
      }

      // 2) Qwen's forced aligner. Each transcribed line came out of exactly one
      //    chunk, so where every word belongs is known rather than matched.
      const placed = await alignWordsInChunks(
        pcm,
        chunks,
        lines,
        chunkOfEachWord(lines, chunks),
        new Set(),
        guessLanguage(lines) ?? 'en',
        (pct) => onProgress({ stage: 'transcribing', percent: 70 + pct * 0.3 }),
        signal
      )
      if (this.cancelled) return { ok: false, res: { ok: false, cancelled: true, error: t('main.error.cancelled') } }
      if (placed.length === 0) {
        return { ok: false, res: { ok: false, error: t('main.error.couldNotTimeTranscribedWords') } }
      }
      log('lyrics', `qwen: ${placed.length} of ${heard} words placed by the aligner`)
      return { ok: true, lines: retime(lines, placed, durationSec) }
    } catch (err) {
      if (this.cancelled) return { ok: false, res: { ok: false, cancelled: true, error: t('main.error.cancelled') } }
      const msg = err instanceof Error ? err.message : String(err)
      log('lyrics', `transcription failed: ${msg}`, 'error')
      return { ok: false, res: { ok: false, error: t('main.error.transcriptionFailed', { message: msg }) } }
    } finally {
      this.child = null
      this.abort = null
    }
  }

  /** Keep the lyrics on a mismatch, otherwise save the retimed ones. Shared
   *  by both fast tiers so a verdict means the same thing either way. */
  private async finishOutcome(
    alignBase: LyricsCache,
    outcome: AlignOutcome,
    lyricsPath: string
  ): Promise<LyricsResult> {
    const { lines, check } = outcome
    if (check.verdict === 'mismatch') {
      // Do not touch the cached lyrics — the text is not what is being sung.
      return {
        ok: true,
        cached: false,
        source: alignBase.source,
        credit: alignBase.credit,
        aligned: alignBase.aligned,
        check,
        lines: alignBase.lines
      }
    }
    const cache: LyricsCache = {
      source: alignBase.source,
      credit: alignBase.credit,
      aligned: true,
      check,
      lines,
      base: alignRef(alignBase),
      ...(check.method === 'qwen' ? { engine: QWEN_ENGINE_ID } : {})
    }
    await this.writeCache(lyricsPath, cache)
    return {
      ok: true,
      cached: false,
      source: alignBase.source,
      credit: alignBase.credit,
      aligned: true,
      check,
      lines
    }
  }

  /** CTC forced alignment via the torch splitter pack (word-level, scored). */
  private async preciseAlign(
    vocals: string,
    alignBase: LyricsCache,
    lyricsPath: string,
    dir: string,
    durationSec: number,
    allowDownload: boolean,
    onProgress: (p: LyricsProgress) => void
  ): Promise<LyricsResult> {
    if (!(await preciseCapable())) {
      return {
        ok: false,
        error: t('main.error.preciseNeedsPack')
      }
    }
    if (!(await exists(mmsModelPath()))) {
      if (!allowDownload) {
        return {
          ok: false,
          needsModel: { sizeMb: mmsModelMb(), what: 'aligner' },
          error: t('main.error.preciseNeedsAlignerModel')
        }
      }
      this.cancelled = false
      this.abort = new AbortController()
      try {
        await downloadFile(
          mmsModelUrl(),
          mmsModelPath(),
          mmsModelMb() * 1e6,
          (pct) => onProgress({ stage: 'downloading-model', percent: pct }),
          this.abort.signal
        )
      } catch (err) {
        if (this.cancelled) return { ok: false, cancelled: true, error: t('main.error.cancelled') }
        const msg = err instanceof Error ? err.message : String(err)
        return { ok: false, error: t('main.error.couldNotDownloadAlignerModel', { message: msg }) }
      } finally {
        this.abort = null
      }
    }

    this.cancelled = false
    onProgress({ stage: 'transcribing', percent: 0 })
    try {
      const ref = alignRef(alignBase)
      const run = await runMmsAlign(vocals, ref, onProgress)
      this.child = run.child
      const ctcWords = await run.done
      const outcome = ctcOutcome(ref, ctcWords, durationSec)
      let { check } = outcome
      const { lines } = outcome
      logSlipped('precise align', outcome)
      // CTC scores cannot tell wrong text from hard vocals on singing — when a
      // listen of these vocals is cached, its text check is authoritative.
      const words = await heardWords(dir, vocals)
      const refCount = ref.reduce((s, l) => s + l.words.length, 0)
      if (words.length > 0 && transcriptionUsable(words, refCount) && check.verdict !== 'mismatch') {
        const textCheck = alignToTranscription(ref, words, durationSec, 'qwen').check
        check = { ...textCheck, method: 'ctc', medianShift: check.medianShift }
      }
      log(
        'lyrics',
        `precise align: ${check.verdict} — ${check.matchedPct}% words heard, median shift ${check.medianShift}s`
      )
      if (check.verdict === 'mismatch') {
        return {
          ok: true,
          cached: false,
          source: alignBase.source,
          credit: alignBase.credit,
          aligned: alignBase.aligned,
          check,
          lines: alignBase.lines
        }
      }
      const cache: LyricsCache = {
        source: alignBase.source,
        credit: alignBase.credit,
        aligned: true,
        check,
        lines,
        base: ref
      }
      await this.writeCache(lyricsPath, cache)
      return {
        ok: true,
        cached: false,
        source: alignBase.source,
        credit: alignBase.credit,
        aligned: true,
        check,
        lines
      }
    } catch (err) {
      if (this.cancelled) return { ok: false, cancelled: true, error: t('main.error.cancelled') }
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: t('main.error.preciseAlignmentFailed', { message: msg }) }
    } finally {
      this.child = null
    }
  }

  cancel(): void {
    this.cancelled = true
    this.abort?.abort()
    this.child?.kill('SIGTERM')
    this.qwen?.stop()
  }
}

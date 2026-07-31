import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { cpus } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { AlignCheck, LyricLine, LyricWord, LyricsProgress, LyricsResult, LyricsSource } from '../shared/types'
import { alignToTranscription, ctcOutcome, guessLanguage, transcriptionUsable } from './align'
import { preciseCapable, runMmsAlign } from './align-mms'
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
import { downloadFile, mmsModelMb, mmsModelPath, mmsModelUrl, modelsDir } from './models'
import { projectLyricsPath } from './projects'
import { hashFile, spawnEnv } from './separation'

// Fallback transcription only runs when no online lyrics exist, so a bigger
// one-time download is worth it — turbo is far stronger than `small` on singing.
const MODEL = process.env.SINGZ_WHISPER_MODEL || 'large-v3-turbo'
const MODEL_SIZES_MB: Record<string, number> = {
  tiny: 75,
  base: 142,
  small: 466,
  medium: 1530,
  'large-v3-turbo': 1620
}
const modelUrl = (m: string): string =>
  `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${m}.bin`

const EXE = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli'

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Bundled-first engine resolution: packaged resources → dev vendor dir → env override. */
async function resolveEngine(): Promise<string[] | null> {
  if (process.env.SINGZ_WHISPER) return process.env.SINGZ_WHISPER.split(' ').filter(Boolean)
  const target = `${process.platform}-${process.arch}`
  const candidates = [
    join(process.resourcesPath ?? '', 'engines', EXE),
    // dev: this module lives at <root>/out/main — vendor sits at the project root
    join(import.meta.dirname, '..', '..', 'vendor', target, EXE),
    join(app.getAppPath(), 'vendor', target, EXE)
  ]
  for (const c of candidates) {
    if (c && (await exists(c))) return [c]
  }
  return null
}

export function whisperModelPath(): string {
  return join(modelsDir(), `ggml-${MODEL}.bin`)
}

/** Prefer the configured model, but use any already-downloaded one before asking. */
async function bestAvailableModel(): Promise<string | null> {
  for (const m of [MODEL, 'medium', 'small', 'base', 'tiny']) {
    const p = join(modelsDir(), `ggml-${m}.bin`)
    if (await exists(p)) return p
  }
  return null
}

/** One-time migration from the old per-identity location (userData/models). */
async function migrateOldModel(): Promise<void> {
  const oldPath = join(app.getPath('userData'), 'models', `ggml-${MODEL}.bin`)
  const newPath = whisperModelPath()
  if (!(await exists(newPath)) && (await exists(oldPath))) {
    try {
      await mkdir(join(newPath, '..'), { recursive: true })
      await rename(oldPath, newPath)
    } catch {
      // cross-volume or locked — the downloader will fetch a fresh copy
    }
  }
}

export function whisperModelSizeMb(): number {
  return MODEL_SIZES_MB[MODEL] ?? 500
}

/** Group whisper.cpp word-chunks into karaoke lines at pauses/punctuation. */
function groupWords(words: LyricWord[]): LyricLine[] {
  const lines: LyricLine[] = []
  let cur: LyricWord[] = []
  const flush = (): void => {
    if (cur.length === 0) return
    lines.push({
      start: cur[0].s,
      end: cur[cur.length - 1].e,
      text: cur.map((w) => w.w).join(' '),
      words: cur
    })
    cur = []
  }
  for (const w of words) {
    const prev = cur[cur.length - 1]
    if (prev && (w.s - prev.e > 0.7 || cur.length >= 10 || /[.!?]$/.test(prev.w))) flush()
    cur.push(w)
  }
  flush()
  return lines
}

interface LyricsCache {
  source: LyricsSource
  credit?: string
  aligned?: boolean
  check?: AlignCheck
  /**
   * true: transcribed while LRCLIB was unanswering — ask again on a later
   * open. false: LRCLIB answered "no match" — settled, stop asking. Absent:
   * written before 0.10.1 tracked outages (the 2026-07-30 outage scarred a
   * day of songs with whisper lyrics) — treat as pending, never as settled.
   */
  lrclibPending?: boolean
  lines: LyricLine[]
}

/** Whisper lyrics stay provisional until LRCLIB has actually answered once. */
export function shouldReaskLrclib(c: {
  source: LyricsSource
  lrclibPending?: boolean
}): boolean {
  return c.source === 'whisper' && c.lrclibPending !== false
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

export class Transcriber {
  private child: ChildProcess | null = null
  private cancelled = false
  private abort: AbortController | null = null

  get busy(): boolean {
    return this.child !== null || this.abort !== null
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
        lrclibPending: raw.lrclibPending,
        lines: raw.lines
      }
    } catch {
      return null
    }
  }

  private async writeCache(file: string, cache: LyricsCache): Promise<void> {
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, JSON.stringify(cache), 'utf8')
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
    if (!hit) return { ok: false, error: 'That entry has no usable synced lyrics.' }
    await this.writeCache(await this.lyricsFile(songPath), {
      source: 'lrclib',
      credit: hit.credit,
      lines: hit.lines
    })
    return { ok: true, cached: false, source: 'lrclib', credit: hit.credit, lines: hit.lines }
  }

  private async downloadModel(onProgress: (p: LyricsProgress) => void): Promise<void> {
    this.abort = new AbortController()
    try {
      await downloadFile(
        modelUrl(MODEL),
        whisperModelPath(),
        whisperModelSizeMb() * 1e6,
        (pct) => onProgress({ stage: 'downloading-model', percent: pct }),
        this.abort.signal
      )
    } finally {
      this.abort = null
    }
  }

  async resolve(
    songPath: string,
    durationSec: number,
    allowDownload: boolean,
    prefer: 'auto' | 'whisper' | 'align' | 'precise',
    onProgress: (p: LyricsProgress) => void
  ): Promise<LyricsResult> {
    if (this.busy) return { ok: false, error: 'A lyrics job is already running.' }

    onProgress({ stage: 'preparing', percent: 0 })
    const dir = await this.cacheDir(songPath)
    const lyricsPath = await this.lyricsFile(songPath)

    const cached = await this.readCache(lyricsPath)
    // Alignment refines existing online lyrics (re-running is fine — the
    // global aligner never reads the current timing); without them, auto.
    let alignBase: LyricsCache | null = null
    if (prefer === 'align' || prefer === 'precise') {
      if (cached?.source === 'lrclib') alignBase = cached
      else prefer = 'auto'
    }
    if (
      cached &&
      !alignBase &&
      (prefer === 'auto' || (prefer === 'whisper' && cached.source === 'whisper'))
    ) {
      // Whisper lyrics born during an LRCLIB outage (or before outages were
      // tracked) are provisional — ask again now, and either upgrade to
      // synced lyrics or settle the matter.
      if (prefer === 'auto' && shouldReaskLrclib(cached)) {
        log('lyrics', 'cached lyrics were transcribed while LRCLIB was unanswering — asking again')
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
          await this.writeCache(lyricsPath, { ...cached, lrclibPending: false })
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

    // 2) Fallback: on-device transcription of the vocals stem (project-local
    // stems first — v2 projects store FLAC — then the hash cache's WAVs)
    const isProject = (await projectLyricsPath(songPath)) !== null
    const vocalsCandidates = [
      ...(isProject
        ? [join(dirname(songPath), 'stems', 'vocals.flac'), join(dirname(songPath), 'stems', 'vocals.wav')]
        : []),
      join(dir, 'htdemucs', 'vocals.wav'),
      join(dir, 'htdemucs_6s', 'vocals.wav')
    ]
    let vocals = vocalsCandidates[vocalsCandidates.length - 1]
    for (const c of vocalsCandidates) {
      if (await exists(c)) {
        vocals = c
        break
      }
    }
    if (!(await exists(vocals))) {
      return { ok: false, error: 'Split the song into stems first — lyrics are read from the vocals track.' }
    }

    // Precise tier: CTC forced alignment through the torch splitter pack.
    if (prefer === 'precise' && alignBase) {
      return this.preciseAlign(
        vocals,
        alignBase,
        lyricsPath,
        join(dir, 'whisper-words.json'),
        durationSec,
        allowDownload,
        onProgress
      )
    }

    // A cached transcription makes re-align (e.g. after switching the lyrics
    // variant) instant — no second whisper run over the same song. The cache
    // remembers its model: words from `small` are superseded once the
    // stronger default model is available on disk.
    const wordsFile = join(dir, 'whisper-words.json')
    if (alignBase && (await exists(wordsFile))) {
      try {
        const raw = JSON.parse(await readFile(wordsFile, 'utf8')) as {
          model?: string
          words?: LyricWord[]
        }
        const words = raw.words ?? []
        const available = await bestAvailableModel()
        const fresher = available && raw.model && !available.includes(raw.model)
        const refCount = alignBase.lines.reduce((s, l) => s + l.words.length, 0)
        // a hallucinated cache (language-detect gone wrong) must not stick —
        // fall through and listen again instead of "mismatching" forever
        if (words.length > 0 && !fresher && transcriptionUsable(words, refCount)) {
          log('lyrics', `align: reusing cached transcription (${words.length} words, ${raw.model ?? '?'})`)
          return await this.finishAlign(alignBase, words, lyricsPath, durationSec)
        }
      } catch {
        // corrupt cache — fall through to a fresh transcription
      }
    }

    const engine = await resolveEngine()
    if (!engine) {
      return {
        ok: false,
        needsEngine: true,
        error: 'The transcription engine (whisper-cli) is missing from this build.'
      }
    }

    await migrateOldModel()
    let modelPath = await bestAvailableModel()
    if (!modelPath) {
      if (!allowDownload) {
        return {
          ok: false,
          needsModel: { sizeMb: whisperModelSizeMb(), what: 'speech' },
          error: 'No online lyrics found — transcribing needs the speech model.'
        }
      }
      this.cancelled = false
      try {
        await this.downloadModel(onProgress)
        modelPath = whisperModelPath()
      } catch (err) {
        if (this.cancelled) return { ok: false, cancelled: true, error: 'Cancelled.' }
        const msg = err instanceof Error ? err.message : String(err)
        return { ok: false, error: `Could not download the speech model: ${msg}` }
      }
    }
    const model = modelPath

    const outDir = join(dir, 'whisper-out')
    await mkdir(outDir, { recursive: true })
    this.cancelled = false

    return new Promise<LyricsResult>((resolve) => {
      const threads = Math.min(8, Math.max(2, cpus().length - 2))
      // Cross-attention DTW timestamps are noticeably tighter than the
      // default segment-split times; the preset must match the model.
      const dtwPreset = /large-v3-turbo/.test(model)
        ? 'large.v3.turbo'
        : /-(tiny|base|small|medium)\.bin$/.exec(model)?.[1]
      const args = [
        ...engine.slice(1),
        '-m',
        model,
        '-f',
        vocals,
        '-l',
        // whisper's auto-detect reads the first 30s — organ intros make it
        // hallucinate in a random language; the lyrics know better
        (alignBase && guessLanguage(alignBase.lines)) ?? 'auto',
        '-oj',
        '-of',
        join(outDir, 'vocals'),
        '-ml',
        '1',
        // no text context between 30s windows: carried context turns one bad
        // window into a whole-song hallucination loop on reverb-heavy vocals
        // (Mr. Crowley's organ intro), and singing has no cross-window
        // grammar worth keeping. Also makes decodes reproducible in practice.
        '-mc',
        '0',
        '--split-on-word',
        // DTW token timestamps need flash-attn off (silently disabled
        // otherwise); the accuracy is worth the ~30% slower decode.
        ...(dtwPreset ? ['-dtw', dtwPreset, '-nfa', '-ojf'] : []),
        '-t',
        String(threads)
      ]
      log('lyrics', `run: ${engine[0]} ${args.join(' ')}`)
      const child = spawn(engine[0], args, { env: spawnEnv() })
      this.child = child

      let tail = ''
      const consume = (chunk: Buffer): void => {
        const text = chunk.toString('utf8')
        tail = (tail + text).slice(-8000)
        // live lines: "[00:00:07.480 --> 00:00:07.600]  word"
        const m = [...text.matchAll(/-->\s+(\d+):(\d{2}):(\d{2})[.,]\d{1,3}\]/g)]
        if (m.length > 0 && durationSec > 0) {
          const last = m[m.length - 1]
          const t = parseInt(last[1], 10) * 3600 + parseInt(last[2], 10) * 60 + parseInt(last[3], 10)
          onProgress({ stage: 'transcribing', percent: Math.min(99, (t / durationSec) * 100) })
        }
      }
      child.stdout?.on('data', consume)
      child.stderr?.on('data', consume)

      child.on('error', (err) => {
        this.child = null
        void rm(outDir, { recursive: true, force: true })
        resolve({ ok: false, error: `Could not start whisper-cli: ${err.message}` })
      })

      child.on('exit', (code) => {
        this.child = null
        log('lyrics', `whisper-cli exited with code ${code}`)
        if (this.cancelled) {
          void rm(outDir, { recursive: true, force: true })
          resolve({ ok: false, cancelled: true, error: 'Cancelled.' })
          return
        }
        void (async () => {
          try {
            if (code !== 0) throw new Error(tail.split('\n').filter(Boolean).slice(-3).join(' — ').slice(0, 400))
            const raw = JSON.parse(await readFile(join(outDir, 'vocals.json'), 'utf8')) as {
              transcription?: {
                offsets?: { from?: number; to?: number }
                text?: string
                tokens?: { text?: string; t_dtw?: number }[]
              }[]
            }
            const words: LyricWord[] = []
            for (const seg of raw.transcription ?? []) {
              const w = String(seg.text ?? '').trim()
              if (!w || /^[[(♪]/.test(w)) continue
              // Segment offsets at segment heads are interpolated guesses
              // ("But I know So" all stamped alike); DTW token times track
              // the audio — prefer them when present (t_dtw centiseconds).
              const dtw = (seg.tokens ?? [])
                .filter((t) => !String(t.text ?? '').startsWith('[_'))
                .map((t) => t.t_dtw ?? -1)
                .filter((t) => t >= 0)
              // DTW attention peaks mid-vowel — pull starts back ~100ms
              // toward the true onset (legato songs otherwise trail).
              const s = dtw.length > 0 ? Math.max(0, dtw[0] / 100 - 0.1) : (seg.offsets?.from ?? 0) / 1000
              const eOff = (seg.offsets?.to ?? 0) / 1000
              const e = dtw.length > 0 ? Math.max(dtw[dtw.length - 1] / 100 + 0.05, s + 0.1) : eOff
              words.push({ w, s, e })
            }
            // keep the transcription — re-aligning another variant reuses it
            // (unless it collapsed into hallucination: never cache those, or
            // every later check would inherit the garbage instantly)
            if (transcriptionUsable(words, alignBase ? alignBase.lines.reduce((s, l) => s + l.words.length, 0) : 0)) {
              await writeFile(
                wordsFile,
                JSON.stringify({ model: basename(model, '.bin').replace(/^ggml-/, ''), words }),
                'utf8'
              )
            }
            if (alignBase) {
              await rm(outDir, { recursive: true, force: true })
              resolve(await this.finishAlign(alignBase, words, lyricsPath, durationSec))
              return
            }
            const lines = groupWords(words)
            await writeFile(
              lyricsPath,
              JSON.stringify({
                source: 'whisper',
                lines,
                // an outage is not a verdict — true makes a later open ask
                // LRCLIB again; false records that it really answered "miss"
                lrclibPending: lrclibDown
              } satisfies LyricsCache),
              'utf8'
            )
            await rm(outDir, { recursive: true, force: true })
            resolve({ ok: true, cached: false, source: 'whisper', lines })
          } catch (err) {
            await rm(outDir, { recursive: true, force: true })
            const msg = err instanceof Error ? err.message : String(err)
            log('lyrics', `transcription failed: ${msg}`, 'error')
            resolve({ ok: false, error: `Transcription failed: ${msg || 'unknown error'}` })
          }
        })()
      })
    })
  }

  /** Shared tail of the whisper align path: judge the fit, retime, cache. */
  private async finishAlign(
    alignBase: LyricsCache,
    words: LyricWord[],
    lyricsPath: string,
    durationSec: number
  ): Promise<LyricsResult> {
    const refCount = alignBase.lines.reduce((s, l) => s + l.words.length, 0)
    if (!transcriptionUsable(words, refCount)) {
      // hallucinated/collapsed transcription — evidence of nothing; a
      // "mismatch" here would slander perfectly good lyrics
      return {
        ok: false,
        error:
          'Could not make out the vocals well enough to check the words. Precise alignment may still work.'
      }
    }
    const { lines, check } = alignToTranscription(alignBase.lines, words, durationSec)
    log(
      'lyrics',
      `align: ${check.verdict} — ${check.matchedPct}% words heard, median shift ${check.medianShift}s, ${check.badLines.length} off lines`
    )
    if (check.verdict === 'mismatch') {
      // Do not touch the cached lyrics — the text is not what is being sung.
      return {
        ok: true,
        cached: false,
        source: 'lrclib',
        credit: alignBase.credit,
        aligned: alignBase.aligned,
        check,
        lines: alignBase.lines
      }
    }
    const cache: LyricsCache = {
      source: 'lrclib',
      credit: alignBase.credit,
      aligned: true,
      check,
      lines
    }
    await writeFile(lyricsPath, JSON.stringify(cache), 'utf8')
    return { ok: true, cached: false, source: 'lrclib', credit: alignBase.credit, aligned: true, check, lines }
  }

  /** CTC forced alignment via the torch splitter pack (word-level, scored). */
  private async preciseAlign(
    vocals: string,
    alignBase: LyricsCache,
    lyricsPath: string,
    wordsFile: string,
    durationSec: number,
    allowDownload: boolean,
    onProgress: (p: LyricsProgress) => void
  ): Promise<LyricsResult> {
    if (!(await preciseCapable())) {
      return {
        ok: false,
        error: 'Precise alignment runs through the splitter pack — install it in the model manager first.'
      }
    }
    if (!(await exists(mmsModelPath()))) {
      if (!allowDownload) {
        return {
          ok: false,
          needsModel: { sizeMb: mmsModelMb(), what: 'aligner' },
          error: 'Precise alignment needs the multilingual aligner model.'
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
        if (this.cancelled) return { ok: false, cancelled: true, error: 'Cancelled.' }
        const msg = err instanceof Error ? err.message : String(err)
        return { ok: false, error: `Could not download the aligner model: ${msg}` }
      } finally {
        this.abort = null
      }
    }

    this.cancelled = false
    onProgress({ stage: 'transcribing', percent: 0 })
    try {
      const run = await runMmsAlign(vocals, alignBase.lines, onProgress)
      this.child = run.child
      const ctcWords = await run.done
      const outcome = ctcOutcome(alignBase.lines, ctcWords, durationSec)
      let { check } = outcome
      const { lines } = outcome
      // CTC scores cannot tell wrong text from hard vocals on singing — when
      // a whisper transcription is cached, its text check is authoritative.
      try {
        const raw = JSON.parse(await readFile(wordsFile, 'utf8')) as
          | { words?: LyricWord[] }
          | LyricWord[]
        const words = Array.isArray(raw) ? raw : (raw.words ?? [])
        const refCount = alignBase.lines.reduce((s, l) => s + l.words.length, 0)
        if (words.length > 0 && transcriptionUsable(words, refCount) && check.verdict !== 'mismatch') {
          const textCheck = alignToTranscription(alignBase.lines, words, durationSec).check
          check = { ...textCheck, method: 'ctc', medianShift: check.medianShift }
        }
      } catch {
        // no transcription cached — the CTC-relative check stands alone
      }
      log(
        'lyrics',
        `precise align: ${check.verdict} — ${check.matchedPct}% words heard, median shift ${check.medianShift}s`
      )
      if (check.verdict === 'mismatch') {
        return {
          ok: true,
          cached: false,
          source: 'lrclib',
          credit: alignBase.credit,
          aligned: alignBase.aligned,
          check,
          lines: alignBase.lines
        }
      }
      const cache: LyricsCache = {
        source: 'lrclib',
        credit: alignBase.credit,
        aligned: true,
        check,
        lines
      }
      await writeFile(lyricsPath, JSON.stringify(cache), 'utf8')
      return { ok: true, cached: false, source: 'lrclib', credit: alignBase.credit, aligned: true, check, lines }
    } catch (err) {
      if (this.cancelled) return { ok: false, cancelled: true, error: 'Cancelled.' }
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: `Precise alignment failed: ${msg}` }
    } finally {
      this.child = null
    }
  }

  cancel(): void {
    this.cancelled = true
    this.abort?.abort()
    this.child?.kill('SIGTERM')
  }
}

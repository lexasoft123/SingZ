import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { cpus } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { LyricLine, LyricWord, LyricsProgress, LyricsResult, LyricsSource } from '../shared/types'
import { lookupLyrics, lyricsById, metaFromFilename, type TrackMeta } from './lrclib'
import { stemsRoot } from './media'
import { log } from './log'
import { downloadFile, modelsDir } from './models'
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
  lines: LyricLine[]
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  const m = a.length
  const n = b.length
  if (m === 0 || n === 0) return Math.max(m, n)
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[n]
}

const normWord = (w: string): string => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '')

function wordsMatch(a: string, b: string): boolean {
  const na = normWord(a)
  const nb = normWord(b)
  if (!na || !nb) return false
  if (na === nb) return true
  return Math.min(na.length, nb.length) >= 4 && levenshtein(na, nb) <= 1
}

/**
 * Snap known-correct lyrics onto whisper's word timestamps: per line, anchor
 * matching words to their recognized times and interpolate the rest. Lines
 * where recognition failed keep their estimated timing.
 */
function alignLines(ref: LyricLine[], hypRaw: LyricWord[]): LyricLine[] {
  // whisper.cpp occasionally emits zero/backward offsets — sanitize first.
  const hyp: LyricWord[] = []
  let lastS = 0
  for (const w of hypRaw) {
    let e = w.e
    if (!(e > w.s)) e = w.s + 0.15
    if (w.s < lastS - 0.5) continue
    lastS = Math.max(lastS, w.s)
    hyp.push({ w: w.w, s: w.s, e })
  }
  return ref.map((line) => {
    const est = line.end - line.start
    const windowWords = hyp.filter((w) => w.s >= line.start - 4 && w.s <= line.start + est + 8)
    if (windowWords.length === 0) return line

    const anchors: { i: number; s: number; e: number }[] = []
    let cursor = 0
    line.words.forEach((rw, i) => {
      for (let j = cursor; j < windowWords.length; j++) {
        if (wordsMatch(rw.w, windowWords[j].w)) {
          anchors.push({ i, s: windowWords[j].s, e: windowWords[j].e })
          cursor = j + 1
          break
        }
      }
    })
    if (anchors.length < Math.max(2, Math.ceil(line.words.length * 0.4))) return line

    const words: LyricWord[] = line.words.map((w) => ({ ...w }))
    for (const a of anchors) {
      words[a.i].s = a.s
      words[a.i].e = a.e
    }
    // interpolate the unanchored words between neighbouring anchors
    const rate = 12 // chars/sec fallback for edges
    const first = anchors[0]
    let t = first.s
    for (let i = first.i - 1; i >= 0; i--) {
      const dur = Math.max(0.12, (words[i].w.length + 1) / rate)
      words[i].e = t
      words[i].s = Math.max(line.start - 2, t - dur)
      t = words[i].s
    }
    for (let k = 0; k < anchors.length - 1; k++) {
      const a = anchors[k]
      const b = anchors[k + 1]
      const between = words.slice(a.i + 1, b.i)
      const total = between.reduce((sum, w) => sum + w.w.length + 1, 0)
      let cur = a.e
      const spanT = Math.max(0, b.s - a.e)
      for (const w of between) {
        const dur = total > 0 ? (spanT * (w.w.length + 1)) / total : 0
        w.s = cur
        w.e = cur + dur
        cur = w.e
      }
    }
    const last = anchors[anchors.length - 1]
    let t2 = last.e
    for (let i = last.i + 1; i < words.length; i++) {
      const dur = Math.max(0.12, (words[i].w.length + 1) / rate)
      words[i].s = t2
      words[i].e = t2 + dur
      t2 = words[i].e
    }
    // Validate: reject the alignment when it came out non-monotonic (bad
    // anchors across repeated phrases), then enforce clean word ordering.
    const sane = words.every(
      (w, i) => w.e >= w.s && (i === 0 || w.s >= words[i - 1].s - 0.01)
    )
    if (!sane) return line
    for (let i = 1; i < words.length; i++) {
      if (words[i].s < words[i - 1].e - 0.01) words[i].s = words[i - 1].e
      if (words[i].e < words[i].s + 0.05) words[i].e = words[i].s + 0.05
    }
    return { ...line, start: words[0].s, end: words[words.length - 1].e, words }
  })
}

async function readTrackMeta(songPath: string, durationSec: number): Promise<TrackMeta> {
  const fromName = metaFromFilename(basename(songPath))
  try {
    const mm = await import('music-metadata')
    const parsed = await mm.parseFile(songPath, { duration: false })
    const title = parsed.common.title?.trim()
    const cleaned = title ? metaFromFilename(title) : null
    return {
      artist: parsed.common.artist?.trim() || cleaned?.artist || fromName.artist,
      title: cleaned?.title || fromName.title,
      album: parsed.common.album?.trim(),
      durationSec
    }
  } catch {
    return { ...fromName, durationSec }
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
      return { source: raw.source ?? 'whisper', credit: raw.credit, lines: raw.lines }
    } catch {
      return null
    }
  }

  private async writeCache(file: string, cache: LyricsCache): Promise<void> {
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, JSON.stringify(cache), 'utf8')
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
    prefer: 'auto' | 'whisper' | 'align',
    onProgress: (p: LyricsProgress) => void
  ): Promise<LyricsResult> {
    if (this.busy) return { ok: false, error: 'A lyrics job is already running.' }

    onProgress({ stage: 'preparing', percent: 0 })
    const dir = await this.cacheDir(songPath)
    const lyricsPath = await this.lyricsFile(songPath)

    const cached = await this.readCache(lyricsPath)
    // Alignment refines existing online lyrics; without them, behave like auto.
    let alignBase: LyricsCache | null = null
    if (prefer === 'align') {
      if (cached?.source === 'lrclib' && !cached.aligned) alignBase = cached
      else prefer = cached?.source === 'lrclib' ? 'auto' : 'auto'
    }
    if (
      cached &&
      !alignBase &&
      (prefer === 'auto' || (prefer === 'whisper' && cached.source === 'whisper'))
    ) {
      log('lyrics', `using cached lyrics for ${basename(songPath)} (${cached.source}${cached.aligned ? ', aligned' : ''}) from ${lyricsPath}`)
      return {
        ok: true,
        cached: true,
        source: cached.source,
        credit: cached.credit,
        aligned: cached.aligned,
        lines: cached.lines
      }
    }

    // 1) Online synced lyrics (no stems, no model needed)
    if (prefer === 'auto' && !alignBase) {
      onProgress({ stage: 'searching', percent: 10 })
      const meta = await readTrackMeta(songPath, durationSec)
      log('lyrics', `LRCLIB search: ${meta.artist ?? '?'} — ${meta.title ?? '?'} (${Math.round(durationSec)}s)`)
      const hit = await lookupLyrics(meta)
      if (hit) {
        log('lyrics', `LRCLIB hit: ${hit.credit ?? 'synced lyrics'}`)
        await this.writeCache(lyricsPath, { source: 'lrclib', credit: hit.credit, lines: hit.lines })
        return { ok: true, cached: false, source: 'lrclib', credit: hit.credit, lines: hit.lines }
      }
      log('lyrics', 'LRCLIB: no match')
    }

    // 2) Fallback: on-device transcription of the vocals stem (project-local
    // stems first, then the hash cache)
    let vocals = join(dirname(songPath), 'stems', 'vocals.wav')
    if (!(await projectLyricsPath(songPath)) || !(await exists(vocals))) {
      vocals = join(dir, 'htdemucs', 'vocals.wav')
    }
    if (!(await exists(vocals))) {
      return { ok: false, error: 'Split the song into stems first — lyrics are read from the vocals track.' }
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
          needsModel: { sizeMb: whisperModelSizeMb() },
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
      const args = [
        ...engine.slice(1),
        '-m',
        model,
        '-f',
        vocals,
        '-l',
        'auto',
        '-oj',
        '-of',
        join(outDir, 'vocals'),
        '-ml',
        '1',
        '--split-on-word',
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
              transcription?: { offsets?: { from?: number; to?: number }; text?: string }[]
            }
            const words: LyricWord[] = []
            for (const seg of raw.transcription ?? []) {
              const w = String(seg.text ?? '').trim()
              if (!w || /^[[(♪]/.test(w)) continue
              words.push({ w, s: (seg.offsets?.from ?? 0) / 1000, e: (seg.offsets?.to ?? 0) / 1000 })
            }
            if (alignBase) {
              const lines = alignLines(alignBase.lines, words)
              log('lyrics', `aligned ${lines.length} lines against ${words.length} transcribed words`)
              const cache: LyricsCache = {
                source: 'lrclib',
                credit: alignBase.credit,
                aligned: true,
                lines
              }
              await writeFile(lyricsPath, JSON.stringify(cache), 'utf8')
              await rm(outDir, { recursive: true, force: true })
              resolve({
                ok: true,
                cached: false,
                source: 'lrclib',
                credit: alignBase.credit,
                aligned: true,
                lines
              })
              return
            }
            const lines = groupWords(words)
            await writeFile(
              lyricsPath,
              JSON.stringify({ source: 'whisper', lines } satisfies LyricsCache),
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

  cancel(): void {
    this.cancelled = true
    this.abort?.abort()
    this.child?.kill('SIGTERM')
  }
}

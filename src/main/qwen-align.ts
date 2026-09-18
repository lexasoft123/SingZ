import { app } from 'electron'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LyricLine } from '../shared/types'
import { type Anchor } from './align'
import { log } from './log'
import { onChildSettled } from './child-exit'
import { spawnEnv } from './separation'
import { qwenAlignerPath } from './models'
import { chunkToWav, type ChunkPlan } from './vocal-chunks'

/**
 * Word timing without whisper: Qwen3-ForcedAligner-0.6B places lyrics we
 * already have against the audio, one sung chunk at a time.
 *
 * Measured over the catalog on 2026-09-17, against the Precise/MMS times the
 * app stores, and against whisper's own tier-1 timing:
 *
 *                        signed   |Δ| med   ≤0.10   onsets ≤0.15
 *   whisper tier-1       +0.17 s   0.19 s     30%        45%
 *   this, chunked        −0.04 s   0.08 s     55%        65%
 *   Precise (MMS)        −0.01 s      —         —        86%
 *
 * Two facts shape the code:
 *
 *  1. It must never see a whole song. Handed one, it drifts through every
 *     instrumental stretch — Highway Star came out 35 s off at the median,
 *     Mein Teil 19.7 s — because unlike MMS it has no way to park text
 *     through audio nobody sings over. Chunked to the sung stretches the same
 *     songs land at 0.62 s and 0.14 s.
 *  2. Its answers are ANCHORS, not gospel. Placing a word depends on the
 *     chunk it was assigned to being the right one, and on a song where the
 *     recogniser heard little (Sixteen Tons: 55% of words anchored) that
 *     assignment is often wrong. Feeding the placements through `retime` lets
 *     the lyrics' own phrasing carry the words the aligner could not support,
 *     which is exactly what whisper's tier does with its own sparse anchors.
 */

const EXE = process.platform === 'win32' ? 'crispasr.exe' : 'crispasr'

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Bundled-first, like every other engine here. */
export async function resolveQwenAligner(): Promise<string | null> {
  if (process.env.SINGZ_CRISPASR) return process.env.SINGZ_CRISPASR
  const target = `${process.platform}-${process.arch}`
  for (const c of [
    join(process.resourcesPath ?? '', 'engines', EXE),
    join(import.meta.dirname, '..', '..', 'vendor', target, EXE),
    join(app.getAppPath(), 'vendor', target, EXE)
  ]) {
    if (c && (await exists(c))) return c
  }
  return null
}

export async function qwenAlignerAvailable(): Promise<boolean> {
  return (await resolveQwenAligner()) !== null && (await exists(qwenAlignerPath()))
}

/** One word, as the runtime reports it: seconds inside the chunk it was given. */
interface PlacedWord {
  word: string
  start: number
  end: number
}

/**
 * Which chunk each lyric word belongs to, taken from where the recogniser
 * heard it. Words nobody heard ride with their nearest heard neighbour, which
 * keeps a line together even when half of it was mumbled.
 */
export function assignWordsToChunks(
  totalWords: number,
  anchorChunk: Map<number, number>
): number[] {
  const out = new Array<number>(totalWords).fill(-1)
  for (const [flatIndex, chunk] of anchorChunk) out[flatIndex] = chunk
  for (let k = 0; k < out.length; k++) {
    if (out[k] !== -1) continue
    let before = -1
    let after = -1
    for (let i = k - 1; i >= 0; i--) {
      if (out[i] !== -1) {
        before = out[i]
        break
      }
    }
    for (let i = k + 1; i < out.length; i++) {
      if (out[i] !== -1) {
        after = out[i]
        break
      }
    }
    out[k] = before >= 0 ? before : after >= 0 ? after : 0
  }
  return out
}

/**
 * Run the aligner over one chunk's words. Returns null rather than throwing:
 * a chunk that fails to align is a chunk whose words stay unanchored, which
 * `retime` already knows how to carry.
 */
function alignChunk(
  exe: string,
  aligner: string,
  wav: string,
  words: string[],
  language: string,
  out: string,
  signal?: AbortSignal
): Promise<PlacedWord[] | null> {
  return new Promise((resolve) => {
    const args = [
      '--align-only',
      '-am', aligner,
      '-f', wav,
      '--ref-text', words.join(' '),
      '-l', language,
      '--align-format', 'json',
      '--align-output', out
    ]
    const child = spawn(exe, args, { env: spawnEnv() })
    const onAbort = (): void => {
      child.kill('SIGTERM')
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    let tail = ''
    const note = (c: Buffer): void => {
      tail = (tail + c.toString('utf8')).slice(-2000)
    }
    child.stdout?.on('data', note)
    child.stderr?.on('data', note)
    child.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort)
      log('lyrics', `align: could not start the word aligner: ${err.message}`, 'error')
      resolve(null)
    })
    onChildSettled(child, 'lyrics', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (code !== 0) {
        const why = tail.split('\n').filter(Boolean).slice(-2).join(' — ')
        log('lyrics', `align: the word aligner exited ${code}${why ? `: ${why}` : ''}`, 'warn')
        resolve(null)
        return
      }
      void (async () => {
        try {
          const placed = JSON.parse(await readFile(out, 'utf8')) as PlacedWord[]
          // the runtime splits the reference on whitespace, so a different
          // count means we are not looking at the words we asked about
          resolve(placed.length === words.length ? placed : null)
        } catch {
          resolve(null)
        }
      })()
    })
  })
}

/**
 * Place the words of `ref` against the vocals, chunk by chunk, and return them
 * as anchors for `retime`. `chunkOfWord` says which chunk each flat word index
 * belongs to (see assignWordsToChunks).
 */
export async function alignWordsInChunks(
  pcm: Float32Array,
  chunks: ChunkPlan[],
  ref: LyricLine[],
  chunkOfWord: number[],
  /**
   * Lines the recogniser could not hear (the app's existing rule: a line with
   * three or more words of which under 40% matched). Their placements are
   * discarded — the aligner answers confidently wherever it is pointed, so
   * its own output cannot say "I was given the wrong audio", and a line the
   * recogniser missed is exactly the line whose chunk is a guess. Measured on
   * a song every engine mishears: dropping them took the median error from
   * 0.57 s to 0.44 s and words within half a second from 47% to 56%.
   */
  untrustedLines: ReadonlySet<number>,
  language: string,
  onProgress: (pct: number) => void,
  signal?: AbortSignal
): Promise<Anchor[]> {
  const exe = await resolveQwenAligner()
  if (!exe) throw new Error('The word aligner is missing from this build.')
  const model = qwenAlignerPath()
  if (!(await exists(model))) throw new Error('The word aligner model is not installed.')

  const flat = ref.flatMap((l, li) => l.words.map((w, wi) => ({ li, wi, w: w.w })))
  const scratch = await mkdtemp(join(tmpdir(), 'singz-align-'))
  const anchors: Anchor[] = []
  try {
    for (let ci = 0; ci < chunks.length; ci++) {
      if (signal?.aborted) throw new Error('Cancelled.')
      const mine = flat.filter((_, k) => chunkOfWord[k] === ci)
      if (mine.length === 0) continue
      const wav = join(scratch, `c${ci}.wav`)
      const out = join(scratch, `c${ci}.json`)
      await writeFile(wav, chunkToWav(pcm, chunks[ci]))
      const placed = await alignChunk(
        exe,
        model,
        wav,
        mine.map((w) => w.w.replace(/\s+/g, '')),
        language,
        out,
        signal
      )
      onProgress(((ci + 1) / chunks.length) * 100)
      if (!placed) {
        log('lyrics', `align: chunk ${ci} did not place its ${mine.length} words`, 'warn')
        continue
      }
      placed.forEach((p, i) => {
        if (untrustedLines.has(mine[i].li)) return
        const at = chunks[ci].start
        anchors.push({
          li: mine[i].li,
          wi: mine[i].wi,
          s: at + p.start,
          e: at + Math.max(p.end, p.start + 0.05),
          sim: 1
        })
      })
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
  return anchors
}

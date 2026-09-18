import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { log } from './log'
import { onChildSettled } from './child-exit'
import { spawnEnv } from './separation'
import { qwenMmprojPath, qwenModelPath } from './models'
import { chunkToWav, type ChunkPlan } from './vocal-chunks'
import type { LyricLine } from '../shared/types'

/**
 * Qwen3-ASR (1.7B, Apache-2.0) through llama.cpp's `llama-server`.
 *
 * Why a second engine at all — measured over the whole catalog on 2026-09-17,
 * against whisper large-v3-turbo with the app's own flags:
 *
 *                     with lyrics        no lyrics       junk phrases
 *   whisper turbo     WER 0.211          WER 0.278       55
 *   Qwen3-ASR 1.7B    WER 0.162          WER 0.167        0
 *
 * and it is FASTER where it matters least on this Mac but most in the field:
 * on the Windows field laptop (4-core Haswell, no usable GPU — llama.cpp's
 * Vulkan build wants 1.2, that machine's driver caps at 1.1) Qwen runs at
 * 0.82x real time against whisper's 1.91x.
 *
 * Three things about this port are load-bearing, all found by measurement:
 *
 *  1. llama.cpp returns an EMPTY transcription past roughly two minutes of
 *     audio in one call, so everything goes through `vocal-chunks`.
 *  2. The 1.7B GGUF's own language LABEL is unreliable — German singing comes
 *     back labelled "English" with perfectly good German text — so the label
 *     never decides anything except "None", which reliably means no singing.
 *  3. Forcing a language on a chunk with no real singing makes it loop
 *     ("oh, oh, oh, …") until it runs out of tokens. The auto answer for the
 *     same chunk is empty, so a looping forced decode falls back to it.
 */

const EXE = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
/** Health poll budget — a cold model load on a slow disk is minutes, not seconds. */
const START_TIMEOUT_MS = 180_000
const HEALTH_POLL_MS = 500

export interface QwenChunkText {
  start: number
  end: number
  text: string
  /** What the model called the language; "None" means it heard no speech. */
  label: string | null
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Bundled-first, exactly like the whisper engine: resources → dev vendor → env. */
export async function resolveQwenServer(): Promise<string | null> {
  if (process.env.SINGZ_LLAMA_SERVER) return process.env.SINGZ_LLAMA_SERVER
  const target = `${process.platform}-${process.arch}`
  const candidates = [
    join(process.resourcesPath ?? '', 'engines', EXE),
    join(import.meta.dirname, '..', '..', 'vendor', target, EXE),
    join(app.getAppPath(), 'vendor', target, EXE)
  ]
  for (const c of candidates) {
    if (c && (await exists(c))) return c
  }
  return null
}

/** Engine binary and both model files present. */
export async function qwenAvailable(): Promise<boolean> {
  return (
    (await resolveQwenServer()) !== null &&
    (await exists(qwenModelPath())) &&
    (await exists(qwenMmprojPath()))
  )
}

/** A port nobody is listening on, asked of the OS rather than guessed. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => (port ? resolve(port) : reject(new Error('no free port'))))
    })
  })
}

/**
 * A decode that ran out of tokens, or repeats one 1-3 word pattern 8+ times
 * over (nine or more of the same word in a row). A real "na na na" outro sits
 * below that; the runaway this catches goes on for dozens.
 */
export function looksLooped(text: string, finish: string | null): boolean {
  if (finish === 'length') return true
  const toks = text
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}']/gu, ''))
    .filter(Boolean)
  for (const n of [1, 2, 3]) {
    let run = 0
    for (let i = n; i < toks.length; i++) {
      if (toks[i] === toks[i - n]) {
        if (++run >= 8 * n) return true
      } else {
        run = 0
      }
    }
  }
  return false
}

/** The language most of the singing was called, by duration; null if none was. */
export function majorityLanguage(chunks: QwenChunkText[]): string | null {
  const weight = new Map<string, number>()
  for (const c of chunks) {
    if (!c.label || c.label === 'None') continue
    weight.set(c.label, (weight.get(c.label) ?? 0) + (c.end - c.start))
  }
  return [...weight.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
}

/**
 * Chunk texts into karaoke lines, with PROVISIONAL timing: the model returns
 * words but no times, so a line is spread evenly across its share of the
 * chunk it came from. Good enough to draw and to hand to a forced aligner,
 * which is what replaces these times with real ones.
 *
 * Lines break at sentence punctuation and at ten words, the same shape
 * `groupWords` gives whisper's output, so the two engines produce lyrics that
 * look alike on screen.
 */
export function linesFromChunks(chunks: QwenChunkText[]): LyricLine[] {
  const lines: LyricLine[] = []
  for (const chunk of chunks) {
    const words = chunk.text.split(/\s+/).filter(Boolean)
    if (words.length === 0) continue
    const groups: string[][] = []
    let cur: string[] = []
    for (const w of words) {
      cur.push(w)
      if (cur.length >= 10 || /[.!?]$/.test(w)) {
        groups.push(cur)
        cur = []
      }
    }
    if (cur.length > 0) groups.push(cur)
    const span = Math.max(0.1, chunk.end - chunk.start)
    const total = groups.reduce((s, g) => s + g.length, 0)
    let at = chunk.start
    for (const group of groups) {
      const dur = (span * group.length) / total
      const per = dur / group.length
      const lineWords = group.map((w, i) => ({ w, s: at + i * per, e: at + (i + 1) * per }))
      lines.push({
        start: at,
        end: at + dur,
        text: group.join(' '),
        words: lineWords
      })
      at += dur
    }
  }
  return lines
}

/**
 * One `llama-server` for the length of a transcription. It is started per job
 * rather than kept warm: a 2 GB model resident for a session the singer may
 * never ask about lyrics in is not a trade worth making, and a cold start is
 * a few seconds against a job measured in minutes.
 */
export class QwenServer {
  private child: ChildProcess | null = null
  private port = 0
  private stopped = false
  private tail = ''

  get running(): boolean {
    return this.child !== null
  }

  async start(): Promise<void> {
    const exe = await resolveQwenServer()
    if (!exe) throw new Error('The transcription engine (llama-server) is missing from this build.')
    const model = qwenModelPath()
    const mmproj = qwenMmprojPath()
    if (!(await exists(model)) || !(await exists(mmproj))) {
      throw new Error('The Qwen speech model is not installed.')
    }
    this.port = await freePort()
    const args = [
      '-m', model,
      '--mmproj', mmproj,
      '--host', '127.0.0.1',
      '--port', String(this.port),
      // one job at a time; 16k covers a 30 s chunk's audio tokens with room over
      '-c', '16384',
      '--parallel', '1',
      '--no-webui'
    ]
    log('lyrics', `qwen: ${exe} ${args.join(' ')}`)
    const child = spawn(exe, args, { env: spawnEnv() })
    this.child = child
    child.stdout?.on('data', (c: Buffer) => this.note(c))
    child.stderr?.on('data', (c: Buffer) => this.note(c))
    child.on('error', (err) => {
      this.child = null
      log('lyrics', `qwen: could not start llama-server: ${err.message}`, 'error')
    })
    onChildSettled(child, 'lyrics', (code) => {
      this.child = null
      if (!this.stopped) log('lyrics', `qwen: llama-server exited with code ${code}`, 'warn')
    })
    await this.waitHealthy()
  }

  private note(chunk: Buffer): void {
    this.tail = (this.tail + chunk.toString('utf8')).slice(-4000)
  }

  private async waitHealthy(): Promise<void> {
    const deadline = Date.now() + START_TIMEOUT_MS
    for (;;) {
      if (this.stopped) throw new Error('Cancelled.')
      if (!this.child) {
        const why = this.tail.split('\n').filter(Boolean).slice(-2).join(' — ')
        throw new Error(`llama-server stopped before it was ready${why ? `: ${why}` : ''}`)
      }
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/health`)
        if (res.ok) return
      } catch {
        // not listening yet
      }
      if (Date.now() > deadline) throw new Error('llama-server did not become ready in time.')
      await new Promise((r) => setTimeout(r, HEALTH_POLL_MS))
    }
  }

  /**
   * One chunk. `language` null asks the model to decide (and to answer "None"
   * when nobody sings); a name forces it.
   */
  private async ask(
    wav: Buffer,
    seconds: number,
    language: string | null,
    signal?: AbortSignal
  ): Promise<{ text: string; label: string | null; finish: string | null }> {
    const messages: unknown[] = [
      { role: 'system', content: '' },
      {
        role: 'user',
        content: [
          { type: 'input_audio', input_audio: { data: wav.toString('base64'), format: 'wav' } }
        ]
      }
    ]
    if (language) messages.push({ role: 'assistant', content: `language ${language}<asr_text>` })
    const res = await fetch(`http://127.0.0.1:${this.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages,
        temperature: 0,
        // sung words run ~4/s; 8/s plus a floor bounds a loop without clipping a real line
        max_tokens: Math.ceil(seconds * 8) + 20,
        cache_prompt: false
      }),
      signal
    })
    if (!res.ok) throw new Error(`llama-server answered HTTP ${res.status}`)
    const body = (await res.json()) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[]
    }
    const raw = body.choices?.[0]?.message?.content ?? ''
    const label = /language\s+([A-Za-z]+)\s*<asr_text>/.exec(raw)?.[1] ?? null
    return {
      text: raw.replace(/^[\s\S]*<asr_text>/, '').trim(),
      label,
      finish: body.choices?.[0]?.finish_reason ?? null
    }
  }

  /**
   * Every chunk, in two phases.
   *
   * Phase one asks each chunk with nothing forced: that is the only way to
   * learn "None" (no singing here), and its text is the fallback for phase
   * two. Phase two forces the song's language on the chunks that disagreed
   * with it — a disagreement is usually this port's wrong label rather than
   * the song switching language, and forcing recovers the text either way.
   * `language` is the language the lyrics are in when we know it; without
   * lyrics the song's own majority answer stands in.
   */
  async transcribe(
    pcm: Float32Array,
    chunks: ChunkPlan[],
    language: string | null,
    onProgress: (pct: number) => void,
    signal?: AbortSignal
  ): Promise<QwenChunkText[]> {
    const out: QwenChunkText[] = []
    for (const [i, chunk] of chunks.entries()) {
      if (signal?.aborted) throw new Error('Cancelled.')
      const auto = await this.ask(chunkToWav(pcm, chunk), chunk.end - chunk.start, null, signal)
      out.push({
        start: chunk.start,
        end: chunk.end,
        text: auto.label === 'None' || looksLooped(auto.text, auto.finish) ? '' : auto.text,
        label: auto.label
      })
      // phase two is at most one more call per chunk, so bank half the bar here
      onProgress(((i + 1) / chunks.length) * 50)
    }

    const want = language ?? majorityLanguage(out)
    const retry = want
      ? out.map((c, i) => ({ c, i })).filter(({ c }) => c.label && c.label !== 'None' && c.label !== want)
      : []
    if (want && retry.length > 0) {
      log('lyrics', `qwen: re-asking ${retry.length} of ${chunks.length} chunks as ${want}`)
    }
    for (const [n, { c, i }] of retry.entries()) {
      if (signal?.aborted) throw new Error('Cancelled.')
      const forced = await this.ask(chunkToWav(pcm, chunks[i]), c.end - c.start, want, signal)
      if (!looksLooped(forced.text, forced.finish)) out[i] = { ...c, text: forced.text }
      onProgress(50 + ((n + 1) / retry.length) * 50)
    }
    onProgress(100)
    return out
  }

  stop(): void {
    this.stopped = true
    this.child?.kill('SIGTERM')
    this.child = null
  }
}

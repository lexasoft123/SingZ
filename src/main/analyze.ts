import { BrowserWindow, ipcMain } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { onChildSettled } from './child-exit'
import { log, logChunk } from './log'
import { isAllowed } from './media'

/**
 * The desktop's way into the C++ core: singz-analyze, spawned like
 * whisper-cli (docs/PHONE-STANDALONE.md, Phase 4c). Melody first — the
 * smallest detector and the one whose input already comes as a file path.
 *
 * The renderer decides whether to USE the result: the CLI reports the core's
 * kPitchDetectVersion, and prepMelody compares it against its own
 * PITCH_DETECT_VERSION, falling back to the in-app tracker — loudly — on any
 * mismatch. That check is what makes a stale vendored binary a visible
 * downgrade instead of a silent one: a binary from before a stamp bump would
 * otherwise write old-framing lines under whatever stamp it carries, which is
 * the melody bug's shape all over again. Main does not import renderer code,
 * so the constant cannot be checked here.
 */

const EXE = process.platform === 'win32' ? 'singz-analyze.exe' : 'singz-analyze'
/** A melody is ~1 s per 3 song-minutes on the slowest fleet CPU measured —
 *  minutes never; this is a hang catcher, not a budget. */
const TIMEOUT_MS = 120_000

export interface MelodyNativeResult {
  ok: boolean
  error?: string
  f0?: Float32Array
  raw?: Float32Array
  rms?: Float32Array
  hopSec?: number
  detVersion?: number
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Bundled-first resolution — the same ladder as whisper-cli's resolveEngine:
 *  packaged resources → dev vendor dir → env override. */
export async function resolveAnalyze(): Promise<string | null> {
  if (process.env.SINGZ_ANALYZE) return process.env.SINGZ_ANALYZE
  const target = `${process.platform}-${process.arch}`
  const candidates = [
    join(process.resourcesPath ?? '', 'engines', EXE),
    // dev: this module lives at <root>/out/main — vendor sits at the project root
    join(import.meta.dirname, '..', '..', 'vendor', target, EXE)
  ]
  for (const c of candidates) {
    if (c && (await exists(c))) return c
  }
  return null
}

interface CliMelody {
  detVersion: number
  hopSec: number
  f0: number[]
  raw: number[]
  rms: number[]
}

/** ONE combined job at a time — melody, key and beats run inside a single
 *  child now, so the per-kind slots this class used to keep are gone with
 *  the per-detector jobs. Cancellable; the renderer's loadSeq decides whose
 *  result counts, this only makes sure a dead song's child dies too.
 *
 *  The spawn gate exists for a measured race: analyze:ml can be DISPATCHED
 *  microseconds after analyze:run (the stored-melody re-track path has its
 *  lattice in hand already), while analyzeAll is still suspended on
 *  resolveAnalyze's threadpool access() — the map lookup found no child and
 *  the lattice was silently dropped, leaving the child on stdin until the
 *  hang catcher shot it at 120 s. The gate is created SYNCHRONOUSLY at
 *  analyzeAll entry, so the paired provideMl always has something real to
 *  await. Gates pair BY TOKEN, not by slot: a refused call gets its own
 *  'busy' gate without touching the running owner's — one shared slot let a
 *  mid-pass Re-detect refusal overwrite the owner's gate and starve its
 *  provideMl (child on stdin until the 240 s catcher). The map is bounded
 *  because refused melody/key-only runs never call provideMl to clean up. */
class Analyze {
  private children = new Map<string, ChildProcess>()
  private spawnGates = new Map<string, Promise<{ child: ChildProcess } | 'busy' | 'failed'>>()
  private setGate(token: string, gate: Promise<{ child: ChildProcess } | 'busy' | 'failed'>): void {
    this.spawnGates.set(token, gate)
    while (this.spawnGates.size > 8) {
      const oldest = this.spawnGates.keys().next().value
      if (oldest === undefined) break
      this.spawnGates.delete(oldest)
    }
  }
  private analyzeTimer: ReturnType<typeof setTimeout> | null = null
  private analyzeTimedOut: { why: string; ms: number } | null = null
  private armAnalyzeTimer(child: ChildProcess, why: string, ms: number): void {
    if (this.analyzeTimer) clearTimeout(this.analyzeTimer)
    this.analyzeTimer = setTimeout(() => {
      this.analyzeTimedOut = { why, ms }
      log('analyze', `core analyze exceeded ${ms / 1000}s (${why}) — killing it`, 'error')
      child.kill('SIGKILL')
    }, ms)
  }

  cancel(): void {
    for (const c of this.children.values()) c.kill('SIGKILL')
  }


  /** The combined pass. Spawned IMMEDIATELY — melody and key run while the
   *  renderer's own model is still working — and the beats stage blocks on
   *  stdin, which provideMl() feeds (the token format) and closes whenever
   *  the lattice is ready, or closes empty on a packless machine. The caller
   *  MUST call provideMl exactly once per run when beats are wanted, or the
   *  child sits on stdin until the hang catcher shoots it. */
  analyzeAll(input: AnalyzeAllInput): Promise<AnalyzeAllResult> {
    // Everything up to the gate assignment is SYNCHRONOUS — see the class
    // comment: the paired analyze:ml may already be queued behind this call.
    if (this.children.has('analyze')) {
      this.setGate(input.token, Promise.resolve('busy'))
      return Promise.resolve({ ok: false, error: 'An analysis is already running.' })
    }
    let gateResolve!: (v: { child: ChildProcess } | 'busy' | 'failed') => void
    this.setGate(
      input.token,
      new Promise((r) => {
        gateResolve = r
      })
    )
    return (async () => {
      const bin = await resolveAnalyze()
      if (bin === null) {
        gateResolve('failed')
        return { ok: false, error: 'singz-analyze is not in this build.' }
      }
      return await new Promise<AnalyzeAllResult>((resolve) => {
      const args = ['analyze']
      if (input.want.melody) args.push('--melody', '--raw')
      if (input.want.key) args.push('--key')
      if (input.want.beats) args.push('--beats', '--ml-stdin')
      if (input.vocals) args.push('--vocals', input.vocals)
      if (input.drums) args.push('--drums', input.drums)
      if (input.bass) args.push('--bass', input.bass)
      for (const p of input.inst) args.push('--inst', p)
      for (const t of input.lineStarts ?? []) args.push('--line', String(t))
      for (const w of input.words ?? []) args.push('--word', `${w.s}:${w.e}`)
      log(
        'analyze',
        `core: one pass, want ${Object.entries(input.want).filter(([, v]) => v).map(([k]) => k).join('+')}` +
          ` (${[input.vocals, input.drums, input.bass, ...input.inst].filter(Boolean).length} stems; lattice+lyrics follow on stdin)`
      )
      const child = spawn(bin, args)
      this.children.set('analyze', child)
      // stdin errors EMIT, they do not throw at the write site — without a
      // listener a write-after-death is an uncaught stream error in main
      child.stdin?.on('error', (e) => log('analyze', `stdin: ${e.message}`, 'error'))
      if (!input.want.beats) child.stdin?.end()
      gateResolve({ child })
      const out: Buffer[] = []
      let outBuf = ''
      let errTail = ''
      let progBuf = ''
      this.analyzeTimedOut = null
      // The lattice-wait phase spans the renderer's own model run, whose
      // sanctioned budget (beats-ml.ts) is 180 s on the slowest fleet path —
      // a 120 s wait cap would shoot a healthy pass mid-wait. Post-feed the
      // beats get a fresh ordinary budget (provideMl re-arms).
      this.armAnalyzeTimer(child, input.want.beats ? 'awaiting the lattice' : 'melody/key', input.want.beats ? 240_000 : TIMEOUT_MS)
      child.stdout?.on('data', (c: Buffer) => {
        out.push(c)
        // each part is one flushed line — validate and broadcast it the
        // moment it completes, so the renderer adopts the melody while the
        // beats stage is still waiting on its lattice
        outBuf += c.toString('utf8')
        let nl: number
        while ((nl = outBuf.indexOf('\n')) >= 0) {
          const line = outBuf.slice(0, nl).trim()
          outBuf = outBuf.slice(nl + 1)
          if (!line.startsWith('{')) continue
          try {
            const part = JSON.parse(line) as { melody?: CliMelody }
            if (part.melody) {
              const m = validateMelody(part.melody)
              for (const win of BrowserWindow.getAllWindows()) {
                if (!win.isDestroyed()) win.webContents.send('analyze:part', { melody: m })
              }
            }
          } catch {
            // a malformed part fails validation again at settle, loudly
          }
        }
      })
      child.stderr?.on('data', (c: Buffer) => {
        const text = c.toString('utf8')
        errTail = (errTail + text).slice(-4000)
        progBuf += text
        let nl: number
        while ((nl = progBuf.indexOf('\n')) >= 0) {
          const line = progBuf.slice(0, nl).trim()
          progBuf = progBuf.slice(nl + 1)
          const m = /^progress melody ([\d.]+)$/.exec(line)
          if (!m) continue
          const p = Number.parseFloat(m[1])
          if (Number.isFinite(p)) {
            for (const win of BrowserWindow.getAllWindows()) {
              if (!win.isDestroyed()) win.webContents.send('melody:progress', Math.min(1, p))
            }
          }
        }
        logChunk('analyze', text, /^progress /)
      })
      child.on('error', (err) => {
        if (this.analyzeTimer) clearTimeout(this.analyzeTimer)
        this.children.delete('analyze')
        this.spawnGates.delete(input.token)
        resolve({ ok: false, error: `Could not start singz-analyze: ${err.message}` })
      })
      onChildSettled(child, 'analyze', (code, signal) => {
        if (this.analyzeTimer) clearTimeout(this.analyzeTimer)
        this.children.delete('analyze')
        this.spawnGates.delete(input.token)
        if (signal === 'SIGKILL') {
          const t = this.analyzeTimedOut
          resolve({ ok: false, error: t ? `Timed out after ${t.ms / 1000}s (${t.why}).` : 'Cancelled.' })
          return
        }
        if (code !== 0) {
          log('analyze', `singz-analyze exited with code ${code}`, 'error')
          resolve({ ok: false, error: errTail.trim().split('\n').pop() || `exit ${code}` })
          return
        }
        resolve(parseCliAnalyze(Buffer.concat(out).toString('utf8'), input.want))
      })
      })
    })()
  }

  /** The lattice for the running combined pass — writes the token format to
   *  the child's stdin and closes it. null = no grid (packless, or the model
   *  failed): stdin closes empty, the CLI runs the homegrown path. */
  async provideMl(
    ml: BeatsNativeInput['ml'],
    aux: { lineStarts: number[] | null; words: { s: number; e: number }[] | null } | undefined,
    token: string
  ): Promise<void> {
    // Await the gate of the run this call is PAIRED with (assigned before
    // this IPC could have been dispatched) — never the bare children map,
    // which is empty for the microseconds resolveAnalyze spends on the
    // threadpool. A 'busy' gate means our run was refused: feeding the
    // RUNNING child someone else's lattice is exactly what this prevents.
    const gatePromise = this.spawnGates.get(token)
    if (!gatePromise) {
      // the run is already gone (child settled) or was evicted — dead lattice
      log('analyze', 'a lattice arrived for a run that is gone — dropped')
      return
    }
    this.spawnGates.delete(token)
    const gate = await gatePromise
    if (gate === 'busy' || gate === 'failed') return
    const child = gate.child
    if (!child.stdin || child.stdin.writableEnded || child.exitCode !== null) return
    try {
      const text = mlFileText(ml, aux)
      log(
        'analyze',
        `lattice+aux over stdin: ${ml ? `${ml.beats.length} beats` : 'no grid'}, ${aux?.words?.length ?? 0} words, ${aux?.lineStarts?.length ?? 0} lines`
      )
      // the wait-for-lattice budget is spent; beats get their own fresh one
      // (the model's sanctioned budget alone is 180 s on the slowest fleet
      // path, which the single spawn-anchored timer used to eat)
      this.armAnalyzeTimer(child, 'beats after the lattice', TIMEOUT_MS)
      if (text) child.stdin.write(text)
      child.stdin.end()
    } catch {
      // stdin errors also EMIT; the spawn-time listener logs those
    }
  }


}

function lastJsonLine(stdout: string): string {
  const line = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'))
    .pop()
  if (!line) throw new Error('no result object on stdout')
  return line
}

/** VALIDATE a melody object. Anything malformed is a failure, never a
 *  partial adoption — same policy as decodeMelody. */
function validateMelody(j: CliMelody): MelodyNativeResult {
  if (!Array.isArray(j.f0) || !Array.isArray(j.raw) || !Array.isArray(j.rms))
    throw new Error('result is missing f0/raw/rms')
  if (!(j.hopSec > 0.001 && j.hopSec < 0.5)) throw new Error(`hopSec ${j.hopSec} is not a hop`)
  if (!Number.isInteger(j.detVersion)) throw new Error('no detVersion stamp')
  if (j.f0.length !== j.rms.length || j.f0.length !== j.raw.length)
    throw new Error(`frame counts disagree (${j.f0.length}/${j.raw.length}/${j.rms.length})`)
  return {
    ok: true,
    f0: Float32Array.from(j.f0),
    raw: Float32Array.from(j.raw),
    rms: Float32Array.from(j.rms),
    hopSec: j.hopSec,
    detVersion: j.detVersion
  }
}

export function parseCliMelody(stdout: string): MelodyNativeResult {
  try {
    return validateMelody(JSON.parse(lastJsonLine(stdout)) as CliMelody)
  } catch (err) {
    return { ok: false, error: `singz-analyze output unusable: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/** The key detector through the same binary. No progress protocol — the
 *  chroma pass is ~1 s on the sample and single-digit seconds on a song. */
export interface KeyNativeResult {
  ok: boolean
  error?: string
  pc?: number
  minor?: boolean
  detVersion?: number
}

function validateKey(j: { detVersion: number; key: { pc: number; minor: boolean } | null }): KeyNativeResult {
  {
    if (!Number.isInteger(j.detVersion)) throw new Error('no detVersion stamp')
    if (j.key === null) return { ok: false, error: 'no key answer (silent harmonics?)' }
    if (!Number.isInteger(j.key.pc) || j.key.pc < 0 || j.key.pc > 11 || typeof j.key.minor !== 'boolean')
      throw new Error('key is not a pitch class')
    return { ok: true, pc: j.key.pc, minor: j.key.minor, detVersion: j.detVersion }
  }
}

export function parseCliKey(stdout: string): KeyNativeResult {
  try {
    return validateKey(JSON.parse(lastJsonLine(stdout)) as { detVersion: number; key: { pc: number; minor: boolean } | null })
  } catch (err) {
    return { ok: false, error: `singz-analyze output unusable: ${err instanceof Error ? err.message : String(err)}` }
  }
}

export interface BeatsNativeInput {
  drums: string
  bass: string | null
  vocals: string | null
  inst: string[]
  lineStarts: number[] | null
  words: { s: number; e: number }[] | null
  ml: { beats: number[]; downbeats: number[]; beatProb?: number[]; downbeatProb?: number[]; fps?: number } | null
}

export interface BeatsNativeResult {
  ok: boolean
  error?: string
  detVersion?: number
  bpm?: number
  beatsPerBar?: number
  downbeat?: number
  beats?: number[]
  downbeats?: number[]
  hasDownbeats?: boolean
  suspectAt?: number[]
}

/** The production grid out of the CLI's staged-debug object — the fields the
 *  app stores are all present in it; everything else is the parity harness's
 *  business. `ok:false` from the DETECTOR (no steady beat) is not an error:
 *  it crosses as ok:true with gridOk:false semantics folded into beats=[] —
 *  the renderer treats an empty grid exactly as the TS's null. */
function validateBeats(j: {
  detVersion: number
  ok: boolean
  bpm: number
  beatsPerBar: number
  downbeat: number
  beatsSec: number[]
  downbeats: number[]
  hasDownbeats: boolean
  suspectAt?: number[]
}): BeatsNativeResult {
  {
    if (!Number.isInteger(j.detVersion)) throw new Error('no detVersion stamp')
    if (j.ok !== true) return { ok: true, detVersion: j.detVersion, beats: [] } // the TS's null
    if (!Array.isArray(j.beatsSec) || j.beatsSec.length === 0) throw new Error('ok grid with no beats')
    if (!(j.bpm > 0) || !Number.isInteger(j.beatsPerBar)) throw new Error('grid without a tempo')
    if (typeof j.hasDownbeats !== 'boolean') throw new Error('no hasDownbeats marker')
    if (!Array.isArray(j.downbeats)) throw new Error('no downbeats array')
    return {
      ok: true,
      detVersion: j.detVersion,
      bpm: j.bpm,
      beatsPerBar: j.beatsPerBar,
      downbeat: j.downbeat,
      beats: j.beatsSec,
      downbeats: j.downbeats,
      hasDownbeats: j.hasDownbeats,
      suspectAt: Array.isArray(j.suspectAt) ? j.suspectAt : []
    }
  }
}

export function parseCliBeats(stdout: string): BeatsNativeResult {
  try {
    return validateBeats(JSON.parse(lastJsonLine(stdout)) as Parameters<typeof validateBeats>[0])
  } catch (err) {
    return { ok: false, error: `singz-analyze output unusable: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/** The neural grid, in the token format readMlFile parses. Values go through
 *  String() — the shortest round-trip — and the CLI reads them with strtod,
 *  so every value is bit-identical on both sides (the property the harness's
 *  own writer documents; a %.17g hop would not give it on every platform). */
export function mlFileText(
  ml: NonNullable<BeatsNativeInput['ml']> | null,
  aux?: { lineStarts: number[] | null; words: { s: number; e: number }[] | null }
): string {
  const arr = (name: string, v: number[] | undefined | null): string =>
    v && v.length > 0 ? `${name} ${v.length} ${v.map((x) => String(x)).join(' ')}\n` : ''
  const wordVals = aux?.words?.flatMap((w) => [w.s, w.e])
  return (
    (ml
      ? `fps ${ml.fps ?? 50}\n` +
        arr('beats', ml.beats) +
        arr('downbeats', ml.downbeats) +
        arr('beatProb', ml.beatProb) +
        arr('downbeatProb', ml.downbeatProb)
      : '') +
    // the lyric aux rides beside the lattice: both are only KNOWN after the
    // child has already started tracking melody
    arr('lineStarts', aux?.lineStarts) +
    arr('words', wordVals)
  )
}

export interface AnalyzeAllInput {
  /** Renderer-minted per-run id pairing analyze:run with its analyze:ml. */
  token: string
  want: { melody: boolean; key: boolean; beats: boolean }
  vocals: string | null
  drums: string | null
  bass: string | null
  inst: string[]
  lineStarts: number[] | null
  words: { s: number; e: number }[] | null
}

export interface AnalyzeAllResult {
  ok: boolean
  error?: string
  melody?: MelodyNativeResult
  key?: KeyNativeResult
  beats?: BeatsNativeResult
}

/** The combined pass's one JSON object → per-part validated results. A
 *  malformed PART fails that part alone (its TS fallback runs); a missing
 *  line fails the whole call. */
export function parseCliAnalyze(stdout: string, want: AnalyzeAllInput['want']): AnalyzeAllResult {
  // `analyze` emits one flushed JSON line PER PART, in detector order, so the
  // caller can adopt the melody before the beats stage has even received its
  // lattice — merge the lines. A part that failed to arrive at all is simply
  // absent and fails its own validation below.
  const j: Record<string, unknown> = {}
  try {
    const lines = stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('{'))
    if (lines.length === 0) throw new Error('no result lines on stdout')
    for (const line of lines) Object.assign(j, JSON.parse(line) as Record<string, unknown>)
  } catch (err) {
    return { ok: false, error: `singz-analyze output unusable: ${err instanceof Error ? err.message : String(err)}` }
  }
  const part = <T>(name: string, wanted: boolean, validate: (x: never) => T): T | { ok: false; error: string } | undefined => {
    if (!wanted) return undefined
    if (!(name in j)) return { ok: false, error: `the ${name} part is missing from the combined result` }
    try {
      return validate(j[name] as never)
    } catch (err) {
      return { ok: false, error: `${name} part unusable: ${err instanceof Error ? err.message : String(err)}` }
    }
  }
  return {
    ok: true,
    melody: part('melody', want.melody, validateMelody),
    key: part('key', want.key, validateKey),
    beats: part('beats', want.beats, validateBeats)
  }
}

const analyze = new Analyze()

export function registerAnalyze(): void {
  ipcMain.handle('melody:available', async () => ({ ok: true, available: (await resolveAnalyze()) !== null }))
  ipcMain.handle('analyze:run', (_e, raw: unknown): Promise<AnalyzeAllResult> => {
    const i = raw as AnalyzeAllInput
    if (!i || !i.want || typeof i.want !== 'object' || typeof i.token !== 'string' || i.token === '')
      return Promise.resolve({ ok: false, error: 'bad input' })
    const paths = [i.vocals, i.drums, i.bass, ...(Array.isArray(i.inst) ? i.inst : [])].filter(
      (p): p is string => typeof p === 'string'
    )
    if (paths.length === 0) return Promise.resolve({ ok: false, error: 'no stems' })
    // The same gate media:read stands behind: the renderer may only point the
    // core at files the load path registered.
    for (const p of paths) if (!isAllowed(p)) return Promise.resolve({ ok: false, error: 'File is not registered.' })
    return analyze.analyzeAll({
      token: i.token,
      want: { melody: !!i.want.melody, key: !!i.want.key, beats: !!i.want.beats },
      vocals: typeof i.vocals === 'string' ? i.vocals : null,
      drums: typeof i.drums === 'string' ? i.drums : null,
      bass: typeof i.bass === 'string' ? i.bass : null,
      inst: Array.isArray(i.inst) ? i.inst.filter((p): p is string => typeof p === 'string') : [],
      lineStarts: Array.isArray(i.lineStarts) ? i.lineStarts.filter((t) => Number.isFinite(t)) : null,
      words: Array.isArray(i.words) ? i.words.filter((w) => w && Number.isFinite(w.s) && Number.isFinite(w.e)) : null
    })
  })
  ipcMain.handle('analyze:ml', (_e, ml: unknown, aux: unknown, token: unknown) => {
    if (typeof token !== 'string' || token === '') return { ok: false as const, error: 'bad token' }
    const a = aux as { lineStarts?: unknown; words?: unknown } | null
    analyze.provideMl(
      ml && Array.isArray((ml as { beats?: unknown }).beats) && Array.isArray((ml as { downbeats?: unknown }).downbeats)
        ? (ml as NonNullable<BeatsNativeInput['ml']>)
        : null,
      {
        lineStarts: Array.isArray(a?.lineStarts) ? a.lineStarts.filter((t): t is number => Number.isFinite(t)) : null,
        words: Array.isArray(a?.words)
          ? a.words.filter((w): w is { s: number; e: number } => !!w && Number.isFinite(w.s) && Number.isFinite(w.e))
          : null
      },
      token
    )
    return { ok: true }
  })
  ipcMain.handle('melody:cancel', () => {
    analyze.cancel()
    return { ok: true }
  })
}

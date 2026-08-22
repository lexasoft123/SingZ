import { BrowserWindow, ipcMain } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { access, mkdir, rm, writeFile } from 'node:fs/promises'
import { app } from 'electron'
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

/** One job per KIND at a time (melody and key fire in parallel from the same
 *  analysis pass), cancellable — the renderer's loadSeq decides whose result
 *  counts; this only makes sure a dead song's children die too. */
class Analyze {
  private children = new Map<string, ChildProcess>()

  cancel(): void {
    for (const c of this.children.values()) c.kill('SIGKILL')
  }

  async key(instPaths: string[], bassPath: string | null): Promise<KeyNativeResult> {
    if (this.children.has('key')) return { ok: false, error: 'A key analysis is already running.' }
    const bin = await resolveAnalyze()
    if (bin === null) return { ok: false, error: 'singz-analyze is not in this build.' }
    return new Promise<KeyNativeResult>((resolve) => {
      const args = ['key']
      for (const p of instPaths) args.push('--inst', p)
      if (bassPath) args.push('--bass', bassPath)
      log('key', `core: ${bin} ${args.map((a) => (a.startsWith('--') ? a : a.split('/').pop())).join(' ')}`)
      const child = spawn(bin, args)
      this.children.set('key', child)
      const out: Buffer[] = []
      let errTail = ''
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        log('key', `core key exceeded ${TIMEOUT_MS / 1000}s — killing it`, 'error')
        child.kill('SIGKILL')
      }, TIMEOUT_MS)
      child.stdout?.on('data', (c: Buffer) => {
        out.push(c)
      })
      child.stderr?.on('data', (c: Buffer) => {
        errTail = (errTail + c.toString('utf8')).slice(-4000)
        logChunk('key', c.toString('utf8'))
      })
      child.on('error', (err) => {
        clearTimeout(timer)
        this.children.delete('key')
        resolve({ ok: false, error: `Could not start singz-analyze: ${err.message}` })
      })
      onChildSettled(child, 'key', (code, signal) => {
        clearTimeout(timer)
        this.children.delete('key')
        if (signal === 'SIGKILL') {
          resolve({ ok: false, error: timedOut ? `Timed out after ${TIMEOUT_MS / 1000}s.` : 'Cancelled.' })
          return
        }
        if (code !== 0) {
          log('key', `singz-analyze exited with code ${code}`, 'error')
          resolve({ ok: false, error: errTail.trim().split('\n').pop() || `exit ${code}` })
          return
        }
        resolve(parseCliKey(Buffer.concat(out).toString('utf8')))
      })
    })
  }

  async beats(input: BeatsNativeInput): Promise<BeatsNativeResult> {
    if (this.children.has('beats')) return { ok: false, error: 'A beat analysis is already running.' }
    const bin = await resolveAnalyze()
    if (bin === null) return { ok: false, error: 'singz-analyze is not in this build.' }
    // NOT `singz-analyze`: build-analyze-host.sh drops the BINARY at
    // $TMPDIR/singz-analyze on dev machines, and mkdir over a file is EEXIST
    // even with recursive — found live as an unhandled 'beats:detect'
    // rejection the first time the ML path ran.
    const tmpDir = join(app.getPath('temp'), 'singz-analyze-ml')
    const mlPath = input.ml ? join(tmpDir, `ml-${process.pid}-${Date.now()}.txt`) : null
    try {
      if (mlPath && input.ml) {
        await mkdir(tmpDir, { recursive: true })
        await writeFile(mlPath, mlFileText(input.ml))
      }
      return await new Promise<BeatsNativeResult>((resolve) => {
        const args = ['beats', '--drums', input.drums]
        if (input.bass) args.push('--bass', input.bass)
        if (input.vocals) args.push('--vocals', input.vocals)
        for (const p of input.inst) args.push('--inst', p)
        for (const t of input.lineStarts ?? []) args.push('--line', String(t))
        for (const w of input.words ?? []) args.push('--word', `${w.s}:${w.e}`)
        if (mlPath) args.push('--ml', mlPath)
        log('beats', `core: ${bin} beats (${input.inst.length + 1 + (input.bass ? 1 : 0) + (input.vocals ? 1 : 0)} stems, ${input.words?.length ?? 0} words, ml=${mlPath ? 'yes' : 'no'})`)
        const child = spawn(bin, args)
        this.children.set('beats', child)
        const out: Buffer[] = []
        let errTail = ''
        let timedOut = false
        const timer = setTimeout(() => {
          timedOut = true
          log('beats', `core beats exceeded ${TIMEOUT_MS / 1000}s — killing it`, 'error')
          child.kill('SIGKILL')
        }, TIMEOUT_MS)
        child.stdout?.on('data', (c: Buffer) => {
          out.push(c)
        })
        child.stderr?.on('data', (c: Buffer) => {
          errTail = (errTail + c.toString('utf8')).slice(-4000)
          logChunk('beats', c.toString('utf8'), /^progress /)
        })
        child.on('error', (err) => {
          clearTimeout(timer)
          this.children.delete('beats')
          resolve({ ok: false, error: `Could not start singz-analyze: ${err.message}` })
        })
        onChildSettled(child, 'beats', (code, signal) => {
          clearTimeout(timer)
          this.children.delete('beats')
          if (signal === 'SIGKILL') {
            resolve({ ok: false, error: timedOut ? `Timed out after ${TIMEOUT_MS / 1000}s.` : 'Cancelled.' })
            return
          }
          if (code !== 0) {
            log('beats', `singz-analyze exited with code ${code}`, 'error')
            resolve({ ok: false, error: errTail.trim().split('\n').pop() || `exit ${code}` })
            return
          }
          resolve(parseCliBeats(Buffer.concat(out).toString('utf8')))
        })
      })
    } catch (err) {
      // IPC handlers return result objects, never throw (the repo rule) — a
      // temp-file failure is a loud fallback, not a renderer exception.
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      if (mlPath) await rm(mlPath, { force: true }).catch(() => undefined)
    }
  }

  async melody(stemPath: string): Promise<MelodyNativeResult> {
    if (this.children.has('melody')) return { ok: false, error: 'A melody analysis is already running.' }
    const bin = await resolveAnalyze()
    if (bin === null) return { ok: false, error: 'singz-analyze is not in this build.' }
    return new Promise<MelodyNativeResult>((resolve) => {
      // --wav reads WAV and FLAC both (the core dispatches on the header);
      // --raw carries raw+rms for the diagnostics hook E2E drivers read.
      const args = ['melody', '--wav', stemPath, '--raw']
      log('melody', `core: ${bin} ${args.join(' ')}`)
      const child = spawn(bin, args)
      this.children.set('melody', child)

      const out: Buffer[] = []
      let errTail = ''
      let progBuf = ''
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        log('melody', `core melody exceeded ${TIMEOUT_MS / 1000}s — killing it`, 'error')
        child.kill('SIGKILL')
      }, TIMEOUT_MS)

      child.stdout?.on('data', (c: Buffer) => {
        out.push(c)
      })
      child.stderr?.on('data', (c: Buffer) => {
        const text = c.toString('utf8')
        errTail = (errTail + text).slice(-4000)
        // `progress melody 0.42` lines are protocol (the CLI prints them
        // every ~3%); everything else on stderr is log.
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
        logChunk('melody', text, /^progress /)
      })

      child.on('error', (err) => {
        clearTimeout(timer)
        this.children.delete('melody')
        resolve({ ok: false, error: `Could not start singz-analyze: ${err.message}` })
      })

      onChildSettled(child, 'melody', (code, signal) => {
        clearTimeout(timer)
        this.children.delete('melody')
        if (signal === 'SIGKILL') {
          // A cancel's result is dropped by the renderer's seq guard before
          // any warn, so the only SIGKILL a human ever READS is the
          // hang-catcher's — name it, or a field hang logs as "Cancelled".
          resolve({ ok: false, error: timedOut ? `Timed out after ${TIMEOUT_MS / 1000}s.` : 'Cancelled.' })
          return
        }
        if (code !== 0) {
          log('melody', `singz-analyze exited with code ${code}`, 'error')
          // `||`, not `??`: a child that dies with a silent stderr (SIGSEGV)
          // yields '' here, and "failed ()" is no diagnosis at all.
          resolve({ ok: false, error: errTail.trim().split('\n').pop() || `exit ${code}` })
          return
        }
        resolve(parseCliMelody(Buffer.concat(out).toString('utf8')))
      })
    })
  }
}

/** Parse and VALIDATE the CLI's one JSON object. Anything malformed is a
 *  failure, never a partial adoption — same policy as decodeMelody. */
export function parseCliMelody(stdout: string): MelodyNativeResult {
  try {
    const line = stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('{'))
      .pop()
    if (!line) throw new Error('no result object on stdout')
    const j = JSON.parse(line) as CliMelody
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

export function parseCliKey(stdout: string): KeyNativeResult {
  try {
    const line = stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('{'))
      .pop()
    if (!line) throw new Error('no result object on stdout')
    const j = JSON.parse(line) as { detVersion: number; key: { pc: number; minor: boolean } | null }
    if (!Number.isInteger(j.detVersion)) throw new Error('no detVersion stamp')
    if (j.key === null) return { ok: false, error: 'no key answer (silent harmonics?)' }
    if (!Number.isInteger(j.key.pc) || j.key.pc < 0 || j.key.pc > 11 || typeof j.key.minor !== 'boolean')
      throw new Error('key is not a pitch class')
    return { ok: true, pc: j.key.pc, minor: j.key.minor, detVersion: j.detVersion }
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
export function parseCliBeats(stdout: string): BeatsNativeResult {
  try {
    const line = stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('{'))
      .pop()
    if (!line) throw new Error('no result object on stdout')
    const j = JSON.parse(line) as {
      detVersion: number
      ok: boolean
      bpm: number
      beatsPerBar: number
      downbeat: number
      beatsSec: number[]
      downbeats: number[]
      hasDownbeats: boolean
      suspectAt?: number[]
    }
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
  } catch (err) {
    return { ok: false, error: `singz-analyze output unusable: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/** The neural grid, in the token format readMlFile parses. Values go through
 *  String() — the shortest round-trip — and the CLI reads them with strtod,
 *  so every value is bit-identical on both sides (the property the harness's
 *  own writer documents; a %.17g hop would not give it on every platform). */
export function mlFileText(ml: NonNullable<BeatsNativeInput['ml']>): string {
  const arr = (name: string, v: number[] | undefined): string =>
    v && v.length > 0 ? `${name} ${v.length} ${v.map((x) => String(x)).join(' ')}\n` : ''
  return (
    `fps ${ml.fps ?? 50}\n` +
    arr('beats', ml.beats) +
    arr('downbeats', ml.downbeats) +
    arr('beatProb', ml.beatProb) +
    arr('downbeatProb', ml.downbeatProb)
  )
}

const analyze = new Analyze()

export function registerAnalyze(): void {
  ipcMain.handle('melody:available', async () => ({ ok: true, available: (await resolveAnalyze()) !== null }))
  ipcMain.handle('melody:track', (_e, stemPath: unknown): Promise<MelodyNativeResult> => {
    if (typeof stemPath !== 'string') return Promise.resolve({ ok: false, error: 'bad path' })
    // The same gate media:read stands behind: the renderer may only point the
    // core at files the load path registered.
    if (!isAllowed(stemPath)) return Promise.resolve({ ok: false, error: 'File is not registered.' })
    return analyze.melody(stemPath)
  })
  ipcMain.handle('melody:cancel', () => {
    analyze.cancel()
    return { ok: true }
  })
  ipcMain.handle('beats:detect', (_e, raw: unknown): Promise<BeatsNativeResult> => {
    const i = raw as BeatsNativeInput
    if (!i || typeof i.drums !== 'string') return Promise.resolve({ ok: false, error: 'bad input' })
    const paths = [i.drums, ...(i.bass ? [i.bass] : []), ...(i.vocals ? [i.vocals] : []), ...(Array.isArray(i.inst) ? i.inst : [])]
    if (paths.some((p) => typeof p !== 'string' || !isAllowed(p)))
      return Promise.resolve({ ok: false, error: 'File is not registered.' })
    return analyze.beats({
      drums: i.drums,
      bass: i.bass ?? null,
      vocals: i.vocals ?? null,
      inst: Array.isArray(i.inst) ? i.inst : [],
      lineStarts: Array.isArray(i.lineStarts) ? i.lineStarts.filter((t) => Number.isFinite(t)) : null,
      words: Array.isArray(i.words) ? i.words.filter((w) => w && Number.isFinite(w.s) && Number.isFinite(w.e)) : null,
      ml: i.ml && Array.isArray(i.ml.beats) && Array.isArray(i.ml.downbeats) ? i.ml : null
    })
  })
  ipcMain.handle('key:detect', (_e, inst: unknown, bass: unknown): Promise<KeyNativeResult> => {
    if (!Array.isArray(inst) || inst.some((p) => typeof p !== 'string') || (bass !== null && typeof bass !== 'string'))
      return Promise.resolve({ ok: false, error: 'bad paths' })
    const paths = [...(inst as string[]), ...(bass ? [bass as string] : [])]
    if (paths.length === 0) return Promise.resolve({ ok: false, error: 'no harmonic stems' })
    for (const p of paths) if (!isAllowed(p)) return Promise.resolve({ ok: false, error: 'File is not registered.' })
    return analyze.key(inst as string[], bass as string | null)
  })
}

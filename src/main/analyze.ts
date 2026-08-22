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

/** One melody job at a time, cancellable — the renderer's loadSeq decides
 *  whose result counts; this only makes sure a dead song's child dies too. */
class Analyze {
  private child: ChildProcess | null = null

  cancel(): void {
    this.child?.kill('SIGKILL')
  }

  async melody(stemPath: string): Promise<MelodyNativeResult> {
    if (this.child) return { ok: false, error: 'A melody analysis is already running.' }
    const bin = await resolveAnalyze()
    if (bin === null) return { ok: false, error: 'singz-analyze is not in this build.' }
    return new Promise<MelodyNativeResult>((resolve) => {
      // --wav reads WAV and FLAC both (the core dispatches on the header);
      // --raw carries raw+rms for the diagnostics hook E2E drivers read.
      const args = ['melody', '--wav', stemPath, '--raw']
      log('melody', `core: ${bin} ${args.join(' ')}`)
      const child = spawn(bin, args)
      this.child = child

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
        this.child = null
        resolve({ ok: false, error: `Could not start singz-analyze: ${err.message}` })
      })

      onChildSettled(child, 'melody', (code, signal) => {
        clearTimeout(timer)
        this.child = null
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
}

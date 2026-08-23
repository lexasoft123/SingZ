import { app, BrowserWindow, ipcMain } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { BeatsMlResult } from '../shared/types'
import { log, logChunk } from './log'
import { resolveAnalyze } from './analyze'
import { isAllowed } from './media'
import { packBeatsAvailable, packDir, packPython } from './models'
import { spawnEnv } from './separation'
import { onChildSettled } from './child-exit'

/** A whole song at 22.05 kHz is a few chunks of a 20M model — minutes never. */
const TIMEOUT_MS = 180_000

interface RunnerJson {
  beats: number[]
  downbeats: number[]
  beat_prob: number[]
  downbeat_prob: number[]
  fps: number
}

function friendlyError(tail: string): string {
  const lines = tail
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  if (/missing model|No module named/i.test(tail))
    return 'The splitter pack is missing the beat model — reinstall it in the model manager.'
  if (/out of memory|MemoryError|bad_alloc/i.test(tail))
    return 'Beat detection ran out of memory. Close other apps and try again.'
  return `Beat detection failed: ${lines.slice(-3).join(' — ').slice(0, 300) || 'unknown error'}`
}

/**
 * Runs the splitter pack's Beat This! runner (python/beat_runner.py) on raw
 * mono float32 PCM. One job at a time, 180 s hard timeout, temp file cleaned
 * up whatever happens. Protocol: one JSON line on stdout, progress on stderr.
 */
class BeatsMl {
  private child: ChildProcess | null = null

  get busy(): boolean {
    return this.child !== null
  }

  /** The model's input is rendered by the CORE (singz-analyze mlmix →
   *  sumStemsTo22k: swr-shaped Kaiser, time-true, -3 dB pan-law level), not
   *  by the renderer's OfflineAudioContext — one render for desktop, phone
   *  and the eval harness, that no Electron upgrade can move. Measured over
   *  the 17-song library before the switch: fused GT 54/55 against the
   *  Chromium render's 52/55 (the level is the difference; the render is
   *  value-neutral at equal level), BEAT_DETECT_VERSION 23 retires what the
   *  old input produced. */
  async detectStems(paths: string[]): Promise<BeatsMlResult> {
    if (this.child) return { ok: false, error: 'Beat detection is already running.' }
    if (!(await packBeatsAvailable())) {
      return {
        ok: false,
        error:
          'The installed splitter pack does not include the beat model yet — re-download it in the model manager.'
      }
    }
    const bin = await resolveAnalyze()
    if (bin === null) return { ok: false, error: 'singz-analyze is not in this build.' }
    const tmpDir = join(app.getPath('temp'), 'singz-beats')
    const f32 = join(tmpDir, `mix-${process.pid}-${Date.now()}.f32`)
    try {
      await mkdir(tmpDir, { recursive: true })
      const mixed = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
        const child = spawn(bin, ['mlmix', f32, ...paths])
        let errTail = ''
        child.stderr?.on('data', (c: Buffer) => {
          errTail = (errTail + c.toString('utf8')).slice(-2000)
        })
        const timer = setTimeout(() => child.kill('SIGKILL'), 120_000)
        child.on('error', (err) => {
          clearTimeout(timer)
          resolve({ ok: false, error: `Could not start singz-analyze: ${err.message}` })
        })
        onChildSettled(child, 'mlmix', (code) => {
          clearTimeout(timer)
          if (code === 0) resolve({ ok: true })
          else resolve({ ok: false, error: errTail.trim().split('\n').pop() ?? `mlmix exit ${code}` })
        })
      })
      if (!mixed.ok) return { ok: false, error: mixed.error ?? 'The mix could not be rendered.' }
      return await this.run(f32, 22050)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      await rm(f32, { force: true }).catch(() => undefined)
    }
  }

  private run(f32: string, sr: number): Promise<BeatsMlResult> {
    return new Promise<BeatsMlResult>((resolve) => {
      const runner = join(packDir(), 'python', 'beat_runner.py')
      const cmd = packPython()
      const args = [runner, '--f32', f32, '--sr', String(Math.round(sr))]
      log('beats', `run: ${cmd} ${args.join(' ')}`)
      const child = spawn(cmd, args, {
        env: {
          ...spawnEnv(),
          // Progress must stream, not arrive at exit (python block-buffers
          // when stdout is not a TTY).
          PYTHONUNBUFFERED: '1',
          // Weights ship inside the pack — nothing may ever hit the network.
          HF_HUB_OFFLINE: '1'
        }
      })
      this.child = child

      let out = ''
      let errTail = ''
      let progBuf = ''
      const timer = setTimeout(() => {
        log('beats', `beat detection exceeded ${TIMEOUT_MS / 1000}s — killing it`, 'error')
        child.kill('SIGKILL')
      }, TIMEOUT_MS)

      child.stdout?.on('data', (c: Buffer) => {
        out += c.toString('utf8')
      })
      child.stderr?.on('data', (c: Buffer) => {
        const text = c.toString('utf8')
        errTail = (errTail + text).slice(-4000)
        // PROG <0..1> lines drive the renderer's beat-detection progress
        // bar; they are protocol, not log noise. Older packs never emit
        // them — the bar just stays text-only there.
        progBuf += text
        let nl: number
        while ((nl = progBuf.indexOf('\n')) >= 0) {
          const line = progBuf.slice(0, nl).trim()
          progBuf = progBuf.slice(nl + 1)
          const m = /^PROG ([\d.]+)$/.exec(line)
          if (!m) continue
          const p = Number.parseFloat(m[1])
          if (Number.isFinite(p)) {
            for (const win of BrowserWindow.getAllWindows()) {
              if (!win.isDestroyed()) win.webContents.send('beats:progress', Math.min(1, p))
            }
          }
        }
        logChunk('beats', text, /^PROG /)
      })

      child.on('error', (err) => {
        clearTimeout(timer)
        this.child = null
        resolve({ ok: false, error: `Could not start the beat runner: ${err.message}` })
      })

      onChildSettled(child, 'beats', (code, signal) => {
        clearTimeout(timer)
        this.child = null
        if (signal === 'SIGKILL') {
          resolve({ ok: false, error: 'Beat detection timed out after 180 s.' })
          return
        }
        if (code !== 0) {
          log('beats', `beat runner exited with code ${code}`, 'error')
          resolve({ ok: false, error: friendlyError(errTail) })
          return
        }
        const line = out
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.startsWith('{'))
          .pop()
        try {
          if (!line) throw new Error('the runner produced no result line')
          const j = JSON.parse(line) as RunnerJson
          if (
            !Array.isArray(j.beats) ||
            !Array.isArray(j.downbeats) ||
            !Array.isArray(j.beat_prob) ||
            !Array.isArray(j.downbeat_prob) ||
            typeof j.fps !== 'number'
          ) {
            throw new Error('the runner result is missing fields')
          }
          log('beats', `ML beat detection: ${j.beats.length} beats, ${j.downbeats.length} downbeats`)
          resolve({
            ok: true,
            beats: j.beats,
            downbeats: j.downbeats,
            beatProb: j.beat_prob,
            downbeatProb: j.downbeat_prob,
            fps: j.fps
          })
        } catch (err) {
          resolve({
            ok: false,
            error: `Beat detection returned garbage: ${err instanceof Error ? err.message : String(err)}`
          })
        }
      })
    })
  }

  cancel(): void {
    if (this.child) this.child.kill('SIGTERM')
  }
}

const beatsMl = new BeatsMl()

/** IPC surface — result objects only, never throws across the bridge. */
export function registerBeatsIpc(): void {
  ipcMain.handle('beats:mlAvailable', async () => {
    try {
      return { ok: true as const, available: await packBeatsAvailable() }
    } catch {
      return { ok: true as const, available: false }
    }
  })

  ipcMain.handle('beats:mlDetectStems', (_e, raw: unknown): Promise<BeatsMlResult> => {
    const paths = Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string') : []
    if (paths.length === 0) return Promise.resolve({ ok: false, error: 'No stems were provided.' })
    // The same gate media:read stands behind: only files the load path
    // registered may reach the mix.
    for (const p of paths) if (!isAllowed(p)) return Promise.resolve({ ok: false, error: 'File is not registered.' })
    return beatsMl.detectStems(paths)
  })
}

export function cancelBeatsMl(): void {
  beatsMl.cancel()
}

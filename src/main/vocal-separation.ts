import { app, ipcMain } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { delimiter, join, resolve } from 'node:path'
import RUNNER from '../../scripts/vocal_split_runner.py?raw'
import { onChildSettled } from './child-exit'
import { allowRoot, isAllowed } from './media'
import { modelsDir, needsVocalRuntime, packPython, vocalRuntimeDir } from './models'
import { VOCAL_MODEL_FILE, VOCAL_MODEL_SHA256 } from './vocal-model'
import { hashFile, spawnEnv } from './separation'
import { log } from './log'

const issuedLeads = new Set<string>()
const RUNNER_VERSION = createHash('sha256').update(RUNNER).digest('hex').slice(0, 12)
/** Only a completed split can become a replacement for the canonical vocal. */
export function isIssuedLead(path: string): boolean { return issuedLeads.has(resolve(path)) }

async function digest(path: string): Promise<string> {
  return new Promise((done, reject) => {
    const hash = createHash('sha256')
    createReadStream(path).on('data', chunk => hash.update(chunk)).on('error', reject)
      .on('end', () => done(hash.digest('hex')))
  })
}

class VocalSeparator {
  private busy = false
  private cancelled = false
  private child: ChildProcess | null = null
  cancel(): void { this.cancelled = true; this.child?.kill('SIGKILL') }

  async split(path: string, progress: (p: number) => void): Promise<
    { ok: true; lead: string; backing: string } | { ok: false; error: string; cancelled?: boolean }
  > {
    if (this.busy) return { ok: false, error: 'Backing vocal separation is already running.' }
    this.busy = true
    this.cancelled = false
    let pending: string | null = null
    try {
      const sourceHash = await hashFile(path)
      const root = join(app.getPath('userData'), 'vocal-splits')
      const dest = join(root, `${sourceHash}-${VOCAL_MODEL_SHA256.slice(0, 12)}-${RUNNER_VERSION}`)
      const lead = join(dest, 'lead.wav'), backing = join(dest, 'backing.wav')
      const complete = async (): Promise<boolean> => {
        try {
          const saved = JSON.parse(await readFile(join(dest, 'complete.json'), 'utf8'))
          return saved.lead === await digest(lead) && saved.backing === await digest(backing)
        } catch { return false }
      }
      if (await complete()) {
        if (this.cancelled) throw new Error('Cancelled')
        allowRoot(dest); issuedLeads.add(resolve(lead)); progress(100)
        return { ok: true, lead, backing }
      }
      try { await stat(packPython()); await stat(join(modelsDir(), VOCAL_MODEL_FILE)) } catch {
        throw new Error('Open the model manager and download the stem splitter and Lead and backing vocals model first.')
      }
      if (needsVocalRuntime()) {
        try { await stat(join(vocalRuntimeDir(), 'onnxruntime', '__init__.py')) } catch {
          throw new Error('Open the model manager and download Lead and backing vocals to install its optional runtime.')
        }
      }
      if (this.cancelled) throw new Error('Cancelled')
      await mkdir(root, { recursive: true })
      pending = `${dest}.part-${process.pid}`
      await rm(pending, { recursive: true, force: true })
      await mkdir(pending, { recursive: true })
      const runner = join(pending, 'runner.py')
      await writeFile(runner, RUNNER)
      if (this.cancelled) throw new Error('Cancelled')
      log('vocal-split', `Separating lead/backing vocals: ${path}`)
      progress(0)
      await new Promise<void>((done, reject) => {
        const env: NodeJS.ProcessEnv = { ...spawnEnv(), PYTHONUNBUFFERED: '1', HF_HUB_OFFLINE: '1', PYTHONDONTWRITEBYTECODE: '1' }
        if (needsVocalRuntime()) env.PYTHONPATH = [vocalRuntimeDir(), process.env.PYTHONPATH].filter(Boolean).join(delimiter)
        const child = spawn(packPython(), [runner, '--model', join(modelsDir(), VOCAL_MODEL_FILE), '--input', path, '--output', pending!], { env })
        this.child = child
        let tail = '', lines = ''
        child.stdout?.on('data', (chunk: Buffer) => {
          lines += chunk.toString()
          const parts = lines.split('\n'); lines = parts.pop() ?? ''
          for (const line of parts) {
            try { const p = JSON.parse(line).percent; if (Number.isFinite(p)) progress(Math.min(99, Math.max(0, p))) } catch { /* non-progress log */ }
          }
        })
        child.stderr?.on('data', (chunk: Buffer) => { tail = (tail + chunk.toString()).slice(-3000) })
        child.once('error', reject)
        onChildSettled(child, 'vocal-split', code => {
          if (code === 0) done()
          else reject(new Error(tail.trim().split('\n').pop() || 'Backing vocal separation stopped.'))
        })
      })
      if (this.cancelled) throw new Error('Cancelled')
      if (await hashFile(path) !== sourceHash) throw new Error('The vocal file changed during separation. Please try again.')
      await writeFile(join(pending, 'complete.json'), JSON.stringify({
        lead: await digest(join(pending, 'lead.wav')), backing: await digest(join(pending, 'backing.wav'))
      }))
      await rm(join(pending, 'runner.py'), { force: true })
      if (this.cancelled) throw new Error('Cancelled')
      await rm(dest, { recursive: true, force: true })
      await rename(pending, dest); pending = null
      allowRoot(dest); issuedLeads.add(resolve(lead)); progress(100)
      log('vocal-split', 'Lead and backing vocals are ready')
      return { ok: true, lead, backing }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      if (!this.cancelled) log('vocal-split', error, 'error')
      return { ok: false, error: this.cancelled ? 'Cancelled' : error, cancelled: this.cancelled }
    } finally {
      if (pending) await rm(pending, { recursive: true, force: true }).catch(() => undefined)
      this.child = null; this.busy = false
    }
  }
}
export const vocalSeparator = new VocalSeparator()
export function registerVocalSeparation(): void {
  ipcMain.handle('vocals:split', (e, raw: string) => {
    const path = resolve(String(raw))
    if (!isAllowed(path)) return { ok: false, error: 'That vocal file is not registered.' }
    return vocalSeparator.split(path, p => { if (!e.sender.isDestroyed()) e.sender.send('vocals:progress', p) })
  })
  ipcMain.handle('vocals:cancel', () => vocalSeparator.cancel())
}

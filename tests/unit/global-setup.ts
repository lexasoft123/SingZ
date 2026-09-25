import { mkdirSync, mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// One userData per `vitest run`, named to the workers in SINGZ_UNIT_USERDATA:
// global setup runs before the first worker starts, and vitest hands every
// worker a copy of process.env as it is then. It used to be one fixed name
// under tmpdir(), which on macOS is the per-user $TMPDIR — so every worktree's
// and every session's suite shared one settings.json, one set of Drive tokens
// and one sync-log.jsonl, and two runs at once failed each other: 13 of 1768
// tests each, over state neither run had written.
//
// Preset SINGZ_UNIT_USERDATA to keep a run's userData for a look afterwards;
// only a directory made here is removed when the run ends.
export default function setup(): (() => Promise<void>) | void {
  const preset = process.env.SINGZ_UNIT_USERDATA
  if (preset) {
    mkdirSync(preset, { recursive: true })
    return
  }
  const dir = mkdtempSync(join(tmpdir(), 'singz-unit-userdata-'))
  process.env.SINGZ_UNIT_USERDATA = dir
  return async () => {
    // Vitest tears down before it closes its pool, so the last test file's
    // worker can still hold a handle in here — which Windows will not unlink
    // under. The async rm waits between its tries (rmSync would not); after
    // them a leftover temp folder is the OS's to clear, never a reason to fail
    // a run.
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 5 })
    } catch (err) {
      console.warn(`unit-test userData left behind at ${dir}: ${(err as Error).message}`)
    }
    // A config edit in watch mode re-runs setup in this same process, which
    // must make a fresh folder, not take the one just removed for a preset.
    delete process.env.SINGZ_UNIT_USERDATA
  }
}

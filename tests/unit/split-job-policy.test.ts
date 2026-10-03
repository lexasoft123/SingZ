import { describe, expect, it } from 'vitest'
import { recoverSplitJob, SplitProgressGate, type SplitJobEvidence, type SplitProcessExit } from '../../src/shared/split-job-policy'

const processName = 'com.lexasoft.singz:split'
const running: SplitJobEvidence & { chunksDone: number } = {
  state: 'splitting', updatedAtMs: 1200, processPid: 41, runStartedAtMs: 1000,
  stage: 'load-model', processName, exitPlatform: 'Android', chunksDone: 2
}
const exit = (overrides: Partial<SplitProcessExit> = {}): SplitProcessExit => ({
  pid: 41, processName, timestampMs: 1300, reason: 'native crash', status: 11,
  description: 'SIGSEGV', pssKb: 256 * 1024, rssKb: 300 * 1024, ...overrides
})

describe('common split progress pacing', () => {
  it('never suppresses an immediate stage change on either native adapter', () => {
    const gate = new SplitProgressGate()
    expect(gate.shouldSend('resample', 0, 1000)).toBe(true)
    expect(gate.shouldSend('load-model', 0, 1001)).toBe(true)
    expect(gate.shouldSend('load-model', 0, 1100)).toBe(false)
    expect(gate.shouldSend('split', 0, 1101)).toBe(true)
  })
  it('paces repeats while preserving completion and later progress', () => {
    const gate = new SplitProgressGate()
    expect(gate.shouldSend('resample', 0, 0)).toBe(true)
    expect(gate.shouldSend('resample', 0.5, 250)).toBe(false)
    expect(gate.shouldSend('resample', 0.5, 251)).toBe(true)
    expect(gate.shouldSend('resample', 1, 252)).toBe(true)
  })
})

describe('common split exit recovery', () => {
  it('returns the exit reason without mutating the record or changing resume identity', () => {
    const job = { ...running, processExits: [exit()] }
    const recovered = recoverSplitJob(job)
    expect(recovered.state).toBe('failed')
    expect(recovered.error).toBe('Android stopped the split during load-model: native crash (status 11, PSS 256 MB, RSS 300 MB) — SIGSEGV')
    expect(recovered.updatedAtMs).toBe(job.updatedAtMs)
    expect(recovered.chunksDone).toBe(2)
    expect(job.state).toBe('splitting')
  })
  it('ignores other processes, reused PIDs and exits before the heartbeat', () => {
    for (const candidate of [exit({ pid: 42 }), exit({ processName: 'com.lexasoft.singz' }),
      exit({ timestampMs: 999 }), exit({ timestampMs: 1199 })]) {
      const job = { ...running, processExits: [candidate] }
      expect(recoverSplitJob(job)).toBe(job)
    }
  })
  it('leaves old documents, absent evidence and terminal verdicts unchanged', () => {
    for (const change of [{ processPid: 0 }, { runStartedAtMs: 0 }, { processName: '' },
      { state: 'done' }, { state: 'cancelled' }, { state: 'failed', error: 'Splitting stalled' }]) {
      const job = { ...running, processExits: [exit()], ...change }
      expect(recoverSplitJob(job)).toBe(job)
    }
    expect(recoverSplitJob(running)).toBe(running)
  })
  it('uses the newest matching exit', () => {
    const job = { ...running, processExits: [exit({ reason: 'low memory', timestampMs: 1250 }), exit()] }
    expect(recoverSplitJob(job).error).toContain('native crash')
  })
  it('uses adapter platform labels rather than assuming Android', () => {
    const job = { ...running, exitPlatform: 'Test OS', stage: '', processExits: [exit({ description: '' })] }
    expect(recoverSplitJob(job).error).toBe('Test OS stopped the split during splitting: native crash (status 11, PSS 256 MB, RSS 300 MB)')
  })
  it('does not fail a resumed attempt using an older exit from the same PID', () => {
    const job = { ...running, runStartedAtMs: 2000, updatedAtMs: 2000, processExits: [exit()] }
    expect(recoverSplitJob(job)).toBe(job)
  })
})


describe('common in-process split recovery', () => {
  const job = { state: 'splitting', updatedAtMs: Date.now(), sessionId: 'old', currentSessionId: 'new', chunksDone: 3 }
  it('immediately recovers a previous session without mutating the resume record', () => {
    expect(recoverSplitJob(job)).toEqual({ ...job, state: 'failed', error: 'Splitting interrupted — resume to try again' })
    expect(job.state).toBe('splitting')
    expect(recoverSplitJob({ ...job, state: 'decoding' }).state).toBe('failed')
  })
  it('preserves a live or suspended job in the same process and old documents', () => {
    for (const change of [{ currentSessionId: 'old' }, { sessionId: undefined }, { currentSessionId: undefined }]) {
      const record = { ...job, ...change }
      expect(recoverSplitJob(record)).toBe(record)
    }
  })
  it('preserves terminal verdicts after restart', () => {
    for (const state of ['done', 'cancelled', 'failed']) {
      const record = { ...job, state, error: 'existing verdict' }
      expect(recoverSplitJob(record)).toBe(record)
    }
  })
  it('keeps a resumed attempt alive after ownership moves to the new session', () => {
    const record = { ...job, sessionId: 'new' }
    expect(recoverSplitJob(record)).toBe(record)
  })
})

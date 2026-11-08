import { describe, expect, it, vi } from 'vitest'
import { applyBoxMetronomePolicy, boxMetronomePreference, MetronomePolicyError } from '../../src/renderer/src/box/metronome-policy'

function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes }); return { promise, resolve } }

describe('Box profile metronome policy', () => {
  it('defaults only a missing legacy preference to Song and rejects unknown profile values', () => {
    expect(boxMetronomePreference(undefined)).toBe('song')
    expect(boxMetronomePreference('off')).toBe('off')
    expect(boxMetronomePreference('song')).toBe('song')
    for (const invalid of [null, '', false, 0, {}, 'OFF']) expect(boxMetronomePreference(invalid)).toBeNull()
  })
  it('silences before saving and never restores Song until the durable save acknowledges', async () => {
    const saved = deferred(), calls: string[] = []
    const apply = vi.fn(async (mode: string) => { calls.push(mode) })
    const task = applyBoxMetronomePolicy('song', apply, async mode => { calls.push(`save:${mode}`); await saved.promise })
    await Promise.resolve(); await Promise.resolve()
    expect(calls).toEqual(['off', 'save:song'])
    saved.resolve(); await expect(task).resolves.toBe('song')
    expect(calls).toEqual(['off', 'save:song', 'song'])
  })
  it('keeps confirmed Off on save failure, with no audible rollback', async () => {
    const apply = vi.fn(async () => {})
    const task = applyBoxMetronomePolicy('song', apply, async () => { throw new Error('disk full') })
    await expect(task).rejects.toMatchObject({ safeMode: 'off', message: 'disk full' })
    expect(apply.mock.calls).toEqual([['off']])
  })
  it('reconfirms silence after an uncertain audible receipt', async () => {
    const apply = vi.fn(async (mode: string) => { if (mode === 'song') throw new Error('timeout') })
    await expect(applyBoxMetronomePolicy('song', apply)).rejects.toMatchObject({ safeMode: 'off' })
    expect(apply.mock.calls).toEqual([['off'], ['song'], ['off']])
  })
  it('does not save or claim Off when both silence receipts fail', async () => {
    const save = vi.fn(), apply = vi.fn(async () => { throw new Error('host unavailable') })
    await expect(applyBoxMetronomePolicy('off', apply, save)).rejects.toMatchObject({ safeMode: null })
    expect(save).not.toHaveBeenCalled()
    expect(apply).toHaveBeenCalledTimes(2)
  })
  it('does not resolve a successful Off change before its save completes', async () => {
    const saved = deferred(), apply = vi.fn(async () => {})
    let complete = false
    const task = applyBoxMetronomePolicy('off', apply, () => saved.promise).then(() => { complete = true })
    await Promise.resolve(); await Promise.resolve(); expect(complete).toBe(false)
    saved.resolve(); await task; expect(complete).toBe(true)
    expect(apply.mock.calls).toEqual([['off']])
  })
  it('preserves an actionable original failure', () => { expect(new MetronomePolicyError('off', new Error('disk')).message).toBe('disk') })
})

/**
 * The library list and the open path must judge a project the same way, and
 * both must notice a file that is there but wrong — the case that used to
 * surface as "Could not decode that audio file" with no name attached.
 */
import { describe, expect, it } from 'vitest'
import { describeProject } from '../../src/main/project-state'

const hashes = (sizes: Record<string, number>): { stemHashes: Record<string, { md5: string; size: number; mtimeMs: number }> } => ({
  stemHashes: Object.fromEntries(
    Object.entries(sizes).map(([name, size]) => [name, { md5: `md5-${name}`, size, mtimeMs: 1 }])
  )
})

const SIX = {
  'vocals.flac': 100,
  'drums.flac': 200,
  'bass.flac': 300,
  'other.flac': 400,
  'guitar.flac': 500,
  'piano.flac': 600
}

describe('describeProject', () => {
  it('calls a project playable on the core four, whatever else is there', () => {
    const core = { 'vocals.flac': 1, 'drums.flac': 1, 'bass.flac': 1, 'other.flac': 1 }
    expect(describeProject(hashes(core), core).playable).toBe(true)
    const { 'bass.flac': _bass, ...three } = core
    expect(describeProject(hashes(three), three).playable).toBe(false)
  })

  it('prefers FLAC over a WAV left beside it', () => {
    const both = { 'vocals.flac': 10, 'vocals.wav': 40 }
    expect(describeProject(null, both).stems.vocals).toBe('flac')
    expect(describeProject(null, { 'vocals.wav': 40 }).stems.vocals).toBe('wav')
  })

  it('names a file the doc expects and stems/ does not have', () => {
    const { 'piano.flac': _gone, ...five } = SIX
    expect(describeProject(hashes(SIX), five).missing).toEqual(['piano.flac'])
  })

  it('names a file that is there at the wrong size', () => {
    expect(describeProject(hashes(SIX), { ...SIX, 'drums.flac': 12 }).damaged).toEqual(['drums.flac'])
  })

  it('says nothing about files an older doc never described', () => {
    const facts = describeProject(null, SIX)
    expect(facts.missing).toEqual([])
    expect(facts.damaged).toEqual([])
    expect(facts.playable).toBe(true)
  })
})

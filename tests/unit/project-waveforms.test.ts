import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveProjectWaveforms } from '../../src/main/projects'
import {
  BUCKETS,
  MAX_LANES,
  POLICY,
  VERSION,
  parseWaveformEnvelopeEntry,
  type StoredWaveformEnvelopeEntry
} from '../../src/shared/waveform-envelope-cache'

const MD5 = {
  flac: 'a'.repeat(32),
  wav: 'b'.repeat(32),
  custom: 'c'.repeat(32),
  drums: 'd'.repeat(32),
  bass: 'e'.repeat(32),
  stale: 'f'.repeat(32)
}

interface TestCustomTrack {
  id: string
  label: string
  color: string
  file: string
}

interface TestProjectDoc {
  [key: string]: unknown
  settings: {
    [key: string]: unknown
    custom?: TestCustomTrack[]
  }
  stemHashes: Record<string, { md5: string; size: number; mtimeMs: number }>
  waveforms?: unknown
}

function envelope(value = 0.25): number[] {
  return new Array<number>(BUCKETS).fill(value)
}

function stamped(md5: string, peaks: number[]): {
  version: typeof VERSION
  policy: typeof POLICY
  md5: string
  peaks: number[]
} {
  return { version: VERSION, policy: POLICY, md5, peaks }
}

const malformed: [string, unknown][] = [
  ['empty', []],
  ['95 buckets', envelope().slice(1)],
  ['97 buckets', [...envelope(), 0.25]],
  ['sparse 96 buckets', new Array<number>(BUCKETS)],
  ['NaN', envelope().fill(Number.NaN, 47, 48)],
  ['positive infinity', envelope().fill(Number.POSITIVE_INFINITY, 47, 48)],
  ['negative infinity', envelope().fill(Number.NEGATIVE_INFINITY, 47, 48)],
  ['negative RMS', envelope().fill(-0.001, 47, 48)],
  ['RMS above one', envelope().fill(1.001, 47, 48)],
  ['non-number RMS', envelope().fill('0.25' as unknown as number, 47, 48)]
]

describe('waveform envelope contract', () => {
  it('normalizes legacy entries only as the original v1 policy and checks expected MD5', () => {
    const peaks = envelope()
    expect(parseWaveformEnvelopeEntry({ md5: MD5.flac, peaks }, MD5.flac)).toEqual({
      version: 1,
      policy: 'singz.native.streaming-envelope.rms96-v1',
      md5: MD5.flac,
      peaks
    })
    expect(parseWaveformEnvelopeEntry(stamped(MD5.flac, peaks), MD5.flac)).toEqual(
      stamped(MD5.flac, peaks)
    )
    expect(parseWaveformEnvelopeEntry({ md5: MD5.flac, peaks }, MD5.wav)).toBeNull()
  })

  it('refuses non-records, unknown keys, incomplete/future stamps, and uppercase MD5', () => {
    const valid = stamped(MD5.flac, envelope())
    expect(parseWaveformEnvelopeEntry(null)).toBeNull()
    expect(parseWaveformEnvelopeEntry([])).toBeNull()
    expect(parseWaveformEnvelopeEntry({ ...valid, extra: true })).toBeNull()
    expect(parseWaveformEnvelopeEntry({ ...valid, version: VERSION + 1 })).toBeNull()
    expect(parseWaveformEnvelopeEntry({ ...valid, policy: `${POLICY}-future` })).toBeNull()
    expect(parseWaveformEnvelopeEntry({ md5: MD5.flac, peaks: envelope(), version: VERSION })).toBeNull()
    expect(parseWaveformEnvelopeEntry({ ...valid, md5: MD5.flac.toUpperCase() })).toBeNull()
  })
})

describe('project waveform persistence', () => {
  let dir = ''

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'singz-project-waveforms-'))
    await writeFile(join(dir, 'project.json'), JSON.stringify({
      version: 2,
      name: 'Song',
      songFile: 'song.mp3',
      savedAt: 'before',
      settings: {
        transpose: 0,
        tracks: {},
        custom: [{
          id: 'custom-studio-id',
          label: 'Studio double',
          color: '#fff',
          file: 'stems/custom-take-7.mp3'
        }]
      },
      stemHashes: {
        'vocals.flac': { md5: MD5.flac, size: 1, mtimeMs: 1 },
        'vocals.wav': { md5: MD5.wav, size: 1, mtimeMs: 1 },
        'custom-take-7.mp3': { md5: MD5.custom, size: 1, mtimeMs: 1 },
        'drums.flac': { md5: MD5.drums, size: 1, mtimeMs: 1 },
        'bass.flac': { md5: MD5.bass, size: 1, mtimeMs: 1 }
      }
    }))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function updateDoc(update: (doc: TestProjectDoc) => void): Promise<void> {
    const path = join(dir, 'project.json')
    const doc = JSON.parse(await readFile(path, 'utf8')) as TestProjectDoc
    update(doc)
    await writeFile(path, JSON.stringify(doc))
  }

  async function setWaveforms(waveforms: unknown): Promise<void> {
    await updateDoc(doc => { doc.waveforms = waveforms })
  }

  async function readWaveforms(): Promise<Record<string, StoredWaveformEnvelopeEntry> | undefined> {
    const doc = JSON.parse(await readFile(join(dir, 'project.json'), 'utf8')) as TestProjectDoc
    return doc.waveforms as Record<string, StoredWaveformEnvelopeEntry> | undefined
  }

  it('writes current stamps, maps custom IDs, and prefers FLAC for normal stems', async () => {
    const custom = envelope()
    custom[0] = 0
    custom[BUCKETS - 1] = 1
    const vocals = envelope(0.5)

    expect(await saveProjectWaveforms(dir, {
      'custom-studio-id': custom,
      vocals
    })).toEqual({ ok: true, stored: 2 })
    expect(await readWaveforms()).toEqual({
      'custom-studio-id': stamped(MD5.custom, custom),
      vocals: stamped(MD5.flac, vocals)
    })
  })

  it('normalizes a usable legacy prior entry while merging new measurements', async () => {
    const drums = envelope(0.4)
    const vocals = envelope(0.5)
    await setWaveforms({ drums: { md5: MD5.drums, peaks: drums } })

    expect(await saveProjectWaveforms(dir, { vocals })).toEqual({ ok: true, stored: 1 })
    expect(await readWaveforms()).toEqual({
      vocals: stamped(MD5.flac, vocals),
      drums: stamped(MD5.drums, drums)
    })
  })

  it('prunes future, stale, removed, and corrupt prior entries even with no new envelopes', async () => {
    const drums = envelope(0.4)
    await setWaveforms({
      drums: { md5: MD5.drums, peaks: drums },
      vocals: { ...stamped(MD5.flac, envelope()), version: VERSION + 1 },
      'custom-studio-id': stamped(MD5.stale, envelope()),
      'custom-removed': stamped(MD5.custom, envelope()),
      bass: { ...stamped(MD5.bass, envelope()), corrupt: true }
    })

    expect(await saveProjectWaveforms(dir, {})).toEqual({ ok: true, stored: 0 })
    expect(await readWaveforms()).toEqual({
      drums: stamped(MD5.drums, drums)
    })
  })

  it('bounds the merged cache and keeps the newest incoming measurements', async () => {
    await setWaveforms({ drums: { md5: MD5.drums, peaks: envelope(0.9) } })
    const envelopes: Record<string, number[]> = {}
    const ids: string[] = []
    await updateDoc(doc => {
      for (let index = 0; index < MAX_LANES + 4; ++index) {
        const id = `lane-${String(index).padStart(2, '0')}`
        const md5 = (index + 1).toString(16).padStart(32, '0')
        ids.push(id)
        doc.stemHashes[`${id}.flac`] = { md5, size: 1, mtimeMs: 1 }
        envelopes[id] = envelope(index / 100)
      }
    })

    expect(await saveProjectWaveforms(dir, envelopes)).toEqual({ ok: true, stored: MAX_LANES })
    const waveforms = await readWaveforms()
    expect(Object.keys(waveforms ?? {})).toEqual(ids.slice(0, MAX_LANES))
    for (const entry of Object.values(waveforms ?? {})) {
      expect(entry).toMatchObject({ version: VERSION, policy: POLICY })
      expect(entry.peaks).toHaveLength(BUCKETS)
    }
  })

  it('does not let a custom record shadow a normal stem ID', async () => {
    await updateDoc(doc => {
      doc.settings.custom!.push({
        id: 'vocals',
        label: 'Malformed collision',
        color: '#fff',
        file: 'stems/custom-take-7.mp3'
      })
    })
    const vocals = envelope(0.5)

    expect(await saveProjectWaveforms(dir, { vocals })).toEqual({ ok: true, stored: 1 })
    expect(await readWaveforms()).toEqual({ vocals: stamped(MD5.flac, vocals) })
  })

  it.each(malformed)('refuses a malformed vocal envelope: %s', async (_name, peaks) => {
    const drums = envelope(0.5)
    expect(await saveProjectWaveforms(dir, {
      vocals: peaks as number[],
      drums
    })).toEqual({ ok: true, stored: 1 })
    expect(await readWaveforms()).toEqual({
      drums: stamped(MD5.drums, drums)
    })
  })
})

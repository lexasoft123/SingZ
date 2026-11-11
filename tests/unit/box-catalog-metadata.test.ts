import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseAudioHeaderDuration, readAudioDurationSec } from '../../src/main/audio-header-duration'
import { catalogState, STATE_GLYPH, STATE_SHORT_KEY, type CatalogStateKind } from '../../src/renderer/src/box/catalog-state'
import { sortEntriesByArtist, type CollectionEntry } from '../../src/renderer/src/box/collection/types'
import { projectMetadata } from '../../src/renderer/src/box/project'
import { sideExit } from '../../src/renderer/src/box/focus'
import { artistLetter, compareSongs, letterGroups, parseSongName } from '../../src/renderer/src/box/song-identity'
import type { ProjectInfo } from '../../src/shared/types'

describe('parseSongName', () => {
  it('splits Artist - Title on hyphen, en dash and em dash', () => {
    expect(parseSongName('Pink Floyd - Wish You Were Here')).toEqual({ artist: 'Pink Floyd', title: 'Wish You Were Here' })
    expect(parseSongName('Cat Stevens – Father and Son')).toEqual({ artist: 'Cat Stevens', title: 'Father and Son' })
    expect(parseSongName('Cat Stevens — Father and Son')).toEqual({ artist: 'Cat Stevens', title: 'Father and Son' })
  })

  it('never fabricates: no separator keeps the whole name as the title', () => {
    expect(parseSongName('Donaukinder')).toEqual({ artist: null, title: 'Donaukinder' })
    // negative controls: unspaced dashes belong to the name
    expect(parseSongName('Jay-Z')).toEqual({ artist: null, title: 'Jay-Z' })
    expect(parseSongName('AC-DC')).toEqual({ artist: null, title: 'AC-DC' })
    // an empty side is not an artist/title pair
    expect(parseSongName('- Intro')).toEqual({ artist: null, title: '- Intro' })
    expect(parseSongName('Band - ')).toEqual({ artist: null, title: 'Band -' })
  })

  it('splits at the first separator and trims spaces; handles non-Latin', () => {
    expect(parseSongName('  Queen  -  Bohemian Rhapsody - Live  ')).toEqual({ artist: 'Queen', title: 'Bohemian Rhapsody - Live' })
    expect(parseSongName('A – B — C')).toEqual({ artist: 'A', title: 'B — C' })
    expect(parseSongName('Кино - Группа крови')).toEqual({ artist: 'Кино', title: 'Группа крови' })
    expect(parseSongName('周杰伦 - 晴天')).toEqual({ artist: '周杰伦', title: '晴天' })
  })
})

describe('catalog order', () => {
  const entry = (name: string, id = name): CollectionEntry => ({ id, remoteId: null, name, local: null })

  it('sorts Artist then Title, locale-aware, unknown artist last', () => {
    const sorted = sortEntriesByArtist([
      entry('Zeit'), entry('Queen - B Side'), entry('Édith Piaf - La Vie'), entry('queen - A Side'), entry('Abba - Waterloo'), entry('Mr Crowley')
    ]).map(e => e.name)
    expect(sorted).toEqual(['Abba - Waterloo', 'Édith Piaf - La Vie', 'queen - A Side', 'Queen - B Side', 'Mr Crowley', 'Zeit'])
  })

  it('negative control: the comparator is not plain code-unit order', () => {
    // A code-unit sort would put "Zed" before "édith" and "queen" after "Queen".
    expect(compareSongs(parseSongName('Édith - X'), parseSongName('Zed - X'))).toBeLessThan(0)
    expect(compareSongs(parseSongName('Zed - X'), parseSongName('Édith - X'))).toBeGreaterThan(0)
  })

  it('is stable and keeps entries addressable by id (remembered row survives reorder)', () => {
    const input = [entry('B - Song', 'one'), entry('A - Song', 'two'), entry('A - Song', 'three')]
    const sorted = sortEntriesByArtist(input)
    expect(sorted.map(e => e.id)).toEqual(['two', 'three', 'one'])
    const remembered = 'one'
    expect(input.findIndex(e => e.id === remembered)).toBe(0)
    expect(sorted.findIndex(e => e.id === remembered)).toBe(2)
  })
})

describe('letter rail', () => {
  it('derives letters, groups digits/symbols and unknown artists', () => {
    expect(artistLetter('Édith Piaf')).toBe('E')
    expect(artistLetter('Кино')).toBe('К')
    expect(artistLetter('10cc')).toBe('#')
    expect(artistLetter(null)).toBeNull()
    expect(letterGroups(['A', 'A', 'B', 'E', 'E', null, null])).toEqual([
      { letter: 'A', index: 0 }, { letter: 'B', index: 2 }, { letter: 'E', index: 3 }, { letter: '—', index: 5 }
    ])
  })

  it('negative control: grouping follows list order, never merges separated runs', () => {
    expect(letterGroups(['A', 'B', 'A']).map(g => g.index)).toEqual([0, 1, 2])
  })
})

function flacHeader(sampleRate: number, totalSamples: number): Buffer {
  const b = Buffer.alloc(42)
  b.write('fLaC', 0, 'latin1')
  b[4] = 0x00 // STREAMINFO, not last
  b.writeUIntBE(34, 5, 3)
  b[18] = (sampleRate >> 12) & 0xff
  b[19] = (sampleRate >> 4) & 0xff
  b[20] = ((sampleRate & 0x0f) << 4) | (1 << 1) // 2 channels
  b[21] = Math.floor(totalSamples / 2 ** 32) & 0x0f
  b.writeUInt32BE(totalSamples % 2 ** 32, 22)
  return b
}

function wavHeader(byteRate: number, dataBytes: number, listBytes = 0): Buffer {
  const parts = [Buffer.alloc(12), Buffer.alloc(24)]
  parts[0].write('RIFF', 0, 'latin1'); parts[0].writeUInt32LE(0, 4); parts[0].write('WAVE', 8, 'latin1')
  parts[1].write('fmt ', 0, 'latin1'); parts[1].writeUInt32LE(16, 4)
  parts[1].writeUInt16LE(1, 8); parts[1].writeUInt16LE(2, 10); parts[1].writeUInt32LE(44100, 12); parts[1].writeUInt32LE(byteRate, 16)
  if (listBytes) {
    const list = Buffer.alloc(8 + listBytes)
    list.write('LIST', 0, 'latin1'); list.writeUInt32LE(listBytes, 4)
    parts.push(list)
  }
  const data = Buffer.alloc(8)
  data.write('data', 0, 'latin1'); data.writeUInt32LE(dataBytes, 4)
  parts.push(data)
  return Buffer.concat(parts)
}

describe('header-only duration', () => {
  it('reads FLAC STREAMINFO: 44.1 kHz x 318 s', () => {
    expect(parseAudioHeaderDuration(flacHeader(44100, 44100 * 318), 1e6)).toBeCloseTo(318, 6)
    // > 2^32 samples exercises the 36-bit field
    expect(parseAudioHeaderDuration(flacHeader(48000, 2 ** 32 + 48000), 1e6)).toBeCloseTo((2 ** 32 + 48000) / 48000, 3)
  })

  it('reads WAV data size over byte rate, skipping other chunks, and handles streamed sizes', () => {
    expect(parseAudioHeaderDuration(wavHeader(176400, 176400 * 10), 1e9)).toBeCloseTo(10, 6)
    expect(parseAudioHeaderDuration(wavHeader(176400, 176400 * 10, 100), 1e9)).toBeCloseTo(10, 6)
    const streamed = wavHeader(176400, 0xffffffff)
    expect(parseAudioHeaderDuration(streamed, streamed.length + 176400 * 4)).toBeCloseTo(4, 6)
  })

  it('negative controls: unreadable headers give null, never a guess', () => {
    expect(parseAudioHeaderDuration(Buffer.from('ID3 not audio at all'), 100)).toBeNull()
    expect(parseAudioHeaderDuration(flacHeader(44100, 0), 1e6)).toBeNull()
    expect(parseAudioHeaderDuration(flacHeader(0, 1000), 1e6)).toBeNull()
    expect(parseAudioHeaderDuration(flacHeader(44100, 1000).subarray(0, 20), 1e6)).toBeNull()
    expect(parseAudioHeaderDuration(wavHeader(0, 1000), 1e6)).toBeNull()
    expect(parseAudioHeaderDuration(Buffer.alloc(0), 0)).toBeNull()
  })

  it('reads a real file without decoding it, and a missing file is null', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'singz-duration-'))
    try {
      const path = join(dir, 'vocals.flac')
      await writeFile(path, Buffer.concat([flacHeader(44100, 44100 * 5.5), Buffer.alloc(100_000)]))
      expect(await readAudioDurationSec(path)).toBeCloseTo(5.5, 3)
      expect(await readAudioDurationSec(join(dir, 'absent.flac'))).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

const info = (overrides: Partial<ProjectInfo> = {}): ProjectInfo => ({
  dir: '/p', name: 'Pink Floyd - Time', formatVersion: 2, settings: { transpose: 0, tracks: {} },
  stems: { vocals: '/p/vocals.flac' }, hasLyrics: true, inLibrary: true, ...overrides
})

describe('project metadata duration and identity', () => {
  it('shows the stored header duration before the song is ever opened', () => {
    const metadata = projectMetadata(info({ durationSec: 318.4 }))
    expect(metadata.duration).toBe(318.4)
    expect(metadata.artist).toBe('Pink Floyd')
    expect(metadata.title).toBe('Time')
  })

  it('prefers the engine-measured duration, and never invents one', () => {
    expect(projectMetadata(info({ durationSec: 100 }), 99).duration).toBe(99)
    expect(projectMetadata(info()).duration).toBeNull()
    expect(projectMetadata(info({ durationSec: Number.NaN })).duration).toBeNull()
    expect(projectMetadata(info({ name: 'Zeit' })).artist).toBeNull()
  })
})

describe('state indicators', () => {
  const base = { downloading: false, unavailable: false, local: true, localHasStems: true, readiness: 'ready' as const }
  const cases: [CatalogStateKind, Parameters<typeof catalogState>[0]][] = [
    ['downloading', { ...base, downloading: true, local: false }],
    ['download', { ...base, local: false, localHasStems: false, readiness: undefined }],
    ['lyrics', { ...base, readiness: 'needs-lyrics' }],
    ['prepare', { ...base, readiness: 'unprepared' }],
    ['repair', { ...base, readiness: 'damaged' }]
  ]

  it.each(cases)('maps %s', (kind, input) => expect(catalogState(input)).toBe(kind))

  it('also maps unavailable references and uninspected unprepared rows', () => {
    expect(catalogState({ ...base, local: false, unavailable: true })).toBe('repair')
    expect(catalogState({ ...base, readiness: undefined, localHasStems: false })).toBe('prepare')
  })

  it('negative controls: ready rows have no badge; each state has its own glyph and word', () => {
    expect(catalogState(base)).toBeNull()
    expect(catalogState({ ...base, readiness: undefined })).toBeNull() // stems present, inspection pending
    const kinds = cases.map(([kind]) => kind)
    expect(new Set(kinds.map(kind => STATE_GLYPH[kind])).size).toBe(5)
    expect(new Set(kinds.map(kind => STATE_SHORT_KEY[kind])).size).toBe(5)
  })
})

describe('letter rail remote hand-over', () => {
  interface Container { attrs: Record<string, string>; members: string[] }
  const el = (name: string, selector: string, container: Container, current = false) => ({
    name,
    dataset: current ? { current: 'true' } : {},
    matches: (sel: string) => sel === selector,
    closest: (sel: string) => container.attrs[sel.slice(1, -1)] !== undefined
      ? { getAttribute: (n: string) => container.attrs[n] ?? null, contains: (x: { name?: string }) => container.members.includes(x?.name ?? '') }
      : null
  })
  it('sends Right to the current letter and Left to the remembered row; other keys fall through', () => {
    const rows: Container = { attrs: { 'data-remote-right': '.letter' }, members: ['row', 'other'] }
    const rail: Container = { attrs: { 'data-remote-left': '.row' }, members: ['A', 'B'] }
    const row = el('row', '.row', rows, true)
    const a = el('A', '.letter', rail)
    const b = el('B', '.letter', rail, true)
    const other = el('other', '.row', rows)
    const targets = [row, a, b, other] as unknown as HTMLElement[]
    const scope = { contains: () => true } as never
    expect(sideExit(scope, row as never, targets, 'ArrowRight')).toBe(b)
    expect(sideExit(scope, a as never, targets, 'ArrowLeft')).toBe(row)
    // negative controls: vertical keys and the wrong side are untouched
    expect(sideExit(scope, row as never, targets, 'ArrowDown')).toBeNull()
    expect(sideExit(scope, row as never, targets, 'ArrowLeft')).toBeNull()
  })
})

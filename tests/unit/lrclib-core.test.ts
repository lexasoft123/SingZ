/**
 * The shared LRCLIB core (src/shared/lrclib-core.ts) — one logic for desktop
 * and phone. The cp1251 table replaces TextDecoder('windows-1251') (Hermes
 * has no non-UTF8 decoders), so its equality is proven per byte here; the
 * LRC fixture is the same file mobile jest asserts against, so the two
 * runners cannot drift in parsing or word timing.
 */
import { describe, expect, it } from 'vitest'
import {
  cp1251FromLatin1,
  fixTagEncoding,
  lookupLyrics,
  metaFromFilename,
  parseLrc,
  realArtist,
  searchCandidates,
  type ApiAnswer
} from '../../src/shared/lrclib-core'
import fixture from '../shared/lrc-fixture.json'

describe('cp1251FromLatin1 — table equals TextDecoder, per byte', () => {
  it('matches windows-1251 for every byte 0x00–0xFF', () => {
    for (let b = 0; b <= 0xff; b++) {
      const viaTable = cp1251FromLatin1(String.fromCharCode(b))
      const viaDecoder = new TextDecoder('windows-1251').decode(Uint8Array.of(b))
      expect(viaTable, `byte 0x${b.toString(16)}`).toBe(viaDecoder)
    }
  })

  it('matches on a full mixed string', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i)
    const latin1 = Array.from(bytes, (b) => String.fromCharCode(b)).join('')
    expect(cp1251FromLatin1(latin1)).toBe(new TextDecoder('windows-1251').decode(bytes))
  })
})

describe('fixTagEncoding', () => {
  it('repairs CP1251-as-Latin-1 soup', () => {
    expect(fixTagEncoding('Àðèÿ')).toBe('Ария')
    expect(fixTagEncoding('Ìåëüíèöà')).toBe('Мельница')
  })
  it('leaves honest Latin-1 alone', () => {
    expect(fixTagEncoding('Motörhead')).toBe('Motörhead')
    expect(fixTagEncoding('Für Elise')).toBe('Für Elise')
  })
  it('leaves real Cyrillic and plain ASCII alone', () => {
    expect(fixTagEncoding('Ария')).toBe('Ария')
    expect(fixTagEncoding('Sixteen Tons')).toBe('Sixteen Tons')
    expect(fixTagEncoding(undefined)).toBeUndefined()
  })
})

describe('realArtist', () => {
  it('drops ripper placeholders, keeps real names', () => {
    expect(realArtist('Unknown Artist')).toBeUndefined()
    expect(realArtist('Артист')).toBeUndefined()
    expect(realArtist('Merle Travis')).toBe('Merle Travis')
  })
})

describe('metaFromFilename', () => {
  it('strips track numbers, brackets and extensions', () => {
    expect(metaFromFilename('08. Sixteen Tons [Am +2st].mp3')).toEqual({
      title: 'Sixteen Tons',
      altTitle: '08. Sixteen Tons'
    })
  })
  it('splits artist - title', () => {
    expect(metaFromFilename('Merle Travis - Sixteen Tons.flac')).toEqual({
      artist: 'Merle Travis',
      title: 'Sixteen Tons'
    })
  })
  it('keeps numeric titles reachable via altTitle', () => {
    const m = metaFromFilename('212-85-06.mp3')
    expect(m.altTitle).toBe('212-85-06')
  })
})

describe('parseLrc — the shared fixture', () => {
  it('reproduces tests/shared/lrc-fixture.json exactly', () => {
    expect(parseLrc(fixture.lrc, fixture.duration)).toEqual(fixture.lines)
  })
})

const REC = {
  id: 7,
  trackName: 'Sixteen Tons',
  artistName: 'Merle Travis',
  duration: 156,
  syncedLyrics: '[00:04.80] You load sixteen tons'
}

function fakeApi(routes: Record<string, ApiAnswer>): (path: string) => Promise<ApiAnswer> {
  return async (path: string) => {
    for (const [prefix, answer] of Object.entries(routes)) {
      if (path.startsWith(prefix)) return answer
    }
    return 'miss'
  }
}

describe('lookupLyrics — miss vs down vs hit', () => {
  const meta = { artist: 'Merle Travis', title: 'Sixteen Tons', durationSec: 156 }

  it('hits via the exact triple', async () => {
    const out = await lookupLyrics(fakeApi({ '/get?': { json: REC } }), meta)
    expect(out).toMatchObject({ hit: { credit: 'Merle Travis — Sixteen Tons' } })
  })

  it('falls through to search and respects duration tolerance', async () => {
    const far = { ...REC, id: 8, duration: 170 }
    const near = { ...REC, id: 9, duration: 158 }
    const out = await lookupLyrics(
      fakeApi({ '/get?': 'miss', '/search?': { json: [far, near] } }),
      meta
    )
    expect(out).toMatchObject({ hit: {} })
    const none = await lookupLyrics(
      fakeApi({ '/get?': 'miss', '/search?': { json: [far] } }),
      meta
    )
    expect(none).toBe('miss')
  })

  it('answers down when any query went unanswered', async () => {
    const out = await lookupLyrics(fakeApi({ '/get?': 'down', '/search?': 'down' }), meta)
    expect(out).toBe('down')
  })

  it('a miss stays a miss — never down', async () => {
    const out = await lookupLyrics(fakeApi({}), meta)
    expect(out).toBe('miss')
  })

  it('retries the unstripped altTitle', async () => {
    const calls: string[] = []
    const api = async (path: string): Promise<ApiAnswer> => {
      calls.push(path)
      return path.includes('212-85-06') ? { json: [{ ...REC, trackName: '212-85-06' }] } : 'miss'
    }
    const out = await lookupLyrics(api, {
      title: '85-06',
      altTitle: '212-85-06',
      durationSec: 156
    })
    expect(out).toMatchObject({ hit: {} })
    expect(calls.some((c) => c.includes('212-85-06'))).toBe(true)
  })
})

describe('searchCandidates', () => {
  it('sorts synced first, then closest duration', async () => {
    const recs = [
      { ...REC, id: 1, duration: 200, syncedLyrics: null, plainLyrics: 'x' },
      { ...REC, id: 2, duration: 190 },
      { ...REC, id: 3, duration: 157 }
    ]
    const out = await searchCandidates(fakeApi({ '/search?': { json: recs } }), { title: 'x' }, 156)
    expect(out.map((c) => c.id)).toEqual([3, 2, 1])
  })
})

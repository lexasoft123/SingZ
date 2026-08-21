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
  primaryArtist,
  realArtist,
  searchCandidates,
  stripSitePrefix,
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

describe('primaryArtist — the lead credit alone', () => {
  it('drops featured guests however the tag spells them', () => {
    expect(primaryArtist('Женя Трофимов feat. Nansi & Sidorov')).toBe('Женя Трофимов')
    expect(primaryArtist('Женя Трофимов, NANSI & SIDOROV')).toBe('Женя Трофимов')
    expect(primaryArtist('Eminem ft. Rihanna')).toBe('Eminem')
    expect(primaryArtist('Calvin Harris Featuring Dua Lipa')).toBe('Calvin Harris')
    expect(primaryArtist('Tiesto x Karol G')).toBe('Tiesto')
    expect(primaryArtist('Metallica vs. Slayer')).toBe('Metallica')
    expect(primaryArtist('Bob Dylan with The Band')).toBe('Bob Dylan')
  })

  it('splits Cyrillic "и" — JS word boundaries never fire around it', () => {
    expect(primaryArtist('Дискотека Авария и Жанна Фриске')).toBe('Дискотека Авария')
  })

  it('leaves a name with no collaboration marker alone', () => {
    expect(primaryArtist('Merle Travis')).toBeUndefined()
    expect(primaryArtist('Maxx')).toBeUndefined()
    expect(primaryArtist('Крематорий')).toBeUndefined()
    expect(primaryArtist(undefined)).toBeUndefined()
  })

  it('refuses a lead too short to be worth a query', () => {
    expect(primaryArtist('M x Y')).toBeUndefined()
  })

  it('is idempotent, so the retry rung cannot recurse forever', () => {
    const lead = primaryArtist('A One, A Two, A Three')
    expect(lead).toBe('A One')
    expect(primaryArtist(lead)).toBeUndefined()
  })
})

describe('stripSitePrefix — the download site glued to the artist', () => {
  it('cuts a _Download_ run off the front', () => {
    // the field case, straight out of the log
    expect(stripSitePrefix('AudioCleaner_Download_Notre Dame de Paris')).toBe(
      'Notre Dame de Paris'
    )
    expect(stripSitePrefix('get-mp3-Ария')).toBe('Ария')
  })

  it('cuts a leading domain, whatever separator follows', () => {
    expect(stripSitePrefix('Muzoi.net - Артист')).toBe('Артист')
    expect(stripSitePrefix('Sefon.Pro_Ария')).toBe('Ария')
    expect(stripSitePrefix('zaycev.net Ария')).toBe('Ария')
    expect(stripSitePrefix('www.muzmo.ru | Кино')).toBe('Кино')
  })

  it('cuts a bracketed site tag, which only filenames ever had stripped', () => {
    expect(stripSitePrefix('[muzmo.ru] Ария')).toBe('Ария')
    expect(stripSitePrefix('(sefon.pro) Ария')).toBe('Ария')
  })

  it('leaves real names alone, dots and all', () => {
    // every one of these is a name a site-shaped stripper could ruin
    for (const name of [
      'Notre Dame de Paris',
      'will.i.am',
      'R.E.M.',
      'Mr. Bungle',
      'St. Vincent',
      'Panic! At The Disco',
      'AC/DC',
      'Ария',
      'Simon & Garfunkel',
      'Blink-182',
      '3 Doors Down',
      'Nine Inch Nails'
    ]) {
      expect(stripSitePrefix(name)).toBeUndefined()
    }
    expect(stripSitePrefix(undefined)).toBeUndefined()
  })

  it('refuses when nothing nameable would be left', () => {
    // the site IS the whole credit — there is nothing to salvage, and a
    // half-stripped fragment is a worse query than the tag itself
    expect(stripSitePrefix('muzmo.ru')).toBeUndefined()
    expect(stripSitePrefix('muzmo.ru - 128')).toBeUndefined()
  })

  it('is idempotent, so the retry rung cannot cycle', () => {
    const clean = stripSitePrefix('AudioCleaner_Download_Notre Dame de Paris')
    expect(clean).toBe('Notre Dame de Paris')
    expect(stripSitePrefix(clean)).toBeUndefined()
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

  it('retries the lead artist when the tag credits guests LRCLIB spells differently', async () => {
    // The field case: the mp3 is tagged "Женя Трофимов feat. Nansi & Sidorov"
    // and LRCLIB holds it as "Женя Трофимов". Both artist-constrained queries
    // for the full credit come back empty; the lead name finds it.
    const REAL = {
      id: 17492551,
      artistName: 'Женя Трофимов',
      trackName: 'Вторая весна (к/ф «Ландыши. Такая нежная любовь»)',
      duration: 210.886531,
      syncedLyrics: '[00:21.30] Вторая весна'
    }
    const calls: string[] = []
    const api = async (path: string): Promise<ApiAnswer> => {
      calls.push(path)
      if (!path.startsWith('/search?')) return 'miss'
      const artist = new URLSearchParams(path.slice('/search?'.length)).get('artist_name')
      return artist === 'Женя Трофимов' ? { json: [REAL] } : { json: [] }
    }
    const retries: string[] = []
    const out = await lookupLyrics(
      api,
      {
        artist: 'Женя Трофимов feat. Nansi & Sidorov',
        title: 'Вторая весна',
        durationSec: 210.873
      },
      (m) => retries.push(m)
    )
    expect(out).toMatchObject({ hit: { credit: expect.stringContaining('Женя Трофимов') } })
    expect(retries).toContain('retrying LRCLIB with the lead artist: Женя Трофимов')
    // the full credit is still asked first — narrowing is a fallback, never
    // the opening query
    expect(calls[0]).toContain('artist_name=%D0%96%D0%B5%D0%BD%D1%8F+%D0%A2%D1%80%D0%BE%D1%84%D0%B8%D0%BC%D0%BE%D0%B2+feat.')
  })

  it('does not narrow the artist when the full credit already hit', async () => {
    const calls: string[] = []
    const api = async (path: string): Promise<ApiAnswer> => {
      calls.push(path)
      return path.startsWith('/get?') ? { json: REC } : 'miss'
    }
    const out = await lookupLyrics(api, {
      artist: 'Merle Travis & The Boys',
      title: 'Sixteen Tons',
      durationSec: 156
    })
    expect(out).toMatchObject({ hit: {} })
    expect(calls).toHaveLength(1)
  })

  it('a down inside the lead-artist retry is not reported as a miss', async () => {
    // Only the narrowed queries go unanswered — the verdict must stay unknown,
    // or the outage becomes a whisper transcription that sticks forever.
    const artistOf = (path: string): string | null =>
      new URLSearchParams(path.slice(path.indexOf('?') + 1)).get('artist_name')
    const api = async (path: string): Promise<ApiAnswer> =>
      artistOf(path) === 'Merle Travis' ? 'down' : 'miss'
    const out = await lookupLyrics(api, {
      artist: 'Merle Travis feat. Tex Ritter',
      title: 'Sixteen Tons',
      durationSec: 156
    })
    expect(out).toBe('down')
  })

  it('retries without the download-site prefix the rip glued to the artist', async () => {
    // The field case: "AudioCleaner_Download_Notre Dame de Paris — Belle",
    // 284s, no match — while LRCLIB holds it synced at exactly 284.0s.
    const REAL = {
      id: 1,
      artistName: 'From Notre Dame de Paris',
      trackName: 'Belle',
      duration: 284,
      syncedLyrics: '[00:12.00] Belle'
    }
    const api = async (path: string): Promise<ApiAnswer> => {
      if (!path.startsWith('/search?')) return 'miss'
      const artist = new URLSearchParams(path.slice('/search?'.length)).get('artist_name')
      return artist === 'Notre Dame de Paris' ? { json: [REAL] } : { json: [] }
    }
    const retries: string[] = []
    const out = await lookupLyrics(
      api,
      {
        artist: 'AudioCleaner_Download_Notre Dame de Paris',
        title: 'Belle',
        durationSec: 284
      },
      (m) => retries.push(m)
    )
    expect(out).toMatchObject({ hit: { credit: 'From Notre Dame de Paris — Belle' } })
    expect(retries).toContain(
      'retrying LRCLIB with the artist without the site tag: Notre Dame de Paris'
    )
  })

  it('asks the tag as written first, and stops the moment it answers', async () => {
    const calls: string[] = []
    const api = async (path: string): Promise<ApiAnswer> => {
      calls.push(path)
      return path.startsWith('/get?') ? { json: REC } : 'miss'
    }
    const out = await lookupLyrics(api, {
      artist: 'Muzoi.net - Merle Travis',
      title: 'Sixteen Tons',
      durationSec: 156
    })
    expect(out).toMatchObject({ hit: {} })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('Muzoi.net')
  })

  it('bounds the query count — the artist dimension is a loop, not a recursion', async () => {
    // Worst case on record: a site prefix AND a featured guest AND an
    // altTitle, every query a miss. Four artist spellings x two questions,
    // twice over for the two titles.
    const calls: string[] = []
    const api = async (path: string): Promise<ApiAnswer> => {
      calls.push(path)
      return 'miss'
    }
    const out = await lookupLyrics(api, {
      artist: 'muzmo.ru - Женя Трофимов feat. Nansi',
      title: '85-06',
      altTitle: '212-85-06',
      durationSec: 156
    })
    expect(out).toBe('miss')
    expect(calls.length).toBeLessThanOrEqual(16)
    // and every spelling really was distinct — no wasted duplicate queries
    expect(new Set(calls).size).toBe(calls.length)
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

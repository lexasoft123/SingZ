import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fixTagEncoding, metaFromFilename, realArtist } from '../../src/main/lrclib'
import { readTrackMeta } from '../../src/main/lyrics'

describe('fixTagEncoding', () => {
  it('repairs CP1251 read as Latin-1', () => {
    expect(fixTagEncoding('Àðòèñò')).toBe('Артист')
    expect(fixTagEncoding('Øòèëü')).toBe('Штиль')
    expect(fixTagEncoding('Àðèÿ')).toBe('Ария')
  })

  it('repairs mixed ASCII + mojibake when the soup dominates', () => {
    expect(fixTagEncoding('DDT - Îñåíü')).toBe('DDT - Осень')
  })

  it('leaves real Latin-1 names alone', () => {
    expect(fixTagEncoding('Motörhead')).toBe('Motörhead')
    expect(fixTagEncoding('Für Elise')).toBe('Für Elise')
    expect(fixTagEncoding('Ça plane pour moi')).toBe('Ça plane pour moi')
  })

  it('leaves proper Cyrillic and plain ASCII alone', () => {
    expect(fixTagEncoding('Ария')).toBe('Ария')
    expect(fixTagEncoding('Sixteen Tons')).toBe('Sixteen Tons')
    expect(fixTagEncoding(undefined)).toBeUndefined()
  })

  it('never touches strings with characters beyond Latin-1', () => {
    expect(fixTagEncoding('Àðòèñò — òåñò')).toBe('Àðòèñò — òåñò') // em dash blocks byte roundtrip
  })
})

describe('realArtist', () => {
  it('drops ripper placeholders in both languages', () => {
    expect(realArtist('Артист')).toBeUndefined()
    expect(realArtist('artist')).toBeUndefined()
    expect(realArtist('Unknown Artist')).toBeUndefined()
    expect(realArtist(undefined)).toBeUndefined()
  })

  it('keeps real artists', () => {
    expect(realArtist('Ария')).toBe('Ария')
    expect(realArtist('The Artist Formerly Known As Prince')).toBeTruthy()
  })
})

/** Minimal ID3v2.3 tag: given frames (encoding 0 bytes), then a fake mp3 body. */
function mp3WithId3(frames: Array<[string, Buffer]>): Buffer {
  const frameBufs = frames.map(([id, data]) => {
    const head = Buffer.alloc(10)
    head.write(id, 0, 'latin1')
    head.writeUInt32BE(data.length + 1, 4) // + encoding byte
    return Buffer.concat([head, Buffer.from([0]), data])
  })
  const body = Buffer.concat(frameBufs)
  const header = Buffer.alloc(10)
  header.write('ID3', 0, 'latin1')
  header[3] = 3 // v2.3
  // synchsafe size
  header[6] = (body.length >> 21) & 0x7f
  header[7] = (body.length >> 14) & 0x7f
  header[8] = (body.length >> 7) & 0x7f
  header[9] = body.length & 0x7f
  // one MPEG1 Layer3 44.1kHz 128kbps frame header + silence-ish payload
  const mpeg = Buffer.alloc(417)
  mpeg.set([0xff, 0xfb, 0x90, 0x00])
  return Buffer.concat([header, body, mpeg])
}

const cp1251 = (s: string): Buffer =>
  Buffer.from(
    Array.from(s, (ch) => {
      const c = ch.codePointAt(0) as number
      if (c === 0x401) return 0xa8
      if (c === 0x451) return 0xb8
      return c >= 0x410 && c <= 0x44f ? c - 0x410 + 0xc0 : c
    })
  )

describe('readTrackMeta', () => {
  it('junk CP1251 tags lose to the filename (the Штиль case)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'singz-meta-'))
    const file = join(dir, 'Ария - Штиль.mp3')
    // his split copy: artist tag is the placeholder "Артист", title "Штиль",
    // both CP1251 bytes in encoding-0 frames
    writeFileSync(
      file,
      mp3WithId3([
        ['TPE1', cp1251('Артист')],
        ['TIT2', cp1251('Штиль')]
      ])
    )
    const { meta, fromFile } = await readTrackMeta(file, 336)
    expect(meta.title).toBe('Штиль') // mojibake repaired
    expect(meta.artist).toBe('Ария') // placeholder dropped → filename artist
    expect(fromFile.artist).toBe('Ария')
    expect(fromFile.title).toBe('Штиль')
  })

  it('repaired tag title survives even when the filename disagrees', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'singz-meta-'))
    const file = join(dir, 'track07.mp3')
    writeFileSync(file, mp3WithId3([['TIT2', cp1251('Штиль')]]))
    const { meta } = await readTrackMeta(file, 336)
    expect(meta.title).toBe('Штиль') // only reachable through the CP1251 repair
  })

  it('clean tags win over the filename', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'singz-meta-'))
    const file = join(dir, '01 - track.mp3')
    writeFileSync(
      file,
      mp3WithId3([
        ['TPE1', Buffer.from('Johnny Cash', 'latin1')],
        ['TIT2', Buffer.from('Hurt', 'latin1')]
      ])
    )
    const { meta } = await readTrackMeta(file, 216)
    expect(meta.artist).toBe('Johnny Cash')
    expect(meta.title).toBe('Hurt')
  })
})

describe('metaFromFilename', () => {
  it('splits artist — title from the Штиль filename', () => {
    expect(metaFromFilename('Ария - Штиль.mp3')).toEqual({ artist: 'Ария', title: 'Штиль' })
  })
})

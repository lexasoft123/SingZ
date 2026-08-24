/**
 * The display split for "Artist — Title" project names. Real libraries carry
 * every dash variant — the em dash the desktop writes, the plain hyphen
 * people type — and the split must never break a hyphenated word.
 */
import { splitSongName } from '../src/ui/bits'

describe('splitSongName', () => {
  it('splits on a spaced em dash', () => {
    expect(splitSongName('Cat Stevens — Father and Son')).toEqual({
      artist: 'Cat Stevens',
      title: 'Father and Son'
    })
  })
  it('splits on a spaced hyphen', () => {
    expect(splitSongName('Pink Floyd - Wish You Were Here')).toEqual({
      artist: 'Pink Floyd',
      title: 'Wish You Were Here'
    })
  })
  it('splits on a spaced en dash', () => {
    expect(splitSongName('Rammstein – Puppe')).toEqual({ artist: 'Rammstein', title: 'Puppe' })
  })
  it('leaves an undashed name whole', () => {
    expect(splitSongName('Going To The Run')).toEqual({ artist: null, title: 'Going To The Run' })
  })
  it('leaves hyphenated words whole — the spaces are the separator', () => {
    expect(splitSongName('T-Rex Boogie')).toEqual({ artist: null, title: 'T-Rex Boogie' })
  })
  it('splits at the FIRST separator when there are several', () => {
    expect(splitSongName('AC - DC - Back in Black')).toEqual({
      artist: 'AC',
      title: 'DC - Back in Black'
    })
  })
})

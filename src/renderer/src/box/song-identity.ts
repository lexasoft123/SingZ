/**
 * Artist / title for the Box catalog.
 *
 * Neither the project document nor the library stores an artist, so the only
 * source is the song name. Library names that embed one use "Artist - Title"
 * with a hyphen, en dash or em dash. A separator counts only when it is
 * surrounded by whitespace ("Jay-Z", "AC-DC" stay whole) and both sides are
 * non-empty. With several separators the FIRST one splits: artists rarely
 * contain " - ", titles ("Song - Live", "Part 1 - Intro") often do.
 * No separator -> artist is null (shown as "—") and the title is the name.
 */
export interface SongIdentity {
  artist: string | null
  title: string
}

const SEPARATOR = /\s[-–—]\s/

export function parseSongName(name: string): SongIdentity {
  const trimmed = name.trim()
  const match = SEPARATOR.exec(trimmed)
  if (!match) return { artist: null, title: trimmed || name }
  const artist = trimmed.slice(0, match.index).trim()
  const title = trimmed.slice(match.index + match[0].length).trim()
  if (!artist || !title) return { artist: null, title: trimmed || name }
  return { artist, title }
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

/** Artist, then title; locale-aware; songs with no known artist come last. */
export function compareSongs(a: SongIdentity, b: SongIdentity): number {
  if ((a.artist === null) !== (b.artist === null)) return a.artist === null ? 1 : -1
  return (a.artist !== null && b.artist !== null ? collator.compare(a.artist, b.artist) : 0) ||
    collator.compare(a.title, b.title)
}

/** Rail letter for an artist: first letter upper-cased without accents; digits
 *  and symbols share "#"; an unknown artist is null. */
export function artistLetter(artist: string | null): string | null {
  if (artist === null) return null
  const first = Array.from(artist.normalize('NFD'))[0]
  if (!first) return null
  const upper = first.toLocaleUpperCase()
  return /\p{L}/u.test(upper) ? upper : '#'
}

export interface LetterGroup {
  letter: string
  /** Index of the first song under this letter. */
  index: number
}

/** First index of each rail letter. `letters` follows the (sorted) list order;
 *  songs with an unknown artist form the trailing "—" group. */
export function letterGroups(letters: (string | null)[]): LetterGroup[] {
  const groups: LetterGroup[] = []
  letters.forEach((raw, index) => {
    const letter = raw ?? '—'
    if (groups[groups.length - 1]?.letter !== letter) groups.push({ letter, index })
  })
  return groups
}

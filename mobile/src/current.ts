import type { ProjectDoc } from './model'

/**
 * "Is the copy we have the file we want?" — said once, in one place.
 *
 * The same ladder runs in three settings: the natives answer it per file on
 * open (they can afford to hash), the library ✓ answers it for a whole song
 * with sizes alone, and the tests' reference native answers it over a temp
 * folder. Four independent copies of these five lines is how the phone came to
 * show a song as downloaded and then download it.
 */

export interface FileFacts {
  /** Bytes on disk. */
  size: number
  /** Only when someone has actually hashed it — the ✓ never does. */
  md5?: string
}

export interface FileWant {
  /** Project-relative, e.g. "stems/vocals.flac". */
  path: string
  size: number
  md5: string
}

/**
 * Missing, wrong size, wrong bytes → not ours. With no md5 to compare against
 * (an older desktop's project.json) the size is all there is; with no size
 * either, nothing has been stated and only a fetch can settle it.
 */
export function isCurrent(have: FileFacts | null | undefined, want: { size: number; md5?: string }): boolean {
  if (!have) return false
  if (want.size > 0 && have.size !== want.size) return false
  if (!want.md5) return want.size > 0
  return have.md5 === want.md5
}

/**
 * Every file the project is made of, as project.json states it: the six stems,
 * the singer's own tracks, and lyrics.json when the doc carries its hash.
 * Audio only by default — the ✓ counts what lands in the download folder, and
 * lyrics ride in prefs rather than on disk.
 */
export function filesOfProject(doc: ProjectDoc | undefined, opts?: { lyrics?: boolean }): FileWant[] {
  const out: FileWant[] = []
  for (const [name, h] of Object.entries(doc?.stemHashes ?? {})) {
    out.push({ path: `stems/${name}`, size: Number(h?.size ?? 0), md5: String(h?.md5 ?? '') })
  }
  const lyrics = doc?.lyricsHash
  if (opts?.lyrics && lyrics) {
    out.push({ path: 'lyrics.json', size: Number(lyrics.size ?? 0), md5: String(lyrics.md5 ?? '') })
  }
  return out
}

import type { TorrentFile, TorrentFormat, TorrentRelease, TorrentTransport } from './torrent'

export interface TorrentSongMatch {
  release: TorrentRelease
  file: TorrentFile
}
export interface TorrentSongProgress {
  checked: number
  known: number
  hasMore: boolean
  stopped: boolean
  stage: 'releases' | 'files' | 'idle'
}
export interface TorrentSongResults {
  matches: TorrentSongMatch[]
  progress: TorrentSongProgress
}
const words = (value: string): string[] =>
  value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/\p{M}/gu, '')
    .match(/[\p{L}\p{N}]+/gu) ?? []
/** Match the audio basename, never a folder/album name standing in for a song. */
export function torrentSongMatches(file: TorrentFile, title: string): boolean {
  const wanted = words(title),
    present = new Set(words(file.name.replace(/\.[^.]+$/, '')))
  return wanted.length > 0 && wanted.every((word) => present.has(word))
}

/** Artist-scoped discovery, in explicit batches. Only .torrent metadata is read.
 * A failed release stays at the cursor so Continue retries it, never silently
 * treating an unavailable file list as a searched release with no matching song. */
export class TorrentSongFinder {
  private releases: TorrentRelease[] = []
  private seen = new Set<string>()
  private matches: TorrentSongMatch[] = []
  private cursor = 0
  private offset = 0
  private morePages = true
  private stopped = false
  private stage: TorrentSongProgress['stage'] = 'idle'
  constructor(
    private transport: TorrentTransport,
    readonly artist: string,
    readonly title: string,
    private format: TorrentFormat
  ) {
    if (!artist.trim() || artist.length > 195 || !words(title).length || title.length > 200)
      throw new Error(
        'Enter an artist and song title (artist up to 195 characters, title up to 200).'
      )
  }
  cancel(): void {
    this.stopped = true
  }
  get results(): TorrentSongResults {
    return {
      matches: [...this.matches].sort(
        (a, b) =>
          b.release.seeders - a.release.seeders ||
          a.release.id.localeCompare(b.release.id) ||
          a.file.path.localeCompare(b.file.path)
      ),
      progress: {
        checked: this.cursor,
        known: this.releases.length,
        hasMore: this.cursor < this.releases.length || this.morePages,
        stopped: this.stopped,
        stage: this.stage
      }
    }
  }
  private async call<T>(request: Parameters<TorrentTransport>[0]): Promise<T> {
    const result = await this.transport(request)
    if (!result.ok) throw new Error(result.error)
    return result.data as T
  }
  async next(report: (result: TorrentSongResults) => void): Promise<TorrentSongResults> {
    this.stopped = false
    let checked = 0,
      pages = 0
    try {
      while (!this.stopped && checked < 10) {
        if (this.cursor >= this.releases.length) {
          if (!this.morePages || pages >= 2) break
          this.stage = 'releases'
          report(this.results)
          const page = await this.call<{
            releases: TorrentRelease[]
            nextOffset: number
            hasMore: boolean
          }>({
            op: 'search',
            query: this.artist.trim() + (this.format === 'mp3' ? ' mp3' : ''),
            offset: this.offset,
            mode: 'release'
          })
          if (this.stopped) break
          if (page.hasMore && page.nextOffset <= this.offset)
            throw new Error('RuTracker did not advance the search page. Try again later.')
          this.offset = page.nextOffset
          this.morePages = page.hasMore
          for (const release of [...page.releases].sort((a, b) => b.seeders - a.seeders)) {
            if (!this.seen.has(release.id)) {
              this.seen.add(release.id)
              this.releases.push(release)
            }
          }
          ++pages
          report(this.results)
          continue
        }
        this.stage = 'files'
        report(this.results)
        const release = this.releases[this.cursor]
        let files: TorrentFile[]
        try {
          files = (await this.call<{ files: TorrentFile[] }>({ op: 'files', release: release.id }))
            .files
        } catch (error) {
          if (!(error instanceof Error && /no supported audio files/i.test(error.message)))
            throw error
          files = []
        }
        for (const file of files) {
          if (
            (this.format === 'all' || /\.mp3$/i.test(file.name)) &&
            torrentSongMatches(file, this.title)
          )
            this.matches.push({ release, file })
        }
        ++this.cursor
        ++checked
        report(this.results)
      }
    } finally {
      this.stage = 'idle'
      report(this.results)
    }
    return this.results
  }
}

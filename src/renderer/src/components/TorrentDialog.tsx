import { useEffect, useRef, useState } from 'react'
import { Modal } from '@singz/ui'
import {
  TORRENT_FILENAME_SEARCH_ENABLED,
  TorrentFlow,
  type TorrentViewState,
  type TorrentImport
} from '../../../shared/torrent'
import './torrent.css'
import TorrentDownloads from './TorrentDownloads'
import type { TorrentJob } from '../../../shared/torrent'

const fmt = (n: number): string =>
  n >= 1e9
    ? (n / 1e9).toFixed(1) + ' GB'
    : n >= 1e6
      ? (n / 1e6).toFixed(1) + ' MB'
      : Math.max(0, Math.round(n / 1e3)) + ' KB'
export default function TorrentDialog({
  onClose,
  onImport
}: {
  onClose: () => void
  onImport: (file: TorrentImport) => void
}): React.JSX.Element {
  const ref = useRef<TorrentFlow | null>(null)
  const [state, setState] = useState<TorrentViewState | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('')
  const mounted = useRef(false)
  const consuming = useRef(false)
  const [importing, setImporting] = useState(false)
  const close = (): void => {
    if (!consuming.current) onClose()
  }
  useEffect(() => {
    mounted.current = true
    const flow = new TorrentFlow((request) => window.singz.torrentRequest(request))
    ref.current = flow
    const off = flow.subscribe(() => setState(flow.state))
    setState(flow.state)
    void flow.initialize()
    return () => {
      mounted.current = false
      off()
      flow.dispose()
      ref.current = null
    }
  }, [])
  const flow = ref.current
  const selected = state?.listing?.files.find((f) => f.index === state.selected)
  const importSong = async (job?: TorrentJob): Promise<void> => {
    if (consuming.current) return
    consuming.current = true
    setImporting(true)
    const file = await ref.current?.consume(job)
    consuming.current = false
    if (!mounted.current) return
    setImporting(false)
    if (file) onImport(file)
  }
  return (
    <Modal onClose={close} cardClassName="torrent-dialog" aria-label="Add a song from RuTracker">
      <header className="torrent-heading">
        <div>
          <span className="torrent-eyebrow">Add song / RuTracker</span>
          <h2>{state?.view === 'download' ? 'Your downloads' : 'Find your next song'}</h2>
        </div>
        <button className="pill ghost" disabled={state?.busy} onClick={() => flow?.downloads()}>
          Downloads ({state?.queue.downloads.length ?? 0})
        </button>
        <button className="pill ghost" disabled={state?.busy} onClick={() => flow?.account()}>
          {state?.connected ? 'RuTracker account' : 'Sign in'}
        </button>
        <button
          className="pill ghost"
          disabled={importing}
          onClick={close}
          aria-label="Close torrent search"
        >
          ×
        </button>
      </header>
      {state?.error && (
        <div role="alert" className="torrent-error">
          {state.error}
        </div>
      )}
      {!state || state.busy ? (
        <p role="status" className="torrent-busy">
          Working…
        </p>
      ) : null}
      {state?.view === 'account' ? (
        <section className="torrent-account">
          <h3>{state.connected ? 'Connected to RuTracker' : 'Bring your RuTracker account'}</h3>
          <p>
            {state.connected
              ? 'Return to search, or sign out to switch accounts.'
              : 'Sign in on the RuTracker website inside SingZ. Your password stays with the site.'}
          </p>
          {!state.connected && (
            <button
              className="pill primary"
              disabled={state.busy}
              onClick={() => void flow?.connect()}
            >
              Sign in to RuTracker
            </button>
          )}
          {state.connected && (
            <>
              <button className="pill ghost" disabled={state.busy} onClick={() => flow?.back()}>
                Back to search
              </button>
              <button
                className="pill ghost"
                disabled={state.busy}
                onClick={() => void flow?.logout()}
              >
                Sign out
              </button>
            </>
          )}
        </section>
      ) : state?.view === 'download' ? (
        <TorrentDownloads
          queue={state.queue}
          busy={state.busy}
          onPause={() => void flow?.control('pause')}
          onResume={() => void flow?.control('resume')}
          onRemove={(job) => void flow?.remove(job)}
          onAdd={(job) => void importSong(job)}
          onBrowse={() => flow?.browse()}
        />
      ) : (
        state && (
          <>
            <div className="torrent-search-modes" aria-label="Audio format">
              <button
                className={'pill ' + (state.format === 'mp3' ? 'primary' : 'ghost')}
                disabled={state.busy}
                onClick={() => flow?.setFormat('mp3')}
              >
                MP3
              </button>
              <button
                className={'pill ' + (state.format === 'all' ? 'primary' : 'ghost')}
                disabled={state.busy}
                onClick={() => flow?.setFormat('all')}
              >
                All formats
              </button>
            </div>
            {TORRENT_FILENAME_SEARCH_ENABLED && (
              <div className="torrent-search-modes">
                <button
                  className={'pill ' + (state.mode === 'filename' ? 'primary' : 'ghost')}
                  disabled={state.busy}
                  onClick={() => flow?.setMode('filename')}
                >
                  Song filenames
                </button>
                <button
                  className={'pill ' + (state.mode === 'release' ? 'primary' : 'ghost')}
                  disabled={state.busy}
                  onClick={() => flow?.setMode('release')}
                >
                  Release titles
                </button>
              </div>
            )}
            <p>
              {state.mode === 'filename'
                ? 'Find torrents containing a matching song filename, even when the album title is different.'
                : 'Search release titles by artist, album, or song.'}
            </p>
            <form
              className="torrent-search"
              onSubmit={(event) => {
                event.preventDefault()
                void flow?.search(query)
              }}
            >
              <input
                id="torrent-search"
                aria-label={state.mode === 'filename' ? 'Song filename' : 'Artist or song title'}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={
                  state.mode === 'filename'
                    ? 'Song filename, for example Sonne'
                    : 'Artist or song title'
                }
                maxLength={200}
              />
              <button className="pill primary" disabled={state.busy || !query.trim()}>
                Search
              </button>
            </form>
            <div className="torrent-columns">
              <section aria-label="Releases sorted by seeders descending">
                <div className="torrent-list-heading">
                  <span>{state.releases.length} releases</span>
                  <strong>↓ Most seeders first</strong>
                </div>

                {state.coverage && (
                  <p className="torrent-hint">
                    {state.coverage.indexedTorrents} torrents indexed
                    {state.coverage.expectedTorrents !== null
                      ? ' of ' + state.coverage.expectedTorrents
                      : ''}
                    .
                    {!state.coverage.complete
                      ? ' Coverage is incomplete; unindexed torrents may be missing.'
                      : ''}{' '}
                    Seeder counts are from the catalog snapshot.
                  </p>
                )}
                {state.releases.map((release) => (
                  <button
                    key={release.id}
                    className={
                      'torrent-release' + (state.release?.id === release.id ? ' selected' : '')
                    }
                    disabled={state.busy}
                    onClick={() => {
                      setFilter(state.mode === 'filename' ? state.query : '')
                      void flow?.choose(release)
                    }}
                  >
                    <span>
                      <b>{release.title}</b>
                      <small>
                        {release.size ? fmt(release.size) : 'Size listed in the torrent'}
                      </small>
                    </span>
                    <span className="torrent-seeders">
                      {release.seeders}
                      <small>seeders</small>
                    </span>
                  </button>
                ))}
                {!state.busy && state.query && state.releases.length === 0 && (
                  <p className="torrent-empty">No releases found. Try an artist or album title.</p>
                )}
                {!state.query && (
                  <p className="torrent-empty">
                    Search for a release, then choose the song inside it.
                  </p>
                )}
                {state.hasMore && (
                  <button
                    className="pill ghost"
                    disabled={state.busy}
                    onClick={() => void flow?.search(state.query, true)}
                  >
                    More releases
                  </button>
                )}
              </section>
              <section className="torrent-files" aria-label="Choose one song">
                {state.listing ? (
                  <>
                    <span className="torrent-eyebrow">Choose one song</span>
                    <h3>{state.listing.name}</h3>
                    <p>{fmt(state.listing.total)} in the full release</p>
                    <input
                      aria-label="Find a song in this release"
                      value={filter}
                      onChange={(event) => setFilter(event.target.value)}
                      placeholder="Find a song in this release"
                    />
                    <div className="torrent-file-list">
                      {state.listing.files
                        .filter((file) =>
                          (file.path + ' ' + file.name)
                            .toLocaleLowerCase()
                            .includes(filter.toLocaleLowerCase())
                        )
                        .map((file) => (
                          <label key={file.index} className="torrent-file">
                            <input
                              type="radio"
                              name="torrent-song"
                              checked={state.selected === file.index}
                              disabled={state.busy}
                              onChange={() => flow?.select(file.index)}
                            />
                            <span>
                              {file.name}
                              <small>{file.path}</small>
                            </span>
                            <span>{fmt(file.size)}</span>
                          </label>
                        ))}
                    </div>
                    <p>
                      {selected
                        ? '1 song selected · ' + fmt(selected.size)
                        : 'Select one audio file.'}
                    </p>
                    <button
                      className="pill primary torrent-download-button"
                      disabled={state.busy || !selected}
                      onClick={() => void flow?.download()}
                    >
                      Add to queue{selected ? ' · ' + fmt(selected.size) : ''}
                    </button>
                  </>
                ) : (
                  <div className="torrent-empty">
                    <h3>An album, just your song.</h3>
                    <p>Choose a release on the left, then select the track you want.</p>
                  </div>
                )}
              </section>
            </div>
          </>
        )
      )}
    </Modal>
  )
}

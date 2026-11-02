import { useEffect, useRef, useState } from 'react'
import { Modal } from '@singz/ui'
import { TorrentFlow, type TorrentViewState, type TorrentImport } from '../../../shared/torrent'
import './torrent.css'

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
  const job = state?.job
  const importSong = async (): Promise<void> => {
    if (consuming.current) return
    consuming.current = true
    setImporting(true)
    const file = await ref.current?.consume()
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
          <h2>{state?.view === 'download' ? 'Your song download' : 'Find your next song'}</h2>
        </div>
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
        <section className="torrent-download">
          {job ? (
            <>
              <span className="torrent-eyebrow">
                {job.state === 'complete'
                  ? 'Song downloaded'
                  : job.state === 'paused'
                  ? 'Download paused'
                  : job.state === 'verifying'
                  ? 'Finishing the download'
                  : job.state === 'error'
                  ? 'Download needs attention'
                  : job.done === 0
                  ? 'Connecting to seeders'
                  : 'Downloading your song'}
              </span>
              <h3>{job.name}</h3>
              <p>{fmt(job.size)} · One selected song</p>
              <div className="torrent-progress-text">
                <strong>{Math.min(100, Math.floor((job.done / job.size) * 100))}%</strong>
                <span>
                  {fmt(job.done)} / {fmt(job.size)}
                </span>
              </div>
              <progress value={job.done} max={job.size} aria-label="Song download" />
              <p>
                {job.state === 'downloading'
                  ? fmt(job.speed) + '/s'
                  : job.state === 'complete'
                  ? 'Verified and ready'
                  : job.state === 'verifying'
                  ? 'Verifying and saving your song'
                  : job.error || 'Resume whenever you’re ready.'}
              </p>
              <div className="torrent-download-actions">
                {job.state === 'complete' ? (
                  <button
                    className="pill primary"
                    disabled={state.busy}
                    onClick={() => void importSong()}
                  >
                    Continue to Add song →
                  </button>
                ) : (
                  <button
                    className="pill primary"
                    disabled={state.busy || job.state === 'verifying'}
                    onClick={() =>
                      void flow?.control(job.state === 'downloading' ? 'pause' : 'resume')
                    }
                  >
                    {job.state === 'downloading' ? 'Pause download' : 'Resume download'}
                  </button>
                )}
                <button
                  className="pill ghost"
                  disabled={state.busy}
                  onClick={() => void flow?.control('cancel')}
                >
                  Cancel download
                </button>
              </div>
            </>
          ) : (
            <p>No active download.</p>
          )}
        </section>
      ) : (
        state && (
          <>
            <form
              className="torrent-search"
              onSubmit={(event) => {
                event.preventDefault()
                void flow?.search(query)
              }}
            >
              <input
                id="torrent-search"
                aria-label="Artist or song title"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Artist or song title"
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
                {state.releases.map((release) => (
                  <button
                    key={release.id}
                    className={
                      'torrent-release' + (state.release?.id === release.id ? ' selected' : '')
                    }
                    disabled={state.busy}
                    onClick={() => {
                      setFilter('')
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
                      Download song{selected ? ' · ' + fmt(selected.size) : ''}
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

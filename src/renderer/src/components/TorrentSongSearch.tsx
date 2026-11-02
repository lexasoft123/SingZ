import { useState } from 'react'
import type { TorrentFlow, TorrentViewState } from '../../../shared/torrent'
const size = (bytes: number): string =>
  bytes >= 1e6 ? (bytes / 1e6).toFixed(1) + ' MB' : Math.ceil(bytes / 1000) + ' KB'
export default function TorrentSongSearch({
  flow,
  state
}: {
  flow: TorrentFlow | null
  state: TorrentViewState
}): React.JSX.Element {
  const [artist, setArtist] = useState(state.songArtist),
    [title, setTitle] = useState(state.songTitle)
  const progress = state.songProgress
  return (
    <section className="torrent-song-search">
      <p>
        Enter the artist and song. Matching tracks appear here, including songs inside albums and
        discographies.
      </p>
      <form
        className="torrent-song-fields"
        onSubmit={(event) => {
          event.preventDefault()
          if (artist.trim() && title.trim() && !state.busy) void flow?.searchSong(artist, title)
        }}
      >
        <input
          aria-label="Artist"
          placeholder="Artist, for example Joe Cocker"
          value={artist}
          onChange={(event) => setArtist(event.target.value)}
          disabled={state.busy}
          maxLength={195}
        />
        <input
          aria-label="Song title"
          placeholder="Song title, for example First We Take Manhattan"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          disabled={state.busy}
          maxLength={200}
        />
        <button className="pill primary" disabled={state.busy || !artist.trim() || !title.trim()}>
          Find song
        </button>
      </form>
      <p>Search checks torrent file lists. Audio downloads when you add a track to the queue.</p>
      {progress && (
        <p role="status">
          {state.busy && progress.stage === 'releases'
            ? 'Finding artist releases…'
            : (progress.stopped ? 'Search stopped. ' : '') +
              'Checked ' +
              progress.checked +
              ' of ' +
              progress.known +
              ' loaded releases.'}{' '}
          {state.songMatches.length} matching tracks · Most seeders first
        </p>
      )}
      {state.busy && progress && progress.stage !== 'idle' && (
        <button
          className="pill ghost"
          disabled={progress.stopped}
          onClick={() => flow?.cancelSongSearch()}
        >
          {progress.stopped ? 'Stopping search…' : 'Stop search'}
        </button>
      )}
      {state.songMatches.slice(0, 100).map((match) => (
        <article className="torrent-download-item" key={match.release.id + '-' + match.file.index}>
          <strong>{match.file.name}</strong>
          <p>
            {size(match.file.size)} · {match.release.seeders} seeders
          </p>
          <p>{match.file.path}</p>
          <small>{match.release.title}</small>
          <p>
            <button
              className="pill primary"
              disabled={state.busy}
              onClick={() => void flow?.queueSong(match)}
            >
              Add to queue: {match.file.name}
            </button>
          </p>
        </article>
      ))}
      {state.songMatches.length > 100 && (
        <p>Showing the first 100 matches. Use a more specific song title to narrow the results.</p>
      )}
      {!state.busy && progress && !state.songMatches.length && (
        <p>
          No matching tracks in the checked releases.
          {progress.hasMore
            ? ' Continue searching more releases.'
            : ' Try another artist spelling or All formats.'}
        </p>
      )}
      {!state.busy && progress?.hasMore && (
        <button
          className="pill ghost"
          onClick={() => void flow?.searchSong(state.songArtist, state.songTitle, true)}
        >
          Search more releases
        </button>
      )}
    </section>
  )
}

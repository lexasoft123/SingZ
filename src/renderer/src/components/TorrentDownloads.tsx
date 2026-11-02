import type { TorrentJob, TorrentQueue } from '../../../shared/torrent'
export default function TorrentDownloads({
  queue,
  busy,
  onPause,
  onResume,
  onRemove,
  onAdd,
  onBrowse
}: {
  queue: TorrentQueue
  busy: boolean
  onPause: () => void
  onResume: () => void
  onRemove: (job: TorrentJob) => void
  onAdd: (job: TorrentJob) => void
  onBrowse: () => void
}): React.JSX.Element {
  const waiting = queue.downloads.filter((j) => j.state !== 'complete'),
    ready = queue.downloads.filter((j) => j.state === 'complete')
  return (
    <section className="torrent-account">
      <h3>Downloads</h3>
      <p>One song downloads at a time. Completed files stay here until you remove them.</p>
      <button className="pill ghost" disabled={busy} onClick={onBrowse}>
        Find more songs
      </button>
      {waiting.length > 0 && (
        <>
          <h3>Download queue · {waiting.length}</h3>
          <button
            className="pill primary"
            disabled={busy}
            onClick={queue.paused ? onResume : onPause}
          >
            {queue.paused ? 'Resume queue' : 'Pause queue'}
          </button>
          {waiting.map((j) => (
            <article className="torrent-download-item" key={j.release + '-' + j.index}>
              <strong>{j.name}</strong>
              <p>
                {j.state === 'queued'
                  ? 'Queued'
                  : j.state === 'paused'
                    ? 'Paused'
                    : j.state === 'error'
                      ? 'Needs attention'
                      : j.state === 'verifying'
                        ? 'Finishing'
                        : Math.min(100, Math.floor((j.done / j.size) * 100)) + '% downloaded'}{' '}
                · {(j.size / 1e6).toFixed(1)} MB
              </p>
              {j.error && <p role="alert">{j.error}</p>}
              <button className="pill ghost" disabled={busy} onClick={() => onRemove(j)}>
                Cancel {j.name}
              </button>
            </article>
          ))}
        </>
      )}
      <h3>Ready to add · {ready.length}</h3>
      <p>Closing or cancelling Add song keeps the downloaded original safe here.</p>
      {ready.map((j) => (
        <article className="torrent-download-item" key={j.release + '-' + j.index}>
          <strong>{j.name}</strong>
          <p>{(j.size / 1e6).toFixed(1)} MB · Downloaded</p>
          <button className="pill primary" disabled={busy} onClick={() => onAdd(j)}>
            Add song: {j.name}
          </button>{' '}
          <button className="pill ghost" disabled={busy} onClick={() => onRemove(j)}>
            Remove download: {j.name}
          </button>
        </article>
      ))}
      {!queue.downloads.length && <p>No downloads yet.</p>}
    </section>
  )
}

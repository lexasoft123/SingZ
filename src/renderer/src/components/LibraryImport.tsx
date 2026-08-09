import { useEffect, useState } from 'react'
import { Modal } from '@singz/ui'

interface Props {
  /** Where the project lives now — outside the library root. */
  dir: string
  busy: boolean
  onImport: (mode: 'copy' | 'move') => void
  onClose: () => void
}

/**
 * Offer to bring a project opened from somewhere else — a shared folder, a USB
 * stick, another machine's cloud library — into this machine's library.
 */
export default function LibraryImport({ dir, busy, onImport, onClose }: Props): React.JSX.Element {
  const [root, setRoot] = useState('')

  useEffect(() => {
    void window.singz.getStorage().then((s) => setRoot(s.root))
  }, [])

  return (
    <Modal onClose={onClose}>
        <div className="picker-head">
          <h2>Add to your library</h2>
          <div className="log-actions">
            <button type="button" className="pill ghost small" disabled={busy} onClick={onClose}>
              Close
            </button>
          </div>
        </div>
        <p>
          This project lives in <strong className="path">{dir}</strong>, outside your library. It
          plays and saves perfectly well there — adding it puts it in{' '}
          <strong className="path">{root}</strong>, where the Open screen lists it and Drive sync
          picks it up.
        </p>
        <div className="storage-actions">
          <button
            type="button"
            className="pill ghost small"
            disabled={busy}
            title="Duplicate the folder into your library — the original stays where it is"
            onClick={() => onImport('copy')}
          >
            Copy it in
          </button>
          <button
            type="button"
            className="pill ghost small"
            disabled={busy}
            title="Relocate the folder into your library — nothing is left behind"
            onClick={() => onImport('move')}
          >
            Move it in
          </button>
        </div>
        <p className="fine" style={{ marginTop: 14 }}>
          {busy
            ? 'Working — a project with stems is a few hundred MB, so give it a moment…'
            : 'Copying leaves the original alone, which is what you want for a folder someone else also uses. Moving takes it with you, stems and all.'}
        </p>
    </Modal>
  )
}

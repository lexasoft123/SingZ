import { useEffect, useState } from 'react'
import { Modal } from '@singz/ui'
import { t, T } from '../i18n'

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
          <h2>{t('library.libraryImport.heading')}</h2>
          <div className="log-actions">
            <button type="button" className="pill ghost small" disabled={busy} onClick={onClose}>
              {t('library.common.close')}
            </button>
          </div>
        </div>
        <p>
          <T k="library.libraryImport.body" vars={{ dir, root }} strongClass="path" />
        </p>
        <div className="storage-actions">
          <button
            type="button"
            className="pill ghost small"
            disabled={busy}
            title={t('library.libraryImport.copyInTitle')}
            onClick={() => onImport('copy')}
          >
            {t('library.libraryImport.copyIn')}
          </button>
          <button
            type="button"
            className="pill ghost small"
            disabled={busy}
            title={t('library.libraryImport.moveInTitle')}
            onClick={() => onImport('move')}
          >
            {t('library.libraryImport.moveIn')}
          </button>
        </div>
        <p className="fine" style={{ marginTop: 14 }}>
          {busy ? t('library.libraryImport.workingHint') : t('library.libraryImport.copyMoveHint')}
        </p>
    </Modal>
  )
}

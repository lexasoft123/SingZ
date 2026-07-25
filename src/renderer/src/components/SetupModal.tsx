import { useState } from 'react'
import type { EngineStatus } from '../../../shared/types'

const INSTALL_CMD = 'pipx install demucs && pipx inject demucs numpy'

interface Props {
  status: EngineStatus | null
  onClose: () => void
  onStatus: (s: EngineStatus) => void
}

export default function SetupModal({ status, onClose, onStatus }: Props): React.JSX.Element {
  const [checking, setChecking] = useState(false)
  const [copied, setCopied] = useState(false)

  const recheck = async (): Promise<void> => {
    setChecking(true)
    const s = await window.singz.checkEngine(true)
    setChecking(false)
    onStatus(s)
    if (s.ok) onClose()
  }

  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(INSTALL_CMD)
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <h2>Stem splitting needs Demucs</h2>
        <p>
          SingZ uses <strong>Demucs</strong> — a free, open-source AI model that runs entirely on
          your machine — to split songs into stems. One-time setup, in Terminal:
        </p>
        <div className="cmd">
          <code>{INSTALL_CMD}</code>
          <button type="button" className="pill ghost small" onClick={copy}>
            {copied ? 'Copied ✓' : 'Copy'}
          </button>
        </div>
        <p className="fine">
          Needs Python 3.10–3.13 and pipx (<code>brew install pipx</code>). The first split
          downloads the model (~80 MB); a typical song takes a few minutes of CPU time.
        </p>
        {status && !status.ok && <p className="fine warn">{status.message}</p>}
        <div className="modal-actions">
          <button type="button" className="pill primary" disabled={checking} onClick={recheck}>
            {checking ? 'Checking…' : 'Re-check'}
          </button>
          <button
            type="button"
            className="pill ghost"
            onClick={() => void window.singz.openExternal('https://github.com/adefossez/demucs')}
          >
            Demucs on GitHub ↗
          </button>
          <button type="button" className="pill ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

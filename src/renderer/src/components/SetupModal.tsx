import { useState } from 'react'
import type { EngineStatus } from '../../../shared/types'
import { Modal } from '@singz/ui'
import { t } from '../i18n'

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
    <Modal onClose={onClose}>
        <h2>{t('settings.demucs.title')}</h2>
        <p>
          {t('settings.demucs.introBefore')} <strong>Demucs</strong> {t('settings.demucs.introAfter')}
        </p>
        <div className="cmd">
          <code>{INSTALL_CMD}</code>
          <button type="button" className="pill ghost small" onClick={copy}>
            {copied ? t('settings.demucs.copiedBadge') : t('settings.demucs.copyButton')}
          </button>
        </div>
        <p className="fine">
          {t('settings.demucs.pipxBefore')}<code>brew install pipx</code>{t('settings.demucs.pipxAfter')}
        </p>
        {status && !status.ok && <p className="fine warn">{status.message}</p>}
        <div className="modal-actions">
          <button type="button" className="pill primary" disabled={checking} onClick={recheck}>
            {checking ? t('settings.demucs.checkingButton') : t('settings.demucs.recheckButton')}
          </button>
          <button
            type="button"
            className="pill ghost"
            onClick={() => void window.singz.openExternal('https://github.com/adefossez/demucs')}
          >
            {t('settings.demucs.githubLink')}
          </button>
          <button type="button" className="pill ghost" onClick={onClose}>
            {t('settings.action.close')}
          </button>
        </div>
    </Modal>
  )
}

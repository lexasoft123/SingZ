import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '@singz/ui'
import { toDataURL } from 'qrcode'
import { backendExpiry, validBackendUrl } from './model'
import { tJourney } from './i18n'

export function PageFrame({ title, subtitle, children, onBack, backDisabled = false }: {
  title: string
  subtitle: string
  children: ReactNode
  onBack: () => void
  backDisabled?: boolean
}) {
  return <>
    <header className="journey-heading">
      <div><h1>{title}</h1><p>{subtitle}</p></div>
      <Button data-focus="journey-back" data-journey-back disabled={backDisabled} onClick={onBack}>
        ← {tJourney('journey.back')}
      </Button>
    </header>
    <div className="journey-content">{children}</div>
    <footer className="journey-footer">
      <span className="box-key">↑ ↓ ← →</span><span>{tJourney('journey.move')}</span>
      <span className="box-key">{tJourney('journey.key.ok')}</span><span>{tJourney('journey.select')}</span>
      <span className="box-key">{tJourney('journey.key.back')}</span><span>{tJourney('journey.back')}</span>
    </footer>
  </>
}

export function ErrorNotice({ error }: { error: string | null }) {
  return error ? <div className="journey-alert" role="alert">{error}</div> : null
}

export function LoadingNotice({ active }: { active: boolean }) {
  return active ? <p className="journey-note" role="status">{tJourney('journey.loading')}</p> : null
}

export function ExpiryText({ expiresAt, now }: { expiresAt?: number; now: number }) {
  const expiry = backendExpiry(expiresAt, now)
  if (expiry.seconds === null) return null
  return <span className={expiry.expired ? 'journey-status expired' : 'journey-status'}>
    {expiry.expired ? tJourney('journey.expired') : tJourney('journey.expires', { seconds: expiry.seconds })}
  </span>
}

export function QrCode({ rawUrl, label }: { rawUrl?: string; label: string }) {
  const url = validBackendUrl(rawUrl)
  const [image, setImage] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const generation = useRef(0)
  useEffect(() => {
    const current = ++generation.current
    setImage(null)
    setFailed(false)
    if (!url) return
    void toDataURL(url, {
      width: 320,
      margin: 1,
      color: { dark: '#12100d', light: '#f4efe6' }
    }).then(result => {
      if (generation.current === current) setImage(result)
    }, () => {
      if (generation.current === current) setFailed(true)
    })
    return () => { generation.current++ }
  }, [url])
  return <div className="journey-qr" data-qr-url={url ?? undefined}>
    {image ? <img src={image} alt={label} /> : <div className="journey-qr-empty" role="status">
      {url && !failed ? tJourney('journey.loading') : tJourney('journey.noUrl')}
    </div>}
    {url && <code>{url}</code>}
  </div>
}

export function SettingRow({ title, help, status, onOpen, primary = false, disabled = false, focus }: {
  title: string
  help: string
  status?: string
  onOpen: () => void
  primary?: boolean
  disabled?: boolean
  focus?: string
}) {
  return <Button
    className="journey-row"
    data-focus={focus}
    data-journey-primary={primary || undefined}
    disabled={disabled}
    onClick={onOpen}
  >
    <span><strong>{title}</strong><small>{help}</small></span>
    <span className="journey-row-status">{status ?? tJourney('journey.open')} ›</span>
  </Button>
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="journey-empty">{children}</div>
}

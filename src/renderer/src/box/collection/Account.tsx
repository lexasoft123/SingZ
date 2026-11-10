import { useEffect, useState } from 'react'
import { Button } from '@singz/ui'
import { t } from '../i18n'
import type { CollectionAuthState } from './types'

function authError(error: string): string {
  switch (error) {
    case 'not-configured': return t('box.account.errorNotConfigured')
    case 'invalid-client': return t('box.account.errorInvalidClient')
    case 'denied': return t('box.account.errorDenied')
    case 'expired': return t('box.account.errorExpired')
    case 'network': return t('box.account.errorNetwork')
    case 'save-failed': return t('box.account.errorSave')
    case 'invalid-response':
    case 'unknown-session': return t('box.account.errorResponse')
    case 'cancelled': return t('box.account.cancelled')
    default: return error
  }
}

export function Account({
  auth,
  remoteError,
  signOutConfirm,
  signOutBusy,
  onBack,
  onStart,
  onCancel,
  onRequestSignOut,
  onCancelSignOut,
  onSignOut,
  onOpenNetwork,
  onOpenStorage
}: {
  auth: CollectionAuthState
  remoteError: string | null
  signOutConfirm: boolean
  signOutBusy: boolean
  onBack: () => void
  onStart: () => void
  onCancel: () => void
  onRequestSignOut: () => void
  onCancelSignOut: () => void
  onSignOut: () => void
  onOpenNetwork: () => void
  onOpenStorage: () => void
}): React.JSX.Element {
  const challenge = auth.challenge
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!challenge) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [challenge])
  const seconds = challenge ? Math.max(0, Math.ceil((challenge.expiresAt - now) / 1000)) : 0
  return <main className="box-account" data-surface="account" aria-label={t('box.account.title')}>
    <div className="account-background" inert={signOutConfirm}>
    <div className="account-heading">
      <Button data-focus="account-back" onClick={onBack}>← {t('box.account.back')}</Button>
      <div><h1>{t('box.account.title')}</h1><p>{t('box.account.body')}</p></div>
    </div>
    {auth.signedIn ? <section className="account-card account-connected">
      <span className="account-status-dot" />
      <h2>{t('box.account.connected')}</h2>
      <p>{t('box.account.connectedBody')}</p>
      {remoteError && <p className="box-error" role="alert">{remoteError}</p>}
      <div className="account-actions">
        <Button data-focus="account-storage" onClick={onOpenStorage}>{t('box.account.storage')}</Button>
        <Button data-focus="account-signout" disabled={signOutBusy} onClick={onRequestSignOut}>{t('box.account.signOut')}</Button>
      </div>
    </section> : <section className="account-card">
      <h2>{t('box.account.connect')}</h2>
      {challenge ? <>
        <p>{t('box.account.intro')}</p>
        <div className="account-challenge">
          <img src={challenge.qrDataUrl} width={280} height={280} alt={t('box.account.qr')} />
          <div className="account-challenge-copy">
            <span>{t('box.account.url')}</span>
            <strong className="account-url">{challenge.verificationUrl}</strong>
            <span>{t('box.account.code')}</span>
            <strong className="account-code">{challenge.userCode}</strong>
            <p role="status">{t('box.account.waiting')}</p>
            <p>{t('box.account.expires', { time: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` })}</p>
          </div>
        </div>
      </> : <p>{auth.phase === 'starting' ? t('box.account.starting') : t('box.account.signInBody')}</p>}
      {auth.error && <p className="box-error" role="alert">{authError(auth.error)}</p>}
      {remoteError && <p className="box-error" role="alert">{remoteError}</p>}
      <div className="account-actions">
        {!challenge && <Button variant="primary" data-account-primary disabled={auth.phase === 'starting'} onClick={onStart}>
          {auth.phase === 'starting' ? t('box.account.starting') : auth.phase === 'error' || auth.phase === 'cancelled' ? t('box.account.retry') : t('box.account.signIn')}
        </Button>}
        {(challenge || auth.phase === 'starting') && <Button data-account-primary onClick={onCancel}>{t('box.account.cancelSignIn')}</Button>}
        <Button data-focus="account-network" onClick={onOpenNetwork}>{t('box.account.network')}</Button>
      </div>
    </section>}
    </div>
    {signOutConfirm && <div className="account-confirm-scrim">
      <section className="account-confirm" role="dialog" data-surface="account-confirmation" aria-modal="true" aria-label={t('box.account.signOutTitle')}>
        <h2>{t('box.account.signOutTitle')}</h2>
        <p>{t('box.account.signOutBody')}</p>
        <div className="account-actions">
          <Button variant="primary" data-signout-cancel autoFocus disabled={signOutBusy} onClick={onCancelSignOut}>{t('box.account.signOutCancel')}</Button>
          <Button data-signout-confirm disabled={signOutBusy} onClick={onSignOut}>{signOutBusy ? t('box.account.signingOut') : t('box.account.signOutConfirm')}</Button>
        </div>
      </section>
    </div>}
  </main>
}

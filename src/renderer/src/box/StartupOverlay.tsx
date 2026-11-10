import { t } from './i18n'

/**
 * Opaque "loading your songs" cover shown while the Box hydrates. It must never
 * hide a startup failure: once hydration reports an error the overlay unmounts
 * so the policy-startup error and its Retry are visible to the remote user.
 */
export function StartupOverlay({ hydrated, failed }: { hydrated: boolean; failed: boolean }): React.JSX.Element | null {
  if (hydrated || failed) return null
  return <div className="box-startup" data-surface="startup" role="status" aria-live="polite">
    <h1>{t('box.catalog.loadingTitle')}</h1>
    <p>{t('box.catalog.loadingBody')}</p>
  </div>
}

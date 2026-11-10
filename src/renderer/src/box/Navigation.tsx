import { Button, SegmentedControl } from '@singz/ui'
import { t } from './i18n'
import { tSettings } from './settings-i18n'

export function BoxNavigation({
  section,
  queueCount,
  hasCurrent,
  onCatalog,
  onQueue,
  onCurrent,
  onSettings,
  onAccount
}: {
  section: 'catalog' | 'queue' | 'settings' | 'account'
  queueCount: number
  hasCurrent: boolean
  onCatalog: () => void
  onQueue: () => void
  onCurrent: () => void
  onSettings: () => void
  onAccount: () => void
}): React.JSX.Element {
  return <header className="box-titlebar" data-surface="navigation">
    <div className="box-logo">Sing<span>Z</span><small>Box</small></div>
    <SegmentedControl
      className="box-navigation"
      aria-label={t('box.navigation.label')}
      options={[
        { value: 'catalog', label: t('box.navigation.catalog') },
        { value: 'queue', label: queueCount > 0 ? t('box.navigation.queueCount', { count: queueCount }) : t('box.navigation.queue') }
      ]}
      value={section}
      onChange={value => value === 'catalog' ? onCatalog() : value === 'queue' ? onQueue() : onSettings()}
    />
    <div className="box-utilities">
      <span className="box-connection"><span className="connection-dot" />{t('box.navigation.local')}</span>
      <Button data-focus="account" aria-current={section === 'account' ? 'page' : undefined} onClick={onAccount}>{t('box.navigation.account')}</Button>
      <Button data-focus="settings" aria-current={section === 'settings' ? 'page' : undefined} onClick={onSettings}>{tSettings('box.settings.navigation')}</Button>
      {hasCurrent && <Button data-focus="current-song" onClick={onCurrent}>{t('box.navigation.current')}</Button>}
    </div>
  </header>
}

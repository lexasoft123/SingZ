import { Button, SegmentedControl } from '@singz/ui'
import { Icon } from '@singz/ui/icons'
import { t } from './i18n'
import { tSettings } from './settings-i18n'
import { songLine } from './next-song'
import { parseSongName } from './song-identity'
import { timeText } from './metadata'

export type BoxNavigationSection = 'catalog' | 'queue' | 'settings' | 'account' | 'player'

/** The one top bar of every Box screen. On the player no place is selected, the song pill is the
 * "you are here" state, and everything but the logo and the pill hides with the player chrome. */
export function BoxNavigation({
  section,
  queueCount,
  currentName,
  playing,
  position,
  duration,
  chromeHidden = false,
  onCatalog,
  onQueue,
  onCurrent,
  onSettings,
  onAccount
}: {
  section: BoxNavigationSection
  queueCount: number
  currentName: string | null
  playing: boolean
  position: number
  duration: number
  /** Player only: chrome is hidden, so the controls are inert and invisible; the logo and pill stay. */
  chromeHidden?: boolean
  onCatalog: () => void
  onQueue: () => void
  onCurrent: () => void
  onSettings: () => void
  onAccount: () => void
}): React.JSX.Element {
  const onPlayer = section === 'player'
  const chrome = onPlayer ? { inert: chromeHidden, 'aria-hidden': chromeHidden } : {}
  const chromeClass = onPlayer ? ' player-chrome' : ''
  const song = currentName === null ? null : parseSongName(currentName)
  const time = timeText(position)
  return <header className={onPlayer ? 'box-titlebar player-header' : 'box-titlebar'} data-surface="navigation" data-variant={onPlayer ? 'player' : 'page'}>
    <div className="box-logo">Sing<span>Z</span><small>Box</small></div>
    <div className={`box-nav-group${chromeClass}`} {...chrome}>
      <span className="box-titlebar-divider" aria-hidden="true" />
      <SegmentedControl<'catalog' | 'queue' | 'player'>
        className="box-navigation"
        aria-label={t('box.navigation.label')}
        options={[
          { value: 'catalog', label: t('box.navigation.catalog') },
          { value: 'queue', label: queueCount > 0 ? t('box.navigation.queueCount', { count: queueCount }) : t('box.navigation.queue') }
        ]}
        value={section === 'catalog' || section === 'queue' ? section : 'player'}
        onChange={value => value === 'catalog' ? onCatalog() : onQueue()}
      />
    </div>
    <div className={`box-utilities${chromeClass}`} {...chrome}>
      <Button data-focus="settings" data-control="settings" aria-current={section === 'settings' ? 'page' : undefined} data-here={section === 'settings' ? 'true' : undefined} onClick={onSettings}>{tSettings('box.settings.navigation')}</Button>
      <Button data-focus="account" aria-current={section === 'account' ? 'page' : undefined} data-here={section === 'account' ? 'true' : undefined} onClick={onAccount}>{t('box.navigation.account')}</Button>
    </div>
    {song && currentName !== null && <Button
      className="box-song-pill"
      data-focus="current-song"
      data-state={onPlayer ? 'current' : 'away'}
      aria-current={onPlayer ? 'page' : undefined}
      aria-label={t('box.navigation.currentNamed', { name: songLine(song.title, song.artist) })}
      {...(onPlayer ? { inert: chromeHidden } : {})}
      onClick={onPlayer ? undefined : onCurrent}
    >
      <span className="box-song-badge" aria-hidden="true"><Icon name={playing ? 'pause' : 'play'} size={14} /></span>
      <span className="box-song-text">
        <strong>{song.title}</strong>
        <small>{onPlayer ? t('box.navigation.nowPlaying', { time, duration: timeText(duration) }) : t('box.navigation.backToSong', { time })}</small>
      </span>
    </Button>}
  </header>
}

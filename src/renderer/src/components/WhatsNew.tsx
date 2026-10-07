import { Modal } from '@singz/ui'
import type { ReleaseNotes, HighlightIcon } from '../../../shared/release-highlights'
const telegram = new URL('../../../shared/telegram-logo.png', import.meta.url).href
import { t } from '../i18n'
function HighlightIconView({ icon }: { icon: HighlightIcon }): React.JSX.Element {
  const paths = { news: 'M4 4h16v16H4z M8 8h8 M8 12h8 M8 16h4', export: 'M12 3v12 M7 10l5 5 5-5 M4 16v5h16v-5', mic: 'M9 4a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0z M5 10v1a7 7 0 0 0 14 0v-1 M12 18v4 M8 22h8', controls: 'M4 7h16 M4 17h16 M8 4v6 M16 14v6' }
  return <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[icon]} /></svg>
}
export default function WhatsNew({ notes, onClose }: { notes: ReleaseNotes; onClose: () => void }): React.JSX.Element {
  return <Modal cardClassName="whats-new-dialog" aria-label={t('app.whatsNew.title')} onClose={onClose}>
    <div className="whats-new-heading"><span>SingZ <small>v{notes.version}</small></span><button type="button" className="pill ghost" aria-label={t('app.whatsNew.done')} onClick={onClose}>×</button></div>
    <h2>{t('app.whatsNew.title')}</h2>
    <button type="button" className="whats-new-telegram" onClick={() => void window.singz.openExternal('https://t.me/SingZapp')}>
      <img src={telegram} width="42" height="42" alt="" /><span><strong>{t('app.whatsNew.subscribe')}</strong><small>{t('app.whatsNew.telegramDescription')}</small></span><span aria-hidden="true">↗</span>
    </button>
    <div className="whats-new-content">
      {notes.entries.map(entry => <section key={entry.version}>
        {notes.entries.length > 1 && <h3>v{entry.version}</h3>}
        {entry.highlights.map(item => <article className="whats-new-highlight" key={item.id}>
          <span className="whats-new-icon"><HighlightIconView icon={item.icon} /></span><div>{item.desktopOnly && <small>{t('app.whatsNew.desktop')}</small>}<h3>{item.title}</h3><p>{item.description}</p></div>
        </article>)}
      </section>)}
    </div>
    <div className="modal-actions">
      <button type="button" className="pill ghost" onClick={() => void window.singz.openExternal(notes.url)}>{t('app.whatsNew.fullNotes')} ↗</button>
      <button type="button" className="pill primary" onClick={onClose}>{t('app.whatsNew.done')}</button>
    </div>
  </Modal>
}

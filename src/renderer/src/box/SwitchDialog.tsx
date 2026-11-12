import { Button, Modal, ModalActions } from '@singz/ui'
import type { ProjectListItem } from '../../../shared/types'
import { t } from './i18n'
import type { BoxActiveSong } from './transport'

/** What confirming does to the target: opens paused (queue pick), starts playing (Sing), or starts playing
 * and drops the song that just played from the queue (Next). */
export type SwitchMode = 'paused' | 'start' | 'advance'

const MODE_KEY = { paused: 'box.switch.next', start: 'box.switch.start', advance: 'box.switch.advance' } as const

export function SwitchDialog({ active, mode, target, onCancel, onConfirm }: {
  active: BoxActiveSong | null
  mode: SwitchMode
  target: ProjectListItem
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  return <Modal persistent onClose={onCancel} cardClassName="box-switch-card" aria-label={t('box.switch.label')}>
    <div data-surface="switch-dialog">
      <h2>{t('box.switch.title')}</h2>
      {active && <p>{t('box.switch.current', { name: active.item.name })}</p>}
      <p>{t(MODE_KEY[mode], { name: target.name })}</p>
      <ModalActions>
        <Button data-keep-current autoFocus onClick={onCancel}>{t('box.switch.cancel')}</Button>
        <Button variant="primary" data-switch-confirm onClick={onConfirm}>{t('box.switch.confirm')}</Button>
      </ModalActions>
    </div>
  </Modal>
}

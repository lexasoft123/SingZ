import { Button, Modal, ModalActions } from '@singz/ui'
import type { ProjectListItem } from '../../../shared/types'
import { t } from './i18n'
import type { BoxActiveSong } from './transport'

export function SwitchDialog({ active, target, onCancel, onConfirm }: {
  active: BoxActiveSong | null
  target: ProjectListItem
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  return <Modal persistent onClose={onCancel} cardClassName="box-switch-card" aria-label={t('box.switch.label')}>
    <div data-surface="switch-dialog">
      <h2>{t('box.switch.title')}</h2>
      {active && <p>{t('box.switch.current', { name: active.item.name })}</p>}
      <p>{t('box.switch.next', { name: target.name })}</p>
      <ModalActions>
        <Button data-keep-current autoFocus onClick={onCancel}>{t('box.switch.cancel')}</Button>
        <Button variant="primary" data-switch-confirm onClick={onConfirm}>{t('box.switch.confirm')}</Button>
      </ModalActions>
    </div>
  </Modal>
}

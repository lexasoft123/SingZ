import { Button } from '@singz/ui'
import { formatBytes } from './format'
import { tJourney, type JourneyKey } from './i18n'
import { confirmationSafeChoice, type PendingConfirmation } from './model'

function copy(confirmation: PendingConfirmation): {
  title: JourneyKey
  body: JourneyKey
  action: JourneyKey
  name?: string
  size?: string
  cloudNote?: false
} {
  switch (confirmation.kind) {
    case 'remove-cache': return {
      title: 'journey.dialog.removeTitle', body: 'journey.dialog.removeBody',
      action: 'journey.dialog.confirmRemove', name: confirmation.name, size: formatBytes(confirmation.bytes)
    }
    case 'phone-revoke': return {
      title: 'journey.dialog.revokeTitle', body: 'journey.dialog.revokeBody',
      action: 'journey.dialog.confirmRevoke', name: confirmation.name
    }
    case 'phone-stop': return {
      title: 'journey.dialog.stopTitle', body: 'journey.dialog.stopBody', action: 'journey.dialog.confirmStop'
    }
    case 'drive-signout': return {
      title: 'journey.dialog.signoutTitle', body: 'journey.dialog.signoutBody', action: 'journey.dialog.confirmSignout'
    }
    case 'update-install': return {
      title: 'journey.dialog.installTitle', body: 'journey.dialog.installBody', action: 'journey.dialog.confirmInstall'
    }
    case 'rollback': return {
      title: 'journey.dialog.rollbackTitle', body: 'journey.dialog.rollbackBody', action: 'journey.dialog.confirmRollback'
    }
    case 'reboot': return {
      title: 'journey.dialog.rebootTitle', body: 'journey.dialog.rebootBody', action: 'journey.dialog.confirmReboot'
    }
    case 'wifi-switch': return {
      title: 'journey.dialog.wifiTitle', body: 'journey.dialog.wifiBody', action: 'journey.dialog.confirmWifi', cloudNote: false
    }
    case 'factory-reset': return {
      title: 'journey.dialog.resetTitle', body: 'journey.dialog.resetBody', action: 'journey.dialog.confirmReset'
    }
  }
}

export function ConfirmationDialog({ confirmation, onCancel, onConfirm }: {
  confirmation: PendingConfirmation
  onCancel: () => void
  onConfirm: () => void
}) {
  const text = copy(confirmation)
  return <div className="journey-dialog-scrim">
    <section
      className="journey-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="journey-dialog-title"
      data-surface="journey-confirmation"
    >
      <h2 id="journey-dialog-title">{tJourney(text.title, { name: text.name ?? '' })}</h2>
      <p>{tJourney(text.body, { size: text.size ?? '' })}</p>
      {text.cloudNote !== false && <p className="journey-note">{tJourney('journey.cloudSafe')}</p>}
      <div className="journey-actions">
        <Button
          autoFocus
          data-journey-primary
          data-journey-confirm-cancel
          data-focus="journey-confirm-cancel"
          disabled={confirmation.pending}
          onClick={onCancel}
        >
          {tJourney(confirmationSafeChoice(confirmation) === 'keep' ? 'journey.keep' : 'journey.cancel')}
        </Button>
        <Button
          variant="danger"
          data-focus="journey-confirm-action"
          disabled={confirmation.pending}
          onClick={onConfirm}
        >
          {tJourney(text.action)}
        </Button>
      </div>
    </section>
  </div>
}

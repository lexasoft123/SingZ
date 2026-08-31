import React, { Component, type ComponentType } from 'react'
import { Modal } from '@singz/ui'
import {
  RecoverableModule,
  type ModuleAttempts,
  type ModuleLoader
} from './RecoverableModule'

export type LazyDialogModuleLoader<Props> = ModuleLoader<Props>
export type LazyDialogModuleAttempts<Props> = ModuleAttempts<Props>

export interface LazyDialogLabels {
  readonly name: string
  readonly opening: string
  readonly failureTitle: string
  readonly failureMessage: string
}

interface ClosableDialogProps {
  readonly onClose: () => void
}

interface DialogRuntimeBoundaryProps<Props extends ClosableDialogProps> {
  readonly Loaded: ComponentType<Props>
  readonly dialogProps: Props
  readonly labels: LazyDialogLabels
  readonly canClose: boolean
}

interface DialogRuntimeBoundaryState {
  readonly failed: boolean
}

/** Runtime faults are contained, but never represented as an import retry. */
export class DialogRuntimeBoundary<
  Props extends ClosableDialogProps
> extends Component<DialogRuntimeBoundaryProps<Props>, DialogRuntimeBoundaryState> {
  state: DialogRuntimeBoundaryState = { failed: false }

  static getDerivedStateFromError(_error: unknown): DialogRuntimeBoundaryState {
    return { failed: true }
  }

  private readonly close = (): void => {
    if (this.props.canClose) this.props.dialogProps.onClose()
  }

  render(): React.JSX.Element {
    if (this.state.failed) {
      return (
        <DialogRuntimeFailure
          labels={this.props.labels}
          canClose={this.props.canClose}
          onClose={this.close}
        />
      )
    }
    const Loaded = this.props.Loaded
    return <Loaded {...this.props.dialogProps} />
  }
}

export function createLazyDialogRoute<Props extends ClosableDialogProps>(
  attempts: LazyDialogModuleAttempts<Props>,
  labels: LazyDialogLabels,
  canClose: (props: Props) => boolean = () => true
): ComponentType<Props> {
  let preferredAttempt: 0 | 1 = 0
  return function LazyDialogRoute(dialogProps: Props): React.JSX.Element {
    const closeAllowed = canClose(dialogProps)
    const close = (): void => {
      if (closeAllowed) dialogProps.onClose()
    }
    return (
      <RecoverableModule
        attempts={attempts}
        initialAttempt={preferredAttempt}
        onAttemptFailed={(attempt) => {
          if (attempt === 0) preferredAttempt = 1
        }}
        renderLoading={() => (
          <LazyDialogFallback labels={labels} canClose={closeAllowed} onClose={close} />
        )}
        renderFailure={(retry) => (
          <LazyDialogFailure
            labels={labels}
            canClose={closeAllowed}
            onRetry={retry}
            onClose={close}
          />
        )}
        renderLoaded={(Loaded) => (
          <DialogRuntimeBoundary
            Loaded={Loaded}
            dialogProps={dialogProps}
            labels={labels}
            canClose={closeAllowed}
          />
        )}
      />
    )
  }
}

export function LazyDialogFallback({
  labels,
  canClose,
  onClose
}: {
  readonly labels: LazyDialogLabels
  readonly canClose: boolean
  readonly onClose: () => void
}): React.JSX.Element {
  return (
    <Modal onClose={onClose} busy={!canClose} cardClassName="dialog-route-state" aria-label={labels.name}>
      <h2>{labels.name}</h2>
      <p role="status" aria-live="polite" aria-busy="true">{labels.opening}</p>
      <div className="modal-actions">
        <button type="button" className="pill ghost" disabled={!canClose} onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  )
}

export function LazyDialogFailure({
  labels,
  canClose,
  onRetry,
  onClose
}: {
  readonly labels: LazyDialogLabels
  readonly canClose: boolean
  readonly onRetry: (() => void) | null
  readonly onClose: () => void
}): React.JSX.Element {
  return (
    <Modal onClose={onClose} busy={!canClose} cardClassName="dialog-route-state" aria-label={labels.failureTitle}>
      <h2>{labels.failureTitle}</h2>
      <p role="alert">{labels.failureMessage}</p>
      <div className="modal-actions">
        {onRetry ? (
          <button type="button" className="pill primary" onClick={onRetry}>Retry</button>
        ) : (
          <p className="fine warn" role="status">
            The recovery copy also could not be loaded. Restart SingZ before trying again.
          </p>
        )}
        <button type="button" className="pill ghost" disabled={!canClose} onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  )
}

export function DialogRuntimeFailure({
  labels,
  canClose,
  onClose
}: {
  readonly labels: LazyDialogLabels
  readonly canClose: boolean
  readonly onClose: () => void
}): React.JSX.Element {
  return (
    <Modal onClose={onClose} busy={!canClose} cardClassName="dialog-route-state" aria-label={`${labels.name} stopped`}>
      <h2>{labels.name} stopped</h2>
      <p role="alert">
        This view encountered a problem. Any work it already started may still be running.
      </p>
      {!canClose && (
        <p className="fine warn" role="status">Keep SingZ open while the current operation finishes.</p>
      )}
      <div className="modal-actions">
        <button type="button" className="pill ghost" disabled={!canClose} onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  )
}

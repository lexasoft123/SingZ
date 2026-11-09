import { useEffect, useState, useSyncExternalStore } from 'react'
import { Button, Modal, ModalActions } from '@singz/ui'
import { RetainedPlaybackController, type RetainedRestore } from './retained-playback'
import { t } from './i18n'

/** Restores verified retained playback when offered, with an explicit Stop fallback. */
export function RetainedPlayback({ onRestore }: { onRestore?: RetainedRestore }): React.JSX.Element | null {
  const [controller] = useState(() => new RetainedPlaybackController(window.singz))
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  useEffect(() => {
    controller.resume()
    const timer = setInterval(() => { void controller.poll() }, 1000)
    return () => { clearInterval(timer); controller.dispose() }
  }, [controller])
  useEffect(() => {
    controller.setRestoreCallback(onRestore)
    void controller.poll()
  }, [controller, onRestore])
  if (state.restoring) return <Modal persistent onClose={() => {}} cardClassName="box-switch-card" aria-label={t('box.retained.restoringTitle')}>
    <div data-surface="retained-playback" data-restoring>
      <h2>{t('box.retained.restoringTitle')}</h2>
      <p role="status">{t('box.retained.restoringBody')}</p>
    </div>
  </Modal>
  if (!state.generation && !state.error) return null
  const title = state.generation
    ? state.playing ? t('box.retained.playingTitle') : t('box.retained.loadedTitle')
    : t('box.retained.unavailableTitle')
  return <Modal persistent onClose={() => {}} cardClassName="box-switch-card" aria-label={t('box.retained.dialogLabel')}>
    <div data-surface="retained-playback">
      <h2>{title}</h2>
      <p>{t('box.retained.body')}</p>
      {state.error && <p role="alert">{state.error}</p>}
      <ModalActions>
        <Button data-retained-refresh autoFocus disabled={state.busy} onClick={() => { void controller.refresh() }}>{t('box.retained.refresh')}</Button>
        <Button data-retained-stop disabled={state.busy || !state.generation} onClick={() => { void controller.stop() }}>{t('box.retained.stop')}</Button>
      </ModalActions>
    </div>
  </Modal>
}

import { useEffect, useState, useSyncExternalStore } from 'react'
import { Button, Modal, ModalActions } from '@singz/ui'
import { RetainedPlaybackController, type RetainedRestore } from './retained-playback'

/** Restores verified retained playback when offered, with an explicit Stop fallback. */
export function RetainedPlayback({ onRestore }: { onRestore?: RetainedRestore }): React.JSX.Element | null {
  const [controller] = useState(() => new RetainedPlaybackController(window.singz))
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  useEffect(() => {
    controller.resume()
    const timer = setInterval(() => { void controller.refresh() }, 1000)
    return () => { clearInterval(timer); controller.dispose() }
  }, [controller])
  useEffect(() => {
    controller.setRestoreCallback(onRestore)
    void controller.refresh()
  }, [controller, onRestore])
  if (state.restoring) return <Modal persistent onClose={() => {}} cardClassName="box-switch-card" aria-label="Restoring previous song">
    <div data-surface="retained-playback" data-restoring>
      <h2>Restoring previous song</h2>
      <p role="status">The song and its lyrics are being restored.</p>
    </div>
  </Modal>
  if (!state.generation && !state.error) return null
  return <Modal persistent onClose={() => {}} cardClassName="box-switch-card" aria-label="Previous song">
    <div data-surface="retained-playback">
      <h2>{state.generation ? state.playing ? 'Music is still playing' : 'Previous song is still loaded' : 'Audio status unavailable'}</h2>
      <p>Stop this song before opening another. Its project and lyrics have not been restored.</p>
      {state.error && <p role="alert">{state.error}</p>}
      <ModalActions>
        <Button data-retained-refresh autoFocus disabled={state.busy} onClick={() => { void controller.refresh() }}>Refresh</Button>
        <Button data-retained-stop disabled={state.busy || !state.generation} onClick={() => { void controller.stop() }}>Stop song</Button>
      </ModalActions>
    </div>
  </Modal>
}

import { useEffect, useState, useSyncExternalStore } from 'react'
import { Button, Modal, ModalActions } from '@singz/ui'
import { RetainedPlaybackController } from './retained-playback'

/** Offers an explicit stop without claiming restored lyrics/project ownership. */
export function RetainedPlayback(): React.JSX.Element | null {
  const [controller] = useState(() => new RetainedPlaybackController(window.singz))
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  useEffect(() => {
    controller.resume()
    void controller.refresh()
    const timer = setInterval(() => { void controller.refresh() }, 1000)
    return () => { clearInterval(timer); controller.dispose() }
  }, [controller])
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

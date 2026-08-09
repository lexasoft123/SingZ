import { WindowButtons as KitWindowButtons, type WindowControlsApi } from '@singz/ui'

/*
 * The buttons themselves are the kit's — three of them, close last, with the
 * Maximize/Restore title flip that win-smoke selects on. What stays here is
 * the only SingZ-shaped part: which IPC bridge they talk to.
 */
const api: WindowControlsApi = {
  isMaximized: () => window.singz.winIsMaximized(),
  onMaximized: (cb) => window.singz.onWinMaximized(cb),
  minimize: () => window.singz.winMinimize(),
  maximizeToggle: () => window.singz.winMaximizeToggle(),
  close: () => window.singz.winClose()
}

export default function WindowButtons(): React.JSX.Element {
  return <KitWindowButtons api={api} />
}

import { useEffect, useState } from 'react'

/** Custom min/max/close for the frameless Windows build (native frame is square on Win10). */
export default function WindowButtons(): React.JSX.Element {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    const apply = (v: boolean): void => {
      setMaximized(v)
      document.body.classList.toggle('maximized', v)
    }
    void window.singz.winIsMaximized().then(apply)
    return window.singz.onWinMaximized(apply)
  }, [])

  return (
    <div className="win-controls no-drag">
      <button type="button" title="Minimize" onClick={() => window.singz.winMinimize()}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <rect x="0" y="4.5" width="10" height="1" fill="currentColor" />
        </svg>
      </button>
      <button
        type="button"
        title={maximized ? 'Restore' : 'Maximize'}
        onClick={() => window.singz.winMaximizeToggle()}
      >
        {maximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <path
              d="M2.5 2.5V0.5h7v7h-2M0.5 2.5h7v7h-7z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1"
            />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <rect
              x="0.5"
              y="0.5"
              width="9"
              height="9"
              fill="none"
              stroke="currentColor"
              strokeWidth="1"
            />
          </svg>
        )}
      </button>
      <button type="button" className="close" title="Close" onClick={() => window.singz.winClose()}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M0.7 0.7l8.6 8.6M9.3 0.7L0.7 9.3" stroke="currentColor" strokeWidth="1.1" />
        </svg>
      </button>
    </div>
  )
}

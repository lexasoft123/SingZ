import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { MultitrackEngine } from '../audio/engine'
import { createVoiceController } from './voice-bootstrap'
import { blocksSongTransportShortcut } from '../keyboard'
import { cleanSongName, type TimeView } from '../model'
import type { LoadedSongIdentity } from '../training-ui-state'
import VoiceRecordButton from './voice-record-button'
import VoiceStrip from './VoiceStrip'
import { useVoiceModel } from './voice-host'
import './voice-strip.css'

/*
 * Everything the Voice strip adds to the song screen, as one lazy chunk (the
 * renderer entry has a size budget, scripts/check-renderer-split.mjs): the
 * controller, the strip, the transport Record button (portalled into the
 * `.voice-record-slot` in Transport), the R shortcut, and the dimming of the
 * stems while a take plays alone.
 */
export default function VoiceHost({
  e: engine,
  s: song,
  p: projectDir,
  v: view
}: {
  e: MultitrackEngine
  s: LoadedSongIdentity | null
  p: string | null
  /** The stems' shared time view: the Voice lane draws on the same axis. */
  v: TimeView | null
}): React.JSX.Element | null {
  const [controller] = useState(() => createVoiceController(engine))
  // Captured when the song loads (its load token changes): later re-anchoring of
  // `song.path` or a newly created project must not swap the strip's song.
  const token = song?.preparationSourceId
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const fixed = useMemo(() => (song ? { path: song.path, projectDir } : null), [token])
  const title = song ? cleanSongName(song.name) : ''
  useEffect(
    () => (fixed ? controller.bindSong({ ...fixed, title, artist: '' }) : undefined),
    [controller, fixed, title]
  )
  const model = useVoiceModel(controller)
  const root = useRef<HTMLSpanElement>(null)
  // The Record button sits right after Play, in a node this host adds there.
  // Transport can re-mount that part of its tree, so the slot is re-attached
  // whenever it falls out of place (coalesced to one check per frame).
  // Not unit-testable here: it needs a DOM and Transport's real markup (the
  // test environment is node); it is covered by the real-app run.
  const [slot, setSlot] = useState<Element | null>(null)
  useEffect(() => {
    const el = document.createElement('span')
    el.className = 'voice-record-slot'
    let raf = 0
    const place = (): void => {
      raf = 0
      const play = document.querySelector('.transport-left .play')
      if (play && play.nextElementSibling !== el) play.after(el)
    }
    const schedule = (): void => {
      if (!raf) raf = requestAnimationFrame(place)
    }
    place()
    setSlot(el)
    // Observe the transport bar and its parent; when the bar is replaced,
    // observe the new one.
    let observedBar: Element | null = null
    const mo = new MutationObserver(() => {
      const now = document.querySelector('.transport')
      if (now !== observedBar) watch(now)
      schedule()
    })
    const watch = (bar: Element | null): void => {
      mo.disconnect()
      observedBar = bar
      if (bar) mo.observe(bar, { childList: true, subtree: true })
      if (bar?.parentElement) mo.observe(bar.parentElement, { childList: true })
    }
    watch(document.querySelector('.transport'))
    return () => {
      mo.disconnect()
      if (raf) cancelAnimationFrame(raf)
      el.remove()
    }
  }, [])

  // R toggles recording. Text fields and dialogs own the key, exactly as for Space.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.code !== 'KeyR' || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
      const modalOpen = document.body.classList.contains('modal-open') || Boolean(document.querySelector('[role="dialog"]'))
      if (blocksSongTransportShortcut(e.target, e.code, modalOpen)) return
      e.preventDefault()
      if (!e.repeat) void controller.toggleRecord()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [controller])

  // A take playing alone: the stems are not playing, so they read as off.
  const alone = model.listen === 'take'
  useEffect(() => {
    const col = root.current?.closest('.main-col')
    col?.classList.toggle('voice-listening-alone', alone)
    return () => col?.classList.remove('voice-listening-alone')
  }, [alone])

  return (
    <>
      <span ref={root} hidden />
      <VoiceStrip controller={controller} engine={engine} view={view} />
      {slot && createPortal(<VoiceRecordButton controller={controller} />, slot)}
    </>
  )
}

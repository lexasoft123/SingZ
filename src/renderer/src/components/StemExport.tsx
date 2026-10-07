import { useEffect, useRef, useState } from 'react'
import { laneLabel, type UITrack } from '../model'
import { t } from '../i18n'
import { Modal } from '@singz/ui'

export default function StemExport({ tracks, onClose }: { tracks: UITrack[]; onClose: () => void }): React.JSX.Element {
  const cancelled = useRef(false)
  const activeToken = useRef<string | undefined>(undefined)
  const [format, setFormat] = useState<'wav' | 'flac' | 'mp3'>('wav')
  const [selected, setSelected] = useState(() => new Set(tracks.map(track => track.id)))
  const [karaoke, setKaraoke] = useState(false)
  const karaokeTracks = tracks.filter(track => ['drums', 'bass', 'other', 'guitar', 'piano'].includes(track.id) || /^custom-backing-vocals(?:-\d+)?$/.test(track.id))
  const hasBacking = karaokeTracks.some(track => /^custom-backing-vocals(?:-\d+)?$/.test(track.id))
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  useEffect(() => {
    return () => { cancelled.current = true; if (activeToken.current) void window.singz.endStemExport(activeToken.current) }
  }, [])
  const close = (): void => {
    cancelled.current = true
    if (activeToken.current) void window.singz.endStemExport(activeToken.current)
    if (!busy) onClose()
  }
  const run = async (): Promise<void> => {
    cancelled.current = false
    setBusy(true)
    setStatus('')
    // Capture before the native picker: the song can change while it is open.
    const sources = tracks.filter(track => selected.has(track.id)).map(track => ({ label: laneLabel(track), paths: [track.sourcePath ?? track.custom?.file] }))
    if (karaoke && karaokeTracks.length) sources.push({ label: t('player.stack.exportKaraoke'), paths: karaokeTracks.map(track => track.sourcePath ?? track.custom?.file) })
    let token: string | undefined
    try {
      const session = await window.singz.beginStemExport()
      if (!session.ok || !session.token) {
        if (session.error) throw new Error(session.error)
        return
      }
      token = session.token
      activeToken.current = token
      for (let i = 0; i < sources.length; i++) {
        if (cancelled.current) break
        const source = sources[i]
        setStatus(`${t('player.stack.exportProgress')} ${i + 1}/${sources.length}: ${source.label}`)
        if (source.paths.some(path => !path)) throw new Error(source.label)
        const result = await window.singz.writeStemExport(token, `${String(i + 1).padStart(2, '0')}-${source.label}`, format, source.paths.length === 1 ? source.paths[0]! : source.paths as string[])
        if (!result.ok) throw new Error(result.error)
      }
      if (!cancelled.current) setStatus(t('player.stack.exportDone'))
    } catch (error) { if (!cancelled.current) setStatus(`${t('player.stack.exportError')}: ${String(error)}`) }
    finally {
      if (token) await window.singz.endStemExport(token)
      activeToken.current = undefined
      setBusy(false)
      if (cancelled.current) onClose()
    }
  }
  return <Modal cardClassName="stem-export-dialog" aria-label={t('player.stack.exportTitle')} onClose={close}>
      <h2 id="stem-export-title">{t('player.stack.exportTitle')}</h2>
      <p>{t('player.stack.exportHint')}</p>
      <select aria-label={t('player.stack.exportTitle')} value={format} disabled={busy} onChange={event => setFormat(event.target.value as typeof format)}>
        <option value="wav">WAV</option><option value="flac">FLAC</option><option value="mp3">MP3</option>
      </select>
      <fieldset className="stem-export-selection" disabled={busy}>
        <legend>{t('player.stack.exportSelect')}</legend>
        {tracks.map(track => <label key={track.id}>
          <input type="checkbox" checked={selected.has(track.id)} onChange={event => setSelected(current => {
            const next = new Set(current)
            if (event.target.checked) next.add(track.id); else next.delete(track.id)
            return next
          })} />{laneLabel(track)}
        </label>)}
        <label><input type="checkbox" checked={karaoke} disabled={!karaokeTracks.length} onChange={event => setKaraoke(event.target.checked)} />{t('player.stack.exportKaraoke')}</label>
      </fieldset>
      <p className="stem-export-note">{t(hasBacking ? 'player.stack.exportKaraokeHint' : 'player.stack.exportKaraokeNoBacking')}</p>
      <p role="status">{status}</p>
      <div className="stem-export-actions">
        <button type="button" disabled={busy || (!tracks.some(track => selected.has(track.id)) && (!karaoke || !karaokeTracks.length))} onClick={() => void run()}>{t('player.stack.exportChoose')}</button>
        <button type="button" onClick={close}>{t('player.stack.exportCancel')}</button>
      </div>
    </Modal>
}

import { useEffect, useRef, useState } from 'react'
import { Modal } from '@singz/ui'
import { t } from '../i18n'
export interface DriveProjectsProps { onOpen: (path: string) => void; onClose: () => void }
export default function DriveProjects({ onOpen, onClose }: DriveProjectsProps): React.JSX.Element {
  const [projects, setProjects] = useState<{ id: string; name: string; songPath?: string }[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [message, setMessage] = useState('')
  const [progress, setProgress] = useState(0)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    void window.singz.gdriveProjects().then(r => { if (alive.current) { setProjects(r.projects); if (!r.ok) setMessage(r.error ?? '') } })
    const off = window.singz.onGdriveProgress(p => { if (alive.current) { setMessage(p.msg); setProgress(p.frac) } })
    return () => { alive.current = false; off(); void window.singz.gdriveCancelDownload() }
  }, [])
  const open = async (p: NonNullable<typeof projects>[number]): Promise<void> => {
    if (p.songPath) { onClose(); onOpen(p.songPath); return }
    setBusy(true); setMessage(t('library.drive.downloading')); setProgress(0)
    const result = await window.singz.gdriveDownload(p.id)
    if (!alive.current) return
    setBusy(false)
    if (result.ok && result.songPath) { onClose(); onOpen(result.songPath) }
    else setMessage(result.cancelled ? t('library.drive.cancelled') : result.error ?? '')
  }
  return <Modal onClose={() => { if (busy) void window.singz.gdriveCancelDownload(); else onClose() }} cardClassName="picker-card">
    <div className="picker-head"><h2>{t('library.drive.title')}</h2><button type="button" className="pill ghost small" onClick={() => { if (busy) void window.singz.gdriveCancelDownload(); else onClose() }}>{busy ? t('library.dropScreen.cancelSync') : t('library.common.close')}</button></div>
    <p className="fine">{t('library.drive.hint')}</p>
    <input className="lib-search" style={{ width: '100%' }} type="search" aria-label={t('library.drive.search')} placeholder={t('library.drive.search')} value={query} onChange={e => setQuery(e.target.value)} disabled={busy} />
    {message && <p role="status">{message}</p>}
    {busy && <progress max={1} value={progress} style={{ width: '100%' }} />}
    {projects === null ? <p>{t('library.drive.loading')}</p> : <div className="picker-rows">
      {projects.filter(p => p.name.toLowerCase().includes(query.toLowerCase())).map(p => <button type="button" className="picker-row" key={p.id} disabled={busy} onClick={() => void open(p)}>
        <span className="picker-name">{p.name}</span><span className="picker-meta">{p.songPath ? t('library.drive.open') : t('library.drive.download')}</span>
      </button>)}
      {projects.length === 0 && <p>{t('library.drive.empty')}</p>}
    </div>}
  </Modal>
}

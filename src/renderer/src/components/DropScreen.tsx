import { useCallback, useEffect, useMemo, useState } from 'react'
import { Modal } from '@singz/ui'
import type { ProjectListItem, SyncStatus } from '../../../shared/types'
import { TRACK_META } from '../model'
import { t, tn, formatLocale } from '../i18n'

const BAR_COLORS = [
  TRACK_META.vocals.color,
  TRACK_META.drums.color,
  TRACK_META.bass.color,
  TRACK_META.other.color
]

// Deterministic pseudo-random bars so renders are stable.
const BARS = Array.from({ length: 56 }, (_, i) => ({
  h: 16 + Math.abs(Math.sin(i * 1.7 + 0.4)) * 78,
  d: (i * 0.137) % 1.4,
  c: BAR_COLORS[i % 4]
}))

const TILE_HUES = [
  ['#f66d5c', '#f2a83d', '#58d68a'],
  ['#5ba8f5', '#f2a83d', '#b58cf2'],
  ['#58d68a', '#ffd97a', '#f66d5c']
]

function fmtDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(formatLocale(), { month: 'short', day: 'numeric' })
}

function fmtSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`
}

/** Which cloud the library folder itself lives in (said once, not per card). */
function folderCloud(root: string): string {
  if (root.includes('Mobile Documents')) return t('library.dropScreen.cloudIcloud')
  if (root.includes('OneDrive')) return t('library.dropScreen.cloudOnedrive')
  return t('library.dropScreen.cloudLocal')
}

interface Props {
  /** Eager shell asset: recoverable route copies must not share a lazy child. */
  gdriveIcon: string
  loading: boolean
  /** What the open is doing and how far along — null until one starts. The
   *  wait is under a second on a fast Mac and several on a field laptop, and
   *  a spinner says the same thing either way. */
  progress?: { msg: string; frac: number } | null
  songName?: string
  /** Song still open behind this page (Catalog view) — softens the hero copy. */
  openName?: string
  onBrowse: () => void
  onOpenProject: (songPath: string) => void
  onManageStorage: () => void
  /** Opens the app's one Log dialog — the sync writes into it like everything
   *  else, so there is no second window to keep in step. */
  onShowLog: () => void
  /** A project was deleted here — the open song may have been it. */
  onDeleted?: (dir: string) => void
}

export default function DropScreen({
  gdriveIcon,
  loading,
  progress,
  songName,
  openName,
  onBrowse,
  onOpenProject,
  onManageStorage,
  onShowLog,
  onDeleted
}: Props): React.JSX.Element {
  const [projects, setProjects] = useState<ProjectListItem[]>([])
  const [root, setRoot] = useState('')
  const [query, setQuery] = useState('')
  const [gdrive, setGdrive] = useState<{
    configured: boolean
    signedIn: boolean
    lastSync?: number | null
    sync?: SyncStatus
    dirtyDirs?: string[]
  }>({ configured: false, signedIn: false })
  const [syncingDir, setSyncingDir] = useState<string | null>(null)
  const [syncProg, setSyncProg] = useState<{ msg: string; frac: number } | null>(null)
  const [driveMsg, setDriveMsg] = useState<string | null>(null)
  /** The project the singer has asked to delete, waiting on the confirmation. */
  const [doomed, setDoomed] = useState<ProjectListItem | null>(null)
  const [deleting, setDeleting] = useState(false)

  useEffect(
    () =>
      window.singz.onGdriveState((sync) => {
        setGdrive((g) => ({ ...g, sync }))
        // A run finishing (or a mark landing) changes which songs are waiting.
        // The reply is merged, never assigned: it was asked for before whatever
        // arrived in the meantime, and a whole-object set would put the older
        // phase and dirty list back on screen.
        if (sync.phase !== 'syncing') {
          void window.singz.gdriveStatus().then((st) =>
            setGdrive((g) => ({ ...st, sync: g.sync ?? st.sync }))
          )
        }
      }),
    []
  )

  const refresh = useCallback(() => {
    void window.singz.listProjects().then((res) => {
      setRoot(res.root)
      setProjects(res.projects)
    })
    void window.singz.gdriveStatus().then(setGdrive)
  }, [])

  useEffect(() => {
    refresh()
    return window.singz.onGdriveProgress((p) => {
      const m = /^(?:Syncing|Uploading) ([^/…]+)/.exec(p.msg)
      setSyncingDir(p.frac >= 1 ? null : (m?.[1]?.trim() ?? null))
      setSyncProg(p.frac >= 1 ? null : p)
      if (p.frac >= 1) refresh()
    })
  }, [refresh])

  const onDrive = useCallback(async () => {
    if (!gdrive.signedIn) {
      setDriveMsg(t('library.common.finishGoogleSignIn'))
      const res = await window.singz.gdriveSignIn()
      if (!res.ok) {
        setDriveMsg(t('library.dropScreen.signInFailed', { error: res.error }))
        return
      }
      setDriveMsg(null)
    }
    setDriveMsg(null)
    const rep = await window.singz.gdriveSync()
    setDriveMsg(rep.ok ? null : t('library.common.syncFailed', { error: rep.error ?? t('library.common.unknownError') }))
    refresh()
  }, [gdrive.signedIn, refresh])

  // body.modal-open is the kit <Modal>'s job now, and it ref-counts it. This
  // was the second independent owner of that class: a `remove` here fired
  // whenever the confirm closed, even if one of App's dialogs was still open
  // behind it, and the equaliser would start animating under the scrim again.

  // Esc answers the question, not the page behind it — App's own Escape
  // handler would otherwise close the whole catalog out from under it. Capture
  // beats bubble whatever order the two listeners were registered in.
  useEffect(() => {
    if (!doomed) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      if (!deleting) setDoomed(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [doomed, deleting])

  const confirmDelete = useCallback(async () => {
    if (!doomed || deleting) return
    setDeleting(true)
    const res = await window.singz.deleteProject(doomed.dir)
    setDeleting(false)
    setDoomed(null)
    if (!res.ok) {
      setDriveMsg(t('library.dropScreen.deleteFailed', { error: res.error }))
      return
    }
    // the song is gone from this machine; whoever owns the open song decides
    // what that means for what is playing
    onDeleted?.(doomed.dir)
    refresh()
  }, [doomed, deleting, onDeleted, refresh])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? projects.filter((p) => p.name.toLowerCase().includes(q)) : projects
  }, [projects, query])

  const lastSyncLabel = useMemo(() => {
    if (!gdrive.lastSync) return null
    const mins = Math.round((Date.now() - gdrive.lastSync) / 60000)
    if (mins < 1) return t('library.dropScreen.justNow')
    if (mins < 60) return t('library.dropScreen.minAgo', { mins })
    const h = Math.round(mins / 60)
    return h < 24 ? t('library.dropScreen.hAgo', { h }) : fmtDate(new Date(gdrive.lastSync).toISOString())
  }, [gdrive.lastSync])

  /**
   * What Drive knows about this song. The old rule compared the last sync time
   * against savedAt, which was wrong both ways: a lyrics-only change never
   * moves savedAt (✓ on a song Drive has never seen), and a sync that failed
   * still left ✓ on everything saved before it. The ledger knows instead.
   */
  const cardBadge = (p: ProjectListItem): React.JSX.Element | null => {
    if (!gdrive.configured) return null
    if (syncingDir && p.dir.startsWith(syncingDir)) {
      return (
        <span className="lib-badge" title={t('library.dropScreen.uploadingTitle')}>
          <img src={gdriveIcon} alt="" /> ↑
        </span>
      )
    }
    if (!gdrive.signedIn) return null
    // A ✓ has to mean "Drive has this", and the only evidence of that is a sync
    // that actually completed. An empty ledger on a library that has never
    // synced is not evidence — it is the absence of any.
    const everSynced = gdrive.lastSync != null
    const waiting = !everSynced || gdrive.dirtyDirs?.includes(p.dir) || gdrive.sync?.dirty === -1
    if (!waiting) {
      return (
        <span className="lib-badge" title={t('library.dropScreen.upToDateTitle')}>
          <img src={gdriveIcon} alt="" /> ✓
        </span>
      )
    }
    const stuck = gdrive.sync?.phase === 'blocked' || gdrive.sync?.lastErrorKind === 'fatal'
    return stuck ? (
      <span
        className="lib-badge dim"
        title={t('library.dropScreen.notOnDriveTitle', {
          reason: gdrive.sync?.lastError ?? t('library.dropScreen.syncFailedFallback')
        })}
      >
        <img src={gdriveIcon} alt="" /> !
      </span>
    ) : (
      <span className="lib-badge dim" title={t('library.dropScreen.waitingTitle')}>
        <img src={gdriveIcon} alt="" /> …
      </span>
    )
  }

  return (
    <div className={`drop-screen${loading ? ' loading' : ''}`}>
      <div className="drop-inner">
        <div className="eq" aria-hidden>
          {BARS.map((b, i) => (
            <span
              key={i}
              style={{
                height: `${b.h}px`,
                animationDelay: `${b.d}s`,
                background: b.c,
                ['--c' as string]: b.c
              }}
            />
          ))}
        </div>
        {loading ? (
          <>
            {/* raw file stems can be 50+ chars of underscore soup — those
                go on a small line instead of a five-row 52px heading */}
            {!songName || songName.length > 28 ? (
              <>
                <h1>{t('library.dropScreen.reading')}</h1>
                {songName && <p className="drop-file">“{songName}”</p>}
              </>
            ) : (
              <h1>{t('library.dropScreen.readingSong', { song: songName })}</h1>
            )}
            <p>{progress?.msg ?? t('library.dropScreen.decodingAudio')}</p>
            {progress && (
              <div className="open-rail" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress.frac * 100)}>
                <div className="open-fill" style={{ width: `${Math.round(progress.frac * 100)}%` }} />
              </div>
            )}
          </>
        ) : openName ? (
          <>
            <h1>{t('library.dropScreen.yourCatalog')}</h1>
            <p>{t('library.dropScreen.catalogHint', { song: openName })}</p>
            <button type="button" className="pill ghost browse" onClick={onBrowse}>
              {t('library.common.browseFiles')}
            </button>
            <span className="drop-hint">{t('library.dropScreen.escHint')}</span>
          </>
        ) : (
          <>
            <h1>{t('library.dropScreen.dropASong')}</h1>
            <p>{t('library.dropScreen.dropHintDesc')}</p>
            <button type="button" className="pill ghost browse" onClick={onBrowse}>
              {t('library.common.browseFiles')}
            </button>
            <span className="drop-hint">{t('library.dropScreen.dragHint')}</span>
          </>
        )}
      </div>
      {!loading && projects.length > 0 && (
        <div className="lib">
          <div className="lib-head">
            <span className="drop-projects-title">{t('library.common.yourProjects')}</span>
            {projects.length > 6 && (
              <input
                className="lib-search"
                placeholder={t('library.dropScreen.searchPlaceholder')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            )}
          </div>
          <div className="src-panel">
            <div className="src-row">
              <div className="src-card-body">
                <span className="src-card-value" title={root}>
                  <span aria-hidden>📁 </span>
                  {root.includes('Mobile Documents')
                    ? `iCloud Drive › ${root.split('/').pop()}`
                    : root.split('/').slice(-2).join(' › ')}
                </span>
                <span className="src-card-sub">
                  {t('library.dropScreen.libraryLivesHere', { cloud: folderCloud(root) })}
                </span>
              </div>
              <button type="button" className="src-link" onClick={onManageStorage}>
                {t('library.dropScreen.change')}
              </button>
            </div>
            {gdrive.configured && (
              <div className="src-row sub">
                <div className="src-card-body">
                  {driveMsg ? (
                    <span className="src-card-value warn">
                      <img className="src-ic" src={gdriveIcon} alt="" /> {driveMsg}
                    </span>
                  ) : syncProg ? (
                    <span className="src-card-value">
                      <img className="src-ic" src={gdriveIcon} alt="" />
                      {t('library.dropScreen.copyingToDrive', {
                        msg: syncProg.msg,
                        percent: Math.round(syncProg.frac * 100)
                      })}
                    </span>
                  ) : gdrive.signedIn ? (
                    <span className="src-card-value">
                      <img className="src-ic" src={gdriveIcon} alt="" />
                      {t('library.dropScreen.driveCopyLives')}
                      <span className="src-dot ok" />
                      <span className="src-dim2">
                        {t('library.dropScreen.upToDate')}{lastSyncLabel ? ` · ${lastSyncLabel}` : ''}
                      </span>
                    </span>
                  ) : (
                    <span className="src-card-value dim">
                      <img className="src-ic" src={gdriveIcon} alt="" />
                      {t('library.dropScreen.keepCopyHint')}
                    </span>
                  )}
                </div>
                {gdrive.signedIn && (
                  <button type="button" className="src-link" onClick={onShowLog}>
                    {t('library.dropScreen.syncLog')}
                  </button>
                )}
                <button
                  type="button"
                  className="src-link"
                  disabled={syncProg !== null}
                  onClick={() => void onDrive()}
                >
                  {gdrive.signedIn ? t('library.dropScreen.syncNow') : t('library.dropScreen.connect')}
                </button>
              </div>
            )}
          </div>
          <div className="lib-grid">
            {filtered.map((p, i) => (
              // the card is a button, so its delete cannot be one inside it —
              // they sit side by side and the card fills the space
              <div key={p.dir} className="lib-slot">
                <button
                  type="button"
                  className="lib-card"
                  onClick={() => onOpenProject(p.songPath)}
                >
                  <span className="lib-tile" aria-hidden>
                    {TILE_HUES[i % 3].map((c) => (
                      <i key={c} style={{ background: c }} />
                    ))}
                  </span>
                  <span className="lib-body">
                    <span className="lib-name">{p.name}</span>
                    <span className="lib-meta">
                      {p.stemCount > 0
                        ? tn('library.dropScreen.stemsCount', p.stemCount)
                        : t('library.dropScreen.noStems')}
                      {p.hasLyrics ? ` · ${t('library.dropScreen.lyricsBadge')}` : ''}
                      {p.savedAt ? ` · ${fmtDate(p.savedAt)}` : ''}
                    </span>
                  </span>
                  {cardBadge(p)}
                </button>
                <button
                  type="button"
                  className="lib-del"
                  title={t('library.dropScreen.deleteTitle', { name: p.name })}
                  aria-label={t('library.dropScreen.deleteAria', { name: p.name })}
                  onClick={() => setDoomed(p)}
                >
                  ✕
                </button>
              </div>
            ))}
            {filtered.length === 0 && (
              <p className="fine">{t('library.dropScreen.noMatches', { query })}</p>
            )}
          </div>
        </div>
      )}

      {doomed && (
        <Modal
          onClose={() => setDoomed(null)}
          cardClassName="confirm-card"
          busy={deleting}
          aria-label={t('library.dropScreen.deleteHeading', { name: doomed.name })}
        >
            <h2>{t('library.dropScreen.deleteHeading', { name: doomed.name })}</h2>
            <p>
              {t('library.dropScreen.eraseBody', {
                stems: doomed.stemCount > 0
                  ? tn('library.dropScreen.stemsCount', doomed.stemCount)
                  : t('library.dropScreen.eraseStemsFallback'),
                lyrics: doomed.hasLyrics ? t('library.dropScreen.eraseLyricsSuffix') : '',
                size: fmtSize(doomed.bytes)
              })}
            </p>
            <p className="fine">
              {openName === doomed.name ? t('library.dropScreen.openSongNote') : ''}
              {gdrive.signedIn
                ? t('library.dropScreen.driveTrashNote')
                : t('library.dropScreen.resplitNote')}
            </p>
            <div className="storage-actions confirm-actions">
              <button
                type="button"
                className="pill ghost small"
                autoFocus
                disabled={deleting}
                onClick={() => setDoomed(null)}
              >
                {t('library.dropScreen.keepIt')}
              </button>
              <button
                type="button"
                className="pill ghost small danger"
                disabled={deleting}
                onClick={() => void confirmDelete()}
              >
                {deleting ? t('library.dropScreen.deleting') : t('library.dropScreen.deleteSize', { size: fmtSize(doomed.bytes) })}
              </button>
            </div>
        </Modal>
      )}
    </div>
  )
}

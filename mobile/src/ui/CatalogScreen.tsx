import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View
} from 'react-native'
import { decodeAudioData } from 'react-native-audio-api'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  driveAccountEmail,
  driveAvailable,
  driveListProjects,
  driveSignedIn,
  driveSignIn,
  driveSignOut,
  driveStoredProjects
} from '../gdrive'
import { getCrumb, getStoredText, setCrumb, setStoredText } from '../latency'
import { log } from '../log'
import LogPanel from './LogPanel'
import { customTracks, STEM_ORDER_ALL, type LyricsDoc, type ProjectDoc } from '../model'
import {
  cacheUsage,
  clearCache,
  clearRoot,
  getRoot,
  isDownloaded,
  listProjects,
  loadProject,
  pickFolder,
  releaseProject,
  releaseStems,
  type CacheUsage,
  type LoadedProject,
  type ProjectEntry,
  type RootInfo
} from '../projects'
import { C, Seg, StemTile, white } from './bits'
import { TEST } from './testhooks'

const BG = require('../../assets/bg/catalog.png')
const GDRIVE_ICON = require('../../assets/gdrive.png')
const SAMPLE_PROJECT = require('../../assets/sample/project.json') as ProjectDoc
const SAMPLE_LYRICS = require('../../assets/sample/lyrics.json') as LyricsDoc
const SAMPLE_STEMS: Record<string, number> = {
  vocals: require('../../assets/sample/stems/vocals.flac'),
  drums: require('../../assets/sample/stems/drums.flac'),
  bass: require('../../assets/sample/stems/bass.flac'),
  guitar: require('../../assets/sample/stems/guitar.flac'),
  piano: require('../../assets/sample/stems/piano.flac'),
  other: require('../../assets/sample/stems/other.flac')
}
const SAMPLE_DIR = '~sample'

interface Loading {
  dir: string
  msg: string
  frac: number
}

const fmtSize = (bytes: number): string =>
  bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`

export default function CatalogScreen({
  sampleRate,
  onLoaded
}: {
  sampleRate: number
  onLoaded: (p: LoadedProject) => void
}): React.JSX.Element {
  const insets = useSafeAreaInsets()
  const [root, setRoot] = useState<RootInfo | null>(null)
  const [projects, setProjects] = useState<ProjectEntry[] | null>(null)
  const [loading, setLoading] = useState<Loading | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Library source: Drive API / picked folder (SAF, iCloud) / on-device. */
  const [mode, setMode] = useState<'gdrive' | 'folder' | 'phone'>('phone')
  const [driveEmail, setDriveEmail] = useState<string | null>(null)
  const [driveOn, setDriveOn] = useState(false)
  const [pulling, setPulling] = useState(false)
  /** What each project holds on this phone: total bytes and the size of every
   *  file present, which is what the ✓ compares against project.json. */
  const [usage, setUsage] = useState<Record<string, CacheUsage>>({})
  /** The listing on screen is the stored one; the refresh behind it failed. */
  const [offline, setOffline] = useState(false)
  /** The diagnostic log — the only evidence a release build leaves behind. */
  const [logOpen, setLogOpen] = useState(false)
  /** Bumping this token abandons any in-flight load (switch or cancel). */
  const token = useRef(0)
  /** Bumping this drops a superseded listing (mode switched mid-flight). */
  const listSeq = useRef(0)

  const loadUsage = useCallback(async () => {
    const rows = await cacheUsage()
    const map: Record<string, CacheUsage> = {}
    for (const r of rows) map[r.project] = r
    setUsage(map)
  }, [])

  const refresh = useCallback(
    async (force = false) => {
      const my = ++listSeq.current
      try {
        setError(null)
        if (mode === 'gdrive') {
          setRoot({ kind: 'picked', path: 'gdrive', name: 'Google Drive' })
          // Stale-while-revalidate, and the stale copy outlives the process:
          // whatever listing we have shows INSTANTLY (a song outlives the
          // freshness window, and a spinner on every exit reads as the
          // library re-downloading), then the network replaces it quietly.
          // The full-screen spinner is ONLY for an empty screen — on
          // pull-to-refresh the pull indicator is already spinning.
          // The catalog goes up BEFORE the sign-in probes: those are pref
          // reads too, and holding a ready catalog behind three bridge hops
          // is a visible "loading from Google Drive" flash on a cold start.
          const cached = await driveStoredProjects()
          if (my !== listSeq.current) return
          setProjects(cached?.length ? cached : null)
          const signed = await driveSignedIn()
          setDriveOn(signed)
          if (!signed) {
            if (my === listSeq.current) setProjects([])
            return
          }
          setDriveEmail(await driveAccountEmail())
          try {
            const fresh = await driveListProjects(force)
            if (my === listSeq.current) {
              setProjects(fresh)
              setOffline(false)
            }
          } catch (e) {
            // No signal is not an error when the phone already knows the
            // library — say so quietly rather than replacing a working
            // catalog with red text.
            if (!cached?.length) throw e
            if (my === listSeq.current) setOffline(true)
          }
        } else {
          const r = await getRoot()
          const list = await listProjects()
          if (my === listSeq.current) {
            setRoot(r)
            setProjects(list)
          }
        }
        void loadUsage()
      } catch (e) {
        if (my === listSeq.current) {
          setError(String(e instanceof Error ? e.message : e))
          setProjects([])
        }
      }
    },
    [mode, loadUsage]
  )

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    void getStoredText('singz.libMode').then((m) => {
      if (m === 'gdrive' && driveAvailable()) setMode('gdrive')
      else if (m === 'folder') setMode('folder')
      else {
        // no stored choice: land on the folder root if one was picked
        void getRoot().then((r) => setMode(r.kind === 'picked' ? 'folder' : 'phone'))
      }
    })
    void getCrumb().then((c) => {
      if (c) {
        setError(`The last open crashed while ${c} — please report this.`)
        void setCrumb('')
      }
    })
  }, [])

  const selectMode = useCallback(
    (next: 'gdrive' | 'folder' | 'phone'): void => {
      void (async () => {
        try {
          setError(null)
          if (next === 'phone') await clearRoot()
          if (next === 'folder') {
            const r = await getRoot()
            if (r.kind !== 'picked') {
              const picked = await pickFolder()
              if (!picked) return // kept the current source
            }
          }
          setMode(next)
          void setStoredText('singz.libMode', next)
        } catch (e) {
          setError(String(e instanceof Error ? e.message : e))
        }
      })()
    },
    [mode, root]
  )

  const driveSignInFlow = useCallback(async () => {
    try {
      setError(null)
      await driveSignIn()
      setDriveOn(true)
      await refresh()
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    }
  }, [refresh])

  const openDrive = useCallback(async () => {
    setMode('gdrive')
    void setStoredText('singz.libMode', 'gdrive')
    if (!(await driveSignedIn())) await driveSignInFlow()
  }, [driveSignInFlow])

  const cancelLoad = useCallback(() => {
    token.current++
    setLoading(null)
  }, [])

  const forget = useCallback(
    async (project: string) => {
      try {
        await clearCache(project)
        await loadUsage()
      } catch (e) {
        setError(String(e instanceof Error ? e.message : e))
      }
    },
    [loadUsage]
  )

  /** Long-press a downloaded song: drop its files, keep it in the library. */
  const confirmForget = useCallback(
    (entry: ProjectEntry) => {
      const have = usage[entry.dir]?.bytes ?? 0
      if (have <= 0) return
      Alert.alert(
        entry.doc.name ?? entry.dir,
        `Remove ${fmtSize(have)} from this phone? The song stays in your library — ` +
          'opening it again downloads it back.',
        [
          { text: 'Keep it', style: 'cancel' },
          { text: 'Remove', style: 'destructive', onPress: () => void forget(entry.dir) }
        ]
      )
    },
    [forget, usage]
  )

  const confirmForgetAll = useCallback(
    (total: number) => {
      Alert.alert(
        'Free up space',
        `Delete ${fmtSize(total)} of downloaded songs? They stay in your library — ` +
          'you can download them again whenever you have signal.',
        [
          { text: 'Keep them', style: 'cancel' },
          { text: 'Delete', style: 'destructive', onPress: () => void forget('') }
        ]
      )
    },
    [forget]
  )

  const openEntry = useCallback(
    async (entry: ProjectEntry) => {
      const tok = ++token.current
      setError(null)
      setLoading({ dir: entry.dir, msg: 'Opening…', frac: 0 })
      try {
        const loaded = await loadProject(
          entry,
          sampleRate,
          (msg, frac) => {
            if (tok === token.current) setLoading({ dir: entry.dir, msg, frac })
          },
          setCrumb
        )
        if (tok !== token.current) {
          releaseProject(loaded) // superseded by another tap — don't strand its stems
          return
        }
        await setCrumb('')
        setLoading(null)
        onLoaded(loaded)
      } catch (e) {
        await setCrumb('')
        if (tok === token.current) {
          setLoading(null)
          setError(String(e instanceof Error ? e.message : e))
        }
      }
    },
    [onLoaded, sampleRate]
  )

  const openSample = useCallback(async () => {
    const tok = ++token.current
    setError(null)
    try {
      const ids = STEM_ORDER_ALL.filter((s) => s in SAMPLE_STEMS)
      const stems: LoadedProject['stems'] = []
      for (let i = 0; i < ids.length; i++) {
        if (tok !== token.current) return releaseStems(stems)
        setLoading({ dir: SAMPLE_DIR, msg: `Decoding ${ids[i]} · ${i + 1}/${ids.length}`, frac: i / ids.length })
        stems.push({ id: ids[i], buffer: await decodeAudioData(SAMPLE_STEMS[ids[i]], sampleRate) })
      }
      if (tok !== token.current) return
      setLoading(null)
      onLoaded({ name: SAMPLE_PROJECT.name, doc: SAMPLE_PROJECT, lyrics: SAMPLE_LYRICS, stems })
    } catch (e) {
      if (tok === token.current) {
        setLoading(null)
        setError(String(e instanceof Error ? e.message : e))
      }
    }
  }, [onLoaded, sampleRate])

  const changeFolder = useCallback(async () => {
    try {
      const picked = await pickFolder()
      if (picked) {
        await refresh()
        setTimeout(() => void refresh(), 1500)
      }
    } catch (e) {
      setError(`Folder picker: ${String(e instanceof Error ? e.message : e)}`)
    }
  }, [refresh])

  useEffect(() => {
    if (!TEST) return
    TEST.screen = 'catalog'
    TEST.refresh = refresh
    TEST.openSample = openSample
    TEST.openProject = (dir: string) => {
      const entry = (projects ?? []).find((p) => p.dir === dir)
      return entry ? openEntry(entry) : Promise.reject(new Error(`no project ${dir}`))
    }
    TEST.cancelLoad = cancelLoad
    TEST.openDrive = openDrive
    TEST.selectMode = selectMode
    TEST.libMode = mode
    TEST.setPref = setStoredText
    TEST.getPref = getStoredText
    TEST.projects = (projects ?? []).map((p) => p.dir)
    TEST.listError = error
    TEST.busy = loading?.msg ?? null
    TEST.loadingFrac = loading?.frac ?? null
    TEST.usage = usage
    TEST.offline = offline
    TEST.forget = forget
  })

  const card = (opts: {
    key: string
    dir: string
    hue: number
    title: string
    meta: React.ReactNode
    right: React.ReactNode
    sample?: boolean
    onPress: () => void
    onLongPress?: () => void
  }): React.JSX.Element => {
    const isLoading = loading?.dir === opts.dir
    return (
      <Pressable
        key={opts.key}
        onPress={opts.onPress}
        onLongPress={opts.onLongPress}
        style={({ pressed }) => [
          s.card,
          opts.sample && s.cardSample,
          isLoading && s.cardLoading,
          pressed && { transform: [{ scale: 0.98 }] }
        ]}
      >
        <StemTile hue={opts.hue} size={56} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={s.cardTitle} numberOfLines={1}>
            {opts.title}
          </Text>
          {isLoading ? (
            <Text style={[s.cardMeta, { color: C.amber }]} numberOfLines={1}>
              {loading.msg}
            </Text>
          ) : (
            <Text style={s.cardMeta} numberOfLines={1}>
              {opts.meta}
            </Text>
          )}
        </View>
        {isLoading ? (
          <Pressable hitSlop={10} onPress={cancelLoad} style={s.cancelBtn}>
            <Text style={{ color: white(0.75), fontSize: 13, fontWeight: '700' }}>✕</Text>
          </Pressable>
        ) : (
          <View style={{ alignItems: 'flex-end' }}>{opts.right}</View>
        )}
        {isLoading && (
          <View style={s.progressRail}>
            <View style={[s.progressFill, { width: `${Math.round(loading.frac * 100)}%` }]} />
          </View>
        )}
      </Pressable>
    )
  }

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Image source={BG} style={StyleSheet.absoluteFill} resizeMode="cover" />
      <View style={[s.wrap, { paddingTop: insets.top + 6 }]}>
        {/* eyebrow brand row: logo + wordmark tucked beside the cutout */}
        <View style={s.brandRow}>
          <StemTile hue={0} size={26} />
          <Text style={s.brand}>SingZ</Text>
          {/* where the desktop keeps it: in the header, always reachable —
              a log you can only open when things are going well is no use */}
          <Pressable hitSlop={10} style={{ marginLeft: 'auto' }} onPress={() => setLogOpen(true)}>
            <Text style={s.ctxLink}>Log</Text>
          </Pressable>
        </View>
        <Seg
          segments={[
            ...(driveAvailable() ? [{ key: 'gdrive', label: 'Drive', icon: GDRIVE_ICON }] : []),
            { key: 'folder', label: 'Folder', emoji: '📁' },
            {
              key: 'phone',
              label: Platform.OS === 'ios' ? 'This iPhone' : 'This phone',
              emoji: '📱'
            }
          ]}
          active={mode}
          onSelect={(k) => {
            if (k === 'gdrive') void openDrive()
            else selectMode(k as 'folder' | 'phone')
          }}
        />
        <View style={s.ctx}>
          {mode === 'gdrive' &&
            (driveOn ? (
              <>
                <Text style={s.ctxWho} numberOfLines={1}>
                  {offline
                    ? 'No signal — showing your last sync'
                    : (driveEmail ?? 'Signed in to Google Drive')}
                </Text>
                <Text style={s.ctxDot}>·</Text>
                <Pressable
                  hitSlop={8}
                  onPress={() => {
                    void driveSignOut().then(() => {
                      setDriveOn(false)
                      setDriveEmail(null)
                      void refresh()
                    })
                  }}
                >
                  <Text style={s.ctxLink}>Sign out</Text>
                </Pressable>
              </>
            ) : (
              <>
                <Text style={s.ctxWho} numberOfLines={1}>
                  Your projects, synced from the desktop
                </Text>
                <Text style={s.ctxDot}>·</Text>
                <Pressable hitSlop={8} onPress={() => void driveSignInFlow()}>
                  <Text style={s.ctxLink}>Sign in</Text>
                </Pressable>
              </>
            ))}
          {mode === 'folder' && (
            <>
              <Text style={s.ctxWho} numberOfLines={1}>
                {root?.kind === 'picked' ? root.name : 'No folder picked yet'}
              </Text>
              <Text style={s.ctxDot}>·</Text>
              <Pressable hitSlop={8} onPress={() => void changeFolder()}>
                <Text style={s.ctxLink}>Change…</Text>
              </Pressable>
            </>
          )}
          {mode === 'phone' && (
            <Text style={s.ctxWho} numberOfLines={1}>
              {Platform.OS === 'ios'
                ? 'Files you copied onto this iPhone'
                : 'Files you copied onto this phone'}
            </Text>
          )}
        </View>
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: 40 + (Platform.OS === 'android' ? insets.bottom : 0) }}
          refreshControl={
            <RefreshControl
              refreshing={pulling}
              tintColor={C.amber}
              colors={[C.amber]}
              onRefresh={() => {
                setPulling(true)
                void refresh(true).finally(() => setPulling(false))
              }}
            />
          }
        >
          {(projects ?? []).map((p) => {
            const downloaded = isDownloaded(p, usage[p.dir])
            const added = customTracks(p.doc?.settings).length
            return card({
              key: p.dir,
              dir: p.dir,
              hue: Math.abs(p.dir.length * 7 + p.dir.charCodeAt(0)) % 3,
              title: p.doc.name ?? p.dir,
              meta: (
                <>
                  {Object.keys(p.stems).length} stems
                  {added > 0 ? ` · ${added} added` : ''}
                  {p.hasLyrics ? ' · lyrics' : ''}
                  {Object.values(p.stems).some((f) => f === 'wav') ? (
                    <Text style={{ color: C.amber }}> · update on desktop</Text>
                  ) : null}
                </>
              ),
              right: (
                <Text style={[s.status, downloaded && s.statusHave]}>
                  {downloaded ? '✓' : p.bytes > 0 ? `☁ ${fmtSize(p.bytes)}` : '☁'}
                </Text>
              ),
              onPress: () => void openEntry(p),
              onLongPress: () => confirmForget(p)
            })
          })}
          {projects === null && (
            <View style={{ alignItems: 'center', paddingVertical: 36 }}>
              <ActivityIndicator color={C.amber} />
              <Text style={[s.empty, { marginTop: 12 }]}>
                {mode === 'gdrive' ? 'Loading your library from Google Drive…' : 'Loading…'}
              </Text>
            </View>
          )}
          {projects !== null && projects.length === 0 && (
            <Text style={s.empty}>
              {Platform.OS === 'ios'
                ? 'No projects here yet. Save one on your computer into the shared folder (iCloud Drive/SingZ), or pick a different folder above.'
                : 'No projects here yet. Copy project folders from your computer onto this phone, or pick a synced folder above.'}
            </Text>
          )}
          {card({
            key: SAMPLE_DIR,
            dir: SAMPLE_DIR,
            hue: 0,
            title: `Sample — ${SAMPLE_PROJECT.name}`,
            meta: 'bundled · always available',
            right: <Text style={s.status}>✓</Text>,
            sample: true,
            onPress: () => void openSample()
          })}
          {(() => {
            const dirs = Object.keys(usage).filter((d) => usage[d].bytes > 0)
            const total = dirs.reduce((n, d) => n + usage[d].bytes, 0)
            if (total <= 0) return null
            return (
              <View style={s.storage}>
                <Text style={s.storageText}>
                  {dirs.length} song{dirs.length > 1 ? 's' : ''} on this phone · {fmtSize(total)} —
                  playable without internet
                </Text>
                <Pressable hitSlop={8} onPress={() => confirmForgetAll(total)}>
                  <Text style={s.ctxLink}>Free up space</Text>
                </Pressable>
              </View>
            )
          })()}
          {error && <Text style={s.err}>{error}</Text>}
        </ScrollView>
        <LogPanel visible={logOpen} onClose={() => setLogOpen(false)} />
      </View>
    </View>
  )
}

const s = StyleSheet.create({
  wrap: { flex: 1, paddingHorizontal: 20 },
  logSheet: { flex: 1, backgroundColor: C.bg, paddingHorizontal: 20, paddingTop: 60 },
  logHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  logTitle: { color: C.text, fontSize: 20, fontWeight: '700' },
  logRow: { paddingVertical: 7, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#ffffff14' },
  logWhen: { color: C.dim, fontSize: 11, marginBottom: 2 },
  logMsg: { color: C.text, fontSize: 13 },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 9, marginBottom: 14 },
  brand: { color: C.amber, fontSize: 20, fontWeight: '800', letterSpacing: -0.3 },
  ctx: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    minHeight: 30,
    marginTop: 9,
    marginBottom: 12,
    paddingHorizontal: 2
  },
  ctxWho: { color: white(0.6), fontSize: 12.5, flexShrink: 1 },
  ctxDot: { color: white(0.3), fontSize: 12.5 },
  ctxLink: { color: C.amber, fontSize: 12.5, fontWeight: '800' },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 12,
    backgroundColor: white(0.045),
    borderWidth: 1,
    borderColor: white(0.05),
    borderRadius: 17,
    marginBottom: 11,
    overflow: 'hidden'
  },
  cardSample: {
    backgroundColor: 'transparent',
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: white(0.14)
  },
  cardLoading: { backgroundColor: 'rgba(242,193,78,0.07)', borderColor: 'rgba(242,193,78,0.25)' },
  cardTitle: { color: C.bright, fontSize: 16.5, fontWeight: '800', letterSpacing: -0.2 },
  cardMeta: { color: white(0.42), fontSize: 12.5, marginTop: 3 },
  status: { color: C.faint, fontSize: 12, fontWeight: '600' },
  statusHave: { color: white(0.62) },
  storage: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
    marginTop: 6,
    paddingHorizontal: 2
  },
  storageText: { color: C.faint, fontSize: 12, flexShrink: 1 },
  cancelBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: C.btnBg,
    alignItems: 'center',
    justifyContent: 'center'
  },
  progressRail: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 3,
    backgroundColor: white(0.08)
  },
  progressFill: { height: 3, backgroundColor: C.amber, borderTopRightRadius: 2, borderBottomRightRadius: 2 },
  empty: { color: C.faint, fontSize: 14, lineHeight: 20, marginVertical: 12 },
  err: { color: C.red, fontSize: 13, marginTop: 10 }
})

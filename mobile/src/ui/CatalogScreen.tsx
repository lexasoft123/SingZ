import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  Image,
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
  driveListIsFresh,
  driveListProjects,
  driveSignedIn,
  driveSignIn,
  driveSignOut,
  driveStoredProjects
} from '../gdrive'
import { getCrumb, getStoredText, setCrumb, setStoredText } from '../latency'
import { STEM_ORDER_ALL, type LyricsDoc, type ProjectDoc } from '../model'
import {
  cacheUsage,
  clearCache,
  clearRoot,
  getRoot,
  listProjects,
  loadProject,
  pickFolder,
  releaseProject,
  releaseStems,
  type LoadedProject,
  type ProjectEntry,
  type RootInfo
} from '../projects'
import { C, Seg, StemTile } from './bits'
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
  /** Bytes each project occupies on this phone — 0/absent means not downloaded. */
  const [usage, setUsage] = useState<Record<string, number>>({})
  /** The listing on screen is the stored one; the refresh behind it failed. */
  const [offline, setOffline] = useState(false)
  /** Bumping this token abandons any in-flight load (switch or cancel). */
  const token = useRef(0)

  const loadUsage = useCallback(async () => {
    const rows = await cacheUsage()
    const map: Record<string, number> = {}
    for (const r of rows) map[r.project] = r.bytes
    setUsage(map)
  }, [])

  const refresh = useCallback(
    async (force = false) => {
      try {
        setError(null)
        if (mode === 'gdrive') {
          setRoot({ kind: 'picked', path: 'gdrive', name: 'Google Drive' })
          const signed = await driveSignedIn()
          setDriveOn(signed)
          if (!signed) {
            setProjects([])
            return
          }
          setDriveEmail(await driveAccountEmail())
          // Last sync first, always: a cold start — and every start without
          // signal — lands on a usable library instead of a spinner, and the
          // refresh happens underneath it.
          const stored = await driveStoredProjects()
          if (stored?.length) setProjects(stored)
          // nothing stored: clear the previous mode's cards only when the list
          // will actually hit the network (coming back from a song serves the
          // in-memory cache and must not flash a spinner)
          else if (force || !driveListIsFresh()) setProjects(null)
          try {
            setProjects(await driveListProjects(force))
            setOffline(false)
          } catch (e) {
            // No signal is not an error when the phone already knows the
            // library — say so quietly rather than replacing a working
            // catalog with red text.
            if (!stored?.length) throw e
            setOffline(true)
          }
        } else {
          setRoot(await getRoot())
          setProjects(await listProjects())
        }
        void loadUsage()
      } catch (e) {
        setError(String(e instanceof Error ? e.message : e))
        setProjects([])
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
      const have = usage[entry.dir] ?? 0
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
            <Text style={{ color: 'rgba(255,255,255,0.75)', fontSize: 13, fontWeight: '700' }}>✕</Text>
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
            // A song counts as downloaded once its files are all here; a
            // half-finished fetch keeps the cloud mark and its remaining size.
            const have = usage[p.dir] ?? 0
            const downloaded = p.cached || (p.bytes > 0 && have + 1024 >= p.bytes)
            return card({
              key: p.dir,
              dir: p.dir,
              hue: Math.abs(p.dir.length * 7 + p.dir.charCodeAt(0)) % 3,
              title: p.doc.name ?? p.dir,
              meta: (
                <>
                  {Object.keys(p.stems).length} stems{p.hasLyrics ? ' · lyrics' : ''}
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
            const dirs = Object.keys(usage).filter((d) => usage[d] > 0)
            const total = dirs.reduce((n, d) => n + usage[d], 0)
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
      </View>
    </View>
  )
}

const s = StyleSheet.create({
  wrap: { flex: 1, paddingHorizontal: 20 },
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
  ctxWho: { color: 'rgba(255,255,255,0.6)', fontSize: 12.5, flexShrink: 1 },
  ctxDot: { color: 'rgba(255,255,255,0.3)', fontSize: 12.5 },
  ctxLink: { color: C.amber, fontSize: 12.5, fontWeight: '800' },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 12,
    backgroundColor: 'rgba(255,255,255,0.045)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.05)',
    borderRadius: 17,
    marginBottom: 11,
    overflow: 'hidden'
  },
  cardSample: {
    backgroundColor: 'transparent',
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: 'rgba(255,255,255,0.14)'
  },
  cardLoading: { backgroundColor: 'rgba(242,193,78,0.07)', borderColor: 'rgba(242,193,78,0.25)' },
  cardTitle: { color: C.bright, fontSize: 16.5, fontWeight: '800', letterSpacing: -0.2 },
  cardMeta: { color: 'rgba(255,255,255,0.42)', fontSize: 12.5, marginTop: 3 },
  status: { color: 'rgba(255,255,255,0.35)', fontSize: 12, fontWeight: '600' },
  statusHave: { color: 'rgba(255,255,255,0.62)' },
  storage: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
    marginTop: 6,
    paddingHorizontal: 2
  },
  storageText: { color: 'rgba(255,255,255,0.35)', fontSize: 12, flexShrink: 1 },
  cancelBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: 'rgba(255,255,255,0.10)',
    alignItems: 'center',
    justifyContent: 'center'
  },
  progressRail: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 3,
    backgroundColor: 'rgba(255,255,255,0.08)'
  },
  progressFill: { height: 3, backgroundColor: C.amber, borderTopRightRadius: 2, borderBottomRightRadius: 2 },
  empty: { color: 'rgba(255,255,255,0.35)', fontSize: 14, lineHeight: 20, marginVertical: 12 },
  err: { color: C.red, fontSize: 13, marginTop: 10 }
})

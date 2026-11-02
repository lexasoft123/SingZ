import React, { useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native'
import { useNavigation, usePreventRemove } from '@react-navigation/native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { TorrentFlow, type TorrentImport, type TorrentViewState } from '../../../src/shared/torrent'
import { torrentBackgroundHint, torrentRequest } from '../torrent'
import { C } from './bits'
const fmt = (n: number): string =>
  n >= 1e9
    ? (n / 1e9).toFixed(1) + ' GB'
    : n >= 1e6
    ? (n / 1e6).toFixed(1) + ' MB'
    : Math.max(0, Math.round(n / 1e3)) + ' KB'
export default function TorrentScreen({
  onClose,
  onImport
}: {
  onClose: () => void
  onImport: (file: TorrentImport) => void
}): React.JSX.Element {
  const insets = useSafeAreaInsets()
  const navigation = useNavigation()
  const consuming = useRef(false)
  const [importing, setImporting] = useState(false)
  const [imported, setImported] = useState<TorrentImport | null>(null)
  const onImportRef = useRef(onImport)
  onImportRef.current = onImport
  const importLocked = importing && imported === null
  usePreventRemove(importLocked, () => {})
  useEffect(() => {
    navigation.setOptions({ gestureEnabled: !importLocked })
  }, [navigation, importLocked])
  // Like AddSongSheet, unlock native removal before replacing the route.
  useEffect(() => {
    if (imported) onImportRef.current(imported)
  }, [imported])
  const ref = useRef<TorrentFlow | null>(null),
    mounted = useRef(false)
  const [state, setState] = useState<TorrentViewState | null>(null)
  const [query, setQuery] = useState(''),
    [filter, setFilter] = useState('')
  useEffect(() => {
    mounted.current = true
    const flow = new TorrentFlow(torrentRequest)
    ref.current = flow
    const off = flow.subscribe(() => setState(flow.state))
    setState(flow.state)
    void flow.initialize()
    return () => {
      mounted.current = false
      off()
      flow.dispose()
      ref.current = null
    }
  }, [])
  const flow = ref.current,
    job = state?.job,
    selected = state?.listing?.files.find(f => f.index === state.selected)
  const button = (
    label: string,
    action: () => void,
    primary = false,
    disabled = false
  ): React.JSX.Element => (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={action}
      style={[s.button, primary && s.primary, disabled && s.disabled]}
    >
      <Text style={[s.buttonText, primary && s.primaryText]}>{label}</Text>
    </Pressable>
  )
  const search = (): void => {
    if (!query.trim() || state?.busy) return
    Keyboard.dismiss()
    void flow?.search(query)
  }
  const importSong = async (): Promise<void> => {
    if (consuming.current) return
    consuming.current = true
    setImporting(true)
    const file = await ref.current?.consume()
    consuming.current = false
    if (!mounted.current) return
    if (file) setImported(file)
    else setImporting(false)
  }
  return (
    <View style={[s.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={s.nav}>
        {button(
          state?.view === 'files' ? '‹ Releases' : '‹ Library',
          () => {
            if (!consuming.current) state?.view === 'files' ? flow?.back() : onClose()
          },
          false,
          importLocked
        )}
        <Text style={s.navTitle}>Add song</Text>
        {button('Account', () => flow?.account(), false, !!state?.busy)}
      </View>
      <ScrollView
        contentContainerStyle={s.body}
        automaticallyAdjustKeyboardInsets
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        keyboardShouldPersistTaps="handled"
      >
        {state?.error && (
          <Text accessibilityRole="alert" style={s.error}>
            {state.error}
          </Text>
        )}
        {(!state || state.busy) && (
          <ActivityIndicator color={C.amber} accessibilityLabel="Working" />
        )}
        {state?.view === 'account' ? (
          <View style={s.section}>
            <Text style={s.eyebrow}>RuTracker account</Text>
            <Text style={s.title}>
              {state.connected ? 'Connected to RuTracker' : 'Bring your account'}
            </Text>
            <Text style={s.hint}>
              Sign in on the RuTracker website inside SingZ. Your password stays with the site.
            </Text>
            {button('Sign in to RuTracker', () => void flow?.connect(), true, state.busy)}
            {state.connected && (
              <>
                {button('Back to search', () => flow?.back(), false, state.busy)}
                {button('Sign out', () => void flow?.logout(), false, state.busy)}
              </>
            )}
          </View>
        ) : state?.view === 'download' ? (
          <View style={s.section}>
            {job ? (
              <>
                <Text style={s.eyebrow}>
                  {job.state === 'complete'
                    ? 'Song downloaded'
                    : job.state === 'paused'
                    ? 'Download paused'
                    : job.state === 'verifying'
                    ? 'Finishing the download'
                    : job.state === 'error'
                    ? 'Download needs attention'
                    : job.done === 0
                    ? 'Connecting to seeders'
                    : 'Downloading your song'}
                </Text>
                <Text style={s.title}>{job.name}</Text>
                <Text style={s.hint}>{fmt(job.size)} · One selected song</Text>
                <Text style={s.percent}>
                  {Math.min(100, Math.floor((job.done / job.size) * 100))}%
                </Text>
                <View
                  accessible
                  accessibilityRole="progressbar"
                  accessibilityValue={{
                    min: 0,
                    max: 100,
                    now: Math.floor((job.done / job.size) * 100)
                  }}
                  style={s.rail}
                >
                  <View
                    style={[
                      s.fill,
                      { width: (Math.min(100, (job.done / job.size) * 100) + '%') as `${number}%` }
                    ]}
                  />
                </View>
                <View style={s.stats}>
                  <Text style={s.hint}>
                    {fmt(job.done)} / {fmt(job.size)}
                  </Text>
                  <Text style={s.hint}>
                    {job.state === 'downloading' ? fmt(job.speed) + '/s' : job.state}
                  </Text>
                </View>
                {job.error ? <Text style={s.error}>{job.error}</Text> : null}
                <Text style={s.notice}>{torrentBackgroundHint}</Text>
                {job.state === 'complete'
                  ? button('Continue to Add song →', () => void importSong(), true, state.busy)
                  : button(
                      job.state === 'downloading' ? 'Pause download' : 'Resume download',
                      () => void flow?.control(job.state === 'downloading' ? 'pause' : 'resume'),
                      true,
                      state.busy || job.state === 'verifying'
                    )}
                {button('Cancel download', () => void flow?.control('cancel'), false, state.busy)}
              </>
            ) : (
              <Text style={s.hint}>No active download.</Text>
            )}
          </View>
        ) : state?.view === 'files' && state.listing ? (
          <View style={s.section}>
            <Text style={s.eyebrow}>Choose one song</Text>
            <Text style={s.title}>{state.listing.name}</Text>
            <Text style={s.hint}>
              {fmt(state.listing.total)} release · {state.release?.seeders ?? 0} seeders
            </Text>
            <TextInput
              accessibilityLabel="Find a song in this release"
              placeholder="Find a song in this release"
              placeholderTextColor={C.dim}
              value={filter}
              onChangeText={setFilter}
              autoCorrect={false}
              autoCapitalize="none"
              returnKeyType="done"
              onSubmitEditing={Keyboard.dismiss}
              style={s.input}
            />
            {state.listing.files
              .filter(file =>
                (file.path + ' ' + file.name)
                  .toLocaleLowerCase()
                  .includes(filter.toLocaleLowerCase())
              )
              .map(file => (
                <Pressable
                  key={file.index}
                  accessibilityRole="radio"
                  accessibilityState={{
                    checked: state.selected === file.index,
                    disabled: state.busy
                  }}
                  disabled={state.busy}
                  onPress={() => {
                    Keyboard.dismiss()
                    flow?.select(file.index)
                  }}
                  style={s.file}
                >
                  <Text style={[s.radio, state.selected === file.index && s.selected]}>
                    {state.selected === file.index ? '◉' : '○'}
                  </Text>
                  <View style={s.grow}>
                    <Text style={[s.fileName, state.selected === file.index && s.selected]}>
                      {file.name}
                    </Text>
                    <Text style={s.path}>{file.path}</Text>
                  </View>
                  <Text style={s.size}>{fmt(file.size)}</Text>
                </Pressable>
              ))}
            <View style={s.stats}>
              <Text style={s.hint}>{selected ? '1 song selected' : 'Select one audio file'}</Text>
              <Text style={s.fileName}>{selected ? fmt(selected.size) : '—'}</Text>
            </View>
            <Text style={s.hint}>The rest of the release stays unselected.</Text>
            {button(
              'Download song' + (selected ? ' · ' + fmt(selected.size) : ''),
              () => void flow?.download(),
              true,
              state.busy || !selected
            )}
          </View>
        ) : state ? (
          <View style={s.section}>
            <Text style={s.eyebrow}>Add song / RuTracker</Text>
            <Text style={s.title}>Find your next song</Text>
            <Text style={s.hint}>Search release titles by artist, album, or song.</Text>
            <Text style={s.hint}>
              To find a song inside an album or discography, search the artist, open a release, then
              filter its filenames.
            </Text>
            <TextInput
              accessibilityLabel="Artist or song title"
              placeholder="Artist or song title"
              placeholderTextColor={C.dim}
              value={query}
              onChangeText={setQuery}
              autoCorrect={false}
              autoCapitalize="none"
              onSubmitEditing={search}
              returnKeyType="search"
              maxLength={200}
              style={s.input}
            />
            {button('Search', search, true, state.busy || !query.trim())}
            <View style={s.stats}>
              <Text style={s.hint}>{state.releases.length} releases</Text>
              <Text style={s.sort}>↓ Most seeders first</Text>
            </View>
            {state.releases.map(release => (
              <Pressable
                key={release.id}
                accessibilityRole="button"
                disabled={state.busy}
                onPress={() => {
                  Keyboard.dismiss()
                  setFilter('')
                  void flow?.choose(release)
                }}
                style={s.release}
              >
                <View style={s.grow}>
                  <Text style={s.fileName}>{release.title}</Text>
                  <Text style={s.path}>
                    {release.size ? fmt(release.size) : 'Size listed in the torrent'}
                  </Text>
                </View>
                <View>
                  <Text style={s.seeders}>{release.seeders}</Text>
                  <Text style={s.size}>seeders</Text>
                </View>
              </Pressable>
            ))}
            {!state.busy && state.query && state.releases.length === 0 && (
              <Text style={s.hint}>No releases found. Try an artist or album title.</Text>
            )}
            {state.hasMore &&
              button(
                'More releases',
                () => void flow?.search(state.query, true),
                false,
                state.busy
              )}
          </View>
        ) : null}
      </ScrollView>
    </View>
  )
}
const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  nav: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8
  },
  navTitle: { color: C.text, fontSize: 15, fontWeight: '600' },
  body: { padding: 20, paddingBottom: 30 },
  section: { gap: 12 },
  eyebrow: { fontSize: 11, letterSpacing: 1.2, textTransform: 'uppercase', color: C.dim },
  title: { color: C.text, fontSize: 26, fontWeight: '700', letterSpacing: -0.7 },
  hint: { fontSize: 13, color: C.dim, lineHeight: 19 },
  input: {
    borderWidth: 1,
    borderColor: C.hairline,
    borderRadius: 11,
    color: C.text,
    fontSize: 16,
    padding: 13,
    marginVertical: 5
  },
  button: {
    minHeight: 44,
    paddingHorizontal: 14,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10
  },
  buttonText: { color: C.amber, fontSize: 14, fontWeight: '500' },
  primary: { backgroundColor: C.amber },
  primaryText: { color: C.amberInk, fontWeight: '700' },
  disabled: { opacity: 0.4 },
  error: { color: C.red, fontSize: 13, lineHeight: 19, paddingVertical: 10 },
  release: {
    flexDirection: 'row',
    gap: 13,
    alignItems: 'center',
    paddingVertical: 16,
    borderTopWidth: 1,
    borderTopColor: C.hairline
  },
  grow: { flex: 1, minWidth: 0 },
  fileName: { fontSize: 14, color: C.text, fontWeight: '500' },
  path: { fontSize: 11, color: C.dim, marginTop: 5 },
  size: { fontSize: 11, color: C.dim },
  seeders: { fontSize: 22, color: C.amber, textAlign: 'right', fontVariant: ['tabular-nums'] },
  stats: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 10,
    alignItems: 'center',
    marginTop: 18
  },
  sort: { fontSize: 12, color: C.amber },
  file: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: C.hairline,
    paddingVertical: 15
  },
  radio: { fontSize: 20, color: C.dim },
  selected: { color: C.amber },
  percent: {
    fontSize: 42,
    color: C.text,
    fontWeight: '500',
    marginTop: 25,
    fontVariant: ['tabular-nums']
  },
  rail: { height: 6, backgroundColor: C.btnBg, borderRadius: 4, overflow: 'hidden' },
  fill: { height: 6, backgroundColor: C.amber },
  notice: {
    fontSize: 13,
    lineHeight: 19,
    color: C.dim,
    backgroundColor: C.sheet,
    padding: 14,
    borderRadius: 10,
    marginVertical: 18
  }
})

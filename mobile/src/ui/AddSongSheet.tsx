import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Dimensions,
  Keyboard,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native'
import {
  addSong,
  findLyrics,
  lyricsCandidates,
  lyricsForCandidate,
  readSongFacts,
  type SongFacts
} from '../addflow'
import type { LyricsCandidate } from '../lyrics/lrclib'
import { log } from '../log'
import type { LyricLine } from '../model'
import { clearCache } from '../projects'
import type { PickedFile } from '../writer'
import { C } from './bits'

/**
 * The add-a-song flow (Phase 1): pick → read the file → confirm title/artist
 * → find synced lyrics → create the project. Steps live in ../addflow.ts,
 * shared with the headless __test driver; this sheet only walks them.
 * Cancelling sweeps imports/ so an abandoned pick cannot strand a full-size
 * copy in durable storage.
 */

type Step =
  | { k: 'reading' }
  | { k: 'meta'; facts: SongFacts }
  | { k: 'searching'; facts: SongFacts }
  | {
      k: 'lyrics'
      facts: SongFacts
      hit: { lines: LyricLine[]; credit?: string } | null
      down: boolean
      candidates: LyricsCandidate[] | null
    }
  | { k: 'creating' }

export default function AddSongSheet({
  visible,
  src,
  sampleRate,
  onShown,
  onStep,
  onClose
}: {
  visible: boolean
  /** The already-picked file. The CALLER picks, before this sheet exists:
   *  iOS presents one view controller at a time, and a sheet that opened its
   *  own picker raced its own presentation and lost it — the flow then ran
   *  invisibly to the end. */
  src: PickedFile | null
  sampleRate: number
  /** Fired when the sheet is REALLY on screen (Modal onShow — iOS calls it
   *  after the presentation completes, so it is the one signal that tells a
   *  refused presentation from a working one; JS state cannot). */
  onShown?: () => void
  /** Which card is up, for drivers (reading → meta → searching → lyrics), and
   *  the duration the read produced — 0 on the card that reports a file this
   *  phone cannot open, which wears the same 'meta' name. */
  onStep?: (step: string, seconds: number) => void
  /** dir of the created project, or null when the flow was abandoned. */
  onClose: (addedDir: string | null) => void
}): React.JSX.Element {
  /**
   * How much of the screen the keyboard is eating.
   *
   * The sheet is bottom-anchored, so a raised keyboard sits ON it: iOS covered
   * the fields and every button, Android pushed the whole sheet off-screen with
   * nothing left but the catalog behind it. Either way the singer could neither
   * see what they typed nor reach an action.
   *
   * Measured rather than delegated to KeyboardAvoidingView: a Modal gets its
   * own window, which does not honour the activity's adjustResize, and KAV's
   * `height` behaviour computed no adjustment at all there (verified on an
   * API 36 emulator — the sheet stayed off-screen). The height the keyboard
   * itself reports needs no window to cooperate, and is the same on both.
   */
  const [kbInset, setKbInset] = useState(0)
  /** The scrim's own laid-out height — see `pad` below. */
  const [scrimH, setScrimH] = useState(0)
  useEffect(() => {
    // iOS gets the will- pair so the sheet travels with the keyboard rather
    // than jumping after it; Android only ever fires the did- pair.
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillChangeFrame' : 'keyboardDidShow'
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide'
    const onShow = Keyboard.addListener(showEvt, (e) =>
      setKbInset(Math.max(0, e?.endCoordinates?.height ?? 0))
    )
    const onHide = Keyboard.addListener(hideEvt, () => setKbInset(0))
    return () => {
      onShow.remove()
      onHide.remove()
    }
  }, [])

  const [step, setStep] = useState<Step>({ k: 'reading' })
  const stepRef = useRef<Step['k']>('reading')
  stepRef.current = step.k
  const onStepRef = useRef(onStep)
  onStepRef.current = onStep
  useEffect(() => {
    onStepRef.current?.(step.k, 'facts' in step ? step.facts.durationSec : 0)
    // step.k alone: the same card with new facts is not a new step
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step.k])
  const [title, setTitle] = useState('')
  const [artist, setArtist] = useState('')
  const [error, setError] = useState<string | null>(null)
  /** The sheet outlives taps; a stale async step must not repaint it. */
  const seq = useRef(0)
  /** The parent hands a fresh onClose every render; the pick effect must not
   *  re-run on that (a re-run mid-pick rejects "busy" and drops the user's
   *  actual pick into a stale seq). */
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  const abandon = useCallback(
    (msg?: string) => {
      // A create in flight owns the import copy and the fresh folder —
      // sweeping under it strands a doc-less project. The button is hidden
      // then too; this guard covers the hardware back path.
      if (stepRef.current === 'creating') return
      seq.current++
      setError(null)
      // the import copy is durable storage — an abandoned add must not keep it
      void clearCache('imports').catch(() => {})
      if (msg) log('song', `add-song flow abandoned — ${msg}`)
      onCloseRef.current(null)
    },
    []
  )

  // The sheet opens on a file the parent already picked. Depends on
  // [visible] alone — parent re-renders must not re-run the read.
  useEffect(() => {
    if (!visible) return
    // No file, no flow — a sheet opened without one would sit on the reading
    // spinner forever, which is the very failure this rewrite removes.
    if (!src) {
      log('song', 'add-song sheet: opened with no file — closing', 'warn')
      onCloseRef.current(null)
      return
    }
    const my = ++seq.current
    setStep({ k: 'reading' })
    setError(null)
    void (async () => {
      try {
        // Every step writes itself down BEFORE it runs: a Release build has
        // no inspector, and a sheet stuck on a spinner with an empty log is
        // exactly the report this line count exists to answer (the first
        // real-phone freeze arrived with only the version line on record).
        log('song', `add-song sheet: reading ${src.name}`)
        const facts = await readSongFacts(src.path, src.name, sampleRate)
        if (my !== seq.current) return
        log('song', `add-song sheet: read ${facts.durationSec.toFixed(0)}s — "${facts.title}"`)
        setTitle(facts.title)
        setArtist(facts.artist ?? '')
        setStep({ k: 'meta', facts })
      } catch (e) {
        if (my !== seq.current) return
        const msg = String(e instanceof Error ? e.message : e)
        log('song', `add-song: the picked file did not open — ${msg}`, 'error')
        // The decoder's own words ("MiniAudioDecoder::openFile failed:
        // Resource does not exist (-7)") were being handed to the singer.
        // They go in the log, which is one line above and is where a report
        // comes from; the card says what it means for the song.
        setError("This file can't be played on this phone — it may be a format SingZ doesn't read. The Log has the details.")
        setTitle('')
        setArtist('')
        setStep({ k: 'meta', facts: { durationSec: 0, title: '' } })
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible])

  const search = useCallback(
    async (facts: SongFacts) => {
      const my = ++seq.current
      setStep({ k: 'searching', facts })
      const meta = {
        title: title.trim() || facts.title,
        artist: artist.trim() || undefined,
        altTitle: facts.altTitle,
        durationSec: facts.durationSec
      }
      log('song', `add-song sheet: searching lyrics for "${meta.title}"`)
      const outcome = await findLyrics(meta)
      if (my !== seq.current) return
      log('song', `add-song sheet: lyrics ${typeof outcome === 'object' ? 'found' : outcome}`)
      if (typeof outcome === 'object') {
        setStep({ k: 'lyrics', facts, hit: outcome.hit, down: false, candidates: null })
        return
      }
      if (outcome === 'down') {
        setStep({ k: 'lyrics', facts, hit: null, down: true, candidates: null })
        return
      }
      // miss: offer the variant picker instead of a dead end
      const candidates = await lyricsCandidates(
        { title: meta.title, artist: meta.artist },
        facts.durationSec
      )
      if (my !== seq.current) return
      setStep({ k: 'lyrics', facts, hit: null, down: false, candidates })
    },
    [artist, title]
  )

  const create = useCallback(
    async (facts: SongFacts, lyrics: { lines: LyricLine[]; credit?: string } | null) => {
      // An undecodable pick must fail before a project folder exists — every
      // card routes here, so the guard lives here, not per button.
      if (!src || facts.durationSec <= 0) return
      const my = ++seq.current
      setStep({ k: 'creating' })
      try {
        log('song', `add-song sheet: creating "${title.trim() || facts.title}"`)
        const { dir } = await addSong({
          srcPath: src.path,
          fileName: src.name,
          title: title.trim() || facts.title || src.name,
          durationSec: facts.durationSec,
          lyrics
        })
        if (my !== seq.current) return
        onCloseRef.current(dir)
      } catch (e) {
        if (my !== seq.current) return
        setError(String(e instanceof Error ? e.message : e))
        setStep({ k: 'meta', facts })
      }
    },
    [src, title]
  )

  const pickCandidate = useCallback(
    async (facts: SongFacts, c: LyricsCandidate) => {
      const my = ++seq.current
      setStep({ k: 'searching', facts })
      const got = await lyricsForCandidate(c.id, facts.durationSec)
      if (my !== seq.current) return
      if (got) setStep({ k: 'lyrics', facts, hit: got, down: false, candidates: null })
      else setStep({ k: 'lyrics', facts, hit: null, down: true, candidates: null })
    },
    []
  )

  const screenH = Dimensions.get('screen').height
  const absorbedByWindow = kbInset > 0 && scrimH > 0 && scrimH < screenH - kbInset * 0.5

  const body = (): React.JSX.Element => {
    switch (step.k) {
      case 'reading':
        return (
          <View style={s.center}>
            <ActivityIndicator color={C.amber} />
            <Text style={s.dimText}>Reading the song…</Text>
          </View>
        )
      case 'creating':
        return (
          <View style={s.center}>
            <ActivityIndicator color={C.amber} />
            <Text style={s.dimText}>Adding it to this phone…</Text>
          </View>
        )
      case 'meta':
      case 'searching': {
        const busy = step.k === 'searching'
        // durationSec 0 IS the "this file did not open" card (the catch above
        // lands here with the error text). Both buttons are dead then — they
        // were dead at full opacity, and Find lyrics walked the singer to a
        // second card whose buttons were also dead. Nothing to do but close.
        const unreadable = step.facts.durationSec <= 0
        // Nothing on this card can lead anywhere: the file did not open, so
        // there is no song to name and no lyrics to look for. It used to show
        // the title and artist fields plus two dead buttons beside the live
        // one — an invitation to type a name for a song that cannot be added.
        // The red line above already says what happened; this just gets out.
        if (unreadable) {
          return (
            <View style={s.row}>
              {/* It closes the sheet — "Add a song" is right there to try
                  again, and promising a picker this button does not open is
                  the kind of small lie that erodes the rest. */}
              <Pressable accessibilityRole="button" style={[s.btn, s.btnPrimary]} onPress={() => abandon('unreadable')}>
                <Text style={s.btnPrimaryText}>Close</Text>
              </Pressable>
            </View>
          )
        }
        return (
          <View>
            <Text style={s.label}>Title</Text>
            <TextInput
              style={s.input}
              value={title}
              onChangeText={setTitle}
              placeholder="Song title"
              placeholderTextColor={C.dim}
              editable={!busy}
            />
            <Text style={s.label}>Artist</Text>
            <TextInput
              style={s.input}
              value={artist}
              onChangeText={setArtist}
              placeholder="Helps find the right lyrics"
              placeholderTextColor={C.dim}
              editable={!busy}
            />
            {step.facts.durationSec > 0 && (
              <Text style={s.dimText}>
                {Math.floor(step.facts.durationSec / 60)}:
                {String(Math.round(step.facts.durationSec % 60)).padStart(2, '0')} —{' '}
                {src?.name ?? ''}
              </Text>
            )}
            <View style={s.row}>
              <Pressable
                accessibilityRole="button"
                // An empty title disabled this button while it kept full amber
                // weight — it looked live and did nothing. The dim now tracks
                // the same condition the disable does.
                style={[s.btn, s.btnPrimary, (busy || !title.trim()) && s.btnDim]}
                disabled={busy || !title.trim()}
                onPress={() => void search(step.facts)}
              >
                {busy ? (
                  <ActivityIndicator color="#1d1204" />
                ) : (
                  <Text style={s.btnPrimaryText}>Find lyrics</Text>
                )}
              </Pressable>
              <Pressable
                accessibilityRole="button"
                style={[s.btn, busy && s.btnDim]}
                disabled={busy}
                onPress={() => void create(step.facts, null)}
              >
                <Text style={s.btnText}>Add without lyrics</Text>
              </Pressable>
            </View>
          </View>
        )
      }
      case 'lyrics': {
        const { facts, hit, down, candidates } = step
        if (hit) {
          return (
            <View>
              <Text style={s.credit}>{hit.credit ?? 'Synced lyrics found'}</Text>
              <ScrollView style={s.preview}>
                {hit.lines.slice(0, 6).map((l, i) => (
                  <Text key={i} style={s.previewLine}>
                    {l.text}
                  </Text>
                ))}
                {hit.lines.length > 6 && <Text style={s.dimText}>…{hit.lines.length} lines</Text>}
              </ScrollView>
              <View style={s.row}>
                <Pressable accessibilityRole="button" style={[s.btn, s.btnPrimary]} onPress={() => void create(facts, hit)}>
                  <Text style={s.btnPrimaryText}>Use these lyrics</Text>
                </Pressable>
                <Pressable accessibilityRole="button" style={s.btn} onPress={() => void create(facts, null)}>
                  <Text style={s.btnText}>Skip</Text>
                </Pressable>
              </View>
            </View>
          )
        }
        if (down) {
          return (
            <View>
              <Text style={s.dimText}>
                The lyrics service didn't answer — the song still adds fine, and lyrics can be
                found later from its card.
              </Text>
              <View style={s.row}>
                <Pressable accessibilityRole="button" style={[s.btn, s.btnPrimary]} onPress={() => void create(facts, null)}>
                  <Text style={s.btnPrimaryText}>Add without lyrics</Text>
                </Pressable>
              </View>
            </View>
          )
        }
        return (
          <View>
            <Text style={s.dimText}>
              No exact match. {candidates && candidates.length > 0 ? 'Close matches:' : ''}
            </Text>
            {candidates && candidates.length > 0 && (
              <ScrollView style={s.preview}>
                {candidates.slice(0, 8).map((c) => (
                  <Pressable accessibilityRole="button" key={c.id} style={s.cand} onPress={() => void pickCandidate(facts, c)}>
                    <Text style={s.candText} numberOfLines={1}>
                      {c.artist ? `${c.artist} — ` : ''}
                      {c.track}
                    </Text>
                    <Text style={s.candMeta}>
                      {Math.floor(c.duration / 60)}:{String(Math.round(c.duration % 60)).padStart(2, '0')}
                      {c.synced ? ' · synced' : ' · text only'}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            )}
            <View style={s.row}>
              <Pressable accessibilityRole="button" style={[s.btn, s.btnPrimary]} onPress={() => void create(facts, null)}>
                <Text style={s.btnPrimaryText}>Add without lyrics</Text>
              </Pressable>
              <Pressable accessibilityRole="button" style={s.btn} onPress={() => void search(facts)}>
                <Text style={s.btnText}>Search again</Text>
              </Pressable>
            </View>
          </View>
        )
      }
    }
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onShow={() => {
        log('song', 'add-song sheet: on screen')
        onShown?.()
      }}
      onRequestClose={() => abandon('back')}
    >
      {/* RN puts SOFT_INPUT_ADJUST_RESIZE on the Modal's own window, so on
          Android 14 and below that window ALREADY ends above the keyboard and
          padding it again would lift the sheet a second full keyboard height.
          On 15+ targetSdk 36 forces edge-to-edge and the resize does nothing,
          which is the case measured here. Rather than sniff the version, ask
          the layout: a scrim already shorter than the screen by about the
          keyboard means the window absorbed it. iOS never resizes, so this is
          always false there. */}
      <View
        style={[s.scrim, { paddingBottom: absorbedByWindow ? 0 : kbInset }]}
        onLayout={(e) => setScrimH(Math.round(e.nativeEvent.layout.height))}
      >
        <View style={s.sheet}>
          <View style={s.head}>
            <Text style={s.title}>Add a song</Text>
            {step.k !== 'creating' && (
              <Pressable
                hitSlop={10}
                onPress={() => abandon('closed')}
                accessibilityRole="button"
                accessibilityLabel="Cancel adding this song"
              >
                <Text style={s.close}>Cancel</Text>
              </Pressable>
            )}
          </View>
          {/* With the keyboard up the sheet can be taller than what is left of
              the screen; let it scroll rather than clip its own buttons.
              keyboardShouldPersistTaps keeps the first tap on a button from
              being eaten by the keyboard dismiss. */}
          <ScrollView
            bounces={false}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ paddingBottom: 4 }}
          >
            {error && <Text style={s.err}>{error}</Text>}
            {body()}
          </ScrollView>
        </View>
      </View>
    </Modal>
  )
}

const s = StyleSheet.create({
  scrim: { flex: 1, justifyContent: 'flex-end', backgroundColor: '#000000aa' },
  sheet: {
    // Lets the sheet shrink inside the keyboard avoider, which is what gives
    // the ScrollView above a bounded height — an unbounded one measures its
    // own content, decides everything fits, and silently never scrolls.
    flexShrink: 1,
    backgroundColor: C.bg,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: 20,
    paddingBottom: 34
  },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
  title: { color: C.text, fontSize: 20, fontWeight: '700' },
  close: { color: C.amber, fontSize: 15 },
  center: { alignItems: 'center', paddingVertical: 28, gap: 10 },
  label: { color: C.dim, fontSize: 12, marginBottom: 4, marginTop: 8 },
  input: {
    color: C.text,
    fontSize: 16,
    backgroundColor: '#ffffff10',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10
  },
  dimText: { color: C.dim, fontSize: 13, marginTop: 10 },
  // Three buttons already span the full width of a 402 pt phone with nothing
  // to spare; a narrower one (SE) pushed the last one off. Let them wrap.
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 16 },
  btn: {
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 11,
    backgroundColor: '#ffffff14'
  },
  btnPrimary: { backgroundColor: C.amber },
  btnPrimaryText: { color: '#1d1204', fontWeight: '700', fontSize: 15 },
  btnText: { color: C.text, fontSize: 15 },
  btnDim: { opacity: 0.5 },
  err: { color: '#ff8a80', fontSize: 13, marginBottom: 8 },
  credit: { color: C.text, fontSize: 15, fontWeight: '600' },
  preview: { maxHeight: 180, marginTop: 10 },
  previewLine: { color: C.dim, fontSize: 13, lineHeight: 19 },
  cand: { paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#ffffff14' },
  candText: { color: C.text, fontSize: 14 },
  candMeta: { color: C.dim, fontSize: 12 }
})

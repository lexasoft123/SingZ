import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Modal,
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
import { pickAudioFile } from '../writer'
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
  sampleRate,
  onClose
}: {
  visible: boolean
  sampleRate: number
  /** dir of the created project, or null when the flow was abandoned. */
  onClose: (addedDir: string | null) => void
}): React.JSX.Element {
  const [src, setSrc] = useState<{ path: string; name: string } | null>(null)
  const [step, setStep] = useState<Step>({ k: 'reading' })
  const stepRef = useRef<Step['k']>('reading')
  stepRef.current = step.k
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
      setSrc(null)
      setError(null)
      // the import copy is durable storage — an abandoned add must not keep it
      void clearCache('imports').catch(() => {})
      if (msg) log('song', `add-song flow abandoned — ${msg}`)
      onCloseRef.current(null)
    },
    []
  )

  // Opening the sheet IS picking a file: no file, no flow. Depends on
  // [visible] alone — parent re-renders while the system picker is up must
  // not re-run this (the second pickAudioFile would reject "busy" and the
  // real pick would land in a stale seq).
  useEffect(() => {
    if (!visible) return
    const my = ++seq.current
    setSrc(null)
    setStep({ k: 'reading' })
    setError(null)
    void (async () => {
      try {
        const picked = await pickAudioFile()
        if (my !== seq.current) return
        if (!picked) {
          onCloseRef.current(null)
          return
        }
        setSrc(picked)
        const facts = await readSongFacts(picked.path, picked.name, sampleRate)
        if (my !== seq.current) return
        setTitle(facts.title)
        setArtist(facts.artist ?? '')
        setStep({ k: 'meta', facts })
      } catch (e) {
        if (my !== seq.current) return
        const msg = String(e instanceof Error ? e.message : e)
        log('song', `add-song: the picked file did not open — ${msg}`, 'error')
        setError(`This file can't be played on this phone (${msg})`)
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
      const outcome = await findLyrics(meta)
      if (my !== seq.current) return
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
        const { dir } = await addSong({
          srcPath: src.path,
          fileName: src.name,
          title: title.trim() || facts.title || src.name,
          durationSec: facts.durationSec,
          lyrics
        })
        if (my !== seq.current) return
        setSrc(null)
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
                style={[s.btn, s.btnPrimary, busy && s.btnDim]}
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
                style={[s.btn, busy && s.btnDim]}
                disabled={busy || step.facts.durationSec <= 0}
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
                <Pressable style={[s.btn, s.btnPrimary]} onPress={() => void create(facts, hit)}>
                  <Text style={s.btnPrimaryText}>Use these lyrics</Text>
                </Pressable>
                <Pressable style={s.btn} onPress={() => void create(facts, null)}>
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
                <Pressable style={[s.btn, s.btnPrimary]} onPress={() => void create(facts, null)}>
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
                  <Pressable key={c.id} style={s.cand} onPress={() => void pickCandidate(facts, c)}>
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
              <Pressable style={[s.btn, s.btnPrimary]} onPress={() => void create(facts, null)}>
                <Text style={s.btnPrimaryText}>Add without lyrics</Text>
              </Pressable>
              <Pressable style={s.btn} onPress={() => void search(facts)}>
                <Text style={s.btnText}>Search again</Text>
              </Pressable>
            </View>
          </View>
        )
      }
    }
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={() => abandon('back')}>
      <View style={s.scrim}>
        <View style={s.sheet}>
          <View style={s.head}>
            <Text style={s.title}>Add a song</Text>
            {step.k !== 'creating' && (
              <Pressable hitSlop={10} onPress={() => abandon('closed')}>
                <Text style={s.close}>Cancel</Text>
              </Pressable>
            )}
          </View>
          {error && <Text style={s.err}>{error}</Text>}
          {body()}
        </View>
      </View>
    </Modal>
  )
}

const s = StyleSheet.create({
  scrim: { flex: 1, justifyContent: 'flex-end', backgroundColor: '#000000aa' },
  sheet: {
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
  row: { flexDirection: 'row', gap: 10, marginTop: 16 },
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

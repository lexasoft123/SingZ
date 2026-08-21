/**
 * The analysis pipeline's rules, off-device: what gets (re)detected, how
 * results merge into the doc on disk, and what happens when the world moves
 * under the run. The host is a fake that returns canned detections; the real
 * detectors are proven bit-perfect elsewhere (Phase 0, mobile/tests).
 */
import {
  BEAT_DETECT_VERSION,
  KEY_DETECT_VERSION,
  PITCH_DETECT_VERSION,
  encodeMelody
} from '../src/gen/analysis-lib'
import {
  analyzeProject,
  mergeAnalysis,
  planAnalysis,
  type AnalysisDeps,
  type AnalysisHost
} from '../src/analysis/pipeline'
import type { ProjectDoc } from '../src/model'

const SIX = { drums: 'wav', bass: 'wav', other: 'wav', vocals: 'wav', guitar: 'wav', piano: 'wav' }

const doc = (settings: Partial<ProjectDoc['settings']> = {}, hashes?: ProjectDoc['stemHashes']): ProjectDoc => ({
  version: 1,
  name: 'T',
  songFile: 'song.mp3',
  savedAt: '2026-08-14T00:00:00.000Z',
  settings: { transpose: 0, tracks: {}, ...settings },
  stemHashes: hashes ?? Object.fromEntries(Object.keys(SIX).map((s) => [`${s}.wav`, { md5: 'h-' + s, size: 100, mtimeMs: 1 }]))
})

/** A melody line covering `sec` seconds, encoded the way the desktop stores it. */
const melodyFor = (sec: number, detVersion = PITCH_DETECT_VERSION) => {
  const hop = 0.025
  const f0 = new Float32Array(Math.round(sec / hop)).fill(220)
  return { ...encodeMelody(f0, hop), detVersion }
}

const autoGrid = (detVersion = BEAT_DETECT_VERSION) => ({
  beats: [0.5, 1, 1.5, 2],
  bpm: 120,
  beatsPerBar: 4,
  downbeat: 0,
  source: 'auto' as const,
  detVersion
})

describe('planAnalysis — the desktop triggers', () => {
  test('a fresh six-stem project wants everything', () => {
    expect(planAnalysis(doc(), SIX, 200)).toEqual({ beat: true, key: true, melody: true, compact: true })
  })
  test('current stamps want nothing', () => {
    const d = doc({ beat: autoGrid(), key: { pc: 0, minor: false, detVersion: KEY_DETECT_VERSION }, melody: melodyFor(200) })
    expect(planAnalysis(d, SIX, 200)).toEqual({ beat: false, key: false, melody: false, compact: true })
  })
  test('an older auto grid re-detects; a manual grid never does', () => {
    expect(planAnalysis(doc({ beat: autoGrid(BEAT_DETECT_VERSION - 1) }), SIX, 200).beat).toBe(true)
    expect(planAnalysis(doc({ beat: { ...autoGrid(1), source: 'manual' } }), SIX, 200).beat).toBe(false)
  })
  // `force` is the "detect again" button: the stamps say nothing needs doing,
  // which is exactly why it was pressed. Each case below is one of the three
  // decisions it is allowed to invert — and the fourth is the one it is NOT.
  test('force overrides a current stamp, a fitting melody and a stored verdict', () => {
    const current = doc({
      beat: autoGrid(),
      key: { pc: 0, minor: false, detVersion: KEY_DETECT_VERSION },
      melody: melodyFor(200)
    })
    expect(planAnalysis(current, SIX, 200)).toEqual({ beat: false, key: false, melody: false, compact: true })
    expect(planAnalysis(current, SIX, 200, false, true)).toEqual({ beat: true, key: true, melody: true, compact: true })

    // A negative verdict binds without force and is re-asked with it.
    const verdict = doc({})
    verdict.settings = { ...verdict.settings, analysisNone: { beat: BEAT_DETECT_VERSION, beatMl: true } }
    expect(planAnalysis(verdict, SIX, 200).beat).toBe(false)
    expect(planAnalysis(verdict, SIX, 200, false, true).beat).toBe(true)
  })
  test('force does NOT re-detect a hand-made grid — the phone has no editor to rebuild one', () => {
    const manual = doc({ beat: { ...autoGrid(1), source: 'manual' } })
    expect(planAnalysis(manual, SIX, 200, false, true).beat).toBe(false)
    // …and it still forces the detectors that have nothing hand-made to lose.
    expect(planAnalysis(manual, SIX, 200, false, true).key).toBe(true)
  })
  test('force cannot conjure a detector the stems do not support', () => {
    const { drums: _d, vocals: _v, ...noDrumsNoVox } = SIX
    expect(planAnalysis(doc({}), noDrumsNoVox, 200, false, true)).toEqual({
      beat: false,
      key: true,
      melody: false,
      compact: true
    })
  })
  test('no drums, no grid — even with nothing stored', () => {
    const { drums: _d, ...noDrums } = SIX
    expect(planAnalysis(doc(), noDrums, 200).beat).toBe(false)
  })
  test('a melody of another song\'s length is disowned; the right length is kept', () => {
    expect(planAnalysis(doc({ melody: melodyFor(120) }), SIX, 200).melody).toBe(true)
    expect(planAnalysis(doc({ melody: melodyFor(200) }), SIX, 200).melody).toBe(false)
    expect(planAnalysis(doc({ melody: melodyFor(200, PITCH_DETECT_VERSION - 1) }), SIX, 200).melody).toBe(true)
  })
  test('key: needs harmonic stems, re-reads under a new stamp', () => {
    expect(planAnalysis(doc({ key: { pc: 2, minor: true, detVersion: KEY_DETECT_VERSION - 1 } }), SIX, 200).key).toBe(true)
    expect(planAnalysis(doc(), { drums: 'wav', vocals: 'wav' }, 200).key).toBe(false)
  })
})

describe('mergeAnalysis — the keep-rule', () => {
  test('only the analysis fields move; the rest is what the disk says', () => {
    const onDisk = doc({ transpose: -2, beat: autoGrid(3), metronome: { click: true, countInBars: 1, volume: 0.5, accent: true } })
    const out = mergeAnalysis(onDisk, { key: { pc: 7, minor: false, detVersion: KEY_DETECT_VERSION } }, 'NOW')
    expect(out.savedAt).toBe('NOW')
    expect(out.settings.transpose).toBe(-2)
    expect(out.settings.beat).toEqual(autoGrid(3)) // absent result never deletes
    expect(out.settings.metronome?.countInBars).toBe(1)
    expect(out.settings.key).toEqual({ pc: 7, minor: false, detVersion: KEY_DETECT_VERSION })
    expect(out.stemHashes).toEqual(onDisk.stemHashes)
  })
})

interface World {
  disk: Map<string, string>
  writes: string[]
  puts: string[]
  tracked: string[]
  keyStems: string[]
  mlAsks: string[][]
  cleared: number
  detectArgs: unknown[]
  deps: AnalysisDeps
  compacts: string[]
}

function world(initial: ProjectDoc, hostOverrides: Partial<AnalysisHost> = {}): World {
  const w: World = { disk: new Map(), writes: [], puts: [], tracked: [], keyStems: [], mlAsks: [], cleared: 0, detectArgs: [], compacts: [], deps: null as unknown as AnalysisDeps }
  w.disk.set('project.json', JSON.stringify(initial))
  const host: AnalysisHost = {
    putStem: async (id) => {
      w.puts.push(id)
    },
    clearStems: async () => {
      w.cleared++
    },
    // No models by default — the packless-desktop condition every existing
    // test was written under.
    mlAvailable: async () => false,
    mlGrid: async (_project, rels) => {
      w.mlAsks.push(rels)
      return null
    },
    detectBeats: async (_project, args) => {
      w.detectArgs.push(args)
      return { beats: [0.5, 1, 1.5, 2, 2.5], bpm: 120, beatsPerBar: 4, downbeat: 0, downbeats: [0, 4] }
    },
    estimateKeyFromStems: async (_project, instRel, bassRel) => {
      w.keyStems.push([...instRel, ...(bassRel ? [bassRel] : [])].join(','))
      return { pc: 9, minor: true }
    },
    trackMelody: async (_project, rel, onProgress) => {
      w.tracked.push(rel)
      onProgress?.(0.5)
      return { f0: new Float32Array(8000).fill(220), hopSec: 0.025, durationSec: 200 }
    },
    audioDuration: async () => 200,
    encodeMelody: async (f0, hop) => encodeMelody(f0, hop),
    applyUserBars: async (info) => ({ ...info, downbeats: [1, 5] }),
    ...hostOverrides
  }
  w.deps = {
    readText: async (_p, file) => {
      const t = w.disk.get(file)
      if (t === undefined) throw new Error('gone')
      return t
    },
    writeText: async (_p, file, text) => {
      w.writes.push(file)
      w.disk.set(file, text)
      return true
    },
    loadMono: async () => ({ data: new Float32Array(44100 * 200), sampleRate: 44100 }),
    // statFile answers for whatever name it is asked about — the pipeline
    // only calls it for freshly written flacs.
    statFile: async (_p, rel) => ({ md5: `md5-of-${rel}`, size: 1000, mtimeMs: 1 }),
    host,
    now: () => 'NOW'
  }
  return w
}

/** world() plus a flac-capable native: the probe answers true and
 *  compactStem records each call. failStems lists ids whose encode rejects
 *  (the wav then stays, like the core's own behaviour). */
function flacWorld(initial: ProjectDoc, failStems: string[] = [], hostOverrides: Partial<AnalysisHost> = {}): World {
  const w = world(initial, {
    flacIsNative: () => true,
    compactStem: async (_p, wavRel, flacRel) => {
      const id = wavRel.replace(/^stems\//, '').replace(/\.wav$/, '')
      if (failStems.includes(id)) throw new Error(`encode failed for ${id}`)
      w.compacts.push(`${wavRel}->${flacRel}`)
      return { bytes: 12345, skipped: false }
    },
    ...hostOverrides
  })
  return w
}

const onDisk = (w: World): ProjectDoc => JSON.parse(w.disk.get('project.json')!) as ProjectDoc

describe('analyzeProject', () => {
  test('a fresh split gets grid + key written first, melody in a second write, stems cleared', async () => {
    const w = world(doc())
    const steps: string[] = []
    const res = await analyzeProject('T', SIX, { deps: w.deps, onStep: (m) => steps.push(m) })
    expect(res?.beat?.beats).toHaveLength(5)
    expect(res?.beat?.source).toBe('auto')
    expect(res?.beat?.detVersion).toBe(BEAT_DETECT_VERSION)
    expect(res?.beat?.autoDownbeats).toEqual([0, 4])
    expect(res?.key).toEqual({ pc: 9, minor: true, detVersion: KEY_DETECT_VERSION })
    expect(res?.melody?.detVersion).toBe(PITCH_DETECT_VERSION)
    // two writes: beat+key, then melody
    expect(w.writes).toEqual(['project.json', 'project.json'])
    const d = onDisk(w)
    expect(d.settings.beat?.beats).toHaveLength(5)
    expect(d.settings.key?.pc).toBe(9)
    expect(d.settings.melody?.f0).toBeTruthy()
    expect(d.savedAt).toBe('NOW')
    // NOTHING crossed to the far side: the grid, the key and the melody all
    // read their own files in the core, and the worklet fallbacks live behind
    // `host` where they load and clear for themselves. This assertion is the
    // whole point of the change that moved the grid's stems off the runtime —
    // it used to read `w.puts[0] === 'vocals'` and list all six.
    expect(w.puts).toEqual([])
    expect(w.tracked).toEqual(['stems/vocals.wav'])
    expect(w.cleared).toBeGreaterThanOrEqual(1)
    expect(steps.some((s) => s.startsWith('Tracking the melody'))).toBe(true)
  })

  test('every progress line says which detector it is about', async () => {
    // The song sheet shows a line against the detector it belongs to. When the
    // stage did not travel with the line, the project-wide text sat under
    // `Beat` — so a hand-tuned grid vanished behind "Reading the key…" along
    // with its promise that nothing here re-detects over it. Asserting only
    // that some line mentions the melody (the test above) cannot see that:
    // the text was always right, it was the ATTRIBUTION that was missing.
    const w = world(doc())
    const seen: { msg: string; stage: string }[] = []
    await analyzeProject('T', SIX, {
      deps: w.deps,
      onStep: (msg, _frac, stage) => seen.push({ msg, stage })
    })
    // All three detectors reported, and no line arrived unattributed.
    expect(new Set(seen.map((x) => x.stage))).toEqual(new Set(['beat', 'key', 'melody']))
    expect(seen.every((x) => typeof x.stage === 'string' && x.stage.length > 0)).toBe(true)
    // …and each line is filed under the detector that emitted it, which is the
    // property the sheet reads. A line about the key must never be a 'beat'.
    const stageOf = (needle: string): string[] =>
      seen.filter((x) => x.msg.includes(needle)).map((x) => x.stage)
    expect(stageOf('beat')).toEqual(expect.arrayContaining(['beat']))
    expect(stageOf('beat').every((st) => st === 'beat')).toBe(true)
    expect(stageOf('key')).toEqual(['key'])
    expect(stageOf('melody').every((st) => st === 'melody')).toBe(true)
    expect(stageOf('melody').length).toBeGreaterThan(0)
  })

  test('only the melody wanted → nothing crosses to the far side at all', async () => {
    const w = world(doc({ beat: autoGrid(), key: { pc: 0, minor: false, detVersion: KEY_DETECT_VERSION } }))
    await analyzeProject('T', SIX, { deps: w.deps })
    expect(w.puts).toEqual([])
    expect(w.tracked).toEqual(['stems/vocals.wav'])
    expect(onDisk(w).settings.melody).toBeTruthy()
  })

  test('the key is asked of the harmonic stems by PATH, bass last', async () => {
    const w = world(doc())
    await analyzeProject('T', SIX, { deps: w.deps })
    expect(w.keyStems).toEqual(['stems/guitar.wav,stems/piano.wav,stems/other.wav,stems/bass.wav'])
  })

  test('the caller hears the grid the moment it is written, before the melody', async () => {
    const w = world(doc())
    const heard: string[] = []
    await analyzeProject('T', SIX, {
      deps: w.deps,
      onCommit: (f) => heard.push(Object.keys(f).filter((k) => f[k as keyof typeof f]).join('+'))
    })
    expect(heard).toEqual(['beat+key', 'melody'])
  })

  test('no grid in the drums → the negative verdict is stored and not re-asked; a newer detector asks again', async () => {
    const w = world(doc(), { detectBeats: async () => null })
    const res = await analyzeProject('T', SIX, { deps: w.deps })
    expect(res?.beat).toBeUndefined()
    expect(res?.none?.beat).toBe(BEAT_DETECT_VERSION) // the caller learns a write landed
    const d = onDisk(w)
    expect(d.settings.beat).toBeUndefined()
    expect(d.settings.analysisNone?.beat).toBe(BEAT_DETECT_VERSION)
    expect(d.settings.key?.pc).toBe(9)
    expect(d.settings.melody).toBeTruthy()
    // the next open asks for nothing
    expect(planAnalysis(d, SIX, 200)).toEqual({ beat: false, key: false, melody: false, compact: true })
    // a bumped detector asks once more
    const older = { ...d, settings: { ...d.settings, analysisNone: { beat: BEAT_DETECT_VERSION - 1 } } }
    expect(planAnalysis(older, SIX, 200).beat).toBe(true)
  })

  test('a later positive answer retires the negative verdict', () => {
    const d = doc({ analysisNone: { beat: BEAT_DETECT_VERSION, key: KEY_DETECT_VERSION } })
    const out = mergeAnalysis(d, { beat: autoGrid() as never }, 'NOW')
    expect(out.settings.analysisNone).toEqual({ key: KEY_DETECT_VERSION })
    const out2 = mergeAnalysis(out, { key: { pc: 1, minor: false, detVersion: KEY_DETECT_VERSION } }, 'NOW')
    expect(out2.settings.analysisNone).toBeUndefined()
  })

  test('only the key wanted → nothing crosses at all (the core reads the files)', async () => {
    const w = world(doc({ beat: autoGrid(), melody: melodyFor(200) }))
    await analyzeProject('T', SIX, { deps: w.deps })
    expect(w.puts).toEqual([])
    expect(w.keyStems).toEqual(['stems/guitar.wav,stems/piano.wav,stems/other.wav,stems/bass.wav'])
  })

  test('the beat aux carries lyric timings and the harmonic bed (App.tsx parity)', async () => {
    const w = world(doc())
    const lines = [
      { start: 1, end: 2, text: 'a b', words: [{ w: 'a', s: 1.1, e: 1.4 }, { w: 'b', s: 1.5, e: 1.9 }] },
      { start: 3, end: 4, text: 'c', words: [] }
    ]
    await analyzeProject('T', SIX, { deps: w.deps, lyrics: { lines } })
    const args = w.detectArgs[0] as { lineStarts: number[]; words: { s: number; e: number }[]; inst: string[]; bass?: string; vocals?: string }
    expect(args.lineStarts).toEqual([1.1, 3]) // first word's start, else the line's
    expect(args.words).toEqual([{ s: 1.1, e: 1.4 }, { s: 1.5, e: 1.9 }])
    // Project-RELATIVE paths now, not stem ids: the core reads them itself.
    expect(new Set(args.inst)).toEqual(
      new Set(['stems/guitar.wav', 'stems/piano.wav', 'stems/other.wav'])
    )
    expect(args.bass).toBe('stems/bass.wav')
    expect(args.vocals).toBe('stems/vocals.wav')
  })

  test('nothing to do → no writes, no puts, no tracking (the length came off the header)', async () => {
    const d = doc({ beat: autoGrid(), key: { pc: 0, minor: false, detVersion: KEY_DETECT_VERSION }, melody: melodyFor(200) })
    const w = world(d)
    const res = await analyzeProject('T', SIX, { deps: w.deps })
    expect(res).toBeNull()
    expect(w.writes).toEqual([])
    expect(w.puts).toEqual([])
    expect(w.tracked).toEqual([])
  })

  test('hand-placed bar lines survive a re-detection, re-folded by the desktop rule', async () => {
    const stale = { ...autoGrid(BEAT_DETECT_VERSION - 1), userBars: [1.0] }
    const w = world(doc({ beat: stale, key: { pc: 0, minor: false, detVersion: KEY_DETECT_VERSION }, melody: melodyFor(200) }))
    const res = await analyzeProject('T', SIX, { deps: w.deps })
    expect(res?.beat?.userBars).toEqual([1.0])
    expect(res?.beat?.downbeats).toEqual([1, 5]) // the fake applyUserBars' fold
    expect(onDisk(w).settings.beat?.userBars).toEqual([1.0])
    expect(w.writes).toEqual(['project.json']) // grid only — key and melody were current
  })

  test('a save that landed mid-run is kept: results merge into the disk, not into memory', async () => {
    const w = world(doc())
    // the player saves a transpose while the detectors run
    const orig = w.deps.host.detectBeats
    w.deps.host.detectBeats = async (p, a) => {
      const cur = onDisk(w)
      w.disk.set('project.json', JSON.stringify({ ...cur, settings: { ...cur.settings, transpose: 3 } }))
      return orig(p, a)
    }
    await analyzeProject('T', SIX, { deps: w.deps })
    const d = onDisk(w)
    expect(d.settings.transpose).toBe(3)
    expect(d.settings.beat?.beats).toHaveLength(5)
  })

  test('stems replaced under the run → the answer is dropped, never written', async () => {
    const w = world(doc())
    const orig = w.deps.host.detectBeats
    w.deps.host.detectBeats = async (p, a) => {
      const cur = onDisk(w)
      w.disk.set(
        'project.json',
        JSON.stringify({ ...cur, stemHashes: { ...cur.stemHashes, 'drums.wav': { md5: 'other', size: 1, mtimeMs: 2 } } })
      )
      return orig(p, a)
    }
    await analyzeProject('T', SIX, { deps: w.deps })
    expect(w.writes).toEqual([]) // both commits refused
    expect(onDisk(w).settings.beat).toBeUndefined()
    expect(w.cleared).toBeGreaterThanOrEqual(1) // and the far side was still cleared
  })

  // put() used to add each stem to the stamp as a side effect of crossing it.
  // Nothing crosses now, so the pipeline names them by hand — and a stem it
  // forgot to name could be replaced mid-run without the commit noticing.
  //
  // VOCALS, specifically: drums is covered by the test above, and every other
  // aux stem (bass, guitar, piano, other) is ALSO named by the key stage, so
  // watching one of those would pass even if the beat list dropped it
  // entirely. The vocals are the only stem the grid alone claims — the aux
  // that votes phrase entries — and therefore the only one that tests this.
  test('the vocals — the grid\'s own aux — are in the stamp: replaced mid-run, the answer drops', async () => {
    const w = world(doc())
    const orig = w.deps.host.detectBeats
    w.deps.host.detectBeats = async (p, a) => {
      const cur = onDisk(w)
      w.disk.set(
        'project.json',
        JSON.stringify({
          ...cur,
          stemHashes: { ...cur.stemHashes, 'vocals.wav': { md5: 'other', size: 1, mtimeMs: 2 } }
        })
      )
      return orig(p, a)
    }
    await analyzeProject('T', SIX, { deps: w.deps })
    expect(w.writes).toEqual([])
    expect(onDisk(w).settings.beat).toBeUndefined()
  })

  test('a project deleted under the run throws, and the far side is still cleared', async () => {
    const w = world(doc())
    w.deps.host.detectBeats = async () => {
      w.disk.delete('project.json')
      return { beats: [1, 2, 3], bpm: 60, beatsPerBar: 4, downbeat: 0 }
    }
    await expect(analyzeProject('T', SIX, { deps: w.deps })).rejects.toThrow('gone')
    expect(w.cleared).toBeGreaterThanOrEqual(1)
  })

  test('a silent harmonic bed stores no key (the histogram fallback is display-only), only the verdict', async () => {
    const w = world(doc(), { estimateKeyFromStems: async () => null })
    const res = await analyzeProject('T', SIX, { deps: w.deps })
    expect(res?.key).toBeUndefined()
    expect(onDisk(w).settings.key).toBeUndefined()
    expect(onDisk(w).settings.analysisNone).toEqual({ key: KEY_DETECT_VERSION })
    expect(onDisk(w).settings.beat?.beats).toHaveLength(5)
    expect(planAnalysis(onDisk(w), SIX, 200).key).toBe(false)
  })
})

/**
 * The neural lattice (Phase 4b): when the beat models are on the phone the
 * pipeline runs mlGrid off the project's stems BEFORE anything crosses to
 * the worklet host, hands the grid to detectBeats as its `ml` aux, and the
 * "no grid" verdict carries the beatMl sub-stamp — because
 * BEAT_DETECT_VERSION alone cannot say whether the lattice was heard (the
 * desktop stores ml and no-ml grids under the same stamp), and a verdict
 * that predates the models must be asked exactly once more when they land.
 */
describe('analyzeProject — the ml aux', () => {
  const ML = { beats: [0.5, 1.5], downbeats: [0.5], beatProb: [0.1], downbeatProb: [0.1], fps: 50 }

  test('with models: mlGrid runs first (before any stem crosses), over every mix stem, and detectBeats hears it', async () => {
    const putsWhenAsked: number[] = []
    const w = world(doc(), {
      mlAvailable: async () => true
    })
    w.deps.host.mlGrid = async (_p, rels) => {
      putsWhenAsked.push(w.puts.length)
      w.mlAsks.push(rels)
      return ML
    }
    await analyzeProject('T', SIX, { deps: w.deps })
    expect(w.mlAsks).toEqual([
      ['stems/drums.wav', 'stems/bass.wav', 'stems/vocals.wav', 'stems/guitar.wav', 'stems/piano.wav', 'stems/other.wav']
    ])
    // The two memory peaks must never stack: the lattice ran with the far
    // side still empty.
    expect(putsWhenAsked).toEqual([0])
    expect((w.detectArgs[0] as { ml?: unknown }).ml).toEqual(ML)
  })

  test('without models nothing is asked and detectBeats hears null — the packless desktop', async () => {
    const w = world(doc())
    await analyzeProject('T', SIX, { deps: w.deps })
    expect(w.mlAsks).toEqual([])
    expect((w.detectArgs[0] as { ml?: unknown }).ml).toBeNull()
  })

  test('a "no grid" verdict heard WITH the lattice is stamped beatMl and binds forever', async () => {
    const w = world(doc(), { mlAvailable: async () => true, mlGrid: async () => ML, detectBeats: async () => null })
    await analyzeProject('T', SIX, { deps: w.deps })
    expect(onDisk(w).settings.analysisNone?.beat).toBe(BEAT_DETECT_VERSION)
    expect(onDisk(w).settings.analysisNone?.beatMl).toBe(true)
    // Models present next open: the verdict already heard them — no re-ask.
    expect(planAnalysis(onDisk(w), SIX, 200, true).beat).toBe(false)
    expect(planAnalysis(onDisk(w), SIX, 200, false).beat).toBe(false)
  })

  test('a verdict reached WITHOUT the lattice is re-asked once models arrive — and only then', async () => {
    const w = world(doc(), { detectBeats: async () => null })
    await analyzeProject('T', SIX, { deps: w.deps })
    expect(onDisk(w).settings.analysisNone?.beat).toBe(BEAT_DETECT_VERSION)
    expect(onDisk(w).settings.analysisNone?.beatMl).toBeUndefined()
    // No models: the verdict binds, no re-decode on every open.
    expect(planAnalysis(onDisk(w), SIX, 200, false).beat).toBe(false)
    // Models landed: ask once more, with the better ears.
    expect(planAnalysis(onDisk(w), SIX, 200, true).beat).toBe(true)
  })

  test('an attempted-but-failed run stays un-stamped, like a missing model — no evidence was heard', async () => {
    const w = world(doc(), { mlAvailable: async () => true, mlGrid: async () => null, detectBeats: async () => null })
    await analyzeProject('T', SIX, { deps: w.deps })
    expect(onDisk(w).settings.analysisNone?.beatMl).toBeUndefined()
    expect(planAnalysis(onDisk(w), SIX, 200, true).beat).toBe(true)
  })

  test('a positive grid retires the verdict AND its sub-stamp', () => {
    const d = doc({ analysisNone: { beat: BEAT_DETECT_VERSION, beatMl: true } })
    const out = mergeAnalysis(d, { beat: autoGrid() as never }, 'NOW')
    expect(out.settings.analysisNone).toBeUndefined()
  })

  test('a fresh no-ml verdict cannot keep wearing an older run\'s beatMl', () => {
    const d = doc({ analysisNone: { beat: BEAT_DETECT_VERSION, beatMl: true } })
    const out = mergeAnalysis(d, { none: { beat: BEAT_DETECT_VERSION } }, 'NOW')
    expect(out.settings.analysisNone).toEqual({ beat: BEAT_DETECT_VERSION })
  })

  test('FLAC stems never reach the lattice: mlNow is judged per project', async () => {
    const flac = { drums: 'flac', bass: 'flac', other: 'flac', vocals: 'flac', guitar: 'flac', piano: 'flac' }
    const hashes = Object.fromEntries(Object.keys(flac).map((s) => [`${s}.flac`, { md5: 'h-' + s, size: 100, mtimeMs: 1 }]))
    const w = world(doc({}, hashes), { mlAvailable: async () => true })
    await analyzeProject('T', flac, { deps: w.deps })
    expect(w.mlAsks).toEqual([])
    expect((w.detectArgs[0] as { ml?: unknown }).ml).toBeNull()
  })
})

describe('the v1->v2 upgrade (Phase 5) — compacting rides and re-queues', () => {
  test('a fresh phone-split project analyses, then compacts, and the doc flips to v2', async () => {
    const w = flacWorld(doc())
    const res = await analyzeProject('T', SIX, { deps: w.deps })
    expect(res?.compacted).toBe(6)
    expect(w.compacts).toHaveLength(6)
    expect(w.compacts[0]).toBe('stems/drums.wav->stems/drums.flac')
    const d = onDisk(w)
    expect(d.version).toBe(2)
    // every hash entry moved wav->flac; none of the old names survive
    expect(Object.keys(d.stemHashes ?? {}).sort()).toEqual(
      ['bass.flac', 'drums.flac', 'guitar.flac', 'other.flac', 'piano.flac', 'vocals.flac']
    )
    expect(d.settings.beat?.beats).toHaveLength(5) // the detectors still ran first
  })

  test('THE STRANDED TAIL: current stamps + v1 wav still plans, and an encode-only run converges', async () => {
    // The kill case review caught: detectors committed, phone died during
    // the encode. Every stamp is current, so a tail that only rode analysis
    // jobs would never run again. plan.compact is what re-queues it.
    const current = doc({
      beat: autoGrid(),
      key: { pc: 0, minor: false, detVersion: KEY_DETECT_VERSION },
      melody: melodyFor(200)
    })
    expect(planAnalysis(current, SIX, 200).compact).toBe(true)
    const w = flacWorld(current)
    const res = await analyzeProject('T', SIX, { deps: w.deps })
    expect(res?.compacted).toBe(6)
    expect(w.tracked).toHaveLength(0) // no detector ran — encode only
    expect(w.detectArgs).toHaveLength(0)
    expect(onDisk(w).version).toBe(2)
    expect(onDisk(w).settings.beat?.beats).toEqual(autoGrid().beats) // the stored grid survives untouched
  })

  test('a build whose native cannot encode does nothing — and does not claim to', async () => {
    const current = doc({
      beat: autoGrid(),
      key: { pc: 0, minor: false, detVersion: KEY_DETECT_VERSION },
      melody: melodyFor(200)
    })
    const w = world(current) // no flacIsNative, no compactStem — an older native
    const res = await analyzeProject('T', SIX, { deps: w.deps })
    expect(res).toBeNull() // "nothing to detect" — the doc is untouched
    expect(onDisk(w).version).toBe(1)
  })

  test('a failed stem keeps its wav in the doc and the project stays v1', async () => {
    const w = flacWorld(doc(), ['bass'])
    const res = await analyzeProject('T', SIX, { deps: w.deps })
    expect(res?.compacted).toBe(5)
    const d = onDisk(w)
    expect(d.version).toBe(1) // the desktop's allFlac rule
    expect(d.stemHashes?.['bass.wav']).toBeTruthy() // the survivor is still named
    expect(d.stemHashes?.['bass.flac']).toBeUndefined()
    expect(d.stemHashes?.['drums.flac']).toBeTruthy()
    // …and the NEXT run heals: compact is still planned, the core skips the
    // five done stems (idempotent) and retries the sixth.
    expect(planAnalysis(d, { ...SIX, bass: 'wav', drums: 'flac' } as never, 200).compact).toBe(false)
    // mixed extensions no longer plan a compact — the doc-level rule is
    // every-stem-wav; the healing rerun happens because entry.stems still
    // reports bass as wav and the OTHERS as flac only after ALL converted.
    expect(planAnalysis(d, SIX, 200).compact).toBe(true)
  })

  test('a FLAC-born project (copied desktop folder) never plans a compact', () => {
    const FLAC6 = Object.fromEntries(Object.keys(SIX).map((k) => [k, 'flac'])) as typeof SIX
    // A real desktop FLAC project is v2 with flac stemHashes — build that,
    // not v1-with-wav-hashes, which is indistinguishable from (and IS) the
    // killed-middle state the next test pins.
    const born = doc()
    born.version = 2
    born.stemHashes = Object.fromEntries(
      Object.keys(SIX).map((k) => [`${k}.flac`, { md5: 'x', size: 1, mtimeMs: 1 }])
    )
    expect(planAnalysis(born, FLAC6, 200).compact).toBe(false)
  })

  test('THE KILLED MIDDLE: mixed stems under an all-wav doc plan, and the healing run converges', async () => {
    // The stranding one state deeper than the tail (review): the phone dies
    // INSIDE the compact loop — three stems converted and their wavs
    // unlinked, doc never rewritten. Probed stems arrive mixed, so all-wav
    // is false forever; what tells this apart from a FAILED stem (which must
    // NOT retry) is the DOC: a failed run wrote its flacs into stemHashes,
    // a killed one did not.
    const killed = doc({
      beat: autoGrid(),
      key: { pc: 0, minor: false, detVersion: KEY_DETECT_VERSION },
      melody: melodyFor(200)
    }) // stemHashes still name six .wav files — the doc write never happened
    const MIXED = { ...SIX, drums: 'flac', bass: 'flac', vocals: 'flac' } as typeof SIX
    expect(planAnalysis(killed, MIXED, 200).compact).toBe(true)

    const cleaned: string[] = []
    const w = flacWorld(killed, [], {
      compactStem: async (_p, wavRel, flacRel) => {
        const id = wavRel.replace(/^stems\//, '').replace(/\.wav$/, '')
        if (['drums', 'bass'].includes(id)) {
          // converted stems whose wav is gone: the wav resolution rejects,
          // which the healing branch treats as the ordinary healed state
          throw new Error(`${wavRel} is missing`)
        }
        if (id === 'vocals') cleaned.push(id) // the rename->unlink micro-window orphan
        w.compacts.push(`${wavRel}->${flacRel}`)
        return { bytes: 1, skipped: id === 'vocals' }
      }
    })
    const res = await analyzeProject('T', MIXED, { deps: w.deps })
    expect(res?.compacted).toBe(6)
    expect(w.tracked).toHaveLength(0) // stamps current — no detector ran
    expect(cleaned).toEqual(['vocals']) // the orphan wav was swept
    const d = onDisk(w)
    expect(d.version).toBe(2)
    expect(Object.keys(d.stemHashes ?? {}).every((f) => f.endsWith('.flac'))).toBe(true)
    // …and the healed doc no longer plans: convergence, not a loop.
    expect(planAnalysis(d, Object.fromEntries(Object.keys(SIX).map((k) => [k, 'flac'])) as typeof SIX, 200).compact).toBe(false)
  })

  test('compacting is a change the listeners hear', async () => {
    const current = doc({
      beat: autoGrid(),
      key: { pc: 0, minor: false, detVersion: KEY_DETECT_VERSION },
      melody: melodyFor(200)
    })
    const w = flacWorld(current)
    const res = await analyzeProject('T', SIX, { deps: w.deps })
    // run.ts computes `changed` from exactly this — a compacted project
    // re-lists (its entry.stems moved), or the next tap runs off stale state.
    expect(!!(res?.beat || res?.key || res?.melody || res?.none || res?.compacted)).toBe(true)
  })
})

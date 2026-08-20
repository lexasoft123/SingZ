import React, { useCallback, useEffect, useState } from 'react'
import { NativeModules, StatusBar, View } from 'react-native'
import { AudioManager } from 'react-native-audio-api'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { MultitrackEngine } from './src/engine'
import { logStartup } from './src/log'
import { replaySplitTrail } from './src/split/service'
import { releaseProject, type LoadedProject } from './src/projects'
import { C } from './src/ui/bits'
import CatalogScreen from './src/ui/CatalogScreen'
import PlayerScreen from './src/ui/PlayerScreen'
import { TEST } from './src/ui/testhooks'

const engine = new MultitrackEngine()
if (TEST) TEST.engine = engine
// Phase-0 analysis-host spike (docs/PHONE-STANDALONE.md): lazy import so the
// analysis bundle never loads outside the spike; kicked via setTimeout so the
// driving eval returns immediately — the run itself blocks the JS thread for
// minutes on Hermes, and results are POLLED from __test.spikeDone (the
// never-await-in-CDP rule).
if (TEST) {
  const hooks = TEST
  // What a native module's JS surface actually holds — the first question
  // when a bridge method comes up undefined on a device. Keys alone lie
  // under the bridgeless interop proxy (it materializes methods lazily), so
  // a named probe answers typeof for one method.
  hooks.nativeApi = (mod: string, method?: string): string[] | string => {
    const m = (NativeModules as Record<string, Record<string, unknown>>)[mod] ?? {}
    return method ? typeof m[method] : Object.keys(m)
  }
  // ORT probe (SingzSplit native module) — drivers reach natives through
  // __test only; `require` does not exist inside CDP evals.
  hooks.ortProbe = (path: string): boolean => {
    hooks.probeDone = false
    hooks.probeOut = null
    ;(NativeModules.SingzSplit as { ortProbe(p: string): Promise<string> })
      .ortProbe(path)
      .then((r) => {
        hooks.probeOut = r
        hooks.probeDone = true
      })
      .catch((e: unknown) => {
        hooks.probeOut = JSON.stringify({ ok: false, error: String(e) })
        hooks.probeDone = true
      })
    return true
  }
  // Phase-2 engine proof: drive the split directly (the :split service is
  // the production path). Progress events land in hooks.splitProgress.
  hooks.runSplitDirect = (
    modelPath: string,
    mixPath: string,
    jobDir: string,
    srcRate: number,
    resumeChunk = 0
  ): Promise<string> => {
    const { DeviceEventEmitter } = require('react-native') as {
      DeviceEventEmitter: { addListener: (e: string, cb: (v: unknown) => void) => { remove(): void } }
    }
    hooks.splitProgress = []
    const sub = DeviceEventEmitter.addListener('singzSplitProgress', (v) => {
      ;(hooks.splitProgress as unknown[]).push(v)
    })
    return (
      NativeModules.SingzSplit as {
        runSplitDirect(
          m: string,
          x: string,
          j: string,
          r: number,
          c: number
        ): Promise<string>
      }
    )
      .runSplitDirect(modelPath, mixPath, jobDir, srcRate, resumeChunk)
      .finally(() => sub.remove())
  }
  hooks.cancelSplit = (): Promise<boolean> =>
    (NativeModules.SingzSplit as { cancelSplit(): Promise<boolean> }).cancelSplit()
  // Production split path (the :split service). Events are captured into
  // hooks.splitEvents; the decode-safe completion probe stays job.json /
  // the persisted log, never a CDP await.
  hooks.startSplitService = (
    srcPath: string,
    modelPath: string,
    projectDir: string,
    resume = false,
    watchdogCapMs = 0
  ): boolean => {
    hooks.splitEvents = []
    void import('./src/split/service').then((svc) => {
      // A leftover subscription from the previous kick would double every
      // event into the fresh array.
      ;(hooks.unsubscribeSplit as (() => void) | undefined)?.()
      const push = (v: unknown): void => {
        ;(hooks.splitEvents as unknown[]).push(v)
      }
      hooks.unsubscribeSplit = svc.subscribeSplit(push, push)
      void svc.startSplit({ srcPath, modelPath, projectDir, resume, watchdogCapMs })
    })
    return true
  }
  hooks.splitServiceStatus = (): boolean => {
    hooks.statusDone = false
    hooks.statusOut = null
    void import('./src/split/service').then((svc) =>
      svc.splitStatus().then((s) => {
        hooks.statusOut = s
        hooks.statusDone = true
      })
    )
    return true
  }
  hooks.cancelSplitService = (): boolean => {
    void import('./src/split/service').then((svc) => svc.cancelSplit())
    return true
  }
  // Pure module rebind, no new JS listener — drives the service-side
  // register dedupe (a re-mounting UI does exactly this).
  hooks.attachSplitEvents = (): boolean => {
    void (
      NativeModules.SingzSplit as { attachSplitEvents(): Promise<boolean> }
    ).attachSplitEvents()
    return true
  }
  // Model download (P2): url override so the driver can point at a local
  // range-serving HTTP server instead of the real release.
  hooks.modelDownload = (url: string, file: string, sha256: string, bytes: number): boolean => {
    hooks.dlDone = false
    hooks.dlOut = null
    hooks.dlProgress = []
    void import('./src/analysis/models').then((m) =>
      m
        .ensureModel({ file, bytes, sha256, url }, (got, total) => {
          ;(hooks.dlProgress as unknown[]).push([got, total])
        })
        .then(
          (p) => {
            hooks.dlOut = p
            hooks.dlDone = true
          },
          (e: unknown) => {
            hooks.dlOut = 'ERR ' + String(e)
            hooks.dlDone = true
          }
        )
    )
    return true
  }
  hooks.cancelModelDownload = (file: string): boolean => {
    void import('./src/analysis/models').then((m) => m.cancelModelDownload(file))
    return true
  }
  hooks.clearSplitJob = (): boolean => {
    void import('./src/split/service').then((svc) => svc.clearSplitJob())
    return true
  }
  hooks.analysisSpike = (minutes?: number): boolean => {
    hooks.spikeDone = false
    hooks.spikeResult = null
    setTimeout(() => {
      void import('./src/analysis/spike')
        .then((m) => {
          hooks.spikeResult = m.runAnalysisSpike(minutes)
          hooks.spikeDone = true
        })
        .catch((e: unknown) => {
          hooks.spikeResult = { error: String(e) }
          hooks.spikeDone = true
        })
    }, 50)
    return true
  }
  // Phase 4 diagnostic: what loadMono44k hands the host for one stem — the
  // first question when a project's analysis comes back empty (it was: the
  // splitter had routed a synthetic "vocal" out of the vocals stem, −83 dB).
  hooks.monoStats = (dir: string, rel: string): boolean => {
    hooks.echoDone = false
    hooks.echoResult = null
    void import('./src/analysis/deps')
      .then(async (m) => {
        const t0 = Date.now()
        const st = await m.loadMono44k(dir, rel)
        let e = 0
        let peak = 0
        for (let i = 0; i < st.data.length; i++) {
          const v = st.data[i]
          e += v * v
          if (Math.abs(v) > peak) peak = Math.abs(v)
        }
        return { len: st.data.length, sr: st.sampleRate, rms: Math.sqrt(e / Math.max(1, st.data.length)), peak, ms: Date.now() - t0 }
      })
      .then((r) => { hooks.echoResult = r; hooks.echoDone = true })
      .catch((e: unknown) => { hooks.echoResult = { error: String(e) }; hooks.echoDone = true })
    return true
  }
  // Phase 4c: the core's KEY detector on this device, over a project's own
  // harmonic stems — the on-device half of eval/key-parity.mjs. Reports the
  // native answer AND the worklet TS's on the same files, so a device that
  // disagrees with the desktop says so here rather than in a stored doc.
  hooks.keyParity = (dir: string, stems: string[]): boolean => {
    hooks.echoDone = false
    hooks.echoResult = null
    void Promise.all([import('./src/analysis/deps'), import('./src/analysis/host'), import('./src/analysis/native')])
      .then(async ([d, h, n]) => {
        const inst = stems.filter((s) => s !== 'bass').map((s) => `stems/${s}.wav`)
        const bass = stems.includes('bass') ? 'stems/bass.wav' : undefined
        const t0 = Date.now()
        const nat = await n.estimateKeyNative(dir, inst, bass)
        const nativeMs = Date.now() - t0
        const ids: string[] = []
        for (const rel of inst) {
          const id = `kp-${ids.length}`
          await h.putStem(id, await d.loadMono44k(dir, rel))
          ids.push(id)
        }
        if (bass) await h.putStem('kp-bass', await d.loadMono44k(dir, bass))
        const t1 = Date.now()
        const ts = await h.estimateKeyFromStems(ids, bass ? 'kp-bass' : undefined)
        const tsMs = Date.now() - t1
        await h.clearStems()
        return {
          native: nat,
          ts,
          same: (nat === null && ts === null) || (!!nat && !!ts && nat.pc === ts.pc && nat.minor === ts.minor),
          ms: { native: nativeMs, ts: tsMs },
          stems: inst.length + (bass ? 1 : 0)
        }
      })
      .then((r) => { hooks.echoResult = r; hooks.echoDone = true })
      .catch((e: unknown) => { hooks.echoResult = { error: String(e), stack: e instanceof Error ? e.stack : undefined }; hooks.echoDone = true })
    return true
  }
  // Phase 4d: the core's BEAT detector on this device, over a project's own
  // stems — the on-device half of eval/beats-parity.mjs, and the same shape as
  // keyParity above. It runs the native AND the worklet TS on the same files
  // and reports whether they agree, so a device that disagrees with the
  // desktop says so HERE rather than in a stored grid nobody re-derives.
  //
  // Both halves matter. The native is what the app now uses; the TS is the
  // reference the parity gate holds it to on the host, and running it here as
  // well is what makes this a comparison rather than a smoke test.
  hooks.beatsParity = (dir: string, stems: string[], ext = 'wav', mlFrom = '', useMl = true): boolean => {
    hooks.echoDone = false
    hooks.echoResult = null
    void import('./src/latency').then((l) => l.setStoredText('singz.beatsParity.done', ''))
    void Promise.all([import('./src/analysis/deps'), import('./src/analysis/host'), import('./src/analysis/native')])
      .then(async ([d, h, n]) => {
        const deps = d.realAnalysisDeps()
        const rel = (id: string) => `stems/${id}.${ext}`
        const inst = stems.filter((x) => x !== 'drums' && x !== 'bass' && x !== 'vocals')
        const args: Parameters<ReturnType<typeof d.realAnalysisHost>['detectBeats']>[1] & {
          lineStarts: number[]
          words: { s: number; e: number }[]
        } = {
          drums: rel('drums'),
          bass: stems.includes('bass') ? rel('bass') : undefined,
          vocals: stems.includes('vocals') ? rel('vocals') : undefined,
          inst: inst.map(rel),
          lineStarts: [],
          words: []
        }
        // The native reads the files itself and only understands WAV; a FLAC
        // project has no native path by design (a copied desktop library).
        // The AUX the real pipeline always fills, and which a bare comparison
        // never crosses: the lyric line starts, the aligned WORDS (a flat
        // number array on the bridge) and the neural LATTICE (a dictionary of
        // three arrays). A grid built from a mis-marshalled word pair or a
        // mis-marshalled lattice is wrong and is stored under an unchanged
        // detVersion, so it is never re-derived — which makes this the one
        // part of the crossing worth going out of the way to exercise.
        let lines: { start: number; words: { s: number; e: number }[] }[] = []
        try {
          const raw = JSON.parse(await deps.readText(dir, 'lyrics.json')) as {
            lines?: { start: number; words?: { s: number; e: number }[] }[]
          }
          lines = (raw.lines ?? []).map((l) => ({ start: l.start, words: l.words ?? [] }))
        } catch {
          lines = [] // no lyrics for this project — reported, not fatal
        }
        const aux = {
          lineStarts: lines.map((l) => l.words[0]?.s ?? l.start).filter((t) => Number.isFinite(t)),
          words: lines.flatMap((l) => l.words.map((w) => ({ s: w.s, e: w.e })))
        }
        // `mlFrom` names the project to compute the lattice FROM, which for a
        // FLAC project is its WAV twin: the core cannot read FLAC, so a flac
        // leg would otherwise get no lattice while the wav leg got one, and
        // the two would be answering different questions. The comparison needs
        // the aux held constant; the app's own behaviour (no phone-ml for a
        // copied desktop project) is not what this hook is measuring.
        const mlDir = mlFrom || dir
        const mixRels = ['drums', 'bass', 'vocals', 'guitar', 'piano', 'other']
          .filter((id) => stems.includes(id))
          .map((id) => `stems/${id}.wav`)
        const host = d.realAnalysisHost()
        // `useMl` false is for a CORPUS run: the host CLI it is compared against
        // would need the identical lattice to answer the same question, and
        // shipping one back per song is a lot of numbers for a comparison the
        // single-song suites already make. Off, both sides run the homegrown
        // path over the same bytes.
        const ml = useMl && (await host.mlAvailable()) ? await host.mlGrid(mlDir, mixRels) : null
        Object.assign(args, aux, { ml })

        const t0 = Date.now()
        const nat = ext === 'wav' ? await n.detectBeatsNative(dir, args) : null
        const nativeMs = Date.now() - t0
        // And the branch itself: what deps.ts actually hands the pipeline for
        // THESE paths. On wav that is the native; on flac it is the worklet
        // fallback, which is the only place that fallback's stem naming and
        // ORDER are ever executed.
        const t2 = Date.now()
        const via = await host.detectBeats(dir, args)
        const viaMs = Date.now() - t2
        // The worklet path wants the stems on the far side, one at a time.
        const ids: string[] = []
        const cross = async (r: string | undefined, id: string) => {
          if (!r) return undefined
          await h.putStem(id, await d.loadMono44k(dir, r))
          ids.push(id)
          return id
        }
        const drumsId = await cross(args.drums, 'bp-drums')
        const bassId = await cross(args.bass, 'bp-bass')
        const vocId = await cross(args.vocals, 'bp-vocals')
        const instIds: string[] = []
        for (const [i, r] of (args.inst ?? []).entries()) {
          const id = await cross(r, `bp-inst-${i}`)
          if (id) instIds.push(id)
        }
        const t1 = Date.now()
        let ts: Awaited<ReturnType<typeof n.detectBeatsNative>> = null
        try {
          ts = drumsId
            ? await h.detectBeats({
                drums: drumsId,
                bass: bassId,
                vocals: vocId,
                inst: instIds,
                lineStarts: args.lineStarts,
                words: args.words,
                ml: args.ml
              })
            : null
        } finally {
          // finally, like every other path here: a throw above would otherwise
          // leave six decoded stems (~53 MB each) pinned on the analysis
          // runtime for the session, and the driver would report a closed
          // inspector instead of the real failure.
          await h.clearStems()
        }
        const tsMs = Date.now() - t1
        const arr = (x?: number[] | null) => (x ?? []).join(',')
        type G = typeof ts
        const alike = (a: G, b: G) =>
          (a === null && b === null) ||
          (!!a &&
            !!b &&
            arr(a.beats) === arr(b.beats) &&
            a.bpm === b.bpm &&
            a.beatsPerBar === b.beatsPerBar &&
            a.downbeat === b.downbeat &&
            arr(a.downbeats) === arr(b.downbeats) &&
            arr(a.suspectAt) === arr(b.suspectAt))
        return {
          same: ext === 'wav' ? alike(nat, ts) : true,
          viaSame: alike(via, ts),
          ext,
          grid: via && { beats: via.beats.length, bpm: via.bpm, bpb: via.beatsPerBar, downbeat: via.downbeat, bars: via.downbeats?.length ?? null },
          // The whole grid, so a driver can compare two RUNS of this hook (a
          // wav project against its own lossless FLAC copy) value for value
          // rather than by these counts.
          digest: via ? `${arr(via.beats)}|${via.bpm}|${via.beatsPerBar}|${via.downbeat}|${arr(via.downbeats)}|${arr(via.suspectAt)}` : null,
          // Counts and the first few values: the driver compares `same`, which
          // was computed over EVERY value above — these are for the human
          // reading a failure, not the gate.
          native: nat && { beats: nat.beats.length, bpm: nat.bpm, bpb: nat.beatsPerBar, downbeat: nat.downbeat, bars: nat.downbeats?.length ?? null, first3: nat.beats.slice(0, 3) },
          ts: ts && { beats: ts.beats.length, bpm: ts.bpm, bpb: ts.beatsPerBar, downbeat: ts.downbeat, bars: ts.downbeats?.length ?? null, first3: ts.beats.slice(0, 3) },
          ms: { native: nativeMs, ts: tsMs, via: viaMs },
          stems: stems.length,
          // What the aux ACTUALLY carried, so a driver can refuse to call a
          // run a pass when the two hardest arguments crossed empty.
          crossed: { words: args.words.length, lineStarts: args.lineStarts.length, mlBeats: ml ? ml.beats.length : 0 }
        }
      })
      .then((r) => { hooks.echoResult = r; hooks.echoDone = true })
      .catch((e: unknown) => { hooks.echoResult = { error: String(e), stack: e instanceof Error ? e.stack : undefined }; hooks.echoDone = true })
      // A CRUMB in the prefs, not just the in-memory flag. The Android driver
      // cannot poll this over CDP: the worklet leg decodes six stems, and
      // evaluating JS while a decodeAudioData is in flight segfaults the
      // Hermes inspector (CLAUDE.md — 3/3 reproducible, and it reads as an
      // OOM). It watches this pref with `adb run-as` instead and evaluates
      // exactly once, after the decodes are over.
      .finally(() => {
        void import('./src/latency').then((l) => l.setStoredText('singz.beatsParity.done', String(Date.now())))
      })
    return true
  }
  // Phase 4b, the pipeline's own entry: the grid FROM STEMS, summed and
  // decimated in the core (mlGridFromStems) — what analyzeProject actually
  // calls. Drivers compare it against mlGridParity fed the same mix rendered
  // on the host, which is how the native sum is proven against the desktop's.
  hooks.mlGridFromStems = (stemPaths: string[], modelsDir: string, dumpDir = ''): boolean => {
    hooks.echoDone = false
    hooks.echoResult = null
    const t0 = Date.now()
    void (NativeModules.SingzSplit as {
      mlGridFromStems(a: string[], b: string, c: string): Promise<Record<string, unknown>>
    })
      .mlGridFromStems(stemPaths, modelsDir, dumpDir)
      .then(
        (g) => { hooks.echoResult = { ok: true, wallMs: Date.now() - t0, grid: g }; hooks.echoDone = true },
        (e: unknown) => { hooks.echoResult = { ok: false, error: String((e as Error)?.message ?? e) }; hooks.echoDone = true }
      )
    return true
  }
  // The app's own log, for drivers: the pipeline writes `ml N ms` and
  // native.ts writes `ml grid: N beats` — the evidence that the lattice was
  // actually heard on the way to a stored grid, which no doc field says.
  hooks.logEntries = (): boolean => {
    hooks.echoDone = false
    hooks.echoResult = null
    void import('./src/log').then((m) =>
      m.logEntries().then(
        (r) => { hooks.echoResult = r; hooks.echoDone = true },
        (e: unknown) => { hooks.echoResult = { error: String(e) }; hooks.echoDone = true }
      )
    )
    return true
  }
  // The beat models' presence and location, as the pipeline judges them — a
  // stat, never a download.
  hooks.beatModelsStatus = (): boolean => {
    hooks.echoDone = false
    hooks.echoResult = null
    void import('./src/analysis/models').then((m) =>
      m.beatModelsStatus().then(
        (r) => { hooks.echoResult = r; hooks.echoDone = true },
        (e: unknown) => { hooks.echoResult = { error: String(e) }; hooks.echoDone = true }
      )
    )
    return true
  }
  // Phase 4b: the Beat This! grid straight off the core, for comparison
  // against the desktop packs' python runner. Same echoDone/echoResult shape
  // as the other parity hooks — the driver polls rather than awaiting an eval,
  // because a long native call blocking the inspector is how the Hermes
  // segfault in the loading tests was first hit.
  hooks.mlGridParity = (wavPath: string, modelsDir: string, dumpDir = ''): boolean => {
    hooks.echoDone = false
    hooks.echoResult = null
    // The STATIC NativeModules from the top of this file, never
    // `import('react-native')`. Building that namespace object enumerates
    // every export, which fires react-native/index.js's lazy getters — and
    // PushNotificationIOS's throws on iOS when its native module is absent,
    // red-boxing the app before this hook does anything. Android never showed
    // it: the throw sits behind a Platform.OS === 'ios' check.
    const t0 = Date.now()
    void (NativeModules.SingzSplit as {
      mlGrid(a: string, b: string, c: string): Promise<Record<string, unknown>>
    })
      .mlGrid(wavPath, modelsDir, dumpDir)
      .then(
        (g) => { hooks.echoResult = { ok: true, wallMs: Date.now() - t0, grid: g }; hooks.echoDone = true },
        (e: unknown) => { hooks.echoResult = { ok: false, error: String((e as Error)?.message ?? e) }; hooks.echoDone = true }
      )
    return true
  }

  // Phase 4c: the core's melody tracker against the desktop TS on the SAME
  // stem file — the on-device half of the parity gate (the host-side half is
  // singz-analyze vs node over the corpus). Native reads the WAV itself; the
  // TS gets the phone's own decode of it (loadMono44k) on the worklet host.
  // Identical f0 means the port, the WAV reader and the decoder all agree.
  hooks.melodyParity = (dir: string, rel: string): boolean => {
    hooks.echoDone = false
    hooks.echoResult = null
    void Promise.all([import('./src/analysis/deps'), import('./src/analysis/host'), import('./src/analysis/native')])
      .then(async ([d, h, n]) => {
        const t0 = Date.now()
        const nat = await n.trackMelodyNative(dir, rel)
        const nativeMs = Date.now() - t0
        const st = await d.loadMono44k(dir, rel)
        await h.putStem('parity', st)
        const t1 = Date.now()
        const ts = await h.trackMelody('parity')
        const tsMs = Date.now() - t1
        await h.clearStems()
        let differing = 0
        let maxAbs = 0
        let first = -1
        const n2 = Math.max(nat.f0.length, ts.f0.length)
        for (let i = 0; i < n2; i++) {
          const a = nat.f0[i] ?? NaN
          const b = ts.f0[i] ?? NaN
          if (a !== b) {
            differing++
            if (first < 0) first = i
            maxAbs = Math.max(maxAbs, Math.abs(a - b))
          }
        }
        return {
          frames: { native: nat.f0.length, ts: ts.f0.length },
          voiced: { native: Array.from(nat.f0).filter((v) => v > 0).length, ts: Array.from(ts.f0).filter((v) => v > 0).length },
          hopSec: { native: nat.hopSec, ts: ts.hopSec },
          detVersion: nat.detVersion,
          differing,
          first,
          maxAbs,
          ms: { native: nativeMs, ts: tsMs }
        }
      })
      .then((r) => { hooks.echoResult = r; hooks.echoDone = true })
      .catch((e: unknown) => { hooks.echoResult = { error: String(e), stack: e instanceof Error ? e.stack : undefined }; hooks.echoDone = true })
    return true
  }
  // Phase 4: the same spike through the analysis host (the worklet runtime).
  // Same polling contract; the app thread stays free while it runs, which is
  // the point — hostResult.ticks says whether it did.
  hooks.hostSpike = (minutes?: number): boolean => {
    hooks.hostDone = false
    hooks.hostResult = null
    void import('./src/analysis/spike')
      .then((m) => m.runHostSpike(minutes))
      .then((r) => {
        hooks.hostResult = r
        hooks.hostDone = true
      })
      .catch((e: unknown) => {
        hooks.hostResult = { error: String(e), stack: e instanceof Error ? e.stack : undefined }
        hooks.hostDone = true
      })
    return true
  }
}

export default function App(): React.JSX.Element {
  const [project, setProject] = useState<LoadedProject | null>(null)

  useEffect(() => {
    // First line of the session, before anything can go wrong underneath it.
    void logStartup()
    // If the last split was killed, its native trail outlived the process —
    // put it in the log where the singer (and a bug report) can see it.
    void replaySplitTrail()
    AudioManager.setAudioSessionOptions({ iosCategory: 'playback', iosMode: 'default' })
    void AudioManager.setAudioSessionActivity(true)
  }, [])

  /* Closing a song frees its stems here, where they are owned: the engine
   * drops its tracks and source nodes, and the LoadedProject stops holding
   * the buffers so the last reference dies with this state update. Waiting
   * for GC to notice instead is what let songs stack up to a jetsam kill. */
  const closeProject = useCallback(() => {
    engine.unload()
    setProject((p) => {
      releaseProject(p)
      return null
    })
  }, [])

  return (
    <SafeAreaProvider>
      <View style={{ flex: 1, backgroundColor: C.bg }}>
        <StatusBar barStyle="light-content" />
        {project === null ? (
          <CatalogScreen sampleRate={engine.sampleRate} onLoaded={setProject} />
        ) : (
          <PlayerScreen engine={engine} project={project} onBack={closeProject} />
        )}
      </View>
    </SafeAreaProvider>
  )
}

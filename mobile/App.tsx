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
  hooks.cancelModelDownload = (): boolean => {
    void import('./src/analysis/models').then((m) => m.cancelModelDownload())
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

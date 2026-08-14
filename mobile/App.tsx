import React, { useCallback, useEffect, useState } from 'react'
import { NativeModules, StatusBar, View } from 'react-native'
import { AudioManager } from 'react-native-audio-api'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { MultitrackEngine } from './src/engine'
import { logStartup } from './src/log'
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
}

export default function App(): React.JSX.Element {
  const [project, setProject] = useState<LoadedProject | null>(null)

  useEffect(() => {
    // First line of the session, before anything can go wrong underneath it.
    void logStartup()
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

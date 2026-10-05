import React, { useEffect, useRef, useState } from 'react'
import { AppState, NativeModules, Platform, Pressable, ScrollView, Share, StyleSheet, Text } from 'react-native'
import type { MultitrackEngine } from '../engine'
import { describeOutput, getRouteLatency } from '../latency'
import { log } from '../log'
import { TrainingMicrophone } from '../training/mic'
import { detectedToneDelayMs } from '../training/diagnostics'
import { trainingMustStopForAppState } from '../training/runtime'
import { nextMicrophoneSampleName, microphoneSampleName } from '../training/sample-name'
import { C } from './bits'

export function AudioDiagnosticsScreen({ engine, active, onBack, onSoundLab }: {
  engine: MultitrackEngine; active: boolean; onBack: () => void; onSoundLab?: () => void
}): React.JSX.Element {
  const mic = useRef(new TrainingMicrophone()).current
  const recording = useRef(false)
  const [finishingSample, setFinishingSample] = useState(false)
  const [sampleUrl, setSampleUrl] = useState<string | null>(null)
  const generation = useRef(0)
  const [detector, setDetector] = useState<string>('CREPE-tiny (default)')
  const [changingDetector, setChangingDetector] = useState(false)
  useEffect(() => {
    let current = true
    if (Platform.OS === 'ios')
      void NativeModules.AudioInputSession?.getPitchDetector?.().then((name: string) => {
        if (current) setDetector(name)
      }).catch(() => undefined)
    return () => { current = false }
  }, [])
  const chooseDetector = async (name: 'crepe-tiny' | 'yin') => {
    setChangingDetector(true)
    try {
      await mic.stop()
      await NativeModules.AudioInputSession.setPitchDetector(name)
      setDetector(name)
      log('audio-debug', `pitch detector selected · ${name}`)
    } catch (error) { setStatus(String(error)) }
    finally { setChangingDetector(false) }
  }
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState('Ready')
  const [route, setRoute] = useState('Route unknown')
  const [reading, setReading] = useState('No microphone frames')
  const [results, setResults] = useState<string[]>([])
  const stop = () => {
    generation.current++
    engine.cancelTrainingCues()
    if (recording.current) setFinishingSample(true)
    void mic.stop().then(async () => {
      if (!recording.current) return
      recording.current = false
      try {
        const sample = await NativeModules.AudioInputSession.finishCarSample()
        setSampleUrl(sample.url)
        log('audio-debug', `car sample saved · ${microphoneSampleName(sample)} · ${sample.seconds.toFixed(1)} s · ${sample.sampleRate} Hz · raw mono PCM16`)
      } catch (error) { log('audio-debug', String(error), 'error') }
      finally { setFinishingSample(false) }
    })
    setRunning(false)
  }
  useEffect(() => {
    if (!active) stop()
    const subscription = AppState.addEventListener('change', state => {
      if (trainingMustStopForAppState(state, mic.isRequestingPermission())) { stop(); setStatus('Stopped in background') }
    })
    return () => { subscription.remove(); stop() }
  }, [active, engine, mic])

  const start = async (probe: boolean, record = false) => {
    if (running || changingDetector || finishingSample) return
    const run = ++generation.current
    setRunning(true)
    setResults([])
    setStatus('Opening microphone…')
    const current = () => generation.current === run
    const clock = () => engine.trainingCurrentTime * 1000
    try {
      if (record) {
        const filename = nextMicrophoneSampleName()
        await NativeModules.AudioInputSession.armCarSample(filename)
        if (!current()) {
          await NativeModules.AudioInputSession.finishCarSample().catch(() => undefined)
          return
        }
        recording.current = true
        setSampleUrl(null)
        log('audio-debug', `car sample recording started · ${filename} · maximum 30 s · raw microphone before analysis`)
      }
      const before = await describeOutput()
      if (!current()) return
      log('audio-debug', `before capture · ${before.text}`)
      const started = await mic.start(clock, error => { setStatus(error); stop() })
      if (!current()) return
      if (!started.ok) { setStatus(started.error); stop(); return }
      const [after, latency] = await Promise.all([describeOutput(), getRouteLatency()])
      if (!current()) return
      const routeText = `${after.text} · reported output + buffer ${(latency.autoSec * 1000).toFixed(1)} ms`
      setRoute(routeText)
      log('audio-debug', `capture active · ${routeText}`)
      setStatus(probe ? 'Stay quiet. Playing nine reference tones…' : 'Sing a steady note. Stop when finished.')
      let lastFrame: unknown = null
      let lastLog = 0
      let scheduled: { midi: number; start: number; matched: number | null } | null = null
      const refresh = () => {
        const { frame, arrivalMs } = mic.diagnostics
        if (!frame || frame === lastFrame) return
        lastFrame = frame
        let callbackLag = 'unknown'
        try {
          callbackLag = (Number(BigInt(frame.callbackHostTimeNs) - BigInt(frame.sampleHostTimeEndNs)) / 1e6).toFixed(1)
        } catch { /* An older bridge may omit host timestamps. */ }
        const line = `${frame.frequency.toFixed(1)} Hz · confidence ${frame.clarity.toFixed(3)} · ${mic.signal.dbfs?.toFixed(1)} dBFS\n` +
          `${'detector' in frame ? frame.detector : 'native'} · ${frame.sampleRate} Hz · ${frame.timestampQuality} · resets ${frame.resetCount}\n` +
          `callback minus window end ${callbackLag} ms · ${frame.discontinuityReason}`
        setReading(line)
        if (Date.now() - lastLog >= 1000) {
          lastLog = Date.now()
          log('audio-debug', line.replace(/\n/g, ' · '))
        }
        if (scheduled && scheduled.matched === null)
          scheduled.matched = detectedToneDelayMs(scheduled.midi, frame.frequency, frame.clarity, arrivalMs, scheduled.start)
      }
      const wait = async (ms: number) => {
        const until = Date.now() + ms
        while (current() && Date.now() < until) {
          refresh()
          await new Promise<void>(resolve => setTimeout(resolve, 50))
        }
      }
      await wait(700)
      if (!probe) {
        const end = record ? Date.now() + 29300 : Infinity
        while (current() && Date.now() < end) await wait(100)
        if (record && current()) { stop(); setStatus('Recording finished. Share the WAV and current app log.') }
        return
      }
      for (const midi of [57, 69, 64, 57, 69, 64, 57, 69, 64]) {
        if (!current()) return
        const cue = await engine.playTrainingCues([{ articulation: 'together', notes: [midi], durationSeconds: 1.5 }])
        if (!current()) return
        if (!cue.ok) throw new Error(cue.error)
        scheduled = { midi, start: cue.startsAt * 1000, matched: null }
        await wait(2600)
        if (!current()) return
        const result = `MIDI ${midi}: ${scheduled.matched === null ? 'no confident match' : scheduled.matched.toFixed(0) + ' ms to pitch detection'}`
        setResults(previous => [...previous, result])
        log('audio-debug', result)
        scheduled = null
      }
      setStatus('Finished. Share the app log, then repeat with the phone speaker for comparison.')
      stop()
    } catch (error) {
      if (!current()) return
      const message = error instanceof Error ? error.message : String(error)
      log('audio-debug', message, 'error')
      setStatus(message)
      stop()
    }
  }
  return <ScrollView contentContainerStyle={styles.content}>
    <Pressable onPress={onBack}><Text style={styles.button}>Back</Text></Pressable>
    <Text style={styles.title}>Audio diagnostics</Text>
    {!running && onSoundLab && <Pressable onPress={onSoundLab}><Text style={styles.button}>Instrument sound lab</Text></Pressable>}
    <Text style={styles.text}>Connect CarPlay while parked. Keep the phone microphone near a speaker and stay quiet during the tone test. Use moderate volume.</Text>
    <Text style={styles.text}>This measures speaker → microphone → pitch detection, including analysis and screen delivery. It is not isolated hardware latency. Reference tones use the selected instrument as training. Microphone audio is never played back. Record sample explicitly saves up to 30 seconds of microphone audio; sharing is manual.</Text>
    <Text style={styles.text}>{route}</Text>
    <Text style={styles.text}>{status}</Text>
    <Text selectable style={styles.reading}>{reading}</Text>
    {Platform.OS === 'ios' && !running && !finishingSample && <>
      <Text style={styles.text}>Pitch detector: {detector}. Selection also applies to vocal training.</Text>
      <Pressable disabled={changingDetector} onPress={() => void chooseDetector('crepe-tiny')}><Text style={styles.button}>Use CREPE-tiny</Text></Pressable>
      <Pressable disabled={changingDetector} onPress={() => void chooseDetector('yin')}><Text style={styles.button}>Use YIN for comparison</Text></Pressable>
    </>}
    {!running && !finishingSample && <>
      {Platform.OS === 'ios' && <Pressable onPress={() => void start(false, true)}><Text style={styles.button}>Record car sample (30 seconds)</Text></Pressable>}
      <Pressable onPress={() => void start(false)}><Text style={styles.button}>Monitor singing</Text></Pressable>
      <Pressable onPress={() => void start(true)}><Text style={styles.button}>Test speaker → microphone</Text></Pressable>
    </>}
    {running && <Pressable onPress={() => { stop(); setStatus('Stopped') }}><Text style={styles.button}>Stop</Text></Pressable>}
    {sampleUrl && !running && <Pressable onPress={() => void Share.share({ url: sampleUrl })}><Text style={styles.button}>Share microphone WAV</Text></Pressable>}
    {results.map((result, index) => <Text key={index} style={styles.text}>{result}</Text>)}
    <Text style={styles.text}>Readings and results go to the existing app log. Compare confidence and resets during flaky detection; share that log with the CarPlay and phone-speaker results.</Text>
  </ScrollView>
}
const styles = StyleSheet.create({
  content: { padding: 24, paddingTop: 64, gap: 18, backgroundColor: C.bg },
  title: { color: C.text, fontSize: 28, fontWeight: '700' },
  text: { color: C.text, fontSize: 16 },
  reading: { color: C.text, fontSize: 17, fontVariant: ['tabular-nums'] },
  button: { color: C.amber, fontSize: 18, paddingVertical: 12 }
})

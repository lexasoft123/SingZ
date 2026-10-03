import React, { useCallback, useEffect, useRef, useState } from 'react'
import { AppState, NativeModules, Platform, Pressable, Share, Text, View } from 'react-native'
import { log } from '../log'
import { nextMicrophoneSampleName, microphoneSampleName } from './sample-name'
import { C } from '../ui/bits'

/** Attaches to capture already owned by training; never restarts its audio session. */
export function useTrainingSampleRecording(active: boolean): React.ReactNode {
  const owner = useRef(false)
  const pending = useRef(false)
  const activeRef = useRef(active)
  activeRef.current = active
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [busy, setBusy] = useState(false)
  const [recording, setRecording] = useState(false)
  const [url, setUrl] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const finish = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    if (!owner.current) return
    owner.current = false
    setBusy(true)
    setRecording(false)
    try {
      const sample = await (Platform.OS === 'android' ? NativeModules.AudioInput : NativeModules.AudioInputSession).finishCarSample()
      setUrl(sample.url)
      setMessage(`Saved ${sample.seconds.toFixed(1)} seconds. Share the WAV and current log.`)
      log('training-recording', `saved · ${microphoneSampleName(sample)} · ${sample.seconds.toFixed(1)} s · ${sample.sampleRate} Hz · mono PCM16`)
    } catch (error) {
      setMessage(String(error))
      log('training-recording', String(error), 'error')
    } finally { setBusy(false) }
  }, [])
  useEffect(() => {
    activeRef.current = active
    if (!active) void finish()
    const listener = AppState.addEventListener('change', state => {
      if (state === 'background') { activeRef.current = false; void finish() }
    })
    return () => { activeRef.current = false; listener.remove(); void finish() }
  }, [active, finish])
  const start = async () => {
    if (pending.current || owner.current || busy || !activeRef.current) return
    pending.current = true
    setBusy(true)
    try {
      const filename = nextMicrophoneSampleName()
      await (Platform.OS === 'android' ? NativeModules.AudioInput : NativeModules.AudioInputSession).armCarSample(filename)
      owner.current = true
      if (!activeRef.current) { await finish(); return }
      setUrl(null)
      setRecording(true)
      setMessage('Recording microphone audio for up to 30 seconds. Training continues normally.')
      log('training-recording', `started · ${filename} · maximum 30 s · microphone before pitch analysis`)
      timer.current = setTimeout(() => void finish(), 30000)
    } catch (error) { setMessage(String(error)); log('training-recording', String(error), 'error') }
    finally { pending.current = false; setBusy(false) }
  }
  if (!active && !url && !busy) return null
  return <View style={{ paddingHorizontal: 24, paddingVertical: 8, gap: 6 }}>
    {active && <Pressable accessibilityRole="button" disabled={busy} onPress={() => void (recording ? finish() : start())}>
      <Text style={{ color: C.amber, fontSize: 15 }}>{recording ? 'Stop recording' : 'Record training sample (30 seconds)'}</Text>
    </Pressable>}
    {!!message && <Text style={{ color: C.text, fontSize: 12 }}>{message}</Text>}
    {url && !recording && <Pressable accessibilityRole="button" onPress={() => void (Platform.OS === 'android' ? NativeModules.AudioInput.shareCarSample(url) : Share.share({ url })).catch((error: unknown) => setMessage(String(error)))}>
      <Text style={{ color: C.amber, fontSize: 15 }}>Share training WAV</Text>
    </Pressable>}
  </View>
}

import React, { useEffect, useRef, useState } from 'react'
import { AppState, Linking, ScrollView, Text, View } from 'react-native'
import { GlassSurface, PrimaryAction } from '@singz/ui/native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { MultitrackEngine } from '../engine'
import { midiNoteName, TRAINING_SOUNDS, type TrainingSound } from '../gen/training-lib'
import { Bar, C, Chip } from './bits'
import { TEST } from './testhooks'
import { t } from '../i18n'

export function TrainingSoundLab({ engine, active, onBack }: { engine: MultitrackEngine; active: boolean; onBack: () => void }): React.JSX.Element {
  const insets = useSafeAreaInsets()
  const [instrument, setInstrument] = useState<TrainingSound>('piano')
  const [midi, setMidi] = useState(60)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef(0)
  const mounted = useRef(true)
  const stop = () => { generation.current++; engine.cancelTrainingCues() }
  useEffect(() => {
    mounted.current = true
    const subscription = AppState.addEventListener('change', state => { if (state !== 'active') stop() })
    return () => { mounted.current = false; subscription.remove(); stop() }
  }, [engine])
  useEffect(() => { if (!active) stop() }, [active])
  const play = async (phrase: boolean) => {
    if (busy || !active) return
    stop()
    const run = generation.current
    setBusy(true); setError('')
    const notes = phrase ? [midi, midi <= 80 ? midi + 4 : midi - 4, midi] : [midi]
    try {
      const result = await engine.playTrainingCues([{ articulation: 'sequence', notes, durationSeconds: 2.2 }], [], instrument)
      if (!result.ok) throw new Error(result.error)
    } catch (failure) { if (mounted.current && generation.current === run) setError(String(failure)) }
    finally { if (mounted.current) setBusy(false) }
  }
  useEffect(() => {
    if (!TEST) return
    TEST.soundLabPlay = play
    TEST.soundLabConfigure = (sound: TrainingSound, note: number) => { stop(); setInstrument(sound); setMidi(Math.max(36, Math.min(84, Math.round(note)))) }
    TEST.soundLabStop = stop
    TEST.soundLabState = { instrument, midi, busy, error }
    return () => { if (TEST) { delete TEST.soundLabPlay; delete TEST.soundLabConfigure; delete TEST.soundLabStop; delete TEST.soundLabState } }
  }, [instrument, midi, busy, error])
  const copy = { color: C.dim, fontSize: 16 }
  return <ScrollView contentContainerStyle={{ padding: 20, paddingTop: insets.top + 12, gap: 18, paddingBottom: 40 }}>
    <Chip active={false} label={t('phone.training.soundLabBack')} onPress={onBack} />
    <Text style={{ color: C.text, fontSize: 32, fontWeight: '900' }}>{t('phone.training.soundLabTitle')}</Text>
    <Text style={copy}>{t('phone.training.soundLabHelp')}</Text>
    <GlassSurface radius={26} style={{ padding: 22, gap: 18 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>{TRAINING_SOUNDS.map(sound => <Chip key={sound} label={t(`phone.training.sound.${sound}`)} active={instrument === sound} onPress={() => { stop(); setInstrument(sound) }} />)}</View>
      <Text style={{ color: C.amber, fontSize: 64, fontWeight: '900' }}>{midiNoteName(midi, { tonicPc: 0, mode: 'major' })}</Text>
      <Bar value={(midi - 36) / 48} color={C.amber} label={t('phone.training.soundLabPitch')} valueText={v => midiNoteName(36 + Math.round(v * 48), { tonicPc: 0, mode: 'major' })} onChange={value => { stop(); setMidi(36 + Math.round(value * 48)) }} />
      <PrimaryAction disabled={busy} label={t(busy ? 'phone.training.soundLabLoading' : 'phone.training.soundLabPlay')} onPress={() => void play(false)} />
      <Chip active={false} label={t('phone.training.soundLabPhrase')} onPress={() => void play(true)} />
      <Chip active={false} label={t('phone.training.soundLabStop')} onPress={stop} />
      {!!error && <Text style={copy}>{error}</Text>}
    </GlassSurface>
    <Text style={copy}>FluidR3 GM · Frank Wen and S. Christian Collins · CC BY 3.0</Text>
    <Text accessibilityRole="link" style={copy} onPress={() => void Linking.openURL('https://creativecommons.org/licenses/by/3.0/')}>creativecommons.org/licenses/by/3.0</Text>
  </ScrollView>
}

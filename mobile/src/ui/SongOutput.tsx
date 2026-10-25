import React, { useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native'
import type { PlaybackBackend } from '../playback/backend'
import { formatSongVolume, songVolumeFromDb, songVolumeToDb } from '../../../src/shared/song-volume'
import { Bar, C, SpeakerGlyph } from './bits'
import { KIT } from './tokens'
import { t } from '../i18n'

interface Reading { peakDb: number; clipped: boolean; available: boolean }
/** A small shared store keeps 10 Hz meter updates out of the lyric screen's
 * React tree. It reads four scalars, never the full playback/device status. */
export class SongOutputMonitor {
  private reading: Reading = { peakDb: -Infinity, clipped: false, available: false }
  private listeners = new Set<() => void>()
  private timer: ReturnType<typeof setInterval> | null = null
  private previousCount = 0
  private generation = 0
  private enabled = true
  constructor(private readonly backend: PlaybackBackend) {}
  setActive(active: boolean): void { this.enabled = active }
  snapshot = (): Reading => this.reading
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    if (!this.timer) this.timer = setInterval(() => this.tick(), 100)
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0 && this.timer) { clearInterval(this.timer); this.timer = null }
    }
  }
  private publish(next: Reading): void {
    if (next.peakDb === this.reading.peakDb && next.clipped === this.reading.clipped && next.available === this.reading.available) return
    this.reading = next
    this.listeners.forEach(listener => listener())
  }
  private tick(): void {
    if (!this.enabled || AppState.currentState !== 'active') return
    if (!this.backend.playing) { this.publish({ ...this.reading, peakDb: -Infinity }); return }
    const meter = this.backend.readOutputMeter()
    if (!meter.available) { this.publish({ ...this.reading, available: false }); return }
    const changed = meter.generation !== this.generation || meter.clippedBlocks !== this.previousCount
    this.generation = meter.generation
    this.previousCount = meter.clippedBlocks
    const db = songVolumeToDb(meter.peak)
    this.publish({ peakDb: Number.isFinite(db) ? Math.round(db * 10) / 10 : -Infinity,
      clipped: this.reading.clipped || (changed && meter.clippedBlocks > 0), available: true })
  }
  reset(): void {
    const meter = this.backend.readOutputMeter()
    if (meter.available) { this.previousCount = meter.clippedBlocks; this.generation = meter.generation }
    this.publish({ ...this.reading, clipped: false })
  }
}
function useReading(monitor: SongOutputMonitor): Reading {
  return useSyncExternalStore(monitor.subscribe, monitor.snapshot, monitor.snapshot)
}
function PeakBar({ db, mini = false, clipped = false }: { db: number; mini?: boolean; clipped?: boolean }): React.JSX.Element {
  const [width, setWidth] = useState(0)
  const pixels = Math.round(Math.max(0, Math.min(1, (db + 60) / 60)) * width)
  const segments = useMemo(() => Array.from({ length: mini ? 12 : 40 }, (_, i) => <View key={i} style={{ flex: 1, height: '100%', borderRadius: 1,
    backgroundColor: i >= (mini ? 11 : 38) ? KIT.danger : i >= (mini ? 10 : 34) ? C.amber : KIT.success }} />), [mini])
  return <View style={[s.meter, mini && s.miniMeter]} onLayout={e => setWidth(Math.round(e.nativeEvent.layout.width))}>
    {mini && <View pointerEvents="none" style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, flexDirection: 'row', gap: 1 }}>
      {Array.from({ length: 12 }, (_, i) => <View key={i} style={{ flex: 1, borderRadius: 1, backgroundColor: clipped ? KIT.danger : C.faint, opacity: clipped ? 0.75 : 0.5 }} />)}
    </View>}
    <View style={{ width: pixels, height: '100%', overflow: 'hidden' }}>
      <View style={{ width, height: '100%', flexDirection: 'row', gap: mini ? 1 : 2 }}>
        {segments}
      </View>
    </View>
  </View>
}
export function SongOutputMeterButton({ monitor, gain, onPress }: { monitor: SongOutputMonitor; gain: number; onPress: () => void }): React.JSX.Element {
  const reading = useReading(monitor)
  return <Pressable testID="song-output-open" onPress={onPress} hitSlop={{ top: 6, bottom: 6 }} accessibilityRole="button" accessibilityLabel={`${t('phone.player.output.title')}, ${formatSongVolume(gain)}${reading.clipped ? `, ${t('phone.player.output.clip')}` : ''}`} style={s.meterButton}>
    <PeakBar db={reading.available ? reading.peakDb : -Infinity} mini clipped={reading.clipped} />
  </Pressable>
}
export function SongOutputControls({ monitor, gain, onGain, onCommit, saveState }: {
  monitor: SongOutputMonitor; gain: number; onGain: (gain: number) => void; onCommit: (gain: number) => void
  saveState: 'saved' | 'saving' | 'failed'
}): React.JSX.Element {
  const reading = useReading(monitor)
  const previous = useRef(1)
  if (gain > 0) previous.current = gain
  const db = Math.max(-60, songVolumeToDb(gain))
  const value = (fraction: number): number => songVolumeFromDb(Math.round((-60 + fraction * 72) * 2) / 2)
  return <View style={s.body}>
    <Text style={s.sectionTitle}>{t('phone.player.output.title')}</Text>
    <View style={s.gainRow}>
      <Pressable testID="song-output-mute" style={s.mute} accessibilityRole="button" accessibilityLabel={t('phone.player.output.mute')} accessibilityState={{ selected: gain === 0 }} onPress={() => onCommit(gain > 0 ? 0 : previous.current)}>
        <SpeakerGlyph color={gain > 0 ? C.text : C.amber} slashed={gain === 0} />
      </Pressable>
      <Text testID="song-output-gain" style={s.gain} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>{formatSongVolume(gain).replace(' dB', '')}<Text style={s.unit}> dB</Text></Text>
      <Pressable testID="song-output-reset" style={s.reset} accessibilityRole="button" onPress={() => onCommit(1)}><Text style={s.resetText}>{t('phone.player.output.reset')}</Text></Pressable>
    </View>
    <Bar value={(db + 60) / 72} onChange={v => onGain(value(v))} onCommit={v => onCommit(value(v))} color={C.amber} height={44}
      label={t('phone.player.output.title')} valueText={v => formatSongVolume(value(v))} />
    <View style={s.gainScale}>{['−∞', '−36', '−12', '0', '+12'].map((label, i) => <Text key={label} style={[s.tick,
      { left: `${[0, 33.33, 66.67, 83.33, 100][i]}%`, transform: [{ translateX: i === 0 ? 0 : i === 4 ? -24 : -8 }] }, i === 3 && { color: C.amber }]}>{label}</Text>)}</View>
    <View style={s.meterBlock}>
      <View style={s.meterHead}>
        <Text style={s.label}>{t('phone.player.output.peak')}</Text>
        <Text testID="song-output-peak" style={s.peakValue}>{reading.available ? formatSongVolume(Number.isFinite(reading.peakDb) ? 10 ** (reading.peakDb / 20) : 0).replace(' dB', '') : '—'}<Text style={s.peakUnit}> dBFS</Text></Text>
        <Pressable testID="song-output-clip" accessibilityRole="button" accessibilityState={{ selected: reading.clipped }} accessibilityLabel={t('phone.player.output.resetClip')} onPress={() => monitor.reset()} style={s.clip}>
          <View style={[s.led, reading.clipped && { backgroundColor: KIT.danger }]} /><Text style={[s.clipText, reading.clipped && { color: KIT.danger }]}>{t('phone.player.output.clip')}</Text>
        </Pressable>
      </View>
      <PeakBar db={reading.available ? reading.peakDb : -Infinity} />
      <View style={s.meterScale}>{['−60', '−36', '−18', '−6', '0'].map((label, i) => <Text key={label} style={[s.scaleText, { left: `${[0, 40, 70, 90, 100][i]}%`, transform: [{ translateX: i === 0 ? 0 : i === 4 ? -6 : -10 }] }]}>{label}</Text>)}</View>
    </View>
    {reading.clipped && <Text style={s.hint}>{t('phone.player.output.clippedHint')}</Text>}
    <Text testID="song-output-save-state" style={[s.saved, saveState === 'failed' && { color: KIT.danger }]}>{saveState === 'saving' ? t('phone.player.output.saving') : saveState === 'failed' ? t('phone.player.output.saveFailed') : `✓  ${t('phone.player.output.saved')}`}</Text>
  </View>
}
const s = StyleSheet.create({
  meterButton: { flex: 1, minWidth: 44, height: 32, justifyContent: 'center', marginHorizontal: 10 },
  led: { width: 5, height: 5, borderRadius: 2, backgroundColor: C.faint },
  body: { paddingTop: 4, paddingBottom: 16, marginBottom: 12, borderBottomWidth: 1, borderBottomColor: C.hairline }, sectionTitle: { color: C.text, fontSize: 13, fontWeight: '600', marginBottom: 8 },
  gainRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 2 },
  mute: { width: 44, height: 44, borderRadius: 22, borderWidth: 1, borderColor: C.hairline, alignItems: 'center', justifyContent: 'center' },
  gain: { color: C.text, fontSize: 28, fontWeight: '400', letterSpacing: -1.5, fontVariant: ['tabular-nums'], flexShrink: 1 },
  unit: { color: C.dim, fontSize: 14, letterSpacing: 0 }, reset: { marginLeft: 'auto', minHeight: 44, flexShrink: 1, justifyContent: 'center', paddingLeft: 8 },
  resetText: { color: C.dim, fontSize: 13 }, gainScale: { height: 20, position: 'relative', marginHorizontal: 6 },
  tick: { position: 'absolute', color: C.dim, fontSize: 11 }, meterBlock: { marginTop: 4, paddingTop: 2 },
  meterHead: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 4 }, label: { color: C.dim, fontSize: 12 },
  peakValue: { marginLeft: 'auto', color: C.text, fontSize: 12, fontVariant: ['tabular-nums'] }, peakUnit: { color: C.dim, fontSize: 11 },
  clip: { minHeight: 44, minWidth: 49, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5 }, clipText: { color: C.dim, fontSize: 11 },
  meter: { height: 16, borderRadius: 3, overflow: 'hidden', backgroundColor: KIT.panelDeep }, miniMeter: { width: '100%', height: 7 },
  meterScale: { position: 'relative', height: 14, marginTop: 8 }, scaleText: { position: 'absolute', color: C.dim, fontSize: 11 },
  hint: { color: KIT.danger, fontSize: 12, lineHeight: 18, marginTop: 8 }, saved: { color: C.dim, fontSize: 11, marginTop: 8 }
})

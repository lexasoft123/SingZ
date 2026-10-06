import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Animated, Easing, StyleSheet, Text, View } from 'react-native'
import { GlassSurface, useNativeTheme, type PitchMeterProps, type PitchMeterLabels } from '@singz/ui/native'

// Keep the shared kit layout, with native transform animations between microphone samples.
const METER_LABELS: PitchMeterLabels = {
  flat: 'Flat',
  sharp: 'Sharp',
  youAreSinging: 'You are singing',
  progress: (instruction, percent) => `${instruction}. ${percent} percent complete.`
}

export const SmoothPitchMeter = React.memo(function SmoothPitchMeter(props: PitchMeterProps & { compact?: boolean }): React.JSX.Element {
  const theme = useNativeTheme()
  const L = { ...METER_LABELS, ...props.labels }
  const x = props.cents === null ? 50 : Math.max(6, Math.min(94, 50 + props.cents * 0.8))
  const [width, setWidth] = useState(0)
  const position = useRef(new Animated.Value(x / 100)).current
  const progress = useRef(new Animated.Value(0)).current
  const hadPitch = useRef(false)
  useEffect(() => {
    // Resume at the new reading after silence; never sweep through invented pitches.
    const animation = props.cents !== null && hadPitch.current
      ? Animated.timing(position, { toValue: x / 100, duration: 80, easing: Easing.linear, useNativeDriver: true, isInteraction: false })
      : null
    if (animation) animation.start()
    else position.setValue(x / 100)
    hadPitch.current = props.cents !== null
    return () => animation?.stop()
  }, [position, x, props.cents === null])
  useEffect(() => {
    if (props.progress >= 1 || props.progress <= 0) {
      progress.setValue(Math.max(0, Math.min(1, props.progress)))
      return
    }
    const animation = Animated.timing(progress, {
      toValue: Math.max(0, Math.min(1, props.progress)), duration: 80,
      easing: Easing.linear, useNativeDriver: true, isInteraction: false
    })
    animation.start()
    return () => animation.stop()
  }, [progress, props.progress])
  const markerTranslation = useMemo(() => Animated.multiply(position, width), [position, width])
  const fillTranslation = useMemo(() => Animated.multiply(Animated.subtract(progress, 1), width / 2), [progress, width])
  return (
    <View style={s.meterWrap}>
      <View style={s.meterLabels}><Text style={[s.meterEdge, { color: theme.dim }]}>{L.flat.toLocaleUpperCase()}</Text><Text style={[s.meterCenterLabel, { color: theme.accent }]}>±{props.pitchWindowCents}¢</Text><Text style={[s.meterEdge, { color: theme.dim }]}>{L.sharp.toLocaleUpperCase()}</Text></View>
      <GlassSurface radius={30} elevation="none" accessibilityLabel={props.accessibilityReading ?? props.reading} style={[s.meter, props.compact && { height: 48 }]} onLayout={event => setWidth(event.nativeEvent.layout.width)}>
        <View style={[s.targetZone, { left: `${50 - props.pitchWindowCents * 0.8}%`, width: `${props.pitchWindowCents * 1.6}%`, backgroundColor: theme.accentSoft }]} />
        <View style={[s.meterCenter, { backgroundColor: theme.accent }]} />
        {props.cents !== null && <Animated.View style={[s.pitchMarker, props.compact && { top: 8, width: 32, height: 32, marginLeft: -16, borderRadius: 16 }, { left: 0, transform: [{ translateX: markerTranslation }], backgroundColor: props.centered ? theme.accent : theme.text, borderColor: props.centered ? theme.text : theme.lineStrong, shadowColor: theme.accent }]} />}
      </GlassSurface>
      <View style={s.livePitchRow}><View><Text style={[s.livePitchLabel, { color: theme.dim }]}>{L.youAreSinging.toLocaleUpperCase()}</Text><Text accessibilityLiveRegion="polite" style={[s.livePitchNote, props.compact && { fontSize: 28, lineHeight: 32 }, { color: theme.text }]}>{props.detectedNote ?? '—'}</Text></View><Text style={[s.meterReading, { color: theme.text }]}>{props.reading}</Text></View>
      <View accessibilityLabel={L.progress(props.instruction, Math.round(props.progress * 100))} style={[s.progressTrack, { backgroundColor: theme.line }]}><Animated.View style={[s.progressFill, { width: '100%', transform: [{ translateX: fillTranslation }, { scaleX: progress }], backgroundColor: theme.accent }]} /></View>
      <Text style={[s.meterHint, { color: theme.dim }]}>{props.hint}</Text>
    </View>
  )
})

const s = StyleSheet.create({
  meterWrap: { flex: 1, width: '100%', justifyContent: 'center', gap: 5, paddingBottom: 4 },
  meterLabels: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 8 },
  meterEdge: { fontSize: 12, fontWeight: '900', letterSpacing: 1.2 },
  meterCenterLabel: { fontSize: 12, fontWeight: '900', letterSpacing: 1.2 },
  meter: { width: '100%', height: 96, overflow: 'hidden' },
  targetZone: { position: 'absolute', top: 0, bottom: 0 },
  meterCenter: { position: 'absolute', left: '50%', top: 0, bottom: 0, width: 2 },
  pitchMarker: { position: 'absolute', top: 26, width: 44, height: 44, marginLeft: -22, borderRadius: 22, borderWidth: 4, shadowOpacity: 0.75, shadowRadius: 14 },
  livePitchRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 10 },
  livePitchLabel: { fontSize: 11, lineHeight: 14, fontWeight: '900', letterSpacing: 1.4 },
  livePitchNote: { fontSize: 38, lineHeight: 42, fontWeight: '900', letterSpacing: -1 },
  meterReading: { flex: 1, fontSize: 16, lineHeight: 21, fontWeight: '900', textAlign: 'right', marginLeft: 16 },
  progressTrack: { width: '100%', height: 8, borderRadius: 4, overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: 4 },
  meterInstruction: { fontSize: 18, lineHeight: 24, fontWeight: '900', textAlign: 'center', paddingHorizontal: 12 },
  meterHint: { fontSize: 12, lineHeight: 17, textAlign: 'center', paddingHorizontal: 12 },
})

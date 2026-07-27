import React, { useCallback, useRef } from 'react'
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent
} from 'react-native'

/** Design-language constants (matches the approved HTML prototype). */
export const C = {
  bg: '#0d0a06',
  text: '#eee6d6',
  bright: '#ffffff',
  dim: 'rgba(255,255,255,0.5)',
  faint: 'rgba(255,255,255,0.35)',
  amber: '#f2c14e',
  amberInk: '#1d1508',
  red: '#e2574c',
  sheet: 'rgba(32,25,15,0.98)',
  hairline: 'rgba(255,255,255,0.09)',
  btnBg: 'rgba(255,255,255,0.10)'
}

export const STEM_TILE_COLORS: string[][] = [
  ['#ff5d66', '#f2c14e', '#7a9bff', '#45d6b5'],
  ['#7a9bff', '#ff5d66', '#45d6b5', '#b48ead'],
  ['#e0873f', '#45d6b5', '#f2c14e', '#ff5d66']
]
const TILE_WIDTHS = ['100%', '72%', '88%', '60%'] as const

/** Mini artwork: four stem lanes, hue-rotated per project. */
export function StemTile({ hue, size }: { hue: number; size: number }): React.JSX.Element {
  const colors = STEM_TILE_COLORS[hue % STEM_TILE_COLORS.length]
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.23,
        backgroundColor: '#17110a',
        justifyContent: 'center',
        gap: size * 0.062,
        paddingHorizontal: size * 0.18
      }}
    >
      {colors.map((c, i) => (
        <View
          key={i}
          style={{ height: size * 0.07, borderRadius: 3, backgroundColor: c, width: TILE_WIDTHS[i] }}
        />
      ))}
    </View>
  )
}

/** Mixer glyph (three slider rails with knobs), drawn with plain views. */
export function MixGlyph({ color = 'rgba(255,255,255,0.85)' }: { color?: string }): React.JSX.Element {
  const knob = (top: number): object => ({
    position: 'absolute',
    top,
    left: -3.5,
    width: 9,
    height: 9,
    borderRadius: 5,
    borderWidth: 2,
    borderColor: color,
    backgroundColor: 'transparent'
  })
  return (
    <View style={{ width: 22, height: 20, flexDirection: 'row', justifyContent: 'space-between' }}>
      {[5, 9, 3].map((k, i) => (
        <View key={i} style={{ width: 2, backgroundColor: color, borderRadius: 1 }}>
          <View style={knob(k)} />
        </View>
      ))}
    </View>
  )
}

export function RoundBtn({
  size = 47,
  onPress,
  children,
  bg = C.btnBg
}: {
  size?: number
  onPress: () => void
  children: React.ReactNode
  bg?: string
}): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => ({
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: pressed ? 'rgba(255,255,255,0.22)' : bg,
        alignItems: 'center',
        justifyContent: 'center'
      })}
    >
      {children}
    </Pressable>
  )
}

export function Chip({
  label,
  active,
  activeColor = C.amber,
  onPress,
  disabled
}: {
  label: string
  active: boolean
  activeColor?: string
  onPress: () => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={6}
      style={[
        b.chip,
        active && { backgroundColor: activeColor, borderColor: activeColor },
        disabled && { opacity: 0.4 }
      ]}
    >
      <Text style={[b.chipText, active && { color: C.amberInk }]}>{label}</Text>
    </Pressable>
  )
}

export function Stepper({
  label,
  valueText,
  onStep,
  suffix
}: {
  label: string
  valueText: string
  onStep: (dir: 1 | -1) => void
  suffix?: string
}): React.JSX.Element {
  return (
    <View style={b.stepRow}>
      <Text style={b.stepLabel}>{label}</Text>
      <Pressable style={b.stepBtn} hitSlop={6} onPress={() => onStep(-1)}>
        <Text style={b.stepBtnText}>−</Text>
      </Pressable>
      <Text style={b.stepValue}>{valueText}</Text>
      <Pressable style={b.stepBtn} hitSlop={6} onPress={() => onStep(1)}>
        <Text style={b.stepBtnText}>+</Text>
      </Pressable>
      {suffix ? <Text style={b.stepSuffix}>{suffix}</Text> : null}
    </View>
  )
}

/**
 * Horizontal drag/tap bar. onChange per move (cheap preview / volume);
 * onCommit once at finger-up — expensive actions belong there.
 */
export function Bar({
  value,
  onChange,
  onCommit,
  color,
  height = 22,
  track = 'rgba(255,255,255,0.16)'
}: {
  value: number
  onChange: (v: number) => void
  onCommit?: (v: number) => void
  color: string
  height?: number
  track?: string
}): React.JSX.Element {
  const width = useRef(1)
  const last = useRef(0)
  const handle = useCallback(
    (e: GestureResponderEvent) => {
      const v = Math.max(0, Math.min(1, e.nativeEvent.locationX / width.current))
      last.current = v
      onChange(v)
    },
    [onChange]
  )
  const commit = useCallback(() => {
    onCommit?.(last.current)
  }, [onCommit])
  return (
    <View
      style={{ height: Math.max(height, 22), justifyContent: 'center' }}
      onLayout={(e: LayoutChangeEvent) => {
        width.current = Math.max(1, e.nativeEvent.layout.width)
      }}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderGrant={handle}
      onResponderMove={handle}
      onResponderRelease={commit}
      onResponderTerminate={commit}
    >
      <View style={{ height: 5, borderRadius: 3, backgroundColor: track, overflow: 'hidden' }}>
        <View
          pointerEvents="none"
          style={{
            width: `${Math.max(0, Math.min(1, value)) * 100}%`,
            height: '100%',
            borderRadius: 3,
            backgroundColor: color
          }}
        />
      </View>
    </View>
  )
}

export const b = StyleSheet.create({
  chip: {
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.16)',
    borderRadius: 999,
    paddingHorizontal: 14,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent'
  },
  chipText: { color: 'rgba(255,255,255,0.6)', fontSize: 13.5, fontWeight: '700' },
  stepRow: { flexDirection: 'row', alignItems: 'center', gap: 13, marginTop: 12 },
  stepLabel: { color: C.text, fontSize: 14.5, width: 56 },
  stepBtn: {
    width: 33,
    height: 33,
    borderRadius: 17,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center',
    justifyContent: 'center'
  },
  stepBtnText: { color: C.text, fontSize: 17, fontWeight: '700' },
  stepValue: {
    color: C.text,
    fontSize: 16,
    fontWeight: '700',
    minWidth: 52,
    textAlign: 'center',
    fontVariant: ['tabular-nums']
  },
  stepSuffix: { color: C.faint, fontSize: 12.5 },
  sheetWrap: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: {
    backgroundColor: C.sheet,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingHorizontal: 22,
    paddingBottom: 34,
    maxHeight: '80%'
  },
  grab: {
    width: 40,
    height: 5,
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.25)',
    alignSelf: 'center',
    marginTop: 10,
    marginBottom: 14
  },
  sheetTitle: { color: C.bright, fontSize: 19, fontWeight: '800', marginBottom: 14, letterSpacing: -0.2 },
  sec: { borderTopWidth: 1, borderTopColor: C.hairline, paddingVertical: 15 },
  secFirst: { borderTopWidth: 0, paddingTop: 2 },
  secLab: {
    color: C.dim,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 11
  },
  segs: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  hint: { color: 'rgba(255,255,255,0.38)', fontSize: 12.5, marginTop: 10, lineHeight: 18 }
})

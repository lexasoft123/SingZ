import React from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { C, MicGlyph } from './bits'

export type RootTab = 'songs' | 'training'

export default function BottomTabs({
  active,
  onChange
}: {
  active: RootTab
  onChange: (tab: RootTab) => void
}): React.JSX.Element {
  const insets = useSafeAreaInsets()
  return (
    <View style={[styles.shell, { paddingBottom: Math.max(6, insets.bottom) }]} accessibilityRole="tablist">
      <Tab label="Songs" selected={active === 'songs'} onPress={() => onChange('songs')} icon="songs" />
      <Tab label="Train" selected={active === 'training'} onPress={() => onChange('training')} icon="train" />
    </View>
  )
}

function Tab({ label, selected, onPress, icon }: { label: string; selected: boolean; onPress: () => void; icon: 'songs' | 'train' }): React.JSX.Element {
  const color = selected ? C.amber : C.dim
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.tab, selected && styles.selected, pressed && styles.pressed]}
    >
      {icon === 'train' ? <MicGlyph color={color} /> : <SongGlyph color={color} />}
      <Text style={[styles.label, { color }]}>{label}</Text>
    </Pressable>
  )
}

function SongGlyph({ color }: { color: string }): React.JSX.Element {
  return (
    <View style={{ width: 19, height: 19 }}>
      {[2, 8, 14].map((left, index) => (
        <View key={left} style={{ position: 'absolute', left, top: 3 + index * 2, width: 3, height: 12 - index * 2, borderRadius: 2, backgroundColor: color }} />
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  shell: {
    minHeight: 58,
    flexDirection: 'row',
    paddingTop: 5,
    paddingHorizontal: 20,
    gap: 12,
    backgroundColor: '#100e0b',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.hairline
  },
  tab: { flex: 1, minHeight: 46, borderRadius: 15, alignItems: 'center', justifyContent: 'center', gap: 2 },
  selected: { backgroundColor: 'rgba(255,160,40,0.09)' },
  pressed: { opacity: 0.72 },
  label: { fontSize: 11, fontWeight: '800', letterSpacing: 0.4 }
})

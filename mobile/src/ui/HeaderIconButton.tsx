import React from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { white } from './bits'

/** Compact header artwork with a full-size, accessible touch target. */
export function HeaderIconButton({ label, onPress, children }: {
  label: string
  onPress: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return <Pressable accessibilityRole="button" accessibilityLabel={label}
    onPress={onPress} style={styles.target}>
    {({ pressed }) => <View pointerEvents="none" style={[styles.surface, pressed && styles.pressed]}>{children}</View>}
  </Pressable>
}
const styles = StyleSheet.create({
  target: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  surface: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  pressed: { backgroundColor: white(0.13) }
})

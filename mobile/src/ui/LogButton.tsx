import React from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { t } from '../i18n'
import { C, LyricsGlyph, white } from './bits'

/** Shared, labelled icon action for the app's single log viewer. */
export function LogButton({ onPress }: { onPress: () => void }): React.JSX.Element {
  return <Pressable accessibilityRole="button" accessibilityLabel={t('phone.library.openLog')}
    hitSlop={8} onPress={onPress} style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
    <View pointerEvents="none" style={styles.document}><LyricsGlyph color={C.amber} /></View>
  </Pressable>
}
const styles = StyleSheet.create({
  button: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: white(0.05), borderWidth: 1, borderColor: white(0.12) },
  pressed: { backgroundColor: white(0.13) },
  document: { width: 19, height: 23, borderWidth: 1.4, borderRadius: 3, borderColor: C.amber, alignItems: 'center', justifyContent: 'center' }
})

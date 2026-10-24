import React from 'react'
import { StyleSheet, View } from 'react-native'
import { t } from '../i18n'
import { HeaderIconButton } from './HeaderIconButton'
import { C, LyricsGlyph } from './bits'

/** Shared, labelled icon action for the app's single log viewer. */
export function LogButton({ onPress }: { onPress: () => void }): React.JSX.Element {
  return <HeaderIconButton label={t('phone.library.openLog')} onPress={onPress}>
    <View style={styles.document}><LyricsGlyph color={C.amber} /></View>
  </HeaderIconButton>
}
const styles = StyleSheet.create({
  document: { width: 18, height: 21, borderWidth: 1.5, borderRadius: 3, borderColor: C.amber, alignItems: 'center', justifyContent: 'center' }
})

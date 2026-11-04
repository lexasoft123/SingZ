import React, { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { useNativeTheme } from '@singz/ui/native'
import { MELODY_LEVELS, type MelodyLevel } from '../gen/training-lib'
import { t } from '../i18n'

export function MelodyLevelSelector({ value, onChange }: { value: MelodyLevel; onChange: (value: MelodyLevel) => void }): React.JSX.Element {
  const theme = useNativeTheme()
  const [expanded, setExpanded] = useState(false)
  return <View style={{ gap: 10, marginBottom: 18 }}>
    <Text style={{ color: theme.dim, fontSize: 13, fontWeight: '700' }}>{t('phone.training.melodyLevel')}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel={t('phone.training.melodyLevel')} accessibilityState={{ expanded }} onPress={() => setExpanded(!expanded)} style={{ flexDirection: 'row', alignItems: 'center', minHeight: 44 }}>
      <Text style={{ color: theme.text, flex: 1, fontSize: 18, fontWeight: '800' }}>{MELODY_LEVELS.indexOf(value)+1}. {t(`phone.training.melodyLevel.${value}`)}</Text>
      <Text style={{ color: theme.accent, fontSize: 22 }}>{expanded ? '⌃' : '⌄'}</Text>
    </Pressable>
    {expanded && MELODY_LEVELS.map((level, i) => <Pressable key={level} accessibilityRole="button" accessibilityState={{ selected: level === value }} onPress={() => { onChange(level); setExpanded(false) }} style={{ minHeight: 44, padding: 10, borderRadius: 12, backgroundColor: level === value ? theme.accentSoft : theme.panelDeep }}><Text style={{ color: level === value ? theme.accent : theme.text, fontSize: 16 }}>{i+1}. {t(`phone.training.melodyLevel.${level}`)}</Text></Pressable>)}
    <Text style={{ color: theme.dim, fontSize: 14, lineHeight: 19 }}>{t(`phone.training.melodyLevel.${value}.help`)}</Text>
  </View>
}

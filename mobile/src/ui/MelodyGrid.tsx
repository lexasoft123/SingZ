import React, { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useNativeTheme } from '@singz/ui/native'
import { melodyGrid, signedMelodyInterval, type TrainingPrompt } from '../gen/training-lib'
import { t } from '../i18n'

export function MelodyGrid({ prompt, activeTarget, matchedCount }: { prompt: TrainingPrompt; activeTarget: number; matchedCount: number }): React.JSX.Element {
  const theme = useNativeTheme()
  const [width, setWidth] = useState(280)
  const grid = melodyGrid(prompt), plotWidth = Math.max(1, width - 44)
  const x = (v: number) => 40 + v * plotWidth, y = (v: number) => 28 + v * 100
  return <View testID="melody-grid" onLayout={e => setWidth(e.nativeEvent.layout.width)} style={{ width: '100%' }}>
    <View style={{ height: 150 }}>
      {grid.rows.map(row => <View key={row.midi} style={[s.row, { top: y(row.y)-7 }]}><Text style={[s.rowLabel, { color: theme.dim }]}>{row.label}</Text><View style={{ flex: 1, height: 1, backgroundColor: theme.text, opacity: row.label ? .14 : .06 }} /></View>)}
      {grid.notes.map((note, i) => {
        const prev = grid.notes[i-1], dx = prev ? x(note.x) - x(prev.x) : 0, dy = prev ? y(note.y) - y(prev.y) : 0
        const done = i < matchedCount
        return <React.Fragment key={i}>
          <View style={{ position: 'absolute', left: x(note.x), top: 22, height: 114, borderLeftWidth: 1, borderStyle: 'dashed', borderColor: theme.line }} />
          {prev && <><View style={{ position: 'absolute', left: (x(note.x)+x(prev.x))/2 - Math.hypot(dx,dy)/2, top: (y(note.y)+y(prev.y))/2, width: Math.hypot(dx,dy), height: 2, backgroundColor: theme.accent, opacity: .3, transform: [{ rotate: `${Math.atan2(dy, dx)}rad` }] }} /><Text style={[s.interval, { left: (x(note.x)+x(prev.x))/2 - 18, color: theme.dim }]}>{signedMelodyInterval(note.interval!)}</Text></>}
          <View testID={`melody-note-${i}`} accessibilityLabel={`${note.noteName}, ${done ? t('phone.training.noteLocked') : i === activeTarget ? t('phone.training.currentTarget') : i+1}`} style={[s.ring, { left: x(note.x)-17, top: y(note.y)-17, borderColor: i === activeTarget && !done ? theme.accent : 'transparent' }]}><View style={[s.dot, { backgroundColor: done ? '#ffce45' : theme.panelDeep, borderColor: done ? '#ffce45' : theme.dim }]}>{done && <Text style={s.check}>✓</Text>}</View></View>
          <Text style={[s.number, { left: x(note.x)-12, color: theme.dim }]}>{i+1}</Text>
        </React.Fragment>
      })}
    </View><Text style={{ color: theme.dim, fontSize: 12 }}>{t('phone.training.melodyGridCaption')}</Text>
  </View>
}
const s = StyleSheet.create({
  row: { position: 'absolute', left: 0, right: 0, height: 14, flexDirection: 'row', alignItems: 'center' },
  rowLabel: { width: 36, marginRight: 4, fontSize: 10, textAlign: 'right' },
  ring: { position: 'absolute', width: 34, height: 34, borderWidth: 2, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  check: { color: '#241800', fontSize: 12, fontWeight: '800' },
  interval: { position: 'absolute', top: 4, width: 36, textAlign: 'center', fontSize: 12 },
  number: { position: 'absolute', top: 136, width: 24, textAlign: 'center', fontSize: 11 }
})

import React from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useNativeTheme } from '@singz/ui/native'
import { chordNameText, chordRoleWord, directionWord, intervalLabel, keyLabel, keyName, type TrainingPrompt } from '../gen/training-lib'
import { t } from '../i18n'

/** The lesson stays visible during both reference playback and singing. */
export function TrainingLessonOverview({ prompt, activeTarget, phrase, repetition }: {
  prompt: TrainingPrompt; activeTarget: number; phrase: boolean; repetition?: number
}): React.JSX.Element {
  const theme = useNativeTheme()
  const index = Math.max(0, Math.min(activeTarget, prompt.targets.length - 1))
  const target = prompt.targets[index]
  const notes = prompt.kind === 'chord-tone' ? prompt.chord.tones : prompt.targets
  const roles = [t('phone.training.roleRoot'), t('phone.training.roleThird'), t('phone.training.roleFifth')]
  const title = prompt.kind === 'interval' ? intervalLabel(prompt.intervalName)
    : prompt.kind === 'chord-tone' || prompt.kind === 'arpeggio' ? chordNameText(prompt.chord)
    : keyLabel(keyName(prompt.key))
  const description = prompt.kind === 'chord-tone'
    ? t('phone.training.chordSing', { note: target.noteName, role: chordRoleWord(prompt.role) })
    : prompt.kind === 'scale' ? t(phrase ? 'phone.training.scalePhraseHelp' : 'phone.training.scaleGuidedHelp')
    : prompt.kind === 'interval' ? t(prompt.taskMode === 'find' ? 'phone.training.intervalFindHelp' : 'phone.training.intervalStepHelp')
    : prompt.kind === 'arpeggio' ? t('phone.training.arpeggioStepHelp') : t('phone.training.singNamedNote', { note: target.noteName })
  const pitch = target.noteName.replace(/-?\d+$/, '')
  const octave = target.noteName.slice(pitch.length)
  return <View testID="training-lesson-overview" style={[s.overview, prompt.kind === 'scale' && s.scaleOverview]}>
    <View accessibilityLabel={`Target note ${target.noteName}`} style={s.heading}><Text style={[s.title, { color: theme.text }]}>{title}</Text>{'direction' in prompt && <Text style={[s.direction, { color: theme.dim }]}>{directionWord(prompt.direction)}</Text>}</View>
    <Text style={[s.description, prompt.kind === 'scale' && s.scaleDescription, { color: theme.text }]}>{description}</Text>
    {repetition !== undefined && <Text style={[s.direction, { color: theme.dim }]}>{t('phone.training.repeatN', { n: repetition })}</Text>}
    {notes.length > 1 && <View style={s.notes}>{notes.map((note, position) => {
      const selected = prompt.kind === 'chord-tone' ? note.pitchClass === target.pitchClass : position === index
      const done = (prompt.kind === 'note' || prompt.kind === 'scale-degree' || prompt.kind === 'scale') && position < index
      return <View key={`${note.noteName}:${position}`} testID={selected ? 'training-current-note' : undefined} accessibilityLabel={`${note.noteName}${selected ? `, ${t('phone.training.currentTarget')}` : ''}`} style={[s.note, notes.length > 4 && s.scaleNote, { backgroundColor: selected ? theme.accentSoft : done ? theme.line : theme.panelDeep, borderColor: selected ? theme.accent : done ? theme.lineStrong : theme.controlLine }]}>
        <Text style={[s.notePitch, notes.length > 4 && s.scalePitch, { color: theme.text }]}>{note.noteName.replace(/-?\d+$/, '')}<Text style={[s.octave, { color: theme.accent }]}>{note.noteName.match(/-?\d+$/)?.[0]}</Text></Text>
        <Text style={[s.role, { color: selected ? theme.accent : theme.dim }]}>{prompt.kind === 'chord-tone' || prompt.kind === 'arpeggio' ? roles[prompt.kind === 'arpeggio' && prompt.direction === 'descending' ? 2 - position : position] : prompt.kind === 'scale' ? ['Do', 'Di', 'Re', 'Me', 'Mi', 'Fa', 'Fi', 'Sol', 'Le', 'La', 'Te', 'Ti'][(note.pitchClass - prompt.key.tonicPc + 12) % 12] : t('phone.training.degreeN', { n: note.scaleDegree })}</Text>
      </View>
    })}</View>}
    {(prompt.kind === 'note' || prompt.kind === 'scale-degree' || prompt.kind === 'scale') && <View testID="single-note-target-area" style={s.target}><Text style={[s.targetPitch, prompt.kind === 'scale' && s.scaleTarget, { color: theme.text }]}>{pitch}<Text style={[s.targetOctave, { color: theme.accent }]}>{octave}</Text></Text><Text style={[s.targetDetail, { color: theme.dim }]}>{t('phone.training.noteOfTotal', { note: index + 1, total: notes.length })}</Text></View>}
  </View>
}
const s = StyleSheet.create({
  overview: { width: '100%', flex: 1, justifyContent: 'center', gap: 8, paddingVertical: 8, minHeight: 200 },
  scaleOverview: { minHeight: 226, gap: 6, paddingVertical: 4 },
  scaleDescription: { fontSize: 16, lineHeight: 21 },
  scaleTarget: { fontSize: 48, lineHeight: 52 },
  heading: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  title: { flex: 1, fontSize: 29, lineHeight: 34, fontWeight: '900', letterSpacing: -.6, textTransform: 'capitalize' },
  direction: { fontSize: 14, fontWeight: '700', textTransform: 'capitalize' },
  description: { fontSize: 18, lineHeight: 23, fontWeight: '600' },
  notes: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  note: { flex: 1, minHeight: 86, borderWidth: 1, borderRadius: 16, alignItems: 'center', justifyContent: 'center', gap: 8 },
  scaleNote: { flex: 0, width: '23%', minHeight: 48, gap: 2 },
  notePitch: { fontSize: 43, lineHeight: 50, fontWeight: '900', letterSpacing: -1 },
  scalePitch: { fontSize: 24, lineHeight: 28 },
  octave: { fontSize: 18, letterSpacing: 0 },
  role: { fontSize: 12, fontWeight: '700', textTransform: 'capitalize' },
  target: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  targetPitch: { fontSize: 60, lineHeight: 65, fontWeight: '900', letterSpacing: -3 },
  targetOctave: { fontSize: 33, letterSpacing: -1 },
  targetDetail: { fontSize: 15, fontWeight: '700' }
})

import React, { useState } from 'react'
import { Icon } from '@singz/ui/native/icons'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { ChoiceChip, GlassSurface, PrimaryAction, useNativeTheme } from '@singz/ui/native'
import { intervalLabel, type TrainingExerciseSelection } from '../gen/training-lib'
import { INTERVAL_LESSONS } from '../training/interval-plan'
import { selectTrainingProgramLevel, type ProgramLesson } from '../training/program'
import type { MobileTrainingPersistence } from '../training/persistence'
import { t } from '../i18n'
import { C, MicGlyph } from './bits'

export function programLessonLabel(lesson: ProgramLesson): string {
  if (lesson.semitones !== undefined) {
    const label = intervalLabel(INTERVAL_LESSONS[lesson.semitones - 1])
    return label.charAt(0).toUpperCase() + label.slice(1)
  }
  const key = ({ note: 'exerciseNoteTitle', interval: 'exerciseIntervalTitle', 'chord-tone': 'exerciseChordToneTitle', scale: 'exerciseScaleTitle', arpeggio: 'exerciseArpeggioTitle', 'scale-degree': 'exerciseScaleDegreeTitle', mixed: 'exerciseMixedTitle' } as const)[lesson.exercise]
  return t(`phone.training.${key}`)
}

export function PracticeWeek({ days, current }: { days: number; current?: number }): React.JSX.Element {
  const theme = useNativeTheme()
  return <View style={s.week}>{Array.from({ length: 7 }, (_, index) => <View key={index} style={s.day}>
    <View accessibilityLabel={t(index < days ? 'phone.training.dashboardDayComplete' : 'phone.training.intervalDay', { day: index + 1 })} style={[s.dayMark, { backgroundColor: index < days ? theme.accentSoft : index === current ? theme.accent : theme.panelDeep }]}>
      <Text style={[s.dayNumber, { color: index === current && index >= days ? theme.accentInk : index < days ? theme.accent : theme.dim }]}>{index + 1}</Text>
      {index < days && <Text style={[s.dayCheck, { color: theme.accent }]}>✓</Text>}
    </View>
  </View>)}</View>
}

export function DailyTrainingActivity({ days }: { days: readonly { date: number; sessions: number; exercises: number }[] }): React.JSX.Element {
  const theme = useNativeTheme()
  return <View style={{ gap: 8 }}>
    <Text style={[s.small, { color: theme.dim }]}>{t('phone.training.dailyActivityHelp')}</Text>
    {days.slice(0, 7).map(day => <View key={day.date} style={s.between}>
      <Text style={[s.small, { color: theme.text }]}>{new Date(day.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</Text>
      <Text style={[s.small, { color: theme.dim }]}>{t('phone.training.dailyActivityTotals', { sessions: day.sessions, exercises: day.exercises })}</Text>
    </View>)}
  </View>
}

export function TrainingDashboard({ store, onLesson, onProgress, onChoose }: {
  store: MobileTrainingPersistence
  onLesson: (lesson: ProgramLesson, day: number) => void
  onProgress: () => void
  onChoose: (exercise: TrainingExerciseSelection) => void
}): React.JSX.Element {
  const theme = useNativeTheme()
  const [, update] = useState(0)
  const [path, setPath] = useState(false)
  const [all, setAll] = useState(false)
  const program = store.program
  const stages = store.programProgress
  const next = stages.find(stage => !stage.done)
  const completed = stages.filter(stage => stage.done).length
  const items = [
    { exercise: 'note', key: 'exerciseNoteTitle', mark: '●' },
    { exercise: 'interval', key: 'exerciseIntervalTitle', mark: '↗' },
    { exercise: 'chord-tone', key: 'dashboardChordNotes', mark: '△' },
    { exercise: 'scale', key: 'exerciseScaleTitle', mark: '↗' },
    { exercise: 'arpeggio', key: 'exerciseArpeggioTitle', mark: '⌁' }
  ] as const
  const select = (level: 'foundation' | 'developing' | 'advanced'): void => {
    store.saveProgram(selectTrainingProgramLevel(store.program, level))
    update(value => value + 1)
    void store.flush().then(() => update(value => value + 1))
  }
  return <View style={s.dashboard}>
    <GlassSurface radius={28} elevation="none" style={s.header}>
      <Text style={[s.headerTitle, { color: theme.text }]}>{t('phone.training.dashboardTrain')}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={t('phone.training.progressEntryTitle')} onPress={onProgress} style={[s.linkHit, { minWidth: 44, alignItems: 'center' }]}><Icon name="progress" size={26} color={theme.accent} /></Pressable>
    </GlassSurface>
    <View style={s.between}><Text style={[s.caption, { color: theme.dim }]}>{t('phone.training.dashboardDaily')}</Text>{store.programPracticeStreak > 0 && <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><Icon name="flame" size={18} color={theme.accent} /><Text style={[s.streak, { color: theme.accent }]}>{t('phone.training.dashboardStreak', { days: store.programPracticeStreak })}</Text></View>}</View>
    {!program ? <GlassSurface radius={26} style={s.focus}>
      <Text style={[s.title, { color: theme.text }]}>{t('phone.training.dashboardChoose')}</Text>
      <Text style={[s.copy, { color: theme.dim }]}>{t('phone.training.dashboardChooseHelp')}</Text>
      <View style={s.levels}>{(['foundation', 'developing', 'advanced'] as const).map(level => <ChoiceChip key={level} label={t(`phone.training.programLevel.${level}`)} onPress={() => select(level)} />)}</View>
    </GlassSurface> : next ? <GlassSurface radius={26} style={s.focus}>
      <Text style={[s.caption, { color: theme.dim }]}>{t(next.practicedToday ? 'phone.training.dashboardTodayComplete' : 'phone.training.dashboardLessonDay', { day: next.dayIndex + 1, level: t(`phone.training.programLevel.${program.level}`) })}</Text>
      <Text style={[s.title, { color: theme.text }]}>{programLessonLabel(next.lesson)}</Text>
      <Text style={[s.copy, { color: theme.dim }]}>{t(next.lesson.mode === 'find' ? 'phone.training.dashboardFindHelp' : next.lesson.exercise === 'interval' ? 'phone.training.dashboardIntervalHelp' : next.lesson.exercise === 'note' ? 'phone.training.exerciseNoteCopy' : next.lesson.exercise === 'scale' ? 'phone.training.scaleGuidedHelp' : next.lesson.exercise === 'chord-tone' ? 'phone.training.exerciseChordToneCopy' : 'phone.training.exerciseArpeggioCopy')}</Text>
      <Text style={[s.meta, { color: theme.dim }]}>{t(next.lesson.exercise === 'interval' ? 'phone.training.dashboardIntervalSession' : next.lesson.exercise === 'scale' ? 'phone.training.dashboardScaleSession' : 'phone.training.dashboardNoteSession', { minutes: next.lesson.exercise === 'arpeggio' ? 5 : 2 })}</Text>
      <PracticeWeek days={next.days} current={next.practicedToday ? undefined : next.dayIndex} />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><Icon name="calendar" size={18} color={theme.dim} /><Text style={[s.small, { color: theme.dim }]}>{t('phone.training.intervalDaysDone', { days: next.days })}</Text></View>
      <DailyTrainingActivity days={(store.programPracticeDays ?? []).slice(0, 2)} />
      <Text style={[s.small, { color: theme.dim }]}>{t('phone.training.dailyRecommendation')}</Text>
      <PrimaryAction label={t(next.practicedToday ? 'phone.training.dashboardPracticeAgain' : 'phone.training.dashboardStart')} icon={<MicGlyph color={C.amberInk} />} onPress={() => onLesson(next.lesson, next.dayIndex)} />
    </GlassSurface> : <GlassSurface radius={26} style={s.focus}><Text style={[s.title, { color: theme.text }]}>{t('phone.training.dashboardProgramComplete')}</Text><Text style={[s.copy, { color: theme.dim }]}>{t('phone.training.programComplete')}</Text><PrimaryAction label={t('phone.training.progressEntryTitle')} onPress={onProgress} /></GlassSurface>}
    {program && <>
      <GlassSurface radius={23} elevation="none" style={s.program}>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: path }} onPress={() => setPath(value => !value)} style={s.programHit}>
          <View style={s.between}><Text style={[s.programTitle, { color: theme.text }]}>{t(`phone.training.programLevel.${program.level}`)}</Text><Text style={[s.link, { color: theme.accent }]}>{t('phone.training.dashboardFullPath')}</Text></View>
          <Text style={[s.small, { color: theme.dim }]}>{t('phone.training.programDone', { done: completed, total: stages.length })}</Text>
          <View accessibilityRole="progressbar" accessibilityLabel={t('phone.training.programTitle')} accessibilityValue={{ min: 0, max: stages.length, now: completed }} style={[s.track, { backgroundColor: theme.line }]}><View style={[s.trackFill, { backgroundColor: theme.accent, width: `${completed / stages.length * 100}%` }]} /></View>
          {next && <Text style={[s.small, { color: theme.dim }]}>{t('phone.training.dashboardNextMilestone', { lesson: programLessonLabel(next.lesson) })}</Text>}
        </Pressable>
      </GlassSurface>
      {path && <GlassSurface radius={23} style={s.focus}>
        <Text style={[s.programTitle, { color: theme.text }]}>{t('phone.training.programTitle')}</Text>
        <View style={s.levels}>{(['foundation', 'developing', 'advanced'] as const).map(level => <ChoiceChip key={level} label={t(`phone.training.programLevel.${level}`)} selected={program.level === level} onPress={() => select(level)} />)}</View>
        {stages.map(stage => <Pressable key={stage.index} accessibilityRole="button" onPress={() => onLesson(stage.lesson, stage.dayIndex)} style={[s.stage, { borderColor: theme.line }]}><Text style={[s.stageMark, { color: stage.done || stage.index === next?.index ? theme.accent : theme.dim }]}>{stage.done ? '✓' : stage.index + 1}</Text><View style={s.stageCopy}><Text style={[s.stageName, { color: theme.text }]}>{programLessonLabel(stage.lesson)}</Text><Text style={[s.small, { color: theme.dim }]}>{t('phone.training.intervalDaysDone', { days: stage.days })}{stage.accuracy === null ? '' : ` · ${Math.round(stage.accuracy * 100)}%`}</Text></View></Pressable>)}
      </GlassSurface>}
    </>}
    <View style={s.between}><Text style={[s.programTitle, { color: theme.text }]}>{t('phone.training.dashboardFree')}</Text><Pressable accessibilityRole="button" onPress={() => setAll(value => !value)} style={s.linkHit}><Text style={[s.link, { color: theme.accent }]}>{t(all ? 'phone.training.dashboardLess' : 'phone.training.dashboardAll')}</Text></Pressable></View>
    <View style={s.quick}>{items.slice(0, all ? items.length : 3).map(item => <Pressable key={item.exercise} accessibilityRole="button" onPress={() => onChoose(item.exercise)} style={s.quickHit}><GlassSurface radius={18} elevation="none" style={s.quickContent}><Icon name={item.exercise === 'note' ? 'note' : item.exercise === 'interval' ? 'interval' : item.exercise === 'chord-tone' ? 'chord' : item.exercise === 'arpeggio' ? 'arpeggio' : 'scale'} size={26} color={theme.accent} /><Text style={[s.quickLabel, { color: theme.text }]}>{t(`phone.training.${item.key}`)}</Text></GlassSurface></Pressable>)}</View>
  </View>
}

const s = StyleSheet.create({
  dashboard: { gap: 14 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, minHeight: 64 },
  headerTitle: { fontSize: 25, fontWeight: '900' },
  between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  caption: { fontSize: 12, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase', flexShrink: 1 },
  streak: { fontSize: 13, fontWeight: '800' },
  focus: { padding: 20, gap: 12 },
  title: { fontSize: 30, lineHeight: 35, fontWeight: '900', letterSpacing: -.5 },
  copy: { fontSize: 16, lineHeight: 22 },
  meta: { fontSize: 14, lineHeight: 19, fontWeight: '600' },
  small: { fontSize: 13, lineHeight: 18 },
  week: { flexDirection: 'row', gap: 6 },
  day: { flex: 1, alignItems: 'center', gap: 6 },
  dayMark: { minHeight: 34, width: '100%', borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  dayNumber: { fontSize: 15, fontWeight: '800' },
  dayCheck: { position: 'absolute', right: 3, top: 1, fontSize: 9, fontWeight: '900' },
  program: { padding: 16 },
  programHit: { gap: 7 },
  programTitle: { fontSize: 18, fontWeight: '800' },
  linkHit: { minHeight: 44, justifyContent: 'center' },
  link: { fontSize: 14, fontWeight: '700' },
  track: { height: 6, borderRadius: 4, overflow: 'hidden', marginVertical: 4 },
  trackFill: { height: '100%', borderRadius: 4 },
  levels: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  stage: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  stageMark: { width: 26, fontSize: 21, fontWeight: '800', textAlign: 'center' },
  stageCopy: { flex: 1, gap: 4 },
  stageName: { fontSize: 17, fontWeight: '700' },
  quick: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  quickHit: { flexGrow: 1, flexBasis: '29%' },
  quickContent: { padding: 12, gap: 7, minHeight: 84 },
  quickMark: { fontSize: 20, fontWeight: '800' },
  quickLabel: { fontSize: 14, fontWeight: '700' }
})

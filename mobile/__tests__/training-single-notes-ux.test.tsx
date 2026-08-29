import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { StyleSheet, View } from 'react-native'
import { defaultTrainingPreferences } from '../src/gen/training-lib'
import { initialTrainingState, mobileTrainingReducer } from '../src/training/state'
import { SingleNoteSetup, TrainingSessionView, TrainingSetup, trainingSwipeDirection, type MicHearing } from '../src/ui/TrainingScreen'

function nodeText(node: ReactTestRenderer.ReactTestInstance): string {
  return node.children.map((child) => typeof child === 'string' ? child : nodeText(child)).join('')
}

function button(tree: ReactTestRenderer.ReactTestRenderer, label: string): ReactTestRenderer.ReactTestInstance {
  return tree.root.findAll((node) =>
    node.props.accessibilityRole === 'button' &&
    typeof node.props.onPress === 'function' &&
    nodeText(node).includes(label)
  )[0]
}

test('single-note setup is compact and uses note names instead of MIDI numbers', async () => {
  const selected = mobileTrainingReducer(initialTrainingState(defaultTrainingPreferences()), {
    type: 'choose-exercise', exercise: 'note'
  })
  const onStart = jest.fn()
  const onReferenceVolumeChange = jest.fn()
  const onPitchWindowChange = jest.fn()
  const onTestReferenceTone = jest.fn()
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <SingleNoteSetup
        setup={selected.setup}
        error={null}
        referenceVolume={0.65}
        pitchWindowCents={10}
        testingReferenceTone={false}
        onReferenceVolumeChange={onReferenceVolumeChange}
        onPitchWindowChange={onPitchWindowChange}
        onTestReferenceTone={onTestReferenceTone}
        onChange={jest.fn()}
        onStart={onStart}
        onBack={jest.fn()}
      />
    )
  })

  const text = nodeText(tree.root)
  expect(text).toContain('Single notes')
  expect(text).toContain('C major')
  expect(text).toContain('C3 — C5')
  expect(text).toContain('20 notes')
  expect(text).toContain('REFERENCE SOUND')
  expect(text).toContain('65%')
  expect(text).toContain('Test C4')
  expect(text).toContain('PITCH WINDOW')
  expect(text).toContain('±10¢')
  expect(text).not.toContain('Comfortable range')
  expect(text).not.toContain('Mode')
  expect(text).not.toContain('48')
  expect(text).not.toContain('72')

  await ReactTestRenderer.act(() => button(tree, 'Voice range').props.onPress())
  expect(nodeText(tree.root)).toContain('Low−C3+')
  expect(nodeText(tree.root)).toContain('High−C5+')
  await ReactTestRenderer.act(() => tree.root.findByProps({ accessibilityLabel: 'Increase reference volume' }).props.onPress())
  expect(onReferenceVolumeChange).toHaveBeenCalledWith(0.75)
  await ReactTestRenderer.act(() => button(tree, 'Test C4').props.onPress())
  expect(onTestReferenceTone).toHaveBeenCalledWith(60)
  await ReactTestRenderer.act(() => button(tree, '±15¢').props.onPress())
  expect(onPitchWindowChange).toHaveBeenCalledWith(15)
  await ReactTestRenderer.act(() => button(tree, 'Start practice').props.onPress())
  expect(onStart).toHaveBeenCalledTimes(1)
})

test.each([
  { exercise: 'interval' as const, title: 'Intervals', option: 'Direction' },
  { exercise: 'chord-tone' as const, title: 'Notes in a chord', option: 'Chord degrees' },
  { exercise: 'arpeggio' as const, title: 'Carry the line', option: 'Direction' }
])('$title uses the compact shared setup and common pitch settings', async ({ exercise, title, option }) => {
  let selected = mobileTrainingReducer(initialTrainingState(defaultTrainingPreferences()), {
    type: 'choose-exercise', exercise
  })
  selected = mobileTrainingReducer(selected, {
    type: 'change-setup', patch: { lowMidi: 50, highMidi: 70, taskMode: 'imitate' }
  })
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <TrainingSetup
        setup={selected.setup}
        error={null}
        referenceVolume={0.8}
        pitchWindowCents={10}
        testingReferenceTone={false}
        onReferenceVolumeChange={jest.fn()}
        onPitchWindowChange={jest.fn()}
        onTestReferenceTone={jest.fn()}
        onChange={jest.fn()}
        onStart={jest.fn()}
        onBack={jest.fn()}
      />
    )
  })
  const text = nodeText(tree.root)
  expect(text).toContain(title)
  expect(text).toContain('PracticeImitate')
  expect(text).toContain(option)
  expect(text).toContain('20 exercises')
  expect(text).toContain('REFERENCE SOUND')
  expect(text).toContain('80%')
  expect(text).toContain('PITCH WINDOW')
  expect(text).toContain('±10¢')
  expect(text).toContain('Start practice')
  expect(text).not.toContain('Comfortable range')
  expect(tree.root.findByProps({ accessibilityLabel: 'Reference sound volume' })).toBeTruthy()
})

test.each(['interval', 'chord-tone', 'arpeggio'] as const)('%s vocal practice uses the large guided tuner and swipe deck', async (exercise) => {
  let state = initialTrainingState(defaultTrainingPreferences())
  state = mobileTrainingReducer(state, { type: 'change-setup', patch: { exercise, taskMode: 'imitate', length: 2 } })
  state = mobileTrainingReducer(state, { type: 'start', seed: `guided-${exercise}` })
  const prompt = state.session!.prompts[0]
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <TrainingSessionView state={state} liveMidi={null} activeTarget={0} onBegin={jest.fn()} onIdentify={jest.fn()} onNext={jest.fn()} onExit={jest.fn()} onBackToSong={null} />
    )
  })
  expect(tree.root.findByProps({ testID: 'single-note-target-area' })).toBeTruthy()
  expect(tree.root.findByProps({ accessibilityLabel: `Target note ${prompt.targets[0].noteName}` })).toBeTruthy()
  expect(tree.root.findByProps({ testID: 'training-swipe-surface' })).toBeTruthy()
  if (prompt.targets.length > 1) expect(tree.root.findByProps({ accessibilityLabel: `Note 1 of ${prompt.targets.length}` })).toBeTruthy()

  state = mobileTrainingReducer(state, { type: 'activate' })
  state = mobileTrainingReducer(state, { type: 'cue-complete' })
  const nextTarget = Math.min(1, prompt.targets.length - 1)
  await ReactTestRenderer.act(() => {
    tree.update(
      <TrainingSessionView state={state} liveMidi={prompt.targets[nextTarget].midi} activeTarget={nextTarget} onBegin={jest.fn()} onIdentify={jest.fn()} onNext={jest.fn()} onExit={jest.fn()} onBackToSong={null} />
    )
  })
  expect(nodeText(tree.root)).toContain('FLAT±10¢SHARP')
  expect(tree.root.findByProps({ accessibilityLabel: `Target note ${prompt.targets[nextTarget].noteName}` })).toBeTruthy()
  expect(tree.root.findByProps({ accessibilityLabel: 'Hear again' })).toBeTruthy()
  expect(tree.root.findByProps({ accessibilityLabel: 'Skip' })).toBeTruthy()
})

test('single-note practice makes the target dominant and exposes a full tuner reading', async () => {
  let state = initialTrainingState(defaultTrainingPreferences())
  state = mobileTrainingReducer(state, { type: 'change-setup', patch: { exercise: 'note', taskMode: 'imitate', length: 2 } })
  state = mobileTrainingReducer(state, { type: 'start', seed: 'focused-single-note' })
  const target = state.session!.prompts[0].targets[0]
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <TrainingSessionView state={state} liveMidi={null} activeTarget={0} onBegin={jest.fn()} onIdentify={jest.fn()} onNext={jest.fn()} onExit={jest.fn()} onBackToSong={null} />
    )
  })
  expect(nodeText(tree.root)).toContain('Preparing next note')
  expect(nodeText(tree.root)).not.toContain('Hear note')
  expect(nodeText(tree.root)).not.toContain(`Match ${target.noteName}`)
  const targetArea = tree.root.findAllByProps({ testID: 'single-note-target-area' }).find((node) => node.type === View)
  const targetAreaStyle = StyleSheet.flatten(targetArea?.props.style)
  expect(targetAreaStyle).toEqual(expect.objectContaining({ height: 222, paddingTop: 18 }))
  const targetLockup = tree.root.findByProps({ accessibilityLabel: `Target note ${target.noteName}` })
  expect(targetLockup).toBeTruthy()
  expect(StyleSheet.flatten(targetLockup.findAllByType('Text' as never)[0].props.style)).toEqual(expect.objectContaining({ textAlign: 'center', left: 0, right: 0 }))
  expect(targetLockup.findAllByType('Text' as never)[1].props.style).toEqual(expect.arrayContaining([expect.objectContaining({ position: 'absolute', left: '50%' })]))

  state = mobileTrainingReducer(state, { type: 'activate' })
  await ReactTestRenderer.act(() => {
    tree.update(
      <TrainingSessionView state={state} liveMidi={null} singleNoteCountdown={3} activeTarget={0} onBegin={jest.fn()} onIdentify={jest.fn()} onNext={jest.fn()} onExit={jest.fn()} onBackToSong={null} />
    )
  })
  expect(nodeText(tree.root)).toContain('SING IN3Listen to the reference note')
  expect(tree.root.findByProps({ accessibilityLabel: 'Sing in 3' })).toBeTruthy()
  expect(StyleSheet.flatten(tree.root.findAllByProps({ testID: 'single-note-target-area' }).find((node) => node.type === View)?.props.style)).toEqual(targetAreaStyle)

  state = mobileTrainingReducer(state, { type: 'cue-complete' })
  await ReactTestRenderer.act(() => {
    tree.update(
      <TrainingSessionView state={state} liveMidi={target.midi} activeTarget={0} onBegin={jest.fn()} onIdentify={jest.fn()} onNext={jest.fn()} onExit={jest.fn()} onBackToSong={null} />
    )
  })
  expect(nodeText(tree.root)).toContain('FLAT±10¢SHARP')
  expect(nodeText(tree.root)).toContain(`YOU ARE SINGING${target.noteName}`)
  expect(nodeText(tree.root)).toContain('Centered')
  expect(nodeText(tree.root)).toContain('Center within ±10¢ and hold for 1.5 seconds')
  expect(StyleSheet.flatten(tree.root.findAllByProps({ testID: 'single-note-target-area' }).find((node) => node.type === View)?.props.style)).toEqual(targetAreaStyle)
  expect(tree.root.findByProps({ accessibilityLabel: 'Hear again' })).toBeTruthy()
  expect(tree.root.findByProps({ testID: 'circular-arrow-glyph' }).props.style).toEqual(expect.objectContaining({ width: 22, height: 22 }))
  expect(tree.root.findByProps({ accessibilityLabel: 'Skip' })).toBeTruthy()
  expect(nodeText(tree.root)).toContain('Swipe right to replay · left to skip')
  expect(nodeText(tree.root)).not.toContain('five seconds')
})

test('single-note swipe deck maps deliberate horizontal gestures to player actions', async () => {
  expect(trainingSwipeDirection(-70, 3, -0.2)).toBe('left')
  expect(trainingSwipeDirection(70, 3, 0.2)).toBe('right')
  expect(trainingSwipeDirection(20, 60, 0.9)).toBeNull()

  let state = initialTrainingState(defaultTrainingPreferences())
  state = mobileTrainingReducer(state, { type: 'change-setup', patch: { exercise: 'note', taskMode: 'imitate', length: 2 } })
  state = mobileTrainingReducer(state, { type: 'start', seed: 'swipe-deck' })
  state = mobileTrainingReducer(state, { type: 'activate' })
  state = mobileTrainingReducer(state, { type: 'cue-complete' })
  const replay = jest.fn()
  const skip = jest.fn()
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <TrainingSessionView state={state} liveMidi={null} activeTarget={0} onBegin={replay} onSkipSingleNote={skip} onIdentify={jest.fn()} onNext={jest.fn()} onExit={jest.fn()} onBackToSong={null} />
    )
  })
  expect(tree.root.findByProps({ testID: 'training-swipe-surface' })).toBeTruthy()
  await ReactTestRenderer.act(() => tree.root.findByProps({ accessibilityLabel: 'Hear again' }).props.onPress())
  expect(replay).toHaveBeenCalledTimes(1)
  await ReactTestRenderer.act(() => tree.root.findByProps({ accessibilityLabel: 'Skip' }).props.onPress())
  expect(skip).toHaveBeenCalledTimes(1)
})

test('the meter names which way the microphone is failing instead of waiting forever', async () => {
  let state = initialTrainingState(defaultTrainingPreferences())
  state = mobileTrainingReducer(state, { type: 'change-setup', patch: { exercise: 'note', taskMode: 'imitate', length: 2 } })
  state = mobileTrainingReducer(state, { type: 'start', seed: 'quiet-room' })
  state = mobileTrainingReducer(state, { type: 'activate' })
  state = mobileTrainingReducer(state, { type: 'cue-complete' })
  const listening = async (micHearing: MicHearing): Promise<string> => {
    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(() => {
      tree = ReactTestRenderer.create(
        <TrainingSessionView state={state} liveMidi={null} micHearing={micHearing} activeTarget={0} onBegin={jest.fn()} onIdentify={jest.fn()} onNext={jest.fn()} onExit={jest.fn()} onBackToSong={null} />
      )
    })
    return nodeText(tree.root)
  }

  // A capture that has simply not delivered its first block yet, and one that
  // is delivering a healthy signal, both stay patient.
  expect(await listening('starting')).toContain('Waiting for your voice')
  expect(await listening('hearing')).toContain('Waiting for your voice')

  // The two that a singer can act on must say so instead.
  const noAudio = await listening('no-audio')
  expect(noAudio).toContain('No sound from the mic')
  expect(noAudio).toContain('Tap Replay to restart the microphone')
  expect(noAudio).not.toContain('Waiting for your voice')

  const silent = await listening('silent')
  expect(silent).toContain('The mic is delivering silence')
  expect(silent).toContain('Check microphone access in Settings')
  expect(silent).not.toContain('Waiting for your voice')

  // Still true on the unnormalized recorder path, and only there.
  const tooQuiet = await listening('too-quiet')
  expect(tooQuiet).toContain('Too quiet to hear')
  expect(tooQuiet).toContain('Sing a little louder')
  expect(tooQuiet).not.toContain('Waiting for your voice')
})

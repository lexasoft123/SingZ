import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import VocalTraining from '../../src/renderer/src/components/VocalTraining'
import {
  audibleCueEndTimeSec,
  claimIdentifySubmission,
  claimTrainingBegin,
  createTrainingTargetWindows,
  desktopTrainingReducer,
  ensureCurrentPromptMicrophone,
  ensurePromptMicrophone,
  identifyAnswerReveal,
  INITIAL_DESKTOP_TRAINING_STATE,
  invalidateTrainingBegin,
  interruptTrainingForeground,
  releasePromptMicrophoneIfFinal,
  releaseTrainingBegin,
  resetIdentifySubmission,
  selectTrainingExercise,
  shouldReleaseMicrophoneAfterResult,
  trainingCaptureDecision,
  trainingFocusTarget,
  trainingPromptKindLabel,
  trainingSummaryPitchCopy,
  summarizeTrainingSession
} from '../../src/renderer/src/training-ui-state'
import type {
  TrainingAttemptInput,
  TrainingExerciseSelection,
  TrainingPrompt
} from '../../src/shared/training-types'

describe('desktop vocal-training orchestration', () => {
  it('keeps setup state explicit and derives identify correctness through the shared session transition', () => {
    let state = desktopTrainingReducer(INITIAL_DESKTOP_TRAINING_STATE, {
      type: 'choose-exercise',
      exercise: 'scale-degree'
    })
    state = desktopTrainingReducer(state, {
      type: 'update-setup',
      patch: { taskMode: 'identify', tonicPc: 7, length: 5 }
    })
    state = desktopTrainingReducer(state, { type: 'start-session', seed: 'desktop-identify' })
    expect(state.route).toBe('session')
    expect(state.exercisePhase).toBe('ready')
    expect(state.session?.config).toMatchObject({
      exercise: 'scale-degree',
      taskMode: 'identify',
      key: { tonicPc: 7, mode: 'major' }
    })

    state = desktopTrainingReducer(state, { type: 'activate-session' })
    state = desktopTrainingReducer(state, { type: 'cue-complete' })
    const prompt = state.session!.prompts[0]
    if (prompt.kind !== 'scale-degree') throw new Error('Expected a scale-degree prompt.')
    state = desktopTrainingReducer(state, {
      type: 'record-result',
      result: {
        response: 'identify',
        promptId: prompt.id,
        answer: { kind: 'scale-degree', scaleDegree: prompt.scaleDegree }
      }
    })

    expect(state.exercisePhase).toBe('feedback')
    expect(selectTrainingExercise(state)?.result).toMatchObject({ response: 'identify', correct: true })
    expect(state.session?.currentIndex).toBe(1)
  })

  it('creates ordered target windows from the cue audio clock, not render frames', () => {
    expect(
      createTrainingTargetWindows(10, 3, {
        responseDelayMs: 200,
        targetDurationMs: 1000,
        targetGapMs: 100
      })
    ).toEqual([
      { targetIndex: 0, startMs: 10200, endMs: 11200 },
      { targetIndex: 1, startMs: 11300, endMs: 12300 },
      { targetIndex: 2, startMs: 12400, endMs: 13400 }
    ])
  })

  it('preserves prompt progress while making an interrupted response safe to restart after tab switching', () => {
    let state = desktopTrainingReducer(INITIAL_DESKTOP_TRAINING_STATE, {
      type: 'start-session',
      seed: 'switch-sections'
    })
    state = desktopTrainingReducer(state, { type: 'activate-session' })
    state = desktopTrainingReducer(state, { type: 'cue-complete' })
    const session = state.session

    state = desktopTrainingReducer(state, { type: 'interrupt-runtime' })
    expect(state.route).toBe('session')
    expect(state.exercisePhase).toBe('ready')
    expect(state.interrupted).toBe(true)
    expect(state.session).toBe(session)
    expect(state.session?.currentIndex).toBe(0)
  })

  it('pairs mixed feedback with the completed arpeggio before a following single-note prompt', () => {
    let state = desktopTrainingReducer(INITIAL_DESKTOP_TRAINING_STATE, {
      type: 'choose-exercise',
      exercise: 'mixed'
    })
    state = desktopTrainingReducer(state, {
      type: 'update-setup',
      patch: { length: 10, taskMode: 'find', lowMidi: 36, highMidi: 84 }
    })
    state = desktopTrainingReducer(state, { type: 'start-session', seed: 'mixed-pairing' })
    const prompts = state.session!.prompts
    const arpeggioIndex = prompts.findIndex(
      (prompt, index) => prompt.kind === 'arpeggio' && prompts[index + 1]?.kind === 'note'
    )
    expect(arpeggioIndex).toBeGreaterThanOrEqual(0)

    state = desktopTrainingReducer(state, { type: 'activate-session' })
    for (let index = 0; index <= arpeggioIndex; index++) {
      const prompt = state.session!.prompts[state.session!.currentIndex]
      state = desktopTrainingReducer(state, {
        type: 'record-result',
        result: vocalResult(prompt, 'on-target', 12)
      })
      if (index < arpeggioIndex)
        state = desktopTrainingReducer(state, { type: 'next-prompt' })
    }

    const selected = selectTrainingExercise(state)!
    expect(selected.prompt.kind).toBe('arpeggio')
    expect(selected.prompt.targets).toHaveLength(3)
    expect(selected.result?.response).toBe('vocal')
    if (selected.result?.response === 'vocal') expect(selected.result.targets).toHaveLength(3)
    expect(state.session!.prompts[state.session!.currentIndex].kind).toBe('note')
    const html = renderTraining(state)
    for (const target of selected.prompt.targets) expect(html).toContain(target.noteName)
  })

  it('keeps identify interval and chord answers out of prompt copy until feedback', () => {
    let intervalState = identifyResponseState('interval', 'secret-interval')
    const interval = selectTrainingExercise(intervalState)!.prompt
    if (interval.kind !== 'interval') throw new Error('Expected interval prompt.')
    const intervalHtml = renderTraining(intervalState)
    expect(trainingPromptKindLabel(interval, false)).toBe('Diatonic interval · number and direction')
    expect(intervalHtml).toContain('Diatonic interval · number and direction')
    expect(intervalHtml).not.toContain(interval.intervalName)
    for (const target of interval.targets) {
      expect(intervalHtml).not.toContain(target.noteName)
      expect(intervalHtml).not.toContain(`Scale degree ${target.scaleDegree}`)
    }
    expect(identifyAnswerReveal(interval)).toContain('Answer:')

    let chordState = identifyResponseState('arpeggio', 'secret-chord')
    const chord = selectTrainingExercise(chordState)!.prompt
    if (chord.kind !== 'arpeggio') throw new Error('Expected arpeggio prompt.')
    const chordAnswer = `${chord.chord.rootName} ${chord.chord.quality}`
    const chordHtml = renderTraining(chordState)
    expect(chordHtml).toContain('Diatonic chord identification')
    expect(chordHtml).not.toContain(chordAnswer)
    expect(chordHtml).not.toContain(chord.chord.rootName)

    intervalState = desktopTrainingReducer(intervalState, {
      type: 'record-result',
      result: correctIdentifyResult(interval)
    })
    expect(renderTraining(intervalState)).toContain(identifyAnswerReveal(interval)!)
    chordState = desktopTrainingReducer(chordState, {
      type: 'record-result',
      result: correctIdentifyResult(chord)
    })
    expect(renderTraining(chordState)).toContain(chordAnswer)
  })

  it('locks identify submission synchronously and makes duplicate reducer delivery idempotent', () => {
    const lock = { current: null as string | null }
    expect(claimIdentifySubmission(lock, 'exercise-1')).toBe(true)
    expect(claimIdentifySubmission(lock, 'exercise-1')).toBe(false)
    expect(claimIdentifySubmission(lock, 'exercise-2')).toBe(true)

    let state = identifyResponseState('scale-degree', 'double-submit')
    const prompt = selectTrainingExercise(state)!.prompt
    const input = correctIdentifyResult(prompt)
    state = desktopTrainingReducer(state, { type: 'record-result', result: input })
    const afterFirst = state
    state = desktopTrainingReducer(state, { type: 'record-result', result: input })
    expect(state).toBe(afterFirst)
    expect(state.session?.results).toHaveLength(1)
    expect(state.error).toBeNull()
  })

  it('restarts a disconnected mic on Next after feedback and releases it for the final prompt', async () => {
    let state = desktopTrainingReducer(INITIAL_DESKTOP_TRAINING_STATE, {
      type: 'update-setup',
      patch: { length: 5, taskMode: 'find' }
    })
    state = desktopTrainingReducer(state, { type: 'start-session', seed: 'mic-return' })
    state = desktopTrainingReducer(state, { type: 'activate-session' })
    const first = state.session!.prompts[0]
    state = desktopTrainingReducer(state, {
      type: 'record-result',
      result: vocalResult(first, 'on-target', 8)
    })
    const feedback = state
    state = desktopTrainingReducer(state, { type: 'interrupt-runtime' })
    expect(state).toBe(feedback)
    expect(selectTrainingExercise(state)?.prompt.id).toBe(first.id)

    const next = state.session!.prompts[state.session!.currentIndex]
    let active = false
    let starts = 0
    const started = await ensurePromptMicrophone(
      next,
      { get active() { return active } },
      async () => {
        starts++
        active = true
      }
    )
    expect(started).toBe(true)
    expect(starts).toBe(1)
    expect(await ensurePromptMicrophone(next, { get active() { return active } }, async () => { starts++ })).toBe(false)
    expect(starts).toBe(1)

    let finalState = desktopTrainingReducer(INITIAL_DESKTOP_TRAINING_STATE, {
      type: 'update-setup',
      patch: { length: 1, taskMode: 'find' }
    })
    finalState = desktopTrainingReducer(finalState, { type: 'start-session', seed: 'final-release' })
    const finalPrompt = finalState.session!.prompts[0]
    expect(shouldReleaseMicrophoneAfterResult(finalState.session!, finalPrompt)).toBe(true)
    expect(shouldReleaseMicrophoneAfterResult(state.session!, next)).toBe(false)
    const stop = vi.fn()
    const released = vi.fn()
    expect(releasePromptMicrophoneIfFinal(finalState.session!, finalPrompt, { stop }, released)).toBe(true)
    expect(stop).toHaveBeenCalledOnce()
    expect(released).toHaveBeenCalledOnce()
    expect(releasePromptMicrophoneIfFinal(state.session!, next, { stop }, released)).toBe(false)
    expect(stop).toHaveBeenCalledOnce()
  })

  it('revokes a pending microphone start and releases resources during feedback interruption', async () => {
    let state = desktopTrainingReducer(INITIAL_DESKTOP_TRAINING_STATE, {
      type: 'start-session',
      seed: 'pending-start'
    })
    const prompt = state.session!.prompts[0]
    const gate = deferred()
    let generation = 1
    let active = false
    const stop = vi.fn(() => {
      active = false
    })
    const pending = ensureCurrentPromptMicrophone(
      prompt,
      { get active() { return active } },
      async () => {
        await gate.promise
        throw new Error('Training microphone start was cancelled.')
      },
      () => generation === 1
    )
    generation++
    stop()
    gate.resolve()
    await expect(pending).resolves.toBe('cancelled')
    expect(stop).toHaveBeenCalledOnce()
    expect(active).toBe(false)

    state = desktopTrainingReducer(state, { type: 'activate-session' })
    state = desktopTrainingReducer(state, {
      type: 'record-result',
      result: vocalResult(prompt, 'on-target', 0)
    })
    const feedback = state
    const stopFeedback = vi.fn()
    expect(interruptTrainingForeground(state.exercisePhase, stopFeedback)).toBe(false)
    expect(stopFeedback).toHaveBeenCalledOnce()
    state = desktopTrainingReducer(state, { type: 'interrupt-runtime' })
    expect(state).toBe(feedback)
  })

  it('locks duplicate begins and lets a new begin own the mic while the cancelled one winds down', async () => {
    const lock = { generation: 0, activeGeneration: null as number | null }
    const firstRun = claimTrainingBegin(lock)
    expect(firstRun).toBe(0)
    expect(claimTrainingBegin(lock)).toBeNull()

    let state = desktopTrainingReducer(INITIAL_DESKTOP_TRAINING_STATE, {
      type: 'start-session',
      seed: 'begin-lock'
    })
    const prompt = state.session!.prompts[0]
    const oldGate = deferred()
    let owner: 'old' | 'new' | null = null
    let starts = 0
    const oldPending = ensureCurrentPromptMicrophone(
      prompt,
      { get active() { return owner !== null } },
      async () => {
        starts++
        await oldGate.promise
      },
      () => firstRun !== null && lock.generation === firstRun && lock.activeGeneration === firstRun
    )

    const explicitStop = vi.fn(() => {
      owner = null
    })
    invalidateTrainingBegin(lock)
    explicitStop()
    const newRun = claimTrainingBegin(lock)
    expect(newRun).toBe(1)
    await expect(
      ensureCurrentPromptMicrophone(
        prompt,
        { get active() { return owner !== null } },
        async () => {
          starts++
          owner = 'new'
        },
        () => newRun !== null && lock.generation === newRun && lock.activeGeneration === newRun
      )
    ).resolves.toBe('ready')

    oldGate.resolve()
    await expect(oldPending).resolves.toBe('cancelled')
    expect(owner).toBe('new')
    expect(explicitStop).toHaveBeenCalledOnce()
    expect(starts).toBe(2)
    expect(releaseTrainingBegin(lock, firstRun!)).toBe(false)
    expect(lock.activeGeneration).toBe(newRun)
    expect(releaseTrainingBegin(lock, newRun!)).toBe(true)
  })

  it('selects stable keyboard focus targets for Ready, Identify response, and Feedback', () => {
    let state = desktopTrainingReducer(INITIAL_DESKTOP_TRAINING_STATE, {
      type: 'update-setup',
      patch: { taskMode: 'identify' }
    })
    state = desktopTrainingReducer(state, { type: 'start-session', seed: 'focus' })
    expect(trainingFocusTarget(state)).toBe('ready-action')
    expect(renderTraining(state)).toContain('data-training-focus="ready-action"')

    state = desktopTrainingReducer(state, { type: 'activate-session' })
    state = desktopTrainingReducer(state, { type: 'cue-complete' })
    expect(trainingFocusTarget(state)).toBe('identify-answer')
    expect(renderTraining(state)).toContain('data-training-focus="identify-answer"')

    state = desktopTrainingReducer(state, {
      type: 'record-result',
      result: correctIdentifyResult(selectTrainingExercise(state)!.prompt)
    })
    expect(trainingFocusTarget(state)).toBe('feedback')
  })

  it('resets Identify submission before the second question becomes focusable', () => {
    let state = identifyResponseState('interval', 'second-identify-focus')
    const first = selectTrainingExercise(state)!.prompt
    const lock = { current: null as string | null }
    expect(claimIdentifySubmission(lock, first.id)).toBe(true)
    state = desktopTrainingReducer(state, {
      type: 'record-result',
      result: correctIdentifyResult(first)
    })

    resetIdentifySubmission(lock)
    state = desktopTrainingReducer(state, { type: 'next-prompt' })
    state = desktopTrainingReducer(state, { type: 'cue-complete' })
    const second = selectTrainingExercise(state)!.prompt
    expect(second.id).not.toBe(first.id)
    expect(lock.current).toBeNull()
    expect(claimIdentifySubmission(lock, second.id)).toBe(true)
    expect(trainingFocusTarget(state)).toBe('identify-answer')
    const html = renderTraining(state)
    expect(html).toContain('data-training-focus="identify-answer"')
    const firstAnswer = html.match(/<button data-training-focus="identify-answer"[^>]*>/)?.[0]
    expect(firstAnswer).toContain('aria-disabled="false"')
    expect(firstAnswer).not.toContain(' disabled')
  })

  it('lets foreground interruption beat an expired capture deadline and aligns to output latency', () => {
    expect(trainingCaptureDecision(false, 12_000, 10_000)).toBe('interrupt')
    expect(trainingCaptureDecision(true, 12_000, 10_000)).toBe('score')
    expect(trainingCaptureDecision(true, 9_000, 10_000)).toBe('sample')
    expect(audibleCueEndTimeSec(10, { outputLatency: 0.12, baseLatency: 0.02 })).toBeCloseTo(10.12)
    expect(audibleCueEndTimeSec(10, { outputLatency: 0, baseLatency: 0.02 })).toBeCloseTo(10.02)
    expect(audibleCueEndTimeSec(10, { outputLatency: 0, baseLatency: 0 })).toBe(10)
  })

  it('summarizes categorical attempts and time-weighted pitch metrics without requiring persistence', () => {
    let state = desktopTrainingReducer(INITIAL_DESKTOP_TRAINING_STATE, {
      type: 'start-session',
      seed: 'summary'
    })
    state = desktopTrainingReducer(state, { type: 'activate-session' })
    const prompt = state.session!.prompts[0]
    state = desktopTrainingReducer(state, {
      type: 'record-result',
      result: {
        response: 'vocal',
        promptId: prompt.id,
        targets: [
          {
            targetIndex: 0,
            classification: 'on-target',
            metrics: {
              medianCentsError: 18,
              voicedCoverage: 0.8,
              stableHoldRatio: 0.75,
              detectedMidi: prompt.targets[0].midi + 0.18
            }
          }
        ]
      }
    })
    state = desktopTrainingReducer(state, { type: 'next-prompt' })
    const wrongPrompt = state.session!.prompts[state.session!.currentIndex]
    state = desktopTrainingReducer(state, {
      type: 'record-result',
      result: vocalResult(wrongPrompt, 'wrong-octave', -1200)
    })
    const summary = summarizeTrainingSession(state.session!)
    expect(summary).toMatchObject({
      attempts: 2,
      correct: 1,
      close: 0,
      averageAbsoluteCents: 18,
      voicedRatio: 0.8,
      stableRatio: 0.75,
      tendency: 'sharp'
    })
    expect(summary.averageSignedCents).toBe(18)
  })

  it('explains missing pitch metrics according to the session task mode', () => {
    let identify = identifyResponseState('note', 'identify-summary')
    const identifyPrompt = selectTrainingExercise(identify)!.prompt
    identify = desktopTrainingReducer(identify, {
      type: 'record-result',
      result: correctIdentifyResult(identifyPrompt)
    })
    expect(trainingSummaryPitchCopy(identify.session!)).toBe(
      'This ear-only session did not use pitch metrics.'
    )

    let vocal = desktopTrainingReducer(INITIAL_DESKTOP_TRAINING_STATE, {
      type: 'start-session',
      seed: 'vocal-summary'
    })
    vocal = desktopTrainingReducer(vocal, { type: 'activate-session' })
    const vocalPrompt = vocal.session!.prompts[0]
    vocal = desktopTrainingReducer(vocal, {
      type: 'record-result',
      result: vocalResult(vocalPrompt, 'wrong-octave', -1200)
    })
    expect(trainingSummaryPitchCopy(vocal.session!)).toBe(
      'No steady centered notes were detected in this session.'
    )
  })

  it('renders focused, button-based exercise choices and the microphone privacy copy', () => {
    const html = renderToStaticMarkup(
      createElement(VocalTraining, {
        state: INITIAL_DESKTOP_TRAINING_STATE,
        dispatch: vi.fn(),
        engine: {} as never,
        cues: {} as never,
        mic: {} as never,
        onMicDevice: vi.fn()
      })
    )
    expect(html).toContain('aria-label="Training exercises"')
    expect(html).toContain('Match a note')
    expect(html).toContain('Notes in a key')
    expect(html).toContain('Intervals')
    expect(html).toContain('Chord tones')
    expect(html).toContain('Arpeggios')
    expect(html).toContain('Mixed practice')
    expect(html).toContain('Microphone audio is analysed live and is never saved.')
    expect((html.match(/<button/g) ?? [])).toHaveLength(6)
  })
})

function identifyResponseState(exercise: TrainingExerciseSelection, seed: string) {
  let state = desktopTrainingReducer(INITIAL_DESKTOP_TRAINING_STATE, {
    type: 'choose-exercise',
    exercise
  })
  state = desktopTrainingReducer(state, {
    type: 'update-setup',
    patch: { taskMode: 'identify', length: 5, lowMidi: 36, highMidi: 84 }
  })
  state = desktopTrainingReducer(state, { type: 'start-session', seed })
  state = desktopTrainingReducer(state, { type: 'activate-session' })
  return desktopTrainingReducer(state, { type: 'cue-complete' })
}

function vocalResult(
  prompt: TrainingPrompt,
  classification: 'on-target' | 'wrong-octave',
  cents: number
): TrainingAttemptInput {
  return {
    response: 'vocal',
    promptId: prompt.id,
    targets: prompt.targets.map((target, targetIndex) => ({
      targetIndex,
      classification,
      metrics: {
        medianCentsError: cents,
        voicedCoverage: 0.8,
        stableHoldRatio: 0.75,
        detectedMidi: target.midi + cents / 100
      }
    }))
  }
}

function correctIdentifyResult(prompt: TrainingPrompt): TrainingAttemptInput {
  switch (prompt.kind) {
    case 'note':
      return {
        response: 'identify',
        promptId: prompt.id,
        answer: { kind: 'note', pitchClass: prompt.targets[0].pitchClass }
      }
    case 'scale-degree':
      return {
        response: 'identify',
        promptId: prompt.id,
        answer: { kind: 'scale-degree', scaleDegree: prompt.scaleDegree }
      }
    case 'interval':
      return {
        response: 'identify',
        promptId: prompt.id,
        answer: {
          kind: 'interval',
          intervalNumber: prompt.intervalNumber,
          direction: prompt.direction
        }
      }
    case 'chord-tone':
      return {
        response: 'identify',
        promptId: prompt.id,
        answer: { kind: 'chord-tone', role: prompt.role }
      }
    case 'arpeggio':
      return {
        response: 'identify',
        promptId: prompt.id,
        answer: {
          kind: 'arpeggio',
          scaleDegree: prompt.chord.scaleDegree,
          quality: prompt.chord.quality
        }
      }
  }
}

function renderTraining(state: ReturnType<typeof desktopTrainingReducer>): string {
  return renderToStaticMarkup(
    createElement(VocalTraining, {
      state,
      dispatch: vi.fn(),
      engine: { context: { currentTime: 0 } } as never,
      cues: {} as never,
      mic: {} as never,
      onMicDevice: vi.fn()
    })
  )
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

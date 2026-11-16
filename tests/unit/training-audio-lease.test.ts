import { readSourceWithEnglish } from './i18n-source'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { pitchMicrophoneUnavailableCopy } from '../../src/renderer/src/components/PitchStrip'
import VocalTraining, {
  scheduleTrainingFeedbackAdvance,
  shouldAutoStartTrainingPrompt,
  trainingAudioLeaseCopy,
  runTrainingAudioAction
} from '../../src/renderer/src/components/VocalTraining'
import { emptyTrainingProgress } from '../../src/shared/training-progress'
import { trainingCleanupAudioBlockedCopy } from '../../src/renderer/src/audio/training-cleanup'
import {
  desktopTrainingReducer,
  INITIAL_DESKTOP_TRAINING_STATE
} from '../../src/renderer/src/training-ui-state'

describe('pitch strip audio lease', () => {
  it('makes the pitch microphone visibly unavailable during Settings or an audio lease', () => {
    const source = readSourceWithEnglish('src/renderer/src/components/PitchStrip.tsx')
    const appSource = readFileSync('src/renderer/src/App.tsx', 'utf8')
    expect(source).toContain('audioLeaseBlocked?: boolean')
    expect(source).toContain("mic === 'starting' || micUnavailableCopy !== null")
    expect(source).toContain('title={micUnavailableCopy ??')
    expect(source).toContain('aria-label={micUnavailableCopy ??')
    expect(source).toContain('Microphone unavailable while Settings is open')
    expect(source).toContain('audioLeaseCopy ?? trainingCleanupAudioBlockedCopy()')
    expect(source).toContain('setSuspended(settingsOwnsMic || audioLeaseBlocked)')
    expect(appSource).toContain('settingsOwnsMic={showSettings}')
    expect(appSource).toContain("audioLeaseBlocked={trainingCleanupPhase !== 'idle'}")
    expect(appSource).not.toContain('monitorShell')
  })
})

describe('vocal-training audio lease guard', () => {
  it('rejects a closed-Settings direct audio action before it can schedule anything', () => {
    const blocked = vi.fn()
    const schedule = vi.fn()

    expect(runTrainingAudioAction(true, blocked, schedule)).toBe(false)
    expect(blocked).toHaveBeenCalledOnce()
    expect(schedule).not.toHaveBeenCalled()
    expect(runTrainingAudioAction(false, blocked, schedule)).toBe(true)
    expect(schedule).toHaveBeenCalledOnce()
  })

  it('resumes ready auto-start and feedback advance after the global lease clears', () => {
    vi.useFakeTimers()
    try {
      let ready = desktopTrainingReducer(INITIAL_DESKTOP_TRAINING_STATE, {
        type: 'choose-exercise', exercise: 'note'
      })
      ready = desktopTrainingReducer(ready, { type: 'start-session', seed: 'lease-resume' })
      expect(shouldAutoStartTrainingPrompt(true, ready)).toBe(false)
      // Rerender after global Stop: the same unconsumed Ready transition is
      // now eligible and can start normally.
      expect(shouldAutoStartTrainingPrompt(false, ready)).toBe(true)

      const feedback = { ...ready, exercisePhase: 'feedback' as const }
      const nextPrompt = vi.fn()
      let cleanup = scheduleTrainingFeedbackAdvance(true, feedback, nextPrompt)
      vi.advanceTimersByTime(1_500)
      expect(nextPrompt).not.toHaveBeenCalled()

      // Rerender with the released lease. Only this render owns a timer.
      cleanup()
      cleanup = scheduleTrainingFeedbackAdvance(false, feedback, nextPrompt)
      vi.advanceTimersByTime(350)
      expect(nextPrompt).toHaveBeenCalledOnce()
      cleanup()
    } finally {
      vi.useRealTimers()
    }
  })

  it('explains the lease and disables test-note and session-start controls after Settings closes', () => {
    const setup = desktopTrainingReducer(INITIAL_DESKTOP_TRAINING_STATE, {
      type: 'choose-exercise', exercise: 'note'
    })
    const html = renderToStaticMarkup(createElement(VocalTraining, {
      state: setup,
      dispatch: vi.fn(),
      engine: { context: { currentTime: 0 } } as never,
      cues: {} as never,
      mic: {} as never,
      onMicDevice: vi.fn(),
      audioLeaseBlocked: true,
      onSetupChange: vi.fn(),
      referenceVolume: 1,
      onReferenceVolumeChange: vi.fn(),
      progress: emptyTrainingProgress(),
      songPreparation: null,
      onBackToSong: vi.fn()
    }))

    expect(html).toContain(trainingAudioLeaseCopy())
    expect(trainingAudioLeaseCopy()).toBe(trainingCleanupAudioBlockedCopy())
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*Test C4/s)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Start practice<\/button>/)
  })

  it('shows training-cleanup provenance as the only app-level audio lease', () => {
    const setup = desktopTrainingReducer(INITIAL_DESKTOP_TRAINING_STATE, {
      type: 'choose-exercise', exercise: 'note'
    })
    const html = renderToStaticMarkup(createElement(VocalTraining, {
      state: setup,
      dispatch: vi.fn(),
      engine: { context: { currentTime: 0 } } as never,
      cues: {} as never,
      mic: {} as never,
      onMicDevice: vi.fn(),
      audioLeaseBlocked: true,
      audioLeaseCopy: trainingCleanupAudioBlockedCopy(),
      onSetupChange: vi.fn(),
      referenceVolume: 1,
      onReferenceVolumeChange: vi.fn(),
      progress: emptyTrainingProgress(),
      songPreparation: null,
      onBackToSong: vi.fn()
    }))

    expect(html).toContain(trainingCleanupAudioBlockedCopy())
    expect(html).not.toContain('Open Settings to review the audio owner')
    expect(html).not.toMatch(/headphone|monitoring/i)
    expect(pitchMicrophoneUnavailableCopy(
      false,
      true,
      trainingCleanupAudioBlockedCopy()
    )).toBe(trainingCleanupAudioBlockedCopy())
  })

  it('blocks audio preparation, continue, and replay entry points but leaves key setup available', () => {
    const common = {
      dispatch: vi.fn(),
      engine: { context: { currentTime: 0 } } as never,
      cues: {} as never,
      mic: {} as never,
      onMicDevice: vi.fn(),
      audioLeaseBlocked: true,
      onSetupChange: vi.fn(),
      referenceVolume: 1,
      onReferenceVolumeChange: vi.fn(),
      progress: emptyTrainingProgress(),
      onBackToSong: vi.fn()
    }
    const homeHtml = renderToStaticMarkup(createElement(VocalTraining, {
      ...common,
      state: INITIAL_DESKTOP_TRAINING_STATE,
      songPreparation: {
        sourceSongId: '/song', songName: 'Song',
        key: { tonicPc: 0, mode: 'major' as const }, transpose: 0
      }
    }))
    expect(homeHtml.match(/<button type="button" disabled="">/g)).toHaveLength(4)

    const unknownKeyHtml = renderToStaticMarkup(createElement(VocalTraining, {
      ...common,
      state: INITIAL_DESKTOP_TRAINING_STATE,
      songPreparation: {
        sourceSongId: '/song', songName: 'Unknown Key Song', key: null, transpose: 0
      }
    }))
    expect(unknownKeyHtml).toContain('Confirm the song key first')
    expect(unknownKeyHtml).toContain('Choose any preparation focus to open setup')
    expect(unknownKeyHtml).not.toMatch(/<button type="button" disabled="">(?:Notes|Intervals|Chords|Mixed warm-up)<\/button>/)

    let session = desktopTrainingReducer(INITIAL_DESKTOP_TRAINING_STATE, {
      type: 'choose-exercise', exercise: 'note'
    })
    session = desktopTrainingReducer(session, { type: 'start-session', seed: 'lease-ui' })
    session = desktopTrainingReducer(session, { type: 'activate-session' })
    const respond = desktopTrainingReducer(session, { type: 'cue-complete' })
    const respondHtml = renderToStaticMarkup(createElement(VocalTraining, {
      ...common, state: respond, songPreparation: null
    }))
    expect(respondHtml).toMatch(/<button[^>]*aria-label="Replay target note" disabled=""/)

    const interrupted = desktopTrainingReducer(session, { type: 'interrupt-runtime' })
    const interruptedHtml = renderToStaticMarkup(createElement(VocalTraining, {
      ...common, state: interrupted, songPreparation: null
    }))
    expect(interruptedHtml).toMatch(/<button[^>]*disabled=""[^>]*>Continue practice<\/button>/)
  })
})

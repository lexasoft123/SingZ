import { sampleAuditionGain, trainingOrganCurve, TRAINING_INSTRUMENT_BOOST } from '../../../shared/training-sound-levels'
import type { TrainingSound } from '../../../shared/training-sound'
import type { TrainingCue, TrainingCuePurpose } from '../../../shared/training-types'
import { createTrainingVoices } from './training-voices'
import { loadTrainingSamples } from './training-samples'
import type { ScheduledTrainingCue, TrainingCueTimingOptions } from './training-audio'

/** Decode and render only when training plays a reference phrase. The resulting
 * PCM is handed to zcore's persistent output; this context has no audio device. */
export async function renderTrainingPhrase(context: AudioContext, samples: Map<string, AudioBuffer>,
  sound: TrainingSound, cues: readonly TrainingCue[], timing: TrainingCueTimingOptions,
  assertCurrent: () => void): Promise<{ rendered: AudioBuffer; planned: ScheduledTrainingCue[]; durationSec: number }> {
    if (sound !== 'organ') await loadTrainingSamples(context, samples, sound, cues, assertCurrent)
    assertCurrent()
    let cursor = 0
    const planned: ScheduledTrainingCue[] = cues.map((cue, cueIndex) => {
      const notes = cue.notes.map((midi, index) => {
        const startTime = cursor + (cue.articulation === 'together' ? 0 : index * (timing.noteDurationSec + timing.sequenceGapSec))
        return { midi, startTime, endTime: startTime + timing.noteDurationSec }
      })
      const endTime = notes.reduce((end, note) => Math.max(end, note.endTime), cursor)
      const scheduled = { cueIndex, purpose: cue.purpose, startTime: cursor, endTime, notes }
      cursor = endTime + (cueIndex === cues.length - 1 ? 0 : purposeGap(cue.purpose, timing))
      return scheduled
    })
    if (cursor <= 0 || cursor > 120) throw new Error('Invalid training cue duration.')
    const offline = new OfflineAudioContext(2, Math.ceil(cursor * 48000), 48000)
    const organOutput = sound === 'organ' ? offline.createWaveShaper() : null
    if (organOutput) { organOutput.curve = trainingOrganCurve(); organOutput.oversample = '2x'; organOutput.connect(offline.destination) }
    for (const cue of planned) for (const note of cue.notes)
      createTrainingVoices(offline, offline.destination, organOutput, samples, sampleAuditionGain,
        note.midi, note.startTime, note.endTime, timing,
        cues[cue.cueIndex].articulation === 'together' ? 1 / Math.max(1, cue.notes.length) : 1,
        1, sound)
    const rendered = await offline.startRendering()
    for (let channel = 0; channel < rendered.numberOfChannels; channel++) {
      const pcm = rendered.getChannelData(channel)
      for (let index = 0; index < pcm.length; index++) pcm[index] *= TRAINING_INSTRUMENT_BOOST
    }
    return { rendered, planned, durationSec: cursor }
}

function purposeGap(purpose: TrainingCuePurpose, timing: TrainingCueTimingOptions): number {
  switch (purpose) {
    case 'context':
      return timing.contextGapSec
    case 'question':
      return timing.questionGapSec
    case 'answer':
      return timing.answerGapSec
  }
}

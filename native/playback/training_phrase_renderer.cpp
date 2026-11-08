#include "training_phrase_renderer.h"
#include "training_levels.generated.h"
#include <zcore/legacy/resample.h>
#include <algorithm>
#include <array>
#include <cmath>
#include <new>
#include <numbers>

namespace singz {
namespace {
constexpr size_t kMaximumNotes = 256;
bool bounded(double value, double minimum, double maximum) {
  return std::isfinite(value) && value >= minimum && value <= maximum;
}
TrainingPhraseResult failure(TrainingRenderStatus status) {
  TrainingPhraseResult result;
  result.status = status;
  return result;
}
double ramp(double time, double start, double end, double from, double to) {
  return end <= start ? to : from + (to - from) * std::clamp((time - start) / (end - start), 0., 1.);
}
double sampleEnvelope(double time, double duration) {
  const double attack = std::min(.008, duration / 4);
  const double releaseAt = std::max(duration / 2, duration - .15);
  if (time < attack) return ramp(time, 0, attack, 0, 1);
  return time < releaseAt ? 1 : ramp(time, releaseAt, duration, 1, 0);
}
double organEnvelope(double time, double duration, const TrainingPhraseTiming& timing) {
  const double settle = std::min(.18, duration * .55);
  if (time < timing.attack) return ramp(time, 0, timing.attack, 0, .86);
  if (time < settle) return ramp(time, timing.attack, settle, .86, 1);
  if (time < duration - timing.release) return 1;
  return ramp(time, duration - timing.release, duration, 1, 0);
}
// Match the source's 2049-point transfer curve, including linear interpolation.
const std::array<float, 2049>& organCurve() {
  static const auto curve = [] {
    std::array<float, 2049> values{};
    for (size_t i = 0; i < values.size(); ++i)
      values[i] = static_cast<float>(std::tanh((i * 2. / 2048 - 1) * 1.55) / std::tanh(1.55));
    return values;
  }();
  return curve;
}
float shape(double input) {
  const auto& curve = organCurve();
  const double offset = (std::clamp(input, -1., 1.) + 1) * 1024;
  const size_t index = static_cast<size_t>(offset);
  const size_t next = std::min(index + 1, curve.size() - 1);
  return static_cast<float>(curve[index] + (curve[next] - curve[index]) * (offset - index));
}
} // namespace

TrainingPhraseResult renderTrainingPhrase(
    TrainingInstrument instrument, const std::vector<TrainingCue>& cues,
    const TrainingPhraseTiming& timing, TrainingSampleLookup lookup,
    void* lookupContext, DecodeCancellation cancellation) noexcept {
  try {
    const auto instrumentIndex = static_cast<unsigned>(instrument);
    const double settle = std::min(.18, timing.noteDuration * .55);
    if (instrumentIndex > 3 || cues.empty() || cues.size() > 128 ||
        !bounded(timing.noteDuration, .01, 10) || !bounded(timing.sequenceGap, 0, 10) ||
        !bounded(timing.contextGap, 0, 10) || !bounded(timing.questionGap, 0, 10) ||
        !bounded(timing.answerGap, 0, 10) || !bounded(timing.peakGain, 0, 8) ||
        !bounded(timing.attack, 0, settle) || !bounded(timing.release, 0, timing.noteDuration - settle))
      return failure(TrainingRenderStatus::InvalidArgument);
    if (cancellation.isRequested()) return failure(TrainingRenderStatus::Cancelled);
    TrainingPhraseResult result;
    double cursor = 0;
    for (size_t cueIndex = 0; cueIndex < cues.size(); ++cueIndex) {
      const auto& cue = cues[cueIndex];
      if (cue.notes.empty() || cue.notes.size() > 32 ||
          result.notes.size() + cue.notes.size() > kMaximumNotes ||
          static_cast<unsigned>(cue.purpose) > 2)
        return failure(TrainingRenderStatus::InvalidArgument);
      double end = cursor;
      for (size_t i = 0; i < cue.notes.size(); ++i) {
        if (cue.notes[i] < 0 || cue.notes[i] > 127) return failure(TrainingRenderStatus::InvalidArgument);
        const double start = cursor + (cue.together ? 0 : i * (timing.noteDuration + timing.sequenceGap));
        end = start + timing.noteDuration;
        if (end > 120) return failure(TrainingRenderStatus::InvalidArgument);
        result.notes.push_back({cue.notes[i], cueIndex, start, end});
      }
      const double gap = cue.purpose == TrainingPurpose::Context ? timing.contextGap :
          cue.purpose == TrainingPurpose::Question ? timing.questionGap : timing.answerGap;
      cursor = end + (cueIndex + 1 == cues.size() ? 0 : gap);
    }
    result.duration = cursor;
    const size_t frames = static_cast<size_t>(std::ceil(cursor * result.sampleRate));
    if (instrument != TrainingInstrument::Organ) {
      if (!lookup) return failure(TrainingRenderStatus::MissingSample);
      result.planes.assign(2, std::vector<float>(frames));
      // Only five bundled roots can be retained during a phrase render.
      std::array<std::shared_ptr<const DecodedAudio>, 5> samples;
      size_t retainedSampleBytes = 0;
      for (const auto& note : result.notes) {
        if (cancellation.isRequested()) return failure(TrainingRenderStatus::Cancelled);
        const unsigned root = static_cast<unsigned>(std::clamp(std::floor((note.midi - 36) / 12. + .5), 0., 4.));
        auto& sample = samples[root];
        if (!sample) {
          sample = lookup(lookupContext, instrument, root);
          if (sample) {
            if (sample->retainedBytes() > 16 * 1024 * 1024 ||
                retainedSampleBytes + sample->retainedBytes() > 32 * 1024 * 1024)
              return failure(TrainingRenderStatus::ResourceExhausted);
            retainedSampleBytes += sample->retainedBytes();
          }
        }
        if (cancellation.isRequested()) return failure(TrainingRenderStatus::Cancelled);
        if (!sample || sample->channelCount() < 1 || sample->channelCount() > 2 ||
            sample->sampleRate() < 8000 || sample->sampleRate() > 192000 ||
            !sample->frameCount() || sample->frameCount() > sample->sampleRate() * 30ull)
          return failure(TrainingRenderStatus::MissingSample);
        const double rate = std::exp2((note.midi - (36 + static_cast<int>(root) * 12)) / 12.);
        const double duration = std::min(timing.noteDuration, sample->frameCount() / (sample->sampleRate() * rate));
        const auto& cue = cues[note.cueIndex];
        const double level = .6 * kTrainingLevels[instrumentIndex][std::clamp(note.midi - 36, 0, 48)] *
            timing.peakGain * kTrainingBoost / (cue.together ? cue.notes.size() : 1);
        const size_t first = static_cast<size_t>(std::ceil(note.start * result.sampleRate));
        const size_t last = std::min(frames, static_cast<size_t>(std::ceil((note.start + duration) * result.sampleRate)));
        for (size_t frame = first; frame < last; ++frame) {
          if ((frame - first) % 512 == 0 && cancellation.isRequested()) return failure(TrainingRenderStatus::Cancelled);
          const double time = frame / static_cast<double>(result.sampleRate) - note.start;
          const double position = time * sample->sampleRate() * rate;
          const size_t index = std::min(static_cast<size_t>(position), static_cast<size_t>(sample->frameCount() - 1));
          const size_t next = std::min(index + 1, static_cast<size_t>(sample->frameCount() - 1));
          const double fraction = position - index;
          const double gain = sampleEnvelope(time, duration) * level;
          for (size_t channel = 0; channel < 2; ++channel) {
            const auto* pcm = sample->channelData(static_cast<uint32_t>(channel % sample->channelCount()));
            const double value = pcm[index] + (pcm[next] - pcm[index]) * fraction;
            if (!std::isfinite(value)) return failure(TrainingRenderStatus::MissingSample);
            result.planes[channel][frame] += static_cast<float>(value * gain);
          }
        }
      }
    } else {
      // Same registration and envelopes as training-tone.ts/training-voices.ts.
      // The shared native resampler supplies 2x antialias filtering; this is
      // not claimed bit-identical to Chromium's WaveShaper/Oscillator filters.
      std::vector<float> oversampled(frames * 2);
      constexpr std::array<double, 7> ratios{1, 2, 3, 4, 5, 6, 8};
      constexpr std::array<double, 7> levels{.36, .09, .018, .009, .003, .0015, .0005};
      for (const auto& note : result.notes) {
        const auto& cue = cues[note.cueIndex];
        const double fundamental = 440 * std::exp2((note.midi - 69) / 12.);
        const double gain = kTrainingLevels[instrumentIndex][std::clamp(note.midi - 36, 0, 48)] *
            timing.peakGain / (cue.together ? cue.notes.size() : 1);
        const size_t first = static_cast<size_t>(std::ceil(note.start * 96000));
        const size_t last = std::min(oversampled.size(), static_cast<size_t>(std::ceil(note.end * 96000)));
        for (size_t partial = 0; partial < ratios.size(); ++partial) {
          const double frequency = fundamental * ratios[partial];
          if (frequency >= 24000) continue; // Output-band oscillator suppression.
          const double level = gain * levels[partial] / std::sqrt(1 + std::pow(frequency / 2150, 4));
          for (size_t frame = first; frame < last; ++frame) {
            if ((frame - first) % 512 == 0 && cancellation.isRequested()) return failure(TrainingRenderStatus::Cancelled);
            const double time = frame / 96000. - note.start;
            oversampled[frame] += static_cast<float>(std::sin(time * frequency * 2 * std::numbers::pi) *
                level * organEnvelope(time, timing.noteDuration, timing));
          }
        }
      }
      Resampler resampler(96000, 48000, 1);
      std::vector<float> filtered;
      filtered.reserve(frames + 128);
      for (size_t offset = 0; offset < oversampled.size(); offset += 512) {
        if (cancellation.isRequested()) return failure(TrainingRenderStatus::Cancelled);
        const size_t count = std::min(size_t{512}, oversampled.size() - offset);
        for (size_t i = offset; i < offset + count; ++i) oversampled[i] = shape(oversampled[i]);
        resampler.process(oversampled.data() + offset, static_cast<int64_t>(count), filtered);
      }
      resampler.flush(filtered);
      const auto latency = static_cast<size_t>(resampler.latencyOutFrames());
      if (filtered.size() < frames + latency) return failure(TrainingRenderStatus::ResourceExhausted);
      result.planes.assign(2, std::vector<float>(frames));
      for (size_t frame = 0; frame < frames; ++frame) {
        if (frame % 512 == 0 && cancellation.isRequested()) return failure(TrainingRenderStatus::Cancelled);
        result.planes[0][frame] = result.planes[1][frame] = static_cast<float>(filtered[frame + latency] * kTrainingBoost);
      }
    }
    if (cancellation.isRequested()) return failure(TrainingRenderStatus::Cancelled);
    result.status = TrainingRenderStatus::Ok;
    return result;
  } catch (...) {
    return failure(TrainingRenderStatus::ResourceExhausted);
  }
}
} // namespace singz

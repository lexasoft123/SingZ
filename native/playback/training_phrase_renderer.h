#pragma once
#include <zcore/media/decoded_audio.h>
#include <cstdint>
#include <memory>
#include <vector>

namespace singz {
enum class TrainingInstrument { Piano, Electric, Guitar, Organ };
enum class TrainingPurpose { Context, Question, Answer };
struct TrainingCue {
  TrainingPurpose purpose = TrainingPurpose::Question;
  bool together = false;
  std::vector<int> notes;
};
struct TrainingPhraseTiming {
  double noteDuration = .55, sequenceGap = .1;
  double contextGap = .35, questionGap = .45, answerGap = .25;
  double attack = .045, release = .12, peakGain = 1;
};
struct TrainingPlannedNote {
  int midi = 0;
  size_t cueIndex = 0;
  double start = 0, end = 0;
};
// Product boundary resolves authorized, bundled sample descriptors. Rendering
// never opens a path, owns an audio device, or runs on a render callback.
// Lookup must use bounded/cancellable decoding (16 MiB per sample). The renderer
// retains at most 32 MiB of samples and 120 seconds of stereo 48 kHz PCM; organ
// generation additionally holds bounded 2x mono and filtered scratch buffers.
using TrainingSampleLookup = std::shared_ptr<const DecodedAudio> (*)(
    void*, TrainingInstrument, unsigned rootIndex);
enum class TrainingRenderStatus { Ok, InvalidArgument, MissingSample, Cancelled, ResourceExhausted };
struct TrainingPhraseResult {
  TrainingRenderStatus status = TrainingRenderStatus::InvalidArgument;
  std::vector<TrainingPlannedNote> notes;
  std::vector<std::vector<float>> planes;
  double duration = 0;
  static constexpr unsigned sampleRate = 48000;
  bool ok() const noexcept { return status == TrainingRenderStatus::Ok; }
};
TrainingPhraseResult renderTrainingPhrase(
    TrainingInstrument instrument, const std::vector<TrainingCue>& cues,
    const TrainingPhraseTiming& timing = {}, TrainingSampleLookup lookup = nullptr,
    void* lookupContext = nullptr, DecodeCancellation cancellation = {}) noexcept;
} // namespace singz

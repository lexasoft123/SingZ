#pragma once

#include <zdsp/processor.h>

namespace singz {

// Product bounds are deliberately narrower than the generic graph ABI.  They
// keep admission deterministic for the pinned Signalsmith configuration and
// cover mono through 7.1 playback at every conventional audio rate/buffer.
inline constexpr uint32_t kSignalsmithTimePitchMaximumChannels = 8;
inline constexpr double kSignalsmithTimePitchMinimumSampleRate = 8000.0;
inline constexpr double kSignalsmithTimePitchMaximumSampleRate = 192000.0;
inline constexpr uint32_t kSignalsmithTimePitchMaximumBlockFrames = 8192;

struct SignalsmithTimePitchConfig {
  zdsp::NodeId node;
  zdsp::SampleRateHz sampleRate;
  uint32_t channels{0};
  uint32_t maximumBlockFrames{0};
  float transposeSemitones{0.0F};
};

struct SignalsmithTimePitchAnchorInput {
  const float *const *channels{nullptr};
  uint32_t channelCount{0};
  uint32_t frameCount{0};
};

struct SignalsmithTimePitchAnchorStatus {
  uint64_t prepared{0};
  uint64_t published{0};
  uint64_t misses{0};
  bool replacementReady{false};
  bool recurring{false};
};

struct SignalsmithTimePitchLoopPlan {
  uint64_t generation{0};
  uint32_t bank{UINT32_MAX};

  [[nodiscard]] bool valid() const noexcept {
    return generation != 0 && bank != UINT32_MAX;
  }
};

// One-shot clock/route/stream reanchors are prepared on the control thread and
// armed by the generation-bound transport command.  The callback only validates
// this token and swaps an already-warmed processor slot at the reset boundary.
struct SignalsmithTimePitchReanchorPlan {
  uint64_t generation{0};
  uint32_t slot{UINT32_MAX};

  [[nodiscard]] bool valid() const noexcept {
    return generation != 0 && slot != UINT32_MAX;
  }
};

enum class SignalsmithTimePitchLoopPrepareCode : uint32_t {
  Ready = 0,
  Disabled,
  TooShort,
  Unavailable,
  Invalid,
};

struct SignalsmithTimePitchLoopPrepareResult {
  SignalsmithTimePitchLoopPrepareCode code{
      SignalsmithTimePitchLoopPrepareCode::Invalid};
  SignalsmithTimePitchLoopPlan plan{};
  uint32_t minimumOutputFrames{0};

  [[nodiscard]] bool ok() const noexcept {
    return code == SignalsmithTimePitchLoopPrepareCode::Ready ||
           code == SignalsmithTimePitchLoopPrepareCode::Disabled;
  }
};

[[nodiscard]] size_t signalsmithTimePitchStateBytes() noexcept;
[[nodiscard]] size_t signalsmithTimePitchPreparedBytes(
    const SignalsmithTimePitchConfig &config) noexcept;
// Conservative deterministic admission estimate for the pinned 1.3.2
// implementation: external warm scratch plus state and every internal
// FFT/STFT/vector allocation, both independently prepared recurring loop-bank
// sample copies, and explicit headroom.
[[nodiscard]] size_t signalsmithTimePitchRetainedBytes(
    const SignalsmithTimePitchConfig &config) noexcept;
[[nodiscard]] zdsp::ProcessorHandle createSignalsmithTimePitch(
    const SignalsmithTimePitchConfig &config,
    zdsp::MutableByteView stateStorage) noexcept;

// outputSeekLength(1) is structural for the configured processor. The caller
// prepares exactly this many planar pre-target song-bus frames off RT.
[[nodiscard]] uint32_t signalsmithTimePitchAnchorFrames(
    const zdsp::ProcessorHandle &processor) noexcept;
// Loops shorter than this output-domain period are rejected before they can
// reach the callback. The bound is at least 250 ms and also leaves one
// complete anchor-prime window plus two maximum hardware blocks for the
// ordinary-thread replenisher.
[[nodiscard]] uint32_t signalsmithTimePitchMinimumLoopOutputFrames(
    const zdsp::ProcessorHandle &processor) noexcept;
[[nodiscard]] bool primeSignalsmithTimePitchInitial(
    const zdsp::ProcessorHandle &processor,
    const SignalsmithTimePitchAnchorInput &input) noexcept;
[[nodiscard]] bool primeSignalsmithTimePitchSeek(
    const zdsp::ProcessorHandle &processor,
    const SignalsmithTimePitchAnchorInput &input) noexcept;
// Prepare a generic route/stream/sample-rate/clock replacement off RT. The
// returned plan is generation-exact; a newer preparation cannot be published
// by an older transport command.
[[nodiscard]] SignalsmithTimePitchReanchorPlan
primeSignalsmithTimePitchReanchor(
    const zdsp::ProcessorHandle &processor,
    const SignalsmithTimePitchAnchorInput &input) noexcept;
// Callback-domain operations. They perform bounded lock-free validation and
// publication only; all Signalsmith work has already happened off RT.
[[nodiscard]] bool armSignalsmithTimePitchSeek(
    const zdsp::ProcessorHandle &processor) noexcept;
void discardSignalsmithTimePitchSeek(
    const zdsp::ProcessorHandle &processor) noexcept;
[[nodiscard]] bool armSignalsmithTimePitchReanchor(
    const zdsp::ProcessorHandle &processor,
    SignalsmithTimePitchReanchorPlan plan) noexcept;
// Release a generation-exact prepared plan which the callback did not need.
// This is callback-safe for the same reason as arming: one lock-free token CAS
// and one bounded slot-state CAS, with destruction deferred to teardown.
void discardSignalsmithTimePitchReanchor(
    const zdsp::ProcessorHandle &processor,
    SignalsmithTimePitchReanchorPlan plan) noexcept;
// A recurring loop plan owns a two-entry prepared bank. The callback consumes
// one entry per wrap and publishes a lock-free epoch. The ordinary-thread
// replenisher observes it with a bounded poll; the callback never performs an
// OS wake.
// Passing nullptr prepares the generation-exact disabled plan without
// disturbing a separately prepared seek replacement.
[[nodiscard]] SignalsmithTimePitchLoopPrepareResult
configureSignalsmithTimePitchLoop(
    const zdsp::ProcessorHandle &processor,
    const SignalsmithTimePitchAnchorInput *input,
    uint64_t loopOutputFrames) noexcept;
// Callback-domain activation is a bounded atomic bank swap. A plan prepared
// by a superseded control command is ignored generation-exactly.
[[nodiscard]] bool activateSignalsmithTimePitchLoop(
    const zdsp::ProcessorHandle &processor,
    SignalsmithTimePitchLoopPlan plan) noexcept;
void deactivateSignalsmithTimePitchLoop(
    const zdsp::ProcessorHandle &processor) noexcept;
[[nodiscard]] bool signalsmithTimePitchReplacementReady(
    const zdsp::ProcessorHandle &processor) noexcept;
[[nodiscard]] bool signalsmithTimePitchLoopReplacementReady(
    const zdsp::ProcessorHandle &processor) noexcept;
void noteSignalsmithTimePitchLoopDeadlineMiss(
    const zdsp::ProcessorHandle &processor) noexcept;
[[nodiscard]] SignalsmithTimePitchAnchorStatus signalsmithTimePitchAnchorStatus(
    const zdsp::ProcessorHandle &processor) noexcept;

} // namespace singz

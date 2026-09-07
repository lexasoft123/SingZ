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
  /* How often the loop worker has woken — a test's window onto its poll
     rate, which is the idle one until a recurring loop is active. */
  uint64_t workerWakeups{0};
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

// A seek replacement prepared for ONE transport command, which owns it until
// the callback arms it (final one-shot in its drain) or discards it (not the
// final one). Each command carries its own slot, so two seeks in flight can
// never retire each other's replacement. They could through the shared
// `pendingSeekSlot` mailbox: the second seek's prime retired the first's slot
// before the first command had drained, the callback then armed nothing for a
// boundary that had moved the source and refused it — and one refusal is
// terminal for the session (an iPhone 13, 2026-09-05: two seeks 54 ms apart
// at the end of a song, anchor outcome 57, render terminal). `stamp` is the
// slot's prime count: a command whose slot was since retired and re-primed
// for another arms nothing rather than another seek's anchor.
struct SignalsmithTimePitchSeekPlan {
  uint32_t slot{UINT32_MAX};
  uint64_t stamp{0};

  [[nodiscard]] bool valid() const noexcept {
    return slot != UINT32_MAX && stamp != 0;
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
// Per-command seek anchors (see SignalsmithTimePitchSeekPlan). Priming runs on
// the control thread and may block; arming and discarding are bounded,
// lock-free and callback-safe. Nothing here touches the mailbox the
// count-in landing and the standalone prime-then-reset API still use.
[[nodiscard]] SignalsmithTimePitchSeekPlan primeSignalsmithTimePitchSeekPlan(
    const zdsp::ProcessorHandle &processor,
    const SignalsmithTimePitchAnchorInput &input) noexcept;
[[nodiscard]] bool armSignalsmithTimePitchSeekPlan(
    const zdsp::ProcessorHandle &processor,
    SignalsmithTimePitchSeekPlan plan) noexcept;
void discardSignalsmithTimePitchSeekPlan(
    const zdsp::ProcessorHandle &processor,
    SignalsmithTimePitchSeekPlan plan) noexcept;
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

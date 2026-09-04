#include "native_playback_session.h"

#include "native_playback_callback.h"
#include "native_playback_projection.h"
#include "signalsmith_time_pitch.h"

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <limits>
#include <mutex>
#include <new>
#include <stdexcept>
#include <thread>
#include <type_traits>
#include <utility>

#if defined(_WIN32)
#include <io.h>
#else
#include <unistd.h>
#endif

#include <zdsp/audio_host_graph_adapter.h>
#include <zdsp/builtin_nodes.h>
#include <zdsp/decoded_buffer_source.h>
#include <zdsp/graph.h>
#include <zdsp/graph_runner.h>
#include <zdsp/realtime_arena.h>
#include <zdsp/scheduled_cue_source.h>
#include <zdsp/scheduled_gain.h>

namespace singz {
namespace {

// Retained only by prepareFixedLegacy(), a source-level parity oracle while
// the document materializer is brought up. Product prepare always synthesizes
// or consumes a format-1 document and never calls that helper.
constexpr uint64_t kLaneNodeBase = 100;
constexpr uint64_t kTrainingNodeBase = 1300;
constexpr uint64_t kSongMixNode = 1000;
constexpr uint64_t kSongGainNode = 1001;
constexpr uint64_t kTimePitchNode = 1002;
constexpr uint64_t kCueSourceNode = 1100;
constexpr uint64_t kCueMapNode = 1101;
constexpr uint64_t kReferenceGainNode = 1102;
constexpr uint64_t kOutputMixNode = 1200;
constexpr uint64_t kOutputGainNode = 1201;
constexpr uint64_t kLimiterNode = 1202;
constexpr uint64_t kOutputNode = 1203;
constexpr size_t kArenaBaseBytes = 4u * 1024u * 1024u;
constexpr size_t kMaximumArenaBytes = 256u * 1024u * 1024u;
constexpr double kMinimumNativePlaybackRate = 0.25;
constexpr double kMaximumNativePlaybackRate = 4.0;
static_assert(kNativePlaybackMaximumGraphNodes == zdsp::kMaximumGraphNodes);
static_assert(kNativePlaybackMaximumGraphConnections ==
              zdsp::kMaximumGraphConnections);

bool rateToQ32(double rate, uint64_t *result) noexcept {
  if (result == nullptr || !std::isfinite(rate) ||
      rate < kMinimumNativePlaybackRate || rate > kMaximumNativePlaybackRate)
    return false;
  const long double scaled =
      static_cast<long double>(rate) *
      static_cast<long double>(zdsp::kProjectRateOneQ32);
  if (scaled < 1.0L ||
      scaled > static_cast<long double>(std::numeric_limits<uint64_t>::max()))
    return false;
  *result = static_cast<uint64_t>(std::llround(scaled));
  return *result != 0;
}

NativePlaybackResult failure(NativePlaybackError error, uint64_t generation,
                             NativePlaybackState state, std::string message) {
  return {false, error, generation, state, {}, {}, std::move(message)};
}

NativePlaybackResult failureWithoutMessage(NativePlaybackError error,
                                           uint64_t generation,
                                           NativePlaybackState state) noexcept {
  NativePlaybackResult result;
  result.ok = false;
  result.error = error;
  result.generation = generation;
  result.state = state;
  return result;
}

bool finiteGain(float gain) noexcept {
  return std::isfinite(gain) && gain >= 0.0F &&
         gain <= kNativePlaybackMaximumLinearGain;
}

bool validChannels(const std::vector<uint32_t> &channels) noexcept {
  if (channels.empty() || channels.size() > zdsp::kMaximumChannelsPerBus)
    return false;
  for (size_t index = 0; index < channels.size(); ++index) {
    if (channels[index] >= kAudioHostMaxChannels)
      return false;
    for (size_t prior = 0; prior < index; ++prior)
      if (channels[index] == channels[prior])
        return false;
  }
  return true;
}

bool graphDocumentRequestsSignalsmith(
    const std::optional<NativePlaybackGraphDocument> &document) noexcept {
  return document.has_value() &&
         std::any_of(document->nodes.begin(), document->nodes.end(),
                     [](const NativePlaybackGraphNode &node) {
                       // A newer persisted schema is materialized through its
                       // declared unavailable policy, not through the v1
                       // Signalsmith factory.
                       return node.typeVersion == 1 &&
                              nativePlaybackGraphTypeEqual(
                                  node.type,
                                  kGraphTypeSignalsmithTimePitch);
                     });
}

std::optional<size_t> preparedGraphArenaCapacity(
    size_t laneCount, size_t trainingLaneCount, bool hasReference,
    uint32_t outputChannels, uint32_t maximumFrames) noexcept {
  if (trainingLaneCount > laneCount || outputChannels == 0 ||
      maximumFrames == 0)
    return std::nullopt;
  const uint64_t logicalBuffers =
      static_cast<uint64_t>(laneCount) * 4u +
      static_cast<uint64_t>(trainingLaneCount) * 2u +
      (hasReference ? 16u : 8u);
  if (logicalBuffers > std::numeric_limits<uint64_t>::max() /
                           outputChannels ||
      logicalBuffers * outputChannels >
          std::numeric_limits<uint64_t>::max() / maximumFrames ||
      logicalBuffers * outputChannels * maximumFrames >
          std::numeric_limits<uint64_t>::max() / sizeof(float))
    return std::nullopt;
  const uint64_t sampleBytes = logicalBuffers * outputChannels *
                               maximumFrames * sizeof(float);
  if (sampleBytes > std::numeric_limits<uint64_t>::max() -
                        kArenaBaseBytes)
    return std::nullopt;
  const uint64_t requested = kArenaBaseBytes + sampleBytes;
  if (requested > kMaximumArenaBytes ||
      requested > std::numeric_limits<uint32_t>::max() ||
      requested > std::numeric_limits<size_t>::max())
    return std::nullopt;
  return static_cast<size_t>(requested);
}

size_t signalsmithExternalRetainedBytes(
    const SignalsmithTimePitchConfig &config) noexcept {
  const size_t total = signalsmithTimePitchRetainedBytes(config);
  const size_t state = signalsmithTimePitchStateBytes();
  const size_t prepared = signalsmithTimePitchPreparedBytes(config);
  if (prepared > std::numeric_limits<size_t>::max() - state ||
      total <= prepared + state)
    return 0;
  // State and prepared scratch are placement allocations inside arenaBytes.
  // Count only the processor's external heap/banks in addition to that arena.
  return total - prepared - state;
}

zdsp::AudioBusDescriptor descriptor(
    uint32_t channels,
    std::array<zdsp::AudioChannelRole, zdsp::kMaximumChannelsPerBus> *roles) {
  if (channels == 1) {
    return {1, zdsp::SampleFormat::Float32Planar,
            zdsp::AudioChannelLayout::Mono, nullptr};
  }
  if (channels == 2) {
    return {2, zdsp::SampleFormat::Float32Planar,
            zdsp::AudioChannelLayout::Stereo, nullptr};
  }
  for (uint32_t channel = 0; channel < channels; ++channel)
    (*roles)[channel] = zdsp::AudioChannelRole::Discrete;
  return {channels, zdsp::SampleFormat::Float32Planar,
          zdsp::AudioChannelLayout::Discrete, roles->data()};
}

uint64_t presentationLatencyFrames(const AudioHostLatency &latency) noexcept {
  uint64_t total = latency.outputDeviceFrames;
  total += latency.bufferFrames;
  total += latency.externalRouteFrames;
  return total;
}

int64_t latencyAdjustedProjectFrame(int64_t rendered, uint32_t fractionQ32,
                                    uint64_t outputLatency,
                                    uint64_t projectRateQ32) noexcept {
  if (projectRateQ32 == 0 ||
      (outputLatency != 0 &&
       projectRateQ32 > std::numeric_limits<uint64_t>::max() / outputLatency))
    return std::numeric_limits<int64_t>::min();
  const uint64_t deltaQ32 = projectRateQ32 * outputLatency;
  uint64_t whole = deltaQ32 >> 32;
  if (fractionQ32 < static_cast<uint32_t>(deltaQ32))
    ++whole;
  if (whole > static_cast<uint64_t>(std::numeric_limits<int64_t>::max()) ||
      rendered < std::numeric_limits<int64_t>::min() +
                     static_cast<int64_t>(whole))
    return std::numeric_limits<int64_t>::min();
  return rendered - static_cast<int64_t>(whole);
}

NativePlaybackTransportBoundaryReason
nativeBoundaryReason(zdsp::DiscontinuityReason reason) noexcept {
  switch (reason) {
  case zdsp::DiscontinuityReason::None:
    return NativePlaybackTransportBoundaryReason::None;
  case zdsp::DiscontinuityReason::StreamGenerationChanged:
    return NativePlaybackTransportBoundaryReason::StreamGenerationChanged;
  case zdsp::DiscontinuityReason::SequenceGap:
    return NativePlaybackTransportBoundaryReason::SequenceGap;
  case zdsp::DiscontinuityReason::SampleRateChanged:
    return NativePlaybackTransportBoundaryReason::SampleRateChanged;
  case zdsp::DiscontinuityReason::RouteGenerationChanged:
    return NativePlaybackTransportBoundaryReason::RouteGenerationChanged;
  case zdsp::DiscontinuityReason::TimestampQualityChanged:
    return NativePlaybackTransportBoundaryReason::TimestampQualityChanged;
  case zdsp::DiscontinuityReason::ClockReanchored:
    return NativePlaybackTransportBoundaryReason::ClockReanchored;
  case zdsp::DiscontinuityReason::SourceSeek:
    return NativePlaybackTransportBoundaryReason::SourceSeek;
  case zdsp::DiscontinuityReason::SourceLoop:
    return NativePlaybackTransportBoundaryReason::SourceLoop;
  case zdsp::DiscontinuityReason::DeviceLost:
    return NativePlaybackTransportBoundaryReason::DeviceLost;
  case zdsp::DiscontinuityReason::SourceFrameOverflow:
    return NativePlaybackTransportBoundaryReason::SourceFrameOverflow;
  }
  return NativePlaybackTransportBoundaryReason::None;
}

bool safeStoppedState(AudioHostState state) noexcept {
  return state == AudioHostState::Stopped || state == AudioHostState::Closed;
}

AudioHostTerminalCause
effectiveTerminalCause(const AudioHostStatus &host,
                       AudioHostTerminalCause callback) noexcept {
  AudioHostTerminalCause hostCause{host.terminalReason, host.terminalOrdinal};
  if (hostCause.reason != AudioHostTerminalReason::None &&
      hostCause.ordinal == 0)
    hostCause = makeAudioHostTerminalCause(hostCause.reason);
  if (hostCause.reason == AudioHostTerminalReason::None &&
      host.state == AudioHostState::DeviceLost)
    hostCause = makeAudioHostTerminalCause(AudioHostTerminalReason::DeviceLost);
  if (hostCause.reason == AudioHostTerminalReason::None &&
      host.state == AudioHostState::Error)
    hostCause =
        makeAudioHostTerminalCause(AudioHostTerminalReason::ProviderFailure);
  return firstAudioHostTerminalCause(hostCause, callback);
}

NativePlaybackError decodeError(DecodedAudioStatus status) noexcept {
  switch (status) {
  case DecodedAudioStatus::Cancelled:
    return NativePlaybackError::Cancelled;
  case DecodedAudioStatus::LimitExceeded:
    return NativePlaybackError::LimitExceeded;
  case DecodedAudioStatus::ResourceExhausted:
    return NativePlaybackError::ResourceExhausted;
  case DecodedAudioStatus::Ok:
  case DecodedAudioStatus::InvalidArgument:
  case DecodedAudioStatus::IoError:
  case DecodedAudioStatus::UnsupportedFormat:
  case DecodedAudioStatus::MalformedData:
    return NativePlaybackError::DecodeFailure;
  }
  return NativePlaybackError::DecodeFailure;
}

NativePlaybackError cuePlanError(PlaybackCuePlanError error) noexcept {
  switch (error) {
  case PlaybackCuePlanError::None:
    return NativePlaybackError::None;
  case PlaybackCuePlanError::InvalidConfiguration:
    return NativePlaybackError::InvalidConfiguration;
  case PlaybackCuePlanError::LimitExceeded:
    return NativePlaybackError::LimitExceeded;
  case PlaybackCuePlanError::ResourceExhausted:
    return NativePlaybackError::ResourceExhausted;
  }
  return NativePlaybackError::InvalidConfiguration;
}

void injectFailure(NativePlaybackTestHooks *hooks,
                   NativePlaybackAllocationPoint point) {
  if (hooks == nullptr || hooks->inject == nullptr)
    return;
  switch (hooks->inject(hooks->context, point)) {
  case NativePlaybackInjectedFailure::None:
    return;
  case NativePlaybackInjectedFailure::BadAllocation:
    throw std::bad_alloc();
  case NativePlaybackInjectedFailure::Unexpected:
    throw point;
  }
}

enum class PlaybackTransportCommandKind : uint32_t {
  Start = 0,
  Pause,
  Resume,
  Seek,
  SetLoop,
  ClearLoop,
  Reanchor,
  Stop,
};

struct PlaybackTransportCommand {
  uint64_t generation{0};
  PlaybackTransportCommandKind kind{PlaybackTransportCommandKind::Stop};
  NativePlaybackTransportState state{NativePlaybackTransportState::Stopped};
  int64_t projectFrame{0};
  int64_t loopStartFrame{0};
  int64_t loopEndFrame{0};
  SignalsmithTimePitchLoopPlan loopPlan{};
  SignalsmithTimePitchReanchorPlan reanchorPlan{};
  uint32_t projectFractionQ32{0};
};

// Where the song is, for a reader that holds NO lock.
//
// The control mutex is held across host open, start and stop (stop waits for
// callback quiescence), and the transport mailbox has one producer serialized
// by that same mutex — so neither may be touched by a read the UI thread
// makes synchronously many times a second. This is that read's source: a
// second, smaller seqlock beside the transport's own, published by the same
// callback at the same moment, but OWNED BY THE SESSION rather than by the
// generation. The graph holds a shared_ptr to it too, so a quarantined graph
// whose callback never quiesced keeps publishing into memory that is still
// alive rather than into a freed Impl. Every publication carries its
// steady-clock instant, so the reader can say how stale the frame is without
// a wall clock the two sides might not share.
struct PlaybackPositionPublication {
  std::atomic<uint32_t> sequence{0};
  std::atomic<uint64_t> generation{0};
  std::atomic<uint32_t> state{
      static_cast<uint32_t>(NativePlaybackTransportState::Stopped)};
  std::atomic<int64_t> projectFrame{0};
  std::atomic<uint64_t> continuousFrame{0};
  std::atomic<uint64_t> remainingPreRoll{0};
  std::atomic<uint64_t> seekCount{0};
  std::atomic<int64_t> publishedAtNs{0};

  static int64_t nowNs() noexcept {
    return std::chrono::duration_cast<std::chrono::nanoseconds>(
               std::chrono::steady_clock::now().time_since_epoch())
        .count();
  }

  // One writer at a time: the callback while a stream runs, the control
  // thread only while the callback is provably not running (prepare commit,
  // resetForOpen, forced stop after quiescence, unload).
  void publish(uint64_t publishedGeneration,
               NativePlaybackTransportState publishedState, int64_t frame,
               uint64_t continuous, uint64_t preRoll,
               uint64_t seeks) noexcept {
    sequence.fetch_add(1u, std::memory_order_acq_rel);
    generation.store(publishedGeneration, std::memory_order_relaxed);
    state.store(static_cast<uint32_t>(publishedState),
                std::memory_order_relaxed);
    projectFrame.store(frame, std::memory_order_relaxed);
    continuousFrame.store(continuous, std::memory_order_relaxed);
    remainingPreRoll.store(preRoll, std::memory_order_relaxed);
    seekCount.store(seeks, std::memory_order_relaxed);
    publishedAtNs.store(nowNs(), std::memory_order_relaxed);
    sequence.fetch_add(1u, std::memory_order_release);
  }

  void clear() noexcept {
    publish(0, NativePlaybackTransportState::Stopped, 0, 0, 0, 0);
  }

  // Bounded like the transport's reader: eight collisions and the caller
  // keeps what it last had rather than spinning on a UI thread.
  bool snapshot(NativePlaybackPositionNow *out,
                int64_t *publishedAt) const noexcept {
    if (out == nullptr || publishedAt == nullptr)
      return false;
    for (uint32_t attempt = 0; attempt < 8; ++attempt) {
      const uint32_t before = sequence.load(std::memory_order_acquire);
      if ((before & 1u) != 0)
        continue;
      NativePlaybackPositionNow sampled;
      sampled.generation = generation.load(std::memory_order_relaxed);
      sampled.transportState = static_cast<NativePlaybackTransportState>(
          state.load(std::memory_order_relaxed));
      sampled.renderedProjectFrame =
          projectFrame.load(std::memory_order_relaxed);
      sampled.continuousFrame = continuousFrame.load(std::memory_order_relaxed);
      sampled.remainingPreRollFrames =
          remainingPreRoll.load(std::memory_order_relaxed);
      sampled.seekCount = seekCount.load(std::memory_order_relaxed);
      const int64_t at = publishedAtNs.load(std::memory_order_relaxed);
      std::atomic_thread_fence(std::memory_order_acquire);
      if (before == sequence.load(std::memory_order_acquire)) {
        *out = sampled;
        *publishedAt = at;
        return true;
      }
    }
    return false;
  }
};

// Prepared with the graph and owned by the session until callback quiescence.
// The fixed SPSC mailbox is written only by session commands under the control
// mutex and drained only by the audio callback at hardware-block offset zero.
// Callback state is never read directly by the control domain; atomics below
// publish coherent telemetry without putting locks or allocation in render.
struct PreparedPlaybackTransport {
  static constexpr uint32_t kCommandCapacity = 32;

  std::array<PlaybackTransportCommand, kCommandCapacity> commands{};
  std::atomic<uint32_t> commandWrite{0};
  std::atomic<uint32_t> commandRead{0};
  // The session's lock-free position sink. Set once, at prepare commit,
  // before any callback of this generation can run; never changed after, so
  // the callback reads a plain pointer. Shared, not borrowed: see the struct.
  std::shared_ptr<PlaybackPositionPublication> positionSink;
  uint64_t generation{0};
  int64_t initialProjectFrame{0};
  bool initialPaused{false};
  bool initialLoopEnabled{false};
  int64_t initialLoopStart{0};
  int64_t initialLoopEnd{0};
  int64_t durationFrames{0};
  const zdsp::ScheduledCueEvent *cueEvents{nullptr};
  uint32_t cueEventCount{0};
  double playbackRate{1.0};
  uint64_t playbackRateQ32{zdsp::kProjectRateOneQ32};
  zdsp::ProcessorHandle timePitchProcessor{};
  SignalsmithTimePitchLoopPlan initialTimePitchLoopPlan{};
  SignalsmithTimePitchReanchorPlan initialTimePitchReanchorPlan{};

  // Control-domain desired state. Session mutex serialization is sufficient.
  NativePlaybackTransportState desiredState{
      NativePlaybackTransportState::Stopped};
  bool desiredLoopEnabled{false};
  int64_t desiredLoopStart{0};
  int64_t desiredLoopEnd{0};

  // Callback-domain state.
  NativePlaybackTransportState callbackState{
      NativePlaybackTransportState::Stopped};
  int64_t callbackProjectFrame{0};
  uint32_t callbackProjectFractionQ32{0};
  uint64_t callbackContinuousFrame{0};
  bool callbackLoopEnabled{false};
  int64_t callbackLoopStart{0};
  int64_t callbackLoopEnd{0};
  uint64_t callbackRouteGeneration{0};
  uint64_t callbackStreamGeneration{0};
  bool callbackHostIdentityValid{false};
  zdsp::Discontinuity pendingDiscontinuity{zdsp::DiscontinuityReason::None,
                                           zdsp::DiscontinuityFlagNone};
  uint64_t callbackLoopCount{0};
  uint64_t callbackSeekCount{0};
  uint64_t callbackDiscontinuities{0};
  uint64_t callbackProjectionAnchorContinuousFrame{0};
  zdsp::DiscontinuityReason callbackLastBoundary{
      zdsp::DiscontinuityReason::None};
  bool callbackTimePitchBoundaryPrepared{false};
  /* The raw AudioHost flag word behind the coalesced pending boundary, or 0
     when this code queued it. ClockReanchored has three producers — the host
     flag, a Reanchor command, and streamChanged — and the reason alone cannot
     tell them apart, which is the difference between "supply more anchors"
     and "stop queueing this". Callback-thread only, cleared when the boundary
     is emitted. */
  uint32_t pendingHostDiscontinuityFlags{0};
  /* Did the SOURCE position move inside this coalesce window?
   *
   * This, not the reason, is what decides whether the Stretch needs a fresh
   * anchor. The stage's state is a function of source-signal history alone —
   * process() reads no transport time, and an unanchored reset() keeps the
   * last valid processor rather than flushing — so a boundary that does not
   * move the source cannot invalidate it. Keying on the reason cannot express
   * that: ClockReanchored arrives BOTH from the host merely learning its
   * clock (source untouched) and from a Reanchor command that writes
   * callbackProjectFrame (source moved), and only the second needs an anchor.
   *
   * Set at the three sites that move the source AND queue a boundary for it:
   * Seek, a Reanchor carrying a valid plan, and the loop wrap. Cleared when
   * the boundary is emitted. Start moves the source too and is deliberately
   * NOT here — it queues no boundary, so setting it would make the guard
   * refuse the first callback of every generation on a reason of None; the
   * start position is covered instead by the initial reanchor plan that
   * openOutput primes and beginBlock arms. advancePosition is ordinary
   * per-block advance, not a move. */
  bool pendingSourcePositionMoved{false};
  /* A swap asked this transport how much of the current block is still its
     own, which begins the block (commands drained, host flags coalesced) a
     little early. The first slice then must not begin it again. */
  bool blockBegun{false};
  /* Which of nextSlice's refusals fired last. Every one of them presents to
     the product as the same "provider-failure", so without this the only way
     to tell them apart is to guess. */
  std::atomic<uint32_t> lastSliceRefusal{0};
  /* What happened at the ONE site that can arm the first-stream Stretch
     anchor. Refusal 202 says only "no anchor was armed"; this says why. */
  std::atomic<uint32_t> lastAnchorOutcome{0};


  std::atomic<uint64_t> publishedGeneration{0};
  std::atomic<uint32_t> publishedSequence{0};
  std::atomic<uint32_t> publishedState{
      static_cast<uint32_t>(NativePlaybackTransportState::Stopped)};
  std::atomic<int64_t> publishedProjectFrame{0};
  std::atomic<uint32_t> publishedProjectFractionQ32{0};
  std::atomic<uint64_t> publishedContinuousFrame{0};
  std::atomic<uint64_t> publishedRemainingPreRoll{0};
  std::atomic<uint32_t> publishedCueEventsCompleted{0};
  std::atomic<uint32_t> publishedNextCueEvent{0};
  std::atomic<uint32_t> publishedLoopEnabled{0};
  std::atomic<int64_t> publishedLoopStart{0};
  std::atomic<int64_t> publishedLoopEnd{0};
  std::atomic<uint64_t> publishedLoopCount{0};
  std::atomic<uint64_t> publishedSeekCount{0};
  std::atomic<uint64_t> publishedDiscontinuities{0};
  std::atomic<uint64_t> publishedProjectionAnchorContinuousFrame{0};
  std::atomic<uint32_t> publishedLastBoundary{
      static_cast<uint32_t>(zdsp::DiscontinuityReason::None)};

  struct Telemetry {
    uint64_t generation{0};
    NativePlaybackTransportState state{NativePlaybackTransportState::Stopped};
    int64_t projectFrame{0};
    uint32_t projectFractionQ32{0};
    uint64_t continuousFrame{0};
    uint64_t remainingPreRoll{0};
    uint32_t cueEventsCompleted{0};
    uint32_t nextCueEvent{0};
    bool loopEnabled{false};
    int64_t loopStart{0};
    int64_t loopEnd{0};
    uint64_t loopCount{0};
    uint64_t seekCount{0};
    uint64_t discontinuities{0};
    uint64_t projectionAnchorContinuousFrame{0};
    zdsp::DiscontinuityReason lastBoundary{zdsp::DiscontinuityReason::None};
  };

  // Written only during ordinary-thread initialization before publication;
  // it provides an explicit coherent baseline when the bounded seqlock reader
  // collides before any last-good status sample exists.
  Telemetry initialTelemetry{};

  static void increment(uint64_t *value) noexcept {
    if (*value != std::numeric_limits<uint64_t>::max())
      ++*value;
  }

  uint32_t cueIndexAt(int64_t projectFrame,
                      uint32_t projectFractionQ32) const noexcept {
    uint32_t first = 0;
    uint32_t count = cueEventCount;
    while (count != 0) {
      const uint32_t step = count / 2u;
      const uint32_t middle = first + step;
      if (cueEvents[middle].projectTimeSamples < projectFrame ||
          (projectFractionQ32 != 0 &&
           cueEvents[middle].projectTimeSamples == projectFrame)) {
        first = middle + 1u;
        count -= step + 1u;
      } else {
        count = step;
      }
    }
    return first;
  }

  Telemetry callbackTelemetry() const noexcept {
    const uint32_t cueIndex =
        cueEvents == nullptr
            ? 0
            : cueIndexAt(callbackProjectFrame, callbackProjectFractionQ32);
    Telemetry telemetry;
    telemetry.generation = generation;
    telemetry.state = callbackState;
    telemetry.projectFrame = callbackProjectFrame;
    telemetry.projectFractionQ32 = callbackProjectFractionQ32;
    telemetry.continuousFrame = callbackContinuousFrame;
    telemetry.remainingPreRoll =
        callbackProjectFrame < 0
            ? static_cast<uint64_t>(-(callbackProjectFrame + 1)) + 1u
            : 0u;
    telemetry.cueEventsCompleted = cueIndex;
    telemetry.nextCueEvent = cueIndex;
    telemetry.loopEnabled = callbackLoopEnabled;
    telemetry.loopStart = callbackLoopStart;
    telemetry.loopEnd = callbackLoopEnd;
    telemetry.loopCount = callbackLoopCount;
    telemetry.seekCount = callbackSeekCount;
    telemetry.discontinuities = callbackDiscontinuities;
    telemetry.projectionAnchorContinuousFrame =
        callbackProjectionAnchorContinuousFrame;
    telemetry.lastBoundary = callbackLastBoundary;
    return telemetry;
  }

  void publishTelemetry() noexcept {
    const Telemetry telemetry = callbackTelemetry();
    publishedSequence.fetch_add(1u, std::memory_order_acq_rel);
    publishedGeneration.store(telemetry.generation, std::memory_order_relaxed);
    publishedState.store(static_cast<uint32_t>(telemetry.state),
                         std::memory_order_relaxed);
    publishedProjectFrame.store(telemetry.projectFrame,
                                std::memory_order_relaxed);
    publishedProjectFractionQ32.store(telemetry.projectFractionQ32,
                                      std::memory_order_relaxed);
    publishedContinuousFrame.store(telemetry.continuousFrame,
                                   std::memory_order_relaxed);
    publishedRemainingPreRoll.store(telemetry.remainingPreRoll,
                                    std::memory_order_relaxed);
    publishedCueEventsCompleted.store(telemetry.cueEventsCompleted,
                                      std::memory_order_relaxed);
    publishedNextCueEvent.store(telemetry.nextCueEvent,
                                std::memory_order_relaxed);
    publishedLoopEnabled.store(telemetry.loopEnabled ? 1u : 0u,
                               std::memory_order_relaxed);
    publishedLoopStart.store(telemetry.loopStart, std::memory_order_relaxed);
    publishedLoopEnd.store(telemetry.loopEnd, std::memory_order_relaxed);
    publishedLoopCount.store(telemetry.loopCount, std::memory_order_relaxed);
    publishedSeekCount.store(telemetry.seekCount, std::memory_order_relaxed);
    publishedDiscontinuities.store(telemetry.discontinuities,
                                   std::memory_order_relaxed);
    publishedProjectionAnchorContinuousFrame.store(
        telemetry.projectionAnchorContinuousFrame,
        std::memory_order_relaxed);
    publishedLastBoundary.store(static_cast<uint32_t>(telemetry.lastBoundary),
                                std::memory_order_relaxed);
    publishedSequence.fetch_add(1u, std::memory_order_release);
    // The same moment, the same numbers, into the sink the lock-free read
    // sees. Kept after the transport's own publication so status() and
    // positionNow() can never disagree about which callback they describe.
    if (positionSink != nullptr)
      positionSink->publish(telemetry.generation, telemetry.state,
                            telemetry.projectFrame, telemetry.continuousFrame,
                            telemetry.remainingPreRoll, telemetry.seekCount);
  }

  bool snapshotTelemetry(Telemetry *result) const noexcept {
    if (result == nullptr)
      return false;
    for (uint32_t attempt = 0; attempt < 8; ++attempt) {
      const uint32_t before = publishedSequence.load(std::memory_order_acquire);
      if ((before & 1u) != 0)
        continue;
      Telemetry sampled;
      sampled.generation = publishedGeneration.load(std::memory_order_relaxed);
      sampled.state = static_cast<NativePlaybackTransportState>(
          publishedState.load(std::memory_order_relaxed));
      sampled.projectFrame =
          publishedProjectFrame.load(std::memory_order_relaxed);
      sampled.projectFractionQ32 =
          publishedProjectFractionQ32.load(std::memory_order_relaxed);
      sampled.continuousFrame =
          publishedContinuousFrame.load(std::memory_order_relaxed);
      sampled.remainingPreRoll =
          publishedRemainingPreRoll.load(std::memory_order_relaxed);
      sampled.cueEventsCompleted =
          publishedCueEventsCompleted.load(std::memory_order_relaxed);
      sampled.nextCueEvent =
          publishedNextCueEvent.load(std::memory_order_relaxed);
      sampled.loopEnabled =
          publishedLoopEnabled.load(std::memory_order_relaxed) != 0;
      sampled.loopStart = publishedLoopStart.load(std::memory_order_relaxed);
      sampled.loopEnd = publishedLoopEnd.load(std::memory_order_relaxed);
      sampled.loopCount = publishedLoopCount.load(std::memory_order_relaxed);
      sampled.seekCount = publishedSeekCount.load(std::memory_order_relaxed);
      sampled.discontinuities =
          publishedDiscontinuities.load(std::memory_order_relaxed);
      sampled.projectionAnchorContinuousFrame =
          publishedProjectionAnchorContinuousFrame.load(
              std::memory_order_relaxed);
      sampled.lastBoundary = static_cast<zdsp::DiscontinuityReason>(
          publishedLastBoundary.load(std::memory_order_relaxed));
      std::atomic_thread_fence(std::memory_order_acquire);
      if (before == publishedSequence.load(std::memory_order_acquire)) {
        *result = sampled;
        return true;
      }
    }
    return false;
  }

  Telemetry initialTelemetrySnapshot() const noexcept {
    return initialTelemetry;
  }

  void overlayQueuedPositionIntent(Telemetry *anchor) const noexcept {
    if (anchor == nullptr)
      return;
    const uint32_t read = commandRead.load(std::memory_order_acquire);
    const uint32_t write = commandWrite.load(std::memory_order_acquire);
    // The producer is serialized by the session mutex and the callback never
    // overwrites mailbox entries. Scan the bounded unconsumed suffix so a
    // reanchor queued behind seeks is primed for the last positional intent,
    // not for telemetry from before those commands.
    for (uint32_t cursor = read; cursor != write; ++cursor) {
      const PlaybackTransportCommand command =
          commands[cursor % kCommandCapacity];
      if (command.generation != generation)
        continue;
      if (command.kind == PlaybackTransportCommandKind::Start ||
          command.kind == PlaybackTransportCommandKind::Seek ||
          command.kind == PlaybackTransportCommandKind::Reanchor) {
        anchor->projectFrame = command.projectFrame;
        anchor->projectFractionQ32 = command.projectFractionQ32;
      }
    }
  }

  void initialize(uint64_t transportGeneration, int64_t initialFrame,
                  const NativePlaybackInitialTransportConfig &initialTransport,
                  int64_t authoritativeDuration,
                  const zdsp::ScheduledCueEvent *events, uint32_t eventCount,
                  double rate,
                  zdsp::ProcessorHandle preparedTimePitch,
                  SignalsmithTimePitchLoopPlan preparedLoopPlan,
                  SignalsmithTimePitchReanchorPlan
                      preparedInitialReanchorPlan) noexcept {
    generation = transportGeneration;
    initialProjectFrame = initialFrame;
    initialPaused = initialTransport.startPaused;
    initialLoopEnabled = initialTransport.loop.has_value();
    initialLoopStart = initialTransport.loop.has_value()
                           ? initialTransport.loop->startProjectFrame
                           : 0;
    initialLoopEnd = initialTransport.loop.has_value()
                         ? initialTransport.loop->endProjectFrame
                         : 0;
    durationFrames = authoritativeDuration;
    cueEvents = events;
    cueEventCount = eventCount;
    playbackRate = rate;
    timePitchProcessor = preparedTimePitch;
    initialTimePitchLoopPlan = preparedLoopPlan;
    initialTimePitchReanchorPlan = preparedInitialReanchorPlan;
    if (!rateToQ32(rate, &playbackRateQ32))
      playbackRateQ32 = zdsp::kProjectRateOneQ32;
    resetForOpen();
  }

  void resetForOpen() noexcept {
    commandRead.store(0, std::memory_order_relaxed);
    commandWrite.store(0, std::memory_order_relaxed);
    desiredState = NativePlaybackTransportState::Stopped;
    // Initial/restored transport is published as one prepared contract. The
    // callback still installs it on Start, but control commands issued before
    // that first callback must resolve against the same loop rather than a
    // second, falsely empty control-domain truth.
    desiredLoopEnabled = initialLoopEnabled;
    desiredLoopStart = initialLoopEnabled ? initialLoopStart : 0;
    desiredLoopEnd = initialLoopEnabled ? initialLoopEnd : 0;
    callbackState = NativePlaybackTransportState::Stopped;
    callbackProjectFrame = initialProjectFrame;
    callbackProjectFractionQ32 = 0;
    callbackContinuousFrame = 0;
    callbackLoopEnabled = false;
    callbackLoopStart = 0;
    callbackLoopEnd = 0;
    callbackRouteGeneration = 0;
    callbackStreamGeneration = 0;
    callbackHostIdentityValid = false;
    pendingDiscontinuity = {zdsp::DiscontinuityReason::None,
                            zdsp::DiscontinuityFlagNone};
    pendingHostDiscontinuityFlags = 0;
    pendingSourcePositionMoved = false;
    blockBegun = false;
    callbackLoopCount = 0;
    callbackSeekCount = 0;
    callbackDiscontinuities = 0;
    callbackProjectionAnchorContinuousFrame = 0;
    callbackLastBoundary = zdsp::DiscontinuityReason::None;
    callbackTimePitchBoundaryPrepared = false;
    // Both diagnostics describe THIS generation. Left unreset they carry the
    // previous one's codes across a re-prepare and describe a graph that no
    // longer exists.
    lastSliceRefusal.store(0, std::memory_order_relaxed);
    lastAnchorOutcome.store(0, std::memory_order_relaxed);
    initialTelemetry = callbackTelemetry();
    publishTelemetry();
  }

  bool enqueue(PlaybackTransportCommand command) noexcept {
    const uint32_t write = commandWrite.load(std::memory_order_relaxed);
    const uint32_t read = commandRead.load(std::memory_order_acquire);
    if (write - read >= kCommandCapacity)
      return false;
    commands[write % kCommandCapacity] = command;
    commandWrite.store(write + 1u, std::memory_order_release);
    return true;
  }

  bool hasCommandCapacity() const noexcept {
    const uint32_t write = commandWrite.load(std::memory_order_relaxed);
    const uint32_t read = commandRead.load(std::memory_order_acquire);
    return write - read < kCommandCapacity;
  }

  int64_t resolvedSeekFrame(int64_t projectFrame) const noexcept {
    if (!desiredLoopEnabled || projectFrame < desiredLoopEnd)
      return projectFrame;
    const uint64_t span = static_cast<uint64_t>(desiredLoopEnd) -
                          static_cast<uint64_t>(desiredLoopStart);
    const uint64_t elapsed = static_cast<uint64_t>(projectFrame) -
                             static_cast<uint64_t>(desiredLoopStart);
    return desiredLoopStart + static_cast<int64_t>(elapsed % span);
  }

  bool start() noexcept {
    const NativePlaybackTransportState state =
        initialPaused
            ? NativePlaybackTransportState::Paused
            : (initialProjectFrame < 0 ? NativePlaybackTransportState::PreRoll
                                       : NativePlaybackTransportState::Playing);
    if (!enqueue({generation, PlaybackTransportCommandKind::Start, state,
                  initialProjectFrame,
                  initialLoopEnabled ? initialLoopStart : 0,
                  initialLoopEnabled ? initialLoopEnd : 0,
                  initialTimePitchLoopPlan}))
      return false;
    desiredState = state;
    return true;
  }

  bool pause() noexcept {
    if (desiredState != NativePlaybackTransportState::Playing &&
        desiredState != NativePlaybackTransportState::PreRoll)
      return false;
    if (!enqueue({generation, PlaybackTransportCommandKind::Pause,
                  NativePlaybackTransportState::Paused, 0, 0, 0}))
      return false;
    desiredState = NativePlaybackTransportState::Paused;
    return true;
  }

  bool resume() noexcept {
    if (desiredState != NativePlaybackTransportState::Paused)
      return false;
    /* The published frame is where the callback LAST was, not where it will
       be: a seek it has not drained yet, or has drained and not yet published,
       moves the transport before this Resume is applied. Resolving Completed
       here off that stale frame is how `seek(0); resume()` on a song parked at
       its end came back as Completed AT FRAME ZERO — the callback applied the
       seek, then a Resume that said the song was over, and Play did nothing.
       So this decides only PreRoll or Playing. Completed is the callback's
       call, made from its own frame on the next block, which is exactly how a
       song running out is reported — the control domain still says Playing,
       so the park that follows (pause) is accepted, and a resume that really
       is at the end ends the song one block later instead of at once. */
    const int64_t frame = publishedProjectFrame.load(std::memory_order_relaxed);
    const NativePlaybackTransportState state =
        frame < 0 ? NativePlaybackTransportState::PreRoll
                  : NativePlaybackTransportState::Playing;
    if (!enqueue(
            {generation, PlaybackTransportCommandKind::Resume, state, 0, 0, 0}))
      return false;
    desiredState = state;
    return true;
  }

  bool seek(int64_t projectFrame) noexcept {
    const NativePlaybackTransportState state =
        desiredState == NativePlaybackTransportState::Paused
            ? NativePlaybackTransportState::Paused
            : (projectFrame >= durationFrames
                   ? NativePlaybackTransportState::Completed
                   : NativePlaybackTransportState::Playing);
    if (!enqueue({generation, PlaybackTransportCommandKind::Seek, state,
                  projectFrame, 0, 0}))
      return false;
    desiredState = state;
    return true;
  }

  bool setLoop(int64_t startFrame, int64_t endFrame,
               SignalsmithTimePitchLoopPlan loopPlan) noexcept {
    if (!enqueue({generation, PlaybackTransportCommandKind::SetLoop,
                  desiredState, 0, startFrame, endFrame, loopPlan}))
      return false;
    desiredLoopEnabled = true;
    desiredLoopStart = startFrame;
    desiredLoopEnd = endFrame;
    return true;
  }

  bool clearLoop() noexcept {
    if (!enqueue({generation, PlaybackTransportCommandKind::ClearLoop,
                  desiredState, 0, 0, 0}))
      return false;
    desiredLoopEnabled = false;
    desiredLoopStart = 0;
    desiredLoopEnd = 0;
    return true;
  }

  bool reanchor(int64_t projectFrame, uint32_t projectFractionQ32,
                SignalsmithTimePitchReanchorPlan plan) noexcept {
    return enqueue({generation, PlaybackTransportCommandKind::Reanchor,
                    desiredState, projectFrame, 0, 0, {}, plan,
                    projectFractionQ32});
  }

  bool stop() noexcept {
    if (!enqueue({generation, PlaybackTransportCommandKind::Stop,
                  NativePlaybackTransportState::Stopped, 0, 0, 0}))
      return false;
    desiredState = NativePlaybackTransportState::Stopped;
    return true;
  }

  void forceStoppedAfterQuiescence() noexcept {
    callbackState = NativePlaybackTransportState::Stopped;
    desiredState = NativePlaybackTransportState::Stopped;
    publishTelemetry();
  }

  void queueDiscontinuity(zdsp::Discontinuity discontinuity) noexcept {
    pendingDiscontinuity = zdsp::coalesceAudioHostDiscontinuity(
        pendingDiscontinuity, discontinuity);
  }

  zdsp::Discontinuity emitPendingDiscontinuity() noexcept {
    const zdsp::Discontinuity emitted = pendingDiscontinuity;
    pendingDiscontinuity = {zdsp::DiscontinuityReason::None,
                            zdsp::DiscontinuityFlagNone};
    pendingHostDiscontinuityFlags = 0;
    pendingSourcePositionMoved = false;
    if (emitted.reason == zdsp::DiscontinuityReason::None)
      return emitted;
    increment(&callbackDiscontinuities);
    callbackLastBoundary = emitted.reason;
    callbackProjectionAnchorContinuousFrame = callbackContinuousFrame;
    // These are counts of emitted typed reset boundaries, not control
    // commands or physical wraps hidden by a higher-priority host boundary.
    if (emitted.reason == zdsp::DiscontinuityReason::SourceSeek)
      increment(&callbackSeekCount);
    if (emitted.reason == zdsp::DiscontinuityReason::SourceLoop)
      increment(&callbackLoopCount);
    return emitted;
  }

  void applyCommands() noexcept {
    uint32_t read = commandRead.load(std::memory_order_relaxed);
    const uint32_t write = commandWrite.load(std::memory_order_acquire);
    uint32_t finalOneShotCommand = 0;
    bool hasFinalOneShotCommand = false;
    for (uint32_t cursor = read; cursor != write; ++cursor) {
      const PlaybackTransportCommand command =
          commands[cursor % kCommandCapacity];
      if (command.generation == generation &&
          (command.kind == PlaybackTransportCommandKind::Seek ||
           command.kind == PlaybackTransportCommandKind::Reanchor)) {
        finalOneShotCommand = cursor;
        hasFinalOneShotCommand = true;
      }
    }
    while (read != write) {
      const uint32_t commandIndex = read;
      const PlaybackTransportCommand command =
          commands[read % kCommandCapacity];
      ++read;
      if (command.generation != generation)
        continue;
      switch (command.kind) {
      case PlaybackTransportCommandKind::Start:
        callbackProjectFrame = command.projectFrame;
        callbackProjectFractionQ32 = 0;
        callbackState = command.state;
        callbackLoopEnabled = command.loopEndFrame > command.loopStartFrame;
        callbackLoopStart = callbackLoopEnabled ? command.loopStartFrame : 0;
        callbackLoopEnd = callbackLoopEnabled ? command.loopEndFrame : 0;
        if (callbackLoopEnabled && timePitchProcessor.state != nullptr)
          (void)activateSignalsmithTimePitchLoop(timePitchProcessor,
                                                 command.loopPlan);
        // Preview clicks can own and advance this same native callback before
        // song transport starts. Continuous time is a stream clock, so Start
        // anchors project projection at the current frame instead of rewinding
        // it to zero and making telemetry move backwards.
        callbackProjectionAnchorContinuousFrame = callbackContinuousFrame;
        break;
      case PlaybackTransportCommandKind::Pause:
        callbackState = NativePlaybackTransportState::Paused;
        callbackProjectionAnchorContinuousFrame = callbackContinuousFrame;
        break;
      case PlaybackTransportCommandKind::Resume:
        callbackState = command.state;
        callbackProjectionAnchorContinuousFrame = callbackContinuousFrame;
        break;
      case PlaybackTransportCommandKind::Seek:
        callbackProjectFrame = command.projectFrame;
        callbackProjectFractionQ32 = 0;
        pendingSourcePositionMoved = true;
        callbackState = command.state;
        callbackProjectionAnchorContinuousFrame = callbackContinuousFrame;
        if (hasFinalOneShotCommand && commandIndex == finalOneShotCommand &&
            timePitchProcessor.state != nullptr &&
            armSignalsmithTimePitchSeek(timePitchProcessor))
          callbackTimePitchBoundaryPrepared = true;
        queueDiscontinuity({zdsp::DiscontinuityReason::SourceSeek,
                            zdsp::DiscontinuityFlagResetState |
                                zdsp::DiscontinuityFlagTimeValid});
        break;
      case PlaybackTransportCommandKind::SetLoop:
        callbackLoopEnabled = true;
        callbackLoopStart = command.loopStartFrame;
        callbackLoopEnd = command.loopEndFrame;
        if (timePitchProcessor.state != nullptr)
          (void)activateSignalsmithTimePitchLoop(timePitchProcessor,
                                                 command.loopPlan);
        break;
      case PlaybackTransportCommandKind::ClearLoop:
        callbackLoopEnabled = false;
        callbackLoopStart = 0;
        callbackLoopEnd = 0;
        deactivateSignalsmithTimePitchLoop(timePitchProcessor);
        break;
      case PlaybackTransportCommandKind::Reanchor:
        if (command.reanchorPlan.valid()) {
          callbackProjectFrame = command.projectFrame;
          callbackProjectFractionQ32 = command.projectFractionQ32;
          pendingSourcePositionMoved = true;
        }
        if (timePitchProcessor.state != nullptr) {
          if (hasFinalOneShotCommand && commandIndex == finalOneShotCommand) {
            discardSignalsmithTimePitchSeek(timePitchProcessor);
            callbackTimePitchBoundaryPrepared =
                armSignalsmithTimePitchReanchor(timePitchProcessor,
                                                command.reanchorPlan);
          } else {
            discardSignalsmithTimePitchReanchor(timePitchProcessor,
                                                command.reanchorPlan);
          }
        }
        queueDiscontinuity({zdsp::DiscontinuityReason::ClockReanchored,
                            zdsp::DiscontinuityFlagResetState |
                                zdsp::DiscontinuityFlagTimeValid});
        break;
      case PlaybackTransportCommandKind::Stop:
        callbackState = NativePlaybackTransportState::Stopped;
        callbackProjectionAnchorContinuousFrame = callbackContinuousFrame;
        break;
      }
    }
    commandRead.store(read, std::memory_order_release);
  }

  void beginBlock(const AudioHostRenderBlock &block) noexcept {
    applyCommands();
    const bool firstHostIdentity = !callbackHostIdentityValid;
    const bool routeChanged = callbackHostIdentityValid &&
                              callbackRouteGeneration != block.routeGeneration;
    const bool streamChanged =
        callbackHostIdentityValid &&
        callbackStreamGeneration != block.streamGeneration;
    if (!callbackHostIdentityValid || routeChanged || streamChanged) {
      callbackRouteGeneration = block.routeGeneration;
      callbackStreamGeneration = block.streamGeneration;
      callbackHostIdentityValid = true;
    }
    // Coalesce every same-frame reset fact before emitting one boundary.
    // Host/identity reset reasons outrank source seek/loop by the shared
    // adapter priority table, so provider requests cannot erase route truth.
    pendingHostDiscontinuityFlags |= block.discontinuity;
    queueDiscontinuity(zdsp::mapAudioHostDiscontinuity(block.discontinuity));
    if (routeChanged)
      queueDiscontinuity({zdsp::DiscontinuityReason::RouteGenerationChanged,
                          zdsp::DiscontinuityFlagResetState |
                              zdsp::DiscontinuityFlagTimeValid});
    if (streamChanged)
      queueDiscontinuity({zdsp::DiscontinuityReason::ClockReanchored,
                          zdsp::DiscontinuityFlagResetState |
                              zdsp::DiscontinuityFlagTimeValid});
    /* FIRST visit only. beginBlock runs once per hardware callback, so an
       unconditional store overwrites the arming result with "the site was not
       reachable" on callback two — and the terminal poll lands milliseconds
       later, so every session read 12 whether it armed an anchor or never
       tried. That made a healthy first callback indistinguishable from a
       missing one, in the field, in the value the diagnosis rests on. */
    if (timePitchProcessor.state != nullptr &&
        lastAnchorOutcome.load(std::memory_order_relaxed) == 0)
      lastAnchorOutcome.store(firstHostIdentity ? (initialTimePitchReanchorPlan.valid() ? 10 : 11)
                                                : 12,
                              std::memory_order_relaxed);
    if (firstHostIdentity && timePitchProcessor.state != nullptr &&
        initialTimePitchReanchorPlan.valid()) {
      const bool genericBoundary =
          pendingDiscontinuity.reason != zdsp::DiscontinuityReason::None &&
          pendingDiscontinuity.reason != zdsp::DiscontinuityReason::SourceLoop &&
          pendingDiscontinuity.reason != zdsp::DiscontinuityReason::SourceSeek;
      // A seek or explicit reanchor command may already have armed the exact
      // source anchor for this coalesced boundary. The duplicate initial plan
      // is only the first-host fallback and must never overwrite it.
      if (genericBoundary && !callbackTimePitchBoundaryPrepared) {
        callbackTimePitchBoundaryPrepared = armSignalsmithTimePitchReanchor(
            timePitchProcessor, initialTimePitchReanchorPlan);
        lastAnchorOutcome.store(callbackTimePitchBoundaryPrepared ? 20 : 21,
                                std::memory_order_relaxed);
      } else {
        discardSignalsmithTimePitchReanchor(timePitchProcessor,
                                            initialTimePitchReanchorPlan);
        lastAnchorOutcome.store(
            callbackTimePitchBoundaryPrepared ? 22
                                              : (30 + static_cast<uint32_t>(
                                                          pendingDiscontinuity.reason)),
            std::memory_order_relaxed);
      }
      initialTimePitchReanchorPlan = {};
    }
  }

  // The project clock's arithmetic, on any (frame, fraction, rate) — the
  // callback's own, and the control thread's when it predicts where the
  // callback will be at a stream frame it has yet to reach (a swap landing
  // on the frame its Stretch anchor was filled for). One definition, so the
  // prediction is the callback's answer to the bit.
  static bool positionFrom(int64_t frame, uint32_t fractionQ32,
                           uint64_t rateQ32, uint32_t outputOffset,
                           zdsp::ProjectSamplePositionQ32 *position) noexcept {
    zdsp::TransportContext transport{};
    transport.validFields = zdsp::TransportValidProjectSamples |
                            zdsp::TransportValidProjectRateQ32;
    transport.projectTimeSamples = frame;
    transport.projectTimeFractionQ32 = fractionQ32;
    transport.projectRateQ32 = rateQ32;
    return zdsp::projectSamplePositionAt(transport, outputOffset, position);
  }

  // Return the first rendered-output offset whose Q32 project position is at
  // or beyond the integer project boundary. The callback block is tiny and
  // rate is positive, so a bounded binary search avoids wide multiplication
  // and remains portable to MSVC without compiler-specific 128-bit integers.
  static uint32_t framesToBoundaryFrom(int64_t frame, uint32_t fractionQ32,
                                       uint64_t rateQ32, int64_t boundary,
                                       uint32_t maximumFrames) noexcept {
    const auto reaches = [&](uint32_t offset) noexcept {
      zdsp::ProjectSamplePositionQ32 position{};
      return positionFrom(frame, fractionQ32, rateQ32, offset, &position) &&
             position.samples >= boundary;
    };
    if (maximumFrames == 0 || frame >= boundary)
      return 0;
    if (!reaches(maximumFrames))
      return maximumFrames;
    uint32_t low = 1;
    uint32_t high = maximumFrames;
    while (low < high) {
      const uint32_t middle = low + (high - low) / 2u;
      if (reaches(middle))
        high = middle;
      else
        low = middle + 1u;
    }
    return low;
  }

  bool positionAtOffset(uint32_t outputOffset,
                        zdsp::ProjectSamplePositionQ32 *position) const
      noexcept {
    return positionFrom(callbackProjectFrame, callbackProjectFractionQ32,
                        playbackRateQ32, outputOffset, position);
  }

  bool advancePosition(uint32_t outputFrames) noexcept {
    zdsp::ProjectSamplePositionQ32 position{};
    if (!positionAtOffset(outputFrames, &position))
      return false;
    callbackProjectFrame = position.samples;
    callbackProjectFractionQ32 = position.fraction;
    return true;
  }

  uint32_t framesToBoundary(int64_t boundary,
                            uint32_t maximumFrames) const noexcept {
    return framesToBoundaryFrom(callbackProjectFrame,
                                callbackProjectFractionQ32, playbackRateQ32,
                                boundary, maximumFrames);
  }

  /* Where the callback's clock will be `outputFrames` stream frames after a
     published telemetry sample, assuming no command lands in between (the
     caller checks the mailbox is drained): nextSlice's own advance — cut at
     the loop end and the duration, wrap at the loop end, stop advancing at
     the end of the song — replayed off the render thread. Exact, because
     Q32 advance is associative and nextSlice cuts at the same boundaries. */
  struct PredictedPosition {
    int64_t frame{0};
    uint32_t fractionQ32{0};
    bool valid{false};
  };
  /* `landLoop*` is the INCOMING generation's loop: the handoff wraps the
     adopted clock by that loop before comparing (a seam that falls on the
     outgoing loop's end hands over the pre-wrap frame, since the wrap is the
     next slice's first act), so the prediction wraps the same way. */
  PredictedPosition predictPosition(const Telemetry &from,
                                    uint64_t outputFrames, bool landLoopEnabled,
                                    int64_t landLoopStart,
                                    int64_t landLoopEnd) const noexcept {
    PredictedPosition out{from.projectFrame, from.projectFractionQ32, true};
    bool advancing = from.state == NativePlaybackTransportState::Playing ||
                     from.state == NativePlaybackTransportState::PreRoll;
    uint64_t remaining = outputFrames;
    // Bounded: every pass either consumes at least one frame or wraps, and
    // a wrap is followed by a pass that consumes. A pass is cut at the loop
    // end exactly as nextSlice cuts a slice there, and the wrap by the
    // OUTGOING loop comes first in the next pass, exactly as nextSlice wraps
    // before it looks at the duration — a loop that ends at the song's end
    // is the case where the order matters (the duration check would stop
    // the advance a wrap should have continued), and an incoming loop that
    // differs from the outgoing one is the case where the end wrap below
    // is not the same modulo.
    for (uint32_t pass = 0; pass < 64 && advancing && remaining != 0; ++pass) {
      if (from.loopEnabled && from.loopEnd > from.loopStart &&
          out.frame >= from.loopEnd) {
        out.frame = wrappedLoopFrame(out.frame, from.loopStart, from.loopEnd);
        continue;
      }
      if (out.frame >= durationFrames) {
        advancing = false;
        break;
      }
      int64_t boundary = durationFrames;
      if (from.loopEnabled && out.frame < from.loopEnd)
        boundary = std::min(boundary, from.loopEnd);
      const uint32_t chunk = static_cast<uint32_t>(
          std::min<uint64_t>(remaining, kAudioHostMaxFrames));
      const uint32_t frames =
          framesToBoundaryFrom(out.frame, out.fractionQ32, playbackRateQ32,
                               boundary, chunk);
      zdsp::ProjectSamplePositionQ32 position{};
      if (frames == 0 ||
          !positionFrom(out.frame, out.fractionQ32, playbackRateQ32, frames,
                        &position)) {
        out.valid = false;
        return out;
      }
      out.frame = position.samples;
      out.fractionQ32 = position.fraction;
      remaining -= frames;
    }
    out.valid = out.valid && (!advancing || remaining == 0);
    if (out.valid && landLoopEnabled && landLoopEnd > landLoopStart &&
        out.frame >= landLoopEnd)
      out.frame = wrappedLoopFrame(out.frame, landLoopStart, landLoopEnd);
    return out;
  }

  static int64_t wrappedLoopFrame(int64_t frame, int64_t loopStart,
                                  int64_t loopEnd) noexcept {
    const uint64_t span = static_cast<uint64_t>(loopEnd) -
                          static_cast<uint64_t>(loopStart);
    const uint64_t elapsed = static_cast<uint64_t>(frame) -
                             static_cast<uint64_t>(loopStart);
    return loopStart + static_cast<int64_t>(elapsed % span);
  }

  bool mailboxDrained() const noexcept {
    return commandWrite.load(std::memory_order_acquire) ==
           commandRead.load(std::memory_order_acquire);
  }

  // --- Replacing a generation on the running stream ---------------------
  //
  // A swap prepares the next generation while this one renders and hands the
  // clock across at a block boundary of the render thread's choosing. Three
  // pieces: the control domain copies its desired state across at arm time
  // (adoptControlState, under the session mutex); the render thread asks the
  // OUTGOING transport how much of the current block is still its own
  // (framesBeforeSwap); and between the two renders the INCOMING transport
  // takes the outgoing one's clock (adoptClock). Sources follow the clock, so
  // the incoming graph is never repositioned — it simply renders from the
  // frame the outgoing one reached.

  void adoptControlState(const PreparedPlaybackTransport &from) noexcept {
    desiredState = from.desiredState;
    // The loop is the incoming generation's own declaration (its initial
    // transport carries the current loop, exactly as a rebuild's does), not
    // the outgoing one's: its Stretch loop bank was primed for that loop and
    // no other. resetForOpen already made desiredLoop* say so.
  }

  void beginBlockOnce(const AudioHostRenderBlock &block) noexcept {
    if (blockBegun)
      return;
    blockBegun = true;
    beginBlock(block);
  }

  /* How many frames of `block` this (outgoing) transport still owns.
     `landingContinuousFrame` is the stream frame the swap was armed to land
     on, 0 for "the first frame of the next block". Begins the block first,
     so the answer is taken after this block's commands have been applied — a
     pause drained here lands the swap at once rather than a block later. A
     landing frame already behind the clock lands at once too (late, and the
     session counts it). */
  uint32_t framesBeforeSwap(const AudioHostRenderBlock &block,
                            uint64_t landingContinuousFrame) noexcept {
    beginBlockOnce(block);
    if (landingContinuousFrame == 0)
      return 0;
    const bool advancing =
        callbackState == NativePlaybackTransportState::Playing ||
        callbackState == NativePlaybackTransportState::PreRoll;
    if (!advancing || landingContinuousFrame <= callbackContinuousFrame)
      return 0;
    const uint64_t ahead = landingContinuousFrame - callbackContinuousFrame;
    return ahead >= block.frames ? block.frames
                                 : static_cast<uint32_t>(ahead);
  }

  /* The handoff at the seam, on the render thread, with neither graph
     rendering. Everything callback-owned crosses, including a boundary the
     outgoing transport coalesced for this block and had not emitted (the
     render callback clears the host flags off the incoming graph's view for
     exactly that reason). The loop is this generation's own, as above.

     A clock at or past this generation's loop end wraps here, by this
     generation's loop, before anything else looks at it — the outgoing
     transport hands over the pre-wrap frame when the seam falls on its loop
     end, because a wrap is the next slice's first act. The wrap counts as a
     loop pass; it queues no SourceLoop, the seam's own boundary covers it.

     `predicted*` (when `exactRequested`) is the position this generation's
     Stretch anchor was filled for. When the adopted clock is exactly there
     the anchor is armed and the seam renders phase-coherent; otherwise the
     plan is discarded and the stage keeps the state it was primed with at
     prepare, which is a few milliseconds off at worst. Returns whether the
     seam was exact. A swap never sets pendingSourcePositionMoved: from the
     incoming graph's point of view the source has not moved, its state is
     simply fresh, and a boundary that merely resets it must not be refused
     for lack of an anchor (that refusal is a wedge, see nextSlice). */
  bool adoptClock(const PreparedPlaybackTransport &from, bool exactRequested,
                  int64_t predictedFrame,
                  uint32_t predictedFractionQ32) noexcept {
    callbackState = from.callbackState;
    callbackProjectFrame = from.callbackProjectFrame;
    callbackProjectFractionQ32 = from.callbackProjectFractionQ32;
    callbackContinuousFrame = from.callbackContinuousFrame;
    callbackRouteGeneration = from.callbackRouteGeneration;
    callbackStreamGeneration = from.callbackStreamGeneration;
    callbackHostIdentityValid = from.callbackHostIdentityValid;
    pendingDiscontinuity = from.pendingDiscontinuity;
    pendingHostDiscontinuityFlags = from.pendingHostDiscontinuityFlags;
    pendingSourcePositionMoved = false;
    callbackLoopCount = from.callbackLoopCount;
    callbackSeekCount = from.callbackSeekCount;
    callbackDiscontinuities = from.callbackDiscontinuities;
    callbackLastBoundary = from.callbackLastBoundary;
    callbackProjectionAnchorContinuousFrame = callbackContinuousFrame;
    callbackLoopEnabled = initialLoopEnabled;
    callbackLoopStart = initialLoopEnabled ? initialLoopStart : 0;
    callbackLoopEnd = initialLoopEnabled ? initialLoopEnd : 0;
    if (callbackLoopEnabled && callbackProjectFrame >= callbackLoopEnd) {
      callbackProjectFrame = wrappedLoopFrame(
          callbackProjectFrame, callbackLoopStart, callbackLoopEnd);
      increment(&callbackLoopCount);
    }
    const bool exactLanding =
        exactRequested && callbackProjectFrame == predictedFrame &&
        callbackProjectFractionQ32 == predictedFractionQ32;
    blockBegun = false;
    callbackTimePitchBoundaryPrepared = false;
    if (timePitchProcessor.state != nullptr) {
      if (callbackLoopEnabled)
        (void)activateSignalsmithTimePitchLoop(timePitchProcessor,
                                               initialTimePitchLoopPlan);
      if (exactLanding && initialTimePitchReanchorPlan.valid()) {
        callbackTimePitchBoundaryPrepared = armSignalsmithTimePitchReanchor(
            timePitchProcessor, initialTimePitchReanchorPlan);
        lastAnchorOutcome.store(callbackTimePitchBoundaryPrepared ? 40 : 41,
                                std::memory_order_relaxed);
      } else {
        discardSignalsmithTimePitchReanchor(timePitchProcessor,
                                            initialTimePitchReanchorPlan);
        lastAnchorOutcome.store(42, std::memory_order_relaxed);
      }
      initialTimePitchReanchorPlan = {};
    }
    // The seam resets the incoming graph's processors and says why. It
    // coalesces with (and is outranked by) any host boundary carried across.
    queueDiscontinuity({zdsp::DiscontinuityReason::ClockReanchored,
                        zdsp::DiscontinuityFlagResetState |
                            zdsp::DiscontinuityFlagTimeValid});
    return exactLanding;
  }

  void wrapAtLoopBoundary() noexcept {
    const uint64_t span = static_cast<uint64_t>(callbackLoopEnd) -
                          static_cast<uint64_t>(callbackLoopStart);
    const uint64_t elapsed = static_cast<uint64_t>(callbackProjectFrame) -
                             static_cast<uint64_t>(callbackLoopStart);
    callbackProjectFrame = callbackLoopStart +
                           static_cast<int64_t>(elapsed % span);
    pendingSourcePositionMoved = true;
    callbackState = NativePlaybackTransportState::Playing;
    callbackProjectionAnchorContinuousFrame = callbackContinuousFrame;
    queueDiscontinuity({zdsp::DiscontinuityReason::SourceLoop,
                        zdsp::DiscontinuityFlagResetState |
                            zdsp::DiscontinuityFlagTimeValid});
  }

  bool nextSlice(const AudioHostRenderBlock &block, uint32_t offset,
                 uint32_t remaining,
                 zdsp::AudioHostTransportSlice *slice) noexcept {
    if (slice == nullptr || remaining == 0 || offset > block.frames ||
        remaining > block.frames - offset) {
      lastSliceRefusal.store(201, std::memory_order_relaxed);
      return false;
    }
    if (offset == 0) {
      beginBlockOnce(block);
      blockBegun = false;
    }

    if (timePitchProcessor.state != nullptr && pendingSourcePositionMoved &&
        pendingDiscontinuity.reason !=
            zdsp::DiscontinuityReason::SourceLoop &&
        !callbackTimePitchBoundaryPrepared) {
      /* A boundary that MOVED THE SOURCE may only reach the graph with an
         off-RT prepared Stretch replacement: rendering a moved source against
         a stale time/pitch state would corrupt the audible project position.
         Failing this callback is bounded and observable.

         It used to ask "is a boundary pending" instead, which is a different
         and much wider question. Every stream start raises the host's
         ClockReanchored the moment its host time becomes valid — a fact about
         the TIMESTAMP domain, with the source untouched — and since one open
         carries one anchor and the first boundary spends it, that flip
         refused every callback for the rest of the generation. Measured: any
         transpose or tempo change wedged native playback on every device.
         The stage's state depends on source-signal history alone (process()
         reads no transport time; an unanchored reset() keeps the last valid
         processor), so a boundary that moves nothing cannot invalidate it.

         The SourceLoop exemption is on the COALESCED reason, and SourceLoop
         has the lowest priority there is, so it survives coalescing only when
         nothing else lands in the same callback. A host flag on a wrap
         callback (an XRun, a clock reanchor) therefore outranks it: this
         guard passes — the wrap runs later in the block, so the source has
         not moved yet — the wrap queues SourceLoop, the emitted reason is the
         host's, and the Stretch's reset takes its generic branch without ever
         consulting the loop bank. That seam renders against the pre-wrap
         state. It is a deliberate widening: the old guard refused the
         callback instead, which is the wedge this change exists to remove,
         and a glitched loop seam is the better failure. The bank is not
         damaged by it (the slot stays Ready and `consumed` does not move).
         Unmeasured on a device — it needs a short A/B loop under a non-unity
         rate with an xrun landing on the wrap. The fix, when someone has that
         measurement, is to consume the loop bank when SourceLoop was queued
         but outranked, rather than to widen this guard again — and the hard
         part is that reset() is handed one COALESCED Discontinuity and
         branches on reason == SourceLoop, so at an outranked seam it cannot
         know a wrap happened at all. Either that fact travels to it, or the
         transport consumes the bank itself. */
      noteSignalsmithTimePitchLoopDeadlineMiss(timePitchProcessor);
      lastSliceRefusal.store(202, std::memory_order_relaxed);
      // WHICH boundary went unanchored. 202 says only "no anchor"; the fix
      // for a host-reported discontinuity (more anchors) and for one this
      // code queues itself (stop queueing it) are opposite, so the reason is
      // the thing worth knowing. 50 + reason, clear of the 30 + reason the
      // discard path uses.
      lastAnchorOutcome.store(
          (pendingHostDiscontinuityFlags != 0 ? 70u : 50u) +
              static_cast<uint32_t>(pendingDiscontinuity.reason),
          std::memory_order_relaxed);
      return false;
    }

    const bool running =
        callbackState == NativePlaybackTransportState::Playing ||
        callbackState == NativePlaybackTransportState::PreRoll;
    if (running && callbackLoopEnabled &&
        callbackProjectFrame >= callbackLoopEnd) {
      if (timePitchProcessor.state != nullptr &&
          !signalsmithTimePitchLoopReplacementReady(timePitchProcessor)) {
        // Accepted loops begin with two prepared replacements and leave a
        // deterministic output-period budget for off-RT replenishment. If the
        // worker nevertheless misses that deadline, fail this render contract
        // immediately: advancing a stream of silence would hide an unbounded
        // callback starvation fault behind apparently healthy transport.
        noteSignalsmithTimePitchLoopDeadlineMiss(timePitchProcessor);
        lastSliceRefusal.store(203, std::memory_order_relaxed);
        return false;
      }
      wrapAtLoopBoundary();
    }
    if ((callbackState == NativePlaybackTransportState::Playing ||
         callbackState == NativePlaybackTransportState::PreRoll) &&
        callbackProjectFrame >= durationFrames) {
      callbackState = NativePlaybackTransportState::Completed;
      callbackProjectionAnchorContinuousFrame = callbackContinuousFrame;
    }
    if (callbackContinuousFrame >
        static_cast<uint64_t>(std::numeric_limits<int64_t>::max())) {
      lastSliceRefusal.store(204, std::memory_order_relaxed);
      return false;
    }

    uint32_t frames = remaining;
    const bool advancesProject =
        callbackState == NativePlaybackTransportState::Playing ||
        callbackState == NativePlaybackTransportState::PreRoll;
    if (advancesProject) {
      int64_t boundary = durationFrames;
      if (callbackLoopEnabled && callbackProjectFrame < callbackLoopEnd)
        boundary = std::min(boundary, callbackLoopEnd);
      if (callbackProjectFrame < boundary) {
        frames = framesToBoundary(boundary, frames);
      }
    }
    zdsp::ProjectSamplePositionQ32 advancedPosition{};
    if (frames == 0 ||
        callbackContinuousFrame >
            static_cast<uint64_t>(std::numeric_limits<int64_t>::max()) -
                frames ||
        (advancesProject && !positionAtOffset(frames, &advancedPosition))) {
      lastSliceRefusal.store(205, std::memory_order_relaxed);
      return false;
    }

    // Cleared on the way OUT, not just on reset: detail 101 is substituted
    // with whatever this holds, and a stale 20x from an earlier block would
    // then be reported for a refusal that never set one.
    lastSliceRefusal.store(0, std::memory_order_relaxed);
    *slice = {};
    slice->transport.validFields = zdsp::TransportValidProjectSamples |
                                   zdsp::TransportValidContinuousSamples |
                                   zdsp::TransportValidProjectRateQ32;
    slice->transport.stateFlags = advancesProject ? zdsp::TransportStatePlaying
                                                  : zdsp::TransportStateNone;
    slice->transport.projectTimeSamples = callbackProjectFrame;
    slice->transport.projectTimeFractionQ32 = callbackProjectFractionQ32;
    slice->transport.projectRateQ32 = playbackRateQ32;
    slice->transport.continuousTimeSamples =
        static_cast<int64_t>(callbackContinuousFrame);
    slice->frames = {frames};
    slice->discontinuity = emitPendingDiscontinuity();
    if (slice->discontinuity.reason != zdsp::DiscontinuityReason::None)
      callbackTimePitchBoundaryPrepared = false;

    callbackContinuousFrame += frames;
    if (advancesProject) {
      if (!advancePosition(frames)) {
        lastSliceRefusal.store(206, std::memory_order_relaxed);
        return false;
      }
      callbackState = callbackProjectFrame < 0
                          ? NativePlaybackTransportState::PreRoll
                          : NativePlaybackTransportState::Playing;
      if (!callbackLoopEnabled && callbackProjectFrame >= durationFrames)
        callbackState = NativePlaybackTransportState::Completed;
      if (callbackState == NativePlaybackTransportState::Completed)
        callbackProjectionAnchorContinuousFrame = callbackContinuousFrame;
    }
    // Publish once per hardware callback, not once per transport slice. A
    // one-frame loop may legally produce 8,192 slices; keeping telemetry at
    // the final slice preserves the RT bound without thousands of atomics.
    if (frames == remaining)
      publishTelemetry();
    return true;
  }
};

static_assert(std::atomic<uint64_t>::is_always_lock_free &&
                  std::atomic<int64_t>::is_always_lock_free,
              "Native playback transport telemetry must be lock-free");

bool slicePreparedPlaybackTransport(
    void *opaque, const AudioHostRenderBlock &block, uint32_t offset,
    uint32_t remaining, zdsp::AudioHostTransportSlice *slice) noexcept {
  auto *state = static_cast<PreparedPlaybackTransport *>(opaque);
  return state != nullptr && state->nextSlice(block, offset, remaining, slice);
}

size_t cuePlanRetainedBytes(const PlaybackCuePlan &plan) noexcept {
  size_t total = sizeof(PlaybackCuePlan);
  total += plan.events.capacity() * sizeof(PlaybackCueEvent);
  total += plan.ordinaryClickPcm.capacity() * sizeof(float);
  total += plan.accentClickPcm.capacity() * sizeof(float);
  total += plan.beatGrid.beats.capacity() * sizeof(double);
  total += plan.beatGrid.downbeats.capacity() * sizeof(uint32_t);
  return total;
}

size_t cueRuntimeRetainedBytes(const PlaybackCuePlan &plan) noexcept {
  return plan.events.size() * sizeof(zdsp::ScheduledCueEvent);
}

NativePlaybackGraphNodeRole
nativeGraphNodeRole(zdsp::GraphNodeRole role) noexcept {
  switch (role) {
  case zdsp::GraphNodeRole::Input:
    return NativePlaybackGraphNodeRole::Input;
  case zdsp::GraphNodeRole::Processor:
    return NativePlaybackGraphNodeRole::Processor;
  case zdsp::GraphNodeRole::Output:
    return NativePlaybackGraphNodeRole::Output;
  }
  return NativePlaybackGraphNodeRole::Processor;
}

NativePlaybackGraphNodeKind
nativeGraphNodeKind(const zdsp::GraphNodeDescription &node) noexcept {
  if (node.role == zdsp::GraphNodeRole::Output)
    return NativePlaybackGraphNodeKind::PhysicalOutput;
  const bool knownPortableType =
      nativePlaybackGraphTypeEqual(node.type, kGraphTypeProjectLaneSource) ||
      nativePlaybackGraphTypeEqual(node.type, kGraphTypeChannelMap) ||
      nativePlaybackGraphTypeEqual(node.type, kGraphTypeGain) ||
      nativePlaybackGraphTypeEqual(node.type, kGraphTypeMix) ||
      nativePlaybackGraphTypeEqual(node.type, kGraphTypeTrainingDuck) ||
      nativePlaybackGraphTypeEqual(node.type, kGraphTypeSignalsmithTimePitch) ||
      nativePlaybackGraphTypeEqual(node.type, kGraphTypeCueSource) ||
      nativePlaybackGraphTypeEqual(node.type, kGraphTypePeakRms) ||
      nativePlaybackGraphTypeEqual(node.type, kGraphTypeTap) ||
      nativePlaybackGraphTypeEqual(node.type, kGraphTypeOscillator) ||
      nativePlaybackGraphTypeEqual(node.type, kGraphTypeSafetyLimiter) ||
      nativePlaybackGraphTypeEqual(node.type, kGraphTypeExternalAdapter);
  if ((knownPortableType && node.schemaVersion != 1) ||
      nativePlaybackGraphTypeEqual(node.type, kGraphTypeExternalAdapter))
    return (node.flags & zdsp::GraphNodeFlagBypassed) != 0
               ? NativePlaybackGraphNodeKind::UnavailableBypass
               : NativePlaybackGraphNodeKind::UnavailableSilence;
  if (nativePlaybackGraphTypeEqual(node.type, kGraphTypeChannelMap))
    return NativePlaybackGraphNodeKind::ChannelMap;
  if (nativePlaybackGraphTypeEqual(node.type, kGraphTypeGain))
    return NativePlaybackGraphNodeKind::Gain;
  if (nativePlaybackGraphTypeEqual(node.type, kGraphTypeMix))
    return NativePlaybackGraphNodeKind::Mix;
  if (nativePlaybackGraphTypeEqual(node.type, kGraphTypeSafetyLimiter))
    return NativePlaybackGraphNodeKind::SafetyLimiter;
  if (nativePlaybackGraphTypeEqual(node.type, kGraphTypeProjectLaneSource))
    return NativePlaybackGraphNodeKind::DecodedSource;
  if (nativePlaybackGraphTypeEqual(node.type, kGraphTypeCueSource))
    return NativePlaybackGraphNodeKind::ScheduledCueSource;
  if (nativePlaybackGraphTypeEqual(node.type, kGraphTypeTrainingDuck))
    return NativePlaybackGraphNodeKind::ScheduledGain;
  if (nativePlaybackGraphTypeEqual(node.type, kGraphTypeSignalsmithTimePitch))
    return NativePlaybackGraphNodeKind::SignalsmithTimePitch;
  if (nativePlaybackGraphTypeEqual(node.type, kGraphTypePeakRms))
    return NativePlaybackGraphNodeKind::PeakRms;
  if (nativePlaybackGraphTypeEqual(node.type, kGraphTypeTap))
    return NativePlaybackGraphNodeKind::Tap;
  if (nativePlaybackGraphTypeEqual(node.type, kGraphTypeOscillator))
    return NativePlaybackGraphNodeKind::Oscillator;
  if (node.type.high == 1) {
    switch (static_cast<zdsp::BuiltinNodeKind>(node.type.low)) {
    case zdsp::BuiltinNodeKind::ChannelMap:
      return NativePlaybackGraphNodeKind::ChannelMap;
    case zdsp::BuiltinNodeKind::Gain:
      return NativePlaybackGraphNodeKind::Gain;
    case zdsp::BuiltinNodeKind::Mix:
      return NativePlaybackGraphNodeKind::Mix;
    case zdsp::BuiltinNodeKind::SafetyLimiter:
      return NativePlaybackGraphNodeKind::SafetyLimiter;
    default:
      return NativePlaybackGraphNodeKind::Unknown;
    }
  }
  if (node.type.high == 3)
    return NativePlaybackGraphNodeKind::DecodedSource;
  if (node.type.high == 4)
    return NativePlaybackGraphNodeKind::ScheduledCueSource;
  if (node.type.high == 5)
    return NativePlaybackGraphNodeKind::ScheduledGain;
  if (node.type.high == 6)
    return NativePlaybackGraphNodeKind::SignalsmithTimePitch;
  return (node.flags & zdsp::GraphNodeFlagBypassed) != 0
             ? NativePlaybackGraphNodeKind::UnavailableBypass
             : NativePlaybackGraphNodeKind::UnavailableSilence;
}

// The compiler input and the product diagnostics share this one control-domain
// composition. Labels describe nodes, but there is deliberately no parallel
// hand-written chain string: topology is formatted from the exact node/edge
// records subsequently passed to compileGraph().
struct PlaybackGraphComposition {
  struct Label {
    zdsp::NodeId node{};
    std::string text;
  };

  std::vector<zdsp::GraphNodeDescription> nodes;
  std::vector<zdsp::GraphConnection> connections;
  std::vector<Label> labels;

  void reserve(size_t nodeCount, size_t connectionCount) {
    nodes.reserve(nodeCount);
    labels.reserve(nodeCount);
    connections.reserve(connectionCount);
  }

  void add(zdsp::GraphNodeDescription node, std::string label) {
    labels.push_back({node.id, std::move(label)});
    nodes.push_back(node);
  }

  void connect(zdsp::GraphConnection connection) {
    connections.push_back(connection);
  }

  const std::string &label(zdsp::NodeId node) const noexcept {
    for (const Label &entry : labels)
      if (entry.node.value == node.value)
        return entry.text;
    static const std::string unknown{"unknown"};
    return unknown;
  }

  std::string summary() const {
    std::string result = "actual graph · nodes [";
    for (size_t index = 0; index < labels.size(); ++index) {
      if (index != 0)
        result += ", ";
      result += labels[index].text;
    }
    result += "] · edges [";
    for (size_t index = 0; index < connections.size(); ++index) {
      if (index != 0)
        result += ", ";
      result += label(connections[index].sourceNode);
      result += "→";
      result += label(connections[index].destinationNode);
    }
    result += "]";
    return result;
  }

  std::optional<NativePlaybackGraphSnapshot>
  snapshot(uint64_t generation, double sampleRate,
           uint32_t maximumFrames) const {
    if (nodes.empty() || nodes.size() != labels.size() ||
        nodes.size() > kNativePlaybackMaximumGraphNodes ||
        connections.size() > kNativePlaybackMaximumGraphConnections)
      return std::nullopt;
    for (size_t index = 0; index < nodes.size(); ++index) {
      const zdsp::GraphNodeDescription &node = nodes[index];
      if (labels[index].node.value != node.id.value ||
          node.inputBusCount > kNativePlaybackMaximumNodeBuses ||
          node.outputBusCount > kNativePlaybackMaximumNodeBuses ||
          (node.inputBusCount != 0 && node.inputBuses == nullptr) ||
          (node.outputBusCount != 0 && node.outputBuses == nullptr))
        return std::nullopt;
    }

    const auto nodeIndex = [&](zdsp::NodeId id) noexcept {
      for (size_t index = 0; index < nodes.size(); ++index)
        if (nodes[index].id.value == id.value)
          return index;
      return nodes.size();
    };
    std::array<uint32_t, kNativePlaybackMaximumGraphNodes> arrivals{};
    std::array<uint32_t, kNativePlaybackMaximumGraphNodes> outputs{};
    std::array<bool, kNativePlaybackMaximumGraphNodes> complete{};
    size_t remaining = nodes.size();
    while (remaining != 0) {
      bool progressed = false;
      for (size_t index = 0; index < nodes.size(); ++index) {
        if (complete[index])
          continue;
        const zdsp::GraphNodeDescription &node = nodes[index];
        uint32_t arrival = 0;
        bool ready = true;
        for (const zdsp::GraphConnection &connection : connections) {
          if (connection.destinationNode.value != node.id.value)
            continue;
          const size_t source = nodeIndex(connection.sourceNode);
          if (source >= nodes.size())
            return std::nullopt;
          if (!complete[source]) {
            ready = false;
            break;
          }
          arrival = std::max(arrival, outputs[source]);
        }
        if (!ready)
          continue;
        uint32_t intrinsic = 0;
        if (node.role == zdsp::GraphNodeRole::Processor) {
          if (node.processor.functions == nullptr ||
              node.processor.state == nullptr)
            return std::nullopt;
          intrinsic =
              node.processor.functions->latency(node.processor.state).value;
        }
        if (intrinsic > UINT32_MAX - arrival)
          return std::nullopt;
        arrivals[index] = arrival;
        outputs[index] = arrival + intrinsic;
        complete[index] = true;
        --remaining;
        progressed = true;
      }
      if (!progressed)
        return std::nullopt;
    }

    uint32_t maximumOutputLatency = 0;
    for (size_t index = 0; index < nodes.size(); ++index)
      if (nodes[index].role == zdsp::GraphNodeRole::Output)
        maximumOutputLatency =
            std::max(maximumOutputLatency, arrivals[index]);

    NativePlaybackGraphSnapshot result;
    result.generation = generation;
    result.formatVersion = zdsp::kGraphFormatVersion;
    result.sampleRate = sampleRate;
    result.maximumFrames = maximumFrames;
    result.outputLatencyFrames = maximumOutputLatency;
    result.nodes.reserve(nodes.size());
    result.connections.reserve(connections.size());
    for (size_t index = 0; index < nodes.size(); ++index) {
      const zdsp::GraphNodeDescription &node = nodes[index];
      NativePlaybackGraphNodeStatus status;
      status.id = node.id.value;
      status.label = labels[index].text;
      status.role = nativeGraphNodeRole(node.role);
      status.kind = nativeGraphNodeKind(node);
      status.typeHigh = node.type.high;
      status.typeLow = node.type.low;
      status.schemaVersion = node.schemaVersion;
      status.flags = node.flags;
      status.inputBusCount = node.inputBusCount;
      status.outputBusCount = node.outputBusCount;
      for (uint32_t bus = 0; bus < node.inputBusCount; ++bus)
        status.inputBusChannels[bus] = node.inputBuses[bus].channelCount;
      for (uint32_t bus = 0; bus < node.outputBusCount; ++bus)
        status.outputBusChannels[bus] = node.outputBuses[bus].channelCount;
      status.intrinsicLatencyFrames = outputs[index] - arrivals[index];
      status.arrivalLatencyFrames = arrivals[index];
      status.outputLatencyFrames = outputs[index];
      result.nodes.push_back(std::move(status));
    }
    for (const zdsp::GraphConnection &connection : connections) {
      const size_t source = nodeIndex(connection.sourceNode);
      const size_t destination = nodeIndex(connection.destinationNode);
      if (source >= nodes.size() || destination >= nodes.size() ||
          connection.sourceBus >= nodes[source].outputBusCount ||
          connection.destinationBus >= nodes[destination].inputBusCount)
        return std::nullopt;
      const uint32_t target =
          nodes[destination].role == zdsp::GraphNodeRole::Output
              ? maximumOutputLatency
              : arrivals[destination];
      if (target < outputs[source])
        return std::nullopt;
      NativePlaybackGraphConnectionStatus status;
      status.sourceNodeId = connection.sourceNode.value;
      status.sourceBus = connection.sourceBus;
      status.sourceChannels =
          nodes[source].outputBuses[connection.sourceBus].channelCount;
      status.destinationNodeId = connection.destinationNode.value;
      status.destinationBus = connection.destinationBus;
      status.destinationChannels =
          nodes[destination].inputBuses[connection.destinationBus].channelCount;
      status.sourceOutputLatencyFrames = outputs[source];
      status.destinationArrivalLatencyFrames = target;
      status.compensationFrames = target - outputs[source];
      status.latencyCompensated = status.compensationFrames != 0;
      if (status.latencyCompensated)
        ++result.latencyCompensatedConnectionCount;
      result.connections.push_back(status);
    }
    return result;
  }
};

using NativePlaybackLanePeaks =
    std::array<float, kNativePlaybackLaneSummaryBuckets>;

// Everything that decides whether an already-decoded lane is the same audio
// as a lane a new prepare is asking for: the bridge's opaque identity for the
// bytes, and the decode settings that shaped the published samples. Nothing
// here is ever used to open anything; it is only ever compared.
struct PlaybackLaneDecodeIdentity {
  std::string sourceKey;
  uint32_t requiredSampleRate{0};
  DecodedAudioSourceFormat sourceFormat{DecodedAudioSourceFormat::Auto};
  uint32_t maximumChannels{0};
  uint64_t maximumFrames{0};

  [[nodiscard]] bool operator==(const PlaybackLaneDecodeIdentity &other) const {
    return sourceKey == other.sourceKey &&
           requiredSampleRate == other.requiredSampleRate &&
           sourceFormat == other.sourceFormat &&
           maximumChannels == other.maximumChannels &&
           maximumFrames == other.maximumFrames;
  }
  // An unnamed source can never be recognized again, so it never adopts.
  [[nodiscard]] bool adoptable() const noexcept { return !sourceKey.empty(); }
};

[[nodiscard]] PlaybackLaneDecodeIdentity
laneDecodeIdentity(const NativePlaybackLaneSource &source,
                   const DecodedAudioPrepareOptions &options,
                   uint32_t requiredSampleRate) {
  return {source.sourceKey, requiredSampleRate, options.sourceFormat,
          options.maximumChannels, options.maximumFrames};
}

// Fixed-resolution amplitude envelope of one decoded lane, taken from the
// planar PCM the graph is about to borrow. Each bucket is the peak absolute
// sample of every channel inside its half-open frame span; buckets partition
// the lane exactly, in integer arithmetic, so the same decode always yields
// the same bytes on every platform. A lane shorter than the bucket count
// still fills every bucket: an otherwise empty span reads the single frame it
// starts on rather than reporting silence that is not there. The envelope is
// deliberately unnormalized — scaling is a drawing decision, and normalizing
// here would make a quiet lane indistinguishable from a loud one.
[[nodiscard]] bool summarizeLanePeaks(const DecodedAudio &audio,
                                      NativePlaybackLanePeaks *peaks) noexcept {
  if (peaks == nullptr)
    return false;
  peaks->fill(0.0F);
  const uint64_t frames = audio.frameCount();
  const uint32_t channels = audio.channelCount();
  if (frames == 0 || channels == 0)
    return false;
  constexpr uint64_t buckets = kNativePlaybackLaneSummaryBuckets;
  for (uint32_t channel = 0; channel < channels; ++channel) {
    const float *samples = audio.channelData(channel);
    if (samples == nullptr)
      continue;
    for (uint64_t bucket = 0; bucket < buckets; ++bucket) {
      const uint64_t begin = bucket * frames / buckets;
      uint64_t end = (bucket + 1) * frames / buckets;
      if (end <= begin)
        end = begin + 1;
      if (end > frames)
        end = frames;
      float peak = (*peaks)[static_cast<size_t>(bucket)];
      for (uint64_t frame = begin; frame < end; ++frame) {
        const float sample = samples[static_cast<size_t>(frame)];
        // Non-finite PCM cannot reach a drawing surface as a height. The
        // decoded lane is trusted, so this only pins the contract.
        if (!std::isfinite(sample))
          continue;
        const float magnitude = sample < 0.0F ? -sample : sample;
        if (magnitude > peak)
          peak = magnitude;
      }
      (*peaks)[static_cast<size_t>(bucket)] = peak > 1.0F ? 1.0F : peak;
    }
  }
  return true;
}

[[nodiscard]] int duplicateDescriptor(int descriptor) noexcept {
  if (descriptor < 0)
    return -1;
#if defined(_WIN32)
  return _dup(descriptor);
#else
  return ::dup(descriptor);
#endif
}

struct ParallelLaneDecode {
  struct Lane {
    DecodedAudioResult result;
    NativePlaybackLanePeaks peaks{};
    bool peaksValid{false};
  };

  std::vector<Lane> lanes;
  // True only when every lane decoded. Anything else — a decode failure, a
  // cancellation, a budget the reservation cannot promise, a thread that
  // could not be created — leaves this false and hands the decision back to
  // the one sequential definition of lane admission.
  bool complete{false};
  // Set only for the one decline a singer can FEEL and nothing else would
  // explain: a lane too large for its share of the decode budget, which sends
  // an otherwise healthy open down the one-lane-at-a-time path and costs
  // seconds. Lanes are not all the same length on this product — six stems
  // from one song are, but a singer's own added track can be any length — so
  // this is a real shape, not a hypothetical. Empty for every other outcome,
  // because those either surface as an error or were asked for.
  std::string declineReason;
};

// Decodes every lane on a bounded worker pool, and summarizes each one on the
// thread that decoded it. This is an OPTIMIZATION ONLY: the pool decides
// nothing and reports nothing. Every refusal, error code and message still
// comes from the sequential loop, which the caller re-runs over its own
// descriptors when this returns incomplete — which is why each worker is
// handed a DUPLICATE (prepareDecodedAudio consumes and closes the descriptor
// it is given, and rewinds it first, so the caller's original stays usable).
//
// A worker's cap IS tighter than the sequential loop's, deliberately: the
// sequential loop may give one lane the whole remaining budget, while here
// every concurrent decode holds a reservation at once, so each gets a share.
// A lane too large for its share is therefore refused here and admitted
// there — that is the fallback working as intended, not a bug, and it is
// exactly what status().laneDecodeFallback exists to explain. Nothing here
// reports a refusal of its own; it only sends the caller back to the
// sequential loop, which remains the one definition of what is admissible.
[[nodiscard]] ParallelLaneDecode decodeLanesConcurrently(
    const std::vector<NativePlaybackLaneSource> &sources,
    const DecodedAudioPrepareOptions &decodeOptions,
    uint32_t requiredSampleRate, size_t maximumRetainedBytes,
    size_t arenaBytes, const DecodeCancellation &outer,
    NativePlaybackTestHooks *testHooks) noexcept {
  ParallelLaneDecode outcome;
  const size_t laneCount = sources.size();
  if (laneCount < 2 || arenaBytes > maximumRetainedBytes)
    return outcome;
  try {
    std::vector<OwnedFileDescriptor> duplicates;
    duplicates.reserve(laneCount);
    for (const NativePlaybackLaneSource &source : sources) {
      const int copy = duplicateDescriptor(source.descriptor.get());
      if (copy < 0)
        return outcome;
      duplicates.emplace_back(copy);
    }
    outcome.lanes.resize(laneCount);
    std::vector<size_t> committedBytes(laneCount, 0);
    std::vector<char> committed(laneCount, 0);
    std::mutex budget;
    const size_t laneBudget = maximumRetainedBytes - arenaBytes;
    const size_t laneShare = laneBudget / laneCount;
    // A REAL reservation, not an accounting comment. `available` is the part
    // of the budget no in-flight decode has been promised; a worker takes its
    // allowance out of it before decoding and puts back only what the lane
    // did not use. The sum of the allowances held by concurrent decodes is
    // therefore `laneBudget - available`, which cannot exceed laneBudget —
    // the earlier version merely accumulated an unspent `surplus` and handed
    // out 1x, 1x, 2x, 3x, 4x, 5x the share, peaking at 1.49x the budget.
    size_t available = laneBudget;
    size_t claimedLanes = 0;
    size_t inFlightBytes = 0;
    // What the lanes already decoded actually hold. Reported with the
    // in-flight reservations because the two are alive at the same time: the
    // ceiling is on their SUM, and tracking it from the real byte counts
    // rather than from `available` means a bookkeeping slip in the allocator
    // shows up here instead of hiding behind it.
    size_t spentBytes = 0;
    std::atomic<bool> refused{false};
    std::atomic<size_t> next{0};
    struct PoolCancellation {
      const DecodeCancellation *outer;
      std::atomic<bool> *refused;
    };
    PoolCancellation cancellationState{&outer, &refused};
    // A sibling's refusal cancels the decodes already in flight, so the
    // caller's fallback starts promptly instead of after the slowest lane.
    const DecodeCancellation poolCancellation{
        &cancellationState, [](void *context) noexcept -> bool {
          auto *state = static_cast<PoolCancellation *>(context);
          return state->refused->load(std::memory_order_acquire) ||
                 state->outer->isRequested();
        }};
    size_t workers = 1;
    const auto work = [&]() {
      for (;;) {
        const size_t index = next.fetch_add(1, std::memory_order_relaxed);
        if (index >= laneCount)
          return;
        if (refused.load(std::memory_order_acquire) || outer.isRequested()) {
          refused.store(true, std::memory_order_release);
          return;
        }
        // Take this lane's allowance out of the budget before decoding it,
        // leaving every lane that has not claimed yet its own share. An equal
        // set gets exactly its share each; an unequal one still fits, because
        // the lanes claimed late may spend what the early ones returned.
        size_t allowance = 0;
        uint64_t inFlightNow = 0;
        {
          std::lock_guard<std::mutex> lock(budget);
          ++claimedLanes;
          const size_t unclaimed = laneCount - claimedLanes;
          const size_t reservedForOthers = unclaimed * laneShare;
          allowance = available > reservedForOthers
                          ? available - reservedForOthers
                          : std::min(available, laneShare);
          available -= allowance;
          inFlightBytes += allowance;
          inFlightNow = spentBytes + inFlightBytes;
        }
        if (allowance == 0) {
          std::lock_guard<std::mutex> lock(budget);
          inFlightBytes -= allowance;
          available += allowance;
          refused.store(true, std::memory_order_release);
          return;
        }
        DecodedAudioPrepareOptions options = decodeOptions;
        options.requiredSampleRate = requiredSampleRate;
        options.maximumDecodedBytes =
            std::min(options.maximumDecodedBytes, allowance);
        // A resampling decode holds input, output and interleaved planes at
        // once. Bound that to what the lane may publish rather than leaving
        // it at the 2 GB per-decode default no caller chose.
        options.maximumWorkingBytes = std::min(
            options.maximumWorkingBytes,
            allowance > std::numeric_limits<size_t>::max() /
                            kNativePlaybackLaneWorkingBytesPerDecodedByte
                ? std::numeric_limits<size_t>::max()
                : allowance * kNativePlaybackLaneWorkingBytesPerDecodedByte);
        if (testHooks != nullptr && testHooks->observeLaneDecodePool != nullptr) {
          testHooks->observeLaneDecodePool(
              testHooks->context, static_cast<uint32_t>(workers),
              static_cast<uint64_t>(laneBudget),
              static_cast<uint64_t>(options.maximumDecodedBytes),
              static_cast<uint64_t>(options.maximumWorkingBytes), inFlightNow);
        }
        DecodedAudioResult result = prepareDecodedAudio(
            std::move(duplicates[index]), options, poolCancellation);
        if (!result.ok()) {
          if (result.status == DecodedAudioStatus::LimitExceeded) {
            std::lock_guard<std::mutex> lock(budget);
            if (outcome.declineReason.empty()) {
              outcome.declineReason =
                  "lane '" + sources[index].id + "' did not fit its " +
                  std::to_string(allowance) +
                  "-byte share of the decode budget; lanes were decoded one "
                  "at a time";
            }
          }
          // Defensive, and deliberately unobservable: the first failure sets
          // `refused`, every other worker returns before claiming, and the
          // whole pool is abandoned for the sequential path — so nothing can
          // spend what this returns. It stays because a future pool that
          // retries instead of abandoning would need it, and no mutation test
          // can cover it while the abandon-on-first-failure rule holds.
          std::lock_guard<std::mutex> lock(budget);
          inFlightBytes -= allowance;
          available += allowance;
          refused.store(true, std::memory_order_release);
          return;
        }
        const size_t bytes = result.audio->retainedBytes();
        ParallelLaneDecode::Lane &lane = outcome.lanes[index];
        lane.peaksValid = summarizeLanePeaks(*result.audio, &lane.peaks);
        lane.result = std::move(result);
        {
          // The reservation is released; only what the lane actually publishes
          // stays spent, so the lanes that follow may use the difference.
          std::lock_guard<std::mutex> lock(budget);
          committedBytes[index] = bytes;
          committed[index] = 1;
          inFlightBytes -= allowance;
          spentBytes += bytes;
          available += allowance > bytes ? allowance - bytes : 0;
        }
      }
    };
    // Concurrency is the declared constant, and nothing else. An earlier
    // version also divided the budget by a per-lane transient estimate, but
    // that estimate was itself the budget over the lane count, so the budget
    // cancelled and the term was only ever `laneCount / 2` — it could not
    // respond to a tighter budget and never bound at four lanes or more. What
    // DOES scale with the budget is the reservation above, which caps what
    // each concurrent decode may publish and, through it, how large a working
    // set the decoder will accept.
    const unsigned hardware = std::thread::hardware_concurrency();
    workers = std::max<size_t>(
        1, std::min<size_t>({laneCount, hardware == 0 ? 1 : hardware,
                             kNativePlaybackMaximumConcurrentLaneDecodes}));

    std::vector<std::thread> pool;
    pool.reserve(workers - 1);
    // Every worker is joined before this frame goes away, on ANY exit path.
    // ~thread on a joinable thread is std::terminate, and these workers hold
    // references into this frame, so an exception escaping past them would
    // turn a handled error into an abort. Nothing inside can throw today —
    // prepareDecodedAudio is noexcept and only a small string build and a
    // mutex lock remain — but that is a property of today's body, not of the
    // structure, and the structure is what a later call has to be safe in.
    struct PoolJoin {
      std::vector<std::thread> &pool;
      // Idempotent: joinable() is false once a thread has been joined, so the
      // ordinary path joins here and the destructor becomes a no-op.
      void join() noexcept {
        for (std::thread &thread : pool)
          if (thread.joinable())
            thread.join();
      }
      ~PoolJoin() { join(); }
    } joinPool{pool};
    try {
      for (size_t index = 1; index < workers; ++index)
        pool.emplace_back(work);
    } catch (...) {
      // A pool this machine will not give us is not an error: the lanes this
      // thread cannot reach are simply left to the sequential fallback.
      refused.store(true, std::memory_order_release);
    }
    work();
    joinPool.join();
    if (refused.load(std::memory_order_acquire) || outer.isRequested()) {
      outcome.lanes.clear();
      return outcome;
    }
    // A pool that delivered every lane declined nothing.
    outcome.declineReason.clear();
    for (const ParallelLaneDecode::Lane &lane : outcome.lanes) {
      if (!lane.result.ok()) {
        outcome.lanes.clear();
        return outcome;
      }
    }
    outcome.complete = true;
    return outcome;
  } catch (...) {
    outcome.lanes.clear();
    outcome.complete = false;
    return outcome;
  }
}

struct PreparedPlaybackGraph {
  struct Lane {
    std::string id;
    std::shared_ptr<const DecodedAudio> owner;
    std::array<const float *, zdsp::kMaximumChannelsPerBus> channelPointers{};
    std::array<zdsp::AudioChannelRole, zdsp::kMaximumChannelsPerBus> roles{};
    zdsp::AudioBusDescriptor sourceBus{};
    // Prepared once from this lane's decoded PCM and never mutated. Status
    // republishes it verbatim for every poll of the generation.
    NativePlaybackLanePeaks peaks{};
    bool peaksValid{false};
    // Compared, never used, when a retaining unload offers this lane to the
    // prepare that follows it.
    PlaybackLaneDecodeIdentity identity{};
    zdsp::ProcessorHandle source{};
    zdsp::ProcessorHandle gainProcessor{};
    zdsp::ProcessorHandle trainingProcessor{};
    uint64_t sourceNodeId{0};
    uint64_t gainNodeId{0};
    uint64_t trainingNodeId{0};
    float graphGainTrim{1.0F};
    mutable zdsp::DecodedBufferSourceCursorReader cursorReader{};
    float gain{1.0F};
    bool muted{false};
    bool solo{false};
    bool trainingSelected{false};
  };

  PreparedPlaybackGraph(std::vector<Lane> decoded,
                        std::shared_ptr<const PlaybackCuePlan> preparedCuePlan,
                        std::optional<NativePlaybackTrainingDuckConfig>
                            preparedTraining,
                        std::optional<NativePlaybackGraphDocument>
                            preparedGraphDocument,
                        double sampleRate, uint32_t outputChannels,
                        uint32_t maximumFrames, float initialMaster,
                        double rate, double transpose,
                        int64_t startProjectFrame,
                        NativePlaybackInitialTransportConfig initialTransport,
                        uint64_t generation, NativePlaybackTestHooks *hooks)
      : lanes(std::move(decoded)), sampleRate(sampleRate),
        outputChannels(outputChannels), maximumFrames(maximumFrames),
        masterGain(initialMaster), cuePlan(std::move(preparedCuePlan)),
        training(std::move(preparedTraining)),
        graphDocument(std::move(preparedGraphDocument)),
        transportGeneration(generation), playbackRate(rate),
        transposeSemitones(transpose),
        preparedStartProjectFrame(startProjectFrame),
        initialTransport(std::move(initialTransport)), testHooks(hooks) {
    (void)rateToQ32(rate, &playbackRateQ32);
    timePitchCorrectionSemitones = static_cast<float>(
        transpose - 12.0 * std::log2(rate));
    // A persisted document is allowed to keep an explicit Signalsmith stage
    // at unity. Its resource bounds and seek/loop anchor contract must be
    // active before materialization, just as they are for a non-unity
    // transport correction.
    hasTimePitch = std::fabs(timePitchCorrectionSemitones) > 1e-6F ||
                   graphDocumentRequestsSignalsmith(graphDocument);
    for (const Lane &lane : lanes)
      durationFrames = std::max(durationFrames, lane.owner->frameCount());
    if (cuePlan != nullptr)
      durationFrames = static_cast<uint64_t>(cuePlan->songDurationFrames);
    if (training.has_value()) {
      trainingEnabled = training->enabled;
      trainingWindows.reserve(training->windows.size());
      for (const NativePlaybackTrainingWindow &window : training->windows)
        trainingWindows.push_back(
            {window.startProjectFrame, window.endProjectFrame});
      for (Lane &lane : lanes)
        lane.trainingSelected =
            std::find(training->laneIds.begin(), training->laneIds.end(),
                      lane.id) != training->laneIds.end();
    }
    // A zero-event cue plan still owns the prepared reference branch used by
    // previewClick(). Size the arena from composition, not from timeline
    // event presence.
    const bool cues = cuePlan != nullptr;
    const uint64_t trainingLaneCount = static_cast<uint64_t>(std::count_if(
        lanes.begin(), lanes.end(),
        [](const Lane &lane) { return lane.trainingSelected; }));
    const std::optional<size_t> requested = preparedGraphArenaCapacity(
        lanes.size(), trainingLaneCount, cues, outputChannels, maximumFrames);
    if (requested.has_value()) {
      arenaBytes.resize(*requested);
      // Freeze the admitted live arena capacity as session metadata. Status
      // must not infer lifecycle accounting from a container implementation
      // detail after the graph has been compiled and output has started.
      graphArenaBytes = arenaBytes.capacity();
      retainedBytes = graphArenaBytes;
    }
  }

  ~PreparedPlaybackGraph() {
    if (runnerInitialized || graph != nullptr || !lanes.empty())
      (void)shutdown();
  }

  std::vector<Lane> lanes;
  std::vector<uint8_t> arenaBytes;
  zdsp::RealtimeArena arena{};
  zdsp::CompiledGraph *graph{nullptr};
  zdsp::ProcessorHandle masterProcessor{};
  zdsp::RuntimeDiagnostics diagnostics{};
  zdsp::RetirementSlot retirement[1]{};
  zdsp::SnapshotPublisher publisher{};
  zdsp::PublishedGraphSnapshot snapshot{};
  zdsp::ParameterQueue parameters{};
  zdsp::GraphRunner runner{};
  PreparedPlaybackTransport transport{};
  zdsp::AudioHostGraphAdapter adapter{};
  NativePlaybackCallbackState callback{};
  // The session's render router, shared so that a graph whose callback never
  // quiesced (quarantined) keeps the object the host still dereferences alive.
  std::shared_ptr<NativePlaybackRenderRouter> router;
  double sampleRate{0.0};
  uint32_t outputChannels{0};
  uint32_t maximumFrames{0};
  float masterGain{1.0F};
  float masterGraphTrim{1.0F};
  uint64_t masterGainNodeId{0};
  std::shared_ptr<const PlaybackCuePlan> cuePlan;
  std::optional<NativePlaybackTrainingDuckConfig> training;
  std::optional<NativePlaybackGraphDocument> graphDocument;
  std::vector<zdsp::ScheduledGainWindow> trainingWindows;
  bool trainingEnabled{false};
  std::vector<zdsp::ScheduledCueEvent> cueEvents;
  std::array<zdsp::ScheduledCueSoundView, 2> cueSounds{};
  zdsp::ProcessorHandle cueSource{};
  zdsp::ProcessorHandle timePitchProcessor{};
  void *timePitchPrepared{nullptr};
  size_t timePitchPreparedBytes{0};
  std::vector<float> timePitchAnchorSamples;
  std::array<const float *, kSignalsmithTimePitchMaximumChannels>
      timePitchAnchorChannels{};
  uint32_t timePitchAnchorFrames{0};
  SignalsmithTimePitchLoopPlan initialTimePitchLoopPlan{};
  SignalsmithTimePitchReanchorPlan initialTimePitchReanchorPlan{};
  float timePitchCorrectionSemitones{0.0F};
  bool hasTimePitch{false};
  float referenceGain{0.0F};
  uint32_t graphNodeCount{0};
  uint32_t graphConnectionCount{0};
  uint32_t latencyCompensatedEdgeCount{0};
  std::shared_ptr<const NativePlaybackGraphSnapshot> graphSnapshot;
  std::string topology;
  std::string laneDecodeFallback;
  std::string graphPreparationError;
  bool runnerInitialized{false};
  bool telemetryLive{true};
  size_t graphArenaBytes{0};
  size_t retainedBytes{0};
  uint64_t durationFrames{0};
  uint64_t transportGeneration{0};
  double playbackRate{1.0};
  double transposeSemitones{0.0};
  uint64_t playbackRateQ32{zdsp::kProjectRateOneQ32};
  uint64_t graphLatencyFrames{0};
  int64_t preparedStartProjectFrame{0};
  NativePlaybackInitialTransportConfig initialTransport{};
  NativePlaybackTestHooks *testHooks{nullptr};

  void observe(NativePlaybackLifecycleEvent event) noexcept {
    if (testHooks != nullptr && testHooks->observe != nullptr)
      testHooks->observe(testHooks->context, event);
  }

  void inject(NativePlaybackAllocationPoint point) {
    injectFailure(testHooks, point);
  }

  zdsp::ProcessorHandle makeBuiltin(const zdsp::BuiltinNodeConfig &config,
                                    void **durable, size_t *durableBytes) {
    const size_t stateBytes = zdsp::builtinStateBytes(config);
    void *state = zdsp::arenaAllocate(&arena, stateBytes, 64);
    if (state == nullptr)
      return {};
    zdsp::ProcessorHandle processor = zdsp::createBuiltinProcessor(
        config,
        {static_cast<uint8_t *>(state), static_cast<uint32_t>(stateBytes)});
    if (processor.state == nullptr)
      return {};
    *durableBytes = zdsp::builtinPreparedBytes(config, {maximumFrames});
    *durable = *durableBytes == 0
                   ? nullptr
                   : zdsp::arenaAllocate(&arena, *durableBytes, alignof(float));
    if (*durableBytes != 0 && *durable == nullptr) {
      (void)zdsp::destroyProcessor(&processor);
      return {};
    }
    return processor;
  }

  bool trainingInside(int64_t projectFrame) const noexcept {
    if (!training.has_value() || !trainingEnabled || projectFrame < 0)
      return false;
    if (training->mode == NativePlaybackTrainingMode::Period)
      return (projectFrame / training->periodFrames) % 2 == 1;
    for (const NativePlaybackTrainingWindow &window : training->windows) {
      if (projectFrame < window.startProjectFrame)
        return false;
      if (projectFrame < window.endProjectFrame)
        return true;
    }
    return false;
  }

  bool fillTimePitchAnchor(int64_t targetProjectFrame,
                           uint32_t targetProjectFractionQ32 = 0) noexcept {
    if (!hasTimePitch || timePitchAnchorFrames == 0 ||
        timePitchAnchorSamples.size() !=
            static_cast<size_t>(timePitchAnchorFrames) * outputChannels)
      return false;
    std::fill(timePitchAnchorSamples.begin(), timePitchAnchorSamples.end(),
              0.0F);
    const bool anySolo = std::any_of(
        lanes.begin(), lanes.end(), [](const Lane &lane) { return lane.solo; });
    const uint64_t sourceStart =
        cuePlan == nullptr || cuePlan->sourceStartFrame < 0
            ? 0
            : static_cast<uint64_t>(cuePlan->sourceStartFrame);
    float trainingCurrentGain = 1.0F;
    float trainingTargetGain = 1.0F;
    float trainingRampStep = 0.0F;
    uint32_t trainingRampRemaining = 0;
    bool trainingAnchorStarted = false;
    for (uint32_t outputFrame = 0; outputFrame < timePitchAnchorFrames;
         ++outputFrame) {
      const long double projectPosition =
          static_cast<long double>(targetProjectFrame) +
          static_cast<long double>(targetProjectFractionQ32) /
              static_cast<long double>(uint64_t{1} << 32) -
          static_cast<long double>(timePitchAnchorFrames - outputFrame) *
              static_cast<long double>(playbackRate);
      if (projectPosition < 0.0L ||
          projectPosition >
              static_cast<long double>(std::numeric_limits<int64_t>::max()))
        continue;
      const int64_t projectFrame =
          static_cast<int64_t>(std::floor(projectPosition));
      const double fraction = static_cast<double>(
          projectPosition - static_cast<long double>(projectFrame));
      const float scheduledTrainingGain =
          trainingInside(projectFrame) ? 0.0F : 1.0F;
      if (!trainingAnchorStarted) {
        trainingCurrentGain = scheduledTrainingGain;
        trainingTargetGain = scheduledTrainingGain;
        trainingAnchorStarted = true;
      } else if (scheduledTrainingGain != trainingTargetGain) {
        trainingTargetGain = scheduledTrainingGain;
        trainingRampRemaining = kNativePlaybackGainRampFrames;
        trainingRampStep =
            (trainingTargetGain - trainingCurrentGain) /
            static_cast<float>(trainingRampRemaining);
      }
      const float trainingGain = trainingCurrentGain;
      for (const Lane &lane : lanes) {
        const float laneGain =
            lane.muted || (anySolo && !lane.solo)
                ? 0.0F
                : lane.gain *
                      lane.graphGainTrim *
                      (lane.trainingSelected ? trainingGain : 1.0F) *
                      masterGain * masterGraphTrim;
        if (laneGain == 0.0F)
          continue;
        const uint64_t elapsed = static_cast<uint64_t>(projectFrame);
        if (elapsed > std::numeric_limits<uint64_t>::max() - sourceStart)
          continue;
        const uint64_t sourceFrame = sourceStart + elapsed;
        if (sourceFrame >= lane.owner->frameCount())
          continue;
        const uint64_t nextFrame = sourceFrame + 1u;
        const uint32_t sourceChannels = lane.owner->channelCount();
        const auto sample = [&](uint32_t channel) {
          const float first = lane.owner->channelData(channel)[sourceFrame];
          const float second =
              nextFrame < lane.owner->frameCount()
                  ? lane.owner->channelData(channel)[nextFrame]
                  : 0.0F;
          return static_cast<float>(
              static_cast<double>(first) +
              (static_cast<double>(second) - static_cast<double>(first)) *
                  fraction);
        };
        if (sourceChannels == 1) {
          const float value = sample(0) * laneGain;
          for (uint32_t channel = 0; channel < outputChannels; ++channel)
            timePitchAnchorSamples[static_cast<size_t>(channel) *
                                           timePitchAnchorFrames +
                                       outputFrame] += value;
        } else if (outputChannels == 1) {
          double sum = 0.0;
          for (uint32_t channel = 0; channel < sourceChannels; ++channel)
            sum += sample(channel);
          timePitchAnchorSamples[outputFrame] +=
              static_cast<float>(sum / sourceChannels) * laneGain;
        } else {
          const uint32_t matching =
              std::min(sourceChannels, outputChannels);
          for (uint32_t channel = 0; channel < matching; ++channel)
            timePitchAnchorSamples[static_cast<size_t>(channel) *
                                           timePitchAnchorFrames +
                                       outputFrame] += sample(channel) * laneGain;
        }
      }
      if (trainingRampRemaining != 0) {
        trainingCurrentGain += trainingRampStep;
        if (--trainingRampRemaining == 0)
          trainingCurrentGain = trainingTargetGain;
      }
    }
    for (float &sample : timePitchAnchorSamples)
      if (!std::isfinite(sample))
        sample = 0.0F;
    return true;
  }

  SignalsmithTimePitchAnchorInput timePitchAnchorInput() const noexcept {
    return {timePitchAnchorChannels.data(), outputChannels,
            timePitchAnchorFrames};
  }

  bool primeTimePitchSeek(int64_t projectFrame) noexcept {
    return !hasTimePitch ||
           (fillTimePitchAnchor(projectFrame) &&
            primeSignalsmithTimePitchSeek(timePitchProcessor,
                                          timePitchAnchorInput()));
  }

  SignalsmithTimePitchReanchorPlan primeTimePitchReanchor(
      int64_t projectFrame, uint32_t projectFractionQ32) noexcept {
    if (!hasTimePitch)
      return {};
    if (!fillTimePitchAnchor(projectFrame, projectFractionQ32))
      return {};
    return primeSignalsmithTimePitchReanchor(timePitchProcessor,
                                             timePitchAnchorInput());
  }

  SignalsmithTimePitchLoopPrepareResult configureTimePitchLoop(
      const std::optional<NativePlaybackInitialLoop> &loop) noexcept {
    if (!hasTimePitch)
      return {SignalsmithTimePitchLoopPrepareCode::Disabled, {}, 0};
    if (!loop.has_value())
      return configureSignalsmithTimePitchLoop(timePitchProcessor, nullptr, 0);
    if (!fillTimePitchAnchor(loop->startProjectFrame))
      return {SignalsmithTimePitchLoopPrepareCode::Invalid,
              {},
              signalsmithTimePitchMinimumLoopOutputFrames(
                  timePitchProcessor)};
    const uint64_t projectFrames =
        static_cast<uint64_t>(loop->endProjectFrame - loop->startProjectFrame);
    const long double outputFrames = std::ceil(
        static_cast<long double>(projectFrames) /
        static_cast<long double>(playbackRate));
    if (!std::isfinite(outputFrames) || outputFrames < 1.0L ||
        outputFrames >
            static_cast<long double>(std::numeric_limits<uint64_t>::max()))
      return {SignalsmithTimePitchLoopPrepareCode::Invalid,
              {},
              signalsmithTimePitchMinimumLoopOutputFrames(
                  timePitchProcessor)};
    const SignalsmithTimePitchAnchorInput input = timePitchAnchorInput();
    return configureSignalsmithTimePitchLoop(
        timePitchProcessor, &input, static_cast<uint64_t>(outputFrames));
  }

  zdsp::Status prepare(zdsp::GraphCompileError *compileError) {
    if (arenaBytes.empty())
      return {zdsp::StatusCode::InsufficientStorage, 1};
    const zdsp::Status initialized = zdsp::initializeArena(
        &arena, {arenaBytes.data(), static_cast<uint32_t>(arenaBytes.size())});
    if (!zdsp::succeeded(initialized))
      return initialized;

    NativePlaybackGraphContext graphContext;
    graphContext.outputChannels = outputChannels;
    graphContext.hasReference = cuePlan != nullptr;
    graphContext.hasTraining = training.has_value();
    graphContext.needsTimePitch = hasTimePitch;
    graphContext.masterGain = masterGain;
    graphContext.referenceGain = cuePlan == nullptr ? 0.0F : cuePlan->volume;
    graphContext.lanes.reserve(lanes.size());
    for (const Lane &lane : lanes)
      graphContext.lanes.push_back(
          {lane.id, lane.owner->channelCount(), lane.trainingSelected});
    NativePlaybackGraphDocument document =
        graphDocument.has_value()
            ? std::move(*graphDocument)
            : synthesizeNativePlaybackGraphDocument(graphContext);
    graphDocument.reset();
    NativePlaybackGraphMaterializeResult materialized =
        materializeNativePlaybackGraphDocument(std::move(document),
                                               graphContext);
    if (!materialized.ok()) {
      graphPreparationError = materialized.message;
      if (compileError != nullptr) {
        compileError->kind = zdsp::GraphErrorKind::InvalidDescription;
        compileError->node = {materialized.node};
        compileError->port = materialized.port;
      }
      return {zdsp::StatusCode::InvalidArgument,
              static_cast<uint32_t>(materialized.error)};
    }
    masterGainNodeId = materialized.graph.masterGainNode;
    hasTimePitch = materialized.graph.signalsmithNode != 0;

    struct RuntimeNode {
      std::vector<std::array<zdsp::AudioChannelRole,
                             zdsp::kMaximumChannelsPerBus>>
          inputRoles;
      std::vector<std::array<zdsp::AudioChannelRole,
                             zdsp::kMaximumChannelsPerBus>>
          outputRoles;
      std::vector<zdsp::AudioBusDescriptor> inputs;
      std::vector<zdsp::AudioBusDescriptor> outputs;
      std::array<float, zdsp::kMaximumChannelsPerBus *
                            zdsp::kMaximumChannelsPerBus>
          matrix{};
      zdsp::ProcessorHandle processor{};
      void *durable{nullptr};
      size_t durableBytes{0};
    };
    std::vector<RuntimeNode> runtime(materialized.graph.nodes.size());
    PlaybackGraphComposition composition;
    composition.reserve(materialized.graph.nodes.size(),
                        materialized.graph.connections.size());
    const bool anySolo = std::any_of(
        lanes.begin(), lanes.end(), [](const Lane &lane) { return lane.solo; });
    const uint64_t sourceStartFrame =
        cuePlan == nullptr || cuePlan->sourceStartFrame < 0
            ? 0
            : static_cast<uint64_t>(cuePlan->sourceStartFrame);

    const auto parameter = [](const NativePlaybackGraphNode &value,
                              const char *id, double fallback) noexcept {
      for (const NativePlaybackGraphParameter &entry : value.parameters)
        if (entry.id == id)
          return entry.normalizedValue;
      return fallback;
    };
    const auto laneFor = [&](const NativePlaybackGraphNode &value) -> Lane * {
      if (!value.binding.has_value() ||
          value.binding->kind != "project-lane")
        return nullptr;
      const auto found = std::find_if(
          lanes.begin(), lanes.end(), [&](const Lane &lane) {
            return lane.id == value.binding->laneId;
          });
      return found == lanes.end() ? nullptr : &*found;
    };
    const auto labelFor = [](const NativePlaybackGraphMaterializedNode &value) {
      const auto lane = [&]() -> const std::string * {
        return value.document.binding.has_value() &&
                       value.document.binding->kind == "project-lane"
                   ? &value.document.binding->laneId
                   : nullptr;
      }();
      std::string label;
      switch (value.kind) {
      case NativePlaybackGraphMaterializedKind::ProjectLaneSource:
        label = lane == nullptr ? "lane source" : "lane source[" + *lane + "]";
        break;
      case NativePlaybackGraphMaterializedKind::ChannelMap:
        label = lane == nullptr ? "channel map" : "channel map[" + *lane + "]";
        if (value.document.binding.has_value() &&
            value.document.binding->kind == "reference-map")
          label = "reference map";
        break;
      case NativePlaybackGraphMaterializedKind::Gain:
        if (lane != nullptr)
          label = "lane gain[" + *lane + "]";
        else if (value.document.binding.has_value() &&
                 value.document.binding->kind == "song-master")
          label = "song gain";
        else if (value.document.binding.has_value() &&
                 value.document.binding->kind == "reference-gain")
          label = "reference gain";
        else if (value.document.binding.has_value() &&
                 value.document.binding->kind == "output-gain")
          label = "output gain";
        else
          label = "gain";
        break;
      case NativePlaybackGraphMaterializedKind::Mix:
        label = std::any_of(
                    value.document.inputs.begin(), value.document.inputs.end(),
                    [](const auto &port) { return port.id == "reference"; })
                    ? "output mix"
                    : "song mix";
        break;
      case NativePlaybackGraphMaterializedKind::TrainingDuck:
        label = lane == nullptr ? "prepared training duck"
                                : "prepared training duck[" + *lane + "]";
        break;
      case NativePlaybackGraphMaterializedKind::SignalsmithTimePitch:
        label = "Signalsmith time/pitch";
        break;
      case NativePlaybackGraphMaterializedKind::CueSource:
        label = "prepared cue source";
        break;
      case NativePlaybackGraphMaterializedKind::PeakRms:
        label = "peak/RMS analyzer";
        break;
      case NativePlaybackGraphMaterializedKind::Tap:
        label = "bounded tap";
        break;
      case NativePlaybackGraphMaterializedKind::Oscillator:
        label = "oscillator";
        break;
      case NativePlaybackGraphMaterializedKind::SafetyLimiter:
        label = "safety limiter";
        break;
      case NativePlaybackGraphMaterializedKind::PhysicalOutput:
        label = "physical output";
        break;
      case NativePlaybackGraphMaterializedKind::PlaceholderBypass:
        label = "unavailable bypass placeholder";
        break;
      case NativePlaybackGraphMaterializedKind::PlaceholderSilence:
        label = "unavailable silence placeholder";
        break;
      }
      if (value.document.binding.has_value() && lane == nullptr &&
          value.document.binding->kind != "song-master" &&
          value.document.binding->kind != "reference-map" &&
          value.document.binding->kind != "reference-gain" &&
          value.document.binding->kind != "reference-cues" &&
          value.document.binding->kind != "output-gain" &&
          value.document.binding->kind != "project-output") {
        label += "[" + value.document.binding->kind;
        if (!value.document.binding->laneId.empty())
          label += ":" + value.document.binding->laneId;
        label += "]";
      }
      return label;
    };

    for (size_t index = 0; index < materialized.graph.nodes.size(); ++index) {
      NativePlaybackGraphMaterializedNode &resolved =
          materialized.graph.nodes[index];
      const NativePlaybackGraphNode &value = resolved.document;
      RuntimeNode &storage = runtime[index];
      storage.inputRoles.resize(value.inputs.size());
      storage.outputRoles.resize(value.outputs.size());
      storage.inputs.reserve(value.inputs.size());
      storage.outputs.reserve(value.outputs.size());
      for (size_t portIndex = 0; portIndex < value.inputs.size(); ++portIndex)
        storage.inputs.push_back(descriptor(
            value.inputs[portIndex].channels, &storage.inputRoles[portIndex]));
      for (size_t portIndex = 0; portIndex < value.outputs.size(); ++portIndex)
        storage.outputs.push_back(descriptor(
            value.outputs[portIndex].channels,
            &storage.outputRoles[portIndex]));

      zdsp::GraphNodeRole role = zdsp::GraphNodeRole::Processor;
      zdsp::GraphNodeFlags flags = zdsp::GraphNodeFlagNone;
      switch (resolved.kind) {
      case NativePlaybackGraphMaterializedKind::ProjectLaneSource: {
        Lane *lane = laneFor(value);
        if (lane == nullptr)
          return {zdsp::StatusCode::InvalidArgument, 20};
        lane->sourceNodeId = value.id;
        const uint32_t sourceChannels = lane->owner->channelCount();
        for (uint32_t channel = 0; channel < sourceChannels; ++channel)
          lane->channelPointers[channel] = lane->owner->channelData(channel);
        const size_t stateBytes = zdsp::decodedBufferSourceStateBytes();
        void *state = zdsp::arenaAllocate(&arena, stateBytes, 64);
        if (state == nullptr)
          return {zdsp::StatusCode::InsufficientStorage, 21};
        lane->source = zdsp::createPositionedDecodedBufferSource(
            {{value.id},
             {lane->channelPointers.data(), sourceChannels,
              lane->owner->frameCount(), {sampleRate}},
             0,
             std::min(sourceStartFrame, lane->owner->frameCount())},
            {static_cast<uint8_t *>(state),
             static_cast<uint32_t>(stateBytes)});
        storage.processor = lane->source;
        if (storage.processor.state == nullptr)
          return {zdsp::StatusCode::InsufficientStorage, 22};
        retainedBytes += lane->owner->retainedBytes();
        break;
      }
      case NativePlaybackGraphMaterializedKind::TrainingDuck: {
        Lane *lane = laneFor(value);
        if (lane == nullptr || !training.has_value())
          return {zdsp::StatusCode::InvalidArgument, 23};
        lane->trainingNodeId = value.id;
        const size_t stateBytes = zdsp::scheduledGainStateBytes();
        void *state = zdsp::arenaAllocate(&arena, stateBytes, 64);
        if (state == nullptr)
          return {zdsp::StatusCode::InsufficientStorage, 24};
        const zdsp::ScheduledGainConfig trainingConfig{
            {value.id},
            training->mode == NativePlaybackTrainingMode::Period
                ? zdsp::ScheduledGainMode::Period
                : zdsp::ScheduledGainMode::Windows,
            trainingWindows.empty() ? nullptr : trainingWindows.data(),
            static_cast<uint32_t>(trainingWindows.size()),
            training->periodFrames,
            0.0F,
            1.0F,
            {kNativePlaybackGainRampFrames},
            trainingEnabled};
        lane->trainingProcessor = zdsp::createScheduledGain(
            trainingConfig,
            {static_cast<uint8_t *>(state),
             static_cast<uint32_t>(stateBytes)});
        storage.processor = lane->trainingProcessor;
        flags = zdsp::GraphNodeFlagMayProcessInPlace;
        break;
      }
      case NativePlaybackGraphMaterializedKind::SignalsmithTimePitch: {
        const SignalsmithTimePitchConfig timePitchConfig{
            {value.id}, {sampleRate}, value.outputs[0].channels, maximumFrames,
            timePitchCorrectionSemitones};
        const size_t stateBytes = signalsmithTimePitchStateBytes();
        void *state = zdsp::arenaAllocate(&arena, stateBytes, 64);
        timePitchPreparedBytes =
            signalsmithTimePitchPreparedBytes(timePitchConfig);
        timePitchPrepared = zdsp::arenaAllocate(
            &arena, timePitchPreparedBytes, alignof(float));
        if (state == nullptr || timePitchPrepared == nullptr ||
            timePitchPreparedBytes == 0)
          return {zdsp::StatusCode::InsufficientStorage, 25};
        timePitchProcessor = createSignalsmithTimePitch(
            timePitchConfig,
            {static_cast<uint8_t *>(state),
             static_cast<uint32_t>(stateBytes)});
        storage.processor = timePitchProcessor;
        storage.durable = timePitchPrepared;
        storage.durableBytes = timePitchPreparedBytes;
        const size_t timePitchRetained =
            signalsmithExternalRetainedBytes(timePitchConfig);
        if (timePitchRetained == 0 ||
            retainedBytes >
                std::numeric_limits<size_t>::max() - timePitchRetained)
          return {zdsp::StatusCode::CapacityExceeded, 26};
        retainedBytes += timePitchRetained;
        break;
      }
      case NativePlaybackGraphMaterializedKind::CueSource: {
        if (cuePlan == nullptr)
          return {zdsp::StatusCode::InvalidArgument, 27};
        cueEvents.reserve(cuePlan->events.size());
        for (const PlaybackCueEvent &event : cuePlan->events)
          cueEvents.push_back(
              {event.projectFrame, static_cast<uint32_t>(event.sound)});
        cueSounds = {{{cuePlan->ordinaryClickPcm.data(),
                       static_cast<uint32_t>(cuePlan->ordinaryClickPcm.size())},
                      {cuePlan->accentClickPcm.data(),
                       static_cast<uint32_t>(cuePlan->accentClickPcm.size())}}};
        const size_t stateBytes = zdsp::scheduledCueSourceStateBytes();
        void *state = zdsp::arenaAllocate(&arena, stateBytes, 64);
        if (state == nullptr)
          return {zdsp::StatusCode::InsufficientStorage, 28};
        cueSource = zdsp::createScheduledCueSource(
            {{value.id}, cueEvents.data(),
             static_cast<uint32_t>(cueEvents.size()), cueSounds.data(),
             static_cast<uint32_t>(cueSounds.size()), {sampleRate},
             playbackRateQ32},
            {static_cast<uint8_t *>(state),
             static_cast<uint32_t>(stateBytes)});
        storage.processor = cueSource;
        break;
      }
      case NativePlaybackGraphMaterializedKind::PhysicalOutput:
        role = zdsp::GraphNodeRole::Output;
        break;
      default: {
        zdsp::BuiltinNodeKind kind = zdsp::BuiltinNodeKind::Gain;
        float value0 = 1.0F;
        float value1 = 0.0F;
        uint32_t inputChannels = value.inputs.empty()
                                     ? 0
                                     : value.inputs[0].channels;
        uint32_t outputChannelsForNode = value.outputs[0].channels;
        uint32_t inputBusCount = static_cast<uint32_t>(value.inputs.size());
        uint32_t frames = 0;
        uint32_t tapCapacity = 0;
        const float *matrix = nullptr;
        switch (resolved.kind) {
        case NativePlaybackGraphMaterializedKind::ChannelMap: {
          kind = zdsp::BuiltinNodeKind::ChannelMap;
          for (uint32_t out = 0; out < outputChannelsForNode; ++out)
            for (uint32_t in = 0; in < inputChannels; ++in) {
              float coefficient = 0.0F;
              if (inputChannels == 1)
                coefficient = 1.0F;
              else if (outputChannelsForNode == 1)
                coefficient = 1.0F / static_cast<float>(inputChannels);
              else if (in == out)
                coefficient = 1.0F;
              storage.matrix[out * inputChannels + in] = coefficient;
            }
          matrix = storage.matrix.data();
          flags = zdsp::GraphNodeFlagMayProcessInPlace;
          break;
        }
        case NativePlaybackGraphMaterializedKind::Gain: {
          kind = zdsp::BuiltinNodeKind::Gain;
          const float trim = static_cast<float>(parameter(value, "gain", 1.0));
          value0 = trim;
          if (Lane *lane = laneFor(value)) {
            lane->gainNodeId = value.id;
            lane->graphGainTrim = trim;
            lane->gainProcessor = {};
            value0 = (lane->muted || (anySolo && !lane->solo) ? 0.0F
                                                               : lane->gain) *
                     trim;
          } else if (value.binding.has_value() &&
                     value.binding->kind == "song-master") {
            masterGainNodeId = value.id;
            masterGraphTrim = trim;
            value0 = masterGain * trim;
          } else if (value.binding.has_value() &&
                     value.binding->kind == "reference-gain") {
            value0 = (cuePlan == nullptr ? 0.0F : cuePlan->volume) * trim;
            referenceGain = value0;
          }
          flags = zdsp::GraphNodeFlagMayProcessInPlace;
          break;
        }
        case NativePlaybackGraphMaterializedKind::Mix:
          kind = zdsp::BuiltinNodeKind::Mix;
          break;
        case NativePlaybackGraphMaterializedKind::PeakRms:
          kind = zdsp::BuiltinNodeKind::PeakRms;
          flags = zdsp::GraphNodeFlagMayProcessInPlace;
          break;
        case NativePlaybackGraphMaterializedKind::Tap:
          kind = zdsp::BuiltinNodeKind::Tap;
          tapCapacity = std::max(
              1u, static_cast<uint32_t>(std::llround(
                      parameter(value, "window", 1.0) * maximumFrames)));
          flags = zdsp::GraphNodeFlagMayProcessInPlace;
          break;
        case NativePlaybackGraphMaterializedKind::Oscillator:
          kind = zdsp::BuiltinNodeKind::Oscillator;
          value0 = static_cast<float>(parameter(value, "frequency", 0.0) *
                                      sampleRate * 0.5);
          value1 = static_cast<float>(parameter(value, "amplitude", 0.0));
          break;
        case NativePlaybackGraphMaterializedKind::SafetyLimiter:
          kind = zdsp::BuiltinNodeKind::SafetyLimiter;
          value0 = static_cast<float>(parameter(value, "ceiling", 1.0));
          flags = zdsp::GraphNodeFlagMayProcessInPlace;
          break;
        case NativePlaybackGraphMaterializedKind::PlaceholderBypass:
          kind = zdsp::BuiltinNodeKind::Gain;
          value0 = 1.0F;
          flags = zdsp::GraphNodeFlagBypassed;
          break;
        case NativePlaybackGraphMaterializedKind::PlaceholderSilence:
          kind = value.inputs.empty() ? zdsp::BuiltinNodeKind::Oscillator
                                      : zdsp::BuiltinNodeKind::Gain;
          value0 = 0.0F;
          value1 = 0.0F;
          flags = value.inputs.empty()
                      ? zdsp::GraphNodeFlagNone
                      : zdsp::GraphNodeFlagMayProcessInPlace;
          break;
        default:
          return {zdsp::StatusCode::InvalidArgument, 29};
        }
        const zdsp::BuiltinNodeConfig config{
            kind,
            {value.id},
            inputChannels,
            outputChannelsForNode,
            inputBusCount,
            value0,
            value1,
            frames,
            zdsp::OscillatorWaveform::Sine,
            matrix,
            tapCapacity};
        storage.processor =
            makeBuiltin(config, &storage.durable, &storage.durableBytes);
        if (storage.processor.state == nullptr)
          return {zdsp::StatusCode::InsufficientStorage, 30};
        if (resolved.kind == NativePlaybackGraphMaterializedKind::Gain) {
          if (Lane *lane = laneFor(value)) {
            lane->gainProcessor = storage.processor;
          } else if (value.binding.has_value() &&
                     value.binding->kind == "song-master") {
            masterProcessor = storage.processor;
          }
        }
        break;
      }
      }
      if (role == zdsp::GraphNodeRole::Processor &&
          storage.processor.state == nullptr)
        return {zdsp::StatusCode::InvalidArgument, 31};
      composition.add(
          {{value.id},
           value.type,
           value.typeVersion,
           role,
           flags,
           static_cast<uint32_t>(storage.inputs.size()),
           static_cast<uint32_t>(storage.outputs.size()),
           storage.inputs.empty() ? nullptr : storage.inputs.data(),
           storage.outputs.empty() ? nullptr : storage.outputs.data(),
           storage.processor,
           {storage.durable, storage.durableBytes,
            storage.durableBytes == 0 ? size_t{1} : alignof(float)}},
          labelFor(resolved));
    }
    for (const NativePlaybackGraphMaterializedConnection &connection :
         materialized.graph.connections)
      composition.connect({connection.sourceNode, connection.sourceBus,
                           connection.destinationNode,
                           connection.destinationBus});

    graphNodeCount = static_cast<uint32_t>(composition.nodes.size());
    graphConnectionCount =
        static_cast<uint32_t>(composition.connections.size());
    topology = composition.summary();
    if (cuePlan != nullptr) {
      retainedBytes += cuePlanRetainedBytes(*cuePlan);
      retainedBytes += cueEvents.capacity() * sizeof(zdsp::ScheduledCueEvent);
    }
    const zdsp::GraphDescription description{
        zdsp::kGraphFormatVersion,
        {sampleRate},
        {maximumFrames},
        composition.nodes.data(),
        static_cast<uint32_t>(composition.nodes.size()),
        composition.connections.data(),
        static_cast<uint32_t>(composition.connections.size())};
    zdsp::GraphCompileResult compiled{};
    const zdsp::Status compileStatus =
        zdsp::compileGraph(description, &arena, &compiled, compileError);
    if (!zdsp::succeeded(compileStatus)) {
      (void)zdsp::cleanupFailedCompile(&compiled);
      return compileStatus;
    }
    graph = compiled.graph;
    graphLatencyFrames = zdsp::compiledGraphLatency(*graph).value;
    latencyCompensatedEdgeCount =
        zdsp::compiledGraphBufferPlan(*graph).compensatedEdgeCount;
    std::optional<NativePlaybackGraphSnapshot> structured =
        composition.snapshot(transportGeneration, sampleRate, maximumFrames);
    if (!structured.has_value() ||
        structured->nodes.size() != graphNodeCount ||
        structured->connections.size() != graphConnectionCount ||
        zdsp::compiledGraphNodeCount(*graph) != structured->nodes.size() ||
        structured->outputLatencyFrames != graphLatencyFrames ||
        structured->latencyCompensatedConnectionCount !=
            latencyCompensatedEdgeCount)
      return {zdsp::StatusCode::InvalidArgument, 32};
    for (uint32_t index = 0; index < zdsp::compiledGraphNodeCount(*graph);
         ++index) {
      const uint64_t compiledId =
          zdsp::compiledGraphNodeId(*graph, index).value;
      if (std::count_if(structured->nodes.begin(), structured->nodes.end(),
                        [compiledId](const auto &node) {
                          return node.id == compiledId;
                        }) != 1)
        return {zdsp::StatusCode::InvalidArgument, 33};
    }
    graphSnapshot = std::make_shared<const NativePlaybackGraphSnapshot>(
        std::move(*structured));
    if (hasTimePitch) {
      timePitchAnchorFrames =
          signalsmithTimePitchAnchorFrames(timePitchProcessor);
      if (timePitchAnchorFrames == 0 ||
          timePitchAnchorFrames >
              std::numeric_limits<size_t>::max() / outputChannels)
        return {zdsp::StatusCode::CapacityExceeded, 34};
      timePitchAnchorSamples.resize(
          static_cast<size_t>(timePitchAnchorFrames) * outputChannels);
      for (uint32_t channel = 0; channel < outputChannels; ++channel)
        timePitchAnchorChannels[channel] =
            timePitchAnchorSamples.data() +
            static_cast<size_t>(channel) * timePitchAnchorFrames;
      if (timePitchAnchorSamples.capacity() >
              std::numeric_limits<size_t>::max() / sizeof(float) ||
          retainedBytes >
              std::numeric_limits<size_t>::max() -
                  timePitchAnchorSamples.capacity() * sizeof(float))
        return {zdsp::StatusCode::CapacityExceeded, 35};
      retainedBytes += timePitchAnchorSamples.capacity() * sizeof(float);
      if (!fillTimePitchAnchor(preparedStartProjectFrame) ||
          !primeSignalsmithTimePitchInitial(timePitchProcessor,
                                            timePitchAnchorInput()))
        return {zdsp::StatusCode::InvalidArgument, 36};
      initialTimePitchReanchorPlan = primeSignalsmithTimePitchReanchor(
          timePitchProcessor, timePitchAnchorInput());
      if (!initialTimePitchReanchorPlan.valid())
        return {zdsp::StatusCode::InvalidArgument, 37};
      const SignalsmithTimePitchLoopPrepareResult loopPrepared =
          configureTimePitchLoop(initialTransport.loop);
      if (!loopPrepared.ok())
        return {zdsp::StatusCode::InvalidArgument, 37};
      initialTimePitchLoopPlan = loopPrepared.plan;
    }
    zdsp::initializePublisher(&publisher, retirement, 1, &diagnostics);
    const zdsp::TransitionPlan hardCut{zdsp::TransitionKind::HardCut,
                                       {0},
                                       {0},
                                       {0},
                                       zdsp::InfiniteTailPolicy::Cut,
                                       {zdsp::TailKind::None, {0}},
                                       {0},
                                       0,
                                       100,
                                       1000,
                                       0};
    snapshot = {graph, 1, hardCut, 0};
    const zdsp::PublicationResult published =
        zdsp::submitSnapshot(&publisher, &snapshot);
    if (!zdsp::succeeded(published.status)) {
      (void)zdsp::deactivateCompiledGraph(graph);
      graph = nullptr;
      return published.status;
    }
    zdsp::initializeGraphRunner(&runner, &publisher, {}, &parameters, nullptr,
                                &diagnostics);
    runnerInitialized = true;
    transport.initialize(transportGeneration, preparedStartProjectFrame,
                         initialTransport,
                         static_cast<int64_t>(durationFrames),
                         cueEvents.empty() ? nullptr : cueEvents.data(),
                         static_cast<uint32_t>(cueEvents.size()), playbackRate,
                         timePitchProcessor, initialTimePitchLoopPlan,
                         initialTimePitchReanchorPlan);
    adapter.runner = &runner;
    adapter.transport = {slicePreparedPlaybackTransport, &transport};
    callback.adapter = &adapter;
    return zdsp::okStatus();
  }

  zdsp::Status prepareFixedLegacy(zdsp::GraphCompileError *compileError) {
    if (arenaBytes.empty())
      return {zdsp::StatusCode::InsufficientStorage, 1};
    const zdsp::Status initialized = zdsp::initializeArena(
        &arena, {arenaBytes.data(), static_cast<uint32_t>(arenaBytes.size())});
    if (!zdsp::succeeded(initialized))
      return initialized;

    std::array<zdsp::AudioChannelRole, zdsp::kMaximumChannelsPerBus>
        outputRoles{};
    const zdsp::AudioBusDescriptor outputBus =
        descriptor(outputChannels, &outputRoles);
    const bool anySolo = std::any_of(
        lanes.begin(), lanes.end(), [](const Lane &lane) { return lane.solo; });
    const bool hasReference = cuePlan != nullptr;
    const uint32_t trainingLaneCount = static_cast<uint32_t>(std::count_if(
        lanes.begin(), lanes.end(),
        [](const Lane &lane) { return lane.trainingSelected; }));
    const uint64_t sourceStartFrame =
        cuePlan == nullptr || cuePlan->sourceStartFrame < 0
            ? 0
            : static_cast<uint64_t>(cuePlan->sourceStartFrame);
    PlaybackGraphComposition composition;
    std::vector<zdsp::AudioBusDescriptor> songMixInputs(lanes.size(),
                                                        outputBus);
    std::vector<std::array<float, zdsp::kMaximumChannelsPerBus *
                                      zdsp::kMaximumChannelsPerBus>>
        matrices(lanes.size());
    std::vector<zdsp::ProcessorHandle> mapProcessors(lanes.size());
    std::vector<void *> mapDurable(lanes.size());
    std::vector<size_t> mapDurableBytes(lanes.size());
    std::vector<void *> gainDurable(lanes.size());
    std::vector<size_t> gainDurableBytes(lanes.size());
    composition.reserve(lanes.size() * 3u + trainingLaneCount +
                            (hasReference ? 9u : 4u),
                        lanes.size() * 3u + trainingLaneCount +
                            (hasReference ? 8u : 3u));

    for (size_t index = 0; index < lanes.size(); ++index) {
      Lane &lane = lanes[index];
      const uint32_t sourceChannels = lane.owner->channelCount();
      const uint64_t laneSourceStartFrame =
          std::min(sourceStartFrame, lane.owner->frameCount());
      lane.sourceBus = descriptor(sourceChannels, &lane.roles);
      for (uint32_t channel = 0; channel < sourceChannels; ++channel)
        lane.channelPointers[channel] = lane.owner->channelData(channel);
      const uint64_t sourceNode = kLaneNodeBase + index * 3u;
      const uint64_t mapNode = sourceNode + 1u;
      const uint64_t gainNode = sourceNode + 2u;

      const size_t sourceBytes = zdsp::decodedBufferSourceStateBytes();
      void *sourceState = zdsp::arenaAllocate(&arena, sourceBytes, 64);
      if (sourceState == nullptr)
        return {zdsp::StatusCode::InsufficientStorage, 2};
      lane.source = zdsp::createPositionedDecodedBufferSource(
          {{sourceNode},
           {lane.channelPointers.data(),
            sourceChannels,
            lane.owner->frameCount(),
            {sampleRate}},
           0,
           laneSourceStartFrame},
          {static_cast<uint8_t *>(sourceState),
           static_cast<uint32_t>(sourceBytes)});
      if (lane.source.state == nullptr)
        return {zdsp::StatusCode::InsufficientStorage, 3};

      auto &matrix = matrices[index];
      if (sourceChannels == 1) {
        for (uint32_t out = 0; out < outputChannels; ++out)
          matrix[out * sourceChannels] = 1.0F;
      } else if (outputChannels == 1) {
        const float scale = 1.0F / static_cast<float>(sourceChannels);
        for (uint32_t in = 0; in < sourceChannels; ++in)
          matrix[in] = scale;
      } else {
        const uint32_t matching = std::min(sourceChannels, outputChannels);
        for (uint32_t channel = 0; channel < matching; ++channel)
          matrix[channel * sourceChannels + channel] = 1.0F;
      }
      const zdsp::BuiltinNodeConfig mapConfig{zdsp::BuiltinNodeKind::ChannelMap,
                                              {mapNode},
                                              sourceChannels,
                                              outputChannels,
                                              1,
                                              0.0F,
                                              0.0F,
                                              0,
                                              zdsp::OscillatorWaveform::Saw,
                                              matrix.data(),
                                              0};
      const float effective =
          lane.muted || (anySolo && !lane.solo) ? 0.0F : lane.gain;
      const zdsp::BuiltinNodeConfig gainConfig{zdsp::BuiltinNodeKind::Gain,
                                               {gainNode},
                                               outputChannels,
                                               outputChannels,
                                               1,
                                               effective,
                                               0.0F,
                                               0,
                                               zdsp::OscillatorWaveform::Saw,
                                               nullptr,
                                               0};
      mapProcessors[index] =
          makeBuiltin(mapConfig, &mapDurable[index], &mapDurableBytes[index]);
      lane.gainProcessor = makeBuiltin(gainConfig, &gainDurable[index],
                                       &gainDurableBytes[index]);
      if (mapProcessors[index].state == nullptr ||
          lane.gainProcessor.state == nullptr)
        return {zdsp::StatusCode::InsufficientStorage, 4};

      composition.add({{sourceNode},
                       {3, sourceNode},
                       1,
                       zdsp::GraphNodeRole::Processor,
                       zdsp::GraphNodeFlagNone,
                       0,
                       1,
                       nullptr,
                       &lane.sourceBus,
                       lane.source,
                       {nullptr, 0, 1}},
                      "lane source[" + lane.id + "]");
      composition.add(
          {{mapNode},
           {1, static_cast<uint64_t>(zdsp::BuiltinNodeKind::ChannelMap)},
           1,
           zdsp::GraphNodeRole::Processor,
           zdsp::GraphNodeFlagMayProcessInPlace,
           1,
           1,
           &lane.sourceBus,
           &outputBus,
           mapProcessors[index],
           {mapDurable[index], mapDurableBytes[index], alignof(float)}},
          "channel map[" + lane.id + "]");
      composition.add(
          {{gainNode},
           {1, static_cast<uint64_t>(zdsp::BuiltinNodeKind::Gain)},
           1,
           zdsp::GraphNodeRole::Processor,
           zdsp::GraphNodeFlagMayProcessInPlace,
           1,
           1,
           &outputBus,
           &outputBus,
           lane.gainProcessor,
           {gainDurable[index], gainDurableBytes[index], alignof(float)}},
          "lane gain[" + lane.id + "]");
      composition.connect({{sourceNode}, 0, {mapNode}, 0});
      composition.connect({{mapNode}, 0, {gainNode}, 0});
      if (lane.trainingSelected && training.has_value()) {
        const uint64_t trainingNode = kTrainingNodeBase + index;
        const size_t stateBytes = zdsp::scheduledGainStateBytes();
        void *state = zdsp::arenaAllocate(&arena, stateBytes, 64);
        if (state == nullptr)
          return {zdsp::StatusCode::InsufficientStorage, 8};
        const zdsp::ScheduledGainConfig trainingConfig{
            {trainingNode},
            training->mode == NativePlaybackTrainingMode::Period
                ? zdsp::ScheduledGainMode::Period
                : zdsp::ScheduledGainMode::Windows,
            trainingWindows.empty() ? nullptr : trainingWindows.data(),
            static_cast<uint32_t>(trainingWindows.size()),
            training->periodFrames,
            0.0F,
            1.0F,
            {kNativePlaybackGainRampFrames},
            trainingEnabled};
        lane.trainingProcessor = zdsp::createScheduledGain(
            trainingConfig,
            {static_cast<uint8_t *>(state), static_cast<uint32_t>(stateBytes)});
        if (lane.trainingProcessor.state == nullptr)
          return {zdsp::StatusCode::InvalidArgument, 9};
        composition.add(
            {{trainingNode},
             {5, trainingNode},
             1,
             zdsp::GraphNodeRole::Processor,
             zdsp::GraphNodeFlagMayProcessInPlace,
             1,
             1,
             &outputBus,
             &outputBus,
             lane.trainingProcessor,
             {nullptr, 0, 1}},
            "prepared training duck[" + lane.id + "]");
        composition.connect({{gainNode}, 0, {trainingNode}, 0});
        composition.connect(
            {{trainingNode}, 0, {kSongMixNode}, static_cast<uint32_t>(index)});
      } else {
        composition.connect(
            {{gainNode}, 0, {kSongMixNode}, static_cast<uint32_t>(index)});
      }
      retainedBytes += lane.owner->retainedBytes();
    }

    const zdsp::AudioBusDescriptor monoBus = descriptor(1, nullptr);
    std::array<zdsp::AudioBusDescriptor, 2> outputMixInputs{outputBus,
                                                            outputBus};
    std::array<float, zdsp::kMaximumChannelsPerBus> cueMatrix{};
    for (uint32_t channel = 0; channel < outputChannels; ++channel)
      cueMatrix[channel] = 1.0F;
    std::array<zdsp::BuiltinNodeConfig, 7> finalConfigs{};
    size_t finalCount = 0;
    const auto addConfig = [&](zdsp::BuiltinNodeKind kind, uint64_t node,
                               uint32_t inputChannels, uint32_t inputBusCount,
                               float value) {
      finalConfigs[finalCount++] = {kind,
                                    {node},
                                    inputChannels,
                                    outputChannels,
                                    inputBusCount,
                                    value,
                                    0.0F,
                                    0,
                                    zdsp::OscillatorWaveform::Saw,
                                    nullptr,
                                    0};
    };
    addConfig(zdsp::BuiltinNodeKind::Mix, kSongMixNode, outputChannels,
              static_cast<uint32_t>(lanes.size()), 0.0F);
    addConfig(zdsp::BuiltinNodeKind::Gain, kSongGainNode, outputChannels, 1,
              masterGain);
    if (hasReference) {
      addConfig(zdsp::BuiltinNodeKind::ChannelMap, kCueMapNode, 1, 1, 0.0F);
      finalConfigs[2].channelMatrix = cueMatrix.data();
      addConfig(zdsp::BuiltinNodeKind::Gain, kReferenceGainNode, outputChannels,
                1, cuePlan->volume);
      addConfig(zdsp::BuiltinNodeKind::Mix, kOutputMixNode, outputChannels, 2,
                0.0F);
      addConfig(zdsp::BuiltinNodeKind::Gain, kOutputGainNode, outputChannels, 1,
                1.0F);
    }
    addConfig(zdsp::BuiltinNodeKind::SafetyLimiter, kLimiterNode,
              outputChannels, 1, kNativePlaybackLimiterCeiling);

    std::array<zdsp::ProcessorHandle, 7> finalProcessors{};
    std::array<void *, 7> finalDurable{};
    std::array<size_t, 7> finalDurableBytes{};
    for (size_t index = 0; index < finalCount; ++index) {
      finalProcessors[index] = makeBuiltin(
          finalConfigs[index], &finalDurable[index], &finalDurableBytes[index]);
      if (finalProcessors[index].state == nullptr)
        return {zdsp::StatusCode::InsufficientStorage, 5};
    }
    masterProcessor = finalProcessors[1];
    referenceGain = hasReference ? cuePlan->volume : 0.0F;
    if (hasTimePitch) {
      const SignalsmithTimePitchConfig timePitchConfig{
          {kTimePitchNode}, {sampleRate}, outputChannels, maximumFrames,
          timePitchCorrectionSemitones};
      const size_t stateBytes = signalsmithTimePitchStateBytes();
      void *state = zdsp::arenaAllocate(&arena, stateBytes, 64);
      timePitchPreparedBytes =
          signalsmithTimePitchPreparedBytes(timePitchConfig);
      timePitchPrepared = zdsp::arenaAllocate(
          &arena, timePitchPreparedBytes, alignof(float));
      if (state == nullptr || timePitchPrepared == nullptr ||
          timePitchPreparedBytes == 0)
        return {zdsp::StatusCode::InsufficientStorage, 10};
      timePitchProcessor = createSignalsmithTimePitch(
          timePitchConfig,
          {static_cast<uint8_t *>(state), static_cast<uint32_t>(stateBytes)});
      if (timePitchProcessor.state == nullptr)
        return {zdsp::StatusCode::InvalidArgument, 11};
        const size_t timePitchRetained =
            signalsmithExternalRetainedBytes(timePitchConfig);
      if (timePitchRetained == 0 ||
          retainedBytes > std::numeric_limits<size_t>::max() -
                              timePitchRetained)
        return {zdsp::StatusCode::CapacityExceeded, 12};
      retainedBytes += timePitchRetained;
    }

    const auto appendBuiltin = [&](size_t index, const char *label,
                                   const zdsp::AudioBusDescriptor *inputs,
                                   uint32_t inputBusCount,
                                   zdsp::GraphNodeFlags flags) {
      const zdsp::BuiltinNodeConfig &config = finalConfigs[index];
      composition.add(
          {config.node,
           {1, static_cast<uint64_t>(config.kind)},
           1,
           zdsp::GraphNodeRole::Processor,
           flags,
           inputBusCount,
           1,
           inputs,
           &outputBus,
           finalProcessors[index],
           {finalDurable[index], finalDurableBytes[index], alignof(float)}},
          label);
    };
    appendBuiltin(0, "song mix", songMixInputs.data(),
                  static_cast<uint32_t>(songMixInputs.size()),
                  zdsp::GraphNodeFlagNone);
    appendBuiltin(1, "song gain", &outputBus, 1,
                  zdsp::GraphNodeFlagMayProcessInPlace);

    composition.connect({{kSongMixNode}, 0, {kSongGainNode}, 0});
    uint64_t processedSongNode = kSongGainNode;
    if (hasTimePitch) {
      composition.add({{kTimePitchNode},
                       {6, kTimePitchNode},
                       1,
                       zdsp::GraphNodeRole::Processor,
                       zdsp::GraphNodeFlagNone,
                       1,
                       1,
                       &outputBus,
                       &outputBus,
                       timePitchProcessor,
                       {timePitchPrepared, timePitchPreparedBytes,
                        alignof(float)}},
                      "Signalsmith time/pitch");
      composition.connect({{kSongGainNode}, 0, {kTimePitchNode}, 0});
      processedSongNode = kTimePitchNode;
    }
    if (hasReference) {
      cueEvents.reserve(cuePlan->events.size());
      for (const PlaybackCueEvent &event : cuePlan->events) {
        cueEvents.push_back(
            {event.projectFrame, static_cast<uint32_t>(event.sound)});
      }
      cueSounds = {{{cuePlan->ordinaryClickPcm.data(),
                     static_cast<uint32_t>(cuePlan->ordinaryClickPcm.size())},
                    {cuePlan->accentClickPcm.data(),
                     static_cast<uint32_t>(cuePlan->accentClickPcm.size())}}};
      const size_t cueStateBytes = zdsp::scheduledCueSourceStateBytes();
      void *cueState = zdsp::arenaAllocate(&arena, cueStateBytes, 64);
      if (cueState == nullptr)
        return {zdsp::StatusCode::InsufficientStorage, 6};
      cueSource = zdsp::createScheduledCueSource(
          {{kCueSourceNode},
           cueEvents.data(),
           static_cast<uint32_t>(cueEvents.size()),
           cueSounds.data(),
           static_cast<uint32_t>(cueSounds.size()),
           {sampleRate},
           playbackRateQ32},
          {static_cast<uint8_t *>(cueState),
           static_cast<uint32_t>(cueStateBytes)});
      if (cueSource.state == nullptr)
        return {zdsp::StatusCode::InvalidArgument, 7};

      composition.add({{kCueSourceNode},
                       {4, kCueSourceNode},
                       1,
                       zdsp::GraphNodeRole::Processor,
                       zdsp::GraphNodeFlagNone,
                       0,
                       1,
                       nullptr,
                       &monoBus,
                       cueSource,
                       {nullptr, 0, 1}},
                      "prepared cue source");
      appendBuiltin(2, "reference map", &monoBus, 1,
                    zdsp::GraphNodeFlagMayProcessInPlace);
      appendBuiltin(3, "reference gain", &outputBus, 1,
                    zdsp::GraphNodeFlagMayProcessInPlace);
      appendBuiltin(4, "output mix", outputMixInputs.data(), 2,
                    zdsp::GraphNodeFlagNone);
      appendBuiltin(5, "output gain", &outputBus, 1,
                    zdsp::GraphNodeFlagMayProcessInPlace);
      appendBuiltin(6, "safety limiter", &outputBus, 1,
                    zdsp::GraphNodeFlagMayProcessInPlace);
      composition.connect({{kCueSourceNode}, 0, {kCueMapNode}, 0});
      composition.connect({{kCueMapNode}, 0, {kReferenceGainNode}, 0});
      composition.connect({{processedSongNode}, 0, {kOutputMixNode}, 0});
      composition.connect({{kReferenceGainNode}, 0, {kOutputMixNode}, 1});
      composition.connect({{kOutputMixNode}, 0, {kOutputGainNode}, 0});
      composition.connect({{kOutputGainNode}, 0, {kLimiterNode}, 0});
    } else {
      appendBuiltin(2, "safety limiter", &outputBus, 1,
                    zdsp::GraphNodeFlagMayProcessInPlace);
      composition.connect({{processedSongNode}, 0, {kLimiterNode}, 0});
    }
    composition.add({{kOutputNode},
                     {0, kOutputNode},
                     1,
                     zdsp::GraphNodeRole::Output,
                     zdsp::GraphNodeFlagNone,
                     1,
                     0,
                     &outputBus,
                     nullptr,
                     {},
                     {}},
                    "physical output");
    composition.connect({{kLimiterNode}, 0, {kOutputNode}, 0});

    graphNodeCount = static_cast<uint32_t>(composition.nodes.size());
    graphConnectionCount =
        static_cast<uint32_t>(composition.connections.size());
    topology = composition.summary();
    if (cuePlan != nullptr) {
      retainedBytes += cuePlanRetainedBytes(*cuePlan);
      retainedBytes += cueEvents.capacity() * sizeof(zdsp::ScheduledCueEvent);
    }

    const zdsp::GraphDescription description{
        zdsp::kGraphFormatVersion,
        {sampleRate},
        {maximumFrames},
        composition.nodes.data(),
        static_cast<uint32_t>(composition.nodes.size()),
        composition.connections.data(),
        static_cast<uint32_t>(composition.connections.size())};
    zdsp::GraphCompileResult compiled{};
    const zdsp::Status compileStatus =
        zdsp::compileGraph(description, &arena, &compiled, compileError);
    if (!zdsp::succeeded(compileStatus)) {
      (void)zdsp::cleanupFailedCompile(&compiled);
      return compileStatus;
    }
    graph = compiled.graph;
    graphLatencyFrames = zdsp::compiledGraphLatency(*graph).value;
    latencyCompensatedEdgeCount =
        zdsp::compiledGraphBufferPlan(*graph).compensatedEdgeCount;
    std::optional<NativePlaybackGraphSnapshot> structured =
        composition.snapshot(transportGeneration, sampleRate, maximumFrames);
    if (!structured.has_value() ||
        structured->nodes.size() != graphNodeCount ||
        structured->connections.size() != graphConnectionCount ||
        zdsp::compiledGraphNodeCount(*graph) != structured->nodes.size() ||
        structured->outputLatencyFrames != graphLatencyFrames ||
        structured->latencyCompensatedConnectionCount !=
            latencyCompensatedEdgeCount)
      return {zdsp::StatusCode::InvalidArgument, 15};
    for (uint32_t index = 0; index < zdsp::compiledGraphNodeCount(*graph);
         ++index) {
      const uint64_t compiledId =
          zdsp::compiledGraphNodeId(*graph, index).value;
      if (std::count_if(structured->nodes.begin(), structured->nodes.end(),
                        [compiledId](const auto &node) {
                          return node.id == compiledId;
                        }) != 1)
        return {zdsp::StatusCode::InvalidArgument, 16};
    }
    graphSnapshot = std::make_shared<const NativePlaybackGraphSnapshot>(
        std::move(*structured));
    if (hasTimePitch) {
      timePitchAnchorFrames =
          signalsmithTimePitchAnchorFrames(timePitchProcessor);
      if (timePitchAnchorFrames == 0 ||
          timePitchAnchorFrames >
              std::numeric_limits<size_t>::max() / outputChannels)
        return {zdsp::StatusCode::CapacityExceeded, 13};
      timePitchAnchorSamples.resize(
          static_cast<size_t>(timePitchAnchorFrames) * outputChannels);
      for (uint32_t channel = 0; channel < outputChannels; ++channel)
        timePitchAnchorChannels[channel] =
            timePitchAnchorSamples.data() +
            static_cast<size_t>(channel) * timePitchAnchorFrames;
      if (timePitchAnchorSamples.capacity() >
              std::numeric_limits<size_t>::max() / sizeof(float) ||
          retainedBytes >
              std::numeric_limits<size_t>::max() -
                  timePitchAnchorSamples.capacity() * sizeof(float))
        return {zdsp::StatusCode::CapacityExceeded, 14};
      retainedBytes += timePitchAnchorSamples.capacity() * sizeof(float);
      if (!fillTimePitchAnchor(preparedStartProjectFrame) ||
          !primeSignalsmithTimePitchInitial(timePitchProcessor,
                                            timePitchAnchorInput()))
        return {zdsp::StatusCode::InvalidArgument, 15};
      initialTimePitchReanchorPlan = primeSignalsmithTimePitchReanchor(
          timePitchProcessor, timePitchAnchorInput());
      if (!initialTimePitchReanchorPlan.valid())
        return {zdsp::StatusCode::InvalidArgument, 15};
      const SignalsmithTimePitchLoopPrepareResult loopPrepared =
          configureTimePitchLoop(initialTransport.loop);
      if (!loopPrepared.ok())
        return {zdsp::StatusCode::InvalidArgument, 15};
      initialTimePitchLoopPlan = loopPrepared.plan;
    }
    zdsp::initializePublisher(&publisher, retirement, 1, &diagnostics);
    const zdsp::TransitionPlan hardCut{zdsp::TransitionKind::HardCut,
                                       {0},
                                       {0},
                                       {0},
                                       zdsp::InfiniteTailPolicy::Cut,
                                       {zdsp::TailKind::None, {0}},
                                       {0},
                                       0,
                                       100,
                                       1000,
                                       0};
    snapshot = {graph, 1, hardCut, 0};
    const zdsp::PublicationResult published =
        zdsp::submitSnapshot(&publisher, &snapshot);
    if (!zdsp::succeeded(published.status)) {
      (void)zdsp::deactivateCompiledGraph(graph);
      graph = nullptr;
      return published.status;
    }
    zdsp::initializeGraphRunner(&runner, &publisher, {}, &parameters, nullptr,
                                &diagnostics);
    runnerInitialized = true;
    transport.initialize(transportGeneration, preparedStartProjectFrame,
                         initialTransport,
                         static_cast<int64_t>(durationFrames),
                         cueEvents.empty() ? nullptr : cueEvents.data(),
                         static_cast<uint32_t>(cueEvents.size()), playbackRate,
                         timePitchProcessor, initialTimePitchLoopPlan,
                         initialTimePitchReanchorPlan);
    adapter.runner = &runner;
    adapter.transport = {slicePreparedPlaybackTransport, &transport};
    callback.adapter = &adapter;
    return zdsp::okStatus();
  }

  bool enqueueGain(zdsp::NodeId node, float value) noexcept {
    return zdsp::enqueueParameter(&parameters,
                                  {node,
                                   zdsp::kGainParameter,
                                   {0},
                                   value,
                                   zdsp::ParameterCurve::Linear,
                                   {kNativePlaybackGainRampFrames}},
                                  &diagnostics);
  }

  bool applyLaneGains() noexcept {
    const bool anySolo = std::any_of(
        lanes.begin(), lanes.end(), [](const Lane &lane) { return lane.solo; });
    std::array<zdsp::ParameterEvent, kNativePlaybackMaximumLanes> events{};
    for (size_t index = 0; index < lanes.size(); ++index) {
      const Lane &lane = lanes[index];
      const float effective =
          lane.muted || (anySolo && !lane.solo)
              ? 0.0F
              : lane.gain * lane.graphGainTrim;
      if (lane.gainNodeId == 0)
        return false;
      events[index] = {{lane.gainNodeId},
                       zdsp::kGainParameter,
                       {0},
                       effective,
                       zdsp::ParameterCurve::Linear,
                       {kNativePlaybackGainRampFrames}};
    }
    if (parameters.pushBatch(events.data(),
                             static_cast<uint32_t>(lanes.size())))
      return true;
    diagnostics.parameterOverflows.fetch_add(1, std::memory_order_relaxed);
    return false;
  }

  bool enqueueMaster(float value) noexcept {
    return masterGainNodeId != 0 &&
           enqueueGain({masterGainNodeId}, value * masterGraphTrim);
  }

  bool enqueueTrainingEnabled(bool enabled) noexcept {
    std::array<zdsp::ParameterEvent, kNativePlaybackMaximumLanes> events{};
    uint32_t count = 0;
    for (size_t index = 0; index < lanes.size(); ++index) {
      if (!lanes[index].trainingSelected)
        continue;
      if (lanes[index].trainingNodeId == 0)
        return false;
      events[count++] = {{lanes[index].trainingNodeId},
                         zdsp::kScheduledGainEnableParameter,
                         {0},
                         enabled ? 1.0F : 0.0F,
                         zdsp::ParameterCurve::Step,
                         {0}};
    }
    if (count == 0)
      return false;
    if (parameters.pushBatch(events.data(), count)) {
      trainingEnabled = enabled;
      return true;
    }
    diagnostics.parameterOverflows.fetch_add(1, std::memory_order_relaxed);
    return false;
  }

  bool enqueuePreviewClick(NativePlaybackPreviewClickSound sound) noexcept {
    return cueSource.state != nullptr &&
           zdsp::enqueueScheduledCueOneShot(
               cueSource, static_cast<uint32_t>(sound));
  }

  zdsp::ScheduledCueOneShotStatus previewClickStatus() const noexcept {
    return zdsp::scheduledCueOneShotStatus(cueSource);
  }

  bool allCursorsAtStart() const noexcept {
    const uint64_t selected =
        cuePlan == nullptr || cuePlan->sourceStartFrame < 0
            ? 0
            : static_cast<uint64_t>(cuePlan->sourceStartFrame);
    for (const Lane &lane : lanes)
      if (zdsp::decodedBufferSourceCursor(lane.source, &lane.cursorReader) !=
          std::min(selected, lane.owner->frameCount()))
        return false;
    return true;
  }

  bool shutdown() noexcept {
    telemetryLive = false;
    if (runnerInitialized) {
      observe(NativePlaybackLifecycleEvent::RunnerShutdown);
      if (testHooks != nullptr && testHooks->failRunnerShutdown != nullptr &&
          testHooks->failRunnerShutdown(testHooks->context))
        return false;
      zdsp::PublishedGraphSnapshot *snapshots[2]{};
      uint32_t count = 0;
      const zdsp::Status stopped =
          zdsp::shutdownGraphRunner(&runner, snapshots, 2, &count);
      if (!zdsp::succeeded(stopped))
        return false;
      runnerInitialized = false;
      adapter.runner = nullptr;
      adapter.transport = {};
      callback.adapter = nullptr;
    }
    if (graph != nullptr) {
      observe(NativePlaybackLifecycleEvent::GraphDeactivate);
      const zdsp::Status deactivated = zdsp::deactivateCompiledGraph(graph);
      if (!zdsp::succeeded(deactivated))
        return false;
      graph = nullptr;
    }
    observe(NativePlaybackLifecycleEvent::DecodedRelease);
    lanes.clear();
    cueSource = {};
    cueEvents.clear();
    cueSounds = {};
    cuePlan.reset();
    training.reset();
    trainingWindows.clear();
    graphSnapshot.reset();
    graphArenaBytes = 0;
    retainedBytes = 0;
    return true;
  }
};

enum class PlaybackQuarantineSlotState : uint32_t {
  Available = 0,
  Reserved,
  Consumed,
};

struct QuarantinedPlaybackGraph {
  std::atomic<PlaybackQuarantineSlotState> state{
      PlaybackQuarantineSlotState::Available};
  // While Reserved the graph is owned by exactly one session, possibly in an
  // off-lock stale-retirement call. Publishing its size here lets every other
  // session report the process owner without dereferencing that session.
  std::atomic<size_t> reservedRetainedBytes{0};
  // Two, not one: a swap has two graphs the callback can see at once (the
  // outgoing one until the seam, its replacement after), and a stream that
  // never proves quiescent leaves both unfreeable. One reservation still
  // covers a session, and a third graph is still the impossible case.
  std::array<std::unique_ptr<PreparedPlaybackGraph>, 2> graphs;
  std::atomic<uint32_t> graphCount{0};
};

static_assert(
    std::is_nothrow_default_constructible_v<QuarantinedPlaybackGraph>);

QuarantinedPlaybackGraph &playbackQuarantine() noexcept {
  // Placement construction uses preallocated process-lifetime storage: no
  // lazy heap allocation can terminate this noexcept fail-stop path, and the
  // intentionally retained graph is not destroyed during static teardown.
  alignas(QuarantinedPlaybackGraph) static std::byte
      storage[sizeof(QuarantinedPlaybackGraph)]{};
  static auto *quarantine =
      ::new (static_cast<void *>(storage)) QuarantinedPlaybackGraph();
  return *quarantine;
}

bool reservePlaybackQuarantineSlot() noexcept {
  auto &holder = playbackQuarantine();
  PlaybackQuarantineSlotState expected = PlaybackQuarantineSlotState::Available;
  const bool reserved = holder.state.compare_exchange_strong(
      expected, PlaybackQuarantineSlotState::Reserved,
      std::memory_order_acq_rel, std::memory_order_acquire);
  if (reserved)
    holder.reservedRetainedBytes.store(0, std::memory_order_release);
  return reserved;
}

void publishPlaybackQuarantineRetainedBytes(size_t retainedBytes) noexcept {
  auto &holder = playbackQuarantine();
  if (holder.state.load(std::memory_order_acquire) ==
      PlaybackQuarantineSlotState::Reserved)
    holder.reservedRetainedBytes.store(retainedBytes,
                                       std::memory_order_release);
}

void releasePlaybackQuarantineSlot() noexcept {
  auto &holder = playbackQuarantine();
  holder.reservedRetainedBytes.store(0, std::memory_order_release);
  PlaybackQuarantineSlotState expected = PlaybackQuarantineSlotState::Reserved;
  (void)holder.state.compare_exchange_strong(
      expected, PlaybackQuarantineSlotState::Available,
      std::memory_order_acq_rel, std::memory_order_acquire);
}

bool consumePlaybackQuarantineSlot(
    std::unique_ptr<PreparedPlaybackGraph> *graph) noexcept {
  if (graph == nullptr || *graph == nullptr)
    return true;
  auto &holder = playbackQuarantine();
  const PlaybackQuarantineSlotState state =
      holder.state.load(std::memory_order_acquire);
  const uint32_t count = holder.graphCount.load(std::memory_order_acquire);
  // The first graph consumes the reservation; the second (a swap's other
  // half) rides on the same one. Anything past two is the impossible case.
  if (!(state == PlaybackQuarantineSlotState::Reserved && count == 0) &&
      !(state == PlaybackQuarantineSlotState::Consumed &&
        count < holder.graphs.size()))
    return false;
  (*graph)->observe(NativePlaybackLifecycleEvent::PreparedQuarantined);
  holder.graphs[count] = std::move(*graph);
  holder.graphCount.store(count + 1u, std::memory_order_release);
  holder.state.store(PlaybackQuarantineSlotState::Consumed,
                     std::memory_order_release);
  return true;
}

void quarantineReserved(
    std::unique_ptr<PreparedPlaybackGraph> *graph) noexcept {
  if (graph == nullptr || *graph == nullptr)
    return;
  if (!consumePlaybackQuarantineSlot(graph)) {
    // Reservation makes this unreachable: there can be only one process-wide
    // prepared graph. Fail immediately rather than silently accumulating an
    // unbounded set of potentially callback-referenced graphs.
    std::terminate();
  }
}

struct PlaybackQuarantineSnapshot {
  PlaybackQuarantineSlotState state{PlaybackQuarantineSlotState::Available};
  size_t retainedBytes{0};
  bool graphPresent{false};
};

PlaybackQuarantineSnapshot playbackQuarantineSnapshot() noexcept {
  auto &holder = playbackQuarantine();
  PlaybackQuarantineSnapshot snapshot;
  snapshot.state = holder.state.load(std::memory_order_acquire);
  if (snapshot.state == PlaybackQuarantineSlotState::Consumed) {
    // Consumed is process-lifetime terminal. The graph was published before
    // the release-store of Consumed and is never mutated or released again,
    // so an acquire snapshot can safely expose its retained-byte fact.
    snapshot.graphPresent = true;
    const uint32_t count = holder.graphCount.load(std::memory_order_acquire);
    for (uint32_t index = 0; index < count && index < holder.graphs.size();
         ++index)
      if (holder.graphs[index] != nullptr)
        snapshot.retainedBytes += holder.graphs[index]->retainedBytes;
  } else if (snapshot.state == PlaybackQuarantineSlotState::Reserved) {
    snapshot.retainedBytes =
        holder.reservedRetainedBytes.load(std::memory_order_acquire);
  }
  // Available implies graph == nullptr by construction: the only graph write
  // precedes the terminal Consumed store, which never transitions back.
  return snapshot;
}

// Process-global ownership is deliberately stronger than the bounded graph
// quarantine. The quarantine answers where a fail-stop graph lives; this
// coordinator answers who may own *any* native playback lifecycle, including
// a generation claimed synchronously before descriptor admission. All state
// changes are ordinary-thread operations and use one fixed, allocation-free
// mutex-protected record so cleanup-to-fallback has no check/claim race.
struct PlaybackOwnershipCoordinator {
  std::mutex mutex;
  NativePlaybackCoordinatorState state{
      NativePlaybackCoordinatorState::Available};
  uint64_t epoch{1};
  uint64_t ownerSession{0};
  uint64_t ownerGeneration{0};
  uint64_t leaseSourceSession{0};
  uint64_t leaseSourceGeneration{0};
  uint64_t handoffLease{0};
  uint64_t nextSessionSerial{1};
  uint64_t nextLeaseSerial{1};
  bool sessionSerialExhausted{false};
  bool leaseSerialExhausted{false};
};

PlaybackOwnershipCoordinator &playbackOwnershipCoordinator() noexcept {
  alignas(PlaybackOwnershipCoordinator) static std::byte
      storage[sizeof(PlaybackOwnershipCoordinator)]{};
  static auto *coordinator =
      ::new (static_cast<void *>(storage)) PlaybackOwnershipCoordinator();
  return *coordinator;
}

struct PlaybackOwnershipSnapshot {
  NativePlaybackCoordinatorState state{
      NativePlaybackCoordinatorState::Available};
  uint64_t epoch{0};
  uint64_t ownerSession{0};
  uint64_t ownerGeneration{0};
  uint64_t leaseSourceSession{0};
  uint64_t leaseSourceGeneration{0};
  uint64_t handoffLease{0};
};

PlaybackOwnershipSnapshot coordinatorSnapshotLocked(
    const PlaybackOwnershipCoordinator &coordinator) noexcept {
  return {coordinator.state,
          coordinator.epoch,
          coordinator.ownerSession,
          coordinator.ownerGeneration,
          coordinator.leaseSourceSession,
          coordinator.leaseSourceGeneration,
          coordinator.handoffLease};
}

PlaybackOwnershipSnapshot playbackOwnershipSnapshot() noexcept {
  auto &coordinator = playbackOwnershipCoordinator();
  try {
    std::lock_guard<std::mutex> lock(coordinator.mutex);
    return coordinatorSnapshotLocked(coordinator);
  } catch (...) {
    PlaybackOwnershipSnapshot snapshot;
    snapshot.state = NativePlaybackCoordinatorState::Poisoned;
    return snapshot;
  }
}

bool advanceCoordinatorEpochLocked(
    PlaybackOwnershipCoordinator *coordinator) noexcept {
  if (coordinator == nullptr ||
      coordinator->epoch >= kNativePlaybackMaximumJsSafeInteger) {
    if (coordinator != nullptr)
      coordinator->state = NativePlaybackCoordinatorState::Poisoned;
    return false;
  }
  ++coordinator->epoch;
  return true;
}

uint64_t registerPlaybackSession() noexcept {
  auto &coordinator = playbackOwnershipCoordinator();
  try {
    std::lock_guard<std::mutex> lock(coordinator.mutex);
    if (coordinator.sessionSerialExhausted ||
        coordinator.nextSessionSerial == 0 ||
        coordinator.nextSessionSerial > kNativePlaybackMaximumJsSafeInteger)
      return 0;
    const uint64_t serial = coordinator.nextSessionSerial;
    if (serial == kNativePlaybackMaximumJsSafeInteger) {
      coordinator.sessionSerialExhausted = true;
    } else {
      ++coordinator.nextSessionSerial;
    }
    return serial;
  } catch (...) {
    return 0;
  }
}

struct PlaybackCoordinatorClaim {
  bool ok{false};
  NativePlaybackError error{NativePlaybackError::ResourceExhausted};
  PlaybackOwnershipSnapshot snapshot{};
  uint64_t consumedLease{0};
};

PlaybackCoordinatorClaim
claimPlaybackOwnership(uint64_t session, uint64_t generation,
                       uint64_t handoffLease) noexcept {
  PlaybackCoordinatorClaim result;
  auto &coordinator = playbackOwnershipCoordinator();
  try {
    std::lock_guard<std::mutex> lock(coordinator.mutex);
    const PlaybackQuarantineSnapshot quarantine = playbackQuarantineSnapshot();
    if (quarantine.state == PlaybackQuarantineSlotState::Consumed ||
        quarantine.graphPresent) {
      coordinator.state = NativePlaybackCoordinatorState::Poisoned;
      coordinator.handoffLease = 0;
      result.error = NativePlaybackError::TeardownUncertain;
      result.snapshot = coordinatorSnapshotLocked(coordinator);
      return result;
    }
    if (session == 0 || generation == 0 ||
        handoffLease > kNativePlaybackMaximumJsSafeInteger) {
      result.error = NativePlaybackError::InvalidConfiguration;
      result.snapshot = coordinatorSnapshotLocked(coordinator);
      return result;
    }
    switch (coordinator.state) {
    case NativePlaybackCoordinatorState::Available:
      if (handoffLease != 0) {
        result.error = NativePlaybackError::InvalidGeneration;
        break;
      }
      if (!advanceCoordinatorEpochLocked(&coordinator))
        break;
      coordinator.state = NativePlaybackCoordinatorState::NativeOwned;
      coordinator.ownerSession = session;
      coordinator.ownerGeneration = generation;
      coordinator.leaseSourceSession = 0;
      coordinator.leaseSourceGeneration = 0;
      coordinator.handoffLease = 0;
      result.ok = true;
      result.error = NativePlaybackError::None;
      break;
    case NativePlaybackCoordinatorState::NativeOwned:
      if (handoffLease == 0 && coordinator.ownerSession == session &&
          generation > coordinator.ownerGeneration) {
        if (!advanceCoordinatorEpochLocked(&coordinator))
          break;
        coordinator.ownerGeneration = generation;
        result.ok = true;
        result.error = NativePlaybackError::None;
      } else if (coordinator.ownerSession == session &&
                 generation <= coordinator.ownerGeneration) {
        result.error = NativePlaybackError::InvalidGeneration;
      }
      break;
    case NativePlaybackCoordinatorState::FallbackLeased:
      if (handoffLease != 0 && handoffLease == coordinator.handoffLease) {
        const uint64_t consumed = coordinator.handoffLease;
        if (!advanceCoordinatorEpochLocked(&coordinator))
          break;
        coordinator.state = NativePlaybackCoordinatorState::NativeOwned;
        coordinator.ownerSession = session;
        coordinator.ownerGeneration = generation;
        coordinator.leaseSourceSession = 0;
        coordinator.leaseSourceGeneration = 0;
        coordinator.handoffLease = 0;
        result.ok = true;
        result.error = NativePlaybackError::None;
        result.consumedLease = consumed;
      } else {
        result.error = handoffLease == 0
                           ? NativePlaybackError::ResourceExhausted
                           : NativePlaybackError::InvalidGeneration;
      }
      break;
    case NativePlaybackCoordinatorState::Poisoned:
      result.error = NativePlaybackError::TeardownUncertain;
      break;
    }
    result.snapshot = coordinatorSnapshotLocked(coordinator);
    return result;
  } catch (...) {
    result.snapshot.state = NativePlaybackCoordinatorState::Poisoned;
    result.error = NativePlaybackError::TeardownUncertain;
    return result;
  }
}

bool playbackOwnershipMatches(uint64_t session, uint64_t generation) noexcept {
  const PlaybackOwnershipSnapshot snapshot = playbackOwnershipSnapshot();
  return snapshot.state == NativePlaybackCoordinatorState::NativeOwned &&
         snapshot.ownerSession == session &&
         snapshot.ownerGeneration == generation;
}

void poisonPlaybackOwnership(uint64_t session, uint64_t generation) noexcept {
  auto &coordinator = playbackOwnershipCoordinator();
  try {
    std::lock_guard<std::mutex> lock(coordinator.mutex);
    if (coordinator.state != NativePlaybackCoordinatorState::Poisoned) {
      (void)advanceCoordinatorEpochLocked(&coordinator);
      coordinator.state = NativePlaybackCoordinatorState::Poisoned;
      coordinator.ownerSession = session;
      coordinator.ownerGeneration = generation;
      coordinator.leaseSourceSession = 0;
      coordinator.leaseSourceGeneration = 0;
      coordinator.handoffLease = 0;
    }
  } catch (...) {
  }
}

void abandonPlaybackOwnership(uint64_t session) noexcept {
  auto &coordinator = playbackOwnershipCoordinator();
  try {
    std::lock_guard<std::mutex> lock(coordinator.mutex);
    if (coordinator.state == NativePlaybackCoordinatorState::NativeOwned &&
        coordinator.ownerSession == session &&
        playbackQuarantineSnapshot().state ==
            PlaybackQuarantineSlotState::Available) {
      if (!advanceCoordinatorEpochLocked(&coordinator))
        return;
      coordinator.state = NativePlaybackCoordinatorState::Available;
      coordinator.ownerSession = 0;
      coordinator.ownerGeneration = 0;
      coordinator.leaseSourceSession = 0;
      coordinator.leaseSourceGeneration = 0;
      coordinator.handoffLease = 0;
    }
  } catch (...) {
  }
}

struct PlaybackLeaseAcquisition {
  NativePlaybackCleanupSafety safety{NativePlaybackCleanupSafety::NotOwned};
  NativePlaybackError error{NativePlaybackError::None};
  PlaybackOwnershipSnapshot snapshot{};
};

PlaybackLeaseAcquisition
acquireFallbackLease(uint64_t session, uint64_t generation, bool locallyEmpty,
                     bool forceSerialExhaustion) noexcept {
  PlaybackLeaseAcquisition result;
  auto &coordinator = playbackOwnershipCoordinator();
  try {
    std::lock_guard<std::mutex> lock(coordinator.mutex);
    const PlaybackQuarantineSnapshot quarantine = playbackQuarantineSnapshot();
    if (coordinator.state == NativePlaybackCoordinatorState::FallbackLeased &&
        coordinator.leaseSourceSession == session &&
        coordinator.leaseSourceGeneration == generation &&
        coordinator.handoffLease != 0) {
      result.safety = NativePlaybackCleanupSafety::Complete;
      result.snapshot = coordinatorSnapshotLocked(coordinator);
      return result;
    }
    if (coordinator.state == NativePlaybackCoordinatorState::Poisoned ||
        quarantine.state == PlaybackQuarantineSlotState::Consumed ||
        quarantine.graphPresent) {
      coordinator.state = NativePlaybackCoordinatorState::Poisoned;
      coordinator.handoffLease = 0;
      result.safety = NativePlaybackCleanupSafety::Uncertain;
      result.error = NativePlaybackError::TeardownUncertain;
      result.snapshot = coordinatorSnapshotLocked(coordinator);
      return result;
    }
    if (coordinator.state != NativePlaybackCoordinatorState::NativeOwned ||
        coordinator.ownerSession != session ||
        coordinator.ownerGeneration != generation) {
      result.snapshot = coordinatorSnapshotLocked(coordinator);
      return result;
    }
    if (!locallyEmpty ||
        quarantine.state != PlaybackQuarantineSlotState::Available) {
      result.safety = NativePlaybackCleanupSafety::Uncertain;
      result.error = NativePlaybackError::TeardownUncertain;
      result.snapshot = coordinatorSnapshotLocked(coordinator);
      return result;
    }
    if (forceSerialExhaustion) {
      coordinator.nextLeaseSerial = kNativePlaybackMaximumJsSafeInteger;
      coordinator.leaseSerialExhausted = true;
    }
    if (coordinator.leaseSerialExhausted || coordinator.nextLeaseSerial == 0 ||
        coordinator.nextLeaseSerial > kNativePlaybackMaximumJsSafeInteger) {
      result.safety = NativePlaybackCleanupSafety::Uncertain;
      result.error = NativePlaybackError::ResourceExhausted;
      result.snapshot = coordinatorSnapshotLocked(coordinator);
      return result;
    }
    const uint64_t lease = coordinator.nextLeaseSerial;
    if (lease == kNativePlaybackMaximumJsSafeInteger) {
      coordinator.leaseSerialExhausted = true;
    } else {
      ++coordinator.nextLeaseSerial;
    }
    if (!advanceCoordinatorEpochLocked(&coordinator)) {
      result.safety = NativePlaybackCleanupSafety::Uncertain;
      result.error = NativePlaybackError::TeardownUncertain;
      result.snapshot = coordinatorSnapshotLocked(coordinator);
      return result;
    }
    coordinator.state = NativePlaybackCoordinatorState::FallbackLeased;
    coordinator.leaseSourceSession = session;
    coordinator.leaseSourceGeneration = generation;
    coordinator.handoffLease = lease;
    result.safety = NativePlaybackCleanupSafety::Complete;
    result.snapshot = coordinatorSnapshotLocked(coordinator);
    return result;
  } catch (...) {
    result.safety = NativePlaybackCleanupSafety::Uncertain;
    result.error = NativePlaybackError::TeardownUncertain;
    result.snapshot.state = NativePlaybackCoordinatorState::Poisoned;
    return result;
  }
}

void advanceAtomic(std::atomic<uint64_t> *value, uint64_t requested) noexcept {
  uint64_t observed = value->load(std::memory_order_acquire);
  while (requested > observed &&
         !value->compare_exchange_weak(observed, requested,
                                       std::memory_order_acq_rel,
                                       std::memory_order_acquire)) {
  }
}

struct PrepareCancellationState {
  std::atomic<uint64_t> *latestGeneration{nullptr};
  std::atomic<uint64_t> *cancelledThrough{nullptr};
  // A swap candidate's own cancellation: naming exactly it, so that giving
  // up on the replacement cancels nothing of the song still playing.
  std::atomic<uint64_t> *cancelledExactly{nullptr};
  uint64_t generation{0};
  DecodeCancellation external{};
};

bool prepareCancelled(void *opaque) noexcept {
  const auto *state = static_cast<const PrepareCancellationState *>(opaque);
  return state == nullptr || state->latestGeneration == nullptr ||
         state->cancelledThrough == nullptr ||
         state->latestGeneration->load(std::memory_order_acquire) !=
             state->generation ||
         state->cancelledThrough->load(std::memory_order_acquire) >=
             state->generation ||
         (state->cancelledExactly != nullptr &&
          state->cancelledExactly->load(std::memory_order_acquire) ==
              state->generation) ||
         state->external.isRequested();
}

} // namespace

const char *nativePlaybackErrorName(NativePlaybackError error) noexcept {
  switch (error) {
  case NativePlaybackError::None:
    return "none";
  case NativePlaybackError::InvalidGeneration:
    return "invalid-generation";
  case NativePlaybackError::InvalidState:
    return "invalid-state";
  case NativePlaybackError::InvalidConfiguration:
    return "invalid-configuration";
  case NativePlaybackError::Cancelled:
    return "cancelled";
  case NativePlaybackError::DecodeFailure:
    return "decode-failure";
  case NativePlaybackError::LimitExceeded:
    return "limit-exceeded";
  case NativePlaybackError::ResourceExhausted:
    return "resource-exhausted";
  case NativePlaybackError::GraphFailure:
    return "graph-failure";
  case NativePlaybackError::HostFailure:
    return "host-failure";
  case NativePlaybackError::ProviderFailure:
    return "provider-failure";
  case NativePlaybackError::QueueFull:
    return "queue-full";
  case NativePlaybackError::TeardownUncertain:
    return "teardown-uncertain";
  case NativePlaybackError::UnsupportedPlaybackRate:
    return "unsupported-playback-rate";
  }
  return "host-failure";
}

// Everything the render thread can hold a pointer to across a swap, in ONE
// heap block owned by the session and by every graph it has pointed the
// router at. A graph whose callback never quiesced is quarantined alive, and
// its callback may still land the swap it was rendering toward — so the
// request, the two transport pointers and the late-landings counter must
// outlive the Impl exactly as the router does. The Impl reaches the router
// through an aliasing shared_ptr into this block.
struct PlaybackRenderShared {
  NativePlaybackRenderRouter router;
  struct SwapContext {
    PreparedPlaybackTransport *outgoing{nullptr};
    PreparedPlaybackTransport *incoming{nullptr};
    // Stream frame to land on; 0 lands on the next block's first frame.
    uint64_t landingContinuousFrame{0};
    // The incoming generation's Stretch anchor was filled for this project
    // position (when `exactRequested`); the seam is exact when the outgoing
    // clock is there, and its anchor is armed only then.
    bool exactRequested{false};
    int64_t predictedFrame{0};
    uint32_t predictedFractionQ32{0};
    std::atomic<uint32_t> *lateLandings{nullptr};
  } context{};
  NativePlaybackSwapRequest request{};
  std::atomic<uint32_t> lateLandings{0};
};

struct NativePlaybackSession::Impl {
  static constexpr size_t kUnloadReceiptCapacity = 8;

  struct UnloadReceiptEntry {
    bool occupied{false};
    bool ready{false};
    uint64_t commandGeneration{0};
    uint64_t cleanupGeneration{0};
    bool playbackOk{false};
    NativePlaybackError playbackError{NativePlaybackError::InvalidState};
    NativePlaybackState playbackState{NativePlaybackState::Unloaded};
    AudioHostFormat playbackFormat{};
    AudioHostLatency playbackLatency{};
    NativePlaybackCleanupResult cleanup{};
  };

  explicit Impl(std::unique_ptr<AudioHostBackend> backend,
                NativePlaybackTestHooks *hooks)
      : host(std::move(backend)), testHooks(hooks),
        sessionId(registerPlaybackSession()) {}

  ~Impl() {
    if (prepared != nullptr) {
      // A swap's outgoing graph goes first: stopHost retires it once the
      // stream is quiescent, and if the stream never is, it is as
      // callback-visible as the replacement and is quarantined beside it.
      if (!stopHost() || !prepared->shutdown()) {
        if (retiringSwap != nullptr)
          quarantineReserved(&retiringSwap);
        quarantineReserved(&prepared);
        quarantineSlotReserved = false;
        poisonPlaybackOwnership(sessionId, generation);
        return;
      }
      prepared.reset();
      router->current.store(nullptr, std::memory_order_release);
      position->clear();
    }
    releaseQuarantineReservation();
    abandonPlaybackOwnership(sessionId);
  }

  // One decoded lane kept alive across a structural rebuild. It owns nothing
  // callback-visible: the graph that borrowed this PCM is already gone.
  struct ParkedLane {
    std::string id;
    PlaybackLaneDecodeIdentity identity;
    std::shared_ptr<const DecodedAudio> owner;
    NativePlaybackLanePeaks peaks{};
    bool peaksValid{false};
  };

  mutable std::mutex mutex;
  // Parked lanes have their own small lock so the callback-safe cancellation
  // admission can drop them without reaching for the control-domain mutex it
  // deliberately never takes. Lock order: this one is always innermost.
  mutable std::mutex parkedMutex;
  std::vector<ParkedLane> parkedLanes;
  std::atomic<size_t> parkedLaneBytes{0};
  std::atomic<uint32_t> parkedLaneCount{0};
  // A short control-domain gate linearizes generation/cancellation claims
  // with prepared/open/running publication. It is never held across decode,
  // graph compilation or an AudioHost call.
  mutable std::mutex generationGate;
  AudioHost host;
  std::unique_ptr<PreparedPlaybackGraph> prepared;
  // The lock-free position sink every generation of this session publishes
  // into (see PlaybackPositionPublication). Cleared wherever the live graph
  // is retired with its callback proven quiescent; a quarantined graph keeps
  // its own reference and positionNow() screens its stale generation out.
  std::shared_ptr<PlaybackPositionPublication> position =
      std::make_shared<PlaybackPositionPublication>();
  // The host's render context for the session's whole life (see
  // PlaybackRenderShared). Which graph renders is a pointer inside it,
  // flipped by the render thread at a swap seam and by the control thread
  // only while no callback runs. `router` aliases into `renderShared`, so
  // holding either keeps the whole block alive.
  std::shared_ptr<PlaybackRenderShared> renderShared =
      std::make_shared<PlaybackRenderShared>();
  std::shared_ptr<NativePlaybackRenderRouter> router{renderShared,
                                                     &renderShared->router};
  // A swap in flight: the outgoing graph, still rendering until the router
  // says otherwise, and (in renderShared) the request the render thread
  // lands. `retiringSwap` is non-null from arm until the graph is freed;
  // `swapPending` is set only while the render thread has yet to land it.
  std::unique_ptr<PreparedPlaybackGraph> retiringSwap;
  // A compiled swap candidate on its way from prepare() to armSwap(): the
  // graph type is this file's own, so the header's declaration cannot carry
  // it. Held for the length of that call and no longer.
  std::unique_ptr<PreparedPlaybackGraph> swapCandidate;
  uint64_t retiringSwapGeneration{0};
  // The outgoing graph's bytes NOT shared with its replacement (its arena,
  // cue runtime, anchors); its decoded PCM is the same memory the new graph
  // holds and is counted once, under the new one.
  size_t retiringSwapUnsharedBytes{0};
  bool swapPending{false};
  uint32_t swapsLandedSeen{0};
  // The generation a swap prepare is building while `generation` keeps
  // rendering; zero otherwise. Its cancellation is its own (below), so that
  // giving up on the replacement never cancels the song that is playing.
  uint64_t swapPrepareGeneration{0};
  std::atomic<uint64_t> cancelledSwapCandidate{0};
  bool swapPrepareUnloadRequested{false};
  // While a swap candidate is claimed (latestGeneration names it) the live
  // generation behind it must keep accepting commands: the player is still
  // driving it, and will be until the swap lands.
  uint64_t liveBehindLatest{0};
  uint64_t lastSwappedOutGeneration{0};
  uint64_t lastFailedSwapGeneration{0};
  // positionNow()'s second accepted generation: the outgoing one, from arm
  // until its graph is freed (the sink says its number until the seam).
  std::atomic<uint64_t> swapFromGeneration{0};
  uint64_t generation{0};
  uint64_t highestAttemptGeneration{0};
  uint64_t lastCancelledGeneration{0};
  uint64_t failedPrepareCleanupGeneration{0};
  uint64_t lastUnloadedGeneration{0};
  // A stale graph remains owned here logically while its unique_ptr is held
  // by prepare() for off-lock shutdown. The reservation and prepare mutation
  // marker stay live until shutdown reaches a terminal result.
  uint64_t retiringPrepareGeneration{0};
  size_t retiringPrepareBytes{0};
  bool retiringUnloadRequested{false};
  bool retiringSupersededByNewerClaim{false};
  uint64_t prepareUnloadRequestedGeneration{0};
  std::atomic<uint64_t> pendingClaimUnloadGeneration{0};
  std::atomic<uint64_t> latestGeneration{0};
  std::atomic<uint64_t> activeGeneration{0};
  std::atomic<uint64_t> cancelledThrough{0};
  NativePlaybackState state{NativePlaybackState::Unloaded};
  NativePlaybackPrepareConfig preparedConfig{};
  AudioHostStatus lastHost{};
  AudioHostTerminalCause lastTerminal{};
  std::string lastError;
  NativePlaybackTestHooks *testHooks{nullptr};
  mutable PreparedPlaybackTransport::Telemetry lastGoodTransportTelemetry{};
  mutable uint64_t lastGoodTransportTelemetryGeneration{0};
  mutable bool hasLastGoodTransportTelemetry{false};
  uint64_t sessionId{0};
  bool quarantineSlotReserved{false};
  std::atomic<uint64_t> pendingClaimGeneration{0};
  std::atomic<uint64_t> claimedHandoffLeaseGeneration{0};
  std::atomic<uint64_t> claimedHandoffLease{0};
  uint64_t prepareMutationGeneration{0};
  uint64_t openInvocationGeneration{0};
  uint64_t openMutationGeneration{0};
  uint64_t startInvocationGeneration{0};
  uint64_t startMutationGeneration{0};
  uint64_t nextDeliverySerial{1};
  NativePlaybackDeliveryToken pendingOpenDelivery{};
  NativePlaybackDeliveryToken pendingStartDelivery{};
  std::array<UnloadReceiptEntry, kUnloadReceiptCapacity> unloadReceipts{};
  uint64_t unloadReceiptJournalExhaustedGeneration{0};
  bool retiringOldUnloadCommandAccepted{false};

  // Every command other than an adopting prepare goes through here. Parked
  // PCM is freed OUTSIDE the lock: it can be hundreds of megabytes.
  void releaseParkedLanes() noexcept {
    std::vector<ParkedLane> released;
    try {
      std::lock_guard<std::mutex> lock(parkedMutex);
      released.swap(parkedLanes);
      parkedLaneBytes.store(0, std::memory_order_release);
      parkedLaneCount.store(0, std::memory_order_release);
    } catch (...) {
      // A mutex this process cannot lock is not a reason to abandon the
      // process; the lanes stay parked and the next command tries again.
      return;
    }
  }

  // Hands the parked lanes to a caller that will own them for a while. The
  // published byte counters deliberately stay as they are: the PCM has not
  // gone anywhere, and a status read while it is still held must not report
  // an empty session. The caller publishes zero when it has actually let go.
  std::vector<ParkedLane> claimParkedLanes() noexcept {
    std::vector<ParkedLane> claimed;
    try {
      std::lock_guard<std::mutex> lock(parkedMutex);
      claimed.swap(parkedLanes);
    } catch (...) {
      return {};
    }
    return claimed;
  }

  void publishParkedLaneBytes(size_t bytes, uint32_t count) noexcept {
    parkedLaneBytes.store(bytes, std::memory_order_release);
    parkedLaneCount.store(count, std::memory_order_release);
  }

  bool parkLanes(std::vector<ParkedLane> lanes) noexcept {
    size_t bytes = 0;
    for (const ParkedLane &lane : lanes) {
      if (lane.owner == nullptr)
        return false;
      bytes += lane.owner->retainedBytes();
    }
    try {
      std::lock_guard<std::mutex> lock(parkedMutex);
      parkedLanes = std::move(lanes);
      parkedLaneBytes.store(bytes, std::memory_order_release);
      parkedLaneCount.store(static_cast<uint32_t>(parkedLanes.size()),
                            std::memory_order_release);
    } catch (...) {
      return false;
    }
    return true;
  }

  [[nodiscard]] size_t parkedBytes() const noexcept {
    return parkedLaneBytes.load(std::memory_order_acquire);
  }

  void latchTerminal(AudioHostTerminalCause cause) noexcept {
    if (cause.reason != AudioHostTerminalReason::None && cause.ordinal == 0)
      cause = makeAudioHostTerminalCause(cause.reason);
    lastTerminal = firstAudioHostTerminalCause(lastTerminal, cause);
  }

  bool reserveQuarantineReservation() noexcept {
    if (quarantineSlotReserved)
      return true;
    quarantineSlotReserved = reservePlaybackQuarantineSlot();
    return quarantineSlotReserved;
  }

  void releaseQuarantineReservation() noexcept {
    if (!quarantineSlotReserved)
      return;
    releasePlaybackQuarantineSlot();
    quarantineSlotReserved = false;
  }

  void quarantinePrepared() noexcept {
    quarantineReserved(&prepared);
    quarantineSlotReserved = false;
    poisonPlaybackOwnership(sessionId, generation);
  }

  // Whichever generation is RENDERING: during an armed swap that is still
  // the outgoing one, and a route change lands on its latch, not the
  // replacement's.
  AudioHostTerminalCause callbackTerminalCause() const noexcept {
    const NativePlaybackCallbackState *rendering =
        router->current.load(std::memory_order_acquire);
    if (rendering != nullptr)
      return rendering->firstTerminalCause.current();
    return prepared == nullptr
               ? AudioHostTerminalCause{}
               : prepared->callback.firstTerminalCause.current();
  }

  // The graph whose transport the stream is rendering right now.
  const PreparedPlaybackGraph *renderingGraph() const noexcept {
    return swapPending && retiringSwap != nullptr ? retiringSwap.get()
                                                  : prepared.get();
  }

  bool swapLanded() const noexcept {
    return retiringSwap != nullptr && swapPending &&
           router->swapsLanded.load(std::memory_order_acquire) !=
               swapsLandedSeen;
  }

  // Once the render thread has landed a swap, the outgoing graph's runner is
  // idle for good: retire it. Called at the top of status() and of every
  // command, so the memory goes back within one poll of the seam. Returns
  // false only when that retirement failed and the graph went to quarantine.
  bool serviceSwapRetirement() noexcept {
    if (retiringSwap == nullptr)
      return true;
    if (swapPending) {
      if (!swapLanded())
        return true;
      swapPending = false;
      swapsLandedSeen = router->swapsLanded.load(std::memory_order_acquire);
    }
    // A landed swap's outgoing graph carries no terminal latch: the render
    // callback refuses to land on one, so whatever it latched is read by
    // callbackTerminalCause() while it still renders, and merged by stopHost
    // before the stop that follows retires it.
    //
    // The shutdown below runs under the session mutex, where the stale
    // prepare retirement deliberately drops every lock. That is sound here
    // and only here: the acquire on swapsLanded above synchronizes with the
    // release the render thread stored after the outgoing graph's LAST
    // render returned, so its runner is idle by proof rather than by wait,
    // and the PCM is shared with the replacement — nothing large is freed.
    return retireSwappedOut();
  }

  // The outgoing graph is no longer callback-visible (landed, or the host
  // is quiescent). Free it. Its decoded PCM lives on in the new graph.
  bool retireSwappedOut() noexcept {
    if (retiringSwap == nullptr)
      return true;
    swapPending = false;
    router->swap.store(nullptr, std::memory_order_release);
    const uint64_t retired = retiringSwapGeneration;
    if (!retiringSwap->shutdown()) {
      quarantineReserved(&retiringSwap);
      quarantineSlotReserved = false;
      poisonPlaybackOwnership(sessionId, retired);
      retiringSwapGeneration = 0;
      retiringSwapUnsharedBytes = 0;
      swapFromGeneration.store(0, std::memory_order_release);
      state = NativePlaybackState::Quarantined;
      lastError = "The replaced native playback graph did not retire cleanly";
      return false;
    }
    retiringSwap.reset();
    retiringSwapGeneration = 0;
    retiringSwapUnsharedBytes = 0;
    lastSwappedOutGeneration = retired;
    swapFromGeneration.store(0, std::memory_order_release);
    if (prepared != nullptr)
      publishPlaybackQuarantineRetainedBytes(prepared->retainedBytes);
    return true;
  }

  // The two render-thread halves of a swap (see NativePlaybackSwapRequest).
  static uint32_t swapOutgoingFrames(void *opaque,
                                     const AudioHostRenderBlock &block) noexcept {
    auto *context = static_cast<PlaybackRenderShared::SwapContext *>(opaque);
    return context->outgoing->framesBeforeSwap(block,
                                               context->landingContinuousFrame);
  }

  static void swapLand(void *opaque, uint32_t) noexcept {
    auto *context = static_cast<PlaybackRenderShared::SwapContext *>(opaque);
    // Exact means the clock is where the anchor was filled for — the
    // prediction proved right — whatever stream frame that happened on.
    const bool exact = context->incoming->adoptClock(
        *context->outgoing, context->exactRequested, context->predictedFrame,
        context->predictedFractionQ32);
    if (context->exactRequested && !exact && context->lateLandings != nullptr)
      context->lateLandings->fetch_add(1u, std::memory_order_relaxed);
  }

  bool hostMutationActive() const noexcept {
    return openMutationGeneration != 0 || startMutationGeneration != 0;
  }

  bool hostMutationActiveFor(uint64_t requested) const noexcept {
    return requested != 0 && (openMutationGeneration == requested ||
                              startMutationGeneration == requested);
  }

  // A cleanup result may be labelled Complete only when the entire session
  // owns nothing, not merely when the requested token/generation is absent.
  // In particular, a later failed prepare retains an exact-generation
  // cleanup handshake and a quarantine reservation even though its public
  // state is Unloaded and it has no decoded bytes yet.
  bool locallyEmptyForCleanup() const noexcept {
    const PlaybackQuarantineSnapshot quarantine = playbackQuarantineSnapshot();
    return quarantine.state == PlaybackQuarantineSlotState::Available &&
           !quarantine.graphPresent && quarantine.retainedBytes == 0 &&
           prepared == nullptr && state == NativePlaybackState::Unloaded &&
           generation == 0 &&
           activeGeneration.load(std::memory_order_acquire) == 0 &&
           failedPrepareCleanupGeneration == 0 &&
           retiringSwap == nullptr && retiringSwapGeneration == 0 &&
           swapPrepareGeneration == 0 &&
           retiringPrepareGeneration == 0 && retiringPrepareBytes == 0 &&
           !retiringUnloadRequested && !retiringSupersededByNewerClaim &&
           prepareUnloadRequestedGeneration == 0 &&
           pendingClaimUnloadGeneration == 0 &&
           prepareMutationGeneration == 0 && !hostMutationActive() &&
           openInvocationGeneration == 0 && startInvocationGeneration == 0 &&
           !pendingOpenDelivery.valid() && !pendingStartDelivery.valid() &&
           !quarantineSlotReserved && pendingClaimGeneration == 0 &&
           // A session parking a song's decoded lanes has not proved every
           // ownership domain empty, and must not hand output to the legacy
           // path while it is still holding hundreds of megabytes of PCM.
           parkedLaneBytes.load(std::memory_order_acquire) == 0;
  }

  bool armDelivery(NativePlaybackDeliveryCommand command, uint64_t requested,
                   NativePlaybackDeliveryToken *output) noexcept {
    if (output == nullptr)
      return true;
    *output = {};
    // Serial zero is permanently invalid. Refuse the physically impossible
    // exhaustion boundary instead of wrapping and making a stale token live.
    if (nextDeliverySerial == std::numeric_limits<uint64_t>::max())
      return false;
    const NativePlaybackDeliveryToken token{requested, nextDeliverySerial++,
                                            command};
    *output = token;
    if (command == NativePlaybackDeliveryCommand::OpenOutput) {
      pendingOpenDelivery = token;
    } else if (command == NativePlaybackDeliveryCommand::Start) {
      pendingStartDelivery = token;
    } else {
      *output = {};
      return false;
    }
    return true;
  }

  static bool
  sameDeliveryToken(const NativePlaybackDeliveryToken &left,
                    const NativePlaybackDeliveryToken &right) noexcept {
    return left.valid() && left.generation == right.generation &&
           left.serial == right.serial && left.command == right.command;
  }

  NativePlaybackCleanupResult
  cleanupSnapshot(NativePlaybackCleanupSafety safety, NativePlaybackError error,
                  uint64_t requested) const noexcept {
    NativePlaybackCleanupResult result;
    result.safety = safety;
    result.error = error;
    result.generation = requested;
    result.state = state;
    const size_t parked = parkedBytes();
    result.parkedLaneBytes = parked;
    // A swapped-out graph not yet freed still holds its own bytes (its PCM
    // is the replacement's and counted there), exactly as status() says.
    const size_t preparedRetained =
        (prepared == nullptr ? 0 : prepared->retainedBytes) +
        retiringSwapUnsharedBytes;
    const size_t ownedRetained =
        retiringPrepareBytes >
                std::numeric_limits<size_t>::max() - preparedRetained
            ? std::numeric_limits<size_t>::max()
            : preparedRetained + retiringPrepareBytes;
    // Parked decoded lanes are this session's, exactly like a prepared
    // graph's PCM. A cleanup that omitted them would report an empty session
    // that is still holding a song.
    const size_t localRetained =
        parked > std::numeric_limits<size_t>::max() - ownedRetained
            ? std::numeric_limits<size_t>::max()
            : ownedRetained + parked;
    const PlaybackQuarantineSnapshot quarantine = playbackQuarantineSnapshot();
    result.processQuarantineRetainedBytes = quarantine.retainedBytes;
    result.processQuarantineReserved =
        quarantine.state == PlaybackQuarantineSlotState::Reserved;
    result.processQuarantinePoisoned =
        quarantine.state == PlaybackQuarantineSlotState::Consumed ||
        quarantine.graphPresent;
    const PlaybackOwnershipSnapshot coordinator = playbackOwnershipSnapshot();
    result.coordinatorState = coordinator.state;
    result.coordinatorEpoch = coordinator.epoch;
    result.coordinatorOwnerSession = coordinator.ownerSession;
    result.coordinatorOwnerGeneration = coordinator.ownerGeneration;
    if (result.safety == NativePlaybackCleanupSafety::Complete &&
        coordinator.state == NativePlaybackCoordinatorState::FallbackLeased &&
        coordinator.leaseSourceSession == sessionId &&
        coordinator.leaseSourceGeneration == requested)
      result.handoffLease = coordinator.handoffLease;
    // A session holding the reservation owns the same bytes described by the
    // process snapshot; another session owns no local copy. Avoid double
    // counting while retaining a process-visible byte fact for observers.
    result.retainedBytes =
        quarantineSlotReserved &&
                quarantine.state == PlaybackQuarantineSlotState::Reserved
            ? std::max(localRetained, quarantine.retainedBytes)
        : quarantine.retainedBytes >
                std::numeric_limits<size_t>::max() - localRetained
            ? std::numeric_limits<size_t>::max()
            : localRetained + quarantine.retainedBytes;
    // Complete is a transferable ownership result, not an empty snapshot.
    // It exists only while the exact source generation's process fallback
    // lease remains held. A concurrent correct reentry consumes the token and
    // therefore safely demotes an older result construction.
    if (result.safety == NativePlaybackCleanupSafety::Complete &&
        (retiringPrepareGeneration != 0 ||
         quarantine.state != PlaybackQuarantineSlotState::Available ||
         result.handoffLease == 0 ||
         coordinator.state != NativePlaybackCoordinatorState::FallbackLeased)) {
      const bool uncertain =
          retiringPrepareGeneration != 0 || result.processQuarantinePoisoned ||
          coordinator.state == NativePlaybackCoordinatorState::Poisoned;
      result.safety = uncertain ? NativePlaybackCleanupSafety::Uncertain
                                : NativePlaybackCleanupSafety::NotOwned;
      result.error = uncertain ? NativePlaybackError::TeardownUncertain
                               : NativePlaybackError::None;
    }
    result.terminalReason = lastTerminal.reason;
    result.physicalOwnershipRetained = hostMutationActive();
    return result;
  }

  NativePlaybackCleanupResult
  acquireCleanupLease(uint64_t requested) const noexcept {
    const bool forceExhaustion =
        testHooks != nullptr &&
        testHooks->exhaustHandoffLeaseSerial != nullptr &&
        testHooks->exhaustHandoffLeaseSerial(testHooks->context);
    const PlaybackLeaseAcquisition acquisition = acquireFallbackLease(
        sessionId, requested, locallyEmptyForCleanup(), forceExhaustion);
    return cleanupSnapshot(acquisition.safety, acquisition.error, requested);
  }

  bool cleanupReceiptStillCurrent(
      const NativePlaybackCleanupResult &cleanup) const noexcept {
    // A receipt taken while lanes were parked describes a session holding a
    // song. The moment those lanes are released it describes nothing that is
    // still true, and replaying it would answer the release that just freed
    // them with the park's own verdict — leaving the caller believing the
    // generation is still held. Park receipts are never Complete (parked
    // bytes are retained bytes), so without this they would replay forever.
    if (cleanup.parkedLaneBytes != 0 &&
        parkedLaneBytes.load(std::memory_order_acquire) == 0)
      return false;
    if (cleanup.safety != NativePlaybackCleanupSafety::Complete)
      return true;
    const PlaybackOwnershipSnapshot ownership = playbackOwnershipSnapshot();
    return cleanup.globallyComplete() &&
           ownership.state == NativePlaybackCoordinatorState::FallbackLeased &&
           ownership.handoffLease == cleanup.handoffLease &&
           ownership.leaseSourceSession == sessionId &&
           ownership.leaseSourceGeneration == cleanup.generation;
  }

  UnloadReceiptEntry *findUnloadReceipt(uint64_t commandGeneration) noexcept {
    for (auto &entry : unloadReceipts) {
      if (entry.occupied && entry.commandGeneration == commandGeneration)
        return &entry;
    }
    return nullptr;
  }

  const UnloadReceiptEntry *
  findUnloadReceipt(uint64_t commandGeneration) const noexcept {
    for (const auto &entry : unloadReceipts) {
      if (entry.occupied && entry.commandGeneration == commandGeneration)
        return &entry;
    }
    return nullptr;
  }

  UnloadReceiptEntry *
  reserveUnloadReceipt(uint64_t commandGeneration,
                       uint64_t cleanupGeneration) noexcept {
    if (auto *existing = findUnloadReceipt(commandGeneration))
      return existing;
    UnloadReceiptEntry *available = nullptr;
    for (auto &entry : unloadReceipts) {
      if (!entry.occupied) {
        available = &entry;
        break;
      }
      // Once a fallback lease was transferred back to native, its old proof
      // is intentionally no longer fallback-safe and its bounded slot may be
      // reused. NotOwned receipts carry no ownership claim either.
      if ((entry.ready &&
           entry.cleanup.safety == NativePlaybackCleanupSafety::NotOwned) ||
          (entry.ready &&
           entry.cleanup.safety == NativePlaybackCleanupSafety::Complete &&
           !cleanupReceiptStillCurrent(entry.cleanup)))
        available = &entry;
    }
    if (available == nullptr)
      return nullptr;
    *available = {};
    available->occupied = true;
    available->commandGeneration = commandGeneration;
    available->cleanupGeneration = cleanupGeneration;
    return available;
  }

  bool reserveDeferredUnloadReceipts(uint64_t oldGeneration,
                                     uint64_t cleanupGeneration) noexcept {
    if (testHooks != nullptr &&
        testHooks->exhaustUnloadReceiptJournal != nullptr &&
        testHooks->exhaustUnloadReceiptJournal(testHooks->context))
      return false;
    UnloadReceiptEntry *cleanup =
        reserveUnloadReceipt(cleanupGeneration, cleanupGeneration);
    if (cleanup == nullptr)
      return false;
    UnloadReceiptEntry *old =
        oldGeneration == cleanupGeneration
            ? cleanup
            : reserveUnloadReceipt(oldGeneration, cleanupGeneration);
    if (old == nullptr) {
      if (!cleanup->ready)
        *cleanup = {};
      return false;
    }
    return true;
  }

  static NativePlaybackResult
  playbackFromReceipt(const UnloadReceiptEntry &entry) noexcept {
    NativePlaybackResult result;
    result.ok = entry.playbackOk;
    result.error = entry.playbackError;
    result.generation = entry.commandGeneration;
    result.state = entry.playbackState;
    result.format = entry.playbackFormat;
    result.latency = entry.playbackLatency;
    return result;
  }

  static NativePlaybackUnloadReceipt
  unloadReceiptFromEntry(const UnloadReceiptEntry &entry) noexcept {
    return {playbackFromReceipt(entry), entry.cleanup};
  }

  void publishUnloadReceipt(uint64_t commandGeneration,
                            NativePlaybackResult playback,
                            NativePlaybackCleanupResult cleanup) noexcept {
    UnloadReceiptEntry *entry = findUnloadReceipt(commandGeneration);
    if (entry == nullptr)
      entry = reserveUnloadReceipt(commandGeneration, cleanup.generation);
    if (entry == nullptr)
      return;
    entry->cleanupGeneration = cleanup.generation;
    entry->playbackOk = playback.ok;
    entry->playbackError = playback.error;
    entry->playbackState = playback.state;
    entry->playbackFormat = playback.format;
    entry->playbackLatency = playback.latency;
    entry->cleanup = cleanup;
    entry->ready = true;
  }

  void discardUnloadReceipt(uint64_t commandGeneration) noexcept {
    if (auto *entry = findUnloadReceipt(commandGeneration))
      *entry = {};
  }

  // Finalize a newer claim whose exact unload was accepted while an older
  // graph still owned the process quarantine reservation. Callers must have
  // physically retired the old graph and published their ordinary Unloaded
  // state first. Keeping this one path shared by normal unload and stale
  // prepare retirement prevents the deferred generation from requiring a
  // second unload merely to release its claim and acquire the fallback lease.
  NativePlaybackCleanupResult finalizeDeferredClaimUnloadAfterRetirement(
      uint64_t retiredGeneration, bool publishRetiredCommandReceipt) noexcept {
    const uint64_t cleanupGeneration =
        pendingClaimUnloadGeneration.load(std::memory_order_acquire);
    if (cleanupGeneration == 0)
      return cleanupSnapshot(NativePlaybackCleanupSafety::NotOwned,
                             NativePlaybackError::None, 0);
    if (pendingClaimGeneration.load(std::memory_order_acquire) ==
        cleanupGeneration)
      pendingClaimGeneration.store(0, std::memory_order_release);
    if (failedPrepareCleanupGeneration == cleanupGeneration)
      failedPrepareCleanupGeneration = 0;
    pendingClaimUnloadGeneration.store(0, std::memory_order_release);
    if (claimedHandoffLeaseGeneration.load(std::memory_order_acquire) ==
        cleanupGeneration) {
      claimedHandoffLeaseGeneration.store(0, std::memory_order_release);
      claimedHandoffLease.store(0, std::memory_order_release);
    }
    releaseQuarantineReservation();
    NativePlaybackCleanupResult cleanup =
        acquireCleanupLease(cleanupGeneration);
    NativePlaybackResult cleanupPlayback = success(cleanupGeneration);
    publishUnloadReceipt(cleanupGeneration, std::move(cleanupPlayback),
                         cleanup);
    if (publishRetiredCommandReceipt) {
      NativePlaybackResult retiredPlayback = success(retiredGeneration);
      if (cleanup.safety == NativePlaybackCleanupSafety::Uncertain) {
        retiredPlayback.ok = false;
        retiredPlayback.error = cleanup.error == NativePlaybackError::None
                                    ? NativePlaybackError::TeardownUncertain
                                    : cleanup.error;
      }
      publishUnloadReceipt(retiredGeneration, std::move(retiredPlayback),
                           cleanup);
    } else {
      discardUnloadReceipt(retiredGeneration);
    }
    return cleanup;
  }

  void refreshTerminalState() noexcept {
    (void)serviceSwapRetirement();
    if (prepared == nullptr || state == NativePlaybackState::Preparing ||
        state == NativePlaybackState::Prepared ||
        state == NativePlaybackState::Unloaded ||
        state == NativePlaybackState::Quarantined || !hostMutationActive())
      return;
    const AudioHostStatus current = host.status();
    const AudioHostTerminalCause cause =
        effectiveTerminalCause(current, callbackTerminalCause());
    if (cause.reason != AudioHostTerminalReason::None ||
        current.state == AudioHostState::DeviceLost ||
        current.state == AudioHostState::Error) {
      state = NativePlaybackState::Terminal;
      latchTerminal(cause.reason != AudioHostTerminalReason::None
                        ? cause
                        : makeAudioHostTerminalCause(
                              AudioHostTerminalReason::ProviderFailure));
    }
  }

  // A swap candidate claims the latest generation while the song it will
  // replace is still the one being driven; that song stays current until
  // the swap is armed (then `generation` moves) or the candidate fails.
  bool latestForOutput(uint64_t requested) const noexcept {
    return requested != 0 &&
           (requested == latestGeneration.load(std::memory_order_acquire) ||
            requested == liveBehindLatest);
  }

  bool currentForCommand(uint64_t requested) const noexcept {
    return requested != 0 && requested == generation && prepared != nullptr &&
           latestForOutput(requested) &&
           cancelledThrough.load(std::memory_order_acquire) < requested;
  }

  NativePlaybackResult recoverPrepareException(NativePlaybackError error,
                                               uint64_t requested) noexcept {
    std::lock_guard<std::mutex> lock(mutex);
    if (prepareMutationGeneration != requested)
      return failureWithoutMessage(error, requested, state);
    prepareMutationGeneration = 0;
    if (swapPrepareGeneration == requested) {
      // The candidate threw; the song it was to replace is untouched.
      swapPrepareGeneration = 0;
      swapPrepareUnloadRequested = false;
      lastFailedSwapGeneration = requested;
      lastCancelledGeneration = requested;
      return failureWithoutMessage(error, requested, state);
    }
    if (generation == requested) {
      if (prepared != nullptr) {
        if (!prepared->shutdown()) {
          quarantinePrepared();
          state = NativePlaybackState::Quarantined;
          activeGeneration.store(0, std::memory_order_release);
          generation = 0;
          failedPrepareCleanupGeneration = 0;
          lastError.clear();
          return failureWithoutMessage(NativePlaybackError::GraphFailure,
                                       requested, state);
        }
        prepared.reset();
        router->current.store(nullptr, std::memory_order_release);
        position->clear();
      }
      generation = 0;
      activeGeneration.store(0, std::memory_order_release);
      state = NativePlaybackState::Unloaded;
      preparedConfig = {};
      failedPrepareCleanupGeneration = requested;
      lastError.clear();
    }
    return failureWithoutMessage(error, requested, state);
  }

  NativePlaybackResult recoverOpenException(NativePlaybackError error,
                                            uint64_t requested) noexcept {
    std::lock_guard<std::mutex> lock(mutex);
    if (openInvocationGeneration != requested)
      return failureWithoutMessage(error, requested, state);
    // host.open may have acquired a lease, observers or an AudioUnit while
    // still reporting Closed/Stopped. Mutation admission, not published host
    // state, decides whether physical stop is mandatory.
    if (!stopHost(true, true)) {
      state = NativePlaybackState::Quarantined;
      return failureWithoutMessage(NativePlaybackError::TeardownUncertain,
                                   requested, state);
    }
    if (requested == generation && prepared != nullptr) {
      state = NativePlaybackState::Prepared;
      lastError.clear();
    }
    return failureWithoutMessage(error, requested, state);
  }

  NativePlaybackResult recoverStartException(NativePlaybackError error,
                                             uint64_t requested) noexcept {
    std::lock_guard<std::mutex> lock(mutex);
    if (startInvocationGeneration != requested)
      return failureWithoutMessage(error, requested, state);
    const AudioHostStatus beforeStop = host.status();
    const AudioHostTerminalCause cause =
        effectiveTerminalCause(beforeStop, callbackTerminalCause());
    latchTerminal(cause);
    if (!stopHost(false, true)) {
      state = NativePlaybackState::Quarantined;
      return failureWithoutMessage(NativePlaybackError::TeardownUncertain,
                                   requested, state);
    }
    if (lastTerminal.reason != AudioHostTerminalReason::None) {
      state = NativePlaybackState::Terminal;
    } else {
      state = NativePlaybackState::Stopped;
    }
    lastError.clear();
    return failureWithoutMessage(error, requested, state);
  }

  bool stopHost(bool force = false,
                bool preserveDeliveryToken = false) noexcept {
    const bool mutationActive = hostMutationActive();
    // A merely Prepared generation has never admitted this provider. Do not
    // sample or stop a stale stream from a prior generation, and do not import
    // its format, telemetry or retained terminal cause.
    if (!mutationActive && !force)
      return true;
    const AudioHostStatus before = host.status();
    latchTerminal(effectiveTerminalCause(before, callbackTerminalCause()));
    if (!force && !mutationActive && safeStoppedState(before.state)) {
      lastHost = before;
      return true;
    }
    if (prepared != nullptr)
      prepared->observe(NativePlaybackLifecycleEvent::HostStopBegin);
    host.stop();
    if (prepared != nullptr)
      prepared->observe(NativePlaybackLifecycleEvent::HostStopComplete);
    lastHost = host.status();
    // This is the final observation after provider callback quiescence. Merge
    // both domains before graph retirement can release callback state.
    latchTerminal(effectiveTerminalCause(lastHost, callbackTerminalCause()));
    const bool quiesced = safeStoppedState(lastHost.state);
    bool swapRetired = true;
    if (quiesced) {
      // A swap that had not landed: the outgoing graph rendered to the end
      // and is idle now, exactly like a landed one. Retire it here, after
      // the terminal merge above has read its latch. A retirement that fails
      // has quarantined the graph and said why (lastError, state
      // Quarantined); reporting "not quiesced" keeps that verdict in front
      // of the caller instead of a Stopped it would otherwise write over it.
      if (retiringSwap != nullptr) {
        retiringSwap->transport.forceStoppedAfterQuiescence();
        swapRetired = retireSwappedOut();
        if (prepared != nullptr)
          router->current.store(&prepared->callback,
                                std::memory_order_release);
      }
      if (prepared != nullptr)
        prepared->transport.forceStoppedAfterQuiescence();
      // These admission markers are physical-ownership facts, not transient
      // call-stack flags. Clear them only after provider quiescence is proven.
      openMutationGeneration = 0;
      openInvocationGeneration = 0;
      startMutationGeneration = 0;
      startInvocationGeneration = 0;
      if (!preserveDeliveryToken) {
        pendingOpenDelivery = {};
        pendingStartDelivery = {};
      }
    }
    return quiesced && swapRetired;
  }

  NativePlaybackResult success(uint64_t resultGeneration) const noexcept {
    const AudioHostStatus current =
        prepared != nullptr && hostMutationActive() ? host.status() : lastHost;
    AudioHostFormat format = current.format;
    if (prepared != nullptr &&
        (state == NativePlaybackState::Prepared || format.sampleRate <= 0.0)) {
      format.sampleRate = prepared->sampleRate;
      format.maximumFrames = prepared->maximumFrames;
      format.outputChannels = prepared->outputChannels;
      format.float32Planar = true;
    }
    return {true,
            NativePlaybackError::None,
            resultGeneration,
            state,
            format,
            current.latency,
            {}};
  }
};

NativePlaybackSession::NativePlaybackSession()
    : impl_(std::make_unique<Impl>(createPlatformAudioHostBackend(), nullptr)) {
}

NativePlaybackSession::NativePlaybackSession(
    std::unique_ptr<AudioHostBackend> backend)
    : impl_(std::make_unique<Impl>(std::move(backend), nullptr)) {}

NativePlaybackSession::NativePlaybackSession(
    std::unique_ptr<AudioHostBackend> backend,
    NativePlaybackTestHooks *testHooks)
    : impl_(std::make_unique<Impl>(std::move(backend), testHooks)) {}

NativePlaybackSession::~NativePlaybackSession() = default;

AudioHostInventory NativePlaybackSession::enumerate() const {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  return impl_->host.enumerate();
}

bool NativePlaybackSession::replaceAudioHostBackend(
    std::unique_ptr<AudioHostBackend> backend) {
  impl_->releaseParkedLanes();
  if (!backend) return false;
  std::scoped_lock lock(impl_->mutex, impl_->generationGate);
  if (impl_->prepared != nullptr || impl_->generation != 0 ||
      impl_->state != NativePlaybackState::Unloaded ||
      impl_->prepareMutationGeneration != 0 ||
      impl_->retiringPrepareGeneration != 0)
    return false;
  impl_->host.stop();
  impl_->host = AudioHost(std::move(backend));
  impl_->lastHost = {};
  impl_->lastTerminal = {};
  impl_->lastError.clear();
  return true;
}

bool NativePlaybackSession::claimGeneration(uint64_t generation) noexcept {
  return claimGeneration(generation, 0).ok;
}

NativePlaybackResult
NativePlaybackSession::claimGeneration(uint64_t generation,
                                       uint64_t handoffLease) noexcept {
  // Deliberately does NOT release parked lanes, and it is the only command
  // that does not. A claim is the first half of a prepare, not a command in
  // its own right: all three bridges claim the next generation and then issue
  // its prepare, so releasing here would free the parked lanes microseconds
  // before the only call that can adopt them — which is exactly what it did,
  // making retention dead code in the product while its own test (which never
  // claimed) passed. The prepare that follows still releases them if its
  // lanes do not match, and so does every other command.
  if (generation == 0 || handoffLease > kNativePlaybackMaximumJsSafeInteger)
    return failureWithoutMessage(NativePlaybackError::InvalidConfiguration,
                                 generation, NativePlaybackState::Unloaded);
  try {
    std::lock_guard<std::mutex> gate(impl_->generationGate);
    const uint64_t latest =
        impl_->latestGeneration.load(std::memory_order_acquire);
    if (generation <= latest)
      return failureWithoutMessage(NativePlaybackError::InvalidGeneration,
                                   generation, NativePlaybackState::Unloaded);
    const PlaybackCoordinatorClaim claim =
        claimPlaybackOwnership(impl_->sessionId, generation, handoffLease);
    if (!claim.ok)
      return failureWithoutMessage(claim.error, generation,
                                   NativePlaybackState::Unloaded);
    impl_->latestGeneration.store(generation, std::memory_order_release);
    impl_->pendingClaimGeneration = generation;
    impl_->claimedHandoffLeaseGeneration = generation;
    impl_->claimedHandoffLease = claim.consumedLease;
    return {true,       NativePlaybackError::None,
            generation, NativePlaybackState::Unloaded,
            {},         {},
            {}};
  } catch (...) {
    return failureWithoutMessage(NativePlaybackError::TeardownUncertain,
                                 generation, NativePlaybackState::Quarantined);
  }
}

bool NativePlaybackSession::requestCancellation(uint64_t generation) noexcept {
  impl_->releaseParkedLanes();
  if (generation == 0)
    return false;
  try {
    std::lock_guard<std::mutex> gate(impl_->generationGate);
    // A swap candidate is cancelled by name. Advancing the epoch to it would
    // cancel the live generation behind it — the song that is playing.
    if (generation == impl_->swapPrepareGeneration) {
      impl_->cancelledSwapCandidate.store(generation,
                                          std::memory_order_release);
      return true;
    }
    // A candidate that was refused or failed is the latest number claimed
    // and has nothing left to cancel; the epoch must not pass the live song
    // on its account.
    if (generation == impl_->lastFailedSwapGeneration)
      return true;
    const uint64_t active =
        impl_->activeGeneration.load(std::memory_order_acquire);
    const uint64_t latest =
        impl_->latestGeneration.load(std::memory_order_acquire);
    if (generation != active && generation != latest)
      return false;
    advanceAtomic(&impl_->cancelledThrough, generation);
    return true;
  } catch (...) {
    return false;
  }
}

NativePlaybackResult NativePlaybackSession::failPrepareAdmission(
    uint64_t generation, NativePlaybackError error) noexcept {
  impl_->releaseParkedLanes();
  try {
    std::lock_guard<std::mutex> lock(impl_->mutex);
    std::lock_guard<std::mutex> gate(impl_->generationGate);
    const uint64_t latest =
        impl_->latestGeneration.load(std::memory_order_acquire);
    if (generation == 0 || generation != latest ||
        generation <= impl_->highestAttemptGeneration ||
        impl_->pendingClaimGeneration != generation ||
        !playbackOwnershipMatches(impl_->sessionId, generation) ||
        impl_->failedPrepareCleanupGeneration != 0) {
      return failureWithoutMessage(NativePlaybackError::InvalidGeneration,
                                   generation, impl_->state);
    }
    impl_->highestAttemptGeneration = generation;
    impl_->pendingClaimGeneration = 0;
    impl_->claimedHandoffLeaseGeneration = 0;
    impl_->claimedHandoffLease = 0;
    impl_->failedPrepareCleanupGeneration = generation;
    if (impl_->prepared == nullptr && impl_->generation == 0 &&
        impl_->activeGeneration.load(std::memory_order_acquire) == 0) {
      impl_->state = NativePlaybackState::Unloaded;
      impl_->preparedConfig = {};
      impl_->lastHost = {};
      impl_->lastTerminal = {};
      impl_->lastError.clear();
    }
    const NativePlaybackError admitted =
        error == NativePlaybackError::ResourceExhausted
            ? NativePlaybackError::ResourceExhausted
            : NativePlaybackError::DecodeFailure;
    return failureWithoutMessage(admitted, generation, impl_->state);
  } catch (...) {
    return failureWithoutMessage(NativePlaybackError::ProviderFailure,
                                 generation, NativePlaybackState::Unloaded);
  }
}

NativePlaybackResult
NativePlaybackSession::prepare(NativePlaybackPrepareConfig config,
                               std::vector<NativePlaybackLaneSource> sources,
                               uint64_t generation,
                               DecodeCancellation cancellation) try {
  // Take any parked lanes into this call's own hands immediately. Only an
  // adopting prepare keeps them: an early refusal, a throw, or a lane set
  // that does not match frees them on the way out of this function. They
  // stay counted as retained for exactly as long as they are held, so a
  // status read from inside the replacement decode cannot report an empty
  // session that is in fact still holding a song.
  struct ParkedLaneClaim {
    ParkedLaneClaim(Impl *owner, std::vector<Impl::ParkedLane> claimed)
        : impl(owner), lanes(std::move(claimed)) {}
    ParkedLaneClaim(const ParkedLaneClaim &) = delete;
    ParkedLaneClaim &operator=(const ParkedLaneClaim &) = delete;
    ~ParkedLaneClaim() { release(); }

    void release() noexcept {
      lanes.clear();
      if (impl != nullptr)
        impl->publishParkedLaneBytes(0, 0);
    }

    Impl *impl{nullptr};
    std::vector<Impl::ParkedLane> lanes;
  } parked{impl_.get(), impl_->claimParkedLanes()};
  std::vector<Impl::ParkedLane> &parkedLanes = parked.lanes;
  {
    std::lock_guard<std::mutex> lock(impl_->mutex);
    std::lock_guard<std::mutex> gate(impl_->generationGate);
    uint64_t latest = impl_->latestGeneration.load(std::memory_order_acquire);
    if (generation == 0 || generation < latest ||
        generation <= impl_->highestAttemptGeneration) {
      injectFailure(impl_->testHooks,
                    NativePlaybackAllocationPoint::PreparePreconditionResult);
      return failure(NativePlaybackError::InvalidGeneration, generation,
                     impl_->state,
                     "Playback generation must increase monotonically");
    }
    if (generation > latest) {
      const PlaybackCoordinatorClaim claim = claimPlaybackOwnership(
          impl_->sessionId, generation, config.handoffLease);
      if (!claim.ok) {
        injectFailure(impl_->testHooks,
                      NativePlaybackAllocationPoint::PreparePreconditionResult);
        return failure(claim.error, generation, impl_->state,
                       "Native playback ownership is unavailable");
      }
      impl_->latestGeneration.store(generation, std::memory_order_release);
      impl_->pendingClaimGeneration = generation;
      impl_->claimedHandoffLeaseGeneration = generation;
      impl_->claimedHandoffLease = claim.consumedLease;
      latest = generation;
    }
    const PlaybackOwnershipSnapshot ownership = playbackOwnershipSnapshot();
    if (generation != latest || impl_->pendingClaimGeneration != generation ||
        ownership.state != NativePlaybackCoordinatorState::NativeOwned ||
        ownership.ownerSession != impl_->sessionId ||
        ownership.ownerGeneration != generation ||
        impl_->claimedHandoffLeaseGeneration != generation ||
        impl_->claimedHandoffLease != config.handoffLease) {
      injectFailure(impl_->testHooks,
                    NativePlaybackAllocationPoint::PreparePreconditionResult);
      return failure(ownership.state == NativePlaybackCoordinatorState::Poisoned
                         ? NativePlaybackError::TeardownUncertain
                         : NativePlaybackError::InvalidGeneration,
                     generation, impl_->state,
                     "The native playback ownership claim is stale");
    }
    if (config.swapFromGeneration != 0) {
      // Replacing a generation on its running stream. The one named must be
      // this session's, rendering, on a stream that is Running (a held
      // stream renders no blocks, so a swap could never land) and nothing
      // else may be in flight. Everything the ordinary arm below resets
      // stays exactly as it is: the song keeps playing under `generation`
      // while the candidate is built, and its commands keep landing.
      (void)impl_->serviceSwapRetirement();
      // Whatever happens to the candidate, the claim it made (latestGeneration)
      // must not make the song being driven stale for its own commands.
      if (impl_->prepared != nullptr && impl_->generation != 0)
        impl_->liveBehindLatest = impl_->generation;
      const bool replaceable =
          impl_->prepared != nullptr &&
          impl_->generation == config.swapFromGeneration &&
          impl_->state == NativePlaybackState::Running &&
          impl_->retiringSwap == nullptr &&
          impl_->swapPrepareGeneration == 0 &&
          impl_->failedPrepareCleanupGeneration == 0 &&
          impl_->retiringPrepareGeneration == 0 &&
          impl_->prepareMutationGeneration == 0 &&
          impl_->hostMutationActive() &&
          impl_->host.status().state == AudioHostState::Running;
      if (!replaceable) {
        // The candidate's claim is spent and nothing of it exists: its
        // unload and cleanup proof are answered as a cancelled generation's.
        impl_->highestAttemptGeneration = generation;
        impl_->pendingClaimGeneration = 0;
        impl_->claimedHandoffLeaseGeneration = 0;
        impl_->claimedHandoffLease = 0;
        impl_->lastFailedSwapGeneration = generation;
        impl_->lastCancelledGeneration = generation;
        injectFailure(impl_->testHooks,
                      NativePlaybackAllocationPoint::PreparePreconditionResult);
        return failure(NativePlaybackError::InvalidState, generation,
                       impl_->state,
                       "Native playback cannot replace that generation on its "
                       "stream — unload it and prepare afresh");
      }
      impl_->highestAttemptGeneration = generation;
      impl_->pendingClaimGeneration = 0;
      impl_->claimedHandoffLeaseGeneration = 0;
      impl_->claimedHandoffLease = 0;
      impl_->swapPrepareGeneration = generation;
      impl_->swapPrepareUnloadRequested = false;
      impl_->cancelledSwapCandidate.store(0, std::memory_order_release);
      impl_->liveBehindLatest = impl_->generation;
      impl_->prepareMutationGeneration = generation;
      // The live graph's decoded lanes, offered to the candidate exactly as
      // a retaining unload's are: shared_ptr copies, nothing decoded twice.
      // The song they belong to keeps rendering from the same memory.
      parkedLanes.clear();
      for (const PreparedPlaybackGraph::Lane &lane : impl_->prepared->lanes)
        parkedLanes.push_back(
            {lane.id, lane.identity, lane.owner, lane.peaks, lane.peaksValid});
    } else if (impl_->prepared != nullptr || impl_->generation != 0 ||
               impl_->activeGeneration.load(std::memory_order_acquire) != 0 ||
               impl_->failedPrepareCleanupGeneration != 0 ||
               impl_->retiringPrepareGeneration != 0) {
      injectFailure(impl_->testHooks,
                    NativePlaybackAllocationPoint::PreparePreconditionResult);
      return failure(NativePlaybackError::InvalidState, generation,
                     impl_->state,
                     "Unload the active native playback generation first");
    }
    if (config.swapFromGeneration != 0) {
      // Admitted; the reservation is the live generation's already.
    } else if (!impl_->reserveQuarantineReservation()) {
      impl_->highestAttemptGeneration = generation;
      impl_->pendingClaimGeneration = 0;
      impl_->claimedHandoffLeaseGeneration = 0;
      impl_->claimedHandoffLease = 0;
      impl_->failedPrepareCleanupGeneration = generation;
      impl_->lastHost = {};
      impl_->lastTerminal = {};
      impl_->lastError.clear();
      return failure(NativePlaybackError::ResourceExhausted, generation,
                     impl_->state,
                     "The bounded native playback quarantine is unavailable");
    } else {
      impl_->highestAttemptGeneration = generation;
      impl_->pendingClaimGeneration = 0;
      impl_->claimedHandoffLeaseGeneration = 0;
      impl_->claimedHandoffLease = 0;
      impl_->liveBehindLatest = 0;
      impl_->generation = generation;
      impl_->activeGeneration.store(generation, std::memory_order_release);
      impl_->state = NativePlaybackState::Preparing;
      impl_->prepareMutationGeneration = generation;
      impl_->lastHost = {};
      impl_->lastTerminal = {};
      impl_->lastError.clear();
    }
  }
  const bool swapPrepare = config.swapFromGeneration != 0;

  const auto failPreparation = [&](NativePlaybackError error,
                                   std::string message) {
    std::lock_guard<std::mutex> lock(impl_->mutex);
    if (swapPrepare) {
      // The candidate failed; the song it was to replace plays on, its
      // commands still accepted (liveBehindLatest stays). unload()/stop() of
      // the candidate are answered as a cancelled generation's are: nothing
      // of it exists.
      std::lock_guard<std::mutex> gate(impl_->generationGate);
      if (impl_->swapPrepareGeneration == generation) {
        impl_->swapPrepareGeneration = 0;
        impl_->swapPrepareUnloadRequested = false;
        impl_->prepareMutationGeneration = 0;
        impl_->lastFailedSwapGeneration = generation;
        impl_->lastCancelledGeneration = generation;
      }
      return failure(error, generation, impl_->state, std::move(message));
    }
    if (impl_->generation == generation && impl_->prepared == nullptr) {
      impl_->prepareMutationGeneration = 0;
      impl_->generation = 0;
      impl_->activeGeneration.store(0, std::memory_order_release);
      impl_->state = NativePlaybackState::Unloaded;
      impl_->failedPrepareCleanupGeneration = generation;
      if (error == NativePlaybackError::Cancelled)
        impl_->lastCancelledGeneration = generation;
      impl_->lastError = message;
    }
    return failure(error, generation, impl_->state, std::move(message));
  };

  uint64_t preparedPlaybackRateQ32 = 0;
  if (config.outputDeviceUid.empty() || !validChannels(config.outputChannels) ||
      !std::isfinite(config.requestedSampleRate) ||
      config.requestedSampleRate <= 0.0 ||
      config.requestedSampleRate >
          static_cast<double>(std::numeric_limits<uint32_t>::max()) ||
      std::floor(config.requestedSampleRate) != config.requestedSampleRate ||
      config.maximumFrames == 0 || config.maximumFrames > kAudioHostMaxFrames ||
      !finiteGain(config.masterGain) ||
      !rateToQ32(config.playbackRate, &preparedPlaybackRateQ32) ||
      !std::isfinite(config.transposeSemitones) ||
      config.transposeSemitones < -24.0 ||
      config.transposeSemitones > 24.0 ||
      config.maximumRetainedBytes == 0 ||
      sources.empty() || sources.size() > kNativePlaybackMaximumLanes) {
    return failPreparation(NativePlaybackError::InvalidConfiguration,
                           "Native playback configuration is invalid");
  }
  const double timePitchCorrection =
      config.transposeSemitones - 12.0 * std::log2(config.playbackRate);
  const bool needsTimePitch =
      std::fabs(timePitchCorrection) > 1e-6 ||
      graphDocumentRequestsSignalsmith(config.graphDocument);
  if (needsTimePitch &&
      (!std::isfinite(timePitchCorrection) || timePitchCorrection < -48.0 ||
       timePitchCorrection > 48.0 ||
       config.requestedSampleRate <
           kSignalsmithTimePitchMinimumSampleRate ||
       config.requestedSampleRate >
           kSignalsmithTimePitchMaximumSampleRate ||
       config.outputChannels.size() >
           kSignalsmithTimePitchMaximumChannels ||
       config.maximumFrames > kSignalsmithTimePitchMaximumBlockFrames)) {
    return failPreparation(
        NativePlaybackError::InvalidConfiguration,
        "Native time/pitch configuration exceeds the prepared DSP bounds");
  }
  if (config.cuePlan.has_value() &&
      config.cuePlan->playbackRate != config.playbackRate)
    return failPreparation(NativePlaybackError::InvalidConfiguration,
                           "Cue and transport playback rates must match");
  for (size_t index = 0; index < sources.size(); ++index) {
    if (sources[index].id.empty() || !sources[index].descriptor.valid() ||
        !finiteGain(sources[index].gain)) {
      return failPreparation(NativePlaybackError::InvalidConfiguration,
                             "A playback lane is invalid");
    }
    for (size_t prior = 0; prior < index; ++prior)
      if (sources[index].id == sources[prior].id)
        return failPreparation(NativePlaybackError::InvalidConfiguration,
                               "Playback lane IDs must be unique");
  }
  if (config.trainingDuck.has_value()) {
    const NativePlaybackTrainingDuckConfig &training = *config.trainingDuck;
    if (training.laneIds.empty() ||
        training.laneIds.size() > kNativePlaybackMaximumLanes ||
        (training.mode == NativePlaybackTrainingMode::Period &&
         (training.periodFrames <= 0 || !training.windows.empty())) ||
        (training.mode == NativePlaybackTrainingMode::Windows &&
         (training.windows.empty() ||
          training.windows.size() > zdsp::kMaximumScheduledGainWindows))) {
      return failPreparation(NativePlaybackError::InvalidConfiguration,
                             "The prepared training schedule is invalid");
    }
    for (size_t index = 0; index < training.laneIds.size(); ++index) {
      const std::string &id = training.laneIds[index];
      const bool known = std::any_of(
          sources.begin(), sources.end(),
          [&](const NativePlaybackLaneSource &source) { return source.id == id; });
      if (!known ||
          std::find(training.laneIds.begin(),
                    training.laneIds.begin() + static_cast<ptrdiff_t>(index),
                    id) != training.laneIds.begin() +
                               static_cast<ptrdiff_t>(index)) {
        return failPreparation(NativePlaybackError::InvalidConfiguration,
                               "A prepared training lane is invalid");
      }
    }
    if (training.mode == NativePlaybackTrainingMode::Windows) {
      for (size_t index = 0; index < training.windows.size(); ++index) {
        const NativePlaybackTrainingWindow &window = training.windows[index];
        if (window.startProjectFrame < 0 ||
            window.endProjectFrame <= window.startProjectFrame ||
            (index != 0 && window.startProjectFrame <
                               training.windows[index - 1].endProjectFrame)) {
          return failPreparation(NativePlaybackError::InvalidConfiguration,
                                 "Prepared training windows are invalid");
        }
      }
    }
  }

  const size_t trainingLaneCount =
      config.trainingDuck.has_value() ? config.trainingDuck->laneIds.size() : 0;
  if (!config.graphDocument.has_value()) {
    NativePlaybackGraphContext synthesizedContext;
    synthesizedContext.outputChannels =
        static_cast<uint32_t>(config.outputChannels.size());
    synthesizedContext.hasReference = config.cuePlan.has_value();
    synthesizedContext.hasTraining = config.trainingDuck.has_value();
    synthesizedContext.needsTimePitch = needsTimePitch;
    synthesizedContext.lanes.reserve(sources.size());
    for (const NativePlaybackLaneSource &source : sources) {
      const bool selected = config.trainingDuck.has_value() &&
          std::find(config.trainingDuck->laneIds.begin(),
                    config.trainingDuck->laneIds.end(), source.id) !=
              config.trainingDuck->laneIds.end();
      // Source channels do not affect synthesis node count and are decoded
      // later. One is a valid placeholder for this pre-decode admission.
      synthesizedContext.lanes.push_back({source.id, 1, selected});
    }
    if (synthesizedNativePlaybackGraphNodeCount(synthesizedContext) >
        kNativePlaybackMaximumGraphNodes) {
      return failPreparation(
          NativePlaybackError::LimitExceeded,
          "The synthesized native playback graph exceeds the bounded node cap");
    }
  }
  const std::optional<size_t> graphArenaAdmission =
      preparedGraphArenaCapacity(
          sources.size(), trainingLaneCount, config.cuePlan.has_value(),
          static_cast<uint32_t>(config.outputChannels.size()),
          config.maximumFrames);
  if (!graphArenaAdmission.has_value() ||
      *graphArenaAdmission > config.maximumRetainedBytes) {
    return failPreparation(
        NativePlaybackError::LimitExceeded,
        "The native playback graph arena exceeds the aggregate memory limit");
  }

  PrepareCancellationState cancellationState{
      &impl_->latestGeneration, &impl_->cancelledThrough,
      swapPrepare ? &impl_->cancelledSwapCandidate : nullptr, generation,
      cancellation};
  const DecodeCancellation combined{&cancellationState, prepareCancelled};

  // Reserve the graph's exact realtime-arena allocation before decoding. The
  // prepared graph reports that same owned capacity once; processor durable
  // storage placed inside it is not charged a second time.
  size_t retained = *graphArenaAdmission;
  std::vector<PreparedPlaybackGraph::Lane> decoded;
  decoded.reserve(sources.size());
  uint64_t authoritativeDurationFrames = 0;

  const uint32_t requiredSampleRate =
      static_cast<uint32_t>(std::llround(config.requestedSampleRate));

  // Adoption: a structural rebuild (a tempo or transpose change) unloads and
  // prepares the same six files at the same rate. Decoding them again is
  // seconds of silence for what is a parameter change, so a retaining unload
  // parked them and this is where they are taken up. The identity compared is
  // the bridge's own key for the bytes plus the decode settings that shaped
  // the samples; anything less than an exact, whole-set, same-order match
  // decodes normally. The aggregate accounting is the same running one, in
  // the same lane order, so an adopted set is admitted on the same terms.
  bool adoptedParkedLanes = false;
  if (!parkedLanes.empty() && parkedLanes.size() == sources.size()) {
    bool matches = true;
    size_t ordered = *graphArenaAdmission;
    for (size_t index = 0; index < sources.size() && matches; ++index) {
      const Impl::ParkedLane &parked = parkedLanes[index];
      const PlaybackLaneDecodeIdentity wanted = laneDecodeIdentity(
          sources[index], config.decodeOptions, requiredSampleRate);
      const size_t bytes =
          parked.owner == nullptr ? 0 : parked.owner->retainedBytes();
      const size_t remaining = config.maximumRetainedBytes - ordered;
      matches = parked.owner != nullptr && wanted.adoptable() &&
                parked.id == sources[index].id && parked.identity == wanted &&
                remaining != 0 && bytes <= remaining;
      ordered += bytes;
    }
    if (matches) {
      for (size_t index = 0; index < sources.size(); ++index) {
        NativePlaybackLaneSource &source = sources[index];
        Impl::ParkedLane &parked = parkedLanes[index];
        retained += parked.owner->retainedBytes();
        authoritativeDurationFrames = std::max(authoritativeDurationFrames,
                                               parked.owner->frameCount());
        PreparedPlaybackGraph::Lane lane;
        lane.id = std::move(source.id);
        lane.owner = std::move(parked.owner);
        lane.peaks = parked.peaks;
        lane.peaksValid = parked.peaksValid;
        lane.identity = std::move(parked.identity);
        lane.gain = source.gain;
        lane.muted = source.muted;
        lane.solo = source.solo;
        decoded.push_back(std::move(lane));
        injectFailure(impl_->testHooks,
                      NativePlaybackAllocationPoint::AfterDecode);
      }
      for (NativePlaybackLaneSource &source : sources)
        source.descriptor.reset();
      adoptedParkedLanes = true;
    }
  }
  // Whatever was not adopted is released HERE, before a single replacement
  // byte is decoded. A six-lane song is hundreds of megabytes; holding a
  // declined set across its own replacement's decode would peak at two songs
  // at once, which on a phone is a per-process kill rather than a slow
  // rebuild. The published counters go to zero with the memory, not before.
  parked.release();

  // Fast path: decode the lanes concurrently, then admit them in lane order
  // with the exact running accounting the sequential loop performs. Six lanes
  // decoded one after another is seconds of a song opening; the pool decides
  // nothing, so a set it cannot deliver whole falls through to the sequential
  // loop below and is refused there, in its own words.
  const bool sequentialLaneDecodeForced =
      impl_->testHooks != nullptr &&
      impl_->testHooks->forceSequentialLaneDecode != nullptr &&
      impl_->testHooks->forceSequentialLaneDecode(impl_->testHooks->context);
  ParallelLaneDecode parallel =
      adoptedParkedLanes || sequentialLaneDecodeForced
          ? ParallelLaneDecode{}
          : decodeLanesConcurrently(sources, config.decodeOptions,
                                    requiredSampleRate,
                                    config.maximumRetainedBytes,
                                    *graphArenaAdmission, combined,
                                    impl_->testHooks);
  bool adoptedParallelLanes = false;
  if (parallel.complete) {
    size_t ordered = *graphArenaAdmission;
    bool admissible = true;
    // A fail-safe for the reservation above, and — while that reservation
    // holds — unreachable: every lane publishes at most the allowance drawn
    // for it, allowances are drawn from a pool that starts at the lane budget
    // and is only replenished by what a lane did NOT use, so the decoded
    // total cannot exceed the budget and no prefix of it can either. It stays
    // because it is what makes a future regression in the reservation degrade
    // to the sequential path instead of admitting an over-budget set, and it
    // costs one pass over six integers. Mutating it away is green for that
    // reason, not because the set below is unchecked: the budget invariant it
    // guards is asserted directly in laneDecodePoolStaysInsideTheMemoryBudget.
    for (const ParallelLaneDecode::Lane &lane : parallel.lanes) {
      const size_t remaining = config.maximumRetainedBytes - ordered;
      const size_t bytes = lane.result.audio->retainedBytes();
      // Both are the sequential loop's own refusals: an exhausted budget
      // before the lane, and a lane larger than the cap that budget would
      // have given its decoder. Either one hands the lane set back.
      if (remaining == 0 || bytes > remaining) {
        admissible = false;
        break;
      }
      ordered += bytes;
    }
    if (admissible) {
      for (size_t index = 0; index < sources.size(); ++index) {
        NativePlaybackLaneSource &source = sources[index];
        ParallelLaneDecode::Lane &prepared = parallel.lanes[index];
        retained += prepared.result.audio->retainedBytes();
        authoritativeDurationFrames = std::max(
            authoritativeDurationFrames, prepared.result.audio->frameCount());
        PreparedPlaybackGraph::Lane lane;
        lane.id = std::move(source.id);
        lane.owner = std::move(prepared.result.audio);
        lane.peaks = prepared.peaks;
        lane.peaksValid = prepared.peaksValid;
        lane.identity = laneDecodeIdentity(source, config.decodeOptions,
                                           requiredSampleRate);
        lane.gain = source.gain;
        lane.muted = source.muted;
        lane.solo = source.solo;
        decoded.push_back(std::move(lane));
        // Ordinary-thread fault injection stays on the ordinary thread, once
        // per lane and in lane order, exactly as the sequential loop does it.
        injectFailure(impl_->testHooks,
                      NativePlaybackAllocationPoint::AfterDecode);
      }
      // The pool consumed its duplicates; a parallel prepare must not go on
      // holding more descriptors than a sequential one.
      for (NativePlaybackLaneSource &source : sources)
        source.descriptor.reset();
      adoptedParallelLanes = true;
    }
  }
  // Release the pool's PCM before any fallback re-decode: the aggregate limit
  // describes what a prepared graph holds, not what an abandoned attempt did.
  // The reason it declined outlives the attempt, because it is the only
  // explanation the singer's log will have for a slow open.
  const std::string laneDecodeFallback = std::move(parallel.declineReason);
  parallel.lanes.clear();
  parallel.complete = false;

  // The one definition of lane admission. Every refusal below — its error
  // code and its exact words — is the original, and the parallel path above
  // deliberately reports none of its own: it hands the set back to this loop.
  if (!adoptedParallelLanes && !adoptedParkedLanes) {
    for (NativePlaybackLaneSource &source : sources) {
      if (combined.isRequested())
        return failPreparation(NativePlaybackError::Cancelled,
                               "Native playback preparation was superseded");
      DecodedAudioPrepareOptions options = config.decodeOptions;
      options.requiredSampleRate =
          static_cast<uint32_t>(std::llround(config.requestedSampleRate));
      const size_t remaining = config.maximumRetainedBytes - retained;
      if (remaining == 0) {
        return failPreparation(
            NativePlaybackError::LimitExceeded,
            "Prepared playback lanes reached the aggregate memory limit");
      }
      options.maximumDecodedBytes =
          std::min(options.maximumDecodedBytes, remaining);
      DecodedAudioResult result =
          prepareDecodedAudio(std::move(source.descriptor), options, combined);
      if (!result.ok()) {
        const NativePlaybackError error = decodeError(result.status);
        return failPreparation(
            error, error == NativePlaybackError::Cancelled
                       ? "Native playback preparation was superseded"
                       : "A WAV/FLAC playback lane could not be prepared");
      }
      const size_t bytes = result.audio->retainedBytes();
      if (bytes > config.maximumRetainedBytes - retained) {
        return failPreparation(
            NativePlaybackError::LimitExceeded,
            "Prepared playback lanes exceed the aggregate memory limit");
      }
      retained += bytes;
      authoritativeDurationFrames =
          std::max(authoritativeDurationFrames, result.audio->frameCount());
      PreparedPlaybackGraph::Lane lane;
      lane.id = std::move(source.id);
      lane.owner = std::move(result.audio);
      // One extra linear pass over PCM that is already resident and warm. It
      // costs no I/O and gives the seek bar a waveform under native playback,
      // where the stems are never decoded in JavaScript.
      lane.peaksValid = summarizeLanePeaks(*lane.owner, &lane.peaks);
      lane.identity =
          laneDecodeIdentity(source, config.decodeOptions, requiredSampleRate);
      lane.gain = source.gain;
      lane.muted = source.muted;
      lane.solo = source.solo;
      decoded.push_back(std::move(lane));
      injectFailure(impl_->testHooks, NativePlaybackAllocationPoint::AfterDecode);
    }
  }
  if (combined.isRequested())
    return failPreparation(NativePlaybackError::Cancelled,
                           "Native playback preparation was superseded");
  if (authoritativeDurationFrames == 0 ||
      authoritativeDurationFrames >
          static_cast<uint64_t>(std::numeric_limits<int64_t>::max())) {
    return failPreparation(NativePlaybackError::LimitExceeded,
                           "Decoded playback duration is out of range");
  }

  std::shared_ptr<const PlaybackCuePlan> cuePlan;
  if (config.cuePlan.has_value()) {
    PlaybackCuePlanRequest request = *config.cuePlan;
    // Decoded lane frames are the sole duration authority. The maximum keeps
    // unequal lanes addressable until the longest lane ends; bridge metadata,
    // beats and lyrics never guess or truncate this boundary.
    request.sampleRate = config.requestedSampleRate;
    request.durationSeconds = static_cast<double>(authoritativeDurationFrames) /
                              config.requestedSampleRate;
    request.playbackRate = config.playbackRate;
    PlaybackCuePlanResult planned = preparePlaybackCuePlan(request);
    if (!planned.ok()) {
      return failPreparation(cuePlanError(planned.error),
                             planned.message.empty()
                                 ? "The playback cue plan is invalid"
                                 : std::move(planned.message));
    }
    cuePlan = std::move(planned.plan);
    const size_t cueBytes =
        cuePlanRetainedBytes(*cuePlan) + cueRuntimeRetainedBytes(*cuePlan);
    if (cueBytes > config.maximumRetainedBytes - retained) {
      return failPreparation(
          NativePlaybackError::LimitExceeded,
          "The playback cue plan exceeds the aggregate memory limit");
    }
    retained += cueBytes;
    // The immutable plan is now the sole schedule authority. Do not retain a
    // second copy of the request's potentially large beat/downbeat vectors.
    config.cuePlan.reset();
  }

  const int64_t earliestStartFrame =
      cuePlan == nullptr ? 0 : -cuePlan->preRollFrames;
  const int64_t finalProjectDuration =
      cuePlan == nullptr ? static_cast<int64_t>(authoritativeDurationFrames)
                         : cuePlan->songDurationFrames;
  if (config.trainingDuck.has_value() &&
      config.trainingDuck->mode == NativePlaybackTrainingMode::Windows &&
      config.trainingDuck->windows.back().endProjectFrame >
          finalProjectDuration) {
    return failPreparation(NativePlaybackError::InvalidConfiguration,
                           "A prepared training window exceeds the song");
  }
  const int64_t preparedStartProjectFrame =
      config.preparedStartProjectFrame.value_or(earliestStartFrame);
  if (preparedStartProjectFrame < earliestStartFrame ||
      preparedStartProjectFrame > finalProjectDuration) {
    return failPreparation(
        NativePlaybackError::InvalidConfiguration,
        "The prepared playback start position is outside the final project "
        "timeline");
  }
  if (config.initialTransport.loop.has_value()) {
    const NativePlaybackInitialLoop &loop = *config.initialTransport.loop;
    if (loop.startProjectFrame < 0 ||
        loop.endProjectFrame <= loop.startProjectFrame ||
        loop.endProjectFrame > finalProjectDuration) {
      return failPreparation(
          NativePlaybackError::InvalidConfiguration,
          "The prepared initial playback loop is outside the final project "
          "timeline");
    }
  }

  auto prepared = std::make_unique<PreparedPlaybackGraph>(
      std::move(decoded), std::move(cuePlan), config.trainingDuck,
      std::move(config.graphDocument),
      config.requestedSampleRate,
      static_cast<uint32_t>(config.outputChannels.size()), config.maximumFrames,
      config.masterGain, config.playbackRate, config.transposeSemitones,
      preparedStartProjectFrame,
      config.initialTransport, generation, impl_->testHooks);
  prepared->laneDecodeFallback = laneDecodeFallback;
  prepared->inject(NativePlaybackAllocationPoint::AfterArena);
  zdsp::GraphCompileError compileError{};
  const zdsp::Status graphStatus = prepared->prepare(&compileError);
  if (!zdsp::succeeded(graphStatus)) {
    (void)prepared->shutdown();
    return failPreparation(
        NativePlaybackError::GraphFailure,
        prepared->graphPreparationError.empty()
            ? "The native playback graph could not be prepared"
            : prepared->graphPreparationError);
  }
  if (prepared->retainedBytes > config.maximumRetainedBytes) {
    (void)prepared->shutdown();
    return failPreparation(
        NativePlaybackError::LimitExceeded,
        "The prepared playback graph exceeds the aggregate memory limit");
  }
  prepared->inject(NativePlaybackAllocationPoint::AfterGraphCompile);

  prepared->observe(NativePlaybackLifecycleEvent::PrepareReadyToPublish);
  if (swapPrepare) {
    {
      std::lock_guard<std::mutex> lock(impl_->mutex);
      impl_->swapCandidate = std::move(prepared);
    }
    return armSwap(std::move(config), generation);
  }
  std::unique_ptr<PreparedPlaybackGraph> stale;
  NativePlaybackState staleState = NativePlaybackState::Unloaded;
  {
    // claimGeneration takes generationGate. The final admission check and
    // publication are therefore one linearized action: a newer claim either
    // wins before this block and prevents publication, or follows it and
    // immediately makes this generation stale for output/control commands.
    std::lock_guard<std::mutex> lock(impl_->mutex);
    std::lock_guard<std::mutex> gate(impl_->generationGate);
    if (impl_->latestGeneration.load(std::memory_order_acquire) != generation ||
        impl_->cancelledThrough.load(std::memory_order_acquire) >= generation ||
        impl_->generation != generation ||
        impl_->state != NativePlaybackState::Preparing) {
      stale = std::move(prepared);
      impl_->retiringPrepareGeneration = generation;
      impl_->retiringPrepareBytes = stale->retainedBytes;
      const PlaybackOwnershipSnapshot ownership = playbackOwnershipSnapshot();
      impl_->retiringSupersededByNewerClaim =
          ownership.state == NativePlaybackCoordinatorState::NativeOwned &&
          ownership.ownerSession == impl_->sessionId &&
          ownership.ownerGeneration > generation;
      impl_->retiringUnloadRequested =
          impl_->prepareUnloadRequestedGeneration == generation ||
          impl_->retiringSupersededByNewerClaim;
      impl_->retiringOldUnloadCommandAccepted =
          impl_->prepareUnloadRequestedGeneration == generation;
      impl_->prepareUnloadRequestedGeneration = 0;
      publishPlaybackQuarantineRetainedBytes(stale->retainedBytes);
      if (impl_->generation == generation) {
        impl_->generation = 0;
        impl_->activeGeneration.store(0, std::memory_order_release);
        impl_->state = NativePlaybackState::Unloaded;
        if (!impl_->retiringSupersededByNewerClaim &&
            impl_->failedPrepareCleanupGeneration == 0)
          impl_->failedPrepareCleanupGeneration = generation;
        impl_->lastCancelledGeneration = generation;
      }
      impl_->lastError = "Native playback preparation was superseded";
      staleState = impl_->state;
    } else {
      impl_->prepared = std::move(prepared);
      // Wire the lock-free position sink before any callback of this
      // generation can exist, and publish the prepared baseline into it now
      // (the callback is not running; this is the control thread's turn) so
      // a synchronous read between prepare and open already names this
      // generation at its entry frame rather than the previous song's exit.
      impl_->prepared->transport.positionSink = impl_->position;
      impl_->prepared->transport.publishTelemetry();
      impl_->prepared->router = impl_->router;
      publishPlaybackQuarantineRetainedBytes(impl_->prepared->retainedBytes);
      impl_->preparedConfig = std::move(config);
      impl_->state = NativePlaybackState::Prepared;
      // Preparing a new generation has not touched AudioHost. Publish a fresh
      // per-generation baseline rather than the provider's previous stopped
      // stream counters, negotiated format or latency.
      impl_->lastHost = {};
      impl_->lastTerminal = {};
      impl_->lastError.clear();
      impl_->prepareMutationGeneration = 0;
      return impl_->success(generation);
    }
  }
  // Decoded owners can be hundreds of megabytes and graph shutdown may wait
  // on test/provider quiescence. Neither session mutex nor generation gate is
  // held while retiring the stale local graph.
  const bool retired = stale->shutdown();
  {
    std::lock_guard<std::mutex> lock(impl_->mutex);
    if (impl_->retiringPrepareGeneration != generation) {
      // Losing the ownership record would make freeing callback-visible state
      // unverifiable. Preserve the graph rather than guessing.
      if (stale != nullptr)
        quarantineReserved(&stale);
      impl_->quarantineSlotReserved = false;
      poisonPlaybackOwnership(impl_->sessionId, generation);
      return failureWithoutMessage(NativePlaybackError::TeardownUncertain,
                                   generation, impl_->state);
    }
    const bool unloadRequested = impl_->retiringUnloadRequested;
    const bool supersededByNewerClaim = impl_->retiringSupersededByNewerClaim;
    const bool oldUnloadCommandAccepted =
        impl_->retiringOldUnloadCommandAccepted;
    impl_->retiringPrepareGeneration = 0;
    impl_->retiringPrepareBytes = 0;
    impl_->retiringUnloadRequested = false;
    impl_->retiringSupersededByNewerClaim = false;
    impl_->retiringOldUnloadCommandAccepted = false;
    if (impl_->prepareMutationGeneration == generation)
      impl_->prepareMutationGeneration = 0;
    if (!retired) {
      // shutdown() failed before decoded release. Consume the exact reservation
      // that admitted this stale graph; never republish it into a newer
      // generation's session state.
      quarantineReserved(&stale);
      impl_->quarantineSlotReserved = false;
      poisonPlaybackOwnership(impl_->sessionId, generation);
      if (unloadRequested) {
        if (!supersededByNewerClaim) {
          impl_->failedPrepareCleanupGeneration = 0;
          impl_->lastUnloadedGeneration = generation;
        }
        if (supersededByNewerClaim &&
            impl_->pendingClaimUnloadGeneration != 0) {
          const uint64_t cleanupGeneration =
              impl_->pendingClaimUnloadGeneration.load(
                  std::memory_order_acquire);
          const auto cleanup = impl_->cleanupSnapshot(
              NativePlaybackCleanupSafety::Uncertain,
              NativePlaybackError::TeardownUncertain, cleanupGeneration);
          impl_->publishUnloadReceipt(
              cleanupGeneration,
              failureWithoutMessage(NativePlaybackError::TeardownUncertain,
                                    cleanupGeneration, impl_->state),
              cleanup);
          if (oldUnloadCommandAccepted)
            impl_->publishUnloadReceipt(
                generation,
                failureWithoutMessage(NativePlaybackError::GraphFailure,
                                      generation, impl_->state),
                cleanup);
          else
            impl_->discardUnloadReceipt(generation);
        }
      }
      impl_->lastError =
          "The stale native playback graph did not retire cleanly";
      return failureWithoutMessage(NativePlaybackError::GraphFailure,
                                   generation, impl_->state);
    }
    publishPlaybackQuarantineRetainedBytes(0);
    if (unloadRequested) {
      if (!supersededByNewerClaim) {
        impl_->failedPrepareCleanupGeneration = 0;
        impl_->lastUnloadedGeneration = generation;
        impl_->releaseQuarantineReservation();
      } else if (impl_->pendingClaimUnloadGeneration != 0) {
        (void)impl_->finalizeDeferredClaimUnloadAfterRetirement(
            generation, oldUnloadCommandAccepted);
      }
    }
    staleState = impl_->state;
  }
  return failure(NativePlaybackError::Cancelled, generation, staleState,
                 "Native playback preparation was superseded");
} catch (const std::bad_alloc &) {
  return impl_->recoverPrepareException(NativePlaybackError::ResourceExhausted,
                                        generation);
} catch (...) {
  return impl_->recoverPrepareException(NativePlaybackError::GraphFailure,
                                        generation);
}

// The candidate is compiled; hand it the stream. The final admission check
// and the publication to the render thread are one linearized action under
// both locks, exactly like an ordinary prepare's commit: a cancellation or an
// unload that won first discards the candidate (off-lock, it never rendered),
// and one that follows finds the new generation already live. The outgoing
// graph keeps rendering until the render thread lands the seam, and is freed
// by the first status() or command after that.
NativePlaybackResult
NativePlaybackSession::armSwap(NativePlaybackPrepareConfig config,
                               uint64_t generation) {
  std::unique_ptr<PreparedPlaybackGraph> stale;
  bool cancelled = false;
  {
    std::lock_guard<std::mutex> lock(impl_->mutex);
    std::lock_guard<std::mutex> gate(impl_->generationGate);
    std::unique_ptr<PreparedPlaybackGraph> candidate =
        std::move(impl_->swapCandidate);
    (void)impl_->serviceSwapRetirement();
    cancelled =
        candidate == nullptr ||
        impl_->latestGeneration.load(std::memory_order_acquire) != generation ||
        impl_->cancelledThrough.load(std::memory_order_acquire) >= generation ||
        impl_->cancelledSwapCandidate.load(std::memory_order_acquire) ==
            generation ||
        impl_->swapPrepareGeneration != generation ||
        impl_->swapPrepareUnloadRequested;
    const AudioHostStatus hostNow = impl_->host.status();
    const bool replaceable =
        impl_->prepared != nullptr &&
        impl_->generation == config.swapFromGeneration &&
        impl_->state == NativePlaybackState::Running &&
        impl_->retiringSwap == nullptr && impl_->hostMutationActive() &&
        impl_->lastTerminal.reason == AudioHostTerminalReason::None &&
        hostNow.state == AudioHostState::Running;
    if (impl_->swapPrepareGeneration == generation) {
      impl_->swapPrepareGeneration = 0;
      impl_->swapPrepareUnloadRequested = false;
      impl_->prepareMutationGeneration = 0;
    }
    if (cancelled || !replaceable) {
      stale = std::move(candidate);
      impl_->lastFailedSwapGeneration = generation;
      impl_->lastCancelledGeneration = generation;
    } else {
      PreparedPlaybackGraph &outgoing = *impl_->prepared;
      // The sink is shared with the outgoing transport, which is publishing
      // into it from the render thread right now: wire it, publish nothing.
      candidate->transport.positionSink = impl_->position;
      candidate->router = impl_->router;
      candidate->transport.adoptControlState(outgoing.transport);
      // Where to land. A candidate with a Stretch stage wants the seam on
      // the exact position its anchor is filled for: predict the outgoing
      // clock a few blocks ahead of its last publication (sound only while
      // its mailbox is drained — a command it has not applied yet moves
      // it), re-prime the candidate's anchor and initial state there, and
      // land on that stream frame. A paused song lands on the next block at
      // the frame it is parked on. Anything else lands on the next block
      // unanchored: the stage keeps the state prepare primed, a few
      // milliseconds off at worst, and the seam is counted as late.
      struct Landing {
        uint64_t continuousFrame{0};
        bool exact{false};
        int64_t frame{0};
        uint32_t fractionQ32{0};
      } landing;
      if (candidate->hasTimePitch) {
        PreparedPlaybackTransport::Telemetry from{};
        if (outgoing.transport.mailboxDrained() &&
            outgoing.transport.snapshotTelemetry(&from) &&
            from.generation == outgoing.transportGeneration) {
          const bool advancing =
              from.state == NativePlaybackTransportState::Playing ||
              from.state == NativePlaybackTransportState::PreRoll;
          const uint64_t margin =
              hostNow.format.nominalBufferFrames != 0
                  ? 3ull * hostNow.format.nominalBufferFrames
                  : 2ull * std::max<uint32_t>(hostNow.format.maximumFrames, 1);
          const PreparedPlaybackTransport &land = candidate->transport;
          const PreparedPlaybackTransport::PredictedPosition predicted =
              advancing ? outgoing.transport.predictPosition(
                              from, margin, land.initialLoopEnabled,
                              land.initialLoopStart, land.initialLoopEnd)
                        : PreparedPlaybackTransport::PredictedPosition{
                              from.projectFrame, from.projectFractionQ32,
                              true};
          if (predicted.valid &&
              candidate->fillTimePitchAnchor(predicted.frame,
                                             predicted.fractionQ32)) {
            const SignalsmithTimePitchAnchorInput input =
                candidate->timePitchAnchorInput();
            if (primeSignalsmithTimePitchInitial(candidate->timePitchProcessor,
                                                 input)) {
              const SignalsmithTimePitchReanchorPlan plan =
                  primeSignalsmithTimePitchReanchor(
                      candidate->timePitchProcessor, input);
              if (plan.valid()) {
                candidate->initialTimePitchReanchorPlan = plan;
                candidate->transport.initialTimePitchReanchorPlan = plan;
                landing = {advancing ? from.continuousFrame + margin : 0, true,
                           predicted.frame, predicted.fractionQ32};
              }
            }
          }
        }
      }
      // Decoded PCM the candidate adopted is the same memory the outgoing
      // graph holds; count it once, under the generation that lives on.
      size_t shared = 0;
      for (const PreparedPlaybackGraph::Lane &lane : candidate->lanes) {
        for (const PreparedPlaybackGraph::Lane &old : outgoing.lanes) {
          if (lane.owner != nullptr && lane.owner == old.owner) {
            shared += lane.owner->retainedBytes();
            break;
          }
        }
      }
      impl_->retiringSwapUnsharedBytes =
          outgoing.retainedBytes > shared ? outgoing.retainedBytes - shared
                                          : 0;
      impl_->retiringSwapGeneration = impl_->generation;
      impl_->retiringSwap = std::move(impl_->prepared);
      impl_->prepared = std::move(candidate);
      impl_->swapFromGeneration.store(impl_->retiringSwapGeneration,
                                      std::memory_order_release);
      impl_->generation = generation;
      impl_->activeGeneration.store(generation, std::memory_order_release);
      impl_->liveBehindLatest = 0;
      impl_->preparedConfig = std::move(config);
      // The stream is this generation's now: every physical-ownership marker
      // names it, so stop and cleanup prove quiescence against the right one.
      impl_->openInvocationGeneration = generation;
      impl_->openMutationGeneration = generation;
      impl_->startInvocationGeneration = generation;
      impl_->startMutationGeneration = generation;
      PlaybackRenderShared &render = *impl_->renderShared;
      render.context = {&impl_->retiringSwap->transport,
                        &impl_->prepared->transport,
                        landing.continuousFrame,
                        landing.exact,
                        landing.frame,
                        landing.fractionQ32,
                        &render.lateLandings};
      render.request = {&impl_->prepared->callback, &render.context,
                        &Impl::swapOutgoingFrames, &Impl::swapLand};
      impl_->swapsLandedSeen =
          impl_->router->swapsLanded.load(std::memory_order_acquire);
      impl_->swapPending = true;
      publishPlaybackQuarantineRetainedBytes(
          impl_->prepared->retainedBytes + impl_->retiringSwapUnsharedBytes);
      impl_->lastError.clear();
      // Test-only: the window in which the prediction above can go stale.
      // A control thread held here past the landing frame lands late.
      impl_->prepared->observe(NativePlaybackLifecycleEvent::SwapArming);
      // The one store the render thread is waiting on. Everything above is
      // ordered before it.
      impl_->router->swap.store(&render.request, std::memory_order_release);
      return impl_->success(generation);
    }
  }
  // A candidate that never rendered: its runner is idle by construction, and
  // the shutdown is the ordinary off-lock one.
  const bool retired = stale == nullptr || stale->shutdown();
  std::lock_guard<std::mutex> lock(impl_->mutex);
  if (!retired) {
    quarantineReserved(&stale);
    impl_->quarantineSlotReserved = false;
    poisonPlaybackOwnership(impl_->sessionId, generation);
    impl_->state = NativePlaybackState::Quarantined;
    return failureWithoutMessage(NativePlaybackError::TeardownUncertain,
                                 generation, impl_->state);
  }
  return failure(cancelled ? NativePlaybackError::Cancelled
                           : NativePlaybackError::InvalidState,
                 generation, impl_->state,
                 cancelled ? "Native playback preparation was superseded"
                           : "The generation to replace is no longer "
                             "rendering on a running stream");
}

NativePlaybackResult NativePlaybackSession::openOutput(
    uint64_t generation, NativePlaybackDeliveryToken *deliveryToken) try {
  impl_->releaseParkedLanes();
  if (deliveryToken != nullptr)
    *deliveryToken = {};
  std::lock_guard<std::mutex> lock(impl_->mutex);
  impl_->refreshTerminalState();
  if (!impl_->currentForCommand(generation)) {
    injectFailure(impl_->testHooks,
                  NativePlaybackAllocationPoint::OpenPreconditionResult);
    return failure(NativePlaybackError::InvalidGeneration, generation,
                   impl_->state, "The playback generation is stale");
  }
  if (impl_->state == NativePlaybackState::Terminal) {
    injectFailure(impl_->testHooks,
                  NativePlaybackAllocationPoint::OpenPreconditionResult);
    return failure(NativePlaybackError::InvalidState, generation, impl_->state,
                   "Native playback reached a terminal output state");
  }
  if ((impl_->state != NativePlaybackState::Prepared &&
       impl_->state != NativePlaybackState::Stopped) ||
      !impl_->prepared->allCursorsAtStart()) {
    injectFailure(impl_->testHooks,
                  NativePlaybackAllocationPoint::OpenPreconditionResult);
    return failure(NativePlaybackError::InvalidState, generation, impl_->state,
                   "The prepared-entry graph cannot open output now");
  }

  const NativePlaybackPrepareConfig &config = impl_->preparedConfig;
  const AudioHostInventory inventory = impl_->host.enumerate();
  const auto output = std::find_if(
      inventory.devices.begin(), inventory.devices.end(),
      [&](const AudioHostDeviceInfo &device) {
        return device.uid == config.outputDeviceUid &&
               (device.direction == AudioHostEndpointDirection::Output ||
                device.direction == AudioHostEndpointDirection::Duplex);
      });
  // Name the term that failed. This is the last gate before the handoff and
  // it can refuse for four unrelated reasons; one undifferentiated sentence
  // (which also said "iOS" on Android) is what turned a platform never
  // publishing a nominal rate into hours of route archaeology.
  const char *routeFault = nullptr;
  if (output == inventory.devices.end())
    routeFault = "the endpoint is gone";
  else if (output->outputChannels == 0)
    routeFault = "the endpoint has no output channels";
  else if (output->nominalSampleRate != config.requestedSampleRate)
    routeFault = "the endpoint rate changed";
  else
    for (uint32_t channel : config.outputChannels)
      if (channel >= output->outputChannels) {
        routeFault = "the endpoint lost a prepared channel";
        break;
      }
  if (routeFault != nullptr) {
    impl_->lastError = std::string("The prepared output route no longer "
                                   "matches — ") +
                       routeFault;
    return failure(NativePlaybackError::HostFailure, generation, impl_->state,
                   impl_->lastError);
  }

  if (impl_->prepared->hasTimePitch) {
    const SignalsmithTimePitchReanchorPlan reopenPlan =
        impl_->prepared->primeTimePitchReanchor(
            impl_->prepared->preparedStartProjectFrame, 0);
    // Priming RETIRES the pending anchor before it claims a slot, so a prime
    // that then fails has already destroyed the plan prepare validated — and
    // storing that empty result would wedge even a first open, silently and
    // for the life of the generation. Fail the open instead, the way the
    // reanchor command does.
    if (!reopenPlan.valid())
      return failure(NativePlaybackError::GraphFailure, generation,
                     impl_->state,
                     "The playback stretch anchor could not be prepared off RT");
    impl_->prepared->transport.initialTimePitchReanchorPlan = reopenPlan;
  }
  // Deliberately BEFORE armDelivery: a failure above is a plain precondition
  // and needs no teardown, where every failure after it has to stopHost or
  // recover, and this one did neither — it left the open-mutation markers set
  // with no host ever opened.

  AudioHostConfig hostConfig;
  hostConfig.outputDeviceUid = config.outputDeviceUid;
  hostConfig.outputChannels = config.outputChannels;
  hostConfig.exclusive = config.exclusive;
  hostConfig.requestedSampleRate = config.requestedSampleRate;
  hostConfig.requestedBufferFrames = config.requestedBufferFrames;
  hostConfig.maximumFrames = config.maximumFrames;
  if (!impl_->armDelivery(NativePlaybackDeliveryCommand::OpenOutput, generation,
                          deliveryToken)) {
    return failureWithoutMessage(NativePlaybackError::ResourceExhausted,
                                 generation, impl_->state);
  }
  impl_->openInvocationGeneration = generation;
  impl_->openMutationGeneration = generation;
  // openOutput is admitted only while the prior provider is quiescent and all
  // positioned sources remain at their prepared entry. The next stream owns
  // a fresh output-frame anchor even if a previous open/start failed. (Its
  // fresh STRETCH anchor is primed further up, before anything is armed —
  // see the hasTimePitch block beside the route check.)
  impl_->prepared->transport.resetForOpen();
  // The router is the host's context for the session's life; this
  // generation is what it renders until a swap lands another.
  impl_->router->current.store(&impl_->prepared->callback,
                               std::memory_order_release);
  const AudioHostResult opened = impl_->host.open(
      hostConfig, &nativePlaybackRender, impl_->router.get());
  const uint32_t actualMaximumFrames = opened.format.maximumFrames;
  const uint32_t nominalBufferFrames = opened.format.nominalBufferFrames;
  const bool exact =
      opened.ok && opened.format.sampleRate == config.requestedSampleRate &&
      actualMaximumFrames != 0 && actualMaximumFrames <= config.maximumFrames &&
      nominalBufferFrames != 0 && nominalBufferFrames <= actualMaximumFrames &&
      opened.format.inputChannels == 0 &&
      opened.format.outputChannels == config.outputChannels.size();
  std::unique_lock<std::mutex> gate(impl_->generationGate);
  const bool stillCurrent =
      impl_->latestForOutput(generation) &&
      impl_->cancelledThrough.load(std::memory_order_acquire) < generation;
  if (!exact || !stillCurrent) {
    // The decision not to publish OutputOpen is now linearized. Do not hold
    // the generation gate across provider quiescence.
    gate.unlock();
    const std::string message =
        !stillCurrent ? "Native playback output open was superseded"
        : opened.message.empty()
            ? "The host did not negotiate the exact source graph format"
            : opened.message;
    if (!impl_->stopHost(true, true)) {
      impl_->state = NativePlaybackState::Quarantined;
      // Carry WHY the open failed into the quarantine. Reporting only the
      // quiescence failure loses the host's own sentence — the one that says
      // which negotiated fact the provider refused — and leaves a reader of
      // the log with the consequence and no cause.
      impl_->lastError =
          "The failed output open did not confirm callback quiescence — after "
          + message;
      return failure(NativePlaybackError::TeardownUncertain, generation,
                     impl_->state, impl_->lastError);
    }
    impl_->state = NativePlaybackState::Prepared;
    impl_->lastError = message;
    return failure(!stillCurrent ? NativePlaybackError::Cancelled
                                 : NativePlaybackError::HostFailure,
                   generation, impl_->state, impl_->lastError);
  }
  impl_->state = NativePlaybackState::OutputOpen;
  impl_->lastHost = impl_->host.status();
  impl_->lastTerminal = {};
  impl_->lastError.clear();
  NativePlaybackResult result = impl_->success(generation);
  impl_->openInvocationGeneration = 0;
  return result;
} catch (const std::bad_alloc &) {
  return impl_->recoverOpenException(NativePlaybackError::ResourceExhausted,
                                     generation);
} catch (...) {
  return impl_->recoverOpenException(NativePlaybackError::ProviderFailure,
                                     generation);
}

NativePlaybackResult
NativePlaybackSession::start(uint64_t generation,
                             NativePlaybackDeliveryToken *deliveryToken) {
  return startOutput(generation, true, deliveryToken);
}

NativePlaybackResult NativePlaybackSession::startOutput(
    uint64_t generation, bool startTransport,
    NativePlaybackDeliveryToken *deliveryToken) try {
  impl_->releaseParkedLanes();
  if (deliveryToken != nullptr)
    *deliveryToken = {};
  std::lock_guard<std::mutex> lock(impl_->mutex);
  impl_->refreshTerminalState();
  if (!impl_->currentForCommand(generation)) {
    injectFailure(impl_->testHooks,
                  NativePlaybackAllocationPoint::StartPreconditionResult);
    return failure(NativePlaybackError::InvalidGeneration, generation,
                   impl_->state, "The playback generation is stale");
  }
  if (impl_->state == NativePlaybackState::Terminal) {
    injectFailure(impl_->testHooks,
                  NativePlaybackAllocationPoint::StartPreconditionResult);
    return failure(NativePlaybackError::InvalidState, generation, impl_->state,
                   "Native playback reached a terminal output state");
  }
  // previewClick may already own a running physical host while intentionally
  // leaving song transport stopped. The later user Start is a bounded
  // transport publication, not a second provider start.
  if (startTransport && impl_->state == NativePlaybackState::Running &&
      impl_->prepared->transport.desiredState ==
          NativePlaybackTransportState::Stopped &&
      impl_->prepared->allCursorsAtStart()) {
    if (!impl_->prepared->transport.start())
      return failureWithoutMessage(NativePlaybackError::QueueFull, generation,
                                   impl_->state);
    return impl_->success(generation);
  }
  if (impl_->state != NativePlaybackState::OutputOpen ||
      !impl_->prepared->allCursorsAtStart()) {
    injectFailure(impl_->testHooks,
                  NativePlaybackAllocationPoint::StartPreconditionResult);
    return failure(NativePlaybackError::InvalidState, generation, impl_->state,
                   startTransport
                       ? "Native playback can start only once from frame zero"
                       : "The prepared click bus cannot start output now");
  }

  const AudioHostStatus before = impl_->host.status();
  const AudioHostTerminalCause callbackBefore = impl_->callbackTerminalCause();
  const AudioHostTerminalCause terminalBefore =
      effectiveTerminalCause(before, callbackBefore);
  if (terminalBefore.reason != AudioHostTerminalReason::None ||
      before.state == AudioHostState::DeviceLost ||
      before.state == AudioHostState::Error) {
    impl_->latchTerminal(terminalBefore.reason != AudioHostTerminalReason::None
                             ? terminalBefore
                             : makeAudioHostTerminalCause(
                                   AudioHostTerminalReason::ProviderFailure));
    impl_->state = NativePlaybackState::Terminal;
    return failureWithoutMessage(NativePlaybackError::ProviderFailure,
                                 generation, impl_->state);
  }
  if (before.state != AudioHostState::Open) {
    injectFailure(impl_->testHooks,
                  NativePlaybackAllocationPoint::StartPreconditionResult);
    return failureWithoutMessage(NativePlaybackError::HostFailure, generation,
                                 impl_->state);
  }

  // The provider may invoke the render callback before start() returns. Keep
  // the public state at OutputOpen until generation, cancellation, callback
  // and host health have all been revalidated after that call.
  if (startTransport && !impl_->prepared->transport.start()) {
    return failureWithoutMessage(NativePlaybackError::QueueFull, generation,
                                 impl_->state);
  }
  if (!impl_->armDelivery(NativePlaybackDeliveryCommand::Start, generation,
                          deliveryToken)) {
    return failureWithoutMessage(NativePlaybackError::ResourceExhausted,
                                 generation, impl_->state);
  }
  impl_->startInvocationGeneration = generation;
  impl_->startMutationGeneration = generation;
  const AudioHostResult started = impl_->host.start();
  const AudioHostStatus after = impl_->host.status();
  const AudioHostTerminalCause callbackAfter = impl_->callbackTerminalCause();
  const AudioHostTerminalCause terminalAfter =
      effectiveTerminalCause(after, callbackAfter);
  std::unique_lock<std::mutex> gate(impl_->generationGate);
  const bool stillLatest = impl_->latestForOutput(generation);
  const bool notCancelled =
      impl_->cancelledThrough.load(std::memory_order_acquire) < generation;
  const bool callbackHealthy =
      callbackAfter.reason == AudioHostTerminalReason::None;
  const bool hostHealthy =
      started.ok && after.state == AudioHostState::Running &&
      after.terminalReason == AudioHostTerminalReason::None;
  if (!stillLatest || !notCancelled || !callbackHealthy || !hostHealthy) {
    const NativePlaybackError error =
        !stillLatest || !notCancelled
            ? NativePlaybackError::Cancelled
            : (!started.ok ? NativePlaybackError::HostFailure
                           : NativePlaybackError::ProviderFailure);
    if (terminalAfter.reason != AudioHostTerminalReason::None)
      impl_->latchTerminal(terminalAfter);
    // No Running state was published. Claims remain immediate while a slow
    // provider stop establishes callback quiescence.
    gate.unlock();
    if (!impl_->stopHost(false, true)) {
      impl_->state = NativePlaybackState::Quarantined;
      return failureWithoutMessage(NativePlaybackError::TeardownUncertain,
                                   generation, impl_->state);
    }
    // stopHost performs the final post-quiescence host+graph merge. A route,
    // provider or graph terminal can arrive during stop itself, after the
    // pre-stop snapshot above, so publication must use that merged latch.
    impl_->state = impl_->lastTerminal.reason != AudioHostTerminalReason::None
                       ? NativePlaybackState::Terminal
                       : NativePlaybackState::Stopped;
    impl_->lastError.clear();
    return failureWithoutMessage(error, generation, impl_->state);
  }
  // Running is provisional and still hidden by the session mutex. A callback
  // may begin as host.start returns, so provide a deterministic test edge and
  // then revalidate every publication guard once more before returning ok.
  impl_->state = NativePlaybackState::Running;
  gate.unlock();
  if (impl_->prepared != nullptr)
    impl_->prepared->observe(
        NativePlaybackLifecycleEvent::HostStartProvisionalRunning);
  const AudioHostStatus finalHost = impl_->host.status();
  const AudioHostTerminalCause finalCallback = impl_->callbackTerminalCause();
  const AudioHostTerminalCause finalTerminal =
      effectiveTerminalCause(finalHost, finalCallback);
  gate.lock();
  const bool finallyLatest = impl_->latestForOutput(generation);
  const bool finallyNotCancelled =
      impl_->cancelledThrough.load(std::memory_order_acquire) < generation;
  const bool finallyHealthy =
      finalTerminal.reason == AudioHostTerminalReason::None &&
      finalHost.state == AudioHostState::Running;
  if (!finallyLatest || !finallyNotCancelled || !finallyHealthy) {
    if (finalTerminal.reason != AudioHostTerminalReason::None)
      impl_->latchTerminal(finalTerminal);
    gate.unlock();
    if (!impl_->stopHost(false, true)) {
      impl_->state = NativePlaybackState::Quarantined;
      return failureWithoutMessage(NativePlaybackError::TeardownUncertain,
                                   generation, impl_->state);
    }
    impl_->state = impl_->lastTerminal.reason != AudioHostTerminalReason::None
                       ? NativePlaybackState::Terminal
                       : NativePlaybackState::Stopped;
    return failureWithoutMessage(!finallyLatest || !finallyNotCancelled
                                     ? NativePlaybackError::Cancelled
                                     : NativePlaybackError::ProviderFailure,
                                 generation, impl_->state);
  }
  impl_->lastHost = finalHost;
  impl_->lastError.clear();
  NativePlaybackResult result{true,
                              NativePlaybackError::None,
                              generation,
                              impl_->state,
                              finalHost.format,
                              finalHost.latency,
                              {}};
  impl_->startInvocationGeneration = 0;
  return result;
} catch (const std::bad_alloc &) {
  return impl_->recoverStartException(NativePlaybackError::ResourceExhausted,
                                      generation);
} catch (...) {
  return impl_->recoverStartException(NativePlaybackError::ProviderFailure,
                                      generation);
}

bool NativePlaybackSession::acknowledgeDelivery(
    NativePlaybackDeliveryToken token) noexcept {
  impl_->releaseParkedLanes();
  if (!token.valid())
    return false;
  try {
    std::lock_guard<std::mutex> lock(impl_->mutex);
    NativePlaybackDeliveryToken *pending = nullptr;
    if (token.command == NativePlaybackDeliveryCommand::OpenOutput)
      pending = &impl_->pendingOpenDelivery;
    if (token.command == NativePlaybackDeliveryCommand::Start)
      pending = &impl_->pendingStartDelivery;
    if (pending == nullptr || !impl_->sameDeliveryToken(*pending, token))
      return false;
    *pending = {};
    return true;
  } catch (...) {
    return false;
  }
}

NativePlaybackCleanupResult NativePlaybackSession::abortDelivery(
    NativePlaybackDeliveryToken token) noexcept {
  impl_->releaseParkedLanes();
  NativePlaybackCleanupResult uncertain{
      NativePlaybackCleanupSafety::Uncertain,
      NativePlaybackError::TeardownUncertain,
      token.generation,
      NativePlaybackState::Quarantined,
      0,
      AudioHostTerminalReason::ProviderFailure,
      true};
  if (!token.valid()) {
    uncertain.safety = NativePlaybackCleanupSafety::NotOwned;
    uncertain.error = NativePlaybackError::None;
    uncertain.state = NativePlaybackState::Unloaded;
    uncertain.terminalReason = AudioHostTerminalReason::None;
    return uncertain;
  }
  try {
    {
      std::lock_guard<std::mutex> lock(impl_->mutex);
      NativePlaybackDeliveryToken *pending = nullptr;
      if (token.command == NativePlaybackDeliveryCommand::OpenOutput)
        pending = &impl_->pendingOpenDelivery;
      if (token.command == NativePlaybackDeliveryCommand::Start)
        pending = &impl_->pendingStartDelivery;
      if (pending == nullptr || !impl_->sameDeliveryToken(*pending, token))
        return impl_->cleanupSnapshot(NativePlaybackCleanupSafety::NotOwned,
                                      NativePlaybackError::None,
                                      token.generation);
      // Consume the exact one-shot capability before releasing the mutex.
      // A duplicate abort and an acknowledgement racing behind it are no-ops.
      *pending = {};
    }
    (void)requestCancellation(token.generation);
    return unloadWithCleanup(token.generation).cleanup;
  } catch (...) {
    try {
      std::lock_guard<std::mutex> lock(impl_->mutex);
      return impl_->cleanupSnapshot(NativePlaybackCleanupSafety::Uncertain,
                                    NativePlaybackError::TeardownUncertain,
                                    token.generation);
    } catch (...) {
      return uncertain;
    }
  }
}

NativePlaybackCleanupResult
NativePlaybackSession::abortPrepareDelivery(uint64_t generation) noexcept {
  impl_->releaseParkedLanes();
  NativePlaybackCleanupResult uncertain{
      NativePlaybackCleanupSafety::Uncertain,
      NativePlaybackError::TeardownUncertain,
      generation,
      NativePlaybackState::Quarantined,
      0,
      AudioHostTerminalReason::ProviderFailure,
      true};
  if (generation == 0) {
    uncertain.safety = NativePlaybackCleanupSafety::NotOwned;
    uncertain.error = NativePlaybackError::None;
    uncertain.state = NativePlaybackState::Unloaded;
    uncertain.terminalReason = AudioHostTerminalReason::None;
    return uncertain;
  }
  try {
    {
      std::lock_guard<std::mutex> lock(impl_->mutex);
      if (const auto *receipt = impl_->findUnloadReceipt(generation);
          receipt != nullptr && receipt->ready &&
          impl_->cleanupReceiptStillCurrent(receipt->cleanup))
        return receipt->cleanup;
      if (generation == impl_->lastUnloadedGeneration) {
        return impl_->acquireCleanupLease(generation);
      }
      const bool owned =
          (generation == impl_->generation && impl_->prepared != nullptr) ||
          generation == impl_->failedPrepareCleanupGeneration ||
          generation == impl_->pendingClaimGeneration ||
          generation == impl_->retiringPrepareGeneration;
      if (!owned)
        return impl_->cleanupSnapshot(NativePlaybackCleanupSafety::NotOwned,
                                      NativePlaybackError::None, generation);
    }
    (void)requestCancellation(generation);
    return unloadWithCleanup(generation).cleanup;
  } catch (...) {
    try {
      std::lock_guard<std::mutex> lock(impl_->mutex);
      return impl_->cleanupSnapshot(NativePlaybackCleanupSafety::Uncertain,
                                    NativePlaybackError::TeardownUncertain,
                                    generation);
    } catch (...) {
      return uncertain;
    }
  }
}

NativePlaybackCleanupResult
NativePlaybackSession::cleanupProof(uint64_t generation) const noexcept {
  NativePlaybackCleanupResult uncertain{
      NativePlaybackCleanupSafety::Uncertain,
      NativePlaybackError::TeardownUncertain,
      generation,
      NativePlaybackState::Quarantined,
      0,
      AudioHostTerminalReason::ProviderFailure,
      true};
  if (generation == 0) {
    uncertain.safety = NativePlaybackCleanupSafety::NotOwned;
    uncertain.error = NativePlaybackError::None;
    uncertain.state = NativePlaybackState::Unloaded;
    uncertain.terminalReason = AudioHostTerminalReason::None;
    return uncertain;
  }
  try {
    std::lock_guard<std::mutex> lock(impl_->mutex);
    if (generation == impl_->unloadReceiptJournalExhaustedGeneration)
      return impl_->cleanupSnapshot(NativePlaybackCleanupSafety::Uncertain,
                                    NativePlaybackError::ResourceExhausted,
                                    generation);
    if (const auto *receipt = impl_->findUnloadReceipt(generation);
        receipt != nullptr && receipt->ready) {
      if (receipt->cleanup.generation == generation &&
          impl_->cleanupReceiptStillCurrent(receipt->cleanup))
        return receipt->cleanup;
      if (receipt->cleanup.generation != generation)
        return impl_->cleanupSnapshot(NativePlaybackCleanupSafety::NotOwned,
                                      NativePlaybackError::None, generation);
    }
    if (playbackOwnershipSnapshot().state ==
        NativePlaybackCoordinatorState::Poisoned) {
      return impl_->cleanupSnapshot(NativePlaybackCleanupSafety::Uncertain,
                                    NativePlaybackError::TeardownUncertain,
                                    generation);
    }
    if (generation == impl_->retiringPrepareGeneration ||
        generation == impl_->retiringSwapGeneration) {
      return impl_->cleanupSnapshot(NativePlaybackCleanupSafety::Uncertain,
                                    NativePlaybackError::TeardownUncertain,
                                    generation);
    }
    if (generation == impl_->lastUnloadedGeneration) {
      return impl_->acquireCleanupLease(generation);
    }
    const bool stillOwned =
        generation == impl_->failedPrepareCleanupGeneration ||
        generation == impl_->pendingClaimGeneration ||
        generation == impl_->prepareMutationGeneration ||
        generation == impl_->swapPrepareGeneration ||
        generation == impl_->generation ||
        impl_->hostMutationActiveFor(generation);
    return impl_->cleanupSnapshot(
        stillOwned ? NativePlaybackCleanupSafety::Uncertain
                   : NativePlaybackCleanupSafety::NotOwned,
        stillOwned ? NativePlaybackError::TeardownUncertain
                   : NativePlaybackError::None,
        generation);
  } catch (...) {
    return uncertain;
  }
}

NativePlaybackResult
NativePlaybackSession::suspendOutput(uint64_t generation) {
  impl_->releaseParkedLanes();
  std::lock_guard<std::mutex> lock(impl_->mutex);
  impl_->refreshTerminalState();
  if (!impl_->currentForCommand(generation))
    return failure(NativePlaybackError::InvalidGeneration, generation,
                   impl_->state, "The playback generation is stale");
  if (impl_->state != NativePlaybackState::Running)
    return failure(NativePlaybackError::InvalidState, generation, impl_->state,
                   "Native playback has no running stream to hold");
  const NativePlaybackTransportState desired =
      impl_->prepared->transport.desiredState;
  if (desired == NativePlaybackTransportState::Playing ||
      desired == NativePlaybackTransportState::PreRoll)
    return failure(NativePlaybackError::InvalidState, generation, impl_->state,
                   "Native playback is still advancing — pause it before "
                   "holding its stream");
  // The control domain may have ASKED for the pause while the callback has
  // not yet rendered it. Holding the stream in that window pauses it with
  // the rendered transport still Playing, and every clock downstream keeps
  // projecting forward. The callback's own last publication is the truth.
  {
    NativePlaybackPositionNow rendered;
    int64_t publishedAt = 0;
    // During an armed swap the sink still says the outgoing generation's
    // number, and its transport is the one that must have rendered the pause.
    const uint64_t outgoing =
        impl_->swapFromGeneration.load(std::memory_order_acquire);
    if (impl_->position->snapshot(&rendered, &publishedAt) &&
        (rendered.generation == generation ||
         (outgoing != 0 && rendered.generation == outgoing)) &&
        (rendered.transportState == NativePlaybackTransportState::Playing ||
         rendered.transportState == NativePlaybackTransportState::PreRoll))
      return failure(NativePlaybackError::InvalidState, generation,
                     impl_->state,
                     "Native playback has not rendered its pause yet — hold "
                     "the stream after the next block");
  }
  const AudioHostStatus before = impl_->host.status();
  if (before.state == AudioHostState::Suspended)
    return impl_->success(generation);
  const AudioHostResult held = impl_->host.suspend();
  if (!held.ok) {
    // A host that cannot hold (or would not, from this state) leaves the
    // stream exactly as it was: say so and keep rendering. A host that
    // fail-stopped on the way is read the way a failed start is read.
    const AudioHostStatus after = impl_->host.status();
    if (after.state == AudioHostState::Running)
      return failure(NativePlaybackError::InvalidState, generation,
                     impl_->state,
                     held.message.empty()
                         ? "The native output host could not hold its stream"
                         : held.message);
    impl_->latchTerminal(effectiveTerminalCause(
        after, impl_->callbackTerminalCause()));
    if (impl_->lastTerminal.reason == AudioHostTerminalReason::None)
      impl_->latchTerminal(
          makeAudioHostTerminalCause(AudioHostTerminalReason::ProviderFailure));
    impl_->state = NativePlaybackState::Terminal;
    impl_->lastError = held.message;
    return failure(NativePlaybackError::HostFailure, generation, impl_->state,
                   held.message);
  }
  return impl_->success(generation);
}

NativePlaybackResult
NativePlaybackSession::resumeOutput(uint64_t generation) {
  impl_->releaseParkedLanes();
  std::lock_guard<std::mutex> lock(impl_->mutex);
  impl_->refreshTerminalState();
  if (!impl_->currentForCommand(generation))
    return failure(NativePlaybackError::InvalidGeneration, generation,
                   impl_->state, "The playback generation is stale");
  if (impl_->state != NativePlaybackState::Running)
    return failure(NativePlaybackError::InvalidState, generation, impl_->state,
                   "Native playback has no held stream to let go");
  const AudioHostStatus before = impl_->host.status();
  if (before.state != AudioHostState::Suspended)
    return impl_->success(generation);
  const AudioHostResult released = impl_->host.resume();
  if (!released.ok) {
    const AudioHostStatus after = impl_->host.status();
    if (after.state == AudioHostState::Suspended)
      return failure(NativePlaybackError::InvalidState, generation,
                     impl_->state,
                     released.message.empty()
                         ? "The native output host could not release its stream"
                         : released.message);
    impl_->latchTerminal(effectiveTerminalCause(
        after, impl_->callbackTerminalCause()));
    if (impl_->lastTerminal.reason == AudioHostTerminalReason::None)
      impl_->latchTerminal(
          makeAudioHostTerminalCause(AudioHostTerminalReason::ProviderFailure));
    impl_->state = NativePlaybackState::Terminal;
    impl_->lastError = released.message;
    return failure(NativePlaybackError::HostFailure, generation, impl_->state,
                   released.message);
  }
  return impl_->success(generation);
}

NativePlaybackResult NativePlaybackSession::pause(uint64_t generation) {
  impl_->releaseParkedLanes();
  std::lock_guard<std::mutex> lock(impl_->mutex);
  impl_->refreshTerminalState();
  if (!impl_->currentForCommand(generation))
    return failure(NativePlaybackError::InvalidGeneration, generation,
                   impl_->state, "The playback generation is stale");
  if (impl_->state != NativePlaybackState::Running ||
      (impl_->prepared->transport.desiredState !=
           NativePlaybackTransportState::Playing &&
       impl_->prepared->transport.desiredState !=
           NativePlaybackTransportState::PreRoll)) {
    return failure(NativePlaybackError::InvalidState, generation, impl_->state,
                   "Native playback is not currently advancing");
  }
  if (!impl_->prepared->transport.pause())
    return failure(NativePlaybackError::QueueFull, generation, impl_->state,
                   "The bounded transport command mailbox is full");
  return impl_->success(generation);
}

NativePlaybackResult NativePlaybackSession::resume(uint64_t generation) {
  impl_->releaseParkedLanes();
  std::lock_guard<std::mutex> lock(impl_->mutex);
  impl_->refreshTerminalState();
  if (!impl_->currentForCommand(generation))
    return failure(NativePlaybackError::InvalidGeneration, generation,
                   impl_->state, "The playback generation is stale");
  if (impl_->state != NativePlaybackState::Running ||
      impl_->prepared->transport.desiredState !=
          NativePlaybackTransportState::Paused) {
    return failure(NativePlaybackError::InvalidState, generation, impl_->state,
                   "Native playback is not paused");
  }
  if (!impl_->prepared->transport.resume())
    return failure(NativePlaybackError::QueueFull, generation, impl_->state,
                   "The bounded transport command mailbox is full");
  return impl_->success(generation);
}

NativePlaybackResult NativePlaybackSession::seek(uint64_t generation,
                                                 int64_t projectFrame) {
  impl_->releaseParkedLanes();
  std::lock_guard<std::mutex> lock(impl_->mutex);
  impl_->refreshTerminalState();
  if (!impl_->currentForCommand(generation))
    return failure(NativePlaybackError::InvalidGeneration, generation,
                   impl_->state, "The playback generation is stale");
  if (impl_->state != NativePlaybackState::Running || projectFrame < 0 ||
      static_cast<uint64_t>(projectFrame) > impl_->prepared->durationFrames) {
    return failure(NativePlaybackError::InvalidConfiguration, generation,
                   impl_->state, "The absolute playback seek is invalid");
  }
  if (!impl_->prepared->transport.hasCommandCapacity())
    return failure(NativePlaybackError::QueueFull, generation, impl_->state,
                   "The bounded transport command mailbox is full");
  const int64_t resolvedProjectFrame =
      impl_->prepared->transport.resolvedSeekFrame(projectFrame);
  if (!impl_->prepared->primeTimePitchSeek(resolvedProjectFrame))
    return failure(NativePlaybackError::GraphFailure, generation, impl_->state,
                   "The playback seek anchor could not be prepared off RT");
  if (!impl_->prepared->transport.seek(resolvedProjectFrame))
    return failure(NativePlaybackError::QueueFull, generation, impl_->state,
                   "The bounded transport command mailbox is full");
  return impl_->success(generation);
}

NativePlaybackResult NativePlaybackSession::setLoop(uint64_t generation,
                                                    int64_t startFrame,
                                                    int64_t endFrame) {
  impl_->releaseParkedLanes();
  std::lock_guard<std::mutex> lock(impl_->mutex);
  impl_->refreshTerminalState();
  if (!impl_->currentForCommand(generation))
    return failure(NativePlaybackError::InvalidGeneration, generation,
                   impl_->state, "The playback generation is stale");
  if (impl_->state != NativePlaybackState::Running || startFrame < 0 ||
      endFrame <= startFrame ||
      static_cast<uint64_t>(endFrame) > impl_->prepared->durationFrames) {
    return failure(NativePlaybackError::InvalidConfiguration, generation,
                   impl_->state, "The playback loop region is invalid");
  }
  if (!impl_->prepared->transport.hasCommandCapacity())
    return failure(NativePlaybackError::QueueFull, generation, impl_->state,
                   "The bounded transport command mailbox is full");
  const std::optional<NativePlaybackInitialLoop> loop =
      NativePlaybackInitialLoop{startFrame, endFrame};
  const SignalsmithTimePitchLoopPrepareResult loopPrepared =
      impl_->prepared->configureTimePitchLoop(loop);
  if (loopPrepared.code == SignalsmithTimePitchLoopPrepareCode::TooShort) {
    return failure(
        NativePlaybackError::InvalidConfiguration, generation, impl_->state,
        "The playback loop is too short for deadline-safe time/pitch priming");
  }
  if (!loopPrepared.ok())
    return failure(NativePlaybackError::GraphFailure, generation, impl_->state,
                   "The playback loop anchor could not be prepared off RT");
  if (!impl_->prepared->transport.setLoop(startFrame, endFrame,
                                          loopPrepared.plan))
    return failure(NativePlaybackError::QueueFull, generation, impl_->state,
                   "The bounded transport command mailbox is full");
  return impl_->success(generation);
}

NativePlaybackResult NativePlaybackSession::clearLoop(uint64_t generation) {
  impl_->releaseParkedLanes();
  std::lock_guard<std::mutex> lock(impl_->mutex);
  impl_->refreshTerminalState();
  if (!impl_->currentForCommand(generation))
    return failure(NativePlaybackError::InvalidGeneration, generation,
                   impl_->state, "The playback generation is stale");
  if (impl_->state != NativePlaybackState::Running)
    return failure(NativePlaybackError::InvalidState, generation, impl_->state,
                   "Native playback output is not running");
  if (!impl_->prepared->transport.desiredLoopEnabled)
    return impl_->success(generation);
  if (!impl_->prepared->transport.hasCommandCapacity())
    return failure(NativePlaybackError::QueueFull, generation, impl_->state,
                   "The bounded transport command mailbox is full");
  if (!impl_->prepared->configureTimePitchLoop(std::nullopt).ok())
    return failure(NativePlaybackError::GraphFailure, generation, impl_->state,
                   "The prepared playback loop anchor could not be cleared");
  if (!impl_->prepared->transport.clearLoop())
    return failure(NativePlaybackError::QueueFull, generation, impl_->state,
                   "The bounded transport command mailbox is full");
  return impl_->success(generation);
}

NativePlaybackResult
NativePlaybackSession::reanchorTransport(uint64_t generation) {
  impl_->releaseParkedLanes();
  std::lock_guard<std::mutex> lock(impl_->mutex);
  impl_->refreshTerminalState();
  if (!impl_->currentForCommand(generation))
    return failure(NativePlaybackError::InvalidGeneration, generation,
                   impl_->state, "The playback generation is stale");
  if (impl_->state != NativePlaybackState::Running)
    return failure(NativePlaybackError::InvalidState, generation, impl_->state,
                   "Native playback output is not running");
  if (!impl_->prepared->transport.hasCommandCapacity())
    return failure(NativePlaybackError::QueueFull, generation, impl_->state,
                   "The bounded transport command mailbox is full");
  PreparedPlaybackTransport::Telemetry anchor{};
  if (!impl_->prepared->transport.snapshotTelemetry(&anchor))
    anchor = impl_->prepared->transport.initialTelemetrySnapshot();
  impl_->prepared->transport.overlayQueuedPositionIntent(&anchor);
  SignalsmithTimePitchReanchorPlan timePitchPlan{};
  if (impl_->prepared->hasTimePitch) {
    timePitchPlan = impl_->prepared->primeTimePitchReanchor(
        anchor.projectFrame, anchor.projectFractionQ32);
    if (!timePitchPlan.valid())
      return failure(NativePlaybackError::GraphFailure, generation, impl_->state,
                     "The playback clock reanchor could not be prepared off RT");
  }
  if (!impl_->prepared->transport.reanchor(
          anchor.projectFrame, anchor.projectFractionQ32, timePitchPlan))
    return failure(NativePlaybackError::QueueFull, generation, impl_->state,
                   "The bounded transport command mailbox is full");
  return impl_->success(generation);
}

NativePlaybackResult NativePlaybackSession::stop(uint64_t generation) {
  impl_->releaseParkedLanes();
  (void)requestCancellation(generation);
  std::lock_guard<std::mutex> lock(impl_->mutex);
  impl_->refreshTerminalState();
  if (generation == 0 || generation != impl_->generation ||
      impl_->prepared == nullptr) {
    if (generation != 0 && generation == impl_->generation &&
        impl_->state == NativePlaybackState::Preparing)
      return impl_->success(generation);
    if (generation != 0 && generation == impl_->lastCancelledGeneration)
      return impl_->success(generation);
    // A swap candidate has nothing to stop; the song it will replace is the
    // one to stop, under its own generation.
    if (generation != 0 && generation == impl_->swapPrepareGeneration)
      return impl_->success(generation);
    return failure(NativePlaybackError::InvalidGeneration, generation,
                   impl_->state, "The playback generation is stale");
  }
  if (impl_->state != NativePlaybackState::Running &&
      impl_->state != NativePlaybackState::OutputOpen &&
      impl_->state != NativePlaybackState::Prepared &&
      impl_->state != NativePlaybackState::Terminal &&
      impl_->state != NativePlaybackState::Stopped) {
    return failure(NativePlaybackError::InvalidState, generation, impl_->state,
                   "Native playback is not stoppable in its current state");
  }
  if (impl_->state == NativePlaybackState::Running)
    (void)impl_->prepared->transport.stop();
  if (!impl_->stopHost()) {
    // A swap retirement that failed on the way has already quarantined its
    // graph and said why; that verdict is the one worth keeping.
    if (!(impl_->state == NativePlaybackState::Quarantined &&
          !impl_->lastError.empty()))
      impl_->lastError = "The native output host did not confirm quiescence";
    impl_->state = NativePlaybackState::Quarantined;
    return failure(NativePlaybackError::TeardownUncertain, generation,
                   impl_->state, impl_->lastError);
  }
  impl_->state = impl_->lastTerminal.reason != AudioHostTerminalReason::None
                     ? NativePlaybackState::Terminal
                     : NativePlaybackState::Stopped;
  impl_->lastError.clear();
  return impl_->success(generation);
}

NativePlaybackResult
NativePlaybackSession::unload(uint64_t generation,
                              NativePlaybackLaneRetention retention) {
  // Whatever an earlier unload parked is released here regardless: only the
  // lanes of the generation being unloaded now may be offered to the next
  // prepare, and only when this caller asked for that.
  impl_->releaseParkedLanes();
  (void)requestCancellation(generation);
  std::lock_guard<std::mutex> lock(impl_->mutex);
  if (const auto *receipt = impl_->findUnloadReceipt(generation);
      receipt != nullptr && receipt->ready &&
      impl_->cleanupReceiptStillCurrent(receipt->cleanup))
    return Impl::playbackFromReceipt(*receipt);
  impl_->refreshTerminalState();
  if (generation != 0 &&
      (generation == impl_->pendingClaimGeneration ||
       generation == impl_->failedPrepareCleanupGeneration) &&
      generation != impl_->generation) {
    // A newer same-session synchronous claim can be globally visible while
    // the superseded prepare is still decoding or retiring. Exact cleanup of
    // the newer claim is recorded now, but the shared fail-stop reservation
    // remains owned until the old graph has physically retired.
    if (impl_->generation != 0 || impl_->retiringPrepareGeneration != 0) {
      const uint64_t retiredGeneration = impl_->generation != 0
                                             ? impl_->generation
                                             : impl_->retiringPrepareGeneration;
      if (!impl_->reserveDeferredUnloadReceipts(retiredGeneration, generation))
        return failureWithoutMessage(NativePlaybackError::ResourceExhausted,
                                     generation, impl_->state);
      impl_->pendingClaimUnloadGeneration = generation;
      impl_->lastCancelledGeneration = generation;
      const NativePlaybackResult accepted = impl_->success(generation);
      impl_->publishUnloadReceipt(
          generation, accepted,
          impl_->cleanupSnapshot(NativePlaybackCleanupSafety::Uncertain,
                                 NativePlaybackError::TeardownUncertain,
                                 generation));
      return accepted;
    }
    if (impl_->pendingClaimGeneration == generation)
      impl_->pendingClaimGeneration = 0;
    if (impl_->failedPrepareCleanupGeneration == generation)
      impl_->failedPrepareCleanupGeneration = 0;
    impl_->pendingClaimUnloadGeneration = 0;
    impl_->claimedHandoffLeaseGeneration = 0;
    impl_->claimedHandoffLease = 0;
    impl_->lastUnloadedGeneration = generation;
    impl_->releaseQuarantineReservation();
    impl_->state = NativePlaybackState::Unloaded;
    impl_->lastError.clear();
    return impl_->success(generation);
  }
  if (generation != 0 && generation == impl_->retiringPrepareGeneration) {
    // The graph is deliberately outside the mutex but remains owned by this
    // session and its process reservation. Record the exact unload intent;
    // retirement completion will release the handshake atomically.
    impl_->retiringUnloadRequested = true;
    impl_->retiringOldUnloadCommandAccepted = true;
    impl_->lastCancelledGeneration = generation;
    return impl_->success(generation);
  }
  if (generation != 0 && generation == impl_->generation &&
      impl_->prepared == nullptr &&
      impl_->state == NativePlaybackState::Preparing) {
    // Cancellation may arrive before the final publication check transfers
    // the soon-to-be-stale graph into retirement ownership.
    impl_->prepareUnloadRequestedGeneration = generation;
    impl_->lastCancelledGeneration = generation;
    return impl_->success(generation);
  }
  if (generation != 0 && impl_->prepared == nullptr &&
      impl_->state == NativePlaybackState::Unloaded &&
      generation == impl_->failedPrepareCleanupGeneration) {
    impl_->failedPrepareCleanupGeneration = 0;
    if (impl_->prepareUnloadRequestedGeneration == generation)
      impl_->prepareUnloadRequestedGeneration = 0;
    impl_->lastUnloadedGeneration = generation;
    impl_->pendingClaimUnloadGeneration = 0;
    impl_->claimedHandoffLeaseGeneration = 0;
    impl_->claimedHandoffLease = 0;
    impl_->releaseQuarantineReservation();
    impl_->lastError.clear();
    return impl_->success(generation);
  }
  if (generation != 0 && generation == impl_->lastUnloadedGeneration)
    return impl_->success(generation);
  // A swap in flight. Its candidate is cancelled by name (nothing of it
  // exists yet); a generation the swap replaced retires by itself, and this
  // is an acknowledgement, not a second teardown.
  if (generation != 0 && generation == impl_->swapPrepareGeneration) {
    impl_->cancelledSwapCandidate.store(generation, std::memory_order_release);
    impl_->swapPrepareUnloadRequested = true;
    impl_->lastCancelledGeneration = generation;
    return impl_->success(generation);
  }
  if (generation != 0 && (generation == impl_->retiringSwapGeneration ||
                          generation == impl_->lastSwappedOutGeneration))
    return impl_->success(generation);
  if (generation == 0 || generation != impl_->generation ||
      impl_->prepared == nullptr) {
    if (generation != 0 && generation == impl_->lastCancelledGeneration)
      return impl_->success(generation);
    return failure(NativePlaybackError::InvalidGeneration, generation,
                   impl_->state, "The playback generation is stale");
  }
  if (!impl_->stopHost()) {
    // A swap retirement that failed on the way has already quarantined its
    // graph and said why; that verdict is the one worth keeping.
    if (!(impl_->state == NativePlaybackState::Quarantined &&
          !impl_->lastError.empty()))
      impl_->lastError = "The native output host did not confirm quiescence";
    impl_->state = NativePlaybackState::Quarantined;
    return failure(NativePlaybackError::TeardownUncertain, generation,
                   impl_->state, impl_->lastError);
  }
  // Copy the decoded owners out before shutdown() drops the lane vector. This
  // is only shared_ptr traffic — nothing is decoded, copied or moved — and it
  // is committed below only once the graph has actually retired. A lane with
  // no bridge identity can never be recognized again, so an unidentifiable
  // set parks nothing rather than parking something unusable.
  std::vector<Impl::ParkedLane> parking;
  if (retention == NativePlaybackLaneRetention::Park) {
    parking.reserve(impl_->prepared->lanes.size());
    for (const PreparedPlaybackGraph::Lane &lane : impl_->prepared->lanes) {
      if (lane.owner == nullptr || !lane.identity.adoptable()) {
        parking.clear();
        break;
      }
      parking.push_back(
          {lane.id, lane.identity, lane.owner, lane.peaks, lane.peaksValid});
    }
  }
  if (!impl_->prepared->shutdown()) {
    impl_->state = NativePlaybackState::Quarantined;
    impl_->lastError = "The native playback graph did not retire cleanly";
    NativePlaybackResult failed =
        failure(NativePlaybackError::GraphFailure, generation, impl_->state,
                impl_->lastError);
    if (impl_->pendingClaimUnloadGeneration != 0) {
      const uint64_t cleanupGeneration =
          impl_->pendingClaimUnloadGeneration.load(std::memory_order_acquire);
      const auto cleanup = impl_->cleanupSnapshot(
          NativePlaybackCleanupSafety::Uncertain,
          NativePlaybackError::TeardownUncertain, cleanupGeneration);
      impl_->publishUnloadReceipt(cleanupGeneration, failed, cleanup);
      impl_->publishUnloadReceipt(generation, failed, cleanup);
    }
    return failed;
  }
  impl_->prepared.reset();
  impl_->router->current.store(nullptr, std::memory_order_release);
  impl_->position->clear();
  // The graph is gone and its arena is released; what remains held is exactly
  // the decoded PCM, and status/cleanup report it as retained until the next
  // command takes it back.
  if (!parking.empty())
    (void)impl_->parkLanes(std::move(parking));
  impl_->lastUnloadedGeneration = generation;
  if (impl_->prepareUnloadRequestedGeneration == generation)
    impl_->prepareUnloadRequestedGeneration = 0;
  impl_->generation = 0;
  if (impl_->pendingClaimGeneration == generation)
    impl_->pendingClaimGeneration = 0;
  if (impl_->pendingClaimUnloadGeneration == generation)
    impl_->pendingClaimUnloadGeneration = 0;
  if (impl_->claimedHandoffLeaseGeneration == generation) {
    impl_->claimedHandoffLeaseGeneration = 0;
    impl_->claimedHandoffLease = 0;
  }
  impl_->activeGeneration.store(0, std::memory_order_release);
  impl_->state = NativePlaybackState::Unloaded;
  impl_->preparedConfig = {};
  impl_->lastError.clear();
  if (impl_->pendingClaimUnloadGeneration != 0) {
    (void)impl_->finalizeDeferredClaimUnloadAfterRetirement(generation, true);
    if (const auto *receipt = impl_->findUnloadReceipt(generation);
        receipt != nullptr && receipt->ready)
      return Impl::playbackFromReceipt(*receipt);
  } else {
    impl_->releaseQuarantineReservation();
  }
  return impl_->success(generation);
}

NativePlaybackUnloadReceipt NativePlaybackSession::unloadWithCleanup(
    uint64_t generation, NativePlaybackLaneRetention retention) noexcept {
  NativePlaybackUnloadReceipt fallback;
  fallback.playback =
      failureWithoutMessage(NativePlaybackError::TeardownUncertain, generation,
                            NativePlaybackState::Quarantined);
  fallback.cleanup = {NativePlaybackCleanupSafety::Uncertain,
                      NativePlaybackError::TeardownUncertain,
                      generation,
                      NativePlaybackState::Quarantined,
                      0,
                      AudioHostTerminalReason::ProviderFailure,
                      true};
  // BEFORE the replay check, because the replay can return without ever
  // reaching unload() — which was the only caller that released a park. Every
  // bridge calls unloadWithCleanup and none calls unload, so without this the
  // releasing path is unreachable from the product and the header's "any
  // other command releases them" is false.
  if (retention == NativePlaybackLaneRetention::Release)
    impl_->releaseParkedLanes();
  try {
    {
      std::lock_guard<std::mutex> lock(impl_->mutex);
      if (const auto *entry = impl_->findUnloadReceipt(generation);
          entry != nullptr && entry->ready &&
          impl_->cleanupReceiptStillCurrent(entry->cleanup))
        return Impl::unloadReceiptFromEntry(*entry);
    }
    NativePlaybackResult playback = unload(generation, retention);
    {
      std::lock_guard<std::mutex> lock(impl_->mutex);
      if (const auto *entry = impl_->findUnloadReceipt(generation);
          entry != nullptr && entry->ready &&
          impl_->cleanupReceiptStillCurrent(entry->cleanup))
        return Impl::unloadReceiptFromEntry(*entry);
    }
    NativePlaybackCleanupResult cleanup = cleanupProof(generation);
    std::lock_guard<std::mutex> lock(impl_->mutex);
    auto *entry = impl_->reserveUnloadReceipt(generation, cleanup.generation);
    if (entry == nullptr) {
      impl_->unloadReceiptJournalExhaustedGeneration = generation;
      cleanup = impl_->cleanupSnapshot(NativePlaybackCleanupSafety::Uncertain,
                                       NativePlaybackError::ResourceExhausted,
                                       generation);
      if (playback.ok) {
        playback.ok = false;
        playback.error = NativePlaybackError::ResourceExhausted;
        playback.message.clear();
      }
      return {std::move(playback), cleanup};
    }
    impl_->publishUnloadReceipt(generation, playback, cleanup);
    return Impl::unloadReceiptFromEntry(*entry);
  } catch (...) {
    return fallback;
  }
}

NativePlaybackResult
NativePlaybackSession::setLaneControl(uint64_t generation,
                                      const std::string &laneId, float gain,
                                      bool muted, bool solo) {
  impl_->releaseParkedLanes();
  std::lock_guard<std::mutex> lock(impl_->mutex);
  impl_->refreshTerminalState();
  if (!impl_->currentForCommand(generation)) {
    return failure(NativePlaybackError::InvalidGeneration, generation,
                   impl_->state, "The playback generation is stale");
  }
  if (impl_->state == NativePlaybackState::Terminal) {
    return failure(NativePlaybackError::InvalidState, generation, impl_->state,
                   "Native playback reached a terminal output state");
  }
  if ((impl_->state != NativePlaybackState::Prepared &&
       impl_->state != NativePlaybackState::OutputOpen &&
       impl_->state != NativePlaybackState::Running) ||
      !finiteGain(gain)) {
    return failure(NativePlaybackError::InvalidConfiguration, generation,
                   impl_->state, "The lane control is invalid");
  }
  auto lane =
      std::find_if(impl_->prepared->lanes.begin(), impl_->prepared->lanes.end(),
                   [&](const PreparedPlaybackGraph::Lane &candidate) {
                     return candidate.id == laneId;
                   });
  if (lane == impl_->prepared->lanes.end()) {
    return failure(NativePlaybackError::InvalidConfiguration, generation,
                   impl_->state, "The playback lane ID is unknown");
  }
  const float previousGain = lane->gain;
  const bool previousMuted = lane->muted;
  const bool previousSolo = lane->solo;
  lane->gain = gain;
  lane->muted = muted;
  lane->solo = solo;
  if (!impl_->prepared->applyLaneGains()) {
    lane->gain = previousGain;
    lane->muted = previousMuted;
    lane->solo = previousSolo;
    return failure(NativePlaybackError::QueueFull, generation, impl_->state,
                   "The bounded playback parameter queue is full");
  }
  return impl_->success(generation);
}

NativePlaybackResult NativePlaybackSession::setMasterGain(uint64_t generation,
                                                          float gain) {
  impl_->releaseParkedLanes();
  std::lock_guard<std::mutex> lock(impl_->mutex);
  impl_->refreshTerminalState();
  if (!impl_->currentForCommand(generation)) {
    return failure(NativePlaybackError::InvalidGeneration, generation,
                   impl_->state, "The playback generation is stale");
  }
  if (impl_->state == NativePlaybackState::Terminal) {
    return failure(NativePlaybackError::InvalidState, generation, impl_->state,
                   "Native playback reached a terminal output state");
  }
  if ((impl_->state != NativePlaybackState::Prepared &&
       impl_->state != NativePlaybackState::OutputOpen &&
       impl_->state != NativePlaybackState::Running) ||
      !finiteGain(gain)) {
    return failure(NativePlaybackError::InvalidConfiguration, generation,
                   impl_->state, "The master gain is invalid");
  }
  if (!impl_->prepared->enqueueMaster(gain)) {
    return failure(NativePlaybackError::QueueFull, generation, impl_->state,
                   "The bounded playback parameter queue is full");
  }
  impl_->prepared->masterGain = gain;
  return impl_->success(generation);
}

NativePlaybackResult
NativePlaybackSession::setTrainingEnabled(uint64_t generation, bool enabled) {
  impl_->releaseParkedLanes();
  std::lock_guard<std::mutex> lock(impl_->mutex);
  impl_->refreshTerminalState();
  if (!impl_->currentForCommand(generation)) {
    return failure(NativePlaybackError::InvalidGeneration, generation,
                   impl_->state, "The playback generation is stale");
  }
  if (impl_->state == NativePlaybackState::Terminal) {
    return failure(NativePlaybackError::InvalidState, generation, impl_->state,
                   "Native playback reached a terminal output state");
  }
  if ((impl_->state != NativePlaybackState::Prepared &&
       impl_->state != NativePlaybackState::OutputOpen &&
       impl_->state != NativePlaybackState::Running) ||
      impl_->prepared->training == std::nullopt) {
    return failure(NativePlaybackError::InvalidConfiguration, generation,
                   impl_->state,
                   "The prepared playback graph has no training schedule");
  }
  if (impl_->prepared->trainingEnabled == enabled)
    return impl_->success(generation);
  if (!impl_->prepared->enqueueTrainingEnabled(enabled)) {
    return failure(NativePlaybackError::QueueFull, generation, impl_->state,
                   "The bounded playback parameter queue is full");
  }
  return impl_->success(generation);
}

NativePlaybackResult NativePlaybackSession::previewClick(
    uint64_t generation, NativePlaybackPreviewClickSound sound) {
  impl_->releaseParkedLanes();
  bool needsOpen = false;
  {
    std::lock_guard<std::mutex> lock(impl_->mutex);
    impl_->refreshTerminalState();
    if (!impl_->currentForCommand(generation)) {
      return failure(NativePlaybackError::InvalidGeneration, generation,
                     impl_->state, "The playback generation is stale");
    }
    if (sound != NativePlaybackPreviewClickSound::Ordinary &&
        sound != NativePlaybackPreviewClickSound::Accent) {
      return failure(NativePlaybackError::InvalidConfiguration, generation,
                     impl_->state, "The preview-click sound is invalid");
    }
    if (impl_->prepared->cueSource.state == nullptr) {
      return failure(NativePlaybackError::InvalidConfiguration, generation,
                     impl_->state,
                     "The prepared playback graph has no click bus");
    }
    if (impl_->state != NativePlaybackState::Prepared &&
        impl_->state != NativePlaybackState::OutputOpen &&
        impl_->state != NativePlaybackState::Running) {
      return failure(NativePlaybackError::InvalidState, generation,
                     impl_->state,
                     "The prepared click bus cannot own output now");
    }
    needsOpen = impl_->state == NativePlaybackState::Prepared;
  }

  if (needsOpen) {
    const NativePlaybackResult opened = openOutput(generation);
    if (!opened.ok)
      return opened;
  }

  bool needsStart = false;
  {
    std::lock_guard<std::mutex> lock(impl_->mutex);
    impl_->refreshTerminalState();
    if (!impl_->currentForCommand(generation))
      return failure(NativePlaybackError::InvalidGeneration, generation,
                     impl_->state, "The playback generation is stale");
    needsStart = impl_->state == NativePlaybackState::OutputOpen;
    if (!needsStart && impl_->state != NativePlaybackState::Running)
      return failure(NativePlaybackError::InvalidState, generation,
                     impl_->state,
                     "The prepared click bus could not retain output");
  }
  if (needsStart) {
    const NativePlaybackResult started = startOutput(generation, false);
    if (!started.ok)
      return started;
  }

  std::lock_guard<std::mutex> lock(impl_->mutex);
  impl_->refreshTerminalState();
  if (!impl_->currentForCommand(generation))
    return failure(NativePlaybackError::InvalidGeneration, generation,
                   impl_->state, "The playback generation is stale");
  if (impl_->state != NativePlaybackState::Running)
    return failure(NativePlaybackError::InvalidState, generation, impl_->state,
                   "The prepared click bus is no longer running");
  if (!impl_->prepared->enqueuePreviewClick(sound)) {
    return failure(NativePlaybackError::QueueFull, generation, impl_->state,
                   "The bounded preview-click mailbox is full");
  }
  return impl_->success(generation);
}

NativePlaybackStatus NativePlaybackSession::status() const {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  impl_->refreshTerminalState();
  NativePlaybackStatus result;
  result.generation = impl_->generation;
  result.state = impl_->state;
  result.host = impl_->prepared != nullptr && impl_->hostMutationActive()
                    ? impl_->host.status()
                    : impl_->lastHost;
  const AudioHostTerminalCause callback = impl_->callbackTerminalCause();
  AudioHostTerminalCause reported = impl_->lastTerminal;
  reported = firstAudioHostTerminalCause(
      reported, {result.host.terminalReason, result.host.terminalOrdinal});
  reported = firstAudioHostTerminalCause(reported, callback);
  result.terminalReason = reported.reason;
  result.terminalOrdinal = reported.ordinal;
  if (impl_->prepared != nullptr &&
      (result.state == NativePlaybackState::Prepared ||
       result.host.format.sampleRate <= 0.0)) {
    result.host.format.sampleRate = impl_->prepared->sampleRate;
    result.host.format.maximumFrames = impl_->prepared->maximumFrames;
    result.host.format.outputChannels = impl_->prepared->outputChannels;
    result.host.format.float32Planar = true;
  }
  result.renderedFrames = result.host.renderedFrames;
  const uint64_t deviceLatency = presentationLatencyFrames(result.host.latency);
  const uint64_t graphLatency =
      impl_->prepared == nullptr ? 0 : impl_->prepared->graphLatencyFrames;
  const uint64_t latency =
      graphLatency > std::numeric_limits<uint64_t>::max() - deviceLatency
          ? std::numeric_limits<uint64_t>::max()
          : graphLatency + deviceLatency;
  result.audibleFrames =
      result.renderedFrames > latency ? result.renderedFrames - latency : 0;
  result.presentationLatencyFrames = latency;
  /* Whatever the graph runner last said. Read from the callback state's
     adapter, which is the same object the RT callback writes it on; this is
     an ordinary relaxed load off the audio thread. Everything the CALLBACK
     writes is read off the generation that is rendering: during an armed
     swap that is still the outgoing one, and its replacement has rendered
     nothing yet. */
  const PreparedPlaybackGraph *rendering = impl_->renderingGraph();
  result.graphStatusCode =
      rendering != nullptr && rendering->callback.adapter != nullptr
          ? rendering->callback.adapter->lastStatusCode.load(
                std::memory_order_relaxed)
          : 0;
  const uint32_t adapterDetail =
      rendering != nullptr && rendering->callback.adapter != nullptr
          ? rendering->callback.adapter->lastStatusDetail.load(
                std::memory_order_relaxed)
          : 0;
  /* 101 says only "the transport refused"; the transport knows WHICH of its
     six refusals fired, so report that instead of the generic code. */
  const uint32_t sliceRefusal =
      rendering != nullptr
          ? rendering->transport.lastSliceRefusal.load(
                std::memory_order_relaxed)
          : 0;
  result.graphStatusDetail =
      adapterDetail == 101 && sliceRefusal != 0 ? sliceRefusal : adapterDetail;
  result.timePitchAnchorOutcome =
      rendering != nullptr
          ? rendering->transport.lastAnchorOutcome.load(
                std::memory_order_relaxed)
          : 0;
  result.swapPendingGeneration =
      impl_->swapPending ? impl_->retiringSwapGeneration : 0;
  result.retiringSwapGeneration =
      impl_->swapPending ? 0 : impl_->retiringSwapGeneration;
  result.swapLandings =
      impl_->router->swapsLanded.load(std::memory_order_acquire);
  result.swapLateLandings =
      impl_->renderShared->lateLandings.load(std::memory_order_relaxed);
  result.graphLatencyFrames = graphLatency;
  result.devicePresentationLatencyFrames = deviceLatency;
  result.totalPresentationLatencyFrames = latency;
  result.error = impl_->lastError;
  result.parkedLaneBytes = impl_->parkedBytes();
  result.parkedLaneCount =
      impl_->parkedLaneCount.load(std::memory_order_acquire);
  // Parked PCM is held by this session as surely as a prepared graph's is.
  // It is added once, here, so a status that says nothing is retained means
  // exactly that on both paths.
  result.retainedBytes = result.parkedLaneBytes;
  // A landed-but-unfreed swap still holds the outgoing graph's own bytes;
  // its decoded PCM is the replacement's and is counted there.
  result.retainedBytes += impl_->retiringSwapUnsharedBytes;
  if (impl_->prepared != nullptr && rendering != nullptr) {
    const PreparedPlaybackTransport &transport = rendering->transport;
    PreparedPlaybackTransport::Telemetry telemetry{};
    const bool forcedCollision =
        impl_->testHooks != nullptr &&
        impl_->testHooks->forceTransportTelemetryCollision != nullptr &&
        impl_->testHooks->forceTransportTelemetryCollision(
            impl_->testHooks->context);
    const bool sampled =
        !forcedCollision && transport.snapshotTelemetry(&telemetry) &&
        telemetry.generation == rendering->transportGeneration;
    if (sampled) {
      impl_->lastGoodTransportTelemetry = telemetry;
      impl_->lastGoodTransportTelemetryGeneration = telemetry.generation;
      impl_->hasLastGoodTransportTelemetry = true;
      result.transportTelemetryQuality =
          NativePlaybackTransportTelemetryQuality::Current;
    } else if (impl_->hasLastGoodTransportTelemetry &&
               impl_->lastGoodTransportTelemetryGeneration ==
                   rendering->transportGeneration) {
      telemetry = impl_->lastGoodTransportTelemetry;
      result.transportTelemetryQuality =
          NativePlaybackTransportTelemetryQuality::LastGood;
    } else {
      telemetry = transport.initialTelemetrySnapshot();
      result.transportTelemetryQuality =
          NativePlaybackTransportTelemetryQuality::Initial;
    }
    result.transportGeneration = telemetry.generation;
    result.transportState = telemetry.state;
    result.lastTransportBoundary = nativeBoundaryReason(telemetry.lastBoundary);
    result.renderedProjectFrame = telemetry.projectFrame;
    result.continuousFrame = telemetry.continuousFrame;
    const bool projectionMature =
        result.transportTelemetryQuality ==
            NativePlaybackTransportTelemetryQuality::Current &&
        telemetry.continuousFrame >=
            telemetry.projectionAnchorContinuousFrame &&
        latency <= telemetry.continuousFrame -
                       telemetry.projectionAnchorContinuousFrame;
    if (projectionMature) {
      int64_t projected = result.renderedProjectFrame;
      if (telemetry.state == NativePlaybackTransportState::Playing ||
          telemetry.state == NativePlaybackTransportState::PreRoll) {
        projected = latencyAdjustedProjectFrame(
            result.renderedProjectFrame, telemetry.projectFractionQ32,
            latency, transport.playbackRateQ32);
        projected = playback_internal::loopAdjustedProjectFrame(
            projected, telemetry.loopEnabled, telemetry.loopStart,
            telemetry.loopEnd);
      }
      if (projected != std::numeric_limits<int64_t>::min()) {
        result.audibleProjectFrame = projected;
        result.audibleProjectionQuality =
            NativePlaybackAudibleProjectionQuality::Current;
      }
    }
    result.durationFrames = impl_->prepared->durationFrames;
    result.remainingPreRollFrames = telemetry.remainingPreRoll;
    result.cueEventsCompleted = telemetry.cueEventsCompleted;
    result.nextCueEventIndex = telemetry.nextCueEvent;
    result.loopEnabled = telemetry.loopEnabled;
    result.loopStartFrame = telemetry.loopStart;
    result.loopEndFrame = telemetry.loopEnd;
    result.loopCount = telemetry.loopCount;
    result.seekCount = telemetry.seekCount;
    result.transportDiscontinuities = telemetry.discontinuities;
    result.playbackRate = impl_->prepared->playbackRate;
    result.transposeSemitones = impl_->prepared->transposeSemitones;
    const SignalsmithTimePitchAnchorStatus anchors =
        signalsmithTimePitchAnchorStatus(
            impl_->prepared->timePitchProcessor);
    result.timePitchAnchorsPrepared = anchors.prepared;
    result.timePitchAnchorsPublished = anchors.published;
    result.timePitchAnchorMisses = anchors.misses;
    result.timePitchReplacementReady = anchors.replacementReady;
    result.timePitchLoopPriming = anchors.recurring;
    result.preparedStartProjectFrame =
        impl_->prepared->preparedStartProjectFrame;
    result.retainedBytes += impl_->prepared->retainedBytes;
    result.graphArenaBytes = impl_->prepared->graphArenaBytes;
    result.masterGain = impl_->prepared->masterGain;
    result.referenceGain = impl_->prepared->referenceGain;
    result.trainingEnabled = impl_->prepared->trainingEnabled;
    if (impl_->prepared->training.has_value())
      result.trainingLanes = impl_->prepared->training->laneIds;
    result.preRollFrames = impl_->prepared->cuePlan == nullptr
                               ? 0
                               : impl_->prepared->cuePlan->preRollFrames;
    result.cueEventCount =
        static_cast<uint32_t>(impl_->prepared->cueEvents.size());
    result.countInEventCount = impl_->prepared->cuePlan == nullptr
                                   ? 0
                                   : impl_->prepared->cuePlan->countInEventCount;
    result.countInBeatsPerBar =
        impl_->prepared->cuePlan == nullptr
            ? 0
            : impl_->prepared->cuePlan->countInBeatsPerBar;
    const zdsp::ScheduledCueOneShotStatus previews =
        impl_->prepared->previewClickStatus();
    result.previewClicksEnqueued = previews.enqueued;
    result.previewClicksStarted = previews.started;
    result.previewClicksCompleted = previews.completed;
    result.previewClicksPending = previews.pending;
    result.graphNodeCount = impl_->prepared->graphNodeCount;
    result.graphConnectionCount = impl_->prepared->graphConnectionCount;
    result.latencyCompensatedEdgeCount =
        impl_->prepared->latencyCompensatedEdgeCount;
    result.graphSnapshot = impl_->prepared->graphSnapshot;
    result.laneDecodeFallback = impl_->prepared->laneDecodeFallback;
    result.topology = impl_->prepared->topology;
    result.adapterRenderFailures =
        impl_->prepared->adapter.renderFailures.load(std::memory_order_relaxed);
    result.terminalRenderFailures =
        impl_->prepared->callback.terminalFailures.load(
            std::memory_order_relaxed);
    result.parameterOverflows =
        impl_->prepared->diagnostics.parameterOverflows.load(
            std::memory_order_relaxed);
    result.nonFiniteSamples =
        impl_->prepared->diagnostics.nonFiniteSamples.load(
            std::memory_order_relaxed);
    result.rejectedBlocks = impl_->prepared->diagnostics.rejectedBlocks.load(
        std::memory_order_relaxed);
    result.lanes.reserve(impl_->prepared->lanes.size());
    for (const PreparedPlaybackGraph::Lane &lane : impl_->prepared->lanes) {
      NativePlaybackLaneStatus laneStatus;
      laneStatus.id = lane.id;
      laneStatus.cursorFrames =
          zdsp::decodedBufferSourceCursor(lane.source, &lane.cursorReader);
      laneStatus.totalFrames = lane.owner->frameCount();
      laneStatus.gain = lane.gain;
      laneStatus.muted = lane.muted;
      laneStatus.solo = lane.solo;
      result.lanes.push_back(std::move(laneStatus));
    }
  }
  return result;
}

NativePlaybackLanePeaksResult
NativePlaybackSession::lanePeaks(uint64_t generation) const {
  NativePlaybackLanePeaksResult result;
  result.generation = generation;
  std::lock_guard<std::mutex> lock(impl_->mutex);
  if (generation == 0 || generation != impl_->generation ||
      impl_->prepared == nullptr) {
    result.message = "The playback generation is stale";
    return result;
  }
  result.lanes.reserve(impl_->prepared->lanes.size());
  for (const PreparedPlaybackGraph::Lane &lane : impl_->prepared->lanes)
    result.lanes.push_back({lane.id, lane.peaksValid, lane.peaks});
  result.ok = true;
  result.error = NativePlaybackError::None;
  return result;
}

NativePlaybackPositionNow NativePlaybackSession::positionNow() const noexcept {
  NativePlaybackPositionNow out;
  // activeGeneration is the one generation fact the control thread publishes
  // atomically — prepare ADMISSION stores it, before the decode, and every
  // retirement zeroes it (a bare claimGeneration does not touch it) — so it
  // is the guard here instead of impl_->generation, which lives under the
  // mutex. During a swap the outgoing generation is a second accepted
  // number: the sink keeps saying it until the seam, and the frame it
  // carries is the same song's.
  const uint64_t active =
      impl_->activeGeneration.load(std::memory_order_acquire);
  const uint64_t outgoing =
      impl_->swapFromGeneration.load(std::memory_order_acquire);
  if (active == 0)
    return out;
  int64_t publishedAt = 0;
  if (!impl_->position->snapshot(&out, &publishedAt))
    return {};
  // Before this generation's prepare commits the sink still says 0 (or a
  // quarantined predecessor's number); after unload it says 0 again. Either
  // way the frame is not this song's, and the caller must not adopt it.
  if (out.generation != active &&
      (outgoing == 0 || out.generation != outgoing))
    return {};
  const int64_t now = PlaybackPositionPublication::nowNs();
  out.ageNs = now > publishedAt ? static_cast<uint64_t>(now - publishedAt) : 0;
  out.available = true;
  return out;
}

const char *nativePlaybackSessionCapabilityTag() noexcept {
  return "singz.native.playback-session.anchored-preview.v4";
}

} // namespace singz

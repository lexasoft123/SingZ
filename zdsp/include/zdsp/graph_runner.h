#pragma once

#include "zdsp/graph.h"
#include "zdsp/queues.h"

namespace zdsp {

enum class TransitionKind : uint32_t { HardCut = 0, Crossfade = 1 };
enum class InfiniteTailPolicy : uint32_t { Reject = 0, Fade = 1, Cut = 2 };

struct TransitionPlan {
  TransitionKind kind;
  FrameCount crossfadeFrames;
  LatencyFrames oldAlignmentDelay;
  LatencyFrames newAlignmentDelay;
  InfiniteTailPolicy infiniteTailPolicy;
  TailInfo replacedTail;
  FrameLength tailSpillFrames;
  uint32_t oldCpuPermille;
  uint32_t newCpuPermille;
  uint32_t combinedCpuLimitPermille;
  uint32_t stateTransferred;
  const CompiledGraph* expectedOldGraph{nullptr};
  const CompiledGraph* expectedReplacementGraph{nullptr};
  uint64_t expectedOldGeneration{0};
  uint64_t replacementGeneration{0};
  // Off-RT aggregate requirements for the topology-compatible external
  // output set. Channels are flattened only in transition scratch; logical
  // bus descriptors remain those of the compiled graphs.
  uint32_t requiredOutputBusCount{0};
  uint32_t requiredOutputChannels{0};
  uint32_t requiredTailInputChannels{0};
};

using TransitionStateTransferFn = Status (*)(
    const CompiledGraph*, CompiledGraph*, void*) noexcept;
struct TransitionRequest {
  TransitionKind kind;
  FrameCount crossfadeFrames;
  InfiniteTailPolicy infiniteTailPolicy;
  uint32_t oldCpuPermille;
  uint32_t newCpuPermille;
  uint32_t combinedCpuLimitPermille;
  TransitionStateTransferFn stateTransfer;
  void* stateTransferContext;
  // Control-domain bound for a finite drain or an infinite-tail fade. A
  // finite crossfade must reserve at least the compiled tail; Fade requires a
  // non-zero bound. Cut never renders a spill.
  FrameLength tailSpillFrames;
  uint64_t expectedOldGeneration{0};
  uint64_t replacementGeneration{0};
};

[[nodiscard]] ZDSP_INTERNAL_API Status prepareTransition(
    const CompiledGraph* replaced, CompiledGraph* replacement,
    const TransitionRequest& request, TransitionPlan* plan) noexcept;

struct PublishedGraphSnapshot {
  CompiledGraph* graph;
  // Zero is the unpublished/unset sentinel. Published generations start at 1.
  uint64_t generation;
  TransitionPlan transition;
  uint32_t reservedRetirementSlot;
};

enum class RetirementSlotState : uint32_t { Free = 0, Reserved = 1, Waiting = 2 };
struct RetirementSlot {
  std::atomic<uint32_t> state;
  std::atomic<PublishedGraphSnapshot*> snapshot;
  uint32_t retireAfterEpoch;
};

enum class AdoptionTransferStage : uint32_t {
  OldOwnershipPublished = 1,
  ReplacementActivePublished = 2,
  OldRetirementReady = 3,
};
using AdoptionTransferTestHook = void (*)(
    void*, AdoptionTransferStage) noexcept;
enum class RejectionTransferStage : uint32_t {
  ClaimedOwnershipVisible = 1,
  ReservedOwnershipVisible = 2,
  WaitingOwnershipVisible = 3,
};
using RejectionTransferTestHook = void (*)(
    void*, RejectionTransferStage) noexcept;

struct SnapshotPublisher {
  // Serializes the short control publication update against the callback's
  // try-only claim handoff: 0 idle, 1 control update, 2 callback claim,
  // 3 permanently drained by GraphRunner shutdown.
  std::atomic<uint32_t> publicationState;
  std::atomic<PublishedGraphSnapshot*> pending;
  std::atomic<PublishedGraphSnapshot*> claimedView;
  PublishedGraphSnapshot* deferred;
  std::atomic<PublishedGraphSnapshot*> activeView;
  std::atomic<PublishedGraphSnapshot*> fadingView;
  RetirementSlot* retirementSlots;
  uint32_t retirementCapacity;
  RuntimeDiagnostics* diagnostics;
  // Test-only deterministic observation points for ownership-transfer races.
  // Production initialization leaves both null and pays one predictable
  // null-branch per adoption stage.
  AdoptionTransferTestHook adoptionTestHook;
  void* adoptionTestContext;
  RejectionTransferTestHook rejectionTestHook;
  void* rejectionTestContext;
};

struct PublicationResult {
  Status status;
  PublishedGraphSnapshot* superseded;
  uint32_t deferred;
};

ZDSP_INTERNAL_API void initializePublisher(
    SnapshotPublisher* publisher, RetirementSlot* slots, uint32_t slotCount,
    RuntimeDiagnostics* diagnostics) noexcept;
ZDSP_INTERNAL_API void setAdoptionTransferTestHook(
    SnapshotPublisher* publisher, AdoptionTransferTestHook hook,
    void* context) noexcept;
ZDSP_INTERNAL_API void setRejectionTransferTestHook(
    SnapshotPublisher* publisher, RejectionTransferTestHook hook,
    void* context) noexcept;
[[nodiscard]] ZDSP_INTERNAL_API PublicationResult submitSnapshot(
    SnapshotPublisher* publisher, PublishedGraphSnapshot* snapshot) noexcept;
[[nodiscard]] ZDSP_INTERNAL_API PublicationResult serviceDeferredSnapshot(
    SnapshotPublisher* publisher) noexcept;
[[nodiscard]] ZDSP_INTERNAL_API uint32_t reclaimSnapshots(
    SnapshotPublisher* publisher, uint32_t acknowledgedEpoch,
    PublishedGraphSnapshot** reclaimed, uint32_t capacity) noexcept;

struct GraphRunnerStorage {
  float* oldOutputSamples;
  float** oldOutputChannels;
  float* oldAlignmentSamples;
  float* newAlignmentSamples;
  float* outputHistorySamples;
  // Aggregate external output channel capacity across every logical bus.
  uint32_t channelCapacity;
  FrameCount frameCapacity;
  FrameCount alignmentCapacity;
  FrameCount historyCapacity;
  float* silenceSamples;
  const float** silenceChannels;
  uint32_t silenceChannelCapacity;
};

struct GraphRunner {
  SnapshotPublisher* publisher;
  PublishedGraphSnapshot* active;
  PublishedGraphSnapshot* fadingFrom;
  GraphRunnerStorage transitionStorage;
  ParameterQueue* parameterQueue;
  MusicalEventQueue* musicalEventQueue;
  RuntimeDiagnostics* diagnostics;
  std::atomic<uint32_t> epoch;
  // 0 idle, 1 callback in flight, 2 permanently quiesced by shutdown.
  std::atomic<uint32_t> renderState;
  uint64_t transitionFrame;
  uint64_t tailFrame;
  float oldPathEnvelope;
  uint32_t oldAlignmentCursor;
  uint32_t newAlignmentCursor;
  uint32_t historyCursor;
};

ZDSP_INTERNAL_API void initializeGraphRunner(
    GraphRunner* runner, SnapshotPublisher* publisher,
    GraphRunnerStorage transitionStorage, ParameterQueue* parameters,
    MusicalEventQueue* events, RuntimeDiagnostics* diagnostics) noexcept;
[[nodiscard]] ZDSP_INTERNAL_API Status renderGraphBlock(
    GraphRunner* runner, ProcessContext context,
    const ConstAudioBusView* inputs, uint32_t inputCount,
    const MutableAudioBusView* outputs, uint32_t outputCount) noexcept;
[[nodiscard]] ZDSP_INTERNAL_API uint32_t acknowledgedEpoch(
    const GraphRunner& runner) noexcept;
[[nodiscard]] ZDSP_INTERNAL_API Status shutdownGraphRunner(
    GraphRunner* runner, PublishedGraphSnapshot** snapshots, uint32_t capacity,
    uint32_t* snapshotCount) noexcept;
// Project-owned synchronization wrappers use this guard to reject acquisition
// from the callback domain. It cannot instrument opaque standard-library or
// operating-system synchronization hidden outside project code.
[[nodiscard]] ZDSP_INTERNAL_API bool inGraphRenderCallback() noexcept;

static_assert(std::atomic<PublishedGraphSnapshot*>::is_always_lock_free);
static_assert(std::atomic<uint32_t>::is_always_lock_free);

}  // namespace zdsp

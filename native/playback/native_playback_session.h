#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include <zcore/device/audio_host.h>
#include <zcore/media/decoded_audio.h>

namespace singz {

inline constexpr uint32_t kNativePlaybackMaximumLanes = 16;
inline constexpr size_t kNativePlaybackDefaultMaximumRetainedBytes = size_t{1}
                                                                     << 30;
inline constexpr float kNativePlaybackMaximumLinearGain = 4.0F;
inline constexpr uint32_t kNativePlaybackGainRampFrames = 128;
inline constexpr float kNativePlaybackLimiterCeiling = 0.891250938F;
inline constexpr uint64_t kNativePlaybackMaximumJsSafeInteger =
    UINT64_C(9007199254740991);

enum class NativePlaybackState : uint32_t {
  Unloaded = 0,
  Preparing,
  Prepared,
  OutputOpen,
  Running,
  Stopped,
  Terminal,
  Quarantined,
};

enum class NativePlaybackError : uint32_t {
  None = 0,
  InvalidGeneration,
  InvalidState,
  InvalidConfiguration,
  Cancelled,
  DecodeFailure,
  LimitExceeded,
  ResourceExhausted,
  GraphFailure,
  HostFailure,
  ProviderFailure,
  QueueFull,
  TeardownUncertain,
};

const char *nativePlaybackErrorName(NativePlaybackError error) noexcept;

struct NativePlaybackLaneSource {
  std::string id;
  OwnedFileDescriptor descriptor;
  float gain{1.0F};
  bool muted{false};
  bool solo{false};
};

struct NativePlaybackPrepareConfig {
  std::string outputDeviceUid;
  std::vector<uint32_t> outputChannels;
  double requestedSampleRate{0.0};
  uint32_t requestedBufferFrames{0};
  uint32_t maximumFrames{4096};
  float masterGain{1.0F};
  size_t maximumRetainedBytes{kNativePlaybackDefaultMaximumRetainedBytes};
  // A process-global fallback handoff lease is a JS-safe bearer capability.
  // Zero requests a fresh claim from Available. A positive value may only be
  // consumed by the exact next native prepare after legacy output is fully
  // suspended.
  uint64_t handoffLease{0};
  DecodedAudioPrepareOptions decodeOptions{};
};

struct NativePlaybackResult {
  bool ok{false};
  NativePlaybackError error{NativePlaybackError::InvalidState};
  uint64_t generation{0};
  NativePlaybackState state{NativePlaybackState::Unloaded};
  AudioHostFormat format{};
  AudioHostLatency latency{};
  std::string message;
};

enum class NativePlaybackDeliveryCommand : uint32_t {
  None = 0,
  OpenOutput,
  Start,
};

// Control-domain capability for one successful bridge-visible mutation. The
// token is deliberately distinct from the persistent physical host ownership
// markers: acknowledging delivery consumes only this token, while stop/unload
// still use the physical markers to prove provider quiescence.
struct NativePlaybackDeliveryToken {
  uint64_t generation{0};
  uint64_t serial{0};
  NativePlaybackDeliveryCommand command{NativePlaybackDeliveryCommand::None};

  [[nodiscard]] bool valid() const noexcept {
    return generation != 0 && serial != 0 &&
           command != NativePlaybackDeliveryCommand::None;
  }
};

enum class NativePlaybackCleanupSafety : uint32_t {
  NotOwned = 0,
  Complete,
  Uncertain,
};

enum class NativePlaybackCoordinatorState : uint32_t {
  Available = 0,
  NativeOwned,
  FallbackLeased,
  Poisoned,
};

// Allocation-free exceptional-delivery cleanup result. Only a globally empty
// Complete result permits fallback. Uncertain is a hard failure; NotOwned is
// merely token-local and cannot prove that another owner is absent.
struct NativePlaybackCleanupResult {
  NativePlaybackCleanupSafety safety{NativePlaybackCleanupSafety::NotOwned};
  NativePlaybackError error{NativePlaybackError::None};
  uint64_t generation{0};
  NativePlaybackState state{NativePlaybackState::Unloaded};
  size_t retainedBytes{0};
  AudioHostTerminalReason terminalReason{AudioHostTerminalReason::None};
  bool physicalOwnershipRetained{false};
  size_t processQuarantineRetainedBytes{0};
  bool processQuarantineReserved{false};
  bool processQuarantinePoisoned{false};
  NativePlaybackCoordinatorState coordinatorState{
      NativePlaybackCoordinatorState::Available};
  uint64_t coordinatorEpoch{0};
  uint64_t coordinatorOwnerSession{0};
  uint64_t coordinatorOwnerGeneration{0};
  uint64_t handoffLease{0};

  // NotOwned only says that this exact delivery capability has no cleanup
  // claim. It says nothing about another command/generation that may still
  // own decoded media or the output provider. Product fallback is safe only
  // after an exact cleanup has globally proved every ownership domain empty.
  [[nodiscard]] bool globallyComplete() const noexcept {
    return safety == NativePlaybackCleanupSafety::Complete &&
           error == NativePlaybackError::None &&
           state == NativePlaybackState::Unloaded && retainedBytes == 0 &&
           !physicalOwnershipRetained && processQuarantineRetainedBytes == 0 &&
           !processQuarantineReserved && !processQuarantinePoisoned &&
           coordinatorState == NativePlaybackCoordinatorState::FallbackLeased &&
           handoffLease != 0;
  }
};

// One exact unload-command receipt. The root playback result is attributed to
// the command generation while cleanup may prove a different, deferred newer
// generation that became globally empty as a consequence of this teardown.
// The session journals receipts so an exceptional bridge delivery can retry
// without losing either attribution or the acquired fallback lease.
struct NativePlaybackUnloadReceipt {
  NativePlaybackResult playback{};
  NativePlaybackCleanupResult cleanup{};
};

struct NativePlaybackLaneStatus {
  std::string id;
  uint64_t cursorFrames{0};
  uint64_t totalFrames{0};
  float gain{1.0F};
  bool muted{false};
  bool solo{false};
};

struct NativePlaybackStatus {
  uint64_t generation{0};
  NativePlaybackState state{NativePlaybackState::Unloaded};
  AudioHostStatus host{};
  AudioHostTerminalReason terminalReason{AudioHostTerminalReason::None};
  uint64_t terminalOrdinal{0};
  uint64_t renderedFrames{0};
  uint64_t audibleFrames{0};
  size_t retainedBytes{0};
  float masterGain{1.0F};
  std::vector<NativePlaybackLaneStatus> lanes;
  uint32_t adapterRenderFailures{0};
  uint32_t terminalRenderFailures{0};
  uint32_t parameterOverflows{0};
  uint32_t nonFiniteSamples{0};
  uint32_t rejectedBlocks{0};
  std::string error;
};

enum class NativePlaybackLifecycleEvent : uint32_t {
  PrepareReadyToPublish,
  HostStopBegin,
  HostStopComplete,
  HostStartProvisionalRunning,
  RunnerShutdown,
  GraphDeactivate,
  DecodedRelease,
  PreparedQuarantined,
};

// Ordinary-thread fault-injection boundary used only by deterministic host
// tests. Production hooks are null. These points deliberately surround every
// allocation-heavy ownership transition without reaching the render leaf.
enum class NativePlaybackAllocationPoint : uint32_t {
  PreparePreconditionResult,
  OpenPreconditionResult,
  StartPreconditionResult,
  AfterDecode,
  AfterArena,
  AfterGraphCompile,
};

enum class NativePlaybackInjectedFailure : uint32_t {
  None,
  BadAllocation,
  Unexpected,
};

struct NativePlaybackTestHooks {
  void (*observe)(void *, NativePlaybackLifecycleEvent) noexcept {nullptr};
  void *context{nullptr};
  NativePlaybackInjectedFailure (*inject)(
      void *, NativePlaybackAllocationPoint) noexcept {nullptr};
  // Deterministic fail-stop coverage for the off-lock stale-publication
  // retirement path. Production leaves this null.
  bool (*failRunnerShutdown)(void *) noexcept {nullptr};
  // Deterministically exercises the JS-safe lease serial exhaustion path.
  // Production leaves this null. A true result must fail closed without
  // transitioning process ownership to fallback.
  bool (*exhaustHandoffLeaseSerial)(void *) noexcept {nullptr};
  // Deterministically exercises bounded unload-receipt journal exhaustion.
  // Production leaves this null. Rejection is fail-closed before recording a
  // deferred unload handshake.
  bool (*exhaustUnloadReceiptJournal)(void *) noexcept {nullptr};
};

// Reusable ordinary-thread composition owner. It accepts only already-opened
// authority and fully decodes/resamples/compiles without touching AudioHost.
// openOutput is a distinct post-handoff route-validation step and never
// configures a platform audio session. Start is frame-zero only; seek, loop,
// tempo, transpose, cues and custom codecs are absent.
class NativePlaybackSession final {
public:
  NativePlaybackSession();
  explicit NativePlaybackSession(std::unique_ptr<AudioHostBackend> backend);
  NativePlaybackSession(std::unique_ptr<AudioHostBackend> backend,
                        NativePlaybackTestHooks *testHooks);
  ~NativePlaybackSession();
  NativePlaybackSession(const NativePlaybackSession &) = delete;
  NativePlaybackSession &operator=(const NativePlaybackSession &) = delete;

  AudioHostInventory enumerate() const;
  // Claims a newer product generation immediately, before its serialized
  // prepare command runs. A claim supersedes in-flight older preparation.
  bool claimGeneration(uint64_t generation) noexcept;
  // Bridge admission variant. A positive handoff lease atomically transfers
  // FallbackLeased back to NativeOwned; zero may claim only Available or
  // supersede this same session. Failures are typed and do not mutate the
  // existing coordinator owner/lease.
  NativePlaybackResult claimGeneration(uint64_t generation,
                                       uint64_t handoffLease) noexcept;
  // Callback-safe cancellation admission for stop/unload dispatchers. It may
  // be called before the matching serialized command is enqueued.
  bool requestCancellation(uint64_t generation) noexcept;
  // Completes a generation already claimed by the bridge when descriptor
  // authorization/opening fails before heavy prepare can take ownership.
  // The exact generation then participates in ordinary idempotent unload.
  NativePlaybackResult failPrepareAdmission(uint64_t generation,
                                            NativePlaybackError error) noexcept;
  NativePlaybackResult prepare(NativePlaybackPrepareConfig config,
                               std::vector<NativePlaybackLaneSource> lanes,
                               uint64_t generation,
                               DecodeCancellation cancellation = {});
  NativePlaybackResult
  openOutput(uint64_t generation,
             NativePlaybackDeliveryToken *deliveryToken = nullptr);
  NativePlaybackResult
  start(uint64_t generation,
        NativePlaybackDeliveryToken *deliveryToken = nullptr);
  // Bridge-only exceptional-delivery recovery. Each method is generation
  // and invocation exact. A precondition failure returns no token; stale,
  // wrong-command and already-acknowledged tokens are harmless no-ops.
  bool acknowledgeDelivery(NativePlaybackDeliveryToken token) noexcept;
  NativePlaybackCleanupResult
  abortDelivery(NativePlaybackDeliveryToken token) noexcept;
  NativePlaybackCleanupResult
  abortPrepareDelivery(uint64_t generation) noexcept;
  // Non-mutating, generation-exact ownership proof for normal bridge unload.
  // Only globallyComplete() permits B2 to acquire legacy output or decode
  // legacy PCM. A locally successful unload is deliberately insufficient.
  NativePlaybackCleanupResult cleanupProof(uint64_t generation) const noexcept;
  NativePlaybackResult stop(uint64_t generation);
  NativePlaybackResult unload(uint64_t generation);
  NativePlaybackUnloadReceipt unloadWithCleanup(uint64_t generation) noexcept;
  NativePlaybackResult setLaneControl(uint64_t generation,
                                      const std::string &laneId, float gain,
                                      bool muted, bool solo);
  NativePlaybackResult setMasterGain(uint64_t generation, float gain);
  NativePlaybackStatus status() const;

private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

// Durable product-link evidence. The bridge's Release binary gate requires
// this exact implementation symbol, not merely its source pod archive.
[[nodiscard]] const char *nativePlaybackSessionCapabilityTag() noexcept;

} // namespace singz

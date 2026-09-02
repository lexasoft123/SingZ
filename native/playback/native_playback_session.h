#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include <zcore/device/audio_host.h>
#include <zcore/media/decoded_audio.h>

#include "native_playback_graph_document.h"
#include "playback_cue_plan.h"

namespace singz {

inline constexpr uint32_t kNativePlaybackMaximumLanes = 16;
inline constexpr uint32_t kNativePlaybackMaximumTrainingWindows = 16384;
inline constexpr uint32_t kNativePlaybackMaximumGraphNodes = 128;
inline constexpr uint32_t kNativePlaybackMaximumGraphConnections = 256;
inline constexpr uint32_t kNativePlaybackMaximumNodeBuses =
    kNativePlaybackMaximumLanes;
inline constexpr size_t kNativePlaybackDefaultMaximumRetainedBytes = size_t{1}
                                                                     << 30;
inline constexpr float kNativePlaybackMaximumLinearGain = 4.0F;
inline constexpr uint32_t kNativePlaybackGainRampFrames = 128;
inline constexpr float kNativePlaybackLimiterCeiling = 0.891250938F;
inline constexpr uint64_t kNativePlaybackMaximumJsSafeInteger =
    UINT64_C(9007199254740991);
// Fixed waveform-summary resolution published with every prepared lane. The
// phones draw the seek bar from exactly this many slivers
// (mobile/src/ui/PlayerScreen.tsx), so the count is part of the bridge
// contract rather than a private implementation detail: all three bridges
// publish it beside the lane arrays as `bucketCount`, in lanePeaks()'s
// result — NOT in status(), and not under any other name.
inline constexpr uint32_t kNativePlaybackLaneSummaryBuckets = 96;
// Concurrent lane decoding is bounded by MEMORY, not by the core count. A
// decode that resamples holds its input planes, its output planes and the
// interleaved output at once, so a lane in flight costs far more than the
// bytes it will publish — measured on six five-minute 44.1 kHz stereo stems
// resampled to 48 kHz (663 MB published), each extra concurrent decode added
// 211 MB of peak RSS, almost exactly twice one lane's published size:
//
//   workers  1 -> 5163 ms /  881 MB      workers  3 -> 1930 ms / 1308 MB
//   workers  2 -> 2592 ms / 1097 MB      workers  6 -> 1311 ms / 1940 MB
//
// Unbounded concurrency therefore turned a 0.9 GB open into a 1.9 GB one,
// and this app has been jetsam-killed for less. Two things bound it now, and
// only one of them is a constant:
//
//   * how much each concurrent decode may PUBLISH is reserved out of the
//     caller's own maximumRetainedBytes, so the sum across the decodes in
//     flight cannot exceed it (decodeLanesConcurrently);
//   * how many may run at once is the constant below.
//
// Three concurrent decodes measured 1303 MB peak against the sequential
// path's 887 MB (+47%) for 2.6x the speed; two measured 1097 MB (+24%) for
// 2.0x. The knee of the curve and a phone's jetsam budget both argue for two,
// so two is the default: the last worker costs 211 MB to buy 26% more speed,
// and a song that fails to open is worse than a song that opens a little
// slower. This is the knob; raising it costs about 211 MB per worker on the
// six-lane project measured above.
inline constexpr size_t kNativePlaybackMaximumConcurrentLaneDecodes = 2;
// Each in-flight decode is additionally bounded to this multiple of what it
// is allowed to PUBLISH, so one lane can no longer reach for the 2 GB
// per-decode working default that no caller ever chose. The decoder's own
// accounting (input + output + interleaved + filter) is about 3x the
// published size for the 44.1 -> 48 kHz ratio this app resamples at.
inline constexpr size_t kNativePlaybackLaneWorkingBytesPerDecodedByte = 4;

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
  UnsupportedPlaybackRate,
};

const char *nativePlaybackErrorName(NativePlaybackError error) noexcept;

struct NativePlaybackLaneSource {
  std::string id;
  OwnedFileDescriptor descriptor;
  float gain{1.0F};
  bool muted{false};
  bool solo{false};
  // Opaque bridge-owned name for this source. The core never interprets,
  // opens, resolves or logs it; its ONE use is deciding whether a lane parked
  // by a retaining unload may be adopted by this prepare instead of decoded
  // again, and an empty key never adopts — a bridge that does not set it
  // simply keeps today's decode-every-time behaviour.
  //
  // BE CLEAR ABOUT WHAT IT IDENTIFIES: all three product bridges pass the
  // authorized PATH they opened, which names a location, not the bytes. If
  // the file at that path is rewritten between a parking unload and the
  // prepare that adopts it, the adopted lane is the OLD audio and nothing
  // here can tell. That is tolerable only because the window is one
  // structural rebuild of a song already open, and every command other than
  // the adopting prepare releases the parked lanes. A bridge that can cheaply
  // name the bytes instead (a content hash, or size+mtime) should pass that,
  // and the window closes.
  std::string sourceKey;
};

// Opt-in decoded-lane retention across a structural rebuild. Release is
// today's behaviour in every respect. Park keeps the decoded lane owners
// alive after the graph is gone so the next prepare of the same files at the
// same rate can adopt them; every other command releases them, and the parked
// bytes are reported as retained until they are.
//
// DORMANT ON PURPOSE. Nothing in the product asks for Park: the bridges
// expose unloadRetainingLanes, no facade calls it, and Release is the default
// everywhere — so this ships inert and the only reachable behaviour is
// today's. It is dormant because retention produced three memory-shaped
// defects in three review rounds on a device that gets killed for holding
// memory: a claim that released the park before the prepare that would adopt
// it, a release path unreachable from any bridge, and an Android lifecycle
// that stranded the PCM across backgrounding. All three are fixed and pinned
// by tests, and none of that is the same as evidence from a device.
//
// The gate for turning it on is a hardware pass that watches parked bytes
// across a rebuild AND across backgrounding — the shape mobile/tests/
// open-close-memory.cjs already has for the JS decode path — not another
// headless suite. The win it buys is ~150 ms on a rebuild; the parallel
// decode that ships alongside it is worth ~2100 ms and stands on its own.
enum class NativePlaybackLaneRetention : uint32_t {
  Release = 0,
  Park,
};

struct NativePlaybackTrainingWindow {
  int64_t startProjectFrame{0};
  int64_t endProjectFrame{0};
};

enum class NativePlaybackTrainingMode : uint32_t { Period = 0, Windows = 1 };

// Already-sanitized frame-domain training intent. It is prepared with the
// graph and borrowed by allocation-free scheduled-gain processors. The lane
// controls remain independent: training is a second multiplicative layer.
struct NativePlaybackTrainingDuckConfig {
  NativePlaybackTrainingMode mode{NativePlaybackTrainingMode::Period};
  int64_t periodFrames{0};
  std::vector<NativePlaybackTrainingWindow> windows;
  std::vector<std::string> laneIds;
  bool enabled{false};
};

struct NativePlaybackInitialLoop {
  int64_t startProjectFrame{0};
  int64_t endProjectFrame{0};
};

// Callback-visible transport intent installed by the Start command itself.
// This is part of prepare because a replacement graph must not briefly run
// without its prior pause/loop state while JavaScript restores commands.
struct NativePlaybackInitialTransportConfig {
  bool startPaused{false};
  std::optional<NativePlaybackInitialLoop> loop;
};

struct NativePlaybackPrepareConfig {
  std::string outputDeviceUid;
  std::vector<uint32_t> outputChannels;
  // Provider-bound access mode validated by the product bridge. ASIO must
  // reach AudioHostBackend::open as exclusive; other providers stay shared.
  bool exclusive{false};
  double requestedSampleRate{0.0};
  uint32_t requestedBufferFrames{0};
  uint32_t maximumFrames{4096};
  float masterGain{1.0F};
  // Structural tempo. Sources, transport schedules and reference cues share
  // one prepared Q32 rate; non-unity tempo also inserts the phase-coherent
  // song-bus Signalsmith correction processor. Runtime changes rebuild the
  // prepared generation instead of mutating its callback-time ratio.
  double playbackRate{1.0};
  double transposeSemitones{0.0};
  size_t maximumRetainedBytes{kNativePlaybackDefaultMaximumRetainedBytes};
  // A process-global fallback handoff lease is a JS-safe bearer capability.
  // Zero requests a fresh claim from Available. A positive value may only be
  // consumed by the exact next native prepare after legacy output is fully
  // suspended.
  uint64_t handoffLease{0};
  DecodedAudioPrepareOptions decodeOptions{};
  // Optional portable scheduling intent. The session prepares and owns the
  // resulting immutable plan before publishing any callback-visible graph.
  // Absence preserves the original frame-zero, song-only topology exactly.
  std::optional<PlaybackCuePlanRequest> cuePlan;
  std::optional<NativePlaybackTrainingDuckConfig> trainingDuck;
  // Generation-bound rebuild/hot-swap position. When absent, the ordinary
  // first start begins at the cue plan's full negative pre-roll. When present,
  // the signed frame must lie within [-preRoll, decodedDuration] and becomes
  // the first Start position without replaying earlier count-in/cues.
  std::optional<int64_t> preparedStartProjectFrame;
  NativePlaybackInitialTransportConfig initialTransport{};
  // Optional portable format-1 graph projection. Absence synthesizes the
  // behavior-preserving fixed graph entirely in memory and never persists it.
  // The bridge keeps opaque/unknown document data outside native code; these
  // bounded fields are the exact topology materialized into zdsp.
  std::optional<NativePlaybackGraphDocument> graphDocument;
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
  // Decoded lanes this session parked for an adopting prepare. They are
  // counted in retainedBytes as well, so `retained 0` keeps meaning that
  // nothing at all is held. Declared last so every existing positional
  // aggregate initialization of this result keeps its meaning.
  size_t parkedLaneBytes{0};

  // NotOwned only says that this exact delivery capability has no cleanup
  // claim. It says nothing about another command/generation that may still
  // own decoded media or the output provider. Product fallback is safe only
  // after an exact cleanup has globally proved every ownership domain empty.
  [[nodiscard]] bool globallyComplete() const noexcept {
    return safety == NativePlaybackCleanupSafety::Complete &&
           error == NativePlaybackError::None &&
           state == NativePlaybackState::Unloaded && retainedBytes == 0 &&
           parkedLaneBytes == 0 && !physicalOwnershipRetained &&
           processQuarantineRetainedBytes == 0 &&
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

// One lane's prepared amplitude envelope: the peak absolute sample of every
// channel inside each of the fixed buckets, as a linear 0..1 float. Computed
// from the same decode that feeds the graph and deliberately NOT normalized —
// the drawing side owns presentation scaling. `valid` is false only when the
// lane carried no addressable audio (no frames or no channels), and `peaks`
// is then all zeros.
struct NativePlaybackLanePeaksEntry {
  std::string id;
  bool valid{false};
  std::array<float, kNativePlaybackLaneSummaryBuckets> peaks{};
};

// Deliberately NOT part of status(). The envelope never changes for a
// prepared generation, and status is polled every 200 ms — every 15 ms while
// a seek receipt is outstanding — so republishing six lanes of 96 floats
// there was 10-12 KB of JSON per poll that nothing could ever have needed
// twice. Read this once when a generation is prepared and cache it under
// that generation.
struct NativePlaybackLanePeaksResult {
  bool ok{false};
  NativePlaybackError error{NativePlaybackError::InvalidGeneration};
  uint64_t generation{0};
  uint32_t bucketCount{kNativePlaybackLaneSummaryBuckets};
  std::vector<NativePlaybackLanePeaksEntry> lanes;
  std::string message;
};

enum class NativePlaybackPreviewClickSound : uint32_t {
  Ordinary = 0,
  Accent = 1,
};

enum class NativePlaybackTransportState : uint32_t {
  Stopped = 0,
  PreRoll,
  Playing,
  Paused,
  Completed,
};

enum class NativePlaybackTransportTelemetryQuality : uint32_t {
  Unavailable = 0,
  Initial,
  Current,
  LastGood,
};

enum class NativePlaybackAudibleProjectionQuality : uint32_t {
  Unavailable = 0,
  Current,
};

enum class NativePlaybackGraphNodeRole : uint32_t {
  Input = 0,
  Processor,
  Output,
};

// UI-facing semantic kind derived from the exact compiled node type record.
// The raw stable type id remains available for forward-compatible diagnostics.
enum class NativePlaybackGraphNodeKind : uint32_t {
  Unknown = 0,
  PhysicalOutput,
  DecodedSource,
  ChannelMap,
  Gain,
  Mix,
  ScheduledGain,
  SignalsmithTimePitch,
  ScheduledCueSource,
  PeakRms,
  Tap,
  Oscillator,
  SafetyLimiter,
  UnavailableBypass,
  UnavailableSilence,
};

struct NativePlaybackGraphNodeStatus {
  uint64_t id{0};
  std::string label;
  NativePlaybackGraphNodeRole role{NativePlaybackGraphNodeRole::Processor};
  NativePlaybackGraphNodeKind kind{NativePlaybackGraphNodeKind::Unknown};
  uint64_t typeHigh{0};
  uint64_t typeLow{0};
  uint32_t schemaVersion{0};
  uint32_t flags{0};
  uint32_t inputBusCount{0};
  uint32_t outputBusCount{0};
  std::array<uint32_t, kNativePlaybackMaximumNodeBuses> inputBusChannels{};
  std::array<uint32_t, kNativePlaybackMaximumNodeBuses> outputBusChannels{};
  uint32_t intrinsicLatencyFrames{0};
  uint32_t arrivalLatencyFrames{0};
  uint32_t outputLatencyFrames{0};
};

struct NativePlaybackGraphConnectionStatus {
  uint64_t sourceNodeId{0};
  uint32_t sourceBus{0};
  uint32_t sourceChannels{0};
  uint64_t destinationNodeId{0};
  uint32_t destinationBus{0};
  uint32_t destinationChannels{0};
  uint32_t sourceOutputLatencyFrames{0};
  uint32_t destinationArrivalLatencyFrames{0};
  uint32_t compensationFrames{0};
  bool latencyCompensated{false};
};

// Constructed once from the exact PlaybackGraphComposition records and then
// retained as immutable control-domain state for the prepared generation.
struct NativePlaybackGraphSnapshot {
  uint64_t generation{0};
  uint32_t formatVersion{0};
  double sampleRate{0.0};
  uint32_t maximumFrames{0};
  uint32_t outputLatencyFrames{0};
  uint32_t latencyCompensatedConnectionCount{0};
  std::vector<NativePlaybackGraphNodeStatus> nodes;
  std::vector<NativePlaybackGraphConnectionStatus> connections;
};

// Mirrors the stable zdsp discontinuity vocabulary without exposing a zdsp
// implementation type through the public native-session interface.
enum class NativePlaybackTransportBoundaryReason : uint32_t {
  None = 0,
  StreamGenerationChanged,
  SequenceGap,
  SampleRateChanged,
  RouteGenerationChanged,
  TimestampQualityChanged,
  ClockReanchored,
  SourceSeek,
  SourceLoop,
  DeviceLost,
  SourceFrameOverflow,
};

struct NativePlaybackStatus {
  uint64_t generation{0};
  NativePlaybackState state{NativePlaybackState::Unloaded};
  AudioHostStatus host{};
  AudioHostTerminalReason terminalReason{AudioHostTerminalReason::None};
  uint64_t terminalOrdinal{0};
  uint64_t renderedFrames{0};
  uint64_t audibleFrames{0};
  uint64_t transportGeneration{0};
  NativePlaybackTransportTelemetryQuality transportTelemetryQuality{
      NativePlaybackTransportTelemetryQuality::Unavailable};
  NativePlaybackTransportState transportState{
      NativePlaybackTransportState::Stopped};
  NativePlaybackTransportBoundaryReason lastTransportBoundary{
      NativePlaybackTransportBoundaryReason::None};
  int64_t renderedProjectFrame{0};
  int64_t audibleProjectFrame{0};
  NativePlaybackAudibleProjectionQuality audibleProjectionQuality{
      NativePlaybackAudibleProjectionQuality::Unavailable};
  uint64_t continuousFrame{0};
  uint64_t durationFrames{0};
  uint64_t remainingPreRollFrames{0};
  uint32_t cueEventsCompleted{0};
  uint32_t nextCueEventIndex{0};
  bool loopEnabled{false};
  int64_t loopStartFrame{0};
  int64_t loopEndFrame{0};
  uint64_t loopCount{0};
  uint64_t seekCount{0};
  uint64_t transportDiscontinuities{0};
  uint64_t presentationLatencyFrames{0};
  double playbackRate{1.0};
  double transposeSemitones{0.0};
  uint64_t graphLatencyFrames{0};
  uint64_t timePitchAnchorsPrepared{0};
  uint64_t timePitchAnchorsPublished{0};
  uint64_t timePitchAnchorMisses{0};
  bool timePitchReplacementReady{false};
  bool timePitchLoopPriming{false};
  uint64_t devicePresentationLatencyFrames{0};
  uint64_t totalPresentationLatencyFrames{0};
  int64_t preparedStartProjectFrame{0};
  size_t retainedBytes{0};
  /** Exact byte capacity of the prepared realtime arena, included once in
   * retainedBytes and aggregate admission. */
  size_t graphArenaBytes{0};
  /** Decoded lanes parked by a retaining unload, waiting for an adopting
   * prepare. Counted once in retainedBytes as well: a session holding parked
   * PCM has never released everything, and must not say that it has. */
  size_t parkedLaneBytes{0};
  uint32_t parkedLaneCount{0};
  float masterGain{1.0F};
  float referenceGain{0.0F};
  bool trainingEnabled{false};
  std::vector<std::string> trainingLanes;
  int64_t preRollFrames{0};
  uint32_t cueEventCount{0};
  // The prepared count-in's shape, so a facade can draw beat dots instead of
  // a bare countdown. Both are zero when the plan schedules no count-in.
  uint32_t countInEventCount{0};
  uint32_t countInBeatsPerBar{0};
  // The lane envelopes are NOT here; see lanePeaks(). They are immutable for
  // the generation and far too large to repeat on every poll.
  uint64_t previewClicksEnqueued{0};
  uint64_t previewClicksStarted{0};
  uint64_t previewClicksCompleted{0};
  uint32_t previewClicksPending{0};
  uint32_t graphNodeCount{0};
  uint32_t graphConnectionCount{0};
  uint32_t latencyCompensatedEdgeCount{0};
  std::shared_ptr<const NativePlaybackGraphSnapshot> graphSnapshot;
  /** Empty for an ordinary open. Non-empty when the bounded lane-decode pool
   * handed this generation's lanes to the one-at-a-time path because a lane
   * did not fit its share of the decode budget — the one decline that costs
   * the singer seconds and that nothing else in the status would explain. It
   * names the lane and its share, and is meant to be logged once beside the
   * facade's own "prepared in N ms" stamp: the two together answer "why did
   * this song open slowly" without anyone having to guess. */
  std::string laneDecodeFallback;
  std::string topology;
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
  // Forces the bounded telemetry reader to observe a publication collision.
  // status() must then return a coherent same-generation initial/last-good
  // snapshot, never zero-initialized transport data.
  bool (*forceTransportTelemetryCollision)(void *) noexcept {nullptr};
  // Deterministically takes the sequential lane-decode path that the bounded
  // concurrent pool hands its work back to. Production leaves this null. The
  // two paths must be value-identical, so this is how a test compares them.
  bool (*forceSequentialLaneDecode)(void *) noexcept {nullptr};
  // Reports the bounded pool's admission decision once per lane CLAIM: how
  // many lanes may decode at once, the lane budget being shared out, the
  // allowances actually handed to that lane's decoder, and — the number that
  // matters — how much of the budget is spoken for at that moment: the bytes
  // already-decoded lanes hold PLUS the allowances of every decode in flight,
  // including this one. A ceiling has to be asserted on that
  // sum; asserting a single lane's allowance instead passes against a pool
  // that hands out too many of them. Called from the worker threads, so an
  // implementation must be thread-safe. Production leaves it null.
  void (*observeLaneDecodePool)(void *, uint32_t workers, uint64_t laneBudget,
                                uint64_t laneDecodedBytes,
                                uint64_t laneWorkingBytes,
                                uint64_t inFlightDecodedBytes) noexcept {
      nullptr};
};

// Reusable ordinary-thread composition owner. It accepts only already-opened
// authority and fully decodes/resamples/compiles without touching AudioHost.
// openOutput is a distinct post-handoff route-validation step and never
// configures a platform audio session. A prepared cue plan may start the
// signed project clock in pre-roll and enter the positioned song sources at
// project frame zero. Runtime pause/resume, absolute seek and bounded looping
// are callback-domain transport commands. Tempo and transpose are structural
// graph settings: a new generation atomically re-anchors them, its sources and
// its prepared cue/training schedules at one project frame.
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
  // Product bridge provider selection. This is accepted only while the
  // session is fully unloaded, before a new generation is claimed.
  bool replaceAudioHostBackend(std::unique_ptr<AudioHostBackend> backend);
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
  // The cancellation token is polled from the bounded lane-decode pool, so
  // its callback may run CONCURRENTLY on up to
  // kNativePlaybackMaximumConcurrentLaneDecodes threads as well as on the
  // calling thread, and it may be entered again before a previous call has
  // returned. It must be thread-safe, must not block (the pool waits on it to
  // abort promptly) and must not issue session commands — a command would
  // race the preparation that is asking it. Const observers such as status()
  // are safe: prepare holds no session lock while decoding.
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
  NativePlaybackResult pause(uint64_t generation);
  NativePlaybackResult resume(uint64_t generation);
  NativePlaybackResult seek(uint64_t generation, int64_t projectFrame);
  NativePlaybackResult setLoop(uint64_t generation, int64_t startFrame,
                               int64_t endFrame);
  NativePlaybackResult clearLoop(uint64_t generation);
  // Preserve project/continuous positions while forcing a typed source reset
  // at the next callback. Platform route/stream changes are also detected
  // automatically by the callback-domain transport owner.
  NativePlaybackResult reanchorTransport(uint64_t generation);
  // Retention is opt-in and defaults to today's behaviour exactly. Park keeps
  // this generation's decoded lanes for the very next prepare; any other
  // command, including a prepare whose lanes do not match, releases them.
  NativePlaybackResult
  unload(uint64_t generation,
         NativePlaybackLaneRetention retention =
             NativePlaybackLaneRetention::Release);
  NativePlaybackUnloadReceipt
  unloadWithCleanup(uint64_t generation,
                    NativePlaybackLaneRetention retention =
                        NativePlaybackLaneRetention::Release) noexcept;
  NativePlaybackResult setLaneControl(uint64_t generation,
                                      const std::string &laneId, float gain,
                                      bool muted, bool solo);
  NativePlaybackResult setMasterGain(uint64_t generation, float gain);
  NativePlaybackResult setTrainingEnabled(uint64_t generation, bool enabled);
  // Enqueue one prepared click sound for the next graph-block boundary. From
  // Prepared/OutputOpen this acquires and starts the already-prepared host
  // without starting song transport; Running includes paused/completed. The
  // command is generation exact and rendered by the native reference bus;
  // callers must never fall back to a parallel JS/legacy audition path after
  // a successful receipt.
  NativePlaybackResult previewClick(
      uint64_t generation,
      NativePlaybackPreviewClickSound sound =
          NativePlaybackPreviewClickSound::Ordinary);
  NativePlaybackStatus status() const;
  // Generation-exact, immutable for that generation, and an OBSERVER like
  // status(): it issues no command and does not release parked lanes. A stale
  // or unprepared generation is refused rather than answered with an older
  // one, so a cached copy can be keyed on the generation safely.
  //
  // Bridge note for consumers: the phones marshal `generation` as a NUMBER
  // and the desktop addon as a lossless decimal STRING. That is the desktop's
  // existing convention for every 64-bit counter it publishes, not a quirk of
  // this method, but it is the one field whose type differs between the three
  // payloads — so parse it, do not compare it raw.
  NativePlaybackLanePeaksResult lanePeaks(uint64_t generation) const;

private:
  NativePlaybackResult
  startOutput(uint64_t generation, bool startTransport,
              NativePlaybackDeliveryToken *deliveryToken = nullptr);
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

// Durable product-link evidence. The bridge's Release binary gate requires
// this exact implementation symbol, not merely its source pod archive.
[[nodiscard]] const char *nativePlaybackSessionCapabilityTag() noexcept;

} // namespace singz

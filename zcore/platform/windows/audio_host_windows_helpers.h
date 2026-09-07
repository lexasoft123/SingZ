#pragma once

#include <atomic>
#include <cstdint>

#include <windows.h>
#include <mmreg.h>

#include <zcore/device/audio_host.h>

namespace singz::detail {

constexpr uint32_t kWasapiMaximumConsecutiveBufferErrors = 3;
constexpr uint32_t kWasapiMaximumExactProfileAttempts = 4;

enum class WasapiBufferAction : uint32_t {
  Proceed,
  Empty,
  Retry,
  Fail,
};

enum class WasapiLifecycleState : uint32_t {
  Opening,
  Open,
  Starting,
  Running,
  Stopped,
  DeviceLost,
  Error,
};

enum class WasapiStartupStage : uint32_t {
  Control,
  PrimeGetBuffer,
  PrimeReleaseBuffer,
  CaptureStart,
  CapturePrimePacket,
  CapturePrimeRelease,
  RenderStart,
};

struct WasapiStartupFailureDecision {
  AudioHostError error{AudioHostError::ProviderFailure};
  WasapiLifecycleState state{WasapiLifecycleState::Error};
};

// Copied while the backend control mutex is held. The owner publishes only
// the first pre-running failure so a later cleanup error cannot erase its
// HRESULT provenance.
struct WasapiStartupFailureState {
  bool hasFailure{false};
  WasapiStartupStage stage{WasapiStartupStage::Control};
  int32_t result{S_OK};
};

enum class WasapiSharedAttemptAction : uint32_t {
  Complete,
  FreshLegacyFallback,
  Reject,
};

enum class WasapiOpenStage : uint32_t {
  DeviceLookup,
  ClientActivation,
  ClientProperties,
  MixFormat,
  FormatProbe,
  SharedPeriod,
  SharedInitialize,
  LegacyInitialize,
  ExclusivePeriod,
  ExclusiveInitialize,
  BufferSize,
  EventHandle,
  Service,
  RequestValidation,
};

enum class WasapiOpenOutcome : uint32_t {
  ApiFailure,
  MalformedAutomaticValue,
  CallerRateMismatch,
  CallerPeriodRejected,
  CallerChannelMapRejected,
  CallerExactTopologyRejected,
  CallerAlignmentMismatch,
  CallerMaximumFramesExceeded,
  ProviderUnsupported,
};

enum class WasapiPairingStage : uint32_t {
  InputState,
  OutputState,
  InputPropertyStore,
  OutputPropertyStore,
  InputContainerValue,
  OutputContainerValue,
  ContainerComparison,
};

enum class WasapiPairingOutcome : uint32_t {
  Success,
  ApiFailure,
  Inactive,
  MissingOrMalformedContainer,
  ContainerMismatch,
};

enum class WasapiOptionalOpenStage : uint32_t {
  StreamLatency,
  ClockFrequency,
};

enum class WasapiOptionalOpenAction : uint32_t {
  UseValue,
  UseFallback,
  FailDeviceLost,
};

enum class WasapiClient3QueryAction : uint32_t {
  UseClient3,
  LegacyFallback,
  Unsupported,
  Fail,
};

enum class WasapiClockPositionAction : uint32_t {
  UseHardware,
  UseQpcFallback,
  FailDeviceLost,
};

struct WasapiOutputTimestampProjection {
  uint64_t hostTimeNs{0};
  bool hardware{false};
};

struct WasapiOwnerArbiterPlan {
  bool stop{false};
  bool recordRenderWake{false};
  bool drainCapture{false};
  bool captureEventObserved{false};
  bool render{false};
};

struct WasapiRenderRequest {
  bool valid{false};
  bool exclusive{false};
  uint64_t observedQpcNs{0};
  uint32_t paddingFrames{0};
  uint32_t framesToWrite{0};
  uint32_t budgetFrames{0};
  uint64_t deadlineNs{0};
};

struct WasapiCaptureRenderState {
  bool renderObservedBeforeDrain{false};
  bool postDrainPollConsumed{false};
  bool renderObservedAfterDrain{false};
  bool requestClaimed{false};
};

struct WasapiOwnerStartPlan {
  bool primeRenderBeforeCapture{false};
  uint32_t capturePrefillPeriods{1};
};

using WasapiShutdownStep = void (*)(void* context) noexcept;

struct WasapiShutdownOperations {
  void* context{nullptr};
  WasapiShutdownStep signal{nullptr};
  WasapiShutdownStep join{nullptr};
  WasapiShutdownStep deactivateAndQuiesce{nullptr};
  WasapiShutdownStep closeEvents{nullptr};
};

enum class WasapiPendingRenderAction : uint32_t {
  Render,
  WaitForCapture,
  Stop,
  FailDeadline,
};

enum class WasapiPrimeAcquireAction : uint32_t {
  Proceed,
  Fail,
};

enum class WasapiExclusiveAlignmentAction : uint32_t {
  NotRequired,
  ReactivateAligned,
  Fail,
};

enum class WasapiOnceStage : uint32_t {
  Idle,
  Pending,
  Acquired,
  Advanced,
  Complete,
  Failed,
};

class WasapiOnceOperation final {
 public:
  bool begin() noexcept;
  bool markAcquired() noexcept;
  bool markAdvanced() noexcept;
  bool finishRelease(int32_t result) noexcept;
  void fail() noexcept;
  WasapiOnceStage stage() const noexcept { return stage_; }
  uint32_t advances() const noexcept { return advances_; }

 private:
  WasapiOnceStage stage_{WasapiOnceStage::Idle};
  uint32_t advances_{0};
};

WasapiOwnerStartPlan wasapiOwnerStartPlan(bool exclusive) noexcept;
bool runWasapiShutdownSequence(
    const WasapiShutdownOperations& operations) noexcept;
bool wasapiOwnerShouldAwaitCapture(bool exclusive, uint32_t fifoFrames,
                                   uint32_t renderFrames) noexcept;
uint64_t wasapiRenderPaddingBudgetNs(uint32_t paddingFrames,
                                     uint32_t sampleRate) noexcept;
uint64_t wasapiRenderDeadlineNs(uint64_t renderWakeNs,
                                uint32_t budgetFrames,
                                uint32_t sampleRate) noexcept;
bool wasapiRenderDeadlineExpired(uint64_t renderWakeNs,
                                 uint64_t completionNs,
                                 uint32_t budgetFrames,
                                 uint32_t sampleRate) noexcept;
bool prepareWasapiRenderRequest(bool exclusive, uint64_t observedQpcNs,
                                uint32_t bufferFrames,
                                uint32_t paddingFrames,
                                uint32_t sampleRate,
                                WasapiRenderRequest* request) noexcept;
bool wasapiRenderRequestExpired(const WasapiRenderRequest& request,
                                uint64_t completionNs) noexcept;
uint32_t wasapiRenderWaitTimeoutMs(uint64_t nowNs,
                                   uint64_t deadlineNs) noexcept;
WasapiPendingRenderAction wasapiPendingRenderAction(
    bool stopRequested, bool exclusive, uint32_t fifoFrames,
    uint32_t renderFrames, uint64_t nowNs, uint64_t deadlineNs) noexcept;
WasapiPrimeAcquireAction classifyWasapiPrimeAcquire(int32_t result) noexcept;
bool wasapiKnownStop(bool stopRequested, bool routeLost,
                     bool routeTerminal) noexcept;
bool wasapiComSucceeded(int32_t result) noexcept;
int32_t wasapiPreserveFirstFailure(int32_t first,
                                   int32_t candidate) noexcept;
bool wasapiRuntimeFailureIsDeviceLost(int32_t result) noexcept;
AudioHostError wasapiOpenErrorForState(
    AudioHostError preparedError, WasapiLifecycleState state) noexcept;

using WasapiExclusiveChannelProbe =
    int32_t (*)(void* context, uint32_t channels) noexcept;
uint32_t chooseWasapiExclusiveChannelCount(
    uint32_t requiredChannels, uint32_t maximumChannels, void* context,
    WasapiExclusiveChannelProbe probe, int32_t* lastResult) noexcept;

WasapiOwnerArbiterPlan wasapiOwnerArbiterPlan(
    bool stopSignaled, bool captureSignaled, bool renderSignaled,
    bool exclusive) noexcept;
WasapiCaptureRenderState beginWasapiCaptureRenderState(
    bool renderObservedBeforeDrain) noexcept;
bool shouldPollWasapiRenderAfterCaptureDrain(
    const WasapiCaptureRenderState& state) noexcept;
bool publishWasapiRenderAfterCaptureDrain(
    WasapiCaptureRenderState* state, bool renderObserved) noexcept;
bool claimWasapiCaptureRenderRequest(
    WasapiCaptureRenderState* state) noexcept;

// Shared by the backend owner and IMMNotificationClient without retaining a
// backend pointer. A failed notification unregister may quarantine this state
// together with its still-live stop event.
class WasapiRouteLossContext final {
 public:
  struct Snapshot {
    uint64_t generation{0};
    WasapiLifecycleState state{WasapiLifecycleState::Opening};
    bool lost{false};
  };
  WasapiRouteLossContext(uint64_t initialGeneration,
                         void* stopEvent) noexcept;
  void markLost() noexcept;
  bool lost() const noexcept;
  Snapshot snapshot() const noexcept;
  uint64_t generation() const noexcept;
  WasapiLifecycleState lifecycleState() const noexcept;
  bool publishOpen(uint64_t expectedGeneration) noexcept;
  bool beginStart() noexcept;
  bool publishRunning(uint64_t expectedGeneration) noexcept;
  void markError() noexcept;
  void markStopped() noexcept;

 private:
  std::atomic<bool> lossClaimed_{false};
  std::atomic<bool> lost_{false};
  std::atomic<uint64_t> generation_{0};
  std::atomic<uint32_t> lifecycleState_{
      static_cast<uint32_t>(WasapiLifecycleState::Opening)};
  void* const stopEvent_{nullptr};
};

WasapiStartupFailureDecision classifyWasapiStartupFailure(
    WasapiStartupStage stage, int32_t result) noexcept;
bool publishWasapiStartupFailure(
    WasapiStartupFailureState* state, WasapiStartupStage stage,
    int32_t result) noexcept;
WasapiStartupFailureState copyWasapiStartupFailure(
    const WasapiStartupFailureState& state) noexcept;
WasapiStartupFailureDecision resolveWasapiStartupFailure(
    const WasapiStartupFailureState& published,
    const WasapiRouteLossContext::Snapshot& postJoinRoute) noexcept;
void applyWasapiStartupFailure(
    WasapiRouteLossContext* route, WasapiStartupStage stage,
    int32_t result) noexcept;

bool nextWasapiRouteGeneration(uint64_t seed, uint64_t previousGeneration,
                               uint64_t* nextGeneration) noexcept;

bool chooseWasapiSharedPeriod(uint32_t requestedFrames,
                              uint32_t fundamentalFrames,
                              uint32_t minimumFrames,
                              uint32_t maximumFrames,
                              uint32_t* selectedFrames) noexcept;

bool wasapiRequestedSharedRateMatches(uint32_t requestedRate,
                                      uint32_t activeRate) noexcept;
bool wasapiFitsMaximumFrames(uint32_t frames,
                            uint32_t maximumFrames) noexcept;
AudioHostError classifyWasapiOpenFailure(
    WasapiOpenStage stage, bool callerSupplied,
    WasapiOpenOutcome outcome, int32_t result) noexcept;
AudioHostError classifyWasapiPairing(
    WasapiPairingStage stage, WasapiPairingOutcome outcome,
    int32_t result) noexcept;
WasapiOptionalOpenAction classifyWasapiOptionalOpenResult(
    WasapiOptionalOpenStage stage, int32_t result,
    bool valueValid) noexcept;
WasapiClient3QueryAction classifyWasapiClient3Query(
    int32_t result, bool explicitPeriod) noexcept;
AudioHostError classifyWasapiSharedFormatProfile(
    uint32_t requestedRate, uint32_t activeRate,
    int32_t probeResult) noexcept;
AudioHostError classifyWasapiCurrentSharedPeriod(
    int32_t result, bool formatMatch, uint32_t requestedFrames,
    uint32_t selectedFrames, uint32_t actualFrames) noexcept;
bool wasapiSemanticFloatFormatMatches(
    const WAVEFORMATEX* initialized,
    const WAVEFORMATEX* current) noexcept;
AudioHostError classifyWasapiCurrentSharedProfile(
    int32_t result, const WAVEFORMATEX* initialized,
    const WAVEFORMATEX* current, uint32_t requestedFrames,
    uint32_t selectedFrames, uint32_t actualFrames) noexcept;
WasapiClockPositionAction classifyWasapiClockPosition(
    int32_t result) noexcept;
WasapiExclusiveAlignmentAction classifyWasapiExclusiveAlignment(
    int32_t initializeResult, int32_t bufferResult,
    uint32_t alignedFrames) noexcept;

bool validWasapiChannelMap(const uint32_t* channels, uint32_t channelCount,
                           uint32_t endpointChannels) noexcept;

void planarToInterleavedFloat(const float* const* planar,
                              uint32_t planarChannels,
                              const uint32_t* endpointMap,
                              uint32_t endpointChannels, uint32_t frames,
                              float* interleaved) noexcept;

uint64_t wasapiClockUnitsToFrames(uint64_t position, uint64_t frequency,
                                  uint32_t sampleRate) noexcept;
uint64_t wasapiAdvanceNsByFrames(uint64_t hostNs, uint64_t frames,
                                 uint32_t sampleRate) noexcept;
WasapiOutputTimestampProjection projectWasapiOutputTimestamp(
    WasapiClockPositionAction action, uint64_t clockPosition,
    uint64_t clockQpc100ns, uint64_t clockFrequency,
    uint64_t submittedFrames, uint32_t sampleRate,
    uint64_t fallbackHostNs) noexcept;
uint64_t wasapiFramesToReferenceTime(uint32_t frames,
                                     uint32_t sampleRate) noexcept;
uint32_t wasapiReferenceTimeToFramesCeil(int64_t referenceTime,
                                         uint32_t sampleRate) noexcept;
WasapiSharedAttemptAction classifyWasapiSharedAttempt(
    bool client3Available, int32_t periodResult, int32_t initializeResult,
    uint32_t requestedFrames) noexcept;
bool shouldRetryWasapiExactProfile(int32_t result,
                                   uint32_t attemptsCompleted) noexcept;
bool wasapiFloatFormatRates(uint32_t sampleRate, uint32_t channels,
                            uint16_t* blockAlign,
                            uint32_t* averageBytesPerSecond) noexcept;
int64_t wasapiSignedFrameBalance(uint64_t acceptedCaptureFrames,
                                 uint64_t renderedFrames) noexcept;
bool wasapiClockPositionExact(int32_t result) noexcept;
bool wasapiExclusiveBufferMatches(uint32_t requestedFrames,
                                  uint32_t actualFrames) noexcept;
WasapiBufferAction classifyWasapiBufferResult(
    int32_t result, bool exclusive,
    uint32_t consecutiveBufferErrors) noexcept;

}  // namespace singz::detail

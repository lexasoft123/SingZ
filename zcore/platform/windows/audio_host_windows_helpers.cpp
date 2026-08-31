#include "audio_host_windows_helpers.h"

#include <audioclient.h>
#include <ks.h>
#include <ksmedia.h>

#include <algorithm>

#include <zcore/device/audio_host_render.h>

namespace singz::detail {

static_assert(std::atomic<uint64_t>::is_always_lock_free,
              "Windows AudioHost requires lock-free route generations");

namespace {

struct SemanticFloatFormat {
  bool valid{false};
  bool extensible{false};
  uint32_t sampleRate{0};
  uint32_t channels{0};
  uint32_t averageBytesPerSecond{0};
  uint16_t bitsPerSample{0};
  uint16_t blockAlign{0};
  uint32_t channelMask{0};
};

uint32_t setBitCount(uint32_t value) noexcept {
  uint32_t count = 0;
  while (value) {
    value &= value - 1;
    ++count;
  }
  return count;
}

bool canonicalBasicChannelMask(uint32_t channels,
                               uint32_t* mask) noexcept {
  if (!mask) return false;
  if (channels == 1) {
    *mask = SPEAKER_FRONT_CENTER;
    return true;
  }
  if (channels == 2) {
    *mask = SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT;
    return true;
  }
  return false;
}

SemanticFloatFormat semanticFloatFormat(
    const WAVEFORMATEX* format) noexcept {
  SemanticFloatFormat result;
  if (!format || !format->nSamplesPerSec || !format->nChannels ||
      format->wBitsPerSample != 32) {
    return result;
  }
  const uint64_t expectedAlign =
      static_cast<uint64_t>(format->nChannels) * sizeof(float);
  const uint64_t expectedAverage =
      static_cast<uint64_t>(format->nSamplesPerSec) * expectedAlign;
  if (expectedAlign > UINT16_MAX || expectedAverage > UINT32_MAX ||
      format->nBlockAlign != expectedAlign ||
      format->nAvgBytesPerSec != expectedAverage) {
    return result;
  }
  if (format->wFormatTag == WAVE_FORMAT_IEEE_FLOAT &&
      format->cbSize == 0) {
    result.valid = true;
  } else if (format->wFormatTag == WAVE_FORMAT_EXTENSIBLE &&
             format->cbSize >=
                 sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX)) {
    const auto* extensible =
        reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(format);
    if (!IsEqualGUID(extensible->SubFormat,
                     KSDATAFORMAT_SUBTYPE_IEEE_FLOAT) ||
        extensible->Samples.wValidBitsPerSample != 32 ||
        (extensible->dwChannelMask != 0 &&
         setBitCount(extensible->dwChannelMask) != format->nChannels)) {
      return result;
    }
    result.valid = true;
    result.extensible = true;
    result.channelMask = extensible->dwChannelMask;
  } else {
    return result;
  }
  result.sampleRate = format->nSamplesPerSec;
  result.channels = format->nChannels;
  result.averageBytesPerSecond = format->nAvgBytesPerSec;
  result.bitsPerSample = format->wBitsPerSample;
  result.blockAlign = format->nBlockAlign;
  return result;
}

}  // namespace

WasapiRouteLossContext::WasapiRouteLossContext(
    uint64_t initialGeneration, void* stopEvent) noexcept
    : generation_(initialGeneration), stopEvent_(stopEvent) {}

void WasapiRouteLossContext::markLost() noexcept {
  if (!lossClaimed_.exchange(true, std::memory_order_acq_rel)) {
    const uint64_t generation = generation_.load(std::memory_order_relaxed);
    generation_.store(generation == UINT64_MAX ? UINT64_MAX : generation + 1,
                      std::memory_order_relaxed);
    lifecycleState_.store(
        static_cast<uint32_t>(WasapiLifecycleState::DeviceLost),
        std::memory_order_relaxed);
    // The release publication comes last: an observer that sees lost also
    // sees the advanced generation and DeviceLost lifecycle state.
    lost_.store(true, std::memory_order_release);
  }
  if (stopEvent_) SetEvent(static_cast<HANDLE>(stopEvent_));
}

bool WasapiRouteLossContext::lost() const noexcept {
  return lost_.load(std::memory_order_acquire);
}

WasapiRouteLossContext::Snapshot WasapiRouteLossContext::snapshot() const
    noexcept {
  for (;;) {
    const bool lostBefore = lost_.load(std::memory_order_acquire);
    const uint64_t generation = generation_.load(std::memory_order_relaxed);
    const auto state = static_cast<WasapiLifecycleState>(
        lifecycleState_.load(std::memory_order_acquire));
    const bool lostAfter = lost_.load(std::memory_order_acquire);
    if (lostBefore == lostAfter &&
        (lostAfter || state != WasapiLifecycleState::DeviceLost))
      return {generation, state, lostAfter};
    // Loss is monotonic. One retry after its release publication observes the
    // preceding relaxed generation/state stores on weakly ordered CPUs.
  }
}

uint64_t WasapiRouteLossContext::generation() const noexcept {
  return snapshot().generation;
}

WasapiLifecycleState WasapiRouteLossContext::lifecycleState() const noexcept {
  return static_cast<WasapiLifecycleState>(
      lifecycleState_.load(std::memory_order_acquire));
}

bool WasapiRouteLossContext::publishOpen(
    uint64_t expectedGeneration) noexcept {
  if (lost_.load(std::memory_order_acquire) ||
      generation_.load(std::memory_order_relaxed) != expectedGeneration)
    return false;
  uint32_t expected = static_cast<uint32_t>(WasapiLifecycleState::Opening);
  if (!lifecycleState_.compare_exchange_strong(
          expected, static_cast<uint32_t>(WasapiLifecycleState::Open),
          std::memory_order_acq_rel, std::memory_order_acquire))
    return false;
  return !lost_.load(std::memory_order_acquire) &&
         generation_.load(std::memory_order_relaxed) == expectedGeneration &&
         lifecycleState() == WasapiLifecycleState::Open;
}

bool WasapiRouteLossContext::beginStart() noexcept {
  uint32_t expected = static_cast<uint32_t>(WasapiLifecycleState::Open);
  return lifecycleState_.compare_exchange_strong(
      expected, static_cast<uint32_t>(WasapiLifecycleState::Starting),
      std::memory_order_acq_rel, std::memory_order_acquire);
}

bool WasapiRouteLossContext::publishRunning(
    uint64_t expectedGeneration) noexcept {
  if (lost_.load(std::memory_order_acquire) ||
      generation_.load(std::memory_order_relaxed) != expectedGeneration)
    return false;
  uint32_t expected = static_cast<uint32_t>(WasapiLifecycleState::Starting);
  if (!lifecycleState_.compare_exchange_strong(
          expected, static_cast<uint32_t>(WasapiLifecycleState::Running),
          std::memory_order_acq_rel, std::memory_order_acquire))
    return false;
  return !lost_.load(std::memory_order_acquire) &&
         generation_.load(std::memory_order_relaxed) == expectedGeneration &&
         lifecycleState() == WasapiLifecycleState::Running;
}

void WasapiRouteLossContext::markError() noexcept {
  uint32_t current = lifecycleState_.load(std::memory_order_acquire);
  for (;;) {
    const auto state = static_cast<WasapiLifecycleState>(current);
    if (state == WasapiLifecycleState::DeviceLost ||
        state == WasapiLifecycleState::Stopped ||
        state == WasapiLifecycleState::Error)
      return;
    if (lifecycleState_.compare_exchange_weak(
            current, static_cast<uint32_t>(WasapiLifecycleState::Error),
            std::memory_order_acq_rel, std::memory_order_acquire))
      return;
  }
}

void WasapiRouteLossContext::markStopped() noexcept {
  uint32_t current = lifecycleState_.load(std::memory_order_acquire);
  for (;;) {
    const auto state = static_cast<WasapiLifecycleState>(current);
    if (state == WasapiLifecycleState::DeviceLost ||
        state == WasapiLifecycleState::Error ||
        state == WasapiLifecycleState::Stopped)
      return;
    if (lifecycleState_.compare_exchange_weak(
            current, static_cast<uint32_t>(WasapiLifecycleState::Stopped),
            std::memory_order_acq_rel, std::memory_order_acquire))
      return;
  }
}

WasapiStartupFailureDecision classifyWasapiStartupFailure(
    WasapiStartupStage stage, int32_t result) noexcept {
  (void)stage;
  if (wasapiRuntimeFailureIsDeviceLost(result)) {
    return {AudioHostError::DeviceNotFound,
            WasapiLifecycleState::DeviceLost};
  }
  return {AudioHostError::ProviderFailure, WasapiLifecycleState::Error};
}

bool publishWasapiStartupFailure(
    WasapiStartupFailureState* state, WasapiStartupStage stage,
    int32_t result) noexcept {
  if (!state || state->hasFailure) return false;
  state->hasFailure = true;
  state->stage = stage;
  state->result = result;
  return true;
}

WasapiStartupFailureState copyWasapiStartupFailure(
    const WasapiStartupFailureState& state) noexcept {
  return state;
}

WasapiStartupFailureDecision resolveWasapiStartupFailure(
    const WasapiStartupFailureState& published,
    const WasapiRouteLossContext::Snapshot& postJoinRoute) noexcept {
  const WasapiStartupFailureDecision first =
      published.hasFailure
          ? classifyWasapiStartupFailure(published.stage, published.result)
          : WasapiStartupFailureDecision{};
  // A coherent route loss observed after the owner has joined is more recent
  // than a previously published generic failure. Conversely, a first-fault
  // invalidation cannot be downgraded by a later generic Stop failure.
  if (postJoinRoute.lost ||
      postJoinRoute.state == WasapiLifecycleState::DeviceLost ||
      first.state == WasapiLifecycleState::DeviceLost) {
    return {AudioHostError::DeviceNotFound,
            WasapiLifecycleState::DeviceLost};
  }
  return {AudioHostError::ProviderFailure, WasapiLifecycleState::Error};
}

void applyWasapiStartupFailure(
    WasapiRouteLossContext* route, WasapiStartupStage stage,
    int32_t result) noexcept {
  if (!route) return;
  const WasapiStartupFailureDecision decision =
      classifyWasapiStartupFailure(stage, result);
  if (decision.state == WasapiLifecycleState::DeviceLost)
    route->markLost();
  else
    route->markError();
}

bool nextWasapiRouteGeneration(uint64_t seed, uint64_t previousGeneration,
                               uint64_t* nextGeneration) noexcept {
  if (!nextGeneration) return false;
  const uint64_t previous = std::max(seed, previousGeneration);
  if (previous == UINT64_MAX) return false;
  *nextGeneration = previous + 1;
  return true;
}

bool chooseWasapiSharedPeriod(uint32_t requestedFrames,
                              uint32_t fundamentalFrames,
                              uint32_t minimumFrames,
                              uint32_t maximumFrames,
                              uint32_t* selectedFrames) noexcept {
  if (selectedFrames == nullptr || fundamentalFrames == 0 ||
      minimumFrames == 0 || maximumFrames < minimumFrames) {
    return false;
  }
  uint32_t selected = requestedFrames;
  if (selected == 0) {
    const uint32_t remainder = minimumFrames % fundamentalFrames;
    if (remainder == 0) {
      selected = minimumFrames;
    } else if (minimumFrames <= UINT32_MAX - (fundamentalFrames - remainder)) {
      selected = minimumFrames + fundamentalFrames - remainder;
    } else {
      return false;
    }
  }
  if (selected < minimumFrames || selected > maximumFrames ||
      selected % fundamentalFrames != 0) {
    return false;
  }
  *selectedFrames = selected;
  return true;
}

bool wasapiRequestedSharedRateMatches(uint32_t requestedRate,
                                      uint32_t activeRate) noexcept {
  return activeRate != 0 &&
         (requestedRate == 0 || requestedRate == activeRate);
}

bool wasapiFitsMaximumFrames(uint32_t frames,
                            uint32_t maximumFrames) noexcept {
  return maximumFrames != 0 && frames <= maximumFrames;
}

AudioHostError classifyWasapiOpenFailure(
    WasapiOpenStage stage, bool callerSupplied,
    WasapiOpenOutcome outcome, int32_t result) noexcept {
  if (wasapiRuntimeFailureIsDeviceLost(result))
    return AudioHostError::DeviceNotFound;
  if (stage == WasapiOpenStage::DeviceLookup &&
      result == HRESULT_FROM_WIN32(ERROR_NOT_FOUND))
    return AudioHostError::DeviceNotFound;
  if (outcome == WasapiOpenOutcome::ProviderUnsupported)
    return AudioHostError::Unsupported;
  const bool callerRejectionProven =
      result == S_OK || result == S_FALSE ||
      (outcome == WasapiOpenOutcome::CallerExactTopologyRejected &&
       result == AUDCLNT_E_UNSUPPORTED_FORMAT);
  if (callerSupplied && callerRejectionProven) {
    switch (outcome) {
      case WasapiOpenOutcome::CallerRateMismatch:
      case WasapiOpenOutcome::CallerPeriodRejected:
      case WasapiOpenOutcome::CallerChannelMapRejected:
      case WasapiOpenOutcome::CallerExactTopologyRejected:
      case WasapiOpenOutcome::CallerAlignmentMismatch:
      case WasapiOpenOutcome::CallerMaximumFramesExceeded:
        return AudioHostError::InvalidConfiguration;
      case WasapiOpenOutcome::ApiFailure:
      case WasapiOpenOutcome::MalformedAutomaticValue:
      case WasapiOpenOutcome::ProviderUnsupported:
        break;
    }
  }
  return AudioHostError::ProviderFailure;
}

AudioHostError classifyWasapiPairing(
    WasapiPairingStage stage, WasapiPairingOutcome outcome,
    int32_t result) noexcept {
  (void)stage;
  if (wasapiRuntimeFailureIsDeviceLost(result))
    return AudioHostError::DeviceNotFound;
  // Semantic pairing outcomes are meaningful only after the corresponding
  // COM call succeeded.  Never let a generic HRESULT inherit a semantic
  // classification merely because a caller supplied the wrong outcome.
  if (result < 0) return AudioHostError::ProviderFailure;
  switch (outcome) {
    case WasapiPairingOutcome::Success:
      return AudioHostError::None;
    case WasapiPairingOutcome::Inactive:
      return AudioHostError::DeviceNotFound;
    case WasapiPairingOutcome::MissingOrMalformedContainer:
    case WasapiPairingOutcome::ContainerMismatch:
      return AudioHostError::DifferentDevicesUnsupported;
    case WasapiPairingOutcome::ApiFailure:
      return AudioHostError::ProviderFailure;
  }
  return AudioHostError::ProviderFailure;
}

WasapiOptionalOpenAction classifyWasapiOptionalOpenResult(
    WasapiOptionalOpenStage stage, int32_t result,
    bool valueValid) noexcept {
  (void)stage;
  if (wasapiRuntimeFailureIsDeviceLost(result))
    return WasapiOptionalOpenAction::FailDeviceLost;
  return result == S_OK && valueValid
             ? WasapiOptionalOpenAction::UseValue
             : WasapiOptionalOpenAction::UseFallback;
}

WasapiClient3QueryAction classifyWasapiClient3Query(
    int32_t result, bool explicitPeriod) noexcept {
  if (result == S_OK) return WasapiClient3QueryAction::UseClient3;
  if (result == E_NOINTERFACE)
    return explicitPeriod ? WasapiClient3QueryAction::Unsupported
                          : WasapiClient3QueryAction::LegacyFallback;
  return WasapiClient3QueryAction::Fail;
}

AudioHostError classifyWasapiSharedFormatProfile(
    uint32_t requestedRate, uint32_t activeRate,
    int32_t probeResult) noexcept {
  if (!wasapiRequestedSharedRateMatches(requestedRate, activeRate)) {
    return classifyWasapiOpenFailure(
        WasapiOpenStage::RequestValidation, true,
        WasapiOpenOutcome::CallerRateMismatch, S_OK);
  }
  if (probeResult == S_OK) return AudioHostError::None;
  // Once the optional caller rate has matched, the float32 shared format is
  // constructed from the endpoint's active profile. IsFormatSupported is
  // therefore a provider/profile decision, not caller provenance.
  return classifyWasapiOpenFailure(
      WasapiOpenStage::FormatProbe, false, WasapiOpenOutcome::ApiFailure,
      probeResult);
}

bool wasapiSemanticFloatFormatMatches(
    const WAVEFORMATEX* initialized,
    const WAVEFORMATEX* current) noexcept {
  const SemanticFloatFormat expected = semanticFloatFormat(initialized);
  const SemanticFloatFormat observed = semanticFloatFormat(current);
  if (!expected.valid || !observed.valid ||
      expected.sampleRate != observed.sampleRate ||
      expected.channels != observed.channels ||
      expected.averageBytesPerSecond != observed.averageBytesPerSecond ||
      expected.bitsPerSample != observed.bitsPerSample ||
      expected.blockAlign != observed.blockAlign) {
    return false;
  }
  // WAVE_FORMAT_IEEE_FLOAT has no mask field. Treat it as the equivalent
  // basic representation only for the canonical mono/stereo layout. For
  // channel counts without a defined basic layout, equivalence cannot be
  // proven. Extensible profiles always carry their exact layout contract.
  if (expected.extensible && observed.extensible)
    return expected.channelMask == observed.channelMask;
  if (!expected.extensible && !observed.extensible) return true;
  uint32_t canonicalMask = 0;
  if (!canonicalBasicChannelMask(expected.channels, &canonicalMask))
    return false;
  return (expected.extensible ? expected.channelMask
                              : observed.channelMask) == canonicalMask;
}

AudioHostError classifyWasapiCurrentSharedPeriod(
    int32_t result, bool formatMatch, uint32_t requestedFrames,
    uint32_t selectedFrames, uint32_t actualFrames) noexcept {
  if (result != S_OK) {
    return classifyWasapiOpenFailure(
        WasapiOpenStage::SharedPeriod, false,
        WasapiOpenOutcome::ApiFailure, result);
  }
  // InitializeSharedAudioStream accepted selectedFrames. A different current
  // profile is endpoint churn, even when selectedFrames originated in an
  // explicit request; it is not a newly proven caller rejection.
  if (!formatMatch || !selectedFrames || !actualFrames ||
      actualFrames != selectedFrames ||
      (requestedFrames != 0 && requestedFrames != selectedFrames)) {
    return AudioHostError::ProviderFailure;
  }
  return AudioHostError::None;
}

AudioHostError classifyWasapiCurrentSharedProfile(
    int32_t result, const WAVEFORMATEX* initialized,
    const WAVEFORMATEX* current, uint32_t requestedFrames,
    uint32_t selectedFrames, uint32_t actualFrames) noexcept {
  // HRESULT provenance is authoritative. In particular, some providers may
  // return an allocated out pointer together with failure; ownership remains
  // with the caller, but the bytes are not a valid format to inspect.
  if (result != S_OK) {
    return classifyWasapiCurrentSharedPeriod(
        result, false, requestedFrames, selectedFrames, actualFrames);
  }
  return classifyWasapiCurrentSharedPeriod(
      result, wasapiSemanticFloatFormatMatches(initialized, current),
      requestedFrames, selectedFrames, actualFrames);
}

WasapiClockPositionAction classifyWasapiClockPosition(
    int32_t result) noexcept {
  if (result == S_OK) return WasapiClockPositionAction::UseHardware;
  if (wasapiRuntimeFailureIsDeviceLost(result))
    return WasapiClockPositionAction::FailDeviceLost;
  return WasapiClockPositionAction::UseQpcFallback;
}

WasapiExclusiveAlignmentAction classifyWasapiExclusiveAlignment(
    int32_t initializeResult, int32_t bufferResult,
    uint32_t alignedFrames) noexcept {
  if (initializeResult != AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED)
    return WasapiExclusiveAlignmentAction::NotRequired;
  return bufferResult >= 0 && alignedFrames != 0
             ? WasapiExclusiveAlignmentAction::ReactivateAligned
             : WasapiExclusiveAlignmentAction::Fail;
}

bool validWasapiChannelMap(const uint32_t* channels, uint32_t channelCount,
                           uint32_t endpointChannels) noexcept {
  if (channels == nullptr || channelCount == 0 ||
      channelCount > kAudioHostMaxChannels || endpointChannels == 0) {
    return false;
  }
  for (uint32_t index = 0; index < channelCount; ++index) {
    if (channels[index] >= endpointChannels) return false;
    for (uint32_t previous = 0; previous < index; ++previous) {
      if (channels[index] == channels[previous]) return false;
    }
  }
  return true;
}

void planarToInterleavedFloat(const float* const* planar,
                              uint32_t planarChannels,
                              const uint32_t* endpointMap,
                              uint32_t endpointChannels, uint32_t frames,
                              float* interleaved) noexcept {
  if (interleaved == nullptr || endpointChannels == 0) return;
  std::fill_n(interleaved, static_cast<size_t>(endpointChannels) * frames,
              0.0F);
  if (planar == nullptr || endpointMap == nullptr) return;
  for (uint32_t channel = 0; channel < planarChannels; ++channel) {
    if (planar[channel] == nullptr || endpointMap[channel] >= endpointChannels)
      continue;
    for (uint32_t frame = 0; frame < frames; ++frame) {
      interleaved[static_cast<size_t>(frame) * endpointChannels +
                  endpointMap[channel]] = planar[channel][frame];
    }
  }
}

uint64_t wasapiClockUnitsToFrames(uint64_t position, uint64_t frequency,
                                  uint32_t sampleRate) noexcept {
  if (frequency == 0 || sampleRate == 0) return 0;
  const uint64_t seconds = position / frequency;
  const uint64_t remainder = position % frequency;
  if (seconds > UINT64_MAX / sampleRate) return UINT64_MAX;
  const uint64_t whole = seconds * sampleRate;
  const uint64_t fraction = remainder <= UINT64_MAX / sampleRate
                                ? remainder * sampleRate / frequency
                                : static_cast<uint64_t>(
                                      static_cast<long double>(remainder) *
                                      sampleRate / frequency);
  return fraction > UINT64_MAX - whole ? UINT64_MAX : whole + fraction;
}

uint64_t wasapiAdvanceNsByFrames(uint64_t hostNs, uint64_t frames,
                                 uint32_t sampleRate) noexcept {
  if (sampleRate == 0) return hostNs;
  const uint64_t seconds = frames / sampleRate;
  const uint64_t remainder = frames % sampleRate;
  if (seconds > (UINT64_MAX - hostNs) / 1000000000ull) return UINT64_MAX;
  const uint64_t whole = seconds * 1000000000ull;
  const uint64_t fraction = remainder * 1000000000ull / sampleRate;
  if (whole > UINT64_MAX - hostNs ||
      fraction > UINT64_MAX - hostNs - whole) return UINT64_MAX;
  return hostNs + whole + fraction;
}

WasapiOutputTimestampProjection projectWasapiOutputTimestamp(
    WasapiClockPositionAction action, uint64_t clockPosition,
    uint64_t clockQpc100ns, uint64_t clockFrequency,
    uint64_t submittedFrames, uint32_t sampleRate,
    uint64_t fallbackHostNs) noexcept {
  WasapiOutputTimestampProjection projection{fallbackHostNs, false};
  if (action != WasapiClockPositionAction::UseHardware ||
      clockFrequency == 0 || sampleRate == 0 || clockQpc100ns == 0 ||
      clockQpc100ns > UINT64_MAX / 100ull) {
    return projection;
  }
  const uint64_t playedFrames =
      wasapiClockUnitsToFrames(clockPosition, clockFrequency, sampleRate);
  if (playedFrames == UINT64_MAX) return projection;
  const uint64_t pendingFrames =
      submittedFrames > playedFrames ? submittedFrames - playedFrames : 0;
  const uint64_t projectedHostNs = wasapiAdvanceNsByFrames(
      clockQpc100ns * 100ull, pendingFrames, sampleRate);
  if (projectedHostNs == 0 || projectedHostNs == UINT64_MAX)
    return projection;
  projection.hostTimeNs = projectedHostNs;
  projection.hardware = true;
  return projection;
}

uint64_t wasapiFramesToReferenceTime(uint32_t frames,
                                     uint32_t sampleRate) noexcept {
  if (frames == 0 || sampleRate == 0) return 0;
  // Microsoft documents nearest-integer rounding for the exclusive duration
  // conversion, rather than the ceiling used for latency bounds.
  return (static_cast<uint64_t>(frames) * 10000000ull + sampleRate / 2u) /
         sampleRate;
}

uint32_t wasapiReferenceTimeToFramesCeil(
    int64_t referenceTime, uint32_t sampleRate) noexcept {
  if (referenceTime <= 0 || !sampleRate) return 0;
  constexpr uint64_t kReferenceUnitsPerSecond = 10000000ull;
  const uint64_t time = static_cast<uint64_t>(referenceTime);
  const uint64_t seconds = time / kReferenceUnitsPerSecond;
  const uint64_t remainder = time % kReferenceUnitsPerSecond;
  if (seconds > UINT32_MAX / sampleRate) return UINT32_MAX;
  const uint64_t whole = seconds * sampleRate;
  const uint64_t fraction =
      (remainder * sampleRate + kReferenceUnitsPerSecond - 1) /
      kReferenceUnitsPerSecond;
  if (whole > UINT32_MAX || fraction > UINT32_MAX - whole)
    return UINT32_MAX;
  return static_cast<uint32_t>(whole + fraction);
}

WasapiSharedAttemptAction classifyWasapiSharedAttempt(
    bool client3Available, int32_t periodResult, int32_t initializeResult,
    uint32_t requestedFrames) noexcept {
  if (client3Available && periodResult >= 0 && initializeResult >= 0)
    return WasapiSharedAttemptAction::Complete;
  return requestedFrames ? WasapiSharedAttemptAction::Reject
                         : WasapiSharedAttemptAction::FreshLegacyFallback;
}

WasapiOwnerArbiterPlan wasapiOwnerArbiterPlan(
    bool stopSignaled, bool captureSignaled, bool renderSignaled,
    bool exclusive) noexcept {
  if (stopSignaled) return {true, false, false, false, false};
  const bool drain = captureSignaled || (renderSignaled && !exclusive);
  return {false, renderSignaled, drain, captureSignaled, renderSignaled};
}

WasapiCaptureRenderState beginWasapiCaptureRenderState(
    bool renderObservedBeforeDrain) noexcept {
  WasapiCaptureRenderState state;
  state.renderObservedBeforeDrain = renderObservedBeforeDrain;
  return state;
}

bool shouldPollWasapiRenderAfterCaptureDrain(
    const WasapiCaptureRenderState& state) noexcept {
  return !state.renderObservedBeforeDrain &&
         !state.postDrainPollConsumed && !state.requestClaimed;
}

bool publishWasapiRenderAfterCaptureDrain(
    WasapiCaptureRenderState* state, bool renderObserved) noexcept {
  if (!state || !shouldPollWasapiRenderAfterCaptureDrain(*state))
    return false;
  state->postDrainPollConsumed = true;
  state->renderObservedAfterDrain = renderObserved;
  return true;
}

bool claimWasapiCaptureRenderRequest(
    WasapiCaptureRenderState* state) noexcept {
  if (!state || state->requestClaimed ||
      (!state->renderObservedBeforeDrain &&
       !state->renderObservedAfterDrain)) {
    return false;
  }
  state->requestClaimed = true;
  return true;
}

WasapiOwnerStartPlan wasapiOwnerStartPlan(bool exclusive) noexcept {
  // Shared render can be filled while stopped, leaving no setup work between
  // the first capture period and render Start. Exclusive primes after capture
  // prefill, but a pre-Start acquisition failure is bounded and never waits
  // for a render event that cannot exist until Start.
  return {!exclusive, 1};
}

bool runWasapiShutdownSequence(
    const WasapiShutdownOperations& operations) noexcept {
  if (!operations.signal || !operations.join ||
      !operations.deactivateAndQuiesce || !operations.closeEvents)
    return false;
  operations.signal(operations.context);
  operations.join(operations.context);
  operations.deactivateAndQuiesce(operations.context);
  operations.closeEvents(operations.context);
  return true;
}

bool wasapiOwnerShouldAwaitCapture(bool exclusive, uint32_t fifoFrames,
                                   uint32_t renderFrames) noexcept {
  (void)exclusive;
  return renderFrames != 0 && fifoFrames < renderFrames;
}

uint64_t wasapiRenderPaddingBudgetNs(uint32_t paddingFrames,
                                     uint32_t sampleRate) noexcept {
  if (!sampleRate) return 0;
  return static_cast<uint64_t>(paddingFrames) * 1000000000ull / sampleRate;
}

uint64_t wasapiRenderDeadlineNs(uint64_t renderWakeNs,
                                uint32_t budgetFrames,
                                uint32_t sampleRate) noexcept {
  const uint64_t budgetNs =
      wasapiRenderPaddingBudgetNs(budgetFrames, sampleRate);
  return renderWakeNs > UINT64_MAX - budgetNs
             ? UINT64_MAX
             : renderWakeNs + budgetNs;
}

bool wasapiRenderDeadlineExpired(uint64_t renderWakeNs,
                                 uint64_t completionNs,
                                 uint32_t budgetFrames,
                                 uint32_t sampleRate) noexcept {
  if (!sampleRate || !budgetFrames) return true;
  return completionNs >=
         wasapiRenderDeadlineNs(renderWakeNs, budgetFrames, sampleRate);
}

bool prepareWasapiRenderRequest(bool exclusive, uint64_t observedQpcNs,
                                uint32_t bufferFrames,
                                uint32_t paddingFrames,
                                uint32_t sampleRate,
                                WasapiRenderRequest* request) noexcept {
  if (!request) return false;
  *request = {};
  if (!bufferFrames || !sampleRate ||
      (!exclusive && paddingFrames > bufferFrames)) {
    return false;
  }
  request->valid = true;
  request->exclusive = exclusive;
  request->observedQpcNs = observedQpcNs;
  request->paddingFrames = exclusive ? 0 : paddingFrames;
  request->framesToWrite =
      exclusive ? bufferFrames : bufferFrames - paddingFrames;
  request->budgetFrames =
      exclusive ? request->framesToWrite : paddingFrames;
  request->deadlineNs = wasapiRenderDeadlineNs(
      observedQpcNs, request->budgetFrames, sampleRate);
  return true;
}

bool wasapiRenderRequestExpired(const WasapiRenderRequest& request,
                                uint64_t completionNs) noexcept {
  return !request.valid || completionNs >= request.deadlineNs;
}

uint32_t wasapiRenderWaitTimeoutMs(uint64_t nowNs,
                                   uint64_t deadlineNs) noexcept {
  constexpr uint64_t kSchedulingGuardNs = 1000000ull;
  if (nowNs >= deadlineNs || deadlineNs - nowNs <= kSchedulingGuardNs)
    return 0;
  const uint64_t milliseconds =
      (deadlineNs - nowNs - kSchedulingGuardNs) / 1000000ull;
  return milliseconds > UINT32_MAX ? UINT32_MAX
                                    : static_cast<uint32_t>(milliseconds);
}

WasapiPendingRenderAction wasapiPendingRenderAction(
    bool stopRequested, bool exclusive, uint32_t fifoFrames,
    uint32_t renderFrames, uint64_t nowNs, uint64_t deadlineNs) noexcept {
  if (stopRequested) return WasapiPendingRenderAction::Stop;
  // The pending request owns a fixed hardware-derived budget. Once expired,
  // late FIFO publication cannot revive it or allow buffer acquisition/graph
  // work after the deadline.
  if (nowNs >= deadlineNs) return WasapiPendingRenderAction::FailDeadline;
  if (!wasapiOwnerShouldAwaitCapture(exclusive, fifoFrames, renderFrames))
    return WasapiPendingRenderAction::Render;
  return WasapiPendingRenderAction::WaitForCapture;
}

WasapiPrimeAcquireAction classifyWasapiPrimeAcquire(
    int32_t result) noexcept {
  return result == S_OK ? WasapiPrimeAcquireAction::Proceed
                        : WasapiPrimeAcquireAction::Fail;
}

bool wasapiKnownStop(bool stopRequested, bool routeLost,
                     bool routeTerminal) noexcept {
  return stopRequested || routeLost || routeTerminal;
}

bool wasapiComSucceeded(int32_t result) noexcept { return result >= 0; }

int32_t wasapiPreserveFirstFailure(int32_t first,
                                   int32_t candidate) noexcept {
  return first >= 0 && candidate < 0 ? candidate : first;
}

bool wasapiRuntimeFailureIsDeviceLost(int32_t result) noexcept {
  return result == AUDCLNT_E_DEVICE_INVALIDATED ||
         result == AUDCLNT_E_RESOURCES_INVALIDATED ||
         result == AUDCLNT_E_SERVICE_NOT_RUNNING;
}

AudioHostError wasapiOpenErrorForState(
    AudioHostError preparedError, WasapiLifecycleState state) noexcept {
  return state == WasapiLifecycleState::DeviceLost
             ? AudioHostError::DeviceNotFound
             : preparedError;
}

uint32_t chooseWasapiExclusiveChannelCount(
    uint32_t requiredChannels, uint32_t maximumChannels, void* context,
    WasapiExclusiveChannelProbe probe, int32_t* lastResult) noexcept {
  if (lastResult) *lastResult = E_INVALIDARG;
  if (!requiredChannels || requiredChannels > maximumChannels || !probe)
    return 0;
  for (uint32_t channels = requiredChannels;; ++channels) {
    const int32_t result = probe(context, channels);
    if (lastResult) *lastResult = result;
    if (result == S_OK) return channels;
    if (result != AUDCLNT_E_UNSUPPORTED_FORMAT && result != S_FALSE)
      return 0;
    if (channels == maximumChannels) break;
  }
  return 0;
}

bool WasapiOnceOperation::begin() noexcept {
  if (stage_ != WasapiOnceStage::Idle) return false;
  stage_ = WasapiOnceStage::Pending;
  return true;
}

bool WasapiOnceOperation::markAcquired() noexcept {
  if (stage_ != WasapiOnceStage::Pending) return false;
  stage_ = WasapiOnceStage::Acquired;
  return true;
}

bool WasapiOnceOperation::markAdvanced() noexcept {
  if (stage_ != WasapiOnceStage::Acquired) return false;
  stage_ = WasapiOnceStage::Advanced;
  ++advances_;
  return true;
}

bool WasapiOnceOperation::finishRelease(int32_t result) noexcept {
  if (stage_ != WasapiOnceStage::Acquired &&
      stage_ != WasapiOnceStage::Advanced)
    return false;
  if (!wasapiComSucceeded(result)) {
    stage_ = WasapiOnceStage::Failed;
    return false;
  }
  stage_ = WasapiOnceStage::Complete;
  return true;
}

void WasapiOnceOperation::fail() noexcept {
  if (stage_ != WasapiOnceStage::Complete)
    stage_ = WasapiOnceStage::Failed;
}

bool shouldRetryWasapiExactProfile(
    int32_t result, uint32_t attemptsCompleted) noexcept {
  // Some shared-engine APO stacks transiently return REGDB_E_CLASSNOTREG as a
  // just-stopped client is reopened. Retry the identical exact profile only;
  // this is not a format or access-mode fallback.
  return result == REGDB_E_CLASSNOTREG &&
         attemptsCompleted < kWasapiMaximumExactProfileAttempts;
}

bool wasapiFloatFormatRates(uint32_t sampleRate, uint32_t channels,
                            uint16_t* blockAlign,
                            uint32_t* averageBytesPerSecond) noexcept {
  if (!sampleRate || !channels || !blockAlign || !averageBytesPerSecond)
    return false;
  const uint64_t align = static_cast<uint64_t>(channels) * sizeof(float);
  const uint64_t average = static_cast<uint64_t>(sampleRate) * align;
  if (align > UINT16_MAX || average > UINT32_MAX) return false;
  *blockAlign = static_cast<uint16_t>(align);
  *averageBytesPerSecond = static_cast<uint32_t>(average);
  return true;
}

int64_t wasapiSignedFrameBalance(uint64_t acceptedCaptureFrames,
                                 uint64_t renderedFrames) noexcept {
  if (acceptedCaptureFrames >= renderedFrames) {
    const uint64_t difference = acceptedCaptureFrames - renderedFrames;
    return difference > static_cast<uint64_t>(INT64_MAX)
               ? INT64_MAX
               : static_cast<int64_t>(difference);
  }
  const uint64_t difference = renderedFrames - acceptedCaptureFrames;
  return difference > static_cast<uint64_t>(INT64_MAX)
             ? INT64_MIN
             : -static_cast<int64_t>(difference);
}

bool wasapiClockPositionExact(int32_t result) noexcept {
  return result == S_OK;
}

bool wasapiExclusiveBufferMatches(uint32_t requestedFrames,
                                  uint32_t actualFrames) noexcept {
  return requestedFrames == 0 || requestedFrames == actualFrames;
}

WasapiBufferAction classifyWasapiBufferResult(
    int32_t result, bool exclusive,
    uint32_t consecutiveBufferErrors) noexcept {
  if (result == S_OK) return WasapiBufferAction::Proceed;
  if (result == AUDCLNT_S_BUFFER_EMPTY) return WasapiBufferAction::Empty;
  if (exclusive && result == AUDCLNT_E_BUFFER_ERROR) {
    return consecutiveBufferErrors < kWasapiMaximumConsecutiveBufferErrors
               ? WasapiBufferAction::Retry
               : WasapiBufferAction::Fail;
  }
  return WasapiBufferAction::Fail;
}

}  // namespace singz::detail

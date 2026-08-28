#include <zcore/device/audio_host.h>
#include <zcore/device/audio_host_callback.h>

#include <audioclient.h>
#include <ks.h>
#include <ksmedia.h>

#include <cstdio>
#include <cstdlib>
#include <atomic>
#include <memory>
#include <thread>
#include <vector>

#include "zcore/platform/windows/audio_host_windows_helpers.h"
#include "zcore/platform/windows/audio_input_windows_helpers.h"

#define CHECK(expression)                                                      \
  do {                                                                         \
    if (!(expression)) {                                                       \
      std::fprintf(stderr, "CHECK failed at %s:%d: %s\n", __FILE__, __LINE__, \
                   #expression);                                               \
      std::abort();                                                            \
    }                                                                          \
  } while (false)

namespace {

struct CaptureSetupTrace {
  std::vector<uint32_t> calls;
  uint32_t failStep{0};
  uint32_t releasedClients{0};
  uint32_t releasedFormats{0};
};

struct ChannelProbeTrace {
  std::vector<uint32_t> attempts;
  uint32_t supported{0};
  int32_t terminal{AUDCLNT_E_UNSUPPORTED_FORMAT};
};

int32_t traceChannelProbe(void* context, uint32_t channels) noexcept {
  auto* trace = static_cast<ChannelProbeTrace*>(context);
  trace->attempts.push_back(channels);
  if (channels == trace->supported) return S_OK;
  return trace->terminal;
}

WAVEFORMATEX basicFloatFormat(uint32_t rate = 48000,
                              uint16_t channels = 2) noexcept {
  WAVEFORMATEX format{};
  format.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
  format.nChannels = channels;
  format.nSamplesPerSec = rate;
  format.wBitsPerSample = 32;
  format.nBlockAlign = static_cast<WORD>(channels * sizeof(float));
  format.nAvgBytesPerSec = rate * format.nBlockAlign;
  return format;
}

WAVEFORMATEXTENSIBLE extensibleFloatFormat(
    uint32_t rate = 48000, uint16_t channels = 2,
    uint32_t channelMask = 3) noexcept {
  WAVEFORMATEXTENSIBLE format{};
  format.Format = basicFloatFormat(rate, channels);
  format.Format.wFormatTag = WAVE_FORMAT_EXTENSIBLE;
  format.Format.cbSize =
      sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX);
  format.Samples.wValidBitsPerSample = 32;
  format.dwChannelMask = channelMask;
  format.SubFormat = KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
  return format;
}

struct BlockingRenderTrace {
  std::atomic<bool> entered{false};
  std::atomic<bool> release{false};
};

bool blockingRender(void* context,
                    const singz::AudioHostRenderBlock&) noexcept {
  auto* trace = static_cast<BlockingRenderTrace*>(context);
  trace->entered.store(true, std::memory_order_release);
  while (!trace->release.load(std::memory_order_acquire))
    std::this_thread::yield();
  return true;
}

struct CallbackShutdownTrace {
  BlockingRenderTrace* render{nullptr};
  singz::AudioHostCallbackEndpoint* endpoint{nullptr};
  std::thread* owner{nullptr};
  std::vector<uint32_t> steps;
  bool eventsClosed{false};
};

void shutdownSignal(void* context) noexcept {
  auto* trace = static_cast<CallbackShutdownTrace*>(context);
  trace->steps.push_back(1);
  trace->render->release.store(true, std::memory_order_release);
}

void shutdownJoin(void* context) noexcept {
  auto* trace = static_cast<CallbackShutdownTrace*>(context);
  trace->steps.push_back(2);
  trace->owner->join();
}

void shutdownDeactivate(void* context) noexcept {
  auto* trace = static_cast<CallbackShutdownTrace*>(context);
  trace->steps.push_back(3);
  singz::deactivateAudioHostCallback(trace->endpoint);
}

void shutdownClose(void* context) noexcept {
  auto* trace = static_cast<CallbackShutdownTrace*>(context);
  trace->steps.push_back(4);
  trace->eventsClosed = true;
}

struct RouteShutdownTrace {
  singz::detail::WasapiRouteLossContext* route{nullptr};
  std::vector<uint32_t> steps;
};

void routeShutdownSignal(void* context) noexcept {
  static_cast<RouteShutdownTrace*>(context)->steps.push_back(1);
}

void routeShutdownJoinWithLoss(void* context) noexcept {
  auto* trace = static_cast<RouteShutdownTrace*>(context);
  trace->steps.push_back(2);
  trace->route->markLost();
}

void routeShutdownDeactivate(void* context) noexcept {
  static_cast<RouteShutdownTrace*>(context)->steps.push_back(3);
}

void routeShutdownClose(void* context) noexcept {
  static_cast<RouteShutdownTrace*>(context)->steps.push_back(4);
}

int32_t traceActivate(void* context, void** client) noexcept {
  auto* trace = static_cast<CaptureSetupTrace*>(context);
  trace->calls.push_back(1);
  if (trace->failStep == 1) return E_FAIL;
  *client = reinterpret_cast<void*>(static_cast<uintptr_t>(1));
  return S_OK;
}

int32_t traceSetProperties(void* context, void*) noexcept {
  auto* trace = static_cast<CaptureSetupTrace*>(context);
  trace->calls.push_back(2);
  return trace->failStep == 2 ? E_FAIL : S_OK;
}

int32_t traceGetMixFormat(void* context, void*, void** format) noexcept {
  auto* trace = static_cast<CaptureSetupTrace*>(context);
  trace->calls.push_back(3);
  if (trace->failStep == 3) return E_FAIL;
  if (trace->failStep != 4)
    *format = reinterpret_cast<void*>(static_cast<uintptr_t>(2));
  return S_OK;
}

void traceReleaseClient(void* context, void*) noexcept {
  ++static_cast<CaptureSetupTrace*>(context)->releasedClients;
}

void traceReleaseFormat(void* context, void*) noexcept {
  ++static_cast<CaptureSetupTrace*>(context)->releasedFormats;
}

singz::detail::WasapiCaptureSetupOperations traceOperations(
    CaptureSetupTrace* trace) {
  return {trace, traceActivate, traceSetProperties, traceGetMixFormat,
          traceReleaseClient, traceReleaseFormat};
}

struct ClockRenderTrace {
  uint32_t silentReleases{0};
  uint32_t normalReleases{0};
  uint32_t graphAdvances{0};
  bool deviceLost{false};
  singz::detail::WasapiOnceStage operationStage{
      singz::detail::WasapiOnceStage::Idle};
};

ClockRenderTrace exerciseClockRenderDecision(int32_t clockResult,
                                             int32_t releaseResult) {
  ClockRenderTrace trace;
  singz::detail::WasapiOnceOperation operation;
  CHECK(operation.begin());
  CHECK(operation.markAcquired());
  const auto action =
      singz::detail::classifyWasapiClockPosition(clockResult);
  if (action == singz::detail::WasapiClockPositionAction::FailDeviceLost) {
    ++trace.silentReleases;
    (void)operation.finishRelease(releaseResult);
    trace.deviceLost = true;
  } else {
    CHECK(operation.markAdvanced());
    ++trace.graphAdvances;
    ++trace.normalReleases;
    (void)operation.finishRelease(releaseResult);
  }
  trace.operationStage = operation.stage();
  return trace;
}

}  // namespace

int main() {
  HANDLE routeEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  CHECK(routeEvent != nullptr);
  auto route = std::make_shared<singz::detail::WasapiRouteLossContext>(
      41, routeEvent);
  const auto quarantined = route;
  CHECK(!route->lost());
  CHECK(route->generation() == 41);
  CHECK(route->publishOpen(41));
  CHECK(route->beginStart());
  std::atomic<bool> publicationValid{true};
  std::vector<std::thread> losses;
  for (uint32_t index = 0; index < 8; ++index) {
    losses.emplace_back([&] { route->markLost(); });
  }
  std::thread observer([&] {
    while (!route->lost()) std::this_thread::yield();
    const auto snapshot = route->snapshot();
    if (!snapshot.lost || snapshot.generation != 42 ||
        snapshot.state != singz::detail::WasapiLifecycleState::DeviceLost)
      publicationValid.store(false, std::memory_order_relaxed);
  });
  for (auto& loss : losses) loss.join();
  observer.join();
  CHECK(route->lost());
  CHECK(route->generation() == 42);
  CHECK(publicationValid.load(std::memory_order_relaxed));
  CHECK(!route->publishRunning(41));
  CHECK(WaitForSingleObject(routeEvent, 0) == WAIT_OBJECT_0);
  route.reset();
  CHECK(quarantined->lost());
  CHECK(quarantined->generation() == 42);
  CloseHandle(routeEvent);

  uint64_t reopenedGeneration = 0;
  CHECK(singz::detail::nextWasapiRouteGeneration(
      41, quarantined->generation(), &reopenedGeneration));
  CHECK(reopenedGeneration == 43);
  CHECK(!singz::detail::nextWasapiRouteGeneration(
      UINT64_MAX, quarantined->generation(), &reopenedGeneration));
  singz::detail::WasapiRouteLossContext exhausted(UINT64_MAX, nullptr);
  exhausted.markLost();
  CHECK(exhausted.lost());
  CHECK(exhausted.generation() == UINT64_MAX);
  CHECK(exhausted.lifecycleState() ==
        singz::detail::WasapiLifecycleState::DeviceLost);

  singz::detail::WasapiRouteLossContext lostDuringOpen(100, nullptr);
  lostDuringOpen.markLost();
  CHECK(!lostDuringOpen.publishOpen(100));
  CHECK(lostDuringOpen.lifecycleState() ==
        singz::detail::WasapiLifecycleState::DeviceLost);

  singz::detail::WasapiRouteLossContext errorDuringStart(200, nullptr);
  CHECK(errorDuringStart.publishOpen(200));
  CHECK(errorDuringStart.beginStart());
  errorDuringStart.markError();
  CHECK(!errorDuringStart.publishRunning(200));
  CHECK(errorDuringStart.lifecycleState() ==
        singz::detail::WasapiLifecycleState::Error);
  errorDuringStart.markStopped();
  CHECK(errorDuringStart.lifecycleState() ==
        singz::detail::WasapiLifecycleState::Error);

  CaptureSetupTrace captureSetup;
  void* captureClient = nullptr;
  void* captureFormat = nullptr;
  singz::detail::WasapiCaptureSetupFailure setupFailure{};
  auto setupOperations = traceOperations(&captureSetup);
  CHECK(singz::detail::runWasapiCaptureSetup(
            setupOperations, &captureClient, &captureFormat, &setupFailure) ==
        S_OK);
  CHECK(captureSetup.calls == std::vector<uint32_t>({1, 2, 3}));
  CHECK(captureClient != nullptr && captureFormat != nullptr);
  CHECK(setupFailure == singz::detail::WasapiCaptureSetupFailure::None);
  setupOperations.releaseFormat(setupOperations.context, captureFormat);
  setupOperations.releaseClient(setupOperations.context, captureClient);
  CHECK(captureSetup.releasedClients == 1);
  CHECK(captureSetup.releasedFormats == 1);

  CaptureSetupTrace failedProperties;
  failedProperties.failStep = 2;
  setupOperations = traceOperations(&failedProperties);
  CHECK(singz::detail::runWasapiCaptureSetup(
            setupOperations, &captureClient, &captureFormat, &setupFailure) ==
        E_FAIL);
  CHECK(failedProperties.calls == std::vector<uint32_t>({1, 2}));
  CHECK(captureClient == nullptr && captureFormat == nullptr);
  CHECK(setupFailure ==
        singz::detail::WasapiCaptureSetupFailure::SetProperties);
  CHECK(failedProperties.releasedClients == 1);

  CaptureSetupTrace missingFormat;
  missingFormat.failStep = 4;
  setupOperations = traceOperations(&missingFormat);
  CHECK(singz::detail::runWasapiCaptureSetup(
            setupOperations, &captureClient, &captureFormat, &setupFailure) ==
        E_UNEXPECTED);
  CHECK(missingFormat.calls == std::vector<uint32_t>({1, 2, 3}));
  CHECK(missingFormat.releasedClients == 1);

  uint32_t selected = 0;
  CHECK(singz::detail::chooseWasapiSharedPeriod(0, 16, 48, 480, &selected));
  CHECK(selected == 48);
  CHECK(singz::detail::chooseWasapiSharedPeriod(0, 16, 50, 480, &selected));
  CHECK(selected == 64);
  CHECK(singz::detail::chooseWasapiSharedPeriod(96, 16, 48, 480, &selected));
  CHECK(selected == 96);
  CHECK(!singz::detail::chooseWasapiSharedPeriod(95, 16, 48, 480, &selected));
  CHECK(!singz::detail::chooseWasapiSharedPeriod(32, 16, 48, 480, &selected));
  CHECK(!singz::detail::chooseWasapiSharedPeriod(496, 16, 48, 480, &selected));
  CHECK(!singz::detail::chooseWasapiSharedPeriod(0, 0, 48, 480, &selected));

  using OpenStage = singz::detail::WasapiOpenStage;
  using OpenOutcome = singz::detail::WasapiOpenOutcome;
  CHECK(singz::detail::wasapiRequestedSharedRateMatches(0, 48000));
  CHECK(singz::detail::wasapiRequestedSharedRateMatches(48000, 48000));
  CHECK(!singz::detail::wasapiRequestedSharedRateMatches(44100, 48000));
  CHECK(!singz::detail::wasapiRequestedSharedRateMatches(0, 0));
  CHECK(singz::detail::classifyWasapiSharedFormatProfile(
            0, 48000, S_OK) == singz::AudioHostError::None);
  CHECK(singz::detail::classifyWasapiSharedFormatProfile(
            48000, 48000, S_OK) == singz::AudioHostError::None);
  CHECK(singz::detail::classifyWasapiSharedFormatProfile(
            44100, 48000, S_OK) ==
        singz::AudioHostError::InvalidConfiguration);
  // The exact float format is constructed from the active shared profile.
  // Its rejection is provider provenance for both automatic and validated
  // explicit rates.
  CHECK(singz::detail::classifyWasapiSharedFormatProfile(
            0, 48000, S_FALSE) == singz::AudioHostError::ProviderFailure);
  CHECK(singz::detail::classifyWasapiSharedFormatProfile(
            48000, 48000, S_FALSE) ==
        singz::AudioHostError::ProviderFailure);
  CHECK(singz::detail::classifyWasapiSharedFormatProfile(
            48000, 48000, AUDCLNT_E_UNSUPPORTED_FORMAT) ==
        singz::AudioHostError::ProviderFailure);
  CHECK(singz::detail::classifyWasapiSharedFormatProfile(
            48000, 48000, AUDCLNT_E_DEVICE_INVALIDATED) ==
        singz::AudioHostError::DeviceNotFound);
  CHECK(singz::detail::classifyWasapiOpenFailure(
            OpenStage::RequestValidation, true,
            OpenOutcome::CallerRateMismatch, S_OK) ==
        singz::AudioHostError::InvalidConfiguration);
  CHECK(singz::detail::classifyWasapiOpenFailure(
            OpenStage::SharedPeriod, true,
            OpenOutcome::CallerPeriodRejected, S_OK) ==
        singz::AudioHostError::InvalidConfiguration);
  CHECK(singz::detail::classifyWasapiOpenFailure(
            OpenStage::SharedPeriod, false,
            OpenOutcome::MalformedAutomaticValue, S_OK) ==
        singz::AudioHostError::ProviderFailure);
  CHECK(singz::detail::classifyWasapiOpenFailure(
            OpenStage::SharedPeriod, false,
            OpenOutcome::ApiFailure, AUDCLNT_E_INVALID_DEVICE_PERIOD) ==
        singz::AudioHostError::ProviderFailure);
  CHECK(singz::detail::classifyWasapiOpenFailure(
            OpenStage::SharedInitialize, true,
            OpenOutcome::ApiFailure, AUDCLNT_E_INVALID_DEVICE_PERIOD) ==
        singz::AudioHostError::ProviderFailure);
  const WAVEFORMATEXTENSIBLE initializedFloat = extensibleFloatFormat();
  const WAVEFORMATEXTENSIBLE sameFloat = extensibleFloatFormat();
  const WAVEFORMATEX basicFloat = basicFloatFormat();
  CHECK(singz::detail::wasapiSemanticFloatFormatMatches(
      &initializedFloat.Format, &sameFloat.Format));
  CHECK(singz::detail::wasapiSemanticFloatFormatMatches(
      &initializedFloat.Format, &basicFloat));
  CHECK(singz::detail::wasapiSemanticFloatFormatMatches(
      &basicFloat, &initializedFloat.Format));
  const WAVEFORMATEXTENSIBLE canonicalMono =
      extensibleFloatFormat(48000, 1, SPEAKER_FRONT_CENTER);
  const WAVEFORMATEX basicMono = basicFloatFormat(48000, 1);
  CHECK(singz::detail::wasapiSemanticFloatFormatMatches(
      &canonicalMono.Format, &basicMono));
  CHECK(singz::detail::wasapiSemanticFloatFormatMatches(
      &basicMono, &canonicalMono.Format));

  WAVEFORMATEXTENSIBLE directOutStereo = initializedFloat;
  directOutStereo.dwChannelMask = 0;
  CHECK(!singz::detail::wasapiSemanticFloatFormatMatches(
      &directOutStereo.Format, &basicFloat));
  CHECK(!singz::detail::wasapiSemanticFloatFormatMatches(
      &basicFloat, &directOutStereo.Format));
  WAVEFORMATEXTENSIBLE noncanonicalStereo = initializedFloat;
  noncanonicalStereo.dwChannelMask = 12;
  CHECK(!singz::detail::wasapiSemanticFloatFormatMatches(
      &noncanonicalStereo.Format, &basicFloat));
  CHECK(!singz::detail::wasapiSemanticFloatFormatMatches(
      &basicFloat, &noncanonicalStereo.Format));
  const WAVEFORMATEX basicFourChannels = basicFloatFormat(48000, 4);
  const WAVEFORMATEXTENSIBLE extensibleFourChannels =
      extensibleFloatFormat(48000, 4, 0x33);
  CHECK(singz::detail::wasapiSemanticFloatFormatMatches(
      &basicFourChannels, &basicFourChannels));
  CHECK(!singz::detail::wasapiSemanticFloatFormatMatches(
      &basicFourChannels, &extensibleFourChannels.Format));
  CHECK(!singz::detail::wasapiSemanticFloatFormatMatches(
      &extensibleFourChannels.Format, &basicFourChannels));

  WAVEFORMATEXTENSIBLE changedRate = initializedFloat;
  changedRate.Format.nSamplesPerSec = 44100;
  changedRate.Format.nAvgBytesPerSec =
      changedRate.Format.nSamplesPerSec * changedRate.Format.nBlockAlign;
  CHECK(!singz::detail::wasapiSemanticFloatFormatMatches(
      &initializedFloat.Format, &changedRate.Format));
  const WAVEFORMATEXTENSIBLE changedChannels =
      extensibleFloatFormat(48000, 1, 4);
  CHECK(!singz::detail::wasapiSemanticFloatFormatMatches(
      &initializedFloat.Format, &changedChannels.Format));
  WAVEFORMATEX nonFloat = basicFloat;
  nonFloat.wFormatTag = WAVE_FORMAT_PCM;
  CHECK(!singz::detail::wasapiSemanticFloatFormatMatches(
      &initializedFloat.Format, &nonFloat));
  WAVEFORMATEXTENSIBLE nonFloatSubtype = initializedFloat;
  nonFloatSubtype.SubFormat = KSDATAFORMAT_SUBTYPE_PCM;
  CHECK(!singz::detail::wasapiSemanticFloatFormatMatches(
      &initializedFloat.Format, &nonFloatSubtype.Format));
  WAVEFORMATEX changedBits = basicFloat;
  changedBits.wBitsPerSample = 16;
  changedBits.nBlockAlign = 4;
  changedBits.nAvgBytesPerSec = changedBits.nSamplesPerSec * 4;
  CHECK(!singz::detail::wasapiSemanticFloatFormatMatches(
      &initializedFloat.Format, &changedBits));
  WAVEFORMATEX changedBlockAlign = basicFloat;
  ++changedBlockAlign.nBlockAlign;
  CHECK(!singz::detail::wasapiSemanticFloatFormatMatches(
      &initializedFloat.Format, &changedBlockAlign));
  WAVEFORMATEX changedAverage = basicFloat;
  ++changedAverage.nAvgBytesPerSec;
  CHECK(!singz::detail::wasapiSemanticFloatFormatMatches(
      &initializedFloat.Format, &changedAverage));
  WAVEFORMATEX basicWithExtraBytes = basicFloat;
  basicWithExtraBytes.cbSize = 2;
  CHECK(!singz::detail::wasapiSemanticFloatFormatMatches(
      &initializedFloat.Format, &basicWithExtraBytes));
  WAVEFORMATEXTENSIBLE changedMask = initializedFloat;
  changedMask.dwChannelMask = 12;
  CHECK(!singz::detail::wasapiSemanticFloatFormatMatches(
      &initializedFloat.Format, &changedMask.Format));
  WAVEFORMATEXTENSIBLE invalidValidBits = initializedFloat;
  invalidValidBits.Samples.wValidBitsPerSample = 24;
  CHECK(!singz::detail::wasapiSemanticFloatFormatMatches(
      &initializedFloat.Format, &invalidValidBits.Format));
  WAVEFORMATEXTENSIBLE invalidExtensibleSize = initializedFloat;
  invalidExtensibleSize.Format.cbSize = 0;
  CHECK(!singz::detail::wasapiSemanticFloatFormatMatches(
      &initializedFloat.Format, &invalidExtensibleSize.Format));
  WAVEFORMATEXTENSIBLE shortExtensibleSize = initializedFloat;
  shortExtensibleSize.Format.cbSize = static_cast<WORD>(
      sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX) - 1);
  CHECK(!singz::detail::wasapiSemanticFloatFormatMatches(
      &initializedFloat.Format, &shortExtensibleSize.Format));
  CHECK(!singz::detail::wasapiSemanticFloatFormatMatches(
      &initializedFloat.Format, nullptr));
  CHECK(singz::detail::classifyWasapiCurrentSharedPeriod(
            S_OK, true, 0, 480, 480) == singz::AudioHostError::None);
  CHECK(singz::detail::classifyWasapiCurrentSharedPeriod(
            S_OK, true, 480, 480, 480) == singz::AudioHostError::None);
  CHECK(singz::detail::classifyWasapiCurrentSharedPeriod(
            S_OK, true, 0, 480, 1056) ==
        singz::AudioHostError::ProviderFailure);
  CHECK(singz::detail::classifyWasapiCurrentSharedPeriod(
            S_OK, true, 480, 480, 1056) ==
        singz::AudioHostError::ProviderFailure);
  CHECK(singz::detail::classifyWasapiCurrentSharedPeriod(
            S_OK, false, 480, 480, 480) ==
        singz::AudioHostError::ProviderFailure);
  CHECK(singz::detail::classifyWasapiCurrentSharedPeriod(
            AUDCLNT_E_DEVICE_INVALIDATED, false, 480, 480, 0) ==
        singz::AudioHostError::DeviceNotFound);
  CHECK(singz::detail::classifyWasapiCurrentSharedPeriod(
            S_OK,
            singz::detail::wasapiSemanticFloatFormatMatches(
                &initializedFloat.Format, &changedRate.Format),
            480, 480, 480) == singz::AudioHostError::ProviderFailure);
  CHECK(singz::detail::classifyWasapiCurrentSharedProfile(
            S_OK, &initializedFloat.Format, &sameFloat.Format,
            480, 480, 480) == singz::AudioHostError::None);
  CHECK(singz::detail::classifyWasapiCurrentSharedProfile(
            S_OK, &initializedFloat.Format, &changedRate.Format,
            480, 480, 480) == singz::AudioHostError::ProviderFailure);
  CHECK(singz::detail::classifyWasapiCurrentSharedProfile(
            S_OK, &initializedFloat.Format, nullptr,
            480, 480, 480) == singz::AudioHostError::ProviderFailure);
  // A failed HRESULT is classified before either non-null out pointer can be
  // parsed. Deliberately invalid addresses make accidental dereference a
  // deterministic crash instead of a vacuous decision-seam pass.
  const auto* invalidFormat = reinterpret_cast<const WAVEFORMATEX*>(1);
  CHECK(singz::detail::classifyWasapiCurrentSharedProfile(
            E_FAIL, invalidFormat, invalidFormat,
            480, 480, 480) == singz::AudioHostError::ProviderFailure);
  CHECK(singz::detail::classifyWasapiCurrentSharedProfile(
            S_FALSE, invalidFormat, invalidFormat,
            480, 480, 480) == singz::AudioHostError::ProviderFailure);
  CHECK(singz::detail::classifyWasapiCurrentSharedProfile(
            AUDCLNT_E_DEVICE_INVALIDATED, invalidFormat, invalidFormat,
            480, 480, 480) == singz::AudioHostError::DeviceNotFound);

  const uint32_t valid[] = {2, 0};
  const uint32_t duplicate[] = {1, 1};
  const uint32_t absent[] = {0, 3};
  CHECK(singz::detail::validWasapiChannelMap(valid, 2, 3));
  CHECK(!singz::detail::validWasapiChannelMap(duplicate, 2, 3));
  CHECK(!singz::detail::validWasapiChannelMap(absent, 2, 3));
  CHECK(singz::detail::classifyWasapiOpenFailure(
            OpenStage::RequestValidation, true,
            OpenOutcome::CallerChannelMapRejected, S_OK) ==
        singz::AudioHostError::InvalidConfiguration);
  CHECK(singz::detail::wasapiFitsMaximumFrames(480, 480));
  CHECK(!singz::detail::wasapiFitsMaximumFrames(481, 480));
  CHECK(!singz::detail::wasapiFitsMaximumFrames(0, 0));
  CHECK(singz::detail::classifyWasapiOpenFailure(
            OpenStage::RequestValidation, true,
            OpenOutcome::CallerMaximumFramesExceeded, S_OK) ==
        singz::AudioHostError::InvalidConfiguration);

  const float left[] = {1, 2, 3};
  const float right[] = {4, 5, 6};
  const float* planar[] = {left, right};
  const uint32_t outputMap[] = {2, 0};
  float interleaved[12];
  singz::detail::planarToInterleavedFloat(planar, 2, outputMap, 4, 3,
                                           interleaved);
  const float expected[] = {4, 0, 1, 0, 5, 0, 2, 0, 6, 0, 3, 0};
  for (size_t index = 0; index < 12; ++index)
    CHECK(interleaved[index] == expected[index]);
  CHECK(singz::detail::wasapiClockUnitsToFrames(10000000, 10000000,
                                                48000) == 48000);
  CHECK(singz::detail::wasapiClockUnitsToFrames(5000000, 10000000,
                                                48000) == 24000);
  CHECK(singz::detail::wasapiClockUnitsToFrames(1, 0, 48000) == 0);
  CHECK(singz::detail::wasapiAdvanceNsByFrames(1000, 480, 48000) ==
        10001000);
  CHECK(singz::detail::wasapiAdvanceNsByFrames(UINT64_MAX - 1, 480,
                                                48000) == UINT64_MAX);
  CHECK(singz::detail::wasapiFramesToReferenceTime(1, 44100) == 227);
  CHECK(singz::detail::wasapiFramesToReferenceTime(64, 44100) == 14512);
  CHECK(singz::detail::wasapiFramesToReferenceTime(441, 44100) == 100000);
  CHECK(singz::detail::wasapiFramesToReferenceTime(0, 44100) == 0);
  CHECK(singz::detail::wasapiReferenceTimeToFramesCeil(100000, 44100) ==
        441);
  CHECK(singz::detail::wasapiReferenceTimeToFramesCeil(1, 44100) == 1);
  CHECK(singz::detail::wasapiReferenceTimeToFramesCeil(0, 44100) == 0);
  CHECK(singz::detail::wasapiReferenceTimeToFramesCeil(
            INT64_MAX, UINT32_MAX) == UINT32_MAX);
  CHECK(singz::detail::wasapiReferenceTimeToFramesCeil(
            10000000, UINT32_MAX) == UINT32_MAX);
  CHECK(singz::detail::classifyWasapiSharedAttempt(
            true, S_OK, S_OK, 0) ==
        singz::detail::WasapiSharedAttemptAction::Complete);
  CHECK(singz::detail::classifyWasapiSharedAttempt(
            true, E_FAIL, E_NOINTERFACE, 0) ==
        singz::detail::WasapiSharedAttemptAction::FreshLegacyFallback);
  CHECK(singz::detail::classifyWasapiSharedAttempt(
            true, S_OK, E_FAIL, 0) ==
        singz::detail::WasapiSharedAttemptAction::FreshLegacyFallback);
  CHECK(singz::detail::classifyWasapiSharedAttempt(
            false, E_NOINTERFACE, E_NOINTERFACE, 0) ==
        singz::detail::WasapiSharedAttemptAction::FreshLegacyFallback);
  CHECK(singz::detail::classifyWasapiSharedAttempt(
            true, S_OK, E_FAIL, 96) ==
        singz::detail::WasapiSharedAttemptAction::Reject);
  const auto coSignaled = singz::detail::wasapiOwnerArbiterPlan(
      false, true, true, false);
  CHECK(!coSignaled.stop && coSignaled.recordRenderWake &&
        coSignaled.drainCapture &&
        coSignaled.captureEventObserved && coSignaled.render);
  const auto sharedRenderOnly = singz::detail::wasapiOwnerArbiterPlan(
      false, false, true, false);
  CHECK(sharedRenderOnly.recordRenderWake &&
        sharedRenderOnly.drainCapture &&
        !sharedRenderOnly.captureEventObserved && sharedRenderOnly.render);
  const auto exclusiveRenderOnly = singz::detail::wasapiOwnerArbiterPlan(
      false, false, true, true);
  CHECK(exclusiveRenderOnly.recordRenderWake &&
        !exclusiveRenderOnly.drainCapture && exclusiveRenderOnly.render);
  const auto captureOnly = singz::detail::wasapiOwnerArbiterPlan(
      false, true, false, true);
  CHECK(!captureOnly.recordRenderWake && captureOnly.drainCapture &&
        captureOnly.captureEventObserved && !captureOnly.render);
  const auto stopWins = singz::detail::wasapiOwnerArbiterPlan(
      true, true, true, false);
  CHECK(stopWins.stop && !stopWins.recordRenderWake &&
        !stopWins.drainCapture && !stopWins.render);

  // A capture-selected iteration polls render before drain and at most once
  // afterward. A discovered render request is claimable exactly once, so the
  // consumed auto-reset event cannot be lost or rendered twice.
  auto renderBeforeCaptureDrain =
      singz::detail::beginWasapiCaptureRenderState(true);
  CHECK(!singz::detail::shouldPollWasapiRenderAfterCaptureDrain(
      renderBeforeCaptureDrain));
  CHECK(!singz::detail::publishWasapiRenderAfterCaptureDrain(
      &renderBeforeCaptureDrain, true));
  CHECK(singz::detail::claimWasapiCaptureRenderRequest(
      &renderBeforeCaptureDrain));
  CHECK(!singz::detail::claimWasapiCaptureRenderRequest(
      &renderBeforeCaptureDrain));

  auto renderDuringCaptureDrain =
      singz::detail::beginWasapiCaptureRenderState(false);
  CHECK(singz::detail::shouldPollWasapiRenderAfterCaptureDrain(
      renderDuringCaptureDrain));
  CHECK(singz::detail::publishWasapiRenderAfterCaptureDrain(
      &renderDuringCaptureDrain, true));
  CHECK(!singz::detail::shouldPollWasapiRenderAfterCaptureDrain(
      renderDuringCaptureDrain));
  CHECK(!singz::detail::publishWasapiRenderAfterCaptureDrain(
      &renderDuringCaptureDrain, true));
  CHECK(singz::detail::claimWasapiCaptureRenderRequest(
      &renderDuringCaptureDrain));
  CHECK(!singz::detail::claimWasapiCaptureRenderRequest(
      &renderDuringCaptureDrain));

  auto noRenderDuringCaptureDrain =
      singz::detail::beginWasapiCaptureRenderState(false);
  CHECK(singz::detail::publishWasapiRenderAfterCaptureDrain(
      &noRenderDuringCaptureDrain, false));
  CHECK(!singz::detail::claimWasapiCaptureRenderRequest(
      &noRenderDuringCaptureDrain));
  CHECK(!singz::detail::shouldPollWasapiRenderAfterCaptureDrain(
      noRenderDuringCaptureDrain));
  const auto sharedStart = singz::detail::wasapiOwnerStartPlan(false);
  CHECK(sharedStart.primeRenderBeforeCapture &&
        sharedStart.capturePrefillPeriods == 1);
  const auto exclusiveStart = singz::detail::wasapiOwnerStartPlan(true);
  CHECK(!exclusiveStart.primeRenderBeforeCapture &&
        exclusiveStart.capturePrefillPeriods == 1);
  CHECK(singz::detail::wasapiOwnerShouldAwaitCapture(false, 0, 480));
  CHECK(singz::detail::wasapiOwnerShouldAwaitCapture(false, 479, 480));
  CHECK(!singz::detail::wasapiOwnerShouldAwaitCapture(false, 480, 480));
  CHECK(!singz::detail::wasapiOwnerShouldAwaitCapture(false, 960, 480));
  CHECK(singz::detail::wasapiOwnerShouldAwaitCapture(true, 0, 480));
  CHECK(singz::detail::wasapiRenderPaddingBudgetNs(576, 48000) ==
        12000000);
  CHECK(singz::detail::wasapiRenderPaddingBudgetNs(UINT32_MAX, 1) ==
        static_cast<uint64_t>(UINT32_MAX) * 1000000000ull);
  CHECK(singz::detail::wasapiRenderPaddingBudgetNs(576, 0) == 0);
  constexpr uint64_t renderWake = 1000000;
  CHECK(singz::detail::wasapiRenderDeadlineNs(
            renderWake, 480, 48000) == 11000000);
  CHECK(!singz::detail::wasapiRenderDeadlineExpired(
      renderWake, 10999999, 480, 48000));
  CHECK(singz::detail::wasapiRenderDeadlineExpired(
      renderWake, 11000000, 480, 48000));
  CHECK(singz::detail::wasapiRenderDeadlineNs(
            UINT64_MAX - 5, UINT32_MAX, 1) == UINT64_MAX);
  CHECK(singz::detail::wasapiRenderDeadlineExpired(
      renderWake, renderWake, 0, 48000));
  CHECK(singz::detail::wasapiRenderDeadlineExpired(
      renderWake, renderWake, 480, 0));

  // A selected shared render snapshots padding before capture conversion.
  // Five milliseconds later the live padding may have shrunk from 576 to
  // 336, but this request keeps its original 480-frame write and 12-ms
  // absolute deadline. Re-querying padding after the work would create a
  // false 7-ms deadline.
  singz::detail::WasapiRenderRequest selectedSharedRequest;
  CHECK(singz::detail::prepareWasapiRenderRequest(
      false, renderWake, 1056, 576, 48000, &selectedSharedRequest));
  CHECK(selectedSharedRequest.valid &&
        !selectedSharedRequest.exclusive);
  CHECK(selectedSharedRequest.observedQpcNs == renderWake);
  CHECK(selectedSharedRequest.paddingFrames == 576);
  CHECK(selectedSharedRequest.framesToWrite == 480);
  CHECK(selectedSharedRequest.budgetFrames == 576);
  CHECK(selectedSharedRequest.deadlineNs == renderWake + 12000000);
  constexpr uint32_t laterPaddingFrames = 336;
  CHECK(!singz::detail::wasapiRenderRequestExpired(
      selectedSharedRequest, renderWake + 11000000));
  CHECK(singz::detail::wasapiRenderDeadlineExpired(
      renderWake, renderWake + 8000000, laterPaddingFrames, 48000));
  CHECK(selectedSharedRequest.paddingFrames == 576);
  CHECK(selectedSharedRequest.framesToWrite == 480);

  // If capture was selected and render appeared during its five-millisecond
  // drain, shared mode takes a new coherent timestamp+padding pair. The later
  // origin plus shrunken padding preserves the same absolute deadline.
  singz::detail::WasapiRenderRequest postDrainSharedRequest;
  CHECK(singz::detail::prepareWasapiRenderRequest(
      false, renderWake + 5000000, 1056, laterPaddingFrames, 48000,
      &postDrainSharedRequest));
  CHECK(postDrainSharedRequest.framesToWrite == 720);
  CHECK(postDrainSharedRequest.paddingFrames == laterPaddingFrames);
  CHECK(postDrainSharedRequest.deadlineNs ==
        selectedSharedRequest.deadlineNs);

  // Exclusive mode has no padding query. If render appears during an 8-ms
  // capture drain, its immutable request retains capture-start QPC so another
  // 3 ms of graph work misses the 10-ms period. A late timestamp would have
  // hidden that miss.
  singz::detail::WasapiRenderRequest exclusiveDuringCapture;
  CHECK(singz::detail::prepareWasapiRenderRequest(
      true, renderWake, 480, 0, 48000, &exclusiveDuringCapture));
  CHECK(exclusiveDuringCapture.exclusive);
  CHECK(exclusiveDuringCapture.paddingFrames == 0);
  CHECK(exclusiveDuringCapture.framesToWrite == 480);
  CHECK(exclusiveDuringCapture.deadlineNs == renderWake + 10000000);
  CHECK(singz::detail::wasapiRenderRequestExpired(
      exclusiveDuringCapture, renderWake + 11000000));
  singz::detail::WasapiRenderRequest incorrectlyLateExclusive;
  CHECK(singz::detail::prepareWasapiRenderRequest(
      true, renderWake + 8000000, 480, 0, 48000,
      &incorrectlyLateExclusive));
  CHECK(!singz::detail::wasapiRenderRequestExpired(
      incorrectlyLateExclusive, renderWake + 11000000));

  singz::detail::WasapiRenderRequest saturatedRequest;
  CHECK(singz::detail::prepareWasapiRenderRequest(
      true, UINT64_MAX - 5, UINT32_MAX, 0, 1, &saturatedRequest));
  CHECK(saturatedRequest.deadlineNs == UINT64_MAX);
  CHECK(!singz::detail::prepareWasapiRenderRequest(
      false, renderWake, 1056, 1057, 48000, &saturatedRequest));
  CHECK(!saturatedRequest.valid);
  CHECK(!singz::detail::prepareWasapiRenderRequest(
      false, renderWake, 1056, 0, 0, &saturatedRequest));
  CHECK(!singz::detail::prepareWasapiRenderRequest(
      false, renderWake, 1056, 0, 48000, nullptr));

  // A co-signaled exclusive render records the wake before capture work. A
  // seven-millisecond capture conversion plus four-millisecond graph crosses
  // its ten-millisecond period and therefore takes the production deadline
  // failure branch; graph work alone below one period remains valid.
  const auto exclusiveCoSignaled = singz::detail::wasapiOwnerArbiterPlan(
      false, true, true, true);
  CHECK(exclusiveCoSignaled.recordRenderWake &&
        exclusiveCoSignaled.drainCapture &&
        exclusiveCoSignaled.captureEventObserved &&
        exclusiveCoSignaled.render);
  const uint64_t afterCaptureWork = renderWake + 7000000;
  CHECK(!singz::detail::wasapiRenderDeadlineExpired(
      renderWake, afterCaptureWork, 480, 48000));
  CHECK(singz::detail::wasapiRenderDeadlineExpired(
      renderWake, afterCaptureWork + 4000000, 480, 48000));
  CHECK(!singz::detail::wasapiRenderDeadlineExpired(
      renderWake, renderWake + 9000000, 480, 48000));

  // Shared padding spends its budget from the observed render wake, not from
  // a later timestamp after capture conversion. Starting the same 12-ms
  // budget five milliseconds late would falsely make this completion clean.
  CHECK(singz::detail::wasapiRenderDeadlineExpired(
      renderWake, renderWake + 13000000, 576, 48000));
  CHECK(!singz::detail::wasapiRenderDeadlineExpired(
      renderWake + 5000000, renderWake + 13000000, 576, 48000));
  CHECK(singz::detail::wasapiRenderWaitTimeoutMs(1000000, 13000000) == 11);
  CHECK(singz::detail::wasapiRenderWaitTimeoutMs(12000000, 13000000) == 0);
  CHECK(singz::detail::wasapiRenderWaitTimeoutMs(13000000, 13000000) == 0);
  using Pending = singz::detail::WasapiPendingRenderAction;
  CHECK(singz::detail::wasapiPendingRenderAction(
            false, false, 480, 480, 1, 10) == Pending::Render);
  CHECK(singz::detail::wasapiPendingRenderAction(
            false, false, 0, 480, 1, 10) == Pending::WaitForCapture);
  CHECK(singz::detail::wasapiPendingRenderAction(
            true, false, 0, 480, 1, 10) == Pending::Stop);
  CHECK(singz::detail::wasapiPendingRenderAction(
            false, false, 0, 480, 10, 10) == Pending::FailDeadline);
  CHECK(singz::detail::wasapiPendingRenderAction(
            false, false, 480, 480, 10, 10) == Pending::FailDeadline);
  singz::detail::WasapiOnceOperation expiredFullRequest;
  if (singz::detail::wasapiPendingRenderAction(
          false, false, 480, 480, 10, 10) == Pending::Render)
    CHECK(expiredFullRequest.begin());
  CHECK(expiredFullRequest.stage() == singz::detail::WasapiOnceStage::Idle);
  CHECK(expiredFullRequest.advances() == 0);
  CHECK(singz::detail::wasapiPendingRenderAction(
            false, true, 0, 480, 1, 10) == Pending::WaitForCapture);
  CHECK(singz::detail::wasapiPendingRenderAction(
            false, true, 480, 480, 2, 10) == Pending::Render);
  CHECK(singz::detail::wasapiPendingRenderAction(
            false, true, 0, 480, 10, 10) == Pending::FailDeadline);
  // One capture wake changes the pending request to exactly one render; the
  // helper never creates a second render action for the same state change.
  uint32_t renderDecisions = 0;
  if (singz::detail::wasapiPendingRenderAction(
          false, false, 0, 480, 1, 10) == Pending::Render)
    ++renderDecisions;
  if (singz::detail::wasapiPendingRenderAction(
          false, false, 480, 480, 2, 10) == Pending::Render)
    ++renderDecisions;
  CHECK(renderDecisions == 1);
  CHECK(singz::detail::shouldRetryWasapiExactProfile(
      REGDB_E_CLASSNOTREG, 1));
  CHECK(singz::detail::shouldRetryWasapiExactProfile(
      REGDB_E_CLASSNOTREG,
      singz::detail::kWasapiMaximumExactProfileAttempts - 1));
  CHECK(!singz::detail::shouldRetryWasapiExactProfile(
      REGDB_E_CLASSNOTREG,
      singz::detail::kWasapiMaximumExactProfileAttempts));
  CHECK(!singz::detail::shouldRetryWasapiExactProfile(E_FAIL, 1));
  uint16_t blockAlign = 0;
  uint32_t averageBytes = 0;
  CHECK(singz::detail::wasapiFloatFormatRates(
      48000, 64, &blockAlign, &averageBytes));
  CHECK(blockAlign == 256);
  CHECK(averageBytes == 12288000);
  CHECK(singz::detail::wasapiFloatFormatRates(
      UINT32_MAX / 256, 64, &blockAlign, &averageBytes));
  CHECK(!singz::detail::wasapiFloatFormatRates(
      UINT32_MAX / 256 + 1, 64, &blockAlign, &averageBytes));
  CHECK(!singz::detail::wasapiFloatFormatRates(
      48000, 0, &blockAlign, &averageBytes));
  CHECK(singz::detail::wasapiSignedFrameBalance(500, 480) == 20);
  CHECK(singz::detail::wasapiSignedFrameBalance(480, 500) == -20);
  CHECK(singz::detail::wasapiSignedFrameBalance(UINT64_MAX, 0) == INT64_MAX);
  CHECK(singz::detail::wasapiSignedFrameBalance(0, UINT64_MAX) == INT64_MIN);
  CHECK(singz::detail::wasapiClockPositionExact(S_OK));
  CHECK(!singz::detail::wasapiClockPositionExact(S_FALSE));
  CHECK(!singz::detail::wasapiClockPositionExact(E_FAIL));
  using ClockAction = singz::detail::WasapiClockPositionAction;
  CHECK(singz::detail::classifyWasapiClockPosition(S_OK) ==
        ClockAction::UseHardware);
  CHECK(singz::detail::classifyWasapiClockPosition(S_FALSE) ==
        ClockAction::UseQpcFallback);
  CHECK(singz::detail::classifyWasapiClockPosition(E_FAIL) ==
        ClockAction::UseQpcFallback);
  CHECK(singz::detail::classifyWasapiClockPosition(
            AUDCLNT_E_DEVICE_INVALIDATED) == ClockAction::FailDeviceLost);
  CHECK(singz::detail::classifyWasapiClockPosition(
            AUDCLNT_E_RESOURCES_INVALIDATED) == ClockAction::FailDeviceLost);
  CHECK(singz::detail::classifyWasapiClockPosition(
            AUDCLNT_E_SERVICE_NOT_RUNNING) == ClockAction::FailDeviceLost);
  const ClockRenderTrace lostClock = exerciseClockRenderDecision(
      AUDCLNT_E_DEVICE_INVALIDATED, E_FAIL);
  CHECK(lostClock.silentReleases == 1);
  CHECK(lostClock.normalReleases == 0);
  CHECK(lostClock.graphAdvances == 0);
  CHECK(lostClock.deviceLost);
  CHECK(lostClock.operationStage ==
        singz::detail::WasapiOnceStage::Failed);
  const ClockRenderTrace fallbackClock =
      exerciseClockRenderDecision(E_FAIL, S_OK);
  CHECK(fallbackClock.silentReleases == 0);
  CHECK(fallbackClock.normalReleases == 1);
  CHECK(fallbackClock.graphAdvances == 1);
  CHECK(!fallbackClock.deviceLost);
  CHECK(fallbackClock.operationStage ==
        singz::detail::WasapiOnceStage::Complete);
  const ClockRenderTrace exactClock =
      exerciseClockRenderDecision(S_OK, S_OK);
  CHECK(exactClock.graphAdvances == 1);
  CHECK(exactClock.normalReleases == 1);
  CHECK(singz::detail::wasapiExclusiveBufferMatches(0, 512));
  CHECK(singz::detail::wasapiExclusiveBufferMatches(480, 480));
  CHECK(!singz::detail::wasapiExclusiveBufferMatches(480, 512));
  CHECK(singz::detail::classifyWasapiOpenFailure(
            OpenStage::RequestValidation, true,
            OpenOutcome::CallerAlignmentMismatch, S_OK) ==
        singz::AudioHostError::InvalidConfiguration);
  using AlignmentAction = singz::detail::WasapiExclusiveAlignmentAction;
  CHECK(singz::detail::classifyWasapiExclusiveAlignment(
            S_OK, S_OK, 480) == AlignmentAction::NotRequired);
  CHECK(singz::detail::classifyWasapiExclusiveAlignment(
            AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED, S_OK, 512) ==
        AlignmentAction::ReactivateAligned);
  CHECK(singz::detail::classifyWasapiExclusiveAlignment(
            AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED, E_FAIL, 0) ==
        AlignmentAction::Fail);
  CHECK(singz::detail::classifyWasapiExclusiveAlignment(
            AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED, S_OK, 0) ==
        AlignmentAction::Fail);
  CHECK(singz::detail::classifyWasapiOpenFailure(
            OpenStage::FormatProbe, true,
            OpenOutcome::CallerExactTopologyRejected,
            AUDCLNT_E_UNSUPPORTED_FORMAT) ==
        singz::AudioHostError::InvalidConfiguration);
  CHECK(singz::detail::classifyWasapiOpenFailure(
            OpenStage::FormatProbe, true,
            OpenOutcome::ApiFailure, E_INVALIDARG) ==
        singz::AudioHostError::ProviderFailure);
  CHECK(singz::detail::classifyWasapiOpenFailure(
            OpenStage::FormatProbe, true,
            OpenOutcome::CallerExactTopologyRejected, E_INVALIDARG) ==
        singz::AudioHostError::ProviderFailure);
  const OpenStage apiStages[] = {
      OpenStage::DeviceLookup,
      OpenStage::ClientActivation,
      OpenStage::ClientProperties,
      OpenStage::MixFormat,
      OpenStage::FormatProbe,
      OpenStage::SharedPeriod,
      OpenStage::SharedInitialize,
      OpenStage::LegacyInitialize,
      OpenStage::ExclusivePeriod,
      OpenStage::ExclusiveInitialize,
      OpenStage::BufferSize,
      OpenStage::EventHandle,
      OpenStage::Service,
  };
  for (const OpenStage stage : apiStages) {
    CHECK(singz::detail::classifyWasapiOpenFailure(
              stage, true, OpenOutcome::ApiFailure, E_FAIL) ==
          singz::AudioHostError::ProviderFailure);
    CHECK(singz::detail::classifyWasapiOpenFailure(
              stage, true, OpenOutcome::ApiFailure, E_OUTOFMEMORY) ==
          singz::AudioHostError::ProviderFailure);
    CHECK(singz::detail::classifyWasapiOpenFailure(
              stage, true, OpenOutcome::ApiFailure, E_ACCESSDENIED) ==
          singz::AudioHostError::ProviderFailure);
    CHECK(singz::detail::classifyWasapiOpenFailure(
              stage, true, OpenOutcome::ApiFailure, E_INVALIDARG) ==
          singz::AudioHostError::ProviderFailure);
    CHECK(singz::detail::classifyWasapiOpenFailure(
              stage, false, OpenOutcome::ApiFailure,
              AUDCLNT_E_DEVICE_INVALIDATED) ==
          singz::AudioHostError::DeviceNotFound);
    CHECK(singz::detail::classifyWasapiOpenFailure(
              stage, false, OpenOutcome::ApiFailure,
              AUDCLNT_E_RESOURCES_INVALIDATED) ==
          singz::AudioHostError::DeviceNotFound);
    CHECK(singz::detail::classifyWasapiOpenFailure(
              stage, false, OpenOutcome::ApiFailure,
              AUDCLNT_E_SERVICE_NOT_RUNNING) ==
          singz::AudioHostError::DeviceNotFound);
  }
  const HRESULT endpointNotFound = HRESULT_FROM_WIN32(ERROR_NOT_FOUND);
  CHECK(singz::detail::classifyWasapiOpenFailure(
            OpenStage::DeviceLookup, true, OpenOutcome::ApiFailure,
            endpointNotFound) == singz::AudioHostError::DeviceNotFound);
  CHECK(singz::detail::classifyWasapiOpenFailure(
            OpenStage::MixFormat, false, OpenOutcome::ApiFailure,
            endpointNotFound) == singz::AudioHostError::ProviderFailure);

  // Endpoint pairing keeps the HRESULT from each endpoint and each property
  // stage separate from the semantic ContainerId outcome.
  using PairStage = singz::detail::WasapiPairingStage;
  using PairOutcome = singz::detail::WasapiPairingOutcome;
  const PairStage pairingApiStages[] = {
      PairStage::InputState,
      PairStage::OutputState,
      PairStage::InputPropertyStore,
      PairStage::OutputPropertyStore,
      PairStage::InputContainerValue,
      PairStage::OutputContainerValue,
  };
  for (const PairStage stage : pairingApiStages) {
    CHECK(singz::detail::classifyWasapiPairing(
              stage, PairOutcome::ApiFailure, E_FAIL) ==
          singz::AudioHostError::ProviderFailure);
    CHECK(singz::detail::classifyWasapiPairing(
              stage, PairOutcome::ApiFailure, E_OUTOFMEMORY) ==
          singz::AudioHostError::ProviderFailure);
    CHECK(singz::detail::classifyWasapiPairing(
              stage, PairOutcome::ApiFailure, E_ACCESSDENIED) ==
          singz::AudioHostError::ProviderFailure);
    CHECK(singz::detail::classifyWasapiPairing(
              stage, PairOutcome::ApiFailure, E_INVALIDARG) ==
          singz::AudioHostError::ProviderFailure);
    CHECK(singz::detail::classifyWasapiPairing(
              stage, PairOutcome::ApiFailure,
              AUDCLNT_E_DEVICE_INVALIDATED) ==
          singz::AudioHostError::DeviceNotFound);
    CHECK(singz::detail::classifyWasapiPairing(
              stage, PairOutcome::ApiFailure,
              AUDCLNT_E_RESOURCES_INVALIDATED) ==
          singz::AudioHostError::DeviceNotFound);
    CHECK(singz::detail::classifyWasapiPairing(
              stage, PairOutcome::ApiFailure,
              AUDCLNT_E_SERVICE_NOT_RUNNING) ==
          singz::AudioHostError::DeviceNotFound);
  }
  CHECK(singz::detail::classifyWasapiPairing(
            PairStage::InputState, PairOutcome::Inactive, S_OK) ==
        singz::AudioHostError::DeviceNotFound);
  CHECK(singz::detail::classifyWasapiPairing(
            PairStage::OutputState, PairOutcome::Inactive, S_OK) ==
        singz::AudioHostError::DeviceNotFound);
  CHECK(singz::detail::classifyWasapiPairing(
            PairStage::InputContainerValue,
            PairOutcome::MissingOrMalformedContainer, S_OK) ==
        singz::AudioHostError::DifferentDevicesUnsupported);
  CHECK(singz::detail::classifyWasapiPairing(
            PairStage::OutputContainerValue,
            PairOutcome::MissingOrMalformedContainer, S_OK) ==
        singz::AudioHostError::DifferentDevicesUnsupported);
  CHECK(singz::detail::classifyWasapiPairing(
            PairStage::ContainerComparison, PairOutcome::ContainerMismatch,
            S_OK) == singz::AudioHostError::DifferentDevicesUnsupported);
  CHECK(singz::detail::classifyWasapiPairing(
            PairStage::ContainerComparison, PairOutcome::Success, S_OK) ==
        singz::AudioHostError::None);
  CHECK(singz::detail::classifyWasapiPairing(
            PairStage::ContainerComparison, PairOutcome::ContainerMismatch,
            E_FAIL) == singz::AudioHostError::ProviderFailure);

  using OptionalStage = singz::detail::WasapiOptionalOpenStage;
  using OptionalAction = singz::detail::WasapiOptionalOpenAction;
  const OptionalStage optionalStages[] = {
      OptionalStage::StreamLatency,
      OptionalStage::ClockFrequency,
  };
  for (const OptionalStage stage : optionalStages) {
    CHECK(singz::detail::classifyWasapiOptionalOpenResult(
              stage, S_OK, true) == OptionalAction::UseValue);
    CHECK(singz::detail::classifyWasapiOptionalOpenResult(
              stage, S_OK, false) == OptionalAction::UseFallback);
    CHECK(singz::detail::classifyWasapiOptionalOpenResult(
              stage, S_FALSE, true) == OptionalAction::UseFallback);
    CHECK(singz::detail::classifyWasapiOptionalOpenResult(
              stage, E_FAIL, false) == OptionalAction::UseFallback);
    CHECK(singz::detail::classifyWasapiOptionalOpenResult(
              stage, E_INVALIDARG, false) == OptionalAction::UseFallback);
    CHECK(singz::detail::classifyWasapiOptionalOpenResult(
              stage, AUDCLNT_E_DEVICE_INVALIDATED, false) ==
          OptionalAction::FailDeviceLost);
    CHECK(singz::detail::classifyWasapiOptionalOpenResult(
              stage, AUDCLNT_E_RESOURCES_INVALIDATED, false) ==
          OptionalAction::FailDeviceLost);
    CHECK(singz::detail::classifyWasapiOptionalOpenResult(
              stage, AUDCLNT_E_SERVICE_NOT_RUNNING, false) ==
          OptionalAction::FailDeviceLost);
  }

  using Client3Action = singz::detail::WasapiClient3QueryAction;
  CHECK(singz::detail::classifyWasapiClient3Query(S_OK, false) ==
        Client3Action::UseClient3);
  CHECK(singz::detail::classifyWasapiClient3Query(S_OK, true) ==
        Client3Action::UseClient3);
  CHECK(singz::detail::classifyWasapiClient3Query(E_NOINTERFACE, false) ==
        Client3Action::LegacyFallback);
  CHECK(singz::detail::classifyWasapiClient3Query(E_NOINTERFACE, true) ==
        Client3Action::Unsupported);
  CHECK(singz::detail::classifyWasapiClient3Query(E_FAIL, false) ==
        Client3Action::Fail);
  CHECK(singz::detail::classifyWasapiClient3Query(
            AUDCLNT_E_DEVICE_INVALIDATED, true) == Client3Action::Fail);
  CHECK(singz::detail::classifyWasapiOpenFailure(
            OpenStage::SharedPeriod, true,
            OpenOutcome::ProviderUnsupported, E_NOINTERFACE) ==
        singz::AudioHostError::Unsupported);
  CHECK(singz::detail::classifyWasapiOpenFailure(
            OpenStage::SharedPeriod, false, OpenOutcome::ApiFailure, E_FAIL) ==
        singz::AudioHostError::ProviderFailure);
  CHECK(singz::detail::classifyWasapiOpenFailure(
            OpenStage::SharedPeriod, true, OpenOutcome::ApiFailure,
            AUDCLNT_E_DEVICE_INVALIDATED) ==
        singz::AudioHostError::DeviceNotFound);
  CHECK(singz::detail::classifyWasapiBufferResult(
            S_OK, true, 0) == singz::detail::WasapiBufferAction::Proceed);
  CHECK(singz::detail::classifyWasapiBufferResult(
            AUDCLNT_S_BUFFER_EMPTY, false, 0) ==
        singz::detail::WasapiBufferAction::Empty);
  CHECK(singz::detail::classifyWasapiBufferResult(
            AUDCLNT_E_BUFFER_ERROR, true, 1) ==
        singz::detail::WasapiBufferAction::Retry);
  CHECK(singz::detail::classifyWasapiBufferResult(
            AUDCLNT_E_BUFFER_ERROR, true,
            singz::detail::kWasapiMaximumConsecutiveBufferErrors) ==
        singz::detail::WasapiBufferAction::Fail);
  CHECK(singz::detail::classifyWasapiBufferResult(
            AUDCLNT_E_BUFFER_ERROR, false, 1) ==
        singz::detail::WasapiBufferAction::Fail);

  // Pre-start exclusive prime is a bounded acquisition: there is no render
  // event to await before Start.
  CHECK(singz::detail::classifyWasapiPrimeAcquire(S_OK) ==
        singz::detail::WasapiPrimeAcquireAction::Proceed);
  CHECK(singz::detail::classifyWasapiPrimeAcquire(
            AUDCLNT_E_BUFFER_ERROR) ==
        singz::detail::WasapiPrimeAcquireAction::Fail);

  // Every pre-running COM source uses the same production decision and route
  // transition. Endpoint invalidation needs no notification callback to
  // become DeviceLost; generic failures remain provider Error.
  using StartupStage = singz::detail::WasapiStartupStage;
  const StartupStage startupStages[] = {
      // Owner wait/MMCSS failures and publishRunning rejection all publish
      // through the same Control stage.
      StartupStage::Control,
      StartupStage::PrimeGetBuffer,
      StartupStage::PrimeReleaseBuffer,
      StartupStage::CaptureStart,
      StartupStage::CapturePrimePacket,
      StartupStage::CapturePrimeRelease,
      StartupStage::RenderStart,
  };
  const HRESULT startupDeviceLosses[] = {
      AUDCLNT_E_DEVICE_INVALIDATED,
      AUDCLNT_E_RESOURCES_INVALIDATED,
      AUDCLNT_E_SERVICE_NOT_RUNNING,
  };
  uint64_t startupGeneration = 700;
  for (const StartupStage stage : startupStages) {
    for (const HRESULT failure : startupDeviceLosses) {
      const auto decision =
          singz::detail::classifyWasapiStartupFailure(stage, failure);
      CHECK(decision.error == singz::AudioHostError::DeviceNotFound);
      CHECK(decision.state ==
            singz::detail::WasapiLifecycleState::DeviceLost);
      singz::detail::WasapiRouteLossContext routeWithoutNotification(
          startupGeneration++, nullptr);
      CHECK(routeWithoutNotification.publishOpen(
          routeWithoutNotification.generation()));
      CHECK(routeWithoutNotification.beginStart());
      singz::detail::applyWasapiStartupFailure(
          &routeWithoutNotification, stage, failure);
      const auto snapshot = routeWithoutNotification.snapshot();
      CHECK(snapshot.lost);
      CHECK(snapshot.state ==
            singz::detail::WasapiLifecycleState::DeviceLost);
    }
    const auto generic =
        singz::detail::classifyWasapiStartupFailure(stage, E_FAIL);
    CHECK(generic.error == singz::AudioHostError::ProviderFailure);
    CHECK(generic.state == singz::detail::WasapiLifecycleState::Error);
    singz::detail::WasapiRouteLossContext genericRoute(
        startupGeneration++, nullptr);
    CHECK(genericRoute.publishOpen(genericRoute.generation()));
    CHECK(genericRoute.beginStart());
    singz::detail::applyWasapiStartupFailure(
        &genericRoute, stage, E_FAIL);
    const auto genericSnapshot = genericRoute.snapshot();
    CHECK(!genericSnapshot.lost);
    CHECK(genericSnapshot.state ==
          singz::detail::WasapiLifecycleState::Error);
  }
  const auto boundedPrimeBufferError =
      singz::detail::classifyWasapiStartupFailure(
          StartupStage::PrimeGetBuffer, AUDCLNT_E_BUFFER_ERROR);
  CHECK(boundedPrimeBufferError.error ==
        singz::AudioHostError::ProviderFailure);
  CHECK(boundedPrimeBufferError.state ==
        singz::detail::WasapiLifecycleState::Error);

  // The mutex-protected production publication stores and copies exactly the
  // first fault. Later cleanup failures cannot erase the originating stage or
  // HRESULT, and the coherent post-join route snapshot has final authority.
  singz::detail::WasapiStartupFailureState firstInvalidation;
  CHECK(singz::detail::publishWasapiStartupFailure(
      &firstInvalidation, StartupStage::CaptureStart,
      AUDCLNT_E_DEVICE_INVALIDATED));
  CHECK(!singz::detail::publishWasapiStartupFailure(
      &firstInvalidation, StartupStage::Control, E_FAIL));
  const auto copiedInvalidation =
      singz::detail::copyWasapiStartupFailure(firstInvalidation);
  CHECK(copiedInvalidation.hasFailure);
  CHECK(copiedInvalidation.stage == StartupStage::CaptureStart);
  CHECK(copiedInvalidation.result == AUDCLNT_E_DEVICE_INVALIDATED);
  const auto invalidationAfterGenericStop =
      singz::detail::resolveWasapiStartupFailure(
          copiedInvalidation,
          {startupGeneration++,
           singz::detail::WasapiLifecycleState::Error, false});
  CHECK(invalidationAfterGenericStop.error ==
        singz::AudioHostError::DeviceNotFound);
  CHECK(invalidationAfterGenericStop.state ==
        singz::detail::WasapiLifecycleState::DeviceLost);

  singz::detail::WasapiStartupFailureState firstGeneric;
  CHECK(singz::detail::publishWasapiStartupFailure(
      &firstGeneric, StartupStage::PrimeGetBuffer, E_FAIL));
  CHECK(!singz::detail::publishWasapiStartupFailure(
      &firstGeneric, StartupStage::PrimeReleaseBuffer,
      AUDCLNT_E_RESOURCES_INVALIDATED));
  const auto copiedGeneric =
      singz::detail::copyWasapiStartupFailure(firstGeneric);
  CHECK(copiedGeneric.stage == StartupStage::PrimeGetBuffer);
  CHECK(copiedGeneric.result == E_FAIL);
  const auto genericThenShutdownLoss =
      singz::detail::resolveWasapiStartupFailure(
          copiedGeneric,
          {startupGeneration++,
           singz::detail::WasapiLifecycleState::DeviceLost, true});
  CHECK(genericThenShutdownLoss.error ==
        singz::AudioHostError::DeviceNotFound);
  CHECK(genericThenShutdownLoss.state ==
        singz::detail::WasapiLifecycleState::DeviceLost);

  singz::detail::WasapiStartupFailureState controlWait;
  CHECK(singz::detail::publishWasapiStartupFailure(
      &controlWait, StartupStage::Control, E_ABORT));
  const auto interruptedWait = singz::detail::resolveWasapiStartupFailure(
      singz::detail::copyWasapiStartupFailure(controlWait),
      {startupGeneration++,
       singz::detail::WasapiLifecycleState::Starting, false});
  CHECK(interruptedWait.error == singz::AudioHostError::ProviderFailure);
  CHECK(interruptedWait.state ==
        singz::detail::WasapiLifecycleState::Error);

  singz::detail::WasapiStartupFailureState mmcssOrPublishRunning;
  CHECK(singz::detail::publishWasapiStartupFailure(
      &mmcssOrPublishRunning, StartupStage::Control, E_FAIL));
  const auto controlGeneric = singz::detail::resolveWasapiStartupFailure(
      mmcssOrPublishRunning,
      {startupGeneration++,
       singz::detail::WasapiLifecycleState::Starting, false});
  CHECK(controlGeneric.error == singz::AudioHostError::ProviderFailure);
  CHECK(controlGeneric.state ==
        singz::detail::WasapiLifecycleState::Error);
  const auto publishRunningAfterLoss =
      singz::detail::resolveWasapiStartupFailure(
          mmcssOrPublishRunning,
          {startupGeneration++,
           singz::detail::WasapiLifecycleState::DeviceLost, true});
  CHECK(publishRunningAfterLoss.error ==
        singz::AudioHostError::DeviceNotFound);
  CHECK(publishRunningAfterLoss.state ==
        singz::detail::WasapiLifecycleState::DeviceLost);

  // Capture publication and graph execution each advance exactly once. A
  // ReleaseBuffer failure is terminal after that advancement and cannot make
  // the same operation pending again.
  singz::detail::WasapiOnceOperation captureOnce;
  CHECK(captureOnce.begin());
  CHECK(captureOnce.markAcquired());
  CHECK(captureOnce.markAdvanced());
  CHECK(!captureOnce.markAdvanced());
  CHECK(!captureOnce.finishRelease(AUDCLNT_E_BUFFER_ERROR));
  CHECK(captureOnce.stage() == singz::detail::WasapiOnceStage::Failed);
  CHECK(captureOnce.advances() == 1);
  CHECK(!captureOnce.begin());

  singz::detail::WasapiOnceOperation graphOnce;
  CHECK(graphOnce.begin());
  CHECK(graphOnce.markAcquired());
  CHECK(graphOnce.markAdvanced());
  CHECK(graphOnce.finishRelease(S_FALSE));
  CHECK(graphOnce.stage() == singz::detail::WasapiOnceStage::Complete);
  CHECK(graphOnce.advances() == 1);

  // The production arbiter + pending + once-operation seams model both
  // shared and exclusive render-only wakes: one capture wake permits one
  // stateful render, while spurious wakes, timeout, stop, and loss do not.
  for (const bool exclusive : {false, true}) {
    const auto renderWake = singz::detail::wasapiOwnerArbiterPlan(
        false, false, true, exclusive);
    CHECK(renderWake.recordRenderWake && renderWake.render);
    CHECK(singz::detail::wasapiPendingRenderAction(
              false, exclusive, 0, 480, 1, 10) ==
          Pending::WaitForCapture);
    CHECK(singz::detail::wasapiPendingRenderAction(
              false, exclusive, 0, 480, 2, 10) ==
          Pending::WaitForCapture);
    CHECK(singz::detail::wasapiPendingRenderAction(
              false, exclusive, 480, 480, 3, 10) == Pending::Render);
    singz::detail::WasapiOnceOperation ownerRender;
    CHECK(ownerRender.begin());
    CHECK(ownerRender.markAcquired());
    CHECK(ownerRender.markAdvanced());
    CHECK(ownerRender.finishRelease(S_OK));
    CHECK(ownerRender.advances() == 1);
  }
  CHECK(singz::detail::wasapiKnownStop(true, false, false));
  CHECK(singz::detail::wasapiKnownStop(false, true, false));
  CHECK(singz::detail::wasapiKnownStop(false, false, true));
  CHECK(!singz::detail::wasapiKnownStop(false, false, false));
  singz::detail::WasapiRouteLossContext terminalRoute(450, nullptr);
  terminalRoute.markError();
  const auto terminalSnapshot = terminalRoute.snapshot();
  CHECK(singz::detail::wasapiKnownStop(
      false, terminalSnapshot.lost,
      terminalSnapshot.state == singz::detail::WasapiLifecycleState::Error));

  CHECK(singz::detail::wasapiComSucceeded(S_OK));
  CHECK(singz::detail::wasapiComSucceeded(S_FALSE));
  CHECK(!singz::detail::wasapiComSucceeded(E_FAIL));
  CHECK(singz::detail::wasapiPreserveFirstFailure(S_OK, E_FAIL) == E_FAIL);
  CHECK(singz::detail::wasapiPreserveFirstFailure(
            E_FAIL, AUDCLNT_E_DEVICE_INVALIDATED) == E_FAIL);
  CHECK(singz::detail::wasapiRuntimeFailureIsDeviceLost(
      AUDCLNT_E_DEVICE_INVALIDATED));
  CHECK(!singz::detail::wasapiRuntimeFailureIsDeviceLost(E_FAIL));
  CHECK(singz::detail::wasapiOpenErrorForState(
            singz::AudioHostError::DifferentDevicesUnsupported,
            singz::detail::WasapiLifecycleState::Opening) ==
        singz::AudioHostError::DifferentDevicesUnsupported);
  CHECK(singz::detail::wasapiOpenErrorForState(
            singz::AudioHostError::Unsupported,
            singz::detail::WasapiLifecycleState::Opening) ==
        singz::AudioHostError::Unsupported);
  CHECK(singz::detail::wasapiOpenErrorForState(
            singz::AudioHostError::DifferentDevicesUnsupported,
            singz::detail::WasapiLifecycleState::DeviceLost) ==
        singz::AudioHostError::DeviceNotFound);

  // Open-failure finalization observes loss injected during owner join. The
  // public error/state pair changes together; without loss the typed pairing
  // error remains intact.
  singz::detail::WasapiRouteLossContext lossDuringShutdown(500, nullptr);
  RouteShutdownTrace routeShutdown{&lossDuringShutdown};
  const singz::detail::WasapiShutdownOperations routeShutdownOperations{
      &routeShutdown, routeShutdownSignal, routeShutdownJoinWithLoss,
      routeShutdownDeactivate, routeShutdownClose};
  CHECK(singz::detail::runWasapiShutdownSequence(routeShutdownOperations));
  CHECK(routeShutdown.steps == std::vector<uint32_t>({1, 2, 3, 4}));
  const auto finalizedLoss = lossDuringShutdown.snapshot();
  CHECK(finalizedLoss.state ==
        singz::detail::WasapiLifecycleState::DeviceLost);
  CHECK(singz::detail::wasapiOpenErrorForState(
            singz::AudioHostError::DifferentDevicesUnsupported,
            finalizedLoss.state) == singz::AudioHostError::DeviceNotFound);
  singz::detail::WasapiRouteLossContext typedWithoutLoss(600, nullptr);
  CHECK(singz::detail::wasapiOpenErrorForState(
            singz::AudioHostError::DifferentDevicesUnsupported,
            typedWithoutLoss.snapshot().state) ==
        singz::AudioHostError::DifferentDevicesUnsupported);

  ChannelProbeTrace fourChannel;
  fourChannel.supported = 4;
  int32_t lastProbe = E_FAIL;
  CHECK(singz::detail::chooseWasapiExclusiveChannelCount(
            4, 8, &fourChannel, traceChannelProbe, &lastProbe) == 4);
  CHECK(fourChannel.attempts == std::vector<uint32_t>({4}));
  CHECK(lastProbe == S_OK);
  ChannelProbeTrace sharedFourExclusiveTwo;
  sharedFourExclusiveTwo.supported = 2;
  CHECK(singz::detail::chooseWasapiExclusiveChannelCount(
            1, 4, &sharedFourExclusiveTwo, traceChannelProbe, &lastProbe) ==
        2);
  CHECK(sharedFourExclusiveTwo.attempts ==
        std::vector<uint32_t>({1, 2}));
  ChannelProbeTrace unsupportedChannels;
  CHECK(singz::detail::chooseWasapiExclusiveChannelCount(
            2, 4, &unsupportedChannels, traceChannelProbe, &lastProbe) == 0);
  CHECK(unsupportedChannels.attempts ==
        std::vector<uint32_t>({2, 3, 4}));
  ChannelProbeTrace terminalProbe;
  terminalProbe.terminal = E_FAIL;
  CHECK(singz::detail::chooseWasapiExclusiveChannelCount(
            1, 8, &terminalProbe, traceChannelProbe, &lastProbe) == 0);
  CHECK(terminalProbe.attempts == std::vector<uint32_t>({1}));

  // Normal teardown leaves the gate active until the admitted render returns.
  // This is the backend ordering: signal, join owner, then deactivate.
  singz::AudioHostCallbackEndpoint callbackEndpoint;
  BlockingRenderTrace blocking;
  singz::prepareAudioHostCallback(&callbackEndpoint, blockingRender,
                                  &blocking);
  singz::activateAudioHostCallback(&callbackEndpoint);
  float callbackSample = 0.0F;
  float* callbackOutput[] = {&callbackSample};
  singz::AudioHostRenderBlock callbackBlock{};
  callbackBlock.output = callbackOutput;
  callbackBlock.outputChannels = 1;
  callbackBlock.frames = 1;
  callbackBlock.maximumFrames = 1;
  callbackBlock.sampleRate = 48000.0;
  callbackBlock.outputClockMaster = true;
  std::thread admitted([&] {
    CHECK(singz::invokeAudioHostCallback(&callbackEndpoint, callbackBlock));
  });
  while (!blocking.entered.load(std::memory_order_acquire))
    std::this_thread::yield();
  CallbackShutdownTrace callbackShutdown{
      &blocking, &callbackEndpoint, &admitted};
  const singz::detail::WasapiShutdownOperations callbackShutdownOperations{
      &callbackShutdown, shutdownSignal, shutdownJoin, shutdownDeactivate,
      shutdownClose};
  CHECK(singz::detail::runWasapiShutdownSequence(
      callbackShutdownOperations));
  CHECK(callbackShutdown.steps == std::vector<uint32_t>({1, 2, 3, 4}));
  CHECK(callbackShutdown.eventsClosed);
  CHECK(callbackEndpoint.invalidCallbacks.load(std::memory_order_relaxed) ==
        0);
  return 0;
}

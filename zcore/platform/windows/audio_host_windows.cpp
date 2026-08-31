#include <zcore/device/audio_host.h>

#if defined(_WIN32)

#include <windows.h>
#include <audioclient.h>
#include <audiopolicy.h>
#include <avrt.h>
#include <initguid.h>
#include <propkeydef.h>
#include <functiondiscoverykeys_devpkey.h>
#include <ks.h>
#include <ksmedia.h>
#include <mmdeviceapi.h>
#include <propidl.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <limits>
#include <memory>
#include <mutex>
#include <new>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include <zcore/device/audio_host_callback.h>

#include "../../src/device/audio_host_fifo.h"
#include "audio_host_windows_helpers.h"

namespace singz {
namespace {

constexpr uint32_t kMaximumWasapiEndpoints = 4096;
constexpr uint32_t kMaximumFifoFrames = 1u << 20;
static_assert(std::atomic<uint64_t>::is_always_lock_free,
              "Windows AudioHost requires lock-free 64-bit telemetry");

void saturatingAdd(std::atomic<uint64_t>* counter, uint64_t amount) noexcept {
  uint64_t current = counter->load(std::memory_order_relaxed);
  for (;;) {
    const uint64_t next = amount > UINT64_MAX - current
                              ? UINT64_MAX : current + amount;
    if (counter->compare_exchange_weak(current, next,
                                       std::memory_order_relaxed,
                                       std::memory_order_relaxed))
      return;
  }
}

template <typename T>
class ComPtr final {
 public:
  ~ComPtr() { reset(); }
  ComPtr() = default;
  ComPtr(const ComPtr&) = delete;
  ComPtr& operator=(const ComPtr&) = delete;
  T* get() const noexcept { return value_; }
  T* operator->() const noexcept { return value_; }
  T** put() noexcept { reset(); return &value_; }
  T* detach() noexcept { T* value = value_; value_ = nullptr; return value; }
  void reset() noexcept { if (value_) value_->Release(); value_ = nullptr; }
  explicit operator bool() const noexcept { return value_ != nullptr; }
 private:
  T* value_{nullptr};
};

class UniqueHandle final {
 public:
  explicit UniqueHandle(HANDLE value = nullptr) noexcept : value_(value) {}
  ~UniqueHandle() { reset(); }
  UniqueHandle(const UniqueHandle&) = delete;
  UniqueHandle& operator=(const UniqueHandle&) = delete;
  HANDLE get() const noexcept { return value_; }
  explicit operator bool() const noexcept { return value_ != nullptr; }
  void reset() noexcept {
    if (value_) CloseHandle(value_);
    value_ = nullptr;
  }

 private:
  HANDLE value_{nullptr};
};

class StaApartment final {
 public:
  StaApartment() : result_(CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED)) {}
  ~StaApartment() { if (result_ == S_OK || result_ == S_FALSE) CoUninitialize(); }
  bool ok() const noexcept { return result_ == S_OK || result_ == S_FALSE; }
  HRESULT result() const noexcept { return result_; }
 private:
  HRESULT result_{E_FAIL};
};

struct WaveFormatDeleter {
  void operator()(WAVEFORMATEX* value) const noexcept {
    if (value) CoTaskMemFree(value);
  }
};
using WaveFormatPtr = std::unique_ptr<WAVEFORMATEX, WaveFormatDeleter>;

std::string hresultMessage(const char* operation, HRESULT result) {
  char code[16]{};
  std::snprintf(code, sizeof(code), "0x%08lx",
                static_cast<unsigned long>(result));
  return std::string(operation) + " failed (" + code + ")";
}

std::string utf8(const wchar_t* value) {
  if (!value || !*value) return {};
  const int count = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value,
                                        -1, nullptr, 0, nullptr, nullptr);
  if (count <= 1 || count > 65536) return {};
  std::string result(static_cast<size_t>(count), '\0');
  if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, -1,
                          result.data(), count, nullptr, nullptr) != count)
    return {};
  result.pop_back();
  return result;
}

std::wstring wide(const std::string& value) {
  if (value.empty() || value.size() > 65535) return {};
  const int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
                                        value.data(),
                                        static_cast<int>(value.size()),
                                        nullptr, 0);
  if (count <= 0 || count > 65536) return {};
  std::wstring result(static_cast<size_t>(count), L'\0');
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                          static_cast<int>(value.size()), result.data(),
                          count) != count)
    return {};
  return result;
}

HRESULT createEnumerator(ComPtr<IMMDeviceEnumerator>& result) {
  return CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                          __uuidof(IMMDeviceEnumerator),
                          reinterpret_cast<void**>(result.put()));
}

std::wstring endpointId(IMMDevice* device) {
  wchar_t* raw = nullptr;
  if (!device || FAILED(device->GetId(&raw)) || !raw) return {};
  std::wstring result(raw);
  CoTaskMemFree(raw);
  return result;
}

std::string propertyString(IMMDevice* device, const PROPERTYKEY& key) {
  ComPtr<IPropertyStore> store;
  if (!device || FAILED(device->OpenPropertyStore(STGM_READ, store.put()))) return {};
  PROPVARIANT value;
  PropVariantInit(&value);
  const HRESULT read = store->GetValue(key, &value);
  std::string result;
  if (SUCCEEDED(read) && value.vt == VT_LPWSTR) result = utf8(value.pwszVal);
  PropVariantClear(&value);
  return result;
}

struct DeviceStateRead {
  HRESULT result{E_POINTER};
  DWORD state{0};
};

DeviceStateRead readDeviceState(IMMDevice* device) {
  DeviceStateRead read;
  if (device) read.result = device->GetState(&read.state);
  return read;
}

struct ContainerIdRead {
  HRESULT propertyStoreResult{E_POINTER};
  HRESULT valueResult{E_UNEXPECTED};
  bool valid{false};
  GUID value{};
};

ContainerIdRead readContainerId(IMMDevice* device) {
  ContainerIdRead result;
  if (!device) return result;
  ComPtr<IPropertyStore> store;
  result.propertyStoreResult =
      device->OpenPropertyStore(STGM_READ, store.put());
  if (FAILED(result.propertyStoreResult)) return result;
  PROPVARIANT value;
  PropVariantInit(&value);
  result.valueResult = store->GetValue(PKEY_Device_ContainerId, &value);
  result.valid = SUCCEEDED(result.valueResult) &&
                 value.vt == VT_CLSID && value.puuid;
  if (result.valid) result.value = *value.puuid;
  PropVariantClear(&value);
  return result;
}

bool floatFormat(const WAVEFORMATEX* mix, uint32_t channels,
                 uint32_t rate, bool preserveMask,
                 WAVEFORMATEXTENSIBLE* output) noexcept {
  if (!output || channels > UINT16_MAX) return false;
  uint16_t blockAlign = 0;
  uint32_t averageBytesPerSecond = 0;
  if (!detail::wasapiFloatFormatRates(rate, channels, &blockAlign,
                                      &averageBytesPerSecond))
    return false;
  WAVEFORMATEXTENSIBLE result{};
  result.Format.wFormatTag = WAVE_FORMAT_EXTENSIBLE;
  result.Format.nChannels = static_cast<WORD>(channels);
  result.Format.nSamplesPerSec = rate;
  result.Format.wBitsPerSample = 32;
  result.Format.nBlockAlign = blockAlign;
  result.Format.nAvgBytesPerSec = averageBytesPerSecond;
  result.Format.cbSize = sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX);
  result.Samples.wValidBitsPerSample = 32;
  result.SubFormat = KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
  if (preserveMask && mix && mix->wFormatTag == WAVE_FORMAT_EXTENSIBLE &&
      mix->cbSize >= sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX))
    result.dwChannelMask =
        reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(mix)->dwChannelMask;
  // Otherwise mask zero is KSAUDIO_SPEAKER_DIRECTOUT: numbered endpoint ports.
  *output = result;
  return true;
}

struct ExclusiveChannelProbeContext {
  IAudioClient* client{nullptr};
  const WAVEFORMATEX* mix{nullptr};
  uint32_t rate{0};
  WAVEFORMATEXTENSIBLE* selected{nullptr};
  bool formatConstructionRejected{false};
};

int32_t probeExclusiveFloatChannels(void* raw,
                                    uint32_t channels) noexcept {
  auto* context = static_cast<ExclusiveChannelProbeContext*>(raw);
  if (!context || !context->client || !context->selected) return E_POINTER;
  WAVEFORMATEXTENSIBLE candidate{};
  if (!floatFormat(context->mix, channels, context->rate,
                   context->mix && channels == context->mix->nChannels,
                   &candidate)) {
    context->formatConstructionRejected = true;
    return E_INVALIDARG;
  }
  const HRESULT result = context->client->IsFormatSupported(
      AUDCLNT_SHAREMODE_EXCLUSIVE, &candidate.Format, nullptr);
  if (result == S_OK) *context->selected = candidate;
  return result;
}

HRESULT setClientProperties(IAudioClient* client, bool capture,
                            std::string* error) {
  ComPtr<IAudioClient2> client2;
  HRESULT result = client->QueryInterface(
      __uuidof(IAudioClient2), reinterpret_cast<void**>(client2.put()));
  if (FAILED(result)) {
    if (error) *error = hresultMessage("WASAPI client properties interface", result);
    return result;
  }
  AudioClientProperties properties{};
  properties.cbSize = sizeof(properties);
  properties.bIsOffload = FALSE;
  properties.eCategory = capture ? AudioCategory_Other : AudioCategory_Media;
  properties.Options = AUDCLNT_STREAMOPTIONS_NONE;
  result = client2->SetClientProperties(&properties);
  if (FAILED(result)) {
    if (error) *error = hresultMessage("WASAPI client properties", result);
    return result;
  }
  return S_OK;
}

uint32_t referenceTimeToFrames(REFERENCE_TIME time, uint32_t rate) noexcept {
  return detail::wasapiReferenceTimeToFramesCeil(time, rate);
}

uint64_t qpcNowNs(uint64_t frequency) noexcept {
  LARGE_INTEGER now{};
  if (!frequency || !QueryPerformanceCounter(&now) || now.QuadPart < 0) return 0;
  const uint64_t ticks = static_cast<uint64_t>(now.QuadPart);
  const uint64_t seconds = ticks / frequency;
  const uint64_t remainder = ticks % frequency;
  if (seconds > UINT64_MAX / 1000000000ull) return UINT64_MAX;
  return seconds * 1000000000ull + remainder * 1000000000ull / frequency;
}

struct EndpointPrepared {
  bool ok{false};
  std::string error;
  uint32_t sampleRate{0};
  uint32_t endpointChannels{0};
  uint32_t periodFrames{0};
  uint32_t bufferFrames{0};
  uint64_t streamLatency100ns{0};
  AudioHostError hostError{AudioHostError::ProviderFailure};
};

struct EndpointProfile {
  EndpointPrepared prepared;
  WAVEFORMATEXTENSIBLE format{};
};

HRESULT activateClient(IMMDevice* device, ComPtr<IAudioClient>& client) {
  client.reset();
  return device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                          reinterpret_cast<void**>(client.put()));
}

bool activateExactEndpointProfile(IMMDevice* device, bool capture,
                                  bool exclusive, uint32_t requestedRate,
                                  uint32_t requiredChannels,
                                  ComPtr<IAudioClient>& client,
                                  EndpointProfile* profile,
                                  HRESULT* exactFormatResult) {
  if (exactFormatResult) *exactFormatResult = S_OK;
  profile->prepared.error.clear();
  profile->prepared.hostError = AudioHostError::ProviderFailure;
  HRESULT result = activateClient(device, client);
  if (FAILED(result)) {
    profile->prepared.hostError = detail::classifyWasapiOpenFailure(
        detail::WasapiOpenStage::ClientActivation, false,
        detail::WasapiOpenOutcome::ApiFailure, result);
    profile->prepared.error = hresultMessage("WASAPI client activation", result);
    return false;
  }
  result = setClientProperties(client.get(), capture,
                               &profile->prepared.error);
  if (FAILED(result)) {
    profile->prepared.hostError = detail::classifyWasapiOpenFailure(
        detail::WasapiOpenStage::ClientProperties, false,
        detail::WasapiOpenOutcome::ApiFailure, result);
    return false;
  }
  WAVEFORMATEX* rawMix = nullptr;
  result = client->GetMixFormat(&rawMix);
  WaveFormatPtr mix(rawMix);
  if (FAILED(result) || !mix || !mix->nChannels ||
      mix->nChannels > kAudioHostMaxChannels || !mix->nSamplesPerSec) {
    profile->prepared.hostError = detail::classifyWasapiOpenFailure(
        detail::WasapiOpenStage::MixFormat, false,
        FAILED(result) ? detail::WasapiOpenOutcome::ApiFailure
                       : detail::WasapiOpenOutcome::MalformedAutomaticValue,
        result);
    profile->prepared.error = FAILED(result)
        ? hresultMessage("WASAPI mix format", result)
        : "WASAPI returned an invalid active shared profile";
    return false;
  }
  const uint32_t rate = requestedRate ? requestedRate : mix->nSamplesPerSec;
  uint32_t channels = mix->nChannels;
  if (!requiredChannels || requiredChannels > kAudioHostMaxChannels) {
    profile->prepared.hostError = detail::classifyWasapiOpenFailure(
        detail::WasapiOpenStage::RequestValidation, true,
        detail::WasapiOpenOutcome::CallerChannelMapRejected, S_OK);
    profile->prepared.error =
        "The requested WASAPI channel count is outside the supported bound";
    return false;
  }
  const AudioHostError sharedRateError = exclusive
      ? AudioHostError::None
      : detail::classifyWasapiSharedFormatProfile(
            requestedRate, mix->nSamplesPerSec, S_OK);
  if (sharedRateError != AudioHostError::None) {
    profile->prepared.hostError = sharedRateError;
    profile->prepared.error =
        "Shared WASAPI uses the endpoint's active sample rate";
    return false;
  }
  if (!exclusive && requiredChannels > mix->nChannels) {
    profile->prepared.hostError = detail::classifyWasapiOpenFailure(
        detail::WasapiOpenStage::RequestValidation, true,
        detail::WasapiOpenOutcome::CallerChannelMapRejected, S_OK);
    profile->prepared.error =
        "A requested shared WASAPI channel is absent from the active profile";
    return false;
  }
  if (exclusive) {
    ExclusiveChannelProbeContext probeContext{
        client.get(), mix.get(), rate, &profile->format};
    int32_t lastProbe = E_INVALIDARG;
    channels = detail::chooseWasapiExclusiveChannelCount(
        requiredChannels, kAudioHostMaxChannels, &probeContext,
        probeExclusiveFloatChannels, &lastProbe);
    if (exactFormatResult) *exactFormatResult = static_cast<HRESULT>(lastProbe);
    if (!channels) {
      const bool exactRejected = probeContext.formatConstructionRejected ||
          lastProbe == S_FALSE || lastProbe == AUDCLNT_E_UNSUPPORTED_FORMAT;
      profile->prepared.hostError = detail::classifyWasapiOpenFailure(
          detail::WasapiOpenStage::FormatProbe, exactRejected,
          exactRejected
              ? detail::WasapiOpenOutcome::CallerExactTopologyRejected
              : detail::WasapiOpenOutcome::ApiFailure,
          probeContext.formatConstructionRejected ? S_OK : lastProbe);
      profile->prepared.error = hresultMessage(
          capture ? "WASAPI capture exact float32 exclusive channel profile"
                  : "WASAPI render exact float32 exclusive channel profile",
          static_cast<HRESULT>(lastProbe));
      profile->prepared.error +=
          "; integer exclusive conversion is deferred";
      return false;
    }
  } else if (!floatFormat(mix.get(), channels, rate, true,
                          &profile->format)) {
    profile->prepared.hostError = detail::classifyWasapiOpenFailure(
        detail::WasapiOpenStage::RequestValidation, requestedRate != 0,
        requestedRate
            ? detail::WasapiOpenOutcome::CallerExactTopologyRejected
            : detail::WasapiOpenOutcome::MalformedAutomaticValue,
        S_OK);
    profile->prepared.error =
        "The requested float32 WASAPI frame layout exceeds WAVEFORMAT limits";
    return false;
  }
  if (exclusive) {
    profile->prepared.sampleRate = rate;
    profile->prepared.endpointChannels = channels;
    return true;
  }
  WAVEFORMATEX* closestRaw = nullptr;
  result = client->IsFormatSupported(
      AUDCLNT_SHAREMODE_SHARED, &profile->format.Format, &closestRaw);
  if (exactFormatResult) *exactFormatResult = result;
  WaveFormatPtr closest(closestRaw);
  if (result != S_OK) {
    profile->prepared.hostError = detail::classifyWasapiSharedFormatProfile(
        requestedRate, mix->nSamplesPerSec, result);
    profile->prepared.error = hresultMessage(
        capture ? "WASAPI capture exact float32 shared format"
                : "WASAPI render exact float32 shared format",
        result);
    profile->prepared.error +=
        "; the active shared endpoint profile was not exact";
    return false;
  }
  profile->prepared.sampleRate = rate;
  profile->prepared.endpointChannels = channels;
  return true;
}

bool activateExactEndpointProfileWithRetry(
    IMMDevice* device, bool capture, bool exclusive, uint32_t requestedRate,
    uint32_t requiredChannels, HANDLE stopEvent,
    ComPtr<IAudioClient>& client, EndpointProfile* profile) {
  for (uint32_t attempt = 1;
       attempt <= detail::kWasapiMaximumExactProfileAttempts; ++attempt) {
    HRESULT exactFormatResult = S_OK;
    if (activateExactEndpointProfile(
            device, capture, exclusive, requestedRate, requiredChannels,
            client, profile, &exactFormatResult))
      return true;
    if (!detail::shouldRetryWasapiExactProfile(exactFormatResult, attempt))
      return false;
    // Control-domain endpoint preparation, before either stream starts. Wait
    // on the session stop event rather than sleeping or polling an audio loop.
    if (!stopEvent || WaitForSingleObject(stopEvent, 10) != WAIT_TIMEOUT) {
      profile->prepared.error =
          "WASAPI exact-profile retry was interrupted by stream shutdown";
      return false;
    }
  }
  return false;
}

bool buildEndpointProfile(IMMDevice* device, bool capture, bool exclusive,
                          uint32_t requestedRate, uint32_t requestedFrames,
                          uint32_t requiredChannels,
                          HANDLE stopEvent,
                          ComPtr<IAudioClient>& client,
                          EndpointProfile* profile) {
  if (!activateExactEndpointProfileWithRetry(
          device, capture, exclusive, requestedRate, requiredChannels,
          stopEvent, client, profile))
    return false;
  uint32_t rate = profile->prepared.sampleRate;
  uint32_t channels = profile->prepared.endpointChannels;
  HRESULT result = S_OK;

  uint32_t selectedPeriod = 0;
  if (!exclusive) {
    ComPtr<IAudioClient3> client3;
    const HRESULT query3 = client->QueryInterface(
        __uuidof(IAudioClient3), reinterpret_cast<void**>(client3.put()));
    const auto client3Action = detail::classifyWasapiClient3Query(
        query3, requestedFrames != 0);
    if (client3Action == detail::WasapiClient3QueryAction::Unsupported) {
      profile->prepared.hostError = detail::classifyWasapiOpenFailure(
          detail::WasapiOpenStage::SharedPeriod, true,
          detail::WasapiOpenOutcome::ProviderUnsupported, query3);
      profile->prepared.error =
          "This Windows endpoint does not expose IAudioClient3 for the explicit shared period";
      return false;
    }
    if (client3Action == detail::WasapiClient3QueryAction::Fail) {
      profile->prepared.hostError = detail::classifyWasapiOpenFailure(
          detail::WasapiOpenStage::SharedPeriod, requestedFrames != 0,
          detail::WasapiOpenOutcome::ApiFailure, query3);
      profile->prepared.error = hresultMessage(
          "WASAPI IAudioClient3 query", query3);
      return false;
    }
    HRESULT periodResult = E_NOINTERFACE;
    HRESULT initializeResult = E_NOINTERFACE;
    if (client3Action == detail::WasapiClient3QueryAction::UseClient3) {
      UINT32 preferred = 0, fundamental = 0, minimum = 0, maximum = 0;
      periodResult = client3->GetSharedModeEnginePeriod(
          &profile->format.Format, &preferred, &fundamental, &minimum, &maximum);
      if (SUCCEEDED(periodResult) && !detail::chooseWasapiSharedPeriod(
                                         requestedFrames, fundamental, minimum,
                                         maximum, &selectedPeriod)) {
        profile->prepared.hostError = detail::classifyWasapiOpenFailure(
            detail::WasapiOpenStage::SharedPeriod, requestedFrames != 0,
            requestedFrames
                ? detail::WasapiOpenOutcome::CallerPeriodRejected
                : detail::WasapiOpenOutcome::MalformedAutomaticValue,
            periodResult);
        profile->prepared.error =
            "The requested shared WASAPI period is outside the exact legal range";
        return false;
      }
      if (SUCCEEDED(periodResult))
        initializeResult = client3->InitializeSharedAudioStream(
            AUDCLNT_STREAMFLAGS_EVENTCALLBACK, selectedPeriod,
            &profile->format.Format, nullptr);
    }
    if (FAILED(periodResult) &&
        detail::wasapiRuntimeFailureIsDeviceLost(periodResult)) {
      profile->prepared.hostError = detail::classifyWasapiOpenFailure(
          detail::WasapiOpenStage::SharedPeriod, requestedFrames != 0,
          detail::WasapiOpenOutcome::ApiFailure, periodResult);
      profile->prepared.error = hresultMessage(
          "WASAPI shared period query", periodResult);
      return false;
    }
    if (FAILED(initializeResult) &&
        detail::wasapiRuntimeFailureIsDeviceLost(initializeResult)) {
      profile->prepared.hostError = detail::classifyWasapiOpenFailure(
          detail::WasapiOpenStage::SharedInitialize, requestedFrames != 0,
          detail::WasapiOpenOutcome::ApiFailure, initializeResult);
      profile->prepared.error = hresultMessage(
          "WASAPI low-period shared initialization", initializeResult);
      return false;
    }
    const auto sharedAction = detail::classifyWasapiSharedAttempt(
        SUCCEEDED(query3), periodResult, initializeResult, requestedFrames);
    if (sharedAction == detail::WasapiSharedAttemptAction::Reject) {
      const HRESULT rejectedResult =
          SUCCEEDED(query3) && SUCCEEDED(periodResult)
              ? initializeResult
              : (FAILED(periodResult) ? periodResult : query3);
      profile->prepared.hostError = detail::classifyWasapiOpenFailure(
          SUCCEEDED(query3) && SUCCEEDED(periodResult)
              ? detail::WasapiOpenStage::SharedInitialize
              : detail::WasapiOpenStage::SharedPeriod,
          requestedFrames != 0, detail::WasapiOpenOutcome::ApiFailure,
          rejectedResult);
      profile->prepared.error = SUCCEEDED(query3) && SUCCEEDED(periodResult)
          ? hresultMessage("WASAPI low-period shared initialization",
                           initializeResult)
          : "This Windows endpoint cannot honor the explicit shared period";
      return false;
    }
    if (sharedAction == detail::WasapiSharedAttemptAction::Complete) {
      WAVEFORMATEX* currentRaw = nullptr;
      UINT32 actual = 0;
      const HRESULT currentResult =
          client3->GetCurrentSharedModeEnginePeriod(&currentRaw, &actual);
      // Own a provider-allocated out pointer even when the HRESULT failed,
      // but classify that HRESULT before the helper is allowed to inspect it.
      WaveFormatPtr current(currentRaw);
      const AudioHostError currentPeriodError =
          detail::classifyWasapiCurrentSharedProfile(
              currentResult, &profile->format.Format, current.get(),
              requestedFrames, selectedPeriod, actual);
      if (currentPeriodError != AudioHostError::None) {
        profile->prepared.hostError = currentPeriodError;
        profile->prepared.error = FAILED(currentResult)
            ? hresultMessage("WASAPI current shared period", currentResult)
            : "The active WASAPI shared period changed after initialization";
        return false;
      }
      selectedPeriod = actual;
    } else {
      // A failed low-period initialization consumes that client. Even when
      // IAudioClient3 is absent, using one fresh path keeps fallback ordering
      // identical: Activate -> SetClientProperties -> GetMixFormat -> exact
      // profile validation -> legacy Initialize.
      selectedPeriod = 0;
      client3.reset();
      if (!activateExactEndpointProfileWithRetry(
              device, capture, false, requestedRate, requiredChannels,
              stopEvent, client, profile))
        return false;
      rate = profile->prepared.sampleRate;
      channels = profile->prepared.endpointChannels;
      result = client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                                  AUDCLNT_STREAMFLAGS_EVENTCALLBACK, 0, 0,
                                  &profile->format.Format, nullptr);
      if (FAILED(result)) {
        profile->prepared.hostError = detail::classifyWasapiOpenFailure(
            detail::WasapiOpenStage::LegacyInitialize, false,
            detail::WasapiOpenOutcome::ApiFailure, result);
        profile->prepared.error = hresultMessage("WASAPI shared initialization", result);
        return false;
      }
    }
    if (!selectedPeriod) {
      REFERENCE_TIME defaultPeriod = 0;
      result = client->GetDevicePeriod(&defaultPeriod, nullptr);
      selectedPeriod = SUCCEEDED(result)
                           ? referenceTimeToFrames(defaultPeriod, rate) : 0;
      if (FAILED(result) || !selectedPeriod) {
        profile->prepared.hostError = detail::classifyWasapiOpenFailure(
            detail::WasapiOpenStage::SharedPeriod, false,
            FAILED(result) ? detail::WasapiOpenOutcome::ApiFailure
                           : detail::WasapiOpenOutcome::MalformedAutomaticValue,
            result);
        profile->prepared.error = FAILED(result)
            ? hresultMessage("WASAPI legacy shared default period", result)
            : "WASAPI returned an invalid legacy shared default period";
        return false;
      }
    }
  } else {
    REFERENCE_TIME defaultPeriod = 0, minimumPeriod = 0;
    result = client->GetDevicePeriod(&defaultPeriod, &minimumPeriod);
    if (FAILED(result)) {
      profile->prepared.hostError = detail::classifyWasapiOpenFailure(
          detail::WasapiOpenStage::ExclusivePeriod, false,
          detail::WasapiOpenOutcome::ApiFailure, result);
      profile->prepared.error = hresultMessage("WASAPI exclusive period", result);
      return false;
    }
    selectedPeriod = requestedFrames ? requestedFrames
                                     : referenceTimeToFrames(minimumPeriod, rate);
    if (!selectedPeriod) {
      profile->prepared.hostError = detail::classifyWasapiOpenFailure(
          detail::WasapiOpenStage::ExclusivePeriod, false,
          detail::WasapiOpenOutcome::MalformedAutomaticValue, S_OK);
      profile->prepared.error = "WASAPI returned an invalid exclusive period";
      return false;
    }
    REFERENCE_TIME duration = static_cast<REFERENCE_TIME>(
        detail::wasapiFramesToReferenceTime(selectedPeriod, rate));
    result = client->Initialize(AUDCLNT_SHAREMODE_EXCLUSIVE,
                                AUDCLNT_STREAMFLAGS_EVENTCALLBACK, duration,
                                duration, &profile->format.Format, nullptr);
    if (result == AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED) {
      UINT32 alignedFrames = 0;
      const HRESULT aligned = client->GetBufferSize(&alignedFrames);
      const auto alignmentAction =
          detail::classifyWasapiExclusiveAlignment(
              result, aligned, alignedFrames);
      if (alignmentAction ==
          detail::WasapiExclusiveAlignmentAction::Fail) {
        profile->prepared.hostError = detail::classifyWasapiOpenFailure(
            detail::WasapiOpenStage::BufferSize, false,
            FAILED(aligned) ? detail::WasapiOpenOutcome::ApiFailure
                            : detail::WasapiOpenOutcome::MalformedAutomaticValue,
            aligned);
        profile->prepared.error = FAILED(aligned)
            ? hresultMessage("WASAPI exclusive aligned buffer", aligned)
            : "WASAPI returned an empty exclusive aligned buffer";
        return false;
      }
      if (alignmentAction !=
          detail::WasapiExclusiveAlignmentAction::ReactivateAligned) {
        profile->prepared.hostError = detail::classifyWasapiOpenFailure(
            detail::WasapiOpenStage::ExclusiveInitialize,
            requestedFrames != 0, detail::WasapiOpenOutcome::ApiFailure,
            result);
        profile->prepared.error = hresultMessage(
            "WASAPI exclusive alignment recovery", result);
        return false;
      }
      if (!activateExactEndpointProfileWithRetry(
              device, capture, true, requestedRate, requiredChannels,
              stopEvent, client, profile))
        return false;
      rate = profile->prepared.sampleRate;
      channels = profile->prepared.endpointChannels;
      selectedPeriod = alignedFrames;
      duration = static_cast<REFERENCE_TIME>(
          detail::wasapiFramesToReferenceTime(selectedPeriod, rate));
      result = client->Initialize(AUDCLNT_SHAREMODE_EXCLUSIVE,
                                  AUDCLNT_STREAMFLAGS_EVENTCALLBACK, duration,
                                  duration, &profile->format.Format, nullptr);
    }
    if (FAILED(result)) {
      profile->prepared.hostError = detail::classifyWasapiOpenFailure(
          detail::WasapiOpenStage::ExclusiveInitialize,
          requestedFrames != 0, detail::WasapiOpenOutcome::ApiFailure,
          result);
      profile->prepared.error = hresultMessage("WASAPI exclusive initialization", result);
      return false;
    }
  }
  UINT32 bufferFrames = 0;
  result = client->GetBufferSize(&bufferFrames);
  if (FAILED(result) || !bufferFrames) {
    profile->prepared.hostError = detail::classifyWasapiOpenFailure(
        detail::WasapiOpenStage::BufferSize, false,
        FAILED(result) ? detail::WasapiOpenOutcome::ApiFailure
                       : detail::WasapiOpenOutcome::MalformedAutomaticValue,
        result);
    profile->prepared.error = FAILED(result)
        ? hresultMessage("WASAPI endpoint buffer", result)
        : "WASAPI returned an empty endpoint buffer";
    return false;
  }
  if (exclusive && !detail::wasapiExclusiveBufferMatches(
                       requestedFrames, bufferFrames)) {
    profile->prepared.hostError = detail::classifyWasapiOpenFailure(
        detail::WasapiOpenStage::RequestValidation,
        requestedFrames != 0,
        detail::WasapiOpenOutcome::CallerAlignmentMismatch, S_OK);
    profile->prepared.error =
        "The exclusive endpoint buffer does not match the exact requested frame count";
    return false;
  }
  if (exclusive) selectedPeriod = bufferFrames;
  REFERENCE_TIME streamLatency = 0;
  const HRESULT streamLatencyResult = client->GetStreamLatency(&streamLatency);
  const auto streamLatencyAction = detail::classifyWasapiOptionalOpenResult(
      detail::WasapiOptionalOpenStage::StreamLatency, streamLatencyResult,
      SUCCEEDED(streamLatencyResult) && streamLatency > 0);
  if (streamLatencyAction ==
      detail::WasapiOptionalOpenAction::FailDeviceLost) {
    profile->prepared.hostError = AudioHostError::DeviceNotFound;
    profile->prepared.error = hresultMessage(
        "WASAPI stream latency", streamLatencyResult);
    return false;
  }
  if (streamLatencyAction ==
      detail::WasapiOptionalOpenAction::UseFallback)
    streamLatency = 0;
  profile->prepared = {true, {}, rate, channels,
                       selectedPeriod ? selectedPeriod : bufferFrames,
                       bufferFrames,
                       streamLatency > 0 ? static_cast<uint64_t>(streamLatency) : 0};
  return true;
}

class MmcssScope final {
 public:
  bool enter() noexcept {
    DWORD taskIndex = 0;
    handle_ = AvSetMmThreadCharacteristicsW(L"Pro Audio", &taskIndex);
    return handle_ && AvSetMmThreadPriority(handle_, AVRT_PRIORITY_NORMAL);
  }
  ~MmcssScope() { if (handle_) AvRevertMmThreadCharacteristics(handle_); }
 private:
  HANDLE handle_{nullptr};
};

bool selectedId(const std::wstring& input, const std::wstring& output,
                LPCWSTR candidate) noexcept {
  return candidate && (input == candidate || output == candidate);
}

class EndpointNotification final : public IMMNotificationClient {
 public:
  EndpointNotification(std::wstring input, std::wstring output,
                       std::shared_ptr<detail::WasapiRouteLossContext> routeContext)
      : input_(std::move(input)), output_(std::move(output)),
        routeContext_(std::move(routeContext)) {}
  ULONG STDMETHODCALLTYPE AddRef() override {
    return static_cast<ULONG>(InterlockedIncrement(&references_));
  }
  ULONG STDMETHODCALLTYPE Release() override {
    const ULONG remaining = static_cast<ULONG>(InterlockedDecrement(&references_));
    if (!remaining) delete this;
    return remaining;
  }
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID id, void** value) override {
    if (!value) return E_POINTER;
    if (id == __uuidof(IUnknown) || id == __uuidof(IMMNotificationClient)) {
      *value = static_cast<IMMNotificationClient*>(this);
      AddRef();
      return S_OK;
    }
    *value = nullptr;
    return E_NOINTERFACE;
  }
  HRESULT STDMETHODCALLTYPE OnDeviceStateChanged(LPCWSTR id, DWORD state) override {
    if (state != DEVICE_STATE_ACTIVE && selectedId(input_, output_, id)) markLost();
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE OnDeviceAdded(LPCWSTR) override { return S_OK; }
  HRESULT STDMETHODCALLTYPE OnDeviceRemoved(LPCWSTR id) override {
    if (selectedId(input_, output_, id)) markLost();
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE OnDefaultDeviceChanged(EDataFlow, ERole, LPCWSTR) override {
    return S_OK;  // Explicit endpoint IDs remain pinned.
  }
  HRESULT STDMETHODCALLTYPE OnPropertyValueChanged(
      LPCWSTR id, const PROPERTYKEY key) override {
    // Friendly-name, icon, volume and effect properties may change during
    // ordinary activation. Only properties that can invalidate the exact
    // profile or physical pairing close this pinned session.
    const bool routeProperty =
        IsEqualPropertyKey(key, PKEY_Device_ContainerId) ||
        IsEqualPropertyKey(key, PKEY_AudioEngine_DeviceFormat) ||
        IsEqualPropertyKey(key, PKEY_AudioEngine_OEMFormat);
    if (routeProperty && selectedId(input_, output_, id)) markLost();
    return S_OK;
  }
 private:
  ~EndpointNotification() = default;
  void markLost() noexcept {
    routeContext_->markLost();
  }
  volatile LONG references_{1};
  const std::wstring input_;
  const std::wstring output_;
  const std::shared_ptr<detail::WasapiRouteLossContext> routeContext_;
};

class EndpointNotificationRegistration final {
 public:
  explicit EndpointNotificationRegistration(
      std::atomic<bool>* quarantineStopEvent) noexcept
      : quarantineStopEvent_(quarantineStopEvent) {}
  ~EndpointNotificationRegistration() { reset(); }
  EndpointNotificationRegistration(const EndpointNotificationRegistration&) =
      delete;
  EndpointNotificationRegistration& operator=(
      const EndpointNotificationRegistration&) = delete;

  bool arm(const std::wstring& input, const std::wstring& output,
           const std::shared_ptr<detail::WasapiRouteLossContext>& routeContext,
           std::string* error) {
    HRESULT result = createEnumerator(enumerator_);
    if (FAILED(result)) {
      if (error)
        *error = hresultMessage("WASAPI notification enumerator", result);
      return false;
    }
    notification_ = new (std::nothrow)
        EndpointNotification(input, output, routeContext);
    if (!notification_) {
      if (error)
        *error =
            "WASAPI could not allocate the mandatory endpoint notification guard";
      return false;
    }
    result = enumerator_->RegisterEndpointNotificationCallback(notification_);
    if (FAILED(result)) {
      notification_->Release();
      notification_ = nullptr;
      if (error)
        *error = hresultMessage(
            "WASAPI endpoint notification registration", result);
      return false;
    }
    registered_ = true;
    return true;
  }

 private:
  void reset() noexcept {
    if (!notification_) return;
    if (!registered_ ||
        SUCCEEDED(enumerator_->UnregisterEndpointNotificationCallback(
            notification_))) {
      notification_->Release();
    } else {
      // The callback owns its independent shared session context. Preserve
      // every object and its event if Windows cannot prove unregistration.
      (void)enumerator_.detach();
      if (quarantineStopEvent_)
        quarantineStopEvent_->store(true, std::memory_order_release);
    }
    notification_ = nullptr;
    registered_ = false;
  }

  ComPtr<IMMDeviceEnumerator> enumerator_;
  EndpointNotification* notification_{nullptr};
  bool registered_{false};
  std::atomic<bool>* quarantineStopEvent_{nullptr};
};

AudioHostResult failure(AudioHostError error, const std::string& message,
                        AudioHostState state = AudioHostState::Error) {
  return {false, error, state, {}, {}, message};
}

AudioHostState audioHostState(
    detail::WasapiLifecycleState state) noexcept {
  switch (state) {
    case detail::WasapiLifecycleState::Opening:
      return AudioHostState::Closed;
    case detail::WasapiLifecycleState::Open:
    case detail::WasapiLifecycleState::Starting:
      return AudioHostState::Open;
    case detail::WasapiLifecycleState::Running:
      return AudioHostState::Running;
    case detail::WasapiLifecycleState::Stopped:
      return AudioHostState::Stopped;
    case detail::WasapiLifecycleState::DeviceLost:
      return AudioHostState::DeviceLost;
    case detail::WasapiLifecycleState::Error:
      return AudioHostState::Error;
  }
  return AudioHostState::Error;
}

struct PairingResult {
  bool ok{false};
  AudioHostError error{AudioHostError::ProviderFailure};
  std::string message;
};

PairingResult verifyEndpointPair(const std::wstring& inputId,
                                 const std::wstring& outputId) {
  StaApartment apartment;
  if (!apartment.ok()) return {false, AudioHostError::ProviderFailure,
      hresultMessage("WASAPI pairing COM initialization", apartment.result())};
  ComPtr<IMMDeviceEnumerator> enumerator;
  HRESULT result = createEnumerator(enumerator);
  if (FAILED(result)) return {false, AudioHostError::ProviderFailure,
      hresultMessage("WASAPI device enumerator", result)};
  ComPtr<IMMDevice> input, output;
  result = enumerator->GetDevice(inputId.c_str(), input.put());
  if (FAILED(result))
    return {false, detail::classifyWasapiOpenFailure(
                       detail::WasapiOpenStage::DeviceLookup, true,
                       detail::WasapiOpenOutcome::ApiFailure, result),
            hresultMessage("WASAPI capture endpoint lookup", result)};
  result = enumerator->GetDevice(outputId.c_str(), output.put());
  if (FAILED(result))
    return {false, detail::classifyWasapiOpenFailure(
                       detail::WasapiOpenStage::DeviceLookup, true,
                       detail::WasapiOpenOutcome::ApiFailure, result),
            hresultMessage("WASAPI render endpoint lookup", result)};
  const DeviceStateRead inputState = readDeviceState(input.get());
  if (FAILED(inputState.result))
    return {false, detail::classifyWasapiPairing(
                       detail::WasapiPairingStage::InputState,
                       detail::WasapiPairingOutcome::ApiFailure,
                       inputState.result),
            hresultMessage("WASAPI capture endpoint state", inputState.result)};
  if (inputState.state != DEVICE_STATE_ACTIVE)
    return {false, detail::classifyWasapiPairing(
                       detail::WasapiPairingStage::InputState,
                       detail::WasapiPairingOutcome::Inactive, S_OK),
            "The selected WASAPI capture endpoint is not active"};
  const DeviceStateRead outputState = readDeviceState(output.get());
  if (FAILED(outputState.result))
    return {false, detail::classifyWasapiPairing(
                       detail::WasapiPairingStage::OutputState,
                       detail::WasapiPairingOutcome::ApiFailure,
                       outputState.result),
            hresultMessage("WASAPI render endpoint state", outputState.result)};
  if (outputState.state != DEVICE_STATE_ACTIVE)
    return {false, detail::classifyWasapiPairing(
                       detail::WasapiPairingStage::OutputState,
                       detail::WasapiPairingOutcome::Inactive, S_OK),
            "The selected WASAPI render endpoint is not active"};

  const ContainerIdRead inputContainer = readContainerId(input.get());
  if (FAILED(inputContainer.propertyStoreResult))
    return {false, detail::classifyWasapiPairing(
                       detail::WasapiPairingStage::InputPropertyStore,
                       detail::WasapiPairingOutcome::ApiFailure,
                       inputContainer.propertyStoreResult),
            hresultMessage("WASAPI capture property store",
                           inputContainer.propertyStoreResult)};
  if (FAILED(inputContainer.valueResult))
    return {false, detail::classifyWasapiPairing(
                       detail::WasapiPairingStage::InputContainerValue,
                       detail::WasapiPairingOutcome::ApiFailure,
                       inputContainer.valueResult),
            hresultMessage("WASAPI capture ContainerId",
                           inputContainer.valueResult)};
  if (!inputContainer.valid)
    return {false, detail::classifyWasapiPairing(
                       detail::WasapiPairingStage::InputContainerValue,
                       detail::WasapiPairingOutcome::MissingOrMalformedContainer,
                       S_OK),
            "The selected WASAPI capture endpoint has no valid ContainerId"};

  const ContainerIdRead outputContainer = readContainerId(output.get());
  if (FAILED(outputContainer.propertyStoreResult))
    return {false, detail::classifyWasapiPairing(
                       detail::WasapiPairingStage::OutputPropertyStore,
                       detail::WasapiPairingOutcome::ApiFailure,
                       outputContainer.propertyStoreResult),
            hresultMessage("WASAPI render property store",
                           outputContainer.propertyStoreResult)};
  if (FAILED(outputContainer.valueResult))
    return {false, detail::classifyWasapiPairing(
                       detail::WasapiPairingStage::OutputContainerValue,
                       detail::WasapiPairingOutcome::ApiFailure,
                       outputContainer.valueResult),
            hresultMessage("WASAPI render ContainerId",
                           outputContainer.valueResult)};
  if (!outputContainer.valid)
    return {false, detail::classifyWasapiPairing(
                       detail::WasapiPairingStage::OutputContainerValue,
                       detail::WasapiPairingOutcome::MissingOrMalformedContainer,
                       S_OK),
            "The selected WASAPI render endpoint has no valid ContainerId"};
  if (!IsEqualGUID(inputContainer.value, outputContainer.value))
    return {false, detail::classifyWasapiPairing(
                       detail::WasapiPairingStage::ContainerComparison,
                       detail::WasapiPairingOutcome::ContainerMismatch, S_OK),
            "Phase 3B requires capture and render endpoints from the same Windows device container"};
  return {true, AudioHostError::None, {}};
}

AudioHostInventory enumerateOnSta() {
  AudioHostInventory inventory;
  StaApartment apartment;
  if (!apartment.ok()) return inventory;
  ComPtr<IMMDeviceEnumerator> enumerator;
  if (FAILED(createEnumerator(enumerator))) return inventory;
  auto defaultId = [&](EDataFlow flow) {
    ComPtr<IMMDevice> device;
    if (FAILED(enumerator->GetDefaultAudioEndpoint(flow, eConsole, device.put())))
      return std::wstring{};
    return endpointId(device.get());
  };
  const std::wstring defaultInput = defaultId(eCapture);
  const std::wstring defaultOutput = defaultId(eRender);
  auto add = [&](EDataFlow flow) {
    ComPtr<IMMDeviceCollection> collection;
    if (FAILED(enumerator->EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE,
                                              collection.put()))) return;
    UINT count = 0;
    if (FAILED(collection->GetCount(&count)) || count > kMaximumWasapiEndpoints) return;
    for (UINT index = 0; index < count; ++index) {
      ComPtr<IMMDevice> device;
      if (FAILED(collection->Item(index, device.put()))) continue;
      const std::wstring id = endpointId(device.get());
      const std::string uid = utf8(id.c_str());
      if (uid.empty()) continue;
      ComPtr<IAudioClient> client;
      std::string ignored;
      if (FAILED(activateClient(device.get(), client)) ||
          FAILED(setClientProperties(client.get(), flow == eCapture,
                                     &ignored))) continue;
      WAVEFORMATEX* raw = nullptr;
      if (FAILED(client->GetMixFormat(&raw)) || !raw) continue;
      WaveFormatPtr mix(raw);
      if (!mix->nChannels || mix->nChannels > kAudioHostMaxChannels ||
          !mix->nSamplesPerSec) continue;
      AudioHostDeviceInfo info;
      info.uid = uid;
      info.label = propertyString(device.get(), PKEY_Device_FriendlyName);
      if (info.label.empty()) info.label = flow == eCapture
          ? "Windows audio input" : "Windows audio output";
      info.defaultInput = flow == eCapture && id == defaultInput;
      info.defaultOutput = flow == eRender && id == defaultOutput;
      info.inputChannels = flow == eCapture ? mix->nChannels : 0;
      info.outputChannels = flow == eRender ? mix->nChannels : 0;
      info.nominalSampleRate = mix->nSamplesPerSec;
      info.sampleRateRanges = {{static_cast<double>(mix->nSamplesPerSec),
                                static_cast<double>(mix->nSamplesPerSec)}};
      info.direction = flow == eCapture ? AudioHostEndpointDirection::Input
                                        : AudioHostEndpointDirection::Output;
      ComPtr<IAudioClient3> client3;
      if (SUCCEEDED(client->QueryInterface(__uuidof(IAudioClient3),
                                           reinterpret_cast<void**>(client3.put())))) {
        UINT32 preferred = 0, fundamental = 0, minimum = 0, maximum = 0;
        if (SUCCEEDED(client3->GetSharedModeEnginePeriod(
                mix.get(), &preferred, &fundamental, &minimum, &maximum)))
          info.bufferFrames = {minimum, maximum, preferred, fundamental};
      }
      if (info.defaultInput) inventory.defaultInputUid = uid;
      if (info.defaultOutput) inventory.defaultOutputUid = uid;
      inventory.devices.push_back(std::move(info));
    }
  };
  add(eCapture);
  add(eRender);
  return inventory;
}

class WasapiAudioHostBackend final : public AudioHostBackend {
 public:
  ~WasapiAudioHostBackend() override { stop(); }

  AudioHostInventory enumerate() const override {
    AudioHostInventory inventory;
    try {
      std::thread worker([&] { inventory = enumerateOnSta(); });
      worker.join();
    } catch (...) {
      return {};
    }
    return inventory;
  }

  AudioHostResult open(const AudioHostConfig& config, AudioHostRender render,
                       void* renderContext) override {
    stop();
    const uint64_t previousRouteGeneration = routeContext_
        ? routeContext_->generation() : routeGenerationSeed_;
    routeContext_.reset();
    state_.store(AudioHostState::Closed, std::memory_order_release);
    inputId_ = wide(config.inputDeviceUid);
    outputId_ = wide(config.outputDeviceUid);
    if (inputId_.empty() || outputId_.empty())
      return fail(AudioHostError::InvalidConfiguration,
                  "WASAPI endpoint UIDs must be the opaque IDs returned by inventory");
    if (!render || !config.maximumFrames ||
        config.maximumFrames > kAudioHostMaxFrames ||
        (config.requestedBufferFrames &&
         config.requestedBufferFrames > config.maximumFrames) ||
        config.inputChannels.empty() || config.outputChannels.empty() ||
        config.inputChannels.size() > kAudioHostMaxChannels ||
        config.outputChannels.size() > kAudioHostMaxChannels ||
        !std::isfinite(config.requestedSampleRate) ||
        config.requestedSampleRate < 0.0 ||
        config.requestedSampleRate > UINT32_MAX ||
        std::floor(config.requestedSampleRate) != config.requestedSampleRate) {
      return fail(AudioHostError::InvalidConfiguration,
                  "Invalid WASAPI channel map, rate, frame bound, or render thunk");
    }
    PairingResult pairing;
    try {
      std::thread worker([&] { pairing = verifyEndpointPair(inputId_, outputId_); });
      worker.join();
    } catch (...) {
      return fail(AudioHostError::ProviderFailure,
                  "Could not create the WASAPI pairing helper");
    }
    if (!pairing.ok) return fail(pairing.error, pairing.message);

    uint64_t nextRouteGeneration = 0;
    if (!detail::nextWasapiRouteGeneration(
            routeGenerationSeed_, previousRouteGeneration,
            &nextRouteGeneration)) {
      return fail(AudioHostError::ProviderFailure,
                  "WASAPI route generation is exhausted");
    }
    routeGenerationSeed_ = nextRouteGeneration;

    config_ = config;
    inputMap_ = config.inputChannels;
    outputMap_ = config.outputChannels;
    capturePrepared_ = {};
    renderPrepared_ = {};
    captureOpenReady_ = renderOpenReady_ = false;
    captureStartReady_ = renderStartReady_ = false;
    captureStartOk_ = renderStartOk_ = false;
    startFailure_ = {};
    startError_.clear();
    acceptedCaptureFrames_.store(0, std::memory_order_relaxed);
    renderRequestedFrames_.store(0, std::memory_order_relaxed);
    startupInputZeroFrames_.store(0, std::memory_order_relaxed);
    streamGeneration_.fetch_add(1, std::memory_order_relaxed);
    stopRequested_.store(false, std::memory_order_release);
    quarantineStopEvent_.store(false, std::memory_order_relaxed);
    stopEvent_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    captureStartEvent_ = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (!stopEvent_ || !captureStartEvent_) {
      closeEvents();
      return fail(AudioHostError::ProviderFailure,
                  "WASAPI could not create stream control events");
    }
    try {
      routeContext_ = std::make_shared<detail::WasapiRouteLossContext>(
          routeGenerationSeed_, stopEvent_);
    } catch (...) {
      closeEvents();
      return fail(AudioHostError::ProviderFailure,
                  "WASAPI could not allocate the route-loss guard");
    }
    prepareAudioHostCallback(&callback_, render, renderContext);
    try {
      workerThread_ = std::thread([this] { unifiedWorker(); });
    } catch (...) {
      return finishOpenFailure(
          AudioHostError::ProviderFailure,
          "WASAPI could not create the endpoint owner thread");
    }
    {
      std::unique_lock<std::mutex> lock(controlMutex_);
      controlChanged_.wait(lock, [&] {
        return captureOpenReady_ && renderOpenReady_;
      });
    }
    if (!capturePrepared_.ok || !renderPrepared_.ok) {
      const EndpointPrepared& failed = !capturePrepared_.ok
                                           ? capturePrepared_
                                           : renderPrepared_;
      const std::string message = failed.error;
      return finishOpenFailure(
          failed.hostError, message,
          "A selected WASAPI endpoint changed while open failure was being finalized");
    }
    if (routeContext_->lost()) {
      return finishOpenFailure(
          AudioHostError::DeviceNotFound,
          "A selected WASAPI endpoint changed while the notification guard was armed");
    }
    if (capturePrepared_.sampleRate != renderPrepared_.sampleRate) {
      return finishOpenFailure(
          AudioHostError::DifferentDevicesUnsupported,
          "Capture and render endpoints negotiated different sample rates; adaptive drift correction is deferred",
          "A selected WASAPI endpoint changed while the rate mismatch was being finalized");
    }
    if (!detail::validWasapiChannelMap(
            inputMap_.data(), static_cast<uint32_t>(inputMap_.size()),
            capturePrepared_.endpointChannels) ||
        !detail::validWasapiChannelMap(
            outputMap_.data(), static_cast<uint32_t>(outputMap_.size()),
            renderPrepared_.endpointChannels)) {
      return finishOpenFailure(
          AudioHostError::InvalidConfiguration,
          "A selected channel is absent from the exact initialized WASAPI format");
    }
    if (capturePrepared_.bufferFrames > config.maximumFrames ||
        renderPrepared_.bufferFrames > config.maximumFrames) {
      return finishOpenFailure(
          AudioHostError::InvalidConfiguration,
          "A negotiated WASAPI buffer exceeds maximumFrames");
    }
    const uint64_t desiredFifo = std::max<uint64_t>(
        static_cast<uint64_t>(config.maximumFrames) * 8,
        static_cast<uint64_t>(capturePrepared_.bufferFrames) +
            static_cast<uint64_t>(renderPrepared_.bufferFrames) * 8);
    const uint32_t fifoFrames = static_cast<uint32_t>(
        std::min<uint64_t>(desiredFifo, kMaximumFifoFrames));
    if (!fifo_.prepare(static_cast<uint32_t>(inputMap_.size()), fifoFrames)) {
      return finishOpenFailure(
          AudioHostError::ProviderFailure,
          "Could not prepare the bounded WASAPI capture FIFO");
    }
    format_ = {static_cast<double>(renderPrepared_.sampleRate),
               config.maximumFrames, renderPrepared_.periodFrames,
               static_cast<uint32_t>(inputMap_.size()),
               static_cast<uint32_t>(outputMap_.size()), true, true,
               config.exclusive ? AudioHostAccessMode::Exclusive
                                : AudioHostAccessMode::Shared};
    // GetStreamLatency is kept in diagnostics; it is not pure hardware delay.
    latency_ = {0, 0, renderPrepared_.bufferFrames, 0};
    resetCallbackCounters();
    const uint64_t openGeneration = routeContext_->generation();
    if (!routeContext_->publishOpen(openGeneration)) {
      return finishOpenFailure(
          AudioHostError::ProviderFailure,
          "WASAPI failed while publishing the open session",
          "A selected WASAPI endpoint changed while opening");
    }
    sessionOwned_ = true;
    return {true, AudioHostError::None, AudioHostState::Open, format_, latency_, {}};
  }

  AudioHostResult start() override {
    if (!routeContext_ || currentState() != AudioHostState::Open ||
        !routeContext_->beginStart())
      return failure(AudioHostError::InvalidState,
                     "Reopen the WASAPI host before starting it",
                     currentState());
    const uint64_t startGeneration = routeContext_->generation();
    fifo_.reset();
    activateAudioHostCallback(&callback_);
    SetEvent(captureStartEvent_);
    bool captureStartOk = false;
    bool renderStartOk = false;
    detail::WasapiStartupFailureState startFailure;
    std::string startError;
    {
      std::unique_lock<std::mutex> lock(controlMutex_);
      controlChanged_.wait(lock, [&] {
        return captureStartReady_ && renderStartReady_;
      });
      captureStartOk = captureStartOk_;
      renderStartOk = renderStartOk_;
      startFailure = detail::copyWasapiStartupFailure(startFailure_);
      startError = startError_;
    }
    if (!captureStartOk) {
      return failStart(startFailure, startError);
    }
    if (!renderStartOk) {
      return failStart(startFailure, startError);
    }
    if (!routeContext_->publishRunning(startGeneration)) {
      detail::WasapiStartupFailureState publishFailure;
      (void)detail::publishWasapiStartupFailure(
          &publishFailure, detail::WasapiStartupStage::Control, E_FAIL);
      return failStart(
          publishFailure,
          "WASAPI failed while publishing the running session");
    }
    return {true, AudioHostError::None, AudioHostState::Running, format_, latency_, {}};
  }

  void stop() noexcept override {
    const bool hadSession = sessionOwned_ || workerThread_.joinable();
    runShutdownSequence();
    sessionOwned_ = false;
    if (hadSession && routeContext_) routeContext_->markStopped();
    else if (hadSession) state_.store(AudioHostState::Stopped,
                                     std::memory_order_release);
  }

  AudioHostStatus status() const noexcept override {
    AudioHostStatus result;
    const auto route = routeContext_
                           ? routeContext_->snapshot()
                           : detail::WasapiRouteLossContext::Snapshot{
                                 routeGenerationSeed_,
                                 detail::WasapiLifecycleState::Stopped, false};
    result.state = routeContext_ ? audioHostState(route.state)
                                 : state_.load(std::memory_order_acquire);
    result.format = format_;
    result.latency = latency_;
    result.routeGeneration = route.generation;
    result.streamGeneration = streamGeneration_.load(std::memory_order_relaxed);
    result.callbacks = callback_.callbacks.load(std::memory_order_relaxed);
    result.renderedFrames = callback_.renderedFrames.load(std::memory_order_relaxed);
    result.xruns = callback_.xruns.load(std::memory_order_relaxed);
    result.deadlineMisses = callback_.deadlineMisses.load(std::memory_order_relaxed);
    result.discontinuities = callback_.discontinuities.load(std::memory_order_relaxed);
    result.invalidCallbacks = callback_.invalidCallbacks.load(std::memory_order_relaxed);
    result.renderFailures = callback_.renderFailures.load(std::memory_order_relaxed);
    auto& diagnostics = result.diagnostics;
    diagnostics.inputStreamLatency100ns = capturePrepared_.streamLatency100ns;
    diagnostics.outputStreamLatency100ns = renderPrepared_.streamLatency100ns;
    diagnostics.inputPeriodFrames = capturePrepared_.periodFrames;
    diagnostics.outputPeriodFrames = renderPrepared_.periodFrames;
    diagnostics.inputBufferFrames = capturePrepared_.bufferFrames;
    diagnostics.outputBufferFrames = renderPrepared_.bufferFrames;
    diagnostics.fifoCapacityFrames = fifo_.capacityFrames();
    diagnostics.fifoCurrentFrames = fifo_.currentFrames();
    diagnostics.fifoMinimumFrames = fifo_.minimumFrames();
    diagnostics.fifoMaximumFrames = fifo_.maximumFrames();
    diagnostics.fifoUnderflows = fifo_.underflows();
    diagnostics.fifoOverflows = fifo_.overflows();
    diagnostics.startupInputZeroFrames =
        startupInputZeroFrames_.load(std::memory_order_relaxed);
    diagnostics.acceptedCaptureMinusRenderedFrames =
        detail::wasapiSignedFrameBalance(
            acceptedCaptureFrames_.load(std::memory_order_relaxed),
            renderRequestedFrames_.load(std::memory_order_relaxed));
    return result;
  }

 private:
  void publishOpen(bool capture, EndpointPrepared prepared) {
    {
      std::lock_guard<std::mutex> lock(controlMutex_);
      if (capture) { capturePrepared_ = std::move(prepared); captureOpenReady_ = true; }
      else { renderPrepared_ = std::move(prepared); renderOpenReady_ = true; }
    }
    controlChanged_.notify_all();
  }

  void publishStart(bool capture, bool ok,
                    detail::WasapiStartupStage stage, HRESULT result,
                    std::string message = {}) {
    {
      std::lock_guard<std::mutex> lock(controlMutex_);
      if (!ok && detail::publishWasapiStartupFailure(
                     &startFailure_, stage, result)) {
        startError_ = std::move(message);
      }
      if (capture) { captureStartOk_ = ok; captureStartReady_ = true; }
      else { renderStartOk_ = ok; renderStartReady_ = true; }
    }
    controlChanged_.notify_all();
  }

  void signalStop() noexcept {
    stopRequested_.store(true, std::memory_order_release);
    if (stopEvent_) SetEvent(stopEvent_);
    if (captureStartEvent_) SetEvent(captureStartEvent_);
  }

  void joinWorkers() noexcept {
    if (workerThread_.joinable() &&
        workerThread_.get_id() != std::this_thread::get_id())
      workerThread_.join();
  }

  void closeEvents() noexcept {
    if (stopEvent_ && !quarantineStopEvent_.load(std::memory_order_acquire))
      CloseHandle(stopEvent_);
    if (captureStartEvent_) CloseHandle(captureStartEvent_);
    stopEvent_ = captureStartEvent_ = nullptr;
  }

  static void shutdownSignal(void* context) noexcept {
    static_cast<WasapiAudioHostBackend*>(context)->signalStop();
  }

  static void shutdownJoin(void* context) noexcept {
    static_cast<WasapiAudioHostBackend*>(context)->joinWorkers();
  }

  static void shutdownDeactivateAndQuiesce(void* context) noexcept {
    auto* backend = static_cast<WasapiAudioHostBackend*>(context);
    // Keep the gate open until the owner has left its render action. An
    // admitted callback completes before teardown on normal and failed-start
    // paths; closing first would manufacture an invalid callback.
    deactivateAudioHostCallback(&backend->callback_);
    while (backend->callback_.inFlight.load(std::memory_order_acquire))
      std::this_thread::yield();
  }

  static void shutdownCloseEvents(void* context) noexcept {
    static_cast<WasapiAudioHostBackend*>(context)->closeEvents();
  }

  void runShutdownSequence() noexcept {
    const detail::WasapiShutdownOperations operations{
        this, shutdownSignal, shutdownJoin, shutdownDeactivateAndQuiesce,
        shutdownCloseEvents};
    (void)detail::runWasapiShutdownSequence(operations);
  }

  void markRuntimeFailure(HRESULT code) noexcept {
    const bool lost = detail::wasapiRuntimeFailureIsDeviceLost(code);
    if (routeContext_) {
      if (lost) routeContext_->markLost();
      else routeContext_->markError();
    } else {
      state_.store(lost ? AudioHostState::DeviceLost : AudioHostState::Error,
                   std::memory_order_release);
    }
    if (stopEvent_) SetEvent(stopEvent_);
  }

  void resetCallbackCounters() noexcept {
    callback_.callbacks.store(0, std::memory_order_relaxed);
    callback_.renderedFrames.store(0, std::memory_order_relaxed);
    callback_.xruns.store(0, std::memory_order_relaxed);
    callback_.deadlineMisses.store(0, std::memory_order_relaxed);
    callback_.discontinuities.store(0, std::memory_order_relaxed);
    callback_.invalidCallbacks.store(0, std::memory_order_relaxed);
    callback_.renderFailures.store(0, std::memory_order_relaxed);
  }

  AudioHostResult fail(AudioHostError error, const std::string& message) {
    if (routeContext_) routeContext_->markError();
    else state_.store(AudioHostState::Error, std::memory_order_release);
    return failure(error, message, currentState());
  }

  AudioHostResult finishOpenFailure(
      AudioHostError preparedError, const std::string& message,
      const char* deviceLostMessage = nullptr) {
    runShutdownSequence();
    sessionOwned_ = false;
    if (routeContext_) {
      routeContext_->markError();
      const auto final = routeContext_->snapshot();
      const AudioHostError error = detail::wasapiOpenErrorForState(
          preparedError, final.state);
      return failure(
          error,
          error == AudioHostError::DeviceNotFound && deviceLostMessage
              ? deviceLostMessage
              : message,
          audioHostState(final.state));
    }
    state_.store(AudioHostState::Error, std::memory_order_release);
    return failure(preparedError, message, AudioHostState::Error);
  }

  AudioHostResult failStart(
      const detail::WasapiStartupFailureState& published,
      const std::string& message) {
    runShutdownSequence();
    sessionOwned_ = false;
    if (routeContext_) {
      const auto joined = routeContext_->snapshot();
      const auto joinedDecision = detail::resolveWasapiStartupFailure(
          published, joined);
      if (joinedDecision.state ==
          detail::WasapiLifecycleState::DeviceLost) {
        if (joined.state != detail::WasapiLifecycleState::DeviceLost)
          routeContext_->markLost();
      } else if (joined.state != detail::WasapiLifecycleState::DeviceLost &&
                 joined.state != detail::WasapiLifecycleState::Error) {
        routeContext_->markError();
      }
    } else {
      state_.store(AudioHostState::Error, std::memory_order_release);
    }
    const auto finalRoute = routeContext_
                                ? routeContext_->snapshot()
                                : detail::WasapiRouteLossContext::Snapshot{
                                      routeGenerationSeed_,
                                      detail::WasapiLifecycleState::Error,
                                      false};
    const auto decision = detail::resolveWasapiStartupFailure(
        published, finalRoute);
    return failure(decision.error,
                   message.empty() ? "WASAPI start failed" : message,
                   audioHostState(decision.state));
  }

  AudioHostState currentState() const noexcept {
    return routeContext_
               ? audioHostState(routeContext_->snapshot().state)
               : state_.load(std::memory_order_acquire);
  }

  bool stopKnown() const noexcept {
    const auto route = routeContext_
                           ? routeContext_->snapshot()
                           : detail::WasapiRouteLossContext::Snapshot{};
    const bool routeTerminal =
        route.state == detail::WasapiLifecycleState::DeviceLost ||
        route.state == detail::WasapiLifecycleState::Error ||
        route.state == detail::WasapiLifecycleState::Stopped;
    return detail::wasapiKnownStop(
        stopRequested_.load(std::memory_order_acquire),
        routeContext_ && route.lost, routeContext_ && routeTerminal);
  }

  bool prepareWorker(bool capture, ComPtr<IAudioClient>& client,
                     EndpointProfile* profile, ComPtr<IMMDevice>& device,
                     HANDLE audioEvent) {
    ComPtr<IMMDeviceEnumerator> enumerator;
    HRESULT result = createEnumerator(enumerator);
    if (FAILED(result)) {
      profile->prepared.error = hresultMessage("WASAPI device enumerator", result);
      return false;
    }
    result = enumerator->GetDevice(
        (capture ? inputId_ : outputId_).c_str(), device.put());
    if (FAILED(result)) {
      profile->prepared.hostError = detail::classifyWasapiOpenFailure(
          detail::WasapiOpenStage::DeviceLookup, true,
          detail::WasapiOpenOutcome::ApiFailure, result);
      profile->prepared.error = hresultMessage(
          capture ? "WASAPI capture endpoint" : "WASAPI render endpoint", result);
      return false;
    }
    const auto& map = capture ? inputMap_ : outputMap_;
    if (!detail::validWasapiChannelMap(
            map.data(), static_cast<uint32_t>(map.size()),
            kAudioHostMaxChannels)) {
      profile->prepared.hostError = detail::classifyWasapiOpenFailure(
          detail::WasapiOpenStage::RequestValidation, true,
          detail::WasapiOpenOutcome::CallerChannelMapRejected, S_OK);
      profile->prepared.error =
          "The requested WASAPI channel map is invalid";
      return false;
    }
    uint32_t requiredChannels = 0;
    for (uint32_t channel : map) requiredChannels = std::max(requiredChannels, channel + 1);
    if (!buildEndpointProfile(device.get(), capture, config_.exclusive,
                              static_cast<uint32_t>(config_.requestedSampleRate),
                              config_.requestedBufferFrames, requiredChannels,
                              stopEvent_,
                              client, profile)) return false;
    if (!detail::wasapiFitsMaximumFrames(
            profile->prepared.bufferFrames, config_.maximumFrames) ||
        !detail::validWasapiChannelMap(map.data(), static_cast<uint32_t>(map.size()),
                                      profile->prepared.endpointChannels)) {
      profile->prepared.ok = false;
      const bool maximumExceeded =
          profile->prepared.bufferFrames > config_.maximumFrames;
      profile->prepared.hostError = detail::classifyWasapiOpenFailure(
          detail::WasapiOpenStage::RequestValidation, true,
          maximumExceeded
              ? detail::WasapiOpenOutcome::CallerMaximumFramesExceeded
              : detail::WasapiOpenOutcome::CallerChannelMapRejected,
          S_OK);
      profile->prepared.error =
          "The exact WASAPI format exceeds maximumFrames or omits a selected channel";
      return false;
    }
    result = client->SetEventHandle(audioEvent);
    if (FAILED(result)) {
      profile->prepared.ok = false;
      profile->prepared.hostError = detail::classifyWasapiOpenFailure(
          detail::WasapiOpenStage::EventHandle, false,
          detail::WasapiOpenOutcome::ApiFailure, result);
      profile->prepared.error = hresultMessage(
          capture ? "WASAPI capture event" : "WASAPI render event", result);
      return false;
    }
    return true;
  }

  void unifiedWorker() noexcept;

  AudioHostConfig config_{};
  std::wstring inputId_, outputId_;
  std::vector<uint32_t> inputMap_, outputMap_;
  AudioHostFormat format_{};
  AudioHostLatency latency_{};
  detail::AudioHostPlanarFifo fifo_;
  AudioHostCallbackEndpoint callback_{};
  std::atomic<AudioHostState> state_{AudioHostState::Closed};
  std::atomic<bool> stopRequested_{true};
  std::atomic<bool> quarantineStopEvent_{false};
  std::atomic<uint64_t> acceptedCaptureFrames_{0};
  std::atomic<uint64_t> renderRequestedFrames_{0};
  std::atomic<uint64_t> startupInputZeroFrames_{0};
  std::shared_ptr<detail::WasapiRouteLossContext> routeContext_;
  uint64_t routeGenerationSeed_{0};
  std::atomic<uint64_t> streamGeneration_{0};
  HANDLE stopEvent_{nullptr}, captureStartEvent_{nullptr};
  std::thread workerThread_;
  mutable std::mutex controlMutex_;
  std::condition_variable controlChanged_;
  bool captureOpenReady_{false}, renderOpenReady_{false};
  bool captureStartReady_{false}, renderStartReady_{false};
  bool captureStartOk_{false}, renderStartOk_{false};
  bool sessionOwned_{false};
  detail::WasapiStartupFailureState startFailure_{};
  std::string startError_;
  EndpointPrepared capturePrepared_{}, renderPrepared_{};
};

void WasapiAudioHostBackend::unifiedWorker() noexcept {
  StaApartment apartment;
  auto publishOpenFailure = [&](
                                const std::string& message,
                                AudioHostError error =
                                    AudioHostError::ProviderFailure) {
    EndpointPrepared captureFailure;
    captureFailure.error = message;
    captureFailure.hostError = error;
    EndpointPrepared renderFailure;
    renderFailure.error = message;
    renderFailure.hostError = error;
    publishOpen(true, std::move(captureFailure));
    publishOpen(false, std::move(renderFailure));
  };
  auto publishStartFailure = [&](detail::WasapiStartupStage stage,
                                 HRESULT result,
                                 const std::string& message) {
    detail::applyWasapiStartupFailure(routeContext_.get(), stage, result);
    publishStart(true, false, stage, result, message);
    publishStart(false, false, stage, result, message);
  };
  auto publishStartSuccess = [&]() {
    publishStart(true, true, detail::WasapiStartupStage::Control, S_OK);
    publishStart(false, true, detail::WasapiStartupStage::Control, S_OK);
  };
  if (!apartment.ok()) {
    publishOpenFailure(hresultMessage("WASAPI owner STA", apartment.result()));
    return;
  }

  // Declared before the registration and COM resources so endpoint events
  // are closed last on this same STA owner.
  UniqueHandle captureAudioEvent(CreateEventW(nullptr, FALSE, FALSE, nullptr));
  UniqueHandle renderAudioEvent(CreateEventW(nullptr, FALSE, FALSE, nullptr));
  if (!captureAudioEvent || !renderAudioEvent) {
    publishOpenFailure("WASAPI could not create both endpoint events");
    return;
  }
  EndpointNotificationRegistration notification(&quarantineStopEvent_);
  std::string notificationError;
  if (!notification.arm(inputId_, outputId_, routeContext_,
                        &notificationError)) {
    publishOpenFailure(notificationError);
    return;
  }
  const PairingResult armedPairing = verifyEndpointPair(inputId_, outputId_);
  if (!armedPairing.ok) {
    publishOpenFailure(armedPairing.message, armedPairing.error);
    return;
  }
  if (routeContext_->lost()) {
    publishOpenFailure(
        "A selected WASAPI endpoint changed while endpoint pairing was revalidated",
        AudioHostError::DeviceNotFound);
    return;
  }

  ComPtr<IMMDevice> captureDevice;
  ComPtr<IMMDevice> renderDevice;
  ComPtr<IAudioClient> captureClient;
  ComPtr<IAudioClient> renderClient;
  EndpointProfile captureProfile;
  EndpointProfile renderProfile;
  if (!prepareWorker(true, captureClient, &captureProfile, captureDevice,
                     captureAudioEvent.get())) {
    publishOpenFailure(captureProfile.prepared.error,
                       captureProfile.prepared.hostError);
    return;
  }
  if (!prepareWorker(false, renderClient, &renderProfile, renderDevice,
                     renderAudioEvent.get())) {
    publishOpenFailure(renderProfile.prepared.error,
                       renderProfile.prepared.hostError);
    return;
  }
  ComPtr<IAudioCaptureClient> capture;
  HRESULT result = captureClient->GetService(
      __uuidof(IAudioCaptureClient), reinterpret_cast<void**>(capture.put()));
  if (FAILED(result)) {
    publishOpenFailure(
        hresultMessage("WASAPI capture service", result),
        detail::classifyWasapiOpenFailure(
            detail::WasapiOpenStage::Service, false,
            detail::WasapiOpenOutcome::ApiFailure, result));
    return;
  }
  ComPtr<IAudioRenderClient> renderer;
  result = renderClient->GetService(
      __uuidof(IAudioRenderClient), reinterpret_cast<void**>(renderer.put()));
  if (FAILED(result)) {
    publishOpenFailure(
        hresultMessage("WASAPI render service", result),
        detail::classifyWasapiOpenFailure(
            detail::WasapiOpenStage::Service, false,
            detail::WasapiOpenOutcome::ApiFailure, result));
    return;
  }
  ComPtr<IAudioClock> clock;
  result = renderClient->GetService(__uuidof(IAudioClock),
                                    reinterpret_cast<void**>(clock.put()));
  if (FAILED(result)) {
    publishOpenFailure(
        hresultMessage("WASAPI render clock service", result),
        detail::classifyWasapiOpenFailure(
            detail::WasapiOpenStage::Service, false,
            detail::WasapiOpenOutcome::ApiFailure, result));
    return;
  }
  UINT64 clockFrequency = 0;
  const HRESULT clockFrequencyResult = clock->GetFrequency(&clockFrequency);
  const auto clockFrequencyAction = detail::classifyWasapiOptionalOpenResult(
      detail::WasapiOptionalOpenStage::ClockFrequency,
      clockFrequencyResult,
      SUCCEEDED(clockFrequencyResult) && clockFrequency != 0);
  if (clockFrequencyAction ==
      detail::WasapiOptionalOpenAction::FailDeviceLost) {
    publishOpenFailure(
        hresultMessage("WASAPI render clock frequency", clockFrequencyResult),
        AudioHostError::DeviceNotFound);
    return;
  }
  if (clockFrequencyAction ==
      detail::WasapiOptionalOpenAction::UseFallback) {
    // A generic diagnostic failure disables only the hardware clock anchor;
    // callback QPC remains the documented timestamp fallback.
    clock.reset();
    clockFrequency = 0;
  }
  LARGE_INTEGER qpcValue{};
  const uint64_t qpcFrequency =
      QueryPerformanceFrequency(&qpcValue) && qpcValue.QuadPart > 0
          ? static_cast<uint64_t>(qpcValue.QuadPart)
          : 0;

  std::vector<float> inputStorage;
  std::vector<float> outputStorage;
  try {
    inputStorage.assign(static_cast<size_t>(inputMap_.size()) *
                            config_.maximumFrames,
                        0.0F);
    outputStorage.assign(static_cast<size_t>(outputMap_.size()) *
                             config_.maximumFrames,
                         0.0F);
  } catch (...) {
    publishOpenFailure(
        "Could not preallocate WASAPI planar conversion buffers");
    return;
  }
  std::array<float*, kAudioHostMaxChannels> inputPointers{};
  std::array<const float*, kAudioHostMaxChannels> inputConstPointers{};
  std::array<float*, kAudioHostMaxChannels> outputPointers{};
  std::array<const float*, kAudioHostMaxChannels> outputConstPointers{};
  for (size_t channel = 0; channel < inputMap_.size(); ++channel) {
    inputPointers[channel] =
        inputStorage.data() + channel * config_.maximumFrames;
    inputConstPointers[channel] = inputPointers[channel];
  }
  for (size_t channel = 0; channel < outputMap_.size(); ++channel) {
    outputPointers[channel] =
        outputStorage.data() + channel * config_.maximumFrames;
    outputConstPointers[channel] = outputPointers[channel];
  }
  if (routeContext_->lost()) {
    publishOpenFailure(
        "A selected WASAPI endpoint changed while the notification guard was armed",
        AudioHostError::DeviceNotFound);
    return;
  }
  publishOpen(true, captureProfile.prepared);
  publishOpen(false, renderProfile.prepared);

  HANDLE beforeStart[] = {stopEvent_, captureStartEvent_};
  const DWORD startWait =
      WaitForMultipleObjects(2, beforeStart, FALSE, INFINITE);
  if (startWait != WAIT_OBJECT_0 + 1 ||
      stopRequested_.load(std::memory_order_acquire)) {
    const HRESULT waitResult = startWait == WAIT_FAILED
        ? HRESULT_FROM_WIN32(GetLastError())
        : E_ABORT;
    publishStartFailure(detail::WasapiStartupStage::Control, waitResult,
                        "WASAPI owner stopped before start");
    return;
  }
  MmcssScope mmcss;
  if (!mmcss.enter()) {
    publishStartFailure(detail::WasapiStartupStage::Control, E_FAIL,
                        "WASAPI owner could not join MMCSS Pro Audio");
    return;
  }

  bool captureStarted = false;
  bool renderStarted = false;
  auto stopOwnedStreams = [&]() noexcept -> HRESULT {
    HRESULT firstFailure = S_OK;
    if (renderStarted) {
      const HRESULT stopped = renderClient->Stop();
      firstFailure = static_cast<HRESULT>(detail::wasapiPreserveFirstFailure(
          firstFailure, stopped));
      renderStarted = false;
    }
    if (captureStarted) {
      const HRESULT stopped = captureClient->Stop();
      firstFailure = static_cast<HRESULT>(detail::wasapiPreserveFirstFailure(
          firstFailure, stopped));
      captureStarted = false;
    }
    if (FAILED(firstFailure)) markRuntimeFailure(firstFailure);
    return firstFailure;
  };
  bool haveCapturePacket = false;
  bool pendingCaptureDiscontinuity = false;
  uint32_t captureBufferErrors = 0;
  struct StartupFailure {
    detail::WasapiStartupStage stage{
        detail::WasapiStartupStage::CapturePrimePacket};
    HRESULT result{S_OK};
  };
  auto drainCapture = [&](bool captureEventObserved,
                          StartupFailure* startupFailure) noexcept -> bool {
    auto preserveStartupFailure = [&](detail::WasapiStartupStage stage,
                                      HRESULT failure) noexcept {
      if (startupFailure && startupFailure->result == S_OK) {
        startupFailure->stage = stage;
        startupFailure->result = failure;
      }
    };
    if (config_.exclusive && !captureEventObserved) return true;
    if (stopKnown()) {
      preserveStartupFailure(detail::WasapiStartupStage::CapturePrimePacket,
                             E_ABORT);
      return false;
    }
    bool another = true;
    while (another) {
      if (stopKnown()) {
        preserveStartupFailure(
            detail::WasapiStartupStage::CapturePrimePacket, E_ABORT);
        return false;
      }
      UINT32 packet = captureProfile.prepared.bufferFrames;
      if (!config_.exclusive) {
        const HRESULT packetResult = capture->GetNextPacketSize(&packet);
        if (packetResult == AUDCLNT_S_BUFFER_EMPTY) return true;
        if (FAILED(packetResult)) {
          preserveStartupFailure(
              detail::WasapiStartupStage::CapturePrimePacket, packetResult);
          markRuntimeFailure(packetResult);
          return false;
        }
        if (!packet) return true;
      } else {
        another = false;
      }
      if (stopKnown()) {
        preserveStartupFailure(
            detail::WasapiStartupStage::CapturePrimePacket, E_ABORT);
        return false;
      }
      BYTE* bytes = nullptr;
      UINT32 frames = 0;
      DWORD flags = 0;
      UINT64 devicePosition = 0;
      UINT64 qpcPosition100ns = 0;
      detail::WasapiOnceOperation operation;
      if (!operation.begin()) {
        preserveStartupFailure(
            detail::WasapiStartupStage::CapturePrimePacket, E_FAIL);
        markRuntimeFailure(E_FAIL);
        return false;
      }
      const HRESULT acquired = capture->GetBuffer(
          &bytes, &frames, &flags, &devicePosition, &qpcPosition100ns);
      const uint32_t nextErrors =
          acquired == AUDCLNT_E_BUFFER_ERROR ? captureBufferErrors + 1 : 0;
      const auto action = detail::classifyWasapiBufferResult(
          acquired, config_.exclusive, nextErrors);
      if (action == detail::WasapiBufferAction::Empty) return true;
      if (action == detail::WasapiBufferAction::Retry ||
          action == detail::WasapiBufferAction::Fail) {
        if (config_.exclusive && acquired == AUDCLNT_E_BUFFER_ERROR) {
          captureBufferErrors = nextErrors;
          pendingCaptureDiscontinuity = true;
          recordAudioHostXRun(&callback_);
          if (action == detail::WasapiBufferAction::Retry) return true;
        }
        const HRESULT failure = acquired == S_OK ? E_FAIL : acquired;
        preserveStartupFailure(
            detail::WasapiStartupStage::CapturePrimePacket, failure);
        markRuntimeFailure(failure);
        return false;
      }
      if (!operation.markAcquired()) {
        const HRESULT released = capture->ReleaseBuffer(frames);
        const HRESULT failure = FAILED(released) ? released : E_FAIL;
        preserveStartupFailure(
            FAILED(released)
                ? detail::WasapiStartupStage::CapturePrimeRelease
                : detail::WasapiStartupStage::CapturePrimePacket,
            failure);
        markRuntimeFailure(failure);
        return false;
      }
      if (stopKnown()) {
        const HRESULT released = capture->ReleaseBuffer(frames);
        if (!operation.finishRelease(released)) {
          const HRESULT failure = FAILED(released) ? released : E_FAIL;
          preserveStartupFailure(
              detail::WasapiStartupStage::CapturePrimeRelease, failure);
          markRuntimeFailure(failure);
        } else {
          preserveStartupFailure(
              detail::WasapiStartupStage::CapturePrimePacket, E_ABORT);
        }
        return false;
      }
      detail::AudioHostCaptureSpan span;
      span.sourceFrame = devicePosition;
      span.timestampValid =
          (flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR) == 0 &&
          qpcPosition100ns && qpcPosition100ns <= UINT64_MAX / 100ull;
      span.timestampHardware = span.timestampValid;
      span.sampleHostTimeNs =
          span.timestampValid ? qpcPosition100ns * 100ull : 0;
      if (haveCapturePacket &&
          (flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY)) {
        span.discontinuity |= AudioHostDiscontinuityXRun;
        recordAudioHostXRun(&callback_);
      }
      if (pendingCaptureDiscontinuity)
        span.discontinuity |= AudioHostDiscontinuityXRun;
      const bool written = fifo_.writeInterleavedFloat(
          reinterpret_cast<const float*>(bytes),
          captureProfile.prepared.endpointChannels, inputMap_.data(), frames,
          span, (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0);
      if (!written) recordAudioHostXRun(&callback_);
      if (written) {
        if (!operation.markAdvanced()) {
          const HRESULT released = capture->ReleaseBuffer(frames);
          const HRESULT failure = FAILED(released) ? released : E_FAIL;
          preserveStartupFailure(
              FAILED(released)
                  ? detail::WasapiStartupStage::CapturePrimeRelease
                  : detail::WasapiStartupStage::CapturePrimePacket,
              failure);
          markRuntimeFailure(failure);
          return false;
        }
        pendingCaptureDiscontinuity = false;
        saturatingAdd(&acceptedCaptureFrames_, frames);
        haveCapturePacket = true;
      }
      const HRESULT released = capture->ReleaseBuffer(frames);
      // Release failures are terminal: the FIFO publication above cannot be
      // rolled back or replayed. Only GetBuffer acquisition is retryable.
      if (!operation.finishRelease(released)) {
        const HRESULT failure = FAILED(released) ? released : E_FAIL;
        preserveStartupFailure(
            detail::WasapiStartupStage::CapturePrimeRelease, failure);
        markRuntimeFailure(failure);
        return false;
      }
      captureBufferErrors = 0;
    }
    return true;
  };

  uint32_t renderBufferErrors = 0;
  const auto ownerStartPlan =
      detail::wasapiOwnerStartPlan(config_.exclusive);
  auto primeRender = [&]() noexcept -> StartupFailure {
    if (stopKnown())
      return {detail::WasapiStartupStage::PrimeGetBuffer, E_ABORT};
    detail::WasapiOnceOperation operation;
    if (!operation.begin())
      return {detail::WasapiStartupStage::PrimeGetBuffer, E_FAIL};
    BYTE* prime = nullptr;
    HRESULT primeResult =
        renderer->GetBuffer(renderProfile.prepared.bufferFrames, &prime);
    // A stopped exclusive client cannot produce a render event. A pre-start
    // buffer error therefore fails this bounded acquisition immediately; it
    // must never wait for an event that Start has not enabled.
    if (detail::classifyWasapiPrimeAcquire(primeResult) !=
        detail::WasapiPrimeAcquireAction::Proceed) {
      operation.fail();
      return {detail::WasapiStartupStage::PrimeGetBuffer, primeResult};
    }
    if (!operation.markAcquired()) {
      const HRESULT released = renderer->ReleaseBuffer(
          renderProfile.prepared.bufferFrames, AUDCLNT_BUFFERFLAGS_SILENT);
      return {FAILED(released)
                  ? detail::WasapiStartupStage::PrimeReleaseBuffer
                  : detail::WasapiStartupStage::PrimeGetBuffer,
              FAILED(released) ? released : E_FAIL};
    }
    const bool validBuffer = prime != nullptr;
    primeResult = renderer->ReleaseBuffer(
        renderProfile.prepared.bufferFrames, AUDCLNT_BUFFERFLAGS_SILENT);
    if (!operation.finishRelease(primeResult))
      return {detail::WasapiStartupStage::PrimeReleaseBuffer,
              FAILED(primeResult) ? primeResult : E_FAIL};
    return {validBuffer ? detail::WasapiStartupStage::Control
                        : detail::WasapiStartupStage::PrimeGetBuffer,
            validBuffer ? primeResult : E_FAIL};
  };

  // In shared mode, prepare the silent endpoint buffer before capture starts.
  // Once the first capture period arrives, render can start immediately; no
  // setup work remains between the one-period prefill and render's clock.
  if (ownerStartPlan.primeRenderBeforeCapture) {
    const StartupFailure prime = primeRender();
    if (prime.result != S_OK) {
      publishStartFailure(
          prime.stage, prime.result,
          hresultMessage("WASAPI render prime", prime.result));
      return;
    }
  }

  result = captureClient->Start();
  if (FAILED(result)) {
    publishStartFailure(detail::WasapiStartupStage::CaptureStart, result,
                        hresultMessage("WASAPI capture start", result));
    return;
  }
  captureStarted = true;
  const ULONGLONG primeDeadline = GetTickCount64() + 2000;
  HANDLE primeEvents[] = {stopEvent_, captureAudioEvent.get()};
  const uint32_t capturePrefillFrames =
      renderProfile.prepared.periodFrames *
      ownerStartPlan.capturePrefillPeriods;
  while (fifo_.currentFrames() < capturePrefillFrames) {
    const ULONGLONG now = GetTickCount64();
    if (now >= primeDeadline) {
      publishStartFailure(
          detail::WasapiStartupStage::CapturePrimePacket, E_FAIL,
          "WASAPI capture did not prime one render period within two seconds");
      (void)stopOwnedStreams();
      return;
    }
    const DWORD remaining = static_cast<DWORD>(primeDeadline - now);
    const DWORD waited =
        WaitForMultipleObjects(2, primeEvents, FALSE, remaining);
    if (waited == WAIT_OBJECT_0 ||
        stopRequested_.load(std::memory_order_acquire)) {
      publishStartFailure(detail::WasapiStartupStage::Control, E_ABORT,
                          "WASAPI capture priming was interrupted");
      (void)stopOwnedStreams();
      return;
    }
    if (waited != WAIT_OBJECT_0 + 1) {
      const HRESULT waitResult = waited == WAIT_FAILED
          ? HRESULT_FROM_WIN32(GetLastError())
          : E_FAIL;
      publishStartFailure(
          detail::WasapiStartupStage::CapturePrimePacket, waitResult,
          "WASAPI capture failed while awaiting a prime packet");
      (void)stopOwnedStreams();
      return;
    }
    StartupFailure capturePrime;
    if (!drainCapture(true, &capturePrime)) {
      const HRESULT failure = capturePrime.result == S_OK
          ? E_FAIL
          : capturePrime.result;
      publishStartFailure(capturePrime.stage, failure,
                          hresultMessage("WASAPI capture prime", failure));
      (void)stopOwnedStreams();
      return;
    }
  }

  if (!ownerStartPlan.primeRenderBeforeCapture) {
    const StartupFailure prime = primeRender();
    if (prime.result != S_OK) {
      publishStartFailure(
          prime.stage, prime.result,
          hresultMessage("WASAPI render prime", prime.result));
      (void)stopOwnedStreams();
      return;
    }
  }
  result = renderClient->Start();
  if (FAILED(result)) {
    publishStartFailure(detail::WasapiStartupStage::RenderStart, result,
                        hresultMessage("WASAPI render start", result));
    (void)stopOwnedStreams();
    return;
  }
  renderStarted = true;
  publishStartSuccess();

  uint64_t submittedFrames = renderProfile.prepared.bufferFrames;
  uint64_t callbackSequence = 0;
  bool firstCallback = true;
  bool pendingRenderDiscontinuity = false;
  AudioHostOutputTimeline outputTimeline{};
  renderBufferErrors = 0;
  auto snapshotRenderRequest =
      [&](uint64_t observedQpcNs,
          detail::WasapiRenderRequest* request) noexcept -> bool {
    if (stopKnown()) return false;
    UINT32 padding = 0;
    if (!config_.exclusive) {
      const HRESULT paddingResult = renderClient->GetCurrentPadding(&padding);
      if (FAILED(paddingResult) ||
          padding > renderProfile.prepared.bufferFrames) {
        markRuntimeFailure(FAILED(paddingResult) ? paddingResult : E_FAIL);
        return false;
      }
    }
    if (stopKnown()) return false;
    if (!detail::prepareWasapiRenderRequest(
            config_.exclusive, observedQpcNs,
            renderProfile.prepared.bufferFrames, padding,
            renderProfile.prepared.sampleRate, request)) {
      markRuntimeFailure(E_FAIL);
      return false;
    }
    return true;
  };
  auto renderOnce =
      [&](const detail::WasapiRenderRequest& request) noexcept -> bool {
    if (stopKnown()) return false;
    if (!request.valid || request.exclusive != config_.exclusive) {
      markRuntimeFailure(E_FAIL);
      return false;
    }
    const UINT32 frames = request.framesToWrite;
    if (!frames) return true;
    if (frames > config_.maximumFrames) {
      markRuntimeFailure(E_FAIL);
      return false;
    }
    // A shared render event can arrive just before the capture event from the
    // same engine boundary. Keep that render action pending on the capture
    // event rather than manufacturing zero input. The queued render padding
    // is the real deadline and is checked below; this adds no FIFO period and
    // performs no sleep or polling.
    // Shared mode spends the already-queued endpoint padding. Exclusive mode
    // has no padding query, so its one exact frame period is the bounded
    // capture coordination budget. Neither path adds software FIFO lead.
    HANDLE captureWait[] = {stopEvent_, captureAudioEvent.get()};
    for (;;) {
      const uint64_t nowNs = qpcNowNs(qpcFrequency);
      const auto pending = detail::wasapiPendingRenderAction(
          stopKnown(), request.exclusive,
          fifo_.currentFrames(), frames, nowNs, request.deadlineNs);
      if (pending == detail::WasapiPendingRenderAction::Render) break;
      if (pending == detail::WasapiPendingRenderAction::Stop) return false;
      if (pending == detail::WasapiPendingRenderAction::FailDeadline) {
        recordAudioHostDeadlineMiss(&callback_);
        recordAudioHostXRun(&callback_);
        markRuntimeFailure(E_FAIL);
        return false;
      }
      const DWORD timeout =
          detail::wasapiRenderWaitTimeoutMs(nowNs, request.deadlineNs);
      if (!timeout) {
        recordAudioHostDeadlineMiss(&callback_);
        recordAudioHostXRun(&callback_);
        markRuntimeFailure(E_FAIL);
        return false;
      }
      const DWORD waited =
          WaitForMultipleObjects(2, captureWait, FALSE, timeout);
      if (waited == WAIT_TIMEOUT) {
        recordAudioHostDeadlineMiss(&callback_);
        recordAudioHostXRun(&callback_);
        markRuntimeFailure(E_FAIL);
        return false;
      }
      if (waited != WAIT_OBJECT_0 + 1 || stopKnown())
        return false;
      if (!drainCapture(true, nullptr)) return false;
    }
    if (stopKnown()) return false;
    BYTE* bytes = nullptr;
    detail::WasapiOnceOperation operation;
    if (!operation.begin()) {
      markRuntimeFailure(E_FAIL);
      return false;
    }
    const HRESULT acquired = renderer->GetBuffer(frames, &bytes);
    const uint32_t nextErrors =
        acquired == AUDCLNT_E_BUFFER_ERROR ? renderBufferErrors + 1 : 0;
    const auto action = detail::classifyWasapiBufferResult(
        acquired, request.exclusive, nextErrors);
    if (action == detail::WasapiBufferAction::Retry) {
      operation.fail();
      renderBufferErrors = nextErrors;
      pendingRenderDiscontinuity = true;
      recordAudioHostXRun(&callback_);
      return true;
    }
    if (action != detail::WasapiBufferAction::Proceed || !bytes) {
      operation.fail();
      markRuntimeFailure(acquired == S_OK ? E_FAIL : acquired);
      return false;
    }
    if (!operation.markAcquired()) {
      const HRESULT released = renderer->ReleaseBuffer(
          frames, AUDCLNT_BUFFERFLAGS_SILENT);
      if (FAILED(released)) markRuntimeFailure(released);
      markRuntimeFailure(E_FAIL);
      return false;
    }
    if (stopKnown()) {
      const HRESULT released = renderer->ReleaseBuffer(
          frames, AUDCLNT_BUFFERFLAGS_SILENT);
      if (!operation.finishRelease(released))
        markRuntimeFailure(FAILED(released) ? released : E_FAIL);
      return false;
    }
    UINT64 clockPosition = 0;
    UINT64 clockQpc100ns = 0;
    const HRESULT clockPositionResult = clock
        ? clock->GetPosition(&clockPosition, &clockQpc100ns)
        : S_FALSE;
    const auto clockPositionAction =
        detail::classifyWasapiClockPosition(clockPositionResult);
    if (clockPositionAction ==
        detail::WasapiClockPositionAction::FailDeviceLost) {
      // The endpoint buffer is already acquired, but neither the capture FIFO
      // nor the graph has advanced. Return it silent exactly once, then
      // publish the synchronous clock loss. A ReleaseBuffer failure cannot
      // replace the more precise device-loss result.
      const HRESULT released = renderer->ReleaseBuffer(
          frames, AUDCLNT_BUFFERFLAGS_SILENT);
      (void)operation.finishRelease(released);
      markRuntimeFailure(clockPositionResult);
      return false;
    }
    const uint64_t beforeNs = qpcNowNs(qpcFrequency);
    const bool primingCallback =
        submittedFrames <
        static_cast<uint64_t>(renderProfile.prepared.bufferFrames) * 2;
    const auto input = fifo_.read(inputPointers.data(), frames,
                                  renderProfile.prepared.sampleRate,
                                  !primingCallback);
    if (input.framesRead < frames) {
      if (primingCallback)
        saturatingAdd(&startupInputZeroFrames_, frames - input.framesRead);
      else
        recordAudioHostXRun(&callback_);
    }
    uint32_t discontinuity = input.discontinuity;
    if (pendingRenderDiscontinuity)
      discontinuity |= AudioHostDiscontinuityXRun;
    if (firstCallback) {
      discontinuity |= AudioHostDiscontinuityStart;
      firstCallback = false;
    }
    const detail::WasapiOutputTimestampProjection outputTimestamp =
        detail::projectWasapiOutputTimestamp(
            clockPositionAction, clockPosition, clockQpc100ns, clockFrequency,
            submittedFrames, renderProfile.prepared.sampleRate, beforeNs);
    const uint64_t outputHostNs = outputTimestamp.hostTimeNs;
    const bool usedHardwareClock = outputTimestamp.hardware;
    const AudioHostOutputTimelineResult timeline =
        resolveAudioHostOutputTimeline(&outputTimeline, true, submittedFrames,
                                       usedHardwareClock, frames,
                                       submittedFrames);
    discontinuity |= timeline.discontinuity;
    AudioHostRenderBlock block{
        inputConstPointers.data(), outputPointers.data(),
        static_cast<uint32_t>(inputMap_.size()),
        static_cast<uint32_t>(outputMap_.size()), frames,
        config_.maximumFrames,
        static_cast<double>(renderProfile.prepared.sampleRate), 2,
        routeContext_->generation(),
        streamGeneration_.load(std::memory_order_relaxed), callbackSequence,
        input.sourceFrame, input.sampleHostTimeNs, input.timestampValid,
        input.timestampHardware, timeline.outputFrame, outputHostNs,
        outputHostNs != 0,
        usedHardwareClock,
        beforeNs,
        discontinuity, true};
    // Route loss and a control stop are rechecked immediately before the
    // graph boundary. A buffer already acquired is returned silent without
    // invoking user code after known loss.
    if (stopKnown()) {
      const HRESULT released = renderer->ReleaseBuffer(
          frames, AUDCLNT_BUFFERFLAGS_SILENT);
      if (!operation.finishRelease(released))
        markRuntimeFailure(FAILED(released) ? released : E_FAIL);
      return false;
    }
    if (!operation.markAdvanced()) {
      const HRESULT released = renderer->ReleaseBuffer(
          frames, AUDCLNT_BUFFERFLAGS_SILENT);
      if (FAILED(released)) markRuntimeFailure(released);
      markRuntimeFailure(E_FAIL);
      return false;
    }
    saturatingAdd(&renderRequestedFrames_, frames);
    invokeAudioHostCallback(&callback_, block);
    callbackSequence = advanceAudioHostFrame(callbackSequence, 1);
    detail::planarToInterleavedFloat(
        outputConstPointers.data(), static_cast<uint32_t>(outputMap_.size()),
        outputMap_.data(), renderProfile.prepared.endpointChannels, frames,
        reinterpret_cast<float*>(bytes));
    const HRESULT released = renderer->ReleaseBuffer(frames, 0);
    // The graph and FIFO have advanced exactly once. Releasing that packet is
    // the commit point and can never be retried without duplicating state.
    if (!operation.finishRelease(released)) {
      markRuntimeFailure(FAILED(released) ? released : E_FAIL);
      return false;
    }
    renderBufferErrors = 0;
    pendingRenderDiscontinuity = false;
    submittedFrames = advanceAudioHostFrame(submittedFrames, frames);
    const uint64_t afterNs = qpcNowNs(qpcFrequency);
    if (detail::wasapiRenderRequestExpired(request, afterNs)) {
      recordAudioHostDeadlineMiss(&callback_);
      recordAudioHostXRun(&callback_);
      markRuntimeFailure(E_FAIL);
      return false;
    }
    return true;
  };

  // Wait priority is stop, render, capture. Selecting render first lets the
  // owner timestamp its wake before it performs any co-signaled capture
  // conversion; the arbiter still orders that capture drain before graph.
  HANDLE runtimeEvents[] = {stopEvent_, renderAudioEvent.get(),
                            captureAudioEvent.get()};
  while (!stopKnown()) {
    const DWORD waited =
        WaitForMultipleObjects(3, runtimeEvents, FALSE, INFINITE);
    if (waited > WAIT_OBJECT_0 + 2) {
      markRuntimeFailure(E_FAIL);
      break;
    }
    if (waited == WAIT_OBJECT_0 || stopKnown()) break;

    if (waited == WAIT_OBJECT_0 + 1) {
      // Render was selected. Snapshot its QPC and, in shared mode, its
      // current padding before polling/draining the capture peer. The request
      // remains immutable through pending capture and graph execution.
      const uint64_t renderWakeNs = qpcNowNs(qpcFrequency);
      if (stopKnown()) break;
      detail::WasapiRenderRequest request;
      if (!snapshotRenderRequest(renderWakeNs, &request)) break;
      if (stopKnown()) break;
      const bool captureObserved =
          WaitForSingleObject(captureAudioEvent.get(), 0) == WAIT_OBJECT_0;
      const auto plan = detail::wasapiOwnerArbiterPlan(
          false, captureObserved, true, config_.exclusive);
      if (plan.stop || stopKnown()) break;
      // Shared capture is packetized and nonblocking. Co-signaled capture is
      // still drained before graph, after the render request was snapshotted.
      if (plan.drainCapture &&
          !drainCapture(plan.captureEventObserved, nullptr))
        break;
      if (stopKnown()) break;
      if (!renderOnce(request)) break;
      continue;
    }

    // Capture was selected. Its start timestamp is conservative if render
    // becomes ready while this drain runs: exclusive mode keeps it so all
    // capture work spends the one-period budget.
    const uint64_t captureStartNs = qpcNowNs(qpcFrequency);
    if (stopKnown()) break;
    const bool renderObservedBeforeDrain =
        WaitForSingleObject(renderAudioEvent.get(), 0) == WAIT_OBJECT_0;
    auto captureRenderState = detail::beginWasapiCaptureRenderState(
        renderObservedBeforeDrain);
    detail::WasapiRenderRequest request;
    if (renderObservedBeforeDrain) {
      if (stopKnown() ||
          !snapshotRenderRequest(captureStartNs, &request))
        break;
    }
    if (!drainCapture(true, nullptr)) break;
    if (stopKnown()) break;
    if (detail::shouldPollWasapiRenderAfterCaptureDrain(
            captureRenderState)) {
      // Poll exactly once after the capture drain. An event that arrived
      // during conversion is consumed and serviced in this owner iteration.
      const bool renderObservedAfterDrain =
          WaitForSingleObject(renderAudioEvent.get(), 0) == WAIT_OBJECT_0;
      if (!detail::publishWasapiRenderAfterCaptureDrain(
              &captureRenderState, renderObservedAfterDrain)) {
        markRuntimeFailure(E_FAIL);
        break;
      }
      if (renderObservedAfterDrain) {
        if (stopKnown()) break;
        const uint64_t observedNs = config_.exclusive
                                        ? captureStartNs
                                        : qpcNowNs(qpcFrequency);
        if (!snapshotRenderRequest(observedNs, &request)) break;
      }
    }
    if (detail::claimWasapiCaptureRenderRequest(&captureRenderState)) {
      if (stopKnown()) break;
      if (!renderOnce(request)) break;
    }
  }

  (void)stopOwnedStreams();
  clock.reset();
  renderer.reset();
  capture.reset();
  renderClient.reset();
  captureClient.reset();
  renderDevice.reset();
  captureDevice.reset();
  // notification unregisters next, then endpoint event handles close last.
}


std::unique_ptr<AudioHostBackend> createWindowsAudioHostBackend() {
  return std::make_unique<WasapiAudioHostBackend>();
}

}  // namespace

std::unique_ptr<AudioHostBackend> createPlatformAudioHostBackend() {
  return createWindowsAudioHostBackend();
}

}  // namespace singz

#endif  // _WIN32

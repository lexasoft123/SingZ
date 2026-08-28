#include <zcore/device/audio_input_backend.h>

#if defined(_WIN32)

#include <windows.h>

#include <audioclient.h>
#include <avrt.h>
#include <propkeydef.h>
#include <functiondiscoverykeys_devpkey.h>
#include <ks.h>
#include <ksmedia.h>
#include <mmdeviceapi.h>
#include <propidl.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <limits>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <zcore/audio/audio_input_convert.h>
#include <zcore/audio/audio_input_timestamp.h>

#include "audio_input_windows_helpers.h"

namespace singz {
namespace {

constexpr wchar_t kWasapiPrefix[] = L"wasapi:";
constexpr uint32_t kMaximumChannels = 4096;
constexpr uint32_t kMaximumFrames = 16384;

template <typename T>
class ComPtr {
 public:
  ComPtr() = default;
  ~ComPtr() { reset(); }
  ComPtr(const ComPtr&) = delete;
  ComPtr& operator=(const ComPtr&) = delete;
  T* get() const { return value_; }
  T** put() {
    reset();
    return &value_;
  }
  T* operator->() const { return value_; }
  explicit operator bool() const { return value_ != nullptr; }
  void attach(T* value) {
    reset();
    value_ = value;
  }
  void reset() {
    if (value_) value_->Release();
    value_ = nullptr;
  }

 private:
  T* value_ = nullptr;
};

class ComApartment {
 public:
  ComApartment() {
    result_ = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    owns_ = result_ == S_OK || result_ == S_FALSE;
  }
  ~ComApartment() {
    if (owns_) CoUninitialize();
  }
  bool usable() const { return SUCCEEDED(result_) || result_ == RPC_E_CHANGED_MODE; }
  HRESULT result() const { return result_; }

 private:
  HRESULT result_ = E_FAIL;
  bool owns_ = false;
};

struct WaveFormatDeleter {
  void operator()(WAVEFORMATEX* value) const {
    if (value) CoTaskMemFree(value);
  }
};
using WaveFormatPtr = std::unique_ptr<WAVEFORMATEX, WaveFormatDeleter>;

std::string hresultMessage(const char* operation, HRESULT result) {
  char code[16] = {};
  std::snprintf(code, sizeof(code), "0x%08lx",
                static_cast<unsigned long>(result));
  return std::string(operation) + " failed (" + code + ")";
}

std::string utf8(const wchar_t* value) {
  if (!value || !*value) return {};
  const int count = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, -1,
                                        nullptr, 0, nullptr, nullptr);
  if (count <= 1 || count > 65536) return {};
  std::string result(static_cast<size_t>(count), '\0');
  if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, -1,
                          result.data(), count, nullptr, nullptr) != count)
    return {};
  result.pop_back();
  return result;
}

std::wstring wide(const std::string& value) {
  if (value.empty()) return {};
  const int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
                                        value.data(), static_cast<int>(value.size()),
                                        nullptr, 0);
  if (count <= 0 || count > 65536) return {};
  std::wstring result(static_cast<size_t>(count), L'\0');
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
                          value.data(), static_cast<int>(value.size()),
                          result.data(), count) != count)
    return {};
  return result;
}

bool endpointIdFromUid(const std::string& uid, std::wstring& id) {
  constexpr char prefix[] = "wasapi:";
  if (uid.compare(0, sizeof(prefix) - 1, prefix) != 0) return false;
  id = wide(uid.substr(sizeof(prefix) - 1));
  return !id.empty();
}

std::string friendlyName(IMMDevice* device) {
  ComPtr<IPropertyStore> properties;
  if (!device || FAILED(device->OpenPropertyStore(STGM_READ, properties.put()))) return {};
  PROPVARIANT value;
  PropVariantInit(&value);
  const HRESULT result = properties->GetValue(PKEY_Device_FriendlyName, &value);
  std::string name;
  if (SUCCEEDED(result) && value.vt == VT_LPWSTR) name = utf8(value.pwszVal);
  PropVariantClear(&value);
  return name;
}

const char* captureSetupOperation(
    detail::WasapiCaptureSetupFailure failure) noexcept {
  switch (failure) {
    case detail::WasapiCaptureSetupFailure::None:
      return "WASAPI capture configuration";
    case detail::WasapiCaptureSetupFailure::Activate:
      return "WASAPI capture activation";
    case detail::WasapiCaptureSetupFailure::SetProperties:
      return "WASAPI capture client properties";
    case detail::WasapiCaptureSetupFailure::GetMixFormat:
      return "WASAPI capture mix format";
  }
  return "WASAPI capture configuration";
}

bool mixFormat(IMMDevice* device, double& sampleRate, uint32_t& channels) {
  ComPtr<IAudioClient> client;
  IAudioClient* rawClient = nullptr;
  WAVEFORMATEX* rawFormat = nullptr;
  detail::WasapiCaptureSetupFailure failure{};
  const HRESULT result = detail::setupWasapiCaptureClient(
      device, reinterpret_cast<void**>(&rawClient),
      reinterpret_cast<void**>(&rawFormat), &failure);
  if (FAILED(result) || !rawClient || !rawFormat) return false;
  client.attach(rawClient);
  WaveFormatPtr format(rawFormat);
  if (format->nChannels == 0 || format->nChannels > kMaximumChannels ||
      format->nSamplesPerSec == 0)
    return false;
  sampleRate = format->nSamplesPerSec;
  channels = format->nChannels;
  return true;
}

bool parseFormat(const WAVEFORMATEX* format, AudioInputEncoding& encoding,
                 uint16_t& validBits, std::string& error) {
  if (!format || format->nChannels == 0 || format->nChannels > kMaximumChannels ||
      format->nSamplesPerSec == 0) {
    error = "WASAPI returned an invalid mix format";
    return false;
  }
  WORD tag = format->wFormatTag;
  GUID subtype{};
  validBits = format->wBitsPerSample;
  if (tag == WAVE_FORMAT_EXTENSIBLE) {
    if (format->cbSize < sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX)) {
      error = "WASAPI returned a truncated extensible format";
      return false;
    }
    const auto* extended = reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(format);
    subtype = extended->SubFormat;
    validBits = extended->Samples.wValidBitsPerSample;
    tag = IsEqualGUID(subtype, KSDATAFORMAT_SUBTYPE_IEEE_FLOAT)
              ? WAVE_FORMAT_IEEE_FLOAT
              : IsEqualGUID(subtype, KSDATAFORMAT_SUBTYPE_PCM) ? WAVE_FORMAT_PCM : 0;
  }
  if (tag == WAVE_FORMAT_IEEE_FLOAT && format->wBitsPerSample == 32) {
    encoding = AudioInputEncoding::Float32;
    validBits = 32;
  } else if (tag == WAVE_FORMAT_PCM && format->wBitsPerSample == 16) {
    encoding = AudioInputEncoding::Pcm16;
  } else if (tag == WAVE_FORMAT_PCM && format->wBitsPerSample == 24) {
    encoding = AudioInputEncoding::Pcm24;
  } else if (tag == WAVE_FORMAT_PCM && format->wBitsPerSample == 32) {
    encoding = AudioInputEncoding::Pcm32;
  } else {
    error = "WASAPI input format is unsupported; expected float32 or PCM16/24/32";
    return false;
  }
  const uint32_t bytes = format->wBitsPerSample / 8;
  if (bytes == 0 || format->nBlockAlign != format->nChannels * bytes ||
      validBits == 0 || validBits > format->wBitsPerSample) {
    error = "WASAPI input format has an invalid frame layout";
    return false;
  }
  return true;
}

HRESULT createEnumerator(ComPtr<IMMDeviceEnumerator>& enumerator) {
  return CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                          __uuidof(IMMDeviceEnumerator),
                          reinterpret_cast<void**>(enumerator.put()));
}

HRESULT activateConfiguredCaptureClient(IMMDevice* device,
                                         ComPtr<IAudioClient>& client,
                                         WaveFormatPtr& format,
                                         const char** failedOperation) {
  client.reset();
  format.reset();
  IAudioClient* rawClient = nullptr;
  WAVEFORMATEX* rawFormat = nullptr;
  detail::WasapiCaptureSetupFailure failure{};
  const HRESULT result = detail::setupWasapiCaptureClient(
      device, reinterpret_cast<void**>(&rawClient),
      reinterpret_cast<void**>(&rawFormat), &failure);
  if (failedOperation) *failedOperation = captureSetupOperation(failure);
  if (SUCCEEDED(result)) {
    client.attach(rawClient);
    format.reset(rawFormat);
  }
  return result;
}

uint64_t qpcNowNs(uint64_t frequency) {
  LARGE_INTEGER now{};
  if (!frequency || !QueryPerformanceCounter(&now)) return 0;
  const uint64_t ticks = static_cast<uint64_t>(now.QuadPart);
  const uint64_t seconds = ticks / frequency;
  const uint64_t remainder = ticks % frequency;
  return seconds * 1000000000ull + remainder * 1000000000ull / frequency;
}

enum class RuntimeFailure : int {
  None,
  DeviceInvalidated,
  ServiceStopped,
  CaptureFailed,
  FormatFailed,
};

class WasapiAudioInputBackend final : public AudioInputBackend {
 public:
  ~WasapiAudioInputBackend() override { stop(); }

  AudioInputResult open(const AudioInputConfig& config, AudioInputPush push,
                        void* context) override {
    stop();
    if (!endpointIdFromUid(config.deviceUid, endpointId_))
      return failureResult("WASAPI device UID is invalid", config.channel);
    channel_ = config.channel;
    push_ = push;
    context_ = context;
    stopRequested_.store(false, std::memory_order_release);
    runtimeFailure_.store(RuntimeFailure::None, std::memory_order_release);
    startEvent_ = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    audioEvent_ = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    stopEvent_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (!startEvent_ || !audioEvent_ || !stopEvent_) {
      closeEvents();
      return failureResult("WASAPI could not create capture events", channel_);
    }
    {
      std::lock_guard<std::mutex> lock(stateMutex_);
      openReady_ = false;
      startReady_ = false;
      openResult_ = failureResult("WASAPI initialization did not complete", channel_);
      startResult_ = failureResult("WASAPI start did not complete", channel_);
    }
    try {
      worker_ = std::thread([this] { run(); });
    } catch (...) {
      closeEvents();
      return failureResult("WASAPI could not create the capture thread", channel_);
    }
    std::unique_lock<std::mutex> lock(stateMutex_);
    stateChanged_.wait(lock, [&] { return openReady_; });
    return openResult_;
  }

  AudioInputResult start() override {
    if (!worker_.joinable() || !startEvent_)
      return failureResult("WASAPI is not prepared", channel_);
    if (!SetEvent(startEvent_))
      return failureResult("WASAPI could not signal capture start", channel_);
    std::unique_lock<std::mutex> lock(stateMutex_);
    stateChanged_.wait(lock, [&] { return startReady_; });
    return startResult_;
  }

  void stop() override {
    stopRequested_.store(true, std::memory_order_release);
    if (stopEvent_) SetEvent(stopEvent_);
    if (startEvent_) SetEvent(startEvent_);
    if (audioEvent_) SetEvent(audioEvent_);
    if (worker_.joinable() && worker_.get_id() != std::this_thread::get_id())
      worker_.join();
    closeEvents();
    push_ = nullptr;
    context_ = nullptr;
  }

  bool takeFailure(std::string& error) override {
    const RuntimeFailure failure = runtimeFailure_.exchange(
        RuntimeFailure::None, std::memory_order_acq_rel);
    switch (failure) {
      case RuntimeFailure::None: return false;
      case RuntimeFailure::DeviceInvalidated:
        error = "WASAPI input device was disconnected or reconfigured";
        return true;
      case RuntimeFailure::ServiceStopped:
        error = "Windows Audio service stopped during capture";
        return true;
      case RuntimeFailure::CaptureFailed:
        error = "WASAPI capture failed";
        return true;
      case RuntimeFailure::FormatFailed:
        error = "WASAPI delivered an invalid input buffer";
        return true;
    }
    return false;
  }

 private:
  AudioInputResult failureResult(std::string message, uint32_t channel) const {
    return AudioInputResult::failure(AudioInputState::Error, std::move(message), channel);
  }

  void publishOpen(AudioInputResult result) {
    {
      std::lock_guard<std::mutex> lock(stateMutex_);
      openResult_ = std::move(result);
      openReady_ = true;
    }
    stateChanged_.notify_all();
  }

  void publishStart(AudioInputResult result) {
    {
      std::lock_guard<std::mutex> lock(stateMutex_);
      startResult_ = std::move(result);
      startReady_ = true;
    }
    stateChanged_.notify_all();
  }

  void closeEvents() {
    if (startEvent_) CloseHandle(startEvent_);
    if (audioEvent_) CloseHandle(audioEvent_);
    if (stopEvent_) CloseHandle(stopEvent_);
    startEvent_ = nullptr;
    audioEvent_ = nullptr;
    stopEvent_ = nullptr;
  }

  void failRuntime(HRESULT result) {
    RuntimeFailure failure = RuntimeFailure::CaptureFailed;
    if (result == AUDCLNT_E_DEVICE_INVALIDATED ||
        result == AUDCLNT_E_RESOURCES_INVALIDATED)
      failure = RuntimeFailure::DeviceInvalidated;
    else if (result == AUDCLNT_E_SERVICE_NOT_RUNNING)
      failure = RuntimeFailure::ServiceStopped;
    runtimeFailure_.store(failure, std::memory_order_release);
  }

  bool initializeShared(IMMDevice* device, ComPtr<IAudioClient>& client,
                        WaveFormatPtr& format, std::string& error) {
    const char* failedOperation = "WASAPI capture configuration";
    HRESULT result = activateConfiguredCaptureClient(
        device, client, format, &failedOperation);
    if (FAILED(result) || !format) {
      error = hresultMessage(failedOperation, result);
      return false;
    }
    HRESULT lowLatencyResult = E_NOINTERFACE;
    ComPtr<IAudioClient3> client3;
    if (SUCCEEDED(client->QueryInterface(__uuidof(IAudioClient3),
                                         reinterpret_cast<void**>(client3.put())))) {
      UINT32 defaultFrames = 0, fundamentalFrames = 0, minimumFrames = 0,
             maximumFrames = 0;
      lowLatencyResult = client3->GetSharedModeEnginePeriod(
          format.get(), &defaultFrames, &fundamentalFrames, &minimumFrames,
          &maximumFrames);
      if (SUCCEEDED(lowLatencyResult)) {
        lowLatencyResult = client3->InitializeSharedAudioStream(
            AUDCLNT_STREAMFLAGS_EVENTCALLBACK, minimumFrames, format.get(), nullptr);
      }
    }
    if (SUCCEEDED(lowLatencyResult)) return true;

    // A failed Initialize leaves the client unsuitable for reuse. Reactivate
    // before the broadly supported shared/event fallback.
    result = activateConfiguredCaptureClient(
        device, client, format, &failedOperation);
    if (FAILED(result) || !format) {
      error = hresultMessage(failedOperation, result);
      return false;
    }
    result = client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                                AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                                0, 0, format.get(), nullptr);
    if (FAILED(result)) {
      error = hresultMessage("WASAPI shared capture initialization", result);
      return false;
    }
    return true;
  }

  void run() {
    ComApartment apartment;
    if (!apartment.usable()) {
      publishOpen(failureResult(hresultMessage("WASAPI COM initialization",
                                               apartment.result()), channel_));
      return;
    }
    ComPtr<IMMDeviceEnumerator> enumerator;
    HRESULT result = createEnumerator(enumerator);
    if (FAILED(result)) {
      publishOpen(failureResult(hresultMessage("WASAPI device enumerator", result),
                                channel_));
      return;
    }
    ComPtr<IMMDevice> device;
    result = enumerator->GetDevice(endpointId_.c_str(), device.put());
    if (FAILED(result)) {
      publishOpen(failureResult(hresultMessage("WASAPI input device", result), channel_));
      return;
    }
    ComPtr<IAudioClient> client;
    WaveFormatPtr format;
    std::string error;
    if (!initializeShared(device.get(), client, format, error)) {
      publishOpen(failureResult(std::move(error), channel_));
      return;
    }
    AudioInputEncoding encoding = AudioInputEncoding::Float32;
    uint16_t validBits = 0;
    if (!parseFormat(format.get(), encoding, validBits, error) ||
        channel_ >= format->nChannels) {
      if (error.empty()) error = "WASAPI input channel disappeared";
      publishOpen(failureResult(std::move(error), channel_));
      return;
    }
    result = client->SetEventHandle(audioEvent_);
    if (FAILED(result)) {
      publishOpen(failureResult(hresultMessage("WASAPI capture event", result), channel_));
      return;
    }
    UINT32 bufferFrames = 0;
    result = client->GetBufferSize(&bufferFrames);
    if (FAILED(result) || bufferFrames == 0 || bufferFrames > kMaximumFrames) {
      publishOpen(failureResult(
          FAILED(result) ? hresultMessage("WASAPI capture buffer", result)
                         : "WASAPI capture buffer is too large",
          channel_));
      return;
    }
    ComPtr<IAudioCaptureClient> capture;
    result = client->GetService(__uuidof(IAudioCaptureClient),
                                reinterpret_cast<void**>(capture.put()));
    if (FAILED(result)) {
      publishOpen(failureResult(hresultMessage("WASAPI capture service", result), channel_));
      return;
    }
    std::vector<float> mono(bufferFrames, 0.0f);
    LARGE_INTEGER qpcFrequency{};
    QueryPerformanceFrequency(&qpcFrequency);
    const uint64_t frequency = qpcFrequency.QuadPart > 0
                                   ? static_cast<uint64_t>(qpcFrequency.QuadPart)
                                   : 0;
    sampleRate_ = format->nSamplesPerSec;
    publishOpen(AudioInputResult::success(
        AudioInputState::Starting, sampleRate_, channel_));

    HANDLE beforeStart[] = {stopEvent_, startEvent_};
    const DWORD startWait = WaitForMultipleObjects(2, beforeStart, FALSE, INFINITE);
    if (startWait != WAIT_OBJECT_0 + 1 || stopRequested_.load(std::memory_order_acquire)) {
      publishStart(failureResult("WASAPI capture was stopped before start", channel_));
      return;
    }
    DWORD taskIndex = 0;
    HANDLE mmcss = AvSetMmThreadCharacteristicsW(L"Pro Audio", &taskIndex);
    result = client->Start();
    if (FAILED(result)) {
      if (mmcss) AvRevertMmThreadCharacteristics(mmcss);
      publishStart(failureResult(hresultMessage("WASAPI capture start", result), channel_));
      return;
    }
    publishStart(AudioInputResult::success(
        AudioInputState::Running, sampleRate_, channel_));

    HANDLE captureEvents[] = {stopEvent_, audioEvent_};
    bool running = true;
    bool haveDeliveredPacket = false;
    while (running) {
      // Never INFINITE: a removed or re-enumerated endpoint can stop
      // signaling audioEvent_ forever (nothing here registers an
      // IMMNotificationClient), which would park this worker with the
      // session still reporting Running — the UI then stays latched "Mic
      // on" with a frozen meter. A timed wake probes the client below, and a
      // dead device surfaces AUDCLNT_E_DEVICE_INVALIDATED from
      // GetNextPacketSize within one period; a healthy-but-idle stream just
      // reads zero packets, twice a second.
      const DWORD waited = WaitForMultipleObjects(2, captureEvents, FALSE, 500);
      if (waited == WAIT_OBJECT_0 || stopRequested_.load(std::memory_order_acquire)) break;
      if (waited != WAIT_OBJECT_0 + 1 && waited != WAIT_TIMEOUT) {
        runtimeFailure_.store(RuntimeFailure::CaptureFailed, std::memory_order_release);
        break;
      }
      for (;;) {
        UINT32 available = 0;
        result = capture->GetNextPacketSize(&available);
        if (FAILED(result)) {
          failRuntime(result);
          running = false;
          break;
        }
        if (available == 0) break;
        BYTE* bytes = nullptr;
        UINT32 frames = 0;
        DWORD flags = 0;
        UINT64 devicePosition = 0;
        UINT64 qpcPosition100ns = 0;
        result = capture->GetBuffer(&bytes, &frames, &flags, &devicePosition,
                                    &qpcPosition100ns);
        if (FAILED(result)) {
          failRuntime(result);
          running = false;
          break;
        }
        const uint64_t callbackTime = qpcNowNs(frequency);
        const bool hardwareTimestampValid =
            !(flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR) &&
            qpcPosition100ns != 0 &&
            qpcPosition100ns <= std::numeric_limits<uint64_t>::max() / 100ull;
        const uint64_t hardwareTime = hardwareTimestampValid
                                          ? qpcPosition100ns * 100ull
                                          : 0;
        const AudioInputTimestampProjection projected = resolveAudioInputTimestamp(
            hardwareTimestampValid, hardwareTime, callbackTime, frames,
            sampleRate_);
        const AudioInputTimestampQuality timestampQuality =
            projected.usedHardwareAnchor
                ? AudioInputTimestampQuality::Hardware
                : AudioInputTimestampQuality::CallbackEstimate;
        bool converted = frames > 0 && frames <= mono.size();
        if (converted && (flags & AUDCLNT_BUFFERFLAGS_SILENT)) {
          std::fill_n(mono.data(), frames, 0.0f);
        } else if (converted) {
          converted = convertAudioInputChannel(
              bytes, frames, format->nChannels, channel_, encoding, validBits,
              mono.data());
        }
        if (converted && push_) {
          // Windows commonly tags the first packet discontinuous because no
          // predecessor exists. Only a gap after streaming has begun is a
          // dropped capture attempt in the portable sequence contract.
          if (haveDeliveredPacket &&
              (flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY))
            (void)push_(context_, nullptr, 0, projected.sampleHostTimeNs,
                        callbackTime, timestampQuality);
          (void)push_(context_, mono.data(), frames,
                      projected.sampleHostTimeNs, callbackTime,
                      timestampQuality);
          haveDeliveredPacket = true;
        }
        const HRESULT releaseResult = capture->ReleaseBuffer(frames);
        if (!converted || FAILED(releaseResult)) {
          runtimeFailure_.store(converted ? RuntimeFailure::CaptureFailed
                                          : RuntimeFailure::FormatFailed,
                                std::memory_order_release);
          running = false;
          break;
        }
      }
    }
    (void)client->Stop();
    if (mmcss) AvRevertMmThreadCharacteristics(mmcss);
  }

  std::wstring endpointId_;
  uint32_t channel_ = 0;
  double sampleRate_ = 0;
  AudioInputPush push_ = nullptr;
  void* context_ = nullptr;
  HANDLE startEvent_ = nullptr;
  HANDLE audioEvent_ = nullptr;
  HANDLE stopEvent_ = nullptr;
  std::thread worker_;
  std::mutex stateMutex_;
  std::condition_variable stateChanged_;
  bool openReady_ = false;
  bool startReady_ = false;
  AudioInputResult openResult_;
  AudioInputResult startResult_;
  std::atomic<bool> stopRequested_{true};
  std::atomic<RuntimeFailure> runtimeFailure_{RuntimeFailure::None};
};

}  // namespace

std::vector<AudioInputDevice> enumeratePlatformAudioInputDevices(std::string* error) {
  if (error) error->clear();
  ComApartment apartment;
  if (!apartment.usable()) {
    if (error) *error = hresultMessage("WASAPI COM initialization", apartment.result());
    return {};
  }
  ComPtr<IMMDeviceEnumerator> enumerator;
  HRESULT result = createEnumerator(enumerator);
  if (FAILED(result)) {
    if (error) *error = hresultMessage("WASAPI device enumerator", result);
    return {};
  }
  std::wstring defaultId;
  ComPtr<IMMDevice> defaultDevice;
  if (SUCCEEDED(enumerator->GetDefaultAudioEndpoint(eCapture, eConsole,
                                                    defaultDevice.put()))) {
    wchar_t* rawId = nullptr;
    if (SUCCEEDED(defaultDevice->GetId(&rawId)) && rawId) {
      defaultId = rawId;
      CoTaskMemFree(rawId);
    }
  }
  ComPtr<IMMDeviceCollection> collection;
  result = enumerator->EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE,
                                          collection.put());
  if (FAILED(result)) {
    if (error) *error = hresultMessage("WASAPI input enumeration", result);
    return {};
  }
  UINT count = 0;
  result = collection->GetCount(&count);
  if (FAILED(result) || count > 4096) {
    if (error) *error = FAILED(result)
                            ? hresultMessage("WASAPI input count", result)
                            : "WASAPI returned too many input devices";
    return {};
  }
  std::vector<AudioInputDevice> devices;
  devices.reserve(count);
  for (UINT index = 0; index < count; ++index) {
    ComPtr<IMMDevice> device;
    if (FAILED(collection->Item(index, device.put()))) continue;
    wchar_t* rawId = nullptr;
    if (FAILED(device->GetId(&rawId)) || !rawId) continue;
    const std::wstring id(rawId);
    CoTaskMemFree(rawId);
    const std::string idUtf8 = utf8(id.c_str());
    double sampleRate = 0;
    uint32_t channels = 0;
    if (idUtf8.empty() || !mixFormat(device.get(), sampleRate, channels)) continue;
    AudioInputDevice item;
    item.uid = "wasapi:" + idUtf8;
    item.label = friendlyName(device.get());
    if (item.label.empty()) item.label = "Windows audio input";
    item.isDefault = id == defaultId;
    item.sampleRate = sampleRate;
    item.channels = channels;
    item.channelLabels.reserve(channels);
    for (uint32_t channel = 0; channel < channels; ++channel)
      item.channelLabels.push_back("Channel " + std::to_string(channel + 1));
    devices.push_back(std::move(item));
  }
  return devices;
}

std::unique_ptr<AudioInputBackend> createPlatformAudioInputBackend() {
  return std::make_unique<WasapiAudioInputBackend>();
}

}  // namespace singz

#endif  // _WIN32

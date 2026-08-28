#include <node_api.h>

#include "audio_monitor_session.h"
#include "native_audio_ownership.h"

#include <zdsp/analysis/capture_adapter.h>
#include <zcore/device/audio_input.h>

#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <limits>
#include <memory>
#include <mutex>
#include <string>
#include <utility>
#include <vector>

#if defined(__APPLE__)
#include <mach/mach_time.h>
#elif defined(_WIN32)
#include <windows.h>
#endif

namespace {

using zdsp::analysis::AnalysisWindow;

struct EventBridge {
  napi_threadsafe_function events = nullptr;
  std::atomic<AnalysisWindow*> latest{nullptr};
  std::atomic<bool> queued{false};
  std::atomic<uint64_t> dropped{0};
  std::atomic<uint64_t> overwritten{0};
};

struct CaptureOwner {
  std::mutex mutex;
  std::unique_ptr<singz::AudioInput> input;
  std::unique_ptr<zdsp::analysis::LiveInputAnalysisAdapter> analyzer;
  EventBridge* bridge = nullptr;
  uint64_t generation = 0;
  uint64_t lastDroppedEvents = 0;
  uint64_t lastOverwrittenWindows = 0;
  singz::AudioInputStats lastStats{};
  singz::AudioInputState lastState = singz::AudioInputState::Idle;
  std::string lastError;
};

CaptureOwner owner;
singz::AudioMonitorSession monitor;
singz::NativeAudioOwnership nativeAudioOwnership;

uint64_t hostTimeNowNs() noexcept {
#if defined(__APPLE__)
  mach_timebase_info_data_t timebase{};
  if (mach_timebase_info(&timebase) != KERN_SUCCESS || !timebase.denom) return 0;
  const long double value = static_cast<long double>(mach_absolute_time()) *
                            timebase.numer / timebase.denom;
  return static_cast<uint64_t>(value);
#elif defined(_WIN32)
  LARGE_INTEGER counter{};
  LARGE_INTEGER frequency{};
  if (!QueryPerformanceCounter(&counter) ||
      !QueryPerformanceFrequency(&frequency) || frequency.QuadPart <= 0) return 0;
  return static_cast<uint64_t>(
      static_cast<long double>(counter.QuadPart) * 1000000000.0L /
      frequency.QuadPart);
#else
  return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(
      std::chrono::steady_clock::now().time_since_epoch()).count());
#endif
}

napi_value undefined(napi_env env) {
  napi_value value;
  napi_get_undefined(env, &value);
  return value;
}

napi_value stringValue(napi_env env, const std::string& text) {
  napi_value value;
  napi_create_string_utf8(env, text.c_str(), text.size(), &value);
  return value;
}

napi_value uintValue(napi_env env, uint32_t number) {
  napi_value value;
  napi_create_uint32(env, number, &value);
  return value;
}

napi_value numberValue(napi_env env, double number) {
  napi_value value;
  napi_create_double(env, number, &value);
  return value;
}

napi_value boolValue(napi_env env, bool flag) {
  napi_value value;
  napi_get_boolean(env, flag, &value);
  return value;
}

void set(napi_env env, napi_value object, const char* name, napi_value value) {
  napi_set_named_property(env, object, name, value);
}

void setU64(napi_env env, napi_value object, const char* name, uint64_t value) {
  set(env, object, name, stringValue(env, std::to_string(value)));
}

const char* qualityName(zdsp::CaptureTimestampQuality quality) {
  switch (quality) {
    case zdsp::CaptureTimestampQuality::Hardware: return "hardware";
    case zdsp::CaptureTimestampQuality::Estimated: return "estimated";
    case zdsp::CaptureTimestampQuality::Unknown: return "unknown";
  }
  return "unknown";
}

const char* reasonName(zdsp::DiscontinuityReason reason) {
  switch (reason) {
    case zdsp::DiscontinuityReason::None: return "none";
    case zdsp::DiscontinuityReason::StreamGenerationChanged: return "stream-generation-changed";
    case zdsp::DiscontinuityReason::SequenceGap: return "sequence-gap";
    case zdsp::DiscontinuityReason::SampleRateChanged: return "sample-rate-changed";
    case zdsp::DiscontinuityReason::RouteGenerationChanged: return "route-generation-changed";
    case zdsp::DiscontinuityReason::TimestampQualityChanged: return "timestamp-quality-changed";
    case zdsp::DiscontinuityReason::ClockReanchored: return "clock-reanchored";
    case zdsp::DiscontinuityReason::SourceSeek: return "source-seek";
    case zdsp::DiscontinuityReason::SourceLoop: return "source-loop";
    case zdsp::DiscontinuityReason::DeviceLost: return "device-lost";
    case zdsp::DiscontinuityReason::SourceFrameOverflow: return "source-frame-overflow";
  }
  return "device-lost";
}

napi_value captureTimeValue(napi_env env, const zdsp::CaptureTime& time) {
  napi_value value;
  napi_create_object(env, &value);
  setU64(env, value, "clockDomainId", time.clockDomain.value);
  setU64(env, value, "streamGeneration", time.streamGeneration.value);
  setU64(env, value, "sequence", time.sequence);
  setU64(env, value, "sourceFrame", time.sourceFrame.value);
  setU64(env, value, "sampleHostTimeNs", time.sampleHostTime.value);
  setU64(env, value, "callbackHostTimeNs", time.callbackHostTime.value);
  set(env, value, "quality", stringValue(env, qualityName(time.quality)));
  set(env, value, "discontinuity", stringValue(env, reasonName(time.discontinuity.reason)));
  set(env, value, "flags", uintValue(env, time.flags));
  return value;
}

void scheduleBridge(EventBridge* bridge) {
  bool expected = false;
  if (!bridge || !bridge->queued.compare_exchange_strong(
          expected, true, std::memory_order_acq_rel)) return;
  const napi_status status = napi_call_threadsafe_function(
      bridge->events, nullptr, napi_tsfn_nonblocking);
  if (status == napi_ok) return;
  bridge->queued.store(false, std::memory_order_release);
  delete bridge->latest.exchange(nullptr, std::memory_order_acq_rel);
  bridge->dropped.fetch_add(1, std::memory_order_relaxed);
}

void publishLatest(EventBridge* bridge, const AnalysisWindow& source) {
  auto* copy = new AnalysisWindow(source);
  if (auto* replaced = bridge->latest.exchange(copy, std::memory_order_acq_rel)) {
    delete replaced;
    bridge->overwritten.fetch_add(1, std::memory_order_relaxed);
  }
  scheduleBridge(bridge);
}

void callJs(napi_env env, napi_value callback, void* context, void*) {
  auto* bridge = static_cast<EventBridge*>(context);
  std::unique_ptr<AnalysisWindow> window(
      bridge ? bridge->latest.exchange(nullptr, std::memory_order_acq_rel) : nullptr);
  if (bridge) bridge->queued.store(false, std::memory_order_release);
  if (!env || !callback || !window) return;
  napi_value event;
  napi_create_object(env, &event);
  setU64(env, event, "ownershipGeneration", window->ownershipGeneration);
  setU64(env, event, "resetCount", window->resetCount);
  set(env, event, "resetReason", stringValue(env, reasonName(window->resetReason)));
  set(env, event, "start", captureTimeValue(env, window->start));
  set(env, event, "end", captureTimeValue(env, window->end));
  setU64(env, event, "deliveredAtNs", window->deliveredAt.value);
  const uint64_t bridgedAt = hostTimeNowNs();
  setU64(env, event, "bridgeHostTimeNs", bridgedAt);
  set(env, event, "callbackToBridgeMs", numberValue(env,
      bridgedAt >= window->deliveredAt.value && window->deliveredAt.value
          ? static_cast<double>(bridgedAt - window->deliveredAt.value) / 1000000.0
          : -1.0));
  set(env, event, "sampleRate", numberValue(env, window->sampleRate.value));
  set(env, event, "frequency", numberValue(env, window->analysis.frequency));
  set(env, event, "clarity", numberValue(env, window->analysis.clarity));
  set(env, event, "peak", numberValue(env, window->analysis.peak));
  set(env, event, "rms", numberValue(env, window->analysis.rms));
  set(env, event, "dbfs", numberValue(env, window->analysis.dbfs));
  napi_value receiver;
  napi_get_undefined(env, &receiver);
  napi_value ignored;
  napi_call_function(env, receiver, callback, 1, &event, &ignored);
  // A producer may have replaced the slot while JS consumed this window.
  // Queue one more token for that latest value; the one-slot TSFN can never
  // accumulate the ~683 ms FIFO backlog the previous depth-64 bridge allowed.
  if (bridge->latest.load(std::memory_order_acquire)) scheduleBridge(bridge);
}

void finalizeBridge(napi_env, void* data, void*) {
  auto* bridge = static_cast<EventBridge*>(data);
  if (!bridge) return;
  delete bridge->latest.exchange(nullptr, std::memory_order_acq_rel);
  delete bridge;
}

std::string getString(napi_env env, napi_value object, const char* name) {
  napi_value value;
  bool present = false;
  napi_has_named_property(env, object, name, &present);
  if (!present || napi_get_named_property(env, object, name, &value) != napi_ok) return {};
  size_t size = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &size) != napi_ok) return {};
  std::string result(size + 1, '\0');
  napi_get_value_string_utf8(env, value, result.data(), result.size(), &size);
  result.resize(size);
  return result;
}

bool getExactU64(napi_env env, napi_value value, uint64_t* result) {
  if (result == nullptr) return false;
  napi_valuetype type = napi_undefined;
  if (napi_typeof(env, value, &type) != napi_ok) return false;
  if (type == napi_bigint) {
    bool lossless = false;
    uint64_t parsed = 0;
    if (napi_get_value_bigint_uint64(env, value, &parsed, &lossless) != napi_ok ||
        !lossless || parsed == 0)
      return false;
    *result = parsed;
    return true;
  }
  if (type != napi_number) return false;
  double parsed = 0.0;
  constexpr double kMaximumSafeInteger = 9007199254740991.0;
  if (napi_get_value_double(env, value, &parsed) != napi_ok ||
      !std::isfinite(parsed) || parsed < 1.0 || parsed > kMaximumSafeInteger ||
      std::floor(parsed) != parsed)
    return false;
  *result = static_cast<uint64_t>(parsed);
  return true;
}

bool getExactU32Value(napi_env env, napi_value value, uint32_t minimum,
                      uint32_t maximum, uint32_t* result) {
  if (result == nullptr || minimum > maximum) return false;
  napi_valuetype type = napi_undefined;
  if (napi_typeof(env, value, &type) != napi_ok) return false;
  uint64_t parsed = 0;
  if (type == napi_bigint) {
    bool lossless = false;
    if (napi_get_value_bigint_uint64(env, value, &parsed, &lossless) != napi_ok ||
        !lossless)
      return false;
  } else if (type == napi_number) {
    double number = 0.0;
    if (napi_get_value_double(env, value, &number) != napi_ok ||
        !std::isfinite(number) || number < 0.0 ||
        number > static_cast<double>(std::numeric_limits<uint32_t>::max()) ||
        std::floor(number) != number)
      return false;
    parsed = static_cast<uint64_t>(number);
  } else {
    return false;
  }
  if (parsed < minimum || parsed > maximum) return false;
  *result = static_cast<uint32_t>(parsed);
  return true;
}

bool getExactU32(napi_env env, napi_value object, const char* name,
                 uint32_t minimum, uint32_t maximum, bool required,
                 uint32_t fallback, uint32_t* result) {
  napi_value value;
  bool present = false;
  if (napi_has_named_property(env, object, name, &present) != napi_ok)
    return false;
  if (!present) {
    if (required || result == nullptr) return false;
    *result = fallback;
    return true;
  }
  return napi_get_named_property(env, object, name, &value) == napi_ok &&
         getExactU32Value(env, value, minimum, maximum, result);
}

bool getExactBool(napi_env env, napi_value object, const char* name,
                  bool required, bool fallback, bool* result) {
  napi_value value;
  bool present = false;
  if (napi_has_named_property(env, object, name, &present) != napi_ok)
    return false;
  if (!present) {
    if (required || result == nullptr) return false;
    *result = fallback;
    return true;
  }
  napi_valuetype type = napi_undefined;
  if (napi_get_named_property(env, object, name, &value) != napi_ok ||
      napi_typeof(env, value, &type) != napi_ok || type != napi_boolean)
    return false;
  return napi_get_value_bool(env, value, result) == napi_ok;
}

bool getExactU32Array(napi_env env, napi_value object, const char* name,
                      std::vector<uint32_t>* result) {
  if (result == nullptr) return false;
  napi_value value;
  bool present = false;
  bool isArray = false;
  napi_has_named_property(env, object, name, &present);
  if (!present || napi_get_named_property(env, object, name, &value) != napi_ok ||
      napi_is_array(env, value, &isArray) != napi_ok || !isArray)
    return false;
  uint32_t length = 0;
  if (napi_get_array_length(env, value, &length) != napi_ok ||
      length > singz::kAudioHostMaxChannels)
    return false;
  if (length == 0) return false;
  std::vector<uint32_t> parsed;
  parsed.reserve(length);
  for (uint32_t index = 0; index < length; ++index) {
    napi_value item;
    uint32_t channel = 0;
    if (napi_get_element(env, value, index, &item) != napi_ok ||
        !getExactU32Value(env, item, 0, singz::kAudioHostMaxChannels - 1,
                          &channel))
      return false;
    parsed.push_back(channel);
  }
  *result = std::move(parsed);
  return true;
}

void stopLocked(uint64_t generation, bool force) {
  if (!force && generation != owner.generation) return;
  const uint64_t releasedGeneration = owner.generation;
  if (owner.analyzer) owner.analyzer->cancel(owner.generation);
  if (owner.input) {
    owner.input->stop();
    owner.lastStats = owner.input->stats();
    owner.lastState = owner.input->state();
    owner.lastError = owner.input->lastError();
  }
  if (owner.bridge) {
    owner.lastDroppedEvents = owner.bridge->dropped.load(std::memory_order_relaxed);
    owner.lastOverwrittenWindows = owner.bridge->overwritten.load(std::memory_order_relaxed);
  }
  owner.analyzer.reset();
  owner.input.reset();
  if (owner.bridge) {
    napi_release_threadsafe_function(owner.bridge->events, napi_tsfn_abort);
    owner.bridge = nullptr;
  }
  owner.generation = 0;
  if (releasedGeneration != 0) {
    (void)nativeAudioOwnership.release(
        singz::NativeAudioOwnerKind::Capture, releasedGeneration);
  }
}

napi_value captureBusyResult(napi_env env, uint64_t generation) {
  napi_value response;
  napi_create_object(env, &response);
  set(env, response, "ok", boolValue(env, false));
  set(env, response, "state", stringValue(env, "busy"));
  set(env, response, "errorCode", stringValue(env, "native-audio-busy"));
  set(env, response, "error", stringValue(
      env, "Another native microphone owner is already active"));
  setU64(env, response, "ownershipGeneration", generation);
  return response;
}

napi_value devices(napi_env env, napi_callback_info) {
  std::string error;
  const auto rows = singz::enumerateAudioInputDevices(&error);
  napi_value result;
  napi_create_object(env, &result);
  set(env, result, "ok", boolValue(env, error.empty()));
  if (!error.empty()) set(env, result, "error", stringValue(env, error));
  napi_value list;
  napi_create_array_with_length(env, rows.size(), &list);
  for (size_t i = 0; i < rows.size(); ++i) {
    napi_value row;
    napi_create_object(env, &row);
    set(env, row, "uid", stringValue(env, rows[i].uid));
    set(env, row, "label", stringValue(env, rows[i].label));
    set(env, row, "isDefault", boolValue(env, rows[i].isDefault));
    set(env, row, "sampleRate", numberValue(env, rows[i].sampleRate));
    set(env, row, "channels", uintValue(env, rows[i].channels));
    napi_value labels;
    napi_create_array_with_length(env, rows[i].channelLabels.size(), &labels);
    for (size_t channel = 0; channel < rows[i].channelLabels.size(); ++channel)
      napi_set_element(env, labels, channel, stringValue(env, rows[i].channelLabels[channel]));
    set(env, row, "channelLabels", labels);
    napi_set_element(env, list, i, row);
  }
  set(env, result, "devices", list);
  return result;
}

napi_value begin(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc != 3) {
    napi_throw_type_error(env, nullptr, "beginCapture requires config, generation and callback");
    return undefined(env);
  }
  uint64_t generation = 0;
  const bool validGeneration = getExactU64(env, argv[1], &generation);
  napi_valuetype callbackType;
  napi_typeof(env, argv[2], &callbackType);
  if (!validGeneration || callbackType != napi_function) {
    napi_throw_type_error(env, nullptr, "generation must be positive and callback must be a function");
    return undefined(env);
  }

  singz::AudioInputConfig config;
  config.deviceUid = getString(env, argv[0], "deviceUid");
  if (!getExactU32(env, argv[0], "inputChannel", 0,
                   singz::kAudioHostMaxChannels - 1, false, 0,
                   &config.channel) ||
      !getExactU32(env, argv[0], "ringBlocks", 2, 256, false, 32,
                   &config.ringBlocks)) {
    napi_throw_type_error(env, nullptr,
                          "capture channels and ring blocks must be exact bounded integers");
    return undefined(env);
  }
  const singz::NativeAudioAcquireResult acquired =
      nativeAudioOwnership.acquire(singz::NativeAudioOwnerKind::Capture,
                                   generation);
  if (acquired == singz::NativeAudioAcquireResult::Busy)
    return captureBusyResult(env, generation);
  if (acquired != singz::NativeAudioAcquireResult::Acquired) {
    napi_throw_type_error(env, nullptr, "capture generation is invalid");
    return undefined(env);
  }

  std::lock_guard<std::mutex> lock(owner.mutex);
  napi_value name = stringValue(env, "SingZ capture analysis");
  auto* bridge = new EventBridge();
  if (napi_create_threadsafe_function(env, argv[2], nullptr, name, 1, 1,
          bridge, finalizeBridge, bridge, callJs, &bridge->events) != napi_ok) {
    delete bridge;
    (void)nativeAudioOwnership.release(
        singz::NativeAudioOwnerKind::Capture, generation);
    napi_throw_error(env, nullptr, "could not create capture event bridge");
    return undefined(env);
  }
  owner.bridge = bridge;
  owner.generation = generation;
  owner.lastDroppedEvents = 0;
  owner.lastOverwrittenWindows = 0;
  owner.analyzer = std::make_unique<zdsp::analysis::LiveInputAnalysisAdapter>(generation);
  owner.input = std::make_unique<singz::AudioInput>();
  const auto inventory = singz::enumerateAudioInputDevices();
  const singz::AudioInputDevice* selectedDevice = nullptr;
  for (const auto& device : inventory) {
    if (device.uid == config.deviceUid) {
      selectedDevice = &device;
      break;
    }
  }
  const auto result = owner.input->start(config, [](const singz::AudioInputBlockView& block) {
    auto* analyzer = owner.analyzer.get();
    if (!analyzer || !owner.bridge) return;
    analyzer->push(block, [](const AnalysisWindow& window) {
      if (owner.bridge) publishLatest(owner.bridge, window);
    });
  });
  owner.lastState = result.state;
  owner.lastError = result.error;
  if (!result.ok) stopLocked(generation, true);

  napi_value response;
  napi_create_object(env, &response);
  set(env, response, "ok", boolValue(env, result.ok));
  set(env, response, "state", stringValue(env, singz::audioInputStateName(result.state)));
  if (!result.error.empty()) set(env, response, "error", stringValue(env, result.error));
  set(env, response, "sampleRate", numberValue(env, result.sampleRate));
  set(env, response, "inputChannel", uintValue(env, result.channel));
  set(env, response, "deviceUid", stringValue(env,
      result.deviceUid.empty() ? config.deviceUid : result.deviceUid));
  set(env, response, "deviceLabel", stringValue(env,
      selectedDevice ? selectedDevice->label : std::string{}));
  set(env, response, "deviceChannels", uintValue(env,
      result.deviceChannels ? result.deviceChannels
                            : selectedDevice ? selectedDevice->channels : 0));
  set(env, response, "sampleFormat", stringValue(env,
      result.sampleFormat.empty() ? "float32" : result.sampleFormat));
#if defined(_WIN32)
  constexpr const char* kSharingMode = "wasapi-shared";
  constexpr const char* kPerformanceMode = "event-driven";
#else
  constexpr const char* kSharingMode = "auhal";
  constexpr const char* kPerformanceMode = "callback";
#endif
  set(env, response, "sharingMode", stringValue(env,
      result.sharingMode.empty() ? kSharingMode : result.sharingMode));
  set(env, response, "performanceMode", stringValue(env,
      result.performanceMode.empty() ? kPerformanceMode : result.performanceMode));
  set(env, response, "timestampSource", stringValue(env,
      result.timestampSource.empty() ? "hardware-or-callback-estimate"
                                     : result.timestampSource));
  return response;
}

napi_value cancel(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  uint64_t generation = 0;
  if (argc) (void)getExactU64(env, argv[0], &generation);
  std::lock_guard<std::mutex> lock(owner.mutex);
  const bool matched = generation != 0 && generation == owner.generation;
  if (matched) stopLocked(generation, false);
  napi_value result;
  napi_create_object(env, &result);
  set(env, result, "ok", boolValue(env, true));
  set(env, result, "cancelled", boolValue(env, matched));
  return result;
}

napi_value state(napi_env env, napi_callback_info) {
  std::lock_guard<std::mutex> lock(owner.mutex);
  napi_value result;
  napi_create_object(env, &result);
  const auto current = owner.input ? owner.input->state() : owner.lastState;
  set(env, result, "state", stringValue(env, singz::audioInputStateName(current)));
  setU64(env, result, "ownershipGeneration", owner.generation);
  set(env, result, "error", stringValue(env, owner.input ? owner.input->lastError() : owner.lastError));
  return result;
}

napi_value stats(napi_env env, napi_callback_info) {
  std::lock_guard<std::mutex> lock(owner.mutex);
  const auto value = owner.input ? owner.input->stats() : owner.lastStats;
  napi_value result;
  napi_create_object(env, &result);
  setU64(env, result, "deliveredBlocks", value.deliveredBlocks);
  setU64(env, result, "deliveredFrames", value.deliveredFrames);
  setU64(env, result, "overruns", value.overruns);
  setU64(env, result, "deliveryWakeups", value.deliveryWakeups);
  setU64(env, result, "droppedEvents", owner.bridge
      ? owner.bridge->dropped.load(std::memory_order_relaxed)
      : owner.lastDroppedEvents);
  setU64(env, result, "overwrittenWindows", owner.bridge
      ? owner.bridge->overwritten.load(std::memory_order_relaxed)
      : owner.lastOverwrittenWindows);
  return result;
}

const char* hostStateName(singz::AudioHostState state) {
  switch (state) {
    case singz::AudioHostState::Closed: return "closed";
    case singz::AudioHostState::Open: return "open";
    case singz::AudioHostState::Running: return "running";
    case singz::AudioHostState::Stopped: return "stopped";
    case singz::AudioHostState::DeviceLost: return "device-lost";
    case singz::AudioHostState::Error: return "error";
    case singz::AudioHostState::Unsupported: return "unsupported";
  }
  return "error";
}

const char* directionName(singz::AudioHostEndpointDirection direction) {
  switch (direction) {
    case singz::AudioHostEndpointDirection::Duplex: return "duplex";
    case singz::AudioHostEndpointDirection::Input: return "input";
    case singz::AudioHostEndpointDirection::Output: return "output";
  }
  return "duplex";
}

const char* accessName(singz::AudioHostAccessMode mode) {
  return mode == singz::AudioHostAccessMode::Exclusive ? "exclusive" : "shared";
}

const char* transportName(singz::AudioHostTransport transport) {
  switch (transport) {
    case singz::AudioHostTransport::Unknown: return "unknown";
    case singz::AudioHostTransport::BuiltIn: return "built-in";
    case singz::AudioHostTransport::Aggregate: return "aggregate";
    case singz::AudioHostTransport::Virtual: return "virtual";
    case singz::AudioHostTransport::Pci: return "pci";
    case singz::AudioHostTransport::Usb: return "usb";
    case singz::AudioHostTransport::FireWire: return "firewire";
    case singz::AudioHostTransport::Bluetooth: return "bluetooth";
    case singz::AudioHostTransport::BluetoothLowEnergy: return "bluetooth-le";
    case singz::AudioHostTransport::Hdmi: return "hdmi";
    case singz::AudioHostTransport::DisplayPort: return "display-port";
    case singz::AudioHostTransport::AirPlay: return "airplay";
    case singz::AudioHostTransport::Avb: return "avb";
    case singz::AudioHostTransport::Thunderbolt: return "thunderbolt";
    case singz::AudioHostTransport::ContinuityWired: return "continuity-wired";
    case singz::AudioHostTransport::ContinuityWireless:
      return "continuity-wireless";
    case singz::AudioHostTransport::Vehicle: return "vehicle";
  }
  return "unknown";
}

const char* monitoringSuitabilityName(
    singz::AudioHostMonitoringSuitability suitability) {
  switch (suitability) {
    case singz::AudioHostMonitoringSuitability::Unknown: return "unknown";
    case singz::AudioHostMonitoringSuitability::LowLatency:
      return "low-latency";
    case singz::AudioHostMonitoringSuitability::HighLatency:
      return "high-latency";
    case singz::AudioHostMonitoringSuitability::Unsupported:
      return "unsupported";
  }
  return "unknown";
}

void setHostFormat(napi_env env, napi_value object,
                   const singz::AudioHostFormat& format) {
  napi_value value;
  napi_create_object(env, &value);
  set(env, value, "sampleRate", numberValue(env, format.sampleRate));
  set(env, value, "maximumFrames", uintValue(env, format.maximumFrames));
  set(env, value, "nominalBufferFrames",
      uintValue(env, format.nominalBufferFrames));
  set(env, value, "inputChannels", uintValue(env, format.inputChannels));
  set(env, value, "outputChannels", uintValue(env, format.outputChannels));
  set(env, value, "sampleFormat", stringValue(env, "float32-planar"));
  set(env, value, "outputClockMaster", boolValue(env, format.outputClockMaster));
  set(env, value, "accessMode", stringValue(env, accessName(format.accessMode)));
  set(env, object, "format", value);
}

void setHostLatency(napi_env env, napi_value object,
                    const singz::AudioHostLatency& latency) {
  napi_value value;
  napi_create_object(env, &value);
  set(env, value, "inputDeviceFrames", uintValue(env, latency.inputDeviceFrames));
  set(env, value, "outputDeviceFrames", uintValue(env, latency.outputDeviceFrames));
  set(env, value, "bufferFrames", uintValue(env, latency.bufferFrames));
  set(env, value, "externalRouteFrames", uintValue(env, latency.externalRouteFrames));
  set(env, object, "latency", value);
}

napi_value monitorResultValue(napi_env env,
                              const singz::AudioMonitorResult& source) {
  napi_value result;
  napi_create_object(env, &result);
  set(env, result, "ok", boolValue(env, source.ok));
  set(env, result, "errorCode",
      stringValue(env, singz::audioMonitorErrorName(source.error)));
  set(env, result, "error", stringValue(env, source.message));
  setU64(env, result, "ownershipGeneration", source.ownershipGeneration);
  set(env, result, "state", stringValue(env, hostStateName(source.state)));
  setHostFormat(env, result, source.format);
  setHostLatency(env, result, source.latency);
  return result;
}

napi_value audioHostDevices(napi_env env, napi_callback_info) {
  const singz::AudioHostInventory inventory = monitor.enumerate();
  napi_value result;
  napi_create_object(env, &result);
  set(env, result, "ok", boolValue(env, true));
  set(env, result, "defaultInputUid",
      stringValue(env, inventory.defaultInputUid));
  set(env, result, "defaultOutputUid",
      stringValue(env, inventory.defaultOutputUid));
  napi_value devices;
  napi_create_array_with_length(env, inventory.devices.size(), &devices);
  for (size_t index = 0; index < inventory.devices.size(); ++index) {
    const singz::AudioHostDeviceInfo& source = inventory.devices[index];
    napi_value device;
    napi_create_object(env, &device);
    set(env, device, "uid", stringValue(env, source.uid));
    set(env, device, "label", stringValue(env, source.label));
    set(env, device, "defaultInput", boolValue(env, source.defaultInput));
    set(env, device, "defaultOutput", boolValue(env, source.defaultOutput));
    set(env, device, "inputChannels", uintValue(env, source.inputChannels));
    set(env, device, "outputChannels", uintValue(env, source.outputChannels));
    set(env, device, "nominalSampleRate",
        numberValue(env, source.nominalSampleRate));
    set(env, device, "direction",
        stringValue(env, directionName(source.direction)));
    set(env, device, "accessMode",
        stringValue(env, accessName(source.accessMode)));
    set(env, device, "transport",
        stringValue(env, transportName(source.transport)));
    set(env, device, "monitoringSuitability",
        stringValue(env,
                    monitoringSuitabilityName(source.monitoringSuitability)));
    napi_value rates;
    napi_create_array_with_length(env, source.sampleRateRanges.size(), &rates);
    for (size_t rateIndex = 0; rateIndex < source.sampleRateRanges.size();
         ++rateIndex) {
      napi_value rate;
      napi_create_object(env, &rate);
      set(env, rate, "minimumHz",
          numberValue(env, source.sampleRateRanges[rateIndex].minimumHz));
      set(env, rate, "maximumHz",
          numberValue(env, source.sampleRateRanges[rateIndex].maximumHz));
      napi_set_element(env, rates, rateIndex, rate);
    }
    set(env, device, "sampleRateRanges", rates);
    napi_value buffers;
    napi_create_object(env, &buffers);
    set(env, buffers, "minimumFrames",
        uintValue(env, source.bufferFrames.minimumFrames));
    set(env, buffers, "maximumFrames",
        uintValue(env, source.bufferFrames.maximumFrames));
    set(env, buffers, "preferredFrames",
        uintValue(env, source.bufferFrames.preferredFrames));
    set(env, buffers, "fundamentalFrames",
        uintValue(env, source.bufferFrames.fundamentalFrames));
    set(env, device, "bufferFrames", buffers);
    napi_set_element(env, devices, index, device);
  }
  set(env, result, "devices", devices);
  return result;
}

napi_value beginMonitor(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc != 2) {
    napi_throw_type_error(env, nullptr,
                          "beginMonitor requires config and generation");
    return undefined(env);
  }
  uint64_t generation = 0;
  const bool validGeneration = getExactU64(env, argv[1], &generation);
  singz::AudioMonitorConfig config;
  config.inputDeviceUid = getString(env, argv[0], "inputDeviceUid");
  config.outputDeviceUid = getString(env, argv[0], "outputDeviceUid");
  uint32_t sampleRate = 0;
  const bool validConfig =
      getExactU32Array(env, argv[0], "inputChannels", &config.inputChannels) &&
      getExactU32Array(env, argv[0], "outputChannels",
                       &config.outputChannels) &&
      getExactU32(env, argv[0], "sampleRate", 8000, 384000, true, 0,
                  &sampleRate) &&
      getExactU32(env, argv[0], "bufferFrames", 1,
                  singz::kAudioHostMaxFrames, true, 0,
                  &config.bufferFrames) &&
      getExactU32(env, argv[0], "maximumFrames", 1,
                  singz::kAudioHostMaxFrames, true, 0,
                  &config.maximumFrames) &&
      getExactBool(env, argv[0], "exclusive", false, false,
                   &config.exclusive);
  config.sampleRate = static_cast<double>(sampleRate);
  if (!validGeneration)
    return monitorResultValue(env, monitor.begin(config, 0));
  if (!validConfig) {
    const singz::AudioMonitorStatus status = monitor.status();
    return monitorResultValue(
        env, {false, singz::AudioMonitorError::InvalidConfiguration,
              generation, status.host.state, status.host.format,
              status.host.latency,
              "Monitor configuration values must have exact bounded types"});
  }
  const singz::NativeAudioAcquireResult acquired =
      nativeAudioOwnership.acquire(singz::NativeAudioOwnerKind::Monitor,
                                   generation);
  if (acquired != singz::NativeAudioAcquireResult::Acquired) {
    const singz::AudioMonitorStatus status = monitor.status();
    const singz::AudioMonitorError error =
        acquired == singz::NativeAudioAcquireResult::Busy
            ? singz::AudioMonitorError::NativeAudioBusy
            : singz::AudioMonitorError::InvalidGeneration;
    return monitorResultValue(
        env, {false, error, generation, status.host.state, status.host.format,
              status.host.latency,
              error == singz::AudioMonitorError::NativeAudioBusy
                  ? "Another native microphone owner is already active"
                  : "Monitor generation is invalid"});
  }
  singz::AudioMonitorResult result = monitor.begin(config, generation);
  if (!result.ok) {
    const singz::AudioMonitorStatus status = monitor.status();
    const uint64_t retainedGeneration =
        status.active ? status.ownershipGeneration : 0;
    (void)singz::releaseUnretainedMonitorBeginLease(
        &nativeAudioOwnership, generation, retainedGeneration);
  }
  return monitorResultValue(env, result);
}

napi_value setMonitorGain(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc != 3) {
    napi_throw_type_error(env, nullptr,
                          "setMonitorGain requires generation, gainDb and enabled");
    return undefined(env);
  }
  uint64_t generation = 0;
  const bool validGeneration = getExactU64(env, argv[0], &generation);
  double gainDb = std::numeric_limits<double>::quiet_NaN();
  napi_valuetype gainType = napi_undefined;
  napi_valuetype enabledType = napi_undefined;
  bool enabled = false;
  const bool validGain =
      napi_typeof(env, argv[1], &gainType) == napi_ok &&
      gainType == napi_number &&
      napi_get_value_double(env, argv[1], &gainDb) == napi_ok &&
      std::isfinite(gainDb) &&
      gainDb >= static_cast<double>(singz::kMonitorMinimumGainDb) &&
      gainDb <= static_cast<double>(singz::kMonitorMaximumGainDb);
  const bool validEnabled =
      napi_typeof(env, argv[2], &enabledType) == napi_ok &&
      enabledType == napi_boolean &&
      napi_get_value_bool(env, argv[2], &enabled) == napi_ok;
  if (!validGeneration)
    return monitorResultValue(env, monitor.setGain(0, 0.0F, false));
  if (!validGain || !validEnabled) {
    const singz::AudioMonitorStatus status = monitor.status();
    return monitorResultValue(
        env, {false, singz::AudioMonitorError::InvalidConfiguration,
              generation, status.host.state, status.host.format,
              status.host.latency,
              "Gain must be between -60 and +12 dB and enabled must be a boolean"});
  }
  return monitorResultValue(
      env, monitor.setGain(generation,
                           static_cast<float>(gainDb), enabled));
}

void setMonitorMeter(napi_env env, napi_value object, const char* name,
                     const singz::AudioMonitorMeter& source) {
  napi_value meter;
  napi_create_object(env, &meter);
  set(env, meter, "peak", numberValue(env, source.peak));
  set(env, meter, "rms", numberValue(env, source.rms));
  setU64(env, meter, "frames", source.frames);
  set(env, object, name, meter);
}

napi_value monitorStatus(napi_env env, napi_callback_info) {
  const singz::AudioMonitorStatus source = monitor.status();
  napi_value result;
  napi_create_object(env, &result);
  set(env, result, "active", boolValue(env, source.active));
  set(env, result, "enabled", boolValue(env, source.enabled));
  set(env, result, "deviceLost", boolValue(env, source.deviceLost));
  setU64(env, result, "ownershipGeneration", source.ownershipGeneration);
  set(env, result, "gainDb", numberValue(env, source.gainDb));
  set(env, result, "state", stringValue(env, hostStateName(source.host.state)));
  set(env, result, "error", stringValue(env, source.error));
  setMonitorMeter(env, result, "pre", source.pre);
  setMonitorMeter(env, result, "post", source.post);
  setHostFormat(env, result, source.host.format);
  setHostLatency(env, result, source.host.latency);
  setU64(env, result, "routeGeneration", source.host.routeGeneration);
  setU64(env, result, "streamGeneration", source.host.streamGeneration);
  setU64(env, result, "callbacks", source.host.callbacks);
  setU64(env, result, "renderedFrames", source.host.renderedFrames);
  setU64(env, result, "xruns", source.host.xruns);
  setU64(env, result, "deadlineMisses", source.host.deadlineMisses);
  setU64(env, result, "renderFailures", source.host.renderFailures);
  set(env, result, "adapterRenderFailures",
      uintValue(env, source.adapterRenderFailures));
  set(env, result, "terminalRenderFailures",
      uintValue(env, source.terminalRenderFailures));
  set(env, result, "adapterLastStatusCode",
      uintValue(env, source.adapterLastStatusCode));
  set(env, result, "parameterOverflows",
      uintValue(env, source.parameterOverflows));
  set(env, result, "nonFiniteSamples",
      uintValue(env, source.nonFiniteSamples));
  set(env, result, "rejectedBlocks", uintValue(env, source.rejectedBlocks));
  return result;
}

napi_value endMonitor(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc != 1) {
    napi_throw_type_error(env, nullptr, "endMonitor requires generation");
    return undefined(env);
  }
  uint64_t generation = 0;
  if (!getExactU64(env, argv[0], &generation))
    return monitorResultValue(env, monitor.end(0));
  singz::AudioMonitorResult result = monitor.end(generation);
  (void)singz::releaseMonitorLeaseAfterEnd(
      &nativeAudioOwnership, generation, result.ok);
  return monitorResultValue(env, result);
}

void cleanup(void*) {
  std::lock_guard<std::mutex> lock(owner.mutex);
  stopLocked(owner.generation, true);
  const auto status = monitor.status();
  if (status.active) {
    const singz::AudioMonitorResult ended =
        monitor.end(status.ownershipGeneration);
    (void)singz::releaseMonitorLeaseAfterEnd(
        &nativeAudioOwnership, status.ownershipGeneration, ended.ok);
  }
}

napi_value init(napi_env env, napi_value exports) {
  napi_add_env_cleanup_hook(env, cleanup, nullptr);
  napi_property_descriptor properties[] = {
      {"inputDevices", nullptr, devices, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"beginCapture", nullptr, begin, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"cancelCapture", nullptr, cancel, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"captureState", nullptr, state, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"captureStats", nullptr, stats, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"audioHostDevices", nullptr, audioHostDevices, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"beginMonitor", nullptr, beginMonitor, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"setMonitorGain", nullptr, setMonitorGain, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"monitorStatus", nullptr, monitorStatus, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"endMonitor", nullptr, endMonitor, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  // Build identity: the loader refuses an addon whose Electron differs from
  // the running process, and the source stamp names exactly which tree built
  // this binary — the vendored-binary-matches-this-build rule, addon edition.
  napi_value buildInfo;
  napi_create_object(env, &buildInfo);
  set(env, buildInfo, "electronVersion", stringValue(env, SINGZ_CAPTURE_ELECTRON));
  set(env, buildInfo, "sourceStamp", stringValue(env, SINGZ_CAPTURE_SOURCE_STAMP));
  set(env, exports, "buildInfo", buildInfo);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)

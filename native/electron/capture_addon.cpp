#include <node_api.h>

#include <zdsp/analysis/capture_adapter.h>
#include <zcore/device/audio_input.h>

#include <atomic>
#include <chrono>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>

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

uint32_t getU32(napi_env env, napi_value object, const char* name, uint32_t fallback) {
  napi_value value;
  uint32_t result = fallback;
  bool present = false;
  napi_has_named_property(env, object, name, &present);
  if (present && napi_get_named_property(env, object, name, &value) == napi_ok)
    napi_get_value_uint32(env, value, &result);
  return result;
}

uint64_t getU64(napi_env env, napi_value value) {
  bool lossless = false;
  uint64_t result = 0;
  if (napi_get_value_bigint_uint64(env, value, &result, &lossless) == napi_ok && lossless)
    return result;
  double number = 0;
  if (napi_get_value_double(env, value, &number) == napi_ok && number >= 1)
    return static_cast<uint64_t>(number);
  return 0;
}

void stopLocked(uint64_t generation, bool force) {
  if (!force && generation != owner.generation) return;
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
  const uint64_t generation = getU64(env, argv[1]);
  napi_valuetype callbackType;
  napi_typeof(env, argv[2], &callbackType);
  if (!generation || callbackType != napi_function) {
    napi_throw_type_error(env, nullptr, "generation must be positive and callback must be a function");
    return undefined(env);
  }

  std::lock_guard<std::mutex> lock(owner.mutex);
  stopLocked(owner.generation, true);
  napi_value name = stringValue(env, "SingZ capture analysis");
  auto* bridge = new EventBridge();
  if (napi_create_threadsafe_function(env, argv[2], nullptr, name, 1, 1,
          bridge, finalizeBridge, bridge, callJs, &bridge->events) != napi_ok) {
    delete bridge;
    napi_throw_error(env, nullptr, "could not create capture event bridge");
    return undefined(env);
  }
  owner.bridge = bridge;
  owner.generation = generation;
  owner.lastDroppedEvents = 0;
  owner.lastOverwrittenWindows = 0;
  owner.analyzer = std::make_unique<zdsp::analysis::LiveInputAnalysisAdapter>(generation);
  owner.input = std::make_unique<singz::AudioInput>();
  singz::AudioInputConfig config;
  config.deviceUid = getString(env, argv[0], "deviceUid");
  config.channel = getU32(env, argv[0], "inputChannel", 0);
  config.ringBlocks = getU32(env, argv[0], "ringBlocks", 32);
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
  const uint64_t generation = argc ? getU64(env, argv[0]) : 0;
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

void cleanup(void*) {
  std::lock_guard<std::mutex> lock(owner.mutex);
  stopLocked(owner.generation, true);
}

napi_value init(napi_env env, napi_value exports) {
  napi_add_env_cleanup_hook(env, cleanup, nullptr);
  napi_property_descriptor properties[] = {
      {"inputDevices", nullptr, devices, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"beginCapture", nullptr, begin, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"cancelCapture", nullptr, cancel, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"captureState", nullptr, state, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"captureStats", nullptr, stats, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)

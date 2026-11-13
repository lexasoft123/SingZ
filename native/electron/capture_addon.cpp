#include "audio_export_bridge.h"
#if defined(SINGZ_BOX_LOOPZ_ROUTING)
#include "box_routing_bridge.h"
#include "../playback/box_routing_owner.h"
#include "../playback/box_input_capture.h"
#endif
#include <node_api.h>
#include <span>
#include <algorithm>

#include "native_audio_ownership.h"
#include "playback_addon_bridge.h"
#include "../playback/shared_audio_service.h"
#include "training_audio_session.h"
#include "voice_monitor_bridge.h"
#include "take_writer.h"
#include "../playback/take_conform.h"
#include "microphone_mix_bridge.h"
#include <zcore/audio/capture_recording.h>
#include <filesystem>

#include <zdsp/analysis/pitch_analysis_module.h>
#include <zcore/device/audio_input.h>
#include <zcore/device/audio_host.h>

#if defined(_WIN32)
#include <zcore/platform/windows/audio_host_windows_provider.h>
#endif

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
#include <unordered_map>

#if defined(__APPLE__)
#include <mach/mach_time.h>
#elif defined(_WIN32)
#include <windows.h>
#endif

namespace {

using zdsp::analysis::AnalysisWindow;

struct CaptureEvent {
  AnalysisWindow window;
  std::string detector;
  double inferenceMs = 0;
  bool harmonicCorrected = false;
};

struct EventBridge {
  napi_threadsafe_function events = nullptr;
  std::atomic<CaptureEvent*> latest{nullptr};
  std::atomic<bool> queued{false};
  std::atomic<uint64_t> dropped{0};
  std::atomic<uint64_t> overwritten{0};
};

// Both paths share analysis/recording/ownership semantics. The Box branch
// borrows LoopZ input history; ordinary Desktop retains its platform capture.
class CaptureInput {
 public:
  singz::AudioInputResult start(const singz::AudioInputConfig& config,
      singz::AudioInputSink sink, const std::vector<singz::AudioInputDevice>* inventory,
      std::span<const uint32_t> enabledChannels = {}) {
#if defined(SINGZ_BOX_LOOPZ_ROUTING)
    if (singz::boxRoutingOwnsCapture()) {
      if (!box_) box_ = std::make_unique<singz::BoxInputCapture>();
      return box_->start(config, std::move(sink), inventory, enabledChannels);
    }
#endif
    if (!normal_) normal_ = std::make_unique<singz::AudioInput>();
    return normal_->start(config, std::move(sink), inventory);
  }
  void stop(bool retain = false) {
#if defined(SINGZ_BOX_LOOPZ_ROUTING)
    if (box_) box_->stop(retain);
#endif
    if (normal_) normal_->stop(retain);
  }
#if defined(SINGZ_BOX_LOOPZ_ROUTING)
  singz::BoxInputMeter meter() const { return box_ ? box_->meter() : singz::BoxInputMeter{}; }
#endif
  singz::AudioInputStats stats() const {
#if defined(SINGZ_BOX_LOOPZ_ROUTING)
    if (box_) return box_->stats();
#endif
    return normal_ ? normal_->stats() : singz::AudioInputStats{};
  }
  singz::AudioInputState state() const {
#if defined(SINGZ_BOX_LOOPZ_ROUTING)
    if (box_) return box_->state();
#endif
    return normal_ ? normal_->state() : singz::AudioInputState::Idle;
  }
  std::string lastError() const {
#if defined(SINGZ_BOX_LOOPZ_ROUTING)
    if (box_) return box_->lastError();
#endif
    return normal_ ? normal_->lastError() : std::string{};
  }
 private:
  std::unique_ptr<singz::AudioInput> normal_;
#if defined(SINGZ_BOX_LOOPZ_ROUTING)
  std::unique_ptr<singz::BoxInputCapture> box_;
#endif
};
std::vector<singz::AudioInputDevice> captureInputDevices() {
#if defined(SINGZ_BOX_LOOPZ_ROUTING)
  if (singz::boxRoutingOwnsCapture()) return singz::boxRoutingInputDevices();
#endif
  return singz::sharedAudioService().inputDevices();
}
struct CaptureOwner {
  std::mutex mutex;
  std::unique_ptr<CaptureInput> input;
  std::unique_ptr<zdsp::analysis::PitchAnalysisModule> analyzer;
  EventBridge* bridge = nullptr;
  std::shared_ptr<singz::CaptureRecording> recording;
  singz::TakeWriter takeWriter;
  bool takePresent = false;
  uint64_t takeGeneration = 0;
  uint32_t sampleRate = 0;
  singz::AudioInputResult inputResult{};
  uint64_t generation = 0;
  uint64_t lastDroppedEvents = 0;
  uint64_t lastOverwrittenWindows = 0;
  singz::AudioInputStats lastStats{};
  singz::AudioInputState lastState = singz::AudioInputState::Idle;
  std::string lastError;
};

CaptureOwner owner;
singz::NativeAudioOwnership nativeAudioOwnership{true};

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

napi_value channelLabelsValue(napi_env env,
                              const std::vector<std::string>& source,
                              uint32_t count,
                              const char* fallbackPrefix) {
  napi_value labels;
  napi_create_array_with_length(env, count, &labels);
  for (uint32_t channel = 0; channel < count; ++channel) {
    const std::string fallback =
        std::string(fallbackPrefix) + " " + std::to_string(channel + 1);
    const std::string& label = channel < source.size() && !source[channel].empty()
                                   ? source[channel]
                                   : fallback;
    napi_set_element(env, labels, channel, stringValue(env, label));
  }
  return labels;
}

const char* qualityName(zdsp::CaptureTimestampQuality quality) {
  switch (quality) {
    case zdsp::CaptureTimestampQuality::Hardware: return "hardware";
    case zdsp::CaptureTimestampQuality::Estimated: return "estimated";
    case zdsp::CaptureTimestampQuality::Unknown: return "unknown";
  }
  return "unknown";
}

const char* qualityName(singz::AudioInputTimestampQuality q) {
  switch (q) {
    case singz::AudioInputTimestampQuality::Hardware: return "hardware";
    case singz::AudioInputTimestampQuality::CallbackEstimate: return "estimated";
    case singz::AudioInputTimestampQuality::Unknown: return "unknown";
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

void publishLatest(EventBridge* bridge, const AnalysisWindow& source,
                   const zdsp::analysis::PitchAnalysisModule& analyzer) {
  auto* copy = new CaptureEvent{source, analyzer.detectorName(), analyzer.inferenceMs(), analyzer.harmonicCorrected()};
  if (auto* replaced = bridge->latest.exchange(copy, std::memory_order_acq_rel)) {
    delete replaced;
    bridge->overwritten.fetch_add(1, std::memory_order_relaxed);
  }
  scheduleBridge(bridge);
}

void callJs(napi_env env, napi_value callback, void* context, void*) {
  auto* bridge = static_cast<EventBridge*>(context);
  std::unique_ptr<CaptureEvent> captured(
      bridge ? bridge->latest.exchange(nullptr, std::memory_order_acq_rel) : nullptr);
  if (bridge) bridge->queued.store(false, std::memory_order_release);
  if (!env || !callback || !captured) return;
  const auto* window = &captured->window;
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
  set(env, event, "detector", stringValue(env, captured->detector));
  set(env, event, "inferenceMs", numberValue(env, captured->inferenceMs));
  set(env, event, "harmonicCorrected", boolValue(env, captured->harmonicCorrected));
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

std::string getStringValue(napi_env env, napi_value value, size_t maxSize = 16) {
  napi_valuetype type = napi_undefined;
  size_t size = 0;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string ||
      napi_get_value_string_utf8(env, value, nullptr, 0, &size) != napi_ok ||
      size == 0 || size > maxSize)
    return {};
  std::string result(size + 1, '\0');
  if (napi_get_value_string_utf8(env, value, result.data(), result.size(),
                                 &size) != napi_ok)
    return {};
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
    owner.input->stop(!force);
    owner.lastStats = owner.input->stats();
    owner.lastState = owner.input->state();
    owner.lastError = owner.input->lastError();
  }
  if (owner.takePresent) owner.takeWriter.finish();
  owner.takeWriter.resetLevel();
  if (owner.bridge) {
    owner.lastDroppedEvents = owner.bridge->dropped.load(std::memory_order_relaxed);
    owner.lastOverwrittenWindows = owner.bridge->overwritten.load(std::memory_order_relaxed);
  }
  std::atomic_store(&owner.recording, std::shared_ptr<singz::CaptureRecording>{});
  owner.analyzer.reset();
  if (force) owner.input.reset();
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
  std::vector<singz::AudioInputDevice> rows;
  try { rows = captureInputDevices(); }
  catch (const std::exception& e) { error = e.what(); }
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

napi_value beginImpl(napi_env env, napi_callback_info info) {
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
  std::vector<uint32_t> enabledChannels;
  bool explicitChannels = false;
  napi_has_named_property(env, argv[0], "enabledChannels", &explicitChannels);
  if (explicitChannels) {
    napi_value value;
    napi_valuetype type;
    if (napi_get_named_property(env, argv[0], "enabledChannels", &value) == napi_ok &&
        napi_typeof(env, value, &type) == napi_ok && type == napi_undefined)
      explicitChannels = false;
  }
  if (explicitChannels) {
    bool supported = false;
#if defined(SINGZ_BOX_LOOPZ_ROUTING)
    supported = singz::boxRoutingOwnsCapture();
#endif
    if (!supported || !getExactU32Array(env, argv[0], "enabledChannels", &enabledChannels) ||
        !std::is_sorted(enabledChannels.begin(), enabledChannels.end()) ||
        std::adjacent_find(enabledChannels.begin(), enabledChannels.end()) != enabledChannels.end() ||
        !std::binary_search(enabledChannels.begin(), enabledChannels.end(), config.channel)) {
      napi_throw_type_error(env, nullptr, "enabledChannels requires Box and sorted unique physical channels including inputChannel");
      return undefined(env);
    }
    const auto inventory = captureInputDevices();
    const auto device = std::find_if(inventory.begin(), inventory.end(),
        [&](const auto& row) { return row.uid == config.deviceUid; });
    if (device == inventory.end() || enabledChannels.back() >= device->channels) {
      napi_throw_type_error(env, nullptr, "enabledChannels contains an unavailable physical channel");
      return undefined(env);
    }
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
  owner.sampleRate = 0;
  owner.inputResult = {};
  owner.takeWriter.resetCaptureTelemetry();
  const auto modelPath = getString(env, argv[0], "crepeModelPath");
  try {
    owner.analyzer = std::make_unique<zdsp::analysis::PitchAnalysisModule>(
        zdsp::analysis::PitchAnalysisConfig{
            modelPath.empty() ? zdsp::analysis::PitchDetectorKind::Yin
                              : zdsp::analysis::PitchDetectorKind::CrepeTiny,
            modelPath, generation});
  } catch (const std::exception& exception) {
    const std::string message = exception.what();
    stopLocked(generation, true);
    napi_value failed;
    napi_create_object(env, &failed);
    set(env, failed, "ok", boolValue(env, false));
    set(env, failed, "error", stringValue(env, message));
    return failed;
  }
  if (!owner.input) owner.input = std::make_unique<CaptureInput>();
  const auto inventory = captureInputDevices();
  const singz::AudioInputDevice* selectedDevice = nullptr;
  for (const auto& device : inventory) {
    if (device.uid == config.deviceUid) {
      selectedDevice = &device;
      break;
    }
  }
  const auto result = owner.input->start(config, [](const singz::AudioInputBlockView& block) {
    owner.takeWriter.append(block);
    auto* analyzer = owner.analyzer.get();
    if (!analyzer || !owner.bridge) return;
    if (auto recording = std::atomic_load(&owner.recording)) recording->append(block);
    analyzer->push(block, [analyzer](const AnalysisWindow& window) {
      if (owner.bridge) publishLatest(owner.bridge, window, *analyzer);
    });
  }, &inventory, enabledChannels);
  owner.sampleRate = static_cast<uint32_t>(result.sampleRate);
  owner.inputResult = result;
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

napi_value begin(napi_env env, napi_callback_info info) {
  try { return beginImpl(env, info); }
  catch (const std::exception& exception) {
    size_t argc = 3; napi_value args[3]{};
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    uint64_t generation = 0;
    if (argc > 1) (void)getExactU64(env, args[1], &generation);
    {
      std::lock_guard<std::mutex> lock(owner.mutex);
      if (generation && owner.generation == generation) stopLocked(generation, true);
      else if (generation) (void)nativeAudioOwnership.release(singz::NativeAudioOwnerKind::Capture, generation);
    }
    napi_value result;
    napi_create_object(env, &result);
    set(env, result, "ok", boolValue(env, false));
    set(env, result, "error", stringValue(env, exception.what()));
    return result;
  }
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
  const auto level = owner.takeWriter.level();
  napi_value inputLevel;
  napi_create_object(env, &inputLevel);
  set(env, inputLevel, "peakDb", numberValue(env, level.peakDb));
  set(env, inputLevel, "rmsDb", numberValue(env, level.rmsDb));
  set(env, result, "inputLevel", inputLevel);
  set(env, result, "sampleRate", uintValue(env, owner.sampleRate));
  // Capture timestamps already refer to the first sample. Buffer duration is
  // separate telemetry; subtracting it here would compensate it twice.
  const bool inputLatencyStable = owner.inputResult.inputLatencySource == "reported" &&
      (!owner.inputResult.inputLatencyStable ||
       owner.inputResult.inputLatencyStable->load(std::memory_order_acquire));
  set(env, result, "inputLatencyFrames", uintValue(env, owner.inputResult.inputLatencyFrames));
  set(env, result, "inputBufferFrames", uintValue(env, owner.inputResult.inputBufferFrames));
  set(env, result, "inputLatencyStable", boolValue(env, inputLatencyStable));
  set(env, result, "inputLatencySource", stringValue(env,
      inputLatencyStable ? "reported" : "unknown"));
  const auto gaps = owner.takeWriter.gapStats();
  setU64(env, result, "gapPaddedFrames", gaps.gapPaddedFrames);
  setU64(env, result, "gapPaddedBlocks", gaps.gapPaddedBlocks);
  setU64(env, result, "gapUntrustedTimestampBlocks", gaps.gapUntrustedTimestampBlocks);
  setU64(env, result, "gapRegressions", gaps.gapRegressions);
  set(env, result, "gapOverflow", boolValue(env, gaps.gapOverflow));
  setU64(env, result, "lastSampleHostNs", owner.takeWriter.lastSampleHostNs());
  const auto frameStamp = owner.takeWriter.frameStamp();
  setU64(env, result, "takeFrameHostNs", frameStamp.hostNs);
  setU64(env, result, "takeFrame", frameStamp.takeFrame);
  const auto firstSample = owner.takeWriter.firstSample();
  set(env, result, "firstSampleCaptured", boolValue(env, owner.takePresent && firstSample.captured));
  setU64(env, result, "firstSampleHostNs", firstSample.hostNs);
  set(env, result, "firstSampleQuality", stringValue(env, qualityName(firstSample.quality)));
  set(env, result, "takeActive", boolValue(env, owner.takeWriter.active()));
  set(env, result, "takeCompleted", boolValue(env, owner.takePresent && owner.takeWriter.completed()));
  setU64(env, result, "deliveredBlocks", value.deliveredBlocks);
  setU64(env, result, "deliveredFrames", value.deliveredFrames);
  setU64(env, result, "overruns", value.overruns);
  setU64(env, result, "deliveryWakeups", value.deliveryWakeups);
  setU64(env, result, "renderSliceDrops", value.renderSliceDrops);
  setU64(env, result, "droppedEvents", owner.bridge
      ? owner.bridge->dropped.load(std::memory_order_relaxed)
      : owner.lastDroppedEvents);
  setU64(env, result, "overwrittenWindows", owner.bridge
      ? owner.bridge->overwritten.load(std::memory_order_relaxed)
      : owner.lastOverwrittenWindows);
#if defined(SINGZ_BOX_LOOPZ_ROUTING)
  if (singz::boxRoutingOwnsCapture()) {
    const auto levels = owner.input ? owner.input->meter() : singz::BoxInputMeter{};
    napi_value meter, peak, rms;
    napi_create_object(env, &meter);
    set(env, meter, "valid", boolValue(env, levels.valid));
    set(env, meter, "channels", uintValue(env, levels.channels));
    setU64(env, meter, "ownershipGeneration", owner.generation);
    napi_create_array_with_length(env, levels.channels, &peak);
    napi_create_array_with_length(env, levels.channels, &rms);
    for (uint32_t channel = 0; channel < levels.channels; ++channel) {
      napi_set_element(env, peak, channel, numberValue(env, levels.peak[channel]));
      napi_set_element(env, rms, channel, numberValue(env, levels.rms[channel]));
    }
    if (levels.channels) {
      napi_value indices;
      napi_create_array_with_length(env, levels.channels, &indices);
      for (uint32_t channel = 0; channel < levels.channels; ++channel)
        napi_set_element(env, indices, channel, uintValue(env, levels.channelIndices[channel]));
      set(env, meter, "channelIndices", indices);
    }
    set(env, meter, "peak", peak); set(env, meter, "rms", rms);
    set(env, result, "microphoneLevels", meter);
  }
#endif
  return result;
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

std::unique_ptr<singz::AudioHostBackend> playbackBackend(
    const std::string& provider, std::string* unavailableReason) {
  if (unavailableReason) unavailableReason->clear();
#if defined(SINGZ_BOX_LOOPZ_ROUTING)
  if (singz::boxRoutingInitialized()) return singz::boxRoutingPlaybackBackend();
#endif
#if defined(_WIN32)
  singz::WindowsAudioHostProvider selected;
  if (provider == "wasapi") {
    selected = singz::WindowsAudioHostProvider::Wasapi;
  } else if (provider == "asio") {
    selected = singz::WindowsAudioHostProvider::Asio;
  } else {
    if (unavailableReason)
      *unavailableReason = "The requested provider is not a Windows audio provider";
    return nullptr;
  }
  const auto status = singz::probeWindowsAudioHostProvider(selected);
  if (!status.available) {
    if (unavailableReason) *unavailableReason = status.detail;
    return nullptr;
  }
  return singz::createWindowsAudioHostBackend(selected);
#elif defined(__APPLE__)
  if (provider == "coreaudio") return singz::createPlatformAudioHostBackend();
  if (unavailableReason)
    *unavailableReason = "The requested provider is not available on macOS";
  return nullptr;
#elif defined(__linux__) && !defined(__ANDROID__)
  if (provider == "alsa") return singz::createPlatformAudioHostBackend();
  if (unavailableReason) *unavailableReason = "The requested provider is not available on Linux";
  return nullptr;
#else
  (void)provider;
  if (unavailableReason)
    *unavailableReason = "Native desktop audio providers are unavailable on this platform";
  return nullptr;
#endif
}

void appendProvider(napi_env env, napi_value providers, uint32_t index,
                    const char* id, const char* label, bool available,
                    const char* errorCode, const std::string& detail) {
  napi_value row;
  napi_create_object(env, &row);
  set(env, row, "id", stringValue(env, id));
  set(env, row, "label", stringValue(env, label));
  set(env, row, "available", boolValue(env, available));
  set(env, row, "errorCode", stringValue(env, errorCode));
  set(env, row, "detail", stringValue(env, detail));
  napi_set_element(env, providers, index, row);
}

napi_value audioHostProviders(napi_env env, napi_callback_info) {
  napi_value providers;
  napi_create_array_with_length(env, 3, &providers);
#if defined(_WIN32)
  appendProvider(env, providers, 0, "coreaudio", "CoreAudio", false,
                 "wrong-platform", "Available only on macOS");
  const auto wasapi = singz::probeWindowsAudioHostProvider(
      singz::WindowsAudioHostProvider::Wasapi);
  appendProvider(env, providers, 1, "wasapi", "WASAPI", wasapi.available,
                 wasapi.available ? "none" : "runtime-unavailable",
                 wasapi.detail);
  const auto asio = singz::probeWindowsAudioHostProvider(
      singz::WindowsAudioHostProvider::Asio);
  const char* asioError = asio.available ? "none"
      : asio.error == singz::WindowsAudioHostProviderError::NotCompiled
          ? "not-compiled" : "runtime-unavailable";
  appendProvider(env, providers, 2, "asio", "ASIO", asio.available,
                 asioError, asio.detail);
#elif defined(__APPLE__)
  appendProvider(env, providers, 0, "coreaudio", "CoreAudio", true, "none",
                 "Native macOS AudioHost output");
  appendProvider(env, providers, 1, "wasapi", "WASAPI", false,
                 "wrong-platform", "Available only on Windows");
  appendProvider(env, providers, 2, "asio", "ASIO", false,
                 "wrong-platform", "ASIO is available only on Windows");
#else
  appendProvider(env, providers, 0, "coreaudio", "CoreAudio", false,
                 "wrong-platform", "Available only on macOS");
  appendProvider(env, providers, 1, "wasapi", "WASAPI", false,
                 "wrong-platform", "Available only on Windows");
  appendProvider(env, providers, 2, "asio", "ASIO", false,
                 "wrong-platform", "ASIO is available only on Windows");
#endif
#if defined(__linux__) && !defined(__ANDROID__)
  appendProvider(env, providers, 3, "alsa", "ALSA", true, "none",
                 "Direct Linux ALSA PCM with exclusive endpoint ownership");
#endif
  return providers;
}

napi_value audioHostDevices(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1]{};
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  const std::string requestedProvider = argc == 1 ? getStringValue(env, argv[0]) : "";
  std::string provider;
  singz::AudioHostInventory inventory;
  bool providerScoped = !requestedProvider.empty();
  if (providerScoped && requestedProvider == singz::sharedAudioService().providerId()) {
    provider = requestedProvider;
    inventory = singz::sharedAudioService().inventory();
  } else if (providerScoped) {
    // Alternate provider inventories are revalidated after the shared service
    // publishes a reconfiguration revision, rather than on each Settings read.
    static std::unordered_map<std::string,std::pair<uint64_t,singz::AudioHostInventory>> alternate;
    const uint64_t revision = singz::sharedAudioService().inventoryRevision();
    const auto cached = alternate.find(requestedProvider);
    if (cached != alternate.end() && cached->second.first == revision) {
      inventory = cached->second.second;
      provider = requestedProvider;
    } else {
    std::string unavailableReason;
    std::unique_ptr<singz::AudioHostBackend> backend =
        playbackBackend(requestedProvider, &unavailableReason);
    if (!backend) {
      napi_value failed;
      napi_create_object(env, &failed);
      set(env, failed, "ok", boolValue(env, false));
      set(env, failed, "provider", stringValue(env, requestedProvider));
      set(env, failed, "defaultInputUid", stringValue(env, ""));
      set(env, failed, "defaultOutputUid", stringValue(env, ""));
      napi_value empty;
      napi_create_array_with_length(env, 0, &empty);
      set(env, failed, "devices", empty);
      set(env, failed, "error", stringValue(env, unavailableReason));
      return failed;
    }
    singz::AudioHost host(std::move(backend));
    inventory = host.enumerate();
    provider = requestedProvider;
    alternate[provider] = {revision,inventory};
    }
  } else {
    inventory = singz::sharedAudioService().inventory();
#if defined(_WIN32)
    provider = "wasapi";
#elif defined(__APPLE__)
    provider = "coreaudio";
#elif defined(__linux__) && !defined(__ANDROID__)
    provider = "alsa";
#else
    provider = "wasapi";
#endif
  }
  const auto exposedUid = [&](const std::string& uid) {
#if defined(_WIN32)
    return providerScoped && !uid.empty() ? provider + ":" + uid : uid;
#else
    return uid;
#endif
  };
  napi_value result;
  napi_create_object(env, &result);
  set(env, result, "ok", boolValue(env, true));
  set(env, result, "provider", stringValue(env, provider));
  set(env, result, "defaultInputUid",
      stringValue(env, exposedUid(inventory.defaultInputUid)));
  set(env, result, "defaultOutputUid",
      stringValue(env, exposedUid(inventory.defaultOutputUid)));
  napi_value devices;
  napi_create_array_with_length(env, inventory.devices.size(), &devices);
  for (size_t index = 0; index < inventory.devices.size(); ++index) {
    const singz::AudioHostDeviceInfo& source = inventory.devices[index];
    napi_value device;
    napi_create_object(env, &device);
    set(env, device, "uid", stringValue(env, exposedUid(source.uid)));
    set(env, device, "label", stringValue(env, source.label));
    set(env, device, "defaultInput", boolValue(env, source.defaultInput));
    set(env, device, "defaultOutput", boolValue(env, source.defaultOutput));
    set(env, device, "inputChannels", uintValue(env, source.inputChannels));
    set(env, device, "outputChannels", uintValue(env, source.outputChannels));
    set(env, device, "inputChannelLabels",
        channelLabelsValue(env, source.inputChannelLabels,
                           source.inputChannels, "Input"));
    set(env, device, "outputChannelLabels",
        channelLabelsValue(env, source.outputChannelLabels,
                           source.outputChannels, "Output"));
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

napi_value captureRecording(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3]{};
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  uint64_t generation = 0;
  napi_value result;
  napi_create_object(env, &result);
  std::lock_guard<std::mutex> lock(owner.mutex);
  if (argc != 3 || !getExactU64(env, argv[2], &generation) || generation != owner.generation) {
    set(env, result, "ok", boolValue(env, false));
    set(env, result, "error", stringValue(env, "The microphone session is no longer active"));
    return result;
  }
  const std::string action = getStringValue(env, argv[0]);
  try {
    if (action == "record" && argc == 3) {
      size_t pathSize = 0;
      napi_get_value_string_utf8(env, argv[1], nullptr, 0, &pathSize);
      std::string path(pathSize + 1, '\0');
      napi_get_value_string_utf8(env, argv[1], path.data(), path.size(), &pathSize);
      path.resize(pathSize);
      if (!singz::CaptureRecording::validName(std::filesystem::path(path).filename().string()))
        throw std::runtime_error("Invalid microphone recording filename");
      if (std::atomic_load(&owner.recording))
        throw std::runtime_error("A microphone recording is already active");
      auto recording = std::make_shared<singz::CaptureRecording>();
      recording->filename = path;
      std::atomic_store(&owner.recording, recording);
      set(env, result, "state", stringValue(env, "recording"));
    } else if (action == "finish") {
      auto recording = std::atomic_exchange(&owner.recording, std::shared_ptr<singz::CaptureRecording>{});
      if (!recording) throw std::runtime_error("No microphone recording is active");
      const double duration = recording->save(recording->filename);
      set(env, result, "state", stringValue(env, "finished"));
      set(env, result, "path", stringValue(env, recording->filename));
      set(env, result, "durationSeconds", numberValue(env, duration));
      set(env, result, "seconds", numberValue(env, duration));
      set(env, result, "sampleRate", numberValue(env, recording->rate));
      set(env, result, "filename", stringValue(env, std::filesystem::path(recording->filename).filename().string()));
    } else throw std::runtime_error("Invalid microphone recording command");
    set(env, result, "ok", boolValue(env, true));
  } catch (const std::exception& exception) {
    set(env, result, "ok", boolValue(env, false));
    set(env, result, "state", stringValue(env, "error"));
    set(env, result, "error", stringValue(env, exception.what()));
  }
  return result;
}

// Voice takes are separate from training's bounded RAM CaptureRecording.
napi_value takeResult(napi_env env, const singz::TakeWriteResult& r) {
  napi_value result;
  napi_create_object(env, &result);
  set(env, result, "ok", boolValue(env, r.error.empty()));
  set(env, result, "path", stringValue(env, r.path));
  // Existing capture timestamps are decimal strings to preserve uint64 precision.
  setU64(env, result, "firstSampleHostNs", r.firstSampleHostNs);
  set(env, result, "frames", numberValue(env, static_cast<double>(r.frames)));
  set(env, result, "sampleRate", uintValue(env, r.sampleRate));
  set(env, result, "firstSampleQuality", stringValue(env, qualityName(r.firstSampleQuality)));
  set(env, result, "droppedBlocks", numberValue(env, static_cast<double>(r.droppedBlocks)));
  set(env, result, "gapPaddedFrames", numberValue(env, static_cast<double>(r.gapPaddedFrames)));
  set(env, result, "gapPaddedBlocks", numberValue(env, static_cast<double>(r.gapPaddedBlocks)));
  set(env, result, "gapUntrustedTimestampBlocks", numberValue(env, static_cast<double>(r.gapUntrustedTimestampBlocks)));
  set(env, result, "gapRegressions", numberValue(env, static_cast<double>(r.gapRegressions)));
  set(env, result, "gapOverflow", boolValue(env, r.gapOverflow));
  set(env, result, "deviceLost", boolValue(env, r.deviceLost));
  if (r.deviceLost) set(env, result, "reason", stringValue(env, "device-lost"));
  if (!r.error.empty()) {
    set(env, result, "reason", stringValue(env, "error"));
    set(env, result, "error", stringValue(env, r.error));
    set(env, result, "message", stringValue(env, r.error));
  }
  return result;
}
napi_value takeError(napi_env env, const char* reason, const std::string& message) {
  napi_value result;
  napi_create_object(env, &result);
  set(env, result, "ok", boolValue(env, false));
  set(env, result, "reason", stringValue(env, reason));
  set(env, result, "error", stringValue(env, message));
  set(env, result, "message", stringValue(env, message));
  return result;
}
napi_value recordTake(napi_env env, napi_callback_info info) {
  size_t argc = 3; napi_value argv[3]{};
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  std::lock_guard<std::mutex> lock(owner.mutex);
  uint64_t generation = 0;
  if (!owner.input || owner.input->state() != singz::AudioInputState::Running)
    return takeError(env, "no-input", "No microphone input is open");
  if (argc != 3 || !getExactU64(env, argv[2], &generation) || generation != owner.generation)
    return takeError(env, "error", "The microphone session is no longer active");
  if (owner.takePresent) return takeError(env, "busy", "A voice take is already active or awaiting finish");
  try {
    auto* input = owner.input.get();
    owner.takeWriter.start(getStringValue(env, argv[0], 32768), getStringValue(env, argv[1], 128), owner.sampleRate,
        [input] { return input->state() != singz::AudioInputState::Running; });
    owner.takePresent = true; owner.takeGeneration = generation;
    napi_value result;
    napi_create_object(env, &result);
    set(env, result, "ok", boolValue(env, true));
    return result;
  } catch (const std::exception& e) { return takeError(env, "error", e.what()); }
}
napi_value finishTake(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1]{};
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  std::lock_guard<std::mutex> lock(owner.mutex);
  uint64_t generation = 0;
  if (argc != 1 || !getExactU64(env, argv[0], &generation) ||
      !owner.takePresent || generation != owner.takeGeneration)
    return takeError(env, "error", "No voice take exists for this microphone session");
  const auto result = owner.takeWriter.finish();
  owner.takePresent = false; owner.takeGeneration = 0;
  return takeResult(env, result);
}
napi_value cancelTake(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1]{};
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  std::lock_guard<std::mutex> lock(owner.mutex);
  uint64_t generation = 0;
  const bool matched = argc == 1 && getExactU64(env, argv[0], &generation) &&
      owner.takePresent && generation == owner.takeGeneration;
  try {
    if (matched) { owner.takeWriter.cancel(); owner.takePresent = false; owner.takeGeneration = 0; }
    napi_value result;
    napi_create_object(env, &result);
    set(env, result, "ok", boolValue(env, true));
    set(env, result, "cancelled", boolValue(env, matched));
    return result;
  } catch (const std::exception& e) { return takeError(env, "error", e.what()); }
}

// Offline jobs run on libuv workers in the audio utility process. Cancellation
// never takes the capture owner mutex and is checked once per DSP block.
struct ConformJob {
  napi_env env{}; napi_async_work work{}; napi_deferred deferred{};
  std::string id, inputPath, outputPath, error, errorCode;
  singz::TakeConformRequest request;
  std::shared_ptr<std::atomic<bool>> cancelled;
  uint64_t frames{0}; uint32_t inputLatency{0}, outputLatency{0}; bool registered{false}, outputComplete{false};
};
std::mutex conformMutex;
std::unordered_map<std::string, std::shared_ptr<std::atomic<bool>>> conformJobs;
napi_value conformProperty(napi_env env, napi_value obj, const char *name) {
  napi_value v{};
  if (napi_get_named_property(env, obj, name, &v) != napi_ok) throw std::runtime_error("Missing conform property");
  return v;
}
double conformNumber(napi_env env, napi_value obj, const char *name) {
  double value = 0;
  if (napi_get_value_double(env, conformProperty(env, obj, name), &value) != napi_ok || !std::isfinite(value))
    throw std::runtime_error("Invalid conform number");
  return value;
}
uint64_t conformFrame(napi_env env, napi_value obj, const char *name) {
  const double n = conformNumber(env, obj, name);
  if (n < 0 || n > 9007199254740991.0 || std::floor(n) != n) throw std::runtime_error("Invalid conform frame");
  return static_cast<uint64_t>(n);
}
bool conformBool(napi_env env, napi_value obj, const char *name) {
  bool value{};
  if (napi_get_value_bool(env, conformProperty(env, obj, name), &value) != napi_ok) throw std::runtime_error("Invalid conform boolean");
  return value;
}
template<class F> void conformArray(napi_env env, napi_value obj, const char *name, uint32_t max, F item) {
  auto v = conformProperty(env, obj, name); bool array = false; uint32_t length = 0;
  if (napi_is_array(env, v, &array) != napi_ok || !array || napi_get_array_length(env, v, &length) != napi_ok || length > max)
    throw std::runtime_error("Invalid conform array");
  for (uint32_t i = 0; i < length; ++i) { napi_value row{}; if (napi_get_element(env, v, i, &row) != napi_ok) throw std::runtime_error("Invalid conform row"); item(row); }
}
napi_value conformTake(napi_env env, napi_callback_info info) {
  size_t argc = 4; napi_value argv[4]{}; napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  auto job = std::make_unique<ConformJob>(); job->env = env;
  try {
    if (argc != 4) throw std::runtime_error("conformTake requires input, output, request and job id");
    job->inputPath = getStringValue(env, argv[0], 32768); job->outputPath = getStringValue(env, argv[1], 32768);
    job->id = getStringValue(env, argv[3], 128);
    if (job->id.empty() || job->inputPath.empty() || job->outputPath.empty() || job->inputPath == job->outputPath ||
      job->inputPath.find('\0') != std::string::npos || job->outputPath.find('\0') != std::string::npos)
      throw std::runtime_error("Invalid conform paths/id");
    auto &r = job->request; const auto config = argv[2];
    const auto rate = conformFrame(env, config, "outputRate");
    if (rate < 8000 || rate > 192000) throw std::runtime_error("Invalid conform output rate");
    r.outputRate = static_cast<uint32_t>(rate);
    r.songDurationProjectFrames = conformFrame(env, config, "songDurationProjectFrames");
    r.startPositionSec = conformNumber(env, config, "startPositionSec"); r.userOffsetSec = conformNumber(env, config, "userOffsetSec");
    conformArray(env, config, "anchors", 20000, [&](napi_value a) { r.anchors.push_back({conformFrame(env, a, "takeFrame"), conformNumber(env, a, "projectFrame")}); });
    conformArray(env, config, "settings", 20000, [&](napi_value s) { r.settings.push_back({conformFrame(env, s, "takeFrame"), conformNumber(env, s, "transposeSemitones")}); });
    conformArray(env, config, "effects", 16, [&](napi_value e) {
      auto params = conformProperty(env, e, "params");
      r.effects.push_back({getStringValue(env, conformProperty(env, e, "id"), 32), conformBool(env, e, "enabled"),
        conformNumber(env, params, "manualOffsetSemitones"), conformBool(env, params, "preserveFormants")});
    });
    job->cancelled = std::make_shared<std::atomic<bool>>(false);
    { std::lock_guard lock(conformMutex);
      if (conformJobs.size() >= 4 || conformJobs.count(job->id)) throw std::runtime_error("Conform queue full or duplicate id");
      conformJobs.emplace(job->id, job->cancelled); job->registered = true;
    }
    napi_value promise{}, resource{};
    if (napi_create_promise(env, &job->deferred, &promise) != napi_ok) throw std::runtime_error("Could not create conform promise");
    napi_create_string_utf8(env, "offlineTakeConform", NAPI_AUTO_LENGTH, &resource);
    const auto created = napi_create_async_work(env, nullptr, resource,
      [](napi_env, void *data) {
        auto *j = static_cast<ConformJob *>(data);
        try {
          auto result = singz::conformTakeFile(j->inputPath, j->outputPath, j->request, j->cancelled.get());
          if (j->cancelled->load()) { std::error_code ignored; std::filesystem::remove(std::filesystem::path(std::u8string(j->outputPath.begin(), j->outputPath.end())), ignored); throw singz::TakeConformError(singz::TakeConformFailure::Cancelled,"Take conform cancelled"); }
          j->outputComplete = true;
          j->frames = result.durationFrames; j->inputLatency = result.inputLatencyFrames; j->outputLatency = result.outputLatencyFrames;
        } catch (const singz::TakeConformError &e) { j->error = e.what(); j->errorCode = singz::takeConformFailureCode(e.code()); }
        catch (const std::exception &e) { j->error = e.what(); j->errorCode = "conform-error"; }
      }, [](napi_env env, napi_status status, void *data) {
        std::unique_ptr<ConformJob> j(static_cast<ConformJob *>(data));
        { std::lock_guard lock(conformMutex); conformJobs.erase(j->id); }
        if (status != napi_ok && j->error.empty()) j->error = "Take conform worker cancelled";
        napi_value result{}; napi_create_object(env, &result);
        set(env, result, "ok", boolValue(env, j->error.empty() && !j->cancelled->load()));
        set(env, result, "error", stringValue(env, j->cancelled->load() ? "Take conform cancelled" : j->error));
        if (j->cancelled->load() && j->outputComplete) { std::error_code ignored; std::filesystem::remove(std::filesystem::path(std::u8string(j->outputPath.begin(), j->outputPath.end())), ignored); }
        if (j->cancelled->load() || status != napi_ok) j->errorCode = "cancelled";
        if (!j->errorCode.empty()) {
          set(env, result, "errorCode", stringValue(env, j->errorCode));
          set(env, result, "detail", stringValue(env, j->cancelled->load() ? "Take conform cancelled" : j->error));
        }
        set(env, result, "durationFrames", numberValue(env, static_cast<double>(j->frames)));
        set(env, result, "inputLatencyFrames", uintValue(env, j->inputLatency)); set(env, result, "outputLatencyFrames", uintValue(env, j->outputLatency));
        napi_resolve_deferred(env, j->deferred, result); napi_delete_async_work(env, j->work);
      }, job.get(), &job->work);
    if (created != napi_ok || napi_queue_async_work(env, job->work) != napi_ok) throw std::runtime_error("Could not queue conform worker");
    job.release(); return promise;
  } catch (const std::exception &e) {
    if (job->registered) { std::lock_guard lock(conformMutex); conformJobs.erase(job->id); }
    if (job->work) napi_delete_async_work(env, job->work);
    napi_throw_error(env, "conform-error", e.what()); return nullptr;
  }
}
napi_value cancelTakeConform(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1]{}; napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc != 1) { napi_throw_error(env, nullptr, "cancelTakeConform requires a job id"); return nullptr; }
  const auto id = getStringValue(env, argv[0], 128);
  std::lock_guard lock(conformMutex); const auto found = conformJobs.find(id);
  if (found != conformJobs.end()) found->second->store(true);
  napi_value result{}; napi_get_undefined(env, &result); return result;
}

void cleanup(void*) {
  if (!singz::cleanupVoiceMonitor()) return; // Other N-API environments still own shared hosts.
  singz::cleanupMicrophoneMix();
  singz::cleanupTrainingAudio();
  singz::cleanupPlaybackBridge();
  std::lock_guard<std::mutex> lock(owner.mutex);
  stopLocked(owner.generation, true);
  singz::sharedAudioService().shutdown();
#if defined(SINGZ_BOX_LOOPZ_ROUTING)
  singz::shutdownBoxRouting();
#endif
}

napi_value init(napi_env env, napi_value exports) {
  singz::defineAudioExport(env, exports);
  singz::defineVoiceMonitorExports(env, exports, &nativeAudioOwnership);
#if defined(SINGZ_BOX_LOOPZ_ROUTING)
  singz::defineBoxRoutingExports(env, exports);
#endif
  singz::defineMicrophoneMixExports(env, exports, &nativeAudioOwnership);
  singz::defineTrainingAudioExports(env, exports, &nativeAudioOwnership, playbackBackend);
  napi_add_env_cleanup_hook(env, cleanup, nullptr);
  napi_property_descriptor properties[] = {
      {"inputDevices", nullptr, devices, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"beginCapture", nullptr, begin, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"cancelCapture", nullptr, cancel, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"captureState", nullptr, state, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"recordTake", nullptr, recordTake, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"conformTake", nullptr, conformTake, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"cancelTakeConform", nullptr, cancelTakeConform, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"finishTake", nullptr, finishTake, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"cancelTake", nullptr, cancelTake, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"captureRecording", nullptr, captureRecording, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"captureStats", nullptr, stats, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"audioHostProviders", nullptr, audioHostProviders, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"audioHostDevices", nullptr, audioHostDevices, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  singz::definePlaybackExports(env, exports, &nativeAudioOwnership,
                               playbackBackend);
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

#include "playback_addon_bridge.h"

#include "native_audio_ownership.h"

#include <native_playback_session.h>

#include <algorithm>
#include <charconv>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <initializer_list>
#include <limits>
#include <mutex>
#include <string>
#include <utility>
#include <vector>

#if defined(_WIN32)
#include <fcntl.h>
#include <io.h>
#else
#include <fcntl.h>
#include <unistd.h>
#endif

namespace singz {
namespace {

struct DesktopPlaybackOwner {
  std::mutex mutex;
  NativePlaybackSession session;
  NativeAudioOwnership *ownership{nullptr};
  DesktopPlaybackBackendFactory backendFactory{nullptr};
  uint64_t generation{0};
  uint64_t handoffLease{0};
  std::string provider;
};

DesktopPlaybackOwner playback;

napi_value makeUndefined(napi_env env) {
  napi_value value{};
  napi_get_undefined(env, &value);
  return value;
}

napi_value makeNull(napi_env env) {
  napi_value value{};
  napi_get_null(env, &value);
  return value;
}

napi_value makeString(napi_env env, const std::string &text) {
  napi_value value{};
  napi_create_string_utf8(env, text.c_str(), text.size(), &value);
  return value;
}

napi_value makeNumber(napi_env env, double number) {
  napi_value value{};
  napi_create_double(env, number, &value);
  return value;
}

napi_value makeBool(napi_env env, bool value) {
  napi_value result{};
  napi_get_boolean(env, value, &result);
  return result;
}

void setValue(napi_env env, napi_value object, const char *name,
              napi_value value) {
  napi_set_named_property(env, object, name, value);
}

void setCounter(napi_env env, napi_value object, const char *name,
                uint64_t value) {
  setValue(env, object, name, makeString(env, std::to_string(value)));
}

void setSignedCounter(napi_env env, napi_value object, const char *name,
                      int64_t value) {
  setValue(env, object, name, makeString(env, std::to_string(value)));
}

const char *playbackStateName(NativePlaybackState state) noexcept {
  switch (state) {
  case NativePlaybackState::Unloaded:
    return "unloaded";
  case NativePlaybackState::Preparing:
    return "preparing";
  case NativePlaybackState::Prepared:
    return "prepared";
  case NativePlaybackState::OutputOpen:
    return "output-open";
  case NativePlaybackState::Running:
    return "running";
  case NativePlaybackState::Stopped:
    return "stopped";
  case NativePlaybackState::Terminal:
    return "terminal";
  case NativePlaybackState::Quarantined:
    return "quarantined";
  }
  return "quarantined";
}

const char *hostStateName(AudioHostState state) noexcept {
  switch (state) {
  case AudioHostState::Closed:
    return "closed";
  case AudioHostState::Open:
    return "open";
  case AudioHostState::Running:
    return "running";
  case AudioHostState::Stopped:
    return "stopped";
  case AudioHostState::DeviceLost:
    return "device-lost";
  case AudioHostState::Error:
    return "error";
  case AudioHostState::Unsupported:
    return "unsupported";
  case AudioHostState::Suspended:
    return "suspended";
  }
  return "error";
}

const char *transportStateName(NativePlaybackTransportState state) noexcept {
  switch (state) {
  case NativePlaybackTransportState::Stopped:
    return "stopped";
  case NativePlaybackTransportState::PreRoll:
    return "pre-roll";
  case NativePlaybackTransportState::Playing:
    return "playing";
  case NativePlaybackTransportState::Paused:
    return "paused";
  case NativePlaybackTransportState::Completed:
    return "completed";
  }
  return "stopped";
}

const char *telemetryQualityName(
    NativePlaybackTransportTelemetryQuality quality) noexcept {
  switch (quality) {
  case NativePlaybackTransportTelemetryQuality::Unavailable:
    return "unavailable";
  case NativePlaybackTransportTelemetryQuality::Initial:
    return "initial";
  case NativePlaybackTransportTelemetryQuality::Current:
    return "current";
  case NativePlaybackTransportTelemetryQuality::LastGood:
    return "lastGood";
  }
  return "unavailable";
}

const char *audibleProjectionQualityName(
    NativePlaybackAudibleProjectionQuality quality) noexcept {
  switch (quality) {
  case NativePlaybackAudibleProjectionQuality::Unavailable:
    return "unavailable";
  case NativePlaybackAudibleProjectionQuality::Current:
    return "current";
  }
  return "unavailable";
}

const char *boundaryName(NativePlaybackTransportBoundaryReason reason) noexcept {
  switch (reason) {
  case NativePlaybackTransportBoundaryReason::None:
    return "none";
  case NativePlaybackTransportBoundaryReason::StreamGenerationChanged:
    return "stream-generation-changed";
  case NativePlaybackTransportBoundaryReason::SequenceGap:
    return "sequence-gap";
  case NativePlaybackTransportBoundaryReason::SampleRateChanged:
    return "sample-rate-changed";
  case NativePlaybackTransportBoundaryReason::RouteGenerationChanged:
    return "route-generation-changed";
  case NativePlaybackTransportBoundaryReason::TimestampQualityChanged:
    return "timestamp-quality-changed";
  case NativePlaybackTransportBoundaryReason::ClockReanchored:
    return "clock-reanchored";
  case NativePlaybackTransportBoundaryReason::SourceSeek:
    return "source-seek";
  case NativePlaybackTransportBoundaryReason::SourceLoop:
    return "source-loop";
  case NativePlaybackTransportBoundaryReason::DeviceLost:
    return "device-lost";
  case NativePlaybackTransportBoundaryReason::SourceFrameOverflow:
    return "source-frame-overflow";
  }
  return "none";
}

const char *graphNodeRoleName(NativePlaybackGraphNodeRole role) noexcept {
  switch (role) {
  case NativePlaybackGraphNodeRole::Input:
    return "input";
  case NativePlaybackGraphNodeRole::Processor:
    return "processor";
  case NativePlaybackGraphNodeRole::Output:
    return "output";
  }
  return nullptr;
}

const char *graphNodeKindName(NativePlaybackGraphNodeKind kind) noexcept {
  switch (kind) {
  case NativePlaybackGraphNodeKind::Unknown:
    return "unknown";
  case NativePlaybackGraphNodeKind::PhysicalOutput:
    return "physical-output";
  case NativePlaybackGraphNodeKind::DecodedSource:
    return "decoded-source";
  case NativePlaybackGraphNodeKind::ChannelMap:
    return "channel-map";
  case NativePlaybackGraphNodeKind::Gain:
    return "gain";
  case NativePlaybackGraphNodeKind::Mix:
    return "mix";
  case NativePlaybackGraphNodeKind::ScheduledGain:
    return "scheduled-gain";
  case NativePlaybackGraphNodeKind::SignalsmithTimePitch:
    return "signalsmith-time-pitch";
  case NativePlaybackGraphNodeKind::ScheduledCueSource:
    return "scheduled-cue-source";
  case NativePlaybackGraphNodeKind::PeakRms:
    return "peak-rms";
  case NativePlaybackGraphNodeKind::Tap:
    return "tap";
  case NativePlaybackGraphNodeKind::Oscillator:
    return "oscillator";
  case NativePlaybackGraphNodeKind::SafetyLimiter:
    return "safety-limiter";
  case NativePlaybackGraphNodeKind::UnavailableBypass:
    return "unavailable-bypass";
  case NativePlaybackGraphNodeKind::UnavailableSilence:
    return "unavailable-silence";
  }
  return nullptr;
}

const char *terminalReasonName(AudioHostTerminalReason reason) noexcept {
  switch (reason) {
  case AudioHostTerminalReason::None:
    return "none";
  case AudioHostTerminalReason::DeviceLost:
    return "device-lost";
  case AudioHostTerminalReason::RouteChanged:
    return "route-changed";
  case AudioHostTerminalReason::Interrupted:
    return "interrupted";
  case AudioHostTerminalReason::MediaServicesLost:
    return "media-services-lost";
  case AudioHostTerminalReason::MediaServicesReset:
    return "media-services-reset";
  case AudioHostTerminalReason::ProviderFailure:
    return "provider-failure";
  }
  return "provider-failure";
}

void setFormat(napi_env env, napi_value object, const AudioHostFormat &format) {
  napi_value value{};
  napi_create_object(env, &value);
  setValue(env, value, "sampleRate", makeNumber(env, format.sampleRate));
  setValue(env, value, "maximumFrames",
           makeNumber(env, format.maximumFrames));
  setValue(env, value, "nominalBufferFrames",
           makeNumber(env, format.nominalBufferFrames));
  setValue(env, value, "inputChannels",
           makeNumber(env, format.inputChannels));
  setValue(env, value, "outputChannels",
           makeNumber(env, format.outputChannels));
  setValue(env, object, "format", value);
}

void setLatency(napi_env env, napi_value object,
                const AudioHostLatency &latency) {
  napi_value value{};
  napi_create_object(env, &value);
  setValue(env, value, "inputDeviceFrames",
           makeNumber(env, latency.inputDeviceFrames));
  setValue(env, value, "outputDeviceFrames",
           makeNumber(env, latency.outputDeviceFrames));
  setValue(env, value, "bufferFrames", makeNumber(env, latency.bufferFrames));
  setValue(env, value, "externalRouteFrames",
           makeNumber(env, latency.externalRouteFrames));
  setValue(env, object, "latency", value);
}

napi_value resultValue(napi_env env, const NativePlaybackResult &source,
                       const char *overrideError = nullptr) {
  napi_value result{};
  napi_create_object(env, &result);
  setValue(env, result, "ok", makeBool(env, source.ok));
  setValue(env, result, "errorCode",
           makeString(env, overrideError != nullptr
                               ? overrideError
                               : nativePlaybackErrorName(source.error)));
  setValue(env, result, "error", makeString(env, source.message));
  setCounter(env, result, "generation", source.generation);
  setValue(env, result, "state",
           makeString(env, playbackStateName(source.state)));
  setFormat(env, result, source.format);
  setLatency(env, result, source.latency);
  return result;
}

NativePlaybackResult simpleFailure(NativePlaybackError error,
                                   uint64_t generation,
                                   std::string message) {
  NativePlaybackResult result;
  result.error = error;
  result.generation = generation;
  result.message = std::move(message);
  return result;
}

bool named(napi_env env, napi_value object, const char *name,
           napi_value *value) {
  bool present = false;
  return napi_has_named_property(env, object, name, &present) == napi_ok &&
         present &&
         napi_get_named_property(env, object, name, value) == napi_ok;
}

bool stringValue(napi_env env, napi_value value, size_t maximumBytes,
                 std::string *result) {
  napi_valuetype type{};
  size_t length = 0;
  if (result == nullptr || napi_typeof(env, value, &type) != napi_ok ||
      type != napi_string ||
      napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok ||
      length == 0 || length > maximumBytes)
    return false;
  std::string text(length + 1, '\0');
  if (napi_get_value_string_utf8(env, value, text.data(), text.size(),
                                 &length) != napi_ok)
    return false;
  text.resize(length);
  if (text.find('\0') != std::string::npos)
    return false;
  *result = std::move(text);
  return true;
}

bool objectWithOnlyKeys(napi_env env, napi_value value,
                        std::initializer_list<const char *> allowed) {
  napi_valuetype type{};
  bool isArray = false;
  napi_value keys{};
  uint32_t length = 0;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_object ||
      napi_is_array(env, value, &isArray) != napi_ok || isArray ||
      napi_get_property_names(env, value, &keys) != napi_ok ||
      napi_get_array_length(env, keys, &length) != napi_ok)
    return false;
  for (uint32_t index = 0; index < length; ++index) {
    napi_value keyValue{};
    std::string key;
    if (napi_get_element(env, keys, index, &keyValue) != napi_ok ||
        !stringValue(env, keyValue, 128, &key))
      return false;
    bool accepted = false;
    for (const char *candidate : allowed)
      accepted = accepted || key == candidate;
    if (!accepted)
      return false;
  }
  return true;
}

bool exactU64(napi_env env, napi_value value, uint64_t *result) {
  napi_valuetype type{};
  if (result == nullptr || napi_typeof(env, value, &type) != napi_ok)
    return false;
  if (type == napi_bigint) {
    bool lossless = false;
    return napi_get_value_bigint_uint64(env, value, result, &lossless) ==
               napi_ok &&
           lossless && *result != 0;
  }
  double number = 0.0;
  if (type != napi_number ||
      napi_get_value_double(env, value, &number) != napi_ok ||
      !std::isfinite(number) || std::floor(number) != number || number < 1.0 ||
      number > static_cast<double>(kNativePlaybackMaximumJsSafeInteger))
    return false;
  *result = static_cast<uint64_t>(number);
  return true;
}

bool numberProperty(napi_env env, napi_value object, const char *name,
                    double minimum, double maximum, double fallback,
                    bool required, double *result) {
  napi_value value{};
  if (!named(env, object, name, &value)) {
    if (required || result == nullptr)
      return false;
    *result = fallback;
    return true;
  }
  napi_valuetype type{};
  double number = 0.0;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_number ||
      napi_get_value_double(env, value, &number) != napi_ok ||
      !std::isfinite(number) || number < minimum || number > maximum)
    return false;
  *result = number;
  return true;
}

bool unsignedProperty(napi_env env, napi_value object, const char *name,
                      uint32_t minimum, uint32_t maximum, uint32_t fallback,
                      bool required, uint32_t *result) {
  double number = 0.0;
  if (!numberProperty(env, object, name, minimum, maximum, fallback, required,
                      &number) ||
      std::floor(number) != number)
    return false;
  *result = static_cast<uint32_t>(number);
  return true;
}

bool boolProperty(napi_env env, napi_value object, const char *name,
                  bool fallback, bool required, bool *result) {
  napi_value value{};
  if (!named(env, object, name, &value)) {
    if (required || result == nullptr)
      return false;
    *result = fallback;
    return true;
  }
  napi_valuetype type{};
  return napi_typeof(env, value, &type) == napi_ok && type == napi_boolean &&
         napi_get_value_bool(env, value, result) == napi_ok;
}

bool stringProperty(napi_env env, napi_value object, const char *name,
                    size_t maximumBytes, std::string *result) {
  napi_value value{};
  return result != nullptr && named(env, object, name, &value) &&
         stringValue(env, value, maximumBytes, result);
}

bool unsignedArray(napi_env env, napi_value object, const char *name,
                   uint32_t maximumValue, std::vector<uint32_t> *result) {
  napi_value value{};
  bool isArray = false;
  uint32_t length = 0;
  if (result == nullptr || !named(env, object, name, &value) ||
      napi_is_array(env, value, &isArray) != napi_ok || !isArray ||
      napi_get_array_length(env, value, &length) != napi_ok || length == 0 ||
      length > kAudioHostMaxChannels)
    return false;
  std::vector<uint32_t> values;
  values.reserve(length);
  for (uint32_t index = 0; index < length; ++index) {
    napi_value item{};
    napi_valuetype type{};
    double number = 0.0;
    if (napi_get_element(env, value, index, &item) != napi_ok ||
        napi_typeof(env, item, &type) != napi_ok || type != napi_number ||
        napi_get_value_double(env, item, &number) != napi_ok ||
        !std::isfinite(number) || std::floor(number) != number || number < 0 ||
        number > maximumValue)
      return false;
    values.push_back(static_cast<uint32_t>(number));
  }
  *result = std::move(values);
  return true;
}

bool doubleArray(napi_env env, napi_value object, const char *name,
                 size_t maximumLength, std::vector<double> *result) {
  napi_value value{};
  bool isArray = false;
  uint32_t length = 0;
  if (result == nullptr || !named(env, object, name, &value) ||
      napi_is_array(env, value, &isArray) != napi_ok || !isArray ||
      napi_get_array_length(env, value, &length) != napi_ok ||
      length > maximumLength)
    return false;
  std::vector<double> values;
  values.reserve(length);
  for (uint32_t index = 0; index < length; ++index) {
    napi_value item{};
    napi_valuetype type{};
    double number = 0.0;
    if (napi_get_element(env, value, index, &item) != napi_ok ||
        napi_typeof(env, item, &type) != napi_ok || type != napi_number ||
        napi_get_value_double(env, item, &number) != napi_ok ||
        !std::isfinite(number))
      return false;
    values.push_back(number);
  }
  *result = std::move(values);
  return true;
}

bool unsignedVector(napi_env env, napi_value object, const char *name,
                    size_t maximumLength, std::vector<uint32_t> *result) {
  napi_value value{};
  bool isArray = false;
  uint32_t length = 0;
  if (result == nullptr || !named(env, object, name, &value) ||
      napi_is_array(env, value, &isArray) != napi_ok || !isArray ||
      napi_get_array_length(env, value, &length) != napi_ok ||
      length > maximumLength)
    return false;
  std::vector<uint32_t> values;
  values.reserve(length);
  for (uint32_t index = 0; index < length; ++index) {
    napi_value item{};
    napi_valuetype type{};
    double number = 0.0;
    if (napi_get_element(env, value, index, &item) != napi_ok ||
        napi_typeof(env, item, &type) != napi_ok || type != napi_number ||
        napi_get_value_double(env, item, &number) != napi_ok ||
        !std::isfinite(number) || std::floor(number) != number || number < 0 ||
        number > std::numeric_limits<uint32_t>::max())
      return false;
    values.push_back(static_cast<uint32_t>(number));
  }
  *result = std::move(values);
  return true;
}

constexpr uint32_t kDesktopPlaybackContractVersion = 2;
constexpr double kMinimumPlaybackRate = 0.25;
constexpr double kMaximumPlaybackRate = 4.0;
constexpr double kMinimumBeatSeparationSeconds = 0.05;
constexpr double kMinimumBpm = 30.0;
constexpr double kMaximumBpm = 300.0;

bool exactJsSafeInt64(napi_env env, napi_value value, bool nonNegative,
                      int64_t *result) {
  napi_valuetype type{};
  double number = 0.0;
  if (result == nullptr || napi_typeof(env, value, &type) != napi_ok ||
      type != napi_number ||
      napi_get_value_double(env, value, &number) != napi_ok ||
      !std::isfinite(number) || std::floor(number) != number ||
      number < (nonNegative ? 0.0
                            : -static_cast<double>(
                                  kNativePlaybackMaximumJsSafeInteger)) ||
      number > static_cast<double>(kNativePlaybackMaximumJsSafeInteger))
    return false;
  *result = static_cast<int64_t>(number);
  return true;
}

bool parseBeatGrid(napi_env env, napi_value value, uint32_t countInBars,
                   PlaybackCueBeatGrid *result,
                   uint64_t *countInEventPotential) {
  if (result == nullptr || countInEventPotential == nullptr ||
      !objectWithOnlyKeys(env, value,
                          {"beats", "beatsPerBar", "downbeat", "downbeats"}))
    return false;
  PlaybackCueBeatGrid grid;
  if (!doubleArray(env, value, "beats", kPlaybackCueMaximumBeats,
                   &grid.beats) ||
      grid.beats.size() < 2 ||
      !unsignedProperty(env, value, "beatsPerBar", 1, 6, 4, true,
                        &grid.beatsPerBar) ||
      (grid.beatsPerBar != 2 && grid.beatsPerBar != 3 &&
       grid.beatsPerBar != 4 && grid.beatsPerBar != 6) ||
      !unsignedProperty(env, value, "downbeat", 0, 5, 0, true,
                        &grid.downbeat) ||
      grid.downbeat >= grid.beatsPerBar ||
      !unsignedVector(env, value, "downbeats", kPlaybackCueMaximumBeats,
                      &grid.downbeats) ||
      grid.downbeats.size() > grid.beats.size())
    return false;

  std::vector<double> intervals;
  intervals.reserve(grid.beats.size() - 1);
  for (size_t index = 0; index < grid.beats.size(); ++index) {
    const double beat = grid.beats[index];
    if (beat < 0.0 || beat > kPlaybackCueMaximumDurationSeconds ||
        (index != 0 &&
         beat - grid.beats[index - 1] <= kMinimumBeatSeparationSeconds))
      return false;
    if (index != 0)
      intervals.push_back(beat - grid.beats[index - 1]);
  }
  std::sort(intervals.begin(), intervals.end());
  const double bpm = 60.0 / intervals[intervals.size() / 2];
  if (!std::isfinite(bpm) || bpm < kMinimumBpm || bpm > kMaximumBpm)
    return false;

  uint32_t previous = 0;
  uint32_t maximumBarLength = grid.beatsPerBar;
  for (size_t index = 0; index < grid.downbeats.size(); ++index) {
    const uint32_t position = grid.downbeats[index];
    if (position >= grid.beats.size() || (index != 0 && position <= previous))
      return false;
    if (index != 0)
      maximumBarLength = std::max(maximumBarLength, position - previous);
    previous = position;
  }
  const uint64_t potential =
      static_cast<uint64_t>(countInBars) * maximumBarLength;
  if (potential > kPlaybackCueMaximumEvents)
    return false;
  *countInEventPotential = potential;
  *result = std::move(grid);
  return true;
}

bool parsePlayback(napi_env env, napi_value value, double sampleRate,
                   NativePlaybackPrepareConfig *config) {
  if (config == nullptr ||
      !objectWithOnlyKeys(env, value, {"version", "transport", "cues"}))
    return false;
  uint32_t version = 0;
  napi_value transport{};
  napi_value cues{};
  if (!unsignedProperty(env, value, "version", 1,
                        kDesktopPlaybackContractVersion, 0, true, &version) ||
      version != kDesktopPlaybackContractVersion ||
      !named(env, value, "transport", &transport) ||
      !objectWithOnlyKeys(env, transport,
                          {"entrySeconds", "durationSeconds", "playbackRate",
                           "transposeSemitones"}) ||
      !named(env, value, "cues", &cues) ||
      !objectWithOnlyKeys(env, cues,
                          {"click", "countInBars", "volume", "accent",
                           "beatGrid"}))
    return false;

  PlaybackCuePlanRequest request;
  double transpose = 0.0;
  if (!numberProperty(env, transport, "entrySeconds", 0.0,
                      kPlaybackCueMaximumDurationSeconds, 0.0, true,
                      &request.entrySeconds) ||
      !numberProperty(env, transport, "playbackRate", kMinimumPlaybackRate,
                      kMaximumPlaybackRate, 1.0, true,
                      &request.playbackRate) ||
      !numberProperty(env, transport, "transposeSemitones", -24.0, 24.0,
                      0.0, true, &transpose) ||
      !boolProperty(env, cues, "click", false, true, &request.click) ||
      !unsignedProperty(env, cues, "countInBars", 0, 2, 0, true,
                        &request.countInBars) ||
      !numberProperty(env, cues, "volume", 0.0, 1.0, 0.7, true,
                      &request.volume) ||
      !boolProperty(env, cues, "accent", true, true, &request.accent))
    return false;

  request.durationSeconds = kPlaybackCueMaximumDurationSeconds;
  napi_value duration{};
  double checkedDuration = 0.0;
  if (named(env, transport, "durationSeconds", &duration) &&
      (!numberProperty(env, transport, "durationSeconds", 0.0,
                       kPlaybackCueMaximumDurationSeconds, 0.0, true,
                       &checkedDuration) ||
       checkedDuration <= 0.0))
    return false;

  uint64_t countInPotential = static_cast<uint64_t>(request.countInBars) * 3;
  napi_value beatGrid{};
  if (named(env, cues, "beatGrid", &beatGrid) &&
      !parseBeatGrid(env, beatGrid, request.countInBars, &request.beatGrid,
                     &countInPotential))
    return false;
  if (request.click && request.beatGrid.beats.empty())
    return false;
  if (request.click &&
      static_cast<uint64_t>(request.beatGrid.beats.size()) + 2 +
              countInPotential >
          kPlaybackCueMaximumEvents)
    return false;

  request.sampleRate = sampleRate;
  config->playbackRate = request.playbackRate;
  config->transposeSemitones = transpose;
  config->cuePlan = std::move(request);
  return true;
}

bool parseTraining(napi_env env, napi_value value,
                   NativePlaybackTrainingDuckConfig *result) {
  if (result == nullptr ||
      !objectWithOnlyKeys(env, value,
                          {"mode", "periodFrames", "windows", "laneIds",
                           "enabled"}))
    return false;
  NativePlaybackTrainingDuckConfig training;
  std::string mode;
  bool enabled = false;
  napi_value laneIds{};
  bool laneIdsArray = false;
  uint32_t laneCount = 0;
  if (!stringProperty(env, value, "mode", 16, &mode) ||
      !boolProperty(env, value, "enabled", false, true, &enabled) ||
      !named(env, value, "laneIds", &laneIds) ||
      napi_is_array(env, laneIds, &laneIdsArray) != napi_ok || !laneIdsArray ||
      napi_get_array_length(env, laneIds, &laneCount) != napi_ok ||
      laneCount == 0 || laneCount > kNativePlaybackMaximumLanes)
    return false;
  training.enabled = enabled;
  training.laneIds.reserve(laneCount);
  for (uint32_t index = 0; index < laneCount; ++index) {
    napi_value lane{};
    std::string laneId;
    if (napi_get_element(env, laneIds, index, &lane) != napi_ok ||
        !stringValue(env, lane, 96, &laneId) ||
        std::find(training.laneIds.begin(), training.laneIds.end(), laneId) !=
            training.laneIds.end())
      return false;
    training.laneIds.push_back(std::move(laneId));
  }

  napi_value periodValue{};
  napi_value windowsValue{};
  const bool hasPeriod = named(env, value, "periodFrames", &periodValue);
  const bool hasWindows = named(env, value, "windows", &windowsValue);
  if (mode == "period") {
    int64_t period = 0;
    if (!hasPeriod || hasWindows ||
        !exactJsSafeInt64(env, periodValue, true, &period) || period == 0)
      return false;
    training.mode = NativePlaybackTrainingMode::Period;
    training.periodFrames = period;
    *result = std::move(training);
    return true;
  }
  if (mode != "windows" || hasPeriod || !hasWindows)
    return false;
  bool windowsArray = false;
  uint32_t windowCount = 0;
  if (napi_is_array(env, windowsValue, &windowsArray) != napi_ok ||
      !windowsArray ||
      napi_get_array_length(env, windowsValue, &windowCount) != napi_ok ||
      windowCount == 0 || windowCount > kNativePlaybackMaximumTrainingWindows)
    return false;
  training.mode = NativePlaybackTrainingMode::Windows;
  training.windows.reserve(windowCount);
  int64_t previousEnd = 0;
  for (uint32_t index = 0; index < windowCount; ++index) {
    napi_value window{};
    napi_value start{};
    napi_value end{};
    NativePlaybackTrainingWindow parsed;
    if (napi_get_element(env, windowsValue, index, &window) != napi_ok ||
        !objectWithOnlyKeys(env, window,
                            {"startProjectFrame", "endProjectFrame"}) ||
        !named(env, window, "startProjectFrame", &start) ||
        !named(env, window, "endProjectFrame", &end) ||
        !exactJsSafeInt64(env, start, true, &parsed.startProjectFrame) ||
        !exactJsSafeInt64(env, end, true, &parsed.endProjectFrame) ||
        parsed.endProjectFrame <= parsed.startProjectFrame ||
        (index != 0 && parsed.startProjectFrame < previousEnd))
      return false;
    previousEnd = parsed.endProjectFrame;
    training.windows.push_back(parsed);
  }
  *result = std::move(training);
  return true;
}

bool parseInitialTransport(napi_env env, napi_value value,
                           NativePlaybackInitialTransportConfig *result) {
  if (result == nullptr ||
      !objectWithOnlyKeys(env, value, {"state", "loop"}))
    return false;
  std::string state;
  if (!stringProperty(env, value, "state", 16, &state) ||
      (state != "playing" && state != "paused"))
    return false;
  NativePlaybackInitialTransportConfig initial;
  initial.startPaused = state == "paused";
  napi_value loop{};
  if (named(env, value, "loop", &loop)) {
    napi_value start{};
    napi_value end{};
    NativePlaybackInitialLoop parsed;
    if (!objectWithOnlyKeys(env, loop,
                            {"startProjectFrame", "endProjectFrame"}) ||
        !named(env, loop, "startProjectFrame", &start) ||
        !named(env, loop, "endProjectFrame", &end) ||
        !exactJsSafeInt64(env, start, true, &parsed.startProjectFrame) ||
        !exactJsSafeInt64(env, end, true, &parsed.endProjectFrame) ||
        parsed.endProjectFrame <= parsed.startProjectFrame)
      return false;
    initial.loop = parsed;
  }
  *result = std::move(initial);
  return true;
}

int openReadOnly(const std::string &utf8Path) noexcept {
#if defined(_WIN32)
  try {
    return _wopen(std::filesystem::u8path(utf8Path).c_str(),
                  _O_RDONLY | _O_BINARY);
  } catch (...) {
    return -1;
  }
#else
  return ::open(utf8Path.c_str(), O_RDONLY | O_CLOEXEC);
#endif
}

bool parseLanes(napi_env env, napi_value value,
                std::vector<NativePlaybackLaneSource> *result) {
  bool isArray = false;
  uint32_t length = 0;
  if (result == nullptr || napi_is_array(env, value, &isArray) != napi_ok ||
      !isArray || napi_get_array_length(env, value, &length) != napi_ok ||
      length == 0 || length > kNativePlaybackMaximumLanes)
    return false;
  std::vector<NativePlaybackLaneSource> lanes;
  lanes.reserve(length);
  for (uint32_t index = 0; index < length; ++index) {
    napi_value laneValue{};
    NativePlaybackLaneSource lane;
    std::string path;
    double gain = 1.0;
    if (napi_get_element(env, value, index, &laneValue) != napi_ok ||
        !objectWithOnlyKeys(env, laneValue,
                            {"id", "path", "gain", "muted", "solo"}) ||
        !stringProperty(env, laneValue, "id", 96, &lane.id) ||
        !stringProperty(env, laneValue, "path", 32768, &path) ||
        !numberProperty(env, laneValue, "gain", 0.0,
                        kNativePlaybackMaximumLinearGain, 1.0, true, &gain) ||
        !boolProperty(env, laneValue, "muted", false, true, &lane.muted) ||
        !boolProperty(env, laneValue, "solo", false, true, &lane.solo))
      return false;
    if (std::any_of(lanes.begin(), lanes.end(), [&](const auto &prior) {
          return prior.id == lane.id;
        }))
      return false;
    const int descriptor = openReadOnly(path);
    if (descriptor < 0)
      return false;
    lane.descriptor = OwnedFileDescriptor(descriptor);
    lane.gain = static_cast<float>(gain);
    // The path this bridge opened is the core's opaque identity for the
    // bytes; it is compared, never opened, when a retaining unload offers an
    // already decoded lane to the next prepare.
    lane.sourceKey = path;
    lanes.push_back(std::move(lane));
  }
  *result = std::move(lanes);
  return true;
}

bool decimalU64String(napi_env env, napi_value value, uint64_t *result) {
  std::string text;
  if (result == nullptr || !stringValue(env, value, 20, &text) ||
      (text.size() > 1 && text[0] == '0'))
    return false;
  uint64_t parsed = 0;
  const auto converted =
      std::from_chars(text.data(), text.data() + text.size(), parsed, 10);
  if (converted.ec != std::errc{} || converted.ptr != text.data() + text.size() ||
      parsed == 0)
    return false;
  *result = parsed;
  return true;
}

bool graphTypeId(napi_env env, napi_value value, zdsp::NodeTypeId *result) {
  std::string text;
  if (result == nullptr || !stringValue(env, value, 32, &text) ||
      text.size() != 32)
    return false;
  for (const char character : text)
    if (!((character >= '0' && character <= '9') ||
          (character >= 'a' && character <= 'f')))
      return false;
  const auto high = std::from_chars(text.data(), text.data() + 16,
                                    result->high, 16);
  const auto low = std::from_chars(text.data() + 16, text.data() + 32,
                                   result->low, 16);
  return high.ec == std::errc{} && high.ptr == text.data() + 16 &&
         low.ec == std::errc{} && low.ptr == text.data() + 32;
}

bool parseGraphPorts(napi_env env, napi_value value,
                     std::vector<NativePlaybackGraphPort> *result) {
  bool isArray = false;
  uint32_t length = 0;
  if (result == nullptr || napi_is_array(env, value, &isArray) != napi_ok ||
      !isArray || napi_get_array_length(env, value, &length) != napi_ok ||
      length > zdsp::kMaximumBusesPerProcessor)
    return false;
  std::vector<NativePlaybackGraphPort> ports;
  ports.reserve(length);
  for (uint32_t index = 0; index < length; ++index) {
    napi_value item{};
    NativePlaybackGraphPort port;
    if (napi_get_element(env, value, index, &item) != napi_ok ||
        !objectWithOnlyKeys(env, item, {"id", "channels"}) ||
        !stringProperty(env, item, "id", 128, &port.id) ||
        !unsignedProperty(env, item, "channels", 1,
                          zdsp::kMaximumChannelsPerBus, 0, true,
                          &port.channels) ||
        std::any_of(ports.begin(), ports.end(), [&](const auto &prior) {
          return prior.id == port.id;
        }))
      return false;
    ports.push_back(std::move(port));
  }
  *result = std::move(ports);
  return true;
}

bool parseGraphParameters(
    napi_env env, napi_value value,
    std::vector<NativePlaybackGraphParameter> *result) {
  napi_valuetype type{};
  bool isArray = false;
  napi_value keys{};
  uint32_t length = 0;
  if (result == nullptr || napi_typeof(env, value, &type) != napi_ok ||
      type != napi_object || napi_is_array(env, value, &isArray) != napi_ok ||
      isArray || napi_get_property_names(env, value, &keys) != napi_ok ||
      napi_get_array_length(env, keys, &length) != napi_ok ||
      length > kNativePlaybackGraphMaximumParametersPerNode)
    return false;
  std::vector<NativePlaybackGraphParameter> parameters;
  parameters.reserve(length);
  for (uint32_t index = 0; index < length; ++index) {
    napi_value keyValue{};
    napi_value numberValue{};
    NativePlaybackGraphParameter parameter;
    napi_valuetype numberType{};
    if (napi_get_element(env, keys, index, &keyValue) != napi_ok ||
        !stringValue(env, keyValue, 128, &parameter.id) ||
        napi_get_property(env, value, keyValue, &numberValue) != napi_ok ||
        napi_typeof(env, numberValue, &numberType) != napi_ok ||
        numberType != napi_number ||
        napi_get_value_double(env, numberValue,
                              &parameter.normalizedValue) != napi_ok ||
        !std::isfinite(parameter.normalizedValue) ||
        parameter.normalizedValue < 0.0 || parameter.normalizedValue > 1.0)
      return false;
    parameters.push_back(std::move(parameter));
  }
  *result = std::move(parameters);
  return true;
}

bool parseGraphDocument(napi_env env, napi_value value,
                        NativePlaybackGraphDocument *result) {
  if (result == nullptr ||
      !objectWithOnlyKeys(env, value,
                          {"format", "engine", "nodes", "connections"}))
    return false;
  NativePlaybackGraphDocument document;
  if (!unsignedProperty(env, value, "format",
                        kNativePlaybackGraphDocumentFormat,
                        kNativePlaybackGraphDocumentFormat, 0, true,
                        &document.format) ||
      !stringProperty(env, value, "engine", 32, &document.engine) ||
      document.engine != kNativePlaybackGraphDocumentEngine)
    return false;
  napi_value nodesValue{};
  napi_value connectionsValue{};
  bool nodesArray = false;
  bool connectionsArray = false;
  uint32_t nodeCount = 0;
  uint32_t connectionCount = 0;
  if (!named(env, value, "nodes", &nodesValue) ||
      napi_is_array(env, nodesValue, &nodesArray) != napi_ok || !nodesArray ||
      napi_get_array_length(env, nodesValue, &nodeCount) != napi_ok ||
      nodeCount == 0 || nodeCount > zdsp::kMaximumGraphNodes ||
      !named(env, value, "connections", &connectionsValue) ||
      napi_is_array(env, connectionsValue, &connectionsArray) != napi_ok ||
      !connectionsArray ||
      napi_get_array_length(env, connectionsValue, &connectionCount) !=
          napi_ok ||
      connectionCount > zdsp::kMaximumGraphConnections)
    return false;
  document.nodes.reserve(nodeCount);
  for (uint32_t index = 0; index < nodeCount; ++index) {
    napi_value object{};
    napi_value id{};
    napi_value type{};
    napi_value unavailable{};
    napi_value ports{};
    napi_value inputs{};
    napi_value outputs{};
    napi_value parameters{};
    NativePlaybackGraphNode node;
    std::string policy;
    if (napi_get_element(env, nodesValue, index, &object) != napi_ok ||
        !objectWithOnlyKeys(env, object,
                            {"id", "type", "typeVersion", "execution",
                             "unavailable", "ports", "parameters",
                             "binding"}) ||
        !named(env, object, "id", &id) ||
        !decimalU64String(env, id, &node.id) ||
        !named(env, object, "type", &type) ||
        !graphTypeId(env, type, &node.type) ||
        !unsignedProperty(env, object, "typeVersion", 1,
                          std::numeric_limits<uint32_t>::max(), 0, true,
                          &node.typeVersion) ||
        !stringProperty(env, object, "execution", 128, &node.execution) ||
        !named(env, object, "unavailable", &unavailable) ||
        !stringValue(env, unavailable, 16, &policy) ||
        (policy != "bypass" && policy != "silence") ||
        !named(env, object, "ports", &ports) ||
        !objectWithOnlyKeys(env, ports, {"inputs", "outputs"}) ||
        !named(env, ports, "inputs", &inputs) ||
        !named(env, ports, "outputs", &outputs) ||
        !parseGraphPorts(env, inputs, &node.inputs) ||
        !parseGraphPorts(env, outputs, &node.outputs) ||
        !named(env, object, "parameters", &parameters) ||
        !parseGraphParameters(env, parameters, &node.parameters))
      return false;
    node.unavailable = policy == "bypass"
                           ? NativePlaybackGraphUnavailablePolicy::Bypass
                           : NativePlaybackGraphUnavailablePolicy::Silence;
    napi_value bindingValue{};
    if (named(env, object, "binding", &bindingValue)) {
      if (!objectWithOnlyKeys(env, bindingValue, {"kind", "laneId"}))
        return false;
      NativePlaybackGraphBinding binding;
      if (!stringProperty(env, bindingValue, "kind", 128, &binding.kind))
        return false;
      napi_value laneValue{};
      if (named(env, bindingValue, "laneId", &laneValue) &&
          !stringValue(env, laneValue, 128, &binding.laneId))
        return false;
      node.binding = std::move(binding);
    }
    document.nodes.push_back(std::move(node));
  }
  document.connections.reserve(connectionCount);
  for (uint32_t index = 0; index < connectionCount; ++index) {
    napi_value object{};
    napi_value from{};
    napi_value to{};
    napi_value fromNode{};
    napi_value toNode{};
    NativePlaybackGraphConnection connection;
    if (napi_get_element(env, connectionsValue, index, &object) != napi_ok ||
        !objectWithOnlyKeys(env, object, {"from", "to"}) ||
        !named(env, object, "from", &from) ||
        !objectWithOnlyKeys(env, from, {"node", "port"}) ||
        !named(env, object, "to", &to) ||
        !objectWithOnlyKeys(env, to, {"node", "port"}) ||
        !named(env, from, "node", &fromNode) ||
        !decimalU64String(env, fromNode, &connection.from.node) ||
        !stringProperty(env, from, "port", 128, &connection.from.port) ||
        !named(env, to, "node", &toNode) ||
        !decimalU64String(env, toNode, &connection.to.node) ||
        !stringProperty(env, to, "port", 128, &connection.to.port))
      return false;
    document.connections.push_back(std::move(connection));
  }
  *result = std::move(document);
  return true;
}

bool parseConfig(napi_env env, napi_value value,
                 NativePlaybackPrepareConfig *result,
                 std::string *provider) {
  if (result == nullptr || provider == nullptr ||
      !objectWithOnlyKeys(
          env, value,
          {"capability", "provider", "accessMode", "outputDeviceUid", "outputChannels", "sampleRate",
           "bufferFrames", "maximumFrames", "masterGain",
           "maximumRetainedBytes", "playback", "training",
           "preparedStartProjectFrame", "initialTransport",
           "graphDocument", "swapFromGeneration"}))
    return false;
  NativePlaybackPrepareConfig config;
  uint32_t sampleRate = 0;
  double masterGain = 1.0;
  std::string capability;
  std::string accessMode;
  if (!stringProperty(env, value, "capability", 128, &capability) ||
      capability != nativePlaybackSessionCapabilityTag() ||
      !stringProperty(env, value, "provider", 16, provider) ||
      !stringProperty(env, value, "accessMode", 16, &accessMode) ||
      !stringProperty(env, value, "outputDeviceUid", 1024,
                      &config.outputDeviceUid) ||
      !unsignedArray(env, value, "outputChannels",
                     kAudioHostMaxChannels - 1, &config.outputChannels) ||
      !unsignedProperty(env, value, "sampleRate", 8000, 384000, 0, true,
                        &sampleRate) ||
      !unsignedProperty(env, value, "bufferFrames", 0, kAudioHostMaxFrames,
                        0, true, &config.requestedBufferFrames) ||
      !unsignedProperty(env, value, "maximumFrames", 1, kAudioHostMaxFrames,
                        4096, true, &config.maximumFrames) ||
      !numberProperty(env, value, "masterGain", 0.0,
                      kNativePlaybackMaximumLinearGain, 1.0, true,
                      &masterGain))
    return false;
  if ((*provider == "asio") != (accessMode == "exclusive") ||
      (*provider != "asio" && accessMode != "shared"))
    return false;
  config.exclusive = accessMode == "exclusive";
  // The input order is semantically meaningful, so reject duplicates without
  // sorting or otherwise rewriting the caller's bounded channel map.
  for (size_t index = 0; index < config.outputChannels.size(); ++index)
    for (size_t prior = 0; prior < index; ++prior)
      if (config.outputChannels[index] == config.outputChannels[prior])
        return false;
  config.requestedSampleRate = sampleRate;
  config.masterGain = static_cast<float>(masterGain);
  config.decodeOptions.requiredSampleRate = sampleRate;

  napi_value playbackValue{};
  if (!named(env, value, "playback", &playbackValue) ||
      !parsePlayback(env, playbackValue, sampleRate, &config))
    return false;

  napi_value retainedValue{};
  if (named(env, value, "maximumRetainedBytes", &retainedValue)) {
    napi_valuetype type{};
    double bytes = 0.0;
    if (napi_typeof(env, retainedValue, &type) != napi_ok ||
        type != napi_number ||
        napi_get_value_double(env, retainedValue, &bytes) != napi_ok ||
        !std::isfinite(bytes) || std::floor(bytes) != bytes || bytes < 1.0 ||
        bytes > static_cast<double>(kNativePlaybackMaximumJsSafeInteger) ||
        bytes > static_cast<double>(std::numeric_limits<size_t>::max()))
      return false;
    config.maximumRetainedBytes = static_cast<size_t>(bytes);
  }
  napi_value trainingValue{};
  if (named(env, value, "training", &trainingValue)) {
    NativePlaybackTrainingDuckConfig training;
    if (!parseTraining(env, trainingValue, &training))
      return false;
    config.trainingDuck = std::move(training);
  }
  napi_value start{};
  if (named(env, value, "preparedStartProjectFrame", &start)) {
    int64_t frame = 0;
    if (!exactJsSafeInt64(env, start, false, &frame))
      return false;
    config.preparedStartProjectFrame = frame;
  }
  napi_value initialTransport{};
  // Replace a running generation on its stream (the phones' seam): the
  // core hands the clock across at a block boundary and retires the old
  // graph itself. Absent or zero is an ordinary prepare.
  napi_value swapFrom{};
  if (named(env, value, "swapFromGeneration", &swapFrom)) {
    uint64_t swapGeneration = 0;
    if (!exactU64(env, swapFrom, &swapGeneration))
      return false;
    config.swapFromGeneration = swapGeneration;
  }
  if (named(env, value, "initialTransport", &initialTransport) &&
      !parseInitialTransport(env, initialTransport, &config.initialTransport)) {
    return false;
  }
  napi_value graphDocument{};
  if (named(env, value, "graphDocument", &graphDocument)) {
    NativePlaybackGraphDocument graph;
    if (!parseGraphDocument(env, graphDocument, &graph))
      return false;
    config.graphDocument = std::move(graph);
  }
  *result = std::move(config);
  return true;
}

bool consumeProviderDeviceUid(const std::string &provider,
                              std::string *deviceUid) {
  if (deviceUid == nullptr) return false;
#if defined(_WIN32)
  if (provider != "wasapi" && provider != "asio") return false;
  const std::string prefix = provider + ":";
  if (!deviceUid->starts_with(prefix) || deviceUid->size() == prefix.size())
    return false;
  deviceUid->erase(0, prefix.size());
  return true;
#elif defined(__APPLE__)
  return provider == "coreaudio";
#else
  (void)provider;
  return false;
#endif
}

napi_value preparePlayback(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3]{};
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  uint64_t generation = 0;
  NativePlaybackPrepareConfig config;
  std::string provider;
  std::vector<NativePlaybackLaneSource> lanes;
  if (argc != 3 || !exactU64(env, argv[2], &generation) ||
      !parseConfig(env, argv[0], &config, &provider) ||
      !parseLanes(env, argv[1], &lanes))
    return resultValue(
        env, simpleFailure(NativePlaybackError::InvalidConfiguration,
                           generation,
                           "Playback configuration or lane paths are invalid"));

  std::lock_guard<std::mutex> lock(playback.mutex);
  if (config.swapFromGeneration != 0) {
    // A SEAM: the candidate replaces the running generation on its stream.
    // No new backend, no new device lease — the stream, its format and its
    // route are the ones the song is on, and the core does the hand-over at
    // a block boundary and retires the old graph itself. Only the active
    // generation may be named, and only on the provider it runs on.
    if (playback.generation == 0 ||
        config.swapFromGeneration != playback.generation)
      return resultValue(env,
                         simpleFailure(NativePlaybackError::InvalidGeneration,
                                       generation,
                                       "A native playback seam must name the "
                                       "active generation"),
                         "invalid-generation");
    if (provider != playback.provider ||
        !consumeProviderDeviceUid(provider, &config.outputDeviceUid))
      return resultValue(
          env, simpleFailure(NativePlaybackError::InvalidConfiguration,
                             generation,
                             "A native playback seam keeps the running "
                             "provider and device"));
    const uint64_t replaced = playback.generation;
    const NativePlaybackResult claimed =
        playback.session.claimGeneration(generation, 0);
    if (!claimed.ok) return resultValue(env, claimed);
    config.handoffLease = 0;
    const NativePlaybackResult prepared = playback.session.prepare(
        std::move(config), std::move(lanes), generation);
    // Took: the lease and the addon's notion of "the active generation" move
    // forward with it; the old one is the core's to retire. Refused: the
    // candidate's claim is spent and nothing of it exists — the running
    // generation is exactly as it was, and main must not move either.
    const bool took = prepared.ok &&
                      playback.ownership->rekey(NativeAudioOwnerKind::Playback,
                                                replaced, generation);
    if (took) playback.generation = generation;
    napi_value result = resultValue(env, prepared);
    setValue(env, result, "ownershipRetained", makeBool(env, took));
    return result;
  }
  if (playback.generation != 0)
    return resultValue(env,
                       simpleFailure(NativePlaybackError::InvalidState,
                                     generation,
                                     "Another native playback session is active"),
                       "native-audio-busy");
  std::string unavailableReason;
  std::unique_ptr<AudioHostBackend> backend = playback.backendFactory == nullptr
      ? nullptr
      : playback.backendFactory(provider, &unavailableReason);
  if (!backend || !consumeProviderDeviceUid(provider, &config.outputDeviceUid))
    return resultValue(
        env,
        simpleFailure(
            NativePlaybackError::InvalidConfiguration, generation,
            unavailableReason.empty()
                ? "The requested native audio provider or device identity is unavailable"
                : unavailableReason),
        "platform-not-ready");
  if (!playback.session.replaceAudioHostBackend(std::move(backend)))
    return resultValue(
        env, simpleFailure(NativePlaybackError::InvalidState, generation,
                           "The native audio provider cannot change while playback owns resources"));
  const NativeAudioAcquireResult acquired = playback.ownership->acquire(
      NativeAudioOwnerKind::Playback, generation);
  if (acquired != NativeAudioAcquireResult::Acquired)
    return resultValue(env,
                       simpleFailure(NativePlaybackError::InvalidState,
                                     generation,
                                     "Another native audio owner is active"),
                       acquired == NativeAudioAcquireResult::Busy
                           ? "native-audio-busy"
                           : "invalid-generation");
  const uint64_t handoff = playback.handoffLease;
  NativePlaybackResult claimed =
      playback.session.claimGeneration(generation, handoff);
  if (!claimed.ok) {
    playback.ownership->release(NativeAudioOwnerKind::Playback, generation);
    return resultValue(env, claimed);
  }
  playback.handoffLease = 0;
  playback.generation = generation;
  playback.provider = provider;
  config.handoffLease = handoff;
  napi_value result = resultValue(
      env, playback.session.prepare(std::move(config), std::move(lanes),
                                    generation));
  setValue(env, result, "ownershipRetained", makeBool(env, true));
  return result;
}

template <typename Invoke>
napi_value generationCommand(napi_env env, napi_callback_info info,
                             Invoke invoke,
                             bool providerFailureForHost = false) {
  size_t argc = 1;
  napi_value argv[1]{};
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  uint64_t generation = 0;
  if (argc != 1 || !exactU64(env, argv[0], &generation))
    return resultValue(
        env, simpleFailure(NativePlaybackError::InvalidGeneration, 0,
                           "Playback generation is invalid"));
  std::lock_guard<std::mutex> lock(playback.mutex);
  const NativePlaybackResult result = invoke(generation);
  const bool explicitProviderFailure =
      providerFailureForHost && playback.provider == "asio" &&
      result.error == NativePlaybackError::HostFailure;
  return resultValue(env, result,
                     explicitProviderFailure ? "provider-failure" : nullptr);
}

napi_value openPlaybackOutput(napi_env env, napi_callback_info info) {
  return generationCommand(env, info, [&](uint64_t generation) {
    NativePlaybackDeliveryToken token;
    NativePlaybackResult result = playback.session.openOutput(generation, &token);
    if (result.ok && !playback.session.acknowledgeDelivery(token))
      return simpleFailure(NativePlaybackError::TeardownUncertain, generation,
                           "Could not acknowledge native output delivery");
    return result;
  }, true);
}

napi_value startPlayback(napi_env env, napi_callback_info info) {
  return generationCommand(env, info, [&](uint64_t generation) {
    NativePlaybackDeliveryToken token;
    NativePlaybackResult result = playback.session.start(generation, &token);
    if (result.ok && !playback.session.acknowledgeDelivery(token))
      return simpleFailure(NativePlaybackError::TeardownUncertain, generation,
                           "Could not acknowledge native start delivery");
    return result;
  });
}

napi_value pausePlayback(napi_env env, napi_callback_info info) {
  return generationCommand(env, info, [&](uint64_t generation) {
    return playback.session.pause(generation);
  });
}

napi_value resumePlayback(napi_env env, napi_callback_info info) {
  return generationCommand(env, info, [&](uint64_t generation) {
    return playback.session.resume(generation);
  });
}

napi_value stopPlayback(napi_env env, napi_callback_info info) {
  return generationCommand(env, info, [&](uint64_t generation) {
    return playback.session.stop(generation);
  });
}

napi_value reanchorPlayback(napi_env env, napi_callback_info info) {
  return generationCommand(env, info, [&](uint64_t generation) {
    return playback.session.reanchorTransport(generation);
  });
}

napi_value seekPlayback(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2]{};
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  uint64_t generation = 0;
  napi_valuetype type{};
  double frame = 0.0;
  if (argc != 2 || !exactU64(env, argv[0], &generation) ||
      napi_typeof(env, argv[1], &type) != napi_ok || type != napi_number ||
      napi_get_value_double(env, argv[1], &frame) != napi_ok ||
      !std::isfinite(frame) || std::floor(frame) != frame ||
      std::abs(frame) > static_cast<double>(kNativePlaybackMaximumJsSafeInteger))
    return resultValue(
        env, simpleFailure(NativePlaybackError::InvalidConfiguration,
                           generation, "Playback seek frame is invalid"));
  std::lock_guard<std::mutex> lock(playback.mutex);
  return resultValue(
      env, playback.session.seek(generation, static_cast<int64_t>(frame)));
}

napi_value setPlaybackLoop(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3]{};
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  uint64_t generation = 0;
  double start = 0.0;
  double end = 0.0;
  napi_valuetype startType{};
  napi_valuetype endType{};
  if (argc != 3 || !exactU64(env, argv[0], &generation) ||
      napi_typeof(env, argv[1], &startType) != napi_ok ||
      startType != napi_number ||
      napi_typeof(env, argv[2], &endType) != napi_ok ||
      endType != napi_number ||
      napi_get_value_double(env, argv[1], &start) != napi_ok ||
      napi_get_value_double(env, argv[2], &end) != napi_ok ||
      !std::isfinite(start) || !std::isfinite(end) ||
      std::floor(start) != start || std::floor(end) != end || start < 0 ||
      end <= start || end > static_cast<double>(kNativePlaybackMaximumJsSafeInteger))
    return resultValue(
        env, simpleFailure(NativePlaybackError::InvalidConfiguration,
                           generation, "Playback loop frames are invalid"));
  std::lock_guard<std::mutex> lock(playback.mutex);
  return resultValue(env, playback.session.setLoop(
                              generation, static_cast<int64_t>(start),
                              static_cast<int64_t>(end)));
}

napi_value clearPlaybackLoop(napi_env env, napi_callback_info info) {
  return generationCommand(env, info, [&](uint64_t generation) {
    return playback.session.clearLoop(generation);
  });
}

napi_value setPlaybackMasterGain(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2]{};
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  uint64_t generation = 0;
  napi_valuetype type{};
  double gain = 0.0;
  if (argc != 2 || !exactU64(env, argv[0], &generation) ||
      napi_typeof(env, argv[1], &type) != napi_ok || type != napi_number ||
      napi_get_value_double(env, argv[1], &gain) != napi_ok ||
      !std::isfinite(gain) || gain < 0 ||
      gain > kNativePlaybackMaximumLinearGain)
    return resultValue(
        env, simpleFailure(NativePlaybackError::InvalidConfiguration,
                           generation, "Playback master gain is invalid"));
  std::lock_guard<std::mutex> lock(playback.mutex);
  return resultValue(env, playback.session.setMasterGain(
                              generation, static_cast<float>(gain)));
}

napi_value setPlaybackLane(napi_env env, napi_callback_info info) {
  size_t argc = 5;
  napi_value argv[5]{};
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  uint64_t generation = 0;
  std::string id;
  napi_valuetype gainType{};
  napi_valuetype mutedType{};
  napi_valuetype soloType{};
  double gain = 0.0;
  bool muted = false;
  bool solo = false;
  napi_value wrapper{};
  napi_create_object(env, &wrapper);
  if (argc == 5)
    napi_set_named_property(env, wrapper, "id", argv[1]);
  if (argc != 5 || !exactU64(env, argv[0], &generation) ||
      !stringProperty(env, wrapper, "id", 96, &id) ||
      napi_typeof(env, argv[2], &gainType) != napi_ok ||
      gainType != napi_number ||
      napi_get_value_double(env, argv[2], &gain) != napi_ok ||
      !std::isfinite(gain) || gain < 0 ||
      gain > kNativePlaybackMaximumLinearGain ||
      napi_typeof(env, argv[3], &mutedType) != napi_ok ||
      mutedType != napi_boolean ||
      napi_get_value_bool(env, argv[3], &muted) != napi_ok ||
      napi_typeof(env, argv[4], &soloType) != napi_ok ||
      soloType != napi_boolean ||
      napi_get_value_bool(env, argv[4], &solo) != napi_ok)
    return resultValue(
        env, simpleFailure(NativePlaybackError::InvalidConfiguration,
                           generation, "Playback lane control is invalid"));
  std::lock_guard<std::mutex> lock(playback.mutex);
  return resultValue(env, playback.session.setLaneControl(
                              generation, id, static_cast<float>(gain), muted,
                              solo));
}

// The prepared lane envelopes for one generation, published once rather than
// on every status poll. Matches the phones' lanePeaks(generation), with one
// documented difference: `generation` goes out as a lossless decimal STRING
// here, as every 64-bit counter this addon publishes does, where the phones
// send a number.
napi_value playbackLanePeaks(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1]{};
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  uint64_t generation = 0;
  napi_value result{};
  napi_create_object(env, &result);
  if (argc != 1 || !exactU64(env, argv[0], &generation)) {
    setValue(env, result, "ok", makeBool(env, false));
    setValue(env, result, "error",
             makeString(env, nativePlaybackErrorName(
                                 NativePlaybackError::InvalidGeneration)));
    setCounter(env, result, "generation", 0);
    setValue(env, result, "bucketCount",
             makeNumber(env, kNativePlaybackLaneSummaryBuckets));
    napi_value empty{};
    napi_create_array_with_length(env, 0, &empty);
    setValue(env, result, "lanes", empty);
    setValue(env, result, "message",
             makeString(env, "Playback generation is invalid"));
    return result;
  }
  std::lock_guard<std::mutex> lock(playback.mutex);
  const NativePlaybackLanePeaksResult peaks =
      playback.session.lanePeaks(generation);
  setValue(env, result, "ok", makeBool(env, peaks.ok));
  setValue(env, result, "error",
           makeString(env, nativePlaybackErrorName(peaks.error)));
  setCounter(env, result, "generation", peaks.generation);
  setValue(env, result, "bucketCount", makeNumber(env, peaks.bucketCount));
  napi_value lanes{};
  napi_create_array_with_length(env, peaks.lanes.size(), &lanes);
  for (size_t index = 0; index < peaks.lanes.size(); ++index) {
    napi_value lane{};
    napi_create_object(env, &lane);
    setValue(env, lane, "id", makeString(env, peaks.lanes[index].id));
    setValue(env, lane, "peaksValid",
             makeBool(env, peaks.lanes[index].valid));
    const auto &values = peaks.lanes[index].peaks;
    napi_value array{};
    napi_create_array_with_length(env, values.size(), &array);
    for (size_t bucket = 0; bucket < values.size(); ++bucket)
      napi_set_element(env, array, bucket, makeNumber(env, values[bucket]));
    setValue(env, lane, "peaks", array);
    napi_set_element(env, lanes, index, lane);
  }
  setValue(env, result, "lanes", lanes);
  setValue(env, result, "message", makeString(env, peaks.message));
  return result;
}

napi_value unloadPlaybackWithRetention(napi_env env,
                                       napi_callback_info info,
                                       NativePlaybackLaneRetention retention) {
  size_t argc = 1;
  napi_value argv[1]{};
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  uint64_t generation = 0;
  if (argc != 1 || !exactU64(env, argv[0], &generation))
    return resultValue(
        env, simpleFailure(NativePlaybackError::InvalidGeneration, 0,
                           "Playback generation is invalid"));
  std::lock_guard<std::mutex> lock(playback.mutex);
  NativePlaybackUnloadReceipt receipt =
      playback.session.unloadWithCleanup(generation, retention);
  if (receipt.cleanup.globallyComplete()) {
    playback.handoffLease = receipt.cleanup.handoffLease;
    if (playback.generation != 0)
      playback.ownership->release(NativeAudioOwnerKind::Playback,
                                  playback.generation);
    playback.generation = 0;
    playback.provider.clear();
  }
  napi_value result = resultValue(env, receipt.playback);
  setValue(env, result, "cleanupComplete",
           makeBool(env, receipt.cleanup.globallyComplete()));
  setCounter(env, result, "retainedBytes", receipt.cleanup.retainedBytes);
  setCounter(env, result, "parkedLaneBytes", receipt.cleanup.parkedLaneBytes);
  setValue(env, result, "physicalOwnershipRetained",
           makeBool(env, receipt.cleanup.physicalOwnershipRetained));
  return result;
}

napi_value unloadPlayback(napi_env env, napi_callback_info info) {
  return unloadPlaybackWithRetention(env, info,
                                     NativePlaybackLaneRetention::Release);
}

// One argument and the same resolved object as unloadPlayback, matching the
// phones' unloadRetainingLanes: this generation's decoded lanes are kept for
// the very next prepare of the same files at the same rate.
napi_value unloadPlaybackRetainingLanes(napi_env env,
                                        napi_callback_info info) {
  return unloadPlaybackWithRetention(env, info,
                                     NativePlaybackLaneRetention::Park);
}

constexpr size_t kDesktopPlaybackGraphMaximumLabelBytes = 256;

bool validGraphSnapshot(const NativePlaybackStatus &status) noexcept {
  if (status.graphSnapshot == nullptr)
    return false;
  const NativePlaybackGraphSnapshot &snapshot = *status.graphSnapshot;
  if (snapshot.generation != status.generation ||
      snapshot.formatVersion == 0 || !std::isfinite(snapshot.sampleRate) ||
      snapshot.sampleRate <= 0.0 || snapshot.maximumFrames == 0 ||
      snapshot.nodes.empty() ||
      snapshot.nodes.size() > kNativePlaybackMaximumGraphNodes ||
      snapshot.connections.size() >
          kNativePlaybackMaximumGraphConnections ||
      snapshot.nodes.size() != status.graphNodeCount ||
      snapshot.connections.size() != status.graphConnectionCount ||
      snapshot.outputLatencyFrames != status.graphLatencyFrames ||
      snapshot.latencyCompensatedConnectionCount !=
          status.latencyCompensatedEdgeCount)
    return false;

  for (size_t index = 0; index < snapshot.nodes.size(); ++index) {
    const NativePlaybackGraphNodeStatus &node = snapshot.nodes[index];
    if (node.id == 0 || node.label.empty() ||
        node.label.size() > kDesktopPlaybackGraphMaximumLabelBytes ||
        graphNodeRoleName(node.role) == nullptr ||
        graphNodeKindName(node.kind) == nullptr ||
        node.inputBusCount > kNativePlaybackMaximumNodeBuses ||
        node.outputBusCount > kNativePlaybackMaximumNodeBuses ||
        node.intrinsicLatencyFrames >
            UINT32_MAX - node.arrivalLatencyFrames ||
        node.outputLatencyFrames !=
            node.arrivalLatencyFrames + node.intrinsicLatencyFrames)
      return false;
    for (size_t prior = 0; prior < index; ++prior)
      if (snapshot.nodes[prior].id == node.id)
        return false;
    for (uint32_t bus = 0; bus < node.inputBusCount; ++bus)
      if (node.inputBusChannels[bus] == 0)
        return false;
    for (uint32_t bus = 0; bus < node.outputBusCount; ++bus)
      if (node.outputBusChannels[bus] == 0)
        return false;
  }

  uint32_t inputBusTotal = 0;
  for (const NativePlaybackGraphNodeStatus &node : snapshot.nodes) {
    if (inputBusTotal > UINT32_MAX - node.inputBusCount)
      return false;
    inputBusTotal += node.inputBusCount;
  }
  if (inputBusTotal != snapshot.connections.size())
    return false;

  uint32_t compensated = 0;
  for (size_t index = 0; index < snapshot.connections.size(); ++index) {
    const NativePlaybackGraphConnectionStatus &connection =
        snapshot.connections[index];
    const auto source = std::find_if(
        snapshot.nodes.begin(), snapshot.nodes.end(), [&](const auto &node) {
          return node.id == connection.sourceNodeId;
        });
    const auto destination = std::find_if(
        snapshot.nodes.begin(), snapshot.nodes.end(), [&](const auto &node) {
          return node.id == connection.destinationNodeId;
        });
    if (source == snapshot.nodes.end() ||
        destination == snapshot.nodes.end() ||
        connection.sourceBus >= source->outputBusCount ||
        connection.destinationBus >= destination->inputBusCount ||
        connection.sourceChannels !=
            source->outputBusChannels[connection.sourceBus] ||
        connection.destinationChannels !=
            destination->inputBusChannels[connection.destinationBus] ||
        connection.sourceChannels != connection.destinationChannels ||
        connection.sourceOutputLatencyFrames != source->outputLatencyFrames ||
        connection.destinationArrivalLatencyFrames <
            connection.sourceOutputLatencyFrames ||
        connection.compensationFrames !=
            connection.destinationArrivalLatencyFrames -
                connection.sourceOutputLatencyFrames ||
        connection.latencyCompensated !=
            (connection.compensationFrames != 0))
      return false;
    for (size_t prior = 0; prior < index; ++prior)
      if (snapshot.connections[prior].destinationNodeId ==
              connection.destinationNodeId &&
          snapshot.connections[prior].destinationBus ==
              connection.destinationBus)
        return false;
    const uint32_t expectedArrival =
        destination->role == NativePlaybackGraphNodeRole::Output
            ? snapshot.outputLatencyFrames
            : destination->arrivalLatencyFrames;
    if (connection.destinationArrivalLatencyFrames != expectedArrival)
      return false;
    if (connection.latencyCompensated)
      ++compensated;
  }
  return compensated == snapshot.latencyCompensatedConnectionCount;
}

napi_value graphSnapshotValue(napi_env env,
                              const NativePlaybackStatus &status) {
  if (!validGraphSnapshot(status))
    return makeNull(env);
  const NativePlaybackGraphSnapshot &snapshot = *status.graphSnapshot;
  napi_value result{};
  napi_create_object(env, &result);
  setCounter(env, result, "generation", snapshot.generation);
  setValue(env, result, "formatVersion",
           makeNumber(env, snapshot.formatVersion));
  setValue(env, result, "sampleRate", makeNumber(env, snapshot.sampleRate));
  setValue(env, result, "maximumFrames",
           makeNumber(env, snapshot.maximumFrames));
  setValue(env, result, "outputLatencyFrames",
           makeNumber(env, snapshot.outputLatencyFrames));
  setValue(env, result, "latencyCompensatedConnectionCount",
           makeNumber(env, snapshot.latencyCompensatedConnectionCount));

  napi_value nodes{};
  napi_create_array_with_length(env, snapshot.nodes.size(), &nodes);
  for (size_t index = 0; index < snapshot.nodes.size(); ++index) {
    const NativePlaybackGraphNodeStatus &source = snapshot.nodes[index];
    napi_value node{};
    napi_create_object(env, &node);
    setCounter(env, node, "id", source.id);
    setValue(env, node, "label", makeString(env, source.label));
    setValue(env, node, "role",
             makeString(env, graphNodeRoleName(source.role)));
    setValue(env, node, "kind",
             makeString(env, graphNodeKindName(source.kind)));
    setCounter(env, node, "typeHigh", source.typeHigh);
    setCounter(env, node, "typeLow", source.typeLow);
    setValue(env, node, "schemaVersion",
             makeNumber(env, source.schemaVersion));
    setValue(env, node, "flags", makeNumber(env, source.flags));
    setValue(env, node, "inputBusCount",
             makeNumber(env, source.inputBusCount));
    setValue(env, node, "outputBusCount",
             makeNumber(env, source.outputBusCount));
    napi_value inputBuses{};
    napi_create_array_with_length(env, source.inputBusCount, &inputBuses);
    for (uint32_t bus = 0; bus < source.inputBusCount; ++bus)
      napi_set_element(env, inputBuses, bus,
                       makeNumber(env, source.inputBusChannels[bus]));
    setValue(env, node, "inputBusChannels", inputBuses);
    napi_value outputBuses{};
    napi_create_array_with_length(env, source.outputBusCount, &outputBuses);
    for (uint32_t bus = 0; bus < source.outputBusCount; ++bus)
      napi_set_element(env, outputBuses, bus,
                       makeNumber(env, source.outputBusChannels[bus]));
    setValue(env, node, "outputBusChannels", outputBuses);
    setValue(env, node, "intrinsicLatencyFrames",
             makeNumber(env, source.intrinsicLatencyFrames));
    setValue(env, node, "arrivalLatencyFrames",
             makeNumber(env, source.arrivalLatencyFrames));
    setValue(env, node, "outputLatencyFrames",
             makeNumber(env, source.outputLatencyFrames));
    napi_set_element(env, nodes, index, node);
  }
  setValue(env, result, "nodes", nodes);

  napi_value connections{};
  napi_create_array_with_length(env, snapshot.connections.size(),
                                &connections);
  for (size_t index = 0; index < snapshot.connections.size(); ++index) {
    const NativePlaybackGraphConnectionStatus &source =
        snapshot.connections[index];
    napi_value connection{};
    napi_create_object(env, &connection);
    setCounter(env, connection, "sourceNodeId", source.sourceNodeId);
    setValue(env, connection, "sourceBus", makeNumber(env, source.sourceBus));
    setValue(env, connection, "sourceChannels",
             makeNumber(env, source.sourceChannels));
    setCounter(env, connection, "destinationNodeId",
               source.destinationNodeId);
    setValue(env, connection, "destinationBus",
             makeNumber(env, source.destinationBus));
    setValue(env, connection, "destinationChannels",
             makeNumber(env, source.destinationChannels));
    setValue(env, connection, "sourceOutputLatencyFrames",
             makeNumber(env, source.sourceOutputLatencyFrames));
    setValue(env, connection, "destinationArrivalLatencyFrames",
             makeNumber(env, source.destinationArrivalLatencyFrames));
    setValue(env, connection, "compensationFrames",
             makeNumber(env, source.compensationFrames));
    setValue(env, connection, "latencyCompensated",
             makeBool(env, source.latencyCompensated));
    napi_set_element(env, connections, index, connection);
  }
  setValue(env, result, "connections", connections);
  return result;
}

napi_value playbackStatus(napi_env env, napi_callback_info) {
  std::lock_guard<std::mutex> lock(playback.mutex);
  const NativePlaybackStatus source = playback.session.status();
  napi_value result{};
  napi_create_object(env, &result);
  setCounter(env, result, "generation", source.generation);
  setValue(env, result, "state",
           makeString(env, playbackStateName(source.state)));
  setValue(env, result, "hostState",
           makeString(env, hostStateName(source.host.state)));
  setValue(env, result, "terminalReason",
           makeString(env, terminalReasonName(source.terminalReason)));
  setCounter(env, result, "terminalOrdinal", source.terminalOrdinal);
  setCounter(env, result, "transportGeneration",
             source.transportGeneration);
  setValue(env, result, "transportState",
           makeString(env, transportStateName(source.transportState)));
  setValue(env, result, "transportTelemetryQuality",
           makeString(env,
                      telemetryQualityName(source.transportTelemetryQuality)));
  setValue(env, result, "lastTransportBoundary",
           makeString(env, boundaryName(source.lastTransportBoundary)));
  setSignedCounter(env, result, "renderedProjectFrame",
                   source.renderedProjectFrame);
  setSignedCounter(env, result, "audibleProjectFrame",
                   source.audibleProjectFrame);
  setValue(env, result, "audibleProjectionQuality",
           makeString(env, audibleProjectionQualityName(
                               source.audibleProjectionQuality)));
  setCounter(env, result, "continuousFrame", source.continuousFrame);
  setCounter(env, result, "durationFrames", source.durationFrames);
  setCounter(env, result, "remainingPreRollFrames",
             source.remainingPreRollFrames);
  setValue(env, result, "cueEventsCompleted",
           makeNumber(env, source.cueEventsCompleted));
  setValue(env, result, "nextCueEventIndex",
           makeNumber(env, source.nextCueEventIndex));
  setCounter(env, result, "presentationLatencyFrames",
             source.presentationLatencyFrames);
  setCounter(env, result, "graphLatencyFrames", source.graphLatencyFrames);
  setCounter(env, result, "devicePresentationLatencyFrames",
             source.devicePresentationLatencyFrames);
  setCounter(env, result, "totalPresentationLatencyFrames",
             source.totalPresentationLatencyFrames);
  setCounter(env, result, "renderedFrames", source.renderedFrames);
  setCounter(env, result, "audibleFrames", source.audibleFrames);
  setCounter(env, result, "routeGeneration", source.host.routeGeneration);
  setCounter(env, result, "streamGeneration", source.host.streamGeneration);
  setCounter(env, result, "callbacks", source.host.callbacks);
  setCounter(env, result, "xruns", source.host.xruns);
  setCounter(env, result, "deadlineMisses", source.host.deadlineMisses);
  setCounter(env, result, "discontinuities", source.host.discontinuities);
  setCounter(env, result, "invalidCallbacks", source.host.invalidCallbacks);
  setCounter(env, result, "renderFailures", source.host.renderFailures);
  setValue(env, result, "loopEnabled", makeBool(env, source.loopEnabled));
  setSignedCounter(env, result, "loopStartFrame", source.loopStartFrame);
  setSignedCounter(env, result, "loopEndFrame", source.loopEndFrame);
  setCounter(env, result, "loopCount", source.loopCount);
  setCounter(env, result, "seekCount", source.seekCount);
  setCounter(env, result, "transportDiscontinuities",
             source.transportDiscontinuities);
  setValue(env, result, "playbackRate", makeNumber(env, source.playbackRate));
  setValue(env, result, "transposeSemitones",
           makeNumber(env, source.transposeSemitones));
  setCounter(env, result, "timePitchAnchorsPrepared",
             source.timePitchAnchorsPrepared);
  setCounter(env, result, "timePitchAnchorsPublished",
             source.timePitchAnchorsPublished);
  setCounter(env, result, "timePitchAnchorMisses",
             source.timePitchAnchorMisses);
  setValue(env, result, "timePitchReplacementReady",
           makeBool(env, source.timePitchReplacementReady));
  setValue(env, result, "timePitchLoopPriming",
           makeBool(env, source.timePitchLoopPriming));
  setSignedCounter(env, result, "preparedStartProjectFrame",
                   source.preparedStartProjectFrame);
  // The seam's own telemetry, spelled exactly as the phone bridges spell it.
  setCounter(env, result, "swapPendingGeneration", source.swapPendingGeneration);
  setCounter(env, result, "retiringSwapGeneration",
             source.retiringSwapGeneration);
  setValue(env, result, "swapLandings", makeNumber(env, source.swapLandings));
  setValue(env, result, "swapLateLandings",
           makeNumber(env, source.swapLateLandings));
  setCounter(env, result, "swapPrimeNs", source.swapPrimeNs);
  setCounter(env, result, "swapLandingFrames", source.swapLandingFrames);
  setCounter(env, result, "retainedBytes",
             static_cast<uint64_t>(source.retainedBytes));
  setCounter(env, result, "graphArenaBytes",
             static_cast<uint64_t>(source.graphArenaBytes));
  setCounter(env, result, "parkedLaneBytes",
             static_cast<uint64_t>(source.parkedLaneBytes));
  setValue(env, result, "parkedLaneCount",
           makeNumber(env, source.parkedLaneCount));
  setValue(env, result, "masterGain", makeNumber(env, source.masterGain));
  setValue(env, result, "referenceGain",
           makeNumber(env, source.referenceGain));
  setValue(env, result, "trainingEnabled",
           makeBool(env, source.trainingEnabled));
  napi_value trainingLanes{};
  napi_create_array_with_length(env, source.trainingLanes.size(),
                                &trainingLanes);
  for (size_t index = 0; index < source.trainingLanes.size(); ++index)
    napi_set_element(env, trainingLanes, index,
                     makeString(env, source.trainingLanes[index]));
  setValue(env, result, "trainingLanes", trainingLanes);
  setSignedCounter(env, result, "preRollFrames", source.preRollFrames);
  setValue(env, result, "cueEventCount",
           makeNumber(env, source.cueEventCount));
  setValue(env, result, "countInEventCount",
           makeNumber(env, source.countInEventCount));
  setValue(env, result, "countInBeatsPerBar",
           makeNumber(env, source.countInBeatsPerBar));
  setCounter(env, result, "previewClicksEnqueued",
             source.previewClicksEnqueued);
  setCounter(env, result, "previewClicksStarted", source.previewClicksStarted);
  setCounter(env, result, "previewClicksCompleted",
             source.previewClicksCompleted);
  setValue(env, result, "previewClicksPending",
           makeNumber(env, source.previewClicksPending));
  setValue(env, result, "laneDecodeFallback",
           makeString(env, source.laneDecodeFallback));
  setValue(env, result, "topology", makeString(env, source.topology));
  setValue(env, result, "graphNodeCount",
           makeNumber(env, source.graphNodeCount));
  setValue(env, result, "graphConnectionCount",
           makeNumber(env, source.graphConnectionCount));
  setValue(env, result, "latencyCompensatedEdgeCount",
           makeNumber(env, source.latencyCompensatedEdgeCount));
  setValue(env, result, "graphSnapshot", graphSnapshotValue(env, source));
  setValue(env, result, "adapterRenderFailures",
           makeNumber(env, source.adapterRenderFailures));
  // The same three the phones publish. Without them the desktop reads a
  // graph that refuses to render as an undifferentiated provider fault —
  // which is the state both phones were in until these were plumbed, one
  // platform further along.
  setValue(env, result, "graphStatusCode",
           makeNumber(env, source.graphStatusCode));
  setValue(env, result, "graphStatusDetail",
           makeNumber(env, source.graphStatusDetail));
  setValue(env, result, "timePitchAnchorOutcome",
           makeNumber(env, source.timePitchAnchorOutcome));
  setValue(env, result, "terminalRenderFailures",
           makeNumber(env, source.terminalRenderFailures));
  setValue(env, result, "parameterOverflows",
           makeNumber(env, source.parameterOverflows));
  setValue(env, result, "nonFiniteSamples",
           makeNumber(env, source.nonFiniteSamples));
  setValue(env, result, "rejectedBlocks",
           makeNumber(env, source.rejectedBlocks));
  setValue(env, result, "error", makeString(env, source.error));
  setFormat(env, result, source.host.format);
  setLatency(env, result, source.host.latency);
  napi_value lanes{};
  napi_create_array_with_length(env, source.lanes.size(), &lanes);
  for (size_t index = 0; index < source.lanes.size(); ++index) {
    napi_value lane{};
    napi_create_object(env, &lane);
    setValue(env, lane, "id", makeString(env, source.lanes[index].id));
    setCounter(env, lane, "cursorFrames", source.lanes[index].cursorFrames);
    setCounter(env, lane, "totalFrames", source.lanes[index].totalFrames);
    setValue(env, lane, "gain", makeNumber(env, source.lanes[index].gain));
    setValue(env, lane, "muted", makeBool(env, source.lanes[index].muted));
    setValue(env, lane, "solo", makeBool(env, source.lanes[index].solo));
    // No envelope here: it never changes for a generation. playbackLanePeaks
    // publishes it once instead.
    napi_set_element(env, lanes, index, lane);
  }
  setValue(env, result, "lanes", lanes);
  setValue(env, result, "capability",
           makeString(env, nativePlaybackSessionCapabilityTag()));
  return result;
}

} // namespace

void definePlaybackExports(napi_env env, napi_value exports,
                           NativeAudioOwnership *ownership,
                           DesktopPlaybackBackendFactory backendFactory) {
  playback.ownership = ownership;
  playback.backendFactory = backendFactory;
  napi_property_descriptor properties[] = {
      {"preparePlayback", nullptr, preparePlayback, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"openPlaybackOutput", nullptr, openPlaybackOutput, nullptr, nullptr,
       nullptr, napi_default, nullptr},
      {"startPlayback", nullptr, startPlayback, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"pausePlayback", nullptr, pausePlayback, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"resumePlayback", nullptr, resumePlayback, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"stopPlayback", nullptr, stopPlayback, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"seekPlayback", nullptr, seekPlayback, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"setPlaybackLoop", nullptr, setPlaybackLoop, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"clearPlaybackLoop", nullptr, clearPlaybackLoop, nullptr, nullptr,
       nullptr, napi_default, nullptr},
      {"reanchorPlayback", nullptr, reanchorPlayback, nullptr, nullptr,
       nullptr, napi_default, nullptr},
      {"setPlaybackLane", nullptr, setPlaybackLane, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"setPlaybackMasterGain", nullptr, setPlaybackMasterGain, nullptr,
       nullptr, nullptr, napi_default, nullptr},
      {"playbackStatus", nullptr, playbackStatus, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"unloadPlayback", nullptr, unloadPlayback, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"unloadPlaybackRetainingLanes", nullptr, unloadPlaybackRetainingLanes,
       nullptr, nullptr, nullptr, napi_default, nullptr},
      {"playbackLanePeaks", nullptr, playbackLanePeaks, nullptr, nullptr,
       nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports,
                         sizeof(properties) / sizeof(properties[0]),
                         properties);
}

void cleanupPlaybackBridge() noexcept {
  std::lock_guard<std::mutex> lock(playback.mutex);
  const uint64_t generation = playback.generation;
  if (generation == 0 || playback.ownership == nullptr)
    return;
  NativePlaybackUnloadReceipt receipt =
      playback.session.unloadWithCleanup(generation);
  if (receipt.cleanup.globallyComplete()) {
    playback.handoffLease = receipt.cleanup.handoffLease;
    playback.ownership->release(NativeAudioOwnerKind::Playback, generation);
    playback.generation = 0;
    playback.provider.clear();
  }
}

} // namespace singz

#include "microphone_mix_bridge.h"
#include "native_audio_ownership.h"
#include "../playback/microphone_mix.h"
#include "../playback/shared_audio_service.h"

#include <cmath>
#include <cstdint>
#include <exception>
#include <memory>
#include <mutex>
#include <string>

namespace singz {
namespace {
std::mutex control;
std::unique_ptr<MicrophoneMixSession> session;
NativeAudioOwnership* ownership = nullptr;

napi_value object(napi_env env) {
  napi_value result;
  napi_create_object(env, &result);
  return result;
}
void boolean(napi_env env, napi_value result, const char* key, bool value) {
  napi_value field;
  napi_get_boolean(env, value, &field);
  napi_set_named_property(env, result, key, field);
}
void number(napi_env env, napi_value result, const char* key, double value) {
  napi_value field;
  napi_create_double(env, value, &field);
  napi_set_named_property(env, result, key, field);
}
void text(napi_env env, napi_value result, const char* key, const std::string& value) {
  napi_value field;
  napi_create_string_utf8(env, value.data(), value.size(), &field);
  napi_set_named_property(env, result, key, field);
}
napi_value result(napi_env env, bool ok, const std::string& error = {}) {
  auto value = object(env);
  boolean(env, value, "ok", ok);
  if (!ok) text(env, value, "error", error);
  return value;
}
napi_value sourceDiagnostics(napi_env env, const MicrophoneMixSourceDiagnostics& source) {
  auto value = object(env);
  number(env, value, "channel", source.channel);
  boolean(env, value, "historyOnline", source.historyOnline);
  text(env, value, "historyCallbacks", std::to_string(source.historyCallbacks));
  text(env, value, "historyDiscontinuities", std::to_string(source.historyDiscontinuities));
  text(env, value, "unanchoredBlocks", std::to_string(source.unanchoredBlocks));
  text(env, value, "unanchoredFrames", std::to_string(source.unanchoredFrames));
  number(env, value, "measuredRate", source.measuredRate);
  text(env, value, "lastHostNs", std::to_string(source.lastHostNs));
  text(env, value, "publishedEndHostNs", std::to_string(source.publishedEndHostNs));
  auto missing = object(env);
  text(env, missing, "invalidRequest", std::to_string(source.missingFramesByReason.invalidRequest));
  text(env, missing, "offline", std::to_string(source.missingFramesByReason.offline));
  text(env, missing, "anchorUnavailable", std::to_string(source.missingFramesByReason.anchorUnavailable));
  text(env, missing, "clockMapping", std::to_string(source.missingFramesByReason.clockMapping));
  text(env, missing, "resamplingSupport", std::to_string(source.missingFramesByReason.resamplingSupport));
  text(env, missing, "generationChanged", std::to_string(source.missingFramesByReason.generationChanged));
  napi_set_named_property(env, value, "missingFramesByReason", missing);
  text(env, value, "unpublishedSampleReads", std::to_string(source.unpublishedSampleReads));
  text(env, value, "expiredSampleReads", std::to_string(source.expiredSampleReads));
  text(env, value, "racingSampleReads", std::to_string(source.racingSampleReads));
  text(env, value, "absentSampleReads", std::to_string(source.absentSampleReads));
  text(env, value, "verifiedClockSteps", std::to_string(source.verifiedClockSteps));
  text(env, value, "maximumVerifiedClockStepNs", std::to_string(source.maximumVerifiedClockStepNs));
  return value;
}
bool property(napi_env env, napi_value value, const char* key, napi_value* field) {
  napi_valuetype type;
  napi_value nullValue;
  bool isNull = false;
  return napi_typeof(env, value, &type) == napi_ok && type == napi_object &&
      napi_get_null(env, &nullValue) == napi_ok &&
      napi_strict_equals(env, value, nullValue, &isNull) == napi_ok && !isNull &&
      napi_get_named_property(env, value, key, field) == napi_ok;
}
bool undefined(napi_env env, napi_value value) {
  napi_valuetype type;
  return napi_typeof(env, value, &type) == napi_ok && type == napi_undefined;
}
bool finiteNumber(napi_env env, napi_value value, double* number) {
  return napi_get_value_double(env, value, number) == napi_ok && std::isfinite(*number);
}
bool readConfig(napi_env env, napi_value value, MicrophoneMixConfig* config) {
  napi_value field;
  size_t length = 0;
  if (!property(env, value, "deviceUid", &field) ||
      napi_get_value_string_utf8(env, field, nullptr, 0, &length) != napi_ok ||
      length == 0 || length > 4096) return false;
  config->deviceUid.resize(length + 1);
  if (napi_get_value_string_utf8(env, field, config->deviceUid.data(),
                               config->deviceUid.size(), &length) != napi_ok) return false;
  config->deviceUid.resize(length);
  if (config->deviceUid.find('\0') != std::string::npos) return false;
  bool hasOutput = false;
  if (napi_has_named_property(env, value, "outputDeviceUid", &hasOutput) != napi_ok) return false;
  if (hasOutput) {
    if (!property(env, value, "outputDeviceUid", &field)) return false;
    if (!undefined(env, field)) {
      if (napi_get_value_string_utf8(env, field, nullptr, 0, &length) != napi_ok ||
          length == 0 || length > 4096) return false;
      config->outputDeviceUid.resize(length + 1);
      if (napi_get_value_string_utf8(env, field, config->outputDeviceUid.data(),
                                   config->outputDeviceUid.size(), &length) != napi_ok) return false;
      config->outputDeviceUid.resize(length);
      if (config->outputDeviceUid.find('\0') != std::string::npos) return false;
    }
  }
  napi_value channels;
  bool array = false;
  uint32_t count = 0;
  if (!property(env, value, "channels", &channels) ||
      napi_is_array(env, channels, &array) != napi_ok || !array ||
      napi_get_array_length(env, channels, &count) != napi_ok || count == 0 || count > 8)
    return false;
  config->channels.reserve(count);
  for (uint32_t index = 0; index < count; ++index) {
    napi_value row;
    double channel = 0, gain = 0, pan = 0;
    bool muted = false;
    if (napi_get_element(env, channels, index, &row) != napi_ok ||
        !property(env, row, "channel", &field) || !finiteNumber(env, field, &channel) ||
        channel < 0 || channel > UINT32_MAX || std::floor(channel) != channel ||
        !property(env, row, "gain", &field) || !finiteNumber(env, field, &gain) ||
        gain < 0 || gain > 1 || !property(env, row, "muted", &field) ||
        napi_get_value_bool(env, field, &muted) != napi_ok) return false;
    for (const auto& prior : config->channels)
      if (prior.channel == static_cast<uint32_t>(channel)) return false;
    bool hasPan = false;
    if (napi_has_named_property(env, row, "pan", &hasPan) != napi_ok) return false;
    if (hasPan) {
      if (!property(env, row, "pan", &field)) return false;
      if (!undefined(env, field) && (!finiteNumber(env, field, &pan) || pan < -1 || pan > 1))
        return false;
    }
    config->channels.push_back({static_cast<uint32_t>(channel), static_cast<float>(gain), muted,
                               static_cast<float>(pan)});
  }
  bool present = false;
  if (napi_has_named_property(env, value, "delayFrames", &present) != napi_ok) return false;
  if (present) {
    double delay = 0;
    if (!property(env, value, "delayFrames", &field)) return false;
    if (!undefined(env, field)) {
      if (!finiteNumber(env, field, &delay) || delay < 256 || delay > 8192 ||
          std::floor(delay) != delay) return false;
      config->delayFrames = static_cast<uint32_t>(delay);
    }
  }
  return true;
}
napi_value configure(napi_env env, napi_callback_info info) {
  size_t count = 1;
  napi_value argument;
  napi_get_cb_info(env, info, &count, &argument, nullptr, nullptr);
  MicrophoneMixConfig config;
  if (count != 1 || !readConfig(env, argument, &config))
    return result(env, false, "Microphone mixing requires valid input/output device UIDs, 1–8 unique channels, gains 0–1, boolean mute values, optional pan −1–1 and an optional 256–8192-frame delay");
#if !defined(__linux__) || defined(__ANDROID__)
  return result(env, false, "Microphone and song mixing is currently available only with Linux ALSA");
#else
  std::lock_guard<std::mutex> lock(control);
  if (ownership && ownership->snapshot().kind == NativeAudioOwnerKind::Monitor)
    return result(env, false, "Stop exclusive headphone monitoring before mixing microphones with playback");
  if (sharedAudioService().providerId() != "alsa")
    return result(env, false, "Select the ALSA playback provider before mixing microphones");
  if (!session) session = std::make_unique<MicrophoneMixSession>(sharedAudioService());
  const auto started = session->start(config);
  return result(env, started.ok, started.error);
#endif
}
napi_value stop(napi_env env, napi_callback_info) {
  std::lock_guard<std::mutex> lock(control);
  if (session) session->stop();
  session.reset();
  return result(env, true);
}
napi_value status(napi_env env, napi_callback_info) {
  std::lock_guard<std::mutex> lock(control);
  const auto current = session ? session->status() : MicrophoneMixStatus{};
  auto value = result(env, true);
  boolean(env, value, "active", current.active);
  // Decimal strings preserve uint64 counter precision across IPC.
  text(env, value, "callbacks", std::to_string(current.callbacks));
  text(env, value, "missingFrames", std::to_string(current.missingFrames));
  text(env, value, "failures", std::to_string(current.failures));
  number(env, value, "sampleRate", current.sampleRate);
  text(env, value, "error", current.error);
  napi_value diagnostics;
  napi_create_array_with_length(env, current.diagnostics.size(), &diagnostics);
  for (uint32_t index = 0; index < current.diagnostics.size(); ++index)
    napi_set_element(env, diagnostics, index, sourceDiagnostics(env, current.diagnostics[index]));
  napi_set_named_property(env, value, "diagnostics", diagnostics);
  return value;
}
template <napi_value (*Call)(napi_env, napi_callback_info)>
napi_value guarded(napi_env env, napi_callback_info info) noexcept {
  try { return Call(env, info); }
  catch (const std::exception& error) { return result(env, false, error.what()); }
  catch (...) { return result(env, false, "Native microphone mixing failed"); }
}
} // namespace

void defineMicrophoneMixExports(napi_env env, napi_value exports,
                                NativeAudioOwnership* owner) {
  ownership = owner;
  napi_property_descriptor properties[] = {
      {"configureMicrophoneMix", nullptr, guarded<configure>, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"stopMicrophoneMix", nullptr, guarded<stop>, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"microphoneMixStatus", nullptr, guarded<status>, nullptr, nullptr, nullptr, napi_default, nullptr}};
  napi_define_properties(env, exports, 3, properties);
}
void cleanupMicrophoneMix() noexcept {
  std::lock_guard<std::mutex> lock(control);
  if (session) session->stop();
  session.reset();
}
bool microphoneMixActive() noexcept {
  std::lock_guard<std::mutex> lock(control);
  try { return session && session->status().active; }
  catch (...) { return true; } // Retain the exclusive-monitor gate on uncertain teardown.
}
} // namespace singz

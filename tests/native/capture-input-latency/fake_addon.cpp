// Compile the real addon entry point with fake device providers. No production
// test exports or environment switches are introduced.
#include <node_api.h>
static void installFakeInput();
static napi_value addOwnershipFixtureExports(napi_env, napi_value);
#undef NAPI_MODULE
#define NAPI_MODULE(modname, regfunc) NAPI_MODULE_INIT() { installFakeInput(); return addOwnershipFixtureExports(env, regfunc(env, exports)); }
#ifndef SINGZ_CAPTURE_ADDON_SOURCE
#define SINGZ_CAPTURE_ADDON_SOURCE "native/electron/capture_addon.cpp"
#endif
#include SINGZ_CAPTURE_ADDON_SOURCE
#include <zcore/device/audio_input_backend.h>
#include <zcore/device/audio_host_fake.h>

namespace {
class LatencyFakeInput final : public singz::AudioInputBackend {
 public:
  singz::AudioInputResult open(const singz::AudioInputConfig& config, singz::AudioInputPush, void*) override {
    channel_ = config.channel;
    return result(singz::AudioInputState::Starting);
  }
  singz::AudioInputResult start() override { return result(singz::AudioInputState::Running); }
  void stop() override {}
  bool suspendPrepared() override { return true; }
  bool takeFailure(std::string&) override {
    // Channel 2 models a benign shared-buffer/latency notification after open.
    if (channel_ == 2) stable_->store(false, std::memory_order_release);
    return false;
  }
 private:
  singz::AudioInputResult result(singz::AudioInputState state) {
    auto r = singz::AudioInputResult::success(state, 48000, channel_);
    r.inputLatencyStable = stable_;
    if (channel_ != 1) {
      r.inputLatencyFrames = 1168;
      r.inputBufferFrames = 512;
      r.inputLatencySource = "reported";
    }
    return r;
  }
  uint32_t channel_ = 0;
  std::shared_ptr<std::atomic<bool>> stable_ = std::make_shared<std::atomic<bool>>(true);
};
std::unique_ptr<singz::AudioInputBackend> fakeInput() { return std::make_unique<LatencyFakeInput>(); }
}
static void installFakeInput() {
  singz::setAudioInputBackendForTests(fakeInput, {});
  (void)singz::sharedVoiceMonitorCapture(fakeInput);
  const auto result = singz::sharedAudioService().configureProvider(singz::createFakeAudioHostBackend(), "latency-fixture");
  if (!result.ok) throw std::runtime_error("could not install latency fixture output");
}

// Test-only probes use the real addon-wide arbitration object; production
// exposes none of these methods.
static napi_value fixtureOwnership(napi_env env, napi_callback_info) {
  const auto held = nativeAudioOwnership.snapshot();
  return stringValue(env, held.kind == singz::NativeAudioOwnerKind::Capture
      ? std::to_string(held.generation) : "0");
}
static napi_value fixtureCanAcquire(napi_env env, napi_callback_info) {
  constexpr uint64_t otherGeneration = 987654321;
  const bool acquired = nativeAudioOwnership.acquire(singz::NativeAudioOwnerKind::Capture,
      otherGeneration) == singz::NativeAudioAcquireResult::Acquired;
  if (acquired) nativeAudioOwnership.release(singz::NativeAudioOwnerKind::Capture, otherGeneration);
  return boolValue(env, acquired);
}
static napi_value fixtureForceCleanup(napi_env env, napi_callback_info) {
  std::lock_guard<std::mutex> lock(owner.mutex);
  stopLocked(owner.generation, true);
  return undefined(env);
}
static napi_value addOwnershipFixtureExports(napi_env env, napi_value exports) {
  const napi_property_descriptor properties[] = {
    {"fixtureCaptureOwnership", nullptr, fixtureOwnership, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"fixtureCanAcquireCapture", nullptr, fixtureCanAcquire, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"fixtureForceCaptureCleanup", nullptr, fixtureForceCleanup, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, std::size(properties), properties);
  return exports;
}

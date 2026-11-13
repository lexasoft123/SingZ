// Compile the real addon entry point with fake device providers. No production
// test exports or environment switches are introduced.
#include <node_api.h>
static void installFakeInput();
#undef NAPI_MODULE
#define NAPI_MODULE(modname, regfunc) NAPI_MODULE_INIT() { installFakeInput(); return regfunc(env, exports); }
#include "native/electron/capture_addon.cpp"
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
  const auto result = singz::sharedAudioService().configureProvider(singz::createFakeAudioHostBackend(), "latency-fixture");
  if (!result.ok) throw std::runtime_error("could not install latency fixture output");
}

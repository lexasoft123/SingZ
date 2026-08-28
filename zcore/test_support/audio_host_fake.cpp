#include <zcore/device/audio_host_fake.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <thread>
#include <utility>
#include <vector>

#include <zcore/device/audio_host_callback.h>

namespace singz {
namespace {

constexpr const char* kFakeUid = "singz:fake-duplex";

AudioHostResult failure(AudioHostError error, AudioHostState state,
                        const char* message) {
  return {false, error, state, {}, {}, message};
}

bool uniqueChannels(const std::vector<uint32_t>& channels,
                    uint32_t deviceChannels) {
  if (channels.empty() || channels.size() > kAudioHostMaxChannels) return false;
  for (size_t i = 0; i < channels.size(); ++i) {
    if (channels[i] >= deviceChannels) return false;
    for (size_t j = 0; j < i; ++j) {
      if (channels[i] == channels[j]) return false;
    }
  }
  return true;
}

class FakeAudioHostBackend final : public AudioHostBackend {
 public:
  explicit FakeAudioHostBackend(FakeAudioHostOptions options) : options_(options) {}
  ~FakeAudioHostBackend() override { stop(); }

  AudioHostInventory enumerate() const override {
    AudioHostDeviceInfo device;
    device.uid = kFakeUid;
    device.label = "SingZ deterministic duplex fixture";
    device.defaultInput = true;
    device.defaultOutput = true;
    device.inputChannels = 8;
    device.outputChannels = 8;
    for (uint32_t channel = 0; channel < 8; ++channel) {
      device.inputChannelLabels.push_back("Input " + std::to_string(channel + 1));
      device.outputChannelLabels.push_back("Output " + std::to_string(channel + 1));
    }
    device.nominalSampleRate = 48000.0;
    device.sampleRateRanges = {{44100.0, 44100.0}, {48000.0, 48000.0},
                               {96000.0, 96000.0}};
    device.bufferFrames = {1, 1024, 128, 1};
    device.transport = AudioHostTransport::Usb;
    device.monitoringSuitability =
        AudioHostMonitoringSuitability::LowLatency;
    return {{std::move(device)}, kFakeUid, kFakeUid};
  }

  AudioHostResult open(const AudioHostConfig& config, AudioHostRender render,
                       void* renderContext) override {
    if (state_.load(std::memory_order_acquire) == AudioHostState::Running) {
      return failure(AudioHostError::InvalidState, AudioHostState::Running,
                     "Stop the fake host before opening it again");
    }
    if (config.inputDeviceUid != kFakeUid || config.outputDeviceUid != kFakeUid) {
      return reject(AudioHostError::DeviceNotFound, AudioHostState::Error,
                    "The fake duplex device UID is singz:fake-duplex");
    }
    const double rate = config.requestedSampleRate == 0.0
                            ? 48000.0
                            : config.requestedSampleRate;
    const uint32_t frames = config.requestedBufferFrames == 0
                                ? 128
                                : config.requestedBufferFrames;
    if ((rate != 44100.0 && rate != 48000.0 && rate != 96000.0) || frames == 0 ||
        frames > 1024 || config.maximumFrames < frames ||
        config.maximumFrames > kAudioHostMaxFrames ||
        !uniqueChannels(config.inputChannels, 8) ||
        !uniqueChannels(config.outputChannels, 8) || render == nullptr) {
      return reject(AudioHostError::InvalidConfiguration, AudioHostState::Error,
                    "Unsupported fake host rate, buffer, channel map, or render thunk");
    }
    stop();
    format_ = {rate, config.maximumFrames, frames,
               static_cast<uint32_t>(config.inputChannels.size()),
               static_cast<uint32_t>(config.outputChannels.size()), true, true,
               config.exclusive ? AudioHostAccessMode::Exclusive
                                : AudioHostAccessMode::Shared};
    latency_ = {frames, frames, frames, 0};
    inputSamples_.assign(static_cast<size_t>(format_.inputChannels) *
                             format_.maximumFrames,
                         0.0F);
    outputSamples_.assign(static_cast<size_t>(format_.outputChannels) *
                              format_.maximumFrames,
                          0.0F);
    inputPointers_.resize(format_.inputChannels);
    outputPointers_.resize(format_.outputChannels);
    for (uint32_t c = 0; c < format_.inputChannels; ++c) {
      inputPointers_[c] = inputSamples_.data() +
                          static_cast<size_t>(c) * format_.maximumFrames;
    }
    for (uint32_t c = 0; c < format_.outputChannels; ++c) {
      outputPointers_[c] = outputSamples_.data() +
                           static_cast<size_t>(c) * format_.maximumFrames;
    }
    resetCounters();
    routeGeneration_.fetch_add(1, std::memory_order_relaxed);
    streamGeneration_.fetch_add(1, std::memory_order_relaxed);
    prepareAudioHostCallback(&endpoint_, render, renderContext);
    state_.store(AudioHostState::Open, std::memory_order_release);
    return {true, AudioHostError::None, AudioHostState::Open, format_, latency_, {}};
  }

  AudioHostResult start() override {
    if (state_.load(std::memory_order_acquire) != AudioHostState::Open) {
      return failure(AudioHostError::InvalidState,
                     state_.load(std::memory_order_relaxed),
                     "Reopen the fake host before starting it");
    }
    if (worker_.joinable()) worker_.join();
    stopRequested_.store(false, std::memory_order_release);
    activateAudioHostCallback(&endpoint_);
    state_.store(AudioHostState::Running, std::memory_order_release);
    worker_ = std::thread([this] { run(); });
    return {true, AudioHostError::None, AudioHostState::Running, format_, latency_, {}};
  }

  void stop() noexcept override {
    stopRequested_.store(true, std::memory_order_release);
    deactivateAudioHostCallback(&endpoint_);
    if (worker_.joinable()) worker_.join();
    while (endpoint_.inFlight.load(std::memory_order_acquire) != 0) {
      std::this_thread::yield();
    }
    const AudioHostState old = state_.load(std::memory_order_acquire);
    if (old != AudioHostState::Closed && old != AudioHostState::Error) {
      state_.store(AudioHostState::Stopped, std::memory_order_release);
    }
  }

  AudioHostStatus status() const noexcept override {
    AudioHostStatus result;
    result.state = state_.load(std::memory_order_acquire);
    result.format = format_;
    result.latency = latency_;
    result.routeGeneration = routeGeneration_.load(std::memory_order_relaxed);
    result.streamGeneration = streamGeneration_.load(std::memory_order_relaxed);
    result.callbacks = endpoint_.callbacks.load(std::memory_order_relaxed);
    result.renderedFrames = endpoint_.renderedFrames.load(std::memory_order_relaxed);
    result.xruns = endpoint_.xruns.load(std::memory_order_relaxed);
    result.deadlineMisses = endpoint_.deadlineMisses.load(std::memory_order_relaxed);
    result.discontinuities = endpoint_.discontinuities.load(std::memory_order_relaxed);
    result.invalidCallbacks = endpoint_.invalidCallbacks.load(std::memory_order_relaxed);
    result.renderFailures = endpoint_.renderFailures.load(std::memory_order_relaxed);
    return result;
  }

 private:
  AudioHostResult reject(AudioHostError error, AudioHostState state,
                         const char* message) noexcept {
    state_.store(state, std::memory_order_release);
    return failure(error, state, message);
  }

  void resetCounters() noexcept {
    endpoint_.callbacks.store(0, std::memory_order_relaxed);
    endpoint_.renderedFrames.store(0, std::memory_order_relaxed);
    endpoint_.xruns.store(0, std::memory_order_relaxed);
    endpoint_.deadlineMisses.store(0, std::memory_order_relaxed);
    endpoint_.discontinuities.store(0, std::memory_order_relaxed);
    endpoint_.invalidCallbacks.store(0, std::memory_order_relaxed);
    endpoint_.renderFailures.store(0, std::memory_order_relaxed);
  }

  void run() noexcept {
    constexpr uint32_t pattern[] = {1, 128, 1024, 17, 257, 64};
    uint64_t outputFrame = 0;
    const auto start = std::chrono::steady_clock::now();
    for (uint32_t index = 0;
         index < options_.callbackCount &&
         !stopRequested_.load(std::memory_order_acquire);
         ++index) {
      uint32_t frames = options_.varyingBlocks
                            ? pattern[index % (sizeof(pattern) / sizeof(pattern[0]))]
                            : format_.nominalBufferFrames;
      frames = std::min(frames, format_.maximumFrames);
      for (uint32_t channel = 0; channel < format_.inputChannels; ++channel) {
        float* samples = inputSamples_.data() +
                         static_cast<size_t>(channel) * format_.maximumFrames;
        for (uint32_t frame = 0; frame < frames; ++frame) {
          samples[frame] = static_cast<float>((channel + 1) * 1000 +
                                              ((outputFrame + frame) % 997));
        }
      }
      for (uint32_t channel = 0; channel < format_.outputChannels; ++channel) {
        std::fill_n(outputPointers_[channel], frames, 7.0F);
      }
      const auto now = std::chrono::steady_clock::now();
      const uint64_t hostNs = static_cast<uint64_t>(
          std::chrono::duration_cast<std::chrono::nanoseconds>(now - start).count());
      uint32_t discontinuity = index == 0 ? AudioHostDiscontinuityStart
                                         : AudioHostDiscontinuityNone;
      if (options_.injectXRunAt != 0 && index + 1 == options_.injectXRunAt) {
        discontinuity |= AudioHostDiscontinuityXRun;
        recordAudioHostXRun(&endpoint_);
      }
      if (options_.injectDeadlineMissAt != 0 &&
          index + 1 == options_.injectDeadlineMissAt) {
        recordAudioHostDeadlineMiss(&endpoint_);
      }
      AudioHostRenderBlock block{
          inputPointers_.data(), outputPointers_.data(), format_.inputChannels,
          format_.outputChannels, frames, format_.maximumFrames, format_.sampleRate,
          1, routeGeneration_.load(std::memory_order_relaxed),
          streamGeneration_.load(std::memory_order_relaxed), index, outputFrame,
          hostNs, true, false, outputFrame, hostNs, hostNs, discontinuity, true};
      invokeAudioHostCallback(&endpoint_, block);
      outputFrame += frames;
    }
    if (!stopRequested_.load(std::memory_order_acquire)) {
      state_.store(AudioHostState::Stopped, std::memory_order_release);
    }
  }

  FakeAudioHostOptions options_;
  AudioHostCallbackEndpoint endpoint_{};
  std::atomic<AudioHostState> state_{AudioHostState::Closed};
  std::atomic<bool> stopRequested_{false};
  std::atomic<uint64_t> routeGeneration_{0};
  std::atomic<uint64_t> streamGeneration_{0};
  AudioHostFormat format_{};
  AudioHostLatency latency_{};
  std::vector<float> inputSamples_;
  std::vector<float> outputSamples_;
  std::vector<const float*> inputPointers_;
  std::vector<float*> outputPointers_;
  std::thread worker_;
};

}  // namespace

std::unique_ptr<AudioHostBackend> createFakeAudioHostBackend(
    FakeAudioHostOptions options) {
  return std::make_unique<FakeAudioHostBackend>(options);
}

}  // namespace singz

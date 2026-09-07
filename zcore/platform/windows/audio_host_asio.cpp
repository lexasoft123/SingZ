#include "audio_host_asio.h"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstddef>
#include <utility>

#include <zcore/device/audio_host_callback.h>

namespace singz {
namespace {

static_assert(std::atomic<AudioHostState>::is_always_lock_free);
static_assert(std::atomic<uint64_t>::is_always_lock_free);

class UnavailableAsioAudioHostBackend final : public AudioHostBackend {
 public:
  AudioHostInventory enumerate() const override { return {}; }

  AudioHostResult open(const AudioHostConfig &, AudioHostRender,
                       void *) override {
    return failure();
  }

  AudioHostResult start() override { return failure(); }
  void stop() noexcept override {}

  AudioHostStatus status() const noexcept override {
    return {AudioHostState::Unsupported};
  }

 private:
  static AudioHostResult failure() {
    return {false, AudioHostError::Unsupported, AudioHostState::Unsupported,
            {}, {}, kAsioSdkUnavailableReason};
  }
};

AudioHostError hostError(AsioDriverError error) noexcept {
  switch (error) {
    case AsioDriverError::None:
      return AudioHostError::None;
    case AsioDriverError::Unavailable:
    case AsioDriverError::UnsupportedFormat:
      return AudioHostError::Unsupported;
    case AsioDriverError::InvalidState:
      return AudioHostError::InvalidState;
    case AsioDriverError::InvalidConfiguration:
      return AudioHostError::InvalidConfiguration;
    case AsioDriverError::DeviceNotFound:
    case AsioDriverError::DeviceLost:
      return AudioHostError::DeviceNotFound;
    case AsioDriverError::Failure:
      return AudioHostError::ProviderFailure;
  }
  return AudioHostError::ProviderFailure;
}

AudioHostState hostState(AsioDriverState state) noexcept {
  switch (state) {
    case AsioDriverState::Closed:
      return AudioHostState::Closed;
    case AsioDriverState::Open:
      return AudioHostState::Open;
    case AsioDriverState::Running:
      return AudioHostState::Running;
    case AsioDriverState::Stopped:
      return AudioHostState::Stopped;
    case AsioDriverState::DeviceLost:
      return AudioHostState::DeviceLost;
    case AsioDriverState::Error:
      return AudioHostState::Error;
  }
  return AudioHostState::Error;
}

bool validChannelMap(const std::vector<uint32_t> &channels,
                     uint32_t available) noexcept {
  if (channels.size() > kAudioHostMaxChannels) return false;
  for (std::size_t index = 0; index < channels.size(); ++index) {
    if (channels[index] >= available) return false;
    for (std::size_t prior = 0; prior < index; ++prior) {
      if (channels[prior] == channels[index]) return false;
    }
  }
  return true;
}

bool supportedRate(const AsioDriverDevice &device, double rate) noexcept {
  return std::isfinite(rate) && rate > 0.0 &&
         std::find(device.sampleRates.begin(), device.sampleRates.end(), rate) !=
             device.sampleRates.end();
}

bool validBufferFrames(const AudioHostBufferRange &range,
                       uint32_t requested) noexcept {
  if (requested == 0 || range.minimumFrames == 0 ||
      range.maximumFrames < range.minimumFrames ||
      requested < range.minimumFrames || requested > range.maximumFrames)
    return false;
  return range.fundamentalFrames == 0 ||
         (requested - range.minimumFrames) % range.fundamentalFrames == 0;
}

class AsioAudioHostBackend final : public AudioHostBackend {
 public:
  explicit AsioAudioHostBackend(std::unique_ptr<AsioDriverApi> driver)
      : driver_(std::move(driver)) {}

  ~AsioAudioHostBackend() override { stop(); }

  AudioHostInventory enumerate() const override {
    AudioHostInventory result;
    if (!driver_ || !driver_->probe().available) return result;
    const AsioDriverInventory inventory = driver_->enumerate();
    result.defaultInputUid = inventory.defaultUid;
    result.defaultOutputUid = inventory.defaultUid;
    result.devices.reserve(inventory.devices.size());
    for (const auto &device : inventory.devices) {
      if (device.uid.empty() || device.outputChannels == 0 ||
          device.outputChannels > kAudioHostMaxChannels ||
          device.inputChannels > kAudioHostMaxChannels)
        continue;
      AudioHostDeviceInfo info;
      info.uid = device.uid;
      info.label = device.label;
      info.defaultInput = device.uid == inventory.defaultUid &&
                          device.inputChannels != 0;
      info.defaultOutput = device.uid == inventory.defaultUid;
      info.inputChannels = device.inputChannels;
      info.outputChannels = device.outputChannels;
      info.inputChannelLabels = device.inputChannelLabels;
      info.outputChannelLabels = device.outputChannelLabels;
      info.nominalSampleRate = device.sampleRates.empty()
                                   ? 0.0
                                   : device.sampleRates.front();
      info.sampleRateRanges.reserve(device.sampleRates.size());
      for (const double rate : device.sampleRates) {
        if (std::isfinite(rate) && rate > 0.0)
          info.sampleRateRanges.push_back({rate, rate});
      }
      info.bufferFrames = device.bufferFrames;
      info.direction = device.inputChannels == 0
                           ? AudioHostEndpointDirection::Output
                           : AudioHostEndpointDirection::Duplex;
      info.accessMode = AudioHostAccessMode::Exclusive;
      info.transport = AudioHostTransport::Unknown;
      info.monitoringSuitability =
          AudioHostMonitoringSuitability::LowLatency;
      result.devices.push_back(std::move(info));
    }
    return result;
  }

  AudioHostResult open(const AudioHostConfig &config, AudioHostRender render,
                       void *renderContext) override {
    if (!driver_) return fail(AudioHostError::Unsupported,
                              AudioHostState::Unsupported,
                              kAsioSdkUnavailableReason);
    if (state_.load(std::memory_order_acquire) == AudioHostState::Running)
      return fail(AudioHostError::InvalidState, AudioHostState::Running,
                  "Stop the ASIO stream before opening another driver");
    stop();
    format_ = {};
    latency_ = {};
    const AsioDriverProbe availability = driver_->probe();
    if (!availability.available)
      return fail(AudioHostError::Unsupported, AudioHostState::Unsupported,
                  availability.detail.empty() ? "ASIO runtime is unavailable"
                                               : availability.detail);
    if (!config.exclusive)
      return fail(AudioHostError::InvalidConfiguration,
                  AudioHostState::Error,
                  "ASIO is an exclusive provider; shared mode is not valid");
    if (config.outputDeviceUid.empty() || config.outputChannels.empty() ||
        (config.inputDeviceUid.empty() != config.inputChannels.empty()) ||
        (!config.inputDeviceUid.empty() &&
         config.inputDeviceUid != config.outputDeviceUid) ||
        config.maximumFrames == 0 ||
        config.maximumFrames > kAudioHostMaxFrames || render == nullptr)
      return fail(AudioHostError::InvalidConfiguration, AudioHostState::Error,
                  "ASIO requires one driver, valid channel maps, and a bounded callback");

    const AsioDriverInventory inventory = driver_->enumerate();
    const auto found = std::find_if(
        inventory.devices.begin(), inventory.devices.end(),
        [&](const auto &device) { return device.uid == config.outputDeviceUid; });
    if (found == inventory.devices.end())
      return fail(AudioHostError::DeviceNotFound, AudioHostState::Error,
                  "The selected ASIO driver is no longer available");
    const AsioDriverDevice &device = *found;
    if (!validChannelMap(config.inputChannels, device.inputChannels) ||
        !validChannelMap(config.outputChannels, device.outputChannels) ||
        !supportedRate(device, config.requestedSampleRate) ||
        !validBufferFrames(device.bufferFrames, config.requestedBufferFrames) ||
        config.requestedBufferFrames > config.maximumFrames)
      return fail(AudioHostError::InvalidConfiguration, AudioHostState::Error,
                  "The ASIO driver does not support the requested float32 profile");

    deactivateAudioHostCallback(&endpoint_);
    prepareAudioHostCallback(&endpoint_, render, renderContext);
    endpoint_.callbacks.store(0, std::memory_order_relaxed);
    endpoint_.renderedFrames.store(0, std::memory_order_relaxed);
    endpoint_.xruns.store(0, std::memory_order_relaxed);
    endpoint_.deadlineMisses.store(0, std::memory_order_relaxed);
    endpoint_.discontinuities.store(0, std::memory_order_relaxed);
    endpoint_.invalidCallbacks.store(0, std::memory_order_relaxed);
    endpoint_.renderFailures.store(0, std::memory_order_relaxed);
    timeline_ = {};
    fallbackFrame_.store(0, std::memory_order_relaxed);
    callbackSequence_.store(0, std::memory_order_relaxed);
    pendingDiscontinuity_.store(AudioHostDiscontinuityStart,
                                std::memory_order_relaxed);
    terminal_.reset();
    if (routeGeneration_ == UINT64_MAX || streamGeneration_ == UINT64_MAX)
      return fail(AudioHostError::ProviderFailure, AudioHostState::Error,
                  "ASIO generation range is exhausted");
    ++routeGeneration_;
    ++streamGeneration_;

    AsioDriverOpenConfig request;
    request.deviceUid = config.outputDeviceUid;
    request.inputChannels = config.inputChannels;
    request.outputChannels = config.outputChannels;
    request.sampleRate = config.requestedSampleRate;
    request.bufferFrames = config.requestedBufferFrames;
    request.maximumFrames = config.maximumFrames;
    AsioDriverCallbacks callbacks{this, &processThunk, &terminalThunk};
    const AsioDriverOpenResult opened = driver_->open(request, callbacks);
    if (!opened.ok) {
      deactivateAudioHostCallback(&endpoint_);
      return fail(hostError(opened.error), hostState(opened.state),
                  opened.message.empty() ? "The ASIO driver could not open"
                                         : opened.message);
    }
    driverOpen_ = true;
    if (!opened.float32Planar || opened.sampleRate != request.sampleRate ||
        opened.bufferFrames != request.bufferFrames ||
        opened.maximumFrames == 0 ||
        opened.maximumFrames < opened.bufferFrames ||
        opened.maximumFrames > request.maximumFrames ||
        opened.inputChannels != request.inputChannels.size() ||
        opened.outputChannels != request.outputChannels.size()) {
      driver_->stop();
      driverOpen_ = false;
      deactivateAudioHostCallback(&endpoint_);
      return fail(AudioHostError::ProviderFailure, AudioHostState::Error,
                  "The ASIO driver returned a mismatched callback format");
    }
    format_ = {opened.sampleRate,
               opened.maximumFrames,
               opened.bufferFrames,
               opened.inputChannels,
               opened.outputChannels,
               true,
               true,
               AudioHostAccessMode::Exclusive};
    latency_ = {opened.inputLatencyFrames, opened.outputLatencyFrames,
                opened.bufferFrames, 0};
    state_.store(AudioHostState::Open, std::memory_order_release);
    return {true, AudioHostError::None, AudioHostState::Open, format_,
            latency_, {}};
  }

  AudioHostResult start() override {
    if (!driver_ || state_.load(std::memory_order_acquire) !=
                        AudioHostState::Open)
      return fail(AudioHostError::InvalidState,
                  state_.load(std::memory_order_acquire),
                  "Open the ASIO driver before starting it");
    activateAudioHostCallback(&endpoint_);
    const AsioDriverResult started = driver_->start();
    if (!started.ok) {
      deactivateAudioHostCallback(&endpoint_);
      AudioHostState state = hostState(started.state);
      if (state_.load(std::memory_order_acquire) ==
          AudioHostState::DeviceLost)
        state = AudioHostState::DeviceLost;
      terminal_.publish(
          state == AudioHostState::DeviceLost
              ? AudioHostTerminalReason::DeviceLost
              : AudioHostTerminalReason::ProviderFailure,
          AudioHostTerminalProducer::Provider);
      state_.store(state, std::memory_order_release);
      return fail(hostError(started.error), state,
                  started.message.empty() ? "The ASIO driver could not start"
                                          : started.message);
    }
    // A synchronous fake may have already published terminal state while
    // start() was on the stack. Never overwrite that with Running.
    AudioHostState expected = AudioHostState::Open;
    state_.compare_exchange_strong(expected, AudioHostState::Running,
                                   std::memory_order_acq_rel,
                                   std::memory_order_acquire);
    const AudioHostState current = state_.load(std::memory_order_acquire);
    if (current != AudioHostState::Running)
      return fail(current == AudioHostState::DeviceLost
                      ? AudioHostError::DeviceNotFound
                      : AudioHostError::ProviderFailure,
                  current, "The ASIO driver terminated while starting");
    return {true, AudioHostError::None, current, format_, latency_, {}};
  }

  void stop() noexcept override {
    deactivateAudioHostCallback(&endpoint_);
    AudioHostState prior = state_.load(std::memory_order_acquire);
    if (driver_ && driverOpen_) {
      driver_->stop();
      driverOpen_ = false;
    }
    if (prior == AudioHostState::Open || prior == AudioHostState::Running) {
      // A terminal callback may race with the driver's quiescing stop. Only
      // publish Stopped if no callback replaced the pre-stop state.
      state_.compare_exchange_strong(prior, AudioHostState::Stopped,
                                     std::memory_order_acq_rel,
                                     std::memory_order_acquire);
    }
  }

  AudioHostStatus status() const noexcept override {
    AudioHostStatus result;
    result.state = state_.load(std::memory_order_acquire);
    const AudioHostTerminalCause cause = terminal_.current();
    result.terminalReason = cause.reason;
    result.terminalOrdinal = cause.ordinal;
    result.format = format_;
    result.latency = latency_;
    result.routeGeneration = routeGeneration_;
    result.streamGeneration = streamGeneration_;
    result.callbacks = endpoint_.callbacks.load(std::memory_order_relaxed);
    result.renderedFrames =
        endpoint_.renderedFrames.load(std::memory_order_relaxed);
    result.xruns = endpoint_.xruns.load(std::memory_order_relaxed);
    result.deadlineMisses =
        endpoint_.deadlineMisses.load(std::memory_order_relaxed);
    result.discontinuities =
        endpoint_.discontinuities.load(std::memory_order_relaxed);
    result.invalidCallbacks =
        endpoint_.invalidCallbacks.load(std::memory_order_relaxed);
    result.renderFailures =
        endpoint_.renderFailures.load(std::memory_order_relaxed);
    return result;
  }

 private:
  AudioHostResult fail(AudioHostError error, AudioHostState state,
                       std::string message) {
    state_.store(state, std::memory_order_release);
    return {false, error, state, format_, latency_, std::move(message)};
  }

  static bool processThunk(void *context,
                           const AsioDriverProcessBlock &block) noexcept {
    return context != nullptr
               ? static_cast<AsioAudioHostBackend *>(context)->process(block)
               : false;
  }

  static void terminalThunk(void *context, AsioDriverError error) noexcept {
    if (context != nullptr)
      static_cast<AsioAudioHostBackend *>(context)->terminal(error);
  }

  bool process(const AsioDriverProcessBlock &source) noexcept {
    const bool exactFormat =
        source.inputChannels == format_.inputChannels &&
        source.outputChannels == format_.outputChannels &&
        source.frames != 0 && source.frames <= format_.maximumFrames;
    if (!exactFormat) {
      AudioHostRenderBlock rejected;
      rejected.output = source.output;
      rejected.outputChannels =
          std::min(source.outputChannels, format_.outputChannels);
      rejected.frames = std::min(source.frames, format_.maximumFrames);
      // frames > maximumFrames (or zero frames) routes this through the common
      // invalid-callback counter and bounded silencer without walking an
      // untrusted driver channel/frame count.
      rejected.maximumFrames = rejected.frames == 0 ? 0 : rejected.frames - 1;
      rejected.sampleRate = format_.sampleRate;
      rejected.outputClockMaster = true;
      return invokeAudioHostCallback(&endpoint_, rejected);
    }
    if (source.xrun) recordAudioHostXRun(&endpoint_);
    if (source.deadlineMiss) recordAudioHostDeadlineMiss(&endpoint_);
    const uint64_t fallback = fallbackFrame_.load(std::memory_order_relaxed);
    const AudioHostOutputTimelineResult projected =
        resolveAudioHostOutputTimeline(
            &timeline_, source.samplePositionValid, source.samplePosition,
            source.systemTimeValid, source.frames, fallback);
    fallbackFrame_.store(advanceAudioHostFrame(projected.outputFrame,
                                               source.frames),
                         std::memory_order_relaxed);
    uint32_t discontinuity = source.discontinuity | projected.discontinuity |
                             pendingDiscontinuity_.exchange(
                                 AudioHostDiscontinuityNone,
                                 std::memory_order_acq_rel);
    if (source.xrun) discontinuity |= AudioHostDiscontinuityXRun;
    AudioHostRenderBlock block;
    block.input = source.input;
    block.output = source.output;
    block.inputChannels = source.inputChannels;
    block.outputChannels = source.outputChannels;
    block.frames = source.frames;
    block.maximumFrames = format_.maximumFrames;
    block.sampleRate = format_.sampleRate;
    block.clockDomain = streamGeneration_;
    block.routeGeneration = routeGeneration_;
    block.streamGeneration = streamGeneration_;
    block.callbackSequence =
        callbackSequence_.fetch_add(1, std::memory_order_relaxed);
    block.inputSourceFrame = projected.outputFrame;
    block.inputSampleHostTimeNs = source.systemTimeNs;
    block.inputTimestampValid = source.samplePositionValid;
    block.inputTimestampHardware = source.samplePositionValid;
    block.outputFrame = projected.outputFrame;
    block.outputHostTimeNs = source.systemTimeNs;
    block.outputTimestampValid = source.systemTimeValid;
    block.outputTimestampHardware = source.systemTimeValid;
    block.callbackHostTimeNs = source.systemTimeNs;
    block.discontinuity = discontinuity;
    block.outputClockMaster = true;
    return invokeAudioHostCallback(&endpoint_, block);
  }

  void terminal(AsioDriverError error) noexcept {
    const bool lost = error == AsioDriverError::DeviceLost ||
                      error == AsioDriverError::DeviceNotFound;
    terminal_.publish(lost ? AudioHostTerminalReason::DeviceLost
                           : AudioHostTerminalReason::ProviderFailure,
                      AudioHostTerminalProducer::Provider);
    pendingDiscontinuity_.fetch_or(
        lost ? AudioHostDiscontinuityDeviceLost
             : AudioHostDiscontinuitySequenceGap,
        std::memory_order_release);
    if (lost) {
      state_.store(AudioHostState::DeviceLost, std::memory_order_release);
    } else {
      AudioHostState observed = state_.load(std::memory_order_acquire);
      while (observed != AudioHostState::DeviceLost &&
             observed != AudioHostState::Error &&
             !state_.compare_exchange_weak(
                 observed, AudioHostState::Error, std::memory_order_acq_rel,
                 std::memory_order_acquire)) {
      }
    }
    deactivateAudioHostCallback(&endpoint_);
  }

  std::unique_ptr<AsioDriverApi> driver_;
  AudioHostCallbackEndpoint endpoint_{};
  AudioHostOutputTimeline timeline_{};
  AudioHostTerminalCauseLatch terminal_{};
  AudioHostFormat format_{};
  AudioHostLatency latency_{};
  uint64_t routeGeneration_{0};
  uint64_t streamGeneration_{0};
  std::atomic<AudioHostState> state_{AudioHostState::Closed};
  std::atomic<uint64_t> fallbackFrame_{0};
  std::atomic<uint64_t> callbackSequence_{0};
  std::atomic<uint32_t> pendingDiscontinuity_{AudioHostDiscontinuityNone};
  bool driverOpen_{false};
};

}  // namespace

bool AsioAudioHostProvider::compiled() noexcept {
#if defined(SINGZ_ASIO_SDK_ADAPTER_COMPILED) && \
    SINGZ_ASIO_SDK_ADAPTER_COMPILED
  return true;
#else
  return false;
#endif
}

const char *AsioAudioHostProvider::unavailableReason() noexcept {
  return kAsioSdkUnavailableReason;
}

AsioProviderStatus AsioAudioHostProvider::probe() {
  if (!compiled())
    return {false, false,
            AsioProviderAvailabilityError::SdkAdapterNotCompiled,
            kAsioSdkUnavailableReason};
  return {true, false, AsioProviderAvailabilityError::RuntimeUnavailable,
          "No ASIO runtime adapter was supplied"};
}

AsioProviderStatus AsioAudioHostProvider::probe(
    const AsioDriverApi &driver) {
  const AsioDriverProbe runtime = driver.probe();
  return {true,
          runtime.available,
          runtime.available ? AsioProviderAvailabilityError::None
                            : AsioProviderAvailabilityError::RuntimeUnavailable,
          runtime.detail};
}

std::unique_ptr<AudioHostBackend> AsioAudioHostProvider::create() {
  return std::make_unique<UnavailableAsioAudioHostBackend>();
}

std::unique_ptr<AudioHostBackend> AsioAudioHostProvider::create(
    std::unique_ptr<AsioDriverApi> driver) {
  if (!driver) return create();
  return std::make_unique<AsioAudioHostBackend>(std::move(driver));
}

}  // namespace singz

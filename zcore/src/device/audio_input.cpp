#include <zcore/device/audio_input.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <limits>
#include <mutex>
#include <thread>

#include <zcore/device/audio_input_backend.h>
#include <zcore/device/audio_input_wake.h>

#include "audio_input_callback.h"

#if defined(__APPLE__)
#include <TargetConditionals.h>
#endif

namespace singz {

namespace {

constexpr uint32_t kMinRingBlocks = 2;
constexpr uint32_t kMaxRingBlocks = 256;
constexpr uint32_t kMaxCallbackFrames = 16384;
std::atomic<uint64_t> nextStreamGeneration{1};

uint64_t captureClockDomain(const std::string& uid) {
  // Stable nonzero FNV-1a identity for the selected endpoint. A new open gets
  // a distinct stream generation while retaining the endpoint clock domain.
  uint64_t value = 14695981039346656037ull;
  for (const unsigned char byte : uid) {
    value ^= byte;
    value *= 1099511628211ull;
  }
  return value ? value : 1;
}

bool isFinitePositive(double value) { return std::isfinite(value) && value > 0; }

#if defined(SINGZ_CORE_TESTS)
std::mutex testBackendMutex;
AudioInputBackendFactoryForTests testBackendFactory = nullptr;
std::vector<AudioInputDevice> testBackendDevices;
#endif

std::unique_ptr<AudioInputBackend> makeAudioInputBackend() {
#if defined(SINGZ_CORE_TESTS)
  std::lock_guard<std::mutex> lock(testBackendMutex);
  return testBackendFactory ? testBackendFactory() : createPlatformAudioInputBackend();
#else
  return createPlatformAudioInputBackend();
#endif
}

bool haveTestAudioInputBackend() {
#if defined(SINGZ_CORE_TESTS)
  std::lock_guard<std::mutex> lock(testBackendMutex);
  return testBackendFactory != nullptr;
#else
  return false;
#endif
}

}  // namespace

bool audioInputBackendSupported() {
  if (haveTestAudioInputBackend()) return true;
#if defined(__APPLE__) && (TARGET_OS_OSX || TARGET_OS_IOS)
  return true;
#elif defined(_WIN32)
  return true;
#elif defined(__ANDROID__)
  return true;
#else
  return false;
#endif
}

std::vector<AudioInputDevice> enumerateAudioInputDevices(std::string* error) {
  if (error) error->clear();
  {
#if defined(SINGZ_CORE_TESTS)
    std::lock_guard<std::mutex> lock(testBackendMutex);
    if (testBackendFactory) return testBackendDevices;
#endif
  }
  return enumeratePlatformAudioInputDevices(error);
}

#if defined(SINGZ_CORE_TESTS)
void setAudioInputBackendForTests(AudioInputBackendFactoryForTests factory,
                                  std::vector<AudioInputDevice> devices) {
  std::lock_guard<std::mutex> lock(testBackendMutex);
  testBackendFactory = factory;
  testBackendDevices = std::move(devices);
}
#endif

bool validateAudioInputConfig(const AudioInputConfig& config,
                              const std::vector<AudioInputDevice>& devices,
                              std::string& error) {
  error.clear();
  if (config.deviceUid.empty() || config.deviceUid.size() > 1024) {
    error = "device UID is missing or too long";
    return false;
  }
  if (config.ringBlocks < kMinRingBlocks || config.ringBlocks > kMaxRingBlocks) {
    error = "ring blocks must be between 2 and 256";
    return false;
  }
  const auto device = std::find_if(devices.begin(), devices.end(), [&](const AudioInputDevice& d) {
    return d.uid == config.deviceUid;
  });
  if (device == devices.end()) {
    error = "audio input device is unavailable";
    return false;
  }
  int32_t mappedChannel = 0;
  if (!makeAudioInputChannelMap(config.channel, device->channels, mappedChannel, error)) return false;
  if (!isFinitePositive(device->sampleRate)) {
    error = "audio input device has no usable sample rate";
    return false;
  }
  return true;
}

bool makeAudioInputChannelMap(uint32_t selectedChannel, uint32_t deviceChannels,
                              int32_t& sourceChannel, std::string& error) {
  error.clear();
  if (deviceChannels == 0 || selectedChannel >= deviceChannels ||
      selectedChannel > static_cast<uint32_t>(std::numeric_limits<int32_t>::max())) {
    error = "audio input channel is out of range";
    return false;
  }
  // One mono destination channel sourced from exactly one physical lane. The
  // platform backend consumes this as its deinterleave/channel-map index.
  sourceChannel = static_cast<int32_t>(selectedChannel);
  return true;
}

const char* audioInputStateName(AudioInputState state) {
  switch (state) {
    case AudioInputState::Idle: return "idle";
    case AudioInputState::Starting: return "starting";
    case AudioInputState::Running: return "running";
    case AudioInputState::Stopping: return "stopping";
    case AudioInputState::Stopped: return "stopped";
    case AudioInputState::Unsupported: return "unsupported";
    case AudioInputState::Error: return "error";
  }
  return "error";
}

#if defined(__GNUC__) || defined(__clang__)
#define SINGZ_ZCORE_IMPL_LOCAL __attribute__((visibility("hidden")))
#else
#define SINGZ_ZCORE_IMPL_LOCAL
#endif

// Impl is an out-of-line ownership detail, not part of zcore's ABI. Keep its
// visibility equal to the callback endpoint it owns; otherwise GCC correctly
// rejects the default-visible aggregate containing a hidden field under the
// strict build.
struct SINGZ_ZCORE_IMPL_LOCAL AudioInput::Impl {
  std::mutex lifecycle;
  mutable std::mutex control;
  std::mutex backendControl;
  std::atomic<AudioInputState> state{AudioInputState::Idle};
  std::atomic<bool> quit{false};
  std::atomic<bool> deliveryArmed{false};
  std::atomic<uint64_t> deliveredBlocks{0};
  std::atomic<uint64_t> deliveredFrames{0};
  std::atomic<uint64_t> lastOverruns{0};
  std::atomic<uint64_t> deliveryWakeups{0};
  double sampleRate = 0;
  AudioInputConfig config;
  std::string failure;
  std::unique_ptr<AudioInputRing> ring;
  std::unique_ptr<AudioInputBackend> backend;
  AudioInputSink sink;
  std::thread delivery;
  AudioInputWake wake;
  AudioInputCallbackEndpoint callback;

  void wakeDelivery() noexcept { wake.signal(); }

  static void notifyDelivery(void* context) noexcept {
    if (context) static_cast<Impl*>(context)->wakeDelivery();
  }

  void resetDeliveryWake() {
    callback.resetNotification();
    wake.drain();
  }

  void stopBackend() {
    std::lock_guard<std::mutex> lock(backendControl);
    if (backend) backend->stop();
  }

  bool backendFailure(std::string& error) {
    std::lock_guard<std::mutex> lock(backendControl);
    return backend && backend->takeFailure(error);
  }

  void fail(std::string error) {
    {
      std::lock_guard<std::mutex> lock(control);
      if (failure.empty()) failure = std::move(error);
      state.store(AudioInputState::Error, std::memory_order_release);
      quit.store(true, std::memory_order_release);
    }
    wakeDelivery();
    stopBackend();
  }

  void deliver() {
    deliveringImpl = this;
    AudioInputBlockView block;
    while (!quit.load(std::memory_order_acquire)) {
      std::string backendError;
      if (backendFailure(backendError)) {
        fail(backendError.empty() ? "audio input backend failed" : std::move(backendError));
        break;
      }
      bool didWork = false;
      while (ring && ring->peek(block, sampleRate)) {
        didWork = true;
        deliveredBlocks.fetch_add(1, std::memory_order_relaxed);
        deliveredFrames.fetch_add(block.frames, std::memory_order_relaxed);
        try {
          if (sink) sink(block);
        } catch (...) {
          ring->consume();
          fail("audio input sink threw an exception");
          break;
        }
        ring->consume();
        block = AudioInputBlockView{};
        if (quit.load(std::memory_order_acquire)) break;
      }
      if (quit.load(std::memory_order_acquire)) break;
      if (!didWork) {
        // Clear the edge before checking the ring again. If this exchange
        // reads a producer's true, its acquire half makes that producer's ring
        // release visible to the recheck. A producer racing after the exchange
        // sees false and signals. Thus no edge is lost on weakly ordered CPUs,
        // and at most one event token can remain for the next idle pass.
        [[maybe_unused]] const bool acquiredProducerPublication =
            callback.rearmNotification();
        AudioInputBlockView racedBlock;
        if (ring && ring->peek(racedBlock, sampleRate)) continue;
        if (wake.wait(5))
          deliveryWakeups.fetch_add(1, std::memory_order_relaxed);
      }
    }
    // Stop hardware before returning from a stop request and deliberately
    // drop queued capture. Draining while a sustained producer is still live
    // can run forever, and a live UI must receive no stale callback after
    // stop()/EOF/SIGTERM.
    stopBackend();
    {
      std::lock_guard<std::mutex> lock(control);
      if (state.load(std::memory_order_relaxed) != AudioInputState::Error)
        state.store(AudioInputState::Stopped, std::memory_order_release);
    }
    deliveringImpl = nullptr;
  }

  static thread_local Impl* deliveringImpl;
};

#undef SINGZ_ZCORE_IMPL_LOCAL

thread_local AudioInput::Impl* AudioInput::Impl::deliveringImpl = nullptr;

AudioInput::AudioInput() : impl_(std::make_shared<Impl>()) {}
AudioInput::~AudioInput() {
  if (!impl_) return;
  const bool fromDelivery = Impl::deliveringImpl == impl_.get();
  stop();
  // The delivery lambda retains Impl until it returns. Detaching its thread
  // object here avoids std::terminate when a sink owns and destroys its input.
  if (fromDelivery && impl_->delivery.joinable()) impl_->delivery.detach();
}

AudioInputResult AudioInput::start(const AudioInputConfig& config, AudioInputSink sink) {
  if (Impl::deliveringImpl == impl_.get()) {
    return AudioInputResult::failure(
        state(), "audio input cannot be restarted from its sink", config.channel);
  }
  std::lock_guard<std::mutex> lifecycle(impl_->lifecycle);
  // Retire any prior self-stopped or failed delivery before replacing state.
  {
    std::lock_guard<std::mutex> control(impl_->control);
    impl_->quit.store(true, std::memory_order_release);
    impl_->wakeDelivery();
  }
  impl_->stopBackend();
  if (impl_->delivery.joinable()) impl_->delivery.join();
  {
    std::lock_guard<std::mutex> control(impl_->control);
    if (impl_->ring)
      impl_->lastOverruns.store(impl_->ring->overruns(), std::memory_order_relaxed);
    impl_->backend.reset();
    impl_->callback.clear();
    impl_->ring.reset();
    impl_->sink = nullptr;
  }
  impl_->deliveredBlocks.store(0, std::memory_order_relaxed);
  impl_->deliveredFrames.store(0, std::memory_order_relaxed);
  impl_->lastOverruns.store(0, std::memory_order_relaxed);
  impl_->deliveryWakeups.store(0, std::memory_order_relaxed);
  impl_->resetDeliveryWake();
  {
    std::lock_guard<std::mutex> control(impl_->control);
    impl_->failure.clear();
  }
  impl_->state.store(AudioInputState::Starting, std::memory_order_release);
  if (!audioInputBackendSupported()) {
    impl_->state.store(AudioInputState::Unsupported, std::memory_order_release);
    return AudioInputResult::failure(
        AudioInputState::Unsupported, "audio input is unsupported on this platform",
        config.channel);
  }
  std::string enumerateError;
  const std::vector<AudioInputDevice> devices = enumerateAudioInputDevices(&enumerateError);
  std::string validationError;
  if (!validateAudioInputConfig(config, devices, validationError)) {
    impl_->state.store(AudioInputState::Error, std::memory_order_release);
    return AudioInputResult::failure(
        AudioInputState::Error,
        enumerateError.empty() ? validationError : enumerateError, config.channel);
  }
  {
    std::lock_guard<std::mutex> control(impl_->control);
    impl_->config = config;
    uint64_t generation = nextStreamGeneration.fetch_add(1, std::memory_order_relaxed);
    if (generation == 0)
      generation = nextStreamGeneration.fetch_add(1, std::memory_order_relaxed);
    impl_->ring = std::make_unique<AudioInputRing>(
        config.ringBlocks, kMaxCallbackFrames,
        captureClockDomain(config.deviceUid), generation);
    impl_->callback.prepare(impl_->ring->producer(), Impl::notifyDelivery,
                            impl_.get());
    impl_->sink = std::move(sink);
    impl_->backend = makeAudioInputBackend();
  }
  if (!impl_->ring->valid() || !impl_->backend) {
    impl_->state.store(AudioInputState::Error, std::memory_order_release);
    return AudioInputResult::failure(
        AudioInputState::Error, "could not create audio input", config.channel);
  }
  AudioInputResult result;
  {
    std::lock_guard<std::mutex> backend(impl_->backendControl);
    result = impl_->backend->open(config, AudioInputCallbackEndpoint::push,
                                  &impl_->callback);
  }
  if (!result.ok) {
    impl_->stopBackend();
    std::lock_guard<std::mutex> control(impl_->control);
    impl_->backend.reset();
    impl_->callback.clear();
    impl_->ring.reset();
    impl_->sink = nullptr;
    impl_->state.store(result.state, std::memory_order_release);
    return result;
  }
  if (!isFinitePositive(result.sampleRate)) {
    impl_->stopBackend();
    std::lock_guard<std::mutex> control(impl_->control);
    impl_->backend.reset();
    impl_->callback.clear();
    impl_->ring.reset();
    impl_->sink = nullptr;
    impl_->failure = "audio input backend returned an invalid sample rate";
    impl_->state.store(AudioInputState::Error, std::memory_order_release);
    return AudioInputResult::failure(AudioInputState::Error, impl_->failure,
                                     config.channel);
  }
  // Immutable delivery configuration is published before the backend can
  // invoke a callback. No thread writes sampleRate/config until delivery joins.
  impl_->sampleRate = result.sampleRate;
  impl_->quit.store(false, std::memory_order_release);
  {
    std::lock_guard<std::mutex> backend(impl_->backendControl);
    result = impl_->backend->start();
  }
  if (!result.ok) {
    impl_->fail(result.error.empty() ? "audio input could not start" : result.error);
    return result;
  }
  // start() may synchronously fill the RT ring, but application callbacks do
  // not run until backend start has returned and Running is published.
  impl_->state.store(AudioInputState::Running, std::memory_order_release);
  result.state = AudioInputState::Running;
  try {
    std::shared_ptr<Impl> keepAlive = impl_;
    impl_->deliveryArmed.store(false, std::memory_order_relaxed);
    std::thread delivery([keepAlive] {
      while (!keepAlive->deliveryArmed.load(std::memory_order_acquire))
        std::this_thread::yield();
      keepAlive->deliver();
    });
    impl_->delivery = std::move(delivery);
    // A sink cannot run (and therefore cannot destroy the owning AudioInput)
    // until the std::thread member assignment above is complete.
    impl_->deliveryArmed.store(true, std::memory_order_release);
  } catch (...) {
    impl_->fail("could not create audio input delivery thread");
    return AudioInputResult::failure(AudioInputState::Error, impl_->failure,
                                     config.channel);
  }
  return result;
}

void AudioInput::stop() {
  if (!impl_) return;
  const bool fromDelivery = Impl::deliveringImpl == impl_.get();
  if (fromDelivery) {
    std::lock_guard<std::mutex> control(impl_->control);
    if (impl_->state.load(std::memory_order_relaxed) != AudioInputState::Error)
      impl_->state.store(AudioInputState::Stopping, std::memory_order_release);
    impl_->quit.store(true, std::memory_order_release);
    impl_->wakeDelivery();
    return;  // delivery epilogue stops the backend; never self-join
  }

  std::lock_guard<std::mutex> lifecycle(impl_->lifecycle);
  {
    std::lock_guard<std::mutex> control(impl_->control);
    const AudioInputState state = impl_->state.load(std::memory_order_relaxed);
    if (state != AudioInputState::Idle && state != AudioInputState::Stopped &&
        state != AudioInputState::Error)
      impl_->state.store(AudioInputState::Stopping, std::memory_order_release);
    impl_->quit.store(true, std::memory_order_release);
  }
  impl_->wakeDelivery();
  impl_->stopBackend();
  if (impl_->delivery.joinable()) impl_->delivery.join();
  {
    std::lock_guard<std::mutex> control(impl_->control);
    if (impl_->ring)
      impl_->lastOverruns.store(impl_->ring->overruns(), std::memory_order_relaxed);
    impl_->backend.reset();
    impl_->callback.clear();
    impl_->ring.reset();
    impl_->sink = nullptr;
    impl_->state.store(AudioInputState::Stopped, std::memory_order_release);
  }
}

AudioInputState AudioInput::state() const {
  return impl_ ? impl_->state.load(std::memory_order_acquire) : AudioInputState::Error;
}

AudioInputStats AudioInput::stats() const {
  AudioInputStats stats;
  if (!impl_) return stats;
  std::lock_guard<std::mutex> control(impl_->control);
  stats.deliveredBlocks = impl_->deliveredBlocks.load(std::memory_order_relaxed);
  stats.deliveredFrames = impl_->deliveredFrames.load(std::memory_order_relaxed);
  stats.overruns = impl_->ring ? impl_->ring->overruns()
                              : impl_->lastOverruns.load(std::memory_order_relaxed);
  stats.deliveryWakeups = impl_->deliveryWakeups.load(std::memory_order_relaxed);
  return stats;
}

std::string AudioInput::lastError() const {
  if (!impl_) return "audio input is unavailable";
  std::lock_guard<std::mutex> control(impl_->control);
  return impl_->failure;
}

#if (!defined(__APPLE__) || (!TARGET_OS_OSX && !TARGET_OS_IOS)) && !defined(_WIN32) && \
    !defined(__ANDROID__)
std::unique_ptr<AudioInputBackend> createPlatformAudioInputBackend() { return nullptr; }
std::vector<AudioInputDevice> enumeratePlatformAudioInputDevices(std::string* error) {
  if (error) *error = "audio input is unsupported on this platform";
  return {};
}
#endif

}  // namespace singz

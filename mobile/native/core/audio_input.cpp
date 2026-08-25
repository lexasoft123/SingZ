#include "audio_input.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include <limits>
#include <mutex>
#include <thread>

#include "audio_input_backend.h"
#include "audio_input_wake.h"

#if defined(__APPLE__)
#include <TargetConditionals.h>
#endif

namespace singz {

namespace {

constexpr uint32_t kMinRingBlocks = 2;
constexpr uint32_t kMaxRingBlocks = 256;
constexpr uint32_t kMaxCallbackFrames = 16384;

struct RingSlot {
  std::vector<float> samples;
  uint32_t frames = 0;
  uint64_t sequence = 0;
  uint64_t sampleHostTimeNs = 0;
  uint64_t callbackHostTimeNs = 0;
};

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

struct AudioInputRing::Impl {
  Impl(uint32_t count, uint32_t frames) : slots(count), maxFrames(frames) {
    for (RingSlot& slot : slots) slot.samples.resize(frames);
  }

  std::vector<RingSlot> slots;
  uint32_t maxFrames = 0;
  // The app still ships armeabi-v7a. uint64 atomics may call a locked runtime
  // helper there, so every counter touched by the real-time producer is
  // deliberately 32-bit and compile-time required to be lock-free. Unsigned
  // distance remains correct across wrap because the ring is at most 256.
  static_assert(std::atomic<uint32_t>::is_always_lock_free,
                "audio callback requires lock-free 32-bit atomics");
  alignas(64) std::atomic<uint32_t> write{0};
  alignas(64) std::atomic<uint32_t> read{0};
  std::atomic<uint32_t> dropped{0};
  uint64_t nextSequence = 0;  // producer-owned, never read on another thread
  mutable std::mutex droppedReadMutex;
  mutable uint32_t lastDroppedRaw = 0;
  mutable uint64_t widenedDropped = 0;
};

AudioInputRing::AudioInputRing(uint32_t blocks, uint32_t maxFrames) {
  if (blocks >= kMinRingBlocks && blocks <= kMaxRingBlocks && maxFrames > 0 &&
      maxFrames <= kMaxCallbackFrames) {
    impl_ = std::make_unique<Impl>(blocks, maxFrames);
  }
}

AudioInputRing::~AudioInputRing() = default;

bool AudioInputRing::valid() const { return impl_ != nullptr; }

bool AudioInputRing::push(const float* mono, uint32_t frames, uint64_t sampleHostTimeNs,
                          uint64_t callbackHostTimeNs) {
  if (!impl_) return false;
  // A sequence describes a hardware callback ATTEMPT, not a ring insertion.
  // The next accepted block therefore exposes any dropped callback as a gap.
  const uint64_t attemptSequence = impl_->nextSequence++;
  if (!mono || frames == 0 || frames > impl_->maxFrames) {
    if (impl_) impl_->dropped.fetch_add(1, std::memory_order_relaxed);
    return false;
  }
  const uint32_t write = impl_->write.load(std::memory_order_relaxed);
  const uint32_t read = impl_->read.load(std::memory_order_acquire);
  if (static_cast<uint32_t>(write - read) >= impl_->slots.size()) {
    impl_->dropped.fetch_add(1, std::memory_order_relaxed);
    return false;
  }
  RingSlot& slot = impl_->slots[static_cast<size_t>(write % impl_->slots.size())];
  std::memcpy(slot.samples.data(), mono, static_cast<size_t>(frames) * sizeof(float));
  slot.frames = frames;
  slot.sequence = attemptSequence;
  slot.sampleHostTimeNs = sampleHostTimeNs;
  slot.callbackHostTimeNs = callbackHostTimeNs;
  impl_->write.store(write + 1, std::memory_order_release);
  return true;
}

bool AudioInputRing::peek(AudioInputBlockView& out, double sampleRate) {
  if (!impl_) return false;
  const uint32_t read = impl_->read.load(std::memory_order_relaxed);
  if (read == impl_->write.load(std::memory_order_acquire)) return false;
  RingSlot& slot = impl_->slots[static_cast<size_t>(read % impl_->slots.size())];
  out.sequence = slot.sequence;
  out.sampleHostTimeNs = slot.sampleHostTimeNs;
  out.callbackHostTimeNs = slot.callbackHostTimeNs;
  out.sampleRate = sampleRate;
  // Hardware/driver faults must not inject NaN or infinity into downstream
  // vocal processors. This scan is on the ordinary consumer thread, never
  // the real-time callback.
  for (uint32_t i = 0; i < slot.frames; ++i)
    if (!std::isfinite(slot.samples[i])) slot.samples[i] = 0;
  out.mono = slot.samples.data();
  out.frames = slot.frames;
  return true;
}

void AudioInputRing::consume() {
  if (!impl_) return;
  const uint32_t read = impl_->read.load(std::memory_order_relaxed);
  if (read != impl_->write.load(std::memory_order_acquire))
    impl_->read.store(read + 1, std::memory_order_release);
}

uint64_t AudioInputRing::overruns() const {
  if (!impl_) return 0;
  // Widen the lock-free producer counter off RT. Unsigned subtraction handles
  // wrap; polling more often than 2^32 dropped callbacks is an easy invariant
  // (over a year even at 100 callbacks/s). Multiple readers serialize here.
  std::lock_guard<std::mutex> lock(impl_->droppedReadMutex);
  const uint32_t raw = impl_->dropped.load(std::memory_order_relaxed);
  impl_->widenedDropped += static_cast<uint32_t>(raw - impl_->lastDroppedRaw);
  impl_->lastDroppedRaw = raw;
  return impl_->widenedDropped;
}

uint32_t AudioInputRing::capacity() const {
  return impl_ ? static_cast<uint32_t>(impl_->slots.size()) : 0;
}

LiveInputFrame analyzeLiveInput(const float* mono, size_t frames, double sampleRate,
                                double minFrequency, double maxFrequency) {
  LiveInputFrame result;
  if (!mono || frames < 32 || !isFinitePositive(sampleRate) ||
      !isFinitePositive(minFrequency) || !isFinitePositive(maxFrequency) ||
      minFrequency >= maxFrequency) {
    return result;
  }

  const float* data = mono;
  std::vector<float> sanitized;
  for (size_t i = 0; i < frames; ++i) {
    if (!std::isfinite(mono[i])) {
      sanitized.assign(mono, mono + frames);
      for (float& sample : sanitized)
        if (!std::isfinite(sample)) sample = 0;
      data = sanitized.data();
      break;
    }
  }
  double sumSquares = 0;
  for (size_t i = 0; i < frames; ++i) {
    const double sample = data[i];
    sumSquares += sample * sample;
  }
  result.rms = std::sqrt(sumSquares / static_cast<double>(frames));
  result.dbfs = result.rms > 0 ? std::max(-120.0, 20.0 * std::log10(result.rms)) : -120.0;
  // Same gate and defaults as renderer/audio/pitch.ts::yinPitchInfo. Keeping
  // live capture on that detector's semantics prevents a native channel from
  // scoring differently merely because it bypasses Chromium.
  if (result.rms < 0.01) return result;

  const size_t minTau = std::max<size_t>(2, static_cast<size_t>(std::floor(sampleRate / maxFrequency)));
  const size_t maxTau = std::min(frames / 2, static_cast<size_t>(std::floor(sampleRate / minFrequency)));
  if (maxTau <= minTau + 2) return result;

  // Float32 stores at the same boundaries as the TypeScript Float32Arrays;
  // sums and interpolation remain double, like JavaScript numbers.
  std::vector<float> difference(maxTau + 1, 0.0f);
  std::vector<float> cmnd(maxTau + 1, 0.0f);
  cmnd[0] = 1.0f;
  const size_t window = frames - maxTau;
  for (size_t tau = 1; tau <= maxTau; ++tau) {
    double sum = 0;
    for (size_t i = 0; i < window; ++i) {
      const double delta = static_cast<double>(data[i]) - data[i + tau];
      sum += delta * delta;
    }
    difference[tau] = static_cast<float>(sum);
  }
  double running = 0;
  for (size_t tau = 1; tau <= maxTau; ++tau) {
    running += difference[tau];
    cmnd[tau] = running == 0
                    ? 1.0f
                    : static_cast<float>(difference[tau] * static_cast<double>(tau) / running);
  }

  size_t tau = minTau;
  constexpr double threshold = 0.15;
  for (; tau <= maxTau; ++tau) {
    if (cmnd[tau] < threshold) {
      while (tau + 1 <= maxTau && cmnd[tau + 1] < cmnd[tau]) ++tau;
      break;
    }
  }
  if (tau > maxTau) {
    tau = static_cast<size_t>(std::min_element(cmnd.begin() + static_cast<std::ptrdiff_t>(minTau),
                                               cmnd.end()) - cmnd.begin());
    if (cmnd[tau] > 0.3f) return result;
  }

  double refined = static_cast<double>(tau);
  if (tau > 1 && tau < maxTau) {
    const double left = cmnd[tau - 1], center = cmnd[tau], right = cmnd[tau + 1];
    const double denom = 2.0 * (2.0 * center - left - right);
    if (std::fabs(denom) > 1e-9) refined += (right - left) / denom;
  }
  if (refined > 0) {
    result.frequency = sampleRate / refined;
    result.clarity = std::clamp(1.0 - cmnd[tau], 0.0, 1.0);
  }
  return result;
}

bool audioInputBackendSupported() {
  if (haveTestAudioInputBackend()) return true;
#if defined(__APPLE__) && TARGET_OS_OSX
  return true;
#elif defined(_WIN32)
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

struct AudioInput::Impl {
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
  std::atomic<bool> wakePending{false};
  double sampleRate = 0;
  AudioInputConfig config;
  std::string failure;
  std::unique_ptr<AudioInputRing> ring;
  std::unique_ptr<AudioInputBackend> backend;
  AudioInputSink sink;
  std::thread delivery;
  AudioInputWake wake;

  void wakeDelivery() { wake.signal(); }

  void notifyDeliveryFromProducer() {
    if (!wakePending.exchange(true, std::memory_order_acq_rel)) wakeDelivery();
  }

  void resetDeliveryWake() {
    wakePending.store(false, std::memory_order_release);
    wake.drain();
  }

  static bool push(void* context, const float* mono, uint32_t frames,
                   uint64_t sampleHostTimeNs, uint64_t callbackHostTimeNs) {
    Impl* self = static_cast<Impl*>(context);
    // ring is published before backend start and is not reset until the
    // backend has stopped and delivery has joined.
    if (!self || !self->ring) return false;
    const bool pushed =
        self->ring->push(mono, frames, sampleHostTimeNs, callbackHostTimeNs);
    // Platform event signaling is a fixed-size kernel operation: no app lock,
    // allocation, logging, JSON, or DSP on the real-time producer.
    if (pushed) self->notifyDeliveryFromProducer();
    return pushed;
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
            wakePending.exchange(false, std::memory_order_acq_rel);
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
    return {false, state(), "audio input cannot be restarted from its sink", 0,
            config.channel};
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
    return {false, AudioInputState::Unsupported, "audio input is unsupported on this platform", 0,
            config.channel};
  }
  std::string enumerateError;
  const std::vector<AudioInputDevice> devices = enumerateAudioInputDevices(&enumerateError);
  std::string validationError;
  if (!validateAudioInputConfig(config, devices, validationError)) {
    impl_->state.store(AudioInputState::Error, std::memory_order_release);
    return {false, AudioInputState::Error,
            enumerateError.empty() ? validationError : enumerateError, 0, config.channel};
  }
  {
    std::lock_guard<std::mutex> control(impl_->control);
    impl_->config = config;
    impl_->ring = std::make_unique<AudioInputRing>(config.ringBlocks, kMaxCallbackFrames);
    impl_->sink = std::move(sink);
    impl_->backend = makeAudioInputBackend();
  }
  if (!impl_->ring->valid() || !impl_->backend) {
    impl_->state.store(AudioInputState::Error, std::memory_order_release);
    return {false, AudioInputState::Error, "could not create audio input", 0, config.channel};
  }
  AudioInputResult result;
  {
    std::lock_guard<std::mutex> backend(impl_->backendControl);
    result = impl_->backend->open(config, Impl::push, impl_.get());
  }
  if (!result.ok) {
    impl_->stopBackend();
    std::lock_guard<std::mutex> control(impl_->control);
    impl_->backend.reset();
    impl_->ring.reset();
    impl_->sink = nullptr;
    impl_->state.store(result.state, std::memory_order_release);
    return result;
  }
  if (!isFinitePositive(result.sampleRate)) {
    impl_->stopBackend();
    std::lock_guard<std::mutex> control(impl_->control);
    impl_->backend.reset();
    impl_->ring.reset();
    impl_->sink = nullptr;
    impl_->failure = "audio input backend returned an invalid sample rate";
    impl_->state.store(AudioInputState::Error, std::memory_order_release);
    return {false, AudioInputState::Error, impl_->failure, 0, config.channel};
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
    return {false, AudioInputState::Error, impl_->failure, 0, config.channel};
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

#if (!defined(__APPLE__) || !TARGET_OS_OSX) && !defined(_WIN32)
std::unique_ptr<AudioInputBackend> createPlatformAudioInputBackend() { return nullptr; }
std::vector<AudioInputDevice> enumeratePlatformAudioInputDevices(std::string* error) {
  if (error) *error = "audio input is unsupported on this platform";
  return {};
}
#endif

}  // namespace singz

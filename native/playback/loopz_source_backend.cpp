#include "loopz_source_backend.h"
#if defined(SINGZ_BOX_LOOPZ_ROUTING)
#include "box_routing_owner.h"
#endif
#include <algorithm>
#include <array>
#include <chrono>
#include <condition_variable>
#include <loopz/timeline.hpp>
#include <mutex>
#include <thread>
#include <zcore/device/audio_input_callback_gate.h>
#if defined(__linux__)
#include <cstdio>
#include <pthread.h>
#include <sched.h>
#endif

namespace singz {
struct LoopZSongSource::State {
  mutable std::mutex mutex;
  mutable std::condition_variable changed;
  mutable AudioInputCallbackGate gate;
  mutable AudioInputCallbackGate historyReaders;
  std::atomic<const void *> driver{nullptr};
  AudioHostRender render{};
  void *context{};
  std::atomic<bool> boundary{true};
  std::atomic<uint64_t> revision{0};
};
LoopZSongSource::LoopZSongSource() : state_(std::make_unique<State>()) {
  state_->historyReaders.open();
}
LoopZSongSource::~LoopZSongSource() = default;
namespace {
void drainGate(AudioInputCallbackGate &gate) noexcept {
  gate.beginClose();
  while (gate.inFlight())
    std::this_thread::yield();
}
} // namespace
void LoopZSongSource::attachProducer(AudioHostRender render, void *context) {
  std::lock_guard lock(state_->mutex);
  drainGate(state_->gate);
  state_->render = render;
  state_->context = context;
  state_->boundary.store(true);
  state_->gate.open();
}
void LoopZSongSource::detachProducer(void *context) noexcept {
  std::lock_guard lock(state_->mutex);
  if (state_->context != context)
    return;
  drainGate(state_->gate);
  state_->render = nullptr;
  state_->context = nullptr;
  history->stop();
}
void LoopZSongSource::selectClockDriver(const void *owner) const noexcept {
  std::lock_guard lock(state_->mutex);
  if (state_->driver.load() == owner)
    return;
  drainGate(state_->gate);
  drainGate(state_->historyReaders);
  state_->driver.store(owner);
  state_->revision.fetch_add(1);
  state_->boundary.store(true);
  history->stop();
  if (!owner)
    state_->historyReaders.open();
  if (state_->render)
    state_->gate.open();
  state_->changed.notify_all();
}
bool LoopZSongSource::deviceClocked() const noexcept {
  return state_->driver.load() != nullptr;
}
uint64_t LoopZSongSource::clockRevision() const noexcept {
  return state_->revision.load();
}
void LoopZSongSource::waitForFallback(const std::atomic<bool> &running) const {
  std::unique_lock lock(state_->mutex);
  state_->changed.wait(lock,
                       [&] { return !running.load() || !deviceClocked(); });
}
void LoopZSongSource::wakeProducer() const noexcept {
  std::lock_guard lock(state_->mutex);
  state_->changed.notify_all();
}
bool LoopZSongSource::renderClocked(
    const void *owner, const AudioHostRenderBlock &physical) const noexcept {
  AudioInputCallbackScope scope(state_->gate);
  if (!scope || state_->driver.load() != owner || !state_->render)
    return false;
  auto block = physical;
  if (state_->boundary.exchange(false))
    block.discontinuity |= AudioHostDiscontinuityClockReanchored;
  return state_->render(state_->context, block);
}
loopz::AudioReadResult
LoopZSongSource::read(uint64_t host, double rate, loopz::RoutingOutput output,
                      uint32_t frames,
                      loopz::AudioReadCursor &cursor) const noexcept {
  AudioInputCallbackScope scope(state_->historyReaders);
  if (!scope) {
    for (auto *plane : output.channels)
      if (plane)
        std::fill_n(plane, std::min(frames, output.capacityFrames), 0.f);
    return {frames, false};
  }
  return history->read(host, rate, output, frames, cursor);
}
loopz::AudioReadResult
LoopZSongSource::readWithFilter(uint64_t host, double rate,
                                loopz::RoutingOutput output, uint32_t frames,
                                loopz::AudioReadCursor &cursor,
                                loopz::ResamplingFilter filter) const noexcept {
  AudioInputCallbackScope scope(state_->historyReaders);
  if (!scope) {
    for (auto *plane : output.channels)
      if (plane)
        std::fill_n(plane, std::min(frames, output.capacityFrames), 0.f);
    return {frames, false};
  }
  return history->readWithFilter(host, rate, output, frames, cursor, filter);
}
namespace {
constexpr uint32_t kFrames = 256;
constexpr double kRate = 48000;
#if defined(__linux__)
// The producer runs the full native song graph (stems, effects, convolution).
// Its scratch use is unmeasured, so keep glibc-default-sized headroom rather
// than a tight explicit limit; the reservation is virtual until touched.
constexpr size_t kProducerStackBytes = 4 * 1024 * 1024;
// zCore's ALSA I/O workers request SCHED_FIFO 20 and read this history about
// one block later. Run just below them so ordinary desktop load cannot starve
// the song render while the physical I/O threads still preempt it.
constexpr int kProducerFifoPriority = 18;
void prepareProducerThread() noexcept {
  const int nameError = pthread_setname_np(pthread_self(), "singz-box-song");
  sched_param parameters{};
  parameters.sched_priority = kProducerFifoPriority;
  const int schedulingError =
      pthread_setschedparam(pthread_self(), SCHED_FIFO, &parameters);
  if (schedulingError != 0) {
    std::fprintf(stderr,
                 "singz: Box song producer SCHED_FIFO priority %d request "
                 "failed (error %d); "
                 "retaining inherited scheduling\n",
                 kProducerFifoPriority, schedulingError);
  } else if (nameError != 0) {
    std::fprintf(stderr,
                 "singz: Box song producer thread naming failed (error %d)\n",
                 nameError);
  }
}
#endif
using Clock = std::chrono::steady_clock;
uint64_t ns(Clock::time_point time) noexcept {
  return std::chrono::duration_cast<std::chrono::nanoseconds>(
             time.time_since_epoch())
      .count();
}
class SourceBackend final : public AudioHostBackend {
public:
  explicit SourceBackend(std::shared_ptr<LoopZSongSource> source)
      : source_(std::move(source)) {}
  ~SourceBackend() override { stop(); }
  AudioHostInventory enumerate() const override {
    AudioHostDeviceInfo device;
    device.uid = "native:singz";
    device.label = "SingZ Box routing source";
    device.defaultOutput = true;
    device.outputChannels = 2;
    device.direction = AudioHostEndpointDirection::Output;
    device.accessMode = AudioHostAccessMode::Exclusive;
    device.transport = AudioHostTransport::Virtual;
    device.nominalSampleRate = kRate;
    device.bufferFrames = {kFrames, kFrames, kFrames, 0};
    return {{device}, {}, device.uid};
  }
  AudioHostResult open(const AudioHostConfig &config, AudioHostRender render,
                       void *context) override {
    stop();
    if (!render || !config.inputDeviceUid.empty() ||
        !config.inputChannels.empty() ||
        (config.requestedSampleRate != 0 &&
         config.requestedSampleRate != kRate) ||
        (config.maximumFrames && config.maximumFrames < kFrames) ||
        (!config.outputChannels.empty() &&
         config.outputChannels != std::vector<uint32_t>{0, 1}))
      return {false,
              AudioHostError::InvalidConfiguration,
              AudioHostState::Closed,
              {},
              {},
              "Box native source requires output-only 48 kHz stereo"};
    bool expected = false;
    if (!source_->leased.compare_exchange_strong(expected, true))
      return {false,
              AudioHostError::InvalidState,
              AudioHostState::Closed,
              {},
              {},
              "Box song producer is already owned"};
    leased_ = true;
    render_ = render;
    context_ = context;
    frames_.store(0);
    callbacks_.store(0);
    failures_.store(0);
    previousClock_ = previousStream_ = previousRoute_ = 0;
    ++generation_;
    state_ = AudioHostState::Open;
    return result();
  }
  AudioHostResult start() override {
    if (state_ != AudioHostState::Open)
      return {false, AudioHostError::InvalidState, state_, {},
              {},    "Source is not open"};
    running_.store(true, std::memory_order_release);
    state_ = AudioHostState::Running;
    source_->attachProducer(
        [](void *context, const AudioHostRenderBlock &block) noexcept {
          return static_cast<SourceBackend *>(context)->renderOne(block);
        },
        this);
#if defined(__linux__)
    pthread_attr_t attributes;
    int error = pthread_attr_init(&attributes);
    if (error == 0) {
      error = pthread_attr_setstacksize(&attributes, kProducerStackBytes);
      if (error == 0)
        error = pthread_create(
            &worker_, &attributes,
            [](void *context) -> void * {
              static_cast<SourceBackend *>(context)->run();
              return nullptr;
            },
            this);
      pthread_attr_destroy(&attributes);
    }
    if (error != 0) {
      running_.store(false);
      source_->detachProducer(this);
      state_ = AudioHostState::Error;
      return {false, AudioHostError::ProviderFailure,   state_, {},
              {},    "Cannot start Box native producer"};
    }
    joinable_ = true;
#else
    try {
      worker_ = std::thread([this] { run(); });
    } catch (...) {
      running_.store(false);
      source_->detachProducer(this);
      state_ = AudioHostState::Error;
      throw;
    }
#endif
    return result();
  }
  void stop() noexcept override {
    running_.store(false, std::memory_order_release);
    source_->wakeProducer();
    source_->detachProducer(this);
#if defined(__linux__)
    if (joinable_) {
      pthread_join(worker_, nullptr);
      joinable_ = false;
    }
#else
    if (worker_.joinable())
      worker_.join();
#endif
    if (leased_) {
      source_->history->stop();
      source_->leased.store(false, std::memory_order_release);
      leased_ = false;
    }
    render_ = nullptr;
    context_ = nullptr;
    state_ = AudioHostState::Stopped;
  }
  AudioHostStatus status() const noexcept override {
    AudioHostStatus status;
    status.state = state_;
    status.format = format();
    status.routeGeneration = 1;
    status.streamGeneration = generation_;
    status.callbacks = callbacks_.load(std::memory_order_relaxed);
    status.renderedFrames = frames_.load(std::memory_order_relaxed);
    status.renderFailures = failures_.load(std::memory_order_relaxed);
    return status;
  }

private:
  AudioHostFormat format() const noexcept {
    return {kRate,
            kFrames,
            kFrames,
            0,
            2,
            true,
            source_->deviceClocked(),
            AudioHostAccessMode::Exclusive};
  }
  AudioHostResult result() const {
    return {true, AudioHostError::None, state_, format(), {}, {}};
  }
  void run() noexcept {
    // Linux reserves an explicit stack for native graph/convolution scratch and
    // requests realtime priority below the ALSA I/O workers (non-fatal).
    // All buffers are allocated before callbacks. Waiting and clock sampling
    // are scheduler work, outside the render/history append realtime section.
#if defined(__linux__)
    prepareProducerThread();
#endif
    auto anchor = Clock::now();
    uint64_t anchorFrame = 0;
    uint64_t frame = 0;
    uint64_t sequence = 0;
    uint64_t revision = source_->clockRevision();
    while (running_.load(std::memory_order_acquire)) {
      if (source_->deviceClocked()) {
        source_->waitForFallback(running_);
        if (!running_.load())
          break;
        anchor = Clock::now();
        anchorFrame = frames_.load();
        frame = anchorFrame;
      }
      const auto currentRevision = source_->clockRevision();
      if (currentRevision != revision) {
        anchor = Clock::now();
        anchorFrame = frames_.load();
        revision = currentRevision;
      }
      frame = frames_.load(std::memory_order_relaxed);
      // Absolute conversion avoids the uint64 frame*1e9 overflow at ~106h.
      const auto due = anchor + std::chrono::nanoseconds(
                                    loopz::frameNs(frame - anchorFrame, kRate));
      std::this_thread::sleep_until(due);
      if (!running_.load(std::memory_order_acquire))
        break;
      // Do not burst-render stale blocks after a scheduler stall: reanchor the
      // source clock by publishing actual estimated time and a discontinuity.
      const auto now = Clock::now();
      const bool late = now - due > std::chrono::milliseconds(2);
      const uint64_t host = ns(late ? now : due);
      std::fill(left_.begin(), left_.end(), 0);
      std::fill(right_.begin(), right_.end(), 0);
      AudioHostRenderBlock block;
      block.output = output_.data();
      block.outputChannels = 2;
      block.frames = block.maximumFrames = kFrames;
      block.sampleRate = kRate;
      block.clockDomain = 1;
      block.routeGeneration = 1;
      block.streamGeneration = generation_;
      block.callbackSequence = ++sequence;
      block.outputFrame = frame;
      block.callbackHostTimeNs = host;
      // This is production time, NOT an audible presentation timestamp.
      block.outputHostTimeNs = host;
      block.outputTimestampValid = false;
      block.outputTimestampHardware = false;
      block.outputClockMaster = false;
      block.discontinuity = sequence == 1
                                ? AudioHostDiscontinuityStart
                                : (late ? AudioHostDiscontinuityClockReanchored
                                        : AudioHostDiscontinuityNone);
      source_->renderClocked(nullptr, block);
      frame = frames_.load(std::memory_order_relaxed);
      if (late) {
        // Avoid a catch-up storm while preserving one render per logical block.
        // Subsequent timestamps follow a new scheduler anchor.
        anchor =
            now + std::chrono::nanoseconds(kFrames * 1000000000ull / 48000);
        anchorFrame = frame;
      }
    }
  }
  bool renderOne(const AudioHostRenderBlock &input) noexcept {
    auto block = input;
    if (!block.output || block.outputChannels != 2 || !block.frames ||
        block.frames > kFrames || block.sampleRate != kRate)
      return false;
    const bool direct = block.outputClockMaster;
    if (direct && (previousClock_ != block.clockDomain ||
                   previousStream_ != block.streamGeneration ||
                   previousRoute_ != block.routeGeneration))
      block.discontinuity |= AudioHostDiscontinuityClockReanchored;
    previousClock_ = block.clockDomain;
    previousStream_ = block.streamGeneration;
    previousRoute_ = block.routeGeneration;
    block.streamGeneration = generation_;
    block.routeGeneration = 1;
    block.outputFrame = frames_.load(std::memory_order_relaxed);
    block.callbackSequence = callbacks_.load(std::memory_order_relaxed) + 1;
    if (block.callbackSequence == 1)
      block.discontinuity |= AudioHostDiscontinuityStart;
    const bool rendered = render_(context_, block);
    const auto host = direct && block.outputTimestampValid
                          ? block.outputHostTimeNs
                          : block.callbackHostTimeNs;
    if (!rendered) {
#if defined(SINGZ_BOX_LOOPZ_ROUTING)
      recordBoxSongFailure(host, block.frames);
#endif
      failures_.fetch_add(1, std::memory_order_relaxed);
      for (uint32_t c = 0; c < 2; ++c)
        std::fill_n(block.output[c], block.frames, 0.f);
    }
    if (rendered) {
      const std::array<const float *, 2> planes{block.output[0],
                                                block.output[1]};
      source_->history->append({planes, block.frames}, block.frames, host,
                               kRate, double(block.outputFrame), true);
    }
    frames_.fetch_add(block.frames, std::memory_order_relaxed);
    callbacks_.fetch_add(1, std::memory_order_relaxed);
    return rendered;
  }
  uint64_t previousClock_{0}, previousStream_{0}, previousRoute_{0};
  std::shared_ptr<LoopZSongSource> source_;
  bool leased_{false};
  AudioHostState state_{AudioHostState::Closed};
  uint64_t generation_{0};
  std::atomic<bool> running_{false};
  std::atomic<uint64_t> frames_{0}, callbacks_{0}, failures_{0};
  AudioHostRender render_{nullptr};
  void *context_{nullptr};
#if defined(__linux__)
  pthread_t worker_{};
  bool joinable_{false};
#else
  std::thread worker_;
#endif
  std::array<float, kFrames> left_{}, right_{};
  std::array<float *, 2> output_{left_.data(), right_.data()};
  std::array<const float *, 2> input_{left_.data(), right_.data()};
};
} // namespace
std::unique_ptr<AudioHostBackend>
createLoopZSourceBackend(std::shared_ptr<LoopZSongSource> source) {
  return std::make_unique<SourceBackend>(std::move(source));
}
} // namespace singz

#include "loopz_source_backend.h"
#if defined(SINGZ_BOX_LOOPZ_ROUTING)
#include "box_routing_owner.h"
#endif
#include <algorithm>
#include <array>
#include <chrono>
#include <thread>
#if defined(__linux__)
#include <pthread.h>
#endif

namespace singz {
namespace {
constexpr uint32_t kFrames = 256;
constexpr double kRate = 48000;
using Clock = std::chrono::steady_clock;
uint64_t ns(Clock::time_point time) noexcept {
  return std::chrono::duration_cast<std::chrono::nanoseconds>(time.time_since_epoch()).count();
}
class SourceBackend final : public AudioHostBackend {
 public:
  explicit SourceBackend(std::shared_ptr<LoopZSongSource> source) : source_(std::move(source)) {}
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
  AudioHostResult open(const AudioHostConfig& config, AudioHostRender render, void* context) override {
    stop();
    if (!render || !config.inputDeviceUid.empty() || !config.inputChannels.empty() ||
        (config.requestedSampleRate != 0 && config.requestedSampleRate != kRate) ||
        (config.maximumFrames && config.maximumFrames < kFrames) ||
        (!config.outputChannels.empty() && config.outputChannels != std::vector<uint32_t>{0, 1}))
      return {false, AudioHostError::InvalidConfiguration, AudioHostState::Closed, {}, {},
              "Box native source requires output-only 48 kHz stereo"};
    bool expected = false;
    if (!source_->leased.compare_exchange_strong(expected, true))
      return {false, AudioHostError::InvalidState, AudioHostState::Closed, {}, {},
              "Box song producer is already owned"};
    leased_ = true;
    render_ = render;
    context_ = context;
    frames_.store(0);
    callbacks_.store(0);
    failures_.store(0);
    ++generation_;
    state_ = AudioHostState::Open;
    return result();
  }
  AudioHostResult start() override {
    if (state_ != AudioHostState::Open)
      return {false, AudioHostError::InvalidState, state_, {}, {}, "Source is not open"};
    running_.store(true, std::memory_order_release);
    state_ = AudioHostState::Running;
#if defined(__linux__)
    pthread_attr_t attributes;
    int error = pthread_attr_init(&attributes);
    if (error == 0) {
      error = pthread_attr_setstacksize(&attributes, 1024 * 1024);
      if (error == 0) error = pthread_create(&worker_, &attributes,
          [](void* context) -> void* { static_cast<SourceBackend*>(context)->run(); return nullptr; }, this);
      pthread_attr_destroy(&attributes);
    }
    if (error != 0) {
      running_.store(false); state_ = AudioHostState::Error;
      return {false, AudioHostError::ProviderFailure, state_, {}, {}, "Cannot start Box native producer"};
    }
    joinable_ = true;
#else
    try { worker_ = std::thread([this] { run(); }); }
    catch (...) { running_.store(false); state_ = AudioHostState::Error; throw; }
#endif
    return result();
  }
  void stop() noexcept override {
    running_.store(false, std::memory_order_release);
#if defined(__linux__)
    if (joinable_) { pthread_join(worker_, nullptr); joinable_ = false; }
#else
    if (worker_.joinable()) worker_.join();
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
  static AudioHostFormat format() noexcept { return {kRate, kFrames, kFrames, 0, 2, true, false, AudioHostAccessMode::Exclusive}; }
  AudioHostResult result() const { return {true, AudioHostError::None, state_, format(), {}, {}}; }
  void run() noexcept {
    // Linux reserves an explicit 1 MiB stack for native graph/convolution scratch.
    // All buffers are allocated before callbacks. Waiting and clock sampling are
    // scheduler work, outside the render/history append realtime section.
    auto anchor = Clock::now();
    uint64_t anchorFrame = 0;
    uint64_t frame = 0;
    uint64_t sequence = 0;
    while (running_.load(std::memory_order_acquire)) {
      const auto due = anchor + std::chrono::nanoseconds((frame - anchorFrame) * 1000000000ull / 48000);
      std::this_thread::sleep_until(due);
      if (!running_.load(std::memory_order_acquire)) break;
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
      block.discontinuity = sequence == 1 ? AudioHostDiscontinuityStart :
          (late ? AudioHostDiscontinuityClockReanchored : AudioHostDiscontinuityNone);
      const bool rendered = render_(context_, block);
      if (!rendered) {
#if defined(SINGZ_BOX_LOOPZ_ROUTING)
        recordBoxSongFailure(host, kFrames);
#endif
        failures_.fetch_add(1, std::memory_order_relaxed);
        std::fill(left_.begin(), left_.end(), 0);
        std::fill(right_.begin(), right_.end(), 0);
      }
      // A failed block is a real hole. The authoritative source-frame gap
      // forces AudioHistory to reset on the next good append, preventing
      // interpolation across failed PCM.
      if (rendered) source_->history->append({input_, kFrames}, kFrames, host, kRate, double(frame), true);
      frame += kFrames;
      frames_.store(frame, std::memory_order_relaxed);
      callbacks_.store(sequence, std::memory_order_relaxed);
      if (late) {
        // Avoid a catch-up storm while preserving one render per logical block.
        // Subsequent timestamps follow a new scheduler anchor.
        anchor = now + std::chrono::nanoseconds(kFrames * 1000000000ull / 48000);
        anchorFrame = frame;
      }
    }
  }
  std::shared_ptr<LoopZSongSource> source_;
  bool leased_{false};
  AudioHostState state_{AudioHostState::Closed};
  uint64_t generation_{0};
  std::atomic<bool> running_{false};
  std::atomic<uint64_t> frames_{0}, callbacks_{0}, failures_{0};
  AudioHostRender render_{nullptr};
  void* context_{nullptr};
#if defined(__linux__)
  pthread_t worker_{};
  bool joinable_{false};
#else
  std::thread worker_;
#endif
  std::array<float, kFrames> left_{}, right_{};
  std::array<float*, 2> output_{left_.data(), right_.data()};
  std::array<const float*, 2> input_{left_.data(), right_.data()};
};
} // namespace
std::unique_ptr<AudioHostBackend> createLoopZSourceBackend(std::shared_ptr<LoopZSongSource> source) {
  return std::make_unique<SourceBackend>(std::move(source));
}
} // namespace singz

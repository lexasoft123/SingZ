#include "box_input_capture.h"
#include "box_input_read_schedule.h"
#include "box_routing_owner.h"
#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <loopz/audio_history.hpp>
#include <mutex>
#include <thread>

namespace singz {
std::optional<loopz::AudioReadResult> box_input_detail::readEnabledChannels(
    const loopz::AudioSource& source, uint64_t host, double rate,
    loopz::RoutingOutput output, uint32_t frames, loopz::AudioReadCursor& cursor,
    std::span<const uint32_t> enabledChannels) noexcept {
  return source.readChannels(host, rate, output, frames, cursor, enabledChannels,
                             std::nullopt);
}
namespace {
constexpr uint32_t frames = BoxInputReadSchedule::blockFrames,
                   rate = BoxInputReadSchedule::sampleRate;
uint64_t nowNs() {
  return uint64_t(std::chrono::duration_cast<std::chrono::nanoseconds>(
                      std::chrono::steady_clock::now().time_since_epoch())
                      .count());
}
} // namespace
struct BoxInputCapture::Impl {
  BoxInputTap tap;
  std::array<uint32_t, 64> enabledChannels{};
  uint32_t enabledCount = 0, analysisIndex = 0;
  std::thread worker;
  std::atomic<bool> stopping{false};
  std::atomic<AudioInputState> state{AudioInputState::Idle};
  std::atomic<uint64_t> blocks{0}, delivered{0}, missed{0}, wakeups{0};
  mutable std::mutex mutex;
  std::condition_variable changed;
  std::string error;
  std::atomic<uint64_t> meterSequence{0}, meterAt{0};
  std::array<std::atomic<float>, 64> peak{}, rms{};
  void message(std::string text) {
    std::lock_guard lock(mutex);
    error = std::move(text);
  }
  void run(AudioInputSink sink) noexcept {
    try {
      std::array<std::array<float, frames>, 64> pcm{};
      std::array<float *, 64> planes{};
      for (uint32_t c = 0; c < enabledCount; ++c)
        planes[c] = pcm[c].data();
      loopz::AudioReadCursor cursor;
      uint64_t sequence = 0, generation = 1;
      bool gap = true;
      BoxInputReadSchedule schedule;
      while (!stopping.load(std::memory_order_acquire)) {
        const auto batch = schedule.step(nowNs());
        if (!batch.plan.valid)
          throw std::runtime_error("Microphone analysis clock is unavailable");
        if (batch.discontinuity()) {
          // This is a private reader discard, not a physical USB xrun. Short
          // late wakes recover contiguous history without resetting analysis.
          if (batch.plan.skippedFrames)
            missed.fetch_add(1, std::memory_order_relaxed);
          gap = true;
        }
        for (uint32_t index = 0; index < batch.plan.blocks &&
                                 !stopping.load(std::memory_order_acquire);
             ++index) {
          const uint64_t current = nowNs();
          const uint64_t host = batch.sampleHostTimeNs(index);
          const uint64_t previousGeneration = cursor.generation;
          const auto read = box_input_detail::readEnabledChannels(
              *tap.source, host, rate,
              {std::span<float *const>(planes.data(), enabledCount), frames},
              frames, cursor,
              std::span<const uint32_t>(enabledChannels.data(), enabledCount));
          if (!read) throw std::runtime_error("Microphone source does not support enabled-channel reads");
          wakeups.fetch_add(1, std::memory_order_relaxed);
          if (read->online && !read->missingFrames) {
            for (uint32_t c = 0; c < enabledCount; ++c)
              for (float value : pcm[c])
                if (!std::isfinite(value))
                  throw std::runtime_error(
                      "Microphone history contains non-finite samples");
            meterSequence.fetch_add(1, std::memory_order_acq_rel);
            std::atomic_thread_fence(std::memory_order_release);
            for (uint32_t c = 0; c < enabledCount; ++c) {
              float high = 0;
              double sum = 0;
              for (float value : pcm[c]) {
                high = std::max(high, std::abs(value));
                sum += double(value) * value;
              }
              peak[c].store(high, std::memory_order_relaxed);
              rms[c].store(float(std::sqrt(sum / frames)),
                           std::memory_order_relaxed);
            }
            meterAt.store(current, std::memory_order_relaxed);
            meterSequence.fetch_add(1, std::memory_order_release);
            const bool boundary =
                gap ||
                (previousGeneration && previousGeneration != cursor.generation);
            if (boundary)
              ++generation;
            AudioInputBlockView block;
            block.capture.clockDomainId = tap.id;
            block.capture.streamGeneration = generation;
            block.capture.sequence = ++sequence;
            block.capture.sampleHostTimeNs = host;
            block.capture.callbackHostTimeNs = current;
            block.capture.timestampQuality =
                AudioInputTimestampQuality::CallbackEstimate;
            block.capture.flags = AudioInputSampleHostTimeValid |
                                  AudioInputCallbackHostTimeValid |
                                  AudioInputTimestampQualityValid;
            if (boundary) {
              block.capture.discontinuity =
                  AudioInputDiscontinuityReason::StreamGenerationChanged;
              block.capture.flags |= AudioInputDiscontinuous;
            }
            // sourceFrame remains unavailable: these are resampled private
            // reads, not a new claim about the physical USB frame counter.
            block.sequence = sequence;
            block.sampleHostTimeNs = host;
            block.callbackHostTimeNs = current;
            block.timestampQuality =
                AudioInputTimestampQuality::CallbackEstimate;
            block.sampleRate = rate;
            block.mono = pcm[analysisIndex].data();
            block.frames = frames;
            state.store(AudioInputState::Running, std::memory_order_release);
            if (gap)
              message({});
            gap = false;
            sink(block);
            blocks.fetch_add(1, std::memory_order_relaxed);
            delivered.fetch_add(frames, std::memory_order_relaxed);
          } else {
            // Missing/offline history is unavailable, never synthetic silence
            // passed off as a microphone level or pitch observation.
            if (!gap)
              missed.fetch_add(1, std::memory_order_relaxed);
            gap = true;
            state.store(AudioInputState::Starting, std::memory_order_release);
            message("Waiting for microphone input history");
          }
        }
        // An already-due wake requests another bounded catch-up batch. Keep the
        // sample grid intact instead of rebasing it to inference completion.
        std::unique_lock lock(mutex);
        const auto next = std::chrono::steady_clock::time_point(
            std::chrono::nanoseconds(batch.plan.nextWakeNs));
        changed.wait_until(lock, next, [&] {
          return stopping.load(std::memory_order_acquire);
        });
      }
    } catch (const std::exception &e) {
      message(e.what());
      state.store(AudioInputState::Error, std::memory_order_release);
    } catch (...) {
      message("Microphone analysis reader failed");
      state.store(AudioInputState::Error, std::memory_order_release);
    }
  }
};
BoxInputCapture::BoxInputCapture() : impl_(std::make_unique<Impl>()) {}
BoxInputCapture::~BoxInputCapture() { stop(); }
AudioInputResult BoxInputCapture::start(const AudioInputConfig &config,
                                        AudioInputSink sink,
                                        const std::vector<AudioInputDevice> *,
                                        std::span<const uint32_t> enabledChannels) {
  std::array<uint32_t, 64> selected{};
  const uint32_t count = enabledChannels.empty() ? 1 : uint32_t(enabledChannels.size());
  uint32_t analysisIndex = 0;
  // Reject invalid selections before draining a valid existing reader or
  // acquiring a physical lease. Empty native span means selected-channel-only.
  try {
    if (!sink || enabledChannels.size() > selected.size() || config.channel >= 64)
      throw std::runtime_error("Invalid enabled microphone channels");
    if (enabledChannels.empty()) selected[0] = config.channel;
    else std::copy(enabledChannels.begin(), enabledChannels.end(), selected.begin());
    const auto inventory = boxRoutingInputDevices();
    const auto device = std::find_if(inventory.begin(), inventory.end(),
        [&](const auto& row) { return row.uid == config.deviceUid; });
    if (device == inventory.end()) throw std::runtime_error("Microphone input is unavailable");
    bool containsAnalysis = false;
    for (uint32_t index = 0; index < count; ++index) {
      if (selected[index] >= device->channels || selected[index] >= 64 ||
          (index && selected[index] <= selected[index - 1]))
        throw std::runtime_error("Enabled microphone channels must be sorted, unique and available");
      if (selected[index] == config.channel) { containsAnalysis = true; analysisIndex = index; }
    }
    if (!containsAnalysis) throw std::runtime_error("Enabled microphone channels must include the analysis channel");
  } catch (const std::exception& e) {
    return AudioInputResult::failure(AudioInputState::Error, e.what(), config.channel);
  }
  stop();
  try {
    impl_->enabledChannels = selected;
    impl_->enabledCount = count;
    impl_->analysisIndex = analysisIndex;
    impl_->tap = acquireBoxInputTap(config.deviceUid, config.channel);
    impl_->blocks = 0;
    impl_->delivered = 0;
    impl_->missed = 0;
    impl_->wakeups = 0;
    impl_->stopping = false;
    impl_->meterAt = 0;
    impl_->message({});
    impl_->state = AudioInputState::Starting;
    auto result = AudioInputResult::success(AudioInputState::Starting, rate,
                                            config.channel);
    result.deviceUid = impl_->tap.device.uid;
    result.deviceChannels = impl_->tap.device.channels;
    result.sampleFormat = "Float32 shared history";
    result.sharingMode = "loopz-shared";
    result.timestampSource = "loopz-estimated-history";
    // Finish allocating the response before publishing the borrowed source to
    // its worker; a preparation exception can then release the lease safely.
    impl_->worker = std::thread(
        [this, sink = std::move(sink)]() mutable {
          impl_->run(std::move(sink));
        });
    return result;
  } catch (const std::exception &e) {
    if (impl_->tap.id)
      releaseBoxInputTap(impl_->tap.id);
    impl_->tap = {};
    impl_->message(e.what());
    impl_->state = AudioInputState::Error;
    return AudioInputResult::failure(AudioInputState::Error, e.what(),
                                     config.channel);
  }
}
void BoxInputCapture::stop(bool) {
  {
    // The worker checks `stopping` under this mutex before sleeping; storing
    // it outside the lock could land between that check and the wait.
    std::lock_guard lock(impl_->mutex);
    impl_->stopping.store(true, std::memory_order_release);
  }
  impl_->changed.notify_all();
  if (impl_->worker.joinable())
    impl_->worker.join();
  if (impl_->tap.id)
    releaseBoxInputTap(impl_->tap.id);
  impl_->tap = {};
  if (impl_->state != AudioInputState::Error)
    impl_->state = AudioInputState::Stopped;
}
AudioInputStats BoxInputCapture::stats() const {
  return {impl_->blocks.load(), impl_->delivered.load(), impl_->missed.load(),
          impl_->wakeups.load()};
}
BoxInputMeter BoxInputCapture::meter() const {
  BoxInputMeter result;
  if (!impl_->tap.id ||
      impl_->state.load(std::memory_order_acquire) != AudioInputState::Running)
    return result;
  for (unsigned retry = 0; retry < 3; ++retry) {
    const auto sequence = impl_->meterSequence.load(std::memory_order_acquire);
    if (sequence & 1)
      continue;
    const auto updated = impl_->meterAt.load(std::memory_order_relaxed);
    result.channels = impl_->enabledCount;
    for (uint32_t c = 0; c < result.channels; ++c) {
      result.channelIndices[c] = impl_->enabledChannels[c];
      result.peak[c] = impl_->peak[c].load(std::memory_order_relaxed);
      result.rms[c] = impl_->rms[c].load(std::memory_order_relaxed);
    }
    const auto now = nowNs();
    result.valid = updated && now >= updated && now - updated < 500000000;
    std::atomic_thread_fence(std::memory_order_acquire);
    if (sequence == impl_->meterSequence.load(std::memory_order_acquire))
      return result;
  }
  result.valid = false;
  return result;
}
AudioInputState BoxInputCapture::state() const {
  return impl_->state.load(std::memory_order_acquire);
}
std::string BoxInputCapture::lastError() const {
  std::lock_guard lock(impl_->mutex);
  return impl_->error;
}
} // namespace singz

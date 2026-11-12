#include "box_input_capture.h"
#include "box_input_queue.h"
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
#if defined(__linux__)
#include <pthread.h>
#endif

namespace singz {
std::optional<loopz::AudioReadResult> box_input_detail::readEnabledChannels(
    const loopz::AudioSource& source, uint64_t host, double rate,
    loopz::RoutingOutput output, uint32_t frames, loopz::AudioReadCursor& cursor,
    std::span<const uint32_t> enabledChannels) noexcept {
  return source.readChannels(host, rate, output, frames, cursor, enabledChannels,
                             std::nullopt);
}
namespace {
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
  // Loudest block peak since the previous meter() read, so a 20 Hz reader does not
  // miss transients that fall between two blocks it happens to sample.
  std::array<std::atomic<float>, 64> peakSince{};
  void message(std::string text) {
    std::lock_guard lock(mutex);
    error = std::move(text);
  }
  void run(AudioInputSink sink) noexcept {
#if defined(__linux__)
    (void)pthread_setname_np(pthread_self(), "box-mic-reader");
#endif
    try {
      uint64_t previousSerial = 0, previousEpoch = 0, generation = 1;
      bool gap = true;
      while (!stopping.load(std::memory_order_acquire)) {
        for (unsigned budget = 0; budget < BoxInputQueue::capacity &&
             !stopping.load(std::memory_order_acquire); ++budget) {
          const auto* slot = tap.native->peek();
          if (!slot) break;
          const auto& bus = slot->bus;
          const uint64_t current = nowNs();
          bool valid = tap.native->online.load(std::memory_order_acquire) &&
              bus.firstNs && bus.quality != AudioInputTimestampQuality::Unknown &&
              current >= bus.deliveryNs && current - bus.deliveryNs < 100000000 &&
              std::isfinite(slot->rate) && slot->rate >= 8000 && slot->rate <= 192000;
          for (uint32_t c = 0; c < enabledCount; ++c)
            valid = valid && enabledChannels[c] < bus.channelCount;
          if (!valid) {
            tap.native->consume();
            gap = true;
            continue;
          }
          const bool boundary = gap || previousEpoch != slot->epoch ||
              previousSerial + 1 != slot->serial ||
              bus.capture.discontinuity != AudioInputDiscontinuityReason::None ||
              (bus.capture.flags & AudioInputDiscontinuous);
          if (boundary) {
            ++generation;
            if (!gap) missed.fetch_add(1, std::memory_order_relaxed);
          }
          previousEpoch = slot->epoch; previousSerial = slot->serial;
          meterSequence.fetch_add(1, std::memory_order_acq_rel);
          std::atomic_thread_fence(std::memory_order_release);
          for (uint32_t c = 0; c < enabledCount; ++c) {
            float high = 0;
            double sum = 0;
            const auto* pcm = slot->pcm.get() + enabledChannels[c] * BoxInputQueue::maximumFrames;
            for (uint32_t f = 0; f < bus.frames; ++f) {
              const float value = pcm[f];
              if (!std::isfinite(value))
                throw std::runtime_error("Microphone capture contains non-finite samples");
              high = std::max(high, std::abs(value));
              sum += double(value) * value;
            }
            peak[c].store(high, std::memory_order_relaxed);
            float seen = peakSince[c].load(std::memory_order_relaxed);
            while (high > seen && !peakSince[c].compare_exchange_weak(seen, high, std::memory_order_relaxed)) {}
            rms[c].store(float(std::sqrt(sum / bus.frames)), std::memory_order_relaxed);
          }
          meterAt.store(current, std::memory_order_relaxed);
          meterSequence.fetch_add(1, std::memory_order_release);
          AudioInputBlockView block;
          block.capture = bus.capture;
          block.capture.clockDomainId = tap.id;
          block.capture.streamGeneration = generation;
          block.capture.sequence = slot->serial;
          block.capture.sampleHostTimeNs = bus.firstNs;
          block.capture.callbackHostTimeNs = bus.deliveryNs;
          block.capture.timestampQuality = bus.quality;
          block.capture.flags |= AudioInputSampleHostTimeValid |
              AudioInputCallbackHostTimeValid | AudioInputTimestampQualityValid;
          if (boundary) {
            block.capture.discontinuity = AudioInputDiscontinuityReason::StreamGenerationChanged;
            block.capture.flags |= AudioInputDiscontinuous;
          }
          block.sequence = slot->serial;
          block.sampleHostTimeNs = bus.firstNs;
          block.callbackHostTimeNs = bus.deliveryNs;
          block.timestampQuality = bus.quality;
          block.sampleRate = slot->rate;
          block.mono = slot->pcm.get() + enabledChannels[analysisIndex] * BoxInputQueue::maximumFrames;
          block.frames = bus.frames;
          state.store(AudioInputState::Running, std::memory_order_release);
          if (gap) message({});
          gap = false;
          sink(block);
          blocks.fetch_add(1, std::memory_order_relaxed);
          delivered.fetch_add(bus.frames, std::memory_order_relaxed);
          wakeups.fetch_add(1, std::memory_order_relaxed);
          tap.native->consume();
        }
        // No synthetic silence when a physical owner stops delivering. A new
        // native epoch or dropped queue slot resets the analysis adapter.
        if (!tap.native->online.load(std::memory_order_acquire) ||
            !meterAt.load() || nowNs() - meterAt.load() >= 100000000) {
          gap = true;
          state.store(AudioInputState::Starting, std::memory_order_release);
          message("Waiting for microphone input");
        }
        std::unique_lock lock(mutex);
        changed.wait_for(lock, std::chrono::milliseconds(5), [&] {
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
    impl_->meterSequence = 0;
    for (auto& held : impl_->peakSince) held.store(0, std::memory_order_relaxed);
    impl_->message({});
    impl_->state = AudioInputState::Starting;
    auto result = AudioInputResult::success(AudioInputState::Starting, impl_->tap.native->rate.load(),
                                            config.channel);
    result.deviceUid = impl_->tap.device.uid;
    result.deviceChannels = impl_->tap.device.channels;
    result.sampleFormat = "Float32 native capture";
    result.sharingMode = "loopz-shared";
    result.timestampSource = "loopz-native-capture";
    // Finish allocating the response before publishing the borrowed source to
    // its worker; a preparation exception can then release the lease safely.
    impl_->worker = std::thread(
        [this, sink = std::move(sink)]() mutable {
          impl_->run(std::move(sink));
        });
    return result;
  } catch (const std::exception &e) {
    if (impl_->tap.native) impl_->tap.native->releaseReader();
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
  if (impl_->tap.native) impl_->tap.native->releaseReader();
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
    if (sequence == impl_->meterSequence.load(std::memory_order_acquire)) {
      // Report the loudest block since the last read (never below the latest block).
      for (uint32_t c = 0; c < result.channels; ++c)
        result.peak[c] = std::max(result.peak[c], impl_->peakSince[c].exchange(0.0f, std::memory_order_relaxed));
      return result;
    }
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

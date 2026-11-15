#pragma once
#include <zcore/device/audio_input_backend.h>
#include <array>
#include <atomic>
#include <algorithm>
#include <memory>

namespace singz {
// Box-only, single producer/single consumer tap of the existing capture bus.
// Full queues drop new observations; the producer never overwrites a slot
// borrowed by the reader. No resampling, allocation, locks or second device.
class BoxInputQueue {
public:
  static constexpr uint32_t capacity = 16, maximumFrames = 2048, maximumChannels = 64;
  struct Block {
    std::unique_ptr<float[]> pcm{new float[maximumFrames * maximumChannels]};
    AudioInputBusBlock bus{};
    double rate{};
    uint64_t serial{}, epoch{};
  };
  void start(double sampleRate = 48000) noexcept {
    rate.store(sampleRate, std::memory_order_relaxed);
    ++epoch_; online.store(true, std::memory_order_release);
  }
  bool acquireReader() noexcept { return !reader_.exchange(true, std::memory_order_acq_rel); }
  void releaseReader() noexcept { reader_.store(false, std::memory_order_release); }
  void stop() noexcept { online.store(false, std::memory_order_release); }
  void push(const AudioInputBusBlock& bus, double rate) noexcept {
    if (!online.load(std::memory_order_relaxed) || !bus.planes || !bus.frames ||
        bus.frames > 16384 || bus.frames > bus.capacityFrames ||
        !bus.channelCount || bus.channelCount > maximumChannels) { ++serial_; return; }
    for (uint32_t c = 0; c < bus.channelCount; ++c)
      if (!bus.planes[c]) { ++serial_; return; }
    for (uint32_t offset = 0; offset < bus.frames; offset += maximumFrames) {
      const auto serial = ++serial_;
      const auto frames = std::min(maximumFrames, bus.frames - offset);
      const auto w = write_.load(std::memory_order_relaxed);
      if (w - read_.load(std::memory_order_acquire) == capacity) continue;
      auto& slot = slots_[w % capacity];
      for (uint32_t c = 0; c < bus.channelCount; ++c)
        std::copy_n(bus.planes[c] + offset, frames, slot.pcm.get() + c * maximumFrames);
      slot.bus = bus;
      slot.bus.planes = nullptr; // Never retain provider-owned pointers.
      slot.bus.frames = slot.bus.capacityFrames = frames;
      slot.bus.firstNs += uint64_t(offset * 1e9 / rate);
      slot.bus.capture.sourceFrame += offset;
      if (offset) {
        slot.bus.capture.discontinuity = AudioInputDiscontinuityReason::None;
        slot.bus.capture.flags &= ~AudioInputDiscontinuous;
      }
      slot.rate = rate; slot.serial = serial; slot.epoch = epoch_;
      write_.store(w + 1, std::memory_order_release);
    }
  }

  const Block* peek() const noexcept {
    const auto r = read_.load(std::memory_order_relaxed);
    return r == write_.load(std::memory_order_acquire) ? nullptr : &slots_[r % capacity];
  }
  uint32_t depth() const noexcept {
    const auto r = read_.load(std::memory_order_acquire);
    const auto w = write_.load(std::memory_order_acquire);
    return uint32_t(std::min<uint64_t>(w - r, capacity));
  }
  void consume() noexcept { read_.fetch_add(1, std::memory_order_release); }
  std::atomic<bool> online{false};
  std::atomic<double> rate{0};
private:
  std::array<Block, capacity> slots_;
  std::atomic<uint64_t> read_{0}, write_{0};
  std::atomic<bool> reader_{false};
  uint64_t serial_{0}, epoch_{0}; // One joined physical producer owns these.
};
} // namespace singz

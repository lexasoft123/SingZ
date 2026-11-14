#pragma once
#include <zcore/device/audio_host_render.h>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdint>

namespace singz {
// One serialized control producer, one callback consumer. Samples, queue and
// voices are owned for the service lifetime; render never allocates or waits.
class PreviewClickMixer final {
 public:
  static constexpr uint32_t capacity = 16;
  struct Status { uint64_t enqueued, started, completed; uint32_t pending; };
  PreviewClickMixer() {
    for (uint32_t sound = 0; sound < 2; ++sound)
      for (uint32_t frame = 0; frame < sampleFrames; ++frame) {
        const double t = frame / sampleRate;
        samples_[sound][frame] = static_cast<float>((sound ? 0.9 : 0.62) *
            std::fmin(1.0, t / 0.0015) * std::exp(-t / 0.012) *
            std::sin(2 * 3.14159265358979323846 * (sound ? 1568 : 1046.5) * t));
      }
  }
  bool enqueue(bool accent, float gain) noexcept {
    if (!std::isfinite(gain) || gain < 0 || gain > 4) return false;
    auto count = pending_.load(std::memory_order_acquire);
    do { if (count >= capacity) return false; }
    while (!pending_.compare_exchange_weak(count, count + 1, std::memory_order_acq_rel));
    const auto write = write_.load(std::memory_order_relaxed);
    queue_[write % capacity] = {accent, gain};
    enqueued_.fetch_add(1, std::memory_order_relaxed);
    write_.store(write + 1, std::memory_order_release);
    return true;
  }
  void render(const AudioHostRenderBlock& block) noexcept {
    if (!std::isfinite(block.sampleRate) || block.sampleRate < 8000 || block.sampleRate > 384000) return;
    auto read = read_.load(std::memory_order_relaxed);
    const auto end = write_.load(std::memory_order_acquire);
    for (auto& voice : voices_) {
      if (!voice.active && read != end) {
        const auto command = queue_[read++ % capacity];
        voice = {true, command.accent, command.gain, 0, 0,
            static_cast<uint32_t>(std::llround(block.sampleRate * 0.055))};
        started_.fetch_add(1, std::memory_order_relaxed);
      }
    }
    read_.store(read, std::memory_order_release);
    for (auto& voice : voices_) {
      if (!voice.active) continue;
      for (uint32_t frame = 0; frame < block.frames && voice.frame < voice.duration; ++frame, ++voice.frame) {
        const auto index = static_cast<uint32_t>(voice.position);
        const auto next = index + 1;
        const float a = index < sampleFrames ? samples_[voice.accent][index] : 0;
        const float b = next < sampleFrames ? samples_[voice.accent][next] : 0;
        const float value = (a + (b - a) * static_cast<float>(voice.position - index)) * voice.gain;
        for (uint32_t channel = 0; channel < block.outputChannels; ++channel)
          if (block.output && block.output[channel]) block.output[channel][frame] += value;
        voice.position += sampleRate / block.sampleRate;
      }
      if (voice.frame == voice.duration) {
        voice.active = false;
        completed_.fetch_add(1, std::memory_order_relaxed);
        pending_.fetch_sub(1, std::memory_order_release);
      }
    }
  }
  Status status() const noexcept {
    return {enqueued_.load(std::memory_order_relaxed), started_.load(std::memory_order_relaxed),
        completed_.load(std::memory_order_relaxed), pending_.load(std::memory_order_acquire)};
  }
  // Only after the service callback has joined.
  void clearQuiesced() noexcept {
    for (auto& voice : voices_) voice.active = false;
    read_.store(write_.load(std::memory_order_relaxed), std::memory_order_relaxed);
    pending_.store(0, std::memory_order_release);
  }
 private:
  static constexpr double sampleRate = 48000;
  static constexpr uint32_t sampleFrames = 2640;
  struct Command { bool accent{}; float gain{}; };
  struct Voice { bool active{}, accent{}; float gain{}; double position{}; uint32_t frame{}, duration{}; };
  std::array<std::array<float, sampleFrames>, 2> samples_{};
  std::array<Command, capacity> queue_{};
  std::array<Voice, capacity> voices_{};
  static_assert(std::atomic<uint64_t>::is_always_lock_free);
  static_assert(std::atomic<uint32_t>::is_always_lock_free);
  std::atomic<uint64_t> read_{0}, write_{0}, enqueued_{0}, started_{0}, completed_{0};
  std::atomic<uint32_t> pending_{0};
};
} // namespace singz

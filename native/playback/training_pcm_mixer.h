#pragma once
#include <zcore/device/audio_host_render.h>
#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <mutex>
#include <vector>
#include <memory>
#include <string>
#include <thread>
#include <cstdio>
#include "presentation_history.h"

namespace singz {
// Portable shared-output cue mixer. Only render() belongs to the callback
// domain. Control methods never mutate planes visible to render; completed
// slots publish release before control reclaims storage. No callback allocation,
// lock, DSP inference or N-API dependency. clearQuiesced requires a retired render.
class TrainingPcmMixer final {
static_assert(std::atomic<uint64_t>::is_always_lock_free &&
              std::atomic<uint32_t>::is_always_lock_free &&
              std::atomic<bool>::is_always_lock_free &&
              std::atomic<float>::is_always_lock_free);
// Three leased PCM16 windows: the disk worker is the only file reader. The
// callback only leases immutable Ready windows; a miss produces silence rather
// than waiting or playing stale PCM. Storage/destruction belongs to control.
struct TakeStream {
  static constexpr uint64_t kWindowFrames = 262144;
  static constexpr size_t kBytes = 3 * kWindowFrames * sizeof(int16_t);
  enum State : uint32_t { Empty, Filling, Ready, Reading };
  struct Window {
    std::atomic<uint32_t> state{Empty};
    uint64_t first = 0, count = 0;
    std::vector<int16_t> pcm;
  };
  std::array<Window, 3> windows;
  std::atomic<uint64_t> requested{0};
  std::atomic<bool> stopping{false};
  std::thread worker;
  FILE* file = nullptr;
  uint64_t frames = 0;
  double sampleRate = 0;
  ~TakeStream();
  bool open(const std::string& path);
  bool fill(Window&, uint64_t first);
  void run() noexcept;
};
struct Voice {
  enum State : uint32_t { Finished, Writing, Ready, Playing };
  std::atomic<uint32_t> state{Finished};
  std::atomic<bool> cancelled{false};
  uint64_t generation = 0, startNs = 0;
  double rate = 0;
  std::atomic<float> gain{1};
  float maximumGain = 8;
  uint32_t cancellationFrames = 0;
  double sourceCursor = 0;
  bool cursorStarted = false;
  bool projectAnchored = false, wasPaused = true;
  double startPositionSec = 0, recordedTempo = 1;
  uint64_t transportSerial = 0;
  uint32_t onsetFrames = 0;
  float currentGain = 0;
  std::unique_ptr<TakeStream> take;
  std::vector<std::vector<float>> planes;
};

 public:
  static constexpr size_t kMaximumBytes = 64 * 1024 * 1024;
  bool active() {
    std::lock_guard<std::mutex> lock(mutex_);
    for (const auto& voice : voices_)
      if (voice.state.load(std::memory_order_acquire) != Voice::Finished) return true;
    return false;
  }
  bool canSchedule(size_t frames, size_t channels) {
    std::lock_guard<std::mutex> lock(mutex_);
    return canScheduleLocked(frames,channels);
  }
 private:
  bool canScheduleLocked(size_t frames, size_t channels) {
    reclaimFinished();
    if (!frames || channels < 1 || channels > 2 || frames > 48 * 1024 * 1024 / sizeof(float) / channels) return false;
    size_t bytes = frames * channels * sizeof(float);
    bool free = false;
    for (const auto& voice : voices_) {
      if (voice.state.load(std::memory_order_acquire) == Voice::Finished) free = true;
      else {
        if (voice.take) bytes += TakeStream::kBytes;
        for (const auto& plane : voice.planes) bytes += plane.size() * sizeof(float);
      }
    }
    return free && bytes <= kMaximumBytes;
  }
 public:
  // WAV is WP1's canonical 44-byte mono PCM16 container. Takes have no
  // duration limit and do not enter the song's time/pitch stage. tempo is the
  // recorded song ratio, used only when locating PCM after a transport jump.
  // startNs=0 starts standalone playback at its first callback after preload.
  bool scheduleTake(const std::string& path, uint64_t generation,
                    double startPositionSec, bool withSong, uint64_t startNs,
                    float gain = 1, double tempo = 1);
  void cancelTakes(uint64_t generation = 0) {
    std::lock_guard<std::mutex> lock(mutex_);
    for (auto& voice : voices_)
      if (voice.state.load(std::memory_order_acquire) != Voice::Finished &&
          voice.take && (!generation || voice.generation == generation))
        voice.cancelled.store(true, std::memory_order_release);
  }
 public:
  bool schedule(std::vector<std::vector<float>> planes, uint64_t generation,
                double rate, uint64_t startNs, float gain) {
    if (!generation || !startNs || !std::isfinite(rate) || rate < 8000 || rate > 192000 ||
        !std::isfinite(gain) || gain < 0 || gain > 8 || planes.empty() || planes.size() > 2 || planes.front().empty() || planes.front().size() > rate * 120) return false;
    const size_t frames = planes.front().size();
    float peak = 0;
    for (const auto& plane : planes) {
      if (plane.size() != frames) return false;
      for (float sample : plane) {
        if (!std::isfinite(sample)) return false;
        peak = std::max(peak, std::abs(sample));
      }
    }
    std::lock_guard<std::mutex> lock(mutex_);
    if (!canScheduleLocked(frames, planes.size())) return false;
    // Control callers are serialized; render can only free more space.
    for (auto& voice : voices_) {
      uint32_t expected = Voice::Finished;
      if (!voice.state.compare_exchange_strong(expected, Voice::Writing, std::memory_order_acq_rel)) continue;
      voice.planes = std::move(planes);
      voice.generation = generation; voice.rate = rate; voice.startNs = startNs;
      // Whole-phrase gain cap: no compression, clipping or envelope changes.
      // Leave 1 dB for reconstruction/interpolation peaks.
      voice.maximumGain = peak > 0 ? std::min(8.0F, 0.89125094F / peak) : 8.0F;
      voice.gain.store(std::min(gain, voice.maximumGain), std::memory_order_relaxed);
      voice.cancellationFrames = 0;
      voice.sourceCursor = 0; voice.cursorStarted = false;
      voice.cancelled.store(false, std::memory_order_relaxed);
      voice.state.store(Voice::Ready, std::memory_order_release);
      return true;
    }
    return false;
  }
  void cancel(uint64_t generation) {
    std::lock_guard<std::mutex> lock(mutex_);
    for (auto& voice : voices_) if (voice.state.load(std::memory_order_acquire) != Voice::Finished && !voice.take && voice.generation == generation)
      voice.cancelled.store(true, std::memory_order_release);
  }
  void setGain(uint64_t generation, float gain) {
    if (!std::isfinite(gain) || gain < 0 || gain > 8) return;
    std::lock_guard<std::mutex> lock(mutex_);
    for (auto& voice : voices_) if (voice.state.load(std::memory_order_acquire) != Voice::Finished && !voice.take && voice.generation == generation)
      voice.gain.store(std::min(gain, voice.maximumGain), std::memory_order_relaxed);
  }
  void clearQuiesced() {
    std::lock_guard<std::mutex> lock(mutex_);
    for (auto& voice : voices_) { voice.state.store(Voice::Finished, std::memory_order_release); voice.planes.clear(); voice.take.reset(); }
  }
bool render(const AudioHostRenderBlock& block,
            const PlaybackPresentationQuery& transport = {}) noexcept {
  if (!block.output || !std::isfinite(block.sampleRate) || block.sampleRate <= 0) return true;
  // Cue timing is the render/callback clock; consumers add physical output
  // latency exactly once when matching captured voice.
  const uint64_t blockNs = block.callbackHostTimeNs;
  if (!blockNs) return true;
  for (auto& voice : voices_) {
    uint32_t expected = Voice::Ready;
    voice.state.compare_exchange_strong(expected, Voice::Playing, std::memory_order_acq_rel);
    if (voice.state.load(std::memory_order_acquire) != Voice::Playing) continue;
    if (voice.take) { renderTake(voice, block, transport); continue; }
    const float gain = voice.gain.load(std::memory_order_relaxed);
    const bool cancelled = voice.cancelled.load(std::memory_order_acquire);
    // Host time anchors onset. After onset, advance by the rendered sample
    // count: callback scheduling jitter must never skip/repeat instrument PCM.
    const uint32_t clockSeam = AudioHostDiscontinuityStart | AudioHostDiscontinuityRouteChanged |
                               AudioHostDiscontinuityClockReanchored | AudioHostDiscontinuityDeviceLost;
    if (block.discontinuity & clockSeam) voice.cursorStarted = false;
    const double sourceAtStart = voice.cursorStarted ? voice.sourceCursor :
        (static_cast<long double>(blockNs) - voice.startNs) * voice.rate / 1e9L;
    const double step = voice.rate / block.sampleRate;
    const auto length = voice.planes.front().size();
    if (cancelled && sourceAtStart < 0) { voice.state.store(Voice::Finished, std::memory_order_release); continue; }
    for (uint32_t frame = 0; frame < block.frames; ++frame) {
      const double source = sourceAtStart + frame * step;
      if (source < 0) continue;
      if (source >= length) break;
      const auto index = static_cast<size_t>(source);
      const auto next = index + 1 < length ? index + 1 : index;
      const float fraction = static_cast<float>(source - index);
      const float cancelGain = cancelled ? std::max(0.0F, 1.0F - static_cast<float>(voice.cancellationFrames++) / static_cast<float>(block.sampleRate * 0.005)) : 1.0F;
      for (uint32_t channel = 0; channel < block.outputChannels; ++channel) {
        if (!block.output[channel]) continue;
        const auto& plane = voice.planes[channel % voice.planes.size()];
        block.output[channel][frame] += (plane[index] + (plane[next] - plane[index]) * fraction) * gain * cancelGain;
      }
    }
    voice.sourceCursor = sourceAtStart + block.frames * step;
    if (voice.sourceCursor >= 0) voice.cursorStarted = true;
    if (voice.sourceCursor >= length || (cancelled && voice.cancellationFrames >= block.sampleRate * 0.005))
      voice.state.store(Voice::Finished, std::memory_order_release);
  }
  return true;
}

 private:
  static void renderTake(Voice&, const AudioHostRenderBlock&,
                         const PlaybackPresentationQuery&) noexcept;
  void reclaimFinished() {
    for (auto& voice : voices_) if (voice.state.load(std::memory_order_acquire) == Voice::Finished) { voice.planes.clear(); voice.take.reset(); }
  }
  std::array<Voice, 32> voices_;
  std::mutex mutex_;
};
}

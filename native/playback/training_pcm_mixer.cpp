#include "training_pcm_mixer.h"
#include <chrono>
#include <cstring>
#include <limits>
#include <filesystem>

namespace singz {
namespace {
bool seekFile(FILE* file, uint64_t offset) {
  if (offset > static_cast<uint64_t>(std::numeric_limits<int64_t>::max())) return false;
#if defined(_WIN32)
  return _fseeki64(file, static_cast<int64_t>(offset), SEEK_SET) == 0;
#else
  return fseeko(file, static_cast<off_t>(offset), SEEK_SET) == 0;
#endif
}
uint32_t little32(const unsigned char* p) {
  return uint32_t(p[0]) | uint32_t(p[1]) << 8 | uint32_t(p[2]) << 16 | uint32_t(p[3]) << 24;
}
}

TrainingPcmMixer::TakeStream::~TakeStream() {
  stopping.store(true, std::memory_order_release);
  if (worker.joinable()) worker.join();
  if (file) fclose(file);
}

bool TrainingPcmMixer::TakeStream::open(const std::string& path) {
#if defined(_WIN32)
  // Main passes a filesystem path, not a URL. Keep Unicode Windows paths.
  const auto wide = std::filesystem::u8path(path).wstring();
  file = _wfopen(wide.c_str(), L"rb");
#else
  file = fopen(path.c_str(), "rb");
#endif
  if (!file) return false;
  unsigned char h[44];
  if (fread(h, 1, sizeof(h), file) != sizeof(h) ||
      memcmp(h, "RIFF", 4) || memcmp(h + 8, "WAVEfmt ", 8) ||
      little32(h + 16) != 16 || h[20] != 1 || h[21] ||
      h[22] != 1 || h[23] || h[32] != 2 || h[33] ||
      h[34] != 16 || h[35] || memcmp(h + 36, "data", 4)) return false;
  sampleRate = little32(h + 24);
  if (sampleRate < 8000 || sampleRate > 192000 || little32(h + 28) != sampleRate * 2) return false;
#if defined(_WIN32)
  if (_fseeki64(file, 0, SEEK_END)) return false;
  const auto size = _ftelli64(file);
#else
  if (fseeko(file, 0, SEEK_END)) return false;
  const auto size = ftello(file);
#endif
  if (size < 46) return false;
  const uint64_t available = static_cast<uint64_t>(size) - 44;
  const uint32_t declared = little32(h + 40);
  // An unpatched journal has a zero data length. Recovered/RF64-sized
  // journals may also carry the saturated sentinel; size owns those cases.
  const uint64_t bytes = declared == 0 || declared == UINT32_MAX ? (available & ~uint64_t{1}) : declared;
  if (!bytes || bytes > available || bytes % 2) return false;
  frames = bytes / 2;
  for (size_t i = 0; i < windows.size(); ++i) {
    windows[i].pcm.resize(kWindowFrames);
    fill(windows[i], i * kWindowFrames);
  }
  worker = std::thread([this] { run(); });
  return true;
}

bool TrainingPcmMixer::TakeStream::fill(Window& window, uint64_t first) {
  window.first = first;
  window.count = 0;
  if (first < frames && seekFile(file, 44 + first * 2)) {
    const size_t count = static_cast<size_t>(std::min(kWindowFrames, frames - first));
    window.count = fread(window.pcm.data(), sizeof(int16_t), count, file);
  }
  window.state.store(Ready, std::memory_order_release);
  return window.count != 0;
}

void TrainingPcmMixer::TakeStream::run() noexcept {
  while (!stopping.load(std::memory_order_acquire)) {
    const uint64_t position = requested.load(std::memory_order_acquire);
    const uint64_t base = position / kWindowFrames * kWindowFrames;
    for (uint64_t ahead = 0; ahead < windows.size(); ++ahead) {
      const uint64_t first = base + ahead * kWindowFrames;
      if (first >= frames) break;
      bool present = false;
      // Only this worker writes first/count. A Reading window is immutable
      // until the callback releases it; control never accesses these fields.
      for (const auto& w : windows) if (w.first == first && w.count) present = true;
      if (present) continue;
      for (auto& w : windows) {
        if (w.count && w.first >= base && w.first < base + windows.size() * kWindowFrames) continue;
        uint32_t expected = Ready;
        if (!w.state.compare_exchange_strong(expected, Filling, std::memory_order_acq_rel)) continue;
        fill(w, first);
        break;
      }
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  fclose(file);
  file = nullptr;
}

bool TrainingPcmMixer::scheduleTake(const std::string& path, uint64_t generation,
                                  double startPositionSec, bool withSong,
                                  uint64_t startNs, float gain, double tempo) {
  if (path.empty() || path.find('\0') != std::string::npos ||
      !generation || !std::isfinite(startPositionSec) ||
      !std::isfinite(tempo) || tempo <= 0 || tempo > 8 ||
      !std::isfinite(gain) || gain < 0 || gain > 8) return false;
  std::lock_guard<std::mutex> lock(mutex_);
  if (!canScheduleLocked(TakeStream::kBytes / sizeof(float), 1)) return false;
  auto stream = std::make_unique<TakeStream>();
  if (!stream->open(path)) return false;
  for (auto& voice : voices_) {
    uint32_t expected = Voice::Finished;
    if (!voice.state.compare_exchange_strong(expected, Voice::Writing, std::memory_order_acq_rel)) continue;
    voice.rate = stream->sampleRate;
    voice.take = std::move(stream);
    voice.generation = generation;
    voice.startNs = startNs;
    voice.projectAnchored = withSong;
    voice.startPositionSec = startPositionSec;
    voice.recordedTempo = tempo;
    voice.maximumGain = 0.89125094F; // PCM16's full-scale peak, with 1 dB headroom.
    voice.gain.store(std::min(gain, voice.maximumGain), std::memory_order_relaxed);
    voice.currentGain = std::min(gain, voice.maximumGain);
    voice.cancelled.store(false, std::memory_order_relaxed);
    voice.cursorStarted = false;
    voice.wasPaused = true;
    voice.sourceCursor = 0;
    voice.cancellationFrames = voice.onsetFrames = 0;
    voice.transportSerial = 0;
    voice.state.store(Voice::Ready, std::memory_order_release);
    return true;
  }
  return false;
}

void TrainingPcmMixer::renderTake(Voice& voice, const AudioHostRenderBlock& block,
                                const PlaybackPresentationQuery& transport) noexcept {
  auto& take = *voice.take;
  const bool cancelled = voice.cancelled.load(std::memory_order_acquire);
  if (voice.projectAnchored && (!transport.found || transport.paused || transport.rate <= 0)) {
    voice.wasPaused = true;
    if (cancelled) {
      take.stopping.store(true, std::memory_order_release);
      voice.state.store(Voice::Finished, std::memory_order_release);
    }
    return;
  }
  const double step = voice.rate / block.sampleRate;
  double source = voice.sourceCursor;
  if (voice.projectAnchored) {
    if (!voice.cursorStarted || voice.wasPaused || voice.transportSerial != transport.discontinuitySerial) {
      const double delta = transport.projectFrame - voice.startPositionSec * transport.sampleRate;
      // Before onset, wait until this block reaches the project's start frame.
      // After onset/seek, locate recorded time using the recorded song ratio.
      source = delta < 0 ? delta / transport.rate * step :
          delta / transport.sampleRate / voice.recordedTempo * voice.rate;
      voice.onsetFrames = 0;
    }
    voice.transportSerial = transport.discontinuitySerial;
    voice.wasPaused = false;
  } else if (!voice.cursorStarted) {
    if (!voice.startNs) voice.startNs = block.callbackHostTimeNs;
    source = static_cast<double>((static_cast<long double>(block.callbackHostTimeNs) - voice.startNs) * voice.rate / 1.e9L);
  }
  if (cancelled && (source < 0 || source >= take.frames)) {
    take.stopping.store(true, std::memory_order_release);
    voice.state.store(Voice::Finished, std::memory_order_release);
    return;
  }
  if (!std::isfinite(source) || source > static_cast<double>(UINT64_MAX / 2)) return;
  const uint64_t request = source > 0 ? static_cast<uint64_t>(source) : 0;
  take.requested.store(std::min(request, take.frames), std::memory_order_release);
  std::array<TakeStream::Window*, 3> leased{};
  for (size_t i = 0; i < leased.size(); ++i) {
    uint32_t expected = TakeStream::Ready;
    if (take.windows[i].state.compare_exchange_strong(expected, TakeStream::Reading, std::memory_order_acq_rel))
      leased[i] = &take.windows[i];
  }
  const auto sample = [&](uint64_t frame, float& value) noexcept {
    for (const auto* w : leased) if (w && frame >= w->first && frame - w->first < w->count) {
      value = w->pcm[frame - w->first] / 32768.0F;
      return true;
    }
    return false;
  };
  const float targetGain = voice.gain.load(std::memory_order_relaxed);
  const float gainStep = 8.0F / static_cast<float>(block.sampleRate * 0.005);
  const float rampFrames = static_cast<float>(block.sampleRate * 0.005);
  for (uint32_t frame = 0; frame < block.frames; ++frame, source += step) {
    const float tail = cancelled ? std::max(0.0F, 1.0F - static_cast<float>(voice.cancellationFrames++) / rampFrames) : 1.0F;
    if (source < 0 || source >= take.frames) continue;
    const auto index = static_cast<uint64_t>(source);
    float a = 0, b = 0;
    if (!sample(index, a) || !sample(std::min(index + 1, take.frames - 1), b)) {
      voice.onsetFrames = 0;
      continue;
    }
    const float fraction = static_cast<float>(source - index);
    const float onset = std::min(1.0F, static_cast<float>(voice.onsetFrames++) / rampFrames);
    voice.currentGain += std::clamp(targetGain - voice.currentGain, -gainStep, gainStep);
    const float value = (a + (b - a) * fraction) * voice.currentGain * onset * tail;
    for (uint32_t channel = 0; channel < block.outputChannels; ++channel)
      if (block.output[channel]) block.output[channel][frame] += value;
  }
  for (auto* w : leased) if (w) w->state.store(TakeStream::Ready, std::memory_order_release);
  voice.sourceCursor = source;
  voice.cursorStarted = source >= 0;
  if ((!voice.projectAnchored && source >= take.frames) ||
      (cancelled && voice.cancellationFrames >= rampFrames)) {
    take.stopping.store(true, std::memory_order_release);
    voice.state.store(Voice::Finished, std::memory_order_release);
  }
}
} // namespace singz

#include <zcore/device/audio_host_callback.h>

#include <cmath>
#include <limits>

namespace singz {
namespace {

static_assert(std::atomic<uint32_t>::is_always_lock_free);
static_assert(std::atomic<AudioHostRender>::is_always_lock_free);
static_assert(std::atomic<void*>::is_always_lock_free);

void saturatingAdd(std::atomic<uint32_t>& value, uint32_t amount) noexcept {
  uint32_t old = value.load(std::memory_order_relaxed);
  for (uint32_t attempt = 0; attempt < 4; ++attempt) {
    const uint32_t maximum = std::numeric_limits<uint32_t>::max();
    if (old == maximum) return;
    const uint32_t replacement = amount > maximum - old ? maximum : old + amount;
    if (value.compare_exchange_weak(old, replacement, std::memory_order_relaxed,
                                    std::memory_order_relaxed)) {
      return;
    }
  }
}

void silence(const AudioHostRenderBlock& block) noexcept {
  if (block.output == nullptr) return;
  for (uint32_t channel = 0; channel < block.outputChannels; ++channel) {
    float* samples = block.output[channel];
    if (samples == nullptr) continue;
    for (uint32_t frame = 0; frame < block.frames; ++frame) samples[frame] = 0.0F;
  }
}

bool valid(const AudioHostRenderBlock& block) noexcept {
  if (!block.outputClockMaster || !std::isfinite(block.sampleRate) ||
      block.sampleRate <= 0.0 ||
      block.frames == 0 || block.frames > block.maximumFrames ||
      block.maximumFrames > kAudioHostMaxFrames || block.output == nullptr ||
      block.outputChannels == 0 || block.outputChannels > kAudioHostMaxChannels ||
      block.inputChannels > kAudioHostMaxChannels) {
    return false;
  }
  for (uint32_t channel = 0; channel < block.outputChannels; ++channel) {
    if (block.output[channel] == nullptr) return false;
  }
  if (block.inputChannels != 0) {
    if (block.input == nullptr) return false;
    for (uint32_t channel = 0; channel < block.inputChannels; ++channel) {
      if (block.input[channel] == nullptr) return false;
    }
  }
  return true;
}

}  // namespace

AudioHostOutputTimelineResult resolveAudioHostOutputTimeline(
    AudioHostOutputTimeline* timeline, bool sampleTimeValid,
    uint64_t sampleFrame, bool hostTimeValid, uint32_t frames,
    uint64_t fallbackFrame) noexcept {
  AudioHostOutputTimelineResult result;
  result.outputFrame = sampleTimeValid ? sampleFrame : fallbackFrame;
  if (timeline == nullptr) return result;
  const uint32_t sampleValid = sampleTimeValid ? 1u : 0u;
  const uint32_t hostValid = hostTimeValid ? 1u : 0u;
  if (timeline->initialized != 0) {
    if (sampleValid != timeline->sampleTimeValid ||
        hostValid != timeline->hostTimeValid) {
      result.discontinuity |=
          AudioHostDiscontinuityTimestampQualityChanged;
    } else if (sampleTimeValid && sampleFrame != timeline->expectedFrame) {
      result.discontinuity |= AudioHostDiscontinuitySequenceGap;
    }
  }
  timeline->initialized = 1;
  timeline->sampleTimeValid = sampleValid;
  timeline->hostTimeValid = hostValid;
  timeline->expectedFrame = advanceAudioHostFrame(result.outputFrame, frames);
  return result;
}

void prepareAudioHostCallback(AudioHostCallbackEndpoint* endpoint,
                              AudioHostRender render, void* context) noexcept {
  if (endpoint == nullptr) return;
  endpoint->active.store(0, std::memory_order_release);
  endpoint->context.store(context, std::memory_order_relaxed);
  endpoint->render.store(render, std::memory_order_release);
}

void activateAudioHostCallback(AudioHostCallbackEndpoint* endpoint) noexcept {
  if (endpoint != nullptr) endpoint->active.store(1, std::memory_order_release);
}

void deactivateAudioHostCallback(AudioHostCallbackEndpoint* endpoint) noexcept {
  if (endpoint != nullptr) endpoint->active.store(0, std::memory_order_release);
}

bool invokeAudioHostCallback(AudioHostCallbackEndpoint* endpoint,
                             const AudioHostRenderBlock& block) noexcept {
  if (endpoint == nullptr) {
    silence(block);
    return false;
  }
  endpoint->inFlight.fetch_add(1, std::memory_order_acq_rel);
  if (endpoint->active.load(std::memory_order_acquire) == 0 || !valid(block)) {
    saturatingAdd(endpoint->invalidCallbacks, 1);
    silence(block);
    endpoint->inFlight.fetch_sub(1, std::memory_order_release);
    return false;
  }
  const AudioHostRender render = endpoint->render.load(std::memory_order_acquire);
  void* context = endpoint->context.load(std::memory_order_relaxed);
  if (render == nullptr) {
    saturatingAdd(endpoint->invalidCallbacks, 1);
    silence(block);
    endpoint->inFlight.fetch_sub(1, std::memory_order_release);
    return false;
  }
  const bool rendered = render(context, block);
  saturatingAdd(endpoint->callbacks, 1);
  saturatingAdd(endpoint->renderedFrames, block.frames);
  if (block.discontinuity != AudioHostDiscontinuityNone) {
    saturatingAdd(endpoint->discontinuities, 1);
  }
  if (!rendered) {
    saturatingAdd(endpoint->renderFailures, 1);
    silence(block);
  }
  endpoint->inFlight.fetch_sub(1, std::memory_order_release);
  return rendered;
}

void recordAudioHostXRun(AudioHostCallbackEndpoint* endpoint) noexcept {
  if (endpoint != nullptr) saturatingAdd(endpoint->xruns, 1);
}

void recordAudioHostDeadlineMiss(AudioHostCallbackEndpoint* endpoint) noexcept {
  if (endpoint != nullptr) {
    saturatingAdd(endpoint->deadlineMisses, 1);
  }
}

}  // namespace singz

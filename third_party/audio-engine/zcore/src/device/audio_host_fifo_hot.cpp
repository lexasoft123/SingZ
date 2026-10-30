#include "audio_host_fifo.h"

#include <algorithm>
#include <cmath>
#include <cstddef>

namespace singz::detail {
namespace {

static_assert(std::atomic<uint32_t>::is_always_lock_free);

void saturatingIncrement(std::atomic<uint32_t>& value) noexcept {
  uint32_t old = value.load(std::memory_order_relaxed);
  while (old != UINT32_MAX &&
         !value.compare_exchange_weak(old, old + 1, std::memory_order_relaxed,
                                      std::memory_order_relaxed)) {
  }
}

uint64_t advanceTime(uint64_t value, uint32_t frames,
                     double sampleRate) noexcept {
  if (value == 0 || !std::isfinite(sampleRate) || sampleRate <= 0.0) return value;
  const long double delta = static_cast<long double>(frames) * 1000000000.0L /
                            static_cast<long double>(sampleRate);
  if (delta >= static_cast<long double>(UINT64_MAX - value)) return UINT64_MAX;
  return value + static_cast<uint64_t>(delta);
}

}  // namespace

void AudioHostPlanarFifo::reset() noexcept {
  dataWrite_.store(0, std::memory_order_relaxed);
  dataRead_.store(0, std::memory_order_relaxed);
  spanWrite_.store(0, std::memory_order_relaxed);
  spanRead_.store(0, std::memory_order_relaxed);
  minimumFrames_.store(UINT32_MAX, std::memory_order_relaxed);
  maximumFrames_.store(0, std::memory_order_relaxed);
  underflows_.store(0, std::memory_order_relaxed);
  overflows_.store(0, std::memory_order_relaxed);
  readSpanOffset_ = 0;
  nextWriteDiscontinuous_ = false;
}

bool AudioHostPlanarFifo::writeInterleavedFloat(
    const float* input, uint32_t endpointChannels, const uint32_t* channelMap,
    uint32_t frames, const AudioHostCaptureSpan& supplied, bool silent) noexcept {
  if (channels_ == 0 || capacityFrames_ == 0 || channelMap == nullptr ||
      frames == 0 || frames > capacityFrames_ || endpointChannels == 0 ||
      (!silent && input == nullptr)) {
    saturatingIncrement(overflows_);
    nextWriteDiscontinuous_ = true;
    return false;
  }
  for (uint32_t channel = 0; channel < channels_; ++channel) {
    if (channelMap[channel] >= endpointChannels) {
      saturatingIncrement(overflows_);
      nextWriteDiscontinuous_ = true;
      return false;
    }
  }
  const uint32_t write = dataWrite_.load(std::memory_order_relaxed);
  const uint32_t read = dataRead_.load(std::memory_order_acquire);
  const uint32_t used = write - read;
  const uint32_t spanWrite = spanWrite_.load(std::memory_order_relaxed);
  const uint32_t spanRead = spanRead_.load(std::memory_order_acquire);
  if (used > capacityFrames_ || frames > capacityFrames_ - used ||
      spanWrite - spanRead >= capacityFrames_) {
    saturatingIncrement(overflows_);
    nextWriteDiscontinuous_ = true;
    return false;
  }
  for (uint32_t channel = 0; channel < channels_; ++channel) {
    float* destination = samples_.data() +
                         static_cast<size_t>(channel) * capacityFrames_;
    for (uint32_t frame = 0; frame < frames; ++frame) {
      const uint32_t slot = (write + frame) & (capacityFrames_ - 1);
      destination[slot] = silent
                              ? 0.0F
                              : input[static_cast<size_t>(frame) * endpointChannels +
                                      channelMap[channel]];
    }
  }
  AudioHostCaptureSpan span = supplied;
  span.frames = frames;
  if (nextWriteDiscontinuous_) {
    span.discontinuity |= AudioHostDiscontinuityXRun;
    nextWriteDiscontinuous_ = false;
  }
  spans_[spanWrite & (capacityFrames_ - 1)] = span;
  spanWrite_.store(spanWrite + 1, std::memory_order_relaxed);
  dataWrite_.store(write + frames, std::memory_order_release);
  updateMaximum(used + frames);
  return true;
}

AudioHostFifoRead AudioHostPlanarFifo::read(float* const* output,
                                            uint32_t frames,
                                            double sampleRate,
                                            bool countUnderflow) noexcept {
  AudioHostFifoRead result;
  if (output == nullptr || frames == 0 || channels_ == 0 ||
      capacityFrames_ == 0) return result;
  for (uint32_t channel = 0; channel < channels_; ++channel) {
    if (output[channel] == nullptr) return result;
    std::fill_n(output[channel], frames, 0.0F);
  }
  uint32_t read = dataRead_.load(std::memory_order_relaxed);
  const uint32_t available = dataWrite_.load(std::memory_order_acquire) - read;
  const uint32_t wanted = std::min(frames, available);
  uint32_t copied = 0;
  while (copied < wanted) {
    uint32_t spanRead = spanRead_.load(std::memory_order_relaxed);
    if (spanRead == spanWrite_.load(std::memory_order_acquire)) break;
    const AudioHostCaptureSpan& span =
        spans_[spanRead & (capacityFrames_ - 1)];
    if (readSpanOffset_ >= span.frames) {
      readSpanOffset_ = 0;
      spanRead_.store(spanRead + 1, std::memory_order_release);
      continue;
    }
    const uint32_t take = std::min(wanted - copied, span.frames - readSpanOffset_);
    if (readSpanOffset_ == 0) result.discontinuity |= span.discontinuity;
    if (copied == 0) {
      result.sourceFrame = advanceAudioHostFrame(span.sourceFrame,
                                                 readSpanOffset_);
      result.sampleHostTimeNs = advanceTime(span.sampleHostTimeNs,
                                            readSpanOffset_, sampleRate);
      result.timestampValid = span.timestampValid;
      result.timestampHardware = span.timestampHardware;
    }
    for (uint32_t channel = 0; channel < channels_; ++channel) {
      const float* source = samples_.data() +
                            static_cast<size_t>(channel) * capacityFrames_;
      for (uint32_t frame = 0; frame < take; ++frame) {
        output[channel][copied + frame] =
            source[(read + frame) & (capacityFrames_ - 1)];
      }
    }
    copied += take;
    read += take;
    readSpanOffset_ += take;
    if (readSpanOffset_ == span.frames) {
      readSpanOffset_ = 0;
      spanRead_.store(spanRead + 1, std::memory_order_release);
    }
  }
  dataRead_.store(read, std::memory_order_release);
  result.framesRead = copied;
  const uint32_t remaining = dataWrite_.load(std::memory_order_acquire) - read;
  updateMinimum(remaining);
  if (copied < frames && countUnderflow) {
    result.discontinuity |= AudioHostDiscontinuityXRun;
    saturatingIncrement(underflows_);
  }
  return result;
}

uint32_t AudioHostPlanarFifo::currentFrames() const noexcept {
  const uint32_t read = dataRead_.load(std::memory_order_acquire);
  const uint32_t used = dataWrite_.load(std::memory_order_acquire) - read;
  return std::min(used, capacityFrames_);
}
uint32_t AudioHostPlanarFifo::minimumFrames() const noexcept {
  const uint32_t value = minimumFrames_.load(std::memory_order_relaxed);
  return value == UINT32_MAX ? 0 : value;
}
uint32_t AudioHostPlanarFifo::maximumFrames() const noexcept {
  return maximumFrames_.load(std::memory_order_relaxed);
}
uint32_t AudioHostPlanarFifo::underflows() const noexcept {
  return underflows_.load(std::memory_order_relaxed);
}
uint32_t AudioHostPlanarFifo::overflows() const noexcept {
  return overflows_.load(std::memory_order_relaxed);
}
void AudioHostPlanarFifo::seedEmptyCursorsForTest(
    uint32_t dataCursor, uint32_t spanCursor) noexcept {
  dataWrite_.store(dataCursor, std::memory_order_relaxed);
  dataRead_.store(dataCursor, std::memory_order_relaxed);
  spanWrite_.store(spanCursor, std::memory_order_relaxed);
  spanRead_.store(spanCursor, std::memory_order_relaxed);
  readSpanOffset_ = 0;
  nextWriteDiscontinuous_ = false;
}
void AudioHostPlanarFifo::updateMaximum(uint32_t value) noexcept {
  uint32_t old = maximumFrames_.load(std::memory_order_relaxed);
  while (old < value && !maximumFrames_.compare_exchange_weak(
                            old, value, std::memory_order_relaxed,
                            std::memory_order_relaxed)) {
  }
}
void AudioHostPlanarFifo::updateMinimum(uint32_t value) noexcept {
  uint32_t old = minimumFrames_.load(std::memory_order_relaxed);
  while (old > value && !minimumFrames_.compare_exchange_weak(
                            old, value, std::memory_order_relaxed,
                            std::memory_order_relaxed)) {
  }
}

}  // namespace singz::detail

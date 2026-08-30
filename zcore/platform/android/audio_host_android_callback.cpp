#include "audio_host_android_callback.h"

#include <time.h>

#include <cstddef>
#include <cstdint>

#include <zcore/audio/audio_input_timestamp.h>

namespace singz::detail {
namespace {

static_assert(std::atomic<uint32_t>::is_always_lock_free);
static_assert(std::atomic<int32_t>::is_always_lock_free);

constexpr uint32_t kMaximumDrainReadsPerCallback = 8;

uint32_t low32(uint64_t value) noexcept {
  return static_cast<uint32_t>(value & 0xffffffffu);
}

uint32_t high32(uint64_t value) noexcept {
  return static_cast<uint32_t>(value >> 32u);
}

uint64_t join32(uint32_t low, uint32_t high) noexcept {
  return static_cast<uint64_t>(low) | (static_cast<uint64_t>(high) << 32u);
}

uint64_t callbackMonotonicNowNs() noexcept {
  timespec now{};
  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0 || now.tv_sec < 0 ||
      now.tv_nsec < 0) return 0;
  return static_cast<uint64_t>(now.tv_sec) * 1000000000ULL +
         static_cast<uint64_t>(now.tv_nsec);
}

class CallbackDeadlineScope final {
 public:
  CallbackDeadlineScope(AudioHostCallbackEndpoint* endpoint,
                        uint64_t entry, uint32_t frames,
                        uint32_t rate) noexcept
      : endpoint_(endpoint), entry_(entry), frames_(frames), rate_(rate) {}
  ~CallbackDeadlineScope() noexcept {
    if (androidAudioHostDeadlineMiss(entry_, callbackMonotonicNowNs(), frames_,
                                     rate_)) {
      recordAudioHostDeadlineMiss(endpoint_);
    }
  }
 private:
  AudioHostCallbackEndpoint* endpoint_;
  uint64_t entry_;
  uint32_t frames_;
  uint32_t rate_;
};

void silenceInterleaved(float* output, uint32_t channels,
                        uint32_t frames) noexcept {
  if (output == nullptr) return;
  const std::size_t samples =
      static_cast<std::size_t>(channels) * static_cast<std::size_t>(frames);
  for (std::size_t index = 0; index < samples; ++index) output[index] = 0.0F;
}

void silencePlanar(AndroidAudioHostCallbackContext& context,
                   uint32_t frames) noexcept {
  for (uint32_t channel = 0; channel < context.format.inputChannels;
       ++channel) {
    float* samples = const_cast<float*>(context.inputPointers[channel]);
    if (samples == nullptr) continue;
    for (uint32_t frame = 0; frame < frames; ++frame) samples[frame] = 0.0F;
  }
  for (uint32_t channel = 0; channel < context.format.outputChannels;
       ++channel) {
    float* samples = context.outputPointers[channel];
    if (samples == nullptr) continue;
    for (uint32_t frame = 0; frame < frames; ++frame) samples[frame] = 0.0F;
  }
}

void observeInputOccupancy(AndroidAudioHostCallbackContext& context,
                           uint32_t frames) noexcept {
  context.inputOccupancyCurrent.store(frames, std::memory_order_relaxed);
  uint32_t minimum =
      context.inputOccupancyMinimum.load(std::memory_order_relaxed);
  if (frames < minimum) {
    (void)context.inputOccupancyMinimum.compare_exchange_strong(
        minimum, frames, std::memory_order_relaxed, std::memory_order_relaxed);
  }
  uint32_t maximum =
      context.inputOccupancyMaximum.load(std::memory_order_relaxed);
  if (frames > maximum) {
    (void)context.inputOccupancyMaximum.compare_exchange_strong(
        maximum, frames, std::memory_order_relaxed, std::memory_order_relaxed);
  }
}

void incrementBounded(std::atomic<uint32_t>& counter) noexcept {
  uint32_t value = counter.load(std::memory_order_relaxed);
  if (value != UINT32_MAX) {
    (void)counter.compare_exchange_strong(
        value, value + 1, std::memory_order_relaxed,
        std::memory_order_relaxed);
  }
}

void terminal(AndroidAudioHostCallbackContext& context,
              AndroidAudioHostRuntimeFailure failure) noexcept {
  context.failureGeneration.fetch_add(1, std::memory_order_acq_rel);
  int32_t expected = static_cast<int32_t>(AndroidAudioHostRuntimeFailure::None);
  context.runtimeFailure.compare_exchange_strong(
      expected, static_cast<int32_t>(failure), std::memory_order_release,
      std::memory_order_relaxed);
  context.admission.beginClose();
  deactivateAudioHostCallback(&context.endpoint);
}

bool routeStillCurrent(
    const AndroidAudioHostCallbackContext& context) noexcept {
  return context.routeGeneration != nullptr &&
         context.routeGeneration->load(std::memory_order_acquire) ==
             context.expectedRouteGeneration;
}

bool readInput(AndroidAudioHostCallbackContext& context, uint32_t frames,
               uint32_t* framesRead, bool tolerateStarting) noexcept {
  *framesRead = 0;
  if (context.inputStream == nullptr || context.inputInterleaved == nullptr) {
    return false;
  }
  const auto result = context.inputStream->read(
      context.inputInterleaved, static_cast<int32_t>(frames), 0);
  if (!result) {
    return tolerateStarting &&
           result.error() == oboe::Result::ErrorInvalidState;
  }
  const int32_t count = result.value();
  if (count < 0 || static_cast<uint32_t>(count) > frames) return false;
  *framesRead = static_cast<uint32_t>(count);
  return true;
}

bool drainInput(AndroidAudioHostCallbackContext& context, uint32_t frames,
                bool* produced) noexcept {
  *produced = false;
  for (uint32_t attempt = 0; attempt < kMaximumDrainReadsPerCallback;
       ++attempt) {
    uint32_t read = 0;
    if (!readInput(context, frames, &read, true)) return false;
    if (read == 0) {
      observeInputOccupancy(context, 0);
      break;
    }
    context.inputSourceFrame =
        advanceAudioHostFrame(context.inputSourceFrame, read);
    *produced = true;
  }
  return true;
}

bool discardInput(AndroidAudioHostCallbackContext& context,
                  uint32_t frames) noexcept {
  const auto available = context.inputStream->getAvailableFrames();
  if (!available) {
    return available.error() == oboe::Result::ErrorInvalidState;
  }
  if (available.value() <= 0) {
    observeInputOccupancy(context, 0);
    return true;
  }
  const uint32_t before = static_cast<uint32_t>(available.value());
  observeInputOccupancy(context, before);
  uint32_t ignored = 0;
  if (!readInput(context, frames, &ignored, true)) return false;
  observeInputOccupancy(context, before > ignored ? before - ignored : 0);
  context.inputSourceFrame =
      advanceAudioHostFrame(context.inputSourceFrame, ignored);
  return true;
}

bool pullInput(AndroidAudioHostCallbackContext& context, uint32_t frames,
               uint32_t* framesRead) noexcept {
  const auto available = context.inputStream->getAvailableFrames();
  if (!available) return false;
  if (available.value() <= 0) {
    observeInputOccupancy(context, 0);
    *framesRead = 0;
    return true;
  }
  const uint32_t before = static_cast<uint32_t>(available.value());
  observeInputOccupancy(context, before);
  if (!readInput(context, frames, framesRead, false)) return false;
  observeInputOccupancy(context,
                        before > *framesRead ? before - *framesRead : 0);
  return true;
}

void deinterleaveInput(AndroidAudioHostCallbackContext& context,
                       uint32_t frames, uint32_t framesRead) noexcept {
  for (uint32_t channel = 0; channel < context.format.inputChannels;
       ++channel) {
    float* destination = const_cast<float*>(context.inputPointers[channel]);
    const uint32_t sourceChannel = context.inputChannelMap[channel];
    for (uint32_t frame = 0; frame < framesRead; ++frame) {
      destination[frame] =
          context.inputInterleaved[
              static_cast<std::size_t>(frame) *
                  context.inputEndpointChannels +
              sourceChannel];
    }
    for (uint32_t frame = framesRead; frame < frames; ++frame) {
      destination[frame] = 0.0F;
    }
  }
}

void interleaveOutput(const AndroidAudioHostCallbackContext& context,
                      float* output, uint32_t frames) noexcept {
  for (uint32_t physical = 0; physical < context.outputEndpointChannels;
       ++physical) {
    const int32_t source = context.outputChannelMap[physical];
    if (source < 0) continue;
    const float* samples =
        context.outputPointers[static_cast<uint32_t>(source)];
    for (uint32_t frame = 0; frame < frames; ++frame) {
      output[static_cast<std::size_t>(frame) *
                 context.outputEndpointChannels +
             physical] = samples[frame];
    }
  }
}

bool driverXrunObserved(AndroidAudioHostCallbackContext& context) noexcept {
  const uint32_t inputXruns = context.inputDriverXruns != nullptr
                                  ? context.inputDriverXruns->load(
                                        std::memory_order_relaxed)
                                  : context.seenDriverXruns.input;
  const uint32_t outputXruns = context.outputDriverXruns != nullptr
                                   ? context.outputDriverXruns->load(
                                         std::memory_order_relaxed)
                                   : context.seenDriverXruns.output;
  const bool driverXrun = androidAudioHostDriverXrunChanged(
      &context.seenDriverXruns, inputXruns, outputXruns);
  if (driverXrun) recordAudioHostXRun(&context.endpoint);
  return driverXrun;
}

uint32_t inputDiscontinuity(AndroidAudioHostCallbackContext& context,
                            uint32_t framesRead, uint32_t frames) noexcept {
  const bool driverXrun = driverXrunObserved(context);
  if (framesRead == frames && !driverXrun) {
    context.consecutiveEmptyInput = 0;
    return AudioHostDiscontinuityNone;
  }
  if (framesRead != frames) {
    recordAudioHostXRun(&context.endpoint);
    incrementBounded(context.inputUnderflows);
  }
  if (framesRead == 0) {
    if (context.consecutiveEmptyInput != UINT32_MAX) {
      ++context.consecutiveEmptyInput;
    }
    if (context.starvationLimitCallbacks != 0 &&
        context.consecutiveEmptyInput >= context.starvationLimitCallbacks) {
      terminal(context, AndroidAudioHostRuntimeFailure::InputStarvation);
    }
  } else {
    context.consecutiveEmptyInput = 0;
  }
  return AudioHostDiscontinuityXRun;
}

}  // namespace

void AndroidAudioHostTimestampMailbox::reset() noexcept {
  sequence.fetch_add(1, std::memory_order_acq_rel);
  frameLow.store(0, std::memory_order_relaxed);
  frameHigh.store(0, std::memory_order_relaxed);
  timeLow.store(0, std::memory_order_relaxed);
  timeHigh.store(0, std::memory_order_relaxed);
  sampledLow.store(0, std::memory_order_relaxed);
  sampledHigh.store(0, std::memory_order_relaxed);
  sequence.fetch_add(1, std::memory_order_release);
}

bool AndroidAudioHostTimestampMailbox::publish(
    int64_t framePosition, int64_t hostTimeNs, uint64_t sampledAtNs) noexcept {
  if (framePosition < 0 || hostTimeNs <= 0 || sampledAtNs == 0) return false;
  const uint64_t frame = static_cast<uint64_t>(framePosition);
  const uint64_t time = static_cast<uint64_t>(hostTimeNs);
  sequence.fetch_add(1, std::memory_order_acq_rel);
  frameLow.store(low32(frame), std::memory_order_relaxed);
  frameHigh.store(high32(frame), std::memory_order_relaxed);
  timeLow.store(low32(time), std::memory_order_relaxed);
  timeHigh.store(high32(time), std::memory_order_relaxed);
  sampledLow.store(low32(sampledAtNs), std::memory_order_relaxed);
  sampledHigh.store(high32(sampledAtNs), std::memory_order_relaxed);
  sequence.fetch_add(1, std::memory_order_release);
  return true;
}

AndroidAudioHostTimestampProjection AndroidAudioHostTimestampMailbox::project(
    uint64_t framePosition, uint32_t sampleRate,
    uint64_t callbackEntryNs) const noexcept {
  if (sampleRate == 0) return {};
  for (uint32_t attempt = 0; attempt < 3; ++attempt) {
    const uint32_t before = sequence.load(std::memory_order_acquire);
    if ((before & 1u) != 0) continue;
    const uint32_t savedFrameLow = frameLow.load(std::memory_order_relaxed);
    const uint32_t savedFrameHigh = frameHigh.load(std::memory_order_relaxed);
    const uint32_t savedTimeLow = timeLow.load(std::memory_order_relaxed);
    const uint32_t savedTimeHigh = timeHigh.load(std::memory_order_relaxed);
    const uint32_t savedSampledLow = sampledLow.load(std::memory_order_relaxed);
    const uint32_t savedSampledHigh = sampledHigh.load(std::memory_order_relaxed);
    const uint32_t after = sequence.load(std::memory_order_acquire);
    if (before != after || (after & 1u) != 0) continue;
    return projectAndroidAudioHostTimestamp(
        {join32(savedFrameLow, savedFrameHigh),
         join32(savedTimeLow, savedTimeHigh),
         join32(savedSampledLow, savedSampledHigh), true},
        framePosition, sampleRate, callbackEntryNs);
  }
  return {};
}

oboe::DataCallbackResult AndroidAudioHostCallback::onAudioReady(
    oboe::AudioStream* stream, void* audioData, int32_t numFrames) noexcept {
  const uint64_t callbackEntryNs = callbackMonotonicNowNs();
  float* output = static_cast<float*>(audioData);
  if (numFrames > 0) {
    silenceInterleaved(output, outputEndpointChannels_,
                       static_cast<uint32_t>(numFrames));
  }
  AudioInputCallbackOwnerScope<AndroidAudioHostCallbackOwner> owner(owner_);
  if (!owner || owner->context == nullptr) {
    static_assert(androidAudioHostRejectedCallbackContinues());
    return oboe::DataCallbackResult::Continue;
  }
  AndroidAudioHostCallbackContext* self = owner->context;
  AudioInputCallbackScope admission(self->admission);
  if (!admission ||
      self->runtimeFailure.load(std::memory_order_acquire) !=
          static_cast<int32_t>(AndroidAudioHostRuntimeFailure::None)) {
    return oboe::DataCallbackResult::Continue;
  }
  if (!routeStillCurrent(*self)) {
    terminal(*self, AndroidAudioHostRuntimeFailure::RouteChanged);
    return oboe::DataCallbackResult::Continue;
  }
  if (stream != self->outputStream || output == nullptr || numFrames <= 0) {
    terminal(*self, AndroidAudioHostRuntimeFailure::InvalidBuffer);
    return oboe::DataCallbackResult::Continue;
  }
  const uint32_t frames = static_cast<uint32_t>(numFrames);
  if (frames > self->format.maximumFrames) {
    terminal(*self, AndroidAudioHostRuntimeFailure::CallbackTooLarge);
    return oboe::DataCallbackResult::Continue;
  }
  CallbackDeadlineScope deadline(
      &self->endpoint, callbackEntryNs, frames,
      static_cast<uint32_t>(self->format.sampleRate));

  uint32_t framesRead = 0;
  if (self->format.inputChannels != 0) {
    if (self->drain.callbacksToDrain != 0) {
      bool produced = false;
      if (!drainInput(*self, frames, &produced)) {
        terminal(*self, AndroidAudioHostRuntimeFailure::InputRead);
      } else {
        (void)androidAudioHostDrainAction(&self->drain, produced);
        if (produced) {
          self->consecutiveEmptyInput = 0;
        } else {
          (void)inputDiscontinuity(*self, 0, frames);
        }
      }
      self->outputFrame = advanceAudioHostFrame(self->outputFrame, frames);
      return oboe::DataCallbackResult::Continue;
    }
    const AndroidAudioHostDrainAction action =
        androidAudioHostDrainAction(&self->drain, false);
    if (action == AndroidAudioHostDrainAction::Cushion) {
      self->outputFrame = advanceAudioHostFrame(self->outputFrame, frames);
      return oboe::DataCallbackResult::Continue;
    }
    if (action == AndroidAudioHostDrainAction::Discard) {
      if (!discardInput(*self, frames)) {
        terminal(*self, AndroidAudioHostRuntimeFailure::InputRead);
      }
      self->outputFrame = advanceAudioHostFrame(self->outputFrame, frames);
      return oboe::DataCallbackResult::Continue;
    }
    if (self->firstRender != 0) {
      self->inputOccupancyCurrent.store(0, std::memory_order_relaxed);
      self->inputOccupancyMinimum.store(UINT32_MAX,
                                        std::memory_order_relaxed);
      self->inputOccupancyMaximum.store(0, std::memory_order_relaxed);
      self->inputUnderflows.store(0, std::memory_order_relaxed);
      self->seenDriverXruns.input = self->inputDriverXruns != nullptr
                                         ? self->inputDriverXruns->load(
                                               std::memory_order_relaxed)
                                         : 0;
      self->seenDriverXruns.output = self->outputDriverXruns != nullptr
                                          ? self->outputDriverXruns->load(
                                                std::memory_order_relaxed)
                                          : 0;
    }
    const uint64_t inputFrameStart = self->inputSourceFrame;
    if (!pullInput(*self, frames, &framesRead)) {
      terminal(*self, AndroidAudioHostRuntimeFailure::InputRead);
      return oboe::DataCallbackResult::Continue;
    }
    self->inputSourceFrame =
        advanceAudioHostFrame(self->inputSourceFrame, framesRead);
    deinterleaveInput(*self, frames, framesRead);
    const auto inputTime = self->inputTimestamp.project(
        inputFrameStart, static_cast<uint32_t>(self->format.sampleRate),
        callbackEntryNs);
    const auto resolvedInputTime = resolveAudioInputTimestamp(
        inputTime.hardware, inputTime.hostTimeNs, callbackEntryNs, frames,
        self->format.sampleRate);

    for (uint32_t channel = 0; channel < self->format.outputChannels;
         ++channel) {
      float* samples = self->outputPointers[channel];
      for (uint32_t frame = 0; frame < frames; ++frame) samples[frame] = 0.0F;
    }
    uint32_t discontinuity = AudioHostDiscontinuityNone;
    if (self->firstRender != 0) {
      self->firstRender = 0;
      discontinuity |= AudioHostDiscontinuityStart;
    }
    discontinuity |= inputDiscontinuity(*self, framesRead, frames);
    const uint32_t inputHardware = resolvedInputTime.usedHardwareAnchor ? 1u : 0u;
    if (self->inputTimestampHardware <= 1u &&
        self->inputTimestampHardware != inputHardware) {
      discontinuity |= AudioHostDiscontinuityTimestampQualityChanged;
      if (inputHardware != 0) {
        discontinuity |= AudioHostDiscontinuityClockReanchored;
      }
    }
    self->inputTimestampHardware = inputHardware;

    const auto outputTime = self->outputTimestamp.project(
        self->outputFrame, static_cast<uint32_t>(self->format.sampleRate),
        callbackEntryNs);
    const AudioHostOutputTimelineResult timeline =
        resolveAudioHostOutputTimeline(&self->outputTimeline, true,
                                       self->outputFrame, outputTime.hardware,
                                       frames, self->outputFrame);
    discontinuity |= timeline.discontinuity;
    AudioHostRenderBlock block{
        self->inputPointers.data(),
        self->outputPointers.data(),
        self->format.inputChannels,
        self->format.outputChannels,
        frames,
        self->format.maximumFrames,
        self->format.sampleRate,
        4,
        self->expectedRouteGeneration,
        self->streamGeneration,
        self->callbackSequence,
        inputFrameStart,
        resolvedInputTime.sampleHostTimeNs,
        resolvedInputTime.sampleHostTimeNs != 0,
        resolvedInputTime.usedHardwareAnchor,
        timeline.outputFrame,
        outputTime.hardware ? outputTime.hostTimeNs : callbackEntryNs,
        outputTime.hardware ? outputTime.hostTimeNs != 0 : callbackEntryNs != 0,
        outputTime.hardware,
        callbackEntryNs,
        discontinuity,
        true};
    const bool rendered =
        self->runtimeFailure.load(std::memory_order_acquire) ==
                static_cast<int32_t>(AndroidAudioHostRuntimeFailure::None) &&
        invokeAudioHostCallback(&self->endpoint, block);
    if (rendered &&
        self->runtimeFailure.load(std::memory_order_acquire) ==
            static_cast<int32_t>(AndroidAudioHostRuntimeFailure::None)) {
      interleaveOutput(*self, output, frames);
    } else {
      silencePlanar(*self, frames);
    }
    self->callbackSequence = advanceAudioHostFrame(self->callbackSequence, 1);
    self->outputFrame = advanceAudioHostFrame(self->outputFrame, frames);
    return oboe::DataCallbackResult::Continue;
  }

  // Output-only streams share the same output master clock without touching
  // the paired-input code above.
  for (uint32_t channel = 0; channel < self->format.outputChannels;
       ++channel) {
    float* samples = self->outputPointers[channel];
    for (uint32_t frame = 0; frame < frames; ++frame) samples[frame] = 0.0F;
  }
  uint32_t discontinuity = AudioHostDiscontinuityNone;
  if (self->firstRender != 0) {
    self->firstRender = 0;
    discontinuity |= AudioHostDiscontinuityStart;
  }
  if (driverXrunObserved(*self)) {
    discontinuity |= AudioHostDiscontinuityXRun;
  }

  const auto outputTime = self->outputTimestamp.project(
      self->outputFrame, static_cast<uint32_t>(self->format.sampleRate),
      callbackEntryNs);
  const AudioHostOutputTimelineResult timeline = resolveAudioHostOutputTimeline(
      &self->outputTimeline, true, self->outputFrame, outputTime.hardware, frames,
      self->outputFrame);
  discontinuity |= timeline.discontinuity;
  AudioHostRenderBlock block{
      nullptr,
      self->outputPointers.data(),
      self->format.inputChannels,
      self->format.outputChannels,
      frames,
      self->format.maximumFrames,
      self->format.sampleRate,
      4,
      self->expectedRouteGeneration,
      self->streamGeneration,
      self->callbackSequence,
      0,
      0,
      false,
      false,
      timeline.outputFrame,
      outputTime.hardware ? outputTime.hostTimeNs : callbackEntryNs,
      outputTime.hardware ? outputTime.hostTimeNs != 0 : callbackEntryNs != 0,
      outputTime.hardware,
      callbackEntryNs,
      discontinuity,
      true};
  const bool rendered =
      self->runtimeFailure.load(std::memory_order_acquire) ==
              static_cast<int32_t>(AndroidAudioHostRuntimeFailure::None) &&
      invokeAudioHostCallback(&self->endpoint, block);
  if (rendered &&
      self->runtimeFailure.load(std::memory_order_acquire) ==
          static_cast<int32_t>(AndroidAudioHostRuntimeFailure::None)) {
    interleaveOutput(*self, output, frames);
  } else {
    silencePlanar(*self, frames);
  }
  self->callbackSequence = advanceAudioHostFrame(self->callbackSequence, 1);
  self->outputFrame = advanceAudioHostFrame(self->outputFrame, frames);
  return oboe::DataCallbackResult::Continue;
}

}  // namespace singz::detail

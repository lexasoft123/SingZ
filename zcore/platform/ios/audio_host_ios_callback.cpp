#include "audio_host_ios_callback.h"

#include <mach/mach_time.h>

#include <cstddef>
#include <cstdint>

#include <zcore/audio/audio_input_timestamp.h>

namespace singz::detail {
namespace {

constexpr int32_t kCallbackTooLarge = INT32_MIN;
constexpr int32_t kCallbackLayoutInvalid = INT32_MIN + 1;

static_assert(std::atomic<uint32_t>::is_always_lock_free);
static_assert(std::atomic<int32_t>::is_always_lock_free);
static_assert(std::atomic<uint64_t>::is_always_lock_free);

class CallbackInFlightScope final {
 public:
  explicit CallbackInFlightScope(std::atomic<uint32_t>& inFlight) noexcept
      : inFlight_(inFlight) {
    inFlight_.fetch_add(1, std::memory_order_acq_rel);
  }
  ~CallbackInFlightScope() noexcept {
    inFlight_.fetch_sub(1, std::memory_order_release);
  }

 private:
  std::atomic<uint32_t>& inFlight_;
};

uint64_t hostTicksToNanos(
    uint64_t ticks, const mach_timebase_info_data_t& timebase) noexcept {
  return (ticks / timebase.denom) * timebase.numer +
         ((ticks % timebase.denom) * timebase.numer) / timebase.denom;
}

void setOutputSilenceFlag(AudioUnitRenderActionFlags* flags,
                          bool silent) noexcept {
  if (flags == nullptr) return;
  *flags = static_cast<AudioUnitRenderActionFlags>(audioHostFinalActionFlags(
      *flags, kAudioUnitRenderAction_OutputIsSilence, silent));
}

void silence(AudioBufferList* buffers) noexcept {
  if (buffers == nullptr) return;
  for (UInt32 channel = 0; channel < buffers->mNumberBuffers; ++channel) {
    auto* bytes = static_cast<uint8_t*>(buffers->mBuffers[channel].mData);
    if (bytes == nullptr) continue;
    for (UInt32 byte = 0; byte < buffers->mBuffers[channel].mDataByteSize;
         ++byte) {
      bytes[byte] = 0;
    }
  }
}

void silenceInput(IosAudioHostCallbackContext& context,
                  uint32_t frames) noexcept {
  for (uint32_t channel = 0; channel < context.format.inputChannels;
       ++channel) {
    float* samples = const_cast<float*>(context.inputPointers[channel]);
    for (uint32_t frame = 0; frame < frames; ++frame) {
      samples[frame] = 0.0F;
    }
  }
}

void setTerminalFailure(IosAudioHostCallbackContext& context,
                        int32_t failure) noexcept {
  int32_t expected = 0;
  context.callbackFailure.compare_exchange_strong(
      expected, failure, std::memory_order_release,
      std::memory_order_relaxed);
}

uint32_t pendingSignals(const IosAudioHostCallbackContext& context) noexcept {
  return context.signals == nullptr
             ? UINT32_MAX
             : context.signals->pending.load(std::memory_order_acquire);
}

}  // namespace

OSStatus iosAudioHostRenderCallback(void* context,
                                    AudioUnitRenderActionFlags* flags,
                                    const AudioTimeStamp* timestamp, UInt32,
                                    UInt32 frames,
                                    AudioBufferList* output) noexcept {
  const uint64_t callbackTicks = mach_absolute_time();
  auto* self = static_cast<IosAudioHostCallbackContext*>(context);
  if (self == nullptr || output == nullptr) return noErr;
  CallbackInFlightScope callbackScope(self->callbackInFlight);
  AudioInputCallbackScope admission(self->admission);
  if (!admission || pendingSignals(*self) != 0 ||
      self->callbackFailure.load(std::memory_order_acquire) != 0) {
    silence(output);
    setOutputSilenceFlag(flags, true);
    return noErr;
  }
  if (frames == 0 || frames > self->format.maximumFrames) {
    silence(output);
    setOutputSilenceFlag(flags, true);
    setTerminalFailure(*self, kCallbackTooLarge);
    invokeAudioHostCallback(&self->endpoint, {});
    return noErr;
  }
  if (output->mNumberBuffers != self->format.outputChannels) {
    silence(output);
    setOutputSilenceFlag(flags, true);
    setTerminalFailure(*self, kCallbackLayoutInvalid);
    invokeAudioHostCallback(&self->endpoint, {});
    return noErr;
  }
  for (uint32_t channel = 0; channel < self->format.outputChannels;
       ++channel) {
    const AudioBuffer& buffer = output->mBuffers[channel];
    if (buffer.mNumberChannels != 1 || buffer.mData == nullptr ||
        buffer.mDataByteSize < frames * sizeof(float)) {
      silence(output);
      setOutputSilenceFlag(flags, true);
      setTerminalFailure(*self, kCallbackLayoutInvalid);
      invokeAudioHostCallback(&self->endpoint, {});
      return noErr;
    }
    self->outputPointers[channel] = static_cast<float*>(buffer.mData);
  }

  bool inputFailed = false;
  if (self->format.inputChannels != 0) {
    for (uint32_t channel = 0; channel < self->format.inputChannels;
         ++channel) {
      self->inputList->mBuffers[channel].mDataByteSize =
          frames * sizeof(float);
    }
    AudioUnitRenderActionFlags inputFlags = 0;
    const OSStatus inputStatus = AudioUnitRender(
        self->unit, &inputFlags, timestamp, 1, frames, self->inputList);
    inputFailed = audioHostInputPullFailed(
        inputStatus, inputFlags, kAudioUnitRenderAction_PostRenderError);
    if (inputFailed) {
      silenceInput(*self, frames);
      recordAudioHostXRun(&self->endpoint);
    }
  }

  uint32_t discontinuity = AudioHostDiscontinuityNone;
  if (self->firstCallback.exchange(0, std::memory_order_relaxed) != 0) {
    discontinuity |= AudioHostDiscontinuityStart;
  }
  if (inputFailed) discontinuity |= AudioHostDiscontinuityXRun;

  const uint64_t callbackNs = hostTicksToNanos(callbackTicks, self->timebase);
  const bool hostTimeValid =
      timestamp != nullptr &&
      (timestamp->mFlags & kAudioTimeStampHostTimeValid) != 0 &&
      timestamp->mHostTime != 0;
  const uint64_t hardwareNs =
      hostTimeValid ? hostTicksToNanos(timestamp->mHostTime, self->timebase)
                    : 0;
  const bool hasInput = self->format.inputChannels != 0;
  const AudioInputTimestampProjection inputProjection =
      hasInput ? resolveAudioInputTimestamp(false, 0, callbackNs, frames,
                                             self->format.sampleRate)
               : AudioInputTimestampProjection{};
  const bool outputFrameValid =
      timestamp != nullptr &&
      (timestamp->mFlags & kAudioTimeStampSampleTimeValid) != 0 &&
      validAudioHostSampleFrame(timestamp->mSampleTime, frames);
  const uint64_t sampleFrame =
      outputFrameValid ? static_cast<uint64_t>(timestamp->mSampleTime) : 0;
  const AudioHostOutputTimelineResult timeline =
      resolveAudioHostOutputTimeline(
          &self->outputTimeline, outputFrameValid, sampleFrame, hostTimeValid,
          frames, self->fallbackOutputFrame);
  discontinuity |= timeline.discontinuity;
  self->fallbackOutputFrame =
      advanceAudioHostFrame(timeline.outputFrame, frames);
  const uint64_t inputSourceFrame = hasInput ? self->inputSourceFrame : 0;
  if (hasInput) {
    self->inputSourceFrame =
        advanceAudioHostFrame(self->inputSourceFrame, frames);
  }
  const uint64_t callbackSequence = self->callbackSequence;
  self->callbackSequence =
      advanceAudioHostFrame(self->callbackSequence, 1);

  AudioHostRenderBlock block{
      hasInput ? self->inputPointers.data() : nullptr,
      self->outputPointers.data(),
      self->format.inputChannels,
      self->format.outputChannels,
      frames,
      self->format.maximumFrames,
      self->format.sampleRate,
      3,
      self->signals->routeGeneration.load(std::memory_order_relaxed),
      self->streamGeneration,
      callbackSequence,
      inputSourceFrame,
      inputProjection.sampleHostTimeNs,
      hasInput,
      false,
      timeline.outputFrame,
      hostTimeValid ? hardwareNs : callbackNs,
      hostTimeValid ? hardwareNs != 0 : callbackNs != 0,
      hostTimeValid,
      callbackNs,
      discontinuity,
      true};
  if (pendingSignals(*self) != 0 ||
      self->callbackFailure.load(std::memory_order_acquire) != 0) {
    silence(output);
    setOutputSilenceFlag(flags, true);
    return noErr;
  }
  const bool rendered = invokeAudioHostCallback(&self->endpoint, block);
  const bool outputSilent =
      !rendered || pendingSignals(*self) != 0 ||
      self->callbackFailure.load(std::memory_order_acquire) != 0;
  if (outputSilent) silence(output);
  setOutputSilenceFlag(flags, outputSilent);

  const uint64_t elapsedNs =
      hostTicksToNanos(mach_absolute_time() - callbackTicks, self->timebase);
  const long double deadlineNs =
      static_cast<long double>(frames) * 1000000000.0L /
      self->format.sampleRate;
  if (static_cast<long double>(elapsedNs) > deadlineNs) {
    recordAudioHostDeadlineMiss(&self->endpoint);
  }
  return noErr;
}

}  // namespace singz::detail

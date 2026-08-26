#include "zdsp/builtin_nodes.h"

#include <cmath>
#include <atomic>
#include <bit>
#include <limits.h>
#include <memory>

namespace zdsp {
namespace {

struct BuiltinState {
  BuiltinNodeConfig config;
  uint32_t prepared;
  uint32_t active;
  uint32_t inputChannels;
  uint32_t outputChannels;
  uint32_t maximumFrames;
  float currentValue;
  float rampTarget;
  float rampStep;
  uint32_t rampRemaining;
  double phase;
  std::atomic<uint32_t> telemetrySequence;
  std::atomic<uint32_t> telemetrySlotVersion[2];
  std::atomic<uint32_t> meterPeakBits[2];
  std::atomic<uint32_t> meterRmsBits[2];
  std::atomic<uint32_t> meterFrames[2];
  uint32_t nonFinite;
  float* delaySamples;
  uint32_t delayLength;
  uint32_t delayIndex;
  std::atomic<uint32_t>* tapBits;
  std::atomic<uint32_t> tapFrames[2];
  float matrix[kMaximumChannelsPerBus * kMaximumChannelsPerBus];
};

static_assert(std::atomic<uint32_t>::is_always_lock_free);

uint32_t beginTelemetryWrite(BuiltinState* state, uint32_t* slot,
                             uint32_t* nextSequence) noexcept {
  *nextSequence = state->telemetrySequence.load(std::memory_order_relaxed) + 1;
  *slot = *nextSequence & 1u;
  return state->telemetrySlotVersion[*slot].fetch_add(
      1, std::memory_order_acq_rel) + 1;
}

void endTelemetryWrite(BuiltinState* state, uint32_t slot, uint32_t oddVersion,
                       uint32_t nextSequence) noexcept {
  state->telemetrySlotVersion[slot].store(oddVersion + 1,
                                          std::memory_order_release);
  state->telemetrySequence.store(nextSequence, std::memory_order_release);
}

void publishMeter(BuiltinState* state, float peak, float rms,
                  uint32_t frames) noexcept {
  uint32_t slot = 0, next = 0;
  const uint32_t odd = beginTelemetryWrite(state, &slot, &next);
  state->meterPeakBits[slot].store(std::bit_cast<uint32_t>(peak),
                                   std::memory_order_relaxed);
  state->meterRmsBits[slot].store(std::bit_cast<uint32_t>(rms),
                                  std::memory_order_relaxed);
  state->meterFrames[slot].store(frames, std::memory_order_relaxed);
  endTelemetryWrite(state, slot, odd, next);
}

float normalizedAutomationValue(BuiltinState* state, float value) noexcept {
  if (state->config.kind == BuiltinNodeKind::SafetyLimiter &&
      (value <= 0.0f || value > 1.0f)) return 1.0f;
  return value;
}

void beginAutomation(BuiltinState* state, const ParameterEvent& event) noexcept {
  const float target = normalizedAutomationValue(state, event.value);
  state->rampTarget = target;
  state->rampRemaining = event.curve == ParameterCurve::Linear
      ? event.rampFrames.value : 0;
  if (state->rampRemaining == 0) {
    state->currentValue = target;
    state->rampStep = 0.0f;
  } else {
    state->rampStep = (target - state->currentValue) /
        static_cast<float>(state->rampRemaining);
  }
}

void advanceAutomation(BuiltinState* state) noexcept {
  if (state->rampRemaining == 0) return;
  state->currentValue += state->rampStep;
  if (--state->rampRemaining == 0) state->currentValue = state->rampTarget;
}

void consumeAutomationAt(BuiltinState* state, const ProcessContext* context,
                         uint32_t offset, ParameterId parameter,
                         uint32_t* eventIndex) noexcept {
  while (*eventIndex < context->parameterCount &&
         context->parameters[*eventIndex].sampleOffset.value == offset) {
    const ParameterEvent& event = context->parameters[(*eventIndex)++];
    if (event.node.value == state->config.node.value &&
        event.parameter.value == parameter.value)
      beginAutomation(state, event);
  }
}

float finiteSample(float value, BuiltinState* state) noexcept {
  if (std::isfinite(value)) return value;
  if (state->nonFinite != UINT32_MAX) ++state->nonFinite;
  return 0.0f;
}

bool sameBusShape(const AudioBusDescriptor& input,
                  const AudioBusDescriptor& output) noexcept {
  if (input.channelCount != output.channelCount ||
      input.sampleFormat != output.sampleFormat || input.layout != output.layout)
    return false;
  if (input.layout != AudioChannelLayout::Discrete) return true;
  for (uint32_t channel = 0; channel < input.channelCount; ++channel)
    if (input.channelRoles[channel] != output.channelRoles[channel]) return false;
  return true;
}

Status prepare(void* opaque, const PrepareSpec* spec,
               const PreparedStorage* storage) noexcept {
  if (opaque == nullptr || spec == nullptr || storage == nullptr)
    return {StatusCode::InvalidArgument, 1};
  BuiltinState* state = static_cast<BuiltinState*>(opaque);
  if (state->prepared != 0 || !succeeded(validatePrepareSpec(*spec)))
    return {StatusCode::InvalidArgument, 2};
  const BuiltinNodeConfig& config = state->config;
  if (spec->inputBusCount != config.inputBusCount || spec->outputBusCount != 1)
    return {StatusCode::UnsupportedFormat, 3};
  if (spec->outputBuses[0].channelCount != config.outputChannels)
    return {StatusCode::UnsupportedFormat, 5};
  for (uint32_t bus = 0; bus < spec->inputBusCount; ++bus) {
    if (spec->inputBuses[bus].channelCount != config.inputChannels)
      return {StatusCode::UnsupportedFormat, 6};
  }
  if (config.kind == BuiltinNodeKind::Oscillator) {
    if (spec->inputBusCount != 0)
      return {StatusCode::UnsupportedFormat, 4};
    if (config.value0 > spec->sampleRate.value * 0.5)
      return {StatusCode::UnsupportedFormat, 9};
  } else if (config.kind == BuiltinNodeKind::ChannelMap) {
    if (spec->inputBusCount != 1)
      return {StatusCode::UnsupportedFormat, 4};
  } else if (config.kind == BuiltinNodeKind::Mix) {
    if (spec->inputBusCount == 0)
      return {StatusCode::UnsupportedFormat, 4};
    for (uint32_t bus = 0; bus < spec->inputBusCount; ++bus)
      if (!sameBusShape(spec->inputBuses[bus], spec->outputBuses[0]))
        return {StatusCode::UnsupportedFormat, 10 + bus};
  } else {
    if (spec->inputBusCount != 1 ||
        !sameBusShape(spec->inputBuses[0], spec->outputBuses[0]))
      return {StatusCode::UnsupportedFormat, 4};
  }
  state->inputChannels = config.inputChannels;
  state->outputChannels = config.outputChannels;
  state->maximumFrames = spec->maximumBlockFrames.value;
  state->delayLength = 0;
  state->delaySamples = nullptr;
  state->tapBits = nullptr;
  if (config.kind == BuiltinNodeKind::DelayCompensation && config.frames != 0) {
    const uint64_t samples = static_cast<uint64_t>(config.frames) * config.outputChannels;
    if (samples > UINT32_MAX / sizeof(float) || storage->data == nullptr ||
        storage->size < samples * sizeof(float) ||
        (reinterpret_cast<uintptr_t>(storage->data) & (alignof(float) - 1)) != 0)
      return {StatusCode::InsufficientStorage, 7};
    state->delaySamples = static_cast<float*>(storage->data);
    state->delayLength = config.frames;
    for (uint64_t index = 0; index < samples; ++index) state->delaySamples[index] = 0.0f;
  }
  if (config.kind == BuiltinNodeKind::Tap && config.tapCapacityFrames != 0) {
    const uint64_t samples = static_cast<uint64_t>(config.tapCapacityFrames) * 2;
    const uint64_t bytes = samples * sizeof(std::atomic<uint32_t>);
    if (bytes > static_cast<uint64_t>(static_cast<size_t>(-1)) ||
        storage->data == nullptr || storage->size < bytes ||
        (reinterpret_cast<uintptr_t>(storage->data) &
         (alignof(std::atomic<uint32_t>) - 1)) != 0)
      return {StatusCode::InsufficientStorage, 8};
    state->tapBits = static_cast<std::atomic<uint32_t>*>(storage->data);
    for (uint64_t frame = 0; frame < samples; ++frame)
      std::construct_at(state->tapBits + frame, 0u);
  }
  state->prepared = 1;
  state->active = 1;
  return okStatus();
}

void reset(void* opaque, Discontinuity) noexcept {
  BuiltinState* state = static_cast<BuiltinState*>(opaque);
  state->phase = 0.0;
  state->rampTarget = state->currentValue;
  state->rampRemaining = 0;
  state->rampStep = 0.0f;
  state->delayIndex = 0;
  if (state->config.kind == BuiltinNodeKind::PeakRms) {
    publishMeter(state, 0.0f, 0.0f, 0);
  } else if (state->config.kind == BuiltinNodeKind::Tap) {
    uint32_t slot = 0, next = 0;
    const uint32_t odd = beginTelemetryWrite(state, &slot, &next);
    state->tapFrames[slot].store(0, std::memory_order_relaxed);
    endTelemetryWrite(state, slot, odd, next);
  }
  if (state->delaySamples != nullptr) {
    const uint64_t samples = static_cast<uint64_t>(state->delayLength) * state->outputChannels;
    for (uint64_t index = 0; index < samples; ++index) state->delaySamples[index] = 0.0f;
  }
}

void passInput(BuiltinState* state, const ConstAudioBusView* inputs,
               const MutableAudioBusView& output) noexcept {
  for (uint32_t channel = 0; channel < output.channelCount; ++channel) {
    const float* source = inputs[0].channels[channel];
    float* destination = output.channels[channel];
    if (source == destination) {
      for (uint32_t frame = 0; frame < output.frames.value; ++frame)
        destination[frame] = finiteSample(destination[frame], state);
    } else {
      for (uint32_t frame = 0; frame < output.frames.value; ++frame)
        destination[frame] = finiteSample(source[frame], state);
    }
  }
}

void processGain(BuiltinState* state, const ProcessContext* context,
                 const ConstAudioBusView* inputs,
                 const MutableAudioBusView& output) noexcept {
  uint32_t eventIndex = 0;
  if (context->frames.value == 0)
    consumeAutomationAt(state, context, 0, kGainParameter, &eventIndex);
  for (uint32_t frame = 0; frame < context->frames.value; ++frame) {
    consumeAutomationAt(state, context, frame, kGainParameter, &eventIndex);
    for (uint32_t channel = 0; channel < output.channelCount; ++channel) {
      output.channels[channel][frame] =
          finiteSample(inputs[0].channels[channel][frame], state) *
          state->currentValue;
    }
    advanceAutomation(state);
  }
}

void processMap(BuiltinState* state, const ConstAudioBusView* inputs,
                const MutableAudioBusView& output) noexcept {
  for (uint32_t out = 0; out < output.channelCount; ++out) {
    for (uint32_t frame = 0; frame < output.frames.value; ++frame) {
      float value = 0.0f;
      for (uint32_t in = 0; in < inputs[0].channelCount; ++in) {
        value += finiteSample(inputs[0].channels[in][frame], state) *
                 state->matrix[out * kMaximumChannelsPerBus + in];
      }
      output.channels[out][frame] = finiteSample(value, state);
    }
  }
}

void processMix(BuiltinState* state, const ConstAudioBusView* inputs,
                const MutableAudioBusView& output) noexcept {
  for (uint32_t channel = 0; channel < output.channelCount; ++channel) {
    for (uint32_t frame = 0; frame < output.frames.value; ++frame) {
      float value = 0.0f;
      for (uint32_t bus = 0; bus < state->config.inputBusCount; ++bus)
        value += finiteSample(inputs[bus].channels[channel][frame], state);
      output.channels[channel][frame] = finiteSample(value, state);
    }
  }
}

void processDelay(BuiltinState* state, const ConstAudioBusView* inputs,
                  const MutableAudioBusView& output) noexcept {
  if (state->delayLength == 0) {
    passInput(state, inputs, output);
    return;
  }
  uint32_t cursor = state->delayIndex;
  for (uint32_t frame = 0; frame < output.frames.value; ++frame) {
    for (uint32_t channel = 0; channel < output.channelCount; ++channel) {
      float* lane = state->delaySamples +
                    static_cast<size_t>(channel) * state->delayLength;
      const float incoming = finiteSample(inputs[0].channels[channel][frame], state);
      output.channels[channel][frame] = lane[cursor];
      lane[cursor] = incoming;
    }
    if (++cursor == state->delayLength) cursor = 0;
  }
  state->delayIndex = cursor;
}

void processMeter(BuiltinState* state, const ConstAudioBusView* inputs,
                  const MutableAudioBusView& output) noexcept {
  passInput(state, inputs, output);
  float peak = 0.0f;
  double sumSquares = 0.0;
  uint32_t sampleCount = 0;
  for (uint32_t channel = 0; channel < output.channelCount; ++channel) {
    for (uint32_t frame = 0; frame < output.frames.value; ++frame) {
      const float value = output.channels[channel][frame];
      const float magnitude = std::fabs(value);
      if (magnitude > peak) peak = magnitude;
      sumSquares += static_cast<double>(value) * value;
      ++sampleCount;
    }
  }
  const float rms = sampleCount == 0 ? 0.0f
      : static_cast<float>(std::sqrt(sumSquares / sampleCount));
  publishMeter(state, peak, rms, output.frames.value);
}

void processOscillator(BuiltinState* state, const ProcessContext* context,
                       const MutableAudioBusView& output) noexcept {
  if ((processContextFlags(*context) & ProcessContextFlagTailDrain) != 0) {
    for (uint32_t channel = 0; channel < output.channelCount; ++channel)
      for (uint32_t frame = 0; frame < output.frames.value; ++frame)
        output.channels[channel][frame] = 0.0f;
    return;
  }
  uint32_t eventIndex = 0;
  if (context->frames.value == 0)
    consumeAutomationAt(state, context, 0, kOscillatorFrequencyParameter,
                        &eventIndex);
  for (uint32_t frame = 0; frame < output.frames.value; ++frame) {
    consumeAutomationAt(state, context, frame, kOscillatorFrequencyParameter,
                        &eventIndex);
    float sample = 0.0f;
    if (state->config.waveform == OscillatorWaveform::Sine)
      sample = static_cast<float>(std::sin(state->phase * 6.2831853071795864769));
    else
      sample = static_cast<float>(state->phase * 2.0 - 1.0);
    for (uint32_t channel = 0; channel < output.channelCount; ++channel)
      output.channels[channel][frame] = sample * state->config.value1;
    state->phase += state->currentValue / context->sampleRate.value;
    state->phase -= std::floor(state->phase);
    advanceAutomation(state);
  }
}

void processTap(BuiltinState* state, const ConstAudioBusView* inputs,
                const MutableAudioBusView& output) noexcept {
  passInput(state, inputs, output);
  const uint32_t copied = output.frames.value < state->config.tapCapacityFrames
      ? output.frames.value : state->config.tapCapacityFrames;
  uint32_t slot = 0, next = 0;
  const uint32_t odd = beginTelemetryWrite(state, &slot, &next);
  if (state->tapBits != nullptr) {
    std::atomic<uint32_t>* samples = state->tapBits +
        static_cast<uint64_t>(slot) * state->config.tapCapacityFrames;
    for (uint32_t frame = 0; frame < copied; ++frame)
      samples[frame].store(std::bit_cast<uint32_t>(output.channels[0][frame]),
                           std::memory_order_relaxed);
  }
  state->tapFrames[slot].store(copied, std::memory_order_relaxed);
  endTelemetryWrite(state, slot, odd, next);
}

void processLimiter(BuiltinState* state, const ProcessContext* context,
                    const ConstAudioBusView* inputs,
                    const MutableAudioBusView& output) noexcept {
  uint32_t eventIndex = 0;
  if (context->frames.value == 0)
    consumeAutomationAt(state, context, 0, kLimiterThresholdParameter,
                        &eventIndex);
  for (uint32_t frame = 0; frame < output.frames.value; ++frame) {
    consumeAutomationAt(state, context, frame, kLimiterThresholdParameter,
                        &eventIndex);
    const float threshold = state->currentValue;
    for (uint32_t channel = 0; channel < output.channelCount; ++channel) {
      float value = finiteSample(inputs[0].channels[channel][frame], state);
      if (value > threshold) value = threshold;
      if (value < -threshold) value = -threshold;
      output.channels[channel][frame] = value;
    }
    advanceAutomation(state);
  }
}

void process(void* opaque, const ProcessContext* context,
             const ConstAudioBusView* inputs, uint32_t inputCount,
             const MutableAudioBusView* outputs, uint32_t outputCount) noexcept {
  BuiltinState* state = static_cast<BuiltinState*>(opaque);
  if (state == nullptr || context == nullptr || outputs == nullptr ||
      outputCount != 1 || inputCount != state->config.inputBusCount) return;
  const MutableAudioBusView& output = outputs[0];
  switch (state->config.kind) {
    case BuiltinNodeKind::Gain: processGain(state, context, inputs, output); break;
    case BuiltinNodeKind::ChannelMap: processMap(state, inputs, output); break;
    case BuiltinNodeKind::Mix: processMix(state, inputs, output); break;
    case BuiltinNodeKind::DelayCompensation: processDelay(state, inputs, output); break;
    case BuiltinNodeKind::PeakRms: processMeter(state, inputs, output); break;
    case BuiltinNodeKind::Oscillator: processOscillator(state, context, output); break;
    case BuiltinNodeKind::Tap: processTap(state, inputs, output); break;
    case BuiltinNodeKind::SafetyLimiter: processLimiter(state, context, inputs, output); break;
  }
}

LatencyFrames latency(const void* opaque) noexcept {
  const BuiltinState* state = static_cast<const BuiltinState*>(opaque);
  return {state->config.kind == BuiltinNodeKind::DelayCompensation
              ? state->config.frames : 0};
}
TailInfo tail(const void*) noexcept { return {TailKind::None, {0}}; }
Status deactivate(void* opaque) noexcept {
  BuiltinState* state = static_cast<BuiltinState*>(opaque);
  if (state == nullptr || state->active == 0) return {StatusCode::InvalidArgument, 1};
  state->active = 0;
  return okStatus();
}
Status destroy(void* opaque) noexcept {
  BuiltinState* state = static_cast<BuiltinState*>(opaque);
  if (state == nullptr || state->active != 0) return {StatusCode::InvalidArgument, 1};
  state->prepared = 0;
  std::destroy_at(state);
  return okStatus();
}

uint32_t consumeNonFinite(void* opaque) noexcept {
  BuiltinState* state = static_cast<BuiltinState*>(opaque);
  if (state == nullptr) return 0;
  const uint32_t count = state->nonFinite;
  state->nonFinite = 0;
  return count;
}

constexpr ProcessorVTable kFunctions{kProcessorInterfaceVersion,
    kProcessorVTableV2RequiredSize, prepare, reset, process, latency, tail,
    deactivate, destroy, consumeNonFinite};

}  // namespace

size_t builtinStateBytes(const BuiltinNodeConfig&) noexcept {
  return sizeof(BuiltinState);
}

size_t builtinPreparedBytes(const BuiltinNodeConfig& config,
                            FrameCount) noexcept {
  uint64_t count = 0;
  size_t itemBytes = 0;
  if (config.kind == BuiltinNodeKind::DelayCompensation) {
    count = static_cast<uint64_t>(config.frames) * config.outputChannels;
    itemBytes = sizeof(float);
  } else if (config.kind == BuiltinNodeKind::Tap) {
    count = static_cast<uint64_t>(config.tapCapacityFrames) * 2;
    itemBytes = sizeof(std::atomic<uint32_t>);
  } else {
    return 0;
  }
  if (count > static_cast<uint64_t>(static_cast<size_t>(-1)) / itemBytes)
    return 0;
  return static_cast<size_t>(count) * itemBytes;
}

ProcessorHandle createBuiltinProcessor(const BuiltinNodeConfig& config,
                                       MutableByteView storage) noexcept {
  bool validContract = false;
  switch (config.kind) {
    case BuiltinNodeKind::Gain:
    case BuiltinNodeKind::DelayCompensation:
    case BuiltinNodeKind::PeakRms:
    case BuiltinNodeKind::Tap:
    case BuiltinNodeKind::SafetyLimiter:
      validContract = config.inputBusCount == 1 && config.inputChannels != 0 &&
          config.inputChannels == config.outputChannels;
      break;
    case BuiltinNodeKind::Mix:
      validContract = config.inputBusCount != 0 && config.inputChannels != 0 &&
          config.inputChannels == config.outputChannels;
      break;
    case BuiltinNodeKind::ChannelMap:
      validContract = config.inputBusCount == 1 && config.inputChannels != 0 &&
          config.channelMatrix != nullptr;
      break;
    case BuiltinNodeKind::Oscillator:
      validContract = config.inputBusCount == 0 && config.inputChannels == 0 &&
          config.waveform <= OscillatorWaveform::Saw;
      break;
  }
  if (storage.data == nullptr || storage.capacity < sizeof(BuiltinState) ||
      (reinterpret_cast<uintptr_t>(storage.data) & (alignof(BuiltinState) - 1)) != 0 ||
      config.outputChannels == 0 || config.outputChannels > kMaximumChannelsPerBus ||
      config.inputChannels > kMaximumChannelsPerBus ||
      config.inputBusCount > kMaximumBusesPerProcessor ||
      config.node.value == 0 ||
      config.kind < BuiltinNodeKind::Gain ||
      config.kind > BuiltinNodeKind::SafetyLimiter ||
      !validContract || !std::isfinite(config.value0) ||
      !std::isfinite(config.value1)) return {nullptr, nullptr};
  if (config.kind == BuiltinNodeKind::SafetyLimiter &&
      (config.value0 <= 0.0f || config.value0 > 1.0f))
    return {nullptr, nullptr};
  if (config.kind == BuiltinNodeKind::Oscillator &&
      (config.value0 < 0.0f || config.value1 < 0.0f || config.value1 > 1.0f))
    return {nullptr, nullptr};
  if (config.kind == BuiltinNodeKind::DelayCompensation) {
    const uint64_t samples = static_cast<uint64_t>(config.frames) *
                             config.outputChannels;
    if (samples > UINT32_MAX / sizeof(float) ||
        samples > static_cast<uint64_t>(SIZE_MAX) / sizeof(float))
      return {nullptr, nullptr};
  }
  if (config.kind == BuiltinNodeKind::Tap) {
    const uint64_t samples = static_cast<uint64_t>(config.tapCapacityFrames) * 2;
    if (samples > static_cast<uint64_t>(SIZE_MAX) /
                      sizeof(std::atomic<uint32_t>))
      return {nullptr, nullptr};
  }
  if (config.kind == BuiltinNodeKind::ChannelMap) {
    const uint64_t coefficients = static_cast<uint64_t>(config.inputChannels) *
                                  config.outputChannels;
    for (uint64_t coefficient = 0; coefficient < coefficients; ++coefficient)
      if (!std::isfinite(config.channelMatrix[coefficient]))
        return {nullptr, nullptr};
  }
  BuiltinState* state = reinterpret_cast<BuiltinState*>(storage.data);
  std::construct_at(state);
  state->config = config;
  state->currentValue = normalizedAutomationValue(state, config.value0);
  state->rampTarget = state->currentValue;
  if (config.kind == BuiltinNodeKind::ChannelMap) {
    for (uint32_t out = 0; out < config.outputChannels; ++out) {
      for (uint32_t in = 0; in < config.inputChannels; ++in) {
        state->matrix[out * kMaximumChannelsPerBus + in] =
            config.channelMatrix[out * config.inputChannels + in];
      }
    }
  }
  return {state, &kFunctions};
}

MeterReading builtinMeter(const ProcessorHandle& processor) noexcept {
  if (processor.functions != &kFunctions || processor.state == nullptr) return {};
  const BuiltinState* state = static_cast<const BuiltinState*>(processor.state);
  for (;;) {
    const uint32_t before = state->telemetrySequence.load(std::memory_order_acquire);
    const uint32_t slot = before & 1u;
    const uint32_t slotBefore = state->telemetrySlotVersion[slot].load(
        std::memory_order_acquire);
    if ((slotBefore & 1u) != 0) continue;
    const float peak = std::bit_cast<float>(
        state->meterPeakBits[slot].load(std::memory_order_relaxed));
    const float rms = std::bit_cast<float>(
        state->meterRmsBits[slot].load(std::memory_order_relaxed));
    const uint32_t frames = state->meterFrames[slot].load(std::memory_order_relaxed);
    const uint32_t slotAfter = state->telemetrySlotVersion[slot].load(
        std::memory_order_acquire);
    const uint32_t after = state->telemetrySequence.load(std::memory_order_acquire);
    if (before == after && slotBefore == slotAfter) return {peak, rms, frames};
  }
}

uint32_t builtinTapFrames(const ProcessorHandle& processor) noexcept {
  if (processor.functions != &kFunctions || processor.state == nullptr) return 0;
  const BuiltinState* state = static_cast<const BuiltinState*>(processor.state);
  for (;;) {
    const uint32_t before = state->telemetrySequence.load(std::memory_order_acquire);
    const uint32_t slot = before & 1u;
    const uint32_t slotBefore = state->telemetrySlotVersion[slot].load(
        std::memory_order_acquire);
    if ((slotBefore & 1u) != 0) continue;
    const uint32_t frames = state->tapFrames[slot].load(
        std::memory_order_relaxed);
    const uint32_t slotAfter = state->telemetrySlotVersion[slot].load(
        std::memory_order_acquire);
    const uint32_t after = state->telemetrySequence.load(std::memory_order_acquire);
    if (before == after && slotBefore == slotAfter) return frames;
  }
}

uint32_t builtinTapSnapshotTestOnly(const ProcessorHandle& processor,
                                    float* destination,
                                    uint32_t capacityFrames,
                                    BuiltinTelemetryReadHook hook,
                                    void* hookContext) noexcept {
  if (processor.functions != &kFunctions || processor.state == nullptr ||
      (capacityFrames != 0 && destination == nullptr)) return 0;
  const BuiltinState* state = static_cast<const BuiltinState*>(processor.state);
  if (state->config.kind != BuiltinNodeKind::Tap || state->tapBits == nullptr) return 0;
  for (;;) {
    const uint32_t before = state->telemetrySequence.load(std::memory_order_acquire);
    const uint32_t slot = before & 1u;
    const uint32_t slotBefore = state->telemetrySlotVersion[slot].load(
        std::memory_order_acquire);
    if ((slotBefore & 1u) != 0) continue;
    if (hook != nullptr) hook(hookContext);
    uint32_t frames = state->tapFrames[slot].load(std::memory_order_relaxed);
    if (frames > capacityFrames) frames = capacityFrames;
    const std::atomic<uint32_t>* samples = state->tapBits +
        static_cast<uint64_t>(slot) * state->config.tapCapacityFrames;
    for (uint32_t frame = 0; frame < frames; ++frame)
      destination[frame] = std::bit_cast<float>(
          samples[frame].load(std::memory_order_relaxed));
    const uint32_t slotAfter = state->telemetrySlotVersion[slot].load(
        std::memory_order_acquire);
    const uint32_t after = state->telemetrySequence.load(std::memory_order_acquire);
    if (before == after && slotBefore == slotAfter) return frames;
  }
}

uint32_t builtinTapSnapshot(const ProcessorHandle& processor, float* destination,
                            uint32_t capacityFrames) noexcept {
  return builtinTapSnapshotTestOnly(processor, destination, capacityFrames,
                                    nullptr, nullptr);
}

}  // namespace zdsp

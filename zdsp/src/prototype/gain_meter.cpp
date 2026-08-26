#include "zdsp/prototype_gain_meter.h"

#include <cmath>
#include <stdint.h>

namespace zdsp {
namespace {

bool sameTopology(const AudioBusDescriptor& input,
                  const AudioBusDescriptor& output) noexcept {
  if (input.channelCount != output.channelCount || input.sampleFormat != output.sampleFormat ||
      input.layout != output.layout) return false;
  if (input.layout != AudioChannelLayout::Discrete) return true;
  for (uint32_t channel = 0; channel < input.channelCount; ++channel) {
    if (input.channelRoles[channel] != output.channelRoles[channel]) return false;
  }
  return true;
}

Status prepare(void* raw, const PrepareSpec* spec, const PreparedStorage* storage) noexcept {
  if (raw == nullptr || spec == nullptr || storage == nullptr || storage->data != raw ||
      storage->size < sizeof(PrototypeGainMeterState) ||
      !succeeded(validatePrepareSpec(*spec)) || spec->inputBusCount != 1 ||
      spec->outputBusCount != 1 || !sameTopology(spec->inputBuses[0], spec->outputBuses[0])) {
    return {StatusCode::InvalidArgument, 1};
  }
  auto* state = static_cast<PrototypeGainMeterState*>(raw);
  if (state->destroyed != 0 || state->prepared != 0 || state->active != 0)
    return {StatusCode::InvalidArgument, 2};
  state->sampleRate = spec->sampleRate;
  state->maximumBlockFrames = spec->maximumBlockFrames;
  state->channelCount = spec->inputBuses[0].channelCount;
  state->prepared = 1;
  state->active = 1;
  return okStatus();
}

void reset(void* raw, Discontinuity) noexcept {
  auto* state = static_cast<PrototypeGainMeterState*>(raw);
  state->currentGain = state->targetGain;
  state->gainStep = 0.0f;
  state->rampRemaining = 0;
  state->meter.peak = 0.0f;
  state->meter.rms = 0.0f;
  state->meter.samples = 0;
  ++state->meter.resetCount;
}

void applyEvent(PrototypeGainMeterState* state, const ParameterEvent& event) noexcept {
  if (event.node.value != state->node.value || event.parameter.value != kPrototypeGainParameter.value) return;
  state->targetGain = event.value;
  if (event.curve == ParameterCurve::Step || event.rampFrames.value == 0) {
    state->currentGain = event.value;
    state->gainStep = 0.0f;
    state->rampRemaining = 0;
  } else {
    state->rampRemaining = event.rampFrames.value;
    state->gainStep = (event.value - state->currentGain) / static_cast<float>(event.rampFrames.value);
  }
}

void process(void* raw, const ProcessContext* context, const ConstAudioBusView* inputs, uint32_t inputCount,
             const MutableAudioBusView* outputs, uint32_t outputCount) noexcept {
  auto* state = static_cast<PrototypeGainMeterState*>(raw);
  if (state == nullptr || context == nullptr || state->active == 0 ||
      !succeeded(validateProcessContext(*context))) return;

  uint32_t eventIndex = 0;
  if (context->frames.value == 0) {
    while (eventIndex < context->parameterCount) applyEvent(state, context->parameters[eventIndex++]);
    state->meter.endFrame = context->time.graphFrame;
    return;
  }
  if (inputCount != 1 || outputCount != 1 || inputs == nullptr || outputs == nullptr) return;
  const auto& input = inputs[0]; const auto& output = outputs[0];
  if (!isValid(input) || !isValid(output) || input.frames.value != context->frames.value ||
      output.frames.value != context->frames.value || input.channelCount != state->channelCount ||
      output.channelCount != state->channelCount) return;
  double squares = 0.0; float peak = 0.0f; uint32_t samples = 0;
  for (uint32_t frame = 0; frame < context->frames.value; ++frame) {
    while (eventIndex < context->parameterCount && context->parameters[eventIndex].sampleOffset.value == frame)
      applyEvent(state, context->parameters[eventIndex++]);
    if (state->rampRemaining != 0) {
      state->currentGain += state->gainStep;
      if (--state->rampRemaining == 0) state->currentGain = state->targetGain;
    }
    for (uint32_t channel = 0; channel < input.channelCount; ++channel) {
      const float sample = input.channels[channel][frame] * state->currentGain;
      output.channels[channel][frame] = sample;
      const float magnitude = std::fabs(sample);
      if (magnitude > peak) peak = magnitude;
      squares += static_cast<double>(sample) * sample;
      ++samples;
    }
  }
  state->meter.peak = peak;
  state->meter.rms = samples == 0 ? 0.0f : static_cast<float>(std::sqrt(squares / samples));
  state->meter.samples = samples;
  state->meter.endFrame = {context->time.graphFrame.value + context->frames.value};
}

LatencyFrames latency(const void*) noexcept { return {0}; }
TailInfo tail(const void*) noexcept { return {TailKind::None, {0}}; }
Status deactivate(void* raw) noexcept {
  if (raw == nullptr) return {StatusCode::InvalidArgument, 1};
  auto* state = static_cast<PrototypeGainMeterState*>(raw);
  if (state->destroyed != 0) return {StatusCode::InvalidArgument, 2};
  state->active = 0;
  return okStatus();
}
Status destroy(void* raw) noexcept {
  if (raw == nullptr) return {StatusCode::InvalidArgument, 1};
  auto* state = static_cast<PrototypeGainMeterState*>(raw);
  if (state->active != 0) return {StatusCode::InvalidArgument, 2};
  state->prepared = 0;
  state->destroyed = 1;
  return okStatus();
}
const ProcessorVTable kVTable{kProcessorInterfaceVersion, kProcessorVTableV1RequiredSize,
                              prepare, reset, process, latency, tail, deactivate, destroy};

bool pointerRange(const float* pointer, uint32_t frames,
                  uintptr_t* begin, uintptr_t* end) noexcept {
  if (pointer == nullptr || begin == nullptr || end == nullptr) return false;
  const uintptr_t first = reinterpret_cast<uintptr_t>(pointer);
  const uintptr_t bytes = static_cast<uintptr_t>(frames) * sizeof(float);
  if (first > UINTPTR_MAX - bytes) return false;
  *begin = first;
  *end = first + bytes;
  return true;
}
bool overlaps(const float* first, const float* second, uint32_t frames) noexcept {
  uintptr_t firstBegin = 0, firstEnd = 0, secondBegin = 0, secondEnd = 0;
  if (!pointerRange(first, frames, &firstBegin, &firstEnd) ||
      !pointerRange(second, frames, &secondBegin, &secondEnd)) return true;
  return firstBegin < secondEnd && secondBegin < firstEnd;
}

}  // namespace

size_t prototypeGainMeterStorageSize() noexcept { return sizeof(PrototypeGainMeterState); }
size_t prototypeGainMeterStorageAlignment() noexcept { return alignof(PrototypeGainMeterState); }

ProcessorHandle makePrototypeGainMeter(const PrototypeGainMeterConfig& config,
                                       const PreparedStorage& storage) noexcept {
  if (storage.data == nullptr || storage.size < sizeof(PrototypeGainMeterState) ||
      storage.alignment < alignof(PrototypeGainMeterState) ||
      reinterpret_cast<uintptr_t>(storage.data) % alignof(PrototypeGainMeterState) != 0 ||
      !std::isfinite(config.initialGain)) return {nullptr, nullptr};
  auto* state = static_cast<PrototypeGainMeterState*>(storage.data);
  *state = {};
  state->node = config.node;
  state->currentGain = config.initialGain;
  state->targetGain = config.initialGain;
  return {state, &kVTable};
}

PrototypeMeterResult prototypeMeter(const ProcessorHandle& processor) noexcept {
  if (!succeeded(validateProcessor(processor)) || processor.functions != &kVTable) return {};
  return static_cast<const PrototypeGainMeterState*>(processor.state)->meter;
}

Status preparePrototypeFakeHost(PrototypeFakeHost* host, ProcessorHandle processor,
                                const PrepareSpec& spec) noexcept {
  if (host == nullptr || host->active != 0)
    return {StatusCode::InvalidArgument, 1};
  const Status valid = validateProcessor(processor);
  if (!succeeded(valid)) return valid;
  if (processor.functions != &kVTable) return {StatusCode::InvalidArgument, 2};
  const Status validSpec = validatePrepareSpec(spec);
  if (!succeeded(validSpec)) return validSpec;
  PreparedStorage storage{processor.state, sizeof(PrototypeGainMeterState), alignof(PrototypeGainMeterState)};
  const Status prepared = processor.functions->prepare(processor.state, &spec, &storage);
  if (!succeeded(prepared)) return prepared;
  // The caller owns PrepareSpec and every descriptor/role array it points to.
  // Render retains only the scalar topology proven during prepare.
  *host = {processor, spec.sampleRate, spec.maximumBlockFrames,
           spec.inputBuses[0].channelCount, spec.outputBuses[0].channelCount,
           {0}, {1}, {1}, 1, 0};
  return okStatus();
}

Status processPrototypeBlock(PrototypeFakeHost* host, const ConstAudioBusView& input,
                             const MutableAudioBusView& output, const ParameterEvent* parameters,
                             uint32_t parameterCount, Discontinuity discontinuity) noexcept {
  if (host == nullptr || host->active == 0 || !succeeded(validateProcessor(host->processor)) ||
      !isValid(input) || !isValid(output) ||
      input.frames.value != output.frames.value ||
      input.frames.value > host->maximumBlockFrames.value ||
      input.channelCount != output.channelCount ||
      input.channelCount != host->inputChannelCount ||
      output.channelCount != host->outputChannelCount ||
      parameterCount > kMaximumEventsPerBlock || (parameterCount != 0 && parameters == nullptr))
    return {StatusCode::InvalidArgument, 1};
  const bool typedDiscontinuity =
      discontinuity.reason != DiscontinuityReason::None;
  const bool resetRequested =
      (discontinuity.flags & DiscontinuityFlagResetState) != 0;
  if (typedDiscontinuity != resetRequested)
    return {StatusCode::InvalidArgument, 70};
  if (host->nextFrame.value > UINT64_MAX - input.frames.value)
    return {StatusCode::CapacityExceeded, 1};
  for (uint32_t channel = 0; channel < input.channelCount; ++channel) {
    if (input.frames.value != 0 &&
        (input.channels[channel] == nullptr || output.channels[channel] == nullptr))
      return {StatusCode::InvalidArgument, channel + 10};
  }
  if (input.frames.value != 0) {
    for (uint32_t first = 0; first < output.channelCount; ++first) {
      for (uint32_t second = first + 1; second < output.channelCount; ++second) {
        if (overlaps(output.channels[first], output.channels[second], input.frames.value))
          return {StatusCode::InvalidArgument, 30 + first};
      }
      for (uint32_t source = 0; source < input.channelCount; ++source) {
        const bool correspondingExact = source == first && input.channels[source] == output.channels[first];
        if (!correspondingExact && overlaps(input.channels[source], output.channels[first], input.frames.value))
          return {StatusCode::InvalidArgument, 50 + source};
      }
    }
  }
  uint32_t previousOffset = 0;
  for (uint32_t i = 0; i < parameterCount; ++i) {
    const bool offsetInvalid = input.frames.value == 0
        ? parameters[i].sampleOffset.value != 0
        : parameters[i].sampleOffset.value >= input.frames.value;
    const bool curveInvalid = parameters[i].curve != ParameterCurve::Step &&
                              parameters[i].curve != ParameterCurve::Linear;
    if (offsetInvalid || curveInvalid || !std::isfinite(parameters[i].value) ||
        (i != 0 && parameters[i].sampleOffset.value < previousOffset)) return {StatusCode::InvalidArgument, i + 2};
    previousOffset = parameters[i].sampleOffset.value;
  }
  ProcessContext context{kProcessContextInterfaceVersion, kProcessContextV1RequiredSize,
      {host->clockDomain, host->streamGeneration, host->nextFrame, {0}, {0},
       typedDiscontinuity ? RenderTimeDiscontinuous : RenderTimeNone},
      nullptr, host->sampleRate, input.frames, parameters, parameterCount, nullptr, 0,
      {nullptr, 0}, discontinuity};
  const Status validContext = validateProcessContext(context);
  if (!succeeded(validContext)) return validContext;
  if (resetRequested) {
    host->processor.functions->reset(host->processor.state, discontinuity);
    ++host->resetDispatchCount;
  }
  host->processor.functions->process(host->processor.state, &context, &input, 1, &output, 1);
  host->nextFrame.value += input.frames.value;
  return okStatus();
}

Status destroyPrototypeFakeHost(PrototypeFakeHost* host) noexcept {
  if (host == nullptr || host->active == 0) return {StatusCode::InvalidArgument, 1};
  Status status = deactivateProcessor(host->processor);
  if (!succeeded(status)) return status;
  status = destroyProcessor(&host->processor);
  if (!succeeded(status)) return status;
  host->active = 0;
  return okStatus();
}

}  // namespace zdsp

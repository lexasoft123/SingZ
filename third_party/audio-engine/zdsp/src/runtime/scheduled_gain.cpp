#include "zdsp/scheduled_gain.h"

#include <cmath>
#include <limits>
#include <memory>

namespace zdsp {
namespace {

struct ScheduledGainState {
  ScheduledGainConfig config{};
  float currentGain{1.0F};
  float targetGain{1.0F};
  float rampStep{0.0F};
  uint32_t rampRemaining{0};
  uint32_t maximumFrames{0};
  uint32_t windowIndex{0};
  int64_t previousProjectFrame{-1};
  bool snapOnNextTransportFrame{false};
  bool enabled{false};
  bool prepared{false};
  bool active{false};
};

bool validConfig(const ScheduledGainConfig &config) noexcept {
  if (config.node.value == 0 || !std::isfinite(config.insideGain) ||
      !std::isfinite(config.outsideGain) || config.insideGain < 0.0F ||
      config.outsideGain < 0.0F || config.rampFrames.value == 0)
    return false;
  if (config.mode == ScheduledGainMode::Period)
    return config.periodFrames > 0 && config.windowCount == 0;
  if (config.mode != ScheduledGainMode::Windows || config.windowCount == 0 ||
      config.windowCount > kMaximumScheduledGainWindows ||
      config.windows == nullptr)
    return false;
  for (uint32_t index = 0; index < config.windowCount; ++index) {
    const ScheduledGainWindow &window = config.windows[index];
    if (window.startProjectTimeSamples < 0 ||
        window.endProjectTimeSamples <= window.startProjectTimeSamples ||
        (index != 0 &&
         window.startProjectTimeSamples <
             config.windows[index - 1].endProjectTimeSamples))
      return false;
  }
  return true;
}

Status prepare(void *opaque, const PrepareSpec *spec,
               const PreparedStorage *) noexcept {
  if (opaque == nullptr || spec == nullptr)
    return {StatusCode::InvalidArgument, 1};
  auto *state = static_cast<ScheduledGainState *>(opaque);
  if (state->prepared || !succeeded(validatePrepareSpec(*spec)))
    return {StatusCode::InvalidArgument, 2};
  if (spec->inputBusCount != 1 || spec->outputBusCount != 1 ||
      spec->inputBuses[0].channelCount !=
          spec->outputBuses[0].channelCount ||
      spec->inputBuses[0].sampleFormat !=
          spec->outputBuses[0].sampleFormat ||
      spec->inputBuses[0].layout != spec->outputBuses[0].layout)
    return {StatusCode::UnsupportedFormat, 3};
  state->maximumFrames = spec->maximumBlockFrames.value;
  state->prepared = true;
  state->active = true;
  return okStatus();
}

void reset(void *opaque, Discontinuity discontinuity) noexcept {
  auto *state = static_cast<ScheduledGainState *>(opaque);
  if (state == nullptr)
    return;
  state->windowIndex = 0;
  state->previousProjectFrame = -1;
  state->rampRemaining = 0;
  state->rampStep = 0.0F;
  state->targetGain = state->currentGain;
  state->snapOnNextTransportFrame =
      discontinuity.reason == DiscontinuityReason::SourceSeek ||
      discontinuity.reason == DiscontinuityReason::SourceLoop;
}

uint32_t lowerBoundWindow(const ScheduledGainState &state,
                          int64_t projectFrame) noexcept {
  uint32_t first = 0;
  uint32_t count = state.config.windowCount;
  while (count != 0) {
    const uint32_t step = count / 2;
    const uint32_t middle = first + step;
    if (state.config.windows[middle].endProjectTimeSamples <= projectFrame) {
      first = middle + 1;
      count -= step + 1;
    } else {
      count = step;
    }
  }
  return first;
}

bool scheduledInside(ScheduledGainState *state,
                     int64_t projectFrame) noexcept {
  if (projectFrame < 0)
    return false;
  if (state->config.mode == ScheduledGainMode::Period)
    return (projectFrame / state->config.periodFrames) % 2 == 1;
  if (state->previousProjectFrame < 0 ||
      projectFrame < state->previousProjectFrame ||
      (state->previousProjectFrame != std::numeric_limits<int64_t>::max() &&
       projectFrame > state->previousProjectFrame + 1))
    state->windowIndex = lowerBoundWindow(*state, projectFrame);
  while (state->windowIndex < state->config.windowCount &&
         state->config.windows[state->windowIndex].endProjectTimeSamples <=
             projectFrame)
    ++state->windowIndex;
  if (state->windowIndex >= state->config.windowCount)
    return false;
  const ScheduledGainWindow &window =
      state->config.windows[state->windowIndex];
  return projectFrame >= window.startProjectTimeSamples &&
         projectFrame < window.endProjectTimeSamples;
}

void beginRamp(ScheduledGainState *state, float target) noexcept {
  if (target == state->targetGain)
    return;
  state->targetGain = target;
  state->rampRemaining = state->config.rampFrames.value;
  state->rampStep = (target - state->currentGain) /
                    static_cast<float>(state->rampRemaining);
}

void advanceRamp(ScheduledGainState *state) noexcept {
  if (state->rampRemaining == 0)
    return;
  state->currentGain += state->rampStep;
  if (--state->rampRemaining == 0)
    state->currentGain = state->targetGain;
}

void consumeEnableAt(ScheduledGainState *state, const ProcessContext &context,
                     uint32_t offset, uint32_t *eventIndex) noexcept {
  while (*eventIndex < context.parameterCount &&
         context.parameters[*eventIndex].sampleOffset.value == offset) {
    const ParameterEvent &event = context.parameters[(*eventIndex)++];
    if (event.node.value == state->config.node.value &&
        event.parameter.value == kScheduledGainEnableParameter.value &&
        std::isfinite(event.value))
      state->enabled = event.value >= 0.5F;
  }
}

void process(void *opaque, const ProcessContext *context,
             const ConstAudioBusView *inputs, uint32_t inputCount,
             const MutableAudioBusView *outputs,
             uint32_t outputCount) noexcept {
  auto *state = static_cast<ScheduledGainState *>(opaque);
  if (state == nullptr || context == nullptr || inputs == nullptr ||
      outputs == nullptr || inputCount != 1 || outputCount != 1)
    return;
  const ConstAudioBusView &input = inputs[0];
  const MutableAudioBusView &output = outputs[0];
  if (!state->active || output.frames.value > state->maximumFrames ||
      input.channelCount != output.channelCount ||
      input.frames.value != output.frames.value)
    return;
  const bool transportValid =
      context->transport != nullptr &&
      (context->transport->validFields & TransportValidProjectSamples) != 0 &&
      (context->transport->stateFlags & TransportStatePlaying) != 0 &&
      (processContextFlags(*context) & ProcessContextFlagTailDrain) == 0;
  uint32_t eventIndex = 0;
  for (uint32_t frame = 0; frame < output.frames.value; ++frame) {
    consumeEnableAt(state, *context, frame, &eventIndex);
    int64_t projectFrame = -1;
    if (transportValid) {
      ProjectSamplePositionQ32 position{};
      if (projectSamplePositionAt(*context->transport, frame, &position))
        projectFrame = position.samples;
    }
    const bool inside =
        transportValid && state->enabled && scheduledInside(state, projectFrame);
    const float scheduledGain = inside ? state->config.insideGain
                                       : state->config.outsideGain;
    if (state->snapOnNextTransportFrame && transportValid) {
      state->currentGain = scheduledGain;
      state->targetGain = scheduledGain;
      state->rampStep = 0.0F;
      state->rampRemaining = 0;
      state->snapOnNextTransportFrame = false;
    } else {
      beginRamp(state, scheduledGain);
    }
    for (uint32_t channel = 0; channel < output.channelCount; ++channel) {
      const float sample = input.channels[channel][frame];
      output.channels[channel][frame] =
          std::isfinite(sample) ? sample * state->currentGain : 0.0F;
    }
    state->previousProjectFrame = projectFrame;
    advanceRamp(state);
  }
}

LatencyFrames latency(const void *) noexcept { return {0}; }
TailInfo tail(const void *) noexcept { return {TailKind::None, {0}}; }

Status deactivate(void *opaque) noexcept {
  auto *state = static_cast<ScheduledGainState *>(opaque);
  if (state == nullptr || !state->active)
    return {StatusCode::InvalidArgument, 1};
  state->active = false;
  return okStatus();
}

Status destroy(void *opaque) noexcept {
  auto *state = static_cast<ScheduledGainState *>(opaque);
  if (state == nullptr || state->active)
    return {StatusCode::InvalidArgument, 1};
  state->prepared = false;
  std::destroy_at(state);
  return okStatus();
}

constexpr ProcessorVTable kFunctions{kProcessorInterfaceVersion,
                                     kProcessorVTableV1RequiredSize,
                                     prepare,
                                     reset,
                                     process,
                                     latency,
                                     tail,
                                     deactivate,
                                     destroy};

} // namespace

size_t scheduledGainStateBytes() noexcept {
  return sizeof(ScheduledGainState);
}

ProcessorHandle createScheduledGain(const ScheduledGainConfig &config,
                                    MutableByteView stateStorage) noexcept {
  if (!validConfig(config) || stateStorage.data == nullptr ||
      stateStorage.capacity < sizeof(ScheduledGainState) ||
      (reinterpret_cast<uintptr_t>(stateStorage.data) &
       (alignof(ScheduledGainState) - 1)) != 0)
    return {};
  auto *state = std::construct_at(
      reinterpret_cast<ScheduledGainState *>(stateStorage.data));
  state->config = config;
  state->currentGain = config.outsideGain;
  state->targetGain = config.outsideGain;
  state->enabled = config.enabled;
  return {state, &kFunctions};
}

} // namespace zdsp

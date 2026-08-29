#include "zdsp/decoded_buffer_source.h"

#include <cmath>
#include <memory>

namespace zdsp {
namespace {

struct SourceState {
  NodeId node;
  SampleRateHz sampleRate;
  uint64_t frameCount;
  uint64_t cursor;
  uint32_t channelCount;
  uint32_t prepared;
  uint32_t active;
  const float* channels[kMaximumChannelsPerBus];
};

Status prepare(void* opaque, const PrepareSpec* spec,
               const PreparedStorage*) noexcept {
  if (opaque == nullptr || spec == nullptr)
    return {StatusCode::InvalidArgument, 1};
  auto* state = static_cast<SourceState*>(opaque);
  if (state->prepared != 0 || !succeeded(validatePrepareSpec(*spec)))
    return {StatusCode::InvalidArgument, 2};
  if (spec->inputBusCount != 0 || spec->outputBusCount != 1 ||
      spec->outputBuses[0].channelCount != state->channelCount ||
      spec->sampleRate.value != state->sampleRate.value)
    return {StatusCode::UnsupportedFormat, 3};
  state->cursor = 0;
  state->prepared = 1;
  state->active = 1;
  return okStatus();
}

// Generic graph discontinuities carry no prepared source position. Rewinding
// here would restart a song on a device/clock reset. A future transport source
// contract will publish positioned seek/loop state explicitly.
void reset(void*, Discontinuity) noexcept {}

void silence(const MutableAudioBusView& output) noexcept {
  for (uint32_t channel = 0; channel < output.channelCount; ++channel)
    for (uint32_t frame = 0; frame < output.frames.value; ++frame)
      output.channels[channel][frame] = 0.0f;
}

void process(void* opaque, const ProcessContext* context,
             const ConstAudioBusView*, uint32_t inputCount,
             const MutableAudioBusView* outputs,
             uint32_t outputCount) noexcept {
  auto* state = static_cast<SourceState*>(opaque);
  if (state == nullptr || context == nullptr || outputs == nullptr ||
      inputCount != 0 || outputCount != 1)
    return;
  const MutableAudioBusView& output = outputs[0];
  if ((processContextFlags(*context) & ProcessContextFlagTailDrain) != 0) {
    silence(output);
    return;
  }
  if (output.frames.value == 0) return;
  const uint64_t available = state->cursor < state->frameCount
      ? state->frameCount - state->cursor : 0;
  const uint32_t copied = available < output.frames.value
      ? static_cast<uint32_t>(available) : output.frames.value;
  for (uint32_t channel = 0; channel < output.channelCount; ++channel) {
    const float* source = state->channels[channel];
    float* destination = output.channels[channel];
    for (uint32_t frame = 0; frame < copied; ++frame)
      destination[frame] = source[state->cursor + frame];
    for (uint32_t frame = copied; frame < output.frames.value; ++frame)
      destination[frame] = 0.0f;
  }
  state->cursor += copied;
}

LatencyFrames latency(const void*) noexcept { return {0}; }
TailInfo tail(const void*) noexcept { return {TailKind::None, {0}}; }

Status deactivate(void* opaque) noexcept {
  auto* state = static_cast<SourceState*>(opaque);
  if (state == nullptr || state->active == 0)
    return {StatusCode::InvalidArgument, 1};
  state->active = 0;
  return okStatus();
}

Status destroy(void* opaque) noexcept {
  auto* state = static_cast<SourceState*>(opaque);
  if (state == nullptr || state->active != 0)
    return {StatusCode::InvalidArgument, 1};
  state->prepared = 0;
  std::destroy_at(state);
  return okStatus();
}

constexpr ProcessorVTable kFunctions{
    kProcessorInterfaceVersion, kProcessorVTableV1RequiredSize,
    prepare, reset, process, latency, tail, deactivate, destroy};

}  // namespace

size_t decodedBufferSourceStateBytes() noexcept { return sizeof(SourceState); }

ProcessorHandle createDecodedBufferSource(
    const DecodedBufferSourceConfig& config,
    MutableByteView stateStorage) noexcept {
  const DecodedBufferView& buffer = config.buffer;
  if (stateStorage.data == nullptr ||
      stateStorage.capacity < sizeof(SourceState) ||
      (reinterpret_cast<uintptr_t>(stateStorage.data) &
       (alignof(SourceState) - 1)) != 0 ||
      config.node.value == 0 || buffer.channelCount == 0 ||
      buffer.channelCount > kMaximumChannelsPerBus ||
      buffer.frameCount > SIZE_MAX / sizeof(float) ||
      !std::isfinite(buffer.sampleRate.value) || buffer.sampleRate.value <= 0.0 ||
      buffer.channels == nullptr)
    return {nullptr, nullptr};
  for (uint32_t channel = 0; channel < buffer.channelCount; ++channel)
    if (buffer.frameCount != 0 && buffer.channels[channel] == nullptr)
      return {nullptr, nullptr};
  auto* state = reinterpret_cast<SourceState*>(stateStorage.data);
  std::construct_at(state);
  state->node = config.node;
  state->sampleRate = buffer.sampleRate;
  state->frameCount = buffer.frameCount;
  state->channelCount = buffer.channelCount;
  for (uint32_t channel = 0; channel < buffer.channelCount; ++channel)
    state->channels[channel] = buffer.channels[channel];
  return {state, &kFunctions};
}

}  // namespace zdsp

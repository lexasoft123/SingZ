#include "zdsp/decoded_buffer_source.h"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <memory>

namespace zdsp {
namespace {

struct SourceState {
  NodeId node;
  SampleRateHz sampleRate;
  uint64_t frameCount;
  uint64_t cursor;
  int64_t entryProjectTimeSamples;
  uint64_t sourceStartFrame;
  uint32_t channelCount;
  uint32_t prepared;
  uint32_t active;
  std::atomic<uint32_t> cursorSequence;
  std::atomic<uint32_t> cursorLow[2];
  std::atomic<uint32_t> cursorHigh[2];
  const float *channels[kMaximumChannelsPerBus];
};

static_assert(std::atomic<uint32_t>::is_always_lock_free);

void publishCursor(SourceState *state) noexcept {
  const uint32_t sequence =
      state->cursorSequence.load(std::memory_order_relaxed);
  const uint32_t slot = (sequence + 1u) & 1u;
  state->cursorLow[slot].store(static_cast<uint32_t>(state->cursor),
                               std::memory_order_relaxed);
  state->cursorHigh[slot].store(static_cast<uint32_t>(state->cursor >> 32),
                                std::memory_order_relaxed);
  state->cursorSequence.store(sequence + 1u, std::memory_order_release);
}

Status prepare(void *opaque, const PrepareSpec *spec,
               const PreparedStorage *) noexcept {
  if (opaque == nullptr || spec == nullptr)
    return {StatusCode::InvalidArgument, 1};
  auto *state = static_cast<SourceState *>(opaque);
  if (state->prepared != 0 || !succeeded(validatePrepareSpec(*spec)))
    return {StatusCode::InvalidArgument, 2};
  if (spec->inputBusCount != 0 || spec->outputBusCount != 1 ||
      spec->outputBuses[0].channelCount != state->channelCount ||
      spec->sampleRate.value != state->sampleRate.value)
    return {StatusCode::UnsupportedFormat, 3};
  state->cursor = state->sourceStartFrame;
  publishCursor(state);
  state->prepared = 1;
  state->active = 1;
  return okStatus();
}

// Generic graph discontinuities carry no source position. Rewinding here
// would restart a sequential source on a device/clock reset; positioned
// sources instead derive every rendered frame from TransportContext after the
// reset, so neither implementation needs mutable reset-time seek data.
void reset(void *, Discontinuity) noexcept {}

void silence(const MutableAudioBusView &output) noexcept {
  for (uint32_t channel = 0; channel < output.channelCount; ++channel)
    for (uint32_t frame = 0; frame < output.frames.value; ++frame)
      output.channels[channel][frame] = 0.0f;
}

void copyFrames(SourceState *state, const MutableAudioBusView &output,
                uint32_t destinationOffset, uint64_t sourceFrame,
                uint32_t requested) noexcept {
  const uint64_t available =
      sourceFrame < state->frameCount ? state->frameCount - sourceFrame : 0;
  const uint32_t copied =
      available < requested ? static_cast<uint32_t>(available) : requested;
  for (uint32_t channel = 0; channel < output.channelCount; ++channel) {
    const float *source = state->channels[channel];
    float *destination = output.channels[channel] + destinationOffset;
    for (uint32_t frame = 0; frame < copied; ++frame)
      destination[frame] = source[sourceFrame + frame];
    for (uint32_t frame = copied; frame < requested; ++frame)
      destination[frame] = 0.0f;
  }
  state->cursor = copied < requested ? state->frameCount : sourceFrame + copied;
  publishCursor(state);
}

bool beginSourceProcess(void *opaque, const ProcessContext *context,
                        uint32_t inputCount, const MutableAudioBusView *outputs,
                        uint32_t outputCount, SourceState **state,
                        const MutableAudioBusView **output) noexcept {
  *state = static_cast<SourceState *>(opaque);
  if (*state == nullptr || context == nullptr || outputs == nullptr ||
      inputCount != 0 || outputCount != 1)
    return false;
  *output = &outputs[0];
  if ((processContextFlags(*context) & ProcessContextFlagTailDrain) != 0) {
    silence(**output);
    return false;
  }
  return (**output).frames.value != 0;
}

void processSequential(void *opaque, const ProcessContext *context,
                       const ConstAudioBusView *, uint32_t inputCount,
                       const MutableAudioBusView *outputs,
                       uint32_t outputCount) noexcept {
  SourceState *state = nullptr;
  const MutableAudioBusView *output = nullptr;
  if (!beginSourceProcess(opaque, context, inputCount, outputs, outputCount,
                          &state, &output))
    return;
  copyFrames(state, *output, 0, state->cursor, output->frames.value);
}

void processPositioned(void *opaque, const ProcessContext *context,
                       const ConstAudioBusView *, uint32_t inputCount,
                       const MutableAudioBusView *outputs,
                       uint32_t outputCount) noexcept {
  auto *state = static_cast<SourceState *>(opaque);
  const MutableAudioBusView *output = nullptr;
  if (!beginSourceProcess(opaque, context, inputCount, outputs, outputCount,
                          &state, &output))
    return;
  silence(*output);
  if (context->transport == nullptr ||
      (context->transport->validFields & TransportValidProjectSamples) == 0 ||
      (context->transport->stateFlags & TransportStatePlaying) == 0)
    return;
  for (uint32_t frame = 0; frame < output->frames.value; ++frame) {
    ProjectSamplePositionQ32 position{};
    if (!projectSamplePositionAt(*context->transport, frame, &position) ||
        position.samples < state->entryProjectTimeSamples)
      continue;
    const uint64_t elapsed = static_cast<uint64_t>(position.samples) -
                             static_cast<uint64_t>(
                                 state->entryProjectTimeSamples);
    if (elapsed > UINT64_MAX - state->sourceStartFrame)
      continue;
    const uint64_t sourceFrame = state->sourceStartFrame + elapsed;
    if (sourceFrame >= state->frameCount)
      continue;
    const double fraction = static_cast<double>(position.fraction) /
                            static_cast<double>(kProjectRateOneQ32);
    for (uint32_t channel = 0; channel < output->channelCount; ++channel) {
      const float first = state->channels[channel][sourceFrame];
      const float second = sourceFrame + 1u < state->frameCount
                               ? state->channels[channel][sourceFrame + 1u]
                               : 0.0F;
      output->channels[channel][frame] = static_cast<float>(
          static_cast<double>(first) +
          (static_cast<double>(second) - static_cast<double>(first)) *
              fraction);
    }
  }

  ProjectSamplePositionQ32 next{};
  if (!projectSamplePositionAt(*context->transport, output->frames.value,
                               &next) ||
      next.samples < state->entryProjectTimeSamples) {
    state->cursor = state->sourceStartFrame;
  } else {
    const uint64_t elapsed = static_cast<uint64_t>(next.samples) -
                             static_cast<uint64_t>(
                                 state->entryProjectTimeSamples);
    state->cursor =
        elapsed > UINT64_MAX - state->sourceStartFrame
            ? state->frameCount
            : std::min(state->frameCount, state->sourceStartFrame + elapsed);
  }
  publishCursor(state);
}

LatencyFrames latency(const void *) noexcept { return {0}; }
TailInfo tail(const void *) noexcept { return {TailKind::None, {0}}; }

Status deactivate(void *opaque) noexcept {
  auto *state = static_cast<SourceState *>(opaque);
  if (state == nullptr || state->active == 0)
    return {StatusCode::InvalidArgument, 1};
  state->active = 0;
  return okStatus();
}

Status destroy(void *opaque) noexcept {
  auto *state = static_cast<SourceState *>(opaque);
  if (state == nullptr || state->active != 0)
    return {StatusCode::InvalidArgument, 1};
  state->prepared = 0;
  std::destroy_at(state);
  return okStatus();
}

constexpr ProcessorVTable kSequentialFunctions{kProcessorInterfaceVersion,
                                               kProcessorVTableV1RequiredSize,
                                               prepare,
                                               reset,
                                               processSequential,
                                               latency,
                                               tail,
                                               deactivate,
                                               destroy};
constexpr ProcessorVTable kPositionedFunctions{kProcessorInterfaceVersion,
                                               kProcessorVTableV1RequiredSize,
                                               prepare,
                                               reset,
                                               processPositioned,
                                               latency,
                                               tail,
                                               deactivate,
                                               destroy};

ProcessorHandle createSource(NodeId node, const DecodedBufferView &buffer,
                             int64_t entryProjectTimeSamples,
                             uint64_t sourceStartFrame,
                             const ProcessorVTable *functions,
                             MutableByteView stateStorage) noexcept {
  if (stateStorage.data == nullptr ||
      stateStorage.capacity < sizeof(SourceState) ||
      (reinterpret_cast<uintptr_t>(stateStorage.data) &
       (alignof(SourceState) - 1)) != 0 ||
      node.value == 0 || buffer.channelCount == 0 ||
      buffer.channelCount > kMaximumChannelsPerBus ||
      buffer.frameCount > SIZE_MAX / sizeof(float) ||
      sourceStartFrame > buffer.frameCount ||
      !std::isfinite(buffer.sampleRate.value) ||
      buffer.sampleRate.value <= 0.0 || buffer.channels == nullptr)
    return {nullptr, nullptr};
  for (uint32_t channel = 0; channel < buffer.channelCount; ++channel)
    if (buffer.frameCount != 0 && buffer.channels[channel] == nullptr)
      return {nullptr, nullptr};
  auto *state = reinterpret_cast<SourceState *>(stateStorage.data);
  std::construct_at(state);
  state->node = node;
  state->sampleRate = buffer.sampleRate;
  state->frameCount = buffer.frameCount;
  state->channelCount = buffer.channelCount;
  state->cursor = sourceStartFrame;
  state->entryProjectTimeSamples = entryProjectTimeSamples;
  state->sourceStartFrame = sourceStartFrame;
  state->cursorSequence.store(0, std::memory_order_relaxed);
  for (uint32_t slot = 0; slot < 2; ++slot) {
    state->cursorLow[slot].store(static_cast<uint32_t>(sourceStartFrame),
                                 std::memory_order_relaxed);
    state->cursorHigh[slot].store(static_cast<uint32_t>(sourceStartFrame >> 32),
                                  std::memory_order_relaxed);
  }
  for (uint32_t channel = 0; channel < buffer.channelCount; ++channel)
    state->channels[channel] = buffer.channels[channel];
  return {state, functions};
}

} // namespace

size_t decodedBufferSourceStateBytes() noexcept { return sizeof(SourceState); }

ProcessorHandle
createDecodedBufferSource(const DecodedBufferSourceConfig &config,
                          MutableByteView stateStorage) noexcept {
  return createSource(config.node, config.buffer, 0, 0, &kSequentialFunctions,
                      stateStorage);
}

ProcessorHandle createPositionedDecodedBufferSource(
    const PositionedDecodedBufferSourceConfig &config,
    MutableByteView stateStorage) noexcept {
  return createSource(config.node, config.buffer,
                      config.entryProjectTimeSamples, config.sourceStartFrame,
                      &kPositionedFunctions, stateStorage);
}

uint64_t decodedBufferSourceCursor(
    const ProcessorHandle &processor, DecodedBufferSourceCursorReader *reader,
    const DecodedBufferSourceCursorReadHook *hook) noexcept {
  if (processor.state == nullptr ||
      (processor.functions != &kSequentialFunctions &&
       processor.functions != &kPositionedFunctions))
    return 0;
  const auto *state = static_cast<const SourceState *>(processor.state);
  uint64_t lastGood = reader == nullptr ? 0 : reader->lastGoodFrames;
  if (lastGood > state->frameCount)
    lastGood = state->frameCount;
  for (uint32_t attempt = 0; attempt < 8; ++attempt) {
    const uint32_t before =
        state->cursorSequence.load(std::memory_order_acquire);
    const uint32_t slot = before & 1u;
    const uint32_t low = state->cursorLow[slot].load(std::memory_order_relaxed);
    if (hook != nullptr && hook->betweenReads != nullptr)
      hook->betweenReads(hook->context, attempt);
    const uint32_t high =
        state->cursorHigh[slot].load(std::memory_order_relaxed);
    const uint32_t after =
        state->cursorSequence.load(std::memory_order_acquire);
    if (before == after) {
      const uint64_t sampled = (static_cast<uint64_t>(high) << 32) | low;
      lastGood = sampled < state->frameCount ? sampled : state->frameCount;
      if (reader != nullptr)
        reader->lastGoodFrames = lastGood;
      return lastGood;
    }
  }
  return lastGood;
}

} // namespace zdsp

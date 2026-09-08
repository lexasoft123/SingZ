#include "zdsp/streaming_window_source.h"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <memory>

namespace zdsp {
namespace {

struct StreamingSourceState {
  NodeId node;
  StreamingWindow *window;
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
};

static_assert(std::atomic<uint32_t>::is_always_lock_free);

void publishRange(StreamingWindowRange *range, uint64_t start,
                  uint64_t end) noexcept {
  const uint32_t sequence = range->sequence.load(std::memory_order_relaxed);
  const uint32_t slot = (sequence + 1u) & 1u;
  range->startLow[slot].store(static_cast<uint32_t>(start),
                              std::memory_order_relaxed);
  range->startHigh[slot].store(static_cast<uint32_t>(start >> 32),
                               std::memory_order_relaxed);
  range->endLow[slot].store(static_cast<uint32_t>(end),
                            std::memory_order_relaxed);
  range->endHigh[slot].store(static_cast<uint32_t>(end >> 32),
                             std::memory_order_relaxed);
  range->sequence.store(sequence + 1u, std::memory_order_release);
}

// A bounded retry, like the cursor reader: a snapshot that keeps losing to the
// other domain reports failure rather than an unverified pair of halves.
bool snapshotRange(const StreamingWindowRange *range, uint64_t *start,
                   uint64_t *end) noexcept {
  for (uint32_t attempt = 0; attempt < 8; ++attempt) {
    const uint32_t before = range->sequence.load(std::memory_order_acquire);
    if (before == 0)
      return false;
    const uint32_t slot = before & 1u;
    const uint32_t startLow =
        range->startLow[slot].load(std::memory_order_relaxed);
    const uint32_t startHigh =
        range->startHigh[slot].load(std::memory_order_relaxed);
    const uint32_t endLow = range->endLow[slot].load(std::memory_order_relaxed);
    const uint32_t endHigh =
        range->endHigh[slot].load(std::memory_order_relaxed);
    const uint32_t after = range->sequence.load(std::memory_order_acquire);
    if (before == after) {
      *start = (static_cast<uint64_t>(startHigh) << 32) | startLow;
      *end = (static_cast<uint64_t>(endHigh) << 32) | endLow;
      return *end >= *start;
    }
  }
  return false;
}

void publishCursor(StreamingSourceState *state) noexcept {
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
  auto *state = static_cast<StreamingSourceState *>(opaque);
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

void reset(void *, Discontinuity) noexcept {}

void silence(const MutableAudioBusView &output) noexcept {
  for (uint32_t channel = 0; channel < output.channelCount; ++channel)
    for (uint32_t frame = 0; frame < output.frames.value; ++frame)
      output.channels[channel][frame] = 0.0f;
}

void process(void *opaque, const ProcessContext *context,
             const ConstAudioBusView *, uint32_t inputCount,
             const MutableAudioBusView *outputs,
             uint32_t outputCount) noexcept {
  auto *state = static_cast<StreamingSourceState *>(opaque);
  if (state == nullptr || context == nullptr || outputs == nullptr ||
      inputCount != 0 || outputCount != 1)
    return;
  const MutableAudioBusView &output = outputs[0];
  if ((processContextFlags(*context) & ProcessContextFlagTailDrain) != 0) {
    silence(output);
    return;
  }
  if (output.frames.value == 0)
    return;
  silence(output);
  if (context->transport == nullptr ||
      (context->transport->validFields & TransportValidProjectSamples) == 0 ||
      (context->transport->stateFlags & TransportStatePlaying) == 0)
    return;

  StreamingWindow *window = state->window;
  uint64_t residentStart = 0;
  uint64_t residentEnd = 0;
  const bool haveWindow =
      snapshotRange(&window->resident, &residentStart, &residentEnd);
  const uint64_t mask = window->capacityFrames - 1u;

  bool starved = false;
  bool demanded = false;
  for (uint32_t frame = 0; frame < output.frames.value; ++frame) {
    ProjectSamplePositionQ32 position{};
    if (!projectSamplePositionAt(*context->transport, frame, &position) ||
        position.samples < state->entryProjectTimeSamples)
      continue;
    const uint64_t elapsed =
        static_cast<uint64_t>(position.samples) -
        static_cast<uint64_t>(state->entryProjectTimeSamples);
    if (elapsed > UINT64_MAX - state->sourceStartFrame)
      continue;
    const uint64_t sourceFrame = state->sourceStartFrame + elapsed;
    if (sourceFrame >= state->frameCount)
      continue;
    // The first frame this block actually wants is what the feeder chases.
    // Published even when the window already holds it, because the feeder
    // decides how far AHEAD to stay from the same value.
    if (!demanded) {
      publishRange(&window->demand, sourceFrame, sourceFrame);
      demanded = true;
    }
    if (!haveWindow || sourceFrame < residentStart ||
        sourceFrame >= residentEnd) {
      starved = true;
      continue;
    }
    // Interpolation needs the next frame too. At the very end of the song
    // there is none and the decoded source uses zero; at the leading edge of
    // the window the neighbour has merely not arrived yet, so that frame is
    // starved rather than faded — fading there would be a click on a window
    // boundary that has nothing to do with the audio.
    const bool haveNext = sourceFrame + 1u < residentEnd;
    const bool endOfSong = sourceFrame + 1u >= state->frameCount;
    if (!haveNext && !endOfSong) {
      starved = true;
      continue;
    }
    const double fraction = static_cast<double>(position.fraction) /
                            static_cast<double>(kProjectRateOneQ32);
    const size_t index = static_cast<size_t>(sourceFrame & mask);
    const size_t nextIndex = static_cast<size_t>((sourceFrame + 1u) & mask);
    for (uint32_t channel = 0; channel < output.channelCount; ++channel) {
      const float *plane = window->channels[channel];
      const float first = plane[index];
      const float second = haveNext ? plane[nextIndex] : 0.0F;
      output.channels[channel][frame] = static_cast<float>(
          static_cast<double>(first) +
          (static_cast<double>(second) - static_cast<double>(first)) *
              fraction);
    }
  }

  if (starved)
    window->starvedBlocks.fetch_add(1u, std::memory_order_relaxed);

  ProjectSamplePositionQ32 next{};
  if (!projectSamplePositionAt(*context->transport, output.frames.value,
                               &next) ||
      next.samples < state->entryProjectTimeSamples) {
    state->cursor = state->sourceStartFrame;
  } else {
    const uint64_t elapsed =
        static_cast<uint64_t>(next.samples) -
        static_cast<uint64_t>(state->entryProjectTimeSamples);
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
  auto *state = static_cast<StreamingSourceState *>(opaque);
  if (state == nullptr || state->active == 0)
    return {StatusCode::InvalidArgument, 1};
  state->active = 0;
  return okStatus();
}

Status destroy(void *opaque) noexcept {
  auto *state = static_cast<StreamingSourceState *>(opaque);
  if (state == nullptr || state->active != 0)
    return {StatusCode::InvalidArgument, 1};
  state->prepared = 0;
  std::destroy_at(state);
  return okStatus();
}

constexpr ProcessorVTable kStreamingFunctions{kProcessorInterfaceVersion,
                                              kProcessorVTableV1RequiredSize,
                                              prepare,
                                              reset,
                                              process,
                                              latency,
                                              tail,
                                              deactivate,
                                              destroy};

bool isPowerOfTwo(uint64_t value) noexcept {
  return value != 0 && (value & (value - 1u)) == 0;
}

} // namespace

size_t streamingWindowSourceStateBytes() noexcept {
  return sizeof(StreamingSourceState);
}

ProcessorHandle
createPositionedStreamingSource(const PositionedStreamingSourceConfig &config,
                                MutableByteView stateStorage) noexcept {
  StreamingWindow *window = config.window;
  if (stateStorage.data == nullptr ||
      stateStorage.capacity < sizeof(StreamingSourceState) ||
      (reinterpret_cast<uintptr_t>(stateStorage.data) &
       (alignof(StreamingSourceState) - 1)) != 0 ||
      config.node.value == 0 || window == nullptr ||
      window->channels == nullptr || window->channelCount == 0 ||
      window->channelCount > kMaximumChannelsPerBus ||
      !isPowerOfTwo(window->capacityFrames) ||
      config.sourceStartFrame > window->totalFrames ||
      !std::isfinite(window->sampleRate.value) ||
      window->sampleRate.value <= 0.0)
    return {nullptr, nullptr};
  for (uint32_t channel = 0; channel < window->channelCount; ++channel)
    if (window->channels[channel] == nullptr)
      return {nullptr, nullptr};
  auto *state = reinterpret_cast<StreamingSourceState *>(stateStorage.data);
  std::construct_at(state);
  state->node = config.node;
  state->window = window;
  state->sampleRate = window->sampleRate;
  state->frameCount = window->totalFrames;
  state->channelCount = window->channelCount;
  state->cursor = config.sourceStartFrame;
  state->entryProjectTimeSamples = config.entryProjectTimeSamples;
  state->sourceStartFrame = config.sourceStartFrame;
  state->cursorSequence.store(0, std::memory_order_relaxed);
  for (uint32_t slot = 0; slot < 2; ++slot) {
    state->cursorLow[slot].store(static_cast<uint32_t>(config.sourceStartFrame),
                                 std::memory_order_relaxed);
    state->cursorHigh[slot].store(
        static_cast<uint32_t>(config.sourceStartFrame >> 32),
        std::memory_order_relaxed);
  }
  return {state, &kStreamingFunctions};
}

void streamingWindowPublishResident(StreamingWindow *window, uint64_t start,
                                    uint64_t end) noexcept {
  if (window == nullptr || end < start)
    return;
  // A window cannot claim more than it can hold: a feeder that published a
  // longer range would have the render thread indexing frames its own newer
  // samples had already overwritten, which is a wrong sample rather than a
  // late one.
  if (end - start > window->capacityFrames)
    start = end - window->capacityFrames;
  publishRange(&window->resident, start, end);
}

bool streamingWindowResident(const StreamingWindow *window, uint64_t *start,
                             uint64_t *end) noexcept {
  if (window == nullptr || start == nullptr || end == nullptr)
    return false;
  return snapshotRange(&window->resident, start, end);
}

bool streamingWindowDemand(const StreamingWindow *window,
                           uint64_t *frame) noexcept {
  if (window == nullptr || frame == nullptr)
    return false;
  uint64_t low = 0;
  uint64_t high = 0;
  if (!snapshotRange(&window->demand, &low, &high))
    return false;
  *frame = low;
  return true;
}

uint64_t
streamingWindowSourceCursor(const ProcessorHandle &processor,
                            DecodedBufferSourceCursorReader *reader) noexcept {
  if (processor.state == nullptr ||
      processor.functions != &kStreamingFunctions)
    return 0;
  const auto *state = static_cast<const StreamingSourceState *>(processor.state);
  uint64_t lastGood = reader == nullptr ? 0 : reader->lastGoodFrames;
  if (lastGood > state->frameCount)
    lastGood = state->frameCount;
  for (uint32_t attempt = 0; attempt < 8; ++attempt) {
    const uint32_t before =
        state->cursorSequence.load(std::memory_order_acquire);
    const uint32_t slot = before & 1u;
    const uint32_t low = state->cursorLow[slot].load(std::memory_order_relaxed);
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

void streamingWindowInitialize(StreamingWindow *window,
                               uint64_t start) noexcept {
  if (window == nullptr)
    return;
  window->starvedBlocks.store(0, std::memory_order_relaxed);
  publishRange(&window->resident, start, start);
  publishRange(&window->demand, start, start);
}

} // namespace zdsp

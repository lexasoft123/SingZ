#include "zdsp/scheduled_cue_source.h"

#include <array>
#include <atomic>
#include <cmath>
#include <limits>
#include <memory>

namespace zdsp {
namespace {

struct ScheduledCueState {
  struct OneShotVoice {
    uint32_t soundIndex{0};
    uint32_t sourceOffset{0};
  };

  NodeId node;
  const ScheduledCueEvent *events;
  const ScheduledCueSoundView *sounds;
  SampleRateHz sampleRate;
  uint32_t eventCount;
  uint32_t soundCount;
  uint32_t maximumSoundFrames;
  uint32_t maximumBlockFrames;
  uint64_t maximumProjectRateQ32;
  uint32_t prepared;
  uint32_t active;
  std::array<uint32_t, kMaximumScheduledCueOneShots> oneShotCommands{};
  std::atomic<uint32_t> oneShotProduced{0};
  std::atomic<uint32_t> oneShotConsumed{0};
  std::array<OneShotVoice, kMaximumScheduledCueOneShots> oneShotVoices{};
  uint32_t oneShotVoiceCount{0};
  std::atomic<uint64_t> oneShotsEnqueued{0};
  std::atomic<uint64_t> oneShotsStarted{0};
  std::atomic<uint64_t> oneShotsCompleted{0};
  std::atomic<uint32_t> oneShotsPending{0};
};

static_assert(std::atomic<uint64_t>::is_always_lock_free);

void silence(const MutableAudioBusView &output) noexcept {
  for (uint32_t channel = 0; channel < output.channelCount; ++channel)
    for (uint32_t frame = 0; frame < output.frames.value; ++frame)
      output.channels[channel][frame] = 0.0f;
}

bool densityIsBounded(const ScheduledCueState &state,
                      uint32_t maximumBlockFrames) noexcept {
  if (state.eventCount <= kMaximumScheduledCueEventsPerRender)
    return true;
  // An event's first output frame can land up to one project step after the
  // event itself, so a sound is audible for maximumSoundFrames whole output
  // frames past it; the scan (below) reaches back that far, and this bound
  // must cover the same window.
  const uint64_t maximumOutputSpan =
      static_cast<uint64_t>(state.maximumSoundFrames) +
      static_cast<uint64_t>(maximumBlockFrames - 1u);
  if (maximumOutputSpan >
      std::numeric_limits<uint64_t>::max() / state.maximumProjectRateQ32)
    return false;
  const uint64_t projectSpanQ32 =
      maximumOutputSpan * state.maximumProjectRateQ32;
  const uint64_t windowSpan =
      (projectSpanQ32 >> 32) +
      ((projectSpanQ32 & 0xffffffffu) != 0 ? 1u : 0u);
  uint32_t first = 0;
  for (uint32_t last = 0; last < state.eventCount; ++last) {
    while (first < last &&
           static_cast<uint64_t>(state.events[last].projectTimeSamples) -
                   static_cast<uint64_t>(
                       state.events[first].projectTimeSamples) >
               windowSpan)
      ++first;
    if (last - first + 1u > kMaximumScheduledCueEventsPerRender)
      return false;
  }
  return true;
}

Status prepare(void *opaque, const PrepareSpec *spec,
               const PreparedStorage *) noexcept {
  if (opaque == nullptr || spec == nullptr)
    return {StatusCode::InvalidArgument, 1};
  auto *state = static_cast<ScheduledCueState *>(opaque);
  if (state->prepared != 0 || !succeeded(validatePrepareSpec(*spec)))
    return {StatusCode::InvalidArgument, 2};
  if (spec->inputBusCount != 0 || spec->outputBusCount != 1 ||
      spec->outputBuses[0].channelCount != 1 ||
      spec->sampleRate.value != state->sampleRate.value)
    return {StatusCode::UnsupportedFormat, 3};
  if (!densityIsBounded(*state, spec->maximumBlockFrames.value))
    return {StatusCode::CapacityExceeded, 4};
  state->maximumBlockFrames = spec->maximumBlockFrames.value;
  state->prepared = 1;
  state->active = 1;
  return okStatus();
}

void reset(void *, Discontinuity) noexcept {}

void mixSample(float *destination, float sample) noexcept {
  const double mixed = static_cast<double>(*destination) +
                       static_cast<double>(sample);
  constexpr double maximum =
      static_cast<double>(std::numeric_limits<float>::max());
  *destination =
      mixed > maximum
          ? std::numeric_limits<float>::max()
          : (mixed < -maximum ? -std::numeric_limits<float>::max()
                              : static_cast<float>(mixed));
}

void activateOneShots(ScheduledCueState *state) noexcept {
  uint32_t consumed =
      state->oneShotConsumed.load(std::memory_order_relaxed);
  const uint32_t produced =
      state->oneShotProduced.load(std::memory_order_acquire);
  while (consumed != produced &&
         state->oneShotVoiceCount < kMaximumScheduledCueOneShots) {
    const uint32_t soundIndex =
        state->oneShotCommands[consumed % kMaximumScheduledCueOneShots];
    ++consumed;
    state->oneShotVoices[state->oneShotVoiceCount++] = {soundIndex, 0};
    state->oneShotsStarted.fetch_add(1, std::memory_order_release);
  }
  state->oneShotConsumed.store(consumed, std::memory_order_release);
}

void renderOneShots(ScheduledCueState *state,
                    const MutableAudioBusView &output) noexcept {
  activateOneShots(state);
  float *destination = output.channels[0];
  uint32_t retained = 0;
  for (uint32_t index = 0; index < state->oneShotVoiceCount; ++index) {
    ScheduledCueState::OneShotVoice voice = state->oneShotVoices[index];
    const ScheduledCueSoundView &sound = state->sounds[voice.soundIndex];
    const uint32_t remaining = sound.frameCount - voice.sourceOffset;
    const uint32_t copied =
        remaining < output.frames.value ? remaining : output.frames.value;
    for (uint32_t frame = 0; frame < copied; ++frame)
      mixSample(&destination[frame],
                sound.samples[voice.sourceOffset + frame]);
    voice.sourceOffset += copied;
    if (voice.sourceOffset == sound.frameCount) {
      state->oneShotsCompleted.fetch_add(1, std::memory_order_release);
      state->oneShotsPending.fetch_sub(1, std::memory_order_release);
    } else {
      state->oneShotVoices[retained++] = voice;
    }
  }
  state->oneShotVoiceCount = retained;
}

uint32_t lowerBoundEvent(const ScheduledCueState &state,
                         int64_t projectTimeSamples) noexcept {
  uint32_t first = 0;
  uint32_t count = state.eventCount;
  while (count != 0) {
    const uint32_t step = count / 2u;
    const uint32_t middle = first + step;
    if (state.events[middle].projectTimeSamples < projectTimeSamples) {
      first = middle + 1u;
      count -= step + 1u;
    } else {
      count = step;
    }
  }
  return first;
}

int64_t saturatingSubtract(int64_t value, uint32_t amount) noexcept {
  if (amount != 0 && value < std::numeric_limits<int64_t>::min() +
                                 static_cast<int64_t>(amount))
    return std::numeric_limits<int64_t>::min();
  return value - static_cast<int64_t>(amount);
}

void process(void *opaque, const ProcessContext *context,
             const ConstAudioBusView *, uint32_t inputCount,
             const MutableAudioBusView *outputs,
             uint32_t outputCount) noexcept {
  auto *state = static_cast<ScheduledCueState *>(opaque);
  if (state == nullptr || context == nullptr || outputs == nullptr ||
      inputCount != 0 || outputCount != 1)
    return;
  const MutableAudioBusView &output = outputs[0];
  silence(output);
  const uint32_t frames = output.frames.value;
  if (frames == 0 || output.channelCount != 1 || state->active == 0 ||
      frames > state->maximumBlockFrames ||
      (processContextFlags(*context) & ProcessContextFlagTailDrain) != 0)
    return;

  renderOneShots(state, output);
  if (
      context->transport == nullptr ||
      (context->transport->validFields & TransportValidProjectSamples) == 0 ||
      (context->transport->stateFlags & TransportStatePlaying) == 0)
    return;

  ProjectSamplePositionQ32 blockStart{};
  ProjectSamplePositionQ32 blockLast{};
  if (!projectSamplePositionAt(*context->transport, 0, &blockStart) ||
      !projectSamplePositionAt(*context->transport, frames - 1u, &blockLast))
    return;
  const uint64_t rate =
      (context->transport->validFields & TransportValidProjectRateQ32) != 0
          ? context->transport->projectRateQ32
          : kProjectRateOneQ32;
  if (rate == 0)
    return;
  if (rate > state->maximumProjectRateQ32)
    return;
  if (state->maximumSoundFrames >
      std::numeric_limits<uint64_t>::max() / rate)
    return;
  // Look back one whole sound duration in project time: an event's first
  // output frame lands up to one project step after it, and the tail runs
  // (frameCount - 1) output frames further. One frame less made the render
  // depend on where the host split its callbacks at rates above 1.0.
  const uint64_t historyDelta =
      rate * static_cast<uint64_t>(state->maximumSoundFrames);
  const uint64_t historyWhole =
      (historyDelta >> 32) + ((historyDelta & 0xffffffffu) != 0 ? 1u : 0u);
  const uint32_t history =
      historyWhole > std::numeric_limits<uint32_t>::max()
          ? std::numeric_limits<uint32_t>::max()
          : static_cast<uint32_t>(historyWhole);
  const int64_t earliest =
      saturatingSubtract(blockStart.samples, history);
  uint32_t eventIndex = lowerBoundEvent(*state, earliest);
  uint32_t renderedEvents = 0;
  float *destination = output.channels[0];
  while (eventIndex < state->eventCount &&
         state->events[eventIndex].projectTimeSamples <= blockLast.samples &&
         renderedEvents < kMaximumScheduledCueEventsPerRender) {
    const ScheduledCueEvent &event = state->events[eventIndex];
    const ScheduledCueSoundView &sound = state->sounds[event.soundIndex];
    uint32_t sourceOffset = 0;
    uint32_t destinationOffset = 0;
    if (event.projectTimeSamples <= blockStart.samples) {
      const uint64_t elapsedWhole = static_cast<uint64_t>(blockStart.samples) -
                               static_cast<uint64_t>(event.projectTimeSamples);
      if (elapsedWhole > (std::numeric_limits<uint64_t>::max() >> 32)) {
        ++eventIndex;
        ++renderedEvents;
        continue;
      }
      const uint64_t elapsedQ32 =
          (elapsedWhole << 32) + blockStart.fraction;
      const uint64_t elapsedOutput = elapsedQ32 / rate;
      if (elapsedOutput >= sound.frameCount) {
        ++eventIndex;
        ++renderedEvents;
        continue;
      }
      sourceOffset = static_cast<uint32_t>(elapsedOutput);
    } else {
      const uint64_t aheadWhole =
          static_cast<uint64_t>(event.projectTimeSamples) -
          static_cast<uint64_t>(blockStart.samples);
      if (aheadWhole > (std::numeric_limits<uint64_t>::max() >> 32))
        break;
      const uint64_t aheadQ32 =
          (aheadWhole << 32) - blockStart.fraction;
      const uint64_t offset = aheadQ32 / rate +
                              (aheadQ32 % rate == 0 ? 0u : 1u);
      if (offset >= frames)
        break;
      destinationOffset = static_cast<uint32_t>(offset);
    }
    const uint32_t soundRemaining = sound.frameCount - sourceOffset;
    const uint32_t blockRemaining = frames - destinationOffset;
    const uint32_t copied =
        soundRemaining < blockRemaining ? soundRemaining : blockRemaining;
    for (uint32_t frame = 0; frame < copied; ++frame) {
      mixSample(&destination[destinationOffset + frame],
                sound.samples[sourceOffset + frame]);
    }
    ++eventIndex;
    ++renderedEvents;
  }
}

LatencyFrames latency(const void *) noexcept { return {0}; }
TailInfo tail(const void *) noexcept { return {TailKind::None, {0}}; }

Status deactivate(void *opaque) noexcept {
  auto *state = static_cast<ScheduledCueState *>(opaque);
  if (state == nullptr || state->active == 0)
    return {StatusCode::InvalidArgument, 1};
  state->active = 0;
  return okStatus();
}

Status destroy(void *opaque) noexcept {
  auto *state = static_cast<ScheduledCueState *>(opaque);
  if (state == nullptr || state->active != 0)
    return {StatusCode::InvalidArgument, 1};
  state->prepared = 0;
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

bool configIsValid(const ScheduledCueSourceConfig &config,
                   uint32_t *maximumSoundFrames) noexcept {
  if (config.node.value == 0 || !std::isfinite(config.sampleRate.value) ||
      config.sampleRate.value <= 0.0 || config.soundCount == 0 ||
      config.soundCount > kMaximumScheduledCueSounds ||
      config.eventCount > kMaximumScheduledCueEvents ||
      config.maximumProjectRateQ32 == 0 ||
      config.sounds == nullptr ||
      (config.eventCount != 0 && config.events == nullptr))
    return false;

  uint32_t totalSoundFrames = 0;
  *maximumSoundFrames = 0;
  for (uint32_t soundIndex = 0; soundIndex < config.soundCount; ++soundIndex) {
    const ScheduledCueSoundView &sound = config.sounds[soundIndex];
    if (sound.samples == nullptr || sound.frameCount == 0 ||
        sound.frameCount > kMaximumScheduledCueFramesPerSound ||
        sound.frameCount >
            kMaximumScheduledCueTotalSoundFrames - totalSoundFrames)
      return false;
    totalSoundFrames += sound.frameCount;
    if (sound.frameCount > *maximumSoundFrames)
      *maximumSoundFrames = sound.frameCount;
    for (uint32_t frame = 0; frame < sound.frameCount; ++frame)
      if (!std::isfinite(sound.samples[frame]))
        return false;
  }

  std::array<int64_t, kMaximumScheduledCueOverlap> activeLastSamples{};
  uint32_t activeCount = 0;
  for (uint32_t eventIndex = 0; eventIndex < config.eventCount; ++eventIndex) {
    const ScheduledCueEvent &event = config.events[eventIndex];
    if (event.soundIndex >= config.soundCount ||
        (eventIndex != 0 &&
         event.projectTimeSamples <
             config.events[eventIndex - 1u].projectTimeSamples))
      return false;
    const uint32_t soundFrames = config.sounds[event.soundIndex].frameCount;
    const uint64_t soundSpan = static_cast<uint64_t>(soundFrames - 1u);
    if (soundSpan > std::numeric_limits<uint64_t>::max() /
                        config.maximumProjectRateQ32)
      return false;
    const uint64_t activeSpanQ32 =
        soundSpan * config.maximumProjectRateQ32;
    const uint64_t activeSpan =
        (activeSpanQ32 >> 32) +
        ((activeSpanQ32 & 0xffffffffu) != 0 ? 1u : 0u);
    if (activeSpan > static_cast<uint64_t>(std::numeric_limits<int64_t>::max()) ||
        event.projectTimeSamples > std::numeric_limits<int64_t>::max() -
                                       static_cast<int64_t>(activeSpan))
      return false;
    uint32_t retained = 0;
    for (uint32_t active = 0; active < activeCount; ++active)
      if (activeLastSamples[active] >= event.projectTimeSamples)
        activeLastSamples[retained++] = activeLastSamples[active];
    activeCount = retained;
    if (activeCount == kMaximumScheduledCueOverlap)
      return false;
    activeLastSamples[activeCount++] =
        event.projectTimeSamples + static_cast<int64_t>(activeSpan);
  }
  return true;
}

} // namespace

size_t scheduledCueSourceStateBytes() noexcept {
  return sizeof(ScheduledCueState);
}

ProcessorHandle
createScheduledCueSource(const ScheduledCueSourceConfig &config,
                         MutableByteView stateStorage) noexcept {
  uint32_t maximumSoundFrames = 0;
  if (stateStorage.data == nullptr ||
      stateStorage.capacity < sizeof(ScheduledCueState) ||
      (reinterpret_cast<uintptr_t>(stateStorage.data) &
       (alignof(ScheduledCueState) - 1)) != 0 ||
      !configIsValid(config, &maximumSoundFrames))
    return {nullptr, nullptr};
  auto *state = reinterpret_cast<ScheduledCueState *>(stateStorage.data);
  std::construct_at(state);
  state->node = config.node;
  state->events = config.events;
  state->sounds = config.sounds;
  state->sampleRate = config.sampleRate;
  state->eventCount = config.eventCount;
  state->soundCount = config.soundCount;
  state->maximumSoundFrames = maximumSoundFrames;
  state->maximumProjectRateQ32 = config.maximumProjectRateQ32;
  return {state, &kFunctions};
}

bool enqueueScheduledCueOneShot(const ProcessorHandle &processor,
                                uint32_t soundIndex) noexcept {
  if (processor.state == nullptr || processor.functions != &kFunctions)
    return false;
  auto *state = static_cast<ScheduledCueState *>(processor.state);
  if (state->active == 0 || soundIndex >= state->soundCount)
    return false;
  const uint32_t produced =
      state->oneShotProduced.load(std::memory_order_relaxed);
  const uint32_t consumed =
      state->oneShotConsumed.load(std::memory_order_acquire);
  if (produced - consumed >= kMaximumScheduledCueOneShots)
    return false;
  state->oneShotCommands[produced % kMaximumScheduledCueOneShots] = soundIndex;
  state->oneShotsEnqueued.fetch_add(1, std::memory_order_release);
  state->oneShotsPending.fetch_add(1, std::memory_order_release);
  state->oneShotProduced.store(produced + 1u, std::memory_order_release);
  return true;
}

ScheduledCueOneShotStatus
scheduledCueOneShotStatus(const ProcessorHandle &processor) noexcept {
  if (processor.state == nullptr || processor.functions != &kFunctions)
    return {};
  const auto *state = static_cast<const ScheduledCueState *>(processor.state);
  return {state->oneShotsEnqueued.load(std::memory_order_acquire),
          state->oneShotsStarted.load(std::memory_order_acquire),
          state->oneShotsCompleted.load(std::memory_order_acquire),
          state->oneShotsPending.load(std::memory_order_acquire)};
}

} // namespace zdsp

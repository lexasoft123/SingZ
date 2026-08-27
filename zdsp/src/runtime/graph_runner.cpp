#include "graph_internal.h"
#include "zdsp/graph_runner.h"

#include <cmath>
#include <limits.h>

namespace zdsp {
namespace {

thread_local bool gInGraphRenderCallback = false;

bool sameRate(SampleRateHz left, SampleRateHz right) noexcept {
  return left.value == right.value;
}

bool sameExternalBus(const RuntimeExternalBus& left,
                     const RuntimeExternalBus& right) noexcept {
  if (left.channels != right.channels || left.sampleFormat != right.sampleFormat ||
      left.layout != right.layout) return false;
  if (left.layout != AudioChannelLayout::Discrete) return true;
  for (uint32_t channel = 0; channel < left.channels; ++channel)
    if (left.roles[channel] != right.roles[channel]) return false;
  return true;
}

bool transitionTopologyCompatible(const CompiledGraph& oldGraph,
                                  const CompiledGraph& newGraph) noexcept {
  if (!sameRate(oldGraph.sampleRate, newGraph.sampleRate) ||
      oldGraph.maximumBlockFrames.value != newGraph.maximumBlockFrames.value ||
      oldGraph.inputCount != newGraph.inputCount ||
      oldGraph.outputCount != newGraph.outputCount) return false;
  for (uint32_t bus = 0; bus < oldGraph.inputCount; ++bus)
    if (!sameExternalBus(oldGraph.inputs[bus], newGraph.inputs[bus])) return false;
  for (uint32_t bus = 0; bus < oldGraph.outputCount; ++bus)
    if (!sameExternalBus(oldGraph.outputs[bus], newGraph.outputs[bus])) return false;
  return true;
}

Status validateGraphBlock(const CompiledGraph* graph,
                          const ProcessContext& context,
                          const ConstAudioBusView* inputs, uint32_t inputCount,
                          const MutableAudioBusView* outputs,
                          uint32_t outputCount) noexcept {
  if (graph == nullptr || inputCount != graph->inputCount ||
      outputCount != graph->outputCount || !sameRate(context.sampleRate, graph->sampleRate) ||
      context.frames.value > graph->maximumBlockFrames.value ||
      (inputCount != 0 && inputs == nullptr) ||
      (outputCount != 0 && outputs == nullptr)) return {StatusCode::InvalidArgument, 1};
  for (uint32_t bus = 0; bus < inputCount; ++bus) {
    if (!isValid(inputs[bus]) || inputs[bus].frames.value != context.frames.value ||
        inputs[bus].channelCount != graph->inputs[bus].channels)
      return {StatusCode::InvalidArgument, bus + 10};
    if (context.frames.value != 0) {
      for (uint32_t channel = 0; channel < inputs[bus].channelCount; ++channel)
        if (inputs[bus].channels[channel] == nullptr)
          return {StatusCode::InvalidArgument, bus + 30};
    }
    if (inputs[bus].capture != nullptr) {
      const CaptureTime& capture = *inputs[bus].capture;
      constexpr uint32_t kKnownCaptureFlags =
          CaptureTimeSourceFrameValid | CaptureTimeSampleHostValid |
          CaptureTimeCallbackHostValid | CaptureTimeStaleAnchor |
          CaptureTimeTimestampQualityValid;
      if (capture.quality > CaptureTimestampQuality::Hardware ||
          capture.discontinuity.reason > DiscontinuityReason::SourceFrameOverflow ||
          (capture.discontinuity.flags &
           ~(DiscontinuityFlagResetState | DiscontinuityFlagTimeValid)) != 0 ||
          (capture.flags & ~kKnownCaptureFlags) != 0 ||
          ((capture.flags & CaptureTimeStaleAnchor) != 0 &&
           (capture.flags & (CaptureTimeSampleHostValid |
                             CaptureTimeTimestampQualityValid)) !=
               (CaptureTimeSampleHostValid |
                CaptureTimeTimestampQualityValid)))
        return {StatusCode::InvalidArgument, bus + 60};
    }
  }
  for (uint32_t bus = 0; bus < outputCount; ++bus) {
    if (!isValid(outputs[bus]) || outputs[bus].frames.value != context.frames.value ||
        outputs[bus].channelCount != graph->outputs[bus].channels)
      return {StatusCode::InvalidArgument, bus + 20};
    if (context.frames.value != 0) {
      for (uint32_t channel = 0; channel < outputs[bus].channelCount; ++channel)
        if (outputs[bus].channels[channel] == nullptr)
          return {StatusCode::InvalidArgument, bus + 40};
    }
  }
  if (context.frames.value != 0) {
    for (uint32_t buffer = 0; buffer < graph->bufferCount; ++buffer) {
      if (graph->buffers[buffer].channels == nullptr)
        return {StatusCode::InvalidArgument, buffer + 50};
      for (uint32_t channel = 0;
           channel < graph->buffers[buffer].channelCount; ++channel)
        if (graph->buffers[buffer].channels[channel] == nullptr)
          return {StatusCode::InvalidArgument, buffer + 50};
    }
  }
  return okStatus();
}

float contained(float value, uint32_t* invalidSamples) noexcept {
  if (std::isfinite(value)) return value;
  if (invalidSamples != nullptr && *invalidSamples != UINT32_MAX)
    ++*invalidSamples;
  return 0.0f;
}

uint64_t offsetNanoseconds(uint32_t frames, SampleRateHz rate) noexcept;

CaptureTime offsetCapture(CaptureTime capture, uint32_t offset,
                          SampleRateHz rate) noexcept {
  if ((capture.flags & CaptureTimeSourceFrameValid) != 0) {
    if (capture.sourceFrame.value > UINT64_MAX - offset)
      capture.flags &= ~CaptureTimeSourceFrameValid;
    else
      capture.sourceFrame.value += offset;
  }
  if ((capture.flags & CaptureTimeSampleHostValid) != 0) {
    const uint64_t delta = offsetNanoseconds(offset, rate);
    if (capture.sampleHostTime.value > UINT64_MAX - delta)
      capture.flags &= ~CaptureTimeSampleHostValid;
    else
      capture.sampleHostTime.value += delta;
  }
  return capture;
}

bool captureContinues(const CaptureTime& previous, const CaptureTime& next,
                      SampleRateHz rate) noexcept {
  if (previous.clockDomain.value != next.clockDomain.value ||
      previous.streamGeneration.value != next.streamGeneration.value ||
      previous.quality != next.quality || previous.flags != next.flags ||
      previous.discontinuity.reason != DiscontinuityReason::None ||
      next.discontinuity.reason != DiscontinuityReason::None ||
      previous.discontinuity.flags != DiscontinuityFlagNone ||
      next.discontinuity.flags != DiscontinuityFlagNone) return false;
  if (next.sequence == previous.sequence) {
    if ((previous.flags & CaptureTimeCallbackHostValid) != 0 &&
        next.callbackHostTime.value != previous.callbackHostTime.value)
      return false;
  } else if (previous.sequence == UINT64_MAX ||
             next.sequence != previous.sequence + 1 ||
             ((previous.flags & CaptureTimeCallbackHostValid) != 0 &&
              next.callbackHostTime.value <= previous.callbackHostTime.value)) {
    return false;
  }
  if ((previous.flags & CaptureTimeSourceFrameValid) != 0) {
    if (previous.sourceFrame.value == UINT64_MAX ||
        next.sourceFrame.value != previous.sourceFrame.value + 1) return false;
  }
  if ((previous.flags & CaptureTimeSampleHostValid) != 0) {
    if (next.sampleHostTime.value <= previous.sampleHostTime.value) return false;
    const uint64_t delta = next.sampleHostTime.value - previous.sampleHostTime.value;
    const double exact = 1000000000.0 / rate.value;
    const uint64_t lower = static_cast<uint64_t>(std::floor(exact));
    const uint64_t upper = static_cast<uint64_t>(std::ceil(exact));
    if (delta < lower || delta > upper) return false;
  }
  return true;
}

const CaptureTime* advanceCaptureDelay(RuntimeCaptureDelay* delay,
                                       const CaptureTime* incoming,
                                       FrameCount frames,
                                       SampleRateHz rate) noexcept {
  if (delay == nullptr || delay->frames == 0) return incoming;
  bool outputValid = frames.value != 0;
  CaptureTime first{};
  CaptureTime previous{};
  uint32_t cursor = delay->cursor;
  for (uint32_t frame = 0; frame < frames.value; ++frame) {
    const bool valid = delay->valid[cursor] != 0;
    const CaptureTime outgoing = valid ? delay->samples[cursor] : CaptureTime{};
    if (frame == 0) {
      outputValid = valid;
      first = outgoing;
    } else if (!valid || !captureContinues(previous, outgoing, rate)) {
      outputValid = false;
    }
    previous = outgoing;
    if (incoming == nullptr) {
      delay->valid[cursor] = 0;
    } else {
      delay->samples[cursor] = offsetCapture(*incoming, frame, rate);
      delay->valid[cursor] = 1;
    }
    if (++cursor == delay->frames) cursor = 0;
  }
  delay->cursor = cursor;
  if (!outputValid) return nullptr;
  delay->output = first;
  return &delay->output;
}

void resetCaptureDelay(RuntimeCaptureDelay* delay) noexcept {
  if (delay == nullptr) return;
  delay->cursor = 0;
  delay->output = {};
  for (uint32_t frame = 0; frame < delay->frames; ++frame)
    delay->valid[frame] = 0;
}

void runDelay(RuntimeDelay* delay, FrameCount frames,
              RuntimeBuffer* buffers, uint32_t* invalidSamples,
              SampleRateHz rate) noexcept {
  if (delay == nullptr || delay->frames == 0) return;
  RuntimeBuffer& source = buffers[delay->sourceBuffer];
  RuntimeBuffer& destination = buffers[delay->destinationBuffer];
  destination.capture = advanceCaptureDelay(
      &delay->capture, source.capture, frames, rate);
  uint32_t cursor = delay->cursor;
  for (uint32_t frame = 0; frame < frames.value; ++frame) {
    for (uint32_t channel = 0; channel < delay->channels; ++channel) {
      float* lane = delay->samples + static_cast<size_t>(channel) * delay->frames;
      const float incoming = contained(source.channels[channel][frame], invalidSamples);
      destination.channels[channel][frame] = lane[cursor];
      lane[cursor] = incoming;
    }
    if (++cursor == delay->frames) cursor = 0;
  }
  delay->cursor = cursor;
}

void alignBus(const MutableAudioBusView& bus, float* samples,
              uint32_t delayFrames, uint32_t* cursor) noexcept {
  if (delayFrames == 0 || samples == nullptr || cursor == nullptr) return;
  uint32_t position = *cursor;
  for (uint32_t frame = 0; frame < bus.frames.value; ++frame) {
    for (uint32_t channel = 0; channel < bus.channelCount; ++channel) {
      float* lane = samples + static_cast<size_t>(channel) * delayFrames;
      const float incoming = bus.channels[channel][frame];
      bus.channels[channel][frame] = lane[position];
      lane[position] = incoming;
    }
    if (++position == delayFrames) position = 0;
  }
  *cursor = position;
}

void alignOutputBuses(const MutableAudioBusView* buses, uint32_t busCount,
                      float* samples, uint32_t delayFrames,
                      uint32_t* cursor) noexcept {
  if (delayFrames == 0 || samples == nullptr || cursor == nullptr ||
      buses == nullptr || busCount == 0) return;
  const uint32_t initial = *cursor;
  uint32_t final = initial;
  uint32_t lane = 0;
  for (uint32_t bus = 0; bus < busCount; ++bus) {
    uint32_t busCursor = initial;
    alignBus(buses[bus], samples + static_cast<size_t>(lane) * delayFrames,
             delayFrames, &busCursor);
    final = busCursor;
    lane += buses[bus].channelCount;
  }
  *cursor = final;
}

bool buildTransitionOutputViews(GraphRunnerStorage* storage,
                                const MutableAudioBusView* external,
                                uint32_t busCount, FrameCount frames,
                                MutableAudioBusView* views) noexcept {
  if (storage == nullptr || external == nullptr || views == nullptr ||
      storage->oldOutputSamples == nullptr ||
      storage->oldOutputChannels == nullptr ||
      frames.value > storage->frameCapacity.value) return false;
  uint32_t lane = 0;
  for (uint32_t bus = 0; bus < busCount; ++bus) {
    const uint32_t firstLane = lane;
    if (external[bus].channelCount > storage->channelCapacity ||
        lane > storage->channelCapacity - external[bus].channelCount)
      return false;
    for (uint32_t channel = 0; channel < external[bus].channelCount; ++channel) {
      storage->oldOutputChannels[lane] = storage->oldOutputSamples +
          static_cast<size_t>(lane) * storage->frameCapacity.value;
      ++lane;
    }
    views[bus] = {storage->oldOutputChannels + firstLane,
                  external[bus].channelCount, frames,
                  storage->frameCapacity};
  }
  return true;
}

bool reserveSlot(SnapshotPublisher* publisher, uint32_t* slot) noexcept {
  for (uint32_t index = 0; index < publisher->retirementCapacity; ++index) {
    uint32_t expected = static_cast<uint32_t>(RetirementSlotState::Free);
    if (publisher->retirementSlots[index].state.compare_exchange_strong(
            expected, static_cast<uint32_t>(RetirementSlotState::Reserved),
            std::memory_order_acq_rel, std::memory_order_relaxed)) {
      *slot = index;
      return true;
    }
  }
  return false;
}

void releaseReservation(SnapshotPublisher* publisher,
                        PublishedGraphSnapshot* snapshot) noexcept {
  if (snapshot == nullptr ||
      snapshot->reservedRetirementSlot >= publisher->retirementCapacity) return;
  RetirementSlot& slot =
      publisher->retirementSlots[snapshot->reservedRetirementSlot];
  slot.snapshot.store(nullptr, std::memory_order_relaxed);
  slot.retireAfterEpoch = 0;
  slot.state.store(static_cast<uint32_t>(RetirementSlotState::Free),
                   std::memory_order_release);
}

bool transitionValid(const PublishedGraphSnapshot& snapshot) noexcept {
  const TransitionPlan& plan = snapshot.transition;
  if (snapshot.generation == 0 ||
      plan.infiniteTailPolicy > InfiniteTailPolicy::Cut) return false;
  if ((plan.expectedReplacementGraph != nullptr &&
       plan.expectedReplacementGraph != snapshot.graph) ||
      (plan.replacementGeneration != 0 &&
       plan.replacementGeneration != snapshot.generation)) return false;
  if (plan.kind != TransitionKind::HardCut &&
      plan.kind != TransitionKind::Crossfade) return false;
  if (plan.kind == TransitionKind::Crossfade && plan.crossfadeFrames.value == 0)
    return false;
  if (plan.kind == TransitionKind::HardCut &&
      (plan.oldAlignmentDelay.value != 0 || plan.newAlignmentDelay.value != 0))
    return false;
  const uint64_t combined = static_cast<uint64_t>(plan.oldCpuPermille) +
                            plan.newCpuPermille;
  if (plan.combinedCpuLimitPermille > 1000 ||
      combined > plan.combinedCpuLimitPermille) return false;
  if (plan.replacedTail.kind > TailKind::Infinite) return false;
  if (plan.kind == TransitionKind::HardCut) {
    if (plan.replacedTail.kind == TailKind::Infinite &&
        plan.infiniteTailPolicy != InfiniteTailPolicy::Cut) return false;
    return plan.tailSpillFrames.value == 0;
  }
  if (plan.replacedTail.kind != TailKind::Infinite) {
    if (plan.replacedTail.frames.value >
        UINT64_MAX - plan.oldAlignmentDelay.value) return false;
    const uint64_t requiredSpill = plan.replacedTail.frames.value +
                                   plan.oldAlignmentDelay.value;
    if (plan.tailSpillFrames.value < requiredSpill) return false;
  }
  if (plan.replacedTail.kind == TailKind::Infinite) {
    if (plan.infiniteTailPolicy == InfiniteTailPolicy::Reject) return false;
    if (plan.infiniteTailPolicy == InfiniteTailPolicy::Fade)
      return plan.tailSpillFrames.value != 0;
    if (plan.infiniteTailPolicy == InfiniteTailPolicy::Cut)
      return plan.tailSpillFrames.value == 0;
  }
  return true;
}

bool transitionIdentityMatches(const PublishedGraphSnapshot& oldSnapshot,
                               const PublishedGraphSnapshot& next) noexcept {
  const TransitionPlan& plan = next.transition;
  return plan.expectedOldGraph == oldSnapshot.graph &&
         plan.expectedReplacementGraph == next.graph &&
         plan.expectedOldGeneration == oldSnapshot.generation &&
         plan.replacementGeneration == next.generation &&
         plan.expectedOldGeneration != 0 && plan.replacementGeneration != 0;
}

void markRetirementReady(GraphRunner* runner,
                         PublishedGraphSnapshot* retired) noexcept {
  if (retired == nullptr || runner->active == nullptr) return;
  const uint32_t index = runner->active->reservedRetirementSlot;
  if (index >= runner->publisher->retirementCapacity) return;
  RetirementSlot& slot = runner->publisher->retirementSlots[index];
  slot.snapshot.store(retired, std::memory_order_relaxed);
  slot.retireAfterEpoch = runner->epoch.load(std::memory_order_relaxed);
  slot.state.store(static_cast<uint32_t>(RetirementSlotState::Waiting),
                   std::memory_order_release);
}

uint32_t graphOutputChannels(const CompiledGraph& graph) noexcept {
  uint32_t total = 0;
  for (uint32_t bus = 0; bus < graph.outputCount; ++bus) {
    if (total > UINT32_MAX - graph.outputs[bus].channels) return UINT32_MAX;
    total += graph.outputs[bus].channels;
  }
  return total;
}

bool sampleStorageOffsetsFit(uint32_t channels,
                             uint32_t frames) noexcept {
  return frames == 0 ||
      channels <= SIZE_MAX / sizeof(float) / frames;
}

void primeAlignment(GraphRunner* runner,
                    const PublishedGraphSnapshot& next) noexcept {
  GraphRunnerStorage& storage = runner->transitionStorage;
  const uint32_t channels = graphOutputChannels(*next.graph);
  const uint32_t delay = next.transition.oldAlignmentDelay.value;
  runner->oldAlignmentCursor = 0;
  runner->newAlignmentCursor = 0;
  if (delay != 0 && storage.oldAlignmentSamples != nullptr &&
      storage.outputHistorySamples != nullptr && storage.historyCapacity.value >= delay) {
    const uint32_t historyCapacity = storage.historyCapacity.value;
    const uint32_t start = (runner->historyCursor + historyCapacity - delay) % historyCapacity;
    for (uint32_t channel = 0; channel < channels; ++channel) {
      const float* history = storage.outputHistorySamples +
          static_cast<size_t>(channel) * historyCapacity;
      float* alignment = storage.oldAlignmentSamples +
          static_cast<size_t>(channel) * delay;
      for (uint32_t frame = 0; frame < delay; ++frame)
        alignment[frame] = history[(start + frame) % historyCapacity];
    }
  }
  const uint32_t newDelay = next.transition.newAlignmentDelay.value;
  if (newDelay != 0 && storage.newAlignmentSamples != nullptr) {
    const uint32_t historyCapacity = storage.historyCapacity.value;
    const uint32_t start = historyCapacity < newDelay ? 0
        : (runner->historyCursor + historyCapacity - newDelay) % historyCapacity;
    for (uint32_t channel = 0; channel < channels; ++channel) {
      float* alignment = storage.newAlignmentSamples +
          static_cast<size_t>(channel) * newDelay;
      const float* history = storage.outputHistorySamples == nullptr ? nullptr
          : storage.outputHistorySamples +
              static_cast<size_t>(channel) * historyCapacity;
      for (uint32_t frame = 0; frame < newDelay; ++frame)
        alignment[frame] = history == nullptr || historyCapacity < newDelay
            ? 0.0f : history[(start + frame) % historyCapacity];
    }
  }
}

uint32_t graphInputChannels(const CompiledGraph& graph) noexcept {
  uint32_t total = 0;
  for (uint32_t bus = 0; bus < graph.inputCount; ++bus) {
    if (total > UINT32_MAX - graph.inputs[bus].channels) return UINT32_MAX;
    total += graph.inputs[bus].channels;
  }
  return total;
}

Status validateTransitionStorage(const GraphRunner& runner,
                                 const PublishedGraphSnapshot& transitionOwner,
                                 const PublishedGraphSnapshot& replaced,
                                 const ProcessContext& context,
                                 const MutableAudioBusView* outputs,
                                 uint32_t outputCount) noexcept {
  const TransitionPlan& plan = transitionOwner.transition;
  const GraphRunnerStorage& storage = runner.transitionStorage;
  const bool alignmentNeedsHistory =
      plan.oldAlignmentDelay.value != 0 || plan.newAlignmentDelay.value != 0;
  const bool missingAlignment =
      (plan.oldAlignmentDelay.value != 0 && storage.oldAlignmentSamples == nullptr) ||
      (plan.newAlignmentDelay.value != 0 && storage.newAlignmentSamples == nullptr) ||
      (alignmentNeedsHistory &&
       (storage.outputHistorySamples == nullptr ||
        storage.historyCapacity.value < plan.oldAlignmentDelay.value ||
        storage.historyCapacity.value < plan.newAlignmentDelay.value));
  const uint32_t silenceChannels = graphInputChannels(*replaced.graph);
  const uint32_t outputChannels = graphOutputChannels(*transitionOwner.graph);
  const bool invalidPreparedRequirements =
      (plan.requiredOutputBusCount != 0 &&
       plan.requiredOutputBusCount != transitionOwner.graph->outputCount) ||
      (plan.requiredOutputChannels != 0 &&
       plan.requiredOutputChannels != outputChannels) ||
      (plan.requiredTailInputChannels != 0 &&
       plan.requiredTailInputChannels != silenceChannels);
  const bool missingTailStorage = plan.tailSpillFrames.value != 0 &&
      replaced.graph->inputCount != 0 &&
      (silenceChannels == UINT32_MAX ||
       silenceChannels > storage.silenceChannelCapacity ||
       storage.silenceSamples == nullptr || storage.silenceChannels == nullptr);
  const bool unsafeOffsets =
      !sampleStorageOffsetsFit(storage.channelCapacity,
                               storage.frameCapacity.value) ||
      !sampleStorageOffsetsFit(storage.channelCapacity,
                               storage.alignmentCapacity.value) ||
      !sampleStorageOffsetsFit(storage.channelCapacity,
                               storage.historyCapacity.value) ||
      !sampleStorageOffsetsFit(storage.silenceChannelCapacity,
                               storage.frameCapacity.value);
  if (outputCount != transitionOwner.graph->outputCount || outputs == nullptr ||
      outputChannels == UINT32_MAX ||
      outputChannels > storage.channelCapacity || invalidPreparedRequirements ||
      unsafeOffsets ||
      context.frames.value > storage.frameCapacity.value ||
      plan.oldAlignmentDelay.value > storage.alignmentCapacity.value ||
      plan.newAlignmentDelay.value > storage.alignmentCapacity.value ||
      storage.oldOutputSamples == nullptr || storage.oldOutputChannels == nullptr ||
      missingAlignment || missingTailStorage)
    return {StatusCode::InsufficientStorage, 3};
  return okStatus();
}

bool buildSilentInputs(GraphRunner* runner, const CompiledGraph& graph,
                       FrameCount frames, ConstAudioBusView* buses) noexcept {
  GraphRunnerStorage& storage = runner->transitionStorage;
  const uint32_t totalChannels = graphInputChannels(graph);
  if (graph.inputCount == 0) return true;
  if (totalChannels == UINT32_MAX || totalChannels > storage.silenceChannelCapacity ||
      storage.silenceSamples == nullptr || storage.silenceChannels == nullptr ||
      frames.value > storage.frameCapacity.value) return false;
  uint32_t lane = 0;
  for (uint32_t bus = 0; bus < graph.inputCount; ++bus) {
    const uint32_t firstLane = lane;
    for (uint32_t channel = 0; channel < graph.inputs[bus].channels; ++channel) {
      storage.silenceChannels[lane] = storage.silenceSamples +
          static_cast<size_t>(lane) * storage.frameCapacity.value;
      ++lane;
    }
    buses[bus] = {storage.silenceChannels + firstLane,
                  graph.inputs[bus].channels, frames,
                  storage.frameCapacity, nullptr};
  }
  return true;
}

uint32_t drainLatestParameters(ParameterQueue* queue, ParameterEvent* selected,
                               uint32_t capacity, FrameCount frames,
                               uint32_t available,
                               uint32_t* coalesced) noexcept {
  uint32_t ordinals[kMaximumEventsPerBlock]{};
  uint32_t count = 0;
  bool overloaded = false;
  uint32_t ordinal = 0;
  ParameterEvent event{};
  for (uint32_t queued = 0;
       queue != nullptr && queued < available && queue->pop(&event); ++queued) {
    const uint32_t eventOrdinal = ordinal++;
    const bool invalidOffset = frames.value == 0
        ? event.sampleOffset.value != 0
        : event.sampleOffset.value >= frames.value;
    const bool invalidValue = !std::isfinite(event.value) ||
        (event.curve != ParameterCurve::Step &&
         event.curve != ParameterCurve::Linear);
    if (invalidOffset || invalidValue) {
      if (*coalesced != UINT32_MAX) ++*coalesced;
      continue;
    }
    if (!overloaded && count < capacity) {
      selected[count] = event;
      ordinals[count++] = eventOrdinal;
      continue;
    }
    if (!overloaded) {
      overloaded = true;
      uint32_t compacted = 0;
      for (uint32_t index = 0; index < count; ++index) {
        uint32_t existing = UINT32_MAX;
        for (uint32_t prior = 0; prior < compacted; ++prior) {
          if (selected[prior].node.value == selected[index].node.value &&
              selected[prior].parameter.value ==
                  selected[index].parameter.value) {
            existing = prior;
            break;
          }
        }
        if (existing == UINT32_MAX) {
          selected[compacted] = selected[index];
          ordinals[compacted++] = ordinals[index];
        } else {
          selected[existing] = selected[index];
          ordinals[existing] = ordinals[index];
        }
      }
      if (count - compacted > *coalesced)
        *coalesced = count - compacted;
      count = compacted;
    }
    uint32_t replace = UINT32_MAX;
    for (uint32_t index = 0; index < count; ++index) {
      if (selected[index].node.value == event.node.value &&
          selected[index].parameter.value == event.parameter.value) {
        replace = index;
        break;
      }
    }
    if (replace != UINT32_MAX) {
      selected[replace] = event;
      ordinals[replace] = eventOrdinal;
    } else if (count < capacity) {
      selected[count] = event;
      ordinals[count++] = eventOrdinal;
    } else {
      uint32_t oldest = 0;
      for (uint32_t index = 1; index < count; ++index)
        if (ordinals[index] < ordinals[oldest]) oldest = index;
      selected[oldest] = event;
      ordinals[oldest] = eventOrdinal;
    }
    if (*coalesced != UINT32_MAX) ++*coalesced;
  }
  // Overload coalescing can replace an earlier event with a later offset.
  // Restore the processor contract's nondecreasing order deterministically.
  for (uint32_t index = 1; index < count; ++index) {
    const ParameterEvent value = selected[index];
    const uint32_t valueOrdinal = ordinals[index];
    uint32_t destination = index;
    while (destination != 0 &&
           (selected[destination - 1].sampleOffset.value >
                value.sampleOffset.value ||
            (selected[destination - 1].sampleOffset.value ==
                 value.sampleOffset.value &&
             ordinals[destination - 1] > valueOrdinal))) {
      selected[destination] = selected[destination - 1];
      ordinals[destination] = ordinals[destination - 1];
      --destination;
    }
    selected[destination] = value;
    ordinals[destination] = valueOrdinal;
  }
  return count;
}

uint32_t drainLatestMusicalEvents(MusicalEventQueue* queue,
                                  MusicalEvent* selected, uint32_t capacity,
                                  FrameCount frames,
                                  uint32_t available,
                                  uint32_t* discarded) noexcept {
  uint32_t count = 0;
  uint32_t ordinals[kMaximumEventsPerBlock]{};
  uint32_t ordinal = 0;
  MusicalEvent event{};
  for (uint32_t queued = 0;
       queue != nullptr && queued < available && queue->pop(&event); ++queued) {
    const uint32_t eventOrdinal = ordinal++;
    const bool invalidOffset = frames.value == 0
        ? event.sampleOffset.value != 0
        : event.sampleOffset.value >= frames.value;
    const bool invalidValue = !std::isfinite(event.value) ||
        event.channel > 15 || event.key > 127 ||
        event.kind > MusicalEventKind::AllNotesOff;
    if (invalidOffset || invalidValue) {
      if (*discarded != UINT32_MAX) ++*discarded;
      continue;
    }
    if (count < capacity) {
      selected[count] = event;
      ordinals[count++] = eventOrdinal;
    }
    else {
      uint32_t oldest = 0;
      for (uint32_t index = 1; index < count; ++index)
        if (ordinals[index] < ordinals[oldest]) oldest = index;
      selected[oldest] = event;
      ordinals[oldest] = eventOrdinal;
      if (*discarded != UINT32_MAX) ++*discarded;
    }
  }
  for (uint32_t index = 1; index < count; ++index) {
    const MusicalEvent value = selected[index];
    const uint32_t valueOrdinal = ordinals[index];
    uint32_t destination = index;
    while (destination != 0 &&
           (selected[destination - 1].sampleOffset.value >
                value.sampleOffset.value ||
            (selected[destination - 1].sampleOffset.value ==
                 value.sampleOffset.value &&
             ordinals[destination - 1] > valueOrdinal))) {
      selected[destination] = selected[destination - 1];
      ordinals[destination] = ordinals[destination - 1];
      --destination;
    }
    selected[destination] = value;
    ordinals[destination] = valueOrdinal;
  }
  return count;
}

void recordHistory(GraphRunner* runner, const MutableAudioBusView* outputs,
                   uint32_t outputCount) noexcept {
  GraphRunnerStorage& storage = runner->transitionStorage;
  if (outputCount == 0 || outputs == nullptr ||
      storage.outputHistorySamples == nullptr ||
      storage.historyCapacity.value == 0) return;
  uint32_t totalChannels = 0;
  for (uint32_t bus = 0; bus < outputCount; ++bus) {
    if (totalChannels > UINT32_MAX - outputs[bus].channelCount) return;
    totalChannels += outputs[bus].channelCount;
  }
  if (totalChannels > storage.channelCapacity) return;
  uint32_t cursor = runner->historyCursor;
  for (uint32_t frame = 0; frame < outputs[0].frames.value; ++frame) {
    uint32_t lane = 0;
    for (uint32_t bus = 0; bus < outputCount; ++bus) {
      for (uint32_t channel = 0; channel < outputs[bus].channelCount; ++channel) {
        storage.outputHistorySamples[
            static_cast<size_t>(lane) * storage.historyCapacity.value + cursor] =
            outputs[bus].channels[channel][frame];
        ++lane;
      }
    }
    if (++cursor == storage.historyCapacity.value) cursor = 0;
  }
  runner->historyCursor = cursor;
}

uint64_t offsetNanoseconds(uint32_t frames, SampleRateHz rate) noexcept {
  return static_cast<uint64_t>(std::llround(
      static_cast<double>(frames) * 1000000000.0 / rate.value));
}

ProcessContext segmentContext(const ProcessContext& source, uint32_t offset,
                              uint32_t frames, bool tailDrain,
                              ParameterEvent* parameters,
                              MusicalEvent* events,
                              TransportContext* transport) noexcept {
  ProcessContext segment = source;
  segment.frames = {frames};
  segment.time.graphFrame.value += offset;
  if ((segment.time.flags & RenderTimeHostValid) != 0)
    segment.time.renderHostTime.value += offsetNanoseconds(offset, source.sampleRate);
  if (offset != 0 || tailDrain) {
    segment.time.flags &= ~RenderTimeDiscontinuous;
    segment.discontinuity = {DiscontinuityReason::None,
                             DiscontinuityFlagNone};
  }
  if (tailDrain) {
    segment.structSize = kProcessContextV2RequiredSize;
    segment.flags = ProcessContextFlagTailDrain;
    segment.parameters = nullptr;
    segment.parameterCount = 0;
    segment.events = nullptr;
    segment.eventCount = 0;
    if (source.transport != nullptr) {
      *transport = *source.transport;
      transport->stateFlags &= ~(TransportStatePlaying |
                                 TransportStateRecording |
                                 TransportStateCycling);
      segment.transport = transport;
    }
    return segment;
  }
  uint32_t parameterCount = 0;
  for (uint32_t index = 0; index < source.parameterCount; ++index) {
    const ParameterEvent& event = source.parameters[index];
    if (event.sampleOffset.value < offset ||
        event.sampleOffset.value >= offset + frames) continue;
    parameters[parameterCount] = event;
    parameters[parameterCount++].sampleOffset.value -= offset;
  }
  segment.parameters = parameterCount == 0 ? nullptr : parameters;
  segment.parameterCount = parameterCount;
  uint32_t eventCount = 0;
  for (uint32_t index = 0; index < source.eventCount; ++index) {
    const MusicalEvent& event = source.events[index];
    if (event.sampleOffset.value < offset ||
        event.sampleOffset.value >= offset + frames) continue;
    events[eventCount] = event;
    events[eventCount++].sampleOffset.value -= offset;
  }
  segment.events = eventCount == 0 ? nullptr : events;
  segment.eventCount = eventCount;
  return segment;
}

void sliceInputs(const ConstAudioBusView* source, uint32_t inputCount,
                 uint32_t offset, uint32_t frames, SampleRateHz sampleRate,
                 ConstAudioBusView* sliced,
                 const float* channelPointers[kMaximumBusesPerProcessor]
                                             [kMaximumChannelsPerBus],
                 CaptureTime* captures) noexcept {
  for (uint32_t bus = 0; bus < inputCount; ++bus) {
    for (uint32_t channel = 0; channel < source[bus].channelCount; ++channel)
      channelPointers[bus][channel] = source[bus].channels[channel] + offset;
    const CaptureTime* capture = nullptr;
    if (source[bus].capture != nullptr) {
      captures[bus] = offsetCapture(*source[bus].capture, offset, sampleRate);
      capture = &captures[bus];
    }
    sliced[bus] = {channelPointers[bus], source[bus].channelCount, {frames},
                   {frames}, capture};
  }
}

void rejectClaimed(GraphRunner* runner,
                   PublishedGraphSnapshot* rejected) noexcept {
  if (rejected == nullptr) return;
  const uint32_t index = rejected->reservedRetirementSlot;
  if (index >= runner->publisher->retirementCapacity) return;
  RetirementSlot& slot = runner->publisher->retirementSlots[index];
  // The reservation is an ownership view, not yet a reclaimable retirement.
  // Publish it before claimedView can stop naming the snapshot.
  slot.snapshot.store(rejected, std::memory_order_release);
  if (runner->publisher->rejectionTestHook != nullptr)
    runner->publisher->rejectionTestHook(
        runner->publisher->rejectionTestContext,
        RejectionTransferStage::ClaimedOwnershipVisible);
  runner->publisher->claimedView.store(nullptr, std::memory_order_release);
  if (runner->publisher->rejectionTestHook != nullptr)
    runner->publisher->rejectionTestHook(
        runner->publisher->rejectionTestContext,
        RejectionTransferStage::ReservedOwnershipVisible);
  slot.retireAfterEpoch = runner->epoch.load(std::memory_order_relaxed);
  slot.state.store(static_cast<uint32_t>(RetirementSlotState::Waiting),
                   std::memory_order_release);
  if (runner->publisher->rejectionTestHook != nullptr)
    runner->publisher->rejectionTestHook(
        runner->publisher->rejectionTestContext,
        RejectionTransferStage::WaitingOwnershipVisible);
}

void adoptionStage(GraphRunner* runner, AdoptionTransferStage stage) noexcept {
  if (runner->publisher->adoptionTestHook != nullptr)
    runner->publisher->adoptionTestHook(
        runner->publisher->adoptionTestContext, stage);
}

void adoptClaimed(GraphRunner* runner, PublishedGraphSnapshot* next) noexcept {
  if (runner->fadingFrom != nullptr) return;
  if (next == nullptr) return;
  PublishedGraphSnapshot* previous = runner->active;
  runner->transitionFrame = 0;
  runner->tailFrame = 0;
  runner->oldPathEnvelope = 1.0f;
  if (previous == nullptr) {
    runner->active = next;
    runner->publisher->activeView.store(next, std::memory_order_release);
    runner->oldAlignmentCursor = 0;
    runner->newAlignmentCursor = 0;
    releaseReservation(runner->publisher, next);
    return;
  }
  const uint32_t index = next->reservedRetirementSlot;
  RetirementSlot& slot = runner->publisher->retirementSlots[index];
  if (next->transition.kind == TransitionKind::Crossfade) {
    primeAlignment(runner, *next);
    runner->fadingFrom = previous;
    runner->publisher->fadingView.store(previous, std::memory_order_release);
    slot.snapshot.store(previous, std::memory_order_release);
  } else {
    runner->publisher->fadingView.store(nullptr, std::memory_order_release);
    // The reserved slot is ownership, but not reclaimable, before activeView
    // stops naming the old graph.
    slot.snapshot.store(previous, std::memory_order_release);
  }
  adoptionStage(runner, AdoptionTransferStage::OldOwnershipPublished);
  runner->active = next;
  runner->publisher->activeView.store(next, std::memory_order_release);
  adoptionStage(runner, AdoptionTransferStage::ReplacementActivePublished);
  if (next->transition.kind == TransitionKind::HardCut) {
    markRetirementReady(runner, previous);
    adoptionStage(runner, AdoptionTransferStage::OldRetirementReady);
  }
}

void clearTransitionHistory(GraphRunner* runner) noexcept {
  GraphRunnerStorage& storage = runner->transitionStorage;
  if (storage.outputHistorySamples != nullptr &&
      sampleStorageOffsetsFit(storage.channelCapacity,
                              storage.historyCapacity.value)) {
    const uint64_t count = static_cast<uint64_t>(storage.channelCapacity) *
                           storage.historyCapacity.value;
    for (uint64_t sample = 0; sample < count; ++sample)
      storage.outputHistorySamples[sample] = 0.0f;
  }
  if (storage.oldAlignmentSamples != nullptr &&
      sampleStorageOffsetsFit(storage.channelCapacity,
                              storage.alignmentCapacity.value)) {
    const uint64_t count = static_cast<uint64_t>(storage.channelCapacity) *
                           storage.alignmentCapacity.value;
    for (uint64_t sample = 0; sample < count; ++sample)
      storage.oldAlignmentSamples[sample] = 0.0f;
  }
  if (storage.newAlignmentSamples != nullptr &&
      sampleStorageOffsetsFit(storage.channelCapacity,
                              storage.alignmentCapacity.value)) {
    const uint64_t count = static_cast<uint64_t>(storage.channelCapacity) *
                           storage.alignmentCapacity.value;
    for (uint64_t sample = 0; sample < count; ++sample)
      storage.newAlignmentSamples[sample] = 0.0f;
  }
  runner->historyCursor = 0;
  runner->oldAlignmentCursor = 0;
  runner->newAlignmentCursor = 0;
}

void cancelTransitionForDiscontinuity(GraphRunner* runner) noexcept {
  if (runner->fadingFrom != nullptr) {
    PublishedGraphSnapshot* retired = runner->fadingFrom;
    runner->fadingFrom = nullptr;
    runner->publisher->fadingView.store(nullptr, std::memory_order_release);
    markRetirementReady(runner, retired);
  }
  runner->transitionFrame = 0;
  runner->tailFrame = 0;
  runner->oldPathEnvelope = 0.0f;
  clearTransitionHistory(runner);
}

}  // namespace

Status processCompiledGraph(CompiledGraph* graph, const ProcessContext& context,
                            const ConstAudioBusView* inputs, uint32_t inputCount,
                            const MutableAudioBusView* outputs, uint32_t outputCount,
                            RuntimeDiagnostics* diagnostics) noexcept {
  const Status validBlock = validateGraphBlock(
      graph, context, inputs, inputCount, outputs, outputCount);
  if (!succeeded(validBlock)) return validBlock;
  uint32_t invalidSamples = 0;
  if ((context.discontinuity.flags & DiscontinuityFlagResetState) != 0) {
    for (uint32_t index = 0; index < graph->nodeCount; ++index) {
      RuntimeNode& node = graph->nodes[index];
      if (node.role == GraphNodeRole::Processor)
        node.processor.functions->reset(node.processor.state, context.discontinuity);
    }
    for (uint32_t delay = 0; delay < graph->delayCount; ++delay) {
      RuntimeDelay& state = graph->delays[delay];
      state.cursor = 0;
      const uint64_t count = static_cast<uint64_t>(state.channels) * state.frames;
      for (uint64_t sample = 0; sample < count; ++sample) state.samples[sample] = 0.0f;
      resetCaptureDelay(&state.capture);
    }
    for (uint32_t delay = 0; delay < graph->captureDelayCount; ++delay)
      resetCaptureDelay(&graph->captureDelays[delay]);
  }
  for (uint32_t bus = 0; bus < inputCount; ++bus) {
    RuntimeBuffer& destination = graph->buffers[graph->inputs[bus].buffer];
    destination.capture = inputs[bus].capture;
    for (uint32_t channel = 0; channel < destination.channelCount; ++channel)
      for (uint32_t frame = 0; frame < context.frames.value; ++frame)
        destination.channels[channel][frame] =
            contained(inputs[bus].channels[channel][frame], &invalidSamples);
  }
  for (uint32_t index = 0; index < graph->nodeCount; ++index) {
    RuntimeNode& node = graph->nodes[index];
    for (uint32_t bus = 0; bus < node.inputCount; ++bus)
      runDelay(node.inputs[bus].delay, context.frames, graph->buffers,
               &invalidSamples, context.sampleRate);
    if (node.role != GraphNodeRole::Processor) continue;
    const CaptureTime* capture = node.inputCount == 1
        ? graph->buffers[node.inputs[0].buffer].capture : nullptr;
    if ((node.flags & GraphNodeFlagBypassed) == 0 &&
        node.captureDelay != nullptr)
      capture = advanceCaptureDelay(node.captureDelay, capture, context.frames,
                                    context.sampleRate);
    for (uint32_t bus = 0; bus < node.outputCount; ++bus)
      graph->buffers[node.outputs[bus].buffer].capture = capture;
    if ((node.flags & GraphNodeFlagBypassed) != 0) {
      if (node.bypassDelay != nullptr) {
        runDelay(node.bypassDelay, context.frames, graph->buffers,
                 &invalidSamples, context.sampleRate);
      } else {
        RuntimeBuffer& source = graph->buffers[node.inputs[0].buffer];
        RuntimeBuffer& destination = graph->buffers[node.outputs[0].buffer];
        for (uint32_t channel = 0; channel < node.outputs[0].channels; ++channel)
          for (uint32_t frame = 0; frame < context.frames.value; ++frame)
            destination.channels[channel][frame] = contained(
                source.channels[channel][frame], &invalidSamples);
      }
      continue;
    }
    ConstAudioBusView inputViews[kMaximumBusesPerProcessor]{};
    MutableAudioBusView outputViews[kMaximumBusesPerProcessor]{};
    for (uint32_t bus = 0; bus < node.inputCount; ++bus) {
      RuntimeBuffer& buffer = graph->buffers[node.inputs[bus].buffer];
      inputViews[bus] = {const_cast<const float* const*>(buffer.channels),
          node.inputs[bus].channels, context.frames, graph->maximumBlockFrames,
          buffer.capture};
    }
    for (uint32_t bus = 0; bus < node.outputCount; ++bus) {
      RuntimeBuffer& buffer = graph->buffers[node.outputs[bus].buffer];
      outputViews[bus] = {buffer.channels, node.outputs[bus].channels,
                          context.frames, graph->maximumBlockFrames};
    }
    node.processor.functions->process(node.processor.state, &context,
        inputViews, node.inputCount, outputViews, node.outputCount);
    if (node.processor.functions->structSize >=
            kProcessorVTableV2RequiredSize &&
        node.processor.functions->consumeNonFinite != nullptr) {
      const uint32_t containedByProcessor =
          node.processor.functions->consumeNonFinite(node.processor.state);
      invalidSamples = containedByProcessor > UINT32_MAX - invalidSamples
          ? UINT32_MAX : invalidSamples + containedByProcessor;
    }
    for (uint32_t bus = 0; bus < node.outputCount; ++bus) {
      for (uint32_t channel = 0; channel < outputViews[bus].channelCount; ++channel)
        for (uint32_t frame = 0; frame < context.frames.value; ++frame)
          outputViews[bus].channels[channel][frame] = contained(
              outputViews[bus].channels[channel][frame], &invalidSamples);
    }
  }
  for (uint32_t bus = 0; bus < outputCount; ++bus) {
    RuntimeBuffer& source = graph->buffers[graph->outputs[bus].buffer];
    for (uint32_t channel = 0; channel < source.channelCount; ++channel)
      for (uint32_t frame = 0; frame < context.frames.value; ++frame)
        outputs[bus].channels[channel][frame] =
            contained(source.channels[channel][frame], &invalidSamples);
  }
  if (invalidSamples != 0 && diagnostics != nullptr)
    diagnostics->nonFiniteSamples.fetch_add(invalidSamples,
                                             std::memory_order_relaxed);
  return okStatus();
}

void initializePublisher(SnapshotPublisher* publisher, RetirementSlot* slots,
                         uint32_t count, RuntimeDiagnostics* diagnostics) noexcept {
  if (publisher == nullptr) return;
  publisher->publicationState.store(0, std::memory_order_relaxed);
  publisher->pending.store(nullptr, std::memory_order_relaxed);
  publisher->claimedView.store(nullptr, std::memory_order_relaxed);
  publisher->deferred = nullptr;
  publisher->activeView.store(nullptr, std::memory_order_relaxed);
  publisher->fadingView.store(nullptr, std::memory_order_relaxed);
  publisher->retirementSlots = count == 0 ? nullptr : slots;
  publisher->retirementCapacity = slots == nullptr ? 0 : count;
  publisher->diagnostics = diagnostics;
  publisher->adoptionTestHook = nullptr;
  publisher->adoptionTestContext = nullptr;
  publisher->rejectionTestHook = nullptr;
  publisher->rejectionTestContext = nullptr;
  for (uint32_t index = 0; index < publisher->retirementCapacity; ++index) {
    slots[index].snapshot.store(nullptr, std::memory_order_relaxed);
    slots[index].retireAfterEpoch = 0;
    slots[index].state.store(static_cast<uint32_t>(RetirementSlotState::Free),
                             std::memory_order_relaxed);
  }
}

void setAdoptionTransferTestHook(SnapshotPublisher* publisher,
                                 AdoptionTransferTestHook hook,
                                 void* context) noexcept {
  if (publisher == nullptr) return;
  publisher->adoptionTestHook = hook;
  publisher->adoptionTestContext = context;
}

void setRejectionTransferTestHook(SnapshotPublisher* publisher,
                                  RejectionTransferTestHook hook,
                                  void* context) noexcept {
  if (publisher == nullptr) return;
  publisher->rejectionTestHook = hook;
  publisher->rejectionTestContext = context;
}

Status prepareTransition(const CompiledGraph* replaced, CompiledGraph* replacement,
                         const TransitionRequest& request,
                         TransitionPlan* plan) noexcept {
  if (replaced == nullptr || replacement == nullptr || plan == nullptr ||
      replaced == replacement ||
      request.infiniteTailPolicy > InfiniteTailPolicy::Cut)
    return {StatusCode::InvalidArgument, 1};
  if (!transitionTopologyCompatible(*replaced, *replacement))
    return {StatusCode::UnsupportedFormat, 2};
  const uint32_t outputChannels = graphOutputChannels(*replacement);
  const uint32_t tailInputChannels = graphInputChannels(*replaced);
  if (outputChannels == UINT32_MAX || tailInputChannels == UINT32_MAX)
    return {StatusCode::CapacityExceeded, 5};
  const LatencyFrames oldLatency = compiledGraphLatency(*replaced);
  const LatencyFrames newLatency = compiledGraphLatency(*replacement);
  const TailInfo replacedTail = compiledGraphTail(*replaced);
  const uint32_t oldAlignment = request.kind == TransitionKind::Crossfade &&
      oldLatency.value < newLatency.value
      ? newLatency.value - oldLatency.value : 0;
  const uint32_t newAlignment = request.kind == TransitionKind::Crossfade &&
      newLatency.value < oldLatency.value
      ? oldLatency.value - newLatency.value : 0;
  FrameLength spill{0};
  if (request.kind == TransitionKind::Crossfade) {
    if (replacedTail.kind != TailKind::Infinite) {
      if (replacedTail.frames.value > UINT64_MAX - oldAlignment)
        return {StatusCode::CapacityExceeded, 4};
      spill = {replacedTail.frames.value + oldAlignment};
    }
    else if (replacedTail.kind == TailKind::Infinite &&
             request.infiniteTailPolicy == InfiniteTailPolicy::Fade)
      spill = request.tailSpillFrames;
  }
  TransitionPlan prepared{request.kind, request.crossfadeFrames,
      {oldAlignment}, {newAlignment},
      request.infiniteTailPolicy, replacedTail, spill,
      request.oldCpuPermille, request.newCpuPermille,
      request.combinedCpuLimitPermille, 0, replaced, replacement,
      request.expectedOldGeneration, request.replacementGeneration,
      replacement->outputCount, outputChannels, tailInputChannels};
  PublishedGraphSnapshot validation{
      replacement, request.replacementGeneration, prepared, 0};
  if (request.kind == TransitionKind::Crossfade &&
      replacedTail.kind != TailKind::Infinite &&
      request.tailSpillFrames.value < spill.value)
    return {StatusCode::InsufficientStorage, 3};
  if (request.expectedOldGeneration == 0 || request.replacementGeneration == 0 ||
      !transitionValid(validation)) return {StatusCode::InvalidArgument, 2};
  if (request.stateTransfer != nullptr) {
    const Status transferred = request.stateTransfer(
        replaced, replacement, request.stateTransferContext);
    if (!succeeded(transferred)) return transferred;
    prepared.stateTransferred = 1;
  }
  *plan = prepared;
  return okStatus();
}

PublicationResult submitSnapshotLocked(SnapshotPublisher* publisher,
                                       PublishedGraphSnapshot* snapshot) noexcept {
  if (publisher == nullptr || snapshot == nullptr || snapshot->graph == nullptr ||
      !transitionValid(*snapshot)) {
    if (publisher != nullptr && publisher->diagnostics != nullptr)
      publisher->diagnostics->transitionRejections.fetch_add(1, std::memory_order_relaxed);
    return {{StatusCode::InvalidArgument, 1}, nullptr, 0};
  }
  auto aliases = [snapshot](PublishedGraphSnapshot* present) noexcept {
    return present != nullptr &&
        (present == snapshot || present->graph == snapshot->graph);
  };
  // claimedView is loaded first. If it observes a callback's release-to-null,
  // the later ownership views/slot state are ordered after that handoff.
  if (aliases(publisher->claimedView.load(std::memory_order_acquire)) ||
      aliases(publisher->pending.load(std::memory_order_acquire)) ||
      aliases(publisher->deferred) ||
      aliases(publisher->activeView.load(std::memory_order_acquire)) ||
      aliases(publisher->fadingView.load(std::memory_order_acquire))) {
    if (publisher->diagnostics != nullptr)
      publisher->diagnostics->transitionRejections.fetch_add(
          1, std::memory_order_relaxed);
    return {{StatusCode::InvalidArgument, 2}, nullptr, 0};
  }
  for (uint32_t index = 0; index < publisher->retirementCapacity; ++index) {
    RetirementSlot& slot = publisher->retirementSlots[index];
    if (slot.state.load(std::memory_order_acquire) !=
            static_cast<uint32_t>(RetirementSlotState::Free) &&
        aliases(slot.snapshot.load(std::memory_order_acquire))) {
      if (publisher->diagnostics != nullptr)
        publisher->diagnostics->transitionRejections.fetch_add(
            1, std::memory_order_relaxed);
      return {{StatusCode::InvalidArgument, 3}, nullptr, 0};
    }
  }
  PublishedGraphSnapshot* supersededDeferred = publisher->deferred;
  publisher->deferred = nullptr;

  // An update that has not reached a callback owns a reservation already.
  // Replace it in that same immutable pending slot instead of consuming
  // another retirement entry.
  PublishedGraphSnapshot* pending =
      publisher->pending.load(std::memory_order_acquire);
  while (pending != nullptr) {
    snapshot->reservedRetirementSlot = pending->reservedRetirementSlot;
    if (publisher->pending.compare_exchange_weak(
            pending, snapshot, std::memory_order_acq_rel,
            std::memory_order_acquire)) {
      publisher->retirementSlots[snapshot->reservedRetirementSlot].snapshot.store(
          snapshot, std::memory_order_release);
      return {okStatus(), pending, 0};
    }
  }
  uint32_t slot = UINT32_MAX;
  if (!reserveSlot(publisher, &slot)) {
    publisher->deferred = snapshot;
    if (publisher->diagnostics != nullptr) {
      publisher->diagnostics->publicationDeferrals.fetch_add(1, std::memory_order_relaxed);
      publisher->diagnostics->retirementSaturations.fetch_add(1, std::memory_order_relaxed);
    }
    return {okStatus(), supersededDeferred, 1};
  }
  snapshot->reservedRetirementSlot = slot;
  publisher->retirementSlots[slot].snapshot.store(snapshot,
                                                   std::memory_order_release);
  PublishedGraphSnapshot* supersededPending =
      publisher->pending.exchange(snapshot, std::memory_order_acq_rel);
  if (supersededPending != nullptr) {
    releaseReservation(publisher, supersededPending);
    return {okStatus(), supersededPending, 0};
  }
  return {okStatus(), supersededDeferred, 0};
}

PublicationResult submitSnapshot(SnapshotPublisher* publisher,
                                 PublishedGraphSnapshot* snapshot) noexcept {
  if (publisher == nullptr)
    return {{StatusCode::InvalidArgument, 1}, nullptr, 0};
  uint32_t expected = 0;
  while (!publisher->publicationState.compare_exchange_weak(
      expected, 1, std::memory_order_acq_rel, std::memory_order_acquire)) {
    if (expected == 3)
      return {{StatusCode::Busy, 3}, nullptr, 0};
    expected = 0;
  }
  const PublicationResult result = submitSnapshotLocked(publisher, snapshot);
  publisher->publicationState.store(0, std::memory_order_release);
  return result;
}

PublicationResult serviceDeferredSnapshot(SnapshotPublisher* publisher) noexcept {
  if (publisher == nullptr) return {{StatusCode::InvalidArgument, 1}, nullptr, 0};
  PublishedGraphSnapshot* snapshot = publisher->deferred;
  if (snapshot == nullptr) return {okStatus(), nullptr, 0};
  publisher->deferred = nullptr;
  PublicationResult result = submitSnapshot(publisher, snapshot);
  if (result.deferred != 0 && publisher->deferred != snapshot) {
    result.superseded = publisher->deferred;
    publisher->deferred = snapshot;
  }
  return result;
}

uint32_t reclaimSnapshots(SnapshotPublisher* publisher, uint32_t acknowledged,
                          PublishedGraphSnapshot** reclaimed,
                          uint32_t capacity) noexcept {
  if (publisher == nullptr || (capacity != 0 && reclaimed == nullptr)) return 0;
  uint32_t count = 0;
  for (uint32_t index = 0; index < publisher->retirementCapacity && count < capacity; ++index) {
    RetirementSlot& slot = publisher->retirementSlots[index];
    if (slot.state.load(std::memory_order_acquire) ==
            static_cast<uint32_t>(RetirementSlotState::Waiting) &&
        static_cast<int32_t>(acknowledged - slot.retireAfterEpoch) >= 0) {
      reclaimed[count++] = slot.snapshot.load(std::memory_order_acquire);
      slot.snapshot.store(nullptr, std::memory_order_relaxed);
      slot.retireAfterEpoch = 0;
      slot.state.store(static_cast<uint32_t>(RetirementSlotState::Free),
                       std::memory_order_release);
    }
  }
  return count;
}

void initializeGraphRunner(GraphRunner* runner, SnapshotPublisher* publisher,
                           GraphRunnerStorage storage, ParameterQueue* parameters,
                           MusicalEventQueue* events,
                           RuntimeDiagnostics* diagnostics) noexcept {
  if (runner == nullptr) return;
  runner->publisher = publisher;
  runner->active = nullptr;
  runner->fadingFrom = nullptr;
  runner->transitionStorage = storage;
  runner->parameterQueue = parameters;
  runner->musicalEventQueue = events;
  runner->diagnostics = diagnostics;
  runner->epoch.store(0, std::memory_order_relaxed);
  runner->renderState.store(0, std::memory_order_relaxed);
  runner->transitionFrame = 0;
  runner->tailFrame = 0;
  runner->oldPathEnvelope = 0.0f;
  runner->oldAlignmentCursor = 0;
  runner->newAlignmentCursor = 0;
  runner->historyCursor = 0;
  if (storage.outputHistorySamples != nullptr &&
      sampleStorageOffsetsFit(storage.channelCapacity,
                              storage.historyCapacity.value)) {
    const uint64_t count = static_cast<uint64_t>(storage.channelCapacity) *
                           storage.historyCapacity.value;
    for (uint64_t sample = 0; sample < count; ++sample)
      storage.outputHistorySamples[sample] = 0.0f;
  }
  if (storage.silenceSamples != nullptr &&
      sampleStorageOffsetsFit(storage.silenceChannelCapacity,
                              storage.frameCapacity.value)) {
    const uint64_t count = static_cast<uint64_t>(storage.silenceChannelCapacity) *
                           storage.frameCapacity.value;
    for (uint64_t sample = 0; sample < count; ++sample)
      storage.silenceSamples[sample] = 0.0f;
  }
}

Status renderGraphBlockImpl(GraphRunner* runner, ProcessContext context,
                            const ConstAudioBusView* inputs, uint32_t inputCount,
                            const MutableAudioBusView* outputs,
                            uint32_t outputCount) noexcept {
  if (runner == nullptr || runner->publisher == nullptr)
    return {StatusCode::InvalidArgument, 1};
  const Status validContext = validateProcessContext(context);
  if (!succeeded(validContext)) {
    if (runner->diagnostics != nullptr)
      runner->diagnostics->rejectedBlocks.fetch_add(1, std::memory_order_relaxed);
    return validContext;
  }
  // Claim exactly one immutable publication before inspecting it. A control
  // producer may supersede an unclaimed pointer at any time, so a mere load
  // can never authorize dereference on the render domain.
  PublishedGraphSnapshot* claimed = nullptr;
  if (runner->fadingFrom == nullptr) {
    uint32_t expected = 0;
    if (runner->publisher->publicationState.compare_exchange_strong(
            expected, 2, std::memory_order_acq_rel,
            std::memory_order_acquire)) {
      claimed = runner->publisher->pending.exchange(
          nullptr, std::memory_order_acq_rel);
      runner->publisher->claimedView.store(claimed, std::memory_order_release);
      runner->publisher->publicationState.store(0, std::memory_order_release);
    }
  }
  auto releaseClaimedView = [runner]() noexcept {
    runner->publisher->claimedView.store(nullptr, std::memory_order_release);
  };
  if (claimed != nullptr) {
    Status compatibility = validateGraphBlock(
        claimed->graph, context, inputs, inputCount, outputs, outputCount);
    if (succeeded(compatibility) && runner->active != nullptr) {
      compatibility = validateGraphBlock(runner->active->graph, context,
          inputs, inputCount, outputs, outputCount);
      if (succeeded(compatibility) &&
          !transitionIdentityMatches(*runner->active, *claimed))
        compatibility = {StatusCode::InvalidArgument, 41};
      if (succeeded(compatibility) &&
          !transitionTopologyCompatible(*runner->active->graph, *claimed->graph))
        compatibility = {StatusCode::UnsupportedFormat, 40};
    }
    if (!succeeded(compatibility)) {
      rejectClaimed(runner, claimed);
      if (runner->diagnostics != nullptr)
        runner->diagnostics->transitionRejections.fetch_add(
            1, std::memory_order_relaxed);
      return compatibility;
    }
  }
  if (claimed == nullptr && runner->active != nullptr) {
    const Status activeValid = validateGraphBlock(runner->active->graph, context,
        inputs, inputCount, outputs, outputCount);
    if (!succeeded(activeValid)) return activeValid;
  }
  if ((context.discontinuity.flags & DiscontinuityFlagResetState) != 0) {
    if (claimed != nullptr &&
        claimed->transition.kind == TransitionKind::Crossfade) {
      rejectClaimed(runner, claimed);
      claimed = nullptr;
      if (runner->diagnostics != nullptr)
        runner->diagnostics->transitionRejections.fetch_add(
            1, std::memory_order_relaxed);
    }
    cancelTransitionForDiscontinuity(runner);
  }
  if (runner->fadingFrom != nullptr) {
    Status preflight = validateGraphBlock(runner->fadingFrom->graph, context,
        inputs, inputCount, outputs, outputCount);
    if (succeeded(preflight)) preflight = validateTransitionStorage(
        *runner, *runner->active, *runner->fadingFrom, context, outputs,
        outputCount);
    if (!succeeded(preflight)) return preflight;
  } else if (runner->active != nullptr && claimed != nullptr &&
             claimed->transition.kind == TransitionKind::Crossfade) {
    const Status preflight = validateTransitionStorage(
        *runner, *claimed, *runner->active, context, outputs, outputCount);
    if (!succeeded(preflight)) {
      rejectClaimed(runner, claimed);
      if (runner->diagnostics != nullptr)
        runner->diagnostics->transitionRejections.fetch_add(
            1, std::memory_order_relaxed);
      return preflight;
    }
  }
  // Until either the existing graph or this exact claimed snapshot has passed
  // every preflight, queues remain control-owned and completely untouched.
  if (runner->active == nullptr && claimed == nullptr)
    return {StatusCode::InvalidArgument, 2};

  ParameterEvent drainedParameters[kMaximumEventsPerBlock]{};
  MusicalEvent drainedEvents[kMaximumEventsPerBlock]{};
  const bool tailDrain =
      (processContextFlags(context) & ProcessContextFlagTailDrain) != 0;
  const uint32_t parameterAvailable =
      !tailDrain && context.parameterCount == 0 && runner->parameterQueue != nullptr
          ? runner->parameterQueue->snapshotAvailable() : 0;
  const uint32_t musicalAvailable =
      !tailDrain && context.eventCount == 0 && runner->musicalEventQueue != nullptr
          ? runner->musicalEventQueue->snapshotAvailable() : 0;
  if (parameterAvailable != 0) {
    uint32_t coalesced = 0;
    context.parameterCount = drainLatestParameters(
        runner->parameterQueue, drainedParameters, kMaximumEventsPerBlock,
        context.frames, parameterAvailable,
        &coalesced);
    context.parameters = drainedParameters;
    if (coalesced != 0 && runner->diagnostics != nullptr)
      runner->diagnostics->parameterOverflows.fetch_add(
          coalesced, std::memory_order_relaxed);
  }
  if (musicalAvailable != 0) {
    uint32_t discardedCount = 0;
    context.eventCount = drainLatestMusicalEvents(
        runner->musicalEventQueue, drainedEvents, kMaximumEventsPerBlock,
        context.frames, musicalAvailable, &discardedCount);
    context.events = drainedEvents;
    if (discardedCount != 0 && runner->diagnostics != nullptr)
      runner->diagnostics->musicalEventOverflows.fetch_add(
          discardedCount, std::memory_order_relaxed);
  }
  // enqueueParameter/enqueueMusicalEvent validate producer input, and the
  // bounded drains above defensively discard malformed raw queue entries.
  // Sorting is completed before publication to processors, so no fallible
  // validation or graph mutation remains between consuming and adoption.
  adoptClaimed(runner, claimed);
  if (claimed != nullptr) releaseClaimedView();
  if (runner->active == nullptr) return {StatusCode::InvalidArgument, 2};
  Status rendered = processCompiledGraph(runner->active->graph, context,
      inputs, inputCount, outputs, outputCount, runner->diagnostics);
  if (!succeeded(rendered)) return rendered;

  if (runner->fadingFrom != nullptr) {
    const TransitionPlan& transition = runner->active->transition;
    GraphRunnerStorage& storage = runner->transitionStorage;
    const uint32_t totalOutputChannels =
        graphOutputChannels(*runner->active->graph);
    if (outputs == nullptr || outputCount == 0 ||
        totalOutputChannels == UINT32_MAX ||
        totalOutputChannels > storage.channelCapacity ||
        context.frames.value > storage.frameCapacity.value ||
        transition.oldAlignmentDelay.value > storage.alignmentCapacity.value ||
        transition.newAlignmentDelay.value > storage.alignmentCapacity.value ||
        storage.oldOutputSamples == nullptr || storage.oldOutputChannels == nullptr)
      return {StatusCode::InsufficientStorage, 3};
    MutableAudioBusView oldOutputs[kMaximumBusesPerProcessor]{};
    if (!buildTransitionOutputViews(&storage, outputs, outputCount,
                                    context.frames, oldOutputs))
      return {StatusCode::InsufficientStorage, 3};
    for (uint32_t channel = 0; channel < totalOutputChannels; ++channel)
      for (uint32_t frame = 0; frame < context.frames.value; ++frame)
        storage.oldOutputChannels[channel][frame] = 0.0f;

    const uint64_t crossfadeRemaining =
        runner->transitionFrame < transition.crossfadeFrames.value
            ? transition.crossfadeFrames.value - runner->transitionFrame : 0;
    const uint32_t liveFrames = crossfadeRemaining < context.frames.value
        ? static_cast<uint32_t>(crossfadeRemaining) : context.frames.value;
    if (liveFrames != 0) {
      ConstAudioBusView liveInputs[kMaximumBusesPerProcessor]{};
      const float* liveChannels[kMaximumBusesPerProcessor]
                               [kMaximumChannelsPerBus]{};
      CaptureTime liveCaptures[kMaximumBusesPerProcessor]{};
      if (inputCount != 0)
        sliceInputs(inputs, inputCount, 0, liveFrames, context.sampleRate,
                    liveInputs, liveChannels, liveCaptures);
      MutableAudioBusView liveOutputs[kMaximumBusesPerProcessor]{};
      for (uint32_t bus = 0; bus < outputCount; ++bus) {
        liveOutputs[bus] = oldOutputs[bus];
        liveOutputs[bus].frames = {liveFrames};
      }
      ParameterEvent liveParameters[kMaximumEventsPerBlock]{};
      MusicalEvent liveEvents[kMaximumEventsPerBlock]{};
      TransportContext liveTransport{};
      ProcessContext liveContext = segmentContext(
          context, 0, liveFrames, false, liveParameters, liveEvents,
          &liveTransport);
      rendered = processCompiledGraph(runner->fadingFrom->graph, liveContext,
          inputCount == 0 ? nullptr : liveInputs, inputCount,
          liveOutputs, outputCount,
          runner->diagnostics);
      if (!succeeded(rendered)) return rendered;
    }

    const uint32_t afterCrossfade = context.frames.value - liveFrames;
    const uint64_t spillRemaining =
        runner->tailFrame < transition.tailSpillFrames.value
            ? transition.tailSpillFrames.value - runner->tailFrame : 0;
    const uint32_t tailFrames = spillRemaining < afterCrossfade
        ? static_cast<uint32_t>(spillRemaining) : afterCrossfade;
    if (tailFrames != 0) {
      ConstAudioBusView silentInputs[kMaximumBusesPerProcessor]{};
      if (!buildSilentInputs(runner, *runner->fadingFrom->graph,
                             {tailFrames}, silentInputs))
        return {StatusCode::InsufficientStorage, 4};
      for (uint32_t channel = 0; channel < totalOutputChannels; ++channel)
        storage.oldOutputChannels[channel] += liveFrames;
      MutableAudioBusView tailOutputs[kMaximumBusesPerProcessor]{};
      for (uint32_t bus = 0; bus < outputCount; ++bus) {
        tailOutputs[bus] = oldOutputs[bus];
        tailOutputs[bus].frames = {tailFrames};
        tailOutputs[bus].capacityFrames = {
            storage.frameCapacity.value - liveFrames};
      }
      ParameterEvent tailParameters[kMaximumEventsPerBlock]{};
      MusicalEvent tailEvents[kMaximumEventsPerBlock]{};
      TransportContext tailTransport{};
      ProcessContext tailContext = segmentContext(
          context, liveFrames, tailFrames, true, tailParameters, tailEvents,
          &tailTransport);
      rendered = processCompiledGraph(runner->fadingFrom->graph, tailContext,
          runner->fadingFrom->graph->inputCount == 0 ? nullptr : silentInputs,
          runner->fadingFrom->graph->inputCount, tailOutputs, outputCount,
          runner->diagnostics);
      for (uint32_t channel = 0; channel < totalOutputChannels; ++channel)
        storage.oldOutputChannels[channel] -= liveFrames;
      if (!succeeded(rendered)) return rendered;
    }
    alignOutputBuses(oldOutputs, outputCount, storage.oldAlignmentSamples,
                     transition.oldAlignmentDelay.value,
                     &runner->oldAlignmentCursor);
    alignOutputBuses(outputs, outputCount, storage.newAlignmentSamples,
                     transition.newAlignmentDelay.value,
                     &runner->newAlignmentCursor);
    const uint64_t total = transition.crossfadeFrames.value;
    for (uint32_t frame = 0; frame < liveFrames; ++frame) {
      const uint64_t absolute = runner->transitionFrame + frame;
      const float alpha = static_cast<float>(absolute + 1) /
                          static_cast<float>(total);
      const float oldGain = 1.0f - alpha;
      runner->oldPathEnvelope = oldGain;
      for (uint32_t bus = 0; bus < outputCount; ++bus) {
        for (uint32_t channel = 0; channel < outputs[bus].channelCount;
             ++channel) {
          outputs[bus].channels[channel][frame] =
              oldOutputs[bus].channels[channel][frame] * oldGain +
              outputs[bus].channels[channel][frame] * alpha;
        }
      }
    }
    for (uint32_t tail = 0; tail < tailFrames; ++tail) {
      float gain = runner->oldPathEnvelope;
      if (transition.replacedTail.kind == TailKind::Infinite &&
          transition.infiniteTailPolicy == InfiniteTailPolicy::Fade) {
        const uint64_t absolute = runner->tailFrame + tail;
        float policyGain = 1.0f - static_cast<float>(absolute + 1) /
            static_cast<float>(transition.tailSpillFrames.value);
        if (policyGain < 0.0f) policyGain = 0.0f;
        if (policyGain < gain) gain = policyGain;
      }
      runner->oldPathEnvelope = gain;
      const uint32_t frame = liveFrames + tail;
      for (uint32_t bus = 0; bus < outputCount; ++bus)
        for (uint32_t channel = 0; channel < outputs[bus].channelCount;
             ++channel)
          outputs[bus].channels[channel][frame] +=
              oldOutputs[bus].channels[channel][frame] * gain;
    }
    runner->transitionFrame += liveFrames;
    runner->tailFrame += tailFrames;
  }
  const uint32_t epoch = runner->epoch.fetch_add(1, std::memory_order_release) + 1;
  if (runner->fadingFrom != nullptr &&
      runner->transitionFrame >= runner->active->transition.crossfadeFrames.value &&
      runner->tailFrame >= runner->active->transition.tailSpillFrames.value) {
    PublishedGraphSnapshot* retired = runner->fadingFrom;
    runner->fadingFrom = nullptr;
    runner->oldPathEnvelope = 0.0f;
    runner->publisher->fadingView.store(nullptr, std::memory_order_release);
    RetirementSlot& slot = runner->publisher->retirementSlots[
        runner->active->reservedRetirementSlot];
    slot.snapshot.store(retired, std::memory_order_relaxed);
    slot.retireAfterEpoch = epoch;
    slot.state.store(static_cast<uint32_t>(RetirementSlotState::Waiting),
                     std::memory_order_release);
  }
  recordHistory(runner, outputs, outputCount);
  return okStatus();
}

Status renderGraphBlock(GraphRunner* runner, ProcessContext context,
                        const ConstAudioBusView* inputs, uint32_t inputCount,
                        const MutableAudioBusView* outputs,
                        uint32_t outputCount) noexcept {
  if (runner == nullptr) return {StatusCode::InvalidArgument, 1};
  uint32_t expected = 0;
  if (!runner->renderState.compare_exchange_strong(
          expected, 1, std::memory_order_acq_rel, std::memory_order_acquire))
    return {StatusCode::Busy, expected};
  gInGraphRenderCallback = true;
  const Status status = renderGraphBlockImpl(
      runner, context, inputs, inputCount, outputs, outputCount);
  gInGraphRenderCallback = false;
  runner->renderState.store(0, std::memory_order_release);
  return status;
}

Status shutdownGraphRunner(GraphRunner* runner,
                           PublishedGraphSnapshot** snapshots,
                           uint32_t capacity,
                           uint32_t* snapshotCount) noexcept {
  if (runner == nullptr || runner->publisher == nullptr ||
      snapshotCount == nullptr || (capacity != 0 && snapshots == nullptr))
    return {StatusCode::InvalidArgument, 1};
  uint32_t expected = 0;
  if (!runner->renderState.compare_exchange_strong(
          expected, 2, std::memory_order_acq_rel, std::memory_order_acquire))
    return {StatusCode::Busy, expected};
  expected = 0;
  while (!runner->publisher->publicationState.compare_exchange_weak(
      expected, 3, std::memory_order_acq_rel, std::memory_order_acquire)) {
    if (expected == 3) {
      runner->renderState.store(0, std::memory_order_release);
      return {StatusCode::Busy, 3};
    }
    expected = 0;
  }
  constexpr uint32_t kMaximumShutdownSnapshots = kMaximumGraphNodes + 4;
  if (runner->publisher->retirementCapacity > kMaximumGraphNodes) {
    runner->publisher->publicationState.store(0, std::memory_order_release);
    runner->renderState.store(0, std::memory_order_release);
    return {StatusCode::CapacityExceeded, 2};
  }
  PublishedGraphSnapshot* found[kMaximumShutdownSnapshots]{};
  uint32_t foundCount = 0;
  auto collect = [&](PublishedGraphSnapshot* candidate) noexcept {
    if (candidate == nullptr) return;
    for (uint32_t index = 0; index < foundCount; ++index)
      if (found[index] == candidate) return;
    if (foundCount < kMaximumShutdownSnapshots) found[foundCount++] = candidate;
  };
  SnapshotPublisher* publisher = runner->publisher;
  collect(publisher->claimedView.load(std::memory_order_acquire));
  collect(publisher->pending.load(std::memory_order_acquire));
  collect(publisher->deferred);
  collect(runner->active);
  collect(runner->fadingFrom);
  for (uint32_t index = 0; index < publisher->retirementCapacity; ++index) {
    RetirementSlot& slot = publisher->retirementSlots[index];
    if (slot.state.load(std::memory_order_acquire) !=
        static_cast<uint32_t>(RetirementSlotState::Free))
      collect(slot.snapshot.load(std::memory_order_acquire));
  }
  if (foundCount > capacity) {
    runner->publisher->publicationState.store(0, std::memory_order_release);
    runner->renderState.store(0, std::memory_order_release);
    return {StatusCode::InsufficientStorage, foundCount};
  }
  publisher->pending.store(nullptr, std::memory_order_release);
  publisher->claimedView.store(nullptr, std::memory_order_release);
  publisher->deferred = nullptr;
  publisher->activeView.store(nullptr, std::memory_order_release);
  publisher->fadingView.store(nullptr, std::memory_order_release);
  runner->active = nullptr;
  runner->fadingFrom = nullptr;
  runner->transitionFrame = 0;
  runner->tailFrame = 0;
  clearTransitionHistory(runner);
  for (uint32_t index = 0; index < publisher->retirementCapacity; ++index) {
    RetirementSlot& slot = publisher->retirementSlots[index];
    slot.snapshot.store(nullptr, std::memory_order_relaxed);
    slot.retireAfterEpoch = 0;
    slot.state.store(static_cast<uint32_t>(RetirementSlotState::Free),
                     std::memory_order_release);
  }
  for (uint32_t index = 0; index < foundCount; ++index) snapshots[index] = found[index];
  *snapshotCount = foundCount;
  return okStatus();
}

uint32_t acknowledgedEpoch(const GraphRunner& runner) noexcept {
  return runner.epoch.load(std::memory_order_acquire);
}

bool inGraphRenderCallback() noexcept { return gInGraphRenderCallback; }

}  // namespace zdsp

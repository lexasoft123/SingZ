#include "graph_internal.h"

#include <cmath>
#include <limits.h>

namespace zdsp {
namespace {

struct EdgeWork {
  uint32_t source;
  uint32_t destination;
  uint32_t sourceBus;
  uint32_t destinationBus;
  uint32_t sourceLogical;
  uint32_t compensatedLogical;
  uint32_t compensation;
  uint32_t runtimeDelay;
};

struct LogicalWork {
  uint32_t parent;
  uint32_t start;
  uint32_t end;
  uint32_t channels;
  uint32_t slot;
  uint32_t active;
};

uint32_t findNode(const GraphDescription& description, NodeId id) noexcept {
  for (uint32_t index = 0; index < description.nodeCount; ++index)
    if (description.nodes[index].id.value == id.value) return index;
  return UINT32_MAX;
}

uint32_t root(LogicalWork* logical, uint32_t index) noexcept {
  while (logical[index].parent != index) index = logical[index].parent;
  return index;
}

void setError(GraphCompileError* error, GraphErrorKind kind, NodeId node,
              uint32_t port, Status status = okStatus()) noexcept {
  if (error != nullptr) *error = {kind, node, port, status};
}

bool compatible(const AudioBusDescriptor& source,
                const AudioBusDescriptor& destination) noexcept {
  if (source.channelCount != destination.channelCount ||
      source.sampleFormat != destination.sampleFormat ||
      source.layout != destination.layout) return false;
  if (source.layout != AudioChannelLayout::Discrete) return true;
  for (uint32_t channel = 0; channel < source.channelCount; ++channel)
    if (source.channelRoles[channel] != destination.channelRoles[channel]) return false;
  return true;
}

Status failCompile(RealtimeArena* arena, ArenaCheckpoint before,
                   GraphCompileError* error, GraphErrorKind kind, NodeId node,
                   uint32_t port, Status detail = okStatus()) noexcept {
  rewindArena(arena, before);
  setError(error, kind, node, port, detail);
  return {kind == GraphErrorKind::StorageExhausted
              ? StatusCode::InsufficientStorage : StatusCode::InvalidArgument,
          static_cast<uint32_t>(kind)};
}

}  // namespace

Status compileGraph(const GraphDescription& description, RealtimeArena* arena,
                    GraphCompileResult* result,
                    GraphCompileError* error) noexcept {
  if (arena == nullptr || result == nullptr) return {StatusCode::InvalidArgument, 1};
  *result = {};
  const ArenaCheckpoint before = checkpoint(*arena);
  if (description.formatVersion != kGraphFormatVersion ||
      !std::isfinite(description.sampleRate.value) || description.sampleRate.value <= 0.0 ||
      description.maximumBlockFrames.value == 0 || description.nodes == nullptr ||
      description.nodeCount == 0 || description.nodeCount > kMaximumGraphNodes ||
      description.connectionCount > kMaximumGraphConnections ||
      (description.connectionCount != 0 && description.connections == nullptr))
    return failCompile(arena, before, error, GraphErrorKind::InvalidDescription, {}, 0);

  uint32_t indegree[kMaximumGraphNodes]{};
  uint32_t order[kMaximumGraphNodes]{};
  uint32_t position[kMaximumGraphNodes]{};
  uint32_t scheduled[kMaximumGraphNodes]{};
  uint32_t outputBase[kMaximumGraphNodes]{};
  uint64_t nodeArrival[kMaximumGraphNodes]{};
  uint64_t nodeOutputLatency[kMaximumGraphNodes]{};
  TailInfo intrinsicTail[kMaximumGraphNodes]{};
  TailInfo pathTail[kMaximumGraphNodes]{};
  uint32_t bypassDelayIndex[kMaximumGraphNodes]{};
  EdgeWork edges[kMaximumGraphConnections]{};
  LogicalWork logical[kMaximumGraphBuses + kMaximumGraphConnections]{};
  uint32_t inputConnection[kMaximumGraphNodes][kMaximumBusesPerProcessor]{};
  for (uint32_t node = 0; node < kMaximumGraphNodes; ++node)
    for (uint32_t bus = 0; bus < kMaximumBusesPerProcessor; ++bus)
      inputConnection[node][bus] = UINT32_MAX;
  for (uint32_t node = 0; node < kMaximumGraphNodes; ++node)
    bypassDelayIndex[node] = UINT32_MAX;

  uint32_t logicalCount = 0;
  uint32_t inputNodeCount = 0;
  uint32_t outputNodeCount = 0;
  for (uint32_t node = 0; node < description.nodeCount; ++node) {
    const GraphNodeDescription& current = description.nodes[node];
    constexpr uint32_t kKnownNodeFlags =
        GraphNodeFlagMayProcessInPlace | GraphNodeFlagBypassed;
    if (current.id.value == 0 || current.schemaVersion == 0 ||
        (current.flags & ~kKnownNodeFlags) != 0 ||
        current.inputBusCount > kMaximumBusesPerProcessor ||
        current.outputBusCount > kMaximumBusesPerProcessor ||
        (current.inputBusCount != 0 && current.inputBuses == nullptr) ||
        (current.outputBusCount != 0 && current.outputBuses == nullptr))
      return failCompile(arena, before, error, GraphErrorKind::InvalidDescription,
                         current.id, 0);
    for (uint32_t prior = 0; prior < node; ++prior)
      if (description.nodes[prior].id.value == current.id.value)
        return failCompile(arena, before, error, GraphErrorKind::DuplicateNode,
                           current.id, 0);
    for (uint32_t bus = 0; bus < current.inputBusCount; ++bus)
      if (!isValid(current.inputBuses[bus]))
        return failCompile(arena, before, error, GraphErrorKind::InvalidPort,
                           current.id, bus);
    for (uint32_t bus = 0; bus < current.outputBusCount; ++bus)
      if (!isValid(current.outputBuses[bus]))
        return failCompile(arena, before, error, GraphErrorKind::InvalidPort,
                           current.id, bus);
    if (current.role == GraphNodeRole::Input) {
      if (current.inputBusCount != 0 || current.outputBusCount != 1 ||
          current.flags != GraphNodeFlagNone || current.processor.state != nullptr ||
          current.processor.functions != nullptr) return failCompile(
              arena, before, error, GraphErrorKind::InvalidDescription, current.id, 0);
      ++inputNodeCount;
    } else if (current.role == GraphNodeRole::Output) {
      if (current.inputBusCount != 1 || current.outputBusCount != 0 ||
          current.flags != GraphNodeFlagNone || current.processor.state != nullptr ||
          current.processor.functions != nullptr) return failCompile(
              arena, before, error, GraphErrorKind::InvalidDescription, current.id, 0);
      ++outputNodeCount;
    } else if (current.role == GraphNodeRole::Processor) {
      // A processor state has exactly one lifecycle owner. Reject aliases
      // before prepare or any arena allocation, even when callers attach a
      // different vtable/type facade to the same state pointer.
      for (uint32_t prior = 0; prior < node; ++prior) {
        const GraphNodeDescription& previous = description.nodes[prior];
        if (previous.role == GraphNodeRole::Processor &&
            previous.processor.state != nullptr &&
            previous.processor.state == current.processor.state)
          return failCompile(arena, before, error,
              GraphErrorKind::DuplicateProcessor, current.id, prior);
      }
      const Status valid = validateProcessor(current.processor);
      if (!succeeded(valid)) return failCompile(arena, before, error,
          GraphErrorKind::ProcessorFailure, current.id, 0, valid);
      if ((current.flags & GraphNodeFlagBypassed) != 0 &&
          (current.inputBusCount != 1 || current.outputBusCount != 1 ||
           !compatible(current.inputBuses[0], current.outputBuses[0])))
        return failCompile(arena, before, error, GraphErrorKind::InvalidDescription,
                           current.id, 0);
    } else {
      return failCompile(arena, before, error, GraphErrorKind::InvalidDescription,
                         current.id, 0);
    }
    outputBase[node] = logicalCount;
    if (logicalCount > kMaximumGraphBuses - current.outputBusCount)
      return failCompile(arena, before, error, GraphErrorKind::InvalidDescription,
                         current.id, 0);
    for (uint32_t bus = 0; bus < current.outputBusCount; ++bus) {
      logical[logicalCount] = {logicalCount, 0, 0,
          current.outputBuses[bus].channelCount, UINT32_MAX, 1};
      ++logicalCount;
    }
  }
  if (inputNodeCount > kMaximumBusesPerProcessor || outputNodeCount == 0 ||
      outputNodeCount > kMaximumBusesPerProcessor)
    return failCompile(arena, before, error, GraphErrorKind::InvalidDescription, {}, 0);

  for (uint32_t edge = 0; edge < description.connectionCount; ++edge) {
    const GraphConnection& connection = description.connections[edge];
    const uint32_t source = findNode(description, connection.sourceNode);
    const uint32_t destination = findNode(description, connection.destinationNode);
    if (source == UINT32_MAX || destination == UINT32_MAX)
      return failCompile(arena, before, error, GraphErrorKind::UnknownNode,
                         source == UINT32_MAX ? connection.sourceNode : connection.destinationNode, 0);
    const GraphNodeDescription& sourceNode = description.nodes[source];
    const GraphNodeDescription& destinationNode = description.nodes[destination];
    if (connection.sourceBus >= sourceNode.outputBusCount ||
        connection.destinationBus >= destinationNode.inputBusCount)
      return failCompile(arena, before, error, GraphErrorKind::InvalidPort,
                         destinationNode.id, connection.destinationBus);
    if (inputConnection[destination][connection.destinationBus] != UINT32_MAX)
      return failCompile(arena, before, error, GraphErrorKind::MultipleProducers,
                         destinationNode.id, connection.destinationBus);
    if (!compatible(sourceNode.outputBuses[connection.sourceBus],
                    destinationNode.inputBuses[connection.destinationBus]))
      return failCompile(arena, before, error, GraphErrorKind::IncompatibleBus,
                         destinationNode.id, connection.destinationBus);
    edges[edge] = {source, destination, connection.sourceBus,
        connection.destinationBus, outputBase[source] + connection.sourceBus,
        UINT32_MAX, 0, UINT32_MAX};
    inputConnection[destination][connection.destinationBus] = edge;
    ++indegree[destination];
  }
  for (uint32_t node = 0; node < description.nodeCount; ++node) {
    for (uint32_t bus = 0; bus < description.nodes[node].inputBusCount; ++bus)
      if (inputConnection[node][bus] == UINT32_MAX)
        return failCompile(arena, before, error, GraphErrorKind::MissingProducer,
                           description.nodes[node].id, bus);
  }

  uint32_t ordered = 0;
  while (ordered < description.nodeCount) {
    uint32_t node = UINT32_MAX;
    for (uint32_t candidate = 0; candidate < description.nodeCount; ++candidate) {
      if (scheduled[candidate] != 0 || indegree[candidate] != 0) continue;
      if (node == UINT32_MAX ||
          description.nodes[candidate].id.value < description.nodes[node].id.value)
        node = candidate;
    }
    if (node == UINT32_MAX) break;
    scheduled[node] = 1;
    order[ordered++] = node;
    for (uint32_t edge = 0; edge < description.connectionCount; ++edge) {
      if (edges[edge].source == node) --indegree[edges[edge].destination];
    }
  }
  if (ordered != description.nodeCount)
    return failCompile(arena, before, error, GraphErrorKind::Cycle, {}, 0);
  for (uint32_t index = 0; index < description.nodeCount; ++index)
    position[order[index]] = index;

  // Only prepared processors require a quarantined checkpoint. Early
  // validation failures already rewound synchronously and must leave no stale
  // cleanup handle capable of rewinding later unrelated arena allocations.
  result->cleanupArena = arena;
  result->cleanupCheckpoint = before;
  auto failPrepared = [&](GraphErrorKind kind, NodeId node, uint32_t port,
                          Status detail) noexcept {
    (void)cleanupFailedCompile(result);
    if (result->cleanupCount == 0)
      return failCompile(arena, before, error, kind, node, port, detail);
    setError(error, kind, node, port, detail);
    return Status{kind == GraphErrorKind::StorageExhausted
                      ? StatusCode::InsufficientStorage
                      : StatusCode::InvalidArgument,
                  static_cast<uint32_t>(kind)};
  };
  for (uint32_t topo = 0; topo < description.nodeCount; ++topo) {
    const uint32_t node = order[topo];
    const GraphNodeDescription& current = description.nodes[node];
    if (current.role != GraphNodeRole::Processor) continue;
    PrepareSpec spec{kProcessorInterfaceVersion, kPrepareSpecV1RequiredSize,
        description.sampleRate, description.maximumBlockFrames,
        current.inputBusCount, current.outputBusCount,
        current.inputBuses, current.outputBuses};
    const Status prepared = current.processor.functions->prepare(
        current.processor.state, &spec, &current.preparedStorage);
    if (!succeeded(prepared))
      return failPrepared(GraphErrorKind::ProcessorFailure, current.id, 0, prepared);
    result->cleanup[result->cleanupCount++] = {
        current.processor, current.id, ProcessorOwnershipState::Active};
  }

  uint64_t maximumOutputLatency = 0;
  for (uint32_t topo = 0; topo < description.nodeCount; ++topo) {
    const uint32_t node = order[topo];
    const GraphNodeDescription& current = description.nodes[node];
    uint64_t arrival = 0;
    for (uint32_t bus = 0; bus < current.inputBusCount; ++bus) {
      const EdgeWork& edge = edges[inputConnection[node][bus]];
      if (nodeOutputLatency[edge.source] > arrival) arrival = nodeOutputLatency[edge.source];
    }
    nodeArrival[node] = arrival;
    uint64_t intrinsic = 0;
    if (current.role == GraphNodeRole::Processor)
      intrinsic = current.processor.functions->latency(current.processor.state).value;
    if (arrival > UINT32_MAX || intrinsic > UINT32_MAX - arrival)
      return failPrepared(GraphErrorKind::LatencyOverflow, current.id, 0,
                          okStatus());
    nodeOutputLatency[node] = arrival + intrinsic;
    if (current.role == GraphNodeRole::Output && arrival > maximumOutputLatency)
      maximumOutputLatency = arrival;
  }

  for (uint32_t node = 0; node < description.nodeCount; ++node) {
    const GraphNodeDescription& current = description.nodes[node];
    if (current.role != GraphNodeRole::Processor) continue;
    intrinsicTail[node] = (current.flags & GraphNodeFlagBypassed) != 0
        ? TailInfo{TailKind::None, {0}}
        : current.processor.functions->tail(current.processor.state);
    if (intrinsicTail[node].kind > TailKind::Infinite ||
        (intrinsicTail[node].kind != TailKind::Finite &&
         intrinsicTail[node].frames.value != 0))
      return failPrepared(GraphErrorKind::ProcessorFailure, current.id, 0,
                          {StatusCode::InvalidArgument, 90});
  }

  uint32_t compensationCount = 0;
  uint32_t bypassDelayCount = 0;
  uint32_t processorCaptureDelayCount = 0;
  for (uint32_t edge = 0; edge < description.connectionCount; ++edge) {
    EdgeWork& current = edges[edge];
    uint64_t target = nodeArrival[current.destination];
    if (description.nodes[current.destination].role == GraphNodeRole::Output)
      target = maximumOutputLatency;
    const uint64_t sourceLatency = nodeOutputLatency[current.source];
    if (target < sourceLatency || target - sourceLatency > UINT32_MAX)
      return failPrepared(GraphErrorKind::LatencyOverflow,
          description.nodes[current.destination].id, current.destinationBus,
          okStatus());
    current.compensation = static_cast<uint32_t>(target - sourceLatency);
    if (current.compensation != 0) {
      if (logicalCount == kMaximumGraphBuses + kMaximumGraphConnections)
        return failPrepared(GraphErrorKind::InvalidDescription,
            description.nodes[current.destination].id, current.destinationBus,
            okStatus());
      current.compensatedLogical = logicalCount;
      logical[logicalCount] = {logicalCount, position[current.destination],
          position[current.destination],
          description.nodes[current.destination].inputBuses[current.destinationBus].channelCount,
          UINT32_MAX, 1};
      ++logicalCount;
      ++compensationCount;
    }
  }
  for (uint32_t node = 0; node < description.nodeCount; ++node) {
    if ((description.nodes[node].flags & GraphNodeFlagBypassed) != 0 &&
        nodeOutputLatency[node] > nodeArrival[node]) ++bypassDelayCount;
    else if (description.nodes[node].role == GraphNodeRole::Processor &&
             nodeOutputLatency[node] > nodeArrival[node])
      ++processorCaptureDelayCount;
  }

  TailInfo graphTail{TailKind::None, {0}};
  for (uint32_t topo = 0; topo < description.nodeCount; ++topo) {
    const uint32_t node = order[topo];
    const GraphNodeDescription& current = description.nodes[node];
    TailInfo upstream{TailKind::None, {0}};
    for (uint32_t bus = 0; bus < current.inputBusCount; ++bus) {
      const EdgeWork& edge = edges[inputConnection[node][bus]];
      const TailInfo sourceTail = pathTail[edge.source];
      if (sourceTail.kind == TailKind::Infinite) {
        upstream = sourceTail;
        break;
      }
      uint64_t frames = sourceTail.frames.value;
      if (frames > UINT64_MAX - edge.compensation)
        return failPrepared(GraphErrorKind::LatencyOverflow, current.id, bus,
                            okStatus());
      frames += edge.compensation;
      if (frames != 0 &&
          (upstream.kind == TailKind::None || frames > upstream.frames.value))
        upstream = {TailKind::Finite, {frames}};
    }
    if (current.role == GraphNodeRole::Processor) {
      const TailInfo own = intrinsicTail[node];
      if (upstream.kind == TailKind::Infinite || own.kind == TailKind::Infinite) {
        pathTail[node] = {TailKind::Infinite, {0}};
      } else {
        uint64_t frames = upstream.frames.value;
        const uint64_t latency =
            current.processor.functions->latency(current.processor.state).value;
        if (frames > UINT64_MAX - latency ||
            frames + latency > UINT64_MAX - own.frames.value)
          return failPrepared(GraphErrorKind::LatencyOverflow, current.id, 0,
                              okStatus());
        frames += latency + own.frames.value;
        pathTail[node] = frames == 0 ? TailInfo{TailKind::None, {0}}
                                    : TailInfo{TailKind::Finite, {frames}};
      }
    } else {
      pathTail[node] = upstream;
    }
    if (current.role == GraphNodeRole::Output) {
      const TailInfo outputTail = pathTail[node];
      if (outputTail.kind == TailKind::Infinite) graphTail = outputTail;
      else if (graphTail.kind != TailKind::Infinite && outputTail.frames.value != 0 &&
               (graphTail.kind == TailKind::None ||
                outputTail.frames.value > graphTail.frames.value))
        graphTail = outputTail;
    }
  }

  for (uint32_t node = 0; node < description.nodeCount; ++node) {
    for (uint32_t bus = 0; bus < description.nodes[node].outputBusCount; ++bus) {
      const uint32_t index = outputBase[node] + bus;
      // External inputs are copied into graph storage before the first node,
      // not when their boundary node appears in topological order.
      logical[index].start = description.nodes[node].role == GraphNodeRole::Input
          ? 0 : position[node];
      logical[index].end = position[node];
    }
  }
  for (uint32_t edge = 0; edge < description.connectionCount; ++edge) {
    LogicalWork& source = logical[edges[edge].sourceLogical];
    if (position[edges[edge].destination] > source.end)
      source.end = position[edges[edge].destination];
  }
  for (uint32_t node = 0; node < description.nodeCount; ++node) {
    if (description.nodes[node].role != GraphNodeRole::Output) continue;
    const EdgeWork& edge = edges[inputConnection[node][0]];
    // External outputs are copied after all nodes finish. Keep the producing
    // value (or its compensation result) live through that boundary copy.
    const uint32_t logicalIndex = edge.compensation == 0
        ? edge.sourceLogical : edge.compensatedLogical;
    logical[logicalIndex].end = description.nodeCount;
  }

  uint32_t aliasCount = 0;
  for (uint32_t topo = 0; topo < description.nodeCount; ++topo) {
    const uint32_t node = order[topo];
    const GraphNodeDescription& current = description.nodes[node];
    if (current.role != GraphNodeRole::Processor ||
        (current.flags & GraphNodeFlagMayProcessInPlace) == 0 ||
        current.inputBusCount != 1 || current.outputBusCount != 1 ||
        ((current.flags & GraphNodeFlagBypassed) != 0 &&
         nodeOutputLatency[node] != nodeArrival[node])) continue;
    const EdgeWork& input = edges[inputConnection[node][0]];
    const uint32_t inputRoot = root(logical, input.sourceLogical);
    const uint32_t outputRoot = root(logical, outputBase[node]);
    if (input.compensation == 0 && logical[inputRoot].end == topo &&
        logical[inputRoot].channels == logical[outputRoot].channels) {
      logical[outputRoot].parent = inputRoot;
      if (logical[outputRoot].end > logical[inputRoot].end)
        logical[inputRoot].end = logical[outputRoot].end;
      ++aliasCount;
    }
  }

  uint32_t slotCount = 0;
  uint32_t slotEnd[kMaximumGraphBuffers]{};
  uint32_t slotChannels[kMaximumGraphBuffers]{};
  for (;;) {
    uint32_t index = UINT32_MAX;
    for (uint32_t candidate = 0; candidate < logicalCount; ++candidate) {
      if (root(logical, candidate) != candidate ||
          logical[candidate].slot != UINT32_MAX) continue;
      if (index == UINT32_MAX || logical[candidate].start < logical[index].start ||
          (logical[candidate].start == logical[index].start &&
           logical[candidate].end < logical[index].end)) index = candidate;
    }
    if (index == UINT32_MAX) break;
    uint32_t chosen = UINT32_MAX;
    for (uint32_t slot = 0; slot < slotCount; ++slot) {
      if (slotEnd[slot] < logical[index].start &&
          slotChannels[slot] == logical[index].channels) {
        chosen = slot;
        break;
      }
    }
    if (chosen == UINT32_MAX) {
      if (slotCount == kMaximumGraphBuffers)
        return failPrepared(GraphErrorKind::StorageExhausted, {}, 0, okStatus());
      chosen = slotCount++;
      slotChannels[chosen] = logical[index].channels;
    }
    slotEnd[chosen] = logical[index].end;
    logical[index].slot = chosen;
  }
  for (uint32_t index = 0; index < logicalCount; ++index)
    logical[index].slot = logical[root(logical, index)].slot;

  CompiledGraph* graph = arenaArray<CompiledGraph>(arena, 1);
  RuntimeNode* runtimeNodes = arenaArray<RuntimeNode>(arena, description.nodeCount);
  RuntimeBuffer* buffers = arenaArray<RuntimeBuffer>(arena, slotCount);
  RuntimeExternalBus* graphInputs = inputNodeCount == 0 ? nullptr
      : arenaArray<RuntimeExternalBus>(arena, inputNodeCount);
  RuntimeExternalBus* graphOutputs = outputNodeCount == 0 ? nullptr
      : arenaArray<RuntimeExternalBus>(arena, outputNodeCount);
  const uint32_t totalDelayCount = compensationCount + bypassDelayCount;
  RuntimeDelay* delays = totalDelayCount == 0 ? nullptr
      : arenaArray<RuntimeDelay>(arena, totalDelayCount);
  RuntimeCaptureDelay* captureDelays = processorCaptureDelayCount == 0
      ? nullptr : arenaArray<RuntimeCaptureDelay>(arena,
                                                 processorCaptureDelayCount);
  if (graph == nullptr || runtimeNodes == nullptr || buffers == nullptr ||
      (inputNodeCount != 0 && graphInputs == nullptr) ||
      (outputNodeCount != 0 && graphOutputs == nullptr) ||
      (totalDelayCount != 0 && delays == nullptr) ||
      (processorCaptureDelayCount != 0 && captureDelays == nullptr))
    return failPrepared(GraphErrorKind::StorageExhausted, {}, 0, okStatus());

  for (uint32_t slot = 0; slot < slotCount; ++slot) {
    float** channelPointers = arenaArray<float*>(arena, slotChannels[slot]);
    const uint64_t sampleCount = static_cast<uint64_t>(slotChannels[slot]) *
                                 description.maximumBlockFrames.value;
    if (sampleCount > static_cast<uint64_t>(static_cast<size_t>(-1)) / sizeof(float))
      return failPrepared(GraphErrorKind::StorageExhausted, {}, 0, okStatus());
    float* samples = arenaArray<float>(arena, static_cast<size_t>(sampleCount));
    if (channelPointers == nullptr || samples == nullptr)
      return failPrepared(GraphErrorKind::StorageExhausted, {}, 0, okStatus());
    for (uint32_t channel = 0; channel < slotChannels[slot]; ++channel)
      channelPointers[channel] = samples +
          static_cast<size_t>(channel) * description.maximumBlockFrames.value;
    buffers[slot] = {channelPointers, samples, slotChannels[slot], nullptr};
  }

  uint32_t delayIndex = 0;
  auto allocateCaptureDelay = [&](uint32_t frames,
                                  RuntimeCaptureDelay* capture) noexcept {
    CaptureTime* samples = arenaArray<CaptureTime>(arena, frames);
    uint8_t* valid = arenaArray<uint8_t>(arena, frames);
    if (samples == nullptr || valid == nullptr) return false;
    for (uint32_t frame = 0; frame < frames; ++frame) valid[frame] = 0;
    *capture = {samples, valid, {}, frames, 0};
    return true;
  };
  for (uint32_t edge = 0; edge < description.connectionCount; ++edge) {
    if (edges[edge].compensation == 0) continue;
    const uint32_t channels = logical[edges[edge].compensatedLogical].channels;
    const uint64_t sampleCount = static_cast<uint64_t>(channels) * edges[edge].compensation;
    if (sampleCount > static_cast<uint64_t>(static_cast<size_t>(-1)))
      return failPrepared(GraphErrorKind::StorageExhausted,
          description.nodes[edges[edge].destination].id,
          edges[edge].destinationBus, okStatus());
    float* samples = arenaArray<float>(arena, static_cast<size_t>(sampleCount));
    if (samples == nullptr)
      return failPrepared(GraphErrorKind::StorageExhausted, {}, 0, okStatus());
    for (uint64_t sample = 0; sample < sampleCount; ++sample) samples[sample] = 0.0f;
    edges[edge].runtimeDelay = delayIndex;
    RuntimeDelay& delay = delays[delayIndex++];
    delay = {samples, edges[edge].compensation, 0, channels,
        logical[edges[edge].sourceLogical].slot,
        logical[edges[edge].compensatedLogical].slot, {}};
    if (!allocateCaptureDelay(edges[edge].compensation, &delay.capture))
      return failPrepared(GraphErrorKind::StorageExhausted, {}, 0, okStatus());
  }
  for (uint32_t node = 0; node < description.nodeCount; ++node) {
    const GraphNodeDescription& current = description.nodes[node];
    if ((current.flags & GraphNodeFlagBypassed) == 0 ||
        nodeOutputLatency[node] == nodeArrival[node]) continue;
    const uint32_t frames = static_cast<uint32_t>(
        nodeOutputLatency[node] - nodeArrival[node]);
    const uint32_t channels = current.outputBuses[0].channelCount;
    const uint64_t sampleCount = static_cast<uint64_t>(channels) * frames;
    if (sampleCount > static_cast<uint64_t>(static_cast<size_t>(-1)))
      return failPrepared(GraphErrorKind::StorageExhausted, current.id, 0,
                          okStatus());
    float* samples = arenaArray<float>(arena, static_cast<size_t>(sampleCount));
    if (samples == nullptr)
      return failPrepared(GraphErrorKind::StorageExhausted, current.id, 0,
                          okStatus());
    for (uint64_t sample = 0; sample < sampleCount; ++sample) samples[sample] = 0.0f;
    const EdgeWork& input = edges[inputConnection[node][0]];
    bypassDelayIndex[node] = delayIndex;
    RuntimeDelay& delay = delays[delayIndex++];
    delay = {samples, frames, 0, channels,
        logical[input.compensation == 0 ? input.sourceLogical
                                        : input.compensatedLogical].slot,
        logical[outputBase[node]].slot, {}};
    if (!allocateCaptureDelay(frames, &delay.capture))
      return failPrepared(GraphErrorKind::StorageExhausted, current.id, 0,
                          okStatus());
  }

  uint32_t externalInput = 0;
  uint32_t externalOutput = 0;
  uint32_t captureDelayIndex = 0;
  for (uint32_t topo = 0; topo < description.nodeCount; ++topo) {
    const uint32_t node = order[topo];
    const GraphNodeDescription& source = description.nodes[node];
    RuntimeInputBinding* inputs = source.inputBusCount == 0 ? nullptr
        : arenaArray<RuntimeInputBinding>(arena, source.inputBusCount);
    RuntimeOutputBinding* outputs = source.outputBusCount == 0 ? nullptr
        : arenaArray<RuntimeOutputBinding>(arena, source.outputBusCount);
    if ((source.inputBusCount != 0 && inputs == nullptr) ||
        (source.outputBusCount != 0 && outputs == nullptr))
      return failPrepared(GraphErrorKind::StorageExhausted, source.id, 0,
                          okStatus());
    for (uint32_t bus = 0; bus < source.inputBusCount; ++bus) {
      const EdgeWork& edge = edges[inputConnection[node][bus]];
      RuntimeDelay* delay = nullptr;
      uint32_t buffer = logical[edge.sourceLogical].slot;
      if (edge.compensation != 0) {
        delay = &delays[edge.runtimeDelay];
        buffer = logical[edge.compensatedLogical].slot;
      }
      inputs[bus] = {buffer, delay, source.inputBuses[bus].channelCount};
    }
    for (uint32_t bus = 0; bus < source.outputBusCount; ++bus)
      outputs[bus] = {logical[outputBase[node] + bus].slot,
                      source.outputBuses[bus].channelCount};
    RuntimeDelay* bypassDelay = bypassDelayIndex[node] == UINT32_MAX ? nullptr
        : &delays[bypassDelayIndex[node]];
    RuntimeCaptureDelay* processorCaptureDelay = nullptr;
    if (source.role == GraphNodeRole::Processor && bypassDelay == nullptr &&
        nodeOutputLatency[node] > nodeArrival[node]) {
      processorCaptureDelay = &captureDelays[captureDelayIndex++];
      const uint32_t frames = static_cast<uint32_t>(
          nodeOutputLatency[node] - nodeArrival[node]);
      if (!allocateCaptureDelay(frames, processorCaptureDelay))
        return failPrepared(GraphErrorKind::StorageExhausted, source.id, 0,
                            okStatus());
    }
    runtimeNodes[topo] = {source.id, source.role, source.flags, source.processor,
                          inputs, outputs, bypassDelay, processorCaptureDelay,
                          source.inputBusCount, source.outputBusCount,
                          source.role == GraphNodeRole::Processor
                              ? ProcessorOwnershipState::Active
                              : ProcessorOwnershipState::Empty};
    if (source.role == GraphNodeRole::Input) {
      RuntimeExternalBus& bus = graphInputs[externalInput++];
      bus = {};
      bus.buffer = outputs[0].buffer;
      bus.channels = outputs[0].channels;
      bus.sampleFormat = source.outputBuses[0].sampleFormat;
      bus.layout = source.outputBuses[0].layout;
      if (bus.layout == AudioChannelLayout::Discrete)
        for (uint32_t channel = 0; channel < bus.channels; ++channel)
          bus.roles[channel] = source.outputBuses[0].channelRoles[channel];
    }
    if (source.role == GraphNodeRole::Output) {
      RuntimeExternalBus& bus = graphOutputs[externalOutput++];
      bus = {};
      bus.buffer = inputs[0].buffer;
      bus.channels = inputs[0].channels;
      bus.sampleFormat = source.inputBuses[0].sampleFormat;
      bus.layout = source.inputBuses[0].layout;
      if (bus.layout == AudioChannelLayout::Discrete)
        for (uint32_t channel = 0; channel < bus.channels; ++channel)
          bus.roles[channel] = source.inputBuses[0].channelRoles[channel];
    }
  }
  *graph = {description.sampleRate, description.maximumBlockFrames,
      runtimeNodes, description.nodeCount, buffers, slotCount,
      graphInputs, inputNodeCount, graphOutputs, outputNodeCount,
      delays, totalDelayCount, captureDelays, processorCaptureDelayCount,
      {logicalCount, slotCount, aliasCount, compensationCount},
      {static_cast<uint32_t>(maximumOutputLatency)}, graphTail};
  result->graph = graph;
  result->buffers = graph->plan;
  result->outputLatency = graph->latency;
  result->cleanupCount = 0;
  result->cleanupArena = nullptr;
  if (error != nullptr) *error = {};
  return okStatus();
}

Status cleanupFailedCompile(GraphCompileResult* result) noexcept {
  if (result == nullptr) return {StatusCode::InvalidArgument, 1};
  Status first = okStatus();
  for (uint32_t index = result->cleanupCount; index != 0; --index) {
    ProcessorCleanupEntry& entry = result->cleanup[index - 1];
    if (entry.state == ProcessorOwnershipState::Empty) continue;
    if (entry.state == ProcessorOwnershipState::Active) {
      const Status status = deactivateProcessor(entry.processor);
      if (!succeeded(status)) {
        if (succeeded(first)) first = status;
        continue;
      }
      entry.state = ProcessorOwnershipState::Deactivated;
    }
    ProcessorHandle disposable = entry.processor;
    const Status status = destroyProcessor(&disposable);
    if (!succeeded(status)) {
      if (succeeded(first)) first = status;
      continue;
    }
    entry = {};
  }
  while (result->cleanupCount != 0 &&
         result->cleanup[result->cleanupCount - 1].state ==
             ProcessorOwnershipState::Empty)
    --result->cleanupCount;
  if (result->cleanupCount == 0 && result->cleanupArena != nullptr) {
    rewindArena(result->cleanupArena, result->cleanupCheckpoint);
    result->cleanupArena = nullptr;
    result->cleanupCheckpoint = {};
  }
  return first;
}

uint32_t compiledGraphNodeCount(const CompiledGraph& graph) noexcept {
  return graph.nodeCount;
}
NodeId compiledGraphNodeId(const CompiledGraph& graph, uint32_t index) noexcept {
  return index < graph.nodeCount ? graph.nodes[index].id : NodeId{};
}
BufferPlanSummary compiledGraphBufferPlan(const CompiledGraph& graph) noexcept {
  return graph.plan;
}
LatencyFrames compiledGraphLatency(const CompiledGraph& graph) noexcept {
  return graph.latency;
}
TailInfo compiledGraphTail(const CompiledGraph& graph) noexcept {
  return graph.tail;
}

Status deactivateCompiledGraph(CompiledGraph* graph) noexcept {
  if (graph == nullptr) return {StatusCode::InvalidArgument, 1};
  Status first = okStatus();
  for (uint32_t index = graph->nodeCount; index != 0; --index) {
    RuntimeNode& node = graph->nodes[index - 1];
    if (node.role != GraphNodeRole::Processor ||
        node.ownership == ProcessorOwnershipState::Empty) continue;
    if (node.ownership == ProcessorOwnershipState::Active) {
      const Status status = deactivateProcessor(node.processor);
      if (!succeeded(status)) {
        if (succeeded(first)) first = status;
        continue;
      }
      node.ownership = ProcessorOwnershipState::Deactivated;
    }
    ProcessorHandle disposable = node.processor;
    const Status status = destroyProcessor(&disposable);
    if (!succeeded(status) && succeeded(first)) first = status;
    if (!succeeded(status)) continue;
    node.processor = {nullptr, nullptr};
    node.ownership = ProcessorOwnershipState::Empty;
  }
  return first;
}

}  // namespace zdsp

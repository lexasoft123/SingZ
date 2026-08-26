#pragma once

#include "zdsp/builtin_nodes.h"

namespace zdsp {

inline constexpr uint32_t kGraphFormatVersion = 1;
inline constexpr uint32_t kMaximumGraphNodes = 64;
inline constexpr uint32_t kMaximumGraphConnections = 256;
inline constexpr uint32_t kMaximumGraphBuses = 256;
inline constexpr uint32_t kMaximumGraphBuffers = 256;

struct NodeTypeId { uint64_t high; uint64_t low; };
enum class GraphNodeRole : uint32_t { Input = 0, Processor = 1, Output = 2 };
enum GraphNodeFlags : uint32_t {
  GraphNodeFlagNone = 0,
  GraphNodeFlagMayProcessInPlace = 1u << 0,
  GraphNodeFlagBypassed = 1u << 1,
};

enum class ProcessorOwnershipState : uint32_t {
  Empty = 0,
  Active,
  Deactivated,
};

struct ProcessorCleanupEntry {
  ProcessorHandle processor;
  NodeId node;
  ProcessorOwnershipState state;
};

struct GraphNodeDescription {
  NodeId id;
  NodeTypeId type;
  uint32_t schemaVersion;
  GraphNodeRole role;
  uint32_t flags;
  uint32_t inputBusCount;
  uint32_t outputBusCount;
  const AudioBusDescriptor* inputBuses;
  const AudioBusDescriptor* outputBuses;
  ProcessorHandle processor;
  PreparedStorage preparedStorage;
};

struct GraphConnection {
  NodeId sourceNode;
  uint32_t sourceBus;
  NodeId destinationNode;
  uint32_t destinationBus;
};

struct GraphDescription {
  uint32_t formatVersion;
  SampleRateHz sampleRate;
  FrameCount maximumBlockFrames;
  const GraphNodeDescription* nodes;
  uint32_t nodeCount;
  const GraphConnection* connections;
  uint32_t connectionCount;
};

enum class GraphErrorKind : uint32_t {
  None = 0,
  InvalidDescription,
  DuplicateNode,
  UnknownNode,
  InvalidPort,
  IncompatibleBus,
  MultipleProducers,
  MissingProducer,
  Cycle,
  ProcessorFailure,
  StorageExhausted,
  LatencyOverflow,
  DuplicateProcessor,
};
struct GraphCompileError {
  GraphErrorKind kind;
  NodeId node;
  uint32_t port;
  Status processorStatus;
};

struct GraphCompileResult;
struct CompiledGraph;

[[nodiscard]] ZDSP_INTERNAL_API Status compileGraph(
    const GraphDescription& description, RealtimeArena* arena,
    GraphCompileResult* result, GraphCompileError* error) noexcept;

struct BufferPlanSummary {
  uint32_t logicalBufferCount;
  uint32_t physicalBufferCount;
  uint32_t inPlaceAliasCount;
  uint32_t compensatedEdgeCount;
};
struct GraphCompileResult {
  CompiledGraph* graph;
  BufferPlanSummary buffers;
  LatencyFrames outputLatency;
  // A failed compile may still own processors whose off-RT teardown failed.
  // Their storage and arena checkpoint stay quarantined until this list is
  // empty; callers retry with cleanupFailedCompile before reclaiming either.
  ProcessorCleanupEntry cleanup[kMaximumGraphNodes];
  uint32_t cleanupCount;
  RealtimeArena* cleanupArena;
  ArenaCheckpoint cleanupCheckpoint;
};

[[nodiscard]] ZDSP_INTERNAL_API Status cleanupFailedCompile(
    GraphCompileResult* result) noexcept;

[[nodiscard]] ZDSP_INTERNAL_API uint32_t compiledGraphNodeCount(
    const CompiledGraph& graph) noexcept;
[[nodiscard]] ZDSP_INTERNAL_API NodeId compiledGraphNodeId(
    const CompiledGraph& graph, uint32_t topologicalIndex) noexcept;
[[nodiscard]] ZDSP_INTERNAL_API BufferPlanSummary compiledGraphBufferPlan(
    const CompiledGraph& graph) noexcept;
[[nodiscard]] ZDSP_INTERNAL_API LatencyFrames compiledGraphLatency(
    const CompiledGraph& graph) noexcept;
[[nodiscard]] ZDSP_INTERNAL_API TailInfo compiledGraphTail(
    const CompiledGraph& graph) noexcept;
[[nodiscard]] ZDSP_INTERNAL_API Status deactivateCompiledGraph(
    CompiledGraph* graph) noexcept;

}  // namespace zdsp

#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include <zdsp/graph.h>

namespace singz {

inline constexpr uint32_t kNativePlaybackGraphDocumentFormat = 1;
inline constexpr const char *kNativePlaybackGraphDocumentEngine = "singz-dsp";
inline constexpr uint32_t kNativePlaybackGraphMaximumParametersPerNode = 64;

// Stable 128-bit product type IDs. They are persistence identities, not
// implementation enum ordinals. Keep these values in sync with
// src/shared/graph-document.ts.
inline constexpr zdsp::NodeTypeId kGraphTypeProjectLaneSource{
    UINT64_C(0x73696e677a2d6473), UINT64_C(0x7000000000000001)};
inline constexpr zdsp::NodeTypeId kGraphTypeChannelMap{
    UINT64_C(0x73696e677a2d6473), UINT64_C(0x7000000000000002)};
inline constexpr zdsp::NodeTypeId kGraphTypeGain{
    UINT64_C(0x73696e677a2d6473), UINT64_C(0x7000000000000003)};
inline constexpr zdsp::NodeTypeId kGraphTypeMix{
    UINT64_C(0x73696e677a2d6473), UINT64_C(0x7000000000000004)};
inline constexpr zdsp::NodeTypeId kGraphTypeTrainingDuck{
    UINT64_C(0x73696e677a2d6473), UINT64_C(0x7000000000000005)};
inline constexpr zdsp::NodeTypeId kGraphTypeSignalsmithTimePitch{
    UINT64_C(0x73696e677a2d6473), UINT64_C(0x7000000000000006)};
inline constexpr zdsp::NodeTypeId kGraphTypeCueSource{
    UINT64_C(0x73696e677a2d6473), UINT64_C(0x7000000000000007)};
inline constexpr zdsp::NodeTypeId kGraphTypePeakRms{
    UINT64_C(0x73696e677a2d6473), UINT64_C(0x7000000000000008)};
inline constexpr zdsp::NodeTypeId kGraphTypeTap{
    UINT64_C(0x73696e677a2d6473), UINT64_C(0x7000000000000009)};
inline constexpr zdsp::NodeTypeId kGraphTypeOscillator{
    UINT64_C(0x73696e677a2d6473), UINT64_C(0x700000000000000a)};
inline constexpr zdsp::NodeTypeId kGraphTypeSafetyLimiter{
    UINT64_C(0x73696e677a2d6473), UINT64_C(0x700000000000000b)};
inline constexpr zdsp::NodeTypeId kGraphTypePhysicalOutput{
    UINT64_C(0x73696e677a2d6473), UINT64_C(0x700000000000000c)};
// A known persistence adapter which is deliberately unavailable until its
// separately hosted implementation is installed. It exercises the same
// declared fail-closed policy as a future unknown type.
inline constexpr zdsp::NodeTypeId kGraphTypeExternalAdapter{
    UINT64_C(0x73696e677a2d6473), UINT64_C(0x700000000000000d)};

enum class NativePlaybackGraphUnavailablePolicy : uint32_t {
  Bypass = 0,
  Silence,
};

struct NativePlaybackGraphPort {
  std::string id;
  uint32_t channels{0};
};

struct NativePlaybackGraphParameter {
  std::string id;
  double normalizedValue{0.0};
};

struct NativePlaybackGraphBinding {
  std::string kind;
  std::string laneId;
};

struct NativePlaybackGraphNode {
  uint64_t id{0};
  zdsp::NodeTypeId type{};
  uint32_t typeVersion{0};
  std::string execution;
  NativePlaybackGraphUnavailablePolicy unavailable{
      NativePlaybackGraphUnavailablePolicy::Silence};
  std::vector<NativePlaybackGraphPort> inputs;
  std::vector<NativePlaybackGraphPort> outputs;
  std::vector<NativePlaybackGraphParameter> parameters;
  std::optional<NativePlaybackGraphBinding> binding;
};

struct NativePlaybackGraphEndpoint {
  uint64_t node{0};
  std::string port;
};

struct NativePlaybackGraphConnection {
  NativePlaybackGraphEndpoint from;
  NativePlaybackGraphEndpoint to;
};

// This is the native projection of a format-1 portable graph. Opaque fields
// and adapter state remain in the shared JS document so an older runtime can
// round-trip them byte-for-byte without pretending to understand them. The
// bridge projects only the bounded fields which can affect compilation.
struct NativePlaybackGraphDocument {
  uint32_t format{kNativePlaybackGraphDocumentFormat};
  std::string engine{kNativePlaybackGraphDocumentEngine};
  std::vector<NativePlaybackGraphNode> nodes;
  std::vector<NativePlaybackGraphConnection> connections;
};

enum class NativePlaybackGraphMaterializedKind : uint32_t {
  ProjectLaneSource = 0,
  ChannelMap,
  Gain,
  Mix,
  TrainingDuck,
  SignalsmithTimePitch,
  CueSource,
  PeakRms,
  Tap,
  Oscillator,
  SafetyLimiter,
  PhysicalOutput,
  PlaceholderBypass,
  PlaceholderSilence,
};

enum class NativePlaybackGraphDocumentError : uint32_t {
  None = 0,
  InvalidEnvelope,
  LimitExceeded,
  InvalidNode,
  DuplicateNode,
  InvalidTypeVersion,
  InvalidExecution,
  InvalidPort,
  InvalidParameter,
  InvalidBinding,
  MissingLane,
  DuplicateLaneBinding,
  InvalidPlaceholder,
  InvalidConnection,
  DuplicateConnection,
  RequiredSemanticNodeMissing,
  UnsupportedSemanticTopology,
};

struct NativePlaybackGraphMaterializedNode {
  NativePlaybackGraphNode document;
  NativePlaybackGraphMaterializedKind kind{
      NativePlaybackGraphMaterializedKind::PlaceholderSilence};
};

struct NativePlaybackGraphMaterializedConnection {
  zdsp::NodeId sourceNode{};
  uint32_t sourceBus{0};
  zdsp::NodeId destinationNode{};
  uint32_t destinationBus{0};
};

struct NativePlaybackGraphMaterialization {
  std::vector<NativePlaybackGraphMaterializedNode> nodes;
  std::vector<NativePlaybackGraphMaterializedConnection> connections;
  // Exact document IDs used by generation-bound controls. Zero means absent.
  uint64_t masterGainNode{0};
  uint64_t cueSourceNode{0};
  uint64_t signalsmithNode{0};
};

struct NativePlaybackGraphLaneContext {
  std::string id;
  uint32_t sourceChannels{0};
  bool trainingSelected{false};
};

struct NativePlaybackGraphContext {
  std::vector<NativePlaybackGraphLaneContext> lanes;
  uint32_t outputChannels{0};
  bool hasReference{false};
  bool hasTraining{false};
  bool needsTimePitch{false};
  float masterGain{1.0F};
  float referenceGain{0.0F};
};

struct NativePlaybackGraphMaterializeResult {
  NativePlaybackGraphDocumentError error{
      NativePlaybackGraphDocumentError::None};
  uint64_t node{0};
  uint32_t port{0};
  std::string message;
  NativePlaybackGraphMaterialization graph;

  [[nodiscard]] bool ok() const noexcept {
    return error == NativePlaybackGraphDocumentError::None;
  }
};

[[nodiscard]] bool nativePlaybackGraphTypeEqual(zdsp::NodeTypeId left,
                                                zdsp::NodeTypeId right) noexcept;
[[nodiscard]] const char *nativePlaybackGraphTypeHex(
    zdsp::NodeTypeId type) noexcept;

// Builds the behavior-preserving fixed graph as an in-memory format-1
// document. It never writes project state. Lane-derived IDs are stable across
// lane ordering and are collision-checked by materialization.
[[nodiscard]] NativePlaybackGraphDocument synthesizeNativePlaybackGraphDocument(
    const NativePlaybackGraphContext &context);

/** Exact number of nodes synthesis will emit for an admitted context. */
[[nodiscard]] size_t synthesizedNativePlaybackGraphNodeCount(
    const NativePlaybackGraphContext &context) noexcept;

// Validates the portable projection and resolves named ports/logical lane
// bindings without allocating or preparing processors. The resulting node and
// edge arrays are the exact inputs the session must instantiate/compile.
[[nodiscard]] NativePlaybackGraphMaterializeResult
materializeNativePlaybackGraphDocument(
    NativePlaybackGraphDocument document,
    const NativePlaybackGraphContext &context);

}  // namespace singz

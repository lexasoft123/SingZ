#include "native_playback_graph_document.h"

#include "signalsmith_time_pitch.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <initializer_list>
#include <limits>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <utility>

namespace singz {
namespace {

constexpr uint64_t kSongMixNode = 1000;
constexpr uint64_t kSongGainNode = 1001;
constexpr uint64_t kTimePitchNode = 1002;
constexpr uint64_t kCueSourceNode = 1100;
constexpr uint64_t kCueMapNode = 1101;
constexpr uint64_t kReferenceGainNode = 1102;
constexpr uint64_t kOutputMixNode = 1200;
constexpr uint64_t kOutputGainNode = 1201;
constexpr uint64_t kLimiterNode = 1202;
constexpr uint64_t kOutputNode = 1203;

constexpr std::string_view kProjectLaneBinding = "project-lane";
constexpr std::string_view kSongMasterBinding = "song-master";
constexpr std::string_view kReferenceCueBinding = "reference-cues";
// No kReferenceGainBinding: `Gain` covers BOTH the song master and the
// reference gain, so its shape check cannot pin one binding — song-master is
// checked where only it can appear, and reference-gain in the session.
constexpr std::string_view kProjectOutputBinding = "project-output";

bool stableName(const std::string &value) noexcept {
  if (value.empty() || value.size() > 128)
    return false;
  for (const unsigned char character : value)
    if (character < 0x20 || character == 0x7f)
      return false;
  return true;
}

NativePlaybackGraphMaterializeResult fail(
    NativePlaybackGraphDocumentError error, std::string message,
    uint64_t node = 0, uint32_t port = 0) {
  NativePlaybackGraphMaterializeResult result;
  result.error = error;
  result.node = node;
  result.port = port;
  result.message = std::move(message);
  return result;
}

uint64_t stableLaneNodeId(std::string_view lane, std::string_view role) noexcept {
  // FNV-1a is used only as a deterministic persistence identity. Every result
  // is checked for collisions before compilation, so a collision is a clean
  // prepare error rather than an alias or an order-dependent probe.
  uint64_t value = UINT64_C(14695981039346656037);
  auto append = [&](std::string_view text) {
    for (const unsigned char character : text) {
      value ^= character;
      value *= UINT64_C(1099511628211);
    }
  };
  append("singz.graph.lane.v1");
  append(role);
  append(lane);
  value |= UINT64_C(0x4000000000000000);
  if (value == 0)
    value = 1;
  return value;
}

NativePlaybackGraphPort port(std::string id, uint32_t channels) {
  return {std::move(id), channels};
}

NativePlaybackGraphBinding binding(std::string kind,
                                   std::string lane = {}) {
  return {std::move(kind), std::move(lane)};
}

NativePlaybackGraphNode node(
    uint64_t id, zdsp::NodeTypeId type, std::string execution,
    std::vector<NativePlaybackGraphPort> inputs,
    std::vector<NativePlaybackGraphPort> outputs,
    std::optional<NativePlaybackGraphBinding> nodeBinding = std::nullopt,
    std::vector<NativePlaybackGraphParameter> parameters = {},
    NativePlaybackGraphUnavailablePolicy unavailable =
        NativePlaybackGraphUnavailablePolicy::Silence) {
  NativePlaybackGraphNode result;
  result.id = id;
  result.type = type;
  result.typeVersion = 1;
  result.execution = std::move(execution);
  result.unavailable = unavailable;
  result.inputs = std::move(inputs);
  result.outputs = std::move(outputs);
  result.parameters = std::move(parameters);
  result.binding = std::move(nodeBinding);
  return result;
}

void connect(NativePlaybackGraphDocument *document, uint64_t from,
             std::string fromPort, uint64_t to, std::string toPort) {
  document->connections.push_back(
      {{from, std::move(fromPort)}, {to, std::move(toPort)}});
}

bool executionMatches(NativePlaybackGraphMaterializedKind kind,
                      const std::string &execution) noexcept {
  switch (kind) {
    case NativePlaybackGraphMaterializedKind::ChannelMap:
    case NativePlaybackGraphMaterializedKind::Gain:
    case NativePlaybackGraphMaterializedKind::Mix:
    case NativePlaybackGraphMaterializedKind::PeakRms:
    case NativePlaybackGraphMaterializedKind::Tap:
    case NativePlaybackGraphMaterializedKind::Oscillator:
    case NativePlaybackGraphMaterializedKind::SafetyLimiter:
      return execution == "builtin";
    case NativePlaybackGraphMaterializedKind::ProjectLaneSource:
    case NativePlaybackGraphMaterializedKind::TrainingDuck:
    case NativePlaybackGraphMaterializedKind::SignalsmithTimePitch:
    case NativePlaybackGraphMaterializedKind::CueSource:
    case NativePlaybackGraphMaterializedKind::PhysicalOutput:
      return execution == "native";
    case NativePlaybackGraphMaterializedKind::PlaceholderBypass:
    case NativePlaybackGraphMaterializedKind::PlaceholderSilence:
      return true;
  }
  return false;
}

NativePlaybackGraphMaterializedKind resolveKind(
    const NativePlaybackGraphNode &value) noexcept {
  if (nativePlaybackGraphTypeEqual(value.type, kGraphTypeProjectLaneSource))
    return NativePlaybackGraphMaterializedKind::ProjectLaneSource;
  if (nativePlaybackGraphTypeEqual(value.type, kGraphTypeChannelMap))
    return NativePlaybackGraphMaterializedKind::ChannelMap;
  if (nativePlaybackGraphTypeEqual(value.type, kGraphTypeGain))
    return NativePlaybackGraphMaterializedKind::Gain;
  if (nativePlaybackGraphTypeEqual(value.type, kGraphTypeMix))
    return NativePlaybackGraphMaterializedKind::Mix;
  if (nativePlaybackGraphTypeEqual(value.type, kGraphTypeTrainingDuck))
    return NativePlaybackGraphMaterializedKind::TrainingDuck;
  if (nativePlaybackGraphTypeEqual(value.type, kGraphTypeSignalsmithTimePitch))
    return NativePlaybackGraphMaterializedKind::SignalsmithTimePitch;
  if (nativePlaybackGraphTypeEqual(value.type, kGraphTypeCueSource))
    return NativePlaybackGraphMaterializedKind::CueSource;
  if (nativePlaybackGraphTypeEqual(value.type, kGraphTypePeakRms))
    return NativePlaybackGraphMaterializedKind::PeakRms;
  if (nativePlaybackGraphTypeEqual(value.type, kGraphTypeTap))
    return NativePlaybackGraphMaterializedKind::Tap;
  if (nativePlaybackGraphTypeEqual(value.type, kGraphTypeOscillator))
    return NativePlaybackGraphMaterializedKind::Oscillator;
  if (nativePlaybackGraphTypeEqual(value.type, kGraphTypeSafetyLimiter))
    return NativePlaybackGraphMaterializedKind::SafetyLimiter;
  if (nativePlaybackGraphTypeEqual(value.type, kGraphTypePhysicalOutput))
    return NativePlaybackGraphMaterializedKind::PhysicalOutput;
  // An external adapter is a known but deliberately unavailable factory in
  // this target. Unknown future type IDs take the same explicit policy path.
  return value.unavailable == NativePlaybackGraphUnavailablePolicy::Bypass
             ? NativePlaybackGraphMaterializedKind::PlaceholderBypass
             : NativePlaybackGraphMaterializedKind::PlaceholderSilence;
}

bool bindingIs(const NativePlaybackGraphNode &value,
               std::string_view kind) noexcept {
  return value.binding.has_value() && value.binding->kind == kind;
}

bool sameChannels(const std::vector<NativePlaybackGraphPort> &ports,
                  uint32_t channels) noexcept {
  return std::all_of(ports.begin(), ports.end(), [channels](const auto &entry) {
    return entry.channels == channels;
  });
}

bool exactShape(const NativePlaybackGraphNode &value, size_t inputs,
                size_t outputs) noexcept {
  return value.inputs.size() == inputs && value.outputs.size() == outputs;
}

bool knownParameters(const NativePlaybackGraphNode &value,
                     std::initializer_list<std::string_view> allowed,
                     std::initializer_list<std::string_view> required = {}) {
  for (const NativePlaybackGraphParameter &parameter : value.parameters) {
    if (std::none_of(allowed.begin(), allowed.end(), [&](std::string_view id) {
          return parameter.id == id;
        }))
      return false;
  }
  for (const std::string_view id : required)
    if (std::none_of(value.parameters.begin(), value.parameters.end(),
                     [&](const auto &parameter) { return parameter.id == id; }))
      return false;
  return true;
}

bool validShape(const NativePlaybackGraphMaterializedNode &resolved) noexcept {
  const NativePlaybackGraphNode &value = resolved.document;
  switch (resolved.kind) {
    case NativePlaybackGraphMaterializedKind::ProjectLaneSource:
      return exactShape(value, 0, 1) &&
             bindingIs(value, kProjectLaneBinding) &&
             knownParameters(value, {});
    case NativePlaybackGraphMaterializedKind::ChannelMap:
      return exactShape(value, 1, 1) && knownParameters(value, {});
    case NativePlaybackGraphMaterializedKind::Gain:
      return exactShape(value, 1, 1) &&
             value.inputs[0].channels == value.outputs[0].channels &&
             knownParameters(value, {"gain"}, {"gain"});
    case NativePlaybackGraphMaterializedKind::Mix:
      return !value.inputs.empty() && value.outputs.size() == 1 &&
             sameChannels(value.inputs, value.outputs[0].channels) &&
             knownParameters(value, {});
    case NativePlaybackGraphMaterializedKind::TrainingDuck:
      return exactShape(value, 1, 1) &&
             value.inputs[0].channels == value.outputs[0].channels &&
             bindingIs(value, kProjectLaneBinding) &&
             knownParameters(value, {});
    case NativePlaybackGraphMaterializedKind::SignalsmithTimePitch:
      return exactShape(value, 1, 1) &&
             value.inputs[0].channels == value.outputs[0].channels &&
             knownParameters(value, {});
    case NativePlaybackGraphMaterializedKind::CueSource:
      return exactShape(value, 0, 1) && value.outputs[0].channels == 1 &&
             bindingIs(value, kReferenceCueBinding) &&
             knownParameters(value, {});
    case NativePlaybackGraphMaterializedKind::PeakRms:
      return exactShape(value, 1, 1) &&
             value.inputs[0].channels == value.outputs[0].channels &&
             knownParameters(value, {});
    case NativePlaybackGraphMaterializedKind::Tap:
      return exactShape(value, 1, 1) &&
             value.inputs[0].channels == value.outputs[0].channels &&
             knownParameters(value, {"window"}, {"window"});
    case NativePlaybackGraphMaterializedKind::Oscillator:
      return exactShape(value, 0, 1) &&
             knownParameters(value, {"frequency", "amplitude"},
                             {"frequency", "amplitude"});
    case NativePlaybackGraphMaterializedKind::SafetyLimiter:
      return exactShape(value, 1, 1) &&
             value.inputs[0].channels == value.outputs[0].channels &&
             knownParameters(value, {"ceiling"}, {"ceiling"});
    case NativePlaybackGraphMaterializedKind::PhysicalOutput:
      return exactShape(value, 1, 0) &&
             bindingIs(value, kProjectOutputBinding) &&
             knownParameters(value, {});
    case NativePlaybackGraphMaterializedKind::PlaceholderBypass:
      return exactShape(value, 1, 1) &&
             value.inputs[0].channels == value.outputs[0].channels;
    case NativePlaybackGraphMaterializedKind::PlaceholderSilence:
      return value.outputs.size() == 1 && value.inputs.size() <= 1 &&
             (value.inputs.empty() ||
              value.inputs[0].channels == value.outputs[0].channels);
  }
  return false;
}

uint32_t portIndex(const std::vector<NativePlaybackGraphPort> &ports,
                   const std::string &id) noexcept {
  for (uint32_t index = 0; index < ports.size(); ++index)
    if (ports[index].id == id)
      return index;
  return std::numeric_limits<uint32_t>::max();
}

}  // namespace

bool nativePlaybackGraphTypeEqual(zdsp::NodeTypeId left,
                                  zdsp::NodeTypeId right) noexcept {
  return left.high == right.high && left.low == right.low;
}

const char *nativePlaybackGraphTypeHex(zdsp::NodeTypeId type) noexcept {
  if (nativePlaybackGraphTypeEqual(type, kGraphTypeProjectLaneSource))
    return "73696e677a2d64737000000000000001";
  if (nativePlaybackGraphTypeEqual(type, kGraphTypeChannelMap))
    return "73696e677a2d64737000000000000002";
  if (nativePlaybackGraphTypeEqual(type, kGraphTypeGain))
    return "73696e677a2d64737000000000000003";
  if (nativePlaybackGraphTypeEqual(type, kGraphTypeMix))
    return "73696e677a2d64737000000000000004";
  if (nativePlaybackGraphTypeEqual(type, kGraphTypeTrainingDuck))
    return "73696e677a2d64737000000000000005";
  if (nativePlaybackGraphTypeEqual(type, kGraphTypeSignalsmithTimePitch))
    return "73696e677a2d64737000000000000006";
  if (nativePlaybackGraphTypeEqual(type, kGraphTypeCueSource))
    return "73696e677a2d64737000000000000007";
  if (nativePlaybackGraphTypeEqual(type, kGraphTypePeakRms))
    return "73696e677a2d64737000000000000008";
  if (nativePlaybackGraphTypeEqual(type, kGraphTypeTap))
    return "73696e677a2d64737000000000000009";
  if (nativePlaybackGraphTypeEqual(type, kGraphTypeOscillator))
    return "73696e677a2d6473700000000000000a";
  if (nativePlaybackGraphTypeEqual(type, kGraphTypeSafetyLimiter))
    return "73696e677a2d6473700000000000000b";
  if (nativePlaybackGraphTypeEqual(type, kGraphTypePhysicalOutput))
    return "73696e677a2d6473700000000000000c";
  if (nativePlaybackGraphTypeEqual(type, kGraphTypeExternalAdapter))
    return "73696e677a2d6473700000000000000d";
  return "unknown";
}

NativePlaybackGraphDocument synthesizeNativePlaybackGraphDocument(
    const NativePlaybackGraphContext &context) {
  NativePlaybackGraphDocument document;
  const uint32_t outputChannels = context.outputChannels;
  std::vector<NativePlaybackGraphPort> songInputs;
  songInputs.reserve(context.lanes.size());
  for (const NativePlaybackGraphLaneContext &lane : context.lanes) {
    const uint64_t source = stableLaneNodeId(lane.id, "source");
    const uint64_t map = stableLaneNodeId(lane.id, "map");
    const uint64_t gain = stableLaneNodeId(lane.id, "gain");
    const uint64_t training = stableLaneNodeId(lane.id, "training");
    document.nodes.push_back(node(
        source, kGraphTypeProjectLaneSource, "native", {},
        {port("out", lane.sourceChannels)}, binding("project-lane", lane.id)));
    document.nodes.push_back(node(
        map, kGraphTypeChannelMap, "builtin",
        {port("in", lane.sourceChannels)}, {port("out", outputChannels)},
        binding("project-lane", lane.id)));
    document.nodes.push_back(node(
        gain, kGraphTypeGain, "builtin", {port("in", outputChannels)},
        {port("out", outputChannels)}, binding("project-lane", lane.id),
        {{"gain", 1.0}}));
    connect(&document, source, "out", map, "in");
    connect(&document, map, "out", gain, "in");
    uint64_t laneOutput = gain;
    if (context.hasTraining && lane.trainingSelected) {
      document.nodes.push_back(node(
          training, kGraphTypeTrainingDuck, "native",
          {port("in", outputChannels)}, {port("out", outputChannels)},
          binding("project-lane", lane.id)));
      connect(&document, gain, "out", training, "in");
      laneOutput = training;
    }
    const std::string input = "lane:" + lane.id;
    songInputs.push_back(port(input, outputChannels));
    connect(&document, laneOutput, "out", kSongMixNode, input);
  }

  document.nodes.push_back(node(kSongMixNode, kGraphTypeMix, "builtin",
                                std::move(songInputs),
                                {port("out", outputChannels)}));
  document.nodes.push_back(node(
      kSongGainNode, kGraphTypeGain, "builtin",
      {port("in", outputChannels)}, {port("out", outputChannels)},
      binding("song-master"), {{"gain", 1.0}}));
  connect(&document, kSongMixNode, "out", kSongGainNode, "in");
  uint64_t processedSong = kSongGainNode;
  if (context.needsTimePitch) {
    document.nodes.push_back(node(
        kTimePitchNode, kGraphTypeSignalsmithTimePitch, "native",
        {port("in", outputChannels)}, {port("out", outputChannels)}));
    connect(&document, kSongGainNode, "out", kTimePitchNode, "in");
    processedSong = kTimePitchNode;
  }
  if (context.hasReference) {
    document.nodes.push_back(node(
        kCueSourceNode, kGraphTypeCueSource, "native", {}, {port("out", 1)},
        binding("reference-cues")));
    document.nodes.push_back(node(
        kCueMapNode, kGraphTypeChannelMap, "builtin", {port("in", 1)},
        {port("out", outputChannels)}, binding("reference-map")));
    document.nodes.push_back(node(
        kReferenceGainNode, kGraphTypeGain, "builtin",
        {port("in", outputChannels)}, {port("out", outputChannels)},
        binding("reference-gain"), {{"gain", 1.0}}));
    document.nodes.push_back(node(
        kOutputMixNode, kGraphTypeMix, "builtin",
        {port("song", outputChannels), port("reference", outputChannels)},
        {port("out", outputChannels)}));
    document.nodes.push_back(node(
        kOutputGainNode, kGraphTypeGain, "builtin",
        {port("in", outputChannels)}, {port("out", outputChannels)},
        binding("output-gain"), {{"gain", 1.0}}));
    connect(&document, kCueSourceNode, "out", kCueMapNode, "in");
    connect(&document, kCueMapNode, "out", kReferenceGainNode, "in");
    connect(&document, processedSong, "out", kOutputMixNode, "song");
    connect(&document, kReferenceGainNode, "out", kOutputMixNode, "reference");
    connect(&document, kOutputMixNode, "out", kOutputGainNode, "in");
    processedSong = kOutputGainNode;
  }
  document.nodes.push_back(node(
      kLimiterNode, kGraphTypeSafetyLimiter, "builtin",
      {port("in", outputChannels)}, {port("out", outputChannels)},
      std::nullopt, {{"ceiling", 0.891250938}}));
  document.nodes.push_back(node(
      kOutputNode, kGraphTypePhysicalOutput, "native",
      {port("in", outputChannels)}, {}, binding("project-output")));
  connect(&document, processedSong, "out", kLimiterNode, "in");
  connect(&document, kLimiterNode, "out", kOutputNode, "in");
  return document;
}

size_t synthesizedNativePlaybackGraphNodeCount(
    const NativePlaybackGraphContext &context) noexcept {
  const size_t selected = static_cast<size_t>(std::count_if(
      context.lanes.begin(), context.lanes.end(),
      [](const NativePlaybackGraphLaneContext &lane) {
        return lane.trainingSelected;
      }));
  return context.lanes.size() * 3u + selected + 4u +
         (context.needsTimePitch ? 1u : 0u) +
         (context.hasReference ? 5u : 0u);
}

NativePlaybackGraphMaterializeResult materializeNativePlaybackGraphDocument(
    NativePlaybackGraphDocument document,
    const NativePlaybackGraphContext &context) {
  if (document.format != kNativePlaybackGraphDocumentFormat ||
      document.engine != kNativePlaybackGraphDocumentEngine)
    return fail(NativePlaybackGraphDocumentError::InvalidEnvelope,
                "The native graph envelope is unsupported");
  if (document.nodes.empty() ||
      document.nodes.size() > zdsp::kMaximumGraphNodes ||
      document.connections.size() > zdsp::kMaximumGraphConnections)
    return fail(NativePlaybackGraphDocumentError::LimitExceeded,
                "The native graph exceeds runtime topology caps");
  if (context.lanes.empty() || context.outputChannels == 0 ||
      context.outputChannels > zdsp::kMaximumChannelsPerBus)
    return fail(NativePlaybackGraphDocumentError::InvalidBinding,
                "The native graph context is invalid");

  NativePlaybackGraphMaterializeResult result;
  result.graph.nodes.reserve(document.nodes.size());
  result.graph.connections.reserve(document.connections.size());
  std::unordered_map<uint64_t, size_t> nodes;
  std::unordered_map<std::string, size_t> lanes;
  for (size_t index = 0; index < context.lanes.size(); ++index) {
    if (!stableName(context.lanes[index].id) ||
        context.lanes[index].sourceChannels == 0 ||
        context.lanes[index].sourceChannels > zdsp::kMaximumChannelsPerBus ||
        !lanes.emplace(context.lanes[index].id, index).second)
      return fail(NativePlaybackGraphDocumentError::InvalidBinding,
                  "The native graph lane context is invalid");
  }

  std::unordered_map<std::string, uint32_t> sourceBindingCount;
  std::unordered_map<std::string, uint32_t> gainBindingCount;
  std::unordered_map<std::string, uint32_t> trainingBindingCount;
  uint32_t outputCount = 0;
  uint32_t masterCount = 0;
  uint32_t cueCount = 0;
  uint32_t signalsmithCount = 0;
  for (NativePlaybackGraphNode &value : document.nodes) {
    if (value.id == 0 || value.typeVersion == 0)
      return fail(NativePlaybackGraphDocumentError::InvalidNode,
                  "A native graph node identity is invalid", value.id);
    if (!nodes.emplace(value.id, result.graph.nodes.size()).second)
      return fail(NativePlaybackGraphDocumentError::DuplicateNode,
                  "The native graph repeats a node ID", value.id);
    if (!stableName(value.execution))
      return fail(NativePlaybackGraphDocumentError::InvalidExecution,
                  "A native graph execution identity is invalid", value.id);
    if (value.inputs.size() > zdsp::kMaximumBusesPerProcessor ||
        value.outputs.size() > zdsp::kMaximumBusesPerProcessor ||
        value.parameters.size() >
            kNativePlaybackGraphMaximumParametersPerNode)
      return fail(NativePlaybackGraphDocumentError::LimitExceeded,
                  "A native graph node exceeds its port or parameter cap",
                  value.id);
    for (const auto *ports : {&value.inputs, &value.outputs}) {
      std::unordered_set<std::string> ids;
      for (uint32_t portNumber = 0; portNumber < ports->size(); ++portNumber) {
        const NativePlaybackGraphPort &entry = (*ports)[portNumber];
        if (!stableName(entry.id) || entry.channels == 0 ||
            entry.channels > zdsp::kMaximumChannelsPerBus ||
            !ids.insert(entry.id).second)
          return fail(NativePlaybackGraphDocumentError::InvalidPort,
                      "A native graph port is invalid or duplicated", value.id,
                      portNumber);
      }
    }
    std::unordered_set<std::string> parameterIds;
    for (const NativePlaybackGraphParameter &parameter : value.parameters) {
      if (!stableName(parameter.id) ||
          !std::isfinite(parameter.normalizedValue) ||
          parameter.normalizedValue < 0.0 || parameter.normalizedValue > 1.0 ||
          !parameterIds.insert(parameter.id).second)
        return fail(NativePlaybackGraphDocumentError::InvalidParameter,
                    "A native graph parameter is invalid or duplicated",
                    value.id);
    }
    if (value.binding.has_value() &&
        (!stableName(value.binding->kind) ||
         (!value.binding->laneId.empty() &&
          !stableName(value.binding->laneId))))
      return fail(NativePlaybackGraphDocumentError::InvalidBinding,
                  "A native graph logical binding is invalid", value.id);

    NativePlaybackGraphMaterializedNode resolved;
    resolved.kind = resolveKind(value);
    // Supported factories are schema-versioned. A newer known schema does not
    // get guessed: it uses the persisted unavailable policy just like an
    // unavailable adapter.
    const bool isUnavailableAdapter =
        nativePlaybackGraphTypeEqual(value.type, kGraphTypeExternalAdapter);
    if ((resolved.kind !=
             NativePlaybackGraphMaterializedKind::PlaceholderBypass &&
         resolved.kind !=
             NativePlaybackGraphMaterializedKind::PlaceholderSilence) &&
        value.typeVersion != 1) {
      resolved.kind =
          value.unavailable == NativePlaybackGraphUnavailablePolicy::Bypass
              ? NativePlaybackGraphMaterializedKind::PlaceholderBypass
              : NativePlaybackGraphMaterializedKind::PlaceholderSilence;
    } else if (isUnavailableAdapter) {
      resolved.kind =
          value.unavailable == NativePlaybackGraphUnavailablePolicy::Bypass
              ? NativePlaybackGraphMaterializedKind::PlaceholderBypass
              : NativePlaybackGraphMaterializedKind::PlaceholderSilence;
    }
    if (!executionMatches(resolved.kind, value.execution))
      return fail(NativePlaybackGraphDocumentError::InvalidExecution,
                  "A known graph node has an incompatible execution domain",
                  value.id);
    resolved.document = std::move(value);
    if (!validShape(resolved))
      return fail(
          resolved.kind == NativePlaybackGraphMaterializedKind::PlaceholderBypass ||
                  resolved.kind ==
                      NativePlaybackGraphMaterializedKind::PlaceholderSilence
              ? NativePlaybackGraphDocumentError::InvalidPlaceholder
              : NativePlaybackGraphDocumentError::UnsupportedSemanticTopology,
          "A graph node does not satisfy its processor port/parameter schema",
          resolved.document.id);

    const NativePlaybackGraphNode &stored = resolved.document;
    if (stored.binding.has_value() &&
        stored.binding->kind == kProjectLaneBinding) {
      const auto lane = lanes.find(stored.binding->laneId);
      if (lane == lanes.end())
        return fail(NativePlaybackGraphDocumentError::MissingLane,
                    "A graph node binds an unavailable project lane",
                    stored.id);
      if (resolved.kind == NativePlaybackGraphMaterializedKind::ProjectLaneSource) {
        if (stored.outputs[0].channels !=
                context.lanes[lane->second].sourceChannels ||
            ++sourceBindingCount[stored.binding->laneId] != 1)
          return fail(NativePlaybackGraphDocumentError::DuplicateLaneBinding,
                      "A project lane source binding is duplicated or has the wrong channel count",
                      stored.id);
      } else if (resolved.kind == NativePlaybackGraphMaterializedKind::Gain) {
        if (++gainBindingCount[stored.binding->laneId] != 1)
          return fail(NativePlaybackGraphDocumentError::DuplicateLaneBinding,
                      "A project lane gain binding is duplicated", stored.id);
      } else if (resolved.kind ==
                 NativePlaybackGraphMaterializedKind::TrainingDuck) {
        if (!context.hasTraining ||
            !context.lanes[lane->second].trainingSelected ||
            ++trainingBindingCount[stored.binding->laneId] != 1)
          return fail(NativePlaybackGraphDocumentError::InvalidBinding,
                      "A project lane training binding is unavailable or duplicated",
                      stored.id);
      }
    }
    if (resolved.kind == NativePlaybackGraphMaterializedKind::PhysicalOutput) {
      if (++outputCount != 1 || stored.inputs[0].channels != context.outputChannels)
        return fail(NativePlaybackGraphDocumentError::InvalidBinding,
                    "The graph must expose one matching physical output",
                    stored.id);
    }
    if (resolved.kind == NativePlaybackGraphMaterializedKind::Gain &&
        bindingIs(stored, kSongMasterBinding)) {
      if (++masterCount != 1)
        return fail(NativePlaybackGraphDocumentError::InvalidBinding,
                    "The song-master gain binding is duplicated", stored.id);
      result.graph.masterGainNode = stored.id;
    }
    if (resolved.kind == NativePlaybackGraphMaterializedKind::CueSource) {
      if (++cueCount != 1 || !context.hasReference)
        return fail(NativePlaybackGraphDocumentError::InvalidBinding,
                    "The cue source does not match the prepared reference bus",
                    stored.id);
      result.graph.cueSourceNode = stored.id;
    }
    if (resolved.kind ==
        NativePlaybackGraphMaterializedKind::SignalsmithTimePitch) {
      if (++signalsmithCount != 1 ||
          stored.inputs[0].channels > kSignalsmithTimePitchMaximumChannels)
        return fail(NativePlaybackGraphDocumentError::InvalidBinding,
                    "The Signalsmith processor binding is duplicated or exceeds its channel cap",
                    stored.id);
      result.graph.signalsmithNode = stored.id;
    }
    result.graph.nodes.push_back(std::move(resolved));
  }

  for (const NativePlaybackGraphLaneContext &lane : context.lanes) {
    if (sourceBindingCount[lane.id] != 1 || gainBindingCount[lane.id] != 1 ||
        (lane.trainingSelected && trainingBindingCount[lane.id] != 1))
      return fail(NativePlaybackGraphDocumentError::RequiredSemanticNodeMissing,
                  "Every prepared project lane needs one source, gain, and selected training binding");
  }
  if (outputCount != 1 || masterCount != 1 ||
      (context.hasReference && cueCount != 1) ||
      (!context.hasReference && cueCount != 0) ||
      (context.needsTimePitch && signalsmithCount != 1))
    return fail(NativePlaybackGraphDocumentError::RequiredSemanticNodeMissing,
                "The graph omits a required song/output/reference processor");

  std::unordered_set<std::string> edges;
  std::unordered_set<std::string> producedInputs;
  std::vector<uint32_t> indegree(result.graph.nodes.size(), 0);
  std::vector<std::vector<size_t>> outgoing(result.graph.nodes.size());
  for (const NativePlaybackGraphConnection &connection : document.connections) {
    const auto source = nodes.find(connection.from.node);
    const auto destination = nodes.find(connection.to.node);
    if (source == nodes.end() || destination == nodes.end())
      return fail(NativePlaybackGraphDocumentError::InvalidConnection,
                  "A graph connection names an unavailable node");
    const NativePlaybackGraphNode &sourceNode =
        result.graph.nodes[source->second].document;
    const NativePlaybackGraphNode &destinationNode =
        result.graph.nodes[destination->second].document;
    const uint32_t sourcePort = portIndex(sourceNode.outputs, connection.from.port);
    const uint32_t destinationPort =
        portIndex(destinationNode.inputs, connection.to.port);
    if (sourcePort == std::numeric_limits<uint32_t>::max() ||
        destinationPort == std::numeric_limits<uint32_t>::max() ||
        sourceNode.outputs[sourcePort].channels !=
            destinationNode.inputs[destinationPort].channels)
      return fail(NativePlaybackGraphDocumentError::InvalidConnection,
                  "A graph connection has an unavailable or incompatible port",
                  destinationNode.id, destinationPort);
    const std::string key = std::to_string(connection.from.node) + "\n" +
                            connection.from.port + "\n" +
                            std::to_string(connection.to.node) + "\n" +
                            connection.to.port;
    const std::string input = std::to_string(connection.to.node) + "\n" +
                              connection.to.port;
    if (!edges.insert(key).second)
      return fail(NativePlaybackGraphDocumentError::DuplicateConnection,
                  "The graph repeats a connection", destinationNode.id,
                  destinationPort);
    if (!producedInputs.insert(input).second)
      return fail(NativePlaybackGraphDocumentError::InvalidConnection,
                  "A graph input has multiple producers", destinationNode.id,
                  destinationPort);
    result.graph.connections.push_back(
        {{connection.from.node}, sourcePort, {connection.to.node},
         destinationPort});
    ++indegree[destination->second];
    outgoing[source->second].push_back(destination->second);
  }
  for (const NativePlaybackGraphMaterializedNode &value : result.graph.nodes)
    for (const NativePlaybackGraphPort &input : value.document.inputs)
      if (!producedInputs.contains(std::to_string(value.document.id) + "\n" +
                                   input.id))
        return fail(NativePlaybackGraphDocumentError::InvalidConnection,
                    "Every graph input requires exactly one producer",
                    value.document.id);

  std::vector<size_t> ready;
  for (size_t index = 0; index < indegree.size(); ++index)
    if (indegree[index] == 0)
      ready.push_back(index);
  size_t visited = 0;
  while (!ready.empty()) {
    const size_t current = ready.back();
    ready.pop_back();
    ++visited;
    for (const size_t next : outgoing[current])
      if (--indegree[next] == 0)
        ready.push_back(next);
  }
  if (visited != result.graph.nodes.size())
    return fail(NativePlaybackGraphDocumentError::UnsupportedSemanticTopology,
                "The native graph contains a cycle");

  // Signalsmith seek/loop re-anchoring is primed from the retained lane PCM,
  // not by executing an audio callback off-line. Until the anchor renderer is
  // generalized, require the documented song branch it can reproduce exactly:
  // one source -> map -> lane gain -> optional training path per logical lane,
  // a single song mix/master, then Signalsmith. Other valid document topology
  // remains supported when no time/pitch node is present.
  if (result.graph.signalsmithNode != 0) {
    const auto resolvedIndex = [&](uint64_t id) -> size_t {
      const auto found = nodes.find(id);
      return found == nodes.end() ? result.graph.nodes.size() : found->second;
    };
    const auto producer = [&](uint64_t destination,
                              uint32_t destinationBus) -> uint64_t {
      for (const auto &connection : result.graph.connections)
        if (connection.destinationNode.value == destination &&
            connection.destinationBus == destinationBus)
          return connection.sourceNode.value;
      return 0;
    };
    const auto laneBinding = [](const NativePlaybackGraphMaterializedNode &node)
        -> const std::string * {
      return node.document.binding.has_value() &&
                     node.document.binding->kind == kProjectLaneBinding
                 ? &node.document.binding->laneId
                 : nullptr;
    };
    const size_t signalsmithIndex = resolvedIndex(result.graph.signalsmithNode);
    const uint64_t masterId = producer(result.graph.signalsmithNode, 0);
    const size_t masterIndex = resolvedIndex(masterId);
    if (signalsmithIndex == result.graph.nodes.size() ||
        masterId != result.graph.masterGainNode ||
        masterIndex == result.graph.nodes.size())
      return fail(NativePlaybackGraphDocumentError::UnsupportedSemanticTopology,
                  "The Signalsmith input must be the bound song-master gain",
                  result.graph.signalsmithNode);
    const uint64_t mixId = producer(masterId, 0);
    const size_t mixIndex = resolvedIndex(mixId);
    if (mixIndex == result.graph.nodes.size() ||
        result.graph.nodes[mixIndex].kind !=
            NativePlaybackGraphMaterializedKind::Mix ||
        result.graph.nodes[mixIndex].document.inputs.size() != context.lanes.size())
      return fail(NativePlaybackGraphDocumentError::UnsupportedSemanticTopology,
                  "The Signalsmith anchor requires one complete project-lane mix",
                  mixId);
    std::unordered_set<std::string> anchoredLanes;
    for (uint32_t bus = 0;
         bus < result.graph.nodes[mixIndex].document.inputs.size(); ++bus) {
      uint64_t laneTailId = producer(mixId, bus);
      size_t laneTailIndex = resolvedIndex(laneTailId);
      if (laneTailIndex == result.graph.nodes.size())
        return fail(NativePlaybackGraphDocumentError::UnsupportedSemanticTopology,
                    "A Signalsmith lane branch is incomplete", mixId, bus);
      const NativePlaybackGraphMaterializedNode *laneTail =
          &result.graph.nodes[laneTailIndex];
      const std::string *lane = laneBinding(*laneTail);
      if (laneTail->kind == NativePlaybackGraphMaterializedKind::TrainingDuck) {
        laneTailId = producer(laneTailId, 0);
        laneTailIndex = resolvedIndex(laneTailId);
        if (laneTailIndex == result.graph.nodes.size())
          return fail(NativePlaybackGraphDocumentError::UnsupportedSemanticTopology,
                      "A Signalsmith training branch is incomplete", mixId,
                      bus);
        laneTail = &result.graph.nodes[laneTailIndex];
      }
      if (lane == nullptr)
        lane = laneBinding(*laneTail);
      if (laneTail->kind != NativePlaybackGraphMaterializedKind::Gain ||
          lane == nullptr || !anchoredLanes.insert(*lane).second)
        return fail(NativePlaybackGraphDocumentError::UnsupportedSemanticTopology,
                    "Signalsmith requires one gain branch per logical lane",
                    laneTail->document.id);
      const uint64_t mapId = producer(laneTail->document.id, 0);
      const size_t mapIndex = resolvedIndex(mapId);
      if (mapIndex == result.graph.nodes.size() ||
          result.graph.nodes[mapIndex].kind !=
              NativePlaybackGraphMaterializedKind::ChannelMap ||
          laneBinding(result.graph.nodes[mapIndex]) == nullptr ||
          *laneBinding(result.graph.nodes[mapIndex]) != *lane)
        return fail(NativePlaybackGraphDocumentError::UnsupportedSemanticTopology,
                    "Signalsmith requires the canonical logical-lane map",
                    mapId);
      const uint64_t sourceId = producer(mapId, 0);
      const size_t sourceIndex = resolvedIndex(sourceId);
      if (sourceIndex == result.graph.nodes.size() ||
          result.graph.nodes[sourceIndex].kind !=
              NativePlaybackGraphMaterializedKind::ProjectLaneSource ||
          laneBinding(result.graph.nodes[sourceIndex]) == nullptr ||
          *laneBinding(result.graph.nodes[sourceIndex]) != *lane)
        return fail(NativePlaybackGraphDocumentError::UnsupportedSemanticTopology,
                    "Signalsmith requires the canonical logical-lane source",
                    sourceId);
    }
    if (anchoredLanes.size() != context.lanes.size())
      return fail(NativePlaybackGraphDocumentError::UnsupportedSemanticTopology,
                  "Signalsmith cannot anchor an incomplete lane set",
                  result.graph.signalsmithNode);
  }
  return result;
}

}  // namespace singz

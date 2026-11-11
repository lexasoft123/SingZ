#pragma once
// Protocol projection of the actual immutable prepared graph. Kept equivalent
// to the desktop addon validator, without loading Node or reconstructing config.
#include <native_playback_session.h>
#include "json_string.h"
#include <algorithm>
#include <cmath>
#include <ostream>
namespace singz::tools {
inline const char *graphNodeRoleName(NativePlaybackGraphNodeRole role) noexcept {
  switch (role) {
  case NativePlaybackGraphNodeRole::Input:
    return "input";
  case NativePlaybackGraphNodeRole::Processor:
    return "processor";
  case NativePlaybackGraphNodeRole::Output:
    return "output";
  }
  return nullptr;
}

inline const char *graphNodeKindName(NativePlaybackGraphNodeKind kind) noexcept {
  switch (kind) {
  case NativePlaybackGraphNodeKind::Unknown:
    return "unknown";
  case NativePlaybackGraphNodeKind::PhysicalOutput:
    return "physical-output";
  case NativePlaybackGraphNodeKind::DecodedSource:
    return "decoded-source";
  case NativePlaybackGraphNodeKind::ChannelMap:
    return "channel-map";
  case NativePlaybackGraphNodeKind::Gain:
    return "gain";
  case NativePlaybackGraphNodeKind::Mix:
    return "mix";
  case NativePlaybackGraphNodeKind::ScheduledGain:
    return "scheduled-gain";
  case NativePlaybackGraphNodeKind::SignalsmithTimePitch:
    return "signalsmith-time-pitch";
  case NativePlaybackGraphNodeKind::ScheduledCueSource:
    return "scheduled-cue-source";
  case NativePlaybackGraphNodeKind::PeakRms:
    return "peak-rms";
  case NativePlaybackGraphNodeKind::Tap:
    return "tap";
  case NativePlaybackGraphNodeKind::Oscillator:
    return "oscillator";
  case NativePlaybackGraphNodeKind::SafetyLimiter:
    return "safety-limiter";
  case NativePlaybackGraphNodeKind::UnavailableBypass:
    return "unavailable-bypass";
  case NativePlaybackGraphNodeKind::UnavailableSilence:
    return "unavailable-silence";
  }
  return nullptr;
}

constexpr size_t kPlaybackGraphMaximumLabelBytes = 256;

inline bool validPlaybackGraphSnapshot(const NativePlaybackStatus &status) noexcept {
  if (status.graphSnapshot == nullptr)
    return false;
  const NativePlaybackGraphSnapshot &snapshot = *status.graphSnapshot;
  if (snapshot.generation != status.generation ||
      snapshot.formatVersion == 0 || !std::isfinite(snapshot.sampleRate) ||
      snapshot.sampleRate <= 0.0 || snapshot.maximumFrames == 0 ||
      snapshot.nodes.empty() ||
      snapshot.nodes.size() > kNativePlaybackMaximumGraphNodes ||
      snapshot.connections.size() >
          kNativePlaybackMaximumGraphConnections ||
      snapshot.nodes.size() != status.graphNodeCount ||
      snapshot.connections.size() != status.graphConnectionCount ||
      snapshot.outputLatencyFrames != status.graphLatencyFrames ||
      snapshot.latencyCompensatedConnectionCount !=
          status.latencyCompensatedEdgeCount)
    return false;

  for (size_t index = 0; index < snapshot.nodes.size(); ++index) {
    const NativePlaybackGraphNodeStatus &node = snapshot.nodes[index];
    if (node.id == 0 || node.label.empty() ||
        node.label.size() > kPlaybackGraphMaximumLabelBytes ||
        graphNodeRoleName(node.role) == nullptr ||
        graphNodeKindName(node.kind) == nullptr ||
        node.inputBusCount > kNativePlaybackMaximumNodeBuses ||
        node.outputBusCount > kNativePlaybackMaximumNodeBuses ||
        node.intrinsicLatencyFrames >
            UINT32_MAX - node.arrivalLatencyFrames ||
        node.outputLatencyFrames !=
            node.arrivalLatencyFrames + node.intrinsicLatencyFrames)
      return false;
    for (size_t prior = 0; prior < index; ++prior)
      if (snapshot.nodes[prior].id == node.id)
        return false;
    for (uint32_t bus = 0; bus < node.inputBusCount; ++bus)
      if (node.inputBusChannels[bus] == 0)
        return false;
    for (uint32_t bus = 0; bus < node.outputBusCount; ++bus)
      if (node.outputBusChannels[bus] == 0)
        return false;
  }

  uint32_t inputBusTotal = 0;
  for (const NativePlaybackGraphNodeStatus &node : snapshot.nodes) {
    if (inputBusTotal > UINT32_MAX - node.inputBusCount)
      return false;
    inputBusTotal += node.inputBusCount;
  }
  if (inputBusTotal != snapshot.connections.size())
    return false;

  uint32_t compensated = 0;
  for (size_t index = 0; index < snapshot.connections.size(); ++index) {
    const NativePlaybackGraphConnectionStatus &connection =
        snapshot.connections[index];
    const auto source = std::find_if(
        snapshot.nodes.begin(), snapshot.nodes.end(), [&](const auto &node) {
          return node.id == connection.sourceNodeId;
        });
    const auto destination = std::find_if(
        snapshot.nodes.begin(), snapshot.nodes.end(), [&](const auto &node) {
          return node.id == connection.destinationNodeId;
        });
    if (source == snapshot.nodes.end() ||
        destination == snapshot.nodes.end() ||
        connection.sourceBus >= source->outputBusCount ||
        connection.destinationBus >= destination->inputBusCount ||
        connection.sourceChannels !=
            source->outputBusChannels[connection.sourceBus] ||
        connection.destinationChannels !=
            destination->inputBusChannels[connection.destinationBus] ||
        connection.sourceChannels != connection.destinationChannels ||
        connection.sourceOutputLatencyFrames != source->outputLatencyFrames ||
        connection.destinationArrivalLatencyFrames <
            connection.sourceOutputLatencyFrames ||
        connection.compensationFrames !=
            connection.destinationArrivalLatencyFrames -
                connection.sourceOutputLatencyFrames ||
        connection.latencyCompensated !=
            (connection.compensationFrames != 0))
      return false;
    for (size_t prior = 0; prior < index; ++prior)
      if (snapshot.connections[prior].destinationNodeId ==
              connection.destinationNodeId &&
          snapshot.connections[prior].destinationBus ==
              connection.destinationBus)
        return false;
    const uint32_t expectedArrival =
        destination->role == NativePlaybackGraphNodeRole::Output
            ? snapshot.outputLatencyFrames
            : destination->arrivalLatencyFrames;
    if (connection.destinationArrivalLatencyFrames != expectedArrival)
      return false;
    if (connection.latencyCompensated)
      ++compensated;
  }
  return compensated == snapshot.latencyCompensatedConnectionCount;
}


inline void writePlaybackGraphSnapshot(std::ostream& out, const NativePlaybackStatus& status) {
  if (!validPlaybackGraphSnapshot(status)) { out << "null"; return; }
  const auto& graph=*status.graphSnapshot;
  out << "{\"generation\":\"" << graph.generation << "\",\"formatVersion\":" << graph.formatVersion
      << ",\"sampleRate\":" << graph.sampleRate << ",\"maximumFrames\":" << graph.maximumFrames
      << ",\"outputLatencyFrames\":" << graph.outputLatencyFrames
      << ",\"latencyCompensatedConnectionCount\":" << graph.latencyCompensatedConnectionCount
      << ",\"nodes\":[";
  for (size_t i=0;i<graph.nodes.size();++i) {
    if(i)out << ',';
    const auto& n=graph.nodes[i];
    out << "{\"id\":\"" << n.id << "\",\"label\":" << jsonString(n.label)
        << ",\"role\":" << jsonString(graphNodeRoleName(n.role))
        << ",\"kind\":" << jsonString(graphNodeKindName(n.kind))
        << ",\"typeHigh\":\"" << n.typeHigh << "\",\"typeLow\":\"" << n.typeLow
        << "\",\"schemaVersion\":" << n.schemaVersion << ",\"flags\":" << n.flags
        << ",\"inputBusCount\":" << n.inputBusCount << ",\"outputBusCount\":" << n.outputBusCount
        << ",\"inputBusChannels\":[";
    for(uint32_t bus=0;bus<n.inputBusCount;++bus){if(bus)out<<',';out<<n.inputBusChannels[bus];}
    out << "],\"outputBusChannels\":[";
    for(uint32_t bus=0;bus<n.outputBusCount;++bus){if(bus)out<<',';out<<n.outputBusChannels[bus];}
    out << "],\"intrinsicLatencyFrames\":" << n.intrinsicLatencyFrames
        << ",\"arrivalLatencyFrames\":" << n.arrivalLatencyFrames
        << ",\"outputLatencyFrames\":" << n.outputLatencyFrames << '}';
  }
  out << "],\"connections\":[";
  for(size_t i=0;i<graph.connections.size();++i) {
    if(i)out << ',';
    const auto& c=graph.connections[i];
    out << "{\"sourceNodeId\":\"" << c.sourceNodeId << "\",\"sourceBus\":" << c.sourceBus
        << ",\"sourceChannels\":" << c.sourceChannels
        << ",\"destinationNodeId\":\"" << c.destinationNodeId << "\",\"destinationBus\":" << c.destinationBus
        << ",\"destinationChannels\":" << c.destinationChannels
        << ",\"sourceOutputLatencyFrames\":" << c.sourceOutputLatencyFrames
        << ",\"destinationArrivalLatencyFrames\":" << c.destinationArrivalLatencyFrames
        << ",\"compensationFrames\":" << c.compensationFrames
        << ",\"latencyCompensated\":" << (c.latencyCompensated?"true":"false") << '}';
  }
  out << "]}";
}
} // namespace singz::tools

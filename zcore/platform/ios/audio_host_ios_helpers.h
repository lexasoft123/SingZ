#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "audio_host_ios_session_signals.h"
#include <zcore/device/audio_host.h>

namespace singz::detail {

enum class IosAudioHostPortKind : uint32_t {
  Unknown,
  BuiltIn,
  Wired,
  Usb,
  BluetoothHfp,
  BluetoothA2dp,
  BluetoothLe,
  AirPlay,
  CarAudio,
  Hdmi,
};

struct IosAudioHostSessionSnapshot {
  uint64_t routeGeneration{0};
  std::string category;
  std::string mode;
  uint64_t categoryOptions{0};
  bool outputActive{false};
  std::string outputUid;
  uint32_t outputChannels{0};
  IosAudioHostPortKind outputKind{IosAudioHostPortKind::Unknown};
  bool inputActive{false};
  bool recordCapable{false};
  std::string inputUid;
  uint32_t inputChannels{0};
  IosAudioHostPortKind inputKind{IosAudioHostPortKind::Unknown};
  bool inputLeaseActive{false};
  uint64_t inputLeaseToken{0};
  uint64_t inputRouteGeneration{0};
  uint64_t inputLeaseRouteGeneration{0};
  std::string inputLeaseUid;
  uint32_t inputLeaseMinimumChannels{0};
  double sampleRate{0.0};
  double ioBufferDurationSeconds{0.0};
  double inputLatencySeconds{0.0};
  double outputLatencySeconds{0.0};
};

struct IosAudioHostPreparedRoute {
  AudioHostFormat format{};
  AudioHostLatency latency{};
  std::vector<int32_t> inputChannelMap;
  std::vector<int32_t> outputChannelMap;
  AudioHostTransport transport{AudioHostTransport::Unknown};
  AudioHostMonitoringSuitability monitoringSuitability{
      AudioHostMonitoringSuitability::Unknown};
};

bool prepareIosAudioHostRoute(const AudioHostConfig &config,
                              const IosAudioHostSessionSnapshot &snapshot,
                              IosAudioHostPreparedRoute *prepared,
                              std::string &error,
                              AudioHostError *errorCode = nullptr);

bool sameIosAudioHostSession(const IosAudioHostSessionSnapshot &left,
                             const IosAudioHostSessionSnapshot &right) noexcept;

AudioHostTransport iosAudioHostTransport(IosAudioHostPortKind kind) noexcept;
AudioHostMonitoringSuitability
iosAudioHostMonitoringSuitability(IosAudioHostPortKind kind) noexcept;

bool validIosAudioHostMaximumFrames(uint32_t providerMaximumFrames,
                                    uint32_t nominalBufferFrames,
                                    uint32_t configuredMaximumFrames) noexcept;

// Terminal cause is durable diagnostic history; physical state is the
// quiescence proof used by owners. Only a live stream is overlaid terminal.
AudioHostState
iosAudioHostReportedState(AudioHostState physical,
                          AudioHostTerminalReason terminalReason) noexcept;

// AudioOutputUnitStop alone does not prove that an AudioUnit lease was
// released. A failed AudioComponentInstanceDispose is process-poisoning
// physical ownership and must remain non-quiescent for session cleanup.
AudioHostState iosAudioHostStateAfterDispose(AudioHostState previous,
                                             bool disposed) noexcept;

} // namespace singz::detail

#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include <zcore/device/audio_host.h>

namespace singz::detail {

struct AndroidAudioHostDevice {
  int32_t deviceId{0};
  std::string uid;
  std::string label;
  bool input{false};
  bool output{false};
  uint32_t channels{0};
  double nominalSampleRate{0.0};
  std::vector<double> sampleRates;
  AudioHostTransport transport{AudioHostTransport::Unknown};
  AudioHostMonitoringSuitability monitoringSuitability{
      AudioHostMonitoringSuitability::Unknown};
};

struct AndroidAudioHostInventorySnapshot {
  uint32_t routeGeneration{0};
  std::vector<AndroidAudioHostDevice> devices;
};

struct AndroidAudioHostPreparedRoute {
  uint32_t routeGeneration{0};
  int32_t inputDeviceId{0};
  int32_t outputDeviceId{0};
  uint32_t inputEndpointChannels{0};
  uint32_t outputEndpointChannels{0};
  std::vector<uint32_t> inputChannelMap;
  // Physical output index -> graph output index, or -1 for an unused port.
  std::vector<int32_t> outputChannelMap;
  AudioHostTransport outputTransport{AudioHostTransport::Unknown};
  AudioHostMonitoringSuitability monitoringSuitability{
      AudioHostMonitoringSuitability::Unknown};
};

enum class AndroidAudioHostApi : uint32_t {
  Unknown,
  OpenSles,
  AAudio,
};

enum class AndroidAudioHostPerformance : uint32_t {
  Unknown,
  LowLatency,
};

struct AndroidAudioHostOpenedStream {
  int32_t deviceId{0};
  uint32_t channels{0};
  uint32_t sampleRate{0};
  uint32_t framesPerBurst{0};
  uint32_t framesPerCallback{0};
  uint32_t bufferSizeFrames{0};
  uint32_t bufferCapacityFrames{0};
  AndroidAudioHostApi api{AndroidAudioHostApi::Unknown};
  AudioHostSampleFormat format{AudioHostSampleFormat::Unknown};
  AndroidAudioHostPerformance performance{
      AndroidAudioHostPerformance::Unknown};
  AudioHostAccessMode accessMode{AudioHostAccessMode::Shared};
  // Android 14/API 34 added public hardware getters. Zero/Unknown is the
  // honest value on older APIs; callback-boundary facts above remain exact.
  uint32_t hardwareChannels{0};
  uint32_t hardwareSampleRate{0};
  AudioHostSampleFormat hardwareFormat{AudioHostSampleFormat::Unknown};
};

bool prepareAndroidAudioHostRoute(
    const AudioHostConfig& config,
    const AndroidAudioHostInventorySnapshot& snapshot,
    AndroidAudioHostPreparedRoute* prepared, std::string& error,
    AudioHostError* errorCode = nullptr);

AudioHostError validateAndroidAudioHostOpenedStream(
    const AndroidAudioHostOpenedStream& actual, int32_t requestedDeviceId,
    uint32_t requestedChannels, double requestedSampleRate,
    uint32_t requestedBufferFrames, uint32_t maximumFrames,
    AudioHostAccessMode requestedAccess, bool namedEndpoint,
    std::string& error);

AudioHostTransport androidAudioHostTransport(const std::string& token) noexcept;
AudioHostMonitoringSuitability androidAudioHostMonitoringSuitability(
    const std::string& token) noexcept;

}  // namespace singz::detail

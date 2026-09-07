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
  // Which endpoint a song plays out of. AudioManager publishes every output
  // the phone has and marks none, so this is decided in Kotlin, where the
  // AudioDeviceInfo TYPE that answers it lives. Empty means the phone offered
  // nothing anyone would listen to music through: no device is published as
  // the default, and the mobile caller declines native playback rather than
  // taking the first output, which is ordered by uid string.
  std::string defaultOutputUid;
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

/** Whether a stream that opened at ordinary latency is a failure.
 *
 *  It is for MONITORING — a singer hearing themselves through the phone is
 *  the one job where round-trip latency is the entire product, so an input
 *  paired with its output must have the fast path or not run at all.
 *
 *  It is NOT for playing a song back. Playback reads the stream's real
 *  presentation latency and aligns the lyrics, the count-in and the seek bar
 *  to it, so a slower path is handled rather than merely tolerated; refusing
 *  one turns native playback OFF on every device and route the OS declines
 *  to make fast, which on an emulator is all of them. */
enum class AndroidAudioHostLatencyRequirement {
  LowLatencyRequired,
  AnyGranted,
};

AudioHostError validateAndroidAudioHostOpenedStream(
    const AndroidAudioHostOpenedStream& actual, int32_t requestedDeviceId,
    uint32_t requestedChannels, double requestedSampleRate,
    uint32_t requestedBufferFrames, uint32_t maximumFrames,
    AudioHostAccessMode requestedAccess, bool namedEndpoint,
    AndroidAudioHostLatencyRequirement latency, std::string& error);

/** The rate this endpoint will be OPENED at, which is the only rate any
 *  other layer may quote for it. AudioManager is allowed to publish no rate
 *  metadata at all, and on that path the field it fills is left at zero — so
 *  a consumer comparing a device's nominal rate against a prepared rate must
 *  compare against THIS, never against the raw field, or it refuses every
 *  Android route ever published. Oboe exact-negotiates and
 *  validateAndroidAudioHostOpenedStream verifies what actually opened, so an
 *  intent that the hardware disagrees with fails loudly at open rather than
 *  playing at the wrong rate. */
double androidAudioHostNominalSampleRate(
    const AndroidAudioHostDevice& device) noexcept;

AudioHostTransport androidAudioHostTransport(const std::string& token) noexcept;
AudioHostMonitoringSuitability androidAudioHostMonitoringSuitability(
    const std::string& token) noexcept;

}  // namespace singz::detail

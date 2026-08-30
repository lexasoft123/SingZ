#include "audio_host_android_policy.h"

#include "audio_host_android_callback_policy.h"

#include <algorithm>
#include <cmath>
#include <limits>

namespace singz::detail {
namespace {

bool outputOnly(const AudioHostConfig& config) noexcept {
  return config.inputDeviceUid.empty() && config.inputChannels.empty();
}

bool validSelection(const std::vector<uint32_t>& selected,
                    uint32_t available) noexcept {
  if (selected.empty() || selected.size() > kAudioHostMaxChannels ||
      available == 0) {
    return false;
  }
  for (std::size_t index = 0; index < selected.size(); ++index) {
    if (selected[index] >= available ||
        selected[index] >= kAudioHostMaxChannels) {
      return false;
    }
    for (std::size_t prior = 0; prior < index; ++prior) {
      if (selected[index] == selected[prior]) return false;
    }
  }
  return true;
}

const AndroidAudioHostDevice* findEndpoint(
    const AndroidAudioHostInventorySnapshot& snapshot, const std::string& uid,
    bool input) noexcept {
  for (const auto& device : snapshot.devices) {
    if (device.uid == uid && (input ? device.input : device.output)) {
      return &device;
    }
  }
  return nullptr;
}

uint32_t endpointChannels(const std::vector<uint32_t>& channels) noexcept {
  if (channels.empty()) return 0;
  return *std::max_element(channels.begin(), channels.end()) + 1;
}

}  // namespace

AudioHostTransport androidAudioHostTransport(
    const std::string& token) noexcept {
  if (token == "built-in") return AudioHostTransport::BuiltIn;
  if (token == "usb") return AudioHostTransport::Usb;
  if (token == "hdmi") return AudioHostTransport::Hdmi;
  if (token == "bluetooth") return AudioHostTransport::Bluetooth;
  if (token == "bluetooth-low-energy") {
    return AudioHostTransport::BluetoothLowEnergy;
  }
  if (token == "vehicle") return AudioHostTransport::Vehicle;
  return AudioHostTransport::Unknown;
}

AudioHostMonitoringSuitability androidAudioHostMonitoringSuitability(
    const std::string& token) noexcept {
  if (token == "low-latency") {
    return AudioHostMonitoringSuitability::LowLatency;
  }
  if (token == "high-latency") {
    return AudioHostMonitoringSuitability::HighLatency;
  }
  return AudioHostMonitoringSuitability::Unknown;
}

bool prepareAndroidAudioHostRoute(
    const AudioHostConfig& config,
    const AndroidAudioHostInventorySnapshot& snapshot,
    AndroidAudioHostPreparedRoute* prepared, std::string& error,
    AudioHostError* errorCode) {
  error.clear();
  if (errorCode != nullptr) *errorCode = AudioHostError::InvalidConfiguration;
  if (prepared == nullptr) {
    error = "Android AudioHost prepared-route output is unavailable";
    return false;
  }
  *prepared = {};
  if (snapshot.routeGeneration == 0) {
    if (errorCode != nullptr) *errorCode = AudioHostError::DeviceNotFound;
    error = "Android AudioManager endpoint inventory is unavailable";
    return false;
  }
  if (config.inputDeviceUid.empty() != config.inputChannels.empty()) {
    error = "Android AudioHost input UID and channel map must both be empty or both be non-empty";
    return false;
  }
  if (config.outputDeviceUid.empty() || config.outputChannels.empty()) {
    error = "Android AudioHost requires an output endpoint and channel map";
    return false;
  }
  if (!std::isfinite(config.requestedSampleRate) ||
      config.requestedSampleRate < 0.0 ||
      config.requestedSampleRate > 384000.0 ||
      (config.requestedSampleRate != 0.0 &&
       config.requestedSampleRate !=
           std::floor(config.requestedSampleRate))) {
    error = "Android AudioHost requested sample rate is invalid";
    return false;
  }
  if (config.maximumFrames == 0 ||
      config.maximumFrames > kAudioHostMaxFrames ||
      config.requestedBufferFrames > config.maximumFrames) {
    error = "Android AudioHost callback frame bounds are invalid";
    return false;
  }
  const auto* output = findEndpoint(snapshot, config.outputDeviceUid, false);
  if (output == nullptr || output->deviceId <= 0) {
    if (errorCode != nullptr) *errorCode = AudioHostError::DeviceNotFound;
    error = "the selected Android output endpoint is unavailable";
    return false;
  }
  if (!validSelection(config.outputChannels, output->channels)) {
    error = "the Android output channel map is invalid for the selected endpoint";
    return false;
  }
  const uint32_t requiredOutput = endpointChannels(config.outputChannels);
  prepared->outputChannelMap.assign(requiredOutput, -1);
  for (std::size_t source = 0; source < config.outputChannels.size(); ++source) {
    prepared->outputChannelMap[config.outputChannels[source]] =
        static_cast<int32_t>(source);
  }

  if (!outputOnly(config)) {
    const auto* input = findEndpoint(snapshot, config.inputDeviceUid, true);
    if (input == nullptr || input->deviceId <= 0) {
      if (errorCode != nullptr) *errorCode = AudioHostError::DeviceNotFound;
      error = "the selected Android input endpoint is unavailable";
      return false;
    }
    if (!validSelection(config.inputChannels, input->channels)) {
      error = "the Android input channel map is invalid for the selected endpoint";
      return false;
    }
    prepared->inputDeviceId = input->deviceId;
    prepared->inputEndpointChannels = endpointChannels(config.inputChannels);
    prepared->inputChannelMap = config.inputChannels;
  }

  prepared->routeGeneration = snapshot.routeGeneration;
  prepared->outputDeviceId = output->deviceId;
  prepared->outputEndpointChannels = requiredOutput;
  prepared->outputTransport = output->transport;
  prepared->monitoringSuitability = output->monitoringSuitability;
  return true;
}

AudioHostError validateAndroidAudioHostOpenedStream(
    const AndroidAudioHostOpenedStream& actual, int32_t requestedDeviceId,
    uint32_t requestedChannels, double requestedSampleRate,
    uint32_t requestedBufferFrames, uint32_t maximumFrames,
    AudioHostAccessMode requestedAccess, bool namedEndpoint,
    std::string& error) {
  error.clear();
  if (actual.deviceId != requestedDeviceId) {
    error = "Oboe routed the stream to a different Android endpoint";
    return AudioHostError::DeviceNotFound;
  } else if (actual.channels != requestedChannels) {
    error = "Oboe changed the exact callback-boundary channel count";
  } else if (actual.sampleRate == 0 ||
             (requestedSampleRate != 0.0 &&
              actual.sampleRate != static_cast<uint32_t>(requestedSampleRate))) {
    error = "Oboe did not preserve the exact callback-boundary sample rate";
  } else if (actual.format != AudioHostSampleFormat::Float32) {
    error = "Oboe did not preserve the float32 callback format";
  } else if (actual.performance != AndroidAudioHostPerformance::LowLatency) {
    error = "Oboe did not grant the low-latency performance mode";
  } else if (actual.accessMode != requestedAccess) {
    error = requestedAccess == AudioHostAccessMode::Exclusive
                ? "Oboe did not grant the requested exact exclusive stream"
                : "Oboe changed the requested shared access mode";
  } else if (namedEndpoint && actual.api != AndroidAudioHostApi::AAudio) {
    error = "a named Android endpoint unexpectedly opened through OpenSL ES";
  } else if (actual.framesPerBurst == 0 ||
             actual.bufferSizeFrames == 0 ||
             actual.bufferSizeFrames > actual.bufferCapacityFrames ||
             actual.bufferCapacityFrames < actual.framesPerBurst ||
             actual.framesPerBurst > maximumFrames) {
    error = "Oboe returned invalid burst or capacity bounds";
  } else if (requestedBufferFrames != 0 &&
             actual.framesPerCallback != requestedBufferFrames) {
    error = "Oboe did not preserve the requested callback frame count";
  } else if (actual.framesPerCallback > maximumFrames) {
    error = "Oboe callback size exceeds the configured maximum";
  } else if ((actual.hardwareChannels == 0) !=
                 (actual.hardwareSampleRate == 0) ||
             (actual.hardwareChannels != 0 &&
              actual.hardwareFormat == AudioHostSampleFormat::Unknown)) {
    error = "Oboe returned incomplete Android hardware format facts";
  }
  return error.empty() ? AudioHostError::None
                       : AudioHostError::ProviderFailure;
}

}  // namespace singz::detail

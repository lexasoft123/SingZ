#include "audio_host_ios_helpers.h"

#include <algorithm>
#include <cmath>
#include <limits>
#include <thread>

namespace singz::detail {
namespace {

bool outputOnly(const AudioHostConfig &config) noexcept {
  return config.inputDeviceUid.empty() && config.inputChannels.empty();
}

bool validSelection(const std::vector<uint32_t> &selected,
                    uint32_t available) noexcept {
  if (selected.empty() || selected.size() > kAudioHostMaxChannels ||
      available == 0 || available > kAudioHostMaxChannels) {
    return false;
  }
  for (std::size_t index = 0; index < selected.size(); ++index) {
    if (selected[index] >= available)
      return false;
    for (std::size_t prior = 0; prior < index; ++prior) {
      if (selected[index] == selected[prior])
        return false;
    }
  }
  return true;
}

bool requestedRateMatches(double requested, double actual) noexcept {
  return requested == 0.0 || requested == actual;
}

bool durationFrames(double seconds, double rate, bool roundUp,
                    uint32_t *frames) noexcept {
  if (frames == nullptr || !std::isfinite(seconds) || seconds < 0.0 ||
      !std::isfinite(rate) || rate <= 0.0) {
    return false;
  }
  const long double exact = static_cast<long double>(seconds) * rate;
  const long double converted = roundUp ? std::ceil(exact) : std::round(exact);
  if (converted < 0.0L ||
      converted >
          static_cast<long double>(std::numeric_limits<uint32_t>::max())) {
    return false;
  }
  *frames = static_cast<uint32_t>(converted);
  return true;
}

bool buildInputMap(const std::vector<uint32_t> &selected, uint32_t available,
                   std::vector<int32_t> *result) {
  if (result == nullptr || !validSelection(selected, available))
    return false;
  result->clear();
  result->reserve(selected.size());
  for (uint32_t channel : selected)
    result->push_back(static_cast<int32_t>(channel));
  return true;
}

bool buildOutputMap(const std::vector<uint32_t> &selected, uint32_t available,
                    std::vector<int32_t> *result) {
  if (result == nullptr || !validSelection(selected, available))
    return false;
  std::vector<int32_t> candidate(available, -1);
  for (std::size_t source = 0; source < selected.size(); ++source) {
    candidate[selected[source]] = static_cast<int32_t>(source);
  }
  *result = std::move(candidate);
  return true;
}

bool highLatency(IosAudioHostPortKind kind) noexcept {
  switch (kind) {
  case IosAudioHostPortKind::BluetoothHfp:
  case IosAudioHostPortKind::BluetoothA2dp:
  case IosAudioHostPortKind::BluetoothLe:
  case IosAudioHostPortKind::AirPlay:
  case IosAudioHostPortKind::CarAudio:
    return true;
  case IosAudioHostPortKind::Unknown:
  case IosAudioHostPortKind::BuiltIn:
  case IosAudioHostPortKind::Wired:
  case IosAudioHostPortKind::Usb:
  case IosAudioHostPortKind::Hdmi:
    return false;
  }
  return false;
}

} // namespace

bool publishIosAudioHostSessionChange(IosAudioHostSessionSignals *signals,
                                      uint32_t cause) noexcept {
  if (signals == nullptr || cause == 0)
    return false;
  AudioInputCallbackScope admitted(signals->observerAdmission);
  if (!admitted)
    return false;
  if (signals->testObserve != nullptr)
    signals->testObserve(signals->testContext,
                         IosAudioHostNotificationEdge::Entered);
  AudioHostTerminalReason reason = AudioHostTerminalReason::ProviderFailure;
  if ((cause & IosAudioHostRouteChanged) != 0)
    reason = AudioHostTerminalReason::RouteChanged;
  else if ((cause & IosAudioHostInterrupted) != 0)
    reason = AudioHostTerminalReason::Interrupted;
  else if ((cause & IosAudioHostMediaServicesLost) != 0)
    reason = AudioHostTerminalReason::MediaServicesLost;
  else if ((cause & IosAudioHostMediaServicesReset) != 0)
    reason = AudioHostTerminalReason::MediaServicesReset;
  signals->firstTerminalCause.publish(
      reason, AudioHostTerminalProducer::PlatformNotification);
  if (signals->testObserve != nullptr)
    signals->testObserve(signals->testContext,
                         IosAudioHostNotificationEdge::TerminalCausePublished);
  signals->pending.fetch_or(cause, std::memory_order_release);
  if (signals->testObserve != nullptr)
    signals->testObserve(signals->testContext,
                         IosAudioHostNotificationEdge::PendingPublished);
  signals->routeGeneration.fetch_add(1, std::memory_order_release);
  if (signals->testObserve != nullptr)
    signals->testObserve(signals->testContext,
                         IosAudioHostNotificationEdge::GenerationPublished);
  return true;
}

void closeIosAudioHostSessionNotifications(
    IosAudioHostSessionSignals *signals) noexcept {
  if (signals != nullptr)
    signals->observerAdmission.beginClose();
}

void waitForIosAudioHostSessionNotifications(
    const IosAudioHostSessionSignals *signals) noexcept {
  if (signals == nullptr)
    return;
  while (signals->observerAdmission.inFlight() != 0)
    std::this_thread::yield();
}

AudioHostTransport iosAudioHostTransport(IosAudioHostPortKind kind) noexcept {
  switch (kind) {
  case IosAudioHostPortKind::BuiltIn:
    return AudioHostTransport::BuiltIn;
  case IosAudioHostPortKind::Wired:
    // The public transport vocabulary has no generic analog-wired value.
    // Keep the provider fact unknown instead of mislabelling a headset as
    // PCI; monitoring suitability independently retains low-latency policy.
    return AudioHostTransport::Unknown;
  case IosAudioHostPortKind::Usb:
    return AudioHostTransport::Usb;
  case IosAudioHostPortKind::BluetoothHfp:
  case IosAudioHostPortKind::BluetoothA2dp:
    return AudioHostTransport::Bluetooth;
  case IosAudioHostPortKind::BluetoothLe:
    return AudioHostTransport::BluetoothLowEnergy;
  case IosAudioHostPortKind::AirPlay:
    return AudioHostTransport::AirPlay;
  case IosAudioHostPortKind::CarAudio:
    return AudioHostTransport::Vehicle;
  case IosAudioHostPortKind::Hdmi:
    return AudioHostTransport::Hdmi;
  case IosAudioHostPortKind::Unknown:
    return AudioHostTransport::Unknown;
  }
  return AudioHostTransport::Unknown;
}

AudioHostMonitoringSuitability
iosAudioHostMonitoringSuitability(IosAudioHostPortKind kind) noexcept {
  if (highLatency(kind))
    return AudioHostMonitoringSuitability::HighLatency;
  return kind == IosAudioHostPortKind::Unknown
             ? AudioHostMonitoringSuitability::Unknown
             : AudioHostMonitoringSuitability::LowLatency;
}

bool validIosAudioHostMaximumFrames(uint32_t providerMaximumFrames,
                                    uint32_t nominalBufferFrames,
                                    uint32_t configuredMaximumFrames) noexcept {
  return providerMaximumFrames != 0 && nominalBufferFrames != 0 &&
         providerMaximumFrames >= nominalBufferFrames &&
         providerMaximumFrames <= configuredMaximumFrames;
}

AudioHostState
iosAudioHostReportedState(AudioHostState physical,
                          AudioHostTerminalReason terminalReason) noexcept {
  if (terminalReason == AudioHostTerminalReason::None ||
      (physical != AudioHostState::Open && physical != AudioHostState::Running))
    return physical;
  return terminalReason == AudioHostTerminalReason::MediaServicesLost
             ? AudioHostState::DeviceLost
             : AudioHostState::Error;
}

AudioHostState iosAudioHostStateAfterDispose(AudioHostState previous,
                                             bool disposed) noexcept {
  if (!disposed)
    return AudioHostState::Error;
  return previous == AudioHostState::Closed ? AudioHostState::Closed
                                            : AudioHostState::Stopped;
}

bool prepareIosAudioHostRoute(const AudioHostConfig &config,
                              const IosAudioHostSessionSnapshot &snapshot,
                              IosAudioHostPreparedRoute *prepared,
                              std::string &error, AudioHostError *errorCode) {
  error.clear();
  if (errorCode != nullptr) {
    *errorCode = AudioHostError::InvalidConfiguration;
  }
  if (prepared == nullptr) {
    error = "iOS AudioHost prepared-route output is unavailable";
    return false;
  }
  *prepared = {};
  if (config.exclusive) {
    error = "iOS RemoteIO does not expose an exclusive access mode";
    return false;
  }
  const bool hasInput = !outputOnly(config);
  if (config.inputDeviceUid.empty() != config.inputChannels.empty()) {
    error = "iOS AudioHost input UID and channel map must both be empty or "
            "both be non-empty";
    return false;
  }
  if (config.outputDeviceUid.empty() || config.outputChannels.empty()) {
    error = "iOS AudioHost requires an output route and channel map";
    return false;
  }
  if (config.maximumFrames == 0 || config.maximumFrames > kAudioHostMaxFrames) {
    error = "iOS AudioHost maximum callback size is invalid";
    return false;
  }
  if (snapshot.routeGeneration == 0 || !snapshot.outputActive ||
      snapshot.outputUid.empty() ||
      snapshot.outputUid != config.outputDeviceUid) {
    if (errorCode != nullptr)
      *errorCode = AudioHostError::DeviceNotFound;
    error = "the active iOS output route does not match the selected device";
    return false;
  }
  if (!std::isfinite(snapshot.sampleRate) || snapshot.sampleRate <= 0.0 ||
      !requestedRateMatches(config.requestedSampleRate, snapshot.sampleRate)) {
    error = "the active iOS sample rate does not match the requested rate";
    return false;
  }
  uint32_t bufferFrames = 0;
  if (!durationFrames(snapshot.ioBufferDurationSeconds, snapshot.sampleRate,
                      false, &bufferFrames) ||
      bufferFrames == 0 || bufferFrames > config.maximumFrames ||
      (config.requestedBufferFrames != 0 &&
       config.requestedBufferFrames != bufferFrames)) {
    error = "the negotiated iOS I/O buffer does not match the requested bounds";
    return false;
  }
  if (!buildOutputMap(config.outputChannels, snapshot.outputChannels,
                      &prepared->outputChannelMap)) {
    error = "the iOS output channel map is invalid for the active route";
    return false;
  }
  if (hasInput) {
    const uint32_t requiredChannels =
        *std::max_element(config.inputChannels.begin(),
                          config.inputChannels.end()) +
        1;
    if (!snapshot.recordCapable || !snapshot.inputActive ||
        snapshot.inputUid != config.inputDeviceUid) {
      if (errorCode != nullptr)
        *errorCode = AudioHostError::DeviceNotFound;
      error = "the active iOS input route does not match the selected device";
      return false;
    }
    if (!snapshot.inputLeaseActive || snapshot.inputLeaseToken == 0 ||
        snapshot.inputRouteGeneration == 0 ||
        snapshot.inputRouteGeneration != snapshot.inputLeaseRouteGeneration ||
        snapshot.inputLeaseUid != config.inputDeviceUid ||
        snapshot.inputLeaseMinimumChannels < requiredChannels) {
      error =
          "the iOS input route is not covered by the prepared session lease";
      return false;
    }
    if (!buildInputMap(config.inputChannels, snapshot.inputChannels,
                       &prepared->inputChannelMap)) {
      error = "the iOS input channel map is invalid for the active route";
      return false;
    }
  }

  uint32_t inputLatency = 0;
  uint32_t outputLatency = 0;
  if (!durationFrames(snapshot.inputLatencySeconds, snapshot.sampleRate, false,
                      &inputLatency) ||
      !durationFrames(snapshot.outputLatencySeconds, snapshot.sampleRate, false,
                      &outputLatency)) {
    error = "the active iOS route reported invalid latency values";
    return false;
  }
  const bool external = highLatency(snapshot.outputKind);
  prepared->format = {snapshot.sampleRate,
                      config.maximumFrames,
                      bufferFrames,
                      static_cast<uint32_t>(config.inputChannels.size()),
                      static_cast<uint32_t>(config.outputChannels.size()),
                      true,
                      true,
                      AudioHostAccessMode::Shared};
  prepared->latency = {hasInput ? inputLatency : 0u,
                       external ? 0u : outputLatency, bufferFrames,
                       external ? outputLatency : 0u};
  prepared->transport = iosAudioHostTransport(snapshot.outputKind);
  prepared->monitoringSuitability =
      iosAudioHostMonitoringSuitability(snapshot.outputKind);
  return true;
}

bool sameIosAudioHostSession(
    const IosAudioHostSessionSnapshot &left,
    const IosAudioHostSessionSnapshot &right) noexcept {
  return left.routeGeneration == right.routeGeneration &&
         left.category == right.category && left.mode == right.mode &&
         left.categoryOptions == right.categoryOptions &&
         left.outputActive == right.outputActive &&
         left.outputUid == right.outputUid &&
         left.outputChannels == right.outputChannels &&
         left.outputKind == right.outputKind &&
         left.inputActive == right.inputActive &&
         left.recordCapable == right.recordCapable &&
         left.inputUid == right.inputUid &&
         left.inputChannels == right.inputChannels &&
         left.inputKind == right.inputKind &&
         left.inputLeaseActive == right.inputLeaseActive &&
         left.inputLeaseToken == right.inputLeaseToken &&
         left.inputRouteGeneration == right.inputRouteGeneration &&
         left.inputLeaseRouteGeneration == right.inputLeaseRouteGeneration &&
         left.inputLeaseUid == right.inputLeaseUid &&
         left.inputLeaseMinimumChannels == right.inputLeaseMinimumChannels &&
         left.sampleRate == right.sampleRate &&
         left.ioBufferDurationSeconds == right.ioBufferDurationSeconds &&
         left.inputLatencySeconds == right.inputLatencySeconds &&
         left.outputLatencySeconds == right.outputLatencySeconds;
}

} // namespace singz::detail

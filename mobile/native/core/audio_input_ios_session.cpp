#include "audio_input_ios_session.h"

#include <cmath>
#include <utility>

namespace singz {

bool shouldRequestLowLatencyIosInputBuffer(IosAudioOutputRouteKind route) {
  switch (route) {
    case IosAudioOutputRouteKind::BuiltIn:
    case IosAudioOutputRouteKind::Wired:
    case IosAudioOutputRouteKind::Usb:
      return true;
    case IosAudioOutputRouteKind::BluetoothHfp:
    case IosAudioOutputRouteKind::BluetoothA2dp:
    case IosAudioOutputRouteKind::BluetoothLe:
    case IosAudioOutputRouteKind::AirPlay:
    case IosAudioOutputRouteKind::CarAudio:
    case IosAudioOutputRouteKind::Unknown:
      return false;
  }
  return false;
}

IosAudioInputSavedRouteStatus classifyIosAudioInputSavedRoute(
    bool currentRouteMatches, bool availableInputsKnown,
    bool availableInputMatches) {
  if (currentRouteMatches || availableInputMatches)
    return IosAudioInputSavedRouteStatus::Present;
  if (availableInputsKnown) return IosAudioInputSavedRouteStatus::Gone;
  return IosAudioInputSavedRouteStatus::Unknown;
}

bool IosAudioInputLeaseRegistry::acquire(uint64_t routeGeneration,
                                         std::string deviceUid,
                                         uint32_t minimumChannels,
                                         uint64_t& token,
                                         std::string& error) {
  std::lock_guard<std::mutex> lock(mutex_);
  token = 0;
  error.clear();
  if (state_.token != 0) {
    error = "an iOS audio input session lease is already active";
    return false;
  }
  if (routeGeneration == 0 || deviceUid.empty() || minimumChannels == 0) {
    error = "the iOS audio input lease policy is incomplete";
    return false;
  }
  uint64_t candidate = nextToken_++;
  if (candidate == 0) candidate = nextToken_++;
  state_ = {candidate, routeGeneration, std::move(deviceUid), minimumChannels};
  token = candidate;
  return true;
}

void IosAudioInputLeaseRegistry::release(uint64_t token) {
  if (token == 0) return;
  std::lock_guard<std::mutex> lock(mutex_);
  if (state_.token == token) state_ = {};
}

IosAudioInputLeaseState IosAudioInputLeaseRegistry::snapshot() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return state_;
}

bool validateIosAudioInputSession(const IosAudioInputSessionSnapshot& snapshot,
                                  const std::string& expectedDeviceUid,
                                  uint32_t expectedChannel,
                                  std::string& error) {
  error.clear();
  if (snapshot.permission == IosAudioInputPermission::Undetermined) {
    error = "microphone permission has not been requested";
    return false;
  }
  if (snapshot.permission == IosAudioInputPermission::Denied) {
    error = "microphone permission is denied";
    return false;
  }
  if (!snapshot.leaseActive || snapshot.leaseToken == 0) {
    error = "iOS audio input session is not prepared by the app";
    return false;
  }
  if (snapshot.routeGeneration != snapshot.leaseRouteGeneration) {
    error = "iOS audio route changed after the input session was prepared";
    return false;
  }
  if (snapshot.leaseDeviceUid != expectedDeviceUid ||
      snapshot.leaseMinimumChannels == 0 ||
      expectedChannel >= snapshot.leaseMinimumChannels) {
    error = "iOS audio input lease does not cover the selected route and channel";
    return false;
  }
  if (!snapshot.recordCapable) {
    error = "iOS audio session is not record-capable";
    return false;
  }
  if (!snapshot.activeInputRoute) {
    error = "iOS audio session has no active input route";
    return false;
  }
  if (expectedDeviceUid.empty() || snapshot.currentDeviceUid != expectedDeviceUid) {
    error = "iOS active input route does not match the selected device";
    return false;
  }
  if (!std::isfinite(snapshot.sampleRate) || snapshot.sampleRate <= 0) {
    error = "iOS active input sample rate is unavailable";
    return false;
  }
  if (snapshot.channels == 0 || expectedChannel >= snapshot.channels) {
    error = "audio input channel is unavailable on the active iOS route";
    return false;
  }
  return true;
}

}  // namespace singz

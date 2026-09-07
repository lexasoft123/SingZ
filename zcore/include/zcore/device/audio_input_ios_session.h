#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>

namespace singz {

enum class IosAudioInputPermission {
  Undetermined,
  Denied,
  Granted,
};

enum class IosAudioOutputRouteKind {
  BuiltIn,
  Wired,
  Usb,
  BluetoothHfp,
  BluetoothA2dp,
  BluetoothLe,
  AirPlay,
  CarAudio,
  Unknown,
};

bool shouldRequestLowLatencyIosInputBuffer(IosAudioOutputRouteKind route);

enum class IosAudioInputSavedRouteStatus : uint32_t {
  NotActive,
  Present,
  Gone,
  Unknown,
};

IosAudioInputSavedRouteStatus classifyIosAudioInputSavedRoute(
    bool currentRouteMatches, bool availableInputsKnown,
    bool availableInputMatches);

// Immutable view of the process-global AVAudioSession owner. Keeping policy
// evaluation in plain C++ makes readiness, lease and route-generation rules
// testable without booting an iOS simulator or touching AVFoundation.
struct IosAudioInputSessionSnapshot {
  IosAudioInputPermission permission = IosAudioInputPermission::Undetermined;
  bool leaseActive = false;
  bool recordCapable = false;
  bool activeInputRoute = false;
  uint64_t leaseToken = 0;
  uint64_t routeGeneration = 0;
  uint64_t leaseRouteGeneration = 0;
  std::string leaseDeviceUid;
  uint32_t leaseMinimumChannels = 0;
  std::string currentDeviceUid;
  double sampleRate = 0;
  uint32_t channels = 0;
};

struct IosAudioInputLeaseState {
  uint64_t token = 0;
  uint64_t routeGeneration = 0;
  std::string deviceUid;
  uint32_t minimumChannels = 0;
};

// Non-real-time lease state. Token, generation and route policy are committed
// under one mutex so a snapshot can never observe a partially published lease,
// and a delayed release for an old token cannot clear a newer lease.
class IosAudioInputLeaseRegistry {
 public:
  bool acquire(uint64_t routeGeneration, std::string deviceUid,
               uint32_t minimumChannels, uint64_t& token, std::string& error);
  void release(uint64_t token);
  IosAudioInputLeaseState snapshot() const;

 private:
  mutable std::mutex mutex_;
  uint64_t nextToken_ = 1;
  IosAudioInputLeaseState state_;
};

class IosAudioInputSessionPolicy {
 public:
  virtual ~IosAudioInputSessionPolicy() = default;
  virtual IosAudioInputSessionSnapshot snapshot() const = 0;
};

bool validateIosAudioInputSession(const IosAudioInputSessionSnapshot& snapshot,
                                  const std::string& expectedDeviceUid,
                                  uint32_t expectedChannel,
                                  std::string& error);

#if defined(__APPLE__)
std::shared_ptr<IosAudioInputSessionPolicy> iosAudioInputSessionPolicy();
#endif

}  // namespace singz

// App-layer lease seam. The caller first uses react-native-audio-api's public
// AudioManager to configure/activate/select an input, then marks that settled
// state as available to the core. These functions validate and record state;
// they never mutate AVAudioSession.
extern "C" bool singzIosAudioInputPrepareCapturePreferences(
    const char* expectedDeviceUid, uint32_t minimumChannels,
    double lowLatencyBufferDuration, uint32_t timeoutMilliseconds,
    uint64_t* preferenceToken, char* error, size_t errorCapacity);
extern "C" bool singzIosAudioInputRestoreCapturePreferences(
    uint64_t preferenceToken, char* error, size_t errorCapacity);
extern "C" bool singzIosAudioInputAbandonCapturePreferences(
    uint64_t preferenceToken,
    singz::IosAudioInputSavedRouteStatus* savedRouteStatus,
    char* error, size_t errorCapacity);
extern "C" bool singzIosAudioInputVerifyCaptureSession(
    const char* expectedDeviceUid, uint32_t minimumChannels,
    char* error, size_t errorCapacity);
extern "C" bool singzIosAudioInputVerifyPlaybackSession(
    char* error, size_t errorCapacity);
extern "C" bool singzIosAudioInputAcquireSessionLease(
    const char* expectedDeviceUid, uint32_t minimumChannels,
    uint64_t* token, char* error, size_t errorCapacity);
extern "C" void singzIosAudioInputReleaseSessionLease(uint64_t token);

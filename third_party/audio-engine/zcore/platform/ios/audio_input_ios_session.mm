#include <zcore/device/audio_input_ios_session.h>

#if defined(__APPLE__)
#include <TargetConditionals.h>
#endif

#if defined(__APPLE__) && TARGET_OS_IOS

#import <AVFAudio/AVFAudio.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstring>
#include <limits>
#include <mutex>
#include <thread>

namespace singz {
namespace {

constexpr const char* kUidPrefix = "ios:";
constexpr AVAudioSessionCategoryOptions kCaptureOptions =
    AVAudioSessionCategoryOptionAllowBluetoothHFP |
    AVAudioSessionCategoryOptionAllowBluetoothA2DP |
    AVAudioSessionCategoryOptionAllowAirPlay |
    AVAudioSessionCategoryOptionDefaultToSpeaker;

std::atomic<uint64_t> routeGeneration{1};
std::once_flag observersOnce;
IosAudioInputLeaseRegistry leaseRegistry;

struct CapturePreferenceState {
  uint64_t token = 0;
  std::string deviceUid;
  uint32_t minimumChannels = 0;
  NSInteger previousChannels = 0;
  NSTimeInterval previousBufferDuration = 0;
  bool changedChannels = false;
  bool changedBufferDuration = false;
};

std::mutex preferenceMutex;
uint64_t nextPreferenceToken = 1;
CapturePreferenceState preferences;

std::string nsString(NSString* value) {
  if (!value) return {};
  const char* utf8 = value.UTF8String;
  return utf8 ? std::string(utf8) : std::string();
}

std::string coreUid(AVAudioSessionPortDescription* port) {
  const std::string uid = port ? nsString(port.UID) : std::string();
  return uid.empty() ? std::string() : std::string(kUidPrefix) + uid;
}

IosAudioInputPermission recordPermission(AVAudioSession* session) {
  if (@available(iOS 17.0, *)) {
    switch (AVAudioApplication.sharedInstance.recordPermission) {
      case AVAudioApplicationRecordPermissionGranted:
        return IosAudioInputPermission::Granted;
      case AVAudioApplicationRecordPermissionDenied:
        return IosAudioInputPermission::Denied;
      case AVAudioApplicationRecordPermissionUndetermined:
      default:
        return IosAudioInputPermission::Undetermined;
    }
  }
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  switch (session.recordPermission) {
    case AVAudioSessionRecordPermissionGranted:
      return IosAudioInputPermission::Granted;
    case AVAudioSessionRecordPermissionDenied:
      return IosAudioInputPermission::Denied;
    case AVAudioSessionRecordPermissionUndetermined:
    default:
      return IosAudioInputPermission::Undetermined;
  }
#pragma clang diagnostic pop
}

bool recordCapableCategory(AVAudioSessionCategory category) {
  return [category isEqualToString:AVAudioSessionCategoryPlayAndRecord] ||
         [category isEqualToString:AVAudioSessionCategoryRecord] ||
         [category isEqualToString:AVAudioSessionCategoryMultiRoute];
}

IosAudioOutputRouteKind outputRouteKind(AVAudioSessionPort port) {
  if ([port isEqualToString:AVAudioSessionPortBuiltInSpeaker] ||
      [port isEqualToString:AVAudioSessionPortBuiltInReceiver])
    return IosAudioOutputRouteKind::BuiltIn;
  if ([port isEqualToString:AVAudioSessionPortHeadphones] ||
      [port isEqualToString:AVAudioSessionPortHeadsetMic] ||
      [port isEqualToString:AVAudioSessionPortLineOut])
    return IosAudioOutputRouteKind::Wired;
  if ([port isEqualToString:AVAudioSessionPortUSBAudio])
    return IosAudioOutputRouteKind::Usb;
  if ([port isEqualToString:AVAudioSessionPortBluetoothHFP])
    return IosAudioOutputRouteKind::BluetoothHfp;
  if ([port isEqualToString:AVAudioSessionPortBluetoothA2DP])
    return IosAudioOutputRouteKind::BluetoothA2dp;
  if ([port isEqualToString:AVAudioSessionPortBluetoothLE])
    return IosAudioOutputRouteKind::BluetoothLe;
  if ([port isEqualToString:AVAudioSessionPortAirPlay])
    return IosAudioOutputRouteKind::AirPlay;
  if ([port isEqualToString:AVAudioSessionPortCarAudio])
    return IosAudioOutputRouteKind::CarAudio;
  return IosAudioOutputRouteKind::Unknown;
}

bool requestLowLatencyBufferForCurrentOutput(AVAudioSession* session) {
  if (session.currentRoute.outputs.count == 0) return false;
  for (AVAudioSessionPortDescription* output in session.currentRoute.outputs)
    if (!shouldRequestLowLatencyIosInputBuffer(outputRouteKind(output.portType)))
      return false;
  return true;
}

void installGenerationObservers() {
  std::call_once(observersOnce, [] {
    NSNotificationCenter* center = NSNotificationCenter.defaultCenter;
    const NSArray<NSNotificationName>* names = @[
      AVAudioSessionRouteChangeNotification,
      AVAudioSessionInterruptionNotification,
      AVAudioSessionMediaServicesWereLostNotification,
      AVAudioSessionMediaServicesWereResetNotification,
    ];
    // Process-lifetime observer tokens intentionally stay registered. Blocks
    // capture no backend object and touch one lock-free counter only.
    static NSMutableArray* tokens = [[NSMutableArray alloc] initWithCapacity:names.count];
    for (NSNotificationName name in names) {
      id token = [center addObserverForName:name
                                     object:nil
                                      queue:nil
                                 usingBlock:^(NSNotification*) {
                                   routeGeneration.fetch_add(1,
                                                             std::memory_order_release);
                                 }];
      if (token) [tokens addObject:token];
    }
  });
}

std::string captureSessionError(AVAudioSession* session,
                                const std::string& expectedDeviceUid,
                                uint32_t minimumChannels,
                                bool exactConfiguration) {
  if (recordPermission(session) == IosAudioInputPermission::Undetermined)
    return "microphone permission has not been requested";
  if (recordPermission(session) == IosAudioInputPermission::Denied)
    return "microphone permission is denied";
  if (exactConfiguration &&
      ![session.category isEqualToString:AVAudioSessionCategoryPlayAndRecord])
    return "react-native-audio-api did not apply the play-and-record category";
  if (exactConfiguration &&
      ![session.mode isEqualToString:AVAudioSessionModeMeasurement])
    return "react-native-audio-api did not apply measurement mode";
  if (exactConfiguration && session.categoryOptions != kCaptureOptions)
    return "react-native-audio-api did not apply the requested capture options";
  if (!recordCapableCategory(session.category))
    return "react-native-audio-api has not prepared a record-capable session";
  AVAudioSessionPortDescription* input = session.currentRoute.inputs.firstObject;
  if (!input || coreUid(input) != expectedDeviceUid)
    return "the current iOS input route does not match the selected device";
  const NSInteger channels = session.inputNumberOfChannels;
  if (minimumChannels == 0 || channels <= 0 ||
      static_cast<uint64_t>(channels) < minimumChannels)
    return "the selected iOS input route did not negotiate the requested channels";
  if (!std::isfinite(session.sampleRate) || session.sampleRate <= 0)
    return "the active iOS input sample rate is unavailable";
  return {};
}

std::string playbackSessionError(AVAudioSession* session) {
  if (![session.category isEqualToString:AVAudioSessionCategoryPlayback])
    return "react-native-audio-api did not restore the playback category";
  if (![session.mode isEqualToString:AVAudioSessionModeDefault])
    return "react-native-audio-api did not restore the default audio mode";
  if (session.categoryOptions != 0)
    return "react-native-audio-api did not clear the capture category options";
  if (session.currentRoute.outputs.count == 0 ||
      !std::isfinite(session.sampleRate) || session.sampleRate <= 0)
    return "the restored iOS playback route is not ready";
  return {};
}

bool restorePreferenceValues(AVAudioSession* session,
                             const CapturePreferenceState& state,
                             std::string& error) {
  error.clear();
  if (state.changedChannels) {
    NSError* channelError = nil;
    if (![session setPreferredInputNumberOfChannels:state.previousChannels
                                             error:&channelError]) {
      error = "could not restore the preferred iOS input channel count: " +
              nsString(channelError.localizedDescription);
    }
  }
  if (state.changedBufferDuration) {
    NSError* bufferError = nil;
    if (![session setPreferredIOBufferDuration:state.previousBufferDuration
                                         error:&bufferError] &&
        error.empty()) {
      error = "could not restore the preferred iOS I/O buffer duration: " +
              nsString(bufferError.localizedDescription);
    }
  }
  return error.empty();
}

void copyError(const std::string& message, char* error, size_t capacity) {
  if (!error || capacity == 0) return;
  const size_t count = std::min(capacity - 1, message.size());
  std::memcpy(error, message.data(), count);
  error[count] = '\0';
}

class ProductionIosAudioInputSessionPolicy final
    : public IosAudioInputSessionPolicy {
 public:
  IosAudioInputSessionSnapshot snapshot() const override {
    @autoreleasepool {
      installGenerationObservers();
      AVAudioSession* session = AVAudioSession.sharedInstance;
      const IosAudioInputLeaseState lease = leaseRegistry.snapshot();
      IosAudioInputSessionSnapshot result;
      result.permission = recordPermission(session);
      result.leaseToken = lease.token;
      result.leaseActive = lease.token != 0;
      result.routeGeneration = routeGeneration.load(std::memory_order_acquire);
      result.leaseRouteGeneration = lease.routeGeneration;
      result.leaseDeviceUid = lease.deviceUid;
      result.leaseMinimumChannels = lease.minimumChannels;
      result.recordCapable = recordCapableCategory(session.category);
      AVAudioSessionPortDescription* input = session.currentRoute.inputs.firstObject;
      result.currentDeviceUid = coreUid(input);
      result.sampleRate = session.sampleRate;
      const NSInteger channelCount = session.inputNumberOfChannels;
      result.channels = channelCount > 0 &&
                                static_cast<uint64_t>(channelCount) <=
                                    std::numeric_limits<uint32_t>::max()
                            ? static_cast<uint32_t>(channelCount)
                            : 0;
      result.activeInputRoute = input != nil && result.channels > 0 &&
                                std::isfinite(result.sampleRate) &&
                                result.sampleRate > 0;
      return result;
    }
  }
};

}  // namespace

std::shared_ptr<IosAudioInputSessionPolicy> iosAudioInputSessionPolicy() {
  static std::shared_ptr<IosAudioInputSessionPolicy> policy =
      std::make_shared<ProductionIosAudioInputSessionPolicy>();
  return policy;
}

}  // namespace singz

extern "C" bool singzIosAudioInputPrepareCapturePreferences(
    const char* expectedDeviceUid, uint32_t minimumChannels,
    double lowLatencyBufferDuration, uint32_t timeoutMilliseconds,
    uint64_t* preferenceToken, char* error, size_t errorCapacity) {
  @autoreleasepool {
    if (preferenceToken) *preferenceToken = 0;
    if (error && errorCapacity) error[0] = '\0';
    const std::string expected =
        expectedDeviceUid ? std::string(expectedDeviceUid) : std::string();
    if (expected.empty() || minimumChannels == 0) {
      singz::copyError("the selected iOS input route and channel are required",
                       error, errorCapacity);
      return false;
    }
    singz::installGenerationObservers();
    std::lock_guard<std::mutex> lock(singz::preferenceMutex);
    if (singz::preferences.token != 0) {
      singz::copyError("iOS capture preferences are already active", error,
                       errorCapacity);
      return false;
    }

    AVAudioSession* session = AVAudioSession.sharedInstance;
    const auto routeDeadline = std::chrono::steady_clock::now() +
                               std::chrono::milliseconds(timeoutMilliseconds);
    std::string readiness;
    do {
      readiness = singz::captureSessionError(session, expected, 1, true);
      if (readiness.empty()) break;
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    } while (std::chrono::steady_clock::now() <= routeDeadline);
    if (!readiness.empty()) {
      singz::copyError(
          "timed out waiting for the selected iOS input route: " + readiness,
          error, errorCapacity);
      return false;
    }
    const NSInteger maximum = session.maximumInputNumberOfChannels;
    if (maximum <= 0 || static_cast<uint64_t>(maximum) < minimumChannels) {
      singz::copyError("the selected iOS input cannot expose the requested channel",
                       error, errorCapacity);
      return false;
    }

    singz::CapturePreferenceState candidate;
    candidate.deviceUid = expected;
    candidate.minimumChannels = minimumChannels;
    candidate.previousChannels = session.preferredInputNumberOfChannels;
    candidate.previousBufferDuration = session.preferredIOBufferDuration;

    NSError* channelError = nil;
    if (![session setPreferredInputNumberOfChannels:maximum error:&channelError]) {
      singz::copyError(
          "could not request all channels from the selected iOS input: " +
              singz::nsString(channelError.localizedDescription),
          error, errorCapacity);
      return false;
    }
    candidate.changedChannels = maximum != candidate.previousChannels;

    if (singz::requestLowLatencyBufferForCurrentOutput(session) &&
        std::isfinite(lowLatencyBufferDuration) &&
        lowLatencyBufferDuration > 0) {
      NSError* bufferError = nil;
      if (![session setPreferredIOBufferDuration:lowLatencyBufferDuration
                                           error:&bufferError]) {
        std::string restoreError;
        singz::restorePreferenceValues(session, candidate, restoreError);
        std::string message =
            "could not request the low-latency iOS I/O buffer: " +
            singz::nsString(bufferError.localizedDescription);
        if (!restoreError.empty()) {
          uint64_t token = singz::nextPreferenceToken++;
          if (token == 0) token = singz::nextPreferenceToken++;
          candidate.token = token;
          singz::preferences = candidate;
          if (preferenceToken) *preferenceToken = token;
          message += "; " + restoreError;
        }
        singz::copyError(message, error, errorCapacity);
        return false;
      }
      candidate.changedBufferDuration =
          lowLatencyBufferDuration != candidate.previousBufferDuration;
    }

    const auto channelDeadline = std::chrono::steady_clock::now() +
                                 std::chrono::milliseconds(timeoutMilliseconds);
    std::string previousUid;
    NSInteger previousCount = -1;
    unsigned stableReads = 0;
    while (std::chrono::steady_clock::now() <= channelDeadline) {
      AVAudioSessionPortDescription* input =
          session.currentRoute.inputs.firstObject;
      const std::string currentUid = singz::coreUid(input);
      const NSInteger currentCount = session.inputNumberOfChannels;
      if (currentUid == expected && currentCount > 0 &&
          static_cast<uint64_t>(currentCount) >= minimumChannels) {
        stableReads = currentUid == previousUid && currentCount == previousCount
                          ? stableReads + 1
                          : 1;
        if (stableReads >= 2) break;
      } else {
        stableReads = 0;
      }
      previousUid = currentUid;
      previousCount = currentCount;
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    if (stableReads < 2) {
      std::string restoreError;
      singz::restorePreferenceValues(session, candidate, restoreError);
      std::string message =
          "timed out waiting for the selected iOS input route and channel count";
      if (!restoreError.empty()) {
        uint64_t token = singz::nextPreferenceToken++;
        if (token == 0) token = singz::nextPreferenceToken++;
        candidate.token = token;
        singz::preferences = candidate;
        if (preferenceToken) *preferenceToken = token;
        message += "; " + restoreError;
      }
      singz::copyError(message, error, errorCapacity);
      return false;
    }

    uint64_t token = singz::nextPreferenceToken++;
    if (token == 0) token = singz::nextPreferenceToken++;
    candidate.token = token;
    singz::preferences = std::move(candidate);
    if (preferenceToken) *preferenceToken = token;
    return true;
  }
}

extern "C" bool singzIosAudioInputRestoreCapturePreferences(
    uint64_t preferenceToken, char* error, size_t errorCapacity) {
  @autoreleasepool {
    if (error && errorCapacity) error[0] = '\0';
    if (preferenceToken == 0) return true;
    std::lock_guard<std::mutex> lock(singz::preferenceMutex);
    if (singz::preferences.token != preferenceToken) return true;
    std::string restoreError;
    if (!singz::restorePreferenceValues(AVAudioSession.sharedInstance,
                                        singz::preferences, restoreError)) {
      singz::copyError(restoreError, error, errorCapacity);
      return false;
    }
    singz::preferences = {};
    return true;
  }
}

extern "C" bool singzIosAudioInputAbandonCapturePreferences(
    uint64_t preferenceToken,
    singz::IosAudioInputSavedRouteStatus* savedRouteStatus,
    char* error, size_t errorCapacity) {
  @autoreleasepool {
    if (savedRouteStatus)
      *savedRouteStatus = singz::IosAudioInputSavedRouteStatus::NotActive;
    if (error && errorCapacity) error[0] = '\0';
    if (preferenceToken == 0) return true;
    std::lock_guard<std::mutex> lock(singz::preferenceMutex);
    if (singz::preferences.token != preferenceToken) return true;

    AVAudioSession* session = AVAudioSession.sharedInstance;
    const std::string savedUid = singz::preferences.deviceUid;
    bool currentMatches = false;
    for (AVAudioSessionPortDescription* input in session.currentRoute.inputs) {
      if (singz::coreUid(input) == savedUid) {
        currentMatches = true;
        break;
      }
    }
    NSArray<AVAudioSessionPortDescription*>* availableInputs =
        session.availableInputs;
    bool availableMatches = false;
    for (AVAudioSessionPortDescription* input in availableInputs) {
      if (singz::coreUid(input) == savedUid) {
        availableMatches = true;
        break;
      }
    }
    const singz::IosAudioInputSavedRouteStatus status =
        singz::classifyIosAudioInputSavedRoute(
            currentMatches, availableInputs != nil, availableMatches);
    if (savedRouteStatus) *savedRouteStatus = status;
    if (status == singz::IosAudioInputSavedRouteStatus::Present) {
      singz::copyError(
          "the saved iOS input route is still present; preference restoration must be retried",
          error, errorCapacity);
      return false;
    }
    if (status != singz::IosAudioInputSavedRouteStatus::Gone) {
      singz::copyError(
          "iOS cannot confirm that the saved input route is gone; preference restoration must be retried",
          error, errorCapacity);
      return false;
    }
    // The route inventory conclusively no longer contains the saved UID. Do
    // not call route-specific setters on vanished hardware; clear only the
    // bookkeeping protected by this exact token.
    singz::preferences = {};
    return true;
  }
}

extern "C" bool singzIosAudioInputVerifyCaptureSession(
    const char* expectedDeviceUid, uint32_t minimumChannels,
    char* error, size_t errorCapacity) {
  @autoreleasepool {
    if (error && errorCapacity) error[0] = '\0';
    const std::string expected =
        expectedDeviceUid ? std::string(expectedDeviceUid) : std::string();
    const std::string message = singz::captureSessionError(
        AVAudioSession.sharedInstance, expected, minimumChannels, true);
    singz::copyError(message, error, errorCapacity);
    return message.empty();
  }
}

extern "C" bool singzIosAudioInputVerifyPlaybackSession(
    char* error, size_t errorCapacity) {
  @autoreleasepool {
    if (error && errorCapacity) error[0] = '\0';
    const std::string message =
        singz::playbackSessionError(AVAudioSession.sharedInstance);
    singz::copyError(message, error, errorCapacity);
    return message.empty();
  }
}

extern "C" bool singzIosAudioInputAcquireSessionLease(
    const char* expectedDeviceUid, uint32_t minimumChannels,
    uint64_t* token, char* error, size_t errorCapacity) {
  @autoreleasepool {
    if (token) *token = 0;
    if (error && errorCapacity) error[0] = '\0';
    const std::string expected =
        expectedDeviceUid ? std::string(expectedDeviceUid) : std::string();
    std::string validationError = singz::captureSessionError(
        AVAudioSession.sharedInstance, expected, minimumChannels, true);
    if (!validationError.empty()) {
      singz::copyError(validationError, error, errorCapacity);
      return false;
    }
    const uint64_t route =
        singz::routeGeneration.load(std::memory_order_acquire);
    uint64_t candidate = 0;
    if (!singz::leaseRegistry.acquire(route, expected, minimumChannels,
                                      candidate, validationError)) {
      singz::copyError(validationError, error, errorCapacity);
      return false;
    }
    const singz::IosAudioInputSessionSnapshot after =
        singz::iosAudioInputSessionPolicy()->snapshot();
    if (after.leaseToken != candidate || after.routeGeneration != route ||
        after.leaseRouteGeneration != route ||
        after.leaseDeviceUid != expected ||
        after.leaseMinimumChannels != minimumChannels) {
      singz::leaseRegistry.release(candidate);
      singz::copyError("iOS audio route changed while preparing capture", error,
                       errorCapacity);
      return false;
    }
    validationError = singz::captureSessionError(
        AVAudioSession.sharedInstance, expected, minimumChannels, true);
    if (!validationError.empty()) {
      singz::leaseRegistry.release(candidate);
      singz::copyError(validationError, error, errorCapacity);
      return false;
    }
    if (token) *token = candidate;
    return true;
  }
}

extern "C" void singzIosAudioInputReleaseSessionLease(uint64_t token) {
  singz::leaseRegistry.release(token);
}

#endif  // __APPLE__ && TARGET_OS_IOS

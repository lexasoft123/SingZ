#include <zcore/device/audio_input_backend.h>
#include <zcore/device/audio_input_ios_session.h>

#if defined(__APPLE__)
#include <TargetConditionals.h>
#endif

#if defined(__APPLE__) && TARGET_OS_IOS

#import <AVFAudio/AVFAudio.h>
#include <AudioToolbox/AudioToolbox.h>
#include <mach/mach_time.h>

#include <atomic>
#include <cmath>
#include <cstdint>
#include <limits>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include <zcore/audio/audio_input_timestamp.h>

namespace singz {
namespace {

constexpr uint32_t kMaximumFrames = 16384;
constexpr const char* kUidPrefix = "ios:";
constexpr uint32_t kRouteChanged = 1u << 0;
constexpr uint32_t kInterrupted = 1u << 1;
constexpr uint32_t kMediaServicesLost = 1u << 2;
constexpr uint32_t kMediaServicesReset = 1u << 3;

struct SessionSignals {
  std::atomic<uint32_t> pending{0};
};

std::string nsString(NSString* value) {
  if (!value) return {};
  const char* utf8 = value.UTF8String;
  return utf8 ? std::string(utf8) : std::string();
}

std::string osStatusMessage(const char* operation, OSStatus status) {
  char fourcc[5] = {};
  const uint32_t code = static_cast<uint32_t>(status);
  fourcc[0] = static_cast<char>((code >> 24) & 0xff);
  fourcc[1] = static_cast<char>((code >> 16) & 0xff);
  fourcc[2] = static_cast<char>((code >> 8) & 0xff);
  fourcc[3] = static_cast<char>(code & 0xff);
  bool printable = true;
  for (int i = 0; i < 4; ++i) printable = printable && fourcc[i] >= 32 && fourcc[i] <= 126;
  return std::string(operation) + " failed (" +
         (printable ? std::string("'") + fourcc + "'" : std::to_string(status)) + ")";
}

std::string coreUid(AVAudioSessionPortDescription* port) {
  const std::string uid = port ? nsString(port.UID) : std::string();
  return uid.empty() ? std::string() : std::string(kUidPrefix) + uid;
}

uint64_t hostTicksToNanos(uint64_t ticks, const mach_timebase_info_data_t& timebase) {
  return (ticks / timebase.denom) * timebase.numer +
         ((ticks % timebase.denom) * timebase.numer) / timebase.denom;
}

class IosAudioInputBackend final : public AudioInputBackend {
 public:
  explicit IosAudioInputBackend(std::shared_ptr<IosAudioInputSessionPolicy> policy)
      : policy_(std::move(policy)) {}
  ~IosAudioInputBackend() override { stop(); }

  AudioInputResult open(const AudioInputConfig& config, AudioInputPush push,
                        void* context) override {
    @autoreleasepool {
      stop();
      channel_ = config.channel;
      selectedUid_ = config.deviceUid;
      if (!push || !context)
        return failMessage("audio input callback is unavailable", config.channel);
      if (!policy_)
        return failMessage("iOS audio input session policy is unavailable", config.channel);
      push_ = push;
      context_ = context;

      // Install observers before the first readiness snapshot. The global
      // lease generation catches earlier changes; these flags close setup.
      signals_ = std::make_shared<SessionSignals>();
      installObservers(signals_);
      const IosAudioInputSessionSnapshot before = policy_->snapshot();
      std::string readinessError;
      if (!validateIosAudioInputSession(before, selectedUid_, channel_, readinessError))
        return failMessage(std::move(readinessError), config.channel);

      AudioComponentDescription description{};
      description.componentType = kAudioUnitType_Output;
      description.componentSubType = kAudioUnitSubType_RemoteIO;
      description.componentManufacturer = kAudioUnitManufacturer_Apple;
      const AudioComponent component = AudioComponentFindNext(nullptr, &description);
      if (!component)
        return failMessage("RemoteIO audio unit is unavailable", config.channel);
      OSStatus status = AudioComponentInstanceNew(component, &unit_);
      if (status != noErr) return fail("AudioComponentInstanceNew", status, config.channel);

      UInt32 enabled = 1;
      status = AudioUnitSetProperty(unit_, kAudioOutputUnitProperty_EnableIO,
                                    kAudioUnitScope_Input, 1, &enabled,
                                    sizeof(enabled));
      if (status != noErr) return fail("enable RemoteIO input", status, config.channel);
      UInt32 disabled = 0;
      status = AudioUnitSetProperty(unit_, kAudioOutputUnitProperty_EnableIO,
                                    kAudioUnitScope_Output, 0, &disabled,
                                    sizeof(disabled));
      if (status != noErr) return fail("disable RemoteIO output", status, config.channel);

      AudioStreamBasicDescription hardwareFormat{};
      UInt32 formatSize = sizeof(hardwareFormat);
      status = AudioUnitGetProperty(unit_, kAudioUnitProperty_StreamFormat,
                                    kAudioUnitScope_Output, 1, &hardwareFormat,
                                    &formatSize);
      if (status != noErr)
        return fail("read RemoteIO input format", status, config.channel);
      if (hardwareFormat.mChannelsPerFrame == 0 ||
          config.channel >= hardwareFormat.mChannelsPerFrame)
        return failMessage("audio input channel is unavailable on the active route",
                           config.channel);

      AudioStreamBasicDescription clientFormat{};
      clientFormat.mSampleRate = before.sampleRate;
      clientFormat.mFormatID = kAudioFormatLinearPCM;
      clientFormat.mFormatFlags = kAudioFormatFlagIsFloat |
                                  kAudioFormatFlagIsPacked |
                                  kAudioFormatFlagIsNonInterleaved |
                                  kAudioFormatFlagsNativeEndian;
      clientFormat.mBytesPerPacket = sizeof(float);
      clientFormat.mFramesPerPacket = 1;
      clientFormat.mBytesPerFrame = sizeof(float);
      clientFormat.mChannelsPerFrame = 1;
      clientFormat.mBitsPerChannel = 32;
      status = AudioUnitSetProperty(unit_, kAudioUnitProperty_StreamFormat,
                                    kAudioUnitScope_Output, 1, &clientFormat,
                                    sizeof(clientFormat));
      if (status != noErr)
        return fail("set RemoteIO client format", status, config.channel);

      SInt32 mappedChannel = 0;
      std::string mapError;
      if (!makeAudioInputChannelMap(config.channel,
                                    hardwareFormat.mChannelsPerFrame,
                                    mappedChannel, mapError))
        return failMessage(std::move(mapError), config.channel);
      const SInt32 channelMap[1] = {mappedChannel};
      status = AudioUnitSetProperty(unit_, kAudioOutputUnitProperty_ChannelMap,
                                    kAudioUnitScope_Output, 1, channelMap,
                                    sizeof(channelMap));
      if (status != noErr)
        return fail("set RemoteIO input channel map", status, config.channel);

      UInt32 maximumFrames = kMaximumFrames;
      status = AudioUnitSetProperty(unit_, kAudioUnitProperty_MaximumFramesPerSlice,
                                    kAudioUnitScope_Global, 0, &maximumFrames,
                                    sizeof(maximumFrames));
      if (status != noErr)
        return fail("set RemoteIO maximum callback size", status, config.channel);
      maximumFrames = 0;
      UInt32 maximumFramesSize = sizeof(maximumFrames);
      status = AudioUnitGetProperty(unit_, kAudioUnitProperty_MaximumFramesPerSlice,
                                    kAudioUnitScope_Global, 0, &maximumFrames,
                                    &maximumFramesSize);
      if (status != noErr || maximumFrames == 0 || maximumFrames > kMaximumFrames)
        return failMessage("RemoteIO callback exceeds the core buffer limit",
                           config.channel);
      renderBuffer_.resize(maximumFrames);

      if (mach_timebase_info(&timebase_) != KERN_SUCCESS || timebase_.denom == 0)
        return failMessage("mach host-time conversion is unavailable", config.channel);

      AURenderCallbackStruct callback{renderCallback, this};
      status = AudioUnitSetProperty(unit_, kAudioOutputUnitProperty_SetInputCallback,
                                    kAudioUnitScope_Global, 0, &callback,
                                    sizeof(callback));
      if (status != noErr)
        return fail("set RemoteIO input callback", status, config.channel);
      status = AudioUnitInitialize(unit_);
      if (status != noErr) return fail("initialize RemoteIO", status, config.channel);
      initialized_ = true;

      const IosAudioInputSessionSnapshot after = policy_->snapshot();
      if (!validateIosAudioInputSession(after, selectedUid_, channel_, readinessError) ||
          after.leaseToken != before.leaseToken ||
          after.routeGeneration != before.routeGeneration ||
          after.sampleRate != before.sampleRate ||
          after.channels != before.channels || pendingChanges() != 0) {
        return failMessage(readinessError.empty()
                               ? "iOS audio route changed while opening RemoteIO"
                               : std::move(readinessError),
                           config.channel);
      }
      leaseToken_ = before.leaseToken;
      routeGeneration_ = before.routeGeneration;
      sampleRate_ = before.sampleRate;
      callbackFailure_.store(0, std::memory_order_relaxed);
      return AudioInputResult::success(AudioInputState::Starting, sampleRate_, channel_);
    }
  }

  AudioInputResult start() override {
    @autoreleasepool {
      if (!unit_ || !initialized_)
        return AudioInputResult::failure(
            AudioInputState::Error, "RemoteIO is not prepared", channel_);
      std::string readinessError;
      if (!sessionStillReady(readinessError) || pendingChanges() != 0)
        return failMessage(readinessError.empty()
                               ? "iOS audio route changed before capture started"
                               : std::move(readinessError),
                           channel_);
      const OSStatus status = AudioOutputUnitStart(unit_);
      if (status != noErr) return fail("start RemoteIO", status, channel_);
      started_ = true;
      if (!sessionStillReady(readinessError) || pendingChanges() != 0)
        return failMessage(readinessError.empty()
                               ? "iOS audio route changed while capture started"
                               : std::move(readinessError),
                           channel_);
      return AudioInputResult::success(AudioInputState::Running, sampleRate_, channel_);
    }
  }

  void stop() override {
    @autoreleasepool {
      removeObservers();
      if (unit_) {
        if (started_) AudioOutputUnitStop(unit_);
        if (initialized_) AudioUnitUninitialize(unit_);
        AudioComponentInstanceDispose(unit_);
      }
      unit_ = nullptr;
      started_ = false;
      initialized_ = false;
      renderBuffer_.clear();
      push_ = nullptr;
      context_ = nullptr;
      sampleRate_ = 0;
      leaseToken_ = 0;
      routeGeneration_ = 0;
      selectedUid_.clear();
      signals_.reset();
      callbackFailure_.store(0, std::memory_order_relaxed);
      // Session category, activation and preferred input are exclusively
      // owned/restored by the app's react-native-audio-api coordinator.
    }
  }

  bool takeFailure(std::string& error) override {
    @autoreleasepool {
      const uint32_t changes = pendingChanges();
      if (changes & kInterrupted) {
        error = "iOS audio session was interrupted; restart capture";
        return true;
      }
      if (changes & kMediaServicesLost) {
        error = "iOS audio services were lost; restart capture";
        return true;
      }
      if (changes & kMediaServicesReset) {
        error = "iOS audio services were reset; restart capture";
        return true;
      }
      if (changes & kRouteChanged) {
        error = "iOS audio route changed; restart capture";
        return true;
      }
      if (!sessionStillReady(error)) return true;
      const int32_t status = callbackFailure_.exchange(0,
                                                        std::memory_order_acq_rel);
      if (!status) return false;
      error = status == kCallbackTooLarge
                  ? "RemoteIO callback exceeded the prepared buffer"
                  : osStatusMessage("RemoteIO render callback",
                                    static_cast<OSStatus>(status));
      return true;
    }
  }

 private:
  static constexpr int32_t kCallbackTooLarge = std::numeric_limits<int32_t>::min();

  uint32_t pendingChanges() const {
    return signals_ ? signals_->pending.load(std::memory_order_acquire) : 0;
  }

  bool sessionStillReady(std::string& error) const {
    if (!policy_) {
      error = "iOS audio input session policy is unavailable";
      return false;
    }
    const IosAudioInputSessionSnapshot state = policy_->snapshot();
    if (!validateIosAudioInputSession(state, selectedUid_, channel_, error)) return false;
    if (state.leaseToken != leaseToken_ ||
        state.routeGeneration != routeGeneration_ ||
        state.sampleRate != sampleRate_) {
      error = "iOS audio input session lease changed; restart capture";
      return false;
    }
    return true;
  }

  void installObservers(const std::shared_ptr<SessionSignals>& signals) {
    NSNotificationCenter* center = NSNotificationCenter.defaultCenter;
    routeObserver_ = [center
        addObserverForName:AVAudioSessionRouteChangeNotification
                    object:nil
                     queue:nil
                usingBlock:^(NSNotification*) {
                  signals->pending.fetch_or(kRouteChanged,
                                            std::memory_order_release);
                }];
    interruptionObserver_ = [center
        addObserverForName:AVAudioSessionInterruptionNotification
                    object:nil
                     queue:nil
                usingBlock:^(NSNotification*) {
                  signals->pending.fetch_or(kInterrupted,
                                            std::memory_order_release);
                }];
    mediaLostObserver_ = [center
        addObserverForName:AVAudioSessionMediaServicesWereLostNotification
                    object:nil
                     queue:nil
                usingBlock:^(NSNotification*) {
                  signals->pending.fetch_or(kMediaServicesLost,
                                            std::memory_order_release);
                }];
    mediaResetObserver_ = [center
        addObserverForName:AVAudioSessionMediaServicesWereResetNotification
                    object:nil
                     queue:nil
                usingBlock:^(NSNotification*) {
                  signals->pending.fetch_or(kMediaServicesReset,
                                            std::memory_order_release);
                }];
  }

  void removeObservers() {
    NSNotificationCenter* center = NSNotificationCenter.defaultCenter;
    if (routeObserver_) [center removeObserver:routeObserver_];
    if (interruptionObserver_) [center removeObserver:interruptionObserver_];
    if (mediaLostObserver_) [center removeObserver:mediaLostObserver_];
    if (mediaResetObserver_) [center removeObserver:mediaResetObserver_];
    routeObserver_ = nil;
    interruptionObserver_ = nil;
    mediaLostObserver_ = nil;
    mediaResetObserver_ = nil;
  }

  static OSStatus renderCallback(void* context,
                                 AudioUnitRenderActionFlags* flags,
                                 const AudioTimeStamp* timestamp, UInt32,
                                 UInt32 frames, AudioBufferList*) {
    const uint64_t callbackTicks = mach_absolute_time();
    IosAudioInputBackend* self = static_cast<IosAudioInputBackend*>(context);
    if (!self || !self->unit_ || !self->push_ || frames == 0) return noErr;
    if (frames > self->renderBuffer_.size()) {
      self->callbackFailure_.store(kCallbackTooLarge,
                                   std::memory_order_release);
      return noErr;
    }
    AudioBufferList list{};
    list.mNumberBuffers = 1;
    list.mBuffers[0].mNumberChannels = 1;
    list.mBuffers[0].mDataByteSize = frames * sizeof(float);
    list.mBuffers[0].mData = self->renderBuffer_.data();
    const OSStatus status = AudioUnitRender(self->unit_, flags, timestamp, 1,
                                            frames, &list);
    if (status != noErr) {
      self->callbackFailure_.store(static_cast<int32_t>(status),
                                   std::memory_order_release);
      return status;
    }
    const uint64_t callbackNs = hostTicksToNanos(callbackTicks, self->timebase_);
    const bool hardwareValid =
        timestamp && (timestamp->mFlags & kAudioTimeStampHostTimeValid) &&
        timestamp->mHostTime != 0;
    const uint64_t hardwareNs = hardwareValid
        ? hostTicksToNanos(timestamp->mHostTime, self->timebase_)
        : 0;
    const AudioInputTimestampProjection projected = resolveAudioInputTimestamp(
        hardwareValid, hardwareNs, callbackNs, frames, self->sampleRate_);
    self->push_(self->context_, self->renderBuffer_.data(), frames,
                projected.sampleHostTimeNs, callbackNs,
                projected.usedHardwareAnchor
                    ? AudioInputTimestampQuality::Hardware
                    : AudioInputTimestampQuality::CallbackEstimate);
    return noErr;
  }

  AudioInputResult fail(const char* operation, OSStatus status,
                        uint32_t channel) {
    return failMessage(osStatusMessage(operation, status), channel);
  }

  AudioInputResult failMessage(std::string message, uint32_t channel) {
    stop();
    return AudioInputResult::failure(AudioInputState::Error, std::move(message), channel);
  }

  std::shared_ptr<IosAudioInputSessionPolicy> policy_;
  AudioUnit unit_ = nullptr;
  bool initialized_ = false;
  bool started_ = false;
  double sampleRate_ = 0;
  uint32_t channel_ = 0;
  uint64_t leaseToken_ = 0;
  uint64_t routeGeneration_ = 0;
  mach_timebase_info_data_t timebase_{};
  std::vector<float> renderBuffer_;
  AudioInputPush push_ = nullptr;
  void* context_ = nullptr;
  std::atomic<int32_t> callbackFailure_{0};
  std::string selectedUid_;
  std::shared_ptr<SessionSignals> signals_;
  id routeObserver_ = nil;
  id interruptionObserver_ = nil;
  id mediaLostObserver_ = nil;
  id mediaResetObserver_ = nil;
};

}  // namespace

std::vector<AudioInputDevice> enumeratePlatformAudioInputDevices(
    std::string* error) {
  @autoreleasepool {
    if (error) error->clear();
    const std::shared_ptr<IosAudioInputSessionPolicy> policy =
        iosAudioInputSessionPolicy();
    const IosAudioInputSessionSnapshot sessionState = policy->snapshot();
    std::string readinessError;
    if (!validateIosAudioInputSession(sessionState,
                                      sessionState.currentDeviceUid, 0,
                                      readinessError)) {
      if (error) *error = std::move(readinessError);
      return {};
    }

    AVAudioSession* session = AVAudioSession.sharedInstance;
    NSArray<AVAudioSessionPortDescription*>* available = session.availableInputs;
    if (!available) available = @[];
    std::vector<AudioInputDevice> result;
    for (AVAudioSessionPortDescription* port in available) {
      AudioInputDevice item;
      item.uid = coreUid(port);
      if (item.uid.empty()) continue;
      item.label = nsString(port.portName);
      if (item.label.empty()) item.label = "Audio input";
      item.isDefault = item.uid == sessionState.currentDeviceUid;
      const NSUInteger describedChannels = port.channels.count;
      item.channels = item.isDefault
                          ? sessionState.channels
                          : (describedChannels <= std::numeric_limits<uint32_t>::max()
                                 ? static_cast<uint32_t>(describedChannels)
                                 : 0);
      if (item.channels == 0) continue;
      item.sampleRate = item.isDefault ? sessionState.sampleRate : 0;
      item.channelLabels.reserve(item.channels);
      for (uint32_t index = 0; index < item.channels; ++index) {
        std::string label;
        if (index < describedChannels)
          label = nsString(port.channels[index].channelName);
        if (label.empty()) label = "Channel " + std::to_string(index + 1);
        item.channelLabels.push_back(std::move(label));
      }
      result.push_back(std::move(item));
    }
    if (result.empty() && error)
      *error = "iOS reported no inputs for the prepared audio session";
    return result;
  }
}

std::unique_ptr<AudioInputBackend> createPlatformAudioInputBackend() {
  return std::make_unique<IosAudioInputBackend>(iosAudioInputSessionPolicy());
}

}  // namespace singz

#endif  // __APPLE__ && TARGET_OS_IOS

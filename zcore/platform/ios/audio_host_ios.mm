#include <zcore/device/audio_host.h>
#include <zcore/device/audio_input_ios_session.h>

#include <TargetConditionals.h>

#if !TARGET_OS_IOS
#error "audio_host_ios.mm is only valid for iOS targets"
#endif

#import <AVFAudio/AVFAudio.h>
#include <AudioToolbox/AudioToolbox.h>
#include <mach/mach_time.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "audio_host_ios_callback.h"
#include "audio_host_ios_helpers.h"

namespace singz {
namespace {

constexpr const char* kInputUidPrefix = "ios:";
constexpr const char* kOutputUidPrefix = "ios-output:";
constexpr uint32_t kRouteChanged = 1u << 0;
constexpr uint32_t kInterrupted = 1u << 1;
constexpr uint32_t kMediaServicesLost = 1u << 2;
constexpr uint32_t kMediaServicesReset = 1u << 3;

static_assert(std::atomic<uint32_t>::is_always_lock_free);
static_assert(std::atomic<int32_t>::is_always_lock_free);
static_assert(std::atomic<uint64_t>::is_always_lock_free);

// AVAudioSession is process-global, so only one standalone RemoteIO host may
// own it at a time. A stop or disposal failure permanently poisons this
// process-local provider and retains exactly one AudioUnit plus its closed
// callback context. This bounded fail-stop quarantine prevents a late
// platform callback from observing freed state without allowing repeated
// failed opens to accumulate resources.
struct IosAudioHostProcessLease {
  std::mutex mutex;
  const void* owner{nullptr};
  bool poisoned{false};
  AudioUnit retiredUnit{nullptr};
  std::unique_ptr<detail::IosAudioHostCallbackContext> retiredCallback;
};

IosAudioHostProcessLease& iosAudioHostProcessLease() {
  static auto* lease = new IosAudioHostProcessLease();
  return *lease;
}

bool claimIosAudioHostProcessLease(const void* owner) {
  auto& lease = iosAudioHostProcessLease();
  std::lock_guard<std::mutex> lock(lease.mutex);
  if (lease.poisoned || (lease.owner != nullptr && lease.owner != owner)) {
    return false;
  }
  lease.owner = owner;
  return true;
}

void releaseIosAudioHostProcessLease(const void* owner) {
  auto& lease = iosAudioHostProcessLease();
  std::lock_guard<std::mutex> lock(lease.mutex);
  if (lease.owner == owner) lease.owner = nullptr;
}

void poisonIosAudioHostProcessLease(
    const void* owner, AudioUnit unit,
    std::unique_ptr<detail::IosAudioHostCallbackContext> callback) {
  auto& lease = iosAudioHostProcessLease();
  std::lock_guard<std::mutex> lock(lease.mutex);
  if (lease.owner == owner && !lease.poisoned) {
    lease.retiredUnit = unit;
    lease.retiredCallback = std::move(callback);
    lease.poisoned = true;
    lease.owner = nullptr;
  } else {
    // A poisoned process can never claim another host, so this path indicates
    // an internal ownership violation. Leak rather than free callback state
    // that Core Audio might still reference.
    (void)callback.release();
  }
}

std::string nsString(NSString* value) {
  if (!value) return {};
  const char* utf8 = value.UTF8String;
  return utf8 ? std::string(utf8) : std::string();
}

std::string portUid(AVAudioSessionPortDescription* port, const char* prefix) {
  const std::string uid = port ? nsString(port.UID) : std::string();
  return uid.empty() ? std::string() : std::string(prefix) + uid;
}

detail::IosAudioHostPortKind portKind(AVAudioSessionPort port) {
  using Kind = detail::IosAudioHostPortKind;
  if ([port isEqualToString:AVAudioSessionPortBuiltInMic] ||
      [port isEqualToString:AVAudioSessionPortBuiltInSpeaker] ||
      [port isEqualToString:AVAudioSessionPortBuiltInReceiver]) {
    return Kind::BuiltIn;
  }
  if ([port isEqualToString:AVAudioSessionPortHeadphones] ||
      [port isEqualToString:AVAudioSessionPortHeadsetMic] ||
      [port isEqualToString:AVAudioSessionPortLineIn] ||
      [port isEqualToString:AVAudioSessionPortLineOut]) {
    return Kind::Wired;
  }
  if ([port isEqualToString:AVAudioSessionPortUSBAudio]) return Kind::Usb;
  if ([port isEqualToString:AVAudioSessionPortBluetoothHFP])
    return Kind::BluetoothHfp;
  if ([port isEqualToString:AVAudioSessionPortBluetoothA2DP])
    return Kind::BluetoothA2dp;
  if ([port isEqualToString:AVAudioSessionPortBluetoothLE])
    return Kind::BluetoothLe;
  if ([port isEqualToString:AVAudioSessionPortAirPlay]) return Kind::AirPlay;
  if ([port isEqualToString:AVAudioSessionPortCarAudio]) return Kind::CarAudio;
  if ([port isEqualToString:AVAudioSessionPortHDMI]) return Kind::Hdmi;
  return Kind::Unknown;
}

bool recordCapableCategory(AVAudioSessionCategory category) {
  return [category isEqualToString:AVAudioSessionCategoryPlayAndRecord] ||
         [category isEqualToString:AVAudioSessionCategoryRecord] ||
         [category isEqualToString:AVAudioSessionCategoryMultiRoute];
}

uint32_t checkedChannels(NSInteger channels) noexcept {
  return channels > 0 &&
                 static_cast<uint64_t>(channels) <= kAudioHostMaxChannels
             ? static_cast<uint32_t>(channels)
             : 0;
}

std::vector<std::string> channelLabels(
    AVAudioSessionPortDescription* port, uint32_t channels,
    const char* fallbackPrefix) {
  std::vector<std::string> result;
  result.reserve(channels);
  const NSUInteger described = port ? port.channels.count : 0;
  for (uint32_t index = 0; index < channels; ++index) {
    std::string label;
    if (index < described) label = nsString(port.channels[index].channelName);
    if (label.empty()) {
      label = std::string(fallbackPrefix) + " " + std::to_string(index + 1);
    }
    result.push_back(std::move(label));
  }
  return result;
}

std::string osStatusMessage(const char* operation, OSStatus status) {
  char fourcc[5] = {};
  const uint32_t code = static_cast<uint32_t>(status);
  fourcc[0] = static_cast<char>((code >> 24) & 0xff);
  fourcc[1] = static_cast<char>((code >> 16) & 0xff);
  fourcc[2] = static_cast<char>((code >> 8) & 0xff);
  fourcc[3] = static_cast<char>(code & 0xff);
  bool printable = true;
  for (int index = 0; index < 4; ++index) {
    printable = printable && fourcc[index] >= 32 && fourcc[index] <= 126;
  }
  return std::string(operation) + " failed (" +
         (printable ? std::string("'") + fourcc + "'"
                    : std::to_string(status)) +
         ")";
}

AudioStreamBasicDescription planarFormat(double rate, uint32_t channels) {
  AudioStreamBasicDescription format{};
  format.mSampleRate = rate;
  format.mFormatID = kAudioFormatLinearPCM;
  format.mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked |
                        kAudioFormatFlagIsNonInterleaved |
                        kAudioFormatFlagsNativeEndian;
  format.mBytesPerPacket = sizeof(float);
  format.mFramesPerPacket = 1;
  format.mBytesPerFrame = sizeof(float);
  format.mChannelsPerFrame = channels;
  format.mBitsPerChannel = 32;
  return format;
}

bool isPlanarFloat32(const AudioStreamBasicDescription& format,
                     double rate, uint32_t channels) noexcept {
  constexpr AudioFormatFlags required =
      kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked |
      kAudioFormatFlagIsNonInterleaved;
  return format.mFormatID == kAudioFormatLinearPCM &&
         (format.mFormatFlags & required) == required &&
         format.mSampleRate == rate && format.mChannelsPerFrame == channels &&
         format.mBytesPerFrame == sizeof(float) &&
         format.mBitsPerChannel == 32;
}

detail::IosAudioHostSessionSnapshot sessionSnapshot(
    const std::shared_ptr<detail::IosAudioHostSessionSignals>& signals,
    const std::shared_ptr<IosAudioInputSessionPolicy>& inputPolicy) {
  AVAudioSession* session = AVAudioSession.sharedInstance;
  detail::IosAudioHostSessionSnapshot result;
  result.routeGeneration = signals
                               ? signals->routeGeneration.load(
                                     std::memory_order_acquire)
                               : 0;
  result.category = nsString(session.category);
  result.mode = nsString(session.mode);
  result.categoryOptions = static_cast<uint64_t>(session.categoryOptions);
  result.sampleRate = session.sampleRate;
  result.ioBufferDurationSeconds = session.IOBufferDuration;
  result.inputLatencySeconds = session.inputLatency;
  result.outputLatencySeconds = session.outputLatency;

  NSArray<AVAudioSessionPortDescription*>* outputs =
      session.currentRoute.outputs;
  AVAudioSessionPortDescription* output =
      outputs.count == 1 ? outputs.firstObject : nil;
  result.outputChannels = checkedChannels(session.outputNumberOfChannels);
  result.outputUid = portUid(output, kOutputUidPrefix);
  result.outputKind = output ? portKind(output.portType)
                             : detail::IosAudioHostPortKind::Unknown;
  result.outputActive = output != nil && !result.outputUid.empty() &&
                        result.outputChannels != 0 &&
                        std::isfinite(result.sampleRate) &&
                        result.sampleRate > 0.0;

  NSArray<AVAudioSessionPortDescription*>* inputs = session.currentRoute.inputs;
  AVAudioSessionPortDescription* input =
      inputs.count == 1 ? inputs.firstObject : nil;
  result.inputChannels = checkedChannels(session.inputNumberOfChannels);
  result.inputUid = portUid(input, kInputUidPrefix);
  result.inputKind = input ? portKind(input.portType)
                           : detail::IosAudioHostPortKind::Unknown;
  result.recordCapable = recordCapableCategory(session.category);
  result.inputActive = input != nil && !result.inputUid.empty() &&
                       result.inputChannels != 0 && result.recordCapable &&
                       result.outputActive;

  if (inputPolicy) {
    const IosAudioInputSessionSnapshot lease = inputPolicy->snapshot();
    result.inputLeaseActive = lease.leaseActive;
    result.inputLeaseToken = lease.leaseToken;
    result.inputRouteGeneration = lease.routeGeneration;
    result.inputLeaseRouteGeneration = lease.leaseRouteGeneration;
    result.inputLeaseUid = lease.leaseDeviceUid;
    result.inputLeaseMinimumChannels = lease.leaseMinimumChannels;
  }
  return result;
}

class IosAudioHostBackend final : public AudioHostBackend {
 public:
  IosAudioHostBackend() : inputPolicy_(iosAudioInputSessionPolicy()) {}
  ~IosAudioHostBackend() override { stop(); }

  AudioHostInventory enumerate() const override {
    @autoreleasepool {
      // Reading the active route does not activate, configure, or otherwise
      // acquire the process-global AVAudioSession.
      auto temporarySignals =
          std::make_shared<detail::IosAudioHostSessionSignals>();
      const auto snapshot = sessionSnapshot(temporarySignals, inputPolicy_);
      AVAudioSession* session = AVAudioSession.sharedInstance;
      AudioHostInventory inventory;
      if (snapshot.outputActive) {
        AVAudioSessionPortDescription* output =
            session.currentRoute.outputs.firstObject;
        AudioHostDeviceInfo device;
        device.uid = snapshot.outputUid;
        device.label = nsString(output.portName);
        if (device.label.empty()) device.label = "iOS audio output";
        device.defaultOutput = true;
        device.outputChannels = snapshot.outputChannels;
        device.outputChannelLabels =
            channelLabels(output, device.outputChannels, "Output");
        device.nominalSampleRate = snapshot.sampleRate;
        device.sampleRateRanges = {
            {snapshot.sampleRate, snapshot.sampleRate}};
        uint32_t bufferFrames = 0;
        std::string ignored;
        AudioHostConfig probe;
        probe.outputDeviceUid = snapshot.outputUid;
        probe.outputChannels = {0};
        probe.maximumFrames = kAudioHostMaxFrames;
        detail::IosAudioHostPreparedRoute prepared;
        if (detail::prepareIosAudioHostRoute(probe, snapshot, &prepared,
                                             ignored)) {
          bufferFrames = prepared.format.nominalBufferFrames;
        }
        device.bufferFrames = {bufferFrames, bufferFrames, bufferFrames,
                               bufferFrames};
        device.direction = AudioHostEndpointDirection::Output;
        device.transport = detail::iosAudioHostTransport(snapshot.outputKind);
        device.monitoringSuitability =
            detail::iosAudioHostMonitoringSuitability(snapshot.outputKind);
        inventory.defaultOutputUid = device.uid;
        inventory.devices.push_back(std::move(device));
      }
      if (snapshot.inputActive) {
        AVAudioSessionPortDescription* input =
            session.currentRoute.inputs.firstObject;
        AudioHostDeviceInfo device;
        device.uid = snapshot.inputUid;
        device.label = nsString(input.portName);
        if (device.label.empty()) device.label = "iOS audio input";
        device.defaultInput = true;
        device.inputChannels = snapshot.inputChannels;
        device.inputChannelLabels =
            channelLabels(input, device.inputChannels, "Input");
        device.nominalSampleRate = snapshot.sampleRate;
        device.sampleRateRanges = {
            {snapshot.sampleRate, snapshot.sampleRate}};
        device.direction = AudioHostEndpointDirection::Input;
        device.transport = detail::iosAudioHostTransport(snapshot.inputKind);
        device.monitoringSuitability =
            detail::iosAudioHostMonitoringSuitability(snapshot.inputKind);
        inventory.defaultInputUid = device.uid;
        inventory.devices.push_back(std::move(device));
      }
      return inventory;
    }
  }

  AudioHostResult open(const AudioHostConfig& config, AudioHostRender render,
                       void* renderContext) override {
    @autoreleasepool {
      stop();
      if (config.exclusive) {
        return reject(AudioHostError::Unsupported,
                      "iOS RemoteIO does not expose an exclusive access mode",
                      AudioHostState::Unsupported);
      }
      if (render == nullptr) {
        return reject(AudioHostError::InvalidConfiguration,
                      "iOS AudioHost render thunk is unavailable");
      }
      if (!claimIosAudioHostProcessLease(this)) {
        return reject(AudioHostError::InvalidState,
                      "the process-global iOS RemoteIO host is unavailable");
      }
      leaseHeld_ = true;

      callback_->callbackFailure.store(0, std::memory_order_relaxed);
      providerFailure_.store(0, std::memory_order_relaxed);
      signals_ = std::make_shared<detail::IosAudioHostSessionSignals>();
      signals_->routeGeneration.store(
          lastRouteGeneration_.fetch_add(1, std::memory_order_relaxed) + 1,
          std::memory_order_relaxed);
      installObservers(signals_);
      const detail::IosAudioHostSessionSnapshot before =
          sessionSnapshot(signals_, inputPolicy_);
      detail::IosAudioHostPreparedRoute prepared;
      std::string policyError;
      AudioHostError policyCode = AudioHostError::InvalidConfiguration;
      if (!detail::prepareIosAudioHostRoute(config, before, &prepared,
                                            policyError, &policyCode)) {
        return fail(policyCode, std::move(policyError));
      }
      const bool hasInput = prepared.format.inputChannels != 0;

      AudioComponentDescription description{};
      description.componentType = kAudioUnitType_Output;
      description.componentSubType = kAudioUnitSubType_RemoteIO;
      description.componentManufacturer = kAudioUnitManufacturer_Apple;
      AudioComponent component = AudioComponentFindNext(nullptr, &description);
      if (component == nullptr ||
          AudioComponentInstanceNew(component, &unit_) != noErr) {
        return fail(AudioHostError::ProviderFailure,
                    "RemoteIO audio unit is unavailable");
      }

      UInt32 enabled = 1;
      UInt32 inputEnabled = hasInput ? 1u : 0u;
      OSStatus osStatus = AudioUnitSetProperty(
          unit_, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Output, 0,
          &enabled, sizeof(enabled));
      if (osStatus == noErr) {
        osStatus = AudioUnitSetProperty(
            unit_, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Input, 1,
            &inputEnabled, sizeof(inputEnabled));
      }
      if (osStatus != noErr) {
        return fail(AudioHostError::ProviderFailure,
                    osStatusMessage("configure RemoteIO I/O", osStatus));
      }

      AudioStreamBasicDescription hardwareOutput{};
      UInt32 propertySize = sizeof(hardwareOutput);
      osStatus = AudioUnitGetProperty(
          unit_, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Output, 0,
          &hardwareOutput, &propertySize);
      if (osStatus != noErr ||
          hardwareOutput.mSampleRate != prepared.format.sampleRate ||
          hardwareOutput.mChannelsPerFrame != before.outputChannels) {
        return fail(AudioHostError::ProviderFailure,
                    "RemoteIO output hardware format does not match AVAudioSession");
      }
      if (hasInput) {
        AudioStreamBasicDescription hardwareInput{};
        propertySize = sizeof(hardwareInput);
        osStatus = AudioUnitGetProperty(
            unit_, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Output, 1,
            &hardwareInput, &propertySize);
        if (osStatus != noErr ||
            hardwareInput.mSampleRate != prepared.format.sampleRate ||
            hardwareInput.mChannelsPerFrame != before.inputChannels) {
          return fail(AudioHostError::ProviderFailure,
                      "RemoteIO input hardware format does not match AVAudioSession");
        }
      }

      const AudioStreamBasicDescription outputFormat = planarFormat(
          prepared.format.sampleRate, prepared.format.outputChannels);
      osStatus = AudioUnitSetProperty(
          unit_, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input, 0,
          &outputFormat, sizeof(outputFormat));
      if (osStatus != noErr) {
        return fail(AudioHostError::ProviderFailure,
                    osStatusMessage("set RemoteIO output format", osStatus));
      }
      if (hasInput) {
        const AudioStreamBasicDescription inputFormat = planarFormat(
            prepared.format.sampleRate, prepared.format.inputChannels);
        osStatus = AudioUnitSetProperty(
            unit_, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Output, 1,
            &inputFormat, sizeof(inputFormat));
        if (osStatus != noErr) {
          return fail(AudioHostError::ProviderFailure,
                      osStatusMessage("set RemoteIO input format", osStatus));
        }
      }

      osStatus = AudioUnitSetProperty(
          unit_, kAudioOutputUnitProperty_ChannelMap, kAudioUnitScope_Input, 0,
          prepared.outputChannelMap.data(),
          static_cast<UInt32>(prepared.outputChannelMap.size() *
                              sizeof(int32_t)));
      if (osStatus == noErr && hasInput) {
        osStatus = AudioUnitSetProperty(
            unit_, kAudioOutputUnitProperty_ChannelMap,
            kAudioUnitScope_Output, 1, prepared.inputChannelMap.data(),
            static_cast<UInt32>(prepared.inputChannelMap.size() *
                                sizeof(int32_t)));
      }
      if (osStatus != noErr) {
        return fail(AudioHostError::InvalidConfiguration,
                    osStatusMessage("set RemoteIO physical channel map",
                                    osStatus));
      }

      UInt32 maximumFrames = prepared.format.maximumFrames;
      osStatus = AudioUnitSetProperty(
          unit_, kAudioUnitProperty_MaximumFramesPerSlice,
          kAudioUnitScope_Global, 0, &maximumFrames, sizeof(maximumFrames));
      if (osStatus != noErr) {
        return fail(AudioHostError::ProviderFailure,
                    osStatusMessage("set RemoteIO callback bound", osStatus));
      }
      maximumFrames = 0;
      propertySize = sizeof(maximumFrames);
      osStatus = AudioUnitGetProperty(
          unit_, kAudioUnitProperty_MaximumFramesPerSlice,
          kAudioUnitScope_Global, 0, &maximumFrames, &propertySize);
      if (osStatus != noErr ||
          !detail::validIosAudioHostMaximumFrames(
              maximumFrames, prepared.format.nominalBufferFrames,
              prepared.format.maximumFrames)) {
        return fail(AudioHostError::ProviderFailure,
                    "RemoteIO did not preserve the configured callback bound");
      }
      prepared.format.maximumFrames = maximumFrames;

      if (hasInput) {
        inputSamples_.resize(
            static_cast<std::size_t>(prepared.format.inputChannels) *
            prepared.format.maximumFrames);
        const std::size_t listBytes =
            offsetof(AudioBufferList, mBuffers) +
            sizeof(AudioBuffer) * prepared.format.inputChannels;
        inputListStorage_.resize(
            (listBytes + sizeof(std::max_align_t) - 1) /
            sizeof(std::max_align_t));
        inputList_ =
            reinterpret_cast<AudioBufferList*>(inputListStorage_.data());
        inputList_->mNumberBuffers = prepared.format.inputChannels;
        for (uint32_t channel = 0; channel < prepared.format.inputChannels;
             ++channel) {
          float* samples = inputSamples_.data() +
                           static_cast<std::size_t>(channel) *
                               prepared.format.maximumFrames;
          callback_->inputPointers[channel] = samples;
          inputList_->mBuffers[channel].mNumberChannels = 1;
          inputList_->mBuffers[channel].mDataByteSize =
              prepared.format.maximumFrames * sizeof(float);
          inputList_->mBuffers[channel].mData = samples;
        }
      }

      if (mach_timebase_info(&callback_->timebase) != KERN_SUCCESS ||
          callback_->timebase.denom == 0) {
        return fail(AudioHostError::ProviderFailure,
                    "Mach host-time conversion is unavailable");
      }
      format_ = prepared.format;
      latency_ = prepared.latency;
      openedSnapshot_ = before;
      const uint64_t streamGeneration =
          streamGeneration_.fetch_add(1, std::memory_order_relaxed) + 1;
      callback_->unit = unit_;
      callback_->format = format_;
      callback_->inputList = inputList_;
      callback_->signals = signals_.get();
      callback_->streamGeneration = streamGeneration;
      callback_->fallbackOutputFrame = 0;
      callback_->callbackSequence = 0;
      callback_->inputSourceFrame = 0;
      callback_->outputTimeline = {};
      callback_->firstCallback.store(1, std::memory_order_relaxed);
      callback_->admission.beginClose();
      resetCounters();
      prepareAudioHostCallback(&callback_->endpoint, render, renderContext);
      AURenderCallbackStruct callback{detail::iosAudioHostRenderCallback,
                                      callback_};
      osStatus = AudioUnitSetProperty(
          unit_, kAudioUnitProperty_SetRenderCallback,
          kAudioUnitScope_Input, 0, &callback, sizeof(callback));
      if (osStatus != noErr || AudioUnitInitialize(unit_) != noErr) {
        return fail(AudioHostError::ProviderFailure,
                    "could not initialize RemoteIO rendering");
      }
      initialized_ = true;

      AudioStreamBasicDescription acceptedOutput{};
      propertySize = sizeof(acceptedOutput);
      osStatus = AudioUnitGetProperty(
          unit_, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input, 0,
          &acceptedOutput, &propertySize);
      if (osStatus != noErr ||
          !isPlanarFloat32(acceptedOutput, format_.sampleRate,
                           format_.outputChannels)) {
        return fail(AudioHostError::ProviderFailure,
                    "RemoteIO did not accept the planar float32 output boundary");
      }
      if (hasInput) {
        AudioStreamBasicDescription acceptedInput{};
        propertySize = sizeof(acceptedInput);
        osStatus = AudioUnitGetProperty(
            unit_, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Output, 1,
            &acceptedInput, &propertySize);
        if (osStatus != noErr ||
            !isPlanarFloat32(acceptedInput, format_.sampleRate,
                             format_.inputChannels)) {
          return fail(AudioHostError::ProviderFailure,
                      "RemoteIO did not accept the planar float32 input boundary");
        }
      }
      if (!sessionStillReady() || pendingSignals() != 0) {
        return fail(AudioHostError::ProviderFailure,
                    "iOS audio route changed while RemoteIO was opening");
      }
      state_.store(AudioHostState::Open, std::memory_order_release);
      return {true, AudioHostError::None, AudioHostState::Open, format_,
              latency_, {}};
    }
  }

  AudioHostResult start() override {
    @autoreleasepool {
      if (!initialized_ || unit_ == nullptr ||
          state_.load(std::memory_order_acquire) != AudioHostState::Open) {
        return {false, AudioHostError::InvalidState,
                state_.load(std::memory_order_acquire), format_, latency_,
                "open RemoteIO before starting it"};
      }
      if (!sessionStillReady() || pendingSignals() != 0) {
        return fail(AudioHostError::ProviderFailure,
                    "iOS audio route changed before RemoteIO started");
      }
      callback_->admission.open();
      activateAudioHostCallback(&callback_->endpoint);
      startAttempted_ = true;
      const OSStatus osStatus = AudioOutputUnitStart(unit_);
      if (osStatus != noErr) {
        callback_->admission.beginClose();
        deactivateAudioHostCallback(&callback_->endpoint);
        return fail(AudioHostError::ProviderFailure,
                    osStatusMessage("start RemoteIO", osStatus));
      }
      started_ = true;
      if (!sessionStillReady() || pendingSignals() != 0) {
        return fail(AudioHostError::ProviderFailure,
                    "iOS audio route changed while RemoteIO started");
      }
      state_.store(AudioHostState::Running, std::memory_order_release);
      return {true, AudioHostError::None, AudioHostState::Running, format_,
              latency_, {}};
    }
  }

  void stop() noexcept override {
    @autoreleasepool {
      if (quarantined_) {
        state_.store(AudioHostState::Error, std::memory_order_release);
        return;
      }
      callback_->admission.beginClose();
      deactivateAudioHostCallback(&callback_->endpoint);
      removeObservers();
      OSStatus stopStatus = noErr;
      if ((started_ || startAttempted_) && unit_ != nullptr) {
        stopStatus = AudioOutputUnitStop(unit_);
        recordProviderFailure(stopStatus);
      }
      while (callback_->admission.inFlight() != 0) {
        std::this_thread::yield();
      }
      while (callback_->endpoint.inFlight.load(std::memory_order_acquire) != 0) {
        std::this_thread::yield();
      }
      if (stopStatus != noErr) {
        // Core Audio did not establish that new callbacks have stopped. The
        // packed admission state proves every callback admitted before close
        // has returned, so buffers and graph state may retire; rejected late
        // callbacks touch only the retained context and their output buffer.
        retireRouteGeneration();
        callback_->inputList = nullptr;
        callback_->signals = nullptr;
        inputListStorage_.clear();
        inputSamples_.clear();
        signals_.reset();
        AudioUnit retiredUnit = unit_;
        unit_ = nullptr;
        initialized_ = false;
        started_ = false;
        startAttempted_ = false;
        inputList_ = nullptr;
        openedSnapshot_ = {};
        poisonIosAudioHostProcessLease(this, retiredUnit,
                                       std::move(callbackOwner_));
        leaseHeld_ = false;
        quarantined_ = true;
        state_.store(AudioHostState::Error, std::memory_order_release);
        return;
      }
      // A successful AudioOutputUnitStop is the platform boundary after which
      // no new render callback begins. Wait callbacks that entered before the
      // stop returned before uninitializing or disposing their AudioUnit.
      while (callback_->callbackInFlight.load(std::memory_order_acquire) != 0) {
        std::this_thread::yield();
      }
      if (initialized_ && unit_ != nullptr) {
        recordProviderFailure(AudioUnitUninitialize(unit_));
      }
      AudioUnit unitForDispose = unit_;
      OSStatus disposeStatus = noErr;
      if (unit_ != nullptr) {
        disposeStatus = AudioComponentInstanceDispose(unit_);
        recordProviderFailure(disposeStatus);
      }
      retireRouteGeneration();
      unit_ = nullptr;
      initialized_ = false;
      started_ = false;
      startAttempted_ = false;
      inputList_ = nullptr;
      openedSnapshot_ = {};
      if (disposeStatus == noErr) {
        callback_->unit = nullptr;
        callback_->inputList = nullptr;
        callback_->signals = nullptr;
        inputListStorage_.clear();
        inputSamples_.clear();
        signals_.reset();
        if (leaseHeld_) releaseIosAudioHostProcessLease(this);
      } else {
        // The callback context has process lifetime through the bounded
        // one-slot quarantine. Closed admission is checked before any of its
        // non-owning stream pointers, so the backend storage may now retire.
        callback_->inputList = nullptr;
        callback_->signals = nullptr;
        poisonIosAudioHostProcessLease(this, unitForDispose,
                                       std::move(callbackOwner_));
        inputListStorage_.clear();
        inputSamples_.clear();
        signals_.reset();
        quarantined_ = true;
      }
      leaseHeld_ = false;
      const AudioHostState previous =
          state_.load(std::memory_order_acquire);
      state_.store(providerFailure_.load(std::memory_order_acquire) != 0
                       ? AudioHostState::Error
                       : (previous == AudioHostState::Closed
                              ? AudioHostState::Closed
                              : AudioHostState::Stopped),
                   std::memory_order_release);
      // AVAudioSession category, mode, activation, route, sample-rate and
      // buffer preferences remain exclusively owned by the app coordinator.
    }
  }

  AudioHostStatus status() const noexcept override {
    AudioHostStatus result;
    const uint32_t pending = pendingSignals();
    const int32_t callbackFailure =
        callback_->callbackFailure.load(std::memory_order_acquire);
    const int32_t providerFailure =
        providerFailure_.load(std::memory_order_acquire);
    if ((pending & kMediaServicesLost) != 0) {
      result.state = AudioHostState::DeviceLost;
    } else if (pending != 0 || callbackFailure != 0 || providerFailure != 0) {
      result.state = AudioHostState::Error;
    } else {
      result.state = state_.load(std::memory_order_acquire);
    }
    result.format = format_;
    result.latency = latency_;
    result.routeGeneration = signals_
                                 ? signals_->routeGeneration.load(
                                       std::memory_order_relaxed)
                                 : lastRouteGeneration_.load(
                                       std::memory_order_relaxed);
    result.streamGeneration =
        streamGeneration_.load(std::memory_order_relaxed);
    result.callbacks = callback_->endpoint.callbacks.load(std::memory_order_relaxed);
    result.renderedFrames =
        callback_->endpoint.renderedFrames.load(std::memory_order_relaxed);
    result.xruns = callback_->endpoint.xruns.load(std::memory_order_relaxed);
    result.deadlineMisses =
        callback_->endpoint.deadlineMisses.load(std::memory_order_relaxed);
    result.discontinuities =
        callback_->endpoint.discontinuities.load(std::memory_order_relaxed);
    result.invalidCallbacks =
        callback_->endpoint.invalidCallbacks.load(std::memory_order_relaxed);
    result.renderFailures =
        callback_->endpoint.renderFailures.load(std::memory_order_relaxed);
    result.diagnostics.inputPeriodFrames = format_.nominalBufferFrames;
    result.diagnostics.outputPeriodFrames = format_.nominalBufferFrames;
    result.diagnostics.inputBufferFrames =
        format_.inputChannels == 0 ? 0 : format_.nominalBufferFrames;
    result.diagnostics.outputBufferFrames = format_.nominalBufferFrames;
    return result;
  }

 private:
  uint32_t pendingSignals() const noexcept {
    return signals_
               ? signals_->pending.load(std::memory_order_acquire)
               : 0;
  }

  bool sessionStillReady() const {
    if (!signals_ || !inputPolicy_) return false;
    const detail::IosAudioHostSessionSnapshot current =
        sessionSnapshot(signals_, inputPolicy_);
    return detail::sameIosAudioHostSession(openedSnapshot_, current);
  }

  void installObservers(
      const std::shared_ptr<detail::IosAudioHostSessionSignals>& signals) {
    NSNotificationCenter* center = NSNotificationCenter.defaultCenter;
    auto notify = ^(uint32_t reason) {
      signals->routeGeneration.fetch_add(1, std::memory_order_release);
      signals->pending.fetch_or(reason, std::memory_order_release);
    };
    routeObserver_ = [center
        addObserverForName:AVAudioSessionRouteChangeNotification
                    object:nil
                     queue:nil
                usingBlock:^(NSNotification*) { notify(kRouteChanged); }];
    interruptionObserver_ = [center
        addObserverForName:AVAudioSessionInterruptionNotification
                    object:nil
                     queue:nil
                usingBlock:^(NSNotification*) { notify(kInterrupted); }];
    mediaLostObserver_ = [center
        addObserverForName:AVAudioSessionMediaServicesWereLostNotification
                    object:nil
                     queue:nil
                usingBlock:^(NSNotification*) { notify(kMediaServicesLost); }];
    mediaResetObserver_ = [center
        addObserverForName:AVAudioSessionMediaServicesWereResetNotification
                    object:nil
                     queue:nil
                usingBlock:^(NSNotification*) { notify(kMediaServicesReset); }];
  }

  void removeObservers() noexcept {
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

  void resetCounters() noexcept {
    callback_->endpoint.callbacks.store(0, std::memory_order_relaxed);
    callback_->endpoint.renderedFrames.store(0, std::memory_order_relaxed);
    callback_->endpoint.xruns.store(0, std::memory_order_relaxed);
    callback_->endpoint.deadlineMisses.store(0, std::memory_order_relaxed);
    callback_->endpoint.discontinuities.store(0, std::memory_order_relaxed);
    callback_->endpoint.invalidCallbacks.store(0, std::memory_order_relaxed);
    callback_->endpoint.renderFailures.store(0, std::memory_order_relaxed);
  }

  void retireRouteGeneration() noexcept {
    if (!signals_) return;
    const uint64_t finalGeneration =
        signals_->routeGeneration.load(std::memory_order_relaxed);
    if (finalGeneration >
        lastRouteGeneration_.load(std::memory_order_relaxed)) {
      lastRouteGeneration_.store(finalGeneration, std::memory_order_relaxed);
    }
  }

  void recordProviderFailure(OSStatus status) noexcept {
    if (status == noErr) return;
    int32_t expected = 0;
    providerFailure_.compare_exchange_strong(
        expected, static_cast<int32_t>(status), std::memory_order_release,
        std::memory_order_relaxed);
  }

  AudioHostResult fail(AudioHostError error, std::string message) {
    stop();
    state_.store(AudioHostState::Error, std::memory_order_release);
    return {false, error, AudioHostState::Error, {}, {}, std::move(message)};
  }

  AudioHostResult reject(AudioHostError error, std::string message,
                         AudioHostState state = AudioHostState::Error) {
    state_.store(state, std::memory_order_release);
    return {false, error, state, {}, {}, std::move(message)};
  }

  std::shared_ptr<IosAudioInputSessionPolicy> inputPolicy_;
  AudioUnit unit_{nullptr};
  bool initialized_{false};
  bool started_{false};
  AudioHostFormat format_{};
  AudioHostLatency latency_{};
  detail::IosAudioHostSessionSnapshot openedSnapshot_{};
  std::unique_ptr<detail::IosAudioHostCallbackContext> callbackOwner_{
      std::make_unique<detail::IosAudioHostCallbackContext>()};
  detail::IosAudioHostCallbackContext* callback_{callbackOwner_.get()};
  std::atomic<AudioHostState> state_{AudioHostState::Closed};
  std::atomic<uint64_t> lastRouteGeneration_{0};
  std::atomic<uint64_t> streamGeneration_{0};
  std::atomic<int32_t> providerFailure_{0};
  bool startAttempted_{false};
  bool leaseHeld_{false};
  bool quarantined_{false};
  std::vector<float> inputSamples_;
  std::vector<std::max_align_t> inputListStorage_;
  AudioBufferList* inputList_{nullptr};
  std::shared_ptr<detail::IosAudioHostSessionSignals> signals_;
  id routeObserver_ = nil;
  id interruptionObserver_ = nil;
  id mediaLostObserver_ = nil;
  id mediaResetObserver_ = nil;
};

}  // namespace

std::unique_ptr<AudioHostBackend> createPlatformAudioHostBackend() {
  return std::make_unique<IosAudioHostBackend>();
}

}  // namespace singz

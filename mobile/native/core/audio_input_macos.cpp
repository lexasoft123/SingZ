#include "audio_input_backend.h"

#if defined(__APPLE__)
#include <TargetConditionals.h>
#endif

#if defined(__APPLE__) && TARGET_OS_OSX

#include <AudioToolbox/AudioToolbox.h>
#include <CoreAudio/CoreAudio.h>
#include <CoreFoundation/CoreFoundation.h>
#include <Block.h>
#include <dispatch/dispatch.h>
#include <mach/mach_time.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <limits>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "audio_input_timestamp.h"

namespace singz {
namespace {

constexpr uint32_t kMaximumFrames = 16384;
constexpr uint32_t kDeviceAliveChanged = 1u << 0;
constexpr uint32_t kSampleRateChanged = 1u << 1;
constexpr uint32_t kStreamConfigurationChanged = 1u << 2;

struct DeviceListenerContext {
  std::atomic<uint32_t> pendingChanges{0};
};

struct RetiredDeviceListener {
  std::shared_ptr<DeviceListenerContext> context;
  dispatch_queue_t queue = nullptr;
  AudioObjectPropertyListenerBlock block = nullptr;
};

// Listener removal failure is exceptional (normally only a broken/disappeared
// AudioObject). Quarantine just those callbacks; every successful capture is
// reclaimed after a dispatch-queue execution barrier.
std::mutex& quarantinedListenerMutex() {
  // Deliberately process-lifetime: if CoreAudio refuses listener removal, a
  // registered block may remain callable until process exit. A normal static
  // destructor would release its raw-captured context during library teardown
  // while CoreAudio threads can still run.
  static std::mutex* mutex = new std::mutex();
  return *mutex;
}

std::vector<RetiredDeviceListener>& quarantinedListeners() {
  // Exceptional removal failures leak one tiny queue/block/context by design.
  // Successful captures take the dispatch barrier path and never enter here.
  static std::vector<RetiredDeviceListener>* listeners =
      new std::vector<RetiredDeviceListener>();
  return *listeners;
}

AudioObjectPropertyAddress address(AudioObjectPropertySelector selector,
                                   AudioObjectPropertyScope scope,
                                   AudioObjectPropertyElement element = kAudioObjectPropertyElementMain) {
  return {selector, scope, element};
}

template <typename T>
bool getProperty(AudioObjectID object, AudioObjectPropertyAddress property, T& value) {
  UInt32 size = sizeof(value);
  return AudioObjectGetPropertyData(object, &property, 0, nullptr, &size, &value) == noErr &&
         size == sizeof(value);
}

std::string cfString(CFStringRef value) {
  if (!value) return {};
  const CFIndex length = CFStringGetLength(value);
  const CFIndex maxBytes = CFStringGetMaximumSizeForEncoding(length, kCFStringEncodingUTF8) + 1;
  if (maxBytes <= 1 || maxBytes > 65536) return {};
  std::vector<char> bytes(static_cast<size_t>(maxBytes));
  if (!CFStringGetCString(value, bytes.data(), maxBytes, kCFStringEncodingUTF8)) return {};
  return bytes.data();
}

std::string stringProperty(AudioObjectID object, AudioObjectPropertyAddress property) {
  CFStringRef value = nullptr;
  UInt32 size = sizeof(value);
  if (AudioObjectGetPropertyData(object, &property, 0, nullptr, &size, &value) != noErr || !value)
    return {};
  const std::string result = cfString(value);
  CFRelease(value);
  return result;
}

uint32_t inputChannelCount(AudioDeviceID device) {
  AudioObjectPropertyAddress property = address(kAudioDevicePropertyStreamConfiguration,
                                                kAudioDevicePropertyScopeInput);
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(device, &property, 0, nullptr, &size) != noErr ||
      size < offsetof(AudioBufferList, mBuffers) + sizeof(AudioBuffer)) {
    return 0;
  }
  std::vector<uint8_t> storage(size);
  AudioBufferList* list = reinterpret_cast<AudioBufferList*>(storage.data());
  if (AudioObjectGetPropertyData(device, &property, 0, nullptr, &size, list) != noErr) return 0;
  uint64_t total = 0;
  for (UInt32 i = 0; i < list->mNumberBuffers; ++i) total += list->mBuffers[i].mNumberChannels;
  // A bounded public/device protocol and a bounded channel-label loop. No
  // real interface approaches this; reject corrupt driver metadata instead
  // of allocating from it.
  return total <= 4096 ? static_cast<uint32_t>(total) : 0;
}

std::vector<AudioDeviceID> allDeviceIds(std::string* error) {
  AudioObjectPropertyAddress property = address(kAudioHardwarePropertyDevices,
                                                kAudioObjectPropertyScopeGlobal);
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &property, 0, nullptr, &size) != noErr ||
      size % sizeof(AudioDeviceID) != 0 || size > sizeof(AudioDeviceID) * 4096u) {
    if (error) *error = "CoreAudio could not enumerate devices";
    return {};
  }
  std::vector<AudioDeviceID> devices(size / sizeof(AudioDeviceID));
  if (size && AudioObjectGetPropertyData(kAudioObjectSystemObject, &property, 0, nullptr, &size,
                                         devices.data()) != noErr) {
    if (error) *error = "CoreAudio could not read devices";
    return {};
  }
  return devices;
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

class MacAudioInputBackend final : public AudioInputBackend {
 public:
  ~MacAudioInputBackend() override { stop(); }

  AudioInputResult open(const AudioInputConfig& config, AudioInputPush push,
                        void* context) override {
    stop();
    push_ = push;
    context_ = context;

    AudioDeviceID selected = kAudioObjectUnknown;
    std::string enumerationError;
    for (const AudioDeviceID device : allDeviceIds(&enumerationError)) {
      const std::string uid = stringProperty(
          device, address(kAudioDevicePropertyDeviceUID, kAudioObjectPropertyScopeGlobal));
      if (uid == config.deviceUid) {
        selected = device;
        break;
      }
    }
    if (selected == kAudioObjectUnknown)
      return AudioInputResult::failure(
          AudioInputState::Error,
          enumerationError.empty() ? "audio input device disappeared" : enumerationError,
          config.channel);
    const uint32_t channels = inputChannelCount(selected);
    if (config.channel >= channels)
      return AudioInputResult::failure(
          AudioInputState::Error, "audio input channel disappeared", config.channel);
    UInt32 alive = 0;
    if (!getProperty(selected,
                     address(kAudioDevicePropertyDeviceIsAlive,
                             kAudioObjectPropertyScopeGlobal),
                     alive) || !alive)
      return AudioInputResult::failure(
          AudioInputState::Error, "audio input device is not alive", config.channel);
    selectedDevice_ = selected;
    channel_ = config.channel;

    Float64 nominalRate = 0;
    if (!getProperty(selected,
                     address(kAudioDevicePropertyNominalSampleRate,
                             kAudioObjectPropertyScopeGlobal),
                    nominalRate) || !std::isfinite(nominalRate) || nominalRate <= 0) {
      return AudioInputResult::failure(
          AudioInputState::Error, "audio input sample rate is unavailable", config.channel);
    }

    AudioComponentDescription description{};
    description.componentType = kAudioUnitType_Output;
    description.componentSubType = kAudioUnitSubType_HALOutput;
    description.componentManufacturer = kAudioUnitManufacturer_Apple;
    const AudioComponent component = AudioComponentFindNext(nullptr, &description);
    if (!component)
      return AudioInputResult::failure(
          AudioInputState::Error, "CoreAudio HAL output unit is unavailable", config.channel);
    OSStatus status = AudioComponentInstanceNew(component, &unit_);
    if (status != noErr) return fail("AudioComponentInstanceNew", status, config.channel);

    UInt32 enabled = 1;
    status = AudioUnitSetProperty(unit_, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Input,
                                  1, &enabled, sizeof(enabled));
    if (status != noErr) return fail("enable AUHAL input", status, config.channel);
    UInt32 disabled = 0;
    status = AudioUnitSetProperty(unit_, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Output,
                                  0, &disabled, sizeof(disabled));
    if (status != noErr) return fail("disable AUHAL output", status, config.channel);
    status = AudioUnitSetProperty(unit_, kAudioOutputUnitProperty_CurrentDevice,
                                  kAudioUnitScope_Global, 0, &selected, sizeof(selected));
    if (status != noErr) return fail("select AUHAL device", status, config.channel);

    AudioStreamBasicDescription format{};
    format.mSampleRate = nominalRate;
    format.mFormatID = kAudioFormatLinearPCM;
    format.mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked |
                          kAudioFormatFlagIsNonInterleaved | kAudioFormatFlagsNativeEndian;
    format.mBytesPerPacket = sizeof(float);
    format.mFramesPerPacket = 1;
    format.mBytesPerFrame = sizeof(float);
    format.mChannelsPerFrame = 1;
    format.mBitsPerChannel = 32;
    status = AudioUnitSetProperty(unit_, kAudioUnitProperty_StreamFormat,
                                  kAudioUnitScope_Output, 1, &format, sizeof(format));
    if (status != noErr) return fail("set AUHAL client format", status, config.channel);

    SInt32 mappedChannel = 0;
    std::string mapError;
    if (!makeAudioInputChannelMap(config.channel, channels, mappedChannel, mapError))
      return failMessage(std::move(mapError), config.channel);
    const SInt32 channelMap[1] = {mappedChannel};
    status = AudioUnitSetProperty(unit_, kAudioOutputUnitProperty_ChannelMap,
                                  kAudioUnitScope_Output, 1, channelMap, sizeof(channelMap));
    if (status != noErr) return fail("set AUHAL input channel map", status, config.channel);

    UInt32 maxFrames = 0;
    UInt32 propertySize = sizeof(maxFrames);
    status = AudioUnitGetProperty(unit_, kAudioUnitProperty_MaximumFramesPerSlice,
                                  kAudioUnitScope_Global, 0, &maxFrames, &propertySize);
    if (status != noErr || maxFrames == 0) maxFrames = 4096;
    if (maxFrames > kMaximumFrames)
      return failMessage("audio device callback is larger than the core limit", config.channel);
    renderBuffer_.resize(maxFrames);
    mach_timebase_info_data_t timebase{};
    if (mach_timebase_info(&timebase) != KERN_SUCCESS || !timebase.denom)
      return failMessage("mach host-time conversion is unavailable", config.channel);
    nsPerHostTick_ = static_cast<double>(timebase.numer) / timebase.denom;

    AURenderCallbackStruct callback{renderCallback, this};
    status = AudioUnitSetProperty(unit_, kAudioOutputUnitProperty_SetInputCallback,
                                  kAudioUnitScope_Global, 0, &callback, sizeof(callback));
    if (status != noErr) return fail("set AUHAL input callback", status, config.channel);
    status = AudioUnitInitialize(unit_);
    if (status != noErr) return fail("initialize AUHAL", status, config.channel);
    initialized_ = true;
    listenerContext_ = std::make_shared<DeviceListenerContext>();
    listenerQueue_ = dispatch_queue_create("com.lexasoft.singz.audio-input-device", nullptr);
    if (!listenerQueue_)
      return failMessage("could not create audio device listener queue", config.channel);
    DeviceListenerContext* listener = listenerContext_.get();
    listenerBlock_ = Block_copy(^(UInt32 count,
                                  const AudioObjectPropertyAddress properties[]) {
      uint32_t changes = 0;
      for (UInt32 i = 0; i < count; ++i) {
        if (properties[i].mSelector == kAudioDevicePropertyDeviceIsAlive)
          changes |= kDeviceAliveChanged;
        else if (properties[i].mSelector == kAudioDevicePropertyNominalSampleRate)
          changes |= kSampleRateChanged;
        else if (properties[i].mSelector == kAudioDevicePropertyStreamConfiguration)
          changes |= kStreamConfigurationChanged;
      }
      if (changes) listener->pendingChanges.fetch_or(changes, std::memory_order_release);
    });
    const AudioObjectPropertyAddress watched[] = {
        address(kAudioDevicePropertyDeviceIsAlive, kAudioObjectPropertyScopeGlobal),
        address(kAudioDevicePropertyNominalSampleRate, kAudioObjectPropertyScopeGlobal),
        address(kAudioDevicePropertyStreamConfiguration, kAudioDevicePropertyScopeInput)};
    for (const AudioObjectPropertyAddress& property : watched) {
      status = AudioObjectAddPropertyListenerBlock(selectedDevice_, &property,
                                                   listenerQueue_, listenerBlock_);
      if (status != noErr) return fail("watch AUHAL device", status, config.channel);
      watchedProperties_.push_back(property);
    }
    sampleRate_ = nominalRate;
    callbackFailure_.store(0, std::memory_order_relaxed);
    return AudioInputResult::success(AudioInputState::Starting, sampleRate_, channel_);
  }

  AudioInputResult start() override {
    if (!unit_ || !initialized_)
      return AudioInputResult::failure(
          AudioInputState::Error, "AUHAL is not prepared", channel_);
    const OSStatus status = AudioOutputUnitStart(unit_);
    if (status != noErr) return fail("start AUHAL", status, channel_);
    started_ = true;
    return AudioInputResult::success(AudioInputState::Running, sampleRate_, channel_);
  }

  void stop() override {
    bool removedAll = true;
    if (selectedDevice_ != kAudioObjectUnknown && listenerContext_) {
      for (const AudioObjectPropertyAddress& property : watchedProperties_) {
        if (AudioObjectRemovePropertyListenerBlock(selectedDevice_, &property,
                                                   listenerQueue_, listenerBlock_) != noErr)
          removedAll = false;
      }
      // A successful remove prevents new submissions. A synchronous no-op on
      // the dedicated serial queue is the execution barrier for callbacks
      // submitted before removal returned, closing the listener entry race.
      if (removedAll) {
        dispatch_sync_f(listenerQueue_, nullptr, [](void*) {});
        Block_release(listenerBlock_);
        dispatch_release(listenerQueue_);
      } else {
        std::lock_guard<std::mutex> lock(quarantinedListenerMutex());
        quarantinedListeners().push_back(
            {listenerContext_, listenerQueue_, listenerBlock_});
      }
    }
    watchedProperties_.clear();
    listenerContext_.reset();
    listenerQueue_ = nullptr;
    listenerBlock_ = nullptr;
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
    selectedDevice_ = kAudioObjectUnknown;
  }

  bool takeFailure(std::string& error) override {
    const uint32_t changes = listenerContext_
                                 ? listenerContext_->pendingChanges.exchange(
                                       0, std::memory_order_acq_rel)
                                 : 0;
    if (changes & kDeviceAliveChanged) {
      UInt32 alive = 0;
      if (!getProperty(selectedDevice_,
                       address(kAudioDevicePropertyDeviceIsAlive,
                               kAudioObjectPropertyScopeGlobal),
                       alive) || !alive) {
        error = "audio input device disconnected";
        return true;
      }
    }
    if (changes & kSampleRateChanged) {
      Float64 nominalRate = 0;
      if (!getProperty(selectedDevice_,
                       address(kAudioDevicePropertyNominalSampleRate,
                               kAudioObjectPropertyScopeGlobal),
                       nominalRate) || !std::isfinite(nominalRate) || nominalRate <= 0 ||
          nominalRate != sampleRate_) {
        error = "audio input sample rate changed; restart capture";
        return true;
      }
    }
    if (changes & kStreamConfigurationChanged) {
      const uint32_t channels = inputChannelCount(selectedDevice_);
      error = channel_ >= channels
                  ? "audio input channel disappeared"
                  : "audio input stream configuration changed; restart capture";
      return true;
    }
    const int32_t status = callbackFailure_.exchange(0, std::memory_order_acq_rel);
    if (!status) return false;
    error = status == kCallbackTooLarge
                ? "audio input callback exceeded the prepared buffer"
                : osStatusMessage("AUHAL render callback", static_cast<OSStatus>(status));
    return true;
  }

 private:
  static constexpr int32_t kCallbackTooLarge = std::numeric_limits<int32_t>::min();

  static OSStatus renderCallback(void* context, AudioUnitRenderActionFlags* flags,
                                 const AudioTimeStamp* timestamp, UInt32,
                                 UInt32 frames, AudioBufferList*) {
    const uint64_t callbackTicks = mach_absolute_time();
    MacAudioInputBackend* self = static_cast<MacAudioInputBackend*>(context);
    if (!self || !self->unit_ || !self->push_ || frames == 0)
      return noErr;
    if (frames > self->renderBuffer_.size()) {
      self->callbackFailure_.store(kCallbackTooLarge, std::memory_order_release);
      return noErr;
    }
    AudioBufferList list{};
    list.mNumberBuffers = 1;
    list.mBuffers[0].mNumberChannels = 1;
    list.mBuffers[0].mDataByteSize = frames * sizeof(float);
    list.mBuffers[0].mData = self->renderBuffer_.data();
    const OSStatus status = AudioUnitRender(self->unit_, flags, timestamp, 1, frames, &list);
    if (status != noErr) {
      // Some drivers stop invoking the callback after the first render error,
      // so waiting for repeated failures can lose the only notification.
      self->callbackFailure_.store(static_cast<int32_t>(status), std::memory_order_release);
      return status;
    }
    const uint64_t callbackNs = static_cast<uint64_t>(
        static_cast<long double>(callbackTicks) *
        static_cast<long double>(self->nsPerHostTick_));
    const bool hardwareValid =
        timestamp && (timestamp->mFlags & kAudioTimeStampHostTimeValid) &&
        timestamp->mHostTime != 0;
    const uint64_t hardwareNs = hardwareValid
        ? static_cast<uint64_t>(static_cast<long double>(timestamp->mHostTime) *
                                static_cast<long double>(self->nsPerHostTick_))
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

  AudioInputResult fail(const char* operation, OSStatus status, uint32_t channel) {
    return failMessage(osStatusMessage(operation, status), channel);
  }

  AudioInputResult failMessage(std::string message, uint32_t channel) {
    stop();
    return AudioInputResult::failure(AudioInputState::Error, std::move(message), channel);
  }

  AudioUnit unit_ = nullptr;
  bool initialized_ = false;
  bool started_ = false;
  AudioDeviceID selectedDevice_ = kAudioObjectUnknown;
  double sampleRate_ = 0;
  uint32_t channel_ = 0;
  double nsPerHostTick_ = 0;
  std::vector<float> renderBuffer_;
  AudioInputPush push_ = nullptr;
  void* context_ = nullptr;
  std::atomic<int32_t> callbackFailure_{0};
  std::shared_ptr<DeviceListenerContext> listenerContext_;
  dispatch_queue_t listenerQueue_ = nullptr;
  AudioObjectPropertyListenerBlock listenerBlock_ = nullptr;
  std::vector<AudioObjectPropertyAddress> watchedProperties_;
};

}  // namespace

std::vector<AudioInputDevice> enumeratePlatformAudioInputDevices(std::string* error) {
  if (error) error->clear();
  AudioDeviceID defaultInput = kAudioObjectUnknown;
  getProperty(kAudioObjectSystemObject,
              address(kAudioHardwarePropertyDefaultInputDevice,
                      kAudioObjectPropertyScopeGlobal),
              defaultInput);
  std::vector<AudioInputDevice> result;
  for (const AudioDeviceID device : allDeviceIds(error)) {
    const uint32_t channels = inputChannelCount(device);
    if (channels == 0) continue;
    AudioInputDevice item;
    item.uid = stringProperty(
        device, address(kAudioDevicePropertyDeviceUID, kAudioObjectPropertyScopeGlobal));
    item.label = stringProperty(
        device, address(kAudioObjectPropertyName, kAudioObjectPropertyScopeGlobal));
    Float64 sampleRate = 0;
    getProperty(device,
                address(kAudioDevicePropertyNominalSampleRate,
                        kAudioObjectPropertyScopeGlobal),
                sampleRate);
    item.sampleRate = sampleRate;
    item.channels = channels;
    item.isDefault = device == defaultInput;
    if (item.uid.empty()) continue;
    if (item.label.empty()) item.label = "Audio input";
    item.channelLabels.reserve(channels);
    for (uint32_t channel = 0; channel < channels; ++channel) {
      std::string label = stringProperty(
          device, address(kAudioObjectPropertyElementName,
                          kAudioDevicePropertyScopeInput,
                          static_cast<AudioObjectPropertyElement>(channel + 1)));
      if (label.empty()) label = "Channel " + std::to_string(channel + 1);
      item.channelLabels.push_back(std::move(label));
    }
    result.push_back(std::move(item));
  }
  return result;
}

std::unique_ptr<AudioInputBackend> createPlatformAudioInputBackend() {
  return std::make_unique<MacAudioInputBackend>();
}

}  // namespace singz

#endif  // __APPLE__ && TARGET_OS_OSX

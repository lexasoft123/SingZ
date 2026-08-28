#include <zcore/device/audio_host.h>

#include <AudioToolbox/AudioToolbox.h>
#include <CoreAudio/CoreAudio.h>
#include <CoreFoundation/CoreFoundation.h>
#include <Block.h>
#include <dispatch/dispatch.h>
#include <mach/mach_time.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <zcore/device/audio_host_callback.h>
#include <zcore/audio/audio_input_timestamp.h>

#include "audio_host_macos_helpers.h"

namespace singz {
namespace {

constexpr uint32_t kAliveChanged = 1u << 0;
constexpr uint32_t kFormatChanged = 1u << 1;

struct HostDeviceListenerContext {
  std::atomic<uint32_t> pendingChanges{0};
  std::atomic<uint64_t> routeGeneration{1};
  std::atomic<bool> routeChanged{false};
};

struct RetiredHostDeviceListener {
  std::shared_ptr<HostDeviceListenerContext> context;
  dispatch_queue_t queue{nullptr};
  AudioObjectPropertyListenerBlock block{nullptr};
};

std::mutex& quarantinedListenerMutex() {
  static std::mutex* value = new std::mutex();
  return *value;
}

std::vector<RetiredHostDeviceListener>& quarantinedListeners() {
  static std::vector<RetiredHostDeviceListener>* value =
      new std::vector<RetiredHostDeviceListener>();
  return *value;
}

AudioObjectPropertyAddress property(AudioObjectPropertySelector selector,
                                    AudioObjectPropertyScope scope,
                                    AudioObjectPropertyElement element =
                                        kAudioObjectPropertyElementMain) {
  return {selector, scope, element};
}

template <typename T>
bool readProperty(AudioObjectID object, AudioObjectPropertyAddress address,
                  T* value) {
  UInt32 size = sizeof(T);
  return AudioObjectGetPropertyData(object, &address, 0, nullptr, &size, value) == noErr &&
         size == sizeof(T);
}

std::string readString(AudioObjectID object, AudioObjectPropertyAddress address) {
  CFStringRef value = nullptr;
  UInt32 size = sizeof(value);
  if (AudioObjectGetPropertyData(object, &address, 0, nullptr, &size, &value) != noErr ||
      value == nullptr) {
    return {};
  }
  const CFIndex characters = CFStringGetLength(value);
  const CFIndex capacity =
      CFStringGetMaximumSizeForEncoding(characters, kCFStringEncodingUTF8) + 1;
  std::string result;
  if (capacity > 1 && capacity <= 65536) {
    std::vector<char> bytes(static_cast<size_t>(capacity));
    if (CFStringGetCString(value, bytes.data(), capacity, kCFStringEncodingUTF8)) {
      result = bytes.data();
    }
  }
  CFRelease(value);
  return result;
}

uint32_t channelCount(AudioDeviceID device, AudioObjectPropertyScope scope) {
  auto address = property(kAudioDevicePropertyStreamConfiguration, scope);
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(device, &address, 0, nullptr, &size) != noErr ||
      size < offsetof(AudioBufferList, mBuffers) + sizeof(AudioBuffer) || size > 1024 * 1024) {
    return 0;
  }
  std::vector<uint8_t> storage(size);
  auto* list = reinterpret_cast<AudioBufferList*>(storage.data());
  if (AudioObjectGetPropertyData(device, &address, 0, nullptr, &size, list) != noErr) return 0;
  uint64_t channels = 0;
  for (UInt32 index = 0; index < list->mNumberBuffers; ++index) {
    channels += list->mBuffers[index].mNumberChannels;
  }
  return channels <= kAudioHostMaxChannels ? static_cast<uint32_t>(channels) : 0;
}

std::vector<std::string> channelLabels(AudioDeviceID device,
                                       AudioObjectPropertyScope scope,
                                       uint32_t count,
                                       const char* fallbackPrefix) {
  std::vector<std::string> result;
  result.reserve(count);
  for (uint32_t channel = 0; channel < count; ++channel) {
    const auto element = static_cast<AudioObjectPropertyElement>(channel + 1);
    std::string label = readString(
        device, property(kAudioObjectPropertyElementName, scope, element));
    if (label.empty()) {
      const std::string category = readString(
          device, property(kAudioObjectPropertyElementCategoryName, scope, element));
      const std::string number = readString(
          device, property(kAudioObjectPropertyElementNumberName, scope, element));
      if (!category.empty())
        label = category + (number.empty() ? " " + std::to_string(channel + 1)
                                           : " " + number);
      else
        label = number;
    }
    if (label.empty()) label = std::string(fallbackPrefix) + " " +
                               std::to_string(channel + 1);
    result.push_back(std::move(label));
  }
  return result;
}

std::vector<AudioDeviceID> devices() {
  auto address = property(kAudioHardwarePropertyDevices, kAudioObjectPropertyScopeGlobal);
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &address, 0, nullptr,
                                     &size) != noErr ||
      size % sizeof(AudioDeviceID) != 0 || size > 4096 * sizeof(AudioDeviceID)) {
    return {};
  }
  std::vector<AudioDeviceID> result(size / sizeof(AudioDeviceID));
  if (size != 0 && AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0,
                                               nullptr, &size, result.data()) != noErr) {
    return {};
  }
  return result;
}

AudioDeviceID findDevice(const std::string& uid) {
  for (AudioDeviceID device : devices()) {
    if (readString(device, property(kAudioDevicePropertyDeviceUID,
                                    kAudioObjectPropertyScopeGlobal)) == uid) {
      return device;
    }
  }
  return kAudioObjectUnknown;
}

bool validMap(const std::vector<uint32_t>& channels, uint32_t available) {
  if (channels.empty() || channels.size() > kAudioHostMaxChannels) return false;
  for (size_t index = 0; index < channels.size(); ++index) {
    if (channels[index] >= available) return false;
    for (size_t previous = 0; previous < index; ++previous) {
      if (channels[index] == channels[previous]) return false;
    }
  }
  return true;
}

AudioHostResult failure(AudioHostError error, const std::string& message,
                        AudioHostState state = AudioHostState::Error) {
  return {false, error, state, {}, {}, message};
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

uint32_t latency(AudioDeviceID device, AudioObjectPropertyScope scope) {
  UInt32 latencyFrames = 0;
  UInt32 safetyFrames = 0;
  readProperty(device, property(kAudioDevicePropertyLatency, scope), &latencyFrames);
  readProperty(device, property(kAudioDevicePropertySafetyOffset, scope), &safetyFrames);
  return detail::saturatedAudioHostLatency(latencyFrames, safetyFrames);
}

class MacAudioHostBackend final : public AudioHostBackend {
 public:
  ~MacAudioHostBackend() override { stop(); }

  AudioHostInventory enumerate() const override {
    AudioDeviceID defaultInput = kAudioObjectUnknown;
    AudioDeviceID defaultOutput = kAudioObjectUnknown;
    readProperty(kAudioObjectSystemObject,
                 property(kAudioHardwarePropertyDefaultInputDevice,
                          kAudioObjectPropertyScopeGlobal),
                 &defaultInput);
    readProperty(kAudioObjectSystemObject,
                 property(kAudioHardwarePropertyDefaultOutputDevice,
                          kAudioObjectPropertyScopeGlobal),
                 &defaultOutput);
    AudioHostInventory inventory;
    for (AudioDeviceID device : devices()) {
      AudioHostDeviceInfo info;
      info.uid = readString(device, property(kAudioDevicePropertyDeviceUID,
                                             kAudioObjectPropertyScopeGlobal));
      info.label = readString(device, property(kAudioObjectPropertyName,
                                               kAudioObjectPropertyScopeGlobal));
      info.inputChannels = channelCount(device, kAudioDevicePropertyScopeInput);
      info.outputChannels = channelCount(device, kAudioDevicePropertyScopeOutput);
      if (info.uid.empty() || (info.inputChannels == 0 && info.outputChannels == 0)) continue;
      info.inputChannelLabels = channelLabels(
          device, kAudioDevicePropertyScopeInput, info.inputChannels, "Input");
      info.outputChannelLabels = channelLabels(
          device, kAudioDevicePropertyScopeOutput, info.outputChannels, "Output");
      info.defaultInput = device == defaultInput;
      info.defaultOutput = device == defaultOutput;
      UInt32 transport = kAudioDeviceTransportTypeUnknown;
      if (readProperty(device,
                       property(kAudioDevicePropertyTransportType,
                                kAudioObjectPropertyScopeGlobal),
                       &transport)) {
        const detail::MacAudioHostTransportCapability capability =
            detail::classifyMacAudioHostTransport(transport);
        info.transport = capability.transport;
        info.monitoringSuitability = capability.monitoringSuitability;
      }
      Float64 rate = 0.0;
      if (readProperty(device, property(kAudioDevicePropertyNominalSampleRate,
                                        kAudioObjectPropertyScopeGlobal),
                       &rate) && std::isfinite(rate) && rate > 0.0) {
        info.nominalSampleRate = rate;
      }
      auto rateAddress = property(kAudioDevicePropertyAvailableNominalSampleRates,
                                  kAudioObjectPropertyScopeGlobal);
      UInt32 rateBytes = 0;
      if (AudioObjectGetPropertyDataSize(device, &rateAddress, 0, nullptr,
                                         &rateBytes) == noErr &&
          rateBytes % sizeof(AudioValueRange) == 0 &&
          rateBytes <= sizeof(AudioValueRange) * 128) {
        std::vector<AudioValueRange> ranges(rateBytes / sizeof(AudioValueRange));
        if (rateBytes != 0 &&
            AudioObjectGetPropertyData(device, &rateAddress, 0, nullptr,
                                       &rateBytes, ranges.data()) == noErr) {
          for (const auto& available : ranges) {
            if (std::isfinite(available.mMinimum) &&
                std::isfinite(available.mMaximum) &&
                available.mMinimum > 0.0 &&
                available.mMaximum >= available.mMinimum) {
              info.sampleRateRanges.push_back(
                  {available.mMinimum, available.mMaximum});
            }
          }
        }
      }
      if (info.sampleRateRanges.empty() && info.nominalSampleRate > 0.0) {
        info.sampleRateRanges.push_back(
            {info.nominalSampleRate, info.nominalSampleRate});
      }
      UInt32 frames = 0;
      readProperty(device, property(kAudioDevicePropertyBufferFrameSize,
                                    kAudioObjectPropertyScopeGlobal),
                   &frames);
      AudioValueRange range{};
      readProperty(device, property(kAudioDevicePropertyBufferFrameSizeRange,
                                    kAudioObjectPropertyScopeGlobal),
                   &range);
      uint32_t minimumFrames = 0;
      uint32_t maximumFrames = 0;
      detail::checkedAudioHostBufferRange(range.mMinimum, range.mMaximum,
                                          &minimumFrames, &maximumFrames);
      info.bufferFrames = {minimumFrames, maximumFrames, frames, 0};
      info.direction = info.inputChannels != 0 && info.outputChannels != 0
                           ? AudioHostEndpointDirection::Duplex
                           : (info.inputChannels != 0
                                  ? AudioHostEndpointDirection::Input
                                  : AudioHostEndpointDirection::Output);
      if (info.direction != AudioHostEndpointDirection::Duplex)
        info.monitoringSuitability =
            AudioHostMonitoringSuitability::Unsupported;
      if (info.defaultInput) inventory.defaultInputUid = info.uid;
      if (info.defaultOutput) inventory.defaultOutputUid = info.uid;
      inventory.devices.push_back(std::move(info));
    }
    return inventory;
  }

  AudioHostResult open(const AudioHostConfig& config, AudioHostRender render,
                       void* renderContext) override {
    stop();
    if (config.exclusive) {
      return reject(AudioHostError::Unsupported,
                    "CoreAudio exclusive mode is not implemented by this AudioHost provider",
                    AudioHostState::Unsupported);
    }
    if (config.inputDeviceUid.empty() || config.outputDeviceUid.empty() ||
        config.inputDeviceUid != config.outputDeviceUid) {
      return reject(AudioHostError::DifferentDevicesUnsupported,
                    "AudioHost requires one physical CoreAudio device for input and output");
    }
    selectedDevice_ = findDevice(config.inputDeviceUid);
    if (selectedDevice_ == kAudioObjectUnknown) {
      return reject(AudioHostError::DeviceNotFound,
                    "The selected CoreAudio device disappeared");
    }
    UInt32 alive = 0;
    Float64 rate = 0.0;
    if (!readProperty(selectedDevice_, property(kAudioDevicePropertyDeviceIsAlive,
                                                kAudioObjectPropertyScopeGlobal),
                      &alive) ||
        alive == 0 ||
        !readProperty(selectedDevice_, property(kAudioDevicePropertyNominalSampleRate,
                                                kAudioObjectPropertyScopeGlobal),
                      &rate) ||
        !std::isfinite(rate) || rate <= 0.0) {
      return fail(AudioHostError::ProviderFailure, "CoreAudio device format is unavailable");
    }
    if (config.requestedSampleRate != 0.0 && config.requestedSampleRate != rate) {
      return fail(AudioHostError::InvalidConfiguration,
                  "Changing a shared CoreAudio device sample rate is not supported in Phase 3A");
    }
    const uint32_t deviceInputs = channelCount(selectedDevice_, kAudioDevicePropertyScopeInput);
    const uint32_t deviceOutputs = channelCount(selectedDevice_, kAudioDevicePropertyScopeOutput);
    if (!validMap(config.inputChannels, deviceInputs) ||
        !validMap(config.outputChannels, deviceOutputs) || render == nullptr ||
        config.maximumFrames == 0 || config.maximumFrames > kAudioHostMaxFrames) {
      return fail(AudioHostError::InvalidConfiguration,
                  "Invalid physical channel map, frame bound, or render thunk");
    }
    const bool previousBufferKnown = readProperty(
        selectedDevice_, property(kAudioDevicePropertyBufferFrameSize,
                                  kAudioObjectPropertyScopeGlobal),
        &previousBufferFrames_);
    if (config.requestedBufferFrames != 0 && !previousBufferKnown) {
      return fail(AudioHostError::ProviderFailure,
                  "CoreAudio buffer size cannot be changed safely because its current value is unknown");
    }
    if (config.requestedBufferFrames != 0 &&
        config.requestedBufferFrames != previousBufferFrames_) {
      UInt32 requested = config.requestedBufferFrames;
      auto address = property(kAudioDevicePropertyBufferFrameSize,
                              kAudioObjectPropertyScopeGlobal);
      if (AudioObjectSetPropertyData(selectedDevice_, &address, 0, nullptr,
                                     sizeof(requested), &requested) != noErr) {
        return fail(AudioHostError::InvalidConfiguration,
                    "CoreAudio rejected the requested device buffer size");
      }
      bufferChanged_ = true;
    }
    UInt32 nominalFrames = 0;
    readProperty(selectedDevice_, property(kAudioDevicePropertyBufferFrameSize,
                                           kAudioObjectPropertyScopeGlobal),
                 &nominalFrames);
    if (nominalFrames == 0 || nominalFrames > config.maximumFrames) {
      return fail(AudioHostError::InvalidConfiguration,
                  "Negotiated CoreAudio buffer exceeds the configured maximum");
    }

    AudioComponentDescription description{};
    description.componentType = kAudioUnitType_Output;
    description.componentSubType = kAudioUnitSubType_HALOutput;
    description.componentManufacturer = kAudioUnitManufacturer_Apple;
    AudioComponent component = AudioComponentFindNext(nullptr, &description);
    if (component == nullptr || AudioComponentInstanceNew(component, &unit_) != noErr) {
      return fail(AudioHostError::ProviderFailure, "CoreAudio AUHAL is unavailable");
    }
    UInt32 enabled = 1;
    if (AudioUnitSetProperty(unit_, kAudioOutputUnitProperty_EnableIO,
                             kAudioUnitScope_Input, 1, &enabled, sizeof(enabled)) != noErr ||
        AudioUnitSetProperty(unit_, kAudioOutputUnitProperty_EnableIO,
                             kAudioUnitScope_Output, 0, &enabled, sizeof(enabled)) != noErr ||
        AudioUnitSetProperty(unit_, kAudioOutputUnitProperty_CurrentDevice,
                             kAudioUnitScope_Global, 0, &selectedDevice_,
                             sizeof(selectedDevice_)) != noErr) {
      return fail(AudioHostError::ProviderFailure, "Could not configure AUHAL duplex I/O");
    }
    const uint32_t inputChannels = static_cast<uint32_t>(config.inputChannels.size());
    const uint32_t outputChannels = static_cast<uint32_t>(config.outputChannels.size());
    AudioStreamBasicDescription inputFormat = planarFormat(rate, inputChannels);
    AudioStreamBasicDescription outputFormat = planarFormat(rate, outputChannels);
    if (AudioUnitSetProperty(unit_, kAudioUnitProperty_StreamFormat,
                             kAudioUnitScope_Output, 1, &inputFormat,
                             sizeof(inputFormat)) != noErr ||
        AudioUnitSetProperty(unit_, kAudioUnitProperty_StreamFormat,
                             kAudioUnitScope_Input, 0, &outputFormat,
                             sizeof(outputFormat)) != noErr) {
      return fail(AudioHostError::ProviderFailure, "Could not set AUHAL float32 planar formats");
    }
    std::vector<SInt32> inputMap(inputChannels);
    std::vector<SInt32> outputMap(outputChannels);
    for (uint32_t index = 0; index < inputChannels; ++index) {
      inputMap[index] = static_cast<SInt32>(config.inputChannels[index]);
    }
    for (uint32_t index = 0; index < outputChannels; ++index) {
      outputMap[index] = static_cast<SInt32>(config.outputChannels[index]);
    }
    if (AudioUnitSetProperty(unit_, kAudioOutputUnitProperty_ChannelMap,
                             kAudioUnitScope_Output, 1, inputMap.data(),
                             static_cast<UInt32>(inputMap.size() * sizeof(SInt32))) != noErr ||
        AudioUnitSetProperty(unit_, kAudioOutputUnitProperty_ChannelMap,
                             kAudioUnitScope_Input, 0, outputMap.data(),
                             static_cast<UInt32>(outputMap.size() * sizeof(SInt32))) != noErr) {
      return fail(AudioHostError::InvalidConfiguration,
                  "CoreAudio rejected the explicit physical channel maps");
    }
    UInt32 maximumFrames = config.maximumFrames;
    if (AudioUnitSetProperty(unit_, kAudioUnitProperty_MaximumFramesPerSlice,
                             kAudioUnitScope_Global, 0, &maximumFrames,
                             sizeof(maximumFrames)) != noErr) {
      return fail(AudioHostError::ProviderFailure, "Could not set AUHAL callback frame bound");
    }
    inputSamples_.resize(static_cast<size_t>(inputChannels) * maximumFrames);
    const size_t inputListBytes = offsetof(AudioBufferList, mBuffers) +
                                  sizeof(AudioBuffer) * inputChannels;
    inputListStorage_.resize((inputListBytes + sizeof(std::max_align_t) - 1) /
                             sizeof(std::max_align_t));
    inputList_ = reinterpret_cast<AudioBufferList*>(inputListStorage_.data());
    inputList_->mNumberBuffers = inputChannels;
    for (uint32_t channel = 0; channel < inputChannels; ++channel) {
      inputPointers_[channel] = inputSamples_.data() +
                                static_cast<size_t>(channel) * maximumFrames;
      inputList_->mBuffers[channel].mNumberChannels = 1;
      inputList_->mBuffers[channel].mDataByteSize = maximumFrames * sizeof(float);
      inputList_->mBuffers[channel].mData = const_cast<float*>(inputPointers_[channel]);
    }
    mach_timebase_info_data_t timebase{};
    if (mach_timebase_info(&timebase) != KERN_SUCCESS || timebase.denom == 0) {
      return fail(AudioHostError::ProviderFailure, "Mach host-time conversion is unavailable");
    }
    nanosecondsPerTick_ = static_cast<double>(timebase.numer) / timebase.denom;
    format_ = {rate, maximumFrames, nominalFrames, inputChannels, outputChannels, true, true};
    latency_ = {latency(selectedDevice_, kAudioDevicePropertyScopeInput),
                latency(selectedDevice_, kAudioDevicePropertyScopeOutput),
                nominalFrames, 0};
    listenerContext_ = std::make_shared<HostDeviceListenerContext>();
    listenerContext_->routeGeneration.store(
        lastRouteGeneration_.fetch_add(1, std::memory_order_relaxed) + 1,
        std::memory_order_relaxed);
    streamGeneration_.fetch_add(1, std::memory_order_relaxed);
    fallbackOutputFrame_ = 0;
    callbackSequence_ = 0;
    inputSourceFrame_ = 0;
    deviceLost_.store(false, std::memory_order_relaxed);
    formatChanged_.store(false, std::memory_order_relaxed);
    endpoint_.callbacks.store(0, std::memory_order_relaxed);
    endpoint_.renderedFrames.store(0, std::memory_order_relaxed);
    endpoint_.xruns.store(0, std::memory_order_relaxed);
    endpoint_.deadlineMisses.store(0, std::memory_order_relaxed);
    endpoint_.discontinuities.store(0, std::memory_order_relaxed);
    endpoint_.invalidCallbacks.store(0, std::memory_order_relaxed);
    endpoint_.renderFailures.store(0, std::memory_order_relaxed);
    prepareAudioHostCallback(&endpoint_, render, renderContext);
    AURenderCallbackStruct callback{renderCallback, this};
    if (AudioUnitSetProperty(unit_, kAudioUnitProperty_SetRenderCallback,
                             kAudioUnitScope_Input, 0, &callback,
                             sizeof(callback)) != noErr ||
        AudioUnitInitialize(unit_) != noErr) {
      return fail(AudioHostError::ProviderFailure, "Could not initialize AUHAL rendering");
    }
    initialized_ = true;
    listenerQueue_ = dispatch_queue_create("com.lexasoft.singz.audio-host-device", nullptr);
    if (listenerQueue_ == nullptr) {
      return fail(AudioHostError::ProviderFailure,
                  "Could not create the CoreAudio route listener queue");
    }
    HostDeviceListenerContext* listener = listenerContext_.get();
    listenerBlock_ = Block_copy(^(UInt32 count,
                                  const AudioObjectPropertyAddress addresses[]) {
      uint32_t changes = 0;
      for (UInt32 index = 0; index < count; ++index) {
        changes |= addresses[index].mSelector == kAudioDevicePropertyDeviceIsAlive
                       ? kAliveChanged
                       : kFormatChanged;
      }
      if (changes != 0) {
        listener->pendingChanges.fetch_or(changes, std::memory_order_release);
        listener->routeGeneration.fetch_add(1, std::memory_order_relaxed);
        listener->routeChanged.store(true, std::memory_order_release);
      }
    });
    if (listenerBlock_ == nullptr) {
      return fail(AudioHostError::ProviderFailure,
                  "Could not allocate the CoreAudio route listener block");
    }
    const AudioObjectPropertyAddress watched[] = {
        property(kAudioDevicePropertyDeviceIsAlive, kAudioObjectPropertyScopeGlobal),
        property(kAudioDevicePropertyNominalSampleRate, kAudioObjectPropertyScopeGlobal),
        property(kAudioDevicePropertyStreamConfiguration, kAudioDevicePropertyScopeInput),
        property(kAudioDevicePropertyStreamConfiguration, kAudioDevicePropertyScopeOutput)};
    for (const auto& address : watched) {
      if (AudioObjectAddPropertyListenerBlock(selectedDevice_, &address,
                                              listenerQueue_,
                                              listenerBlock_) != noErr) {
        return fail(AudioHostError::ProviderFailure, "Could not watch the CoreAudio route");
      }
      watched_.push_back(address);
    }
    firstCallback_.store(true, std::memory_order_relaxed);
    state_.store(AudioHostState::Open, std::memory_order_release);
    return {true, AudioHostError::None, AudioHostState::Open, format_, latency_, {}};
  }

  AudioHostResult start() override {
    if (!initialized_ || state_.load(std::memory_order_acquire) != AudioHostState::Open) {
      return failure(AudioHostError::InvalidState,
                     "Open AUHAL before starting it",
                     state_.load(std::memory_order_acquire));
    }
    activateAudioHostCallback(&endpoint_);
    if (AudioOutputUnitStart(unit_) != noErr) {
      deactivateAudioHostCallback(&endpoint_);
      return fail(AudioHostError::ProviderFailure, "Could not start AUHAL");
    }
    started_ = true;
    state_.store(AudioHostState::Running, std::memory_order_release);
    return {true, AudioHostError::None, AudioHostState::Running, format_, latency_, {}};
  }

  void stop() noexcept override {
    deactivateAudioHostCallback(&endpoint_);
    if (started_ && unit_ != nullptr) AudioOutputUnitStop(unit_);
    while (endpoint_.inFlight.load(std::memory_order_acquire) != 0) std::this_thread::yield();
    bool removedAll = true;
    for (const auto& address : watched_) {
      if (AudioObjectRemovePropertyListenerBlock(selectedDevice_, &address,
                                                 listenerQueue_,
                                                 listenerBlock_) != noErr) {
        removedAll = false;
      }
    }
    if (listenerContext_ != nullptr && listenerQueue_ != nullptr &&
        listenerBlock_ != nullptr) {
      if (removedAll) {
        dispatch_sync_f(listenerQueue_, nullptr, [](void*) {});
        Block_release(listenerBlock_);
        dispatch_release(listenerQueue_);
      } else {
        std::lock_guard<std::mutex> lock(quarantinedListenerMutex());
        quarantinedListeners().push_back(
            {listenerContext_, listenerQueue_, listenerBlock_});
      }
    } else if (listenerQueue_ != nullptr) {
      dispatch_release(listenerQueue_);
    }
    watched_.clear();
    if (listenerContext_ != nullptr) {
      const uint64_t finalGeneration = listenerContext_->routeGeneration.load(
          std::memory_order_relaxed);
      if (finalGeneration > lastRouteGeneration_.load(std::memory_order_relaxed)) {
        lastRouteGeneration_.store(finalGeneration, std::memory_order_relaxed);
      }
    }
    listenerContext_.reset();
    listenerQueue_ = nullptr;
    listenerBlock_ = nullptr;
    if (initialized_ && unit_ != nullptr) AudioUnitUninitialize(unit_);
    if (unit_ != nullptr) AudioComponentInstanceDispose(unit_);
    bool bufferRestoreFailed = false;
    if (bufferChanged_ && selectedDevice_ != kAudioObjectUnknown &&
        previousBufferFrames_ != 0) {
      auto address = property(kAudioDevicePropertyBufferFrameSize,
                              kAudioObjectPropertyScopeGlobal);
      bufferRestoreFailed =
          AudioObjectSetPropertyData(selectedDevice_, &address, 0, nullptr,
                                     sizeof(previousBufferFrames_),
                                     &previousBufferFrames_) != noErr;
    }
    unit_ = nullptr;
    initialized_ = false;
    started_ = false;
    inputList_ = nullptr;
    inputListStorage_.clear();
    inputSamples_.clear();
    selectedDevice_ = kAudioObjectUnknown;
    previousBufferFrames_ = 0;
    bufferChanged_ = false;
    const AudioHostState previous = state_.load(std::memory_order_acquire);
    state_.store(bufferRestoreFailed
                     ? AudioHostState::Error
                     : (previous == AudioHostState::Closed
                            ? AudioHostState::Closed
                            : AudioHostState::Stopped),
                 std::memory_order_release);
  }

  AudioHostStatus status() const noexcept override {
    const uint32_t changes = listenerContext_ != nullptr
                                 ? listenerContext_->pendingChanges.load(
                                       std::memory_order_acquire)
                                 : 0;
    if ((changes & kAliveChanged) != 0 && selectedDevice_ != kAudioObjectUnknown) {
      UInt32 alive = 0;
      if (!readProperty(selectedDevice_,
                        property(kAudioDevicePropertyDeviceIsAlive,
                                 kAudioObjectPropertyScopeGlobal),
                        &alive) ||
          alive == 0) {
        deviceLost_.store(true, std::memory_order_release);
      }
    }
    if ((changes & kFormatChanged) != 0) {
      formatChanged_.store(true, std::memory_order_release);
    }
    AudioHostStatus result;
    result.state = deviceLost_.load(std::memory_order_acquire)
                       ? AudioHostState::DeviceLost
                       : (formatChanged_.load(std::memory_order_acquire)
                              ? AudioHostState::Error
                              : state_.load(std::memory_order_acquire));
    result.format = format_;
    result.latency = latency_;
    result.routeGeneration = listenerContext_ != nullptr
                                 ? listenerContext_->routeGeneration.load(
                                       std::memory_order_relaxed)
                                 : lastRouteGeneration_.load(
                                       std::memory_order_relaxed);
    result.streamGeneration = streamGeneration_.load(std::memory_order_relaxed);
    result.callbacks = endpoint_.callbacks.load(std::memory_order_relaxed);
    result.renderedFrames = endpoint_.renderedFrames.load(std::memory_order_relaxed);
    result.xruns = endpoint_.xruns.load(std::memory_order_relaxed);
    result.deadlineMisses = endpoint_.deadlineMisses.load(std::memory_order_relaxed);
    result.discontinuities = endpoint_.discontinuities.load(std::memory_order_relaxed);
    result.invalidCallbacks = endpoint_.invalidCallbacks.load(std::memory_order_relaxed);
    result.renderFailures = endpoint_.renderFailures.load(std::memory_order_relaxed);
    return result;
  }

 private:
  static OSStatus renderCallback(void* context, AudioUnitRenderActionFlags* flags,
                                 const AudioTimeStamp* timestamp, UInt32,
                                 UInt32 frames, AudioBufferList* output) noexcept {
    auto* self = static_cast<MacAudioHostBackend*>(context);
    if (self == nullptr || output == nullptr) return noErr;
    const uint64_t callbackTicks = mach_absolute_time();
    if (frames == 0 || frames > self->format_.maximumFrames ||
        output->mNumberBuffers < self->format_.outputChannels) {
      AudioHostRenderBlock invalid{};
      for (UInt32 channel = 0; channel < output->mNumberBuffers; ++channel) {
        auto* bytes = static_cast<uint8_t*>(output->mBuffers[channel].mData);
        if (bytes == nullptr) continue;
        for (UInt32 byte = 0; byte < output->mBuffers[channel].mDataByteSize;
             ++byte) {
          bytes[byte] = 0;
        }
      }
      invalid.outputChannels = std::min<uint32_t>(output->mNumberBuffers,
                                                  kAudioHostMaxChannels);
      invalid.frames = std::min<uint32_t>(frames, self->format_.maximumFrames);
      invalid.maximumFrames = self->format_.maximumFrames;
      invalid.sampleRate = self->format_.sampleRate;
      invalid.outputClockMaster = false;
      for (uint32_t c = 0; c < invalid.outputChannels; ++c) {
        self->outputPointers_[c] = static_cast<float*>(output->mBuffers[c].mData);
      }
      invalid.output = self->outputPointers_.data();
      invokeAudioHostCallback(&self->endpoint_, invalid);
      return noErr;
    }
    for (uint32_t channel = 0; channel < self->format_.inputChannels; ++channel) {
      self->inputList_->mBuffers[channel].mDataByteSize = frames * sizeof(float);
    }
    const OSStatus inputStatus = AudioUnitRender(self->unit_, flags, timestamp, 1,
                                                 frames, self->inputList_);
    if (inputStatus != noErr) {
      recordAudioHostXRun(&self->endpoint_);
      for (uint32_t channel = 0; channel < self->format_.inputChannels; ++channel) {
        std::fill_n(const_cast<float*>(self->inputPointers_[channel]), frames, 0.0F);
      }
    }
    for (uint32_t channel = 0; channel < self->format_.outputChannels; ++channel) {
      self->outputPointers_[channel] = static_cast<float*>(output->mBuffers[channel].mData);
    }
    uint32_t discontinuity = AudioHostDiscontinuityNone;
    if (self->firstCallback_.exchange(false, std::memory_order_relaxed)) {
      discontinuity |= AudioHostDiscontinuityStart;
    }
    if (self->listenerContext_ != nullptr &&
        self->listenerContext_->routeChanged.exchange(false,
                                                       std::memory_order_acq_rel)) {
      discontinuity |= AudioHostDiscontinuityRouteChanged;
    }
    if (self->deviceLost_.load(std::memory_order_acquire)) {
      discontinuity |= AudioHostDiscontinuityDeviceLost;
    }
    if (inputStatus != noErr ||
        (flags != nullptr && (*flags & kAudioUnitRenderAction_PostRenderError) != 0)) {
      discontinuity |= AudioHostDiscontinuityXRun;
    }
    const uint64_t callbackNs = static_cast<uint64_t>(
        static_cast<long double>(callbackTicks) * self->nanosecondsPerTick_);
    const uint64_t outputNs = timestamp != nullptr &&
                                      (timestamp->mFlags & kAudioTimeStampHostTimeValid) != 0
                                  ? static_cast<uint64_t>(
                                        static_cast<long double>(timestamp->mHostTime) *
                                        self->nanosecondsPerTick_)
                                  : callbackNs;
    const bool inputHardwareValid = timestamp != nullptr &&
                                    (timestamp->mFlags &
                                     kAudioTimeStampHostTimeValid) != 0 &&
                                    timestamp->mHostTime != 0;
    const uint64_t inputHardwareNs = inputHardwareValid
                                         ? static_cast<uint64_t>(
                                               static_cast<long double>(
                                                   timestamp->mHostTime) *
                                               self->nanosecondsPerTick_)
                                         : 0;
    const AudioInputTimestampProjection inputProjection =
        resolveAudioInputTimestamp(inputHardwareValid, inputHardwareNs,
                                   callbackNs, frames,
                                   self->format_.sampleRate);
    const uint64_t inputSourceFrame = self->inputSourceFrame_;
    self->inputSourceFrame_ = advanceAudioHostFrame(self->inputSourceFrame_, frames);
    const bool outputFrameValid = timestamp != nullptr &&
                                  (timestamp->mFlags &
                                   kAudioTimeStampSampleTimeValid) != 0 &&
                                  validAudioHostSampleFrame(
                                      timestamp->mSampleTime, frames);
    const uint64_t outputFrame = outputFrameValid
                                     ? static_cast<uint64_t>(timestamp->mSampleTime)
                                     : self->fallbackOutputFrame_;
    self->fallbackOutputFrame_ = advanceAudioHostFrame(outputFrame, frames);
    const uint64_t callbackSequence = self->callbackSequence_;
    self->callbackSequence_ = advanceAudioHostFrame(self->callbackSequence_, 1);
    AudioHostRenderBlock block{
        self->inputPointers_.data(), self->outputPointers_.data(),
        self->format_.inputChannels, self->format_.outputChannels, frames,
        self->format_.maximumFrames, self->format_.sampleRate, 1,
        self->listenerContext_ != nullptr
            ? self->listenerContext_->routeGeneration.load(
                  std::memory_order_relaxed)
            : self->lastRouteGeneration_.load(std::memory_order_relaxed),
        self->streamGeneration_.load(std::memory_order_relaxed),
        callbackSequence,
        inputSourceFrame, inputProjection.sampleHostTimeNs, true,
        inputProjection.usedHardwareAnchor, outputFrame, outputNs, callbackNs,
        discontinuity, true};
    invokeAudioHostCallback(&self->endpoint_, block);
    const uint64_t elapsedTicks = mach_absolute_time() - callbackTicks;
    const long double elapsedNs = static_cast<long double>(elapsedTicks) *
                                  self->nanosecondsPerTick_;
    const long double deadlineNs = static_cast<long double>(frames) * 1000000000.0L /
                                   self->format_.sampleRate;
    if (elapsedNs > deadlineNs) recordAudioHostDeadlineMiss(&self->endpoint_);
    return noErr;
  }

  AudioHostResult fail(AudioHostError error, const std::string& message) {
    stop();
    state_.store(AudioHostState::Error, std::memory_order_release);
    return failure(error, message);
  }

  AudioHostResult reject(
      AudioHostError error, const std::string& message,
      AudioHostState state = AudioHostState::Error) noexcept {
    state_.store(state, std::memory_order_release);
    return failure(error, message, state);
  }

  AudioUnit unit_{nullptr};
  AudioDeviceID selectedDevice_{kAudioObjectUnknown};
  bool initialized_{false};
  bool started_{false};
  UInt32 previousBufferFrames_{0};
  bool bufferChanged_{false};
  AudioHostFormat format_{};
  AudioHostLatency latency_{};
  AudioHostCallbackEndpoint endpoint_{};
  std::atomic<AudioHostState> state_{AudioHostState::Closed};
  std::atomic<uint64_t> lastRouteGeneration_{0};
  std::atomic<uint64_t> streamGeneration_{0};
  uint64_t fallbackOutputFrame_{0};
  uint64_t callbackSequence_{0};
  std::atomic<bool> firstCallback_{false};
  mutable std::atomic<bool> deviceLost_{false};
  mutable std::atomic<bool> formatChanged_{false};
  uint64_t inputSourceFrame_{0};
  double nanosecondsPerTick_{0.0};
  std::vector<float> inputSamples_;
  std::vector<std::max_align_t> inputListStorage_;
  AudioBufferList* inputList_{nullptr};
  std::array<const float*, kAudioHostMaxChannels> inputPointers_{};
  std::array<float*, kAudioHostMaxChannels> outputPointers_{};
  std::vector<AudioObjectPropertyAddress> watched_;
  std::shared_ptr<HostDeviceListenerContext> listenerContext_;
  dispatch_queue_t listenerQueue_{nullptr};
  AudioObjectPropertyListenerBlock listenerBlock_{nullptr};
};

}  // namespace

std::unique_ptr<AudioHostBackend> createPlatformAudioHostBackend() {
  return std::make_unique<MacAudioHostBackend>();
}

}  // namespace singz

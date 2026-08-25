#include "audio_input_backend.h"

#if defined(__ANDROID__)

#if !defined(__ANDROID_API__) || __ANDROID_API__ < 26
#error "SingZ's AAudio input backend requires Android API 26 or newer"
#endif

#include <aaudio/AAudio.h>
#include <android/api-level.h>
#include <dlfcn.h>
#include <time.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <limits>
#include <memory>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "audio_input_android_registry.h"
#include "audio_input_android_policy.h"
#include "audio_input_callback_gate.h"
#include "audio_input_timestamp.h"

namespace singz {
namespace {

constexpr char kUidPrefix[] = "android:";
constexpr int32_t kMaximumChannels = 256;
constexpr int32_t kMaximumCallbackFrames = 16384;

bool deviceIdFromUid(const std::string& uid, int32_t& deviceId) {
  if (uid.rfind(kUidPrefix, 0) != 0) return false;
  const std::string value = uid.substr(sizeof(kUidPrefix) - 1);
  if (value.empty() || value.size() > 10) return false;
  uint64_t parsed = 0;
  for (const char c : value) {
    if (c < '0' || c > '9') return false;
    parsed = parsed * 10 + static_cast<uint64_t>(c - '0');
    if (parsed > static_cast<uint64_t>(std::numeric_limits<int32_t>::max())) return false;
  }
  deviceId = static_cast<int32_t>(parsed);
  return deviceId > 0;
}

uint64_t monotonicNowNs() {
  timespec now{};
  return clock_gettime(CLOCK_MONOTONIC, &now) == 0
             ? static_cast<uint64_t>(now.tv_sec) * 1000000000ull +
                   static_cast<uint64_t>(now.tv_nsec)
             : 0;
}

const char* formatName(aaudio_format_t format) {
  switch (format) {
    case AAUDIO_FORMAT_PCM_FLOAT: return "float32";
    case AAUDIO_FORMAT_PCM_I16: return "pcm16";
    default: return "unsupported";
  }
}

const char* sharingName(aaudio_sharing_mode_t mode) {
  return mode == AAUDIO_SHARING_MODE_EXCLUSIVE ? "exclusive" : "shared";
}

const char* performanceName(aaudio_performance_mode_t mode) {
  switch (mode) {
    case AAUDIO_PERFORMANCE_MODE_LOW_LATENCY: return "low-latency";
    case AAUDIO_PERFORMANCE_MODE_POWER_SAVING: return "power-saving";
    default: return "none";
  }
}

using SetInputPreset = void (*)(AAudioStreamBuilder*, aaudio_input_preset_t);
using GetInputPreset = aaudio_input_preset_t (*)(AAudioStream*);

SetInputPreset setInputPresetFunction() {
  return reinterpret_cast<SetInputPreset>(
      dlsym(RTLD_DEFAULT, "AAudioStreamBuilder_setInputPreset"));
}

GetInputPreset getInputPresetFunction() {
  if (android_get_device_api_level() < 28) return nullptr;
  return reinterpret_cast<GetInputPreset>(
      dlsym(RTLD_DEFAULT, "AAudioStream_getInputPreset"));
}

struct PresetChoice {
  aaudio_input_preset_t value = AAUDIO_INPUT_PRESET_VOICE_RECOGNITION;
  bool apply = false;
};

std::vector<PresetChoice> presetChoices() {
  const int api = android_get_device_api_level();
  if (api >= 29)
    return {{AAUDIO_INPUT_PRESET_VOICE_PERFORMANCE, true},
            {AAUDIO_INPUT_PRESET_UNPROCESSED, true},
            {AAUDIO_INPUT_PRESET_VOICE_RECOGNITION, true}};
  if (api >= 28)
    return {{AAUDIO_INPUT_PRESET_UNPROCESSED, true},
            {AAUDIO_INPUT_PRESET_VOICE_RECOGNITION, true}};
  // setInputPreset was introduced in API 28. API 26-27 already default to
  // VOICE_RECOGNITION, which AAudio documents as the low-latency safe path.
  return {{AAUDIO_INPUT_PRESET_VOICE_RECOGNITION, false}};
}

enum class RuntimeFailure : int32_t {
  None = 0,
  Disconnected = 1,
  CallbackTooLarge = 2,
  InvalidBuffer = 3,
  StreamError = 4,
};

class AAudioInputBackend final : public AudioInputBackend {
 public:
  ~AAudioInputBackend() override { stop(); }

  AudioInputResult open(const AudioInputConfig& config, AudioInputPush push,
                        void* context) override {
    stop();
    int32_t requestedDevice = 0;
    if (!deviceIdFromUid(config.deviceUid, requestedDevice))
      return failure("Android audio input UID is invalid", config.channel);
    const std::vector<AudioInputDevice> devices = androidAudioInputDevices();
    const auto found = std::find_if(devices.begin(), devices.end(), [&](const auto& device) {
      return device.uid == config.deviceUid;
    });
    if (found == devices.end())
      return failure("Android audio input device is unavailable", config.channel);
    if (found->channels == 0 || found->channels > static_cast<uint32_t>(kMaximumChannels) ||
        config.channel >= found->channels)
      return failure("Android audio input channel is out of range", config.channel);

    requestedDeviceId_ = requestedDevice;
    requestedChannels_ = static_cast<int32_t>(found->channels);
    selectedChannel_ = config.channel;
    push_ = push;
    context_ = context;
    runtimeFailure_.store(RuntimeFailure::None, std::memory_order_relaxed);
    stopRequested_.store(false, std::memory_order_release);
    mono_.resize(kMaximumCallbackFrames);

    std::string lastError = "AAudio could not open the requested input";
    const SetInputPreset setPreset = setInputPresetFunction();
    const GetInputPreset getPreset = getInputPresetFunction();
    for (const aaudio_sharing_mode_t sharing :
         {AAUDIO_SHARING_MODE_EXCLUSIVE, AAUDIO_SHARING_MODE_SHARED}) {
      for (const PresetChoice& preset : presetChoices()) {
        // API 28+ should expose the symbol. If a vendor image does not, use
        // AAudio's documented voice-recognition default exactly once.
        PresetChoice attempt = preset;
        if (attempt.apply && !setPreset) {
          attempt = {AAUDIO_INPUT_PRESET_VOICE_RECOGNITION, false};
        }
        const aaudio_result_t opened = openStream(sharing, attempt, setPreset);
        if (opened != AAUDIO_OK) {
          lastError = std::string("AAudio could not open the input: ") +
                      AAudio_convertResultToText(opened);
          closeStream();
          if (!setPreset && preset.apply) break;
          continue;
        }
        lastError = verifyOpenedStream(getPreset);
        if (lastError.empty()) return negotiatedResult(AudioInputState::Starting);
        // Validation failures are retried too. Some devices expose a reduced
        // lane map or a different format only in exclusive mode.
        closeStream();
        if (!setPreset && preset.apply) break;
      }
    }
    return failure(std::move(lastError), selectedChannel_);
  }

  AudioInputResult start() override {
    if (!stream_)
      return failure("AAudio input is not prepared", selectedChannel_);
    callbackGate_.open();
    callbackFrameCursor_ = 0;
    timestampProjector_.reset();
    const aaudio_result_t requested = AAudioStream_requestStart(stream_);
    if (requested != AAUDIO_OK) {
      callbackGate_.beginClose();
      return failure(std::string("AAudio input could not start: ") +
                         AAudio_convertResultToText(requested),
                     selectedChannel_);
    }

    aaudio_stream_state_t current = AAudioStream_getState(stream_);
    const int64_t deadline = static_cast<int64_t>(monotonicNowNs()) + 2000000000ll;
    while (current != AAUDIO_STREAM_STATE_STARTED &&
           current != AAUDIO_STREAM_STATE_DISCONNECTED &&
           static_cast<int64_t>(monotonicNowNs()) < deadline) {
      aaudio_stream_state_t next = current;
      const aaudio_result_t waited =
          AAudioStream_waitForStateChange(stream_, current, &next, 100000000ll);
      if (waited != AAUDIO_OK && waited != AAUDIO_ERROR_TIMEOUT)
        return failure(std::string("AAudio start state failed: ") +
                           AAudio_convertResultToText(waited),
                       selectedChannel_);
      current = next;
    }
    if (current != AAUDIO_STREAM_STATE_STARTED)
      return failure(current == AAUDIO_STREAM_STATE_DISCONNECTED
                         ? "Android audio input disconnected while starting"
                         : "Android audio input did not start in time",
                     selectedChannel_);
    started_ = true;
    if (!startTimestampSampler())
      return failure("Android could not start the hardware timestamp sampler",
                     selectedChannel_);
    return negotiatedResult(AudioInputState::Running);
  }

  void stop() override {
    stopRequested_.store(true, std::memory_order_release);
    closeStream();
    mono_.clear();
    mono_.shrink_to_fit();
    push_ = nullptr;
    context_ = nullptr;
  }

  bool takeFailure(std::string& error) override {
    switch (runtimeFailure_.exchange(RuntimeFailure::None, std::memory_order_acq_rel)) {
      case RuntimeFailure::None: return false;
      case RuntimeFailure::Disconnected:
        error = "Android audio input was disconnected or rerouted";
        return true;
      case RuntimeFailure::CallbackTooLarge:
        error = "AAudio input callback exceeded the core frame limit";
        return true;
      case RuntimeFailure::InvalidBuffer:
        error = "AAudio delivered an invalid input buffer";
        return true;
      case RuntimeFailure::StreamError:
        error = "AAudio input stream failed";
        return true;
    }
    return false;
  }

 private:
  AudioInputResult failure(std::string error, uint32_t channel) const {
    return AudioInputResult::failure(AudioInputState::Error, std::move(error), channel);
  }

  AudioInputResult negotiatedResult(AudioInputState state) const {
    AudioInputResult result = AudioInputResult::success(
        state, static_cast<double>(sampleRate_), selectedChannel_);
    result.deviceUid = std::string(kUidPrefix) + std::to_string(deviceId_);
    result.deviceChannels = static_cast<uint32_t>(channels_);
    result.sampleFormat = formatName(format_);
    result.sharingMode = sharingName(sharingMode_);
    result.performanceMode = performanceName(performanceMode_);
    result.inputPreset = inputPresetName_;
    result.timestampSource =
        "aaudio-hardware-monotonic-anchor-with-callback-fallback";
    return result;
  }

  std::string verifyOpenedStream(GetInputPreset getPreset) {
    deviceId_ = AAudioStream_getDeviceId(stream_);
    channels_ = AAudioStream_getChannelCount(stream_);
    sampleRate_ = AAudioStream_getSampleRate(stream_);
    format_ = AAudioStream_getFormat(stream_);
    sharingMode_ = AAudioStream_getSharingMode(stream_);
    performanceMode_ = AAudioStream_getPerformanceMode(stream_);
    if (getPreset) {
      inputPresetName_ = androidAudioInputPresetMetadata(
          static_cast<int32_t>(getPreset(stream_)), true, false);
    }
    if (deviceId_ != requestedDeviceId_)
      return "Android routed capture to a different input device";
    if (channels_ <= 0 || channels_ > kMaximumChannels ||
        selectedChannel_ >= static_cast<uint32_t>(channels_))
      return "AAudio exposed fewer channels than AudioManager advertised";
    if (sampleRate_ <= 0 ||
        (format_ != AAUDIO_FORMAT_PCM_FLOAT && format_ != AAUDIO_FORMAT_PCM_I16))
      return "AAudio returned an unsupported input format";
    return {};
  }

  aaudio_result_t openStream(aaudio_sharing_mode_t sharingMode,
                             const PresetChoice& preset,
                             SetInputPreset setPreset) {
    AAudioStreamBuilder* builder = nullptr;
    aaudio_result_t result = AAudio_createStreamBuilder(&builder);
    if (result != AAUDIO_OK || !builder) return result;
    AAudioStreamBuilder_setDirection(builder, AAUDIO_DIRECTION_INPUT);
    AAudioStreamBuilder_setFormat(builder, AAUDIO_FORMAT_PCM_FLOAT);
    AAudioStreamBuilder_setPerformanceMode(builder, AAUDIO_PERFORMANCE_MODE_LOW_LATENCY);
    AAudioStreamBuilder_setSharingMode(builder, sharingMode);
    AAudioStreamBuilder_setDeviceId(builder, requestedDeviceId_);
    AAudioStreamBuilder_setChannelCount(builder, requestedChannels_);
    if (preset.apply && setPreset) setPreset(builder, preset.value);
    AAudioStreamBuilder_setDataCallback(builder, dataCallback, this);
    AAudioStreamBuilder_setErrorCallback(builder, errorCallback, this);
    result = AAudioStreamBuilder_openStream(builder, &stream_);
    AAudioStreamBuilder_delete(builder);
    inputPresetName_ = androidAudioInputPresetMetadata(
        static_cast<int32_t>(preset.value), false, preset.apply && setPreset);
    return result;
  }

  void closeStream() {
    AAudioStream* stream = stream_;
    // The sampler is the only non-RT caller of AAudioStream_getTimestamp.
    // Stop and join it while the stream remains open, before either callback
    // admission closes or AAudioStream_close can invalidate the handle.
    stopTimestampSampler();
    callbackGate_.beginClose();
    if (!stream) return;
    if (started_) {
      (void)AAudioStream_requestStop(stream);
      aaudio_stream_state_t current = AAudioStream_getState(stream);
      const uint64_t deadline = monotonicNowNs() + 500000000ull;
      while (current != AAUDIO_STREAM_STATE_STOPPED &&
             current != AAUDIO_STREAM_STATE_DISCONNECTED &&
             monotonicNowNs() < deadline) {
        aaudio_stream_state_t next = current;
        (void)AAudioStream_waitForStateChange(stream, current, &next, 50000000ll);
        current = next;
      }
    }
    // Our callback contains no blocking operation. Closing the admission gate
    // first therefore makes this wait finite and ensures buffers/self are not
    // destroyed while either AAudio callback is still touching them.
    while (callbackGate_.inFlight() != 0)
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
    (void)AAudioStream_close(stream);
    stream_ = nullptr;
    started_ = false;
    timestampProjector_.reset();
  }

  bool startTimestampSampler() {
    timestampSamplerStop_.store(false, std::memory_order_release);
    timestampQueryGate_.open();
    try {
      timestampSampler_ = std::thread([this] {
        while (!timestampSamplerStop_.load(std::memory_order_acquire)) {
          {
            AudioInputTimestampQueryScope query(timestampQueryGate_);
            if (!query) break;
            int64_t framePosition = 0;
            int64_t frameTimeNs = 0;
            const aaudio_result_t result = AAudioStream_getTimestamp(
                stream_, CLOCK_MONOTONIC, &framePosition, &frameTimeNs);
            const uint64_t sampledAtNs = monotonicNowNs();
            if (result == AAUDIO_OK)
              (void)timestampProjector_.publish(
                  framePosition, frameTimeNs, sampledAtNs);
          }
          // A short bounded cadence keeps anchors fresh without polling from
          // the real-time callback. Split the wait so teardown joins quickly.
          for (int i = 0; i < 5 &&
               !timestampSamplerStop_.load(std::memory_order_acquire); ++i) {
            std::this_thread::sleep_for(std::chrono::milliseconds(2));
          }
        }
      });
    } catch (...) {
      timestampQueryGate_.beginClose();
      timestampSamplerStop_.store(true, std::memory_order_release);
      return false;
    }
    return true;
  }

  void stopTimestampSampler() {
    timestampQueryGate_.beginClose();
    timestampSamplerStop_.store(true, std::memory_order_release);
    if (timestampSampler_.joinable() &&
        timestampSampler_.get_id() != std::this_thread::get_id()) {
      timestampSampler_.join();
    }
    // join is the lifecycle barrier: no getTimestamp call can remain admitted
    // when closeStream continues to AAudioStream_close.
  }

  static aaudio_data_callback_result_t dataCallback(AAudioStream*, void* user,
                                                    void* audioData, int32_t frames) {
    const uint64_t callbackTime = monotonicNowNs();
    auto* self = static_cast<AAudioInputBackend*>(user);
    if (!self) return AAUDIO_CALLBACK_RESULT_STOP;
    AudioInputCallbackScope callback(self->callbackGate_);
    if (!callback || self->stopRequested_.load(std::memory_order_acquire))
      return AAUDIO_CALLBACK_RESULT_STOP;
    if (!audioData || frames <= 0 || self->channels_ <= 0) {
      self->runtimeFailure_.store(RuntimeFailure::InvalidBuffer, std::memory_order_release);
      return AAUDIO_CALLBACK_RESULT_STOP;
    }
    if (frames > kMaximumCallbackFrames) {
      self->runtimeFailure_.store(RuntimeFailure::CallbackTooLarge,
                                  std::memory_order_release);
      return AAUDIO_CALLBACK_RESULT_STOP;
    }
    float* mono = self->mono_.data();
    const int32_t channels = self->channels_;
    const uint32_t selected = self->selectedChannel_;
    if (self->format_ == AAUDIO_FORMAT_PCM_FLOAT) {
      const auto* source = static_cast<const float*>(audioData);
      for (int32_t frame = 0; frame < frames; ++frame)
        mono[static_cast<size_t>(frame)] =
            source[static_cast<size_t>(frame) * static_cast<size_t>(channels) +
                   static_cast<size_t>(selected)];
    } else {
      const auto* source = static_cast<const int16_t*>(audioData);
      constexpr float scale = 1.0f / 32768.0f;
      for (int32_t frame = 0; frame < frames; ++frame)
        mono[static_cast<size_t>(frame)] =
            source[static_cast<size_t>(frame) * static_cast<size_t>(channels) +
                   static_cast<size_t>(selected)] * scale;
    }
    const int64_t blockStartFrame = self->callbackFrameCursor_;
    if (blockStartFrame > std::numeric_limits<int64_t>::max() - frames) {
      self->runtimeFailure_.store(RuntimeFailure::InvalidBuffer,
                                  std::memory_order_release);
      return AAUDIO_CALLBACK_RESULT_STOP;
    }
    self->callbackFrameCursor_ += frames;
    // The hardware CLOCK_MONOTONIC anchor is sampled only by the joined
    // non-RT sampler. This RT projection uses bounded lock-free 32-bit atomic
    // reads; until a fresh sane anchor exists it falls back to callback entry
    // minus exactly this block's duration. Playback latency is never applied.
    const AudioInputTimestampProjection projected =
        self->timestampProjector_.project(
            blockStartFrame, static_cast<uint32_t>(frames), self->sampleRate_,
            callbackTime);
    if (self->push_)
      (void)self->push_(self->context_, mono, static_cast<uint32_t>(frames),
                        projected.sampleHostTimeNs,
                        callbackTime,
                        projected.usedHardwareAnchor
                            ? AudioInputTimestampQuality::Hardware
                            : AudioInputTimestampQuality::CallbackEstimate);
    return AAUDIO_CALLBACK_RESULT_CONTINUE;
  }

  static void errorCallback(AAudioStream*, void* user, aaudio_result_t error) {
    auto* self = static_cast<AAudioInputBackend*>(user);
    if (!self) return;
    AudioInputCallbackScope callback(self->callbackGate_);
    if (!callback || self->stopRequested_.load(std::memory_order_acquire)) return;
    self->runtimeFailure_.store(error == AAUDIO_ERROR_DISCONNECTED
                                    ? RuntimeFailure::Disconnected
                                    : RuntimeFailure::StreamError,
                                std::memory_order_release);
  }

  AAudioStream* stream_ = nullptr;
  AudioInputPush push_ = nullptr;
  void* context_ = nullptr;
  std::vector<float> mono_;
  std::atomic<RuntimeFailure> runtimeFailure_{RuntimeFailure::None};
  std::atomic<bool> stopRequested_{true};
  AudioInputCallbackGate callbackGate_;
  AudioInputTimestampProjector timestampProjector_;
  AudioInputTimestampQueryGate timestampQueryGate_;
  std::thread timestampSampler_;
  std::atomic<bool> timestampSamplerStop_{true};
  int64_t callbackFrameCursor_ = 0;  // RT callback only while the gate is open
  int32_t requestedDeviceId_ = 0;
  int32_t deviceId_ = 0;
  int32_t requestedChannels_ = 0;
  int32_t channels_ = 0;
  int32_t sampleRate_ = 0;
  aaudio_format_t format_ = AAUDIO_FORMAT_UNSPECIFIED;
  aaudio_sharing_mode_t sharingMode_ = AAUDIO_SHARING_MODE_SHARED;
  aaudio_performance_mode_t performanceMode_ = AAUDIO_PERFORMANCE_MODE_NONE;
  std::string inputPresetName_ = "voice-recognition-default-unverified";
  uint32_t selectedChannel_ = 0;
  bool started_ = false;
};

}  // namespace

std::unique_ptr<AudioInputBackend> createPlatformAudioInputBackend() {
  return std::make_unique<AAudioInputBackend>();
}

std::vector<AudioInputDevice> enumeratePlatformAudioInputDevices(std::string* error) {
  std::vector<AudioInputDevice> devices = androidAudioInputDevices();
  if (error) *error = devices.empty() ? "Android audio input inventory is unavailable" : "";
  return devices;
}

}  // namespace singz

#endif

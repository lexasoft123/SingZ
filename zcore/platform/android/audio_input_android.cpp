#include <zcore/device/audio_input_backend.h>

#if defined(__ANDROID__)

#if !defined(__ANDROID_API__) || __ANDROID_API__ < 28
#error "SingZ's Android input backend requires Android API 28 or newer"
#endif

#include <oboe/Oboe.h>
#include <android/log.h>
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

#include <zcore/device/audio_input_android_registry.h>
#include <zcore/device/audio_input_android_policy.h>
#include <zcore/device/audio_input_callback_gate.h>
#include <zcore/audio/audio_input_timestamp.h>

// Capture goes through Oboe rather than raw AAudio, and the reason is
// QuirksManager — Google's device database, maintained from fleet-wide
// reports, which we cannot reproduce one phone at a time. It knows, among
// other things, that certain Exynos 9810 builds RECORD SILENCE on MMAP
// without the VoiceCommunication preset — the exact combination the ladder
// here used to try FIRST, and which opens successfully, so no open-failure
// fallback would ever have caught it. It also knows that Exynos 9810/850 run
// a mono request in stereo and need the first channel extracted, that Exynos
// 990 and Qualcomm SM8150 have broken low-latency capture, and that float
// capture has no fast path before Android P.
//
// What Oboe does NOT do, and what this file therefore still does, is verify
// that Android actually routed capture to the device we asked for. SingZ lets
// a singer pick an input, so quietly getting a different one is a failure
// here even though it is fine for Oboe's usual callers.
namespace singz {
namespace {

constexpr char kUidPrefix[] = "android:";
constexpr int32_t kMaximumChannels = 256;
constexpr int32_t kMaximumCallbackFrames = 16384;
constexpr uint64_t kCallbackDrainTimeoutNs = 2000000000ull;

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

const char* formatName(oboe::AudioFormat format) {
  switch (format) {
    case oboe::AudioFormat::Float: return "float32";
    case oboe::AudioFormat::I16: return "pcm16";
    case oboe::AudioFormat::I24: return "pcm24";
    case oboe::AudioFormat::I32: return "pcm32";
    default: return "unsupported";
  }
}

const char* sharingName(oboe::SharingMode mode) {
  return mode == oboe::SharingMode::Exclusive ? "exclusive" : "shared";
}

const char* performanceName(oboe::PerformanceMode mode) {
  switch (mode) {
    case oboe::PerformanceMode::LowLatency: return "low-latency";
    case oboe::PerformanceMode::PowerSaving: return "power-saving";
    default: return "none";
  }
}

enum class RuntimeFailure : int32_t {
  None = 0,
  Disconnected = 1,
  CallbackTooLarge = 2,
  InvalidBuffer = 3,
  StreamError = 4,
};

class OboeInputBackend;

/**
 * Oboe retains its callbacks for the stream's life and dispatches errors from
 * its own thread — `oboe_aaudio_error_thread_proc_common` calls
 * onErrorBeforeClose, then close(), then onErrorAfterClose, holding a
 * shared_ptr to the STREAM only. Handing it a raw `this` is deprecated in
 * Oboe for that reason: a disconnect landing inside teardown would call a
 * virtual on freed memory, and the callback gate cannot help because
 * onErrorAfterClose runs after Oboe's own close().
 *
 * So the callbacks live on a separately owned object that Oboe keeps alive,
 * carrying a back-pointer the backend clears before it goes. Late callbacks
 * then find null and do nothing. Same shape as the JNI listener bridge.
 */
struct OboeCallbackBridge final : oboe::AudioStreamDataCallback,
                                  oboe::AudioStreamErrorCallback {
  AudioInputCallbackOwnerGate<OboeInputBackend> owner;

  oboe::DataCallbackResult onAudioReady(oboe::AudioStream* stream, void* audioData,
                                        int32_t frames) override;
  void onErrorBeforeClose(oboe::AudioStream* stream, oboe::Result error) override;
};

class OboeInputBackend final : public AudioInputBackend {
 public:
  ~OboeInputBackend() override { stop(); }

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
    // Ask for MONO whenever the caller wants the first lane, which on Android
    // is always — nothing in the app offers a lane picker. Asking instead for
    // the maximum count AudioManager advertised (2 on a phone) and taking lane
    // 0 rests on something the platform never defines: AOSP documents how to
    // SELECT a channel by index and nowhere says which microphone an index is,
    // and the one API that maps the two (MicrophoneInfo.getChannelMapping) has
    // no equivalent on this capture path. Measured on a Xiaomi 23049PCD8G, the
    // two lanes sit 4.4 dB apart on the same sound, so the choice changes what
    // you hear — while saying nothing about which lane is which.
    requestedChannels_ =
        config.channel == 0 ? 1 : static_cast<int32_t>(found->channels);
    selectedChannel_ = config.channel;
    push_ = push;
    context_ = context;
    runtimeFailure_.store(RuntimeFailure::None, std::memory_order_relaxed);
    stopRequested_.store(false, std::memory_order_release);
    mono_.resize(kMaximumCallbackFrames);
    callbacks_->owner.open(this);

    oboe::AudioStreamBuilder builder;
    builder.setDirection(oboe::Direction::Input)
        ->setDeviceId(requestedDeviceId_)
        ->setChannelCount(requestedChannels_)
        ->setFormat(oboe::AudioFormat::Float)
        // Convert rather than fail when a device cannot serve float or the
        // requested lane count natively — including the pre-P quirk where
        // float capture has no fast path at all.
        ->setFormatConversionAllowed(true)
        ->setSampleRateConversionQuality(oboe::SampleRateConversionQuality::Medium)
        ->setPerformanceMode(oboe::PerformanceMode::LowLatency)
        // Sharing mode is left at Oboe's default on purpose. The old code
        // tried EXCLUSIVE (MMAP) first and fell back only on an open FAILURE,
        // which is exactly wrong for the devices whose MMAP capture opens fine
        // and then delivers silence. QuirksManager gates MMAP per device.
        ->setInputPreset(oboe::InputPreset::VoicePerformance)
        ->setDataCallback(callbacks_)
        ->setErrorCallback(callbacks_);
    // Audio API is left to Oboe. It recommends AAudio from API 27 and minSdk
    // is 28, so OpenSL ES — which does not support device IDs and reports 0
    // for every stream, which would fail the routing check below for every
    // microphone a singer picks — is out of reach on any device that can
    // install this app.

    const oboe::Result opened = builder.openStream(stream_);
    if (opened != oboe::Result::OK || !stream_) {
      closeStream();
      return failure(std::string("Oboe could not open the input: ") +
                         oboe::convertToText(opened),
                     selectedChannel_);
    }
    std::string invalid = verifyOpenedStream();
    if (!invalid.empty()) {
      closeStream();
      return failure(std::move(invalid), selectedChannel_);
    }
    return negotiatedResult(AudioInputState::Starting);
  }

  AudioInputResult start() override {
    if (!stream_) return failure("Oboe input is not prepared", selectedChannel_);
    callbackGate_.open();
    callbackFrameCursor_ = 0;
    timestampProjector_.reset();
    const oboe::Result requested = stream_->requestStart();
    if (requested != oboe::Result::OK) {
      callbackGate_.beginClose();
      return failure(std::string("Oboe input could not start: ") +
                         oboe::convertToText(requested),
                     selectedChannel_);
    }

    oboe::StreamState current = stream_->getState();
    const int64_t deadline = static_cast<int64_t>(monotonicNowNs()) + 2000000000ll;
    while (current != oboe::StreamState::Started &&
           current != oboe::StreamState::Disconnected &&
           static_cast<int64_t>(monotonicNowNs()) < deadline) {
      oboe::StreamState next = current;
      const oboe::Result waited =
          stream_->waitForStateChange(current, &next, 100000000ll);
      if (waited != oboe::Result::OK && waited != oboe::Result::ErrorTimeout)
        return failure(std::string("Oboe start state failed: ") +
                           oboe::convertToText(waited),
                       selectedChannel_);
      current = next;
    }
    if (current != oboe::StreamState::Started)
      return failure(current == oboe::StreamState::Disconnected
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
        error = "Oboe input callback exceeded the core frame limit";
        return true;
      case RuntimeFailure::InvalidBuffer:
        error = "Oboe delivered an invalid input buffer";
        return true;
      case RuntimeFailure::StreamError:
        error = "Oboe input stream failed";
        return true;
    }
    return false;
  }

  // ---- driven by OboeCallbackBridge ----------------------------------------
  oboe::DataCallbackResult onAudioReady(void* audioData, int32_t frames) {
    const uint64_t callbackTime = monotonicNowNs();
    AudioInputCallbackScope callback(callbackGate_);
    // Continue, not Stop, on the teardown paths. Below API 31 Oboe turns a
    // Stop return into a DETACHED thread that calls requestStop() on a raw
    // AudioStream*, and closeStream() is already dropping that stream — the
    // thread can reach its lock after the object is gone. Nothing needs
    // stopping here anyway: the close is under way. Genuine errors below still
    // return Stop, where the close arrives a JS round-trip later.
    if (!callback || stopRequested_.load(std::memory_order_acquire))
      return oboe::DataCallbackResult::Continue;
    if (!audioData || frames <= 0 || channels_ <= 0) {
      runtimeFailure_.store(RuntimeFailure::InvalidBuffer, std::memory_order_release);
      return oboe::DataCallbackResult::Stop;
    }
    if (frames > kMaximumCallbackFrames) {
      runtimeFailure_.store(RuntimeFailure::CallbackTooLarge, std::memory_order_release);
      return oboe::DataCallbackResult::Stop;
    }
    // setFormatConversionAllowed means Oboe hands us the format we asked for
    // even when the device serves another, so this is always float.
    float* mono = mono_.data();
    const auto* source = static_cast<const float*>(audioData);
    const int32_t channels = channels_;
    const uint32_t selected = selectedChannel_;
    for (int32_t frame = 0; frame < frames; ++frame)
      mono[static_cast<size_t>(frame)] =
          source[static_cast<size_t>(frame) * static_cast<size_t>(channels) +
                 static_cast<size_t>(selected)];

    const int64_t blockStartFrame = callbackFrameCursor_;
    if (blockStartFrame > std::numeric_limits<int64_t>::max() - frames) {
      runtimeFailure_.store(RuntimeFailure::InvalidBuffer, std::memory_order_release);
      return oboe::DataCallbackResult::Stop;
    }
    callbackFrameCursor_ += frames;
    const AudioInputTimestampProjection projected = timestampProjector_.project(
        blockStartFrame, static_cast<uint32_t>(frames), sampleRate_, callbackTime);
    if (push_)
      (void)push_(context_, mono, static_cast<uint32_t>(frames),
                  projected.sampleHostTimeNs, callbackTime,
                  projected.usedHardwareAnchor
                      ? AudioInputTimestampQuality::Hardware
                      : AudioInputTimestampQuality::CallbackEstimate);
    return oboe::DataCallbackResult::Continue;
  }

  void onErrorBeforeClose(oboe::Result error) {
    // Enter the gate here too: teardown's inFlight() wait is what stops the
    // backend being destroyed underneath a callback still running.
    AudioInputCallbackScope callback(callbackGate_);
    if (!callback || stopRequested_.load(std::memory_order_acquire)) return;
    runtimeFailure_.store(error == oboe::Result::ErrorDisconnected
                              ? RuntimeFailure::Disconnected
                              : RuntimeFailure::StreamError,
                          std::memory_order_release);
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
    result.timestampSource = "oboe-hardware-monotonic-anchor-with-callback-fallback";
    return result;
  }

  std::string verifyOpenedStream() {
    deviceId_ = stream_->getDeviceId();
    channels_ = stream_->getChannelCount();
    sampleRate_ = stream_->getSampleRate();
    format_ = stream_->getFormat();
    sharingMode_ = stream_->getSharingMode();
    performanceMode_ = stream_->getPerformanceMode();
    // A genuine read-back: AAudioStream_getInputPreset exists from API 28, and
    // minSdk is 28, so this is the preset the stream actually carries rather
    // than a restatement of what we asked for.
    inputPresetName_ = androidAudioInputPresetMetadata(
        static_cast<int32_t>(stream_->getInputPreset()), true, true);
    // Oboe does not check this, and for its usual callers it need not: they
    // want a microphone, not a NAMED microphone. SingZ offers a device choice,
    // so capture arriving from somewhere else is a failure, not a fallback.
    if (deviceId_ != requestedDeviceId_)
      return "Android routed capture to a different input device";
    if (channels_ <= 0 || channels_ > kMaximumChannels ||
        selectedChannel_ >= static_cast<uint32_t>(channels_))
      return "Oboe exposed fewer channels than AudioManager advertised";
    if (sampleRate_ <= 0 || format_ != oboe::AudioFormat::Float)
      return "Oboe returned an unsupported input format";
    return {};
  }

  void closeStream() {
    // This outer bridge gate is the backend lifetime barrier. Its counter is
    // incremented before owner is read, unlike the backend gate below. Once
    // admission is closed, a callback racing after a zero observation cannot
    // load the owner and therefore cannot enter the backend at all.
    callbacks_->owner.beginClose();
    // The sampler is the only non-RT caller of getTimestamp. Stop and join it
    // while the stream is still open, before close() can invalidate the
    // handle. Already-entered bridge callbacks remain pinned by the outer
    // counter and drain below.
    stopTimestampSampler();
    callbackGate_.beginClose();
    auto stream = stream_;
    if (stream && started_) (void)stream->requestStop();

    // Both callback bodies are bounded and non-blocking. Cap the control-side
    // wait anyway: hanging forever during teardown is not a recovery policy.
    // If the invariant is ever broken, fail closed with an Android tombstone
    // instead of clearing a pointer that another thread still owns.
    const auto deadline = std::chrono::steady_clock::now() +
                          std::chrono::nanoseconds(kCallbackDrainTimeoutNs);
    while ((callbacks_->owner.inFlight() != 0 || callbackGate_.inFlight() != 0) &&
           std::chrono::steady_clock::now() < deadline) {
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    if (callbacks_->owner.inFlight() != 0 || callbackGate_.inFlight() != 0) {
      __android_log_assert("callback-drain-timeout", "SingZ",
                           "Oboe callbacks did not quiesce within 2 seconds");
    }
    if (!callbacks_->owner.clearOwnerIfQuiescent()) {
      __android_log_assert("callback-owner-still-live", "SingZ",
                           "Oboe callback owner cleared before quiescence");
    }
    if (!stream) {
      started_ = false;
      timestampProjector_.reset();
      return;
    }
    // Oboe's error thread calls close() and then onErrorAfterClose; with the
    // bridge gate closed and its owner cleared above, neither has anything of
    // ours to reach.
    (void)stream->close();
    stream_.reset();
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
            auto stream = stream_;
            if (!stream) break;
            const auto stamp = stream->getTimestamp(CLOCK_MONOTONIC);
            const uint64_t sampledAtNs = monotonicNowNs();
            if (stamp)
              (void)timestampProjector_.publish(stamp.value().position,
                                                stamp.value().timestamp, sampledAtNs);
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
    // when closeStream continues to close().
  }

  std::shared_ptr<oboe::AudioStream> stream_;
  std::shared_ptr<OboeCallbackBridge> callbacks_ = std::make_shared<OboeCallbackBridge>();
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
  oboe::AudioFormat format_ = oboe::AudioFormat::Invalid;
  oboe::SharingMode sharingMode_ = oboe::SharingMode::Shared;
  oboe::PerformanceMode performanceMode_ = oboe::PerformanceMode::None;
  std::string inputPresetName_ = "voice-performance-requested-unverified";
  uint32_t selectedChannel_ = 0;
  bool started_ = false;
};

oboe::DataCallbackResult OboeCallbackBridge::onAudioReady(oboe::AudioStream* /*stream*/,
                                                          void* audioData, int32_t frames) {
  AudioInputCallbackOwnerScope<OboeInputBackend> backend(owner);
  return backend ? backend->onAudioReady(audioData, frames)
                 : oboe::DataCallbackResult::Continue;
}

void OboeCallbackBridge::onErrorBeforeClose(oboe::AudioStream* /*stream*/,
                                            oboe::Result error) {
  AudioInputCallbackOwnerScope<OboeInputBackend> backend(owner);
  if (backend) backend->onErrorBeforeClose(error);
}

}  // namespace

std::unique_ptr<AudioInputBackend> createPlatformAudioInputBackend() {
  return std::make_unique<OboeInputBackend>();
}

std::vector<AudioInputDevice> enumeratePlatformAudioInputDevices(std::string* error) {
  std::vector<AudioInputDevice> devices = androidAudioInputDevices();
  if (error) *error = devices.empty() ? "Android audio input inventory is unavailable" : "";
  return devices;
}

}  // namespace singz

#endif

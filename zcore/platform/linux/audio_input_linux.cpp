#include "alsa_pcm.h"

#include <zcore/device/audio_input_backend.h>

namespace singz {
namespace {
class AlsaInput final : public AudioInputBackend {
 public:
  ~AlsaInput() override { stop(); }
  AudioInputResult open(const AudioInputConfig& config, AudioInputPush push,
                        void* context) override {
    stop();
    if (!push) return fail("Capture callback is missing", config.channel);
    const auto endpoints = detail::alsaEndpoints();
    for (const auto& endpoint : endpoints) {
      if (endpoint.info.uid != config.deviceUid) continue;
      if (config.channel >= endpoint.info.inputChannels)
        return fail("Capture channel is outside the device inventory", config.channel);
      channel_ = config.channel; push_ = push; context_ = context;
      // The appliance baseline uses 48 kHz and 256 frames. Neural analysis
      // resampling remains on its existing delivery worker.
      std::string error;
      lease_ = detail::acquireAlsaCapture(config.deviceUid, endpoint.pcm,
          config.channel + 1, 48000, 256, deliver, this, error);
      if (!lease_) return fail(error, config.channel);
      mono_.resize(lease_->period());
      prepared_ = AudioInputResult::success(AudioInputState::Starting, 48000, channel_);
      prepared_.deviceUid = config.deviceUid;
      prepared_.deviceChannels = lease_->channels();
      prepared_.sampleFormat = "converted planar float32";
      prepared_.sharingMode = "exclusive ALSA; shared capture lease";
      prepared_.timestampSource = "monotonic read completion (estimated)";
      return prepared_;
    }
    return fail("ALSA capture endpoint was not found", config.channel);
  }
  AudioInputResult start() override {
    std::string error;
    if (!lease_ || !lease_->start(error))
      return fail(error.empty() ? "Capture endpoint is not prepared" : error, channel_);
    auto result = prepared_; result.state = AudioInputState::Running; return result;
  }
  void stop() override {
    lease_.reset();
    push_ = nullptr; context_ = nullptr;
  }
  bool suspendPrepared() override {
    if (!lease_ || lease_->failure()) return false;
    lease_->stop(); return true;
  }
  bool takeFailure(std::string& error) override {
    const int code = lease_ ? lease_->failure() : 0;
    if (!code) return false;
    error = std::string("ALSA capture stopped: ") + snd_strerror(code);
    return true;
  }
 private:
  static AudioInputResult fail(std::string error, uint32_t channel) {
    return AudioInputResult::failure(AudioInputState::Error, std::move(error), channel);
  }
  static bool deliver(void* context, const float* input, uint32_t channels,
                       uint32_t frames, uint64_t, uint64_t firstSampleNs) noexcept {
    auto& self = *static_cast<AlsaInput*>(context);
    for (uint32_t frame = 0; frame < frames; ++frame)
      self.mono_[frame] = input[size_t(frame) * channels + self.channel_];
    return self.push_(self.context_, self.mono_.data(), frames,
        firstSampleNs, detail::alsaMonotonicNs(),
        AudioInputTimestampQuality::CallbackEstimate);
  }
  std::unique_ptr<detail::AlsaCaptureLease> lease_;
  std::vector<float> mono_;
  uint32_t channel_{0};
  AudioInputPush push_{nullptr};
  void* context_{nullptr};
  AudioInputResult prepared_;
};
}
std::unique_ptr<AudioInputBackend> createPlatformAudioInputBackend() {
  return std::make_unique<AlsaInput>();
}
std::vector<AudioInputDevice> enumeratePlatformAudioInputDevices(std::string* error) {
  if (error) error->clear();
  std::vector<AudioInputDevice> devices;
  for (const auto& endpoint : detail::alsaEndpoints()) {
    const auto& row = endpoint.info;
    if (row.inputChannels) devices.push_back({row.uid, row.label, row.defaultInput,
        row.nominalSampleRate, row.inputChannels, row.inputChannelLabels});
  }
  return devices;
}
}  // namespace singz

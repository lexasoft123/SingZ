#include "alsa_pcm.h"
#include "../../src/device/audio_host_fifo.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <mutex>
#include <set>
#include <thread>

namespace singz {
namespace {
std::atomic<uint64_t> nextGeneration{1};
std::mutex outputOwnersMutex;
std::set<std::string> outputOwners;
class AlsaHost final : public AudioHostBackend {
 public:
  ~AlsaHost() override { stop(); }
  AudioHostInventory enumerate() const override {
    AudioHostInventory result;
    for (auto& endpoint : detail::alsaEndpoints()) {
      if (endpoint.info.defaultInput) result.defaultInputUid = endpoint.info.uid;
      if (endpoint.info.defaultOutput) result.defaultOutputUid = endpoint.info.uid;
      result.devices.push_back(std::move(endpoint.info));
    }
    return result;
  }
  AudioHostResult open(const AudioHostConfig& config, AudioHostRender render,
                       void* context) override {
    stop();
    state_.store(AudioHostState::Closed, std::memory_order_release);
    const bool input = !config.inputChannels.empty();
    const double rate = config.requestedSampleRate ? config.requestedSampleRate : 48000;
    const uint32_t period = config.requestedBufferFrames ? config.requestedBufferFrames : 256;
    if (!render || !std::isfinite(rate) || rate < 8000 || rate > 384000 ||
        std::floor(rate) != rate || config.outputChannels.empty() ||
        config.outputChannels.size() > kAudioHostMaxChannels ||
        config.inputChannels.size() > kAudioHostMaxChannels ||
        input != !config.inputDeviceUid.empty() || !config.maximumFrames ||
        config.maximumFrames > kAudioHostMaxFrames || period > config.maximumFrames)
      return fail(AudioHostError::InvalidConfiguration, "Invalid ALSA host configuration");
    auto validMap = [](const auto& map) {
      std::array<bool, kAudioHostMaxChannels> used{};
      for (uint32_t channel : map) {
        if (channel >= used.size() || used[channel]) return false;
        used[channel] = true;
      }
      return true;
    };
    if (!validMap(config.outputChannels) || !validMap(config.inputChannels))
      return fail(AudioHostError::InvalidConfiguration, "Invalid or duplicate channel map");
    std::string outputPcm, inputPcm, outputIdentity;
#if defined(SINGZ_CORE_TESTS)
    outputPcm = testOutput_; inputPcm = testInput_;
    if (!outputPcm.empty()) outputIdentity = "test-pcm:" + outputPcm;
#endif
    if (outputPcm.empty()) {
      for (const auto& endpoint : detail::alsaEndpoints()) {
        if ((endpoint.info.uid == config.outputDeviceUid ||
             (config.outputDeviceUid.empty() && endpoint.info.defaultOutput)) &&
            endpoint.info.outputChannels) {
          outputPcm = endpoint.pcm;
          outputIdentity = endpoint.info.uid;
        }
        if (endpoint.info.uid == config.inputDeviceUid && endpoint.info.inputChannels)
          inputPcm = endpoint.pcm;
      }
    }
    if (outputPcm.empty() || (input && inputPcm.empty()))
      return fail(AudioHostError::DeviceNotFound, "ALSA endpoint was not found or is ambiguous");
    {
      std::lock_guard<std::mutex> lock(outputOwnersMutex);
      if (!outputOwners.insert(outputIdentity).second)
        return fail(AudioHostError::ProviderFailure, "ALSA output endpoint already has an owner");
      claimedOutput_ = std::move(outputIdentity);
    }
    std::string error;
    if (!pcm_.open(outputPcm, false,
        *std::max_element(config.outputChannels.begin(), config.outputChannels.end()) + 1,
        uint32_t(rate), period, config.maximumFrames, error))
      return fail(AudioHostError::ProviderFailure, error);
    config_ = config;
    render_ = render; context_ = context;
    format_ = {rate, config.maximumFrames, pcm_.period,
        uint32_t(config.inputChannels.size()), uint32_t(config.outputChannels.size()),
        true, true, AudioHostAccessMode::Exclusive};
    output_.resize(size_t(format_.outputChannels) * pcm_.period);
    interleaved_.resize(size_t(pcm_.channels) * pcm_.period);
    bytes_.resize(interleaved_.size() * pcm_.sampleBytes());
    for (uint32_t c = 0; c < format_.outputChannels; ++c)
      outputPointers_[c] = output_.data() + size_t(c) * pcm_.period;
    if (input) {
      if (!fifo_.prepare(format_.inputChannels, pcm_.period * 16))
        return fail(AudioHostError::ProviderFailure, "Cannot prepare capture FIFO");
      input_.resize(size_t(format_.inputChannels) * pcm_.period);
      for (uint32_t c = 0; c < format_.inputChannels; ++c)
        inputPointers_[c] = input_.data() + size_t(c) * pcm_.period;
      capture_ = detail::acquireAlsaCapture(config.inputDeviceUid, inputPcm,
          *std::max_element(config.inputChannels.begin(), config.inputChannels.end()) + 1,
          uint32_t(rate), pcm_.period, capture, this, error);
      if (!capture_) return fail(AudioHostError::ProviderFailure, error);
    }
    generation_ = nextGeneration.fetch_add(1, std::memory_order_relaxed);
    clock_ = detail::alsaClockId(claimedOutput_);
    callbacks_.store(0); frames_.store(0); failures_.store(0);
    nonFinite_.store(0);
    error_.store(0); xruns_.store(0);
    terminal_.reset();
    nextDiscontinuity_ = AudioHostDiscontinuityStart;
    state_.store(AudioHostState::Open, std::memory_order_release);
    return success();
  }
  AudioHostResult start() override {
    const auto state = state_.load(std::memory_order_acquire);
    if ((state != AudioHostState::Open && state != AudioHostState::Suspended) || !pcm_.handle)
      return invalid("ALSA host is not prepared");
    std::string error;
    if (capture_ && !capture_->start(error))
      return fail(AudioHostError::ProviderFailure, error);
    int result = snd_pcm_prepare(pcm_.handle);
    if (result < 0) return fail(AudioHostError::ProviderFailure, snd_strerror(result));
    // No render callback during priming. Every physical output starts silent.
    std::fill(bytes_.begin(), bytes_.end(), 0);
    snd_pcm_uframes_t written = 0;
    while (written < pcm_.buffer) {
      const auto count = snd_pcm_writei(pcm_.handle, bytes_.data(),
          std::min(snd_pcm_uframes_t(pcm_.period), pcm_.buffer - written));
      if (count <= 0) return fail(AudioHostError::ProviderFailure,
          count < 0 ? snd_strerror(int(count)) : "ALSA prefill made no progress");
      written += snd_pcm_uframes_t(count);
    }
    result = snd_pcm_start(pcm_.handle);
    if (result < 0) return fail(AudioHostError::ProviderFailure, snd_strerror(result));
    pcm_.clearWake();
    stopping_.store(false, std::memory_order_release);
    state_.store(AudioHostState::Running, std::memory_order_release);
    try { worker_ = std::thread([this] { run(); }); }
    catch (...) { return fail(AudioHostError::ProviderFailure, "Cannot create ALSA output worker"); }
    return success();
  }
  void halt() noexcept {
    stopping_.store(true, std::memory_order_release);
    pcm_.wake();
    if (worker_.joinable()) worker_.join();
    if (pcm_.handle) snd_pcm_drop(pcm_.handle);
  }
  void stop() noexcept override {
    halt();
    capture_.reset(); // gate closes and drains before its render context dies
    pcm_.close();
    if (!claimedOutput_.empty()) {
      std::lock_guard<std::mutex> lock(outputOwnersMutex);
      outputOwners.erase(claimedOutput_); claimedOutput_.clear();
    }
    render_ = nullptr; context_ = nullptr;
    if (state_.load(std::memory_order_acquire) != AudioHostState::Closed)
      state_.store(AudioHostState::Stopped, std::memory_order_release);
  }
  AudioHostResult suspend() override {
    if (state_.load(std::memory_order_acquire) != AudioHostState::Running)
      return invalid("Only a running ALSA host can be suspended");
    halt();
    if (terminal_.hasCause()) return invalid("ALSA host failed while suspending");
    if (capture_) capture_->stop(); // other input leases remain active
    fifo_.reset(); // both producer admission and output consumer are stopped
    nextDiscontinuity_ = AudioHostDiscontinuityClockReanchored;
    state_.store(AudioHostState::Suspended, std::memory_order_release);
    return success();
  }
  AudioHostResult resume() override {
    if (state_.load(std::memory_order_acquire) != AudioHostState::Suspended)
      return invalid("ALSA host is not suspended");
    return start();
  }
  AudioHostStatus status() const noexcept override {
    AudioHostStatus result;
    result.state = state_.load(std::memory_order_acquire);
    const auto cause = terminal_.current();
    result.terminalReason = cause.reason; result.terminalOrdinal = cause.ordinal;
    result.format = format_;
    result.routeGeneration = generation_; result.streamGeneration = generation_;
    result.callbacks = callbacks_.load(std::memory_order_relaxed);
    result.renderedFrames = frames_.load(std::memory_order_relaxed);
    result.renderFailures = failures_.load(std::memory_order_relaxed);
    result.xruns = xruns_.load(std::memory_order_relaxed);
    result.diagnostics.nonFiniteOutputSamples = nonFinite_.load(std::memory_order_relaxed);
    result.diagnostics.outputPeriodFrames = pcm_.period;
    result.diagnostics.outputBufferFrames = pcm_.buffer;
    if (capture_) {
      result.diagnostics.inputPeriodFrames = capture_->period();
      result.diagnostics.inputBufferFrames = capture_->bufferFrames();
      result.diagnostics.nonFiniteInputSamples = capture_->nonFiniteSamples();
      result.diagnostics.fifoCapacityFrames = fifo_.capacityFrames();
      result.diagnostics.fifoCurrentFrames = fifo_.currentFrames();
      result.diagnostics.fifoUnderflows = fifo_.underflows();
      result.diagnostics.fifoOverflows = fifo_.overflows();
    }
    return result;
  }
#if defined(SINGZ_CORE_TESTS)
  std::string testOutput_, testInput_;
  detail::AlsaWriteForTest testWrite_{nullptr};
  void* testWriteContext_{nullptr};
#endif
 private:
  AudioHostResult success() const {
    return {true, AudioHostError::None, state_.load(std::memory_order_acquire), format_, {}, {}};
  }
  AudioHostResult invalid(const char* message) const {
    return {false, AudioHostError::InvalidState, state_.load(std::memory_order_acquire), format_, {}, message};
  }
  AudioHostResult fail(AudioHostError code, std::string message) {
    stop();
    state_.store(AudioHostState::Error, std::memory_order_release);
    return {false, code, AudioHostState::Error, {}, {}, std::move(message)};
  }
  static bool capture(void* context, const float* input, uint32_t channels,
                       uint32_t frames, uint64_t source, uint64_t firstSampleNs) noexcept {
    auto& self = *static_cast<AlsaHost*>(context);
    detail::AudioHostCaptureSpan span{source, firstSampleNs,
        frames, AudioHostDiscontinuityNone, true, false};
    return self.fifo_.writeInterleavedFloat(input, channels,
        self.config_.inputChannels.data(), frames, span, false);
  }
  void terminal(int error) noexcept {
    error_.store(error, std::memory_order_release);
    if (error == -EPIPE || error == -ESTRPIPE)
      xruns_.fetch_add(1, std::memory_order_relaxed);
    const bool lost = error == -ENODEV || error == -EBADFD;
    terminal_.publish(lost ? AudioHostTerminalReason::DeviceLost :
        AudioHostTerminalReason::ProviderFailure, AudioHostTerminalProducer::Provider);
    state_.store(lost ? AudioHostState::DeviceLost : AudioHostState::Error,
                 std::memory_order_release);
    // Drop queued playback on a terminal error. No drain or auto-resume.
    snd_pcm_drop(pcm_.handle);
  }
  void run() noexcept {
    uint32_t pending = 0, offset = 0;
    while (!stopping_.load(std::memory_order_acquire)) {
      if (capture_ && capture_->failure()) { terminal(capture_->failure()); break; }
      const int ready = pcm_.wait();
      if (stopping_.load(std::memory_order_acquire)) break;
      if (ready < 0) { terminal(ready); break; }
      if (!ready) continue;
      if (!pending) {
        const auto available = snd_pcm_avail_update(pcm_.handle);
        if (available == -EAGAIN || available == -EINTR) continue;
        if (available < 0) { terminal(int(available)); break; }
        if (available < pcm_.period) continue;
        std::fill(output_.begin(), output_.end(), 0);
        AudioHostRenderBlock block;
        block.output = outputPointers_.data(); block.outputChannels = format_.outputChannels;
        block.frames = pcm_.period; block.maximumFrames = format_.maximumFrames;
        block.sampleRate = format_.sampleRate; block.clockDomain = clock_;
        block.routeGeneration = generation_; block.streamGeneration = generation_;
        block.callbackSequence = callbacks_.load(std::memory_order_relaxed);
        block.outputFrame = frames_.load(std::memory_order_relaxed);
        block.callbackHostTimeNs = detail::alsaMonotonicNs();
        snd_pcm_sframes_t queued = 0;
        if (snd_pcm_delay(pcm_.handle, &queued) == 0 && queued >= 0) {
          block.outputHostTimeNs = block.callbackHostTimeNs +
              uint64_t(double(queued) * 1e9 / format_.sampleRate);
          block.outputTimestampValid = true;
          block.outputTimestampHardware = false;
        }
        block.discontinuity = nextDiscontinuity_;
        nextDiscontinuity_ = AudioHostDiscontinuityNone;
        if (capture_) {
          const auto read = fifo_.read(inputPointers_.data(), pcm_.period, format_.sampleRate);
          block.input = inputPointers_.data(); block.inputChannels = format_.inputChannels;
          block.inputSourceFrame = read.sourceFrame;
          block.inputSampleHostTimeNs = read.sampleHostTimeNs;
          block.inputTimestampValid = read.timestampValid;
          block.inputTimestampHardware = false;
          block.discontinuity |= read.discontinuity;
        }
        if (!render_(context_, block)) {
          failures_.fetch_add(1, std::memory_order_relaxed);
          terminal(-ECANCELED); break;
        }
        callbacks_.fetch_add(1, std::memory_order_relaxed);
        frames_.fetch_add(pcm_.period, std::memory_order_relaxed);
        std::fill(interleaved_.begin(), interleaved_.end(), 0);
        for (uint32_t c = 0; c < format_.outputChannels; ++c)
          for (uint32_t frame = 0; frame < pcm_.period; ++frame)
            interleaved_[size_t(frame) * pcm_.channels + config_.outputChannels[c]] =
                outputPointers_[c][frame];
        nonFinite_.fetch_add(detail::alsaEncode(interleaved_.data(), bytes_.data(),
            uint32_t(interleaved_.size()), pcm_.sampleFormat), std::memory_order_relaxed);
        pending = pcm_.period; offset = 0;
      }
      const void* data = bytes_.data() + size_t(offset) * pcm_.channels * pcm_.sampleBytes();
#if defined(SINGZ_CORE_TESTS)
      const auto count = testWrite_ ? testWrite_(testWriteContext_, data, pending) :
          snd_pcm_writei(pcm_.handle, data, pending);
#else
      const auto count = snd_pcm_writei(pcm_.handle, data, pending);
#endif
      if (count == -EAGAIN || count == -EINTR) continue;
      if (count <= 0 || uint64_t(count) > pending) {
        terminal(count < 0 ? int(count) : -EIO); break;
      }
      // Retain an incompletely written block. Never render its prefix twice.
      offset += uint32_t(count); pending -= uint32_t(count);
    }
  }
  detail::AlsaPcm pcm_;
  std::unique_ptr<detail::AlsaCaptureLease> capture_;
  detail::AudioHostPlanarFifo fifo_;
  AudioHostConfig config_;
  AudioHostFormat format_;
  AudioHostRender render_{nullptr}; void* context_{nullptr};
  std::string claimedOutput_;
  std::vector<float> output_, input_, interleaved_;
  std::vector<unsigned char> bytes_;
  std::array<float*, kAudioHostMaxChannels> outputPointers_{}, inputPointers_{};
  std::thread worker_;
  std::atomic<bool> stopping_{true};
  std::atomic<AudioHostState> state_{AudioHostState::Closed};
  std::atomic<int> error_{0};
  std::atomic<uint64_t> callbacks_{0}, frames_{0}, failures_{0}, xruns_{0};
  std::atomic<uint64_t> nonFinite_{0};
  AudioHostTerminalCauseLatch terminal_;
  uint64_t generation_{0}, clock_{0};
  uint32_t nextDiscontinuity_{AudioHostDiscontinuityStart};
};
}
std::unique_ptr<AudioHostBackend> createPlatformAudioHostBackend() {
  return std::make_unique<AlsaHost>();
}
#if defined(SINGZ_CORE_TESTS)
namespace detail {
std::unique_ptr<AudioHostBackend> makeAlsaAudioHostForTests(
    std::string outputPcm, std::string inputPcm,
    AlsaWriteForTest write, void* writeContext) {
  auto host = std::make_unique<AlsaHost>();
  host->testOutput_ = std::move(outputPcm); host->testInput_ = std::move(inputPcm);
  host->testWrite_ = write; host->testWriteContext_ = writeContext;
  return host;
}
}
#endif
}  // namespace singz

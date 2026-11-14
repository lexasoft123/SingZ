#include "voice_monitor_source.h"
#include <algorithm>
#include <cmath>
#include <chrono>
#include <limits>
#include <mutex>
#include <thread>
#include <utility>
#include <zcore/routing/audio_resampler.h>

namespace singz {
// SINGZ_MONITOR_SOURCE_RT_BEGIN
static_assert(std::atomic<uint64_t>::is_always_lock_free);
static_assert(std::atomic<double>::is_always_lock_free);
static_assert(std::atomic<uint32_t>::is_always_lock_free);
namespace {
bool monitorRate(double rate) noexcept {
  return std::isfinite(rate) && rate >= 8000 && rate <= 192000;
}
uint64_t monitorFrameNs(uint64_t frames, double rate) noexcept {
  return static_cast<uint64_t>(static_cast<long double>(frames) * 1e9L / rate);
}
uint32_t monitorTimingFrames(uint64_t ns, double rate) noexcept {
  // Two independently rounded host timestamps can differ by a nanosecond.
  // Keep that conversion precision from growing an integral-frame queue.
  const auto frames = std::ceil(std::max(0.0L, static_cast<long double>(ns) - 2) * rate / 1e9L);
  return static_cast<uint32_t>(std::min(frames, static_cast<long double>(kVoiceMonitorHistoryFrames)));
}
}
uint32_t voiceMonitorQueueFloor(double src, double dst, uint32_t outputPeriod,
    uint32_t inputPeriod, uint32_t lookback, uint32_t jitter, uint32_t quantum,
    uint32_t captureAge, uint32_t outputLead) noexcept {
  if (!monitorRate(src) || !monitorRate(dst) || !outputPeriod ||
      outputPeriod > kAudioHostMaxFrames || !inputPeriod ||
      inputPeriod > kVoiceMonitorMaximumCaptureFrames) return 0;
  const double outputFloor = std::ceil(2.0 * outputPeriod * src / dst) + quantum;
  const uint64_t inputFloor = std::max(inputPeriod, captureAge);
  const auto support = std::max(static_cast<uint64_t>(lookback) + jitter, uint64_t{quantum});
  // A presentation timestamp can be ahead of callback entry while capture's
  // first sample is already old when its block is published. Both offsets,
  // the entire output read and FIR support must fit behind publication.
  const double publicationFloor = std::ceil((double(outputPeriod) + outputLead) * src / dst) +
      static_cast<double>(inputFloor) + support;
  const double floor = std::max(outputFloor, publicationFloor);
  if (floor > kVoiceMonitorHistoryFrames / 2) return 0;
  return static_cast<uint32_t>(floor);
}
uint32_t voiceMonitorPresentationLead(const AudioHostRenderBlock& b) noexcept {
  if (!monitorRate(b.sampleRate) || !b.callbackHostTimeNs ||
      b.outputHostTimeNs <= b.callbackHostTimeNs) return 0;
  return monitorTimingFrames(b.outputHostTimeNs - b.callbackHostTimeNs, b.sampleRate);
}
void VoiceMonitorTimingWindow::reset() noexcept {
  largest_ = {}; previous_ = warmup_ = estimate_ = 0; startNs_ = 0;
}
uint32_t VoiceMonitorTimingWindow::observe(uint32_t frames, uint32_t period, uint64_t ns,
    uint32_t deviceFrames) noexcept {
  if (warmup_ < 4) { ++warmup_; return 0; } // Start may deliver queued packets.
  if (!startNs_ || ns < startNs_ || ns - startNs_ >= 500000000) {
    previous_ = startNs_ && ns >= startNs_ && ns - startNs_ < 1000000000 ? largest_[2] : 0;
    largest_ = {}; startNs_ = ns;
  }
  const auto cap = std::min(uint64_t{period} * 4 + deviceFrames, uint64_t{kVoiceMonitorHistoryFrames / 4});
  auto candidate = static_cast<uint32_t>(std::min(uint64_t{frames}, cap));
  for (auto& value : largest_) if (candidate > value) std::swap(candidate, value);
  estimate_ = std::max(previous_, largest_[2]);
  return estimate_;
}
void VoiceMonitorOutputClock::reset() noexcept { *this = {}; }
double VoiceMonitorOutputClock::observe(uint64_t frame, uint64_t ns, uint32_t frames,
                                      double nominal, bool discontinuity) noexcept {
  if (!frames || frame > UINT64_MAX - frames || !ns || !monitorRate(nominal)) {
    reset(); return 0;
  }
  if (previousNs_) {
    const auto expected = static_cast<long double>(previousFrames_) * 1e9L / nominal;
    const auto elapsed = static_cast<long double>(ns) - previousNs_;
    discontinuity = discontinuity || nominal != nominalRate_ ||
      frame != previousFrame_ + previousFrames_ || ns <= previousNs_ ||
      std::abs(elapsed - expected) > std::max(2000000.0L, expected * .005L + 1000);
  }
  if (discontinuity) reset();
  if (!originNs_) { originNs_ = recentNs_ = ns; originFrame_ = recentFrame_ = frame; }
  constexpr uint64_t window = 25000000;
  if (ns - recentNs_ >= window) {
    if (recentNs_ != originNs_) { originNs_ = recentNs_; originFrame_ = recentFrame_; }
    recentNs_ = ns; recentFrame_ = frame;
  }
  double rate = nominal;
  if (ns - originNs_ >= window) {
    const auto expected = static_cast<long double>(frame - originFrame_) * 1e9L / nominal;
    const auto elapsed = ns - originNs_;
    // Host timestamps are integer nanoseconds. Do not turn their rounding
    // into clock drift: that alternates direct copy and the bandlimited FIR
    // on a nominal 1:1 route, changing the waveform from callback to callback.
    // Match the history clock's two-nanosecond precision admission.
    if (std::abs(expected - elapsed) > 2)
      rate = static_cast<double>(static_cast<long double>(frame - originFrame_) * 1e9L / elapsed);
    if (rate < nominal * .995 || rate > nominal * 1.005) {
      originNs_ = recentNs_ = ns; originFrame_ = recentFrame_ = frame; rate = nominal;
    }
  }
  previousNs_ = ns; previousFrame_ = frame; previousFrames_ = frames; nominalRate_ = nominal;
  return rate;
}
bool VoiceMonitorSource::publish(const float* input, uint32_t frames, uint64_t ns,
    AudioInputTimestampQuality quality, AudioInputSourcePosition position, uint64_t callbackNs) noexcept {
  const double rate = rate_.load(std::memory_order_relaxed);
  // A provider may omit its opening period. Retain the largest actual block.
  if (frames <= kVoiceMonitorMaximumCaptureFrames && frames > inputPeriod_.load(std::memory_order_relaxed))
    inputPeriod_.store(frames, std::memory_order_relaxed);
  const float* planes[]{input};
  const bool accepted = input && frames && frames <= kVoiceMonitorMaximumCaptureFrames && ns &&
      monitorRate(rate) && history_.append({planes, frames}, frames, ns, rate,
                                         position.sampleFrame, position.valid);
  if (!accepted) {
    droppedBlocks_.fetch_add(1, std::memory_order_relaxed);
    droppedFrames_.fetch_add(frames, std::memory_order_relaxed);
    return false;
  }
  const auto age = callbackNs > ns ? monitorTimingFrames(callbackNs - ns, rate) : 0;
  captureAgeFrames_.store(captureAgeWindow_.observe(age, inputPeriod(), ns, inputDeviceFrames_),
      std::memory_order_relaxed);
  publishedBlocks_.fetch_add(1, std::memory_order_relaxed);
  publishedFrames_.fetch_add(frames, std::memory_order_relaxed);
  if (quality == AudioInputTimestampQuality::Unknown) unknown_.fetch_add(1, std::memory_order_relaxed);
  if (quality == AudioInputTimestampQuality::CallbackEstimate) estimated_.fetch_add(1, std::memory_order_relaxed);
  return true;
}
uint32_t VoiceMonitorSource::queueFloor(double rate, uint32_t period, uint32_t outputLead) const noexcept {
  const double src = sourceRate();
  if (!monitorRate(src) || !monitorRate(rate)) return 0;
  const auto lookback = static_cast<uint32_t>(std::ceil(96.0 / (.94 * std::min(1.0, rate / src))));
  return voiceMonitorQueueFloor(src, rate, period, inputPeriod(), lookback, 128,
      kVoiceMonitorQuantum, captureAgeFrames_.load(std::memory_order_relaxed), outputLead);
}
zcore::routing::AudioReadResult VoiceMonitorSource::render(const AudioHostRenderBlock& b,
    float* mono, uint32_t capacity, uint32_t queueFrames, VoiceMonitorReader& reader, uint32_t preparedFloor) noexcept {
  const uint32_t writable = std::min(capacity, b.frames);
  if (mono) std::fill_n(mono, writable, 0.f);
  const auto floor = preparedFloor ? preparedFloor : queueFloor(b.sampleRate, b.frames, voiceMonitorPresentationLead(b));
  if (!queueFrames) queueFrames = floor;
  const double src = sourceRate();
  uint64_t queueNs = 0;
  if (monitorRate(src) && queueFrames <= kVoiceMonitorHistoryFrames / 2)
    queueNs = monitorFrameNs(queueFrames, src);
  if (!mono || !b.frames || b.frames > capacity || b.frames > b.maximumFrames ||
      b.frames > kAudioHostMaxFrames || !b.outputTimestampValid || !floor ||
      queueFrames < floor || !queueNs || b.outputHostTimeNs <= queueNs) {
    missingFrames_.fetch_add(b.frames, std::memory_order_relaxed);
    reader.clock.reset(); reader.cursor = {};
    return {b.frames, false};
  }
  const double rate = reader.clock.observe(b.outputFrame, b.outputHostTimeNs, b.frames,
                                          b.sampleRate, b.discontinuity != 0);
  if (!rate) {
    missingFrames_.fetch_add(b.frames, std::memory_order_relaxed);
    return {b.frames, false};
  }
  uint32_t missing = 0;
  bool online = false;
  for (uint32_t offset = 0; offset < b.frames; offset += kVoiceMonitorQuantum) {
    const uint32_t count = std::min(kVoiceMonitorQuantum, b.frames - offset);
    float* plane[]{mono + offset};
    const auto result = history_.readWithCoverage(b.outputHostTimeNs - queueNs + monitorFrameNs(offset, rate),
                                     rate, {plane, count}, count, reader.cursor, {});
    missing += result.online ? std::min(count, result.missingFrames) : count;
    online = online || result.online;
    for (uint32_t i = 0; i < count; ++i) {
      if (!std::isfinite(mono[offset + i])) mono[offset + i] = 0;
    }
  }
  missingFrames_.fetch_add(missing, std::memory_order_relaxed);
  return {missing, online};
}
VoiceMonitorSourceStats VoiceMonitorSource::stats() const noexcept {
  const auto history = history_.status();
  return {publishedBlocks_.load(std::memory_order_relaxed), publishedFrames_.load(std::memory_order_relaxed),
    droppedBlocks_.load(std::memory_order_relaxed), droppedFrames_.load(std::memory_order_relaxed),
    missingFrames_.load(std::memory_order_relaxed), estimated_.load(std::memory_order_relaxed), unknown_.load(std::memory_order_relaxed),
    history.phaseCorrections, history.correctedSamples, history.rejectedIntervals, history.discontinuities,
    captureAgeFrames_.load(std::memory_order_relaxed)};
}
bool VoiceMonitorCaptureTap::push(void* context, const float* input, uint32_t frames,
    uint64_t ns, uint64_t callbackNs, AudioInputTimestampQuality quality) noexcept {
  return pushWithPosition(context, input, frames, ns, callbackNs, quality, {});
}
bool VoiceMonitorCaptureTap::pushWithPosition(void* context, const float* input, uint32_t frames,
    uint64_t ns, uint64_t callbackNs, AudioInputTimestampQuality quality,
    AudioInputSourcePosition position) noexcept {
  if (!context) return false;
  auto& tap = *static_cast<VoiceMonitorCaptureTap*>(context);
  const bool delivered = tap.delivery.pushWithPosition(input, frames, ns, callbackNs, quality, position);
  if (tap.monitor) (void)tap.monitor->publish(input, frames, ns, quality, position, callbackNs);
  return delivered;
}
// SINGZ_MONITOR_SOURCE_RT_END

VoiceMonitorSource::VoiceMonitorSource()
    : history_(1, kVoiceMonitorHistoryFrames, zcore::routing::ResamplingFilter::LinearPhase,
               false, kVoiceMonitorPhaseConfig) {}
void VoiceMonitorSource::prepare(double rate, uint32_t period, uint32_t inputDeviceFrames) noexcept {
  history_.stop();
  rate_.store(rate, std::memory_order_relaxed);
  inputPeriod_.store(period, std::memory_order_relaxed);
  captureAgeFrames_.store(0, std::memory_order_relaxed);
  inputDeviceFrames_ = inputDeviceFrames;
  captureAgeWindow_.reset();
}
void VoiceMonitorSource::stop() noexcept { history_.stop(); }

namespace {
std::atomic<uint64_t> captureGeneration{1};
uint64_t captureDomain(const std::string& uid) {
  uint64_t value = 14695981039346656037ull;
  for (unsigned char byte : uid) { value ^= byte; value *= 1099511628211ull; }
  return value ? value : 1;
}
bool sameCapture(const AudioInputConfig& a, const AudioInputConfig& b) {
  return a.deviceUid == b.deviceUid && a.channel == b.channel && a.ringBlocks == b.ringBlocks &&
      a.requestedBufferFrames == b.requestedBufferFrames &&
      a.allowSharedDeviceBufferChange == b.allowSharedDeviceBufferChange &&
      a.maximumAcceptableBufferFrames == b.maximumAcceptableBufferFrames;
}
size_t userIndex(VoiceCaptureUser user) { return static_cast<size_t>(user); }
}
struct
#if defined(__GNUC__) || defined(__clang__)
__attribute__((visibility("hidden")))
#endif
VoiceMonitorCapture::Impl {
  explicit Impl(BackendFactory factory) : factory(factory) {}
  BackendFactory factory;
  mutable std::mutex control, backendControl, sinkControl, statusControl;
  std::array<uint32_t, 3> users{};
  AudioInputConfig config;
  std::vector<AudioInputDevice> inventory;
  AudioInputResult opened;
  AudioInputSink sink;
  std::unique_ptr<AudioInputBackend> backend;
  std::unique_ptr<AudioInputRing> ring;
  VoiceMonitorSource source;
  VoiceMonitorCaptureTap tap;
  std::thread delivery;
  std::atomic<bool> quit{false};
  std::atomic<AudioInputState> state{AudioInputState::Idle};
  std::atomic<uint64_t> deliveredBlocks{0}, deliveredFrames{0};
  std::string error;
  bool retained{};
  AudioInputStats finalStats{};
  uint64_t total() const { return static_cast<uint64_t>(users[0]) + users[1] + users[2]; }
  void fail(const std::string& message) {
    { std::lock_guard lock(statusControl); error = message; }
    state.store(AudioInputState::Error, std::memory_order_release);
    quit.store(true, std::memory_order_release);
  }
  void deliver() {
    for (;;) {
      if (quit.load(std::memory_order_acquire)) break;
      std::string failure;
      {
        std::lock_guard lock(backendControl);
        if (backend->takeFailure(failure)) fail(failure.empty() ? "audio input backend failed" : failure);
      }
      AudioInputBlockView block;
      while (!quit.load(std::memory_order_acquire) && ring->peek(block, opened.sampleRate)) {
        deliveredBlocks.fetch_add(1, std::memory_order_relaxed);
        deliveredFrames.fetch_add(block.frames, std::memory_order_relaxed);
        try {
          std::lock_guard lock(sinkControl);
          if (sink) sink(block);
        } catch (...) { fail("audio input sink threw an exception"); }
        ring->consume();
      }
      // No capture-side OS notification: this wait belongs to delivery only.
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    std::lock_guard lock(backendControl);
    // On a backend/sink failure stop immediately, without waiting for control.
    if (state.load(std::memory_order_acquire) == AudioInputState::Error) backend->stop();
  }
  void close(bool retainPrepared) {
    quit.store(true, std::memory_order_release);
    {
      std::lock_guard lock(backendControl);
      retained = backend && retainPrepared && backend->suspendPrepared();
      if (backend && !retained) backend->stop();
    }
    if (delivery.joinable()) delivery.join();
    source.stop();
    finalStats.deliveredBlocks = deliveredBlocks.load(std::memory_order_relaxed);
    finalStats.deliveredFrames = deliveredFrames.load(std::memory_order_relaxed);
    finalStats.overruns = ring ? ring->overruns() : 0;
    if (backend) {
      finalStats.bufferWarnings |= backend->bufferWarnings();
      finalStats.renderSliceDrops = backend->renderSliceDrops();
    }
    tap = {};
    ring.reset();
    if (!retained) backend.reset();
    if (state.load(std::memory_order_acquire) != AudioInputState::Error)
      state.store(AudioInputState::Stopped, std::memory_order_release);
  }
};
VoiceMonitorCapture::VoiceMonitorCapture(BackendFactory factory) : impl_(std::make_unique<Impl>(factory)) {}
VoiceMonitorCapture::~VoiceMonitorCapture() {
  std::lock_guard lock(impl_->control);
  impl_->close(false);
}
AudioInputResult VoiceMonitorCapture::retain(VoiceCaptureUser user, const AudioInputConfig& config,
    AudioInputSink sink, const std::vector<AudioInputDevice>* inventory) {
  auto& s = *impl_;
  std::lock_guard lock(s.control);
  const auto index = userIndex(user);
  if (index >= s.users.size() || s.users[index] == UINT32_MAX)
    return AudioInputResult::failure(AudioInputState::Error, "invalid capture user", config.channel);
  if (s.total()) {
    // Joining an active route must never renegotiate its buffer or restart a
    // take. Opening preferences apply only when the first user opens capture.
    if (config.deviceUid != s.config.deviceUid || config.channel != s.config.channel ||
        config.ringBlocks != s.config.ringBlocks ||
        s.state.load(std::memory_order_acquire) != AudioInputState::Running)
      return AudioInputResult::failure(AudioInputState::Error, "another capture route is retained", config.channel);
    auto result = s.opened;
    if (sink) { std::lock_guard sinkLock(s.sinkControl); s.sink = std::move(sink); }
    ++s.users[index];
    return result;
  }
  std::string validationError;
  const auto devices = inventory ? *inventory : enumerateAudioInputDevices(&validationError);
  if (!validateAudioInputConfig(config, devices, validationError))
    return AudioInputResult::failure(AudioInputState::Error, validationError, config.channel);
  s.inventory = devices;
  if (s.backend && (!s.retained || !sameCapture(config, s.config))) s.close(false);
  s.config = config;
  s.finalStats = {};
  s.deliveredBlocks.store(0, std::memory_order_relaxed);
  s.deliveredFrames.store(0, std::memory_order_relaxed);
  { std::lock_guard statusLock(s.statusControl); s.error.clear(); }
  auto generation = captureGeneration.fetch_add(1, std::memory_order_relaxed);
  if (!generation) generation = captureGeneration.fetch_add(1, std::memory_order_relaxed);
  s.ring = std::make_unique<AudioInputRing>(config.ringBlocks, kVoiceMonitorMaximumCaptureFrames,
                                          captureDomain(config.deviceUid), generation);
  s.tap = {s.ring->producer(), &s.source};
  s.sink = std::move(sink);
  s.state.store(AudioInputState::Starting, std::memory_order_release);
  if (!s.retained) {
    s.backend = s.factory ? s.factory() : nullptr;
    if (!s.backend) {
      s.close(false);
      s.state.store(AudioInputState::Unsupported, std::memory_order_release);
      return AudioInputResult::failure(AudioInputState::Unsupported, "capture backend unavailable", config.channel);
    }
    s.opened = s.backend->open(config, VoiceMonitorCaptureTap::push, &s.tap);
    s.backend->setPositionPush(VoiceMonitorCaptureTap::pushWithPosition);
  }
  s.retained = false;
  if (!s.opened.ok) { s.fail(s.opened.error); s.close(false); return s.opened; }
  // Without opening-period metadata the first capture block establishes a
  // conservative observed period. Takes keep the normal delivery timeline.
  s.source.prepare(s.opened.sampleRate, s.opened.inputBufferFrames, s.opened.inputLatencyFrames);
  s.quit.store(false, std::memory_order_release);
  auto started = s.backend->start();
  if (!started.ok) { s.fail(started.error); s.close(false); return started; }
  started.state = AudioInputState::Running;
  try {
    // Preserve the backend activation result, including fresh input-latency
    // validity/period telemetry, exactly as the original AudioInput owner did.
    s.opened = started;
    s.state.store(AudioInputState::Running, std::memory_order_release);
    s.delivery = std::thread([&s] { s.deliver(); });
  }
  catch (...) {
    s.fail("could not create audio input delivery thread"); s.close(false);
    return AudioInputResult::failure(AudioInputState::Error, lastError(), config.channel);
  }
  ++s.users[index];
  return started;
}
bool VoiceMonitorCapture::retainExisting(VoiceCaptureUser user) {
  std::lock_guard lock(impl_->control);
  const auto index = userIndex(user);
  if (index >= impl_->users.size() || impl_->users[index] == UINT32_MAX || !impl_->total() ||
      impl_->state.load(std::memory_order_acquire) != AudioInputState::Running) return false;
  ++impl_->users[index]; return true;
}
void VoiceMonitorCapture::release(VoiceCaptureUser user, bool retainPrepared) {
  std::lock_guard lock(impl_->control);
  const auto index = userIndex(user);
  if (index >= impl_->users.size() || !impl_->users[index]) return;
  --impl_->users[index];
  if (!impl_->total()) impl_->close(retainPrepared);
}
void VoiceMonitorCapture::releasePrepared() {
  std::lock_guard lock(impl_->control);
  if (!impl_->total()) impl_->close(false);
}
bool VoiceMonitorCapture::pauseForBufferChange() {
  std::lock_guard lock(impl_->control);
  if (impl_->users[userIndex(VoiceCaptureUser::Take)]) return false;
  impl_->close(false);
  return true;
}
AudioInputResult VoiceMonitorCapture::resumeAfterBufferChange(uint32_t frames) {
  std::array<uint32_t, 3> users;
  AudioInputConfig config;
  AudioInputSink sink;
  std::vector<AudioInputDevice> inventory;
  {
    std::lock_guard lock(impl_->control);
    if (!impl_->total()) return impl_->opened;
    users = impl_->users; config = impl_->config; inventory = impl_->inventory;
    { std::lock_guard sinkLock(impl_->sinkControl); sink = impl_->sink; }
    impl_->users = {};
  }
  config.requestedBufferFrames = frames;
  config.allowSharedDeviceBufferChange = true;
  config.maximumAcceptableBufferFrames = 0;
  const auto first = users[0] ? VoiceCaptureUser::Arm : VoiceCaptureUser::Monitor;
  AudioInputResult result;
  try { result = retain(first, config, std::move(sink), &inventory); }
  catch (...) {
    std::lock_guard lock(impl_->control);
    impl_->users = users;
    impl_->fail("could not resume audio input after buffer change");
    impl_->close(false);
    throw;
  }
  {
    std::lock_guard lock(impl_->control);
    // Preserve references even on failure so rollback can reopen the same
    // owners. The transaction keeps callbacks closed until this succeeds.
    impl_->users = users;
  }
  return result;
}
void VoiceMonitorCapture::setDeliverySink(AudioInputSink sink) {
  std::lock_guard lock(impl_->sinkControl); impl_->sink = std::move(sink);
}
void VoiceMonitorCapture::synchronizeDelivery(const std::function<void()>& action) {
  std::lock_guard lock(impl_->sinkControl);
  action();
}
uint32_t VoiceMonitorCapture::users(VoiceCaptureUser user) const {
  std::lock_guard lock(impl_->control);
  const auto index = userIndex(user);
  return index < impl_->users.size() ? impl_->users[index] : 0;
}
AudioInputState VoiceMonitorCapture::state() const noexcept { return impl_->state.load(std::memory_order_acquire); }
AudioInputResult VoiceMonitorCapture::openingResult() const {
  std::lock_guard lock(impl_->control);
  auto result = impl_->opened;
  result.deviceUid = impl_->config.deviceUid;
  return result;
}
AudioInputStats VoiceMonitorCapture::stats() const {
  std::lock_guard lock(impl_->control);
  auto result = impl_->finalStats;
  result.deliveredBlocks = impl_->deliveredBlocks.load(std::memory_order_relaxed);
  result.deliveredFrames = impl_->deliveredFrames.load(std::memory_order_relaxed);
  if (impl_->ring) result.overruns = impl_->ring->overruns();
  std::lock_guard backendLock(impl_->backendControl);
  if (impl_->backend) {
    result.bufferWarnings |= impl_->backend->bufferWarnings();
    result.renderSliceDrops = impl_->backend->renderSliceDrops();
  }
  return result;
}
std::string VoiceMonitorCapture::lastError() const {
  std::lock_guard lock(impl_->statusControl); return impl_->error;
}
VoiceMonitorSource& VoiceMonitorCapture::source() noexcept { return impl_->source; }
VoiceMonitorCapture& sharedVoiceMonitorCapture(VoiceMonitorCapture::BackendFactory factory) {
  // N-API cleanup releases users and prepared hardware. Client facades can
  // outlive function statics during exit, as with sharedAudioService().
  static VoiceMonitorCapture* capture = new VoiceMonitorCapture(factory);
  return *capture;
}
} // namespace singz

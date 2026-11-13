#include "voice_monitor_client.h"
#include <chrono>
#include <thread>

namespace singz {
namespace {
VoiceMonitorResult monitorFailure(const std::string& reason, const std::string& detail) {
  VoiceMonitorResult result;
  result.reason = reason;
  result.error = detail;
  return result;
}
bool virtualSameDevice(const AudioHostDeviceInfo& input, const AudioHostDeviceInfo& output) noexcept {
  return input.uid == output.uid && (input.transport == AudioHostTransport::Virtual || output.transport == AudioHostTransport::Virtual);
}
bool knownLoopback(const std::string& label) noexcept {
  // Inventory has a display label, not a driver/manufacturer/topology identity.
  // Recognize the documented BlackHole family only; renamed/custom drivers are
  // unclassified, never inferred from channel counts or opaque UID fragments.
  constexpr char prefix[] = "blackhole";
  if (label.size() < sizeof(prefix)-1) return false;
  for (size_t i=0; i<sizeof(prefix)-1; ++i) {
    const auto c=static_cast<unsigned char>(label[i]);
    if ((c >= 'A' && c <= 'Z' ? c + ('a'-'A') : c) != prefix[i]) return false;
  }
  return label.size()==sizeof(prefix)-1 || label[sizeof(prefix)-1]==' ';
}
bool feedbackRoute(const AudioHostDeviceInfo& input, const AudioHostDeviceInfo& output) noexcept {
  return virtualSameDevice(input, output) && (knownLoopback(input.label) || knownLoopback(output.label));
}
std::optional<float> monitorGainDb(const CommonVoiceMonitorRender& render) noexcept {
  const auto gain = render.target.load(std::memory_order_acquire);
  if (!std::isfinite(gain) || gain <= 0) return std::nullopt;
  return std::clamp(20.0f * std::log10(gain), kVoiceMonitorGainMinDb, kVoiceMonitorGainMaxDb);
}
std::vector<std::string> monitorWarnings(uint32_t flags) {
  std::vector<std::string> notes;
  if (flags & AudioBufferWarningExternalChange) notes.emplace_back("Audio buffer changed externally; saved size was not restored");
  if (flags & AudioBufferWarningRestoreFailed) notes.emplace_back("Audio buffer could not be restored");
  if (flags & AudioBufferWarningReadFailed) notes.emplace_back("Audio buffer metadata could not be read");
  return notes;
}
}
VoiceMonitorAvailability classifyCommonVoiceMonitorRoute(const AudioHostInventory& inventory,
    const std::string& uid, uint32_t channel, const std::string& output, bool permission) {
  VoiceMonitorAvailability result;
  auto refuse = [&](const char* reason, const char* detail) {
    result.reason = reason; result.detail = detail; return result;
  };
  const AudioHostDeviceInfo *input = nullptr, *sink = nullptr;
  for (const auto& device : inventory.devices) {
    if (device.uid == uid && device.inputChannels) input = &device;
    if (device.uid == output && device.outputChannels) sink = &device;
  }
  if (!input || channel >= input->inputChannels) return refuse("no-input", "Select an available microphone channel");
  if (!sink) return refuse("device-lost", "The common output is unavailable");
  for (const auto* device : {input, sink}) {
    switch (device->transport) {
      case AudioHostTransport::Bluetooth: case AudioHostTransport::BluetoothLowEnergy:
        return refuse("route-bluetooth", "Bluetooth monitoring is unavailable");
      case AudioHostTransport::AirPlay: case AudioHostTransport::ContinuityWireless:
        return refuse("route-wireless", "Wireless monitoring is unavailable");
      default: break; // Buffered history accepts built-in, wired, virtual and unknown routes.
    }
  }
  if (feedbackRoute(*input, *sink)) return refuse("route-feedback", "Monitoring this route would feed back into itself: choose a different input or output");
  if (!permission) return refuse("permission", "Microphone permission must already be granted");
  result.available = true; result.deviceUid = uid;
  result.minBufferFrames = input->bufferFrames.minimumFrames;
  result.maxBufferFrames = input->bufferFrames.maximumFrames;
  return result;
}
CommonVoiceMonitor::CommonVoiceMonitor(SharedAudioService& service, VoiceMonitorCapture& capture)
    : service_(service), capture_(capture) {}
CommonVoiceMonitor::~CommonVoiceMonitor() { close(); }
VoiceMonitorAvailability CommonVoiceMonitor::availability(const std::string& uid, uint32_t channel, bool permission) const {
  return classifyCommonVoiceMonitorRoute(service_.inventory(), uid, channel,
      service_.voiceMonitorOutputConfig().outputDeviceUid, permission);
}
VoiceMonitorResult CommonVoiceMonitor::begin(const std::string& uid, uint32_t channel,
    bool permission, float gainDb, uint64_t generation, uint32_t queueFrames) {
  if (!generation || !std::isfinite(gainDb) || queueFrames > kVoiceMonitorHistoryFrames / 2)
    return monitorFailure("error", "Invalid monitor configuration");
  const auto available = availability(uid, channel, permission);
  if (!available.available) return monitorFailure(available.reason, available.detail);
  close();
  // The common host follows the app route and its song-session period. Opening
  // input never upgrades/reopens it duplex and never changes the song period.
  const auto output = service_.ensureOutput();
  if (!output.ok) return monitorFailure("error", output.message);
  AudioInputConfig config; config.deviceUid = uid; config.channel = channel;
  if (service_.providerId() == "coreaudio") {
    const auto inventory = service_.inventory();
    for (const auto& device : inventory.devices) if (device.uid == uid) {
      config.requestedBufferFrames = chooseMonitorBufferFrames(device.bufferFrames, device.bufferFrames, 32, 256).value_or(0);
      break;
    }
    config.allowSharedDeviceBufferChange = true;
    config.maximumAcceptableBufferFrames = config.requestedBufferFrames ? 256 : 0;
    // A physical same-device buffer is also the song host's period. Adopt it
    // while a song session holds that device; history accepts a delayed route
    // instead of retuning a playing song. A cross-device input may negotiate.
    if (uid == service_.activeOutputUid() && service_.playbackOutputCurrent()) {
      config.requestedBufferFrames = 0;
      config.maximumAcceptableBufferFrames = 0;
    }
  }
  const auto devices = service_.inputDevices();
  const auto capture = capture_.retain(VoiceCaptureUser::Monitor, config, {}, &devices);
  if (!capture.ok) return monitorFailure("error", capture.error);
  retained_ = true; input_ = uid; generation_ = generation;
  channel_ = channel;
  route_ = service_.outputRouteGeneration(); lost_ = false; reason_.clear();
  render_.feedbackRisk.store(0, std::memory_order_relaxed);
  render_.owner = this;
  render_.source = &capture_.source(); render_.reader = {}; render_.queueFrames = queueFrames;
  render_.current = render_.destination = render_.step = 0; render_.remaining = 0;
  render_.period.store(0, std::memory_order_relaxed);
  render_.hostPeriod.store(service_.status().latency.bufferFrames, std::memory_order_release);
  render_.silent.store(1, std::memory_order_relaxed);
  render_.peak.store(0, std::memory_order_relaxed); render_.rms.store(0, std::memory_order_relaxed);
  setGain(gainDb);
  const auto floor = capture_.source().queueFloor(output.format.sampleRate, output.latency.bufferFrames);
  if ((queueFrames && floor && queueFrames < floor) ||
      (!floor && capture_.source().inputPeriod() && output.latency.bufferFrames)) {
    close(); return monitorFailure("route-latency", "Monitor queue is below the safe floor");
  }
  service_.setVoiceMonitorRenderer(CommonVoiceMonitorRender::render, &render_, admit);
  const auto admitted = availability(uid, channel, permission);
  if (!admitted.available) { close(); return monitorFailure(admitted.reason, admitted.detail); }
  auto notes = monitorWarnings(capture_.stats().bufferWarnings);
  if (render_.feedbackRisk.load(std::memory_order_acquire)) notes.insert(notes.begin(), "route-feedback-risk");
  return {true, {}, {}, latency(), std::move(notes), monitorGainDb(render_)};
}
bool CommonVoiceMonitor::setGain(float db) noexcept {
  if (!std::isfinite(db)) return false;
  db = std::clamp(db, kVoiceMonitorGainMinDb, kVoiceMonitorGainMaxDb);
  render_.target.store(std::pow(10.f, db / 20.f),
                       std::memory_order_release);
  return true;
}
VoiceMonitorLatency CommonVoiceMonitor::latency() {
  const auto host = service_.status();
  VoiceMonitorLatency result;
  result.sampleRate = host.format.sampleRate; result.requestedFrames = 32;
  result.bufferFrames = host.latency.bufferFrames;
  const auto input = capture_.openingResult();
  result.inputDeviceFrames = !input.inputLatencyStable || input.inputLatencyStable->load(std::memory_order_acquire)
      ? input.inputLatencyFrames : 0;
  result.inputBufferFrames = capture_.source().inputPeriod();
  result.inputSampleRate = capture_.source().sourceRate();
  result.outputDeviceFrames = host.latency.outputDeviceFrames;
  // The current host owns the period. Old-generation callback telemetry must
  // not keep a stale (larger or smaller) floor after a route/period change.
  const auto period = std::max(result.bufferFrames, host.observedCallbackFrames);
  render_.hostPeriod.store(period, std::memory_order_release);
  result.outputPeriodFrames = result.bufferFrames;
  result.observedOutputFrames = host.observedCallbackFrames;
  result.queueFloorFrames = capture_.source().queueFloor(result.sampleRate, period);
  result.queueFrames = std::max(render_.queueFrames, result.queueFloorFrames);
  const double sourceRate = capture_.source().sourceRate();
  result.roundTripMs = sourceRate > 0 && result.sampleRate > 0 ?
      1000.0 * ((double(result.queueFrames) + result.inputBufferFrames + result.inputDeviceFrames) / sourceRate +
          double(result.bufferFrames + result.outputDeviceFrames) / result.sampleRate) : 0;
  result.roundTripFrames = static_cast<uint64_t>(std::ceil(result.roundTripMs * result.sampleRate / 1000));
  bool uncertain = false;
  const auto output = service_.activeOutputUid();
  for (const auto& device : service_.inventory().devices)
    if ((device.uid == input_ || device.uid == output) && device.transport == AudioHostTransport::Unknown)
      uncertain = true;
  result.delayed = uncertain || result.roundTripMs > 10.0; // ADR G2 same-device budget, also applied cross-device.
  return result;
}
VoiceMonitorStatus CommonVoiceMonitor::status() {
  if (retained_) {
    const auto host = service_.status();
    const auto inventory = service_.inventory();
    const bool missing = std::none_of(inventory.devices.begin(), inventory.devices.end(),
        [&](const auto& d) { return d.uid == input_ && d.inputChannels; });
    if (missing || service_.voiceMonitorOutputLost() || host.state == AudioHostState::DeviceLost || capture_.state() == AudioInputState::Error) {
      close(); lost_ = true; reason_ = "device-lost";
    } else {
      const auto eligible = availability(input_, channel_, true);
      if (!eligible.available) refuse(eligible.reason);
      else if (!service_.hasVoiceMonitorRenderer(&render_)) refuse("error");
      else if (host.state == AudioHostState::Error) refuse("error");
      else if (host.state == AudioHostState::Stopped || host.state == AudioHostState::Closed) {
        if (!service_.ensureOutput().ok) refuse("error");
      }
      // A song/output reopen is a migration, never a new capture user.
      if (retained_) route_ = service_.outputRouteGeneration();
    }
  } else if (!service_.hasVoiceMonitorRenderer(&render_)) {
    // Reconcile a stranded Monitor reference even if the facade reads off.
    if (capture_.users(VoiceCaptureUser::Monitor)) reason_ = "error";
    while (capture_.users(VoiceCaptureUser::Monitor)) capture_.release(VoiceCaptureUser::Monitor);
  }

  VoiceMonitorStatus result;
  result.running = retained_; result.lost = lost_; result.reason = reason_;
  result.warnings = monitorWarnings(capture_.stats().bufferWarnings);
  if (render_.feedbackRisk.load(std::memory_order_acquire)) result.warnings.insert(result.warnings.begin(), "route-feedback-risk");
  if (retained_) result.gainDb = monitorGainDb(render_);
  const auto output = service_.activeOutputUid();
  for (const auto& device : service_.inventory().devices)
    if ((device.uid == input_ || device.uid == output) &&
        (device.transport == AudioHostTransport::Unknown || device.transport == AudioHostTransport::Virtual || device.transport == AudioHostTransport::Aggregate)) {
      result.warnings.emplace_back("Virtual or unclassified route: latency is estimated"); break;
    }
  if (retained_) {
    result.latency = latency();
    const auto period = std::max(result.latency.bufferFrames, service_.status().observedCallbackFrames);
    const auto floor = capture_.source().queueFloor(result.latency.sampleRate, period);
    if (!floor && capture_.source().inputPeriod() && period) {
      close(); reason_ = "route-latency";
      result.running = false; result.reason = reason_; result.latency = {};
    }
  }
  result.peak = render_.peak.load(std::memory_order_relaxed);
  result.rms = render_.rms.load(std::memory_order_relaxed);
  result.observedCallbackFrames = render_.period.load(std::memory_order_relaxed);
  return result;
}
VoiceMonitorResult CommonVoiceMonitor::end(uint64_t generation) {
  if (generation && generation_ && generation != generation_) return monitorFailure("error", "Stale monitor generation");
  if (retained_) {
    render_.target.store(0, std::memory_order_release);
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(kVoiceMonitorMuteWaitMs);
    while (!render_.silent.load(std::memory_order_acquire) && std::chrono::steady_clock::now() < deadline)
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  close(); generation_ = 0; return {true, {}, {}, {}, monitorWarnings(capture_.stats().bufferWarnings), std::nullopt};
}
bool CommonVoiceMonitor::admit(void* context, const AudioHostInventory& inventory, const AudioHostConfig& config, const AudioHostResult& result) noexcept {
  if (!context) return false;
  auto& self = *static_cast<CommonVoiceMonitorRender*>(context);
  if (!self.owner) return false; // Admission requires a live control owner.
  self.hostPeriod.store(result.latency.bufferFrames, std::memory_order_release);
  // The service has drained callbacks before admission: reset the callback-owned
  // envelope so every successful reopen fades in through the existing ramp.
  self.current = self.destination = self.step = 0; self.remaining = 0; // Re-admission ramp.
  const auto& owner = *static_cast<const CommonVoiceMonitor*>(self.owner);
  const AudioHostDeviceInfo* input = nullptr;
  for (const auto& device : inventory.devices) if (device.uid == owner.input_ && device.inputChannels) input = &device;
  // Check feedback before reopening the callback gate, not only on the next poll.
  for (const auto& device : inventory.devices) if (device.uid == config.outputDeviceUid && device.outputChannels) {
    const bool risk = input && virtualSameDevice(*input, device) && !feedbackRoute(*input, device);
    const auto previousRisk = self.feedbackRisk.exchange(risk ? 1u : 0u, std::memory_order_acq_rel);
    if (risk && !previousRisk) {
      // A newly entered unclassified virtual route starts below unity even if
      // the saved gain was hot. A deliberate later fader move remains allowed.
      auto gain = self.target.load(std::memory_order_acquire);
      while (gain > .01f && !self.target.compare_exchange_weak(gain, .01f,
          std::memory_order_acq_rel, std::memory_order_acquire)) {}
      // An end() target of zero, or a lower user gain, can never be raised here.
    }
    return input && !feedbackRoute(*input, device) && device.transport != AudioHostTransport::Bluetooth && device.transport != AudioHostTransport::BluetoothLowEnergy &&
        device.transport != AudioHostTransport::AirPlay && device.transport != AudioHostTransport::ContinuityWireless;
  }
  return false;
}
void CommonVoiceMonitor::close() noexcept {
  if (service_.hasVoiceMonitorRenderer(&render_)) service_.clearVoiceMonitorRenderer();
  retained_ = false;
  while (capture_.users(VoiceCaptureUser::Monitor)) capture_.release(VoiceCaptureUser::Monitor);
}
void CommonVoiceMonitor::refuse(const std::string& reason) { close(); lost_ = reason == "device-lost"; reason_ = reason; }
void CommonVoiceMonitor::routeChanged() { status(); }
}

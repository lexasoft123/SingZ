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
      case AudioHostTransport::Unknown: return refuse("platform", "The device transport is unknown");
      default: break;
    }
    if (device->monitoringSuitability == AudioHostMonitoringSuitability::HighLatency)
      return refuse("route-latency", "The route reports excessive monitoring latency");
    if (device->monitoringSuitability == AudioHostMonitoringSuitability::Unsupported)
      return refuse("platform", "The route does not support monitoring");
  }
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
    if (!config.requestedBufferFrames) return monitorFailure("route-latency", "Input cannot negotiate a monitor buffer");
    config.allowSharedDeviceBufferChange = true;
    config.maximumAcceptableBufferFrames = 256;
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
  inputLatencyFrames_ = capture.inputLatencyFrames;
  route_ = service_.outputRouteGeneration(); lost_ = false; reason_.clear();
  render_.source = &capture_.source(); render_.reader = {}; render_.queueFrames = queueFrames;
  render_.current = render_.destination = render_.step = 0; render_.remaining = 0;
  render_.period.store(output.latency.bufferFrames, std::memory_order_relaxed);
  render_.silent.store(1, std::memory_order_relaxed);
  render_.peak.store(0, std::memory_order_relaxed); render_.rms.store(0, std::memory_order_relaxed);
  setGain(gainDb);
  const auto floor = capture_.source().queueFloor(output.format.sampleRate, output.latency.bufferFrames);
  if ((queueFrames && floor && queueFrames < floor) ||
      (!floor && capture_.source().inputPeriod() && output.latency.bufferFrames)) {
    close(); return monitorFailure("route-latency", "Monitor queue is below the safe floor");
  }
  service_.setVoiceMonitorRenderer(CommonVoiceMonitorRender::render, &render_);
  return {true, {}, {}, latency(), monitorWarnings(capture_.stats().bufferWarnings)};
}
bool CommonVoiceMonitor::setGain(float db) noexcept {
  if (!std::isfinite(db)) return false;
  render_.target.store(std::pow(10.f, std::clamp(db, kVoiceMonitorGainMinDb, kVoiceMonitorGainMaxDb) / 20.f),
                       std::memory_order_release);
  return true;
}
VoiceMonitorLatency CommonVoiceMonitor::latency() const {
  const auto host = service_.status();
  VoiceMonitorLatency result;
  result.sampleRate = host.format.sampleRate; result.requestedFrames = 32;
  result.bufferFrames = host.latency.bufferFrames;
  result.inputDeviceFrames = inputLatencyFrames_;
  result.inputBufferFrames = capture_.source().inputPeriod();
  result.inputSampleRate = capture_.source().sourceRate();
  result.outputDeviceFrames = host.latency.outputDeviceFrames;
  const auto period = std::max(result.bufferFrames, render_.period.load(std::memory_order_relaxed));
  result.queueFrames = render_.queueFrames ? render_.queueFrames : capture_.source().queueFloor(result.sampleRate, period);
  const double sourceRate = capture_.source().sourceRate();
  result.roundTripMs = sourceRate > 0 && result.sampleRate > 0 ?
      1000.0 * ((double(result.queueFrames) + result.inputBufferFrames + result.inputDeviceFrames) / sourceRate +
          double(result.bufferFrames + result.outputDeviceFrames) / result.sampleRate) : 0;
  result.roundTripFrames = static_cast<uint64_t>(std::ceil(result.roundTripMs * result.sampleRate / 1000));
  result.delayed = result.roundTripMs > 10.0; // ADR G2 same-device budget, also applied cross-device.
  return result;
}
VoiceMonitorStatus CommonVoiceMonitor::status() {
  if (retained_) {
    const auto host = service_.status();
    const auto inventory = service_.inventory();
    const bool missing = std::none_of(inventory.devices.begin(), inventory.devices.end(),
        [&](const auto& d) { return d.uid == input_ && d.inputChannels; });
    if (missing || host.state == AudioHostState::DeviceLost || capture_.state() == AudioInputState::Error) {
      close(); lost_ = true; reason_ = "device-lost";
    } else if (service_.outputRouteGeneration() != route_ || host.state != AudioHostState::Running) {
      routeChanged();
    }
  }
  VoiceMonitorStatus result;
  result.running = retained_; result.lost = lost_; result.reason = reason_;
  result.warnings = monitorWarnings(capture_.stats().bufferWarnings);
  if (retained_) {
    result.latency = latency();
    const auto period = std::max(result.latency.bufferFrames, render_.period.load(std::memory_order_relaxed));
    const auto floor = capture_.source().queueFloor(result.latency.sampleRate, period);
    if ((render_.queueFrames && floor && render_.queueFrames < floor) ||
        (!floor && capture_.source().inputPeriod() && period)) {
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
  if (generation_ && generation != generation_) return monitorFailure("error", "Stale monitor generation");
  if (retained_) {
    render_.target.store(0, std::memory_order_release);
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(kVoiceMonitorMuteWaitMs);
    while (!render_.silent.load(std::memory_order_acquire) && std::chrono::steady_clock::now() < deadline)
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  close(); generation_ = 0; return {true, {}, {}, {}, monitorWarnings(capture_.stats().bufferWarnings)};
}
void CommonVoiceMonitor::close() noexcept {
  if (retained_) {
    service_.clearVoiceMonitorRenderer(); // Reader joins before capture's last release.
    capture_.release(VoiceCaptureUser::Monitor);
    retained_ = false;
  }
}
void CommonVoiceMonitor::routeChanged() { close(); lost_ = false; reason_ = "error"; }
}

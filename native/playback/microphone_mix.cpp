#include "microphone_mix.h"
#include <zcore/routing/audio_history.h>
#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <limits>
#include <set>

namespace singz {
namespace route = zcore::routing;
namespace {
bool validUid(const std::string& uid) {
  return !uid.empty() && uid.size() <= 4096 && uid.find('\0') == std::string::npos;
}
}
struct MicrophoneMixSession::Impl {
  Impl(SharedAudioService& output, InputFactory inputFactory, OutputFactory outputFactory)
      : service(output), factory(inputFactory), outputFactory(outputFactory) {}
  struct Source {
    route::AudioHistory history{1};
    std::unique_ptr<AudioInputBackend> backend;
    route::AudioReadCursor cursor{};
    double rate = 48000;
    uint64_t frames = 0;
    std::array<float, route::kBlock> samples{};
    std::atomic<uint64_t> rejected{0};
    static bool capture(void* context, const float* mono, uint32_t count,
                        uint64_t firstNs, uint64_t,
                        AudioInputTimestampQuality) noexcept {
      auto& self = *static_cast<Source*>(context);
      if (!mono || !count || count > kAudioHostMaxFrames || self.frames > UINT64_MAX - count) {
        self.rejected.fetch_add(1, std::memory_order_relaxed);
        return true;
      }
      // Provider blocks can be wider than the routing quantum. Publication is
      // bounded and preserves first-sample time for each chunk.
      for (uint32_t offset = 0; offset < count; offset += route::kBlock) {
        const auto frames = std::min(route::kBlock, count - offset);
        const float* plane = mono + offset;
        const auto timestamp = firstNs + static_cast<uint64_t>(offset * 1e9L / self.rate);
        const bool ok = self.history.append({{&plane, 1}, frames}, frames,
            timestamp, self.rate, static_cast<double>(self.frames + offset), true);
        if (!ok) self.rejected.fetch_add(1, std::memory_order_relaxed);
      }
      self.frames += count;
      return true;
    }
  };
  SharedAudioService& service;
  InputFactory factory;
  OutputFactory outputFactory;
  std::vector<std::unique_ptr<Source>> sources;
  std::unique_ptr<route::RoutingGraph> graph;
  std::unique_ptr<AudioHostBackend> relay;
  std::atomic<uint64_t> callbacks{0}, missing{0}, failures{0};
  std::atomic<bool> renderFailed{false};
  uint64_t outputGeneration = 0;
  std::string captureUid, lastError;
  double rate = 0;
  uint64_t delayNs = 0;
  bool active = false, attached = false, relayMode = false;
  std::array<std::array<float, route::kBlock>, 2> song{}, mixed{};
  static bool render(void* context, const AudioHostRenderBlock& block) noexcept {
    return static_cast<Impl*>(context)->mix(block);
  }
  static void silence(const AudioHostRenderBlock& block) noexcept {
    if (!block.output || block.frames > block.maximumFrames ||
        block.maximumFrames > kAudioHostMaxFrames) return;
    for (uint32_t channel = 0; channel < std::min(block.outputChannels, kAudioHostMaxChannels); ++channel)
      if (block.output[channel]) std::fill_n(block.output[channel], block.frames, 0);
  }
  bool mix(const AudioHostRenderBlock& block) noexcept {
    // Relay owns a different physical output: never copy the dry original
    // song into it. The hardware main capture already contains that song.
    if (relayMode) silence(block);
    if (renderFailed.load(std::memory_order_relaxed)) return !relayMode;
    if (!block.output || block.outputChannels != 2 || !block.output[0] ||
        !block.output[1] || !block.frames || block.frames > block.maximumFrames ||
        block.maximumFrames > kAudioHostMaxFrames || block.sampleRate != rate ||
        !block.callbackHostTimeNs ||
        (relayMode && service.outputRouteGeneration() != outputGeneration)) {
      failures.fetch_add(1, std::memory_order_relaxed);
      renderFailed.store(true, std::memory_order_release);
      return !relayMode; // Additive failure preserves backing playback.
    }
    std::array<route::RoutingInput, 9> inputs{};
    std::array<const float*, 2> songPlanes{song[0].data(), song[1].data()};
    std::array<const float*, 8> micPlanes{};
    std::array<float*, 2> output{mixed[0].data(), mixed[1].data()};
    const size_t firstMic = relayMode ? 0 : 1;
    if (!relayMode) inputs[0] = {{songPlanes.data(), 2}, route::kBlock};
    for (size_t index = 0; index < sources.size(); ++index) {
      micPlanes[index] = sources[index]->samples.data();
      inputs[index + firstMic] = {{&micPlanes[index], 1}, route::kBlock};
    }
    for (uint32_t offset = 0; offset < block.frames; offset += route::kBlock) {
      const auto count = std::min(route::kBlock, block.frames - offset);
      if (!relayMode)
        for (uint32_t channel = 0; channel < 2; ++channel)
          std::copy_n(block.output[channel] + offset, count, song[channel].data());
      const uint64_t now = block.callbackHostTimeNs +
          static_cast<uint64_t>(offset * 1e9L / rate);
      for (auto& source : sources) {
        float* destination = source->samples.data();
        if (now < delayNs) {
          std::fill_n(destination, count, 0);
          missing.fetch_add(count, std::memory_order_relaxed);
        } else {
          const auto read = source->history.read(now - delayNs, rate,
              {{&destination, 1}, route::kBlock}, count, source->cursor);
          missing.fetch_add(read.missingFrames, std::memory_order_relaxed);
        }
      }
      const bool ok = graph->render({inputs.data(), sources.size() + firstMic},
          {{output.data(), 2}, route::kBlock}, count, block.outputFrame + offset);
      if (!ok) {
        failures.fetch_add(1, std::memory_order_relaxed);
        if (relayMode) {
          silence(block);
          renderFailed.store(true, std::memory_order_release);
          return false;
        }
        continue;
      }
      for (uint32_t channel = 0; channel < 2; ++channel)
        std::copy_n(mixed[channel].data(), count, block.output[channel] + offset);
    }
    callbacks.fetch_add(1, std::memory_order_relaxed);
    return true;
  }
};
MicrophoneMixSession::MicrophoneMixSession(SharedAudioService& output,
    InputFactory inputFactory, OutputFactory outputFactory)
    : impl_(std::make_unique<Impl>(output, inputFactory, outputFactory)) {}
MicrophoneMixSession::~MicrophoneMixSession() { stop(); }
void MicrophoneMixSession::stop() noexcept {
  auto& self = *impl_;
  if (self.attached) {
    self.service.clearMicrophoneRenderer();
    self.attached = false;
  }
  // The physical relay callback must have retired before capture or graph
  // storage is reclaimed. Shared song playback remains running on its device.
  if (self.relay) self.relay->stop();
  self.relay.reset();
  for (auto& source : self.sources) {
    source->backend->stop();
    source->history.stop();
  }
  self.sources.clear();
  self.graph.reset();
  self.active = false;
}
MicrophoneMixResult MicrophoneMixSession::start(const MicrophoneMixConfig& config) {
  auto& self = *impl_;
#if !defined(__linux__) || defined(__ANDROID__)
  if (self.factory == createPlatformAudioInputBackend)
    return {false, "Cross-device microphone mixing is currently available on Linux ALSA only"};
#endif
  if (!validUid(config.deviceUid) || (!config.outputDeviceUid.empty() &&
      (!validUid(config.outputDeviceUid) || config.deviceUid == config.outputDeviceUid)) ||
      config.channels.empty() || config.channels.size() > 8 ||
      config.delayFrames < 256 || config.delayFrames > 8192)
    return {false, "Invalid microphone route or feedback between capture and relay output"};
  std::set<uint32_t> channels;
  for (const auto& channel : config.channels)
    if (channel.channel >= kAudioHostMaxChannels ||
        !channels.insert(channel.channel).second || !std::isfinite(channel.gain) ||
        channel.gain < 0 || channel.gain > 1 || !std::isfinite(channel.pan) ||
        channel.pan < -1 || channel.pan > 1)
      return {false, "Invalid or duplicate microphone channel, gain or pan"};
  if (self.service.providerId() != "alsa")
    return {false, "Select an ALSA output before starting microphone mixing"};
  const bool relayMode = !config.outputDeviceUid.empty();
  if (relayMode) {
    if (self.service.activeOutputUid() != config.deviceUid ||
        self.service.status().state != AudioHostState::Running)
      return {false, "Hardware mix relay requires active song output on the capture device"};
  } else {
    auto output = self.service.ensureOutput();
    if (!output.ok) return {false, output.message};
  }
  const auto host = self.service.status();
  if (host.format.outputChannels < 2 || (!relayMode && host.format.outputChannels != 2) || host.format.sampleRate != 48000)
    return {false, "The development microphone mix requires 48 kHz output with a stereo pair"};
  stop();
  self.rate = host.format.sampleRate;
  self.delayNs = static_cast<uint64_t>(config.delayFrames * 1e9L / self.rate);
  self.outputGeneration = self.service.outputRouteGeneration();
  self.captureUid = config.deviceUid;
  self.relayMode = relayMode;
  self.lastError.clear();
  self.callbacks.store(0); self.missing.store(0); self.failures.store(0);
  self.renderFailed.store(false);
  try {
    route::RoutingConfiguration graph;
    if (!relayMode)
      graph.sources.push_back({"song", 2, 1, true, false,
          route::defaultChannelConnections(2, 2)});
    for (const auto& channel : config.channels) {
      auto source = std::make_unique<Impl::Source>();
      source->backend = self.factory ? self.factory() : nullptr;
      if (!source->backend) { stop(); return {false, "Native capture is unavailable"}; }
      self.sources.push_back(std::move(source));
      auto& stored = *self.sources.back();
      auto result = stored.backend->open({config.deviceUid, channel.channel, 32},
          Impl::Source::capture, &stored);
      if (!result.ok) { stop(); return {false, result.error}; }
      if (!std::isfinite(result.sampleRate) || result.sampleRate < 8000 || result.sampleRate > 192000) {
        stop(); return {false, "Native capture returned an invalid sample rate"};
      }
      stored.rate = result.sampleRate;
      graph.sources.push_back({"mic-" + std::to_string(channel.channel), 1,
          channel.gain, true, channel.muted,
          {{0, 0, channel.pan > 0 ? 1 - channel.pan : 1},
           {0, 1, channel.pan < 0 ? 1 + channel.pan : 1}}});
    }
    self.graph = std::make_unique<route::RoutingGraph>(self.rate, graph);
    if (relayMode) {
      self.relay = self.outputFactory ? self.outputFactory() : nullptr;
      if (!self.relay) { stop(); return {false, "Native relay output is unavailable"}; }
      AudioHostConfig output;
      output.outputDeviceUid = config.outputDeviceUid;
      output.outputChannels = {0, 1};
      output.requestedSampleRate = self.rate;
      output.requestedBufferFrames = 1024;
      auto result = self.relay->open(output, Impl::render, &self);
      if (!result.ok) { stop(); return {false, result.message}; }
      if (result.format.sampleRate != self.rate || result.format.outputChannels != 2) {
        stop(); return {false, "Relay output did not negotiate stereo 48 kHz"};
      }
    }
    for (auto& source : self.sources) {
      auto result = source->backend->start();
      if (!result.ok) { stop(); return {false, result.error}; }
    }
    if (relayMode) {
      auto result = self.relay->start();
      if (!result.ok) { stop(); return {false, result.message}; }
    } else {
      self.service.setMicrophoneRenderer(Impl::render, &self);
      self.attached = true;
    }
    self.active = true;
    return {true, {}};
  } catch (...) { stop(); throw; }
}
MicrophoneMixStatus MicrophoneMixSession::status() {
  auto& self = *impl_;
  if (self.active) {
    std::string error;
    if (self.renderFailed.load(std::memory_order_acquire))
      error = "The microphone output render route failed or changed";
    if (error.empty() && self.relayMode &&
        (self.service.activeOutputUid() != self.captureUid ||
         self.service.status().state != AudioHostState::Running))
      error = "The hardware mixer song output changed or stopped";
    if (error.empty() && self.relay) {
      const auto state = self.relay->status().state;
      if (state != AudioHostState::Running)
        error = "The HDMI relay output stopped or failed";
    }
    for (const auto& source : self.sources) {
      std::string captureError;
      if (source->backend->takeFailure(captureError)) {
        error = captureError.empty() ? "Native capture failed" : captureError;
        break;
      }
      if (source->rejected.load(std::memory_order_relaxed)) {
        error = "Native capture returned invalid timestamped audio";
        break;
      }
    }
    if (!error.empty()) {
      self.failures.fetch_add(1);
      self.lastError = std::move(error);
      stop();
    }
  }
  return {self.active, self.callbacks.load(), self.missing.load(),
          self.failures.load(), self.rate, self.lastError};
}
} // namespace singz

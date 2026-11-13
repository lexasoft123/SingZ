#include "microphone_mix.h"
#include <zcore/routing/audio_history.h>
#include <zcore/routing/audio_resampler.h>
#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <limits>
#include <set>
#if defined(__linux__)
#include <time.h>
#endif

namespace singz {
namespace route = zcore::routing;
namespace {
bool validUid(const std::string& uid) {
  return !uid.empty() && uid.size() <= 4096 && uid.find('\0') == std::string::npos;
}
uint64_t renderWallNs() noexcept {
  return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(
      std::chrono::steady_clock::now().time_since_epoch()).count());
}
bool renderThreadCpuNs(uint64_t& value) noexcept {
#if defined(__linux__)
  timespec time{};
  if (clock_gettime(CLOCK_THREAD_CPUTIME_ID, &time) != 0) return false;
  value = static_cast<uint64_t>(time.tv_sec) * 1000000000ULL +
          static_cast<uint64_t>(time.tv_nsec);
  return true;
#else
  (void)value;
  return false;
#endif
}
void updateMaximum(std::atomic<uint64_t>& counter, uint64_t value) noexcept {
  if (value > counter.load(std::memory_order_relaxed))
    counter.store(value, std::memory_order_relaxed);
}
}
struct MicrophoneMixSession::Impl {
  Impl(SharedAudioService& output, InputFactory inputFactory, OutputFactory outputFactory)
      : service(output), factory(inputFactory), outputFactory(outputFactory) {}
  struct Source {
    route::AudioHistory history{1, route::AudioHistory::kDefaultCapacityFrames,
                                route::ResamplingFilter::LinearPhase, true};
    uint32_t channel = 0;
    std::unique_ptr<AudioInputBackend> backend;
    route::AudioReadCursor cursor{};
    double rate = 48000;
    uint64_t frames = 0;
    bool timelineGap = false;
    std::array<float, route::kBlock> samples{};
    std::atomic<uint64_t> rejected{0}, unanchoredBlocks{0}, unanchoredFrames{0};
    static bool capture(void* context, const float* mono, uint32_t count,
                        uint64_t firstNs, uint64_t,
                        AudioInputTimestampQuality quality) noexcept {
      auto& self = *static_cast<Source*>(context);
      if (!mono || !count || count > kAudioHostMaxFrames ||
          (quality != AudioInputTimestampQuality::Unknown && !firstNs)) {
        self.rejected.fetch_add(1, std::memory_order_relaxed);
        return true;
      }
      // Unknown PCM has no trustworthy timeline, even when a timestamp was
      // supplied. Drop it without advancing source time; the next anchored
      // block starts a new epoch instead of bridging unknown loss.
      if (quality == AudioInputTimestampQuality::Unknown) {
        self.unanchoredBlocks.fetch_add(1, std::memory_order_relaxed);
        self.unanchoredFrames.fetch_add(count, std::memory_order_relaxed);
        self.timelineGap = true;
        return true;
      }
      if (self.timelineGap) {
        self.frames = 0;
        self.timelineGap = false;
      }
      if (self.frames > UINT64_MAX - count) {
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
  struct StereoSource {
    route::AudioHistory history{2, route::AudioHistory::kDefaultCapacityFrames,
                                route::ResamplingFilter::LinearPhase, true};
    std::array<uint32_t, 2> channel{};
    std::unique_ptr<AudioInputBackend> backend;
    route::AudioReadCursor cursor{};
    double rate = 48000;
    uint64_t frames = 0;
    bool timelineGap = false;
    std::array<std::array<float, route::kBlock>, 2> samples{};
    std::atomic<uint64_t> rejected{0}, unanchoredBlocks{0}, unanchoredFrames{0};
    static bool capture(void* context, const AudioInputBusBlock& block) noexcept {
      auto& self = *static_cast<StereoSource*>(context);
      if (!block.planes || block.channelCount != 2 || !block.frames ||
          block.frames > block.capacityFrames || block.frames > kAudioHostMaxFrames ||
          !block.planes[0] || !block.planes[1] ||
          (block.quality != AudioInputTimestampQuality::Unknown && !block.firstNs)) {
        self.rejected.fetch_add(1, std::memory_order_relaxed);
        return true;
      }
      if (block.quality == AudioInputTimestampQuality::Unknown) {
        self.unanchoredBlocks.fetch_add(1, std::memory_order_relaxed);
        self.unanchoredFrames.fetch_add(block.frames, std::memory_order_relaxed);
        self.timelineGap = true;
        return true;
      }
      if (self.timelineGap) {
        self.frames = 0;
        self.timelineGap = false;
      }
      if (self.frames > UINT64_MAX - block.frames) {
        self.rejected.fetch_add(1, std::memory_order_relaxed);
        return true;
      }
      for (uint32_t offset = 0; offset < block.frames; offset += route::kBlock) {
        const auto frames = std::min(route::kBlock, block.frames - offset);
        const float* planes[]{block.planes[0] + offset, block.planes[1] + offset};
        const auto timestamp = block.firstNs + static_cast<uint64_t>(offset * 1e9L / self.rate);
        const bool ok = self.history.append({{planes, 2}, frames}, frames,
            timestamp, self.rate, static_cast<double>(self.frames + offset), true);
        if (!ok) self.rejected.fetch_add(1, std::memory_order_relaxed);
      }
      self.frames += block.frames;
      return true;
    }
  };
  SharedAudioService& service;
  InputFactory factory;
  OutputFactory outputFactory;
  std::vector<std::unique_ptr<Source>> sources;
  std::unique_ptr<StereoSource> stereo;
  std::unique_ptr<route::RoutingGraph> graph;
  std::unique_ptr<AudioHostBackend> relay;
  std::atomic<uint64_t> callbacks{0}, missing{0}, failures{0};
  std::atomic<uint64_t> outputTimestampUnavailableBlocks{0};
  std::atomic<uint64_t> relayRenderCalls{0}, relayRenderTotalWallNs{0}, relayRenderMaxWallNs{0};
  std::atomic<uint64_t> relayRenderTotalCpuNs{0}, relayRenderMaxCpuNs{0};
  std::atomic<uint64_t> relayRenderBudgetOverruns{0};
  std::atomic<bool> renderFailed{false}, relayRenderCpuClockFailed{false};
  uint64_t outputGeneration = 0;
  std::string captureUid, lastError;
  double rate = 0;
  uint64_t delayNs = 0, presentationDelayNs = 0;
  uint32_t captureSafetyFrames = 0, outputPeriodFrames = 0, outputBufferFrames = 0;
  uint32_t presentationDelayFrames = 0;
  uint64_t outputXruns = 0;
  bool active = false, attached = false, relayMode = false, measureRenderTiming = false;
  std::array<std::array<float, route::kBlock>, 2> song{}, mixed{};
  static bool render(void* context, const AudioHostRenderBlock& block) noexcept {
    auto& self = *static_cast<Impl*>(context);
    if (!self.relayMode || !self.measureRenderTiming) return self.mix(block);
    const auto wallBegin = renderWallNs();
    uint64_t cpuBegin = 0, cpuEnd = 0;
    const bool cpuBeginValid = !self.relayRenderCpuClockFailed.load(std::memory_order_relaxed) &&
                               renderThreadCpuNs(cpuBegin);
    const bool result = self.mix(block);
    const bool cpuEndValid = cpuBeginValid && renderThreadCpuNs(cpuEnd);
    const auto wallEnd = renderWallNs();
    const bool cpuValid = cpuEndValid && cpuEnd >= cpuBegin;
    if (!cpuValid) self.relayRenderCpuClockFailed.store(true, std::memory_order_relaxed);
    const auto wallNs = wallEnd >= wallBegin ? wallEnd - wallBegin : 0;
    self.relayRenderCalls.fetch_add(1, std::memory_order_relaxed);
    self.relayRenderTotalWallNs.fetch_add(wallNs, std::memory_order_relaxed);
    updateMaximum(self.relayRenderMaxWallNs, wallNs);
    if (cpuValid) {
      const auto cpuNs = cpuEnd - cpuBegin;
      self.relayRenderTotalCpuNs.fetch_add(cpuNs, std::memory_order_relaxed);
      updateMaximum(self.relayRenderMaxCpuNs, cpuNs);
    }
    if (block.frames && std::isfinite(block.sampleRate) && block.sampleRate > 0 &&
        static_cast<long double>(wallNs) >
            static_cast<long double>(block.frames) * 1e9L / block.sampleRate)
      self.relayRenderBudgetOverruns.fetch_add(1, std::memory_order_relaxed);
    return result;
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
        (!relayMode && !block.callbackHostTimeNs) ||
        (relayMode && service.outputRouteGeneration() != outputGeneration)) {
      failures.fetch_add(1, std::memory_order_relaxed);
      renderFailed.store(true, std::memory_order_release);
      return !relayMode; // Additive failure preserves backing playback.
    }
    if (relayMode) {
      const auto finalOffsetNs =
          static_cast<uint64_t>((block.frames - 1) * 1e9L / rate);
      if (!block.outputTimestampValid || !block.outputHostTimeNs ||
          block.outputHostTimeNs > UINT64_MAX - finalOffsetNs) {
        // Output timing can recover. Never substitute callback arrival time.
        outputTimestampUnavailableBlocks.fetch_add(1, std::memory_order_relaxed);
        return true;
      }
    }
    const uint64_t firstHostNs = relayMode ? block.outputHostTimeNs : block.callbackHostTimeNs;
    const uint64_t readDelayNs = relayMode ? presentationDelayNs : delayNs;
    std::array<route::RoutingInput, 9> inputs{};
    std::array<const float*, 2> songPlanes{song[0].data(), song[1].data()};
    std::array<const float*, 8> micPlanes{};
    std::array<float*, 2> output{mixed[0].data(), mixed[1].data()};
    const size_t firstMic = relayMode ? 0 : 1;
    if (!relayMode) inputs[0] = {{songPlanes.data(), 2}, route::kBlock};
    if (stereo) {
      for (size_t index = 0; index < 2; ++index) {
        micPlanes[index] = stereo->samples[index].data();
        inputs[index + firstMic] = {{&micPlanes[index], 1}, route::kBlock};
      }
    } else {
      for (size_t index = 0; index < sources.size(); ++index) {
        micPlanes[index] = sources[index]->samples.data();
        inputs[index + firstMic] = {{&micPlanes[index], 1}, route::kBlock};
      }
    }
    for (uint32_t offset = 0; offset < block.frames; offset += route::kBlock) {
      const auto count = std::min(route::kBlock, block.frames - offset);
      if (!relayMode)
        for (uint32_t channel = 0; channel < 2; ++channel)
          std::copy_n(block.output[channel] + offset, count, song[channel].data());
      const uint64_t now = firstHostNs + static_cast<uint64_t>(offset * 1e9L / rate);
      if (stereo) {
        float* destinations[]{stereo->samples[0].data(), stereo->samples[1].data()};
        if (now < readDelayNs) {
          for (auto* destination : destinations) std::fill_n(destination, count, 0);
          missing.fetch_add(2 * count, std::memory_order_relaxed);
        } else {
          const auto read = stereo->history.read(now - readDelayNs, rate,
              {{destinations, 2}, route::kBlock}, count, stereo->cursor);
          missing.fetch_add(2 * read.missingFrames, std::memory_order_relaxed);
        }
      } else {
        for (auto& source : sources) {
          float* destination = source->samples.data();
          if (now < readDelayNs) {
            std::fill_n(destination, count, 0);
            missing.fetch_add(count, std::memory_order_relaxed);
          } else {
            const auto read = source->history.read(now - readDelayNs, rate,
                {{&destination, 1}, route::kBlock}, count, source->cursor);
            missing.fetch_add(read.missingFrames, std::memory_order_relaxed);
          }
        }
      }
      const bool ok = graph->render({inputs.data(), (stereo ? 2 : sources.size()) + firstMic},
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
  if (self.relay) {
    self.relay->stop();
    self.outputXruns = self.relay->status().xruns;
  }
  self.relay.reset();
  for (auto& source : self.sources) {
    source->backend->stop();
    source->history.stop();
  }
  self.sources.clear();
  if (self.stereo) {
    self.stereo->backend->stop();
    self.stereo->history.stop();
    self.stereo.reset();
  }
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
  if (config.requestedOutputPeriodFrames != 256 && config.requestedOutputPeriodFrames != 512 &&
      config.requestedOutputPeriodFrames != 1024)
    return {false, "Requested relay output period must be 256, 512 or 1024 frames"};
  if (config.measureRenderTiming && config.outputDeviceUid.empty())
    return {false, "Render timing measurement requires a relay output"};
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
  self.presentationDelayNs = 0;
  self.captureSafetyFrames = config.delayFrames;
  self.outputPeriodFrames = self.outputBufferFrames = self.presentationDelayFrames = 0;
  self.outputXruns = 0;
  self.outputTimestampUnavailableBlocks.store(0);
  self.relayRenderCalls.store(0);
  self.relayRenderTotalWallNs.store(0);
  self.relayRenderMaxWallNs.store(0);
  self.relayRenderTotalCpuNs.store(0);
  self.relayRenderMaxCpuNs.store(0);
  self.relayRenderBudgetOverruns.store(0);
  self.relayRenderCpuClockFailed.store(false);
  self.measureRenderTiming = relayMode && config.measureRenderTiming;
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
    auto appendGraphSource = [&](const MicrophoneMixChannel& channel) {
      graph.sources.push_back({"mic-" + std::to_string(channel.channel), 1,
          channel.gain, true, channel.muted,
          {{0, 0, channel.pan > 0 ? 1 - channel.pan : 1},
           {0, 1, channel.pan < 0 ? 1 + channel.pan : 1}}});
    };
    if (config.channels.size() == 2) {
      auto candidate = std::make_unique<Impl::StereoSource>();
      auto backend = self.factory ? self.factory() : nullptr;
      if (!backend) { stop(); return {false, "Native capture is unavailable"}; }
      AudioInputBusConfig bus{config.deviceUid,
          {config.channels[0].channel, config.channels[1].channel}};
      auto opened = backend->openBus(bus, Impl::StereoSource::capture, candidate.get());
      if (opened.status == AudioInputBusOpenStatus::Error ||
          (opened.status == AudioInputBusOpenStatus::Ready && !opened.result.ok)) {
        backend->stop();
        stop(); return {false, opened.result.error};
      }
      if (opened.status == AudioInputBusOpenStatus::Ready) {
        if (!std::isfinite(opened.result.sampleRate) || opened.result.sampleRate < 8000 ||
            opened.result.sampleRate > 192000) {
          backend->stop();
          stop(); return {false, "Native capture returned an invalid sample rate"};
        }
        candidate->backend = std::move(backend);
        candidate->rate = opened.result.sampleRate;
        candidate->channel = {config.channels[0].channel, config.channels[1].channel};
        self.stereo = std::move(candidate);
        appendGraphSource(config.channels[0]);
        appendGraphSource(config.channels[1]);
      }
    }
    if (!self.stereo) {
      for (const auto& channel : config.channels) {
        auto source = std::make_unique<Impl::Source>();
        source->channel = channel.channel;
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
        appendGraphSource(channel);
      }
    }
    self.graph = std::make_unique<route::RoutingGraph>(self.rate, graph);
    if (relayMode) {
      self.relay = self.outputFactory ? self.outputFactory() : nullptr;
      if (!self.relay) { stop(); return {false, "Native relay output is unavailable"}; }
      AudioHostConfig output;
      output.outputDeviceUid = config.outputDeviceUid;
      output.outputChannels = {0, 1};
      output.requestedSampleRate = self.rate;
      output.requestedBufferFrames = config.requestedOutputPeriodFrames;
      auto result = self.relay->open(output, Impl::render, &self);
      if (!result.ok) { stop(); return {false, result.message}; }
      if (result.format.sampleRate != self.rate || result.format.outputChannels != 2) {
        stop(); return {false, "Relay output did not negotiate stereo 48 kHz"};
      }
      const auto negotiated = self.relay->status();
      const auto period = negotiated.diagnostics.outputPeriodFrames;
      const auto buffer = negotiated.diagnostics.outputBufferFrames;
      if (!period || period > kAudioHostMaxFrames || !buffer || buffer < period) {
        stop(); return {false, "Relay output did not report valid period and buffer bounds"};
      }
      const auto presentationDelay = static_cast<uint64_t>(buffer) + config.delayFrames;
      if (presentationDelay > route::AudioHistory::kDefaultCapacityFrames) {
        stop(); return {false, "Relay presentation delay exceeds capture history capacity"};
      }
      self.outputPeriodFrames = period;
      self.outputBufferFrames = buffer;
      self.presentationDelayFrames = static_cast<uint32_t>(presentationDelay);
      self.presentationDelayNs = static_cast<uint64_t>(presentationDelay * 1e9L / self.rate);
      self.outputXruns = negotiated.xruns;
    }
    for (auto& source : self.sources) {
      auto result = source->backend->start();
      if (!result.ok) { stop(); return {false, result.error}; }
    }
    if (self.stereo) {
      auto result = self.stereo->backend->start();
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
  if (self.relay) self.outputXruns = self.relay->status().xruns;
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
    if (error.empty() && self.stereo) {
      std::string captureError;
      if (self.stereo->backend->takeFailure(captureError))
        error = captureError.empty() ? "Native capture failed" : captureError;
      else if (self.stereo->rejected.load(std::memory_order_relaxed))
        error = "Native capture returned invalid timestamped audio";
    }
    if (!error.empty()) {
      self.failures.fetch_add(1);
      self.lastError = std::move(error);
      stop();
    }
  }
  MicrophoneMixStatus result;
  result.active = self.active;
  result.callbacks = self.callbacks.load();
  result.missingFrames = self.missing.load();
  result.failures = self.failures.load();
  result.sampleRate = self.rate;
  result.error = self.lastError;
  result.captureSafetyFrames = self.captureSafetyFrames;
  result.outputPeriodFrames = self.outputPeriodFrames;
  result.outputBufferFrames = self.outputBufferFrames;
  result.presentationDelayFrames = self.presentationDelayFrames;
  result.outputXruns = self.outputXruns;
  result.outputTimestampUnavailableBlocks = self.outputTimestampUnavailableBlocks.load();
  result.relayRenderCalls = self.relayRenderCalls.load();
  result.relayRenderTotalWallNs = self.relayRenderTotalWallNs.load();
  result.relayRenderMaxWallNs = self.relayRenderMaxWallNs.load();
  result.relayRenderTotalCpuNs = self.relayRenderTotalCpuNs.load();
  result.relayRenderMaxCpuNs = self.relayRenderMaxCpuNs.load();
  result.relayRenderBudgetOverruns = self.relayRenderBudgetOverruns.load();
  result.relayRenderCpuTimingAvailable = self.measureRenderTiming && result.relayRenderCalls != 0 &&
                                         !self.relayRenderCpuClockFailed.load();
  result.relayRenderTimingEnabled = self.measureRenderTiming;
  result.diagnostics.reserve(self.sources.size() + (self.stereo ? 2 : 0));
  auto appendDiagnostics = [&](uint32_t channel, const route::AudioHistory& historySource,
                               uint64_t unanchoredBlocks, uint64_t unanchoredFrames) {
    const auto history = historySource.status();
    const auto reads = historySource.readDiagnostics();
    auto& row = result.diagnostics.emplace_back();
    row.channel = channel;
    row.historyOnline = history.online;
    row.historyCallbacks = history.callbacks;
    row.historyDiscontinuities = history.discontinuities;
    row.unanchoredBlocks = unanchoredBlocks;
    row.unanchoredFrames = unanchoredFrames;
    row.measuredRate = history.measuredRate;
    row.lastHostNs = history.lastHostNs;
    row.publishedEndHostNs = historySource.publishedBlockEndHostNs();
    row.missingFramesByReason.invalidRequest = reads.missingFrames[
        static_cast<size_t>(route::AudioHistoryMissingReason::InvalidRequest)];
    row.missingFramesByReason.offline = reads.missingFrames[
        static_cast<size_t>(route::AudioHistoryMissingReason::Offline)];
    row.missingFramesByReason.anchorUnavailable = reads.missingFrames[
        static_cast<size_t>(route::AudioHistoryMissingReason::AnchorUnavailable)];
    row.missingFramesByReason.clockMapping = reads.missingFrames[
        static_cast<size_t>(route::AudioHistoryMissingReason::ClockMapping)];
    row.missingFramesByReason.resamplingSupport = reads.missingFrames[
        static_cast<size_t>(route::AudioHistoryMissingReason::ResamplingSupport)];
    row.missingFramesByReason.generationChanged = reads.missingFrames[
        static_cast<size_t>(route::AudioHistoryMissingReason::GenerationChanged)];
    row.unpublishedSampleReads = reads.unpublishedSampleReads;
    row.expiredSampleReads = reads.expiredSampleReads;
    row.racingSampleReads = reads.racingSampleReads;
    row.absentSampleReads = reads.absentSampleReads;
    row.verifiedClockSteps = reads.verifiedClockSteps;
    row.maximumVerifiedClockStepNs = reads.maximumVerifiedClockStepNs;
  };
  for (const auto& source : self.sources)
    appendDiagnostics(source->channel, source->history,
        source->unanchoredBlocks.load(std::memory_order_relaxed),
        source->unanchoredFrames.load(std::memory_order_relaxed));
  if (self.stereo)
    for (const auto channel : self.stereo->channel)
      appendDiagnostics(channel, self.stereo->history,
          self.stereo->unanchoredBlocks.load(std::memory_order_relaxed),
          self.stereo->unanchoredFrames.load(std::memory_order_relaxed));
  return result;
}
} // namespace singz

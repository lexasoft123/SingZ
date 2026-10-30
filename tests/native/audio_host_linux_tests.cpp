#include "zcore/platform/linux/alsa_pcm.h"
#include <zcore/device/audio_input.h>
#include <zcore/device/audio_input_backend.h>

#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <thread>
#include <type_traits>

#define CHECK(value) do { if (!(value)) { \
  std::fprintf(stderr, "CHECK %s:%d: %s\n", __FILE__, __LINE__, #value); \
  std::abort(); } } while (false)
using namespace singz;
using namespace std::chrono_literals;
namespace {
static_assert(!std::is_copy_constructible_v<detail::AlsaCaptureLease>);
template <class Predicate> bool until(Predicate predicate, uint32_t milliseconds = 2000) {
  const auto deadline = std::chrono::steady_clock::now() +
      std::chrono::milliseconds(milliseconds);
  while (!predicate() && std::chrono::steady_clock::now() < deadline)
    std::this_thread::sleep_for(2ms);
  return predicate();
}
struct Render {
  std::atomic<uint32_t> calls{0}, signalBlocks{0};
  std::atomic<bool> invalid{false};
  bool reject{false};
  static bool run(void* context, const AudioHostRenderBlock& block) noexcept {
    auto& self = *static_cast<Render*>(context);
    if (!block.output || block.outputChannels != 2 || !block.frames ||
        block.frames > block.maximumFrames || block.sampleRate != 48000)
      self.invalid.store(true);
    for (uint32_t frame = 0; frame < block.frames; ++frame) {
      block.output[0][frame] = 0.125f;
      block.output[1][frame] = -0.375f;
    }
    if (block.inputChannels == 2) {
      if (block.inputTimestampHardware) self.invalid.store(true);
      if (std::abs(block.input[0][0] - 0.25f) < .002f &&
          std::abs(block.input[1][0] + 0.125f) < .002f)
        self.signalBlocks.fetch_add(1);
    }
    self.calls.fetch_add(1);
    return !self.reject;
  }
};
AudioHostConfig config(const std::string& output = "test-output") {
  AudioHostConfig result;
  result.outputDeviceUid = output; result.outputChannels = {0, 1};
  result.requestedSampleRate = 48000; result.requestedBufferFrames = 256;
  result.maximumFrames = 1024;
  return result;
}
void conversion() {
  for (auto format : {SND_PCM_FORMAT_FLOAT_LE, SND_PCM_FORMAT_S32_LE,
       SND_PCM_FORMAT_S24_3LE, SND_PCM_FORMAT_S24_LE, SND_PCM_FORMAT_S16_LE}) {
    const std::array<float, 7> source{-1, -.5f, 0, .25f, 1,
        std::numeric_limits<float>::quiet_NaN(), std::numeric_limits<float>::infinity()};
    std::array<unsigned char, 28> bytes{};
    std::array<float, 7> decoded{};
    CHECK(detail::alsaEncode(source.data(), bytes.data(), source.size(), format) == 2);
    detail::alsaDecode(bytes.data(), decoded.data(), decoded.size(), format);
    for (size_t i = 0; i < 5; ++i) CHECK(std::abs(source[i] - decoded[i]) < .00004f);
    CHECK(decoded[5] == 0 && decoded[6] == 0);
  }
  // Independent byte fixtures catch shared mistakes in encode and decode.
  const unsigned char packed[]{0, 0, 0x80, 0xff, 0xff, 0x7f};
  float decoded[2]{};
  detail::alsaDecode(packed, decoded, 2, SND_PCM_FORMAT_S24_3LE);
  CHECK(decoded[0] == -1 && decoded[1] > .9999f);
  const unsigned char padded[]{0, 0, 0x40, 0xff};
  detail::alsaDecode(padded, decoded, 1, SND_PCM_FORMAT_S24_LE);
  CHECK(decoded[0] == .5f);
  const float nonFinite[]{std::numeric_limits<float>::quiet_NaN(),
                          std::numeric_limits<float>::infinity()};
  CHECK(detail::alsaDecode(reinterpret_cast<const unsigned char*>(nonFinite),
      decoded, 2, SND_PCM_FORMAT_FLOAT_LE) == 2);
  CHECK(decoded[0] == 0 && decoded[1] == 0);
  const float fixed[]{-.5f, .25f}; unsigned char bytes[4]{};
  detail::alsaEncode(fixed, bytes, 2, SND_PCM_FORMAT_S16_LE);
  CHECK(bytes[0] == 0 && bytes[1] == 0xc0 && bytes[2] == 0 && bytes[3] == 0x20);
}
void lifecycle() {
  AudioHost host(detail::makeAlsaAudioHostForTests("null"));
  Render observer;
  CHECK(!host.start().ok);
  auto bad = config(); bad.requestedSampleRate = std::numeric_limits<double>::quiet_NaN();
  CHECK(!host.open(bad, Render::run, &observer).ok);
  bad = config(); bad.outputChannels = {0, 0};
  CHECK(!host.open(bad, Render::run, &observer).ok);
  bad = config(); bad.inputDeviceUid = "input";
  CHECK(!host.open(bad, Render::run, &observer).ok);
  CHECK(host.open(config(), Render::run, &observer).ok);
  CHECK(observer.calls == 0); // open never renders
  AudioHost duplicate(detail::makeAlsaAudioHostForTests("null"));
  CHECK(!duplicate.open(config(), Render::run, &observer).ok);
  CHECK(host.start().ok);
  CHECK(until([&] { return observer.calls > 4; }));
  CHECK(host.suspend().ok);
  const auto held = observer.calls.load();
  std::this_thread::sleep_for(10ms); CHECK(observer.calls == held);
  CHECK(host.resume().ok);
  CHECK(until([&] { return observer.calls > held; }));
  host.stop();
  const auto stopped = observer.calls.load();
  std::this_thread::sleep_for(10ms); CHECK(observer.calls == stopped);
  CHECK(!observer.invalid);
  CHECK(duplicate.open(config(), Render::run, &observer).ok);
  duplicate.stop();
  observer.reject = true;
  CHECK(host.open(config(), Render::run, &observer).ok && host.start().ok);
  CHECK(until([&] { return host.status().state == AudioHostState::Error; }));
  CHECK(host.status().renderFailures == 1);
  CHECK(host.status().terminalReason == AudioHostTerminalReason::ProviderFailure);
  host.stop();
  AudioHost real;
  CHECK(!real.open(config("alsa:missing"), Render::run, &observer).ok);
}
struct ShortWrites {
  uint64_t frame{0};
  uint32_t calls{0}, interrupted{0};
  bool invalid{false};
  int failure{-EPIPE};
  static bool render(void*, const AudioHostRenderBlock& block) noexcept {
    for (uint32_t i = 0; i < block.frames; ++i) {
      block.output[0][i] = float((block.outputFrame + i) % 251) / 512;
      block.output[1][i] = -.25f;
    }
    return true;
  }
  static snd_pcm_sframes_t write(void* context, const void* data, snd_pcm_uframes_t frames) {
    auto& self = *static_cast<ShortWrites*>(context);
    ++self.calls;
    if (self.calls % 7 == 0) { ++self.interrupted; return -EINTR; }
    if (self.calls % 5 == 0) { ++self.interrupted; return -EAGAIN; }
    if (self.frame >= 4096) return self.failure;
    const uint32_t accepted = uint32_t(std::min<snd_pcm_uframes_t>(13, frames));
    const auto* bytes = static_cast<const unsigned char*>(data);
    for (uint32_t i = 0; i < accepted; ++i) {
      float left = 0, right = 0;
      std::memcpy(&left, bytes + size_t(i) * 8, 4);
      std::memcpy(&right, bytes + size_t(i) * 8 + 4, 4);
      if (left != float((self.frame + i) % 251) / 512 || right != -.25f)
        self.invalid = true;
    }
    self.frame += accepted;
    return accepted;
  }
};
void shortTransfers() {
  for (const int failure : {-EPIPE, -ENODEV, 0}) {
    ShortWrites observed; observed.failure = failure;
    AudioHost host(detail::makeAlsaAudioHostForTests("null", {}, ShortWrites::write, &observed));
    CHECK(host.open(config(), ShortWrites::render, nullptr).ok && host.start().ok);
    const auto expected = failure == -ENODEV ? AudioHostState::DeviceLost : AudioHostState::Error;
    CHECK(until([&] { return host.status().state == expected; }));
    CHECK(host.status().xruns == uint64_t(failure == -EPIPE));
    CHECK(host.status().terminalReason == (failure == -ENODEV ?
        AudioHostTerminalReason::DeviceLost : AudioHostTerminalReason::ProviderFailure));
    host.stop();
    CHECK(!observed.invalid && observed.frame >= 4096 && observed.interrupted > 0);
  }
}
bool captureCount(void* context, const float*, uint32_t, uint32_t,
                   uint64_t, uint64_t) noexcept {
  static_cast<std::atomic<uint32_t>*>(context)->fetch_add(1); return true;
}
void leases() {
  std::array<std::atomic<uint32_t>, 5> counts{};
  std::array<std::unique_ptr<detail::AlsaCaptureLease>, 5> leases;
  std::string error;
  for (uint32_t i = 0; i < 4; ++i) {
    leases[i] = detail::acquireAlsaCapture("test-null-capture", "null", 2,
        48000, 256, captureCount, &counts[i], error);
    CHECK(leases[i]);
  }
  leases[4] = detail::acquireAlsaCapture("test-null-capture", "null", 2,
      48000, 256, captureCount, &counts[4], error);
  CHECK(!leases[4]);
  CHECK(leases[0]->start(error) && leases[1]->start(error));
  CHECK(until([&] { return counts[0] > 4 && counts[1] > 4; }));
  CHECK(counts[2] == 0 && counts[3] == 0); // prepared subscribers stay silent
  leases[0].reset();
  const auto stopped = counts[0].load(), running = counts[1].load();
  CHECK(until([&] { return counts[1] > running + 4; }));
  CHECK(counts[0] == stopped);
  leases[1]->stop();
  const auto held = counts[1].load();
  std::this_thread::sleep_for(10ms); CHECK(counts[1] == held);
  CHECK(leases[1]->start(error));
  CHECK(until([&] { return counts[1] > held; }));
}

// A real snd-aloop peer. Its deterministic signal stays inside the kernel
// virtual cable; never open an HDA/USB/default playback device in this test.
class Peer {
 public:
  explicit Peer(const std::string& name) {
    std::string error;
    CHECK(pcm.open(name, false, 2, 48000, 256, 1024, error));
    CHECK(pcm.channels == 2);
    std::vector<float> signal(size_t(pcm.period) * 2);
    for (uint32_t i = 0; i < pcm.period; ++i) {
      signal[i * 2] = .25f; signal[i * 2 + 1] = -.125f;
    }
    bytes.resize(signal.size() * pcm.sampleBytes());
    detail::alsaEncode(signal.data(), bytes.data(), signal.size(), pcm.sampleFormat);
    CHECK(snd_pcm_prepare(pcm.handle) == 0);
    for (uint32_t filled = 0; filled < pcm.buffer; filled += pcm.period)
      CHECK(snd_pcm_writei(pcm.handle, bytes.data(), pcm.period) == pcm.period);
    CHECK(snd_pcm_start(pcm.handle) == 0);
    worker = std::thread([this] {
      uint32_t offset = 0;
      while (!stop.load()) {
        const int ready = pcm.wait();
        if (stop.load()) break;
        if (ready < 0) { failed.store(true); break; }
        if (!ready) continue;
        const auto count = snd_pcm_writei(pcm.handle,
            bytes.data() + size_t(offset) * 2 * pcm.sampleBytes(), pcm.period - offset);
        if (count == -EAGAIN || count == -EINTR) continue;
        if (count < 0) { failed.store(true); break; }
        offset += uint32_t(count);
        if (offset == pcm.period) offset = 0;
      }
    });
  }
  ~Peer() { stop.store(true); pcm.wake(); if (worker.joinable()) worker.join(); }
  detail::AlsaPcm pcm;
  std::atomic<bool> failed{false}, stop{false};
  std::vector<unsigned char> bytes;
  std::thread worker;
};
struct CaptureObservation {
  std::atomic<uint32_t> blocks{0}, matching{0};
  std::atomic<bool> invalid{false};
  float expected;
  explicit CaptureObservation(float value) : expected(value) {}
  void accept(const AudioInputBlockView& block) {
    if (!block.frames || block.sampleRate != 48000 ||
        block.timestampQuality == AudioInputTimestampQuality::Hardware)
      invalid.store(true);
    for (uint32_t i = 0; i < block.frames; ++i)
      if (std::abs(block.mono[i] - expected) < .002f) { matching.fetch_add(1); break; }
    blocks.fetch_add(1);
  }
};
void loopback(const std::string& identity) {
  CHECK(identity == "SingZLoop"); // explicit fixture identity, never a default
  const int card = snd_card_get_index(identity.c_str());
  CHECK(card >= 0);
  const auto endpoints = detail::alsaEndpoints();
  std::string outputUid, captureUid;
  for (const auto& row : endpoints) {
    if (row.info.transport != AudioHostTransport::Virtual) continue;
    CHECK(row.info.monitoringSuitability == AudioHostMonitoringSuitability::LowLatency);
    CHECK(row.info.bufferFrames.minimumFrames >= 1);
    CHECK(row.info.bufferFrames.preferredFrames >= row.info.bufferFrames.minimumFrames);
    CHECK(row.info.bufferFrames.preferredFrames <= row.info.bufferFrames.maximumFrames);
    CHECK(row.info.bufferFrames.maximumFrames <= kAudioHostMaxFrames);
    if (row.pcm == "hw:" + std::to_string(card) + ",0,0") outputUid = row.info.uid;
    if (row.pcm == "hw:" + std::to_string(card) + ",1,0") captureUid = row.info.uid;
  }
  CHECK(!outputUid.empty() && !captureUid.empty());
  {
    // Output mapping {1,0} must reach two independently selected input lanes.
    AudioHost host;
    Render render;
    auto route = config(outputUid); route.outputChannels = {1, 0};
    CHECK(host.open(route, Render::run, &render).ok);
    AudioInput left, right;
    CaptureObservation l(-.375f), r(.125f);
    CHECK(left.start({captureUid, 0, 32}, [&](const auto& b) { l.accept(b); }).ok);
    CHECK(right.start({captureUid, 1, 32}, [&](const auto& b) { r.accept(b); }).ok);
    CHECK(host.start().ok);
    CHECK(until([&] { return l.matching > 8 && r.matching > 8; }));
    left.stop();
    const auto leftStopped = l.blocks.load(), rightBefore = r.blocks.load();
    CHECK(until([&] { return r.blocks > rightBefore + 8; }));
    CHECK(l.blocks == leftStopped);
    CHECK(!l.invalid && !r.invalid && !render.invalid);
    CHECK(host.status().xruns == 0);
    right.stop(); host.stop();
  }
  {
    // Opposite virtual cable drives capture-only before a duplex/output owner
    // joins. Output suspend/stop must not disturb this separate input lease.
    Peer peer("hw:CARD=SingZLoop,DEV=1,SUBDEV=0");
    AudioInput input;
    CaptureObservation observed(.25f);
    CHECK(input.start({outputUid, 0, 32}, [&](const auto& b) { observed.accept(b); }).ok);
    CHECK(until([&] { return observed.matching > 8; }));
    AudioHost host;
    Render render;
    auto route = config(outputUid);
    route.inputDeviceUid = outputUid; route.inputChannels = {0, 1};
    CHECK(host.open(route, Render::run, &render).ok && host.start().ok);
    CHECK(until([&] { return render.signalBlocks > 8; }));
    input.stop();
    const auto before = render.calls.load();
    CHECK(until([&] { return render.calls > before + 8; }));
    CHECK(input.start({outputUid, 0, 32}, [&](const auto& b) { observed.accept(b); }).ok);
    CHECK(host.suspend().ok);
    const auto parked = render.calls.load(), captured = observed.matching.load();
    CHECK(until([&] { return observed.matching > captured + 8; }));
    CHECK(render.calls == parked);
    CHECK(host.resume().ok);
    CHECK(until([&] { return render.calls > parked + 8; }));
    CHECK(host.status().xruns == 0);
    host.stop();
    const auto stopped = render.calls.load(), stillCapturing = observed.matching.load();
    CHECK(until([&] { return observed.matching > stillCapturing + 8; }));
    CHECK(render.calls == stopped);
    input.stop();
    CHECK(!peer.failed && !observed.invalid && !render.invalid);
  }
  std::puts("PASS snd-aloop: mapped playback, two capture lanes, capture-only, duplex sharing, detach, suspend/resume, stop quiescence");
}
}
int main(int argc, char** argv) {
  // A USB microphone and separate speakers each have one unambiguous direction.
  std::vector<detail::AlsaEndpoint> defaults(2);
  defaults[0].info.inputChannels = 2;
  defaults[1].info.outputChannels = 2;
  detail::alsaUniqueDefaults(defaults);
  CHECK(defaults[0].info.defaultInput && !defaults[0].info.defaultOutput);
  CHECK(!defaults[1].info.defaultInput && defaults[1].info.defaultOutput);
  defaults[0].info.outputChannels = 2;
  detail::alsaUniqueDefaults(defaults);
  CHECK(defaults[0].info.defaultInput);
  CHECK(!defaults[0].info.defaultOutput && !defaults[1].info.defaultOutput);

  if (argc == 3 && std::string(argv[1]) == "--loopback") loopback(argv[2]);
  else {
    CHECK(argc == 1);
    conversion(); lifecycle(); shortTransfers(); leases();
    std::puts("PASS ALSA conversion, lifecycle, failure and bounded capture lease tests");
  }
}

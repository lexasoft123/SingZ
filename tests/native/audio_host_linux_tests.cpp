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
  using Operation = detail::AlsaOutputRecoveryOperation;
  uint64_t frame{0}, failureFrame{4096}, primed{0};
  uint32_t calls{0}, interrupted{0}, recoveryBlocks{0};
  uint32_t recoveryPrepares{0}, recoveryWrites{0}, recoveryStarts{0};
  uint32_t renders{0}, statusCalls{0}, statusCount{0}, statusSleepMs{0};
  std::array<detail::AlsaPlaybackSnapshot, 8> statusSnapshots{};
  std::array<int, 8> statusResults{};
  std::array<uint64_t, 8> outputTimes{}, callbackTimes{};
  std::array<bool, 8> outputValid{}, outputHardware{};
  bool invalid{false}, oneShot{false}, injected{false};
  bool failRestart{false};
  int failure{-EPIPE};
  Operation restartFailureOperation{Operation::Prepare};
  snd_pcm_sframes_t restartFailure{-EIO};
  static bool render(void* context, const AudioHostRenderBlock& block) noexcept {
    auto& self = *static_cast<ShortWrites*>(context);
    const auto index = self.renders++;
    if (index < self.outputTimes.size()) {
      self.outputTimes[index] = block.outputHostTimeNs;
      self.callbackTimes[index] = block.callbackHostTimeNs;
      self.outputValid[index] = block.outputTimestampValid;
      self.outputHardware[index] = block.outputTimestampHardware;
    }
    const auto discontinuity = block.discontinuity &
        (AudioHostDiscontinuityXRun | AudioHostDiscontinuityClockReanchored);
    if (discontinuity) {
      ++self.recoveryBlocks;
      if (discontinuity != (AudioHostDiscontinuityXRun |
          AudioHostDiscontinuityClockReanchored))
        self.invalid = true;
    }
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
    if (self.frame >= self.failureFrame && (!self.oneShot || !self.injected)) {
      self.injected = true;
      return self.failure;
    }
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
  static snd_pcm_sframes_t recover(void* context, Operation operation,
      const void* data, snd_pcm_uframes_t frames) {
    auto& self = *static_cast<ShortWrites*>(context);
    if (operation == Operation::Prepare) ++self.recoveryPrepares;
    if (operation == Operation::Write) ++self.recoveryWrites;
    if (operation == Operation::Start) ++self.recoveryStarts;
    if (self.failRestart && self.restartFailureOperation == operation)
      return self.restartFailure;
    if (operation != Operation::Write) return 0;
    const auto* bytes = static_cast<const unsigned char*>(data);
    if (!bytes || !frames) self.invalid = true;
    for (size_t i = 0; i < size_t(frames) * 8; ++i)
      if (bytes[i] != 0) self.invalid = true;
    const auto accepted = std::min<snd_pcm_uframes_t>(13, frames);
    self.primed += accepted;
    return accepted;
  }
  static int status(void* context, detail::AlsaPlaybackSnapshot& snapshot) {
    auto& self = *static_cast<ShortWrites*>(context);
    if (!self.statusCount) {
      self.invalid = true;
      return -ENOSYS;
    }
    if (self.statusCalls >= self.statusCount) return -EAGAIN;
    const auto index = self.statusCalls++;
    snapshot = self.statusSnapshots[index];
    if (self.statusSleepMs)
      std::this_thread::sleep_for(std::chrono::milliseconds(self.statusSleepMs));
    return self.statusResults[index];
  }
};
void shortTransfers() {
  for (const int failure : {-ENODEV, 0, -ESTRPIPE, std::numeric_limits<int>::max()}) {
    ShortWrites observed; observed.failure = failure;
    AudioHost host(detail::makeAlsaAudioHostForTests("null", {}, ShortWrites::write, &observed));
    CHECK(host.open(config(), ShortWrites::render, &observed).ok && host.start().ok);
    const auto expected = failure == -ENODEV ? AudioHostState::DeviceLost : AudioHostState::Error;
    CHECK(until([&] { return host.status().state == expected; }));
    CHECK(host.status().xruns == uint64_t(failure == -ESTRPIPE));
    CHECK(host.status().terminalReason == (failure == -ENODEV ?
        AudioHostTerminalReason::DeviceLost : AudioHostTerminalReason::ProviderFailure));
    host.stop();
    CHECK(!observed.invalid && observed.frame >= 4096 && observed.interrupted > 0);
  }
}
void recoveredUnderrun() {
  ShortWrites observed;
  observed.oneShot = true;
  observed.failureFrame = 4109;
  AudioHost host(detail::makeAlsaAudioHostForTests(
      "null", {}, ShortWrites::write, &observed, ShortWrites::recover));
  CHECK(host.open(config(), ShortWrites::render, &observed).ok);
  const auto buffer = host.status().diagnostics.outputBufferFrames;
  CHECK(host.start().ok);
  CHECK(until([&] { return host.status().xruns == 1 && host.status().callbacks >= 20; }));
  CHECK(host.status().state == AudioHostState::Running);
  CHECK(host.status().terminalReason == AudioHostTerminalReason::None);
  CHECK(host.status().xruns == 1);
  host.stop();
  CHECK(observed.injected && observed.frame > observed.failureFrame);
  CHECK(observed.recoveryBlocks == 1);
  CHECK(observed.recoveryPrepares == 1 && observed.recoveryStarts == 1);
  CHECK(observed.recoveryWrites == (buffer + 12) / 13 && observed.primed == buffer);
  CHECK(!observed.invalid && observed.interrupted > 0);
}
void recoveryFailures() {
  for (const auto operation : {ShortWrites::Operation::Prepare,
       ShortWrites::Operation::Write, ShortWrites::Operation::Start}) {
    ShortWrites observed;
    observed.oneShot = true;
    observed.failureFrame = 4109;
    observed.failRestart = true;
    observed.restartFailureOperation = operation;
    observed.restartFailure = operation == ShortWrites::Operation::Write ? 0 : -EIO;
    AudioHost host(detail::makeAlsaAudioHostForTests(
        "null", {}, ShortWrites::write, &observed, ShortWrites::recover));
    CHECK(host.open(config(), ShortWrites::render, &observed).ok);
    const auto buffer = host.status().diagnostics.outputBufferFrames;
    CHECK(host.start().ok);
    CHECK(until([&] { return host.status().state == AudioHostState::Error; }));
    CHECK(host.status().xruns == 1);
    CHECK(host.status().terminalReason == AudioHostTerminalReason::ProviderFailure);
    host.stop();
    CHECK(observed.injected && observed.recoveryPrepares == 1);
    const auto expectedWrites = operation == ShortWrites::Operation::Prepare ? 0 :
        operation == ShortWrites::Operation::Write ? 1 : (buffer + 12) / 13;
    CHECK(observed.recoveryWrites == expectedWrites);
    CHECK(observed.recoveryStarts == uint32_t(operation == ShortWrites::Operation::Start));
    CHECK(observed.primed == (operation == ShortWrites::Operation::Start ? buffer : 0));
    CHECK(!observed.invalid);
  }
}
detail::AlsaPlaybackSnapshot outputSnapshot(uint64_t timestampNs,
    snd_pcm_sframes_t delay = 256) {
  detail::AlsaPlaybackSnapshot result;
  result.available = 1024;
  result.time.tv_sec = static_cast<decltype(result.time.tv_sec)>(
      timestampNs / 1000000000ull);
  result.time.tv_nsec = static_cast<decltype(result.time.tv_nsec)>(
      timestampNs % 1000000000ull);
  result.delay = delay;
  return result;
}
void playbackTimestampMath() {
  const auto snapshot = outputSnapshot(100000000000ull);
  constexpr uint64_t expected = 100005333333ull;
  CHECK(detail::alsaPlaybackOutputHostNs(snapshot, 48000, 1024, 0, 0) == expected);
  CHECK(detail::alsaPlaybackOutputHostNs(snapshot, 48000, 1024,
      100000000000ull, expected) == 0);
  CHECK(detail::alsaPlaybackOutputHostNs(snapshot, 48000, 1024,
      100000000001ull, 0) == 0);
  CHECK(detail::alsaPlaybackOutputHostNs(snapshot, 48000, 1024,
      0, expected + 1) == 0);
  const auto sameTimeMoreQueued = outputSnapshot(100000000000ull, 512);
  CHECK(detail::alsaPlaybackOutputHostNs(sameTimeMoreQueued, 48000, 1024,
      100000000000ull, expected) == 100010666666ull);
  const auto advanced = outputSnapshot(100010000000ull);
  CHECK(detail::alsaPlaybackOutputHostNs(advanced, 48000, 1024,
      100000000000ull, expected) == 100015333333ull);
  const auto atBudget = outputSnapshot(100000000000ull, 1024);
  CHECK(detail::alsaPlaybackOutputHostNs(atBudget, 48000, 1024, 0, 0) == 100021333333ull);
  const auto zero = outputSnapshot(0);
  CHECK(detail::alsaPlaybackOutputHostNs(zero, 48000, 1024, 0, 0) == 0);
  CHECK(detail::alsaPlaybackOutputHostNs(zero, 48000, 1024,
      100000000000ull, expected) == 0);
  const auto negativeDelay = outputSnapshot(100000000000ull, -1);
  CHECK(detail::alsaPlaybackOutputHostNs(negativeDelay, 48000, 1024, 0, 0) == 0);
  const auto unsupportedLookahead = outputSnapshot(100000000000ull, 1025);
  CHECK(detail::alsaPlaybackOutputHostNs(unsupportedLookahead, 48000, 1024, 0, 0) == 0);
  CHECK(detail::alsaPlaybackOutputHostNs(snapshot, 0, 1024, 0, 0) == 0);
  CHECK(detail::alsaPlaybackOutputHostNs(snapshot, 48000, 0, 0, 0) == 0);
  const auto overflow = outputSnapshot(std::numeric_limits<uint64_t>::max() - 1000);
  CHECK(detail::alsaPlaybackOutputHostNs(overflow, 48000, 1024, 0, 0) == 0);
}
void outputStatusEstimates() {
  ShortWrites observed;
  observed.statusCount = 2;
  observed.statusSnapshots[0] = outputSnapshot(100000000000ull);
  observed.statusSnapshots[1] = outputSnapshot(100010000000ull);
  observed.statusSleepMs = 2;
  AudioHost host(detail::makeAlsaAudioHostForTests(
      "null", {}, ShortWrites::write, &observed, nullptr, ShortWrites::status));
  CHECK(host.open(config(), ShortWrites::render, &observed).ok && host.start().ok);
  CHECK(until([&] { return host.status().callbacks >= 2; }));
  CHECK(host.status().state == AudioHostState::Running);
  host.stop();
  CHECK(observed.renders == 2 && observed.statusCalls >= 2 && !observed.invalid);
  CHECK(observed.outputValid[0] && observed.outputValid[1] &&
      !observed.outputHardware[0] && !observed.outputHardware[1]);
  CHECK(observed.outputTimes[0] == 100005333333ull &&
      observed.outputTimes[1] == 100015333333ull);
  CHECK(observed.callbackTimes[0] && observed.callbackTimes[1] &&
      observed.callbackTimes[0] != observed.callbackTimes[1]);
}
void outputStatusUnavailableThenValid() {
  ShortWrites observed;
  observed.statusCount = 2;
  observed.statusSnapshots[0] = outputSnapshot(100000000000ull, 1025);
  observed.statusSnapshots[1] = outputSnapshot(100000000000ull);
  AudioHost host(detail::makeAlsaAudioHostForTests(
      "null", {}, ShortWrites::write, &observed, nullptr, ShortWrites::status));
  CHECK(host.open(config(), ShortWrites::render, &observed).ok && host.start().ok);
  CHECK(until([&] { return host.status().callbacks >= 2; }));
  CHECK(host.status().state == AudioHostState::Running);
  host.stop();
  CHECK(observed.renders == 2 && !observed.invalid);
  CHECK(!observed.outputValid[0] && observed.outputTimes[0] == 0 &&
      observed.callbackTimes[0] != 0);
  CHECK(observed.outputValid[1] && observed.outputTimes[1] == 100005333333ull &&
      !observed.outputHardware[0] && !observed.outputHardware[1]);
}
void outputStatusXrunRecovery() {
  ShortWrites observed;
  observed.statusCount = 2;
  observed.statusSnapshots[0] = outputSnapshot(100000000000ull, 0);
  observed.statusSnapshots[0].state = SND_PCM_STATE_XRUN;
  observed.statusSnapshots[0].available = 0;
  observed.statusSnapshots[1] = outputSnapshot(100000000000ull);
  AudioHost host(detail::makeAlsaAudioHostForTests(
      "null", {}, ShortWrites::write, &observed, ShortWrites::recover,
      ShortWrites::status));
  CHECK(host.open(config(), ShortWrites::render, &observed).ok && host.start().ok);
  CHECK(until([&] { return host.status().xruns == 1 && host.status().callbacks >= 1; }));
  CHECK(host.status().state == AudioHostState::Running);
  CHECK(host.status().terminalReason == AudioHostTerminalReason::None);
  host.stop();
  CHECK(observed.renders == 1 && observed.recoveryPrepares == 1 &&
      observed.recoveryStarts == 1 && observed.recoveryBlocks == 1);
  CHECK(observed.outputValid[0] && observed.outputTimes[0] == 100005333333ull &&
      !observed.invalid);
}
void outputStatusTerminal() {
  for (const auto state : {SND_PCM_STATE_SUSPENDED, SND_PCM_STATE_DISCONNECTED,
       static_cast<snd_pcm_state_t>(999)}) {
    ShortWrites observed;
    observed.statusCount = 1;
    observed.statusSnapshots[0] = outputSnapshot(100000000000ull, 0);
    observed.statusSnapshots[0].state = state;
    observed.statusSnapshots[0].available = 0;
    AudioHost host(detail::makeAlsaAudioHostForTests(
        "null", {}, ShortWrites::write, &observed, nullptr, ShortWrites::status));
    CHECK(host.open(config(), ShortWrites::render, &observed).ok && host.start().ok);
    const auto expected = state == SND_PCM_STATE_DISCONNECTED ?
        AudioHostState::DeviceLost : AudioHostState::Error;
    CHECK(until([&] { return host.status().state == expected; }));
    host.stop();
    CHECK(observed.renders == 0 && host.status().callbacks == 0 && !observed.invalid);
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
struct CaptureRecoveryObservation {
  AudioInputRing ring{16, 256};
  std::array<float, 256> mono{};
  std::array<uint64_t, 8> sourceFrames{};
  std::atomic<uint32_t> callbacks{0};
  bool invalid{false};
  static bool push(void* context, const float* input, uint32_t channels,
                   uint32_t frames, uint64_t source, uint64_t firstSampleNs) noexcept {
    auto& self = *static_cast<CaptureRecoveryObservation*>(context);
    if (!frames || frames > self.mono.size() || !input || !channels) {
      self.invalid = true;
      return false;
    }
    for (uint32_t frame = 0; frame < frames; ++frame)
      self.mono[frame] = input[size_t(frame) * channels];
    const auto index = self.callbacks.load(std::memory_order_relaxed);
    if (index < self.sourceFrames.size()) self.sourceFrames[index] = source;
    self.callbacks.store(index + 1, std::memory_order_release);
    // Only the initial metadata blocks enter the ring. Callback counting
    // independently proves continuation without requiring queue admission.
    if (index >= 4) return true;
    const bool pushed = self.ring.push(self.mono.data(), frames, firstSampleNs,
        detail::alsaMonotonicNs(), firstSampleNs ?
            AudioInputTimestampQuality::CallbackEstimate :
            AudioInputTimestampQuality::Unknown);
    if (!pushed) self.invalid = true;
    return pushed;
  }
};
struct CaptureRecoveryScript {
  using Operation = detail::AlsaCaptureOperation;
  uint32_t reads{0}, prepares{0}, starts{0}, timestamps{0};
  uint32_t injectAfter{0}, injections{1};
  uint32_t timestampInjections{0}, delayReadMs{0};
  uint32_t readEagain{0}, readEintr{0};
  int readResult{-EPIPE}, recoveryResult{-EIO}, timestampResult{0};
  snd_pcm_uframes_t timestampAvailable{64};
  uint64_t fixedTimestampNs{0}, timestampStepNs{0};
  bool failRecovery{false};
  Operation recoveryFailureOperation{Operation::Prepare};
  static snd_pcm_sframes_t operation(void* context, Operation action,
      void* data, snd_pcm_uframes_t frames) {
    auto& self = *static_cast<CaptureRecoveryScript*>(context);
    if (action == Operation::Timestamp) {
      ++self.timestamps;
      if (self.timestampInjections) {
        --self.timestampInjections;
        return self.timestampResult;
      }
      auto& snapshot = *static_cast<detail::AlsaCaptureSnapshot*>(data);
      const uint64_t timestampNs = self.fixedTimestampNs ?
          self.fixedTimestampNs + (self.timestamps - 1) * self.timestampStepNs :
          detail::alsaMonotonicNs();
      snapshot.available = self.timestampAvailable;
      snapshot.time.tv_sec = static_cast<decltype(snapshot.time.tv_sec)>(
          timestampNs / 1000000000ull);
      snapshot.time.tv_nsec = static_cast<decltype(snapshot.time.tv_nsec)>(
          timestampNs % 1000000000ull);
      return 0;
    }
    if (action == Operation::Prepare) ++self.prepares;
    if (action == Operation::Start) ++self.starts;
    if (action != Operation::Read) {
      if (self.failRecovery && self.recoveryFailureOperation == action)
        return self.recoveryResult;
      return 0;
    }
    ++self.reads;
    if (self.injections && self.reads > self.injectAfter) {
      --self.injections;
      return self.readResult;
    }
    if (self.readEagain) { --self.readEagain; return -EAGAIN; }
    if (self.readEintr) { --self.readEintr; return -EINTR; }
    if (self.delayReadMs)
      std::this_thread::sleep_for(std::chrono::milliseconds(self.delayReadMs));
    if (!data) return -EIO;
    const auto accepted = std::min<snd_pcm_uframes_t>(64, frames);
    std::memset(data, 0, size_t(accepted) * 8);
    return accepted;
  }
};
void captureRecovery() {
  CaptureRecoveryObservation firstObserved, secondObserved;
  CaptureRecoveryScript script;
  script.injectAfter = 2;
  script.injections = 2;
  std::string error;
  auto first = detail::acquireAlsaCapture("test-capture-recovery", "null", 2,
      48000, 256, CaptureRecoveryObservation::push, &firstObserved, error);
  auto second = detail::acquireAlsaCapture("test-capture-recovery", "null", 2,
      48000, 256, CaptureRecoveryObservation::push, &secondObserved, error);
  CHECK(first && second);
  first->setOperationsForTests(CaptureRecoveryScript::operation, &script);
  CHECK(first->start(error) && second->start(error));
  CHECK(until([&] { return firstObserved.callbacks >= 4 && secondObserved.callbacks >= 4; }));
  CHECK(first->failure() == 0 && second->failure() == 0);
  const auto continued = secondObserved.callbacks.load();
  first->stop();
  CHECK(until([&] { return secondObserved.callbacks > continued; }));
  second->stop();
  CHECK(script.reads >= 7 && script.prepares == 2 && script.starts == 2);
  CHECK(firstObserved.sourceFrames[2] == 128 && firstObserved.sourceFrames[3] == 192);
  CHECK(!firstObserved.invalid && !secondObserved.invalid);
  CHECK(firstObserved.ring.overruns() == 0 && secondObserved.ring.overruns() == 0);
  AudioInputBlockView block;
  CHECK(firstObserved.ring.peek(block, 48000));
  CHECK(block.capture.sequence == 0 && block.capture.sourceFrame == 0 &&
      block.capture.discontinuity == AudioInputDiscontinuityReason::None &&
      block.capture.sampleHostTimeNs != 0);
  firstObserved.ring.consume();
  CHECK(firstObserved.ring.peek(block, 48000));
  CHECK(block.capture.sequence == 1 && block.capture.sourceFrame == 64 &&
      block.capture.discontinuity == AudioInputDiscontinuityReason::None);
  firstObserved.ring.consume();
  CHECK(firstObserved.ring.peek(block, 48000));
  CHECK(block.capture.sequence == 2 && block.capture.sourceFrame == 128 &&
      block.capture.discontinuity == AudioInputDiscontinuityReason::TimestampQualityChanged &&
      (block.capture.flags & AudioInputDiscontinuous) != 0 &&
      block.capture.sampleHostTimeNs == 0 &&
      block.capture.timestampQuality == AudioInputTimestampQuality::Unknown &&
      (block.capture.flags & AudioInputSampleHostTimeValid) == 0 &&
      (block.capture.flags & AudioInputTimestampQualityValid) == 0);
  firstObserved.ring.consume();
  CHECK(firstObserved.ring.peek(block, 48000));
  CHECK(block.capture.sequence == 3 && block.capture.sourceFrame == 192 &&
      block.capture.discontinuity == AudioInputDiscontinuityReason::TimestampQualityChanged &&
      block.capture.sampleHostTimeNs != 0 &&
      block.capture.timestampQuality == AudioInputTimestampQuality::CallbackEstimate &&
      (block.capture.flags & AudioInputSampleHostTimeValid) != 0 &&
      (block.capture.flags & AudioInputStaleAnchor) != 0);
  firstObserved.ring.consume();
}
void captureRecoveryFailures() {
  using Operation = CaptureRecoveryScript::Operation;
  struct Case {
    int readResult;
    bool failRecovery;
    Operation failureOperation;
    int expected;
    uint32_t prepares, starts;
  };
  const std::array<Case, 6> cases{{
    {-ENODEV, false, Operation::Read, -ENODEV, 0, 0},
    {-ESTRPIPE, false, Operation::Read, -ESTRPIPE, 0, 0},
    {0, false, Operation::Read, -EIO, 0, 0},
    {std::numeric_limits<int>::max(), false, Operation::Read, -EIO, 0, 0},
    {-EPIPE, true, Operation::Prepare, -EIO, 1, 0},
    {-EPIPE, true, Operation::Start, -EIO, 1, 1},
  }};
  for (size_t index = 0; index < cases.size(); ++index) {
    const auto& test = cases[index];
    CaptureRecoveryObservation observed;
    CaptureRecoveryScript script;
    script.readResult = test.readResult;
    script.failRecovery = test.failRecovery;
    script.recoveryFailureOperation = test.failureOperation;
    std::string error;
    auto lease = detail::acquireAlsaCapture(
        "test-capture-terminal-" + std::to_string(index), "null", 2, 48000, 256,
        CaptureRecoveryObservation::push, &observed, error);
    CHECK(lease);
    lease->setOperationsForTests(CaptureRecoveryScript::operation, &script);
    CHECK(lease->start(error));
    CHECK(until([&] { return lease->failure() == test.expected; }));
    lease->stop();
    CHECK(script.reads == 1 && script.prepares == test.prepares &&
        script.starts == test.starts);
    CHECK(observed.callbacks == 0 && observed.ring.overruns() == 0 && !observed.invalid);
  }
}
void captureTimestampConfiguration() {
  std::string error;
  detail::AlsaPcm capture;
  CHECK(capture.open("null", true, 2, 48000, 256, 1024, error));
  snd_pcm_sw_params_t* software = nullptr;
  snd_pcm_sw_params_alloca(&software);
  snd_pcm_tstamp_t mode = SND_PCM_TSTAMP_NONE;
  snd_pcm_tstamp_type_t type = SND_PCM_TSTAMP_TYPE_GETTIMEOFDAY;
  CHECK(snd_pcm_sw_params_current(capture.handle, software) == 0);
  CHECK(snd_pcm_sw_params_get_tstamp_mode(software, &mode) == 0);
  CHECK(snd_pcm_sw_params_get_tstamp_type(software, &type) == 0);
  CHECK(mode == SND_PCM_TSTAMP_ENABLE && type == SND_PCM_TSTAMP_TYPE_MONOTONIC);
  detail::AlsaPcm output;
  CHECK(output.open("null", false, 2, 48000, 256, 1024, error));
  CHECK(snd_pcm_sw_params_current(output.handle, software) == 0);
  CHECK(snd_pcm_sw_params_get_tstamp_mode(software, &mode) == 0);
  CHECK(snd_pcm_sw_params_get_tstamp_type(software, &type) == 0);
  CHECK(mode == SND_PCM_TSTAMP_ENABLE && type == SND_PCM_TSTAMP_TYPE_MONOTONIC);
}
void captureTimestampMath() {
  detail::AlsaCaptureSnapshot snapshot;
  snapshot.available = 3072;
  snapshot.time.tv_sec = 100;
  snapshot.time.tv_nsec = 0;
  constexpr uint64_t expected = 99936000000ull;
  CHECK(detail::alsaTimespecMonotonicNs(snapshot.time) == 100000000000ull);
  CHECK(detail::alsaCaptureFirstSampleNs(snapshot, 48000, 16384, 0, 0) == expected);
  CHECK(detail::alsaCaptureFirstSampleNs(snapshot, 48000, 16384,
      100000000001ull, 0) == 0);
  CHECK(detail::alsaCaptureFirstSampleNs(snapshot, 48000, 16384,
      0, expected + 1) == 0);
  CHECK(detail::alsaCaptureFirstSampleNs(snapshot, 48000, 16384,
      0, expected) == 0);
  auto advanced = snapshot;
  advanced.available = 1536;
  CHECK(detail::alsaCaptureFirstSampleNs(advanced, 48000, 16384,
      100000000000ull, expected) == 99968000000ull);
  auto invalid = snapshot;
  invalid.time.tv_sec = 0;
  invalid.time.tv_nsec = 0;
  CHECK(detail::alsaCaptureFirstSampleNs(invalid, 48000, 16384, 0, 0) == 0);
  invalid = snapshot;
  invalid.time.tv_sec = -1;
  CHECK(detail::alsaCaptureFirstSampleNs(invalid, 48000, 16384, 0, 0) == 0);
  invalid = snapshot;
  invalid.time.tv_nsec = 1000000000L;
  CHECK(detail::alsaCaptureFirstSampleNs(invalid, 48000, 16384, 0, 0) == 0);
  invalid = snapshot;
  invalid.available = 0;
  CHECK(detail::alsaCaptureFirstSampleNs(invalid, 48000, 16384, 0, 0) == 0);
  invalid = snapshot;
  invalid.available = 16385;
  CHECK(detail::alsaCaptureFirstSampleNs(invalid, 48000, 16384, 0, 0) == 0);
  invalid = snapshot;
  invalid.time.tv_sec = 0;
  invalid.time.tv_nsec = 1000;
  CHECK(detail::alsaCaptureFirstSampleNs(invalid, 48000, 16384, 0, 0) == 0);
  CHECK(detail::alsaCaptureFirstSampleNs(snapshot, 0, 16384, 0, 0) == 0);
  CHECK(detail::alsaCaptureFirstSampleNs(snapshot, 48000, 0, 0, 0) == 0);
  invalid = snapshot;
  invalid.time.tv_sec = std::numeric_limits<decltype(invalid.time.tv_sec)>::max();
  invalid.time.tv_nsec = 999999999L;
  const auto seconds = static_cast<uint64_t>(invalid.time.tv_sec);
  if (seconds > (std::numeric_limits<uint64_t>::max() - 999999999ull) / 1000000000ull)
    CHECK(detail::alsaTimespecMonotonicNs(invalid.time) == 0);
}
void captureTimestampDelay() {
  CaptureRecoveryObservation observed;
  CaptureRecoveryScript script;
  script.injections = 0;
  script.fixedTimestampNs = 100000000000ull;
  script.timestampAvailable = 512;
  script.delayReadMs = 3;
  std::string error;
  auto lease = detail::acquireAlsaCapture("test-capture-fixed-htimestamp", "null",
      2, 48000, 256, CaptureRecoveryObservation::push, &observed, error);
  CHECK(lease);
  lease->setOperationsForTests(CaptureRecoveryScript::operation, &script);
  CHECK(lease->start(error));
  CHECK(until([&] { return observed.callbacks >= 1; }));
  CHECK(lease->failure() == 0);
  lease->stop();
  CHECK(!observed.invalid && observed.ring.overruns() == 0);
  AudioInputBlockView block;
  CHECK(observed.ring.peek(block, 48000));
  CHECK(block.capture.sourceFrame == 0 && block.capture.sampleHostTimeNs == 99989333334ull &&
      block.capture.timestampQuality == AudioInputTimestampQuality::CallbackEstimate &&
      (block.capture.flags & AudioInputSampleHostTimeValid) != 0);
  observed.ring.consume();
}
void captureTimestampRecovery() {
  CaptureRecoveryObservation observed;
  CaptureRecoveryScript script;
  script.injections = 0;
  script.timestampInjections = 1;
  script.timestampResult = -EPIPE;
  script.fixedTimestampNs = 100000000000ull;
  script.timestampStepNs = 1000000ull;
  script.readEagain = 1;
  script.readEintr = 1;
  std::string error;
  auto lease = detail::acquireAlsaCapture("test-capture-htimestamp-recovery", "null",
      2, 48000, 256, CaptureRecoveryObservation::push, &observed, error);
  CHECK(lease);
  lease->setOperationsForTests(CaptureRecoveryScript::operation, &script);
  CHECK(lease->start(error));
  CHECK(until([&] { return observed.callbacks >= 2; }));
  CHECK(lease->failure() == 0);
  lease->stop();
  CHECK(script.timestamps >= 5 && script.reads >= 4 &&
      script.readEagain == 0 && script.readEintr == 0 &&
      script.prepares == 1 && script.starts == 1);
  CHECK(!observed.invalid && observed.ring.overruns() == 0);
  AudioInputBlockView block;
  CHECK(observed.ring.peek(block, 48000));
  CHECK(block.capture.sourceFrame == 0 && block.capture.sampleHostTimeNs == 0 &&
      block.capture.timestampQuality == AudioInputTimestampQuality::Unknown &&
      (block.capture.flags & AudioInputSampleHostTimeValid) == 0);
  observed.ring.consume();
  CHECK(observed.ring.peek(block, 48000));
  CHECK(block.capture.sequence == 1 && block.capture.sourceFrame == 64 &&
      block.capture.sampleHostTimeNs != 0 &&
      block.capture.discontinuity == AudioInputDiscontinuityReason::TimestampQualityChanged &&
      block.capture.timestampQuality == AudioInputTimestampQuality::CallbackEstimate &&
      (block.capture.flags & AudioInputSampleHostTimeValid) != 0);
  observed.ring.consume();
}
void captureTimestampApiFailure() {
  CaptureRecoveryObservation observed;
  CaptureRecoveryScript script;
  script.injections = 0;
  script.timestampInjections = 1;
  script.timestampResult = -ENOSYS;
  std::string error;
  auto lease = detail::acquireAlsaCapture("test-capture-htimestamp-failure", "null",
      2, 48000, 256, CaptureRecoveryObservation::push, &observed, error);
  CHECK(lease);
  lease->setOperationsForTests(CaptureRecoveryScript::operation, &script);
  CHECK(lease->start(error));
  CHECK(until([&] { return lease->failure() == -ENOSYS; }));
  lease->stop();
  CHECK(script.timestamps == 1 && script.reads == 0 &&
      script.prepares == 0 && script.starts == 0);
  CHECK(observed.callbacks == 0 && observed.ring.overruns() == 0 && !observed.invalid);
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
    conversion(); lifecycle(); shortTransfers(); recoveredUnderrun(); recoveryFailures();
    playbackTimestampMath(); outputStatusEstimates(); outputStatusUnavailableThenValid();
    outputStatusXrunRecovery(); outputStatusTerminal(); leases();
    captureRecovery(); captureRecoveryFailures(); captureTimestampConfiguration();
    captureTimestampMath(); captureTimestampDelay(); captureTimestampRecovery();
    captureTimestampApiFailure();
    std::puts("PASS ALSA conversion, lifecycle, output/capture recovery, timestamps and bounded capture lease tests");
  }
}

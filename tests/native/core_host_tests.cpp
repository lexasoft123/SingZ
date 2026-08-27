// Host-compiled checks for the ORT-free zcore component targets: the
// resampler's quality claim and the WAV writer's byte contract. The
// overlap-add loop and the resume tail live inside split_engine.cpp next to
// the ORT session and are proven on-device instead (the LSB-parity gate and
// the kill/resume run in mobile/tests/split-android.cjs) — reimplementing
// them here would test the reimplementation.
//
// Built by scripts/run-core-host-tests.sh (plain c++, no NDK), run by the
// Android CI canary.
#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <cstdio>
#include <cstring>
#include <memory>
#include <limits>
#include <semaphore>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#include <zcore/legacy/analysis.h>
#include <zcore/device/audio_input.h>
#include <zcore/legacy/audio_input_analysis_adapter.h>
#include <zcore/device/audio_input_android_policy.h>
#include <zcore/device/audio_input_backend.h>
#include <zcore/device/audio_input_callback_gate.h>
#include <zcore/audio/audio_input_convert.h>
#include <zcore/device/audio_input_ios_session.h>
#include <zcore/audio/audio_input_timestamp.h>
#include <zcore/media/flac_io.h>
#include <zcore/legacy/beat_this.h>
#include <zcore/legacy/beats.h>
#include <zcore/legacy/live_input_analysis.h>
#include <zcore/legacy/melody.h>
#include <zcore/legacy/resample.h>
#include <zcore/media/wav.h>

#include "audio_input_callback.h"

static int failures = 0;

static std::atomic<int> fakeFailureAfter{-1};
static std::atomic<bool> fakeNoSleep{false};
static std::atomic<bool> fakeStartFails{false};
static std::atomic<bool> fakeInvalidRate{false};
static std::atomic<bool> fakeSuppressCallbacks{false};

class FakeAudioInputBackend final : public singz::AudioInputBackend {
 public:
  ~FakeAudioInputBackend() override { stop(); }

  singz::AudioInputResult open(const singz::AudioInputConfig& config,
                               singz::AudioInputPush push, void* context) override {
    channel_ = config.channel;
    push_ = push;
    context_ = context;
    return singz::AudioInputResult::success(
        singz::AudioInputState::Starting,
        fakeInvalidRate.load() ? std::numeric_limits<double>::quiet_NaN() : 48000,
        channel_);
  }

  singz::AudioInputResult start() override {
    if (fakeStartFails.load())
      return singz::AudioInputResult::failure(
          singz::AudioInputState::Error, "simulated start failure", channel_);
    stop_.store(false);
    if (fakeSuppressCallbacks.load())
      return singz::AudioInputResult::success(
          singz::AudioInputState::Running, 48000, channel_);
    producer_ = std::thread([this] {
      float samples[128];
      for (int i = 0; i < 128; ++i)
        samples[i] = static_cast<float>(0.2 * std::sin(2 * M_PI * 440 * i / 48000));
      uint64_t host = 1000000000;
      int callbacks = 0;
      while (!stop_.load()) {
        const uint64_t callbackTime = static_cast<uint64_t>(
            std::chrono::duration_cast<std::chrono::nanoseconds>(
                std::chrono::steady_clock::now().time_since_epoch()).count());
        if (push_)
          push_(context_, samples, 128, host, callbackTime,
                singz::AudioInputTimestampQuality::Hardware);
        host += 2666667;
        if (fakeFailureAfter.load() >= 0 && ++callbacks >= fakeFailureAfter.load()) {
          failed_.store(true);
          break;
        }
        if (!fakeNoSleep.load()) std::this_thread::sleep_for(std::chrono::milliseconds(1));
      }
    });
    return singz::AudioInputResult::success(
        singz::AudioInputState::Running, 48000, channel_);
  }

  void stop() override {
    stop_.store(true);
    if (producer_.joinable() && producer_.get_id() != std::this_thread::get_id()) producer_.join();
  }

  bool takeFailure(std::string& error) override {
    if (!failed_.exchange(false)) return false;
    error = "simulated input device disconnected";
    return true;
  }

 private:
  singz::AudioInputPush push_ = nullptr;
  void* context_ = nullptr;
  uint32_t channel_ = 0;
  std::atomic<bool> stop_{false};
  std::atomic<bool> failed_{false};
  std::thread producer_;
};

static std::unique_ptr<singz::AudioInputBackend> fakeAudioInputBackend() {
  return std::make_unique<FakeAudioInputBackend>();
}

static bool waitForState(singz::AudioInput& input, singz::AudioInputState wanted,
                         int timeoutMs = 1000) {
  const auto until = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);
  while (std::chrono::steady_clock::now() < until) {
    if (input.state() == wanted) return true;
    std::this_thread::sleep_for(std::chrono::milliseconds(2));
  }
  return input.state() == wanted;
}

// Keep the internal name unlike any likely caller local: the old `ok` macro
// captured an `ok` variable and silently tested uninitialized storage.
#define CHECK(label, cond)                                        \
  do {                                                            \
    const bool check_ok_ = (cond);                                \
    std::printf("%s  %s\n", check_ok_ ? "PASS" : "FAIL", label);  \
    if (!check_ok_) failures++;                                   \
  } while (0)

static void audioInputConversionTests() {
  {
    const float interleaved[] = {0.25f, -0.5f, 0.75f, -1.0f};
    float mono[2] = {};
    CHECK("audio input conversion: float32 channel selection",
          singz::convertAudioInputChannel(
              reinterpret_cast<const uint8_t*>(interleaved), 2, 2, 1,
              singz::AudioInputEncoding::Float32, 32, mono) &&
              mono[0] == -0.5f && mono[1] == -1.0f);
  }
  {
    const int16_t interleaved[] = {-32768, 16384, 32767, -16384};
    float mono[2] = {};
    CHECK("audio input conversion: PCM16 normalization",
          singz::convertAudioInputChannel(
              reinterpret_cast<const uint8_t*>(interleaved), 2, 2, 0,
              singz::AudioInputEncoding::Pcm16, 16, mono) &&
              mono[0] == -1.0f && std::fabs(mono[1] - 32767.0f / 32768.0f) < 1e-7f);
  }
  {
    // Two stereo frames: selected right lane is minimum then maximum PCM24.
    const uint8_t interleaved[] = {
        0, 0, 0, 0, 0, 0x80,
        0, 0, 0, 0xff, 0xff, 0x7f,
    };
    float mono[2] = {};
    CHECK("audio input conversion: packed PCM24 normalization",
          singz::convertAudioInputChannel(interleaved, 2, 2, 1,
                                          singz::AudioInputEncoding::Pcm24,
                                          24, mono) &&
              mono[0] == -1.0f && mono[1] > 0.999999f);
  }
  {
    // 24 valid bits in a 32-bit container are left-aligned.
    const int32_t interleaved[] = {
        std::numeric_limits<int32_t>::min(), 0x7fffff00,
    };
    float mono[2] = {};
    CHECK("audio input conversion: extensible PCM valid bits",
          singz::convertAudioInputChannel(
              reinterpret_cast<const uint8_t*>(interleaved), 2, 1, 0,
              singz::AudioInputEncoding::Pcm32, 24, mono) &&
              mono[0] == -1.0f && mono[1] > 0.999999f);
    CHECK("audio input conversion: rejects invalid channel",
          !singz::convertAudioInputChannel(
              reinterpret_cast<const uint8_t*>(interleaved), 2, 1, 1,
              singz::AudioInputEncoding::Pcm32, 24, mono));
  }
}

static void audioInputAnalysisAdapterTests() {
  constexpr double rate = 48000;
  constexpr uint64_t startNs = 2000000000ull;
  auto timestamp = [](uint64_t start, uint64_t frame) {
    return static_cast<uint64_t>(static_cast<long double>(start) +
                                 static_cast<long double>(frame) * 1000000000.0L / rate);
  };
  std::vector<float> block960(960, 0.0f);
  std::vector<singz::LiveInputAnalysisWindow> windows;
  singz::LiveInputAnalysisAdapter adapter;
  for (uint64_t sequence = 0; sequence < 3; ++sequence) {
    singz::AudioInputBlockView block;
    block.sequence = sequence;
    block.sampleHostTimeNs = timestamp(startNs, sequence * block960.size());
    block.callbackHostTimeNs = 3000000000ull + sequence * 20000000ull;
    block.timestampQuality = singz::AudioInputTimestampQuality::Hardware;
    block.sampleRate = rate;
    block.mono = block960.data();
    block.frames = static_cast<uint32_t>(block960.size());
    CHECK("live adapter: variable 960-frame callback accepted",
          adapter.push(block, [&](const auto& window) { windows.push_back(window); }));
  }
  CHECK("live adapter: consumes every available 512-frame hop",
        windows.size() == 2 && adapter.emittedWindows() == 2);
  CHECK("live adapter: bounded circular backlog after multiple outputs",
        adapter.bufferedFrames() == 1856 &&
            adapter.bufferedFrames() <= singz::LiveInputAnalysisAdapter::analysisFrames());
  CHECK("live adapter: first window spans the contributing callbacks",
        windows.size() == 2 && windows[0].startSequence == 0 &&
            windows[0].endSequence == 2);
  CHECK("live adapter: window start/end timestamps align to sample positions",
        windows.size() == 2 && windows[0].sampleHostTimeStartNs == startNs &&
            windows[0].sampleHostTimeEndNs == timestamp(startNs, 2048) &&
            windows[1].sampleHostTimeStartNs == timestamp(startNs, 512) &&
            windows[1].sampleHostTimeEndNs == timestamp(startNs, 2560));
  CHECK("live adapter: window timestamps are monotonic",
        windows.size() == 2 &&
            windows[1].sampleHostTimeStartNs > windows[0].sampleHostTimeStartNs &&
            windows[1].sampleHostTimeEndNs > windows[0].sampleHostTimeEndNs);

  std::vector<float> maximumBlock(16384, 0.0f);
  windows.clear();
  adapter.reset();
  singz::AudioInputBlockView large;
  large.sequence = 20;
  large.sampleHostTimeNs = 5000000000ull;
  large.callbackHostTimeNs = 5100000000ull;
  large.timestampQuality = singz::AudioInputTimestampQuality::Hardware;
  large.sampleRate = rate;
  large.mono = maximumBlock.data();
  large.frames = static_cast<uint32_t>(maximumBlock.size());
  CHECK("live adapter: maximum callback is accepted",
        adapter.push(large, [&](const auto& window) { windows.push_back(window); }));
  CHECK("live adapter: one large callback emits all 29 windows",
        windows.size() == 29 && adapter.emittedWindows() == 31);
  CHECK("live adapter: maximum callback leaves only fixed overlap",
        adapter.bufferedFrames() == 1536);

  adapter.reset();
  windows.clear();
  singz::AudioInputBlockView beforeGap = large;
  beforeGap.sequence = 40;
  beforeGap.frames = 960;
  beforeGap.mono = block960.data();
  beforeGap.sampleHostTimeNs = 7000000000ull;
  CHECK("live adapter: pre-gap partial window accepted",
        adapter.push(beforeGap, [&](const auto& window) { windows.push_back(window); }));
  singz::AudioInputBlockView afterGap = large;
  afterGap.sequence = 42;
  afterGap.frames = 2048;
  afterGap.mono = maximumBlock.data();
  afterGap.sampleHostTimeNs = 9000000000ull;
  afterGap.callbackHostTimeNs = 9100000000ull;
  CHECK("live adapter: post-gap block accepted",
        adapter.push(afterGap, [&](const auto& window) { windows.push_back(window); }));
  CHECK("live adapter: sequence gap resets partial audio and resampler state",
        windows.size() == 1 && windows[0].startSequence == 42 &&
            windows[0].endSequence == 42 && adapter.resets() == 3);
  CHECK("live adapter: post-gap timestamps restart at the new raw anchor",
        windows.size() == 1 && windows[0].sampleHostTimeStartNs == 9000000000ull &&
            windows[0].sampleHostTimeEndNs == timestamp(9000000000ull, 2048));

  // AAudio starts before its non-RT timestamp sampler has a hardware anchor.
  // Partial estimate-domain audio must not leak into the first hardware
  // analysis window; the inverse transition on a stale anchor is isolated too.
  singz::LiveInputAnalysisAdapter qualityAdapter;
  windows.clear();
  for (uint64_t sequence = 0; sequence < 2; ++sequence) {
    singz::AudioInputBlockView estimate;
    estimate.sequence = sequence;
    estimate.sampleHostTimeNs = timestamp(8000000000ull, sequence * block960.size());
    estimate.callbackHostTimeNs = estimate.sampleHostTimeNs + 20000000ull;
    estimate.timestampQuality = singz::AudioInputTimestampQuality::CallbackEstimate;
    estimate.sampleRate = rate;
    estimate.mono = block960.data();
    estimate.frames = static_cast<uint32_t>(block960.size());
    CHECK("live adapter: initial callback-estimate block accepted",
          qualityAdapter.push(estimate,
                              [&](const auto& window) { windows.push_back(window); }));
  }
  CHECK("live adapter: partial callback-estimate window remains pending",
        windows.empty() && qualityAdapter.bufferedFrames() == 1920);
  for (uint64_t sequence = 2; sequence < 5; ++sequence) {
    singz::AudioInputBlockView hardware;
    hardware.sequence = sequence;
    hardware.sampleHostTimeNs = timestamp(9000000000ull,
                                          (sequence - 2) * block960.size());
    hardware.callbackHostTimeNs = hardware.sampleHostTimeNs + 20000000ull;
    hardware.timestampQuality = singz::AudioInputTimestampQuality::Hardware;
    hardware.sampleRate = rate;
    hardware.mono = block960.data();
    hardware.frames = static_cast<uint32_t>(block960.size());
    CHECK("live adapter: hardware-anchor block accepted after fallback",
          qualityAdapter.push(hardware,
                              [&](const auto& window) { windows.push_back(window); }));
  }
  CHECK("live adapter: estimate-to-hardware transition drops mixed-domain overlap",
        windows.size() == 2 && windows[0].startSequence == 2 &&
            windows[0].timestampQuality == singz::AudioInputTimestampQuality::Hardware &&
            windows[0].sampleHostTimeStartNs == 9000000000ull &&
            qualityAdapter.resets() == 1);

  windows.clear();
  singz::AudioInputBlockView staleFallback;
  staleFallback.sequence = 5;
  staleFallback.sampleHostTimeNs = 11000000000ull;
  staleFallback.callbackHostTimeNs = 11050000000ull;
  staleFallback.timestampQuality = singz::AudioInputTimestampQuality::CallbackEstimate;
  staleFallback.sampleRate = rate;
  staleFallback.mono = maximumBlock.data();
  staleFallback.frames = 2048;
  CHECK("live adapter: stale-anchor callback fallback is accepted",
        qualityAdapter.push(staleFallback,
                            [&](const auto& window) { windows.push_back(window); }));
  CHECK("live adapter: hardware-to-estimate transition also reanchors",
        windows.size() == 1 && windows[0].startSequence == 5 &&
            windows[0].endSequence == 5 &&
            windows[0].timestampQuality ==
                singz::AudioInputTimestampQuality::CallbackEstimate &&
            windows[0].sampleHostTimeStartNs == 11000000000ull &&
            qualityAdapter.resets() == 2);
}

static void androidAudioInputPresetPolicyTests() {
  using singz::AndroidAudioInputPreset;
  CHECK("Android input preset: opened voice-performance is explicitly verified",
        singz::androidAudioInputPresetMetadata(
            static_cast<int32_t>(AndroidAudioInputPreset::VoicePerformance),
            true, false) == "voice-performance-verified");
  CHECK("Android input preset: setter-only result is labeled requested/unverified",
        singz::androidAudioInputPresetMetadata(
            static_cast<int32_t>(AndroidAudioInputPreset::Unprocessed),
            false, true) == "unprocessed-requested-unverified");
  CHECK("Android input preset: API 26-27 default is labeled unverified",
        singz::androidAudioInputPresetMetadata(
            static_cast<int32_t>(AndroidAudioInputPreset::VoiceRecognition),
            false, false) == "voice-recognition-default-unverified");
  CHECK("Android input preset: vendor values remain honest instead of guessed",
        singz::androidAudioInputPresetMetadata(12345, true, false) ==
            "unknown-verified");
}

static void audioInputCallbackGateTests() {
  singz::AudioInputCallbackGate gate;
  CHECK("audio callback gate: closed gate rejects entry", !gate.enter());
  gate.open();
  CHECK("audio callback gate: open gate admits callback", gate.enter());
  CHECK("audio callback gate: admitted callback is counted", gate.inFlight() == 1);
  gate.beginClose();
  CHECK("audio callback gate: teardown rejects a late callback", !gate.enter());
  CHECK("audio callback gate: rejected callback leaves count unchanged", gate.inFlight() == 1);
  gate.leave();
  CHECK("audio callback gate: admitted callback quiesces before destruction",
        gate.inFlight() == 0 && !gate.accepting());
}

static void countAudioInputNotification(void* context) noexcept {
  auto* count = static_cast<uint32_t*>(context);
  ++*count;
}

static void audioInputCallbackEndpointTests() {
  singz::AudioInputRing ring(2, 4);
  singz::AudioInputCallbackEndpoint endpoint;
  uint32_t notifications = 0;
  endpoint.prepare(ring.producer(), countAudioInputNotification,
                   &notifications);
  const float first[2] = {0.25f, -0.5f};
  const float second[2] = {0.75f, 1.0f};
  CHECK("audio callback endpoint: prepared callback accepts into the ring",
        singz::AudioInputCallbackEndpoint::push(
            &endpoint, first, 2, 100, 110,
            singz::AudioInputTimestampQuality::Hardware));
  CHECK("audio callback endpoint: pending notification is coalesced",
        singz::AudioInputCallbackEndpoint::push(
            &endpoint, second, 2, 200, 210,
            singz::AudioInputTimestampQuality::CallbackEstimate) &&
            notifications == 1);
  CHECK("audio callback endpoint: consumer rearms exactly one publication",
        endpoint.rearmNotification() && !endpoint.rearmNotification());
  singz::AudioInputBlockView block;
  CHECK("audio callback endpoint: first callback metadata is preserved",
        ring.peek(block, 48000) && block.frames == 2 &&
            block.sampleHostTimeNs == 100 && block.callbackHostTimeNs == 110 &&
            block.timestampQuality ==
                singz::AudioInputTimestampQuality::Hardware);
  ring.consume();
  CHECK("audio callback endpoint: rearmed callback signals again",
        singz::AudioInputCallbackEndpoint::push(
            &endpoint, first, 2, 300, 310,
            singz::AudioInputTimestampQuality::Hardware) &&
            notifications == 2);
  endpoint.clear();
  CHECK("audio callback endpoint: cleared endpoint is inert",
        !singz::AudioInputCallbackEndpoint::push(
            &endpoint, first, 2, 400, 410,
            singz::AudioInputTimestampQuality::Hardware));
}

static bool boundedSpinUntil(const std::atomic<bool>& value,
                             uint32_t maxYields = 1000000) {
  for (uint32_t i = 0; i < maxYields; ++i) {
    if (value.load(std::memory_order_acquire)) return true;
    std::this_thread::yield();
  }
  return value.load(std::memory_order_acquire);
}

static void audioInputSpscStressTests() {
  constexpr uint32_t kCapacity = 8;
  constexpr uint32_t kBlocks = 8192;
  constexpr uint32_t kSpinBudget = 4000000;
  singz::AudioInputRing ring(kCapacity, 1);
  const singz::AudioInputRingProducer producer = ring.producer();
  std::atomic<bool> prefilled{false};
  std::atomic<bool> consumeGo{false};
  std::atomic<bool> abort{false};
  std::atomic<bool> producerDone{false};
  std::atomic<bool> fullObserved{false};
  std::atomic<uint32_t> consumed{0};
  std::atomic<uint32_t> errors{0};

  std::thread producerThread([&] {
    uint32_t item = 0;
    for (; item < kCapacity; ++item) {
      const float sample = static_cast<float>(item);
      if (!producer.push(&sample, 1, 1000 + item, 2000 + item,
                         singz::AudioInputTimestampQuality::Hardware)) {
        errors.fetch_add(1, std::memory_order_relaxed);
        abort.store(true, std::memory_order_release);
        break;
      }
    }
    if (!abort.load(std::memory_order_acquire)) {
      const float fullSample = static_cast<float>(item);
      fullObserved.store(
          !producer.push(&fullSample, 1, 1000 + item, 2000 + item,
                         singz::AudioInputTimestampQuality::Hardware),
          std::memory_order_release);
    }
    prefilled.store(true, std::memory_order_release);
    uint32_t waitYields = 0;
    while (!consumeGo.load(std::memory_order_acquire) &&
           !abort.load(std::memory_order_acquire) &&
           ++waitYields < kSpinBudget)
      std::this_thread::yield();
    if (!consumeGo.load(std::memory_order_acquire))
      abort.store(true, std::memory_order_release);

    for (; item < kBlocks && !abort.load(std::memory_order_acquire); ++item) {
      const float sample = static_cast<float>(item);
      uint32_t attempts = 0;
      while (!producer.push(&sample, 1, 1000 + item, 2000 + item,
                            singz::AudioInputTimestampQuality::Hardware)) {
        if (++attempts >= kSpinBudget) {
          abort.store(true, std::memory_order_release);
          break;
        }
        std::this_thread::yield();
      }
    }
    producerDone.store(true, std::memory_order_release);
  });

  const bool reachedPrefill = boundedSpinUntil(prefilled);
  std::thread consumerThread([&] {
    uint32_t expected = 0;
    uint32_t emptyYields = 0;
    while (expected < kBlocks && !abort.load(std::memory_order_acquire)) {
      singz::AudioInputBlockView block;
      if (!ring.peek(block, 48000)) {
        if (producerDone.load(std::memory_order_acquire)) {
          // The empty peek preceded the acquire of producerDone. Recheck after
          // that acquire so the producer's final ring release is visible.
          if (ring.peek(block, 48000)) continue;
          abort.store(true, std::memory_order_release);
          break;
        }
        if (++emptyYields >= kSpinBudget) {
          abort.store(true, std::memory_order_release);
          break;
        }
        std::this_thread::yield();
        continue;
      }
      emptyYields = 0;
      const float wanted = static_cast<float>(expected);
      if (block.frames != 1 || block.mono[0] != wanted ||
          block.sampleHostTimeNs != 1000 + expected ||
          block.callbackHostTimeNs != 2000 + expected ||
          block.timestampQuality !=
              singz::AudioInputTimestampQuality::Hardware)
        errors.fetch_add(1, std::memory_order_relaxed);
      ring.consume();
      ++expected;
      consumed.store(expected, std::memory_order_release);
    }
  });
  consumeGo.store(true, std::memory_order_release);
  producerThread.join();
  consumerThread.join();

  CHECK("audio input SPSC stress: producer reaches deterministic full boundary",
        reachedPrefill && fullObserved.load(std::memory_order_acquire));
  CHECK("audio input SPSC stress: bounded concurrent wrap preserves every block",
        !abort.load(std::memory_order_acquire) &&
            errors.load(std::memory_order_relaxed) == 0 &&
            consumed.load(std::memory_order_acquire) == kBlocks &&
            ring.overruns() >= 1);
}

struct AudioInputWakeHarness {
  std::atomic<uint32_t> notifications{0};
  std::counting_semaphore<65536> wake{0};
};

static void signalAudioInputWakeHarness(void* context) noexcept {
  auto* harness = static_cast<AudioInputWakeHarness*>(context);
  harness->notifications.fetch_add(1, std::memory_order_relaxed);
  harness->wake.release();
}

static void audioInputWakePublicationStressTests() {
  constexpr uint32_t kBlocks = 4096;
  constexpr uint32_t kSpinBudget = 4000000;
  singz::AudioInputRing ring(16, 1);
  singz::AudioInputCallbackEndpoint endpoint;
  AudioInputWakeHarness harness;
  endpoint.prepare(ring.producer(), signalAudioInputWakeHarness, &harness);
  std::atomic<bool> go{false};
  std::atomic<bool> abort{false};
  std::atomic<bool> producerDone{false};
  std::atomic<uint32_t> consumed{0};
  std::atomic<uint32_t> errors{0};

  std::thread producerThread([&] {
    uint32_t waitYields = 0;
    while (!go.load(std::memory_order_acquire) &&
           ++waitYields < kSpinBudget)
      std::this_thread::yield();
    if (!go.load(std::memory_order_acquire))
      abort.store(true, std::memory_order_release);
    for (uint32_t item = 0;
         item < kBlocks && !abort.load(std::memory_order_acquire); ++item) {
      const float sample = static_cast<float>(item);
      uint32_t attempts = 0;
      while (!singz::AudioInputCallbackEndpoint::push(
          &endpoint, &sample, 1, 10000 + item, 20000 + item,
          singz::AudioInputTimestampQuality::CallbackEstimate)) {
        if (++attempts >= kSpinBudget) {
          abort.store(true, std::memory_order_release);
          break;
        }
        std::this_thread::yield();
      }
    }
    producerDone.store(true, std::memory_order_release);
  });

  std::thread consumerThread([&] {
    uint32_t expected = 0;
    uint32_t waitTimeouts = 0;
    while (expected < kBlocks && !abort.load(std::memory_order_acquire)) {
      bool didWork = false;
      singz::AudioInputBlockView block;
      while (ring.peek(block, 48000)) {
        didWork = true;
        const float wanted = static_cast<float>(expected);
        if (block.frames != 1 || block.mono[0] != wanted ||
            block.sampleHostTimeNs != 10000 + expected ||
            block.callbackHostTimeNs != 20000 + expected)
          errors.fetch_add(1, std::memory_order_relaxed);
        ring.consume();
        ++expected;
        waitTimeouts = 0;
        consumed.store(expected, std::memory_order_release);
      }
      if (expected == kBlocks) break;
      if (!didWork) {
        [[maybe_unused]] const bool sawPublication =
            endpoint.rearmNotification();
        if (ring.peek(block, 48000)) continue;
        if (!harness.wake.try_acquire_for(std::chrono::milliseconds(250))) {
          const bool done = producerDone.load(std::memory_order_acquire);
          // As above, the acquire may publish the final block after the last
          // empty check. Accept that interleaving before bounded failure.
          if (done && ring.peek(block, 48000)) continue;
          if (done || ++waitTimeouts >= 32) {
            abort.store(true, std::memory_order_release);
            break;
          }
        }
      }
    }
  });

  go.store(true, std::memory_order_release);
  producerThread.join();
  consumerThread.join();
  endpoint.clear();
  const uint32_t notifications =
      harness.notifications.load(std::memory_order_acquire);
  CHECK("audio input wake stress: rearm and ring recheck lose no publication",
        !abort.load(std::memory_order_acquire) &&
            errors.load(std::memory_order_relaxed) == 0 &&
            consumed.load(std::memory_order_acquire) == kBlocks);
  CHECK("audio input wake stress: notification remains bounded and coalesced",
        notifications > 0 && notifications <= kBlocks);
}

static void audioInputCallbackQuiescenceTests() {
  constexpr uint32_t kSpinBudget = 1000000;
  singz::AudioInputRing ring(2, 1);
  singz::AudioInputCallbackEndpoint endpoint;
  endpoint.prepare(ring.producer(), nullptr, nullptr);
  singz::AudioInputCallbackGate gate;
  gate.open();
  std::atomic<bool> entered{false};
  std::atomic<bool> release{false};
  std::atomic<bool> pushed{false};

  std::thread callbackThread([&] {
    singz::AudioInputCallbackScope scope(gate);
    if (!scope) return;
    entered.store(true, std::memory_order_release);
    uint32_t waitYields = 0;
    while (!release.load(std::memory_order_acquire) &&
           ++waitYields < kSpinBudget)
      std::this_thread::yield();
    const float sample = 0.5f;
    pushed.store(singz::AudioInputCallbackEndpoint::push(
                     &endpoint, &sample, 1, 100, 110,
                     singz::AudioInputTimestampQuality::Hardware),
                 std::memory_order_release);
  });

  const bool callbackEntered = boundedSpinUntil(entered);
  gate.beginClose();
  const bool lateRejected = !gate.enter();
  release.store(true, std::memory_order_release);
  bool quiesced = false;
  for (uint32_t i = 0; i < kSpinBudget; ++i) {
    if (gate.inFlight() == 0) {
      quiesced = true;
      break;
    }
    std::this_thread::yield();
  }
  callbackThread.join();
  // Clear borrowed callback state only after join even when the bounded
  // quiescence observation failed; `quiesced` still records that failure.
  endpoint.clear();
  const float lateSample = 1.0f;
  const bool inertAfterClear = !singz::AudioInputCallbackEndpoint::push(
      &endpoint, &lateSample, 1, 200, 210,
      singz::AudioInputTimestampQuality::Hardware);
  CHECK("audio callback quiescence: close rejects late entry and drains in-flight",
        callbackEntered && lateRejected && quiesced &&
            pushed.load(std::memory_order_acquire));
  CHECK("audio callback quiescence: endpoint is cleared only after callback exit",
        inertAfterClear && gate.inFlight() == 0 && !gate.accepting());
}

static void audioInputTimestampTests() {
  constexpr int32_t rate = 48000;
  constexpr uint32_t frames = 480;
  constexpr uint64_t callback = 2000000000ull;
  constexpr uint64_t duration = 10000000ull;

  const singz::AudioInputTimestampProjection validHardware =
      singz::resolveAudioInputTimestamp(true, 1500000000ull, callback,
                                        frames, rate);
  CHECK("audio timestamp policy: valid OS timestamp remains hardware",
        validHardware.usedHardwareAnchor &&
            validHardware.sampleHostTimeNs == 1500000000ull);
  const singz::AudioInputTimestampProjection invalidHardware =
      singz::resolveAudioInputTimestamp(false, 1500000000ull, callback,
                                        frames, rate);
  CHECK("audio timestamp policy: invalid OS timestamp uses callback estimate",
        !invalidHardware.usedHardwareAnchor &&
            invalidHardware.sampleHostTimeNs == callback - duration);
  const singz::AudioInputTimestampProjection missingHardware =
      singz::resolveAudioInputTimestamp(true, 0, callback, frames, rate);
  CHECK("audio timestamp policy: zero OS timestamp is never hardware",
        !missingHardware.usedHardwareAnchor &&
            missingHardware.sampleHostTimeNs == callback - duration);
  CHECK("audio timestamp policy: callback estimate clamps underflow nonzero",
        singz::audioInputCallbackEntryFallback(5, frames, rate) == 1);

  singz::AudioInputTimestampProjector projector;

  const auto empty = projector.project(0, frames, rate, callback);
  CHECK("audio timestamp: no hardware anchor uses bounded callback fallback",
        !empty.usedHardwareAnchor &&
            empty.sampleHostTimeNs == callback - duration);

  CHECK("audio timestamp: accepts a sane non-RT hardware anchor",
        projector.publish(4800, 1000000000ll, 1010000000ull));
  const auto aligned = projector.project(5280, frames, rate, 1020000000ull);
  CHECK("audio timestamp: projects the block start in the AAudio frame domain",
        aligned.usedHardwareAnchor && aligned.sampleHostTimeNs == 1010000000ull);
  const auto next = projector.project(5760, frames, rate, 1030000000ull);
  CHECK("audio timestamp: consecutive blocks remain monotonic and frame-aligned",
        next.usedHardwareAnchor &&
            next.sampleHostTimeNs == aligned.sampleHostTimeNs + duration);

  const auto stale = projector.project(6240, frames, rate, 1600000000ull);
  CHECK("audio timestamp: stale sampler anchor falls back at callback entry",
        !stale.usedHardwareAnchor &&
            stale.sampleHostTimeNs == 1600000000ull - duration);
  CHECK("audio timestamp: rejects an anchor implausibly ahead of its sample clock",
        !projector.publish(0, 3000000000ll, 1000000000ull));

  projector.reset();
  const auto reset = projector.project(0, frames, rate, callback);
  CHECK("audio timestamp: reset disowns the prior stream frame domain",
        !reset.usedHardwareAnchor && reset.sampleHostTimeNs == callback - duration);

  singz::AudioInputTimestampQueryGate gate;
  CHECK("audio timestamp query gate: closed gate rejects sampler", !gate.enter());
  gate.open();
  CHECK("audio timestamp query gate: open stream admits sampler", gate.enter());
  CHECK("audio timestamp query gate: admitted query is counted", gate.inFlight() == 1);
  gate.beginClose();
  CHECK("audio timestamp query gate: teardown rejects a late timestamp query",
        !gate.enter());
  gate.leave();
  CHECK("audio timestamp query gate: admitted query quiesces before stream close",
        gate.inFlight() == 0 && !gate.accepting());

  // macOS/iOS AudioUnit and Windows WASAPI all use the policy above. Replay
  // each backend shape through the production adapter to hold the essential
  // contract: fallback audio cannot cross into the first hardware window.
  constexpr std::array<const char*, 3> backends = {"macOS", "iOS", "Windows"};
  std::vector<float> partial(960, 0.0f);
  std::vector<float> full(2048, 0.0f);
  for (const char* backend : backends) {
    singz::LiveInputAnalysisAdapter adapter;
    std::vector<singz::LiveInputAnalysisWindow> windows;
    const auto fallback = singz::resolveAudioInputTimestamp(
        false, 0, 8020000000ull, static_cast<uint32_t>(partial.size()), rate);
    singz::AudioInputBlockView estimate;
    estimate.sequence = 0;
    estimate.sampleHostTimeNs = fallback.sampleHostTimeNs;
    estimate.callbackHostTimeNs = 8020000000ull;
    estimate.timestampQuality = singz::AudioInputTimestampQuality::CallbackEstimate;
    estimate.sampleRate = rate;
    estimate.mono = partial.data();
    estimate.frames = static_cast<uint32_t>(partial.size());
    const bool acceptedEstimate = adapter.push(
        estimate, [&](const auto& window) { windows.push_back(window); });

    const auto hardware = singz::resolveAudioInputTimestamp(
        true, 9000000000ull, 9043000000ull,
        static_cast<uint32_t>(full.size()), rate);
    singz::AudioInputBlockView anchored;
    anchored.sequence = 1;
    anchored.sampleHostTimeNs = hardware.sampleHostTimeNs;
    anchored.callbackHostTimeNs = 9043000000ull;
    anchored.timestampQuality = singz::AudioInputTimestampQuality::Hardware;
    anchored.sampleRate = rate;
    anchored.mono = full.data();
    anchored.frames = static_cast<uint32_t>(full.size());
    const bool acceptedHardware = adapter.push(
        anchored, [&](const auto& window) { windows.push_back(window); });
    const std::string label = std::string("audio timestamp policy: ") + backend +
                              " fallback-to-hardware resets adapter";
    CHECK(label.c_str(), acceptedEstimate && acceptedHardware &&
          windows.size() == 1 && windows[0].startSequence == 1 &&
          windows[0].sampleHostTimeStartNs == 9000000000ull &&
          windows[0].timestampQuality ==
              singz::AudioInputTimestampQuality::Hardware &&
          adapter.resets() == 1);
  }
}

// Scratch directory for the wav/flac fixtures the suites write. TMPDIR is the
// POSIX answer; Windows sets TEMP (never TMPDIR) and has no /tmp, which made
// every hardcoded literal here a harness failure on the first MSVC run — the
// core was healthy, the paths were not.
static std::string scratchDir() {
  if (const char* t = std::getenv("TMPDIR")) return t;
  if (const char* t = std::getenv("TEMP")) return t;
  return "/tmp";
}
static std::vector<float> sine(double hz, int rate, int frames, int channels) {
  std::vector<float> out(static_cast<size_t>(frames) *
                         static_cast<size_t>(channels));
  for (int i = 0; i < frames; i++) {
    const float v = static_cast<float>(0.5 * std::sin(2.0 * M_PI * hz * i / rate));
    for (int c = 0; c < channels; c++)
      out[static_cast<size_t>(i) * static_cast<size_t>(channels) +
          static_cast<size_t>(c)] = v;
  }
  return out;
}

static void audioInputTests() {
  {
    using Route = singz::IosAudioOutputRouteKind;
    CHECK("iOS buffer policy: built-in output requests low latency",
          singz::shouldRequestLowLatencyIosInputBuffer(Route::BuiltIn));
    CHECK("iOS buffer policy: wired output requests low latency",
          singz::shouldRequestLowLatencyIosInputBuffer(Route::Wired));
    CHECK("iOS buffer policy: USB output requests low latency",
          singz::shouldRequestLowLatencyIosInputBuffer(Route::Usb));
    CHECK("iOS buffer policy: Bluetooth HFP keeps route-controlled duration",
          !singz::shouldRequestLowLatencyIosInputBuffer(Route::BluetoothHfp));
    CHECK("iOS buffer policy: Bluetooth A2DP keeps route-controlled duration",
          !singz::shouldRequestLowLatencyIosInputBuffer(Route::BluetoothA2dp));
    CHECK("iOS buffer policy: Bluetooth LE keeps route-controlled duration",
          !singz::shouldRequestLowLatencyIosInputBuffer(Route::BluetoothLe));
    CHECK("iOS buffer policy: AirPlay keeps route-controlled duration",
          !singz::shouldRequestLowLatencyIosInputBuffer(Route::AirPlay));
    CHECK("iOS buffer policy: CarPlay keeps route-controlled duration",
          !singz::shouldRequestLowLatencyIosInputBuffer(Route::CarAudio));
  }
  {
    using Status = singz::IosAudioInputSavedRouteStatus;
    CHECK("iOS preference cleanup: current saved route is present",
          singz::classifyIosAudioInputSavedRoute(true, true, false) ==
              Status::Present);
    CHECK("iOS preference cleanup: available saved route is present",
          singz::classifyIosAudioInputSavedRoute(false, true, true) ==
              Status::Present);
    CHECK("iOS preference cleanup: known inventory proves unplugged route",
          singz::classifyIosAudioInputSavedRoute(false, true, false) ==
              Status::Gone);
    CHECK("iOS preference cleanup: unavailable inventory is inconclusive",
          singz::classifyIosAudioInputSavedRoute(false, false, false) ==
              Status::Unknown);
  }
  {
    singz::IosAudioInputSessionSnapshot state;
    std::string error;
    CHECK("iOS audio session policy: undetermined permission is not ready",
          !singz::validateIosAudioInputSession(state, "ios:mic", 0, error) &&
              error.find("permission") != std::string::npos);
    state.permission = singz::IosAudioInputPermission::Granted;
    state.leaseActive = true;
    state.leaseToken = 9;
    state.routeGeneration = 4;
    state.leaseRouteGeneration = 4;
    state.leaseDeviceUid = "ios:mic";
    state.leaseMinimumChannels = 3;
    state.recordCapable = true;
    state.activeInputRoute = true;
    state.currentDeviceUid = "ios:mic";
    state.sampleRate = 48000;
    state.channels = 4;
    CHECK("iOS audio session policy: prepared selected lane is ready",
          singz::validateIosAudioInputSession(state, "ios:mic", 2, error));
    state.routeGeneration++;
    CHECK("iOS audio session policy: route generation invalidates lease",
          !singz::validateIosAudioInputSession(state, "ios:mic", 2, error) &&
              error.find("route changed") != std::string::npos);
    state.routeGeneration = state.leaseRouteGeneration;
    state.sampleRate = 0;
    CHECK("iOS audio session policy: inactive/unknown rate is rejected",
          !singz::validateIosAudioInputSession(state, "ios:mic", 2, error) &&
              error.find("sample rate") != std::string::npos);
    state.sampleRate = 48000;
    state.currentDeviceUid = "ios:other";
    CHECK("iOS audio session policy: selected device must be active",
          !singz::validateIosAudioInputSession(state, "ios:mic", 2, error));
  }
  {
    singz::IosAudioInputLeaseRegistry leases;
    std::string error;
    uint64_t first = 0;
    uint64_t second = 0;
    CHECK("iOS audio lease: first route policy is committed atomically",
          leases.acquire(10, "ios:usb", 4, first, error) && first != 0);
    const singz::IosAudioInputLeaseState firstState = leases.snapshot();
    CHECK("iOS audio lease: snapshot contains one coherent policy",
          firstState.token == first && firstState.routeGeneration == 10 &&
              firstState.deviceUid == "ios:usb" &&
              firstState.minimumChannels == 4);
    CHECK("iOS audio lease: overlapping acquisition is rejected",
          !leases.acquire(11, "ios:other", 1, second, error) &&
              leases.snapshot().token == first);
    leases.release(first);
    CHECK("iOS audio lease: a new generation can follow release",
          leases.acquire(12, "ios:new", 2, second, error) && second != first);
    leases.release(first);
    const singz::IosAudioInputLeaseState afterOldRelease = leases.snapshot();
    CHECK("iOS audio lease: delayed old release cannot clear a newer lease",
          afterOldRelease.token == second &&
              afterOldRelease.routeGeneration == 12 &&
              afterOldRelease.deviceUid == "ios:new" &&
              afterOldRelease.minimumChannels == 2);
    leases.release(second);
    CHECK("iOS audio lease: matching release clears the complete policy",
          leases.snapshot().token == 0 &&
              leases.snapshot().deviceUid.empty());
  }
  {
    singz::AudioInputRing ring(2, 4);
    CHECK("audio input ring: valid preallocated shape", ring.valid() && ring.capacity() == 2);
    const float a[4] = {1, 2, 3, 4};
    const float b[2] = {5, 6};
    const float c[3] = {7, 8, 9};
    CHECK("audio input ring: first block accepted",
          ring.push(a, 4, 100, 110,
                    singz::AudioInputTimestampQuality::Hardware));
    CHECK("audio input ring: second block accepted",
          ring.push(b, 2, 200, 210,
                    singz::AudioInputTimestampQuality::CallbackEstimate));
    CHECK("audio input ring: full ring drops newest", !ring.push(c, 3, 300));
    CHECK("audio input ring: overflow is counted", ring.overruns() == 1);
    singz::AudioInputBlockView out;
    CHECK("audio input ring: first block pops",
          ring.peek(out, 48000) && out.sequence == 0 && out.sampleHostTimeNs == 100 &&
              out.sampleRate == 48000 && out.frames == 4 &&
              out.timestampQuality == singz::AudioInputTimestampQuality::Hardware &&
              std::equal(out.mono, out.mono + out.frames, a));
    const float* firstSlot = out.mono;
    ring.consume();
    CHECK("audio input ring: wrap slot accepts after pop", ring.push(c, 3, 300));
    CHECK("audio input ring: second block keeps order",
          ring.peek(out, 48000) && out.sequence == 1 && out.sampleHostTimeNs == 200 &&
              out.timestampQuality ==
                  singz::AudioInputTimestampQuality::CallbackEstimate &&
              out.frames == 2 && std::equal(out.mono, out.mono + out.frames, b));
    ring.consume();
    CHECK("audio input ring: wrapped block exposes dropped-attempt gap",
          ring.peek(out, 48000) && out.sequence == 3 && out.sampleHostTimeNs == 300 &&
              out.frames == 3 && std::equal(out.mono, out.mono + out.frames, c));
    CHECK("audio input ring: preallocated slots are reused without delivery allocation",
          out.mono == firstSlot);
    ring.consume();
    CHECK("audio input ring: empty pop is non-blocking", !ring.peek(out, 48000));
    CHECK("audio input ring: oversized callback is rejected", !ring.push(a, 5, 400));
    CHECK("audio input ring: invalid construction is inert",
          !singz::AudioInputRing(1, 4).valid() && !singz::AudioInputRing(2, 0).valid());
    singz::AudioInputRing corruptRing(2, 4);
    const float corrupt[4] = {1, std::numeric_limits<float>::quiet_NaN(),
                              std::numeric_limits<float>::infinity(), -1};
    CHECK("audio input ring: corrupt hardware block is accepted for delivery",
          corruptRing.push(corrupt, 4, 500) && corruptRing.peek(out, 48000));
    CHECK("audio input ring: non-finite PCM is sanitized off the RT thread",
          out.frames == 4 && out.mono[0] == 1 && out.mono[1] == 0 &&
              out.mono[2] == 0 && out.mono[3] == -1);
    corruptRing.consume();

    singz::AudioInputRing fallbackRing(8, 4, 31, 32);
    CHECK("audio input ring: hardware and fallback domain blocks publish",
          fallbackRing.push(a, 4, 1000, 1010,
                            singz::AudioInputTimestampQuality::Hardware) &&
              fallbackRing.push(a, 4, 2000, 2010,
                                singz::AudioInputTimestampQuality::CallbackEstimate) &&
              fallbackRing.push(a, 4, 3000, 3010,
                                singz::AudioInputTimestampQuality::CallbackEstimate) &&
              fallbackRing.push(a, 4, 4000, 4010,
                                singz::AudioInputTimestampQuality::CallbackEstimate) &&
              fallbackRing.push(a, 4, 5000, 5010,
                                singz::AudioInputTimestampQuality::Hardware));
    CHECK("audio input ring: initial hardware domain is fresh",
          fallbackRing.peek(out, 48000) && out.capture.sequence == 0 &&
              out.capture.discontinuity ==
                  singz::AudioInputDiscontinuityReason::None &&
              (out.capture.flags & singz::AudioInputStaleAnchor) == 0);
    fallbackRing.consume();
    CHECK("audio input ring: fallback entry is typed and stale",
          fallbackRing.peek(out, 48000) && out.capture.sequence == 1 &&
              out.capture.discontinuity ==
                  singz::AudioInputDiscontinuityReason::TimestampQualityChanged &&
              (out.capture.flags & singz::AudioInputStaleAnchor) != 0);
    fallbackRing.consume();
    CHECK("audio input ring: fallback stale state persists without a second edge",
          fallbackRing.peek(out, 48000) && out.capture.sequence == 2 &&
              out.capture.discontinuity ==
                  singz::AudioInputDiscontinuityReason::None &&
              (out.capture.flags & singz::AudioInputStaleAnchor) != 0);
    fallbackRing.consume();
    CHECK("audio input ring: later fallback blocks remain stale and continuous",
          fallbackRing.peek(out, 48000) && out.capture.sequence == 3 &&
              out.capture.discontinuity ==
                  singz::AudioInputDiscontinuityReason::None &&
              (out.capture.flags & singz::AudioInputStaleAnchor) != 0);
    fallbackRing.consume();
    CHECK("audio input ring: hardware return clears stale with one typed edge",
          fallbackRing.peek(out, 48000) && out.capture.sequence == 4 &&
              out.capture.discontinuity ==
                  singz::AudioInputDiscontinuityReason::TimestampQualityChanged &&
              (out.capture.flags & singz::AudioInputStaleAnchor) == 0);
    fallbackRing.consume();

    singz::AudioInputRing overflowDomainRing(
        4, 4, 33, 34, std::numeric_limits<uint64_t>::max() - 2);
    CHECK("audio input ring: overflow domain blocks publish",
          overflowDomainRing.push(a, 4, 6000, 6010,
                                  singz::AudioInputTimestampQuality::Hardware) &&
              overflowDomainRing.push(a, 4, 7000, 7010,
                                      singz::AudioInputTimestampQuality::Hardware));
    CHECK("audio input ring: valid-to-invalid source edge is typed once",
          overflowDomainRing.peek(out, 48000) && out.capture.sequence == 0 &&
              out.capture.sourceFrame ==
                  std::numeric_limits<uint64_t>::max() - 2 &&
              (out.capture.flags & singz::AudioInputSourceFrameValid) == 0 &&
              out.capture.discontinuity ==
                  singz::AudioInputDiscontinuityReason::SourceFrameOverflow);
    overflowDomainRing.consume();
    CHECK("audio input ring: saturated invalid source domain stays quiet",
          overflowDomainRing.peek(out, 48000) && out.capture.sequence == 1 &&
              out.capture.sourceFrame == std::numeric_limits<uint64_t>::max() &&
              (out.capture.flags & singz::AudioInputSourceFrameValid) == 0 &&
              out.capture.discontinuity ==
                  singz::AudioInputDiscontinuityReason::None);
    overflowDomainRing.consume();
  }
  {
    singz::AudioInputDevice device;
    device.uid = "stable-device";
    device.label = "Interface";
    device.sampleRate = 48000;
    device.channels = 16;
    for (int i = 1; i <= 16; ++i) device.channelLabels.push_back("Channel " + std::to_string(i));
    std::string error;
    singz::AudioInputConfig config;
    config.deviceUid = device.uid;
    config.channel = 2;
    CHECK("audio input config: zero-based channel 2 of 16 is valid",
          singz::validateAudioInputConfig(config, {device}, error));
    int32_t mapped = -1;
    CHECK("audio input config: mono map contains exact zero-based lane",
          singz::makeAudioInputChannelMap(2, 16, mapped, error) && mapped == 2);
    CHECK("audio input config: mono map refuses an out-of-bounds lane",
          !singz::makeAudioInputChannelMap(16, 16, mapped, error));
    config.channel = 16;
    CHECK("audio input config: channel count itself is out of bounds",
          !singz::validateAudioInputConfig(config, {device}, error) &&
              error.find("out of range") != std::string::npos);
    config.channel = 2;
    config.ringBlocks = 1;
    CHECK("audio input config: ring bounds are strict",
          !singz::validateAudioInputConfig(config, {device}, error));
    config.ringBlocks = 32;
    config.deviceUid = "other-device";
    CHECK("audio input config: transient index cannot substitute for stable UID",
          !singz::validateAudioInputConfig(config, {device}, error));
  }
  {
    singz::AudioInputDevice fake;
    fake.uid = "fake-input";
    fake.label = "Fake input";
    fake.sampleRate = 48000;
    fake.channels = 4;
    fake.channelLabels = {"One", "Two", "Three", "Four"};
    singz::setAudioInputBackendForTests(fakeAudioInputBackend, {fake});
    singz::AudioInputConfig config;
    config.deviceUid = fake.uid;
    config.channel = 2;

    singz::AudioInput selfStopping;
    std::atomic<int> selfCalls{0};
    std::atomic<bool> ratePublished{false};
    fakeFailureAfter.store(-1);
    fakeNoSleep.store(true);
    const auto selfStopBegan = std::chrono::steady_clock::now();
    const singz::AudioInputResult selfStarted = selfStopping.start(
        config, [&](const singz::AudioInputBlockView& block) {
          ratePublished.store(block.sampleRate == 48000);
          if (selfCalls.fetch_add(1) == 0) selfStopping.stop();
        });
    CHECK("audio input lifecycle: fake backend starts", selfStarted.ok);
    CHECK("audio input lifecycle: sink-triggered stop never self-joins",
          waitForState(selfStopping, singz::AudioInputState::Stopped));
    CHECK("audio input lifecycle: sustained producer self-stop is bounded",
          std::chrono::steady_clock::now() - selfStopBegan < std::chrono::seconds(1));
    CHECK("audio input lifecycle: negotiated rate published before callback",
          ratePublished.load());
    selfStopping.stop();  // joins the already-finished delivery thread
    fakeNoSleep.store(false);

    singz::AudioInput wakeRestart;
    std::atomic<int> saturatedBlocks{0};
    fakeNoSleep.store(true);
    const singz::AudioInputResult saturatedStarted = wakeRestart.start(
        config, [&](const singz::AudioInputBlockView&) {
          if (saturatedBlocks.fetch_add(1) >= 127) wakeRestart.stop();
        });
    CHECK("audio input wake: saturated capture reaches a bounded self-stop",
          saturatedStarted.ok &&
              waitForState(wakeRestart, singz::AudioInputState::Stopped));
    wakeRestart.stop();
    fakeNoSleep.store(false);
    fakeSuppressCallbacks.store(true);
    const singz::AudioInputResult quietRestart = wakeRestart.start(
        config, [](const singz::AudioInputBlockView&) {});
    std::this_thread::sleep_for(std::chrono::milliseconds(30));
    const singz::AudioInputStats quietStats = wakeRestart.stats();
    CHECK("audio input wake: restart has no stale semaphore-token spin",
          quietRestart.ok && quietStats.deliveredBlocks == 0 &&
              quietStats.deliveryWakeups <= 1);
    wakeRestart.stop();
    fakeSuppressCallbacks.store(false);

    singz::AudioInput latencyInput;
    std::vector<double> handoffMs;
    bool rawBlocksUnbatched = true;
    const singz::AudioInputResult latencyStarted = latencyInput.start(
        config, [&](const singz::AudioInputBlockView& block) {
          const uint64_t now = static_cast<uint64_t>(
              std::chrono::duration_cast<std::chrono::nanoseconds>(
                  std::chrono::steady_clock::now().time_since_epoch()).count());
          rawBlocksUnbatched = rawBlocksUnbatched && block.frames == 128;
          if (block.callbackHostTimeNs && now >= block.callbackHostTimeNs)
            handoffMs.push_back(
                static_cast<double>(now - block.callbackHostTimeNs) / 1000000.0);
          if (handoffMs.size() >= 64) latencyInput.stop();
        });
    CHECK("audio input latency: raw hardware blocks start without analysis batching",
          latencyStarted.ok && waitForState(latencyInput, singz::AudioInputState::Stopped) &&
              rawBlocksUnbatched && handoffMs.size() >= 64);
    latencyInput.stop();
    std::sort(handoffMs.begin(), handoffMs.end());
    const double fakeP95 = handoffMs.empty()
                               ? 999
                               : handoffMs[static_cast<size_t>(
                                     std::floor(static_cast<double>(handoffMs.size() - 1) *
                                                0.95))];
    CHECK("audio input latency: polling handoff remains bounded below 10 ms",
          fakeP95 < 10.0);

    singz::AudioInput recursive;
    std::atomic<bool> recursiveRejected{false};
    const singz::AudioInputResult recursiveStarted = recursive.start(
        config, [&](const singz::AudioInputBlockView&) {
          const singz::AudioInputResult nested = recursive.start(
              config, [](const singz::AudioInputBlockView&) {});
          recursiveRejected.store(!nested.ok && nested.error.find("sink") != std::string::npos);
          recursive.stop();
        });
    CHECK("audio input lifecycle: recursive sink start begins outer capture",
          recursiveStarted.ok);
    CHECK("audio input lifecycle: recursive sink start is rejected without deadlock",
          waitForState(recursive, singz::AudioInputState::Stopped) && recursiveRejected.load());
    recursive.stop();

    std::atomic<singz::AudioInput*> ownedFromSink{new singz::AudioInput()};
    std::atomic<bool> destroyedFromSink{false};
    singz::AudioInput* destroyTarget = ownedFromSink.load();
    const singz::AudioInputResult destroyStarted = destroyTarget->start(
        config, [&](const singz::AudioInputBlockView&) {
          singz::AudioInput* owned = ownedFromSink.exchange(nullptr);
          if (owned) delete owned;
          destroyedFromSink.store(true);
        });
    CHECK("audio input lifecycle: callback-owned instance starts", destroyStarted.ok);
    const auto destroyUntil = std::chrono::steady_clock::now() + std::chrono::seconds(1);
    while (!destroyedFromSink.load() && std::chrono::steady_clock::now() < destroyUntil)
      std::this_thread::sleep_for(std::chrono::milliseconds(2));
    CHECK("audio input lifecycle: destruction inside sink is safe and bounded",
          destroyedFromSink.load());
    if (singz::AudioInput* leftover = ownedFromSink.exchange(nullptr)) delete leftover;

    fakeStartFails.store(true);
    singz::AudioInput startFailure;
    const singz::AudioInputResult failedStart = startFailure.start(
        config, [](const singz::AudioInputBlockView&) {});
    CHECK("audio input lifecycle: synchronous backend failure never reports ready",
          !failedStart.ok && failedStart.state == singz::AudioInputState::Error &&
              startFailure.state() == singz::AudioInputState::Error);
    startFailure.stop();
    fakeStartFails.store(false);

    fakeInvalidRate.store(true);
    singz::AudioInput invalidRate;
    const singz::AudioInputResult invalidRateStart = invalidRate.start(
        config, [](const singz::AudioInputBlockView&) {});
    CHECK("audio input lifecycle: non-finite negotiated rate is rejected",
          !invalidRateStart.ok && invalidRateStart.error.find("sample rate") != std::string::npos);
    invalidRate.stop();
    fakeInvalidRate.store(false);

    singz::AudioInput throwing;
    const singz::AudioInputResult throwingStarted = throwing.start(
        config, [](const singz::AudioInputBlockView&) { throw std::runtime_error("sink"); });
    CHECK("audio input lifecycle: throwing sink starts", throwingStarted.ok);
    CHECK("audio input lifecycle: escaping sink exception becomes error state",
          waitForState(throwing, singz::AudioInputState::Error) &&
              throwing.lastError().find("sink threw") != std::string::npos);
    throwing.stop();

    singz::AudioInput unplugged;
    fakeFailureAfter.store(3);
    const singz::AudioInputResult unplugStarted = unplugged.start(
        config, [](const singz::AudioInputBlockView&) {});
    CHECK("audio input lifecycle: simulated unplug starts", unplugStarted.ok);
    CHECK("audio input lifecycle: backend failure reaches core state",
          waitForState(unplugged, singz::AudioInputState::Error) &&
              unplugged.lastError().find("disconnected") != std::string::npos);
    unplugged.stop();

    fakeFailureAfter.store(-1);
    singz::AudioInput raced;
    std::atomic<bool> controllersDone{false};
    std::thread statsReader([&] {
      while (!controllersDone.load()) {
        (void)raced.state();
        (void)raced.stats();
        (void)raced.lastError();
      }
    });
    auto controller = [&] {
      for (int i = 0; i < 20; ++i) {
        (void)raced.start(config, [](const singz::AudioInputBlockView&) {});
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
        raced.stop();
      }
    };
    std::thread controllerA(controller), controllerB(controller);
    controllerA.join();
    controllerB.join();
    controllersDone.store(true);
    statsReader.join();
    raced.stop();
    CHECK("audio input lifecycle: concurrent start/stop/stats settles stopped",
          raced.state() == singz::AudioInputState::Stopped);
    singz::setAudioInputBackendForTests(nullptr, {});
  }
  {
    const int rate = 48000;
    const std::vector<float> tone = sine(440, rate, 4096, 1);
    const singz::LiveInputFrame frame = singz::analyzeLiveInput(tone.data(), tone.size(), rate);
    // Golden values from renderer/audio/pitch.ts::yinPitchInfo over this
    // exact Float32 tone. This holds the native detector's Float32 store
    // boundaries, fixed CMND window and interpolation to the existing mic
    // semantics rather than merely accepting any detector near 440 Hz.
    CHECK("live input analysis: renderer YIN frequency parity",
          std::fabs(frame.frequency - 440.01758519081193) < 1e-5);
    CHECK("live input analysis: renderer YIN clarity parity",
          std::fabs(frame.clarity - 0.9999863087477934) < 1e-7);
    CHECK("live input analysis: renderer RMS parity",
          std::fabs(frame.rms - 0.3533426141796633) < 1e-9);
    CHECK("live input analysis: 440 Hz tone is within one hertz",
          std::fabs(frame.frequency - 440.0) < 1.0);
    CHECK("live input analysis: periodic tone has high clarity", frame.clarity > 0.95);
    CHECK("live input analysis: sine RMS is amplitude/sqrt(2)",
          std::fabs(frame.rms - 0.5 / std::sqrt(2.0)) < 0.001);
    CHECK("live input analysis: dBFS derives from RMS",
          std::fabs(frame.dbfs - 20.0 * std::log10(frame.rms)) < 1e-9);
    std::vector<float> silence(1024, 0);
    const singz::LiveInputFrame quiet =
        singz::analyzeLiveInput(silence.data(), silence.size(), rate);
    CHECK("live input analysis: silence is unvoiced at -120 dBFS",
          quiet.frequency == 0 && quiet.clarity == 0 && quiet.rms == 0 && quiet.dbfs == -120);
    std::vector<float> corrupt = tone;
    corrupt[10] = std::numeric_limits<float>::quiet_NaN();
    corrupt[20] = std::numeric_limits<float>::infinity();
    const singz::LiveInputFrame safe =
        singz::analyzeLiveInput(corrupt.data(), corrupt.size(), rate);
    CHECK("live input analysis: non-finite PCM never escapes as non-finite scalars",
          std::isfinite(safe.frequency) && std::isfinite(safe.clarity) &&
              std::isfinite(safe.rms) && std::isfinite(safe.dbfs));
    constexpr double e2 = 82.4068892282175;
    const std::vector<float> lowTone = sine(e2, rate, 2048, 1);
    const singz::LiveInputFrame low =
        singz::analyzeLiveInput(lowTone.data(), lowTone.size(), rate);
    CHECK("live input analysis: 2048-frame window resolves E2 at 48 kHz",
          std::fabs(low.frequency - e2) < 0.5 && low.clarity > 0.95);

    const int highRate = 192000;
    const std::vector<float> highRateLowTone = sine(e2, highRate, highRate / 5, 1);
    singz::Resampler lowTap(highRate, rate, 1);
    std::vector<float> downsampledLow;
    downsampledLow.reserve(highRateLowTone.size() / 4 + 128);
    for (size_t offset = 0; offset < highRateLowTone.size(); offset += 512) {
      const size_t count = std::min<size_t>(512, highRateLowTone.size() - offset);
      lowTap.process(highRateLowTone.data() + offset,
                     static_cast<int64_t>(count), downsampledLow);
    }
    const size_t settled = 1024;
    singz::LiveInputFrame resampledLow;
    if (downsampledLow.size() >= settled + 2048)
      resampledLow = singz::analyzeLiveInput(
          downsampledLow.data() + settled, 2048, rate);
    CHECK("live input analysis: 192k->48k tap preserves E2",
          downsampledLow.size() >= settled + 2048 &&
              std::fabs(resampledLow.frequency - e2) < 0.5 &&
              resampledLow.clarity > 0.95);
    CHECK("live input analysis: resampler output remains finite",
          std::all_of(downsampledLow.begin(), downsampledLow.end(),
                      [](float sample) { return std::isfinite(sample); }));

    const std::vector<float> ultrasonic = sine(60000, highRate, highRate / 5, 1);
    singz::Resampler aliasTap(highRate, rate, 1);
    std::vector<float> downsampledAlias;
    downsampledAlias.reserve(ultrasonic.size() / 4 + 128);
    for (size_t offset = 0; offset < ultrasonic.size(); offset += 512) {
      const size_t count = std::min<size_t>(512, ultrasonic.size() - offset);
      aliasTap.process(ultrasonic.data() + offset,
                       static_cast<int64_t>(count), downsampledAlias);
    }
    double aliasSquares = 0;
    for (size_t i = settled; i < downsampledAlias.size(); ++i)
      aliasSquares += static_cast<double>(downsampledAlias[i]) *
                      downsampledAlias[i];
    const double aliasRms = std::sqrt(
        aliasSquares /
        static_cast<double>(std::max<size_t>(1, downsampledAlias.size() - settled)));
    CHECK("live input analysis: 192k tap suppresses ultrasonic alias",
          aliasRms < 0.001);
  }
  {
    singz::AudioInput input;
    CHECK("audio input lifecycle: begins idle", input.state() == singz::AudioInputState::Idle);
    if (!singz::audioInputBackendSupported()) {
      singz::AudioInputConfig config;
      config.deviceUid = "none";
      const singz::AudioInputResult result = input.start(config, nullptr);
      CHECK("audio input lifecycle: unsupported platform is explicit",
            !result.ok && result.state == singz::AudioInputState::Unsupported &&
                input.state() == singz::AudioInputState::Unsupported);
      input.stop();
      CHECK("audio input lifecycle: unsupported instance still stops cleanly",
            input.state() == singz::AudioInputState::Stopped);
    } else {
      CHECK("audio input lifecycle: host backend advertises support",
            singz::audioInputBackendSupported());
    }
  }
}

static void resamplerTests() {
  {
    singz::Resampler r(44100, 44100, 2);
    CHECK("identity rate is passthrough", r.passthrough());
  }
  {
    // 48k -> 44.1k, 1 kHz sine: compare against the ideal output sine.
    // Phase is preserved by the polyphase design; skip the warm-up head and
    // the tail, measure SNR over the steady middle.
    const int srcRate = 48000, dstRate = 44100, seconds = 2;
    singz::Resampler r(srcRate, dstRate, 2);
    const auto in = sine(1000.0, srcRate, srcRate * seconds, 2);
    std::vector<float> out;
    r.process(in.data(), srcRate * seconds, out);
    r.flush(out);
    const int outFrames = static_cast<int>(out.size() / 2);
    {
      char label[96];
      std::snprintf(label, sizeof label,
                    "48k->44.1k frame count within the filter tail (delta %d)",
                    outFrames - dstRate * seconds);
      // flush() pushes the filter history through, so up to a tap's worth of
      // extra frames is by design; the engine sizes from the file, not from
      // arithmetic.
      CHECK(label, outFrames >= dstRate * seconds &&
                       outFrames <= dstRate * seconds + 64);
    }

    // Fit A*sin + B*cos at the test frequency over the steady middle — the
    // residual is genuine distortion + aliasing, immune to this harness's
    // guesses about group delay or passband gain (a quarter-sample delay
    // error alone reads as ~37 dB and says nothing about the filter).
    const int head = dstRate / 10, tail = dstRate / 10;
    double ss = 0, sc = 0, cc = 0, ys = 0, yc = 0;
    for (int i = head; i < outFrames - tail; i++) {
      const double ph = 2.0 * M_PI * 1000.0 * i / dstRate;
      const double sn = std::sin(ph), cs = std::cos(ph);
      const double y = out[static_cast<size_t>(i) * 2];
      ss += sn * sn; sc += sn * cs; cc += cs * cs;
      ys += y * sn; yc += y * cs;
    }
    const double det = ss * cc - sc * sc;
    const double A = (ys * cc - yc * sc) / det;
    const double B = (yc * ss - ys * sc) / det;
    double sig = 0, noise = 0;
    for (int i = head; i < outFrames - tail; i++) {
      const double ph = 2.0 * M_PI * 1000.0 * i / dstRate;
      const double fit = A * std::sin(ph) + B * std::cos(ph);
      const double e = out[static_cast<size_t>(i) * 2] - fit;
      sig += fit * fit;
      noise += e * e;
    }
    const double snr = 10.0 * std::log10(sig / (noise > 0 ? noise : 1e-30));
    char label[96];
    std::snprintf(label, sizeof label, "in-band sine SNR > 90 dB (measured %.1f dB)", snr);
    CHECK(label, snr > 90.0);
    const double gain = std::sqrt(A * A + B * B) / 0.5;
    std::snprintf(label, sizeof label, "passband gain within 0.1 dB (%.4f)", gain);
    CHECK(label, gain > 0.9886 && gain < 1.0116);
  }
  {
    // 44.1k -> 22.05k, the Beat This! input path: a DECIMATION, where the
    // filter actually has to work. The 1 kHz/48k->44.1k check above is
    // nearly unity ratio and cannot see a short filter — it read 110 dB while
    // the 2:1 case was a 24-tap lowpass aliasing 14 kHz back at -25 dB
    // (measured; cymbals onto the band the beat model listens to, a
    // different grid from the same stems). Gate the alias floor and the
    // passband edge, not a tone that sits comfortably in the middle.
    const int srcRate = 44100, dstRate = 22050, seconds = 2;
    auto gainAt = [&](double hz) {
      singz::Resampler r(srcRate, dstRate, 1);
      const auto in = sine(hz, srcRate, srcRate * seconds, 1);
      std::vector<float> out;
      r.process(in.data(), srcRate * seconds, out);
      r.flush(out);
      const int n = static_cast<int>(out.size()), head = dstRate / 10, tail = dstRate / 10;
      // above the new Nyquist a tone lands at its alias
      const double f = hz < dstRate / 2.0 ? hz : std::fabs(hz - dstRate);
      double ss = 0, sc = 0, cc = 0, ys = 0, yc = 0;
      for (int i = head; i < n - tail; i++) {
        const double ph = 2.0 * M_PI * f * i / dstRate, sn = std::sin(ph), cs = std::cos(ph),
                     y = out[static_cast<size_t>(i)];
        ss += sn * sn; sc += sn * cs; cc += cs * cs; ys += y * sn; yc += y * cs;
      }
      const double det = ss * cc - sc * sc, A = (ys * cc - yc * sc) / det, B = (yc * ss - ys * sc) / det;
      return 20.0 * std::log10(std::sqrt(A * A + B * B) / 0.5);
    };
    char label[128];
    const double g9k = gainAt(9000.0), g10k = gainAt(10000.0), a14k = gainAt(14000.0), a12k = gainAt(12000.0);
    // The decimating design is swresample's published one (32 taps/net
    // decimation, beta 9, cutoff 0.97) — adopted by GT measurement over the
    // old brick wall (resample.cpp says why). Its passband edge droops like
    // the winner's: ffmpeg-swr itself measures -0.01 dB at 9 kHz and
    // -1.29 dB at 10 kHz on this exact ratio, and our port sits within
    // 0.11 dB of that. Gate the shape we adopted, not the wall we left.
    std::snprintf(label, sizeof label, "2:1 passband flat to 9 kHz (%.2f dB)", g9k);
    CHECK(label, g9k > -0.15);
    std::snprintf(label, sizeof label, "2:1 edge at 10 kHz within swr's droop (%.2f dB)", g10k);
    CHECK(label, g10k > -2.0 && g10k < -0.7);
    std::snprintf(label, sizeof label, "2:1 alias of 14 kHz below -60 dB (%.1f dB)", a14k);
    CHECK(label, a14k < -60.0);
    std::snprintf(label, sizeof label, "2:1 alias of 12 kHz below -30 dB (%.1f dB)", a12k);
    CHECK(label, a12k < -30.0);
  }
  {
    // Streaming in blocks must equal one-shot processing byte for byte —
    // the history rebase is exactly the thing that can go quietly wrong.
    const int srcRate = 22050, dstRate = 44100;
    const auto in = sine(440.0, srcRate, srcRate, 2);
    singz::Resampler oneShot(srcRate, dstRate, 2);
    std::vector<float> a;
    oneShot.process(in.data(), srcRate, a);
    oneShot.flush(a);
    singz::Resampler streamed(srcRate, dstRate, 2);
    std::vector<float> b;
    const int block = 1024;
    for (int at = 0; at < srcRate; at += block) {
      const int n = std::min(block, srcRate - at);
      streamed.process(in.data() + static_cast<size_t>(at) * 2, n, b);
    }
    streamed.flush(b);
    bool same = a.size() == b.size();
    for (size_t i = 0; same && i < a.size(); i++) same = a[i] == b[i];
    CHECK("streamed == one-shot, bit for bit", same);
  }
}

static std::vector<unsigned char> slurp(const std::string& path) {
  std::vector<unsigned char> out;
  std::FILE* f = std::fopen(path.c_str(), "rb");
  if (!f) return out;
  std::fseek(f, 0, SEEK_END);
  out.resize(static_cast<size_t>(std::ftell(f)));
  std::fseek(f, 0, SEEK_SET);
  if (!out.empty() && std::fread(out.data(), 1, out.size(), f) != out.size()) out.clear();
  std::fclose(f);
  return out;
}

static void wavTests() {
  const std::string path = scratchDir() + "/singz-core-host-test.wav";
  std::remove(path.c_str());
  {
    // Golden bytes: header fields + lrintf scaling, including the clamp.
    singz::WavWriter w;
    CHECK("fresh open", w.open(path, 44100, 2));
    const float frames[8] = {0.0f, 0.5f, -0.5f, 1.0f, -1.0f, 2.0f, -2.0f, 0.25f};
    CHECK("write 4 frames", w.append(frames, 4));
    CHECK("finalize", w.finalize());
    CHECK("finalize twice is fine", w.finalize());
    const auto b = slurp(path);
    CHECK("file is 44 + 16 bytes", b.size() == 60);
    CHECK("RIFF/WAVE/fmt/data markers",
          !std::memcmp(&b[0], "RIFF", 4) && !std::memcmp(&b[8], "WAVE", 4) &&
          !std::memcmp(&b[12], "fmt ", 4) && !std::memcmp(&b[36], "data", 4));
    auto u32 = [&](size_t at) {
      return static_cast<uint32_t>(b[at]) | (static_cast<uint32_t>(b[at + 1]) << 8) |
             (static_cast<uint32_t>(b[at + 2]) << 16) | (static_cast<uint32_t>(b[at + 3]) << 24);
    };
    auto s16 = [&](size_t frame, int ch) {
      const size_t at = 44 + (frame * 2 + static_cast<size_t>(ch)) * 2;
      return static_cast<int16_t>(static_cast<uint16_t>(b[at]) |
                                  (static_cast<uint16_t>(b[at + 1]) << 8));
    };
    CHECK("RIFF size", u32(4) == 52);
    CHECK("sample rate 44100", u32(24) == 44100);
    CHECK("byte rate", u32(28) == 44100u * 4u);
    CHECK("data size 16", u32(40) == 16);
    CHECK("0.0 -> 0", s16(0, 0) == 0);
    CHECK("0.5 -> 16384 (lrintf, not truncation)", s16(0, 1) == 16384);
    CHECK("-0.5 -> -16384", s16(1, 0) == -16384);
    CHECK("1.0 -> 32767", s16(1, 1) == 32767);
    CHECK("-1.0 -> -32767 (symmetric scale)", s16(2, 0) == -32767);
    CHECK("+2.0 clamps to 32767", s16(2, 1) == 32767);
    CHECK("-2.0 clamps to -32768 (the desktop renderer's floor)", s16(3, 0) == -32768);
    CHECK("0.25 -> 8192", s16(3, 1) == 8192);
  }
  {
    // Append-resume: reopen claiming 4 existing frames, add 2, and the
    // header must account for all 6.
    singz::WavWriter w;
    CHECK("append open with matching size", w.open(path, 44100, 2, 4));
    const float more[4] = {0.25f, 0.25f, -0.25f, -0.25f};
    CHECK("append 2 frames", w.append(more, 2));
    CHECK("flush is callable", w.flush());
    CHECK("finalize appended", w.finalize());
    const auto b = slurp(path);
    CHECK("6 frames on disk", b.size() == 44 + 24);
    auto u32 = [&](size_t at) {
      return static_cast<uint32_t>(b[at]) | (static_cast<uint32_t>(b[at + 1]) << 8) |
             (static_cast<uint32_t>(b[at + 2]) << 16) | (static_cast<uint32_t>(b[at + 3]) << 24);
    };
    // The header must ACCOUNT for the pre-existing frames, not just the
    // appended ones — dropping existingFrames in open() would still pass a
    // bare size check.
    CHECK("RIFF size counts all 6 frames", u32(4) == 60);
    CHECK("data size counts all 6 frames", u32(40) == 24);
  }
  {
    // The size backstop: a tail claiming more frames than the file holds
    // must refuse the append (the engine then falls back to a fresh start).
    singz::WavWriter w;
    CHECK("append open with an overstated tail refuses", !w.open(path, 44100, 2, 100));
  }
  std::remove(path.c_str());
}

// The melody tracker (melody.cpp) — a synthetic phrase with known pitches
// comes back at those pitches, voiced where sung and silent in the rest,
// and the WAV reader feeds it the same samples the raw path gets. The
// bit-parity claim against the desktop TS is NOT provable here (it needs
// node): eval/melody-parity.mjs runs singz-analyze against trackMelodyCore
// over real stems, and mobile/tests asserts it on device.
static void melodyTests() {
  const int sr = 44100;
  const int frames = sr * 6;
  std::vector<float> mono(static_cast<size_t>(frames), 0.0f);
  // 2 s of A3 (220 Hz), 1 s of rest, 2 s of E4 (329.63 Hz), 1 s of rest —
  // with a touch of second harmonic so it looks like a voice to CMND.
  double ph = 0;
  for (int i = 0; i < frames; i++) {
    const double t = static_cast<double>(i) / sr;
    double hz = 0;
    if (t < 2) hz = 220;
    else if (t >= 3 && t < 5) hz = 329.63;
    if (hz > 0) {
      ph += 2 * M_PI * hz / sr;
      mono[static_cast<size_t>(i)] = static_cast<float>(0.3 * std::sin(ph) + 0.05 * std::sin(2 * ph));
    }
  }
  const singz::MelodyTrack t = singz::trackMelody(mono.data(), mono.size(), sr, nullptr);
  CHECK("melody: hop is 25 ms of the decimated rate", std::fabs(t.hopSec - 368.0 / 14700.0) < 1e-12);
  CHECK("melody: one frame per hop over the song", t.f0.size() == static_cast<size_t>((frames / 3 - 1024) / 368));
  auto median = [&](double t0, double t1) {
    std::vector<double> v;
    for (size_t i = 0; i < t.f0.size(); i++) {
      const double tt = static_cast<double>(i) * t.hopSec;
      if (tt >= t0 && tt < t1 && t.f0[i] > 0) v.push_back(t.f0[i]);
    }
    if (v.empty()) return 0.0;
    std::sort(v.begin(), v.end());
    return v[v.size() / 2];
  };
  auto voicedFrac = [&](double t0, double t1) {
    int n = 0, v = 0;
    for (size_t i = 0; i < t.f0.size(); i++) {
      const double tt = static_cast<double>(i) * t.hopSec;
      if (tt >= t0 && tt < t1) {
        n++;
        if (t.f0[i] > 0) v++;
      }
    }
    return n ? static_cast<double>(v) / n : 0.0;
  };
  const double a3 = median(0.2, 1.8), e4 = median(3.2, 4.8);
  CHECK("melody: A3 phrase tracked within 2 cents", a3 > 0 && std::fabs(1200 * std::log2(a3 / 220)) < 2);
  CHECK("melody: E4 phrase tracked within 2 cents", e4 > 0 && std::fabs(1200 * std::log2(e4 / 329.63)) < 2);
  CHECK("melody: sung stretches are voiced", voicedFrac(0.2, 1.8) > 0.95 && voicedFrac(3.2, 4.8) > 0.95);
  CHECK("melody: rests are silent (RMS gate)", voicedFrac(2.2, 2.9) < 0.05 && voicedFrac(5.2, 5.9) < 0.05);

  // The reader: write the phrase as PCM16 stereo (the split's own format),
  // read it back mono, track — same pitches; and the fold matches the JS
  // fold to the bit on a stereo pair (L != R).
  const std::string path = scratchDir() + "/singz-melody-test.wav";
  {
    singz::WavWriter w;
    CHECK("reader: fixture written", w.open(path, sr, 2));
    std::vector<float> st(static_cast<size_t>(frames) * 2);
    for (int i = 0; i < frames; i++) {
      st[static_cast<size_t>(i) * 2] = mono[static_cast<size_t>(i)];
      st[static_cast<size_t>(i) * 2 + 1] = mono[static_cast<size_t>(i)] * 0.5f;
    }
    w.append(st.data(), frames);
    w.finalize();
  }
  const singz::MonoWav r = singz::readWavMono(path);
  CHECK("reader: PCM16 stereo read", r.ok && r.sampleRate == sr && r.channels == 2 && r.samples.size() == static_cast<size_t>(frames));
  if (r.ok) {
    // JS fold of the same PCM16 pair — ((0 + L/2) as f32 + R/2) as f32 with
    // L, R = s / 32768 — computed from the shorts ON DISK (the writer's own
    // 44-byte header, then interleaved int16), so this checks the reader's
    // fold and nothing about the writer's rounding.
    bool foldOk = true;
    std::FILE* f = std::fopen(path.c_str(), "rb");
    if (f != nullptr) {
      std::fseek(f, 44, SEEK_SET);
      std::vector<int16_t> pcm(static_cast<size_t>(frames) * 2);
      const size_t got = std::fread(pcm.data(), sizeof(int16_t), pcm.size(), f);
      std::fclose(f);
      if (got != pcm.size()) foldOk = false;
      for (int i = 0; i < frames && foldOk; i += 997) {
        const double L = pcm[static_cast<size_t>(i) * 2] / 32768.0;
        const double R = pcm[static_cast<size_t>(i) * 2 + 1] / 32768.0;
        const float js = static_cast<float>(static_cast<double>(static_cast<float>(0 + L / 2)) + R / 2);
        if (js != r.samples[static_cast<size_t>(i)]) foldOk = false;
      }
    } else {
      foldOk = false;
    }
    CHECK("reader: channel fold matches the JS fold to the bit", foldOk);
    const singz::MelodyTrack t2 = singz::trackMelody(r.samples.data(), r.samples.size(), r.sampleRate, nullptr);
    CHECK("reader→tracker: same frame count", t2.f0.size() == t.f0.size());
  }
  // The header alone says the same, without reading a sample.
  const singz::WavInfo info = singz::readWavInfo(path);
  CHECK("reader: header-only info matches", info.ok && info.sampleRate == sr && info.channels == 2 && info.frames == frames);
  // A header that lies about its size (streaming encoders write 0xFFFFFFFF;
  // a truncated file states more than it holds) must clamp to the bytes on
  // disk, never allocate what it claims.
  {
    std::FILE* f = std::fopen(path.c_str(), "r+b");
    if (f != nullptr) {
      const unsigned char huge[4] = {0xFF, 0xFF, 0xFF, 0xFF};
      std::fseek(f, 40, SEEK_SET);  // canonical header: data size at 40
      std::fwrite(huge, 1, 4, f);
      std::fclose(f);
    }
    const singz::WavInfo lying = singz::readWavInfo(path);
    CHECK("reader: a lying data size clamps to the file", lying.ok && lying.frames == frames);
    const singz::MonoWav r2 = singz::readWavMono(path);
    CHECK("reader: and reads what is there", r2.ok && r2.samples.size() == static_cast<size_t>(frames));
  }
  std::remove(path.c_str());
}

// The key detector (analysis.cpp): a synthetic C-major triad bed comes back
// as C major, and a silent bed has no answer at all. The bit-parity claim
// against the desktop TS lives in eval/key-parity.mjs (node-side, over real
// projects) — this is the shape check that runs with no corpus.
static void keyTests() {
  const int sr = 44100;
  const int frames = sr * 12;
  auto tone = [&](double hz, std::vector<float>& out, double amp) {
    double ph = 0;
    for (int i = 0; i < frames; i++) {
      ph += 2 * M_PI * hz / sr;
      out[static_cast<size_t>(i)] += static_cast<float>(amp * std::sin(ph));
    }
  };
  // C major: C3 (130.81), E3 (164.81), G3 (196.00), with C2 in the bass.
  singz::AnalysisStem inst;
  inst.mono.assign(static_cast<size_t>(frames), 0.0f);
  inst.sampleRate = sr;
  tone(130.81, inst.mono, 0.25);
  tone(164.81, inst.mono, 0.20);
  tone(196.00, inst.mono, 0.22);
  singz::AnalysisStem bass;
  bass.mono.assign(static_cast<size_t>(frames), 0.0f);
  bass.sampleRate = sr;
  tone(65.41, bass.mono, 0.30);
  const singz::KeyGuess k = singz::estimateKeyFromStems({inst}, &bass);
  CHECK("key: a C-major triad bed reads as C major", k.ok && k.pc == 0 && !k.minor);
  CHECK("key: stamp is the TS's KEY_DETECT_VERSION", singz::kKeyDetectVersion == 2);

  singz::AnalysisStem silent;
  silent.mono.assign(static_cast<size_t>(frames), 0.0f);
  silent.sampleRate = sr;
  const singz::KeyGuess q = singz::estimateKeyFromStems({silent}, nullptr);
  CHECK("key: a silent bed has no answer (never a stored key)", !q.ok);

  // Too little audio to judge: fewer than 8 chroma frames is the TS's floor.
  singz::AnalysisStem tiny;
  tiny.mono.assign(16384 * 4, 0.1f);
  tiny.sampleRate = sr;
  CHECK("key: too short to judge answers nothing", !singz::estimateKeyFromStems({tiny}, nullptr).ok);

  // estimateKey — the melody-histogram fallback. Nothing in the app reaches
  // it yet (the phone shows no key readout), so without this it would be a
  // ported detector with no coverage at all, which is where a parity defect
  // waits until the day it is wired up. A C-major scale weighted toward the
  // tonic reads C major; under 100 voiced frames there is no answer.
  {
    const double scale[7] = {261.63, 293.66, 329.63, 349.23, 392.00, 440.00, 493.88};  // C D E F G A B
    std::vector<float> f0;
    for (int rep = 0; rep < 40; rep++)
      for (int i = 0; i < 7; i++) {
        // The tonic and dominant held longer, as a real melody does — a flat
        // histogram has no key and the correlation would pick arbitrarily.
        const int hold = (i == 0 || i == 4) ? 4 : 2;
        for (int h = 0; h < hold; h++) f0.push_back(static_cast<float>(scale[i]));
      }
    const singz::KeyGuess mk = singz::estimateKey(f0.data(), f0.size());
    CHECK("key: a C-major melody histogram reads as C major", mk.ok && mk.pc == 0 && !mk.minor);
    CHECK("key: under 100 voiced frames there is no answer",
          !singz::estimateKey(f0.data(), 99).ok);
  }
}

// The beat tracker's front end (beats.cpp): a synthetic click train at a
// known tempo is found at that tempo and not at an octave of it, and material
// with no impulsive onsets is refused rather than given a metronome. The
// bit-parity claim against the desktop TS lives in eval/beats-parity.mjs,
// which compares stage by stage over real stems.
static void beatsTests() {
  const int sr = 44100;
  const int frames = sr * 30;
  singz::AnalysisStem drums;
  drums.mono.assign(static_cast<size_t>(frames), 0.0f);
  drums.sampleRate = sr;
  // 120 bpm: a click every 0.5 s, accented every fourth.
  const double period = 0.5 * sr;
  for (int b = 0; b * period < frames - 400; b++) {
    const int st = static_cast<int>(std::lrint(b * period));
    const double amp = (b % 4 == 0) ? 0.95 : 0.6;
    for (int i = 0; i < 300; i++)
      drums.mono[static_cast<size_t>(st + i)] += static_cast<float>(amp * std::exp(-i / 30.0) * std::sin(i * 0.5));
  }
  singz::BeatDebug d;
  const singz::DrumLattice lat = singz::trackFromDrums(drums, {}, d);
  const bool ok = lat.ok;
  CHECK("beats: a 120 bpm click train is tracked", ok);
  CHECK("beats: at 120 bpm, not an octave of it",
        ok && std::fabs(d.chosenBpm - 120) < 2.0);
  CHECK("beats: the windows agree (not rubato)", ok && d.consistency >= 0.6);
  CHECK("beats: the lattice has a beat every ~0.5 s", ok && std::fabs(lat.medSec - 0.5) < 0.02 &&
        lat.beatsSec.size() > 50);
  CHECK("beats: stamp is the TS's BEAT_DETECT_VERSION", singz::kBeatDetectVersion == 23);

  // The meter test: a straight 4/4 click train must NOT read as compound.
  // (Its 6/8 counterpart is a library fact rather than a synthesis one —
  // Nothing Else Matters measures ac3/ac4 = 2.61 and comes out 6, which the
  // parity harness checks against the TS on the real stem.)
  singz::BeatAux noAux;
  // MlPhaseCtx{} is "no model on this device" — every field then reads as the
  // TS reads an absent aux.ml, which is the path this fixture is about.
  const singz::BarPhase phase = singz::barPhase(lat, drums, noAux, singz::MlPhaseCtx{}, d);
  CHECK("beats: a straight click train is 4/4, not compound", phase.ok && phase.beatsPerBar == 4);
  CHECK("beats: and its beats are nearly all active", phase.ok && d.activeBeats > 50);

  // A sustained pad has periodicity but no attacks — it must be refused.
  singz::AnalysisStem pad;
  pad.mono.assign(static_cast<size_t>(frames), 0.0f);
  pad.sampleRate = sr;
  double ph = 0;
  for (int i = 0; i < frames; i++) {
    ph += 2 * M_PI * 220 / sr;
    pad.mono[static_cast<size_t>(i)] = static_cast<float>(0.3 * std::sin(ph));
  }
  singz::BeatDebug pd;
  CHECK("beats: a sustained pad earns no metronome", !singz::trackFromDrums(pad, {}, pd).ok);
  CHECK("beats: and says why", !pd.reject.empty());
}

// sumStemsTo22k (beat_this.cpp) — the from-stems ML input. The resampler's
// QUALITY is gated above; these gate the wiring around it: the pad-to-max
// sum, the 44.1 kHz refusal, and that the whole path equals Resampler(sum) —
// so a future "optimisation" that resamples per stem, drops the tail flush
// or truncates to the shortest stem turns a light red here instead of a
// slightly different grid on a phone.
static void sumStemsTests() {
  const std::string a = scratchDir() + "/singz-core-host-sum-a.wav";
  const std::string b = scratchDir() + "/singz-core-host-sum-b.wav";
  // Quarters survive the writer/reader pair exactly (0.25 -> 8192 -> 0.25:
  // the writer scales by 32767 with lrintf, the reader divides by 32768), so
  // the sum below is checked with == and not a tolerance.
  const int an = 1200;
  const int bn = 700;  // shorter: the tail of `a` must arrive unsummed
  std::vector<float> av(an), bv(bn);
  for (int i = 0; i < an; i++) av[static_cast<size_t>(i)] = (i % 2 == 0) ? 0.25f : -0.5f;
  for (int i = 0; i < bn; i++) bv[static_cast<size_t>(i)] = (i % 3 == 0) ? 0.5f : -0.25f;
  {
    singz::WavWriter w;
    w.open(a, 44100, 1);
    w.append(av.data(), an);
    w.finalize();
  }
  {
    singz::WavWriter w;
    w.open(b, 44100, 1);
    w.append(bv.data(), bn);
    w.finalize();
  }

  std::string err;
  const std::vector<float> got = singz::sumStemsTo22k({a, b}, err);
  CHECK("two stems sum without error", err.empty());

  // The reference: hand-sum (padding b with silence), the equal-power gain,
  // then the very Resampler the function is contracted to use, made
  // time-true the same way — latency dropped, tail cut to inLen/2. The
  // contract this pins moved twice by measurement (beat_this.cpp says why):
  // the model's input is sample i == the song at i/22050 s, at -3 dB
  // pan-law level.
  std::vector<float> mix(static_cast<size_t>(an), 0.0f);
  for (int i = 0; i < an; i++) mix[static_cast<size_t>(i)] += av[static_cast<size_t>(i)];
  for (int i = 0; i < bn; i++) mix[static_cast<size_t>(i)] += bv[static_cast<size_t>(i)];
  for (float& v : mix) v *= 1.4142135623730951f;
  singz::Resampler rs(44100, singz::kBeatThisSr, 1);
  std::vector<float> want;
  rs.process(mix.data(), an, want);
  rs.flush(want);
  const size_t latency = static_cast<size_t>(rs.latencyOutFrames());
  if (want.size() > latency) want.erase(want.begin(), want.begin() + static_cast<long>(latency));
  if (want.size() > static_cast<size_t>(an) / 2) want.resize(static_cast<size_t>(an) / 2);
  bool same = got.size() == want.size();
  for (size_t i = 0; same && i < got.size(); i++) same = got[i] == want[i];
  CHECK("sum+decimate == Resampler(hand-sum), time-true", same);
  // Exactly half the frames now: latency dropped at the head, the flush
  // tail cut at inLen/2 — time-true output has no filter overhang. A
  // missing flush() would come up short and fail the identity check above.
  CHECK("output is exactly half the frames (time-true)",
        got.size() == static_cast<size_t>(an / 2));

  // Refusals say why, with the path in the message.
  const std::vector<float> none = singz::sumStemsTo22k({}, err);
  CHECK("no stems is an error", !err.empty() && none.empty());
  const std::vector<float> gone = singz::sumStemsTo22k({scratchDir() + "/singz-no-such-stem.wav"}, err);
  CHECK("a missing stem names itself", !err.empty() && gone.empty() &&
        err.find("singz-no-such-stem") != std::string::npos);
  {
    singz::WavWriter w;
    w.open(b, 48000, 1);
    w.append(bv.data(), bn);
    w.finalize();
  }
  const std::vector<float> wrong = singz::sumStemsTo22k({a, b}, err);
  CHECK("a 48 kHz stem is refused, not resampled", !err.empty() && wrong.empty() &&
        err.find("48000") != std::string::npos);

  std::remove(a.c_str());
  std::remove(b.c_str());
}

// The core's FLAC path (Phase 5, docs/PHONE-STANDALONE.md): what these hold
// is that a FLAC stem answers IDENTICALLY to the WAV it was encoded from —
// same samples, same fold, through the same readWavMono the detectors call —
// so a compacted project's grid cannot drift from its own pre-compact grid.
// Losslessness alone does not give that: the mono fold squeezes the running
// sum through float32 per channel, and a FLAC path that folded in double
// would differ in the last bit while every byte on disk was correct.
static void flacTests() {
  const std::string dir = scratchDir();
  const std::string wav = dir + "/singz-flac-io-test.wav";
  const std::string wavKeep = dir + "/singz-flac-io-keep.wav";
  const std::string flac = dir + "/singz-flac-io-test.flac";
  std::remove(wav.c_str());
  std::remove(wavKeep.c_str());
  std::remove(flac.c_str());

  // Two seconds of full-range stereo: tones plus deterministic noise, values
  // that exercise both channels differently so the fold has work to do.
  const int rate = 44100, frames = 2 * rate;
  std::vector<float> pcm(static_cast<size_t>(frames) * 2);
  unsigned seed = 424242u;
  for (int i = 0; i < frames; i++) {
    seed = seed * 1103515245u + 12345u;
    const double t = static_cast<double>(i) / rate;
    pcm[static_cast<size_t>(i) * 2] =
        static_cast<float>(0.5 * std::sin(2 * M_PI * 220.0 * t) +
                           0.05 * (static_cast<int16_t>(seed >> 16) / 32768.0));
    pcm[static_cast<size_t>(i) * 2 + 1] =
        static_cast<float>(0.4 * std::sin(2 * M_PI * 333.0 * t + 0.7));
  }
  {
    singz::WavWriter w;
    w.open(wav, rate, 2);
    w.append(pcm.data(), frames);
    w.finalize();
  }
  {
    singz::WavWriter w;  // a copy compactStem will not eat, for the comparison
    w.open(wavKeep, rate, 2);
    w.append(pcm.data(), frames);
    w.finalize();
  }

  // The upgrade's own op writes the FLAC (level 5, verify on, .part rename).
  const singz::CompactResult enc = singz::compactStem(wav, flac);
  CHECK("compactStem encodes a canonical stem", enc.ok && !enc.skipped && enc.bytes > 0);
  CHECK("…and the wav is gone afterwards", std::fopen(wav.c_str(), "rb") == nullptr);
  {
    std::FILE* pf = std::fopen((flac + ".part").c_str(), "rb");
    CHECK("…and no .part is left behind", pf == nullptr);
    if (pf != nullptr) std::fclose(pf);
  }

  // Idempotence: the kill-between-rename-and-unlink state heals itself.
  {
    singz::WavWriter w;
    w.open(wav, rate, 2);
    w.append(pcm.data(), frames);
    w.finalize();
  }
  const singz::CompactResult again = singz::compactStem(wav, flac);
  CHECK("a re-run with the flac already there skips and removes the wav",
        again.ok && again.skipped && std::fopen(wav.c_str(), "rb") == nullptr);

  // THE parity check: the FLAC through readWavMono — magic dispatch, not the
  // suffix — equals the WAV, sample for sample, no tolerance.
  const singz::MonoWav a = singz::readWavMono(wavKeep);
  const singz::MonoWav b = singz::readWavMono(flac);
  CHECK("both readers report ok", a.ok && b.ok);
  CHECK("same length", a.samples.size() == b.samples.size());
  size_t bad = 0, firstBad = 0;
  for (size_t i = 0; i < std::min(a.samples.size(), b.samples.size()); i++)
    if (a.samples[i] != b.samples[i]) {
      if (bad == 0) firstBad = i;
      bad++;
    }
  if (bad > 0)
    std::printf("      %zu samples differ; first at %zu: % .9f vs % .9f\n", bad, firstBad,
                static_cast<double>(a.samples[firstBad]), static_cast<double>(b.samples[firstBad]));
  CHECK("FLAC folds to the SAME mono as its source WAV, bit for bit", bad == 0 && a.ok && b.ok);

  // readWavInfo answers off STREAMINFO, no samples read.
  const singz::WavInfo wi = singz::readWavInfo(wavKeep);
  const singz::WavInfo fi = singz::readWavInfo(flac);
  CHECK("info: rate/channels/frames agree across the formats",
        wi.ok && fi.ok && wi.sampleRate == fi.sampleRate && wi.channels == fi.channels &&
            wi.frames == fi.frames);

  // The dispatch trusts magic, not names: the same FLAC bytes under a .wav
  // name still decode (a copied file wearing the wrong suffix answers
  // plausibly-and-wrong if the suffix decides).
  const std::string lie = dir + "/singz-flac-io-lie.wav";
  std::remove(lie.c_str());
  {
    std::FILE* in = std::fopen(flac.c_str(), "rb");
    std::FILE* outF = std::fopen(lie.c_str(), "wb");
    char buf[65536];
    size_t n;
    while ((n = std::fread(buf, 1, sizeof buf, in)) > 0) std::fwrite(buf, 1, n, outF);
    std::fclose(in);
    std::fclose(outF);
  }
  const singz::MonoWav c = singz::readWavMono(lie);
  CHECK("a FLAC named .wav decodes by magic, identically",
        c.ok && c.samples.size() == b.samples.size() &&
            std::memcmp(c.samples.data(), b.samples.data(),
                        b.samples.size() * sizeof(float)) == 0);

  // And a stem that is neither is an error, not a guess.
  const singz::CompactResult junk = singz::compactStem(lie, dir + "/singz-flac-io-junk.flac");
  CHECK("compactStem refuses a non-PCM16 source", !junk.ok);

  std::remove(wavKeep.c_str());
  std::remove(flac.c_str());
  std::remove(lie.c_str());
}

int main() {
  audioInputConversionTests();
  audioInputTests();
  audioInputAnalysisAdapterTests();
  androidAudioInputPresetPolicyTests();
  audioInputCallbackGateTests();
  audioInputCallbackEndpointTests();
  audioInputSpscStressTests();
  audioInputWakePublicationStressTests();
  audioInputCallbackQuiescenceTests();
  audioInputTimestampTests();
  resamplerTests();
  wavTests();
  flacTests();
  melodyTests();
  keyTests();
  beatsTests();
  sumStemsTests();
  std::printf(failures == 0 ? "\nALL CORE HOST TESTS PASS\n" : "\n%d FAILURE(S)\n", failures);
  return failures == 0 ? 0 : 1;
}

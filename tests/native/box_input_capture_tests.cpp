#include "native/playback/box_input_capture.h"
#include "native/playback/box_input_queue.h"
#include <zdsp/analysis/capture_adapter.h>
#include "native/playback/box_input_read_schedule.h"
#include "native/playback/box_routing_owner.h"
#include "native/playback/shared_audio_service.h"
#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <loopz/document_json.hpp>
#include <loopz/audio_history.hpp>
#include <memory>
#include <new>
#include <limits>
#include <string>
#include <thread>
#include <unistd.h>
#include <zcore/device/audio_input_backend.h>

namespace {
thread_local bool trackSparseHeap = false;
thread_local uint64_t sparseHeapEvents = 0;
}
// TSan supplies strong new/delete interceptors. Keep the allocation probe in
// ordinary/ASan builds; all behavioral and concurrency checks still run in TSan.
#if defined(__has_feature)
#if __has_feature(thread_sanitizer)
#define SINGZ_BOX_INPUT_TSAN 1
#endif
#endif
#if !defined(__SANITIZE_THREAD__) && !defined(SINGZ_BOX_INPUT_TSAN)
void* operator new(std::size_t bytes) {
  if (trackSparseHeap) ++sparseHeapEvents;
  if (auto* value = std::malloc(bytes ? bytes : 1)) return value;
  throw std::bad_alloc();
}
void* operator new[](std::size_t bytes) { return ::operator new(bytes); }
void operator delete(void* value) noexcept {
  if (trackSparseHeap && value) ++sparseHeapEvents;
  std::free(value);
}
void operator delete[](void* value) noexcept { ::operator delete(value); }
void operator delete(void* value, std::size_t) noexcept { ::operator delete(value); }
void operator delete[](void* value, std::size_t) noexcept { ::operator delete(value); }

#endif

#define CHECK(v)                                                               \
  do {                                                                         \
    if (!(v)) {                                                                \
      std::fprintf(stderr, "failed %d: %s\n", __LINE__, #v);                   \
      std::abort();                                                            \
    }                                                                          \
  } while (false)
namespace {
using namespace singz;
using Clock = std::chrono::steady_clock;
constexpr uint32_t kChannels = 10, kFrames = 256, kRate = 48000;
uint64_t nowNs() {
  return std::chrono::duration_cast<std::chrono::nanoseconds>(
             Clock::now().time_since_epoch())
      .count();
}
uint64_t frameNs(uint64_t frame) { return frame * 1000000000ull / kRate; }
void scheduleRecoversJitterWithoutReset() {
  BoxInputReadSchedule schedule;
  constexpr uint64_t base = 480000; // exact 256-frame boundary, ten seconds
  const auto at = [](uint64_t frame) {
    return loopz::frameNs(frame, kRate) + 1;
  };
  uint64_t expected = base;
  unsigned reanchors = 0;
  const auto consume = [&](const BoxInputReadSchedule::Batch &batch) {
    CHECK(batch.plan.valid && batch.plan.blocks > 0 && batch.plan.blocks <= 4);
    if (batch.discontinuity()) {
      CHECK(batch.plan.skippedFrames > 0);
      CHECK(batch.plan.firstFrame == expected + batch.plan.skippedFrames);
      ++reanchors;
    } else {
      CHECK(batch.plan.skippedFrames == 0 && batch.plan.firstFrame == expected);
    }
    for (uint32_t index = 0; index < batch.plan.blocks; ++index) {
      CHECK(batch.sampleHostTimeNs(index) ==
            loopz::frameNs(batch.plan.firstFrame + uint64_t(index) * kFrames -
                               BoxInputReadSchedule::historyLookbackFrames,
                           kRate));
    }
    expected = batch.plan.firstFrame + uint64_t(batch.plan.blocks) * kFrames;
  };
  const auto first = schedule.step(at(base));
  consume(first);
  CHECK(!first.discontinuity());
  const auto halfBlockLate = schedule.step(at(base + kFrames + kFrames / 2));
  consume(halfBlockLate);
  CHECK(!halfBlockLate.discontinuity());
  const auto twoBlocksLate = schedule.step(at(base + 4 * kFrames));
  consume(twoBlocksLate);
  // Negative-control oracle: the former any-lateness reset policy would flag
  // this already-due backlog even though every requested frame is retained.
  CHECK(twoBlocksLate.plan.lateFrames > 0 && !twoBlocksLate.discontinuity());
  CHECK(reanchors == 0);
  const auto longStall = schedule.step(at(base + 20 * kFrames));
  consume(longStall);
  CHECK(longStall.discontinuity() && reanchors == 1);
  const auto recovered = schedule.step(at(base + 21 * kFrames));
  consume(recovered);
  CHECK(!recovered.discontinuity() && reanchors == 1);
  // Catch-up across turns remains contiguous, and no individual turn runs an
  // unbounded old queue. Seven overdue blocks recover in two batches of four.
  const auto catchupA = schedule.step(at(base + 29 * kFrames));
  consume(catchupA);
  CHECK(catchupA.plan.blocks == 4 && !catchupA.discontinuity());
  const auto catchupB = schedule.step(at(base + 29 * kFrames));
  consume(catchupB);
  CHECK(catchupB.plan.blocks == 4 && !catchupB.discontinuity());
  CHECK(reanchors == 1);
}
void nativeQueuePreservesSamplesAndBounds() {
  BoxInputQueue queue;
  queue.start();
  std::array<float, kFrames> pcm{};
  for (uint32_t f = 0; f < kFrames; ++f) pcm[f] = float(f) / 8192;
  const float* planes[]{pcm.data()};
  AudioInputBusBlock bus;
  bus.planes = planes; bus.channelCount = 1;
  bus.frames = bus.capacityFrames = kFrames;
  bus.firstNs = 1000000000; bus.deliveryNs = 1001000000;
  bus.quality = AudioInputTimestampQuality::Hardware;
  const auto before = sparseHeapEvents;
  trackSparseHeap = true;
  for (uint32_t i = 0; i < BoxInputQueue::capacity; ++i) queue.push(bus, 44100);
  const auto* first = queue.peek();
  CHECK(first && first->rate == 44100 && first->bus.firstNs == bus.firstNs);
  CHECK(std::equal(pcm.begin(), pcm.end(), first->pcm.get()));
  pcm.fill(-1);
  queue.push(bus, 44100); // Saturation cannot overwrite a borrowed slot.
  CHECK(first->pcm[17] == float(17) / 8192);
  queue.consume();
  queue.push(bus, 44100);
  for (uint32_t i = 1; i < BoxInputQueue::capacity; ++i) queue.consume();
  CHECK(queue.peek()->serial == BoxInputQueue::capacity + 2);
  CHECK(queue.peek()->pcm[17] == -1);
  queue.consume();
  CHECK(!queue.peek());
  queue.stop(); queue.start(); queue.push(bus, 48000);
  CHECK(queue.peek()->epoch == 2 && queue.peek()->rate == 48000);
  trackSparseHeap = false;
  CHECK(before == sparseHeapEvents);
}
// Compare the production analysis adapter at the native capture rate against
// the former 48 kHz timestamp-history route, on voiced harmonic signals. The
// native queue's PCM equality above separately pins exact pre-resample meters.
void nativePitchMatchesResampledPitch() {
  constexpr uint64_t origin = 1000000000;
  for (const double rate : {44100., 48000., 96000.}) {
    for (const double frequency : {110., 220., 440., 880.}) {
      loopz::AudioHistory history(1);
      std::vector<float> source(24000);
      for (size_t f = 0; f < source.size(); ++f) {
        const double phase = 2 * 3.141592653589793 * frequency * f / rate;
        source[f] = float(.2 * std::sin(phase) + .04 * std::sin(2 * phase));
      }
      for (uint32_t f = 0; f + kFrames <= source.size(); f += kFrames) {
        const float* planes[]{source.data() + f};
        CHECK(history.append({planes, kFrames}, kFrames,
            origin + uint64_t(f * 1e9 / rate), rate, f, true));
      }
      const auto analyze = [&](bool native) {
        BoxInputQueue queue; queue.start(rate);
        zdsp::analysis::LiveInputAnalysisAdapter adapter(1);
        double last = 0;
        uint32_t voiced = 0;
        std::array<float, kFrames> converted{};
        float* output[]{converted.data()};
        loopz::AudioReadCursor cursor;
        const double hz = native ? rate : 48000;
        for (uint32_t f = 0; f < uint32_t(.16 * hz); f += kFrames) {
          AudioInputBlockView block;
          block.sampleRate = hz; block.frames = kFrames;
          block.capture.clockDomainId = 1; block.capture.streamGeneration = 1;
          block.capture.sequence = f / kFrames + 1;
          block.capture.sampleHostTimeNs = origin + 30000000 + uint64_t(f * 1e9 / hz);
          block.capture.callbackHostTimeNs = block.capture.sampleHostTimeNs + 1000000;
          block.capture.timestampQuality = AudioInputTimestampQuality::Hardware;
          block.capture.flags = AudioInputSampleHostTimeValid | AudioInputCallbackHostTimeValid |
              AudioInputTimestampQualityValid;
          if (native) {
            const float* planes[]{source.data() + uint32_t(.03 * rate) + f};
            AudioInputBusBlock raw;
            raw.planes = planes; raw.channelCount = 1;
            raw.frames = raw.capacityFrames = kFrames;
            raw.firstNs = block.capture.sampleHostTimeNs;
            raw.deliveryNs = block.capture.callbackHostTimeNs;
            queue.push(raw, rate);
            CHECK(queue.peek());
            block.mono = queue.peek()->pcm.get();
            block.sampleRate = queue.peek()->rate;
          }
          else {
            const auto read = history.read(block.capture.sampleHostTimeNs, hz,
                {output, kFrames}, kFrames, cursor);
            CHECK(read.online && !read.missingFrames);
            block.mono = converted.data();
          }
          CHECK(adapter.push(block, [&](const auto& window) {
            if (window.analysis.frequency > 0) { last = window.analysis.frequency; ++voiced; }
          }));
          if (native) queue.consume();
        }
        CHECK(voiced >= 5);
        return last;
      };
      const auto native = analyze(true), previous = analyze(false);
      CHECK(std::abs(1200 * std::log2(native / previous)) < 5);
      CHECK(std::abs(1200 * std::log2(native / frequency)) < 10);
    }
  }
}
void sparseReadsNeverProcessDisabledChannels() {
  struct Spy final : loopz::AudioSource {
    mutable unsigned fullReads = 0, sparseReads = 0;
    bool supported = true, missing = false;
    std::array<float, 64> physical{};
    uint32_t channels() const noexcept override { return kChannels; }
    loopz::AudioReadResult read(uint64_t, double, loopz::RoutingOutput,
        uint32_t count, loopz::AudioReadCursor&) const noexcept override {
      ++fullReads; return {count, false};
    }
    std::optional<loopz::AudioReadResult> readChannels(uint64_t host, double rate,
        loopz::RoutingOutput output, uint32_t count, loopz::AudioReadCursor& cursor,
        std::span<const uint32_t> indices,
        std::optional<loopz::ResamplingFilter> filter) const noexcept override {
      ++sparseReads;
      CHECK(host == 1234 && rate == kRate && !filter);
      CHECK(indices.size() == output.channels.size() && count == kFrames);
      if (!supported) return std::nullopt;
      for (size_t dense = 0; dense < indices.size(); ++dense)
        std::fill_n(output.channels[dense], count, physical[indices[dense]]);
      cursor.generation = 3;
      return loopz::AudioReadResult{missing ? count : 0, true};
    }
  } spy;
  std::array<std::array<float, kFrames>, 2> pcm{};
  std::array<float*, 2> planes{pcm[0].data(), pcm[1].data()};
  for (const std::array<uint32_t, 2> indices : {std::array<uint32_t, 2>{0, 1},
                                               std::array<uint32_t, 2>{1, 7}}) {
    spy.physical.fill(std::numeric_limits<float>::quiet_NaN());
    spy.physical[indices[0]] = .2f; spy.physical[indices[1]] = .7f;
    loopz::AudioReadCursor cursor;
    const auto before = sparseHeapEvents;
    trackSparseHeap = true;
    const auto read = box_input_detail::readEnabledChannels(
        spy, 1234, kRate, {planes, kFrames}, kFrames, cursor, indices);
    trackSparseHeap = false;
    CHECK(sparseHeapEvents == before);
    CHECK(read && read->online && read->missingFrames == 0 && cursor.generation == 3);
    for (uint32_t frame = 0; frame < kFrames; ++frame)
      CHECK(pcm[0][frame] == .2f && pcm[1][frame] == .7f);
  }
  const std::array<uint32_t, 2> indices{1, 7};
  loopz::AudioReadCursor cursor;
  spy.missing = true;
  const auto missing = box_input_detail::readEnabledChannels(
      spy, 1234, kRate, {planes, kFrames}, kFrames, cursor, indices);
  CHECK(missing && missing->missingFrames == kFrames);
  spy.supported = false;
  CHECK(!box_input_detail::readEnabledChannels(
      spy, 1234, kRate, {planes, kFrames}, kFrames, cursor, indices));
  CHECK(spy.fullReads == 0 && spy.sparseReads == 4);
}
struct Hardware {
  std::atomic<unsigned> opens{0}, stops{0}, live{0}, maximumLive{0},
      outputOpens{0};
  std::atomic<bool> supply{true}, offline{false};
};
class Host final : public AudioHostBackend {
public:
  explicit Host(std::shared_ptr<Hardware> hardware)
      : hardware_(std::move(hardware)) {}
  AudioHostInventory enumerate() const override {
    AudioHostDeviceInfo microphone;
    microphone.uid = "fixture:microphone";
    microphone.label = "Ten channel microphone interface";
    microphone.defaultInput = true;
    microphone.direction = AudioHostEndpointDirection::Input;
    microphone.inputChannels =
        hardware_->live.load() ? 0 : kChannels; // ALSA EBUSY probe
    microphone.nominalSampleRate = kRate;
    return {{microphone}, microphone.uid, {}};
  }
  AudioHostResult open(const AudioHostConfig &, AudioHostRender,
                       void *) override {
    hardware_->outputOpens.fetch_add(1);
    return {false,
            AudioHostError::ProviderFailure,
            AudioHostState::Error,
            {},
            {},
            "Output forbidden"};
  }
  AudioHostResult start() override { return {}; }
  void stop() noexcept override {}
  AudioHostStatus status() const noexcept override { return {}; }

private:
  std::shared_ptr<Hardware> hardware_;
};
class Input final : public AudioInputBackend {
public:
  explicit Input(std::shared_ptr<Hardware> hardware)
      : hardware_(std::move(hardware)) {}
  ~Input() override { stop(); }
  AudioInputResult open(const AudioInputConfig &, AudioInputPush,
                        void *) override {
    CHECK(false); // analysis must subscribe to the owner's shared planar bus
    return {};
  }
  AudioInputBusResult openBus(const AudioInputBusConfig &config,
                              AudioInputBusPush callback,
                              void *context) override {
    hardware_->opens.fetch_add(1);
    CHECK(config.deviceUid == "fixture:microphone" &&
          config.channels.size() == kChannels);
    for (uint32_t channel = 0; channel < kChannels; ++channel)
      CHECK(config.channels[channel] == channel);
    if (hardware_->offline.load())
      return {AudioInputBusOpenStatus::Error,
              AudioInputResult::failure(AudioInputState::Error,
                                        "Fixture input offline", 0)};
    CHECK(hardware_->live.fetch_add(1) ==
          0); // never open a competing physical input
    hardware_->maximumLive.store(
        std::max(hardware_->maximumLive.load(), hardware_->live.load()));
    opened_ = true;
    callback_ = callback;
    context_ = context;
    return {AudioInputBusOpenStatus::Ready,
            AudioInputResult::success(AudioInputState::Starting, kRate, 0)};
  }
  AudioInputResult start() override {
    stopping_.store(false);
    worker_ = std::thread([this] { pushTones(); });
    return AudioInputResult::success(AudioInputState::Running, kRate, 0);
  }
  void stop() override {
    stopping_.store(true);
    if (worker_.joinable())
      worker_.join();
    if (opened_) {
      CHECK(hardware_->live.fetch_sub(1) == 1);
      hardware_->stops.fetch_add(1);
      opened_ = false;
    }
  }
  bool takeFailure(std::string &error) override {
    if (opened_ && hardware_->offline.load()) { error = "Fixture unplugged"; return true; }
    return false;
  }

private:
  void pushTones() {
    std::array<std::array<float, kFrames>, kChannels> pcm{};
    std::array<const float *, kChannels> planes{};
    for (uint32_t channel = 0; channel < kChannels; ++channel)
      planes[channel] = pcm[channel].data();
    const uint64_t origin = nowNs() - 100000000;
    uint64_t frame = 0, sequence = 0;
    while (!stopping_.load()) {
      const auto current = nowNs();
      for (unsigned budget = 0;
           hardware_->supply.load() && !hardware_->offline.load() && budget < 32 &&
           origin + frameNs(frame + kFrames) <= current && !stopping_.load();
           ++budget) {
        for (uint32_t sample = 0; sample < kFrames; ++sample) {
          const double time = double(frame + sample) / kRate;
          pcm[0][sample] =
              float(0.2 * std::sin(2 * 3.141592653589793 * 440 * time));
          pcm[1][sample] =
              float(0.1 * std::sin(2 * 3.141592653589793 * 220 * time));
          for (uint32_t channel = 2; channel < kChannels; ++channel)
            pcm[channel][sample] = 0;
          pcm[7][sample] = float(0.15 * std::sin(2 * 3.141592653589793 * 330 * time));
        }
        AudioInputBusBlock block;
        block.planes = planes.data();
        block.channelCount = kChannels;
        block.frames = block.capacityFrames = kFrames;
        block.firstNs = origin + frameNs(frame);
        block.deliveryNs = nowNs();
        block.quality = AudioInputTimestampQuality::CallbackEstimate;
        block.capture = {7,
                         1,
                         sequence++,
                         frame,
                         block.firstNs,
                         block.deliveryNs,
                         block.quality,
                         AudioInputDiscontinuityReason::None,
                         AudioInputSourceFrameValid |
                             AudioInputSampleHostTimeValid |
                             AudioInputCallbackHostTimeValid |
                             AudioInputTimestampQualityValid};
        CHECK(callback_ && callback_(context_, block));
        frame += kFrames;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
  }
  std::shared_ptr<Hardware> hardware_;
  std::thread worker_;
  std::atomic<bool> stopping_{true};
  bool opened_{false};
  AudioInputBusPush callback_{nullptr};
  void *context_{nullptr};
};
struct Sink {
  std::atomic<uint64_t> blocks{0}, frames{0}, crossings{0};
  std::atomic<double> squares{0};
  std::atomic<float> peak{0};
  std::atomic<bool> badMetadata{false};
  std::atomic<uint64_t> discontinuities{0};
  float last{0}; // one joined analysis reader owns this field
  void accept(const AudioInputBlockView &block) {
    if (block.capture.discontinuity == AudioInputDiscontinuityReason::StreamGenerationChanged) ++discontinuities;
    if (block.frames != kFrames || block.sampleRate != kRate || !block.mono ||
        block.timestampQuality !=
            AudioInputTimestampQuality::CallbackEstimate ||
        block.capture.timestampQuality !=
            AudioInputTimestampQuality::CallbackEstimate ||
        !(block.capture.flags & AudioInputSourceFrameValid) ||
        !block.capture.streamGeneration || !block.sampleHostTimeNs ||
        block.capture.sampleHostTimeNs != block.sampleHostTimeNs)
      badMetadata.store(true);
    double sum = 0;
    float high = peak.load();
    uint64_t up = 0;
    for (uint32_t frame = 0; frame < block.frames; ++frame) {
      const float sample = block.mono[frame];
      if (!std::isfinite(sample))
        badMetadata.store(true);
      if (last <= 0 && sample > 0)
        ++up;
      last = sample;
      sum += double(sample) * sample;
      high = std::max(high, std::abs(sample));
    }
    squares.fetch_add(sum);
    crossings.fetch_add(up);
    peak.store(high);
    frames.fetch_add(block.frames);
    blocks.fetch_add(1, std::memory_order_release);
  }
};
template <typename Predicate>
void eventually(Predicate ready, unsigned seconds = 4) {
  const auto deadline = Clock::now() + std::chrono::seconds(seconds);
  do {
    if (ready())
      return;
    pollBoxRouting();
    std::this_thread::sleep_for(std::chrono::milliseconds(3));
  } while (Clock::now() < deadline);
  CHECK(false);
}
void checkSignal(const Sink &sink, double frequency, double amplitude) {
  CHECK(!sink.badMetadata.load() && sink.frames.load() >= 24 * kFrames);
  const double rms = std::sqrt(sink.squares.load() / sink.frames.load());
  const double hz = double(sink.crossings.load()) * kRate / sink.frames.load();
  CHECK(std::abs(sink.peak.load() - amplitude) < amplitude * 0.05);
  CHECK(std::abs(rms - amplitude / std::sqrt(2.0)) < amplitude * 0.15);
  CHECK(std::abs(hz - frequency) < frequency * 0.2);
}
loopz::JSON state() {
  return loopz::parseControlJSON(
      boxRoutingRequest(R"({"version":1,"operation":"state"})"));
}
void edit(const char *operation, loopz::JSON commands) {
  const auto current = state();
  loopz::JSON request{{"version", 1},
                      {"expected", current["snapshot"]["revision"]},
                      {"commands", std::move(commands)}};
  const auto reply = loopz::parseControlJSON(boxRoutingRequest(loopz::JSON{
      {"version", 1},
      {"operation", operation},
      {"request", request}}.dump()));
  CHECK(reply.at("ok") == true);
}
} // namespace
int main() {
  nativeQueuePreservesSamplesAndBounds();
  nativePitchMatchesResampledPitch();
  sparseReadsNeverProcessDisabledChannels();
  scheduleRecoversJitterWithoutReset();
  char pattern[] = "/tmp/singz-box-input-XXXXXX";
  const char *scratch = mkdtemp(pattern);
  CHECK(scratch);
  const auto hardware = std::make_shared<Hardware>();
  std::string error;
  CHECK(initializeBoxRoutingWithHost(
      std::string(scratch) + "/routes.json", error,
      [hardware] { return std::make_unique<Host>(hardware); }, {},
      [hardware] { return std::make_unique<Input>(hardware); }));
  const auto devices = boxRoutingInputDevices();
  CHECK(devices.size() == 1 && devices[0].channels == kChannels);
  CHECK(sharedAudioService()
            .inputDevices()
            .empty()); // producer is not physical inventory
  CHECK(hardware->opens == 0 && hardware->outputOpens == 0);
  BoxInputCapture capture;
  AudioInputConfig config;
  config.deviceUid = "fixture:microphone";
  config.channel = 1;
  Sink first;
  const std::array<uint32_t, 2> enabled{0, 1};
  const auto started = capture.start(
      config, [&](const auto &block) { first.accept(block); }, &devices, enabled);
  CHECK(started.ok && started.deviceChannels == kChannels &&
        started.sampleRate == kRate);
  CHECK(started.sharingMode == "loopz-shared" &&
        started.timestampSource == "loopz-native-capture");
  eventually([&] {
    return first.blocks.load(std::memory_order_acquire) >= 24 &&
           capture.stats().deliveredFrames >= 24 * kFrames &&
           capture.meter().valid;
  });
  const auto levels = capture.meter();
  CHECK(levels.valid && levels.channels == 2 &&
        levels.channelIndices[0] == 0 && levels.channelIndices[1] == 1);
  for (uint32_t channel = 0; channel < levels.channels; ++channel)
    CHECK(std::isfinite(levels.peak[channel]) &&
          std::isfinite(levels.rms[channel]));
  CHECK(levels.peak[0] > 0.18f && levels.peak[0] < 0.22f);
  CHECK(levels.peak[1] > 0.08f && levels.peak[1] < 0.12f);
  CHECK(levels.rms[0] > 0.11f && levels.rms[0] < 0.17f);
  CHECK(levels.rms[1] > 0.05f && levels.rms[1] < 0.09f);
  // The first read consumed the since-last-read peak; an immediate second read
  // must still report at least the latest block (never an emptied hold).
  const auto again = capture.meter();
  CHECK(again.valid && again.peak[0] > 0.18f && again.peak[0] < 0.22f &&
        again.peak[1] > 0.08f && again.peak[1] < 0.12f);
  // A private subscription must survive a physical failure: LoopZ reopens
  // underneath the held reader, which publishes no fabricated offline levels.
  const auto opensBeforeLoss = hardware->opens.load();
  const auto boundariesBeforeLoss = first.discontinuities.load();
  hardware->offline.store(true);
  eventually([&] { return hardware->live == 0 &&
      capture.state() == AudioInputState::Starting && !capture.meter().valid; });
  const auto blocksWhileOffline = first.blocks.load();
  std::this_thread::sleep_for(std::chrono::milliseconds(80));
  CHECK(first.blocks.load() == blocksWhileOffline && !capture.meter().valid);
  hardware->offline.store(false);
  eventually([&] { return hardware->opens > opensBeforeLoss && hardware->live == 1 &&
      capture.state() == AudioInputState::Running && capture.meter().valid &&
      first.discontinuities > boundariesBeforeLoss; }, 5);
  CHECK(hardware->maximumLive == 1 && hardware->outputOpens == 0);
  const auto opensBeforeInvalid = hardware->opens.load();
  const auto stopsBeforeInvalid = hardware->stops.load();
  for (const auto invalid : {std::vector<uint32_t>{1, 1}, {1, 0}, {0}, {1, 10}, {1, 64}}) {
    CHECK(!capture.start(config, [&](const auto& block) { first.accept(block); },
                         &devices, invalid).ok);
    CHECK(capture.state() == AudioInputState::Running && capture.meter().valid);
  }
  const auto deliveredBeforeInvalid = first.blocks.load();
  eventually([&] { return first.blocks.load() > deliveredBeforeInvalid; });
  CHECK(hardware->opens == opensBeforeInvalid && hardware->stops == stopsBeforeInvalid);
  CHECK(boxRoutingInputDevices()[0].channels ==
        kChannels); // owned prefix survives EBUSY
  const auto stats = capture.stats();
  CHECK(stats.deliveredBlocks > 0 && stats.deliveredFrames >= 24 * kFrames &&
        stats.deliveryWakeups >= stats.deliveredBlocks);
  hardware->supply.store(false);
  eventually([&] {
    return capture.state() == AudioInputState::Starting &&
           !capture.meter().valid;
  });
  // Let the final physical block age beyond the consumer lookback before
  // asserting a stable missing-history interval.
  std::this_thread::sleep_for(std::chrono::milliseconds(200));
  CHECK(capture.state() == AudioInputState::Starting && !capture.meter().valid);
  const auto missingCount = first.blocks.load();
  std::this_thread::sleep_for(std::chrono::milliseconds(80));
  CHECK(first.blocks.load() ==
        missingCount); // missing history is never fake silence/analysis
  CHECK(!capture.meter().valid);
  capture.stop();
  checkSignal(first, 220, 0.1);
  const auto joinedCount = first.blocks.load();
  std::this_thread::sleep_for(std::chrono::milliseconds(20));
  CHECK(first.blocks.load() == joinedCount && !capture.meter().valid);
  CHECK(hardware->live == 0 && hardware->maximumLive == 1 &&
        hardware->outputOpens == 0);

  // A public input route and repeated private selections share one physical
  // owner.
  hardware->supply.store(true);
  edit("initialize", loopz::JSON::array({{{"type", "createDevice"},
                                          {"id", "micbus"},
                                          {"name", "Mic bus"},
                                          {"channels", 2},
                                          {"sampleRate", 48000},
                                          {"passThrough", false}},
                                         {{"type", "addSource"},
                                          {"device", "micbus"},
                                          {"id", "micinput"},
                                          {"kind", "input-device"},
                                          {"selector", "fixture:microphone"},
                                          {"channels", kChannels},
                                          {"muteOriginal", false},
                                          {"connectByDefault", true}}}));
  const auto publicDocument = state()["snapshot"]["document"];
  const auto opensBeforePrivate = hardware->opens.load();
  Sink second;
  config.channel = 0;
  CHECK(capture.start(config, [&](const auto &block) { second.accept(block); })
            .ok);
  eventually(
      [&] { return second.blocks.load(std::memory_order_acquire) >= 24; });
  CHECK(capture.meter().valid && capture.meter().channels == 1 &&
        capture.meter().channelIndices[0] == 0);
  capture.stop(true);
  checkSignal(second, 440, 0.2);
  CHECK(hardware->opens == opensBeforePrivate && hardware->live == 1);
  CHECK(state()["snapshot"]["document"] == publicDocument);
  Sink third;
  config.channel = 7;
  const std::array<uint32_t, 2> noncontiguous{1, 7};
  CHECK(capture.start(config, [&](const auto &block) { third.accept(block); },
                      nullptr, noncontiguous).ok);
  eventually(
      [&] { return third.blocks.load(std::memory_order_acquire) >= 24; });
  const auto sparseLevels = capture.meter();
  CHECK(sparseLevels.valid && sparseLevels.channels == 2 &&
        sparseLevels.channelIndices[0] == 1 && sparseLevels.channelIndices[1] == 7);
  CHECK(sparseLevels.peak[0] > .08f && sparseLevels.peak[0] < .12f &&
        sparseLevels.peak[1] > .13f && sparseLevels.peak[1] < .17f);
  capture.stop();
  checkSignal(third, 330, 0.15);
  CHECK(hardware->opens == opensBeforePrivate && hardware->maximumLive == 1 &&
        hardware->live == 1);
  CHECK(state()["snapshot"]["document"] == publicDocument);
  edit("edit", loopz::JSON::array({{{"type", "setSourceControls"},
                                    {"device", "micbus"},
                                    {"source", "micinput"},
                                    {"controls", {{"enabled", false}}}}}));
  eventually([&] { return hardware->live == 0; });

  // Stop while offline must join before releasing the last private tap. A
  // later poll/device return must not revive a cancelled analysis worker.
  Sink offlineStop;
  config.channel = 1;
  CHECK(capture.start(config, [&](const auto &block) { offlineStop.accept(block); }).ok);
  eventually([&] { return offlineStop.blocks >= 24 && capture.meter().valid; });
  hardware->offline.store(true);
  eventually([&] { return hardware->live == 0 && capture.state() == AudioInputState::Starting; });
  capture.stop();
  const auto joinedOffline = offlineStop.blocks.load();
  const auto opensAfterOfflineStop = hardware->opens.load();
  hardware->offline.store(false);
  for (unsigned i = 0; i < 210; ++i) {
    pollBoxRouting();
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
  CHECK(offlineStop.blocks == joinedOffline && !capture.meter().valid &&
      hardware->live == 0 && hardware->opens == opensAfterOfflineStop);
  const auto beforeInvalid = hardware->opens.load();
  config.deviceUid = "missing";
  CHECK(!capture.start(config, [&](const auto &block) { third.accept(block); })
             .ok);
  config.deviceUid = "fixture:microphone";
  config.channel = kChannels;
  CHECK(!capture.start(config, [&](const auto &block) { third.accept(block); })
             .ok);
  CHECK(hardware->opens == beforeInvalid && hardware->live == 0);
  config.channel = 1;
  hardware->offline.store(true);
  CHECK(!capture.start(config, [&](const auto &block) { third.accept(block); })
             .ok);
  CHECK(hardware->live == 0 && !capture.meter().valid &&
        hardware->outputOpens == 0);
  capture.stop();
  shutdownBoxRouting();
  CHECK(hardware->live == 0 && hardware->maximumLive == 1 &&
        hardware->outputOpens == 0);
  CHECK(initializeBoxRoutingWithHost(
      std::string(scratch) + "/null-input.json", error,
      [hardware] { return std::make_unique<Host>(hardware); }, {},
      [] { return std::unique_ptr<AudioInputBackend>{}; }));
  CHECK(!capture.start(config, [&](const auto& block) { third.accept(block); }).ok);
  capture.stop();
  shutdownBoxRouting();
  std::filesystem::remove_all(scratch);
  std::puts("Box private input "
            "tones/metadata/meters/missing-history/sharing/drain passed");
}

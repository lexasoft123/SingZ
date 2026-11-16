#include "native/playback/presentation_history.h"
#include "native/playback/native_playback_session.h"
#include <zcore/media/wav.h>
#include "allocation_trap.h"

#include <atomic>
#include <cmath>
#include <chrono>
#include <filesystem>
#include <memory>
#include <vector>
#include <fcntl.h>
#if defined(_WIN32)
#include <io.h>
#else
#include <unistd.h>
#endif
#include <cstdio>
#include <cstdlib>
#include <thread>

using namespace singz;
#define CHECK(x) do { if (!(x)) { std::fprintf(stderr, "%s:%d %s\n", __FILE__, __LINE__, #x); std::abort(); } } while (false)
namespace {
constexpr uint64_t origin = 1000000000;
PlaybackPresentationEntry entry(uint64_t ms, double frame, double rate = 1) {
  PlaybackPresentationEntry e;
  e.hostTimeNs = origin + ms * 1000000;
  e.frames = 480;
  e.sampleRate = 48000;
  e.projectFrame = frame;
  e.rate = rate;
  e.generation = 1;
  e.continuousFrame = ms * 48;
  e.paused = rate == 0;
  return e;
}
void affineAndEdges() {
  PlaybackPresentationHistory h;
  CHECK(!h.query(origin).found);
  CHECK(h.append(entry(0, 48000)));
  CHECK(h.append(entry(10, 48480, 0)));
  CHECK(h.append(entry(20, 48480, .85)));
  CHECK(h.query(origin + 5000000).projectFrame == 48240);
  const auto pause = h.query(origin + 15000000);
  CHECK(pause.found && pause.paused && pause.projectFrame == 48480);
  const auto rate = h.query(origin + 25000000);
  CHECK(rate.found && std::abs(rate.projectFrame - 48684) < 1e-8);
  CHECK(h.query(origin + 10000000).rate == 0);
  CHECK(h.query(origin + 20000000).rate == .85);
  CHECK(!h.query(origin - 1).found);
  CHECK(!h.query(origin + 30000000).found);
  CHECK(!h.append(entry(30, NAN)));
}
void boundariesAndEviction() {
  PlaybackPresentationHistory h;
  CHECK(h.append(entry(0, 0)));
  const auto first = h.query(origin);
  auto e = entry(10, 96000);
  e.seekCount = 1;
  CHECK(h.append(e));
  CHECK(h.query(origin + 10000000).discontinuitySerial != first.discontinuitySerial);
  e = entry(20, 0);
  e.seekCount = 1;
  e.loopCount = 1;
  e.nonAffine = true;
  CHECK(h.append(e));
  const auto loop = h.query(origin + 25000000);
  CHECK(!loop.found && loop.nonAffine);
  CHECK(loop.discontinuitySerial > first.discontinuitySerial);
  for (uint32_t i = 3; i < PlaybackPresentationHistory::kCapacity + 3; ++i)
    CHECK(h.append(entry(i * 10, i * 480)));
  CHECK(!h.query(origin).found); // Explicit eviction, not current-rate extrapolation.
  CHECK(h.query(origin + uint64_t(PlaybackPresentationHistory::kCapacity + 2) * 10000000).found);
  // A fresh song's reset continuous coordinate discards the former song.
  e = entry(100000, 0); e.generation = 2; e.continuousFrame = 0;
  CHECK(h.append(e));
  CHECK(!h.query(origin + 10000000).found);
  CHECK(h.query(e.hostTimeNs).generation == 2);
  // A monotonic clock reset likewise hides the old clock incarnation.
  e.hostTimeNs = origin; e.continuousFrame = 480;
  CHECK(h.append(e));
  CHECK(h.query(origin).found);
  CHECK(!h.query(origin + 100000000000).found);
}

void settingsSeamsVersusFaults() {
  PlaybackPresentationHistory h;
  CHECK(h.append(entry(0, 48000)));
  const auto start = h.query(origin);
  auto seam = entry(10, 48480, .5); seam.generation = 2;
  CHECK(h.append(seam));
  auto p = h.query(origin + 15000000);
  CHECK(p.found && p.discontinuitySerial > start.discontinuitySerial);
  CHECK(p.faultSerial == start.faultSerial);
  CHECK(p.mappingStartHostNs == origin + 10000000);
  CHECK(p.mappingStartSongSeconds == 1.01 && p.rate == .5);
  // A transpose-only seam also changes the epoch while preserving the time map.
  seam = entry(20, 48720, .5); seam.generation = 3; seam.transposeSemitones = 2;
  CHECK(h.append(seam)); p = h.query(origin + 25000000);
  CHECK(p.found && p.faultSerial == start.faultSerial && p.transposeSemitones == 2);
  CHECK(p.mappingStartHostNs == origin + 20000000);
  // Negative control: a seek sharing a tempo seam must NEVER inherit its exemption.
  seam = entry(30, 96000, 2); seam.generation = 4; seam.seekCount = 1;
  CHECK(h.append(seam)); p = h.query(origin + 35000000);
  CHECK(p.found && p.faultSerial > start.faultSerial);
  const auto seekFault = p.faultSerial;
  seam = entry(40, 96960, 2); seam.generation = 4; seam.seekCount = 1;
  seam.nonAffine = true;
  CHECK(h.append(seam)); p = h.query(origin + 45000000);
  CHECK(!p.found && p.faultSerial > seekFault);

  PlaybackPresentationHistory opaque;
  CHECK(opaque.append(entry(0, 0)));
  seam = entry(10, 480); seam.generation = 2; // Unexplained graph replacement, same settings.
  CHECK(opaque.append(seam));
  CHECK(opaque.query(origin + 15000000).faultSerial != opaque.query(origin).faultSerial);
}
// A synchronous output fixture proves this is the SONG callback's published
// coordinate, including adopted seek/pause commands, rather than an unrelated
// synthetic journal. stop() also reenters the query while the session holds its
// control mutex: taking that mutex from the provider would deadlock this test.
class PresentationBackend final : public AudioHostBackend {
public:
  AudioHostInventory enumerate() const override {
    AudioHostDeviceInfo d;
    d.uid = "presentation:output"; d.label = "Presentation fixture";
    d.defaultOutput = true; d.outputChannels = 2; d.nominalSampleRate = 48000;
    d.sampleRateRanges = {{48000, 48000}}; d.bufferFrames = {1, 512, 480, 1};
    d.direction = AudioHostEndpointDirection::Output;
    d.transport = AudioHostTransport::BuiltIn;
    return {{std::move(d)}, {}, "presentation:output"};
  }
  AudioHostResult open(const AudioHostConfig &config, AudioHostRender render,
                       void *context) override {
    callback = render; opaque = context;
    status_.format = {48000, config.maximumFrames, 480, 0, 2, true, true,
                      AudioHostAccessMode::Shared};
    status_.state = AudioHostState::Open;
    status_.routeGeneration = status_.streamGeneration = 1;
    return {true, AudioHostError::None, status_.state, status_.format, {}, {}};
  }
  AudioHostResult start() override {
    status_.state = AudioHostState::Running;
    return {true, AudioHostError::None, status_.state, status_.format, {}, {}};
  }
  void stop() noexcept override {
    status_.state = AudioHostState::Stopped;
    callback = nullptr; opaque = nullptr;
  }
  AudioHostStatus status() const noexcept override { return status_; }
  void drive() {
    float *outputs[]{left, right};
    AudioHostRenderBlock b;
    b.output = outputs; b.outputChannels = 2; b.frames = 480;
    b.maximumFrames = status_.format.maximumFrames; b.sampleRate = 48000;
    b.clockDomain = b.routeGeneration = b.streamGeneration = 1;
    b.callbackSequence = status_.callbacks;
    b.outputFrame = status_.renderedFrames;
    b.callbackHostTimeNs = origin + status_.renderedFrames * 1000000000ull / 48000;
    b.outputHostTimeNs = b.callbackHostTimeNs; b.outputTimestampValid = true;
    if (!status_.callbacks) b.discontinuity = AudioHostDiscontinuityStart;
    lastHostNs = b.callbackHostTimeNs;
    CHECK(callback && callback(opaque, b));
    ++status_.callbacks; status_.renderedFrames += b.frames;
  }
  uint64_t lastHostNs{0};
private:
  AudioHostStatus status_{};
  AudioHostRender callback{nullptr};
  void *opaque{nullptr};
  float left[512]{}, right[512]{};
};
void sessionPlacementQuery(double rate = 1, double transpose = 0) {
  auto backend = std::make_unique<PresentationBackend>();
  auto *fake = backend.get();
  NativePlaybackSession session(std::move(backend));
  CHECK(!session.presentationQuery(origin).found);
  const auto path = (std::filesystem::temp_directory_path() /
      ("singz-presentation-" + std::to_string(
          std::chrono::steady_clock::now().time_since_epoch().count()) + ".wav")).string();
  WavWriter wav;
  const std::vector<float> pcm(192000, .1f);
  CHECK(wav.open(path, 48000, 1));
  CHECK(wav.append(pcm.data(), pcm.size())); CHECK(wav.finalize());
#if defined(_WIN32)
  const int fd = _open(path.c_str(), _O_RDONLY | _O_BINARY);
#else
  const int fd = ::open(path.c_str(), O_RDONLY);
#endif
  CHECK(fd >= 0);
  std::vector<NativePlaybackLaneSource> lanes;
  lanes.push_back({"song", OwnedFileDescriptor(fd), 1, false, false, {}});
  NativePlaybackPrepareConfig config;
  config.outputDeviceUid = "presentation:output"; config.outputChannels = {0, 1};
  config.requestedSampleRate = 48000; config.maximumFrames = 512;
  config.playbackRate = rate; config.transposeSemitones = transpose;
  CHECK(session.prepare(config, std::move(lanes), 1).ok);
  CHECK(!session.presentationQuery(origin).found);
  CHECK(session.openOutput(1).ok && session.start(1).ok);
  fake->drive();
  auto first = session.presentationQuery(origin + 5000000);
  CHECK(first.found && first.projectFrame == 240 * rate && first.rate == rate && !first.paused);
  // The first captured block may arrive before the time/pitch pipeline has
  // presented any song audio. The old immediate-writer path looked up this
  // pre-history timestamp and permanently marked the take partial-error.
  const auto latency = session.presentationQuery(origin + 5000000);
  const auto delay = latency.outputLatencyFrames + latency.graphLatencyFrames;
  if (rate != 1 || transpose != 0) {
    CHECK(delay > 240);
    CHECK(!session.presentationQuery(origin + 5000000 - delay * 1000000000ull / 48000).found);
  }
  // Drive past startup, then use the same wall-time latency subtraction as
  // main. Historical rate mapping must be applied exactly once.
  for (unsigned n = 0; n < 100; ++n) fake->drive();
  const uint64_t capture = fake->lastHostNs + 5000000;
  const uint64_t aligned = capture - delay * 1000000000ull / 48000;
  const auto placed = session.presentationQuery(aligned);
  CHECK(placed.found && !placed.paused);
  CHECK(std::abs(placed.songSeconds - (aligned - origin) / 1.e9 * rate) < 1.e-8);
  CHECK(session.seek(1, 48000).ok); fake->drive();
  const auto sought = session.presentationQuery(fake->lastHostNs + 5000000);
  CHECK(sought.found && sought.projectFrame == 48000 + 240 * rate);
  CHECK(sought.discontinuitySerial != first.discontinuitySerial);
  CHECK(session.pause(1).ok); fake->drive();
  const auto paused = session.presentationQuery(fake->lastHostNs + 5000000);
  CHECK(paused.found && paused.paused && paused.rate == 0 && paused.projectFrame == 48000 + 480 * rate);
  CHECK(session.stop(1).ok);
  CHECK(session.unload(1).ok);
  CHECK(!session.presentationQuery(fake->lastHostNs + 5000000).found);
  std::remove(path.c_str());
}

void allocationFreeAndConcurrent() {
  PlaybackPresentationHistory h;
  zdsp::test::resetAllocationTrap();
  zdsp::test::setAllocationTrapEnabled(true);
  for (uint32_t i = 0; i < 20000; ++i)
    CHECK(h.append(entry(i * 10, i * 480)));
  zdsp::test::setAllocationTrapEnabled(false);
  CHECK(zdsp::test::trappedAllocationCount() == 0);
  // Atomic scalar assertions in the implementation reject locking fallbacks
  // at compile time; no mutex/allocator exists anywhere in the append path.
  std::atomic<bool> done{false};
  std::thread writer([&] {
    for (uint32_t i = 20000; i < 50000; ++i)
      CHECK(h.append(entry(i * 10, i * 480)));
    done.store(true);
  });
  uint32_t hits = 0;
  while (!done.load()) {
    for (uint32_t i = 20000; i < 50000; i += 61) {
      const auto p = h.query(origin + uint64_t(i) * 10000000 + 5000000);
      if (p.found) { CHECK(p.projectFrame == i * 480 + 240); ++hits; }
    }
  }
  writer.join();
  CHECK(h.query(origin + 499995000000).found);
  (void)hits; // Scheduling is unconstrained; every observed hit must be coherent.
}

void settingsSeam() {
  auto backend = std::make_unique<PresentationBackend>();
  auto *fake = backend.get();
  NativePlaybackTestHooks hooks;
  // A non-integral number of 480-frame callbacks forces an interior seam
  // independent of host speed, including the Release negative control.
  hooks.timePitchPrimeNs = 70010000;
  NativePlaybackSession session(std::move(backend), &hooks);
  const auto path = (std::filesystem::temp_directory_path() /
      ("singz-anchor-seam-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()) + ".wav")).string();
  WavWriter wav; const std::vector<float> pcm(480000, .1f);
  CHECK(wav.open(path, 48000, 1)); CHECK(wav.append(pcm.data(), pcm.size())); CHECK(wav.finalize());
  const auto lanes = [&] {
#if defined(_WIN32)
    const int fd = _open(path.c_str(), _O_RDONLY | _O_BINARY);
#else
    const int fd = ::open(path.c_str(), O_RDONLY);
#endif
    CHECK(fd >= 0);
    std::vector<NativePlaybackLaneSource> result;
    result.push_back({"song", OwnedFileDescriptor(fd), 1, false, false, {}});
    return result;
  };
  NativePlaybackPrepareConfig config;
  config.outputDeviceUid = "presentation:output"; config.outputChannels = {0, 1};
  config.requestedSampleRate = 48000; config.maximumFrames = 512;
  CHECK(session.prepare(config, lanes(), 1).ok);
  CHECK(session.openOutput(1).ok && session.start(1).ok);
  for (unsigned n = 0; n < 30; ++n) fake->drive();
  const auto before = session.presentationQuery(fake->lastHostNs + 5000000);
  CHECK(before.found);
  config.swapFromGeneration = 1; config.preparedStartProjectFrame = 14400;
  config.playbackRate = .5; config.transposeSemitones = 2;
  CHECK(session.prepare(config, lanes(), 2).ok);
  for (unsigned n = 0; n < 100; ++n) fake->drive();
  const auto after = session.presentationQuery(fake->lastHostNs + 5000000);
  CHECK(after.found && after.generation == 2 && after.rate == .5 && after.transposeSemitones == 2);
  CHECK(after.discontinuitySerial > before.discontinuitySerial);
  if (after.faultSerial != before.faultSerial) {
    const auto left = session.presentationQuery(after.mappingStartHostNs - 1);
    const auto right = session.presentationQuery(after.mappingStartHostNs);
    std::fprintf(stderr, "seam fault: before=%llu after=%llu edge=%llu left(found=%d gen=%llu frame=%.12f rate=%.6f) right(found=%d gen=%llu frame=%.12f rate=%.6f)\n",
        static_cast<unsigned long long>(before.faultSerial), static_cast<unsigned long long>(after.faultSerial),
        static_cast<unsigned long long>(after.mappingStartHostNs), left.found, static_cast<unsigned long long>(left.generation),
        left.projectFrame, left.rate, right.found, static_cast<unsigned long long>(right.generation), right.projectFrame, right.rate);
  }
  CHECK(after.faultSerial == before.faultSerial);
  CHECK(after.mappingStartHostNs > before.mappingStartHostNs);
  CHECK((after.mappingStartHostNs - origin) % 10000000 != 0); // Seam is inside a 10 ms callback.
  CHECK(session.seek(2, 96000).ok); fake->drive();
  const auto fault = session.presentationQuery(fake->lastHostNs + 5000000);
  CHECK(fault.found && fault.faultSerial > after.faultSerial);
  CHECK(session.stop(2).ok && session.unload(2).ok);
  std::remove(path.c_str());
}
}
int main() {
  affineAndEdges(); boundariesAndEviction(); settingsSeamsVersusFaults(); allocationFreeAndConcurrent(); sessionPlacementQuery();
  for (double rate : {.25, .5, 2.0}) sessionPlacementQuery(rate);
  sessionPlacementQuery(1, 2);
  settingsSeam();
  std::puts("playback presentation history tests passed");
}

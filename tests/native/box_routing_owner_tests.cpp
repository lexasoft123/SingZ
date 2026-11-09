#include "native/playback/box_routing_owner.h"
#include "tests/native/box_timing_journal_regression.h"
#include "native/playback/loopz_source_backend.h"
#include <vector>
#include <map>
#include "native/playback/shared_audio_service.h"
#include <loopz/document_json.hpp>
#include <loopz/audio_scene.hpp>
#include <loopz/audio_resampler.hpp>
#include <array>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <thread>
#include <stdexcept>
#include <unistd.h>
#define CHECK(v) do { if (!(v)) { std::fprintf(stderr, "failed %d: %s\n", __LINE__, #v); std::abort(); } } while (false)
using namespace singz;
uint64_t nowNs() { return std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now().time_since_epoch()).count(); }
uint64_t fixtureClockNs = 0;
uint64_t fixtureNowNs() { return fixtureClockNs ? fixtureClockNs : nowNs(); }
struct Probe { AudioHostRender callback{}; void* context{}; bool running{false}; uint64_t stream{1}; uint32_t queue{256}; uint64_t presentationHostNs{0}; };
class FakeHost final : public AudioHostBackend {
 public:
  using Probes = std::map<std::string, std::shared_ptr<Probe>>;
  explicit FakeHost(std::shared_ptr<Probes> probes) : probes_(std::move(probes)) {}
  AudioHostInventory enumerate() const override {
    AudioHostDeviceInfo d; d.uid = "pa"; d.label = "Fake PA"; d.outputChannels = 2;
    d.defaultOutput = true; d.nominalSampleRate = 48000; d.direction = AudioHostEndpointDirection::Output;
    auto aux = d; aux.uid = "aux"; aux.defaultOutput = false;
    return {{d, aux}, {}, d.uid};
  }
  AudioHostResult open(const AudioHostConfig& config, AudioHostRender callback, void* context) override {
    probe_ = probes_->at(config.outputDeviceUid);
    opened_ = true; probe_->callback = callback; probe_->context = context; current_.state = AudioHostState::Open;
    current_.format = {48000, 256, 256, 0, 2}; current_.latency.bufferFrames = 256;
    return {true, AudioHostError::None, current_.state, current_.format, current_.latency, {}};
  }
  AudioHostResult start() override { probe_->running = true; current_.state = AudioHostState::Running; return {true, AudioHostError::None, current_.state, current_.format, current_.latency, {}}; }
  void stop() noexcept override { if (!opened_) return; opened_ = false; probe_->running = false; current_.state = AudioHostState::Stopped; }
  AudioHostStatus status() const noexcept override { auto result = current_; if (probe_) result.latency.bufferFrames = probe_->queue; return result; }
 private: std::shared_ptr<Probes> probes_; std::shared_ptr<Probe> probe_; AudioHostStatus current_; bool opened_{false};
};
struct DiscoveryProbe {
  unsigned enumerations = 0, opens = 0;
  std::string uid = "before";
  bool fail = false;
};
class DiscoveryHost final : public AudioHostBackend {
 public:
  explicit DiscoveryHost(std::shared_ptr<DiscoveryProbe> probe) : probe_(std::move(probe)) {}
  AudioHostInventory enumerate() const override {
    ++probe_->enumerations;
    if (probe_->fail) throw std::runtime_error("Discovery temporarily unavailable");
    AudioHostDeviceInfo device;
    device.uid = probe_->uid; device.label = "Discovery fixture";
    device.inputChannels = 2; device.direction = AudioHostEndpointDirection::Input;
    return {{device}, device.uid, {}};
  }
  AudioHostResult open(const AudioHostConfig&, AudioHostRender, void*) override {
    ++probe_->opens; return {};
  }
  AudioHostResult start() override { return {}; }
  void stop() noexcept override {}
  AudioHostStatus status() const noexcept override { return {}; }
 private:
  std::shared_ptr<DiscoveryProbe> probe_;
};
void inventoryCacheRegression() {
  const auto path = std::string("/tmp/box-discovery-test-") + std::to_string(getpid()) + ".json";
  unlink(path.c_str());
  auto probe = std::make_shared<DiscoveryProbe>();
  uint64_t clock = 1000000000;
  auto factory = [probe] { return std::make_unique<DiscoveryHost>(probe); };
  std::string error;
  CHECK(initializeBoxRoutingWithHost(path, error, factory, {}, {}, [&clock] { return clock; }));
  CHECK(probe->enumerations == 1);
  const auto state = [] {
    return loopz::parseControlJSON(boxRoutingRequest(R"({"version":1,"operation":"state"})"));
  };
  const auto inputUid = [] {
    const auto devices = boxRoutingInputDevices();
    CHECK(devices.size() == 1); return devices.front().uid;
  };
  CHECK(inputUid() == "before");
  probe->uid = "after";
  for (unsigned index = 0; index < 40; ++index) {
    clock = 1000000000 + uint64_t(index) * 25000000;
    pollBoxRouting();
    CHECK(inputUid() == "before"); // Temporary host instances share one cache.
  }
  CHECK(probe->enumerations == 1);
  clock = 2000000000;
  pollBoxRouting();
  CHECK(probe->enumerations == 2 && inputUid() == "after");
  CHECK(state().at("inventory").at("devices").at(0).at("uid") == "after");
  probe->fail = true;
  clock = 3000000000;
  pollBoxRouting();
  CHECK(probe->enumerations == 3);
  CHECK(state().at("inventory").at("devicesFresh") == false);
  for (unsigned index = 0; index < 40; ++index) {
    clock = 3000000000 + uint64_t(index) * 25000000;
    pollBoxRouting();
    bool failed = false;
    try { (void)boxRoutingInputDevices(); }
    catch (const std::runtime_error&) { failed = true; }
    CHECK(failed); // Never disguise a failed refresh as fresh cached devices.
  }
  CHECK(probe->enumerations == 3);
  probe->fail = false; probe->uid = "recovered";
  clock = 4000000000;
  pollBoxRouting();
  CHECK(probe->enumerations == 4 && inputUid() == "recovered");
  CHECK(state().at("inventory").at("devicesFresh") == true);
  shutdownBoxRouting();
  probe->uid = "reinitialized";
  CHECK(initializeBoxRoutingWithHost(path, error, factory, {}, {}, [&clock] { return clock; }));
  CHECK(probe->enumerations == 5 && inputUid() == "reinitialized");
  CHECK(probe->opens == 0); // Discovery does not prepare routes or open outputs.
  shutdownBoxRouting();
}
void emit(const std::shared_ptr<Probe>& probe, bool timestampValid = true) {
  CHECK(probe->running && probe->callback);
  std::array<float, 256> left{}, right{}; float* out[]{left.data(), right.data()};
  AudioHostRenderBlock block; block.output = out; block.outputChannels = 2;
  block.frames = block.maximumFrames = 256; block.sampleRate = 48000;
  block.callbackHostTimeNs = fixtureNowNs() - 1000000;
  probe->presentationHostNs = block.callbackHostTimeNs;
  block.outputHostTimeNs = block.callbackHostTimeNs; block.outputTimestampValid = timestampValid;
  block.outputTimestampHardware = false; block.routeGeneration = 1; block.streamGeneration = probe->stream;
  CHECK(probe->callback(probe->context, block));
}
void pollingDoesNotDemandMeterPreview() {
  const auto path = std::string("/tmp/box-poll-preview-") + std::to_string(getpid()) + ".json";
  loopz::VirtualDeviceDefinition bus; bus.id = "parked"; bus.name = "Undemanded song";
  loopz::SourceRouting source; source.id = "native"; source.channels = 2;
  source.connections = {{0, 0, 1}, {1, 1, 1}};
  bus.routing.sources.push_back(source);
  bus.bindings.push_back({"native", loopz::SourceKind::Application, "native:singz", false});
  loopz::RouteDocument document; document.devices.push_back(bus);
  std::ofstream(path) << loopz::JSON{{"version", 1}, {"generation", "1"},
                                    {"document", loopz::encodeDocument(document)}};
  auto sourceHistory = std::make_shared<LoopZSongSource>();
  sourceHistory->history = std::make_shared<loopz::AudioHistory>(2,
      loopz::AudioHistory::kDefaultCapacityFrames, loopz::ResamplingFilter::LinearPhase, true);
  std::vector<float> pcm(32768, .25f);
  std::array<const float*, 2> planes{pcm.data(), pcm.data()};
  CHECK(sourceHistory->history->append({planes, 32768}, 32768, nowNs() - 100000000,
                                      48000, 0, true));
  auto probes = std::make_shared<FakeHost::Probes>();
  std::string error;
  CHECK(initializeBoxRoutingWithHost(path, error,
      [probes] { return std::make_unique<FakeHost>(probes); }, sourceHistory));
  // An actual visible state reader still requests the existing bounded preview.
  (void)boxRoutingRequest(R"({"version":1,"operation":"state"})");
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(4);
  while (!sourceHistory->history->readDiagnostics().reads && std::chrono::steady_clock::now() < deadline) {
    pollBoxRouting();
    std::this_thread::sleep_for(std::chrono::milliseconds(25));
  }
  CHECK(sourceHistory->history->readDiagnostics().reads > 0);
  auto previous = sourceHistory->history->readDiagnostics().reads;
  auto stableSince = std::chrono::steady_clock::now();
  const auto started = stableSince;
  bool parked = false;
  while (std::chrono::steady_clock::now() < deadline) {
    pollBoxRouting();
    const auto reads = sourceHistory->history->readDiagnostics().reads;
    const auto now = std::chrono::steady_clock::now();
    if (reads != previous) { previous = reads; stableSince = now; }
    if (now - started >= std::chrono::milliseconds(700) &&
        now - stableSince >= std::chrono::milliseconds(250)) { parked = true; break; }
    std::this_thread::sleep_for(std::chrono::milliseconds(25));
  }
  CHECK(parked); // Old refreshMapping(state) renews preview on every poll and fails.
  const auto parkedReads = sourceHistory->history->readDiagnostics().reads;
  (void)boxRoutingRequest(R"({"version":1,"operation":"state"})");
  const auto resumeDeadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
  while (sourceHistory->history->readDiagnostics().reads == parkedReads &&
         std::chrono::steady_clock::now() < resumeDeadline) {
    pollBoxRouting();
    std::this_thread::sleep_for(std::chrono::milliseconds(25));
  }
  CHECK(sourceHistory->history->readDiagnostics().reads > parkedReads);
  CHECK(probes->empty()); // No physical output was created for a meter preview.
  shutdownBoxRouting();
  unlink(path.c_str());
}
int main() {
  singz::box_timing::runJournalRegression();
  CHECK(!boxRoutingTimingCoverageLost());
  const auto path = std::string("/tmp/box-routing-test-") + std::to_string(getpid()) + ".json";
  loopz::VirtualDeviceDefinition bus; bus.id = "song"; bus.name = "Song";
  loopz::SourceRouting source; source.id = "native"; source.channels = 2;
  source.connections = {{0, 0, 1}, {1, 1, 1}};
  bus.routing.sources.push_back(source);
  bus.bindings.push_back({"native", loopz::SourceKind::Application, "native:singz", true});
  loopz::MonitorDefinition monitor; monitor.id = "main"; monitor.deviceSelector = "pa";
  monitor.connections = {{0, 0, 1}, {1, 1, 1}}; bus.monitors.push_back(monitor);
  loopz::RouteDocument document; document.devices.push_back(bus);
  // An independent virtual silence bus exercises route ownership separately
  // from the song producer. This is not a microphone/capture qualification.
  loopz::VirtualDeviceDefinition auxiliary; auxiliary.id = "independent"; auxiliary.name = "Independent virtual source";
  auto auxMonitor = monitor; auxMonitor.deviceSelector = "aux"; auxiliary.monitors.push_back(auxMonitor);
  document.devices.push_back(auxiliary);
  std::ofstream(path) << loopz::JSON{{"version", 1}, {"generation", "1"}, {"document", loopz::encodeDocument(document)}};
  auto probe = std::make_shared<Probe>(); auto auxProbe = std::make_shared<Probe>();
  auto probes = std::make_shared<FakeHost::Probes>(); (*probes)["pa"] = probe; (*probes)["aux"] = auxProbe;
  std::string error;
  auto songSource = std::make_shared<LoopZSongSource>();
  CHECK(initializeBoxRoutingWithHost(path, error, [probes] { return std::make_unique<FakeHost>(probes); }, songSource));
  CHECK(boxRoutingOwnsCapture());
  // Deterministic source clock: feed a full retained window on this thread.
  // The separate source test exercises the actual worker scheduler.
  std::vector<float> pcm(32768, 0.25f);
  std::array<const float*, 2> input{pcm.data(), pcm.data()};
  CHECK(songSource->history->append({input, 32768}, 32768,
                                    nowNs() - 100000000, 48000, 0, true));
  std::this_thread::sleep_for(std::chrono::milliseconds(70));
  // Runtime monitor telemetry matures only after render plus control polling.
  emit(probe); pollBoxRouting(); emit(probe); pollBoxRouting(); emit(probe);
  const auto state = loopz::parseControlJSON(boxRoutingRequest(R"({"version":1,"operation":"state"})"));
  const auto& monitors = state.at("snapshot").at("runtime").at("monitors");
  auto songMonitor = [](const loopz::JSON& rows) -> const loopz::JSON& {
    for (const auto& row : rows)
      if (row.at("device") == "song" && row.at("monitor") == "main") return row;
    CHECK(false);
    return rows.at(0);
  };
  CHECK(songMonitor(monitors).at("historyBudgetKnown") == true);
  const uint64_t H = songMonitor(monitors).at("historyBudgetFrames").get<uint64_t>();
  const auto timing = loopz::planSceneTiming(document, {48000, 256, 1024, 128});
  const uint64_t delay = H + timing.latencyFrames[0];
  // Freeze this fixture phase's clock. QEMU/preemption may take arbitrarily
  // longer than the 5 ms callback interval to execute the next statement.
  fixtureClockNs = nowNs();
  auto project = [&](uint64_t generation, uint64_t seek, uint64_t graphLatency) {
    const uint64_t query = fixtureClockNs ? fixtureClockNs : probe->presentationHostNs + 1000000;
    return boxAudibleProjectionAtTimeForTesting(generation, seek, graphLatency, query);
  };
  const auto producerTime = fixtureNowNs() - delay * 1000000000 / 48000 - 1000000;
  recordBoxSongSlice(producerTime, 2048, 77, 1000, 0, 1ull << 32, 1, 0);
  emit(probe);
  auto position = project(77, 0, 0);
  CHECK(position.available && position.routeDelayFrames == delay);
  CHECK(position.projectFrame == 1048);
  CHECK(!boxAudibleProjectionAtTimeForTesting(77, 0, 0,
      fixtureClockNs + 43000000).available); // physical callback coverage expired
  // Native graph latency is independent, subtracted exactly once.
  auto graphDelayed = project(77, 0, 24);
  CHECK(graphDelayed.available && graphDelayed.projectFrame == position.projectFrame - 24);
  emit(probe, false);
  CHECK(!project(77, 0, 0).available);
  emit(probe);
  // A newer seek cannot claim queued audio from the older timeline as current.
  CHECK(!project(77, 1, 0).available);
  CHECK(!project(78, 0, 0).available);
  // Stream changes invalidate callback coverage instead of reusing old clocks.
  ++probe->stream; emit(probe);
  CHECK(project(77, 0, 0).available); // new epoch has a current exact callback
  // A recorded loop edge maps the old and new song positions by content
  // timestamp, never by extrapolating the latest producer head across a wrap.
  const auto loopHost = fixtureNowNs() - delay * 1000000000 / 48000 - 1000000;
  recordBoxSongSlice(loopHost, 2048, 77, 200, 0, 1ull << 32, 1, 0);
  emit(probe);
  const auto loopPosition = project(77, 0, 0);
  CHECK(loopPosition.available && loopPosition.projectFrame == 248);
  recordBoxSongFailure(loopHost, 2048);
  CHECK(!project(77, 0, 0).available);
  // A successful route edit fences the preceding physical callback epoch.
  auto editMonitor = [&](double gain) {
    const auto canonical = loopz::parseControlJSON(boxRoutingRequest(R"({"version":1,"operation":"state"})"));
    loopz::JSON command{{"type", "setMonitorControls"}, {"device", "song"},
                        {"monitor", "main"}, {"controls", {{"gain", gain}}}};
    loopz::JSON request{{"version", 1}, {"expected", canonical["snapshot"]["revision"]},
                        {"commands", loopz::JSON::array({command})}};
    loopz::JSON edit{{"version", 1}, {"operation", "edit"}, {"request", request}};
    const auto reply = loopz::parseControlJSON(boxRoutingRequest(edit.dump()));
    CHECK(reply.at("ok") == true);
  };
  fixtureClockNs = 0; // warm up the replacement scene on its real render clock
  probe->queue = 1024;
  editMonitor(0.8);
  CHECK(!project(77, 0, 0).available);
  const auto updated = loopz::parseControlJSON(boxRoutingRequest(R"({"version":1,"operation":"state"})"));
  const auto updatedH = songMonitor(updated["snapshot"]["runtime"]["monitors"])["historyBudgetFrames"].get<uint64_t>();
  CHECK(updatedH > H);
  const uint64_t updatedDelay = updatedH + timing.latencyFrames[0];
  // The preceding deliberately failed interval is still physically queued
  // after a route edit. Wait until the NEW route's content clock has passed
  // its end; a route epoch must never erase a genuine failed-audio interval.
  const uint64_t failedEnd = loopHost + uint64_t(2048) * 1000000000 / 48000;
  const uint64_t updatedDelayNs = updatedDelay * 1000000000 / 48000;
  const auto maturityDeadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
  while (nowNs() <= failedEnd + updatedDelayNs + 2000000 &&
         std::chrono::steady_clock::now() < maturityDeadline) {
    std::this_thread::sleep_for(std::chrono::milliseconds(2));
    emit(probe); pollBoxRouting();
  }
  CHECK(nowNs() > failedEnd + updatedDelayNs + 2000000);
  // Refresh the deterministic source window so test load cannot expire its
  // retained samples while waiting for the failed interval to leave the ear.
  CHECK(songSource->history->append({input, 32768}, 32768,
                                    nowNs() - 100000000, 48000, 32768, true));
  std::this_thread::sleep_for(std::chrono::milliseconds(70));
  emit(probe); pollBoxRouting(); emit(probe); pollBoxRouting();
  fixtureClockNs = nowNs();
  recordBoxSongSlice(fixtureClockNs - updatedDelayNs - 1000000,
                     2048, 88, 400, 0, 1ull << 32, 1, 0);
  emit(probe);
  const auto afterCommit = project(88, 0, 0);
  CHECK(afterCommit.available && afterCommit.routeDelayFrames == updatedDelay);
  CHECK(afterCommit.projectFrame == 448);
  fixtureClockNs = 0;
  // Invalid JSON does not replace the active scene or stop its output.
  const auto rejected = loopz::parseControlJSON(boxRoutingRequest(R"({"version":1,"operation":"edit","request":{}})"));
  CHECK(rejected.at("ok") == false && probe->running);
  // Detaching the last song stops only its producer/history, while LoopZ's
  // physical endpoint and independent virtual-source route survive.
  auto client = sharedPlaybackBackend(boxRoutingPlaybackBackend(), "box-loopz");
  AudioHostConfig config; config.outputDeviceUid = "pa";
  config.outputChannels = {0, 1}; config.requestedSampleRate = 48000;
  struct SongRenderer {
    std::atomic<bool> fail{false};
    std::atomic<uint64_t> calls{0};
    static bool render(void* context, const AudioHostRenderBlock& block) noexcept {
      auto& self = *static_cast<SongRenderer*>(context);
      // Record the same valid slice a normal native graph records before a
      // downstream processor can fail. SharedAudioService wraps this callback
      // and deliberately returns true to its producer even on song failure.
      recordBoxSongSlice(block.callbackHostTimeNs, block.frames, 99,
                         1000 + static_cast<int64_t>(block.outputFrame), 0,
                         1ull << 32, 1, 0);
      self.calls.fetch_add(1, std::memory_order_release);
      return !self.fail.load(std::memory_order_acquire);
    }
  } renderer;
  CHECK(client->open(config, SongRenderer::render, &renderer).ok);
  CHECK(client->start().ok);
  bool goodProjection = false;
  for (unsigned attempt = 0; attempt < 150; ++attempt) {
    std::this_thread::sleep_for(std::chrono::milliseconds(2));
    emit(probe); pollBoxRouting(); emit(probe);
    if (project(99, 0, 0).available) { goodProjection = true; break; }
  }
  CHECK(goodProjection && songSource->history->status().online);
  renderer.fail.store(true, std::memory_order_release);
  const auto callsBeforeFailure = renderer.calls.load(std::memory_order_acquire);
  for (unsigned attempt = 0; attempt < 150 &&
       renderer.calls.load(std::memory_order_acquire) < callsBeforeFailure + 24; ++attempt)
    std::this_thread::sleep_for(std::chrono::milliseconds(2));
  CHECK(renderer.calls.load(std::memory_order_acquire) >= callsBeforeFailure + 24);
  emit(probe); pollBoxRouting(); emit(probe);
  // History remains online because the shared wrapper returned true. Only the
  // actual failing song callback's interval hook can reject this projection.
  CHECK(songSource->history->status().online);
  CHECK(client->status().state == AudioHostState::Error);
  CHECK(!project(99, 0, 0).available);
  client->stop();
  CHECK(sharedAudioService().status().state == AudioHostState::Stopped);
  CHECK(probe->running && auxProbe->running);
  emit(auxProbe);
  CHECK(!songSource->history->status().online);
  shutdownBoxRouting(); CHECK(!probe->running && !auxProbe->running && !boxRoutingOwnsCapture());
  CHECK(!boxRoutingTimingCoverageLost());
  unlink(path.c_str());
  // SharedAudioService retains its provider backend after shutdown. Run the
  // discovery-only lifecycle fixture last so its separate synthetic source
  // cannot replace the history identity assumed by the playback fixture.
  pollingDoesNotDemandMeterPreview();
  inventoryCacheRegression();
  std::puts("Box routing physical delay/seek/generation/stop regression passed");
}

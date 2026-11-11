#include "box_input_queue.h"
#include "box_routing_owner.h"
#include "box_timing_journal.h"
#include "loopz_source_backend.h"
#include "shared_audio_service.h"
#include <loopz/runtime/control.hpp>
#include <filesystem>
#include <cstdio>
#include <system_error>
#include <exception>
#include <stdexcept>
#include <array>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <limits>
#include <vector>

namespace singz {
namespace {
constexpr uint64_t kNs = 1000000000;
constexpr size_t kTimelineSlots = 65536, kPhysicalSlots = 4096;
struct SongRecord {
  std::atomic<uint64_t> sequence{0}, host{0}, generation{0}, seek{0}, rate{0};
  std::atomic<int64_t> frame{0};
  std::atomic<uint32_t> fraction{0}, frames{0}, state{0};
};
struct PhysicalRecord {
  std::atomic<uint64_t> sequence{0}, host{0}, endpoint{0}, epoch{0}, stream{0}, route{0};
  std::atomic<uint32_t> frames{0}, flags{0};
};
std::array<SongRecord, kTimelineSlots> timeline;
std::array<PhysicalRecord, kPhysicalSlots> physical;
struct MissingRecord {
  std::atomic<uint64_t> sequence{0}, host{0}, duration{0};
};
std::array<MissingRecord, kPhysicalSlots> missingHistory;
std::atomic<uint64_t> missingWritten{0};
std::atomic<bool> journalCoverageLost{false};
std::atomic<uint64_t> songWritten{0}, physicalWritten{0}, epoch{1};
std::atomic<uint64_t> primaryEndpoint{0}, primaryDelay{0};
std::atomic<bool> mappingKnown{false}, enabled{false};
// Static destruction runs in reverse declaration order. If the process exits
// without shutdownBoxRouting(), ~Control destroys InstrumentedHost instances
// that erase from `endpoints`, so the registry must be declared (constructed)
// before, and therefore destroyed after, `control`.
uint64_t endpointSerial = 0;
struct Endpoint { uint64_t id; std::string uid; };
std::vector<Endpoint> endpoints;
std::shared_ptr<LoopZSongSource> song;
std::unique_ptr<loopz::runtime::Control> control;
loopz::runtime::AudioRuntime* runtimeView = nullptr;
std::function<uint64_t()> controlClock;
bool controlPolled = false;
uint64_t controlPolledAt = 0;
std::string stateRecovery;
uint64_t selectedGeneration = 0, selectedDocumentRevision = 0;
std::string selectedPrimary;
uint64_t selectedDelay = 0;
std::optional<loopz::SceneTimingPlan> mappingTiming;
uint64_t mappingDocumentRevision = 0, mappingActiveGeneration = 0;

class ObservedSongSource final : public loopz::AudioSource {
 public:
  explicit ObservedSongSource(std::shared_ptr<loopz::AudioHistory> history) : history_(std::move(history)) {}
  uint32_t channels() const noexcept override { return 2; }
  loopz::AudioReadResult read(uint64_t host, double rate, loopz::RoutingOutput output,
                             uint32_t frames, loopz::AudioReadCursor& cursor) const noexcept override {
    auto result = history_->read(host, rate, output, frames, cursor);
    observe(host, rate, frames, result); return result;
  }
  loopz::AudioReadResult readWithFilter(uint64_t host, double rate, loopz::RoutingOutput output,
                             uint32_t frames, loopz::AudioReadCursor& cursor,
                             loopz::ResamplingFilter filter) const noexcept override {
    auto result = history_->readWithFilter(host, rate, output, frames, cursor, filter);
    observe(host, rate, frames, result); return result;
  }
 private:
  static void observe(uint64_t host, double rate, uint32_t frames, loopz::AudioReadResult result) noexcept {
    if (result.online && result.missingFrames == 0) return;
    const uint64_t index = missingWritten.fetch_add(1, std::memory_order_relaxed);
    auto& row = missingHistory[index % kPhysicalSlots];
    if (!box_timing::tryClaim(row.sequence, index, journalCoverageLost)) return;
    row.host.store(host, std::memory_order_relaxed);
    row.duration.store(rate > 0 ? uint64_t(double(frames) * kNs / rate) : 0, std::memory_order_relaxed);
    box_timing::publish(row.sequence, index);
  }
  std::shared_ptr<loopz::AudioHistory> history_;
};

// All inventory callers are serialized on the routing control owner. Discovery
// state must outlive temporary hosts constructed by AudioRuntime::inventory().
struct PhysicalInventoryCache {
  std::function<uint64_t()> clock;
  uint64_t attemptedAt = 0;
  bool attempted = false;
  AudioHostInventory inventory;
  std::exception_ptr failure;
  AudioHostInventory enumerate(const AudioHostBackend& backend) {
    const auto now = clock();
    if (!attempted || now < attemptedAt || now - attemptedAt >= kNs) {
      attempted = true;
      attemptedAt = now;
      failure = nullptr;
      try { inventory = backend.enumerate(); }
      catch (...) { failure = std::current_exception(); inventory = {}; }
    }
    if (failure) std::rethrow_exception(failure);
    return inventory;
  }
};

class InstrumentedHost final : public AudioHostBackend {
 public:
  InstrumentedHost(std::unique_ptr<AudioHostBackend> backend,
                   std::shared_ptr<PhysicalInventoryCache> inventory)
      : backend_(std::move(backend)), inventory_(std::move(inventory)), id_(++endpointSerial) {}
  ~InstrumentedHost() override {
    backend_->stop();
    std::erase_if(endpoints, [this](const auto& endpoint) { return endpoint.id == id_; });
  }
  AudioHostInventory enumerate() const override { return inventory_->enumerate(*backend_); }
  std::optional<AudioHostDeviceInfo> describeOutputDevice(const std::string& uid) const override {
    return backend_->describeOutputDevice(uid);
  }
  AudioHostResult open(const AudioHostConfig& config, AudioHostRender render, void* context) override {
    callback_ = render; context_ = context;
    const auto existing = std::find_if(endpoints.begin(), endpoints.end(),
        [this](const auto& endpoint) { return endpoint.id == id_; });
    if (existing != endpoints.end()) existing->uid = config.outputDeviceUid;
    else {
      if (endpoints.size() >= 32) return {false, AudioHostError::InvalidState,
          AudioHostState::Closed, {}, {}, "Box physical endpoint registry is full"};
      endpoints.push_back({id_, config.outputDeviceUid});
    }
    return backend_->open(config, forward, this);
  }
  AudioHostResult start() override { return backend_->start(); }
  void stop() noexcept override { backend_->stop(); }
  AudioHostStatus status() const noexcept override { return backend_->status(); }
  AudioHostResult suspend() override { return backend_->suspend(); }
  AudioHostResult resume() override { return backend_->resume(); }
 private:
  static bool forward(void* opaque, const AudioHostRenderBlock& block) noexcept {
    auto& self = *static_cast<InstrumentedHost*>(opaque);
    // Capture physical metadata unchanged. Multiple output callbacks may run
    // concurrently; every slot has a unique reserved sequence.
    const uint64_t callbackEpoch = epoch.load(std::memory_order_acquire);
    const bool rendered = self.callback_(self.context_, block);
    const bool coherent = callbackEpoch == epoch.load(std::memory_order_acquire);
    const uint64_t index = physicalWritten.fetch_add(1, std::memory_order_relaxed);
    auto& row = physical[index % kPhysicalSlots];
    if (!box_timing::tryClaim(row.sequence, index, journalCoverageLost)) return rendered;
    row.host.store(block.outputTimestampValid ? block.outputHostTimeNs : block.callbackHostTimeNs, std::memory_order_relaxed);
    row.endpoint.store(self.id_, std::memory_order_relaxed);
    row.epoch.store(callbackEpoch, std::memory_order_relaxed);
    row.stream.store(block.streamGeneration, std::memory_order_relaxed);
    row.route.store(block.routeGeneration, std::memory_order_relaxed);
    row.frames.store(rendered && coherent && block.outputTimestampValid && block.sampleRate == 48000 ? block.frames : 0, std::memory_order_relaxed);
    row.flags.store(block.discontinuity, std::memory_order_relaxed);
    box_timing::publish(row.sequence, index);
    return rendered;
  }
  std::unique_ptr<AudioHostBackend> backend_;
  std::shared_ptr<PhysicalInventoryCache> inventory_;
  uint64_t id_;
  AudioHostRender callback_{};
  void* context_{};
};
// Registry and backend lifetime are serialized on the routing owner. Shared
// queues survive physical reopen so an analysis lease follows device recovery.
std::map<std::string, std::shared_ptr<BoxInputQueue>> nativeInputs;
class AnalysisInput final : public AudioInputBackend {
 public:
  explicit AnalysisInput(std::unique_ptr<AudioInputBackend> backend) : backend_(std::move(backend)) {}
  ~AnalysisInput() override { stop(); }
  AudioInputResult open(const AudioInputConfig& c, AudioInputPush p, void* ctx) override {
    return backend_->open(c, p, ctx);
  }
  AudioInputBusResult openBus(const AudioInputBusConfig& c, AudioInputBusPush push, void* ctx) override {
    if (!backend_) return {};
    auto& queue = nativeInputs[c.deviceUid];
    if (!queue) queue = std::make_shared<BoxInputQueue>();
    queue_ = queue; push_ = push; context_ = ctx;
    auto result = backend_->openBus(c, deliver, this);
    rate_ = result.result.sampleRate;
    return result;
  }
  AudioInputResult start() override {
    if (queue_) queue_->start(rate_);
    auto result = backend_->start();
    if (!result.ok && queue_) queue_->stop();
    return result;
  }
  void stop() override {
    backend_->stop();
    if (queue_) queue_->stop();
  }
  bool takeFailure(std::string& error) override { return backend_->takeFailure(error); }
 private:
  static bool deliver(void* opaque, const AudioInputBusBlock& block) noexcept {
    auto& self = *static_cast<AnalysisInput*>(opaque);
    // Publish the original route first; the private tap cannot change its
    // samples, result or lifecycle, including when its queue is full.
    const bool result = self.push_(self.context_, block);
    self.queue_->push(block, self.rate_);
    return result;
  }
  std::unique_ptr<AudioInputBackend> backend_;
  std::shared_ptr<BoxInputQueue> queue_;
  AudioInputBusPush push_{};
  void* context_{};
  double rate_{};
};
bool carriesSong(const loopz::RouteDocument& document, size_t bus, size_t depth = 0) {
  if (depth >= document.devices.size()) return false;
  const auto& device = document.devices[bus];
  if (!device.routing.enabled || device.routing.muted || device.routing.gain == 0) return false;
  for (const auto& binding : device.bindings) {
    auto source = std::find_if(device.routing.sources.begin(), device.routing.sources.end(),
        [&](const auto& row) { return row.id == binding.id; });
    if (source == device.routing.sources.end() || !source->enabled || source->muted ||
        source->gain == 0 || source->connections.empty()) continue;
    if (binding.kind == loopz::SourceKind::Application && binding.selector == "native:singz") return true;
    if (binding.kind == loopz::SourceKind::VirtualDevice) {
      for (size_t other = 0; other < document.devices.size(); ++other)
        if (document.devices[other].id == binding.selector && carriesSong(document, other, depth + 1)) return true;
    }
  }
  return false;
}
void refreshMappingUnchecked();
// Runs after Control has committed state, so it must not report failure to the
// caller: a rebuild failure (realistically only allocation) leaves presentation
// unavailable and forces the next successful selection to open a new epoch.
void refreshMapping() noexcept {
  try { refreshMappingUnchecked(); }
  catch (...) {
    mappingKnown.store(false, std::memory_order_release);
    mappingTiming.reset();
    selectedGeneration = selectedDocumentRevision = 0;
    selectedPrimary.clear();
  }
}
void refreshMappingUnchecked() {
  mappingKnown.store(false, std::memory_order_release);
  if (!control || !runtimeView) return;
  const auto view = control->routeView();
  const auto active = view.activeGeneration;
  if (active != view.desiredGeneration || !view.desired) {
    mappingTiming.reset();
    return;
  }
  const auto& document = *view.desired;
  if (!mappingTiming || mappingDocumentRevision != view.documentRevision ||
      mappingActiveGeneration != active) {
    // Drop the old plan before a possibly throwing rebuild. The borrowed
    // document is used only during this serialized control-owner call.
    mappingTiming.reset();
    mappingTiming = loopz::planSceneTiming(document, {48000, 256, 1024, 128});
    mappingDocumentRevision = view.documentRevision;
    mappingActiveGeneration = active;
  }
  // Endpoint health still refreshes every poll; a cached plan never proves an
  // offline endpoint connected or resurrects an old audible mapping.
  const auto runtime = runtimeView->status();
  const auto& timing = *mappingTiming;
  // The first enabled, unmuted song-bearing monitor is the explicit primary
  // according to saved document order. Additional monitors remain independent.
  for (size_t bus = 0; bus < document.devices.size(); ++bus) {
    const auto& device = document.devices[bus];
    if (!carriesSong(document, bus)) continue;
    for (const auto& monitor : device.monitors) {
      if (!monitor.enabled || monitor.muted || monitor.gain == 0 || monitor.connections.empty()) continue;
      for (const auto& telemetry : runtime.monitors) {
        if (telemetry.device != device.id || telemetry.monitor != monitor.id ||
            !telemetry.historyBudgetKnown || !telemetry.status.sourceOnline) continue;
        uint64_t id = 0;
        for (const auto& endpoint : endpoints) if (endpoint.uid == monitor.deviceSelector) id = endpoint.id;
        if (!id) continue;
        const std::string primary = device.id + "/" + monitor.id + "/" + std::to_string(id);
        const uint64_t routeDelay = uint64_t(telemetry.historyDelayFrames) + timing.latencyFrames.at(bus);
        if (selectedGeneration != active || selectedDocumentRevision != view.documentRevision ||
            selectedPrimary != primary || selectedDelay != routeDelay) {
          epoch.fetch_add(1, std::memory_order_acq_rel);
          selectedGeneration = active; selectedDocumentRevision = view.documentRevision;
          selectedPrimary = primary; selectedDelay = routeDelay;
        }
        primaryEndpoint.store(id, std::memory_order_relaxed);
        // H already includes queued output, period, filter and reserve.
        primaryDelay.store(routeDelay, std::memory_order_relaxed);
        mappingKnown.store(true, std::memory_order_release);
        return;
      }
    }
  }
}
} // namespace

bool initializeBoxRouting(const std::string& statePath, std::string& error) {
  return initializeBoxRoutingWithHost(statePath, error, createPlatformAudioHostBackend);
}
bool initializeBoxRoutingWithHost(const std::string& statePath, std::string& error,
                                  BoxRoutingHostFactory factory,
                                  std::shared_ptr<LoopZSongSource> source,
                                  BoxRoutingInputFactory inputFactory,
                                  std::function<uint64_t()> inventoryClock) {
  if (control) { error = "Box routing is already initialized"; return false; }
  if (statePath.empty() || statePath.find('\0') != std::string::npos || !std::filesystem::path(statePath).is_absolute()) {
    error = "Box routing state path must be absolute"; return false;
  }
  try {
    auto nextSong = source ? std::move(source) : std::make_shared<LoopZSongSource>();
    if (!inputFactory) inputFactory = createPlatformAudioInputBackend;
    auto inventory = std::make_shared<PhysicalInventoryCache>();
    inventory->clock = inventoryClock ? std::move(inventoryClock) : [] {
      return uint64_t(std::chrono::duration_cast<std::chrono::nanoseconds>(
          std::chrono::steady_clock::now().time_since_epoch()).count());
    };
    loopz::runtime::AudioRuntime* nextView = nullptr;
    const auto build = [&] {
      auto runtime = std::make_unique<loopz::runtime::AudioRuntime>(
          [factory, inventory] {
            return std::make_unique<InstrumentedHost>(factory(), inventory);
          },
          [inputFactory]() -> std::unique_ptr<AudioInputBackend> {
            auto backend = inputFactory();
            if (!backend) return {};
            return std::make_unique<AnalysisInput>(std::move(backend));
          });
      nextView = runtime.get();
      runtime->bindNativeSource("native:singz", std::make_shared<ObservedSongSource>(nextSong->history));
      // Construction restores only an explicit saved document. An absent state
      // file leaves the runtime inactive; no default output/mic route is added.
      return std::make_unique<loopz::runtime::Control>(statePath, std::move(runtime));
    };
    auto next = build();
    // Another process holding the LoopZ state lock also reports not-ready, but
    // the saved file is valid and was never read: never move it aside.
    const auto unowned = [](loopz::runtime::Control& candidate) {
      const auto snapshot = candidate.request({{"version", 1}, {"operation", "state"}});
      return "Saved routing is unavailable: " +
             snapshot.at("snapshot").at("restoration").at("error").get<std::string>();
    };
    if (!next->ownsState()) throw std::runtime_error(unowned(*next));
    std::string recovery;
    // Control fails closed on a saved document it cannot restore; every edit
    // then reports storage-unavailable and retry re-reads the same file. With
    // no keyboard on the Box that is a dead end, so preserve the bytes beside
    // the state file once and start from no saved routing.
    const auto initial = next->request({{"version", 1}, {"operation", "state"}});
    if (initial.at("connection").at("ready") != true) {
      const auto reason = initial.at("snapshot").at("restoration").at("error").get<std::string>();
      const auto stamp = std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::system_clock::now().time_since_epoch()).count();
      std::error_code status;
      std::filesystem::path aside;
      for (unsigned attempt = 0; attempt < 16; ++attempt) {
        aside = statePath + ".corrupt-" + std::to_string(stamp) +
                (attempt ? "-" + std::to_string(attempt) : std::string());
        if (!std::filesystem::exists(std::filesystem::symlink_status(aside, status))) break;
        aside.clear();
      }
      // rename() moves a symlink itself, never its target.
      if (!aside.empty()) std::filesystem::rename(statePath, aside, status);
      if (aside.empty() || status) {
        recovery = "Saved routing could not be restored (" + reason +
                   ") and could not be moved aside";
      } else {
        next.reset(); // Release the first runtime's hosts before rebuilding.
        next = build();
        // The lock was released for the rebuild; another owner may have won it.
        if (!next->ownsState()) throw std::runtime_error(unowned(*next));
        recovery = "Saved routing could not be restored (" + reason + "); moved to " +
                   aside.string() + " and started without saved routing";
      }
      std::fprintf(stderr, "singz box routing: %s\n", recovery.c_str());
    }
    auto nextClock = inventory->clock;
    const auto installed = sharedAudioService().configureProvider(
        createLoopZSourceBackend(nextSong), "box-loopz");
    if (!installed.ok) throw std::runtime_error(installed.message);
    // Nothing below may throw: commit the owner, then publish enablement last.
    song = std::move(nextSong);
    control = std::move(next);
    runtimeView = nextView;
    controlClock = std::move(nextClock);
    controlPolled = false;
    controlPolledAt = 0;
    stateRecovery = std::move(recovery);
    refreshMapping();
    enabled.store(true, std::memory_order_release);
    return true;
  } catch (const std::exception& ex) { error = ex.what(); return false; }
  catch (...) { error = "Box routing initialization failed"; return false; }
}
std::string boxRoutingStateRecovery() { return stateRecovery; }
bool boxRoutingInitialized() noexcept { return enabled.load(std::memory_order_acquire); }
bool boxRoutingTimingCoverageLost() noexcept { return journalCoverageLost.load(std::memory_order_acquire); }
bool boxRoutingOwnsCapture() noexcept { return enabled.load(std::memory_order_acquire); }
std::vector<AudioInputDevice> boxRoutingInputDevices() {
  if (!runtimeView) throw std::runtime_error("Box input runtime is unavailable");
  std::vector<AudioInputDevice> result;
  for (const auto& row : runtimeView->inventory().devices) {
    if (row.inputChannels) result.push_back({row.uid, row.label, row.defaultInput,
        row.nominalSampleRate, row.inputChannels, row.inputChannelLabels});
  }
  return result;
}
BoxInputTap acquireBoxInputTap(const std::string& uid, uint32_t channel) {
  if (!runtimeView) throw std::runtime_error("Box input runtime is unavailable");
  const auto inventory = boxRoutingInputDevices();
  auto device = std::find_if(inventory.begin(), inventory.end(), [&](const auto& row) { return row.uid == uid; });
  if (device == inventory.end() || channel >= device->channels || device->channels > 64)
    throw std::runtime_error("Choose an available microphone device and channel");
  // Capture the known physical layout once so later channel selection can use
  // the same owner, and busy probes do not shrink its proven input profile.
  BoxInputTap result;
  result.device = *device; // Finish potentially allocating metadata before acquisition.
  const auto subscription = runtimeView->acquireInput(uid, device->channels);
  try {
    const auto status = runtimeView->inputStatus(subscription.id);
    if (!status || !status->connected)
      throw std::runtime_error(status && !status->error.empty() ? status->error : "Microphone input is offline");
    result.native = nativeInputs.at(uid);
    if (!result.native->acquireReader())
      throw std::runtime_error("Microphone analysis already has a reader");
  } catch (...) {
    runtimeView->releaseInput(subscription.id);
    throw;
  }
  result.id = subscription.id;
  result.source = subscription.source;
  return result;
}
void releaseBoxInputTap(uint64_t id) noexcept {
  if (runtimeView) (void)runtimeView->releaseInput(id);
}

std::string boxRoutingRequest(const std::string& request) {
  if (!control) throw std::runtime_error("Box routing is not initialized");
  auto response = control->request(loopz::parseControlJSON(request));
  refreshMapping();
  // Snapshots embed host-provided device and channel labels verbatim. A USB
  // product string need not be UTF-8; replace invalid bytes instead of failing
  // every state request with nlohmann's type_error.316.
  return response.dump(-1, ' ', false, loopz::JSON::error_handler_t::replace);
}
void pollBoxRouting() {
  if (!control) return;
  const auto view = control->routeView();
  const bool pending = view.desired && view.desiredGeneration != view.activeGeneration;
  const uint64_t now = controlClock();
  if (box_routing_detail::controlPollDue(controlPolled, controlPolledAt, now, pending)) {
    // Stamp before polling: a throwing poll must not turn into a retry storm.
    controlPolled = true;
    controlPolledAt = now;
    control->poll();
  }
  refreshMapping();
}
void shutdownBoxRouting() noexcept {
  // Host must drain shared song renderers before this final process shutdown.
  enabled.store(false, std::memory_order_release);
  mappingKnown.store(false, std::memory_order_release);
  epoch.fetch_add(1, std::memory_order_acq_rel);
  sharedAudioService().shutdown();
  control.reset();
  nativeInputs.clear();
  song.reset();
  runtimeView = nullptr;
  controlClock = nullptr;
  controlPolled = false;
  controlPolledAt = 0;
  stateRecovery.clear();
  endpoints.clear();
  selectedGeneration = selectedDocumentRevision = 0; selectedPrimary.clear();
  mappingTiming.reset();
  mappingDocumentRevision = mappingActiveGeneration = 0;
  // Both the native producer and all runtime/render/physical workers have now
  // joined. Only this full drain permits reclaiming journal slots and loss.
  for (auto& row : physical) row.sequence.store(0, std::memory_order_relaxed);
  for (auto& row : missingHistory) row.sequence.store(0, std::memory_order_relaxed);
  for (auto& row : timeline) row.sequence.store(0, std::memory_order_relaxed);
  physicalWritten.store(0, std::memory_order_relaxed);
  missingWritten.store(0, std::memory_order_relaxed);
  songWritten.store(0, std::memory_order_relaxed);
  journalCoverageLost.store(false, std::memory_order_release);
}
std::unique_ptr<AudioHostBackend> boxRoutingPlaybackBackend() {
  if (!control || !song) return nullptr;
  return createLoopZSourceBackend(song);
}
void recordBoxSongSlice(uint64_t hostNs, uint32_t frames, uint64_t generation,
                        int64_t projectFrame, uint32_t fractionQ32,
                        uint64_t rateQ32, uint32_t state, uint64_t seekCount) noexcept {
  if (!enabled.load(std::memory_order_acquire)) return;
  const uint64_t index = songWritten.load(std::memory_order_relaxed);
  auto& row = timeline[index % kTimelineSlots];
  if (!box_timing::tryClaim(row.sequence, index, journalCoverageLost)) return;
  row.host.store(hostNs, std::memory_order_relaxed);
  row.frames.store(frames, std::memory_order_relaxed);
  row.generation.store(generation, std::memory_order_relaxed);
  row.seek.store(seekCount, std::memory_order_relaxed);
  row.rate.store(rateQ32, std::memory_order_relaxed);
  row.frame.store(projectFrame, std::memory_order_relaxed);
  row.fraction.store(fractionQ32, std::memory_order_relaxed);
  row.state.store(state, std::memory_order_relaxed);
  box_timing::publish(row.sequence, index);
  songWritten.store(index + 1, std::memory_order_release);
}
void recordBoxSongFailure(uint64_t hostNs, uint32_t frames) noexcept {
  if (!enabled.load(std::memory_order_acquire)) return;
  const uint64_t index = missingWritten.fetch_add(1, std::memory_order_relaxed);
  auto& row = missingHistory[index % kPhysicalSlots];
  if (!box_timing::tryClaim(row.sequence, index, journalCoverageLost)) return;
  row.host.store(hostNs, std::memory_order_relaxed);
  row.duration.store(uint64_t(frames) * kNs / 48000, std::memory_order_relaxed);
  box_timing::publish(row.sequence, index);
}
BoxAudibleProjection boxAudibleProjection(uint64_t generation, uint64_t seekCount,
                                        uint64_t graphLatencyFrames) noexcept {
  const uint64_t now = std::chrono::duration_cast<std::chrono::nanoseconds>(
      std::chrono::steady_clock::now().time_since_epoch()).count();
  return boxAudibleProjectionAtTimeForTesting(generation, seekCount, graphLatencyFrames, now);
}
BoxAudibleProjection boxAudibleProjectionAtTimeForTesting(
    uint64_t generation, uint64_t seekCount, uint64_t graphLatencyFrames,
    uint64_t now) noexcept {
  BoxAudibleProjection result;
  if (journalCoverageLost.load(std::memory_order_acquire) ||
      !mappingKnown.load(std::memory_order_acquire)) return result;
  const uint64_t wantedEpoch = epoch.load(std::memory_order_acquire);
  const uint64_t wantedEndpoint = primaryEndpoint.load(std::memory_order_relaxed);
  const uint64_t delay = primaryDelay.load(std::memory_order_relaxed);
  result.routeDelayFrames = delay;
  const uint64_t physicalEnd = physicalWritten.load(std::memory_order_acquire);
  // Prove there is no unpublished physical boundary in the retained snapshot,
  // including callbacks whose endpoint identity has not yet been published.
  for (uint64_t back = 0; back < std::min<uint64_t>(physicalEnd, kPhysicalSlots); ++back) {
    const uint64_t index = physicalEnd - back - 1;
    if (!box_timing::published(physical[index % kPhysicalSlots].sequence, index)) return result;
  }
  bool covered = false;
  uint64_t newestStream = 0, newestRoute = 0;
  bool haveIdentity = false;
  for (uint64_t back = 0; back < std::min<uint64_t>(physicalEnd, kPhysicalSlots); ++back) {
    const uint64_t index = physicalEnd - back - 1;
    const auto& row = physical[index % kPhysicalSlots];
    const uint64_t sequence = row.sequence.load(std::memory_order_acquire);
    if (sequence != index * 2 + 2) return result;
    const uint64_t host = row.host.load(std::memory_order_relaxed);
    const uint64_t id = row.endpoint.load(std::memory_order_relaxed);
    const uint64_t savedEpoch = row.epoch.load(std::memory_order_relaxed);
    const uint32_t frames = row.frames.load(std::memory_order_relaxed);
    const uint32_t flags = row.flags.load(std::memory_order_relaxed);
    const uint64_t stream = row.stream.load(std::memory_order_relaxed);
    const uint64_t route = row.route.load(std::memory_order_relaxed);
    if (!box_timing::stillPublished(row.sequence, sequence)) return result;
    if (id != wantedEndpoint || savedEpoch != wantedEpoch) continue;
    if (!haveIdentity) { newestStream = stream; newestRoute = route; haveIdentity = true; }
    if (stream != newestStream || route != newestRoute) return result;
    if (flags != AudioHostDiscontinuityNone || frames == 0) return result;
    if (host <= now && now - host < uint64_t(frames) * kNs / 48000) { covered = true; break; }
  }
  if (!covered) return result;
  if (delay > UINT64_MAX - graphLatencyFrames) return result;
  const uint64_t totalDelay = delay + graphLatencyFrames;
  if (totalDelay > now / (kNs / 48000)) return result;
  const uint64_t target = now - totalDelay * kNs / 48000;
  // A successfully recorded transport slice does not prove the router read
  // its PCM successfully. Missing upstream history must suppress projection.
  const uint64_t contentTarget = now - delay * kNs / 48000;
  const uint64_t missingEnd = missingWritten.load(std::memory_order_acquire);
  for (uint64_t back = 0; back < std::min<uint64_t>(missingEnd, kPhysicalSlots); ++back) {
    const uint64_t index = missingEnd - back - 1;
    const auto& row = missingHistory[index % kPhysicalSlots];
    const uint64_t sequence = row.sequence.load(std::memory_order_acquire);
    if (sequence != index * 2 + 2) return result;
    const uint64_t host = row.host.load(std::memory_order_relaxed);
    const uint64_t duration = row.duration.load(std::memory_order_relaxed);
    if (!box_timing::stillPublished(row.sequence, sequence)) return result;
    if (contentTarget >= host && contentTarget - host < duration) return result;
  }
  const uint64_t end = songWritten.load(std::memory_order_acquire);
  for (uint64_t back = 0; back < std::min<uint64_t>(end, kTimelineSlots); ++back) {
    const uint64_t index = end - back - 1;
    const auto& row = timeline[index % kTimelineSlots];
    const uint64_t sequence = row.sequence.load(std::memory_order_acquire);
    if (sequence != index * 2 + 2) return result;
    const uint64_t host = row.host.load(std::memory_order_relaxed);
    const uint32_t frames = row.frames.load(std::memory_order_relaxed);
    const uint64_t savedGeneration = row.generation.load(std::memory_order_relaxed);
    const uint64_t seek = row.seek.load(std::memory_order_relaxed);
    const int64_t frame = row.frame.load(std::memory_order_relaxed);
    const uint32_t fraction = row.fraction.load(std::memory_order_relaxed);
    const uint64_t rate = row.rate.load(std::memory_order_relaxed);
    const uint32_t state = row.state.load(std::memory_order_relaxed);
    if (!box_timing::stillPublished(row.sequence, sequence)) return result;
    if (host > target) continue;
    if (target - host >= uint64_t(frames) * kNs / 48000) return result;
    if (savedGeneration != generation || seek != seekCount) return result;
    const long double offset = static_cast<long double>(target - host) * 48000 / kNs;
    // enum Playing/PreRoll values are passed as an explicit advancing flag.
    const long double projected = static_cast<long double>(frame) +
        static_cast<long double>(fraction) / 4294967296.0L +
        (state ? offset * static_cast<long double>(rate) / 4294967296.0L : 0);
    if (projected < -9223372036854775808.0L || projected >= 9223372036854775808.0L) return result;
    if (epoch.load(std::memory_order_acquire) != wantedEpoch || !mappingKnown.load(std::memory_order_acquire)) return result;
    if (!box_timing::unchanged(physicalWritten, physicalEnd,
                               missingWritten, missingEnd, journalCoverageLost)) return result;
    result.available = true;
    result.projectFrame = static_cast<int64_t>(std::floor(projected));
    result.routeDelayFrames = delay;
    return result;
  }
  return result;
}
} // namespace singz

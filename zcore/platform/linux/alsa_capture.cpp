#include "alsa_pcm.h"

#include <zcore/device/audio_input_callback_gate.h>

#include <array>
#include <map>
#include <mutex>
#include <thread>

namespace singz::detail {
// Capture ownership is internal, matching the hidden callback gate it owns.
class __attribute__((visibility("hidden"))) AlsaCaptureRoute final {
 public:
  struct Client {
    AudioInputCallbackGate gate;
    bool leased{false}, started{false};
    AlsaCapturePush push{nullptr};
    void* context{nullptr};
    std::atomic<uint64_t> drops{0};
  };
  ~AlsaCaptureRoute() {
    halt();
  }
  void halt() noexcept {
    stopping.store(true, std::memory_order_release);
    pcm.wake();
    if (worker.joinable()) worker.join();
    if (pcm.handle) snd_pcm_drop(pcm.handle);
  }
  bool start(uint32_t index, std::string& error) {
    std::lock_guard<std::mutex> lock(control);
    auto& client = clients[index];
    if (failure.load(std::memory_order_acquire)) {
      error = "Capture endpoint failed; release all leases and reopen"; return false;
    }
    if (client.started) return true;
    if (!worker.joinable()) {
      int result = snd_pcm_prepare(pcm.handle);
      if (result >= 0) result = snd_pcm_start(pcm.handle);
      if (result < 0) { error = snd_strerror(result); return false; }
      pcm.clearWake();
      stopping.store(false, std::memory_order_release);
      // The gate stays shut until callback state is fully published.
      client.started = true;
      client.gate.open();
      try { worker = std::thread([this] { run(); }); }
      catch (...) {
        client.gate.beginClose(); client.started = false;
        stopping.store(true, std::memory_order_release);
        snd_pcm_drop(pcm.handle);
        error = "Cannot create ALSA capture worker"; return false;
      }
    } else {
      client.started = true;
      client.gate.open();
    }
    return true;
  }
  void stop(uint32_t index, bool release = false) noexcept {
    std::lock_guard<std::mutex> lock(control);
    auto& client = clients[index];
    client.gate.beginClose();
    while (client.gate.inFlight()) std::this_thread::yield();
    client.started = false;
    bool active = false;
    for (const auto& row : clients) active |= row.started;
    if (!active) halt();
    if (release) {
      client.push = nullptr; client.context = nullptr; client.leased = false;
    }
  }
  void run() noexcept {
    while (!stopping.load(std::memory_order_acquire)) {
      const int ready = pcm.wait();
      if (stopping.load(std::memory_order_acquire)) break;
      if (ready < 0) { failure.store(ready, std::memory_order_release); break; }
      if (!ready) continue;
      const auto available = snd_pcm_avail_update(pcm.handle);
      if (available == -EINTR || available == -EAGAIN || available == 0) continue;
      if (available < 0) { failure.store(int(available), std::memory_order_release); break; }
      const snd_pcm_sframes_t count = snd_pcm_readi(pcm.handle, bytes.data(), pcm.period);
      if (count == -EAGAIN || count == -EINTR) continue;
      if (count <= 0 || count > pcm.period) {
        failure.store(count < 0 ? int(count) : -EIO, std::memory_order_release);
        break;
      }
      const auto frames = uint32_t(count);
      nonFinite.fetch_add(alsaDecode(bytes.data(), samples.data(),
          frames * pcm.channels, pcm.sampleFormat), std::memory_order_relaxed);
      const uint64_t now = alsaMonotonicNs();
      const uint64_t queuedNs = uint64_t(double(available) * 1e9 / pcm.rate);
      const uint64_t estimatedFirstSample = now > queuedNs ? now - queuedNs : 0;
      // Queue-depth corrected monotonic estimate, never a hardware timestamp.
      for (auto& client : clients) {
        AudioInputCallbackScope scope(client.gate);
        if (scope && !client.push(client.context, samples.data(), pcm.channels,
                                 frames, sourceFrame, estimatedFirstSample))
          client.drops.fetch_add(1, std::memory_order_relaxed);
      }
      sourceFrame = advanceAudioHostFrame(sourceFrame, frames);
    }
  }
  AlsaPcm pcm;
  std::mutex control;
  std::array<Client, 4> clients;
  std::vector<unsigned char> bytes;
  std::vector<float> samples;
  std::thread worker;
  std::atomic<bool> stopping{true};
  std::atomic<int> failure{0};
  std::atomic<uint64_t> nonFinite{0};
  uint64_t sourceFrame{0};
};

namespace {
std::mutex registryMutex;
std::map<std::string, std::weak_ptr<AlsaCaptureRoute>> routes;
}
std::unique_ptr<AlsaCaptureLease> acquireAlsaCapture(
    const std::string& uid, const std::string& pcm, uint32_t channelsNeeded,
    uint32_t rate, uint32_t period, AlsaCapturePush push, void* context,
    std::string& error) {
  if (!push || uid.empty()) { error = "Capture callback/identity is missing"; return {}; }
  std::lock_guard<std::mutex> registry(registryMutex);
  // Reclaim dead registry keys on the control thread; discovery is unbounded
  // over a machine's lifetime, while active device/client work stays bounded.
  std::erase_if(routes, [](const auto& row) { return row.second.expired(); });
  auto route = routes[uid].lock();
  if (!route) {
    route = std::make_shared<AlsaCaptureRoute>();
    if (!route->pcm.open(pcm, true, channelsNeeded, rate, period,
                         kAudioHostMaxFrames, error)) return {};
    route->bytes.resize(size_t(route->pcm.period) * route->pcm.channels *
                        route->pcm.sampleBytes());
    route->samples.resize(size_t(route->pcm.period) * route->pcm.channels);
    routes[uid] = route;
  }
  std::lock_guard<std::mutex> lock(route->control);
  if (route->pcm.rate != rate || route->pcm.channels < channelsNeeded ||
      route->failure.load(std::memory_order_acquire)) {
    error = "Existing capture lease has an incompatible format or failed endpoint";
    return {};
  }
  for (uint32_t index = 0; index < route->clients.size(); ++index) {
    auto& client = route->clients[index];
    if (client.leased) continue;
    // Allocate before publishing the reservation. A failed allocation must
    // not strand a slot; noncopyable leases cannot later close a reused slot.
    auto lease = std::unique_ptr<AlsaCaptureLease>(new AlsaCaptureLease());
    client.leased = true;
    client.push = push; client.context = context;
    client.drops.store(0, std::memory_order_relaxed);
    lease->route_ = route; lease->slot_ = index;
    return lease;
  }
  error = "ALSA capture subscriber capacity reached";
  return {};
}
AlsaCaptureLease::~AlsaCaptureLease() {
  if (route_) route_->stop(slot_, true);
}
bool AlsaCaptureLease::start(std::string& error) { return route_->start(slot_, error); }
void AlsaCaptureLease::stop() noexcept { if (route_) route_->stop(slot_); }
int AlsaCaptureLease::failure() const noexcept {
  return route_->failure.load(std::memory_order_acquire);
}
uint32_t AlsaCaptureLease::channels() const noexcept { return route_->pcm.channels; }
uint32_t AlsaCaptureLease::period() const noexcept { return route_->pcm.period; }
uint32_t AlsaCaptureLease::bufferFrames() const noexcept { return route_->pcm.buffer; }
uint64_t AlsaCaptureLease::nonFiniteSamples() const noexcept {
  return route_->nonFinite.load(std::memory_order_relaxed);
}
}  // namespace singz::detail

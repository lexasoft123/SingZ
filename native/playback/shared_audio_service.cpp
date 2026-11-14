#include "shared_audio_service.h"
#if defined(SINGZ_BOX_LOOPZ_ROUTING)
#include "box_routing_owner.h"
#endif

#include <algorithm>
#include <atomic>
#include <array>
#include <chrono>
#include <mutex>
#include <thread>
#include <utility>
#include <zcore/device/audio_input_callback_gate.h>

#if defined(__linux__) && !defined(__ANDROID__)
#include <libudev.h>
#include <poll.h>
#endif

#if defined(__APPLE__)
#include <TargetConditionals.h>
#if TARGET_OS_OSX
#include <CoreAudio/CoreAudio.h>
#include <CoreFoundation/CoreFoundation.h>
#include <Block.h>
#include <dispatch/dispatch.h>
#endif
#endif

#if defined(_WIN32)
#include <windows.h>
#include <mmdeviceapi.h>
#include <functiondiscoverykeys_devpkey.h>
#endif

namespace singz {
namespace {
void drain(AudioInputCallbackGate& gate) noexcept {
  gate.beginClose();
  while (gate.inFlight() != 0) std::this_thread::yield();
}
AudioHostResult failure(const char* message) {
  return {false, AudioHostError::InvalidState, AudioHostState::Error,
          {}, {}, message};
}
}

struct SharedAudioService::Impl {
  explicit Impl(std::unique_ptr<AudioHostBackend> source, bool watch)
      : backend(std::move(source)), watchDevices(watch) { callbackGate.open(); }
  AudioInputCallbackGate callbackGate;
  struct RenderClient {
    AudioInputCallbackGate gate;
    AudioHostRender render{nullptr};
    void* context{nullptr};
    std::atomic<bool> failed{false};
    std::atomic<uint64_t> callbacks{0};
    std::atomic<uint64_t> frames{0};
  } playback, training, microphone, monitor;
  ServiceMasterStage master;
  // Song/cue render time belongs to this service, not an AUHAL incarnation.
  // A period-only reopen pauses that clock and keeps DSP/PCM cursors intact.
  struct ClientClock {
    bool initialized{}, pending{}, mapped{};
    uint64_t endFrame{}, stream{}, route{}, sequence{}, nextCallbackNs{}, physicalFrame{}, logicalFrame{}, physicalStream{}, physicalRoute{}, physicalSequence{}, logicalSequence{};
    void map(AudioHostRenderBlock& block) noexcept {
      if (pending && initialized) {
        physicalFrame = block.outputFrame; logicalFrame = endFrame;
        physicalStream = block.streamGeneration; physicalRoute = block.routeGeneration;
        physicalSequence = block.callbackSequence; logicalSequence = sequence + 1;
        mapped = true; pending = false;
        block.discontinuity &= ~(AudioHostDiscontinuityStart | AudioHostDiscontinuityClockReanchored | AudioHostDiscontinuityRouteChanged);
      }
      if (mapped && (block.streamGeneration != physicalStream || block.routeGeneration != physicalRoute ||
          block.outputFrame < physicalFrame || block.callbackSequence < physicalSequence)) mapped = false;
      if (mapped) {
        block.outputFrame = logicalFrame + (block.outputFrame - physicalFrame);
        block.streamGeneration = stream; block.routeGeneration = route;
        block.callbackSequence = logicalSequence + (block.callbackSequence - physicalSequence);
      }
      endFrame = block.outputFrame + block.frames;
      stream = block.streamGeneration; route = block.routeGeneration; initialized = true;
      sequence = block.callbackSequence;
      nextCallbackNs = std::isfinite(block.sampleRate) && block.sampleRate >= 8000
          ? block.callbackHostTimeNs + static_cast<uint64_t>(block.frames * 1e9 / block.sampleRate) : 0;
    }
  } clientClock;
  uint64_t monitorGeneration{0};
  MonitorAdmission monitorAdmission{nullptr};
  bool monitorOutputLost{false};
  mutable std::mutex mutex;
  std::unique_ptr<AudioHostBackend> backend;
  AudioHostInventory cached;
  AudioHostConfig route;
  std::string preferredOutputUid;
  BufferPreferences bufferPreferences;
  uint32_t requestedBuffer(const std::string& uid) const {
    const auto found = bufferPreferences.find(uid);
    return found == bufferPreferences.end() ? 128 : found->second;
  }
  uint32_t supportedBuffer(const std::string& uid) const {
    const auto frames = requestedBuffer(uid);
    const auto device = std::find_if(cached.devices.begin(), cached.devices.end(),
        [&](const auto& d) { return d.uid == uid; });
    if (device == cached.devices.end()) return 0;
    const auto& b = device->bufferFrames;
    return b.minimumFrames && frames >= b.minimumFrames && frames <= b.maximumFrames &&
        (!b.fundamentalFrames || frames % b.fundamentalFrames == 0) ? frames : 0;
  }
  bool parked = false;
  bool songOutputCurrent = false;
  OutputCallbackDiagnostics callbackDiagnostics;
  std::string provider;
  bool enumerated{false};
  bool watchDevices{true};
  std::shared_ptr<std::atomic<bool>> dirty = std::make_shared<std::atomic<bool>>(false);
  std::atomic<bool> quitting{false};
  std::thread watcher;
  std::atomic<uint64_t> frames{0};
  std::atomic<uint64_t> outputGeneration{0};
  std::atomic<double> rate{0};
  std::atomic<uint64_t> revisions{0};
  std::atomic<uint64_t> enumerations{0};
  std::atomic<uint64_t> watchedDevices{0};

#if defined(__APPLE__) && TARGET_OS_OSX
  struct Listener { AudioObjectID object; AudioObjectPropertyAddress address;
    dispatch_queue_t queue; AudioObjectPropertyListenerBlock block;
    std::shared_ptr<std::atomic<bool>> pending; };
  std::vector<Listener> listeners;
  void listen(AudioObjectID object, AudioObjectPropertySelector selector,
              AudioObjectPropertyScope scope = kAudioObjectPropertyScopeGlobal) {
    const AudioObjectPropertyAddress address{selector, scope,
                                             kAudioObjectPropertyElementMain};
    if (!AudioObjectHasProperty(object, &address)) return;
    auto pending = dirty;
    auto* raw = pending.get();
    dispatch_queue_t queue = dispatch_queue_create("singz.inventory", DISPATCH_QUEUE_SERIAL);
    auto block = static_cast<AudioObjectPropertyListenerBlock>(Block_copy(
        ^(UInt32, const AudioObjectPropertyAddress*) {
          raw->store(true, std::memory_order_release);
        }));
    if (AudioObjectAddPropertyListenerBlock(object, &address, queue, block) == noErr)
      listeners.push_back({object, address, queue, block, std::move(pending)});
    else { Block_release(block); dispatch_release(queue); }
  }
  void removeListeners() {
    for (auto& row : listeners) {
      if (AudioObjectRemovePropertyListenerBlock(row.object, &row.address,
          row.queue, row.block) == noErr) {
        dispatch_sync_f(row.queue, nullptr, [](void*) {});
        Block_release(row.block);
        dispatch_release(row.queue);
      } else {
        // A disappearing/broken driver can refuse removal. Its block captures
        // only this retained atomic, never the service. Quarantine on that
        // exceptional path rather than free a callback still registered.
        static auto* quarantine = new std::vector<Listener>();
        static auto* guard = new std::mutex();
        std::lock_guard<std::mutex> lock(*guard);
        quarantine->push_back(std::move(row));
      }
    }
    listeners.clear();
  }
  void installListeners() {
    removeListeners();
    watchedDevices.store(0,std::memory_order_relaxed);
    listen(kAudioObjectSystemObject, kAudioHardwarePropertyDevices);
    listen(kAudioObjectSystemObject, kAudioHardwarePropertyDefaultInputDevice);
    listen(kAudioObjectSystemObject, kAudioHardwarePropertyDefaultOutputDevice);
    for (const auto& device : cached.devices) {
      CFStringRef uid = CFStringCreateWithCString(nullptr, device.uid.c_str(),
                                                 kCFStringEncodingUTF8);
      if (!uid) continue;
      AudioDeviceID id = kAudioObjectUnknown;
      AudioObjectPropertyAddress address{kAudioHardwarePropertyTranslateUIDToDevice,
          kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
      UInt32 size = sizeof(id);
      const auto result = AudioObjectGetPropertyData(kAudioObjectSystemObject,
          &address, sizeof(uid), &uid, &size, &id);
      CFRelease(uid);
      if (result != noErr || id == kAudioObjectUnknown) continue;
      watchedDevices.fetch_add(1,std::memory_order_relaxed);
      listen(id, kAudioDevicePropertyDeviceIsAlive);
      listen(id, kAudioDevicePropertyNominalSampleRate);
      listen(id, kAudioDevicePropertyBufferFrameSize);
      listen(id, kAudioDevicePropertyStreamConfiguration, kAudioObjectPropertyScopeInput);
      listen(id, kAudioDevicePropertyStreamConfiguration, kAudioObjectPropertyScopeOutput);
    }
  }
#elif defined(_WIN32)
  struct Notifications final : IMMNotificationClient {
    explicit Notifications(std::shared_ptr<std::atomic<bool>> pending)
        : pending(std::move(pending)) {}
    std::atomic<ULONG> references{1};
    std::shared_ptr<std::atomic<bool>> pending;
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** value) override {
      if (!value) return E_POINTER;
      *value = nullptr;
      if (iid == __uuidof(IUnknown) || iid == __uuidof(IMMNotificationClient)) {
        *value = static_cast<IMMNotificationClient*>(this); AddRef(); return S_OK;
      }
      return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return ++references; }
    ULONG STDMETHODCALLTYPE Release() override {
      const auto remaining = --references;
      if (!remaining) delete this;
      return remaining;
    }
    HRESULT STDMETHODCALLTYPE OnDeviceStateChanged(LPCWSTR, DWORD) override { changed(); return S_OK; }
    HRESULT STDMETHODCALLTYPE OnDeviceAdded(LPCWSTR) override { changed(); return S_OK; }
    HRESULT STDMETHODCALLTYPE OnDeviceRemoved(LPCWSTR) override { changed(); return S_OK; }
    HRESULT STDMETHODCALLTYPE OnDefaultDeviceChanged(EDataFlow, ERole, LPCWSTR) override { changed(); return S_OK; }
    HRESULT STDMETHODCALLTYPE OnPropertyValueChanged(LPCWSTR, const PROPERTYKEY) override { changed(); return S_OK; }
    void changed() { pending->store(true, std::memory_order_release); }
  };
  // COM notification registration is owned and released on the watcher thread.
  void removeListeners() {}
  void installListeners() {}
#else
  void removeListeners() {}
  void installListeners() {}
#endif

  void refreshLocked() {
    auto inventory = backend->enumerate();
    // Empty is a valid inventory when every endpoint has been disabled. The
    // current provider contract has no separate enumeration-error result.
    cached = std::move(inventory);
    enumerations.fetch_add(1, std::memory_order_relaxed);
    revisions.fetch_add(1, std::memory_order_release);
    enumerated = true;
    if (watchDevices) installListeners();
  }
  void startWatcherLocked() {
    if (!watchDevices || watcher.joinable()) return;
    watcher = std::thread([this] {
#if defined(__linux__) && !defined(__ANDROID__)
      udev* deviceContext = udev_new();
      udev_monitor* monitor = deviceContext ?
          udev_monitor_new_from_netlink(deviceContext, "udev") : nullptr;
      int monitorFd = -1;
      if (monitor && udev_monitor_filter_add_match_subsystem_devtype(
          monitor, "sound", nullptr) == 0 &&
          udev_monitor_enable_receiving(monitor) == 0) {
        monitorFd = udev_monitor_get_fd(monitor);
        watchedDevices.store(1, std::memory_order_relaxed);
        // Close the first-enumeration/monitor-registration race, including
        // a device that was absent when the service was constructed.
        dirty->store(true, std::memory_order_release);
      }
#endif
#if defined(_WIN32)
      const HRESULT apartment = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
      IMMDeviceEnumerator* enumerator = nullptr;
      auto* notifications = new Notifications(dirty);
      if (SUCCEEDED(apartment) && SUCCEEDED(CoCreateInstance(__uuidof(MMDeviceEnumerator),
          nullptr, CLSCTX_ALL, __uuidof(IMMDeviceEnumerator), reinterpret_cast<void**>(&enumerator))))
        enumerator->RegisterEndpointNotificationCallback(notifications);
#endif
      while (!quitting.load(std::memory_order_acquire)) {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
#if defined(__linux__) && !defined(__ANDROID__)
        if (monitorFd >= 0) {
          pollfd descriptor{monitorFd, POLLIN, 0};
          for (uint32_t events = 0; events < 64 &&
               ::poll(&descriptor, 1, 0) > 0 && (descriptor.revents & POLLIN); ++events) {
            udev_device* device = udev_monitor_receive_device(monitor);
            if (!device) break;
            udev_device_unref(device);
            dirty->store(true, std::memory_order_release);
          }
        }
#endif
        if (!dirty->exchange(false, std::memory_order_acq_rel)) continue;
        std::lock_guard<std::mutex> lock(mutex);
        try {
          refreshLocked();
          const auto state = backend->status().state;
          if (!parked && (state == AudioHostState::Running || state == AudioHostState::DeviceLost))
            (void)ensureLocked();
        } catch (...) {
          // Keep the last complete inventory/route. Retry on the next event;
          // an observer/provider exception must never terminate the process.
          dirty->store(true, std::memory_order_release);
        }
      }
#if defined(__linux__) && !defined(__ANDROID__)
      if (monitor) udev_monitor_unref(monitor);
      if (deviceContext) udev_unref(deviceContext);
#endif
#if defined(_WIN32)
      if (enumerator) {
        enumerator->UnregisterEndpointNotificationCallback(notifications);
        enumerator->Release();
      }
      notifications->Release();
      if (SUCCEEDED(apartment)) CoUninitialize();
#endif
    });
  }
  static bool render(void* context, const AudioHostRenderBlock& block) noexcept {
    auto& self = *static_cast<Impl*>(context);
#if defined(__APPLE__) && TARGET_OS_OSX
    self.callbackDiagnostics.observe(block);
#endif
    for (uint32_t channel = 0; channel < block.outputChannels; ++channel)
      if (block.output && block.output[channel])
        std::fill_n(block.output[channel], block.frames, 0.0F);
    self.master.meter.clearSongTargets();
    AudioInputCallbackScope serviceScope(self.callbackGate);
    if (!serviceScope) return true; // Controlled reopen: silence without advancing any client clock.
    auto clientBlock = block;
    self.clientClock.map(clientBlock);
    // A registered graph meter remains alive through the final bus pass.
    AudioInputCallbackScope playbackScope(self.playback.gate);
    {
      if (playbackScope && self.playback.render &&
          !self.playback.render(self.playback.context, clientBlock)) {
        self.playback.failed.store(true, std::memory_order_release);
#if defined(SINGZ_BOX_LOOPZ_ROUTING)
        recordBoxSongFailure(block.callbackHostTimeNs, block.frames);
#endif
      }
      if (playbackScope) {
        self.playback.callbacks.fetch_add(1, std::memory_order_relaxed);
        self.playback.frames.fetch_add(block.frames, std::memory_order_relaxed);
      }
    }
    {
      AudioInputCallbackScope scope(self.training.gate);
      if (scope && self.training.render &&
          !self.training.render(self.training.context, clientBlock))
        self.training.failed.store(true, std::memory_order_release);
    }
    {
      AudioInputCallbackScope scope(self.microphone.gate);
      if (scope && self.microphone.render &&
          !self.microphone.render(self.microphone.context, block))
        self.microphone.failed.store(true, std::memory_order_release);
    }
    {
      AudioInputCallbackScope scope(self.monitor.gate);
      if (scope && self.monitorGeneration == self.outputGeneration.load(std::memory_order_acquire) && self.monitor.render &&
          !self.monitor.render(self.monitor.context, block))
        self.monitor.failed.store(true, std::memory_order_release);
    }
    self.master.process(block);
    self.frames.fetch_add(block.frames, std::memory_order_relaxed);
    return true;
  }
  AudioHostResult openLocked(AudioHostConfig config) {
    // Provider-scoped so the same CoreAudio lifecycle is testable with a fake
    // backend on any host. Other production platforms never select coreaudio.
#if defined(__APPLE__) && TARGET_OS_OSX
    const bool sharedCoreAudio = provider != "box-loopz";
#else
    const bool sharedCoreAudio = provider == "coreaudio";
#endif
    if (sharedCoreAudio) config.allowSharedDeviceBufferChange = true;
    if (!enumerated) refreshLocked();
    startWatcherLocked();
    if (config.outputDeviceUid.empty()) config.outputDeviceUid = cached.defaultOutputUid;
    // Every desktop CoreAudio opener uses one policy, including the silent
    // base host, song, cues and take playback. The zCore backend owns its lease.
    if (provider == "coreaudio") config.requestedBufferFrames = supportedBuffer(config.outputDeviceUid);
    if (config.outputChannels.empty()) {
      const auto found = std::find_if(cached.devices.begin(), cached.devices.end(),
          [&](const auto& device) { return device.uid == config.outputDeviceUid; });
      if (found == cached.devices.end() || found->outputChannels == 0)
        return failure("No output device is available");
      config.outputChannels = {0};
      if (found->outputChannels > 1) config.outputChannels.push_back(1);
      if (config.requestedSampleRate == 0) config.requestedSampleRate = found->nominalSampleRate;
    }
    const auto current = backend->status();
    const bool samePhysical = route.outputDeviceUid == config.outputDeviceUid &&
        route.outputChannels == config.outputChannels && route.inputDeviceUid == config.inputDeviceUid &&
        route.inputChannels == config.inputChannels && route.exclusive == config.exclusive &&
        (config.requestedSampleRate == 0 || route.requestedSampleRate == config.requestedSampleRate);
    // History monitoring never renegotiates the output period. A song joining
    // the running idle host adopts its capacity/period without a hardware seam.
    if (monitor.render && samePhysical && current.format.maximumFrames != 0 &&
        current.format.maximumFrames <= config.maximumFrames &&
        (current.state == AudioHostState::Running || current.state == AudioHostState::Open))
      return {true, AudioHostError::None, current.state, current.format, current.latency, {}};
    const bool same = samePhysical && route.maximumFrames == config.maximumFrames &&
        (config.requestedBufferFrames == 0 || route.requestedBufferFrames == config.requestedBufferFrames) &&
        route.exclusive == config.exclusive && route.holdSharedDeviceBuffer == config.holdSharedDeviceBuffer;
    if (same && (current.state == AudioHostState::Running || current.state == AudioHostState::Open))
      return {true, AudioHostError::None, current.state, current.format, current.latency, {}};
    if (playback.render && playback.gate.accepting()) {
      // A song graph is prepared for an exact output format/clock. Retire its
      // callback on a route seam; its existing terminal recovery must reprepare
      // before it can render against the new hardware format.
      drain(playback.gate);
      playback.failed.store(true, std::memory_order_release);
    }
    if (monitor.render && (current.state == AudioHostState::DeviceLost ||
        (!route.outputDeviceUid.empty() && std::none_of(cached.devices.begin(), cached.devices.end(),
            [&](const auto& device) { return device.uid == route.outputDeviceUid && device.outputChannels; }))))
      monitorOutputLost = true;
    const bool resumeMonitor = monitor.render && current.state == AudioHostState::Running;
    drain(monitor.gate); // Join the old output generation before opening another.
    outputGeneration.fetch_add(1, std::memory_order_release);
    backend->stop();
    clientClock = {}; // Ordinary route changes retain their real discontinuity.
    auto result = backend->open(config, render, this);
    if (result.ok) {
      route = std::move(config);
      rate.store(result.format.sampleRate, std::memory_order_release);
      // Capture/history belongs to the monitor, not the song generation. Admit
      // the new output before callbacks resume, including a paused song prepare.
      if (monitor.render && !monitorOutputLost && (!monitorAdmission || monitorAdmission(monitor.context, cached, route, result))) {
        monitorGeneration = outputGeneration.load(std::memory_order_acquire);
        monitor.gate.open();
        if (resumeMonitor) result = backend->start();
        if (!result.ok) drain(monitor.gate);
      }
    }
    return result;
  }
  AudioHostConfig preferredRouteLocked() {
    if (!enumerated) refreshLocked();
    const auto preferred = std::find_if(cached.devices.begin(), cached.devices.end(),
        [&](const auto& device) { return !preferredOutputUid.empty() && device.uid == preferredOutputUid && device.outputChannels != 0; });
    const std::string selected = preferred != cached.devices.end() ? preferred->uid : cached.defaultOutputUid;
    AudioHostConfig config = route;
    config.holdSharedDeviceBuffer = songOutputCurrent && provider == "coreaudio";
    config.inputDeviceUid.clear(); config.inputChannels.clear();
    if (config.outputDeviceUid != selected) {
      config.outputChannels.clear(); config.requestedSampleRate = 0;
      config.requestedBufferFrames = 0;
    } else {
      // A driver can change its active sample rate without changing UID.
      const auto device = std::find_if(cached.devices.begin(),cached.devices.end(),
          [&](const auto& row) { return row.uid == selected; });
      // Capture can negotiate mono on the same CarPlay/Bluetooth UID that
      // previously played a stereo song. Keep valid explicit selections, but
      // rebuild a map that no longer fits the active endpoint.
      if (device != cached.devices.end() &&
          std::any_of(config.outputChannels.begin(), config.outputChannels.end(),
              [&](uint32_t channel) { return channel >= device->outputChannels; })) {
        config.outputChannels.clear();
        config.requestedBufferFrames = 0;
      }
      if (device != cached.devices.end() && device->nominalSampleRate > 0 &&
          device->nominalSampleRate != config.requestedSampleRate)
        config.requestedSampleRate = device->nominalSampleRate;
    }
    config.outputDeviceUid = selected;
    return config;
  }
  // Control mutex held. A song handback must not disturb live/scheduled cues
  // or microphone output; keep its ledger hold until the last client detaches.
  void completeIdleBufferHandbackLocked() {
    if (songOutputCurrent || monitor.render || !route.holdSharedDeviceBuffer) return;
    if (training.render || microphone.render) return;
    backend->stop();
    outputGeneration.fetch_add(1, std::memory_order_release);
    route.holdSharedDeviceBuffer = false;
  }
  void retireIdleBoxProducerLocked() noexcept {
#if defined(SINGZ_BOX_LOOPZ_ROUTING)
    if (provider == "box-loopz" && !playback.render &&
        !training.render && !microphone.render) backend->stop();
#endif
  }
  AudioHostResult ensureLocked() {
    parked = false;
    auto result = openLocked(preferredRouteLocked());
    if (!result.ok || result.state == AudioHostState::Running) return result;
    return backend->start();
  }

};

class SharedAudioService::Client final : public AudioHostBackend {
 public:
  Client(SharedAudioService& service, std::unique_ptr<AudioHostBackend> backend,
         std::string provider)
      : service_(service), candidate_(std::move(backend)), provider_(std::move(provider)) {
#if defined(SINGZ_BOX_LOOPZ_ROUTING)
    if (boxRoutingInitialized()) provider_ = "box-loopz";
#endif
  }
  ~Client() override { stop(); }
  AudioHostInventory enumerate() const override { return service_.inventory(); }
  std::optional<AudioHostDeviceInfo> describeOutputDevice(const std::string& uid) const override {
    for (const auto& device : service_.inventory().devices)
      if (device.uid == uid && device.outputChannels != 0) return device;
    return std::nullopt;
  }
  AudioHostResult open(const AudioHostConfig& config, AudioHostRender render, void* context) override {
    auto& self = *service_.impl_;
    std::lock_guard<std::mutex> lock(self.mutex);
    if (attached_ || self.playback.render) return failure("A song renderer is already attached");
    if (self.provider != provider_) {

      self.backend->stop();
      self.backend = std::move(candidate_);
      self.provider = provider_;
      self.enumerated = false;
      self.route = {};
    }
    config_ = config;
    config_.holdSharedDeviceBuffer = provider_ == "coreaudio";
    auto result = self.openLocked(config_);
    if (!result.ok) return result;
    // A song selected on a non-default endpoint owns that route too. Otherwise
    // ensureOutput() would silently restore the startup default on its first cue.
    self.preferredOutputUid = config.outputDeviceUid == self.cached.defaultOutputUid &&
        self.preferredOutputUid != config.outputDeviceUid
        ? std::string{} : config.outputDeviceUid;
    self.songOutputCurrent = self.provider == "coreaudio";
    self.playback.render = render;
    self.playback.context = context;
    self.playback.failed.store(false, std::memory_order_release);
    self.playback.callbacks.store(0, std::memory_order_relaxed);
    self.playback.frames.store(0, std::memory_order_relaxed);
    format_ = result.format;
    attached_ = true;
    state_ = AudioHostState::Open;
    result.state = state_;
    return result;
  }
  AudioHostResult start() override {
    auto& self = *service_.impl_;
    std::lock_guard<std::mutex> lock(self.mutex);
    if (!attached_) return failure("No song renderer is attached");
    // Resume restores the song's remembered exact configuration. Training may
    // have used a different output while this renderer was suspended.
    auto result = self.openLocked(config_);
    if (!result.ok) return result;
    if (result.format.sampleRate != format_.sampleRate || result.format.outputChannels != format_.outputChannels)
      return failure("The song output format changed; prepare the graph again");
    self.preferredOutputUid = config_.outputDeviceUid == self.cached.defaultOutputUid &&
        self.preferredOutputUid != config_.outputDeviceUid
        ? std::string{} : config_.outputDeviceUid;
    self.playback.failed.store(false, std::memory_order_release);
    self.playback.gate.open();
    self.parked = false;
    if (result.state != AudioHostState::Running) result = self.backend->start();
    if (!result.ok) drain(self.playback.gate);
    else state_ = AudioHostState::Running;
    return result;
  }
  void stop() noexcept override {
    auto& self = *service_.impl_;
    std::lock_guard<std::mutex> lock(self.mutex);
    if (!attached_) return;
    drain(self.playback.gate);
    self.playback.render = nullptr;
    self.playback.context = nullptr;
    self.playback.failed.store(false, std::memory_order_release);
    self.retireIdleBoxProducerLocked();
    attached_ = false;
    state_ = AudioHostState::Stopped;
  }
  AudioHostStatus status() const noexcept override {
    auto result = service_.status();
    const auto clientState = state_.load(std::memory_order_acquire);
    // stop() publishes Stopped only after this client's callback gate drains.
    // The shared physical stream may retain an error for another owner, but
    // that history cannot revoke proof that this song's callback is detached.
    if (clientState == AudioHostState::Stopped) {
      result.state = clientState;
    } else {
      if (result.state != AudioHostState::DeviceLost && result.state != AudioHostState::Error)
        result.state = clientState;
      if (service_.impl_->playback.failed.load(std::memory_order_acquire))
        result.state = AudioHostState::Error;
    }
    result.callbacks = service_.impl_->playback.callbacks.load(std::memory_order_acquire);
    result.renderedFrames = service_.impl_->playback.frames.load(std::memory_order_acquire);
    return result;
  }
  AudioHostResult suspend() override {
    auto& self = *service_.impl_;
    std::lock_guard<std::mutex> lock(self.mutex);
    if (!attached_ || state_ != AudioHostState::Running) return failure("Song output is not running");
    drain(self.playback.gate);
    state_ = AudioHostState::Suspended;
    const auto host = self.backend->status();
    return {true, AudioHostError::None, state_, host.format, host.latency, {}};
  }
  AudioHostResult resume() override { return start(); }
 private:
  SharedAudioService& service_;
  std::unique_ptr<AudioHostBackend> candidate_;
  std::string provider_;
  bool attached_{false};
  AudioHostConfig config_;
  AudioHostFormat format_;
  std::atomic<AudioHostState> state_{AudioHostState::Closed};
};

SharedAudioService::SharedAudioService()
    : impl_(std::make_unique<Impl>(createPlatformAudioHostBackend(), true)) {
#if defined(__APPLE__)
  impl_->provider = "coreaudio";
#elif defined(_WIN32)
  impl_->provider = "wasapi";
#elif defined(__ANDROID__)
  impl_->provider = "oboe";
#elif defined(__linux__)
  impl_->provider = "alsa";
#endif
}
SharedAudioService::SharedAudioService(std::unique_ptr<AudioHostBackend> backend, std::string provider)
    : impl_(std::make_unique<Impl>(std::move(backend), false)) { impl_->provider = std::move(provider); }
SharedAudioService::~SharedAudioService() { shutdown(); }
AudioHostResult SharedAudioService::applyBufferPreferences(const BufferPreferences& preferences,
    const BufferChangeHooks& hooks) {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  auto& self = *impl_;
  const auto before = self.backend->status();
  if (self.bufferPreferences == preferences)
    return {true, AudioHostError::None, before.state, before.format, before.latency, {}};
  if (self.provider != "coreaudio") return failure("Buffer changes require CoreAudio");
  const auto previous = self.bufferPreferences;
  const auto route = self.route;
  const bool output = !route.outputDeviceUid.empty();
  const bool running = before.state == AudioHostState::Running;
  const std::array<bool, 4> accepting{self.playback.gate.accepting(), self.training.gate.accepting(),
      self.microphone.gate.accepting(), self.monitor.gate.accepting()};
  auto join = [&] { drain(self.callbackGate); drain(self.playback.gate); drain(self.training.gate); drain(self.microphone.gate); drain(self.monitor.gate); };
  auto restore = [&] {
    if (accepting[0]) self.playback.gate.open();
    if (accepting[1]) self.training.gate.open();
    if (accepting[2]) self.microphone.gate.open();
    if (accepting[3]) self.monitor.gate.open();
    self.callbackGate.open();
  };
  join();
  const auto began = std::chrono::steady_clock::now();
  bool pauseRefused = false;
  auto attempt = [&](const BufferPreferences& policy) -> AudioHostResult {
    if (hooks.pauseInput && !hooks.pauseInput()) { pauseRefused = true; return failure("A voice take is recording"); }
    if (output) self.backend->stop(); // Both ledger leases are released before either reopens.
    self.bufferPreferences = policy;
    auto config = route;
    config.requestedBufferFrames = self.supportedBuffer(config.outputDeviceUid);
    auto result = output ? self.backend->open(config, Impl::render, &self)
                         : AudioHostResult{true, AudioHostError::None, before.state, before.format, before.latency, {}};
    if (!result.ok) return result;
    if (output && (result.format.sampleRate != before.format.sampleRate ||
        result.format.outputChannels != before.format.outputChannels ||
        result.format.maximumFrames > before.format.maximumFrames))
      return failure("The audio format changed while applying the buffer size");
    if (hooks.resumeInput) {
      const auto error = hooks.resumeInput(self.supportedBuffer(hooks.inputUid));
      if (!error.empty()) return failure(error.c_str());
    }
    if (output && self.monitor.render && self.monitorAdmission &&
        !self.monitorAdmission(self.monitor.context, self.cached, config, result))
      return failure("The monitor route could not resume after the buffer change");
    self.route = config;
    // AUHAL's physical clock restarts. Keep song/cue DSP time continuous on
    // this same-format route; the monitor still receives physical timestamps.
    self.clientClock.pending = self.clientClock.initialized;
    self.master.current = self.master.destination = self.master.step = 0;
    self.master.remaining = 0; self.master.initialized = true;
    const auto elapsed = static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(
        std::chrono::steady_clock::now() - began).count());
    if (hooks.prepareCues) hooks.prepareCues(elapsed, self.clientClock.nextCallbackNs);
    restore();
    if (output && running) result = self.backend->start();
    return result;
  };
  auto safely = [&](const BufferPreferences& policy) -> AudioHostResult {
    try { return attempt(policy); }
    catch (const std::exception& error) { return failure(error.what()); }
    catch (...) { return failure("Audio buffer change failed"); }
  };
  auto changed = safely(preferences);
  if (changed.ok) return changed;
  if (pauseRefused) {
    self.clientClock.pending = self.clientClock.initialized;
    restore(); return changed;
  }
  join();
  const auto restored = safely(previous);
  if (!restored.ok) {
    join(); self.backend->stop();
    // Output failure must not strand retained capture users in Stopped.
    // Restore input independently; its owner publishes Error on failure.
    if (hooks.resumeInput) {
      try {
        const auto inputError = hooks.resumeInput(self.supportedBuffer(hooks.inputUid));
        if (!inputError.empty()) changed.message += "; input capture could not be restored: " + inputError;
      } catch (const std::exception& error) {
        changed.message += "; input capture could not be restored: " + std::string(error.what());
      } catch (...) { changed.message += "; input capture could not be restored"; }
    }
    self.playback.failed.store(true, std::memory_order_release);
    // The incompatible song stays closed, but a later healthy output
    // must still admit independent cues whose renderer remains attached.
    if (accepting[1]) self.training.gate.open();
    self.callbackGate.open();
    changed.message += "; previous audio route could not be restored: " + restored.message;
  }
  return changed;
}
uint32_t SharedAudioService::requestedBufferFrames(const std::string& uid) const {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  return impl_->requestedBuffer(uid);
}
AudioInputConfig SharedAudioService::inputBufferConfig(AudioInputConfig config) const {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  if (impl_->provider == "coreaudio") {
    if (!impl_->enumerated) impl_->refreshLocked();
    config.requestedBufferFrames = impl_->supportedBuffer(config.deviceUid);
    config.allowSharedDeviceBufferChange = true;
    config.maximumAcceptableBufferFrames = 0;
  }
  return config;
}
AudioHostResult SharedAudioService::initialize(const AudioHostConfig& config) {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  if (config.outputDeviceUid.empty() && config.outputChannels.empty() &&
      !impl_->route.outputDeviceUid.empty())
    return impl_->openLocked(impl_->route);
  impl_->preferredOutputUid = config.outputDeviceUid;
  return impl_->openLocked(config);
}
AudioHostResult SharedAudioService::configureOutput(const std::string& preferredUid) {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  if (!impl_->enumerated) impl_->refreshLocked();
  if (!preferredUid.empty() && std::none_of(impl_->cached.devices.begin(),impl_->cached.devices.end(),
      [&](const auto& device) { return device.uid == preferredUid && device.outputChannels != 0; }))
    return failure("The selected output device is unavailable");
  const bool running = impl_->backend->status().state == AudioHostState::Running;
  impl_->preferredOutputUid = preferredUid;
  auto result = impl_->openLocked(impl_->preferredRouteLocked());
  if (result.ok && running && result.state != AudioHostState::Running && !impl_->parked)
    result = impl_->backend->start();
  return result;
}
AudioHostResult SharedAudioService::configureProvider(std::unique_ptr<AudioHostBackend> backend,
                                                    const std::string& provider) {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  const std::string effectiveProvider =
#if defined(SINGZ_BOX_LOOPZ_ROUTING)
      boxRoutingInitialized() ? "box-loopz" :
#endif
      provider;
  if (impl_->provider == effectiveProvider) {
    const auto status = impl_->backend->status();
    return {true,AudioHostError::None,status.state,status.format,status.latency,{}};
  }
  if (impl_->playback.render) return failure("Change the song output provider before starting training");
  if (!backend) return failure("The selected audio provider is unavailable");
  impl_->outputGeneration.fetch_add(1, std::memory_order_release);
  impl_->backend->stop();
  impl_->removeListeners();
  impl_->backend = std::move(backend); impl_->provider = effectiveProvider;
  impl_->route = {}; impl_->songOutputCurrent = false;
  impl_->preferredOutputUid.clear(); impl_->enumerated = false;
  return impl_->openLocked({});
}
AudioHostResult SharedAudioService::ensureOutput() {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  return impl_->ensureLocked();
}
AudioHostInventory SharedAudioService::inventory() const {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  if (!impl_->enumerated) impl_->refreshLocked();
  impl_->startWatcherLocked();
  return impl_->cached;
}
std::vector<AudioInputDevice> SharedAudioService::inputDevices() const {
  std::vector<AudioInputDevice> result;
  for (const auto& device : inventory().devices)
    if (device.inputChannels != 0)
      result.push_back({device.uid, device.label, device.defaultInput,
          device.nominalSampleRate, device.inputChannels, device.inputChannelLabels});
  return result;
}
void SharedAudioService::refreshInventory() {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  impl_->refreshLocked();
}
void SharedAudioService::setTrainingRenderer(AudioHostRender render, void* context) {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  drain(impl_->training.gate);
  impl_->training.render = render;
  impl_->training.context = context;
  impl_->training.failed.store(false, std::memory_order_release);
  if (render) impl_->training.gate.open();
  else { impl_->completeIdleBufferHandbackLocked(); impl_->retireIdleBoxProducerLocked(); }
}
void SharedAudioService::clearTrainingRenderer() { setTrainingRenderer(nullptr, nullptr); }
void SharedAudioService::setMicrophoneRenderer(AudioHostRender render, void* context) {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  drain(impl_->microphone.gate);
  impl_->microphone.render = render;
  impl_->microphone.context = context;
  impl_->microphone.failed.store(false, std::memory_order_release);
  if (render) impl_->microphone.gate.open();
  else { impl_->completeIdleBufferHandbackLocked(); impl_->retireIdleBoxProducerLocked(); }
}
void SharedAudioService::clearMicrophoneRenderer() { setMicrophoneRenderer(nullptr, nullptr); }
void SharedAudioService::setVoiceMonitorRenderer(AudioHostRender render, void* context, MonitorAdmission admission) {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  drain(impl_->monitor.gate);
  impl_->monitor.render = render;
  impl_->monitor.context = context;
  impl_->monitorAdmission = admission;
  if (render) impl_->monitorOutputLost = false;
  impl_->monitorGeneration = impl_->outputGeneration.load(std::memory_order_acquire);
  impl_->monitor.failed.store(false, std::memory_order_release);
  if (render) {
    const auto current = impl_->backend->status();
    const AudioHostResult opening{true, AudioHostError::None, current.state, current.format, current.latency, {}};
    if (!admission || admission(context, impl_->cached, impl_->route, opening)) impl_->monitor.gate.open();
  } else impl_->completeIdleBufferHandbackLocked();
}
bool SharedAudioService::voiceMonitorOutputLost() const {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  return impl_->monitorOutputLost;
}
bool SharedAudioService::hasVoiceMonitorRenderer(const void* context) const {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  return impl_->monitor.render && impl_->monitor.context == context;
}
void SharedAudioService::clearVoiceMonitorRenderer() { setVoiceMonitorRenderer(nullptr, nullptr); }
bool SharedAudioService::setMasterGain(float gain) noexcept {
  if (!std::isfinite(gain) || gain < 0.0F || gain > 4.0F) return false;
  impl_->master.target.store(gain, std::memory_order_release);
  return true;
}
ServiceMasterMeterSnapshot SharedAudioService::outputMeter() const noexcept {
  return impl_->master.meter.snapshot();
}
ServiceMasterMeter& SharedAudioService::masterMeterState() noexcept {
  return impl_->master.meter;
}
AudioHostStatus SharedAudioService::status() const {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  return impl_->backend->status();
}
uint64_t SharedAudioService::renderedFrames() const noexcept { return impl_->frames.load(std::memory_order_acquire); }
double SharedAudioService::sampleRate() const noexcept { return impl_->rate.load(std::memory_order_acquire); }
uint64_t SharedAudioService::inventoryRevision() const noexcept { return impl_->revisions.load(std::memory_order_acquire); }
uint64_t SharedAudioService::enumerationCount() const noexcept { return impl_->enumerations.load(std::memory_order_acquire); }
uint64_t SharedAudioService::watchedDeviceCount() const noexcept { return impl_->watchedDevices.load(std::memory_order_acquire); }
std::string SharedAudioService::providerId() const {
  std::lock_guard<std::mutex> lock(impl_->mutex); return impl_->provider;
}
std::string SharedAudioService::activeOutputUid() const {
  std::lock_guard<std::mutex> lock(impl_->mutex); return impl_->route.outputDeviceUid;
}
AudioHostConfig SharedAudioService::activeOutputConfig() const {
  std::lock_guard<std::mutex> lock(impl_->mutex); return impl_->route;
}
AudioHostConfig SharedAudioService::commonOutputConfig() const {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  if (impl_->songOutputCurrent) return impl_->route;
  if (!impl_->enumerated || impl_->dirty->load(std::memory_order_acquire)) impl_->refreshLocked();
  auto config = impl_->preferredRouteLocked();
  if (config.outputChannels.empty()) {
    const auto device = std::find_if(impl_->cached.devices.begin(),impl_->cached.devices.end(),
        [&](const auto& row) { return row.uid == config.outputDeviceUid; });
    if (device != impl_->cached.devices.end() && device->outputChannels) {
      config.outputChannels = {0};
      if (device->outputChannels > 1) config.outputChannels.push_back(1);
    }
  }
  return config;
}
OutputCallbackDiagnosticSnapshot SharedAudioService::callbackDiagnostics() const noexcept {
  return snapshotOutputCallbacks(impl_->callbackDiagnostics);
}
bool SharedAudioService::playbackOutputCurrent() const {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  return impl_->songOutputCurrent;
}
bool SharedAudioService::setPlaybackOutputCurrent(bool current) {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  if (current && (impl_->provider != "coreaudio" || !impl_->playback.render ||
                  impl_->route.outputDeviceUid.empty())) return false;
  impl_->songOutputCurrent = current;
  if (!current) impl_->completeIdleBufferHandbackLocked();
  return true;
}
uint32_t SharedAudioService::retainedPlaybackCapacity(const AudioHostConfig& config) const {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  const auto& route=impl_->route;
  const auto status=impl_->backend->status();
  if (!impl_->monitor.render ||
      (status.state!=AudioHostState::Running && status.state!=AudioHostState::Open) ||
      route.outputDeviceUid!=config.outputDeviceUid || route.outputChannels!=config.outputChannels ||
      route.requestedSampleRate!=config.requestedSampleRate || route.exclusive!=config.exclusive)
    return 0;
  return status.format.maximumFrames;
}
uint64_t SharedAudioService::outputRouteGeneration() const noexcept {
  return impl_->outputGeneration.load(std::memory_order_acquire);
}
void SharedAudioService::parkOutput() noexcept {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  impl_->parked = true;
  impl_->outputGeneration.fetch_add(1, std::memory_order_release);
  impl_->backend->stop();
}
void SharedAudioService::shutdown() noexcept {
  impl_->quitting.store(true, std::memory_order_release);
  if (impl_->watcher.joinable()) impl_->watcher.join();
  std::lock_guard<std::mutex> lock(impl_->mutex);
  impl_->outputGeneration.fetch_add(1, std::memory_order_release);
  impl_->backend->stop();
  drain(impl_->playback.gate);
  drain(impl_->training.gate);
  drain(impl_->microphone.gate);
  drain(impl_->monitor.gate);
  impl_->monitor.render = nullptr;
  impl_->microphone.render = nullptr;
  impl_->songOutputCurrent = false;

  impl_->playback.render = nullptr;
  impl_->training.render = nullptr;
  impl_->removeListeners();
}
std::unique_ptr<AudioHostBackend> SharedAudioService::playbackBackend(
    std::unique_ptr<AudioHostBackend> backend, std::string provider) {
  return std::make_unique<Client>(*this, std::move(backend), std::move(provider));
}
SharedAudioService& sharedAudioService() {
  // The addon environment cleanup owns shutdown. Static playback sessions can
  // outlive function statics during process destruction, so retain the empty
  // facade until process exit rather than destroy a client-facing singleton.
  static SharedAudioService* service = new SharedAudioService();
  return *service;
}
std::unique_ptr<AudioHostBackend> sharedPlaybackBackend(
    std::unique_ptr<AudioHostBackend> backend, std::string provider) {
  return sharedAudioService().playbackBackend(std::move(backend), std::move(provider));
}
}  // namespace singz

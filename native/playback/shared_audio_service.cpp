#include "shared_audio_service.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <mutex>
#include <thread>
#include <utility>
#include <zcore/device/audio_input_callback_gate.h>

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
      : backend(std::move(source)), watchDevices(watch) {}
  struct RenderClient {
    AudioInputCallbackGate gate;
    AudioHostRender render{nullptr};
    void* context{nullptr};
    std::atomic<bool> failed{false};
    std::atomic<uint64_t> callbacks{0};
    std::atomic<uint64_t> frames{0};
  } playback, training;
  mutable std::mutex mutex;
  std::unique_ptr<AudioHostBackend> backend;
  AudioHostInventory cached;
  AudioHostConfig route;
  std::string preferredOutputUid;
  bool parked = false;
  std::string provider;
  bool enumerated{false};
  bool watchDevices{true};
  std::shared_ptr<std::atomic<bool>> dirty = std::make_shared<std::atomic<bool>>(false);
  std::atomic<bool> quitting{false};
  std::thread watcher;
  std::atomic<uint64_t> frames{0};
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
    for (uint32_t channel = 0; channel < block.outputChannels; ++channel)
      if (block.output && block.output[channel])
        std::fill_n(block.output[channel], block.frames, 0.0F);
    {
      AudioInputCallbackScope scope(self.playback.gate);
      if (scope && self.playback.render &&
          !self.playback.render(self.playback.context, block))
        self.playback.failed.store(true, std::memory_order_release);
      if (scope) {
        self.playback.callbacks.fetch_add(1, std::memory_order_relaxed);
        self.playback.frames.fetch_add(block.frames, std::memory_order_relaxed);
      }
    }
    {
      AudioInputCallbackScope scope(self.training.gate);
      if (scope && self.training.render &&
          !self.training.render(self.training.context, block))
        self.training.failed.store(true, std::memory_order_release);
    }
    self.frames.fetch_add(block.frames, std::memory_order_relaxed);
    return true;
  }
  AudioHostResult openLocked(AudioHostConfig config) {
    if (!enumerated) refreshLocked();
    startWatcherLocked();
    if (config.outputDeviceUid.empty()) config.outputDeviceUid = cached.defaultOutputUid;
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
    const bool same = route.outputDeviceUid == config.outputDeviceUid &&
        route.outputChannels == config.outputChannels &&
        route.inputDeviceUid == config.inputDeviceUid && route.inputChannels == config.inputChannels &&
        route.maximumFrames == config.maximumFrames &&
        (config.requestedSampleRate == 0 || route.requestedSampleRate == config.requestedSampleRate) &&
        (config.requestedBufferFrames == 0 || route.requestedBufferFrames == config.requestedBufferFrames) &&
        route.exclusive == config.exclusive;
    if (same && (current.state == AudioHostState::Running || current.state == AudioHostState::Open))
      return {true, AudioHostError::None, current.state, current.format, current.latency, {}};
    if (playback.render && playback.gate.accepting()) {
      // A song graph is prepared for an exact output format/clock. Retire its
      // callback on a route seam; its existing terminal recovery must reprepare
      // before it can render against the new hardware format.
      drain(playback.gate);
      playback.failed.store(true, std::memory_order_release);
    }
    backend->stop();
    auto result = backend->open(config, render, this);
    if (result.ok) {
      route = std::move(config);
      rate.store(result.format.sampleRate, std::memory_order_release);
    }
    return result;
  }
  AudioHostConfig preferredRouteLocked() {
    if (!enumerated) refreshLocked();
    const auto preferred = std::find_if(cached.devices.begin(), cached.devices.end(),
        [&](const auto& device) { return !preferredOutputUid.empty() && device.uid == preferredOutputUid && device.outputChannels != 0; });
    const std::string selected = preferred != cached.devices.end() ? preferred->uid : cached.defaultOutputUid;
    AudioHostConfig config = route;
    config.inputDeviceUid.clear(); config.inputChannels.clear();
    if (config.outputDeviceUid != selected) {
      config.outputChannels.clear(); config.requestedSampleRate = 0;
      config.requestedBufferFrames = 0;
    } else {
      // A driver can change its active sample rate without changing UID.
      const auto device = std::find_if(cached.devices.begin(),cached.devices.end(),
          [&](const auto& row) { return row.uid == selected; });
      if (device != cached.devices.end() && device->nominalSampleRate > 0 &&
          device->nominalSampleRate != config.requestedSampleRate)
        config.requestedSampleRate = device->nominalSampleRate;
    }
    config.outputDeviceUid = selected;
    return config;
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
      : service_(service), candidate_(std::move(backend)), provider_(std::move(provider)) {}
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
    auto result = self.openLocked(config);
    if (!result.ok) return result;
    // A song selected on a non-default endpoint owns that route too. Otherwise
    // ensureOutput() would silently restore the startup default on its first cue.
    self.preferredOutputUid = config.outputDeviceUid == self.cached.defaultOutputUid &&
        self.preferredOutputUid != config.outputDeviceUid
        ? std::string{} : config.outputDeviceUid;
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
    attached_ = false;
    state_ = AudioHostState::Stopped;
  }
  AudioHostStatus status() const noexcept override {
    auto result = service_.status();
    if (result.state != AudioHostState::DeviceLost && result.state != AudioHostState::Error)
      result.state = state_;
    if (service_.impl_->playback.failed.load(std::memory_order_acquire))
      result.state = AudioHostState::Error;
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
#endif
}
SharedAudioService::SharedAudioService(std::unique_ptr<AudioHostBackend> backend)
    : impl_(std::make_unique<Impl>(std::move(backend), false)) {}
SharedAudioService::~SharedAudioService() { shutdown(); }
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
  if (impl_->provider == provider) {
    const auto status = impl_->backend->status();
    return {true,AudioHostError::None,status.state,status.format,status.latency,{}};
  }
  if (impl_->playback.render) return failure("Change the song output provider before starting training");
  if (!backend) return failure("The selected audio provider is unavailable");
  impl_->backend->stop();
  impl_->removeListeners();
  impl_->backend = std::move(backend); impl_->provider = provider;
  impl_->route = {}; impl_->preferredOutputUid.clear(); impl_->enumerated = false;
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
}
void SharedAudioService::clearTrainingRenderer() { setTrainingRenderer(nullptr, nullptr); }
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
void SharedAudioService::parkOutput() noexcept {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  impl_->parked = true;
  impl_->backend->stop();
}
void SharedAudioService::shutdown() noexcept {
  impl_->quitting.store(true, std::memory_order_release);
  if (impl_->watcher.joinable()) impl_->watcher.join();
  std::lock_guard<std::mutex> lock(impl_->mutex);
  impl_->backend->stop();
  drain(impl_->playback.gate);
  drain(impl_->training.gate);
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

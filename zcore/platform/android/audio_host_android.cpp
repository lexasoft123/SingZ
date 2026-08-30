#include <zcore/device/audio_host.h>

#if defined(__ANDROID__)

#if !defined(__ANDROID_API__) || __ANDROID_API__ < 28
#error "SingZ Android AudioHost requires Android API 28 or newer"
#endif

#include <android/api-level.h>
#include <oboe/Oboe.h>
#include <time.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include <zcore/device/audio_host_callback.h>

#include "audio_host_android_callback.h"
#include "audio_host_android_lifecycle.h"
#include "audio_host_android_policy.h"
#include "audio_host_android_provider.h"
#include "audio_host_android_registry.h"
#include "audio_host_android_sampler.h"

namespace singz {
namespace {

constexpr int64_t kStateTimeoutNs = 2000000000LL;
constexpr uint32_t kCallbackDrainTimeoutMs = 2000;
constexpr char kAndroidPackageName[] = "com.lexasoft.singz";

static_assert(std::atomic<uint32_t>::is_always_lock_free);
static_assert(std::atomic<int32_t>::is_always_lock_free);

struct AndroidAudioHostPreparedState {
  detail::AndroidAudioHostCallbackContext callbackContext;
  detail::AndroidAudioHostCallbackOwner callbackOwner;
  std::shared_ptr<detail::AndroidAudioHostCallback> callback;
  std::vector<uint32_t> inputChannelMap;
  std::vector<int32_t> outputChannelMap;
  std::vector<float> inputInterleaved;
  std::vector<float> inputPlanar;
  std::vector<float> outputPlanar;
};

// Callback-retained coordination object. It deliberately owns every object
// touched by Oboe error/data callbacks and by the timestamp/error workers.
// The process quarantine retains this whole object when Oboe teardown cannot
// prove quiescence, so no callback can fall through to a destroyed backend.
struct AndroidAudioHostControlBlock {
  // operationMutex serializes application-owned Oboe lifecycle calls. It is
  // never acquired by an Oboe callback. pairMutex protects only the compact
  // epoch/teardown state and is never held across an Oboe call or sampler
  // join, so Oboe callbacks cannot invert a lifecycle lock.
  // API calls may nest (open/fail call stop) but competing public calls must
  // remain serialized even while stop temporarily yields operationMutex to
  // the error worker.
  mutable std::recursive_mutex apiMutex;
  mutable std::mutex operationMutex;
  mutable std::mutex pairMutex;
  std::mutex errorMutex;
  std::condition_variable errorCv;
  detail::AndroidAudioHostErrorHandoffState errorHandoff{};
  std::shared_ptr<oboe::AudioStream> input;
  std::shared_ptr<oboe::AudioStream> output;
  std::unique_ptr<AndroidAudioHostPreparedState> prepared;
  detail::AndroidAudioHostSamplerOwner timestampSampler;
  std::thread errorWorker;
  std::atomic<uint32_t> outputPresentationFrames{0};
  std::atomic<uint32_t> inputDriverXruns{0};
  std::atomic<uint32_t> outputDriverXruns{0};
  std::atomic<AudioHostState> state{AudioHostState::Closed};
  detail::AndroidAudioHostPairState pairState{};
  double sampleRate{0.0};
};

struct AndroidAudioHostProcessLease {
  std::mutex mutex;
  const void* owner{nullptr};
  bool poisoned{false};
  std::shared_ptr<AndroidAudioHostControlBlock> retiredControl;
};

AndroidAudioHostProcessLease& processLease() {
  static auto* lease = new AndroidAudioHostProcessLease();
  return *lease;
}

bool claimProcessLease(const void* owner) {
  auto& lease = processLease();
  std::lock_guard<std::mutex> lock(lease.mutex);
  if (lease.poisoned || (lease.owner != nullptr && lease.owner != owner)) {
    return false;
  }
  lease.owner = owner;
  return true;
}

void releaseProcessLease(const void* owner) {
  auto& lease = processLease();
  std::lock_guard<std::mutex> lock(lease.mutex);
  if (lease.owner == owner) lease.owner = nullptr;
}

void poisonProcessLease(
    const void* owner, std::shared_ptr<AndroidAudioHostControlBlock> control) {
  auto& lease = processLease();
  std::lock_guard<std::mutex> lock(lease.mutex);
  if (lease.owner == owner && !lease.poisoned) {
    lease.retiredControl = std::move(control);
    lease.poisoned = true;
    lease.owner = nullptr;
  } else {
    (void)new std::shared_ptr<AndroidAudioHostControlBlock>(
        std::move(control));
  }
}

uint64_t monotonicNowNs() noexcept {
  timespec now{};
  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0 || now.tv_sec < 0 ||
      now.tv_nsec < 0) {
    return 0;
  }
  return static_cast<uint64_t>(now.tv_sec) * 1000000000ULL +
         static_cast<uint64_t>(now.tv_nsec);
}

uint32_t saturatingFrames(long double value) noexcept {
  if (!std::isfinite(value) || value <= 0.0L) return 0;
  if (value >= static_cast<long double>(UINT32_MAX)) return UINT32_MAX;
  return static_cast<uint32_t>(value);
}

detail::AndroidAudioHostApi androidApi(oboe::AudioApi value) noexcept {
  switch (value) {
    case oboe::AudioApi::AAudio:
      return detail::AndroidAudioHostApi::AAudio;
    case oboe::AudioApi::OpenSLES:
      return detail::AndroidAudioHostApi::OpenSles;
    case oboe::AudioApi::Unspecified:
      return detail::AndroidAudioHostApi::Unknown;
  }
  return detail::AndroidAudioHostApi::Unknown;
}

detail::AndroidAudioHostOpenedStream openedFacts(
    oboe::AudioStream& stream) noexcept {
  detail::AndroidAudioHostOpenedStream result;
  const int32_t channels = stream.getChannelCount();
  const int32_t rate = stream.getSampleRate();
  const int32_t burst = stream.getFramesPerBurst();
  const int32_t callback = stream.getFramesPerDataCallback();
  const int32_t bufferSize = stream.getBufferSizeInFrames();
  const int32_t capacity = stream.getBufferCapacityInFrames();
  result.deviceId = stream.getDeviceId();
  result.channels = channels > 0 ? static_cast<uint32_t>(channels) : 0;
  result.sampleRate = rate > 0 ? static_cast<uint32_t>(rate) : 0;
  result.framesPerBurst = burst > 0 ? static_cast<uint32_t>(burst) : 0;
  result.framesPerCallback = callback > 0 ? static_cast<uint32_t>(callback) : 0;
  result.bufferSizeFrames =
      bufferSize > 0 ? static_cast<uint32_t>(bufferSize) : 0;
  result.bufferCapacityFrames = capacity > 0 ? static_cast<uint32_t>(capacity) : 0;
  result.api = androidApi(stream.getAudioApi());
  result.format = stream.getFormat() == oboe::AudioFormat::Float
                      ? AudioHostSampleFormat::Float32
                      : AudioHostSampleFormat::Unknown;
  result.performance =
      stream.getPerformanceMode() == oboe::PerformanceMode::LowLatency
          ? detail::AndroidAudioHostPerformance::LowLatency
          : detail::AndroidAudioHostPerformance::Unknown;
  result.accessMode =
      stream.getSharingMode() == oboe::SharingMode::Exclusive
          ? AudioHostAccessMode::Exclusive
          : AudioHostAccessMode::Shared;
  if (android_get_device_api_level() >= 34) {
    const int32_t hardwareChannels = stream.getHardwareChannelCount();
    const int32_t hardwareRate = stream.getHardwareSampleRate();
    result.hardwareChannels =
        hardwareChannels > 0 ? static_cast<uint32_t>(hardwareChannels) : 0;
    result.hardwareSampleRate =
        hardwareRate > 0 ? static_cast<uint32_t>(hardwareRate) : 0;
    const oboe::AudioFormat hardwareFormat = stream.getHardwareFormat();
    result.hardwareFormat =
        hardwareFormat == oboe::AudioFormat::Float
            ? AudioHostSampleFormat::Float32
            : hardwareFormat == oboe::AudioFormat::Unspecified
                  ? AudioHostSampleFormat::Unknown
                  : AudioHostSampleFormat::Other;
  }
  return result;
}

bool waitStarted(oboe::AudioStream& stream) {
  oboe::StreamState state = stream.getState();
  const uint64_t start = monotonicNowNs();
  while (state != oboe::StreamState::Started &&
         state != oboe::StreamState::Disconnected) {
    if (start == 0 || monotonicNowNs() - start >=
                          static_cast<uint64_t>(kStateTimeoutNs)) {
      return false;
    }
    oboe::StreamState next = state;
    const oboe::Result waited =
        stream.waitForStateChange(state, &next, 100000000LL);
    if (waited != oboe::Result::OK && waited != oboe::Result::ErrorTimeout) {
      return false;
    }
    state = next;
  }
  return state == oboe::StreamState::Started;
}

bool waitCallbacks(const detail::AndroidAudioHostCallback& callback,
                   const detail::AndroidAudioHostCallbackContext& context) noexcept {
  const auto deadline = std::chrono::steady_clock::now() +
                        std::chrono::milliseconds(kCallbackDrainTimeoutMs);
  while ((callback.inFlight() != 0 || context.admission.inFlight() != 0 ||
          context.endpoint.inFlight.load(std::memory_order_acquire) != 0) &&
         std::chrono::steady_clock::now() < deadline) {
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  return callback.inFlight() == 0 && context.admission.inFlight() == 0 &&
         context.endpoint.inFlight.load(std::memory_order_acquire) == 0;
}

class AndroidOboeAudioHostBackend final : public AudioHostBackend {
 public:
  AndroidOboeAudioHostBackend()
      : control_(std::make_shared<AndroidAudioHostControlBlock>()) {}

  ~AndroidOboeAudioHostBackend() override {
    stop();
    shutdownErrorWorker(*control_);
  }

  AudioHostInventory enumerate() const override {
    const auto snapshot = detail::androidAudioHostInventorySnapshot();
    AudioHostInventory inventory;
    inventory.devices.reserve(snapshot.devices.size());
    for (const auto& source : snapshot.devices) {
      AudioHostDeviceInfo device;
      device.uid = source.uid;
      device.label = source.label;
      device.inputChannels = source.input ? source.channels : 0;
      device.outputChannels = source.output ? source.channels : 0;
      device.nominalSampleRate = source.nominalSampleRate;
      for (double rate : source.sampleRates) {
        device.sampleRateRanges.push_back({rate, rate});
      }
      device.direction = source.input && source.output
                             ? AudioHostEndpointDirection::Duplex
                             : source.input ? AudioHostEndpointDirection::Input
                                            : AudioHostEndpointDirection::Output;
      device.transport = source.transport;
      device.monitoringSuitability = source.monitoringSuitability;
      for (uint32_t channel = 0; channel < device.inputChannels; ++channel) {
        device.inputChannelLabels.push_back("Input " +
                                            std::to_string(channel + 1));
      }
      for (uint32_t channel = 0; channel < device.outputChannels; ++channel) {
        device.outputChannelLabels.push_back("Output " +
                                             std::to_string(channel + 1));
      }
      inventory.devices.push_back(std::move(device));
    }
    return inventory;
  }

  AudioHostResult open(const AudioHostConfig& config, AudioHostRender render,
                       void* renderContext) override {
    std::lock_guard<std::recursive_mutex> api(control_->apiMutex);
    stop();
    if (!ensureErrorWorker(*control_)) {
      return reject(AudioHostError::ProviderFailure,
                    "Android could not start the Oboe error teardown worker");
    }
    if (render == nullptr) {
      return reject(AudioHostError::InvalidConfiguration,
                    "Android AudioHost render thunk is unavailable");
    }
    if (!claimProcessLease(this)) {
      return reject(AudioHostError::InvalidState,
                    "the process-local Android Oboe host is unavailable");
    }
    leaseHeld_ = true;
    std::unique_lock<std::mutex> lifecycle(control_->operationMutex);
    bool quarantined = false;
    {
      std::lock_guard<std::mutex> pair(control_->pairMutex);
      quarantined = control_->pairState.phase ==
                    detail::AndroidAudioHostPairPhase::Quarantined;
    }
    if (quarantined) {
      return failLocked(lifecycle, AudioHostError::InvalidState,
                        "the Android Oboe pair is quarantined");
    }
    format_ = {};
    latency_ = {};
    routeGeneration_ = 0;
    inputCapacityFrames_ = 0;
    outputCapacityFrames_ = 0;
    inputBurstFrames_ = 0;
    outputBurstFrames_ = 0;
    highLatencyOutput_ = false;
    inputHardwareRate_ = 0;
    outputHardwareRate_ = 0;
    inputHardwareChannels_ = 0;
    outputHardwareChannels_ = 0;
    inputHardwareFormat_ = AudioHostSampleFormat::Unknown;
    outputHardwareFormat_ = AudioHostSampleFormat::Unknown;
    control_->outputPresentationFrames.store(0, std::memory_order_relaxed);
    control_->inputDriverXruns.store(0, std::memory_order_relaxed);
    control_->outputDriverXruns.store(0, std::memory_order_relaxed);

    const auto snapshot = detail::androidAudioHostInventorySnapshot();
    detail::AndroidAudioHostPreparedRoute route;
    std::string error;
    AudioHostError errorCode = AudioHostError::InvalidConfiguration;
    if (!detail::prepareAndroidAudioHostRoute(config, snapshot, &route, error,
                                              &errorCode)) {
      return failLocked(lifecycle, errorCode, std::move(error));
    }

    const uint64_t pairEpoch = ++lastStreamGeneration_;
    bool pairOpened = false;
    {
      std::lock_guard<std::mutex> pair(control_->pairMutex);
      pairOpened = detail::androidAudioHostBeginPairOpen(&control_->pairState,
                                                         pairEpoch);
    }
    if (!pairOpened) {
      return failLocked(lifecycle, AudioHostError::InvalidState,
                        "the Android Oboe pair cannot begin a new epoch");
    }

    control_->prepared = std::make_unique<AndroidAudioHostPreparedState>();
    auto& prepared = *control_->prepared;
    prepared.inputChannelMap = route.inputChannelMap;
    prepared.outputChannelMap = route.outputChannelMap;
    prepared.callback = std::make_shared<detail::AndroidAudioHostCallback>(
        route.outputEndpointChannels);
    prepared.callbackOwner.context = &prepared.callbackContext;
    prepared.callbackOwner.control = control_.get();
    prepared.callbackOwner.pairEpoch = pairEpoch;
    prepared.callbackOwner.observeError = &observeErrorThunk;
    prepared.callbackOwner.beforeErrorClose = &beforeErrorCloseThunk;
    prepared.callbackOwner.afterErrorClose = &afterErrorCloseThunk;
    prepared.callback->bind(&prepared.callbackOwner);
    // This must precede the first builder call: Oboe may synchronously invoke
    // the newly bound error callback from inside openStream. No later open
    // preparation is allowed to erase that callback-published failure.
    prepared.callbackContext.runtimeFailure.store(
        static_cast<int32_t>(detail::AndroidAudioHostRuntimeFailure::None),
        std::memory_order_release);
    prepared.callbackContext.failureGeneration.store(0,
                                                      std::memory_order_release);
    prepared.callbackContext.admission.beginClose();

    oboe::AudioStreamBuilder outputBuilder;
    outputBuilder.setDirection(oboe::Direction::Output)
        ->setDeviceId(route.outputDeviceId)
        ->setChannelCount(static_cast<int32_t>(route.outputEndpointChannels))
        ->setFormat(oboe::AudioFormat::Float)
        ->setFormatConversionAllowed(false)
        ->setChannelConversionAllowed(false)
        ->setSampleRateConversionQuality(oboe::SampleRateConversionQuality::None)
        ->setSharingMode(config.exclusive ? oboe::SharingMode::Exclusive
                                          : oboe::SharingMode::Shared)
        ->setPerformanceMode(oboe::PerformanceMode::LowLatency)
        ->setUsage(oboe::Usage::Media)
        ->setContentType(oboe::ContentType::Music)
        ->setPackageName(kAndroidPackageName)
        ->setDataCallback(prepared.callback)
        ->setErrorCallback(prepared.callback);
    if (config.requestedBufferFrames != 0) {
      outputBuilder.setFramesPerDataCallback(
          static_cast<int32_t>(config.requestedBufferFrames));
    }
    const oboe::Result outputOpened = outputBuilder.openStream(control_->output);
    if (outputOpened != oboe::Result::OK || !control_->output) {
      return failLocked(lifecycle, AudioHostError::ProviderFailure,
                  std::string("Oboe could not open the Android output: ") +
                      oboe::convertToText(outputOpened));
    }
    if (!openingCheckpoint(pairEpoch, false, false, false)) {
      return failLocked(lifecycle, AudioHostError::ProviderFailure,
                        "the Android output failed while opening");
    }
    bool outputPublished = false;
    {
      std::lock_guard<std::mutex> pair(control_->pairMutex);
      outputPublished = detail::androidAudioHostPublishOutputIdentity(
          &control_->pairState, pairEpoch, control_->output.get());
    }
    if (!outputPublished) {
      return failLocked(lifecycle, AudioHostError::InvalidState,
                        "the Android output belongs to a stale pair epoch");
    }
    if (!openingCheckpoint(pairEpoch, true, false, false)) {
      return failLocked(lifecycle, AudioHostError::ProviderFailure,
                        "the Android output failed after identity publication");
    }
    const auto outputFacts = openedFacts(*control_->output);
    if (!openingCheckpoint(pairEpoch, true, false, false)) {
      return failLocked(lifecycle, AudioHostError::ProviderFailure,
                        "the Android output changed while facts were queried");
    }
    const AudioHostError outputValidation =
        detail::validateAndroidAudioHostOpenedStream(
            outputFacts, route.outputDeviceId, route.outputEndpointChannels,
            config.requestedSampleRate, config.requestedBufferFrames,
            config.maximumFrames,
            config.exclusive ? AudioHostAccessMode::Exclusive
                             : AudioHostAccessMode::Shared,
            true, error);
    if (outputValidation != AudioHostError::None) {
      return failLocked(lifecycle, outputValidation, std::move(error));
    }
    outputHardwareRate_ = outputFacts.hardwareSampleRate;
    outputHardwareChannels_ = outputFacts.hardwareChannels;
    outputHardwareFormat_ = outputFacts.hardwareFormat;

    if (route.inputEndpointChannels != 0) {
      if (outputFacts.bufferCapacityFrames >
          static_cast<uint32_t>(std::numeric_limits<int32_t>::max() / 2)) {
        return failLocked(lifecycle, AudioHostError::ProviderFailure,
                    "Oboe output capacity cannot size the paired input");
      }
      const uint32_t requestedInputCapacity = outputFacts.bufferCapacityFrames * 2;
      oboe::AudioStreamBuilder inputBuilder;
      inputBuilder.setDirection(oboe::Direction::Input)
          ->setDeviceId(route.inputDeviceId)
          ->setChannelCount(static_cast<int32_t>(route.inputEndpointChannels))
          ->setSampleRate(static_cast<int32_t>(outputFacts.sampleRate))
          ->setFormat(oboe::AudioFormat::Float)
          ->setFormatConversionAllowed(false)
          ->setChannelConversionAllowed(false)
          ->setSampleRateConversionQuality(oboe::SampleRateConversionQuality::None)
          ->setBufferCapacityInFrames(static_cast<int32_t>(requestedInputCapacity))
          ->setSharingMode(config.exclusive ? oboe::SharingMode::Exclusive
                                            : oboe::SharingMode::Shared)
          ->setPerformanceMode(oboe::PerformanceMode::LowLatency)
          ->setInputPreset(oboe::InputPreset::VoicePerformance)
          ->setPackageName(kAndroidPackageName)
          ->setErrorCallback(prepared.callback);
      const oboe::Result inputOpened = inputBuilder.openStream(control_->input);
      if (inputOpened != oboe::Result::OK || !control_->input) {
        return failLocked(lifecycle, AudioHostError::ProviderFailure,
                    std::string("Oboe could not open the paired Android input: ") +
                        oboe::convertToText(inputOpened));
      }
      if (!openingCheckpoint(pairEpoch, true, false, true)) {
        return failLocked(lifecycle, AudioHostError::ProviderFailure,
                          "the paired Android input failed while opening");
      }
      bool inputPublished = false;
      {
        std::lock_guard<std::mutex> pair(control_->pairMutex);
        inputPublished = detail::androidAudioHostPublishInputIdentity(
            &control_->pairState, pairEpoch, control_->input.get());
      }
      if (!inputPublished) {
        return failLocked(lifecycle, AudioHostError::InvalidState,
                          "the Android input belongs to a stale pair epoch");
      }
      if (!openingCheckpoint(pairEpoch, true, true, true)) {
        return failLocked(lifecycle, AudioHostError::ProviderFailure,
                          "the Android input failed after identity publication");
      }
      const auto inputFacts = openedFacts(*control_->input);
      if (!openingCheckpoint(pairEpoch, true, true, true)) {
        return failLocked(lifecycle, AudioHostError::ProviderFailure,
                          "the Android input changed while facts were queried");
      }
      const AudioHostError inputValidation =
          detail::validateAndroidAudioHostOpenedStream(
              inputFacts, route.inputDeviceId, route.inputEndpointChannels,
              outputFacts.sampleRate, 0, config.maximumFrames,
              config.exclusive ? AudioHostAccessMode::Exclusive
                               : AudioHostAccessMode::Shared,
              true, error);
      if (inputValidation != AudioHostError::None) {
        return failLocked(lifecycle, inputValidation, std::move(error));
      }
      inputHardwareRate_ = inputFacts.hardwareSampleRate;
      inputHardwareChannels_ = inputFacts.hardwareChannels;
      inputHardwareFormat_ = inputFacts.hardwareFormat;
      if (inputFacts.sampleRate != outputFacts.sampleRate ||
          inputFacts.bufferCapacityFrames < requestedInputCapacity) {
        return failLocked(lifecycle, AudioHostError::ProviderFailure,
                    "Oboe did not preserve the paired rate and 2x input capacity");
      }
      const oboe::InputPreset expectedPreset =
          android_get_device_api_level() <= 28
              ? oboe::InputPreset::VoiceRecognition
              : oboe::InputPreset::VoicePerformance;
      const oboe::InputPreset actualPreset = control_->input->getInputPreset();
      if (!openingCheckpoint(pairEpoch, true, true, true)) {
        return failLocked(lifecycle, AudioHostError::ProviderFailure,
                          "the Android input changed while its preset was queried");
      }
      if (actualPreset != expectedPreset) {
        return failLocked(lifecycle, AudioHostError::ProviderFailure,
                    "Oboe did not preserve the supported VoicePerformance input preset");
      }
      inputCapacityFrames_ = inputFacts.bufferCapacityFrames;
      inputBurstFrames_ = inputFacts.framesPerBurst;
    }

    if (detail::androidAudioHostRouteGenerationSignal()->load(
            std::memory_order_acquire) != route.routeGeneration) {
      return failLocked(lifecycle, AudioHostError::DeviceNotFound,
                  "Android endpoints changed while the Oboe pair was opening");
    }

    const uint32_t rate = outputFacts.sampleRate;
    const uint32_t nominalFrames = config.requestedBufferFrames != 0
                                       ? config.requestedBufferFrames
                                       : outputFacts.framesPerBurst;
    format_ = {static_cast<double>(rate),
               config.maximumFrames,
               nominalFrames,
               static_cast<uint32_t>(config.inputChannels.size()),
               static_cast<uint32_t>(config.outputChannels.size()),
               true,
               true,
               config.exclusive ? AudioHostAccessMode::Exclusive
                                : AudioHostAccessMode::Shared};
    control_->sampleRate = format_.sampleRate;
    latency_ = {0, 0, outputFacts.bufferSizeFrames, 0};
    outputCapacityFrames_ = outputFacts.bufferCapacityFrames;
    outputBurstFrames_ = outputFacts.framesPerBurst;
    // Unknown routes are not silently promoted to local/monitoring-safe.
    highLatencyOutput_ = route.monitoringSuitability !=
                         AudioHostMonitoringSuitability::LowLatency;

    const std::size_t maximumFrames = format_.maximumFrames;
    if (format_.inputChannels != 0) {
      prepared.inputInterleaved.assign(
          maximumFrames * route.inputEndpointChannels, 0.0F);
      prepared.inputPlanar.assign(maximumFrames * format_.inputChannels, 0.0F);
    }
    prepared.outputPlanar.assign(maximumFrames * format_.outputChannels, 0.0F);

    auto& callback = prepared.callbackContext;
    callback.inputStream = control_->input.get();
    callback.outputStream = control_->output.get();
    callback.format = format_;
    callback.inputEndpointChannels = route.inputEndpointChannels;
    callback.outputEndpointChannels = route.outputEndpointChannels;
    callback.inputChannelMap = prepared.inputChannelMap.empty()
                                   ? nullptr
                                   : prepared.inputChannelMap.data();
    callback.outputChannelMap = prepared.outputChannelMap.data();
    callback.inputInterleaved = prepared.inputInterleaved.empty()
                                    ? nullptr
                                    : prepared.inputInterleaved.data();
    for (uint32_t channel = 0; channel < format_.inputChannels; ++channel) {
      callback.inputPointers[channel] =
          prepared.inputPlanar.data() + maximumFrames * channel;
    }
    for (uint32_t channel = 0; channel < format_.outputChannels; ++channel) {
      callback.outputPointers[channel] =
          prepared.outputPlanar.data() + maximumFrames * channel;
    }
    callback.routeGeneration = detail::androidAudioHostRouteGenerationSignal();
    callback.inputDriverXruns = &control_->inputDriverXruns;
    callback.outputDriverXruns = &control_->outputDriverXruns;
    callback.expectedRouteGeneration = route.routeGeneration;
    callback.streamGeneration = pairEpoch;
    callback.starvationLimitCallbacks =
        std::clamp<uint32_t>((rate * 2 + nominalFrames - 1) / nominalFrames,
                             64, 4096);
    callback.admission.beginClose();
    resetCallbackCounters(callback.endpoint);
    prepareAudioHostCallback(&callback.endpoint, render, renderContext);

    routeGeneration_ = route.routeGeneration;
    if (!commitOpen(pairEpoch, route.inputEndpointChannels != 0)) {
      return failLocked(lifecycle, AudioHostError::ProviderFailure,
                        "the Android Oboe pair failed before open committed");
    }
    return {true, AudioHostError::None, AudioHostState::Open, format_, latency_, {}};
  }

  AudioHostResult start() override {
    std::lock_guard<std::recursive_mutex> api(control_->apiMutex);
    std::unique_lock<std::mutex> lifecycle(control_->operationMutex);
    if (!control_->output || !control_->prepared ||
        control_->state.load(std::memory_order_acquire) !=
            AudioHostState::Open) {
      return {false, AudioHostError::InvalidState,
              control_->state.load(std::memory_order_acquire), format_, latency_,
              "open the Android Oboe host before starting it"};
    }
    auto& callback = control_->prepared->callbackContext;
    // Capture the immutable terminal token before admission is opened and
    // before requestStart/waitStarted can re-enter an Oboe callback. A
    // terminal increments the token before its delayed failure/admission
    // stores; the bracket therefore cannot accidentally adopt that increment
    // as a new healthy baseline.
    const uint32_t failureGenerationBeforeStart =
        callback.failureGeneration.load(std::memory_order_acquire);
    uint64_t pairEpoch = 0;
    uint32_t startFailureGeneration = 0;
    bool pairStarting = false;
    {
      std::lock_guard<std::mutex> pair(control_->pairMutex);
      pairEpoch = control_->pairState.epoch;
      const detail::AndroidAudioHostStartBaselineFacts baseline{
          failureGenerationBeforeStart,
          callback.runtimeFailure.load(std::memory_order_acquire) ==
              static_cast<int32_t>(
                  detail::AndroidAudioHostRuntimeFailure::None),
          callback.admission.accepting(),
          detail::androidAudioHostRouteGenerationSignal()->load(
              std::memory_order_acquire) == routeGeneration_,
          callback.failureGeneration.load(std::memory_order_acquire)};
      pairStarting = detail::androidAudioHostBeginPairStart(
          &control_->pairState, pairEpoch, baseline);
      startFailureGeneration = baseline.failureGenerationAfter;
    }
    if (!pairStarting) {
      return {false, AudioHostError::InvalidState,
              control_->state.load(std::memory_order_acquire), format_, latency_,
              "open the Android Oboe host before starting it"};
    }
    if (detail::androidAudioHostRouteGenerationSignal()->load(
            std::memory_order_acquire) != routeGeneration_) {
      return failLocked(lifecycle, AudioHostError::DeviceNotFound,
                  "Android endpoints changed before the Oboe pair started");
    }
    callback.drain = format_.inputChannels != 0
                         ? detail::AndroidAudioHostDrainState{}
                         : detail::AndroidAudioHostDrainState{0, 0, 0};
    callback.consecutiveEmptyInput = 0;
    callback.seenDriverXruns = {
        control_->inputDriverXruns.load(std::memory_order_relaxed),
        control_->outputDriverXruns.load(std::memory_order_relaxed)};
    callback.inputTimestampHardware = 2;
    callback.firstRender = 1;
    callback.callbackSequence = 0;
    callback.inputSourceFrame = 0;
    callback.outputFrame = 0;
    callback.outputTimeline = {};
    callback.inputTimestamp.reset();
    callback.outputTimestamp.reset();
    callback.inputOccupancyCurrent.store(0, std::memory_order_relaxed);
    callback.inputOccupancyMinimum.store(UINT32_MAX,
                                         std::memory_order_relaxed);
    callback.inputOccupancyMaximum.store(0, std::memory_order_relaxed);
    callback.inputUnderflows.store(0, std::memory_order_relaxed);
    control_->inputDriverXruns.store(0, std::memory_order_relaxed);
    callback.admission.open();
    activateAudioHostCallback(&callback.endpoint);

    const void* inputIdentity = control_->input.get();
    const void* outputIdentity = control_->output.get();
    const auto stillStarting = [&] {
      std::lock_guard<std::mutex> pair(control_->pairMutex);
      return control_->pairState.epoch == pairEpoch &&
             control_->pairState.phase ==
                 detail::AndroidAudioHostPairPhase::Starting &&
             control_->pairState.teardownOwner ==
                 detail::AndroidAudioHostTeardownOwner::None &&
             !control_->pairState.uncertainty;
    };
    const auto startRun = detail::androidAudioHostStartPair(
        inputIdentity, outputIdentity,
        [](const void* identity) {
          return static_cast<oboe::AudioStream*>(
                     const_cast<void*>(identity))->requestStart() ==
                 oboe::Result::OK;
        },
        [](const void* identity) {
          return waitStarted(*static_cast<oboe::AudioStream*>(
              const_cast<void*>(identity)));
        },
        [&](const void* identity) {
          std::lock_guard<std::mutex> pair(control_->pairMutex);
          if (control_->pairState.epoch != pairEpoch) return;
          if (identity == inputIdentity) control_->pairState.inputStarted = true;
          if (identity == outputIdentity) {
            control_->pairState.outputStarted = true;
          }
        },
        stillStarting);
    if (startRun != detail::AndroidAudioHostLifecycleRun::Completed) {
      return failLocked(
          lifecycle,
          startRun == detail::AndroidAudioHostLifecycleRun::Superseded
              ? AudioHostError::InvalidState
              : AudioHostError::ProviderFailure,
          "the Android Oboe pair changed or failed while starting");
    }
    if (!startTimestampSampler(*control_, pairEpoch)) {
      return failLocked(lifecycle, AudioHostError::ProviderFailure,
                  "Android could not start the off-RT timestamp sampler");
    }
    if (detail::androidAudioHostRouteGenerationSignal()->load(
            std::memory_order_acquire) != routeGeneration_) {
      return failLocked(lifecycle, AudioHostError::DeviceNotFound,
                  "Android endpoints changed while the Oboe pair started");
    }
    if (callback.runtimeFailure.load(std::memory_order_acquire) !=
        static_cast<int32_t>(detail::AndroidAudioHostRuntimeFailure::None)) {
      return failLocked(lifecycle, AudioHostError::ProviderFailure,
                  "the Android Oboe pair failed while it was starting");
    }
    if (!commitStart(pairEpoch, startFailureGeneration)) {
      return failLocked(lifecycle, AudioHostError::InvalidState,
                        "the Android Oboe pair changed while starting");
    }
    if (!finalStartHealthy(startFailureGeneration)) {
      control_->state.store(AudioHostState::Error, std::memory_order_release);
      return failLocked(lifecycle, AudioHostError::ProviderFailure,
                        "the Android Oboe pair failed as start committed");
    }
    return {true, AudioHostError::None, AudioHostState::Running, format_,
            currentLatencyLocked(), {}};
  }

  void stop() noexcept override {
    std::lock_guard<std::recursive_mutex> api(control_->apiMutex);
    std::unique_lock<std::mutex> lifecycle(control_->operationMutex);
    uint64_t pairEpoch = 0;
    detail::AndroidAudioHostPairPhase pairPhase =
        detail::AndroidAudioHostPairPhase::Empty;
    {
      std::lock_guard<std::mutex> pair(control_->pairMutex);
      pairEpoch = control_->pairState.epoch;
      pairPhase = control_->pairState.phase;
    }
    if (pairPhase == detail::AndroidAudioHostPairPhase::Quarantined) {
      control_->state.store(AudioHostState::Error, std::memory_order_release);
      return;
    }
    if (pairEpoch == 0 ||
        ((pairPhase == detail::AndroidAudioHostPairPhase::Empty ||
          pairPhase == detail::AndroidAudioHostPairPhase::Closed) &&
         !control_->input && !control_->output && !control_->prepared)) {
      if (leaseHeld_) releaseProcessLease(this);
      leaseHeld_ = false;
      return;
    }
    detail::AndroidAudioHostUserStopAction stopAction;
    detail::AndroidAudioHostTeardownOwner teardownOwner;
    bool inputStarted = false;
    bool outputStarted = false;
    {
      std::lock_guard<std::mutex> pair(control_->pairMutex);
      stopAction = detail::androidAudioHostClaimUserStop(
          &control_->pairState, pairEpoch);
      teardownOwner = control_->pairState.teardownOwner;
      inputStarted = control_->pairState.inputStarted;
      outputStarted = control_->pairState.outputStarted;
    }
    if (stopAction == detail::AndroidAudioHostUserStopAction::Stale ||
        (stopAction == detail::AndroidAudioHostUserStopAction::AlreadyStopping &&
         teardownOwner == detail::AndroidAudioHostTeardownOwner::User)) {
      return;
    }
    if (control_->prepared) {
      control_->prepared->callbackContext.admission.beginClose();
      deactivateAudioHostCallback(&control_->prepared->callbackContext.endpoint);
    }
    // This owner is independent of operationMutex/pairMutex. If Oboe is in
    // before-close, the two callers serialize here and both return only after
    // every timestamp/xrun query for this epoch has left the stream.
    control_->timestampSampler.stopAndJoin(pairEpoch);
    {
      std::lock_guard<std::mutex> pair(control_->pairMutex);
      if (control_->pairState.epoch == pairEpoch) {
        control_->pairState.timestampSamplerStarted = false;
      }
    }

    bool uncertain = false;
    if (stopAction ==
        detail::AndroidAudioHostUserStopAction::WaitForErrorWorker) {
      lifecycle.unlock();
      if (!waitForErrorWorker(*control_, pairEpoch)) uncertain = true;
      lifecycle.lock();
      {
        std::lock_guard<std::mutex> pair(control_->pairMutex);
        if (control_->pairState.epoch != pairEpoch ||
            !control_->pairState.workerCompleted) {
          uncertain = true;
        }
      }
    } else if (stopAction ==
                   detail::AndroidAudioHostUserStopAction::OperatePair) {
      const auto stillUserOwned = [&] {
        std::lock_guard<std::mutex> pair(control_->pairMutex);
        return control_->pairState.epoch == pairEpoch &&
               control_->pairState.teardownOwner ==
                   detail::AndroidAudioHostTeardownOwner::User &&
               control_->pairState.phase ==
                   detail::AndroidAudioHostPairPhase::UserStopping &&
               !control_->pairState.uncertainty;
      };
      const auto stopRun = detail::androidAudioHostStopClosePair(
          control_->input.get(), inputStarted, control_->output.get(),
          outputStarted, nullptr,
          [](const void* identity) {
            return acceptableStopped(static_cast<oboe::AudioStream*>(
                const_cast<void*>(identity))->stop(kStateTimeoutNs));
          },
          [](const void* identity) {
            return acceptableClosed(static_cast<oboe::AudioStream*>(
                const_cast<void*>(identity))->close());
          },
          stillUserOwned);
      uncertain =
          stopRun != detail::AndroidAudioHostLifecycleRun::Completed;
      std::lock_guard<std::mutex> pair(control_->pairMutex);
      detail::androidAudioHostPublishPairUncertainty(
          &control_->pairState, pairEpoch, uncertain);
    }

    if (control_->prepared) control_->prepared->callback->beginClose();

    // Oboe callbacks never acquire operationMutex, so callback admission can
    // drain while the one application lifecycle owner remains serialized.
    AndroidAudioHostPreparedState* prepared = control_->prepared.get();
    if (prepared && !waitCallbacks(*prepared->callback,
                                   prepared->callbackContext)) {
      uncertain = true;
    }
    if (control_->prepared.get() != prepared) {
      uncertain = true;
    }
    {
      std::lock_guard<std::mutex> pair(control_->pairMutex);
      if (control_->pairState.epoch != pairEpoch) uncertain = true;
      uncertain = uncertain || control_->pairState.uncertainty;
    }
    if (prepared && !uncertain &&
        !prepared->callback->clearOwnerIfQuiescent()) {
      uncertain = true;
    }
    bool teardownCertain = false;
    {
      std::lock_guard<std::mutex> pair(control_->pairMutex);
      detail::androidAudioHostPublishPairUncertainty(
          &control_->pairState, pairEpoch, uncertain);
      teardownCertain = detail::androidAudioHostCompleteUserStop(
          &control_->pairState, pairEpoch, uncertain);
    }

    if (!teardownCertain) {
      poisonProcessLease(this, control_);
      leaseHeld_ = false;
      control_->state.store(AudioHostState::Error, std::memory_order_release);
      return;
    }
    control_->input.reset();
    control_->output.reset();
    control_->prepared.reset();
    if (leaseHeld_) releaseProcessLease(this);
    leaseHeld_ = false;
    const AudioHostState previous =
        control_->state.load(std::memory_order_acquire);
    control_->state.store(
        previous == AudioHostState::Closed ? AudioHostState::Closed
                                           : AudioHostState::Stopped,
        std::memory_order_release);
  }

  AudioHostStatus status() const noexcept override {
    std::lock_guard<std::mutex> lifecycle(control_->operationMutex);
    AudioHostStatus result;
    detail::AndroidAudioHostPairPhase pairPhase;
    {
      std::lock_guard<std::mutex> pair(control_->pairMutex);
      pairPhase = control_->pairState.phase;
    }
    int32_t failure = 0;
    if (control_->prepared) {
      failure = control_->prepared->callbackContext.runtimeFailure.load(
          std::memory_order_acquire);
    }
    const auto runtime = static_cast<detail::AndroidAudioHostRuntimeFailure>(failure);
    if (runtime == detail::AndroidAudioHostRuntimeFailure::Disconnected ||
        runtime == detail::AndroidAudioHostRuntimeFailure::RouteChanged) {
      result.state = AudioHostState::DeviceLost;
    } else if (runtime != detail::AndroidAudioHostRuntimeFailure::None ||
               pairPhase == detail::AndroidAudioHostPairPhase::Quarantined) {
      result.state = AudioHostState::Error;
    } else {
      result.state = control_->state.load(std::memory_order_acquire);
    }
    result.format = format_;
    result.latency = currentLatencyLocked();
    result.routeGeneration = routeGeneration_;
    result.streamGeneration = lastStreamGeneration_;
    if (control_->prepared) {
      const auto& endpoint = control_->prepared->callbackContext.endpoint;
      result.callbacks = endpoint.callbacks.load(std::memory_order_relaxed);
      result.renderedFrames = endpoint.renderedFrames.load(std::memory_order_relaxed);
      result.xruns = endpoint.xruns.load(std::memory_order_relaxed);
      result.deadlineMisses = endpoint.deadlineMisses.load(std::memory_order_relaxed);
      result.discontinuities = endpoint.discontinuities.load(std::memory_order_relaxed);
      result.invalidCallbacks = endpoint.invalidCallbacks.load(std::memory_order_relaxed);
      result.renderFailures = endpoint.renderFailures.load(std::memory_order_relaxed);
    }
    result.diagnostics.inputPeriodFrames = inputBurstFrames_;
    result.diagnostics.outputPeriodFrames = outputBurstFrames_;
    result.diagnostics.inputBufferFrames = inputCapacityFrames_;
    result.diagnostics.outputBufferFrames = outputCapacityFrames_;
    result.diagnostics.fifoCapacityFrames = inputCapacityFrames_;
    result.diagnostics.inputHardwareSampleRate = inputHardwareRate_;
    result.diagnostics.outputHardwareSampleRate = outputHardwareRate_;
    result.diagnostics.inputHardwareChannels = inputHardwareChannels_;
    result.diagnostics.outputHardwareChannels = outputHardwareChannels_;
    result.diagnostics.inputHardwareSampleFormat = inputHardwareFormat_;
    result.diagnostics.outputHardwareSampleFormat = outputHardwareFormat_;
    if (control_->prepared && inputCapacityFrames_ != 0) {
      const auto& callback = control_->prepared->callbackContext;
      result.diagnostics.fifoCurrentFrames =
          callback.inputOccupancyCurrent.load(std::memory_order_relaxed);
      const uint32_t minimum =
          callback.inputOccupancyMinimum.load(std::memory_order_relaxed);
      result.diagnostics.fifoMinimumFrames =
          minimum == UINT32_MAX ? 0 : minimum;
      result.diagnostics.fifoMaximumFrames =
          callback.inputOccupancyMaximum.load(std::memory_order_relaxed);
      result.diagnostics.fifoUnderflows =
          callback.inputUnderflows.load(std::memory_order_relaxed);
      result.diagnostics.fifoOverflows =
          control_->inputDriverXruns.load(std::memory_order_relaxed);
    }
    return result;
  }

  private:
  bool commitStart(uint64_t pairEpoch,
                   uint32_t expectedFailureGeneration) {
    auto& callback = control_->prepared->callbackContext;
    // Stream getters may re-enter Oboe error delivery and therefore remain
    // outside pairMutex. Whichever side acquires pairMutex first defines the
    // start/error order; the losing side observes the winner's state.
    const bool outputStarted =
        control_->output != nullptr &&
        control_->output->getState() == oboe::StreamState::Started;
    const bool requireInput = control_->input != nullptr;
    const bool inputStarted =
        !requireInput ||
        control_->input->getState() == oboe::StreamState::Started;
    std::lock_guard<std::mutex> pair(control_->pairMutex);
    const detail::AndroidAudioHostStartCommitFacts facts{
        control_->input.get(),
        control_->output.get(),
        requireInput,
        inputStarted,
        outputStarted,
        detail::androidAudioHostRouteGenerationSignal()->load(
            std::memory_order_acquire) == routeGeneration_,
        callback.runtimeFailure.load(std::memory_order_acquire) ==
            static_cast<int32_t>(
                detail::AndroidAudioHostRuntimeFailure::None),
        callback.admission.accepting(),
        expectedFailureGeneration,
        callback.failureGeneration.load(std::memory_order_acquire)};
    if (!detail::androidAudioHostCommitPairStart(
            &control_->pairState, pairEpoch, facts)) {
      return false;
    }
    // Pair and public state share this one linearization point. onError also
    // takes pairMutex, so it either prevents this commit or publishes Error
    // strictly after it; there is no later Running store to overwrite Error.
    control_->state.store(AudioHostState::Running, std::memory_order_release);
    return true;
  }

  bool finalStartHealthy(uint32_t expectedFailureGeneration) const noexcept {
    const auto& callback = control_->prepared->callbackContext;
    // The terminal path increments generation first. Bracketing all other
    // acquire reads with generation closes every RT precheck/commit/return
    // window; a terminal after the second read is ordered after success.
    const uint32_t before =
        callback.failureGeneration.load(std::memory_order_acquire);
    const bool runtimeHealthy =
        callback.runtimeFailure.load(std::memory_order_acquire) ==
        static_cast<int32_t>(detail::AndroidAudioHostRuntimeFailure::None);
    const bool accepting = callback.admission.accepting();
    const bool routeCurrent =
        detail::androidAudioHostRouteGenerationSignal()->load(
            std::memory_order_acquire) == routeGeneration_;
    const uint32_t after =
        callback.failureGeneration.load(std::memory_order_acquire);
    return detail::androidAudioHostFinalStartHealthy(
        expectedFailureGeneration, before, runtimeHealthy, accepting,
        routeCurrent, after);
  }

  bool openingCheckpoint(uint64_t pairEpoch, bool outputPublished,
                         bool inputPublished, bool requireInputState) const {
    // Oboe getters stay outside pairMutex because they may re-enter the error
    // callback. The exact epoch/owner/failure commit is checked afterward
    // under pairMutex; a callback which wins first makes this checkpoint fail.
    const bool outputOpen =
        control_->output != nullptr &&
        control_->output->getState() == oboe::StreamState::Open;
    const bool inputOpen =
        !requireInputState ||
        (control_->input != nullptr &&
         control_->input->getState() == oboe::StreamState::Open);
    std::lock_guard<std::mutex> pair(control_->pairMutex);
    const bool callbackHealthy =
        control_->prepared != nullptr &&
        control_->prepared->callbackOwner.pairEpoch == pairEpoch &&
        control_->prepared->callbackContext.runtimeFailure.load(
            std::memory_order_acquire) ==
            static_cast<int32_t>(
                detail::AndroidAudioHostRuntimeFailure::None);
    return outputOpen && inputOpen && callbackHealthy &&
           detail::androidAudioHostPairOpeningMatches(
               control_->pairState, pairEpoch, control_->output.get(),
               control_->input.get(), outputPublished, inputPublished);
  }

  bool commitOpen(uint64_t pairEpoch, bool requireInput) {
    const bool outputOpen =
        control_->output != nullptr &&
        control_->output->getState() == oboe::StreamState::Open;
    const bool inputOpen =
        !requireInput ||
        (control_->input != nullptr &&
         control_->input->getState() == oboe::StreamState::Open);
    std::lock_guard<std::mutex> pair(control_->pairMutex);
    if (!outputOpen || !inputOpen || control_->prepared == nullptr ||
        control_->prepared->callbackOwner.pairEpoch != pairEpoch ||
        control_->prepared->callbackContext.runtimeFailure.load(
            std::memory_order_acquire) !=
            static_cast<int32_t>(
                detail::AndroidAudioHostRuntimeFailure::None) ||
        !detail::androidAudioHostCompletePairOpen(
            &control_->pairState, pairEpoch, control_->output.get(),
            control_->input.get(), requireInput)) {
      return false;
    }
    // Pair phase and public state become Open at this one linearization point.
    // A later callback linearizes after it and immediately publishes Error;
    // a callback which arrived earlier owns the pair and prevents this commit.
    control_->state.store(AudioHostState::Open, std::memory_order_release);
    return true;
  }

  static bool acceptableStopped(oboe::Result result) noexcept {
    return result == oboe::Result::OK || result == oboe::Result::ErrorClosed ||
           result == oboe::Result::ErrorInvalidState;
  }

  static bool acceptableClosed(oboe::Result result) noexcept {
    return result == oboe::Result::OK || result == oboe::Result::ErrorClosed;
  }

  static bool waitForErrorWorker(AndroidAudioHostControlBlock& control,
                                 uint64_t pairEpoch) noexcept {
    const auto deadline = std::chrono::steady_clock::now() +
                          std::chrono::milliseconds(kCallbackDrainTimeoutMs);
    while (std::chrono::steady_clock::now() < deadline) {
      {
        std::lock_guard<std::mutex> lifecycle(control.pairMutex);
        if (control.pairState.epoch != pairEpoch) return false;
        if (control.pairState.workerCompleted) {
          return !control.pairState.uncertainty;
        }
        if (control.pairState.uncertainty ||
            control.pairState.phase ==
                detail::AndroidAudioHostPairPhase::Quarantined) {
          return false;
        }
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    return false;
  }

  static void observeErrorThunk(void* control, uint64_t pairEpoch,
                                oboe::AudioStream* stream,
                                oboe::Result error) noexcept {
    if (control != nullptr) {
      observeError(*static_cast<AndroidAudioHostControlBlock*>(control),
                   pairEpoch, stream, error);
    }
  }

  static void beforeErrorCloseThunk(void* control, uint64_t pairEpoch,
                                    oboe::AudioStream* stream,
                                    oboe::Result) noexcept {
    if (control != nullptr) {
      auto& state = *static_cast<AndroidAudioHostControlBlock*>(control);
      bool exactPair = false;
      {
        std::lock_guard<std::mutex> pair(state.pairMutex);
        exactPair = state.pairState.epoch == pairEpoch &&
                    (detail::androidAudioHostPairContains(state.pairState,
                                                          stream) ||
                     state.pairState.errorStreamIdentity == stream);
      }
      if (exactPair) {
        // Pinned Oboe may free the raw AAudioStream as soon as this returns.
        // The independent owner blocks until any in-progress getTimestamp or
        // getXRunCount call for this epoch has returned. It also closes the
        // start-before-publish race through its stopped-through epoch gate.
        state.timestampSampler.stopAndJoin(pairEpoch);
        std::lock_guard<std::mutex> pair(state.pairMutex);
        if (state.pairState.epoch == pairEpoch) {
          state.pairState.timestampSamplerStarted = false;
        }
      }
    }
  }

  static void afterErrorCloseThunk(void* control, uint64_t pairEpoch,
                                   oboe::AudioStream* stream,
                                   oboe::Result error) noexcept {
    if (control != nullptr) {
      requestErrorTeardown(*static_cast<AndroidAudioHostControlBlock*>(control),
                           pairEpoch, stream, error);
    }
  }

  static void observeError(AndroidAudioHostControlBlock& control,
                           uint64_t pairEpoch, oboe::AudioStream* stream,
                           oboe::Result error) noexcept {
    std::lock_guard<std::mutex> lifecycle(control.pairMutex);
    const auto claim = detail::androidAudioHostClaimErrorTeardown(
        &control.pairState, pairEpoch, stream);
    if (claim == detail::AndroidAudioHostErrorClaim::UserOwned) {
      // User teardown won the epoch, but Oboe has independently entered its
      // failing-stream close sequence. Preserve that overlap as uncertainty;
      // stop() re-reads it after the callback gate drains and quarantines the
      // pair instead of treating its own stop/close return values as proof.
      control.state.store(AudioHostState::Error, std::memory_order_release);
      return;
    }
    if (claim != detail::AndroidAudioHostErrorClaim::Claimed &&
        claim != detail::AndroidAudioHostErrorClaim::AlreadyClaimed) {
      return;
    }
    if (!control.prepared ||
        control.prepared->callbackOwner.pairEpoch != pairEpoch) return;
    auto& callback = control.prepared->callbackContext;
    callback.failureGeneration.fetch_add(1, std::memory_order_acq_rel);
    int32_t expected = static_cast<int32_t>(
        detail::AndroidAudioHostRuntimeFailure::None);
    callback.runtimeFailure.compare_exchange_strong(
        expected,
        static_cast<int32_t>(
            error == oboe::Result::ErrorDisconnected
                ? detail::AndroidAudioHostRuntimeFailure::Disconnected
                : detail::AndroidAudioHostRuntimeFailure::StreamError),
        std::memory_order_release, std::memory_order_relaxed);
    callback.admission.beginClose();
    deactivateAudioHostCallback(&callback.endpoint);
    control.state.store(error == oboe::Result::ErrorDisconnected
                            ? AudioHostState::DeviceLost
                            : AudioHostState::Error,
                        std::memory_order_release);
  }

  static bool ensureErrorWorker(AndroidAudioHostControlBlock& control) noexcept {
    std::lock_guard<std::mutex> lock(control.errorMutex);
    if (control.errorWorker.joinable()) return true;
    control.errorHandoff.shutdown = false;
    try {
      control.errorWorker = std::thread([&control] { errorWorkerMain(control); });
    } catch (...) {
      control.errorHandoff.shutdown = true;
      return false;
    }
    return true;
  }

  static void requestErrorTeardown(AndroidAudioHostControlBlock& control,
                                   uint64_t pairEpoch,
                                   oboe::AudioStream* stream,
                                   oboe::Result) noexcept {
    {
      std::lock_guard<std::mutex> lifecycle(control.pairMutex);
      if (control.pairState.epoch != pairEpoch ||
          control.pairState.teardownOwner !=
              detail::AndroidAudioHostTeardownOwner::ErrorWorker ||
          control.pairState.errorStreamIdentity != stream) {
        return;
      }
    }
    std::lock_guard<std::mutex> lock(control.errorMutex);
    const auto request = detail::androidAudioHostRequestErrorTeardown(
        &control.errorHandoff, pairEpoch, stream);
    if (request.generation == 0) return;
    control.errorCv.notify_one();
  }

  static void errorWorkerMain(AndroidAudioHostControlBlock& control) noexcept {
    std::unique_lock<std::mutex> lock(control.errorMutex);
    while (!control.errorHandoff.shutdown) {
      control.errorCv.wait(lock, [&control] {
        return control.errorHandoff.pending.generation != 0 ||
               control.errorHandoff.shutdown;
      });
      if (control.errorHandoff.shutdown) break;
      const auto request =
          detail::androidAudioHostTakeErrorTeardown(&control.errorHandoff);
      lock.unlock();
      bool uncertain = false;
      {
        // This is the same application lifecycle-call boundary used by public
        // open/start/stop, but callbacks never acquire it. after-close proves
        // Oboe has finished closing the failing stream before this worker may
        // touch the peer.
        std::lock_guard<std::mutex> operation(control.operationMutex);
        bool ownsExactPair = false;
        bool inputStarted = false;
        bool outputStarted = false;
        {
          std::lock_guard<std::mutex> pair(control.pairMutex);
          ownsExactPair = detail::androidAudioHostBeginErrorWorker(
              &control.pairState, request.pairEpoch,
              request.failingStream);
          inputStarted = control.pairState.inputStarted;
          outputStarted = control.pairState.outputStarted;
        }
        if (ownsExactPair) {
          control.timestampSampler.stopAndJoin(request.pairEpoch);
          // Oboe already closed the stream which reported the error. The
          // retained shared_ptrs identify the current validated epoch; the
          // raw callback pointer above is compared only and never dereferenced.
          const auto stillErrorOwned = [&] {
            std::lock_guard<std::mutex> pair(control.pairMutex);
            return control.pairState.epoch == request.pairEpoch &&
                   control.pairState.teardownOwner ==
                       detail::AndroidAudioHostTeardownOwner::ErrorWorker &&
                   control.pairState.phase ==
                       detail::AndroidAudioHostPairPhase::ErrorStopping &&
                   control.pairState.errorStreamIdentity ==
                       request.failingStream &&
                   !control.pairState.uncertainty;
          };
          const auto stopRun = detail::androidAudioHostStopClosePair(
              control.input.get(), inputStarted, control.output.get(),
              outputStarted, request.failingStream,
              [](const void* identity) {
                return acceptableStopped(static_cast<oboe::AudioStream*>(
                    const_cast<void*>(identity))->stop(kStateTimeoutNs));
              },
              [](const void* identity) {
                return acceptableClosed(static_cast<oboe::AudioStream*>(
                    const_cast<void*>(identity))->close());
              },
              stillErrorOwned);
          uncertain =
              stopRun != detail::AndroidAudioHostLifecycleRun::Completed;
          {
            std::lock_guard<std::mutex> pair(control.pairMutex);
            detail::androidAudioHostPublishPairUncertainty(
                &control.pairState, request.pairEpoch, uncertain);
            (void)detail::androidAudioHostCompleteErrorWorker(
                &control.pairState, request.pairEpoch,
                request.failingStream, uncertain);
          }
        }
      }
      lock.lock();
      detail::androidAudioHostCompleteErrorTeardown(&control.errorHandoff,
                                                     request);
      control.errorCv.notify_all();
    }
  }

  static void shutdownErrorWorker(AndroidAudioHostControlBlock& control) noexcept {
    {
      std::lock_guard<std::mutex> lock(control.errorMutex);
      control.errorHandoff.shutdown = true;
      control.errorCv.notify_all();
    }
    if (control.errorWorker.joinable() &&
        control.errorWorker.get_id() != std::this_thread::get_id()) {
      control.errorWorker.join();
    }
  }

  void resetCallbackCounters(AudioHostCallbackEndpoint& endpoint) noexcept {
    endpoint.callbacks.store(0, std::memory_order_relaxed);
    endpoint.renderedFrames.store(0, std::memory_order_relaxed);
    endpoint.xruns.store(0, std::memory_order_relaxed);
    endpoint.deadlineMisses.store(0, std::memory_order_relaxed);
    endpoint.discontinuities.store(0, std::memory_order_relaxed);
    endpoint.invalidCallbacks.store(0, std::memory_order_relaxed);
    endpoint.renderFailures.store(0, std::memory_order_relaxed);
  }

  bool startTimestampSampler(AndroidAudioHostControlBlock& control,
                             uint64_t pairEpoch) {
    auto input = control.input;
    auto output = control.output;
    auto* prepared = control.prepared.get();
    const double sampleRate = control.sampleRate;
    if (prepared == nullptr || output == nullptr) return false;
    return control.timestampSampler.start(
        pairEpoch,
        [&control, input = std::move(input), output = std::move(output),
         prepared, sampleRate](const std::atomic<uint32_t>& stop) {
        while (stop.load(std::memory_order_acquire) == 0) {
          if (output) {
            const auto stamp = output->getTimestamp(CLOCK_MONOTONIC);
            if (stamp) {
              const uint64_t sampledAtNs = monotonicNowNs();
              prepared->callbackContext.outputTimestamp.publish(
                  stamp.value().position, stamp.value().timestamp,
                  sampledAtNs);
              const int64_t written = output->getFramesWritten();
              if (written >= stamp.value().position && sampledAtNs != 0 &&
                  stamp.value().timestamp > 0 &&
                  sampledAtNs >=
                      static_cast<uint64_t>(stamp.value().timestamp)) {
                const long double elapsed =
                    static_cast<long double>(sampledAtNs -
                        static_cast<uint64_t>(stamp.value().timestamp)) *
                    sampleRate / 1000000000.0L;
                const long double presented = stamp.value().position + elapsed;
                control.outputPresentationFrames.store(
                    written > presented ? saturatingFrames(written - presented) : 0,
                    std::memory_order_relaxed);
              }
            }
            const auto xruns = output->getXRunCount();
            if (xruns && xruns.value() >= 0) {
              control.outputDriverXruns.store(
                  static_cast<uint32_t>(xruns.value()),
                  std::memory_order_relaxed);
            }
          }
          if (input) {
            const auto stamp = input->getTimestamp(CLOCK_MONOTONIC);
            if (stamp) {
              const uint64_t sampledAtNs = monotonicNowNs();
              prepared->callbackContext.inputTimestamp.publish(
                stamp.value().position, stamp.value().timestamp,
                sampledAtNs);
            }
            const auto xruns = input->getXRunCount();
            if (xruns && xruns.value() >= 0) {
              control.inputDriverXruns.store(
                  static_cast<uint32_t>(xruns.value()),
                  std::memory_order_relaxed);
            }
          }
          for (uint32_t count = 0;
               count < 5 &&
               stop.load(std::memory_order_acquire) == 0;
               ++count) {
            std::this_thread::sleep_for(std::chrono::milliseconds(2));
          }
        }
      });
  }

  AudioHostLatency currentLatencyLocked() const noexcept {
    AudioHostLatency result = latency_;
    const uint32_t presentation =
        control_->outputPresentationFrames.load(std::memory_order_relaxed);
    const uint32_t beyondBuffer = presentation > latency_.bufferFrames
                                      ? presentation - latency_.bufferFrames
                                      : 0;
    if (highLatencyOutput_) {
      result.externalRouteFrames = beyondBuffer;
      result.outputDeviceFrames = 0;
    } else {
      result.outputDeviceFrames = beyondBuffer;
      result.externalRouteFrames = 0;
    }
    return result;
  }

  AudioHostResult fail(AudioHostError error, std::string message) {
    stop();
    control_->state.store(AudioHostState::Error, std::memory_order_release);
    return {false, error, AudioHostState::Error, {}, {}, std::move(message)};
  }

  AudioHostResult failLocked(std::unique_lock<std::mutex>& lifecycle,
                             AudioHostError error, std::string message) {
    lifecycle.unlock();
    return fail(error, std::move(message));
  }

  AudioHostResult reject(AudioHostError error, std::string message) {
    control_->state.store(AudioHostState::Error, std::memory_order_release);
    return {false, error, AudioHostState::Error, {}, {}, std::move(message)};
  }

  const std::shared_ptr<AndroidAudioHostControlBlock> control_;
  AudioHostFormat format_{};
  AudioHostLatency latency_{};
  uint64_t lastStreamGeneration_{0};
  uint32_t routeGeneration_{0};
  uint32_t inputCapacityFrames_{0};
  uint32_t outputCapacityFrames_{0};
  uint32_t inputBurstFrames_{0};
  uint32_t outputBurstFrames_{0};
  uint32_t inputHardwareRate_{0};
  uint32_t outputHardwareRate_{0};
  uint32_t inputHardwareChannels_{0};
  uint32_t outputHardwareChannels_{0};
  AudioHostSampleFormat inputHardwareFormat_{AudioHostSampleFormat::Unknown};
  AudioHostSampleFormat outputHardwareFormat_{AudioHostSampleFormat::Unknown};
  bool highLatencyOutput_{false};
  bool leaseHeld_{false};
};

}  // namespace

bool detail::AndroidAudioHostCallback::onError(
    oboe::AudioStream* stream, oboe::Result error) noexcept {
  AudioInputCallbackOwnerScope<AndroidAudioHostCallbackOwner> owner(owner_);
  if (owner && owner->observeError != nullptr) {
    owner->observeError(owner->control, owner->pairEpoch, stream, error);
  }
  // Pinned Oboe 1.9.3 contract: false asks Oboe to run before-close, close the
  // failing stream, then call onErrorAfterClose. The pair peer is closed by
  // the serialized owner worker below, never by an audio data callback.
  return false;
}

void detail::AndroidAudioHostCallback::onErrorBeforeClose(
    oboe::AudioStream* stream, oboe::Result error) {
  AudioInputCallbackOwnerScope<AndroidAudioHostCallbackOwner> owner(owner_);
  if (owner && owner->beforeErrorClose != nullptr) {
    owner->beforeErrorClose(owner->control, owner->pairEpoch, stream, error);
  }
}

void detail::AndroidAudioHostCallback::onErrorAfterClose(
    oboe::AudioStream* stream, oboe::Result error) {
  AudioInputCallbackOwnerScope<AndroidAudioHostCallbackOwner> owner(owner_);
  if (owner && owner->afterErrorClose != nullptr) {
    owner->afterErrorClose(owner->control, owner->pairEpoch, stream, error);
  }
}

const char* detail::androidAudioHostProviderBuildMarker() noexcept {
  return "singz.android.oboe.audio_host.phase3d";
}

std::unique_ptr<AudioHostBackend> createPlatformAudioHostBackend() {
  return std::make_unique<AndroidOboeAudioHostBackend>();
}

}  // namespace singz

#endif

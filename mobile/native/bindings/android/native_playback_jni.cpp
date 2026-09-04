#include <jni.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <iterator>
#include <limits>
#include <new>
#include <mutex>
#include <string>
#include <utility>
#include <vector>

#include <fcntl.h>
#include <limits.h>
#include <sys/stat.h>
#include <unistd.h>

#include <native_playback_session.h>
#include <zcore/media/decoded_audio.h>

namespace {

constexpr char kBuildId[] =
    "singz.android.zdsp_runtime.phase-android-q32-time-pitch-v3";
constexpr uint32_t kInterfaceVersion = 3;
constexpr uint32_t kPlaybackContractVersion = 2;

struct AndroidPlaybackOwner {
  std::mutex commandMutex;
  singz::NativePlaybackSession session;
  std::atomic<uint64_t> latestClaimedGeneration{0};
  std::atomic<uint64_t> cancelledThrough{0};
};

AndroidPlaybackOwner &owner() {
  static auto *value = new AndroidPlaybackOwner();
  return *value;
}

std::string fromJava(JNIEnv *env, jstring value) {
  if (value == nullptr)
    return {};
  const char *characters = env->GetStringUTFChars(value, nullptr);
  if (characters == nullptr)
    return {};
  std::string result(characters);
  env->ReleaseStringUTFChars(value, characters);
  return result;
}

void appendHex4(std::string &output, uint32_t value) {
  constexpr char digits[] = "0123456789abcdef";
  output += "\\u";
  output.push_back(digits[(value >> 12U) & 0xFU]);
  output.push_back(digits[(value >> 8U) & 0xFU]);
  output.push_back(digits[(value >> 4U) & 0xFU]);
  output.push_back(digits[value & 0xFU]);
}

// Convert arbitrary provider UTF-8 into ASCII-only JSON. JNI NewStringUTF
// accepts this representation on every Android release, including labels
// containing supplementary Unicode code points.
void appendQuoted(std::string &output, const std::string &value) {
  output.push_back('"');
  for (size_t index = 0; index < value.size();) {
    const uint8_t first = static_cast<uint8_t>(value[index]);
    uint32_t codepoint = 0;
    size_t width = 1;
    if (first < 0x80U) {
      codepoint = first;
    } else if ((first & 0xE0U) == 0xC0U && index + 1 < value.size()) {
      codepoint = first & 0x1FU;
      width = 2;
    } else if ((first & 0xF0U) == 0xE0U && index + 2 < value.size()) {
      codepoint = first & 0x0FU;
      width = 3;
    } else if ((first & 0xF8U) == 0xF0U && index + 3 < value.size()) {
      codepoint = first & 0x07U;
      width = 4;
    } else {
      codepoint = 0xFFFDU;
    }
    bool valid = true;
    for (size_t continuation = 1; continuation < width; ++continuation) {
      const uint8_t byte = static_cast<uint8_t>(value[index + continuation]);
      if ((byte & 0xC0U) != 0x80U) {
        valid = false;
        break;
      }
      codepoint = (codepoint << 6U) | (byte & 0x3FU);
    }
    if (!valid || (width == 2 && codepoint < 0x80U) ||
        (width == 3 && codepoint < 0x800U) ||
        (width == 4 && codepoint < 0x10000U) || codepoint > 0x10FFFFU ||
        (codepoint >= 0xD800U && codepoint <= 0xDFFFU)) {
      codepoint = 0xFFFDU;
      width = 1;
    }
    index += width;
    switch (codepoint) {
    case '"':
      output += "\\\"";
      break;
    case '\\':
      output += "\\\\";
      break;
    case '\b':
      output += "\\b";
      break;
    case '\f':
      output += "\\f";
      break;
    case '\n':
      output += "\\n";
      break;
    case '\r':
      output += "\\r";
      break;
    case '\t':
      output += "\\t";
      break;
    default:
      if (codepoint >= 0x20U && codepoint <= 0x7EU) {
        output.push_back(static_cast<char>(codepoint));
      } else if (codepoint <= 0xFFFFU) {
        appendHex4(output, codepoint);
      } else {
        const uint32_t scalar = codepoint - 0x10000U;
        appendHex4(output, 0xD800U + (scalar >> 10U));
        appendHex4(output, 0xDC00U + (scalar & 0x3FFU));
      }
      break;
    }
  }
  output.push_back('"');
}

void appendDouble(std::string &output, double value) {
  char buffer[64]{};
  if (!std::isfinite(value))
    value = 0.0;
  std::snprintf(buffer, sizeof(buffer), "%.17g", value);
  output += buffer;
}

const char *playbackState(singz::NativePlaybackState state) noexcept {
  switch (state) {
  case singz::NativePlaybackState::Unloaded:
    return "unloaded";
  case singz::NativePlaybackState::Preparing:
    return "preparing";
  case singz::NativePlaybackState::Prepared:
    return "prepared";
  case singz::NativePlaybackState::OutputOpen:
    return "output-open";
  case singz::NativePlaybackState::Running:
    return "running";
  case singz::NativePlaybackState::Stopped:
    return "stopped";
  case singz::NativePlaybackState::Terminal:
    return "terminal";
  case singz::NativePlaybackState::Quarantined:
    return "quarantined";
  }
  return "terminal";
}

const char *hostState(singz::AudioHostState state) noexcept {
  switch (state) {
  case singz::AudioHostState::Closed:
    return "closed";
  case singz::AudioHostState::Open:
    return "open";
  case singz::AudioHostState::Running:
    return "running";
  case singz::AudioHostState::Stopped:
    return "stopped";
  case singz::AudioHostState::DeviceLost:
    return "device-lost";
  case singz::AudioHostState::Error:
    return "error";
  case singz::AudioHostState::Unsupported:
    return "unsupported";
  }
  return "error";
}

const char *terminalReason(singz::AudioHostTerminalReason reason) noexcept {
  switch (reason) {
  case singz::AudioHostTerminalReason::None:
    return "none";
  case singz::AudioHostTerminalReason::RouteChanged:
    return "route-changed";
  case singz::AudioHostTerminalReason::Interrupted:
    return "interrupted";
  case singz::AudioHostTerminalReason::MediaServicesLost:
    return "media-services-lost";
  case singz::AudioHostTerminalReason::MediaServicesReset:
    return "media-services-reset";
  case singz::AudioHostTerminalReason::DeviceLost:
    return "device-lost";
  case singz::AudioHostTerminalReason::ProviderFailure:
    return "provider-failure";
  }
  return "provider-failure";
}

const char *transportState(singz::NativePlaybackTransportState state) noexcept {
  switch (state) {
  case singz::NativePlaybackTransportState::Stopped:
    return "stopped";
  case singz::NativePlaybackTransportState::PreRoll:
    return "pre-roll";
  case singz::NativePlaybackTransportState::Playing:
    return "playing";
  case singz::NativePlaybackTransportState::Paused:
    return "paused";
  case singz::NativePlaybackTransportState::Completed:
    return "completed";
  }
  return "stopped";
}

const char *transportTelemetryQuality(
    singz::NativePlaybackTransportTelemetryQuality quality) noexcept {
  switch (quality) {
  case singz::NativePlaybackTransportTelemetryQuality::Unavailable:
    return "unavailable";
  case singz::NativePlaybackTransportTelemetryQuality::Initial:
    return "initial";
  case singz::NativePlaybackTransportTelemetryQuality::Current:
    return "current";
  case singz::NativePlaybackTransportTelemetryQuality::LastGood:
    return "lastGood";
  }
  return "unavailable";
}

const char *transportBoundaryReason(
    singz::NativePlaybackTransportBoundaryReason reason) noexcept {
  switch (reason) {
  case singz::NativePlaybackTransportBoundaryReason::None:
    return "none";
  case singz::NativePlaybackTransportBoundaryReason::StreamGenerationChanged:
    return "stream-generation-changed";
  case singz::NativePlaybackTransportBoundaryReason::SequenceGap:
    return "sequence-gap";
  case singz::NativePlaybackTransportBoundaryReason::SampleRateChanged:
    return "sample-rate-changed";
  case singz::NativePlaybackTransportBoundaryReason::RouteGenerationChanged:
    return "route-generation-changed";
  case singz::NativePlaybackTransportBoundaryReason::TimestampQualityChanged:
    return "timestamp-quality-changed";
  case singz::NativePlaybackTransportBoundaryReason::ClockReanchored:
    return "clock-reanchored";
  case singz::NativePlaybackTransportBoundaryReason::SourceSeek:
    return "source-seek";
  case singz::NativePlaybackTransportBoundaryReason::SourceLoop:
    return "source-loop";
  case singz::NativePlaybackTransportBoundaryReason::DeviceLost:
    return "device-lost";
  case singz::NativePlaybackTransportBoundaryReason::SourceFrameOverflow:
    return "source-frame-overflow";
  }
  return "none";
}

const char *audibleProjectionQuality(
    singz::NativePlaybackAudibleProjectionQuality quality) noexcept {
  return quality == singz::NativePlaybackAudibleProjectionQuality::Current
             ? "current"
             : "unavailable";
}

const char *cleanupSafety(singz::NativePlaybackCleanupSafety safety) noexcept {
  switch (safety) {
  case singz::NativePlaybackCleanupSafety::NotOwned:
    return "not-owned";
  case singz::NativePlaybackCleanupSafety::Complete:
    return "complete";
  case singz::NativePlaybackCleanupSafety::Uncertain:
    return "uncertain";
  }
  return "uncertain";
}

const char *coordinatorState(
    singz::NativePlaybackCoordinatorState state) noexcept {
  switch (state) {
  case singz::NativePlaybackCoordinatorState::Available:
    return "available";
  case singz::NativePlaybackCoordinatorState::NativeOwned:
    return "native-owned";
  case singz::NativePlaybackCoordinatorState::FallbackLeased:
    return "fallback-leased";
  case singz::NativePlaybackCoordinatorState::Poisoned:
    return "poisoned";
  }
  return "poisoned";
}

std::string resultJson(const singz::NativePlaybackResult &result) {
  std::string output = "{\"ok\":";
  output += result.ok ? "true" : "false";
  output += ",\"error\":";
  appendQuoted(output, singz::nativePlaybackErrorName(result.error));
  output += ",\"generation\":" + std::to_string(result.generation);
  output += ",\"state\":";
  appendQuoted(output, playbackState(result.state));
  output += ",\"sampleRate\":";
  appendDouble(output, result.format.sampleRate);
  output += ",\"maximumFrames\":" +
            std::to_string(result.format.maximumFrames);
  output += ",\"nominalBufferFrames\":" +
            std::to_string(result.format.nominalBufferFrames);
  output += ",\"outputChannels\":" +
            std::to_string(result.format.outputChannels);
  output += ",\"sampleFormat\":\"float32\",\"message\":";
  appendQuoted(output, result.message);
  output.push_back('}');
  return output;
}

void appendCleanup(std::string &output,
                   const singz::NativePlaybackCleanupResult &cleanup) {
  output += "{\"safety\":";
  appendQuoted(output, cleanupSafety(cleanup.safety));
  output += ",\"error\":";
  appendQuoted(output, singz::nativePlaybackErrorName(cleanup.error));
  output += ",\"generation\":" + std::to_string(cleanup.generation);
  output += ",\"state\":";
  appendQuoted(output, playbackState(cleanup.state));
  output += ",\"retainedBytes\":" + std::to_string(cleanup.retainedBytes);
  output += ",\"parkedLaneBytes\":" +
            std::to_string(cleanup.parkedLaneBytes);
  output += ",\"physicalOwnershipRetained\":";
  output += cleanup.physicalOwnershipRetained ? "true" : "false";
  output += ",\"processQuarantineRetainedBytes\":" +
            std::to_string(cleanup.processQuarantineRetainedBytes);
  output += ",\"processQuarantineReserved\":";
  output += cleanup.processQuarantineReserved ? "true" : "false";
  output += ",\"processQuarantinePoisoned\":";
  output += cleanup.processQuarantinePoisoned ? "true" : "false";
  output += ",\"terminalReason\":";
  appendQuoted(output, terminalReason(cleanup.terminalReason));
  output += ",\"coordinatorState\":";
  appendQuoted(output, coordinatorState(cleanup.coordinatorState));
  output += ",\"coordinatorEpoch\":" +
            std::to_string(cleanup.coordinatorEpoch);
  output += ",\"coordinatorOwnerSession\":" +
            std::to_string(cleanup.coordinatorOwnerSession);
  output += ",\"coordinatorOwnerGeneration\":" +
            std::to_string(cleanup.coordinatorOwnerGeneration);
  output += ",\"handoffLease\":" + std::to_string(cleanup.handoffLease);
  output += ",\"globallyComplete\":";
  output += cleanup.globallyComplete() ? "true" : "false";
  output += ",\"fallbackSafe\":";
  output += cleanup.globallyComplete() ? "true" : "false";
  output.push_back('}');
}

std::string unloadJson(const singz::NativePlaybackUnloadReceipt &receipt) {
  std::string output = resultJson(receipt.playback);
  output.pop_back();
  output += ",\"cleanup\":";
  appendCleanup(output, receipt.cleanup);
  output.push_back('}');
  return output;
}

// The host already applied androidAudioHostNominalSampleRate when it built
// this inventory, and openOutput's route check compares against that same
// field. A second rule here is how the two came to disagree: the listing
// showed JS a usable 48 kHz while the route check saw the raw zero and
// refused every Android handoff ever attempted.
double inventorySampleRate(const singz::AudioHostDeviceInfo &device) noexcept {
  return std::isfinite(device.nominalSampleRate) &&
                 device.nominalSampleRate > 0.0
             ? device.nominalSampleRate
             : 0.0;
}

void appendStatus(std::string &output,
                  const singz::NativePlaybackStatus &status) {
  const auto &host = status.host;
  output += "{\"generation\":" + std::to_string(status.generation);
  output += ",\"state\":";
  appendQuoted(output, playbackState(status.state));
  output += ",\"hostState\":";
  appendQuoted(output, hostState(host.state));
  output += ",\"terminalReason\":";
  appendQuoted(output, terminalReason(status.terminalReason));
  output += ",\"terminalOrdinal\":" +
            std::to_string(status.terminalOrdinal);
  output += ",\"sampleRate\":";
  appendDouble(output, host.format.sampleRate);
  output += ",\"maximumFrames\":" +
            std::to_string(host.format.maximumFrames);
  output += ",\"nominalBufferFrames\":" +
            std::to_string(host.format.nominalBufferFrames);
  output += ",\"outputChannels\":" +
            std::to_string(host.format.outputChannels);
  output += ",\"renderedFrames\":" + std::to_string(status.renderedFrames);
  output += ",\"audibleFrames\":" + std::to_string(status.audibleFrames);
  output += ",\"transportGeneration\":" +
            std::to_string(status.transportGeneration);
  output += ",\"transportState\":";
  appendQuoted(output, transportState(status.transportState));
  output += ",\"transportTelemetryQuality\":";
  appendQuoted(output,
               transportTelemetryQuality(status.transportTelemetryQuality));
  output += ",\"lastTransportBoundary\":";
  appendQuoted(output, transportBoundaryReason(status.lastTransportBoundary));
  output += ",\"renderedProjectFrame\":" +
            std::to_string(status.renderedProjectFrame);
  output += ",\"audibleProjectFrame\":" +
            std::to_string(status.audibleProjectFrame);
  output += ",\"audibleProjectionQuality\":";
  appendQuoted(output, audibleProjectionQuality(status.audibleProjectionQuality));
  output += ",\"continuousFrame\":" +
            std::to_string(status.continuousFrame);
  output += ",\"durationFrames\":" + std::to_string(status.durationFrames);
  output += ",\"remainingPreRollFrames\":" +
            std::to_string(status.remainingPreRollFrames);
  output += ",\"cueEventsCompleted\":" +
            std::to_string(status.cueEventsCompleted);
  output += ",\"nextCueEventIndex\":" +
            std::to_string(status.nextCueEventIndex);
  output += ",\"loopEnabled\":";
  output += status.loopEnabled ? "true" : "false";
  output += ",\"loopStartFrame\":" + std::to_string(status.loopStartFrame);
  output += ",\"loopEndFrame\":" + std::to_string(status.loopEndFrame);
  output += ",\"loopCount\":" + std::to_string(status.loopCount);
  output += ",\"seekCount\":" + std::to_string(status.seekCount);
  output += ",\"transportDiscontinuities\":" +
            std::to_string(status.transportDiscontinuities);
  output += ",\"presentationLatencyFrames\":" +
            std::to_string(status.presentationLatencyFrames);
  output += ",\"playbackRate\":";
  appendDouble(output, status.playbackRate);
  output += ",\"transposeSemitones\":";
  appendDouble(output, status.transposeSemitones);
  output += ",\"graphLatencyFrames\":" +
            std::to_string(status.graphLatencyFrames);
  output += ",\"timePitchAnchorsPrepared\":" +
            std::to_string(status.timePitchAnchorsPrepared);
  output += ",\"timePitchAnchorsPublished\":" +
            std::to_string(status.timePitchAnchorsPublished);
  output += ",\"timePitchAnchorMisses\":" +
            std::to_string(status.timePitchAnchorMisses);
  output += ",\"timePitchReplacementReady\":";
  output += status.timePitchReplacementReady ? "true" : "false";
  output += ",\"timePitchLoopPriming\":";
  output += status.timePitchLoopPriming ? "true" : "false";
  output += ",\"devicePresentationLatencyFrames\":" +
            std::to_string(status.devicePresentationLatencyFrames);
  output += ",\"totalPresentationLatencyFrames\":" +
            std::to_string(status.totalPresentationLatencyFrames);
  output += ",\"preparedStartProjectFrame\":" +
            std::to_string(status.preparedStartProjectFrame);
  output += ",\"retainedBytes\":" + std::to_string(status.retainedBytes);
  output += ",\"parkedLaneBytes\":" +
            std::to_string(status.parkedLaneBytes);
  output += ",\"parkedLaneCount\":" +
            std::to_string(status.parkedLaneCount);
  output += ",\"graphArenaBytes\":" +
            std::to_string(status.graphArenaBytes);
  output += ",\"masterGain\":";
  appendDouble(output, status.masterGain);
  output += ",\"referenceGain\":";
  appendDouble(output, status.referenceGain);
  output += ",\"trainingEnabled\":";
  output += status.trainingEnabled ? "true" : "false";
  output += ",\"trainingLanes\":[";
  for (size_t index = 0; index < status.trainingLanes.size(); ++index) {
    if (index != 0)
      output.push_back(',');
    appendQuoted(output, status.trainingLanes[index]);
  }
  output.push_back(']');
  output += ",\"preRollFrames\":" + std::to_string(status.preRollFrames);
  output += ",\"cueEventCount\":" + std::to_string(status.cueEventCount);
  output += ",\"countInEventCount\":" +
            std::to_string(status.countInEventCount);
  output += ",\"countInBeatsPerBar\":" +
            std::to_string(status.countInBeatsPerBar);
  output += ",\"previewClicksEnqueued\":" +
            std::to_string(status.previewClicksEnqueued);
  output += ",\"previewClicksStarted\":" +
            std::to_string(status.previewClicksStarted);
  output += ",\"previewClicksCompleted\":" +
            std::to_string(status.previewClicksCompleted);
  output += ",\"previewClicksPending\":" +
            std::to_string(status.previewClicksPending);
  output += ",\"graphNodeCount\":" + std::to_string(status.graphNodeCount);
  output += ",\"graphConnectionCount\":" +
            std::to_string(status.graphConnectionCount);
  output += ",\"latencyCompensatedEdgeCount\":" +
            std::to_string(status.latencyCompensatedEdgeCount);
  output += ",\"laneDecodeFallback\":";
  appendQuoted(output, status.laneDecodeFallback);
  output += ",\"topology\":";
  appendQuoted(output, status.topology);
  output += ",\"xruns\":" + std::to_string(host.xruns);
  output += ",\"deadlineMisses\":" + std::to_string(host.deadlineMisses);
  output += ",\"discontinuities\":" +
            std::to_string(host.discontinuities);
  output += ",\"renderFailures\":" + std::to_string(host.renderFailures);
  output += ",\"graphStatusCode\":" + std::to_string(status.graphStatusCode);
  output += ",\"graphStatusDetail\":" + std::to_string(status.graphStatusDetail);
  output += ",\"timePitchAnchorOutcome\":" + std::to_string(status.timePitchAnchorOutcome);
  output += ",\"adapterRenderFailures\":" +
            std::to_string(status.adapterRenderFailures);
  output += ",\"terminalRenderFailures\":" +
            std::to_string(status.terminalRenderFailures);
  output += ",\"parameterOverflows\":" +
            std::to_string(status.parameterOverflows);
  output += ",\"nonFiniteSamples\":" +
            std::to_string(status.nonFiniteSamples);
  output += ",\"rejectedBlocks\":" + std::to_string(status.rejectedBlocks);
  output += ",\"sampleFormat\":\"float32\",\"routeGeneration\":" +
            std::to_string(host.routeGeneration);
  output += ",\"streamGeneration\":" +
            std::to_string(host.streamGeneration);
  output += ",\"latency\":{\"outputDeviceFrames\":" +
            std::to_string(host.latency.outputDeviceFrames);
  output += ",\"bufferFrames\":" +
            std::to_string(host.latency.bufferFrames);
  output += ",\"externalRouteFrames\":" +
            std::to_string(host.latency.externalRouteFrames);
  output += ",\"presentationFrames\":" +
            std::to_string(status.presentationLatencyFrames) + "}";
  output += ",\"lanes\":[";
  for (size_t index = 0; index < status.lanes.size(); ++index) {
    if (index != 0)
      output.push_back(',');
    const auto &lane = status.lanes[index];
    output += "{\"id\":";
    appendQuoted(output, lane.id);
    output += ",\"cursorFrames\":" + std::to_string(lane.cursorFrames);
    output += ",\"totalFrames\":" + std::to_string(lane.totalFrames);
    output += ",\"gain\":";
    appendDouble(output, lane.gain);
    output += ",\"muted\":";
    output += lane.muted ? "true" : "false";
    output += ",\"solo\":";
    output += lane.solo ? "true" : "false";
    // No envelope here: it never changes for a generation and this runs every
    // 200 ms. nativePlaybackLanePeaks publishes it once instead.
    output.push_back('}');
  }
  output += "],\"message\":";
  appendQuoted(output, status.error);
  output.push_back('}');
}

std::string capabilityJson(AndroidPlaybackOwner &bridge) {
  const auto inventory = bridge.session.enumerate();
  const auto status = bridge.session.status();
  const auto mediaCodec = singz::decodedAudioCodecCapabilities();
  std::string output = "{\"available\":true,\"interfaceVersion\":" +
                       std::to_string(kInterfaceVersion);
  output += ",\"playbackContractVersion\":" +
            std::to_string(kPlaybackContractVersion);
  output +=
      ",\"graph\":true,\"audioHostAdapter\":true,\"playbackSession\":true";
  output +=
      ",\"playbackCleanupProof\":true,\"playbackHandoffLease\":true";
  output +=
      ",\"playbackTransport\":true,\"scheduledCues\":true,\"timePitch\":true";
  output += ",\"mediaCodec\":{\"abiVersion\":" +
            std::to_string(mediaCodec.abiVersion);
  output += ",\"formatMask\":" + std::to_string(mediaCodec.formatMask);
  output += ",\"dynamicallyLinkedFfmpeg\":";
  output += mediaCodec.dynamicallyLinkedFfmpeg ? "true" : "false";
  output += ",\"runtimeVersion\":";
  appendQuoted(output, mediaCodec.runtimeVersion == nullptr
                           ? ""
                           : mediaCodec.runtimeVersion);
  output += ",\"capabilityTag\":";
  appendQuoted(output, singz::decodedAudioCapabilityTag());
  output.push_back('}');
  output += ",\"buildId\":";
  appendQuoted(output, kBuildId);
  output += ",\"playbackBuild\":";
  appendQuoted(output, singz::nativePlaybackSessionCapabilityTag());
  output +=
      ",\"ownership\":\"coordinated\",\"activation\":\"experimental-4c\"";
  output += ",\"outputs\":[";
  bool first = true;
  for (const auto &device : inventory.devices) {
    if (device.outputChannels == 0)
      continue;
    if (!first)
      output.push_back(',');
    first = false;
    output += "{\"uid\":";
    appendQuoted(output, device.uid);
    output += ",\"label\":";
    appendQuoted(output, device.label);
    output += ",\"default\":";
    output += device.uid == inventory.defaultOutputUid ? "true" : "false";
    output += ",\"channels\":" + std::to_string(device.outputChannels);
    output += ",\"sampleRate\":";
    appendDouble(output, inventorySampleRate(device));
    output += ",\"sampleFormat\":\"float32\"}";
  }
  output += "],\"session\":";
  appendStatus(output, status);
  output.push_back('}');
  return output;
}

jstring javaJson(JNIEnv *env, const std::string &json) {
  // All provider strings were escaped to ASCII by appendQuoted.
  return env->NewStringUTF(json.c_str());
}

singz::NativePlaybackResult providerFailure(uint64_t generation,
                                            const char *message) noexcept {
  singz::NativePlaybackResult result;
  result.error = singz::NativePlaybackError::ProviderFailure;
  result.generation = generation;
  result.state = singz::NativePlaybackState::Quarantined;
  try {
    result.message = message;
  } catch (...) {
  }
  return result;
}

template <typename Function>
jstring resultBoundary(JNIEnv *env, uint64_t generation, Function &&function) {
  try {
    return javaJson(env, resultJson(function()));
  } catch (const std::bad_alloc &) {
    return javaJson(env, resultJson(providerFailure(
                             generation, "Android native playback ran out of memory")));
  } catch (...) {
    return javaJson(env, resultJson(providerFailure(
                             generation, "Android native playback failed unexpectedly")));
  }
}

bool pathInside(const std::string &path, const std::string &root) noexcept {
  if (path == root || path.size() <= root.size() ||
      path.compare(0, root.size(), root) != 0)
    return false;
  return root.back() == '/' || path[root.size()] == '/';
}

std::vector<std::string> stringArray(JNIEnv *env, jobjectArray values,
                                     jsize maximum) {
  std::vector<std::string> result;
  if (values == nullptr)
    return result;
  const jsize count = env->GetArrayLength(values);
  if (count < 0 || count > maximum)
    return result;
  result.reserve(static_cast<size_t>(count));
  for (jsize index = 0; index < count; ++index) {
    auto *value =
        static_cast<jstring>(env->GetObjectArrayElement(values, index));
    result.push_back(fromJava(env, value));
    if (value != nullptr)
      env->DeleteLocalRef(value);
  }
  return result;
}

bool graphDocument(JNIEnv *env, jboolean present, jobjectArray nodeValues,
                   jobjectArray connectionValues,
                   singz::NativePlaybackGraphDocument *result) {
  if (result == nullptr || nodeValues == nullptr || connectionValues == nullptr)
    return false;
  const jsize nodeCount = env->GetArrayLength(nodeValues);
  const jsize connectionCount = env->GetArrayLength(connectionValues);
  if (present != JNI_TRUE)
    return nodeCount == 0 && connectionCount == 0;
  if (nodeCount <= 0 ||
      nodeCount > static_cast<jsize>(zdsp::kMaximumGraphNodes) ||
      connectionCount < 0 ||
      connectionCount > static_cast<jsize>(zdsp::kMaximumGraphConnections))
    return false;

  auto *firstNode = env->GetObjectArrayElement(nodeValues, 0);
  if (firstNode == nullptr)
    return false;
  jclass nodeClass = env->GetObjectClass(firstNode);
  env->DeleteLocalRef(firstNode);
  if (nodeClass == nullptr)
    return false;
  const jfieldID nodeId = env->GetFieldID(nodeClass, "id", "J");
  const jfieldID typeHigh = env->GetFieldID(nodeClass, "typeHigh", "J");
  const jfieldID typeLow = env->GetFieldID(nodeClass, "typeLow", "J");
  const jfieldID typeVersion = env->GetFieldID(nodeClass, "typeVersion", "I");
  const jfieldID execution =
      env->GetFieldID(nodeClass, "execution", "Ljava/lang/String;");
  const jfieldID unavailable = env->GetFieldID(nodeClass, "unavailable", "I");
  const jfieldID inputPortIds = env->GetFieldID(
      nodeClass, "inputPortIds", "[Ljava/lang/String;");
  const jfieldID inputPortChannels =
      env->GetFieldID(nodeClass, "inputPortChannels", "[I");
  const jfieldID outputPortIds = env->GetFieldID(
      nodeClass, "outputPortIds", "[Ljava/lang/String;");
  const jfieldID outputPortChannels =
      env->GetFieldID(nodeClass, "outputPortChannels", "[I");
  const jfieldID parameterIds = env->GetFieldID(
      nodeClass, "parameterIds", "[Ljava/lang/String;");
  const jfieldID parameterValues =
      env->GetFieldID(nodeClass, "parameterValues", "[D");
  const jfieldID bindingPresent =
      env->GetFieldID(nodeClass, "bindingPresent", "Z");
  const jfieldID bindingKind =
      env->GetFieldID(nodeClass, "bindingKind", "Ljava/lang/String;");
  const jfieldID bindingLaneId =
      env->GetFieldID(nodeClass, "bindingLaneId", "Ljava/lang/String;");
  if (nodeId == nullptr || typeHigh == nullptr || typeLow == nullptr ||
      typeVersion == nullptr || execution == nullptr || unavailable == nullptr ||
      inputPortIds == nullptr || inputPortChannels == nullptr ||
      outputPortIds == nullptr || outputPortChannels == nullptr ||
      parameterIds == nullptr || parameterValues == nullptr ||
      bindingPresent == nullptr || bindingKind == nullptr ||
      bindingLaneId == nullptr || env->ExceptionCheck()) {
    env->DeleteLocalRef(nodeClass);
    return false;
  }

  singz::NativePlaybackGraphDocument document;
  document.nodes.reserve(static_cast<size_t>(nodeCount));
  for (jsize index = 0; index < nodeCount; ++index) {
    jobject object = env->GetObjectArrayElement(nodeValues, index);
    if (object == nullptr || !env->IsInstanceOf(object, nodeClass)) {
      if (object != nullptr)
        env->DeleteLocalRef(object);
      env->DeleteLocalRef(nodeClass);
      return false;
    }
    auto *executionValue = static_cast<jstring>(
        env->GetObjectField(object, execution));
    auto *inputsValue = static_cast<jobjectArray>(
        env->GetObjectField(object, inputPortIds));
    auto *inputChannelsValue = static_cast<jintArray>(
        env->GetObjectField(object, inputPortChannels));
    auto *outputsValue = static_cast<jobjectArray>(
        env->GetObjectField(object, outputPortIds));
    auto *outputChannelsValue = static_cast<jintArray>(
        env->GetObjectField(object, outputPortChannels));
    auto *parametersValue = static_cast<jobjectArray>(
        env->GetObjectField(object, parameterIds));
    auto *normalizedValues = static_cast<jdoubleArray>(
        env->GetObjectField(object, parameterValues));
    auto *bindingKindValue = static_cast<jstring>(
        env->GetObjectField(object, bindingKind));
    auto *bindingLaneIdValue = static_cast<jstring>(
        env->GetObjectField(object, bindingLaneId));
    const jint policy = env->GetIntField(object, unavailable);
    const jsize inputCount = inputsValue == nullptr ? -1 : env->GetArrayLength(inputsValue);
    const jsize outputCount = outputsValue == nullptr ? -1 : env->GetArrayLength(outputsValue);
    const jsize parameterCount =
        parametersValue == nullptr ? -1 : env->GetArrayLength(parametersValue);
    const bool valid = executionValue != nullptr && inputsValue != nullptr &&
        inputChannelsValue != nullptr && outputsValue != nullptr &&
        outputChannelsValue != nullptr && parametersValue != nullptr &&
        normalizedValues != nullptr && bindingKindValue != nullptr &&
        bindingLaneIdValue != nullptr && (policy == 0 || policy == 1) &&
        inputCount >= 0 && inputCount <= static_cast<jsize>(zdsp::kMaximumBusesPerProcessor) &&
        outputCount >= 0 && outputCount <= static_cast<jsize>(zdsp::kMaximumBusesPerProcessor) &&
        parameterCount >= 0 &&
        parameterCount <= static_cast<jsize>(singz::kNativePlaybackGraphMaximumParametersPerNode) &&
        env->GetArrayLength(inputChannelsValue) == inputCount &&
        env->GetArrayLength(outputChannelsValue) == outputCount &&
        env->GetArrayLength(normalizedValues) == parameterCount &&
        !env->ExceptionCheck();
    if (!valid) {
      // Every element must already be a jobject: a braced list of distinct
      // JNI array pointer types has no deducible element type.
      for (jobject reference : {static_cast<jobject>(executionValue),
                                static_cast<jobject>(inputsValue),
                                static_cast<jobject>(inputChannelsValue),
                                static_cast<jobject>(outputsValue),
                                static_cast<jobject>(outputChannelsValue),
                                static_cast<jobject>(parametersValue),
                                static_cast<jobject>(normalizedValues),
                                static_cast<jobject>(bindingKindValue),
                                static_cast<jobject>(bindingLaneIdValue)})
        if (reference != nullptr)
          env->DeleteLocalRef(reference);
      env->DeleteLocalRef(object);
      env->DeleteLocalRef(nodeClass);
      return false;
    }
    singz::NativePlaybackGraphNode node;
    node.id = static_cast<uint64_t>(env->GetLongField(object, nodeId));
    node.type.high = static_cast<uint64_t>(env->GetLongField(object, typeHigh));
    node.type.low = static_cast<uint64_t>(env->GetLongField(object, typeLow));
    node.typeVersion = static_cast<uint32_t>(env->GetIntField(object, typeVersion));
    node.execution = fromJava(env, executionValue);
    node.unavailable = policy == 0
                           ? singz::NativePlaybackGraphUnavailablePolicy::Bypass
                           : singz::NativePlaybackGraphUnavailablePolicy::Silence;
    const auto inputIds = stringArray(env, inputsValue, zdsp::kMaximumBusesPerProcessor);
    const auto outputIds = stringArray(env, outputsValue, zdsp::kMaximumBusesPerProcessor);
    const auto parameterNames = stringArray(
        env, parametersValue,
        singz::kNativePlaybackGraphMaximumParametersPerNode);
    std::vector<jint> inputChannels(static_cast<size_t>(inputCount));
    std::vector<jint> outputChannels(static_cast<size_t>(outputCount));
    std::vector<jdouble> values(static_cast<size_t>(parameterCount));
    if (inputCount != 0)
      env->GetIntArrayRegion(inputChannelsValue, 0, inputCount,
                             inputChannels.data());
    if (outputCount != 0)
      env->GetIntArrayRegion(outputChannelsValue, 0, outputCount,
                             outputChannels.data());
    if (parameterCount != 0)
      env->GetDoubleArrayRegion(normalizedValues, 0, parameterCount,
                                values.data());
    if (inputIds.size() != static_cast<size_t>(inputCount) ||
        outputIds.size() != static_cast<size_t>(outputCount) ||
        parameterNames.size() != static_cast<size_t>(parameterCount) ||
        env->ExceptionCheck()) {
      env->DeleteLocalRef(executionValue);
      env->DeleteLocalRef(inputsValue);
      env->DeleteLocalRef(inputChannelsValue);
      env->DeleteLocalRef(outputsValue);
      env->DeleteLocalRef(outputChannelsValue);
      env->DeleteLocalRef(parametersValue);
      env->DeleteLocalRef(normalizedValues);
      env->DeleteLocalRef(bindingKindValue);
      env->DeleteLocalRef(bindingLaneIdValue);
      env->DeleteLocalRef(object);
      env->DeleteLocalRef(nodeClass);
      return false;
    }
    for (jsize port = 0; port < inputCount; ++port)
      node.inputs.push_back({inputIds[static_cast<size_t>(port)],
                             static_cast<uint32_t>(inputChannels[static_cast<size_t>(port)])});
    for (jsize port = 0; port < outputCount; ++port)
      node.outputs.push_back({outputIds[static_cast<size_t>(port)],
                              static_cast<uint32_t>(outputChannels[static_cast<size_t>(port)])});
    for (jsize parameter = 0; parameter < parameterCount; ++parameter)
      node.parameters.push_back(
          {parameterNames[static_cast<size_t>(parameter)],
           values[static_cast<size_t>(parameter)]});
    if (env->GetBooleanField(object, bindingPresent) == JNI_TRUE)
      node.binding = singz::NativePlaybackGraphBinding{
          fromJava(env, bindingKindValue), fromJava(env, bindingLaneIdValue)};
    document.nodes.push_back(std::move(node));
    env->DeleteLocalRef(executionValue);
    env->DeleteLocalRef(inputsValue);
    env->DeleteLocalRef(inputChannelsValue);
    env->DeleteLocalRef(outputsValue);
    env->DeleteLocalRef(outputChannelsValue);
    env->DeleteLocalRef(parametersValue);
    env->DeleteLocalRef(normalizedValues);
    env->DeleteLocalRef(bindingKindValue);
    env->DeleteLocalRef(bindingLaneIdValue);
    env->DeleteLocalRef(object);
  }
  env->DeleteLocalRef(nodeClass);

  document.connections.reserve(static_cast<size_t>(connectionCount));
  if (connectionCount != 0) {
    jobject firstConnection = env->GetObjectArrayElement(connectionValues, 0);
    if (firstConnection == nullptr)
      return false;
    jclass connectionClass = env->GetObjectClass(firstConnection);
    env->DeleteLocalRef(firstConnection);
    if (connectionClass == nullptr)
      return false;
    const jfieldID sourceNode = env->GetFieldID(connectionClass, "sourceNode", "J");
    const jfieldID sourcePort = env->GetFieldID(
        connectionClass, "sourcePort", "Ljava/lang/String;");
    const jfieldID destinationNode =
        env->GetFieldID(connectionClass, "destinationNode", "J");
    const jfieldID destinationPort = env->GetFieldID(
        connectionClass, "destinationPort", "Ljava/lang/String;");
    if (sourceNode == nullptr || sourcePort == nullptr ||
        destinationNode == nullptr || destinationPort == nullptr ||
        env->ExceptionCheck()) {
      env->DeleteLocalRef(connectionClass);
      return false;
    }
    for (jsize index = 0; index < connectionCount; ++index) {
      jobject object = env->GetObjectArrayElement(connectionValues, index);
      if (object == nullptr || !env->IsInstanceOf(object, connectionClass)) {
        if (object != nullptr)
          env->DeleteLocalRef(object);
        env->DeleteLocalRef(connectionClass);
        return false;
      }
      auto *sourcePortValue = static_cast<jstring>(
          env->GetObjectField(object, sourcePort));
      auto *destinationPortValue = static_cast<jstring>(
          env->GetObjectField(object, destinationPort));
      if (sourcePortValue == nullptr || destinationPortValue == nullptr ||
          env->ExceptionCheck()) {
        if (sourcePortValue != nullptr)
          env->DeleteLocalRef(sourcePortValue);
        if (destinationPortValue != nullptr)
          env->DeleteLocalRef(destinationPortValue);
        env->DeleteLocalRef(object);
        env->DeleteLocalRef(connectionClass);
        return false;
      }
      document.connections.push_back(
          {{static_cast<uint64_t>(env->GetLongField(object, sourceNode)),
            fromJava(env, sourcePortValue)},
           {static_cast<uint64_t>(env->GetLongField(object, destinationNode)),
            fromJava(env, destinationPortValue)}});
      env->DeleteLocalRef(sourcePortValue);
      env->DeleteLocalRef(destinationPortValue);
      env->DeleteLocalRef(object);
    }
    env->DeleteLocalRef(connectionClass);
  }
  *result = std::move(document);
  return true;
}

singz::OwnedFileDescriptor openAuthorized(const std::string &path,
                                          const std::vector<std::string> &roots) {
  singz::OwnedFileDescriptor descriptor(
      ::open(path.c_str(), O_RDONLY | O_CLOEXEC | O_NOFOLLOW));
  if (!descriptor.valid())
    return {};
  struct stat information {};
  if (::fstat(descriptor.get(), &information) != 0 ||
      !S_ISREG(information.st_mode))
    return {};
  char linkPath[64]{};
  std::snprintf(linkPath, sizeof(linkPath), "/proc/self/fd/%d", descriptor.get());
  char canonicalPath[PATH_MAX]{};
  if (::realpath(linkPath, canonicalPath) == nullptr)
    return {};
  const std::string candidate(canonicalPath);
  for (const auto &root : roots) {
    char canonicalRoot[PATH_MAX]{};
    if (::realpath(root.c_str(), canonicalRoot) != nullptr &&
        pathInside(candidate, canonicalRoot))
      return descriptor;
  }
  return {};
}

void noteCancellation(AndroidPlaybackOwner &bridge, uint64_t generation) noexcept {
  uint64_t previous =
      bridge.cancelledThrough.load(std::memory_order_relaxed);
  while (previous < generation &&
         !bridge.cancelledThrough.compare_exchange_weak(
             previous, generation, std::memory_order_release,
             std::memory_order_relaxed)) {
  }
}

struct CancellationContext {
  AndroidPlaybackOwner *owner{nullptr};
  uint64_t generation{0};
};

bool cancellationRequested(void *raw) noexcept {
  const auto *context = static_cast<const CancellationContext *>(raw);
  return context == nullptr || context->owner == nullptr ||
         context->owner->cancelledThrough.load(std::memory_order_acquire) >=
             context->generation;
}

singz::NativePlaybackResult configuredResult(AndroidPlaybackOwner &bridge,
                                             uint64_t generation) {
  const auto status = bridge.session.status();
  singz::NativePlaybackResult result;
  result.generation = generation;
  result.state = status.state;
  result.format = status.host.format;
  result.latency = status.host.latency;
  if (status.generation != generation) {
    result.error = singz::NativePlaybackError::InvalidGeneration;
    result.message = "The Android playback generation is stale";
  } else if (status.state != singz::NativePlaybackState::Prepared) {
    result.error = singz::NativePlaybackError::InvalidState;
    result.message = "Android output focus requires a prepared graph";
  } else {
    result.ok = true;
    result.error = singz::NativePlaybackError::None;
  }
  return result;
}

} // namespace

static jstring nativePlaybackStatus(JNIEnv *env, jobject) {
  auto &bridge = owner();
  std::lock_guard<std::mutex> lock(bridge.commandMutex);
  try {
    return javaJson(env, capabilityJson(bridge));
  } catch (...) {
    return javaJson(env,
                    "{\"available\":false,\"error\":\"provider-failure\"}");
  }
}

/* The session block alone: what the telemetry poll reads 2.5 times a second.
   nativePlaybackStatus above also enumerates the host's devices and describes
   the runtime and codec build on every call — none of it can change within a
   generation, and the poll never read any of it. iOS's session is its exact
   twin: same name, no arguments, the same object status() nests under
   "session". A failure resolves to something the session parser refuses, the
   way status() resolves an unavailable capability. */
static jstring nativePlaybackSession(JNIEnv *env, jobject) {
  auto &bridge = owner();
  std::lock_guard<std::mutex> lock(bridge.commandMutex);
  try {
    std::string output;
    appendStatus(output, bridge.session.status());
    return javaJson(env, output);
  } catch (...) {
    return javaJson(env, "{\"error\":\"provider-failure\"}");
  }
}

static jstring nativePlaybackClaim(JNIEnv *env, jobject, jlong generationValue,
                                   jlong handoffLeaseValue) {
  const uint64_t generation = static_cast<uint64_t>(generationValue);
  const uint64_t handoffLease = static_cast<uint64_t>(handoffLeaseValue);
  auto &bridge = owner();
  const auto result = bridge.session.claimGeneration(generation, handoffLease);
  if (result.ok) {
    bridge.latestClaimedGeneration.store(generation, std::memory_order_release);
  }
  return javaJson(env, resultJson(result));
}

static jboolean nativePlaybackRequestCancellation(JNIEnv *, jobject,
                                                  jlong generationValue) {
  const uint64_t generation = static_cast<uint64_t>(generationValue);
  auto &bridge = owner();
  const bool accepted = bridge.session.requestCancellation(generation);
  if (accepted)
    noteCancellation(bridge, generation);
  return accepted ? JNI_TRUE : JNI_FALSE;
}

static jstring nativePlaybackPrepare(
    JNIEnv *env, jobject, jlong generationValue, jstring outputDeviceUid,
    jintArray outputChannelsValue, jint sampleRate, jint maximumFrames,
    jint bufferFrames, jfloat masterGain, jlong maximumRetainedBytes,
    jlong handoffLease, jboolean preparedStartProjectFramePresent,
    jlong preparedStartProjectFrame, jboolean initialPaused,
    jboolean initialLoopPresent, jlong initialLoopStartProjectFrame,
    jlong initialLoopEndProjectFrame, jobjectArray laneIdsValue,
    jobjectArray lanePathsValue,
    jfloatArray laneGainsValue, jbooleanArray laneMutedValue,
    jbooleanArray laneSoloValue, jboolean playbackPresent, jdouble entrySeconds,
    jdouble playbackRate, jdouble transposeSemitones, jboolean click,
    jint countInBars, jdouble cueVolume,
    jboolean accent, jdoubleArray beatsValue, jint beatsPerBar, jint downbeat,
    jintArray downbeatsValue, jboolean trainingPresent, jint trainingMode,
    jlong trainingPeriodFrames, jlongArray trainingWindowStartsValue,
    jlongArray trainingWindowEndsValue, jobjectArray trainingLaneIdsValue,
    jboolean trainingEnabled, jboolean graphPresent,
    jobjectArray graphNodesValue, jobjectArray graphConnectionsValue,
    jobjectArray authorizedRootsValue) {
  const uint64_t generation = static_cast<uint64_t>(generationValue);
  auto &bridge = owner();
  std::lock_guard<std::mutex> lock(bridge.commandMutex);
  try {
    const std::vector<std::string> laneIds =
        stringArray(env, laneIdsValue, singz::kNativePlaybackMaximumLanes);
    const std::vector<std::string> lanePaths =
        stringArray(env, lanePathsValue, singz::kNativePlaybackMaximumLanes);
    const std::vector<std::string> roots = stringArray(env, authorizedRootsValue, 16);
    const std::vector<std::string> trainingLaneIds = stringArray(
        env, trainingLaneIdsValue, singz::kNativePlaybackMaximumLanes);
    const jsize laneCount = laneIdsValue == nullptr
                                ? 0
                                : env->GetArrayLength(laneIdsValue);
    const jsize outputCount = outputChannelsValue == nullptr
                                  ? 0
                                  : env->GetArrayLength(outputChannelsValue);
    const jsize beatCount =
        beatsValue == nullptr ? 0 : env->GetArrayLength(beatsValue);
    const jsize downbeatCount =
        downbeatsValue == nullptr ? 0 : env->GetArrayLength(downbeatsValue);
    const jsize trainingWindowStartCount =
        trainingWindowStartsValue == nullptr
            ? 0
            : env->GetArrayLength(trainingWindowStartsValue);
    const jsize trainingWindowEndCount =
        trainingWindowEndsValue == nullptr
            ? 0
            : env->GetArrayLength(trainingWindowEndsValue);
    const jsize trainingLaneCount =
        trainingLaneIdsValue == nullptr
            ? 0
            : env->GetArrayLength(trainingLaneIdsValue);
    const bool validTraining =
        trainingPresent != JNI_TRUE ||
        (trainingLaneCount > 0 &&
         trainingLaneCount <=
             static_cast<jsize>(singz::kNativePlaybackMaximumLanes) &&
         static_cast<jsize>(trainingLaneIds.size()) == trainingLaneCount &&
         ((trainingMode == 0 && trainingPeriodFrames > 0 &&
           trainingWindowStartCount == 0 && trainingWindowEndCount == 0) ||
          (trainingMode == 1 && trainingPeriodFrames == 0 &&
           trainingWindowStartCount > 0 &&
           trainingWindowStartCount == trainingWindowEndCount &&
           trainingWindowStartCount <= static_cast<jsize>(
               singz::kNativePlaybackMaximumTrainingWindows))));
    singz::NativePlaybackGraphDocument graph;
    const bool validGraph = graphDocument(env, graphPresent, graphNodesValue,
                                          graphConnectionsValue, &graph);
    const bool validShape =
        generation != 0 && laneCount > 0 &&
        laneCount <= static_cast<jsize>(singz::kNativePlaybackMaximumLanes) &&
        static_cast<jsize>(laneIds.size()) == laneCount &&
        static_cast<jsize>(lanePaths.size()) == laneCount &&
        laneGainsValue != nullptr && laneMutedValue != nullptr &&
        laneSoloValue != nullptr && env->GetArrayLength(laneGainsValue) == laneCount &&
        env->GetArrayLength(laneMutedValue) == laneCount &&
        env->GetArrayLength(laneSoloValue) == laneCount && outputCount > 0 &&
        outputCount <= static_cast<jsize>(singz::kAudioHostMaxChannels) &&
        sampleRate > 0 && maximumFrames > 0 && bufferFrames >= 0 &&
        std::isfinite(masterGain) && masterGain >= 0.0F &&
        masterGain <= singz::kNativePlaybackMaximumLinearGain &&
        maximumRetainedBytes > 0 &&
        static_cast<uint64_t>(maximumRetainedBytes) <=
            static_cast<uint64_t>(std::numeric_limits<size_t>::max()) &&
        handoffLease >= 0 &&
        static_cast<uint64_t>(handoffLease) <=
            singz::kNativePlaybackMaximumJsSafeInteger &&
        (!preparedStartProjectFramePresent ||
         (preparedStartProjectFrame >=
              -static_cast<jlong>(singz::kNativePlaybackMaximumJsSafeInteger) &&
          preparedStartProjectFrame <=
              static_cast<jlong>(singz::kNativePlaybackMaximumJsSafeInteger))) &&
        (initialLoopPresent != JNI_TRUE ||
         (initialLoopStartProjectFrame >= 0 &&
          initialLoopEndProjectFrame > initialLoopStartProjectFrame &&
          initialLoopEndProjectFrame <= static_cast<jlong>(
              singz::kNativePlaybackMaximumJsSafeInteger))) &&
        !roots.empty() && validTraining && validGraph &&
        (!playbackPresent ||
         (std::isfinite(entrySeconds) && entrySeconds >= 0.0 &&
          std::isfinite(playbackRate) && playbackRate >= 0.25 &&
          playbackRate <= 4.0 && std::isfinite(transposeSemitones) &&
          transposeSemitones >= -24.0 && transposeSemitones <= 24.0 &&
          countInBars >= 0 && countInBars <= 2 &&
          std::isfinite(cueVolume) && cueVolume >= 0.0 && cueVolume <= 1.0 &&
          beatCount >= 0 &&
          beatCount <= static_cast<jsize>(singz::kPlaybackCueMaximumBeats) &&
          downbeatCount >= 0 && downbeatCount <= beatCount));
    if (!validShape) {
      return javaJson(env, resultJson(bridge.session.failPrepareAdmission(
                               generation,
                               singz::NativePlaybackError::InvalidConfiguration)));
    }

    std::vector<jint> outputChannels(static_cast<size_t>(outputCount));
    env->GetIntArrayRegion(outputChannelsValue, 0, outputCount,
                           outputChannels.data());
    std::vector<jfloat> gains(static_cast<size_t>(laneCount));
    std::vector<jboolean> muted(static_cast<size_t>(laneCount));
    std::vector<jboolean> solo(static_cast<size_t>(laneCount));
    env->GetFloatArrayRegion(laneGainsValue, 0, laneCount, gains.data());
    env->GetBooleanArrayRegion(laneMutedValue, 0, laneCount, muted.data());
    env->GetBooleanArrayRegion(laneSoloValue, 0, laneCount, solo.data());

    singz::NativePlaybackPrepareConfig config;
    config.outputDeviceUid = fromJava(env, outputDeviceUid);
    config.requestedSampleRate = static_cast<double>(sampleRate);
    config.maximumFrames = static_cast<uint32_t>(maximumFrames);
    config.requestedBufferFrames = static_cast<uint32_t>(bufferFrames);
    config.masterGain = masterGain;
    config.maximumRetainedBytes = static_cast<size_t>(maximumRetainedBytes);
    config.handoffLease = static_cast<uint64_t>(handoffLease);
    if (preparedStartProjectFramePresent == JNI_TRUE)
      config.preparedStartProjectFrame =
          static_cast<int64_t>(preparedStartProjectFrame);
    config.initialTransport.startPaused = initialPaused == JNI_TRUE;
    if (initialLoopPresent == JNI_TRUE) {
      config.initialTransport.loop = singz::NativePlaybackInitialLoop{
          static_cast<int64_t>(initialLoopStartProjectFrame),
          static_cast<int64_t>(initialLoopEndProjectFrame)};
    }
    config.outputChannels.reserve(static_cast<size_t>(outputCount));
    for (const jint channel : outputChannels) {
      if (channel < 0 ||
          channel >= static_cast<jint>(singz::kAudioHostMaxChannels)) {
        return javaJson(env, resultJson(bridge.session.failPrepareAdmission(
                                 generation,
                                 singz::NativePlaybackError::InvalidConfiguration)));
      }
      config.outputChannels.push_back(static_cast<uint32_t>(channel));
    }

    if (playbackPresent) {
      config.playbackRate = playbackRate;
      config.transposeSemitones = transposeSemitones;
      singz::PlaybackCuePlanRequest playback;
      playback.entrySeconds = entrySeconds;
      playback.playbackRate = playbackRate;
      playback.click = click == JNI_TRUE;
      playback.countInBars = static_cast<uint32_t>(countInBars);
      playback.volume = cueVolume;
      playback.accent = accent == JNI_TRUE;
      playback.sampleRate = static_cast<double>(sampleRate);
      playback.durationSeconds = singz::kPlaybackCueMaximumDurationSeconds;
      if (beatCount != 0) {
        playback.beatGrid.beats.resize(static_cast<size_t>(beatCount));
        env->GetDoubleArrayRegion(beatsValue, 0, beatCount,
                                  playback.beatGrid.beats.data());
        playback.beatGrid.beatsPerBar = static_cast<uint32_t>(beatsPerBar);
        playback.beatGrid.downbeat = static_cast<uint32_t>(downbeat);
        std::vector<jint> downbeats(static_cast<size_t>(downbeatCount));
        if (downbeatCount != 0)
          env->GetIntArrayRegion(downbeatsValue, 0, downbeatCount,
                                 downbeats.data());
        playback.beatGrid.downbeats.reserve(static_cast<size_t>(downbeatCount));
        for (jint position : downbeats) {
          if (position < 0)
            return javaJson(env, resultJson(bridge.session.failPrepareAdmission(
                                     generation,
                                     singz::NativePlaybackError::InvalidConfiguration)));
          playback.beatGrid.downbeats.push_back(static_cast<uint32_t>(position));
        }
      }
      config.cuePlan = std::move(playback);
    }

    if (trainingPresent == JNI_TRUE) {
      singz::NativePlaybackTrainingDuckConfig training;
      training.mode =
          trainingMode == 0 ? singz::NativePlaybackTrainingMode::Period
                            : singz::NativePlaybackTrainingMode::Windows;
      training.periodFrames = static_cast<int64_t>(trainingPeriodFrames);
      training.laneIds = trainingLaneIds;
      training.enabled = trainingEnabled == JNI_TRUE;
      if (trainingMode == 1) {
        std::vector<jlong> starts(
            static_cast<size_t>(trainingWindowStartCount));
        std::vector<jlong> ends(
            static_cast<size_t>(trainingWindowEndCount));
        env->GetLongArrayRegion(trainingWindowStartsValue, 0,
                                trainingWindowStartCount, starts.data());
        env->GetLongArrayRegion(trainingWindowEndsValue, 0,
                                trainingWindowEndCount, ends.data());
        training.windows.reserve(static_cast<size_t>(trainingWindowStartCount));
        for (jsize index = 0; index < trainingWindowStartCount; ++index) {
          training.windows.push_back(
              {static_cast<int64_t>(starts[static_cast<size_t>(index)]),
               static_cast<int64_t>(ends[static_cast<size_t>(index)])});
        }
      }
      config.trainingDuck = std::move(training);
    }
    if (graphPresent == JNI_TRUE)
      config.graphDocument = std::move(graph);

    std::vector<singz::NativePlaybackLaneSource> lanes;
    lanes.reserve(static_cast<size_t>(laneCount));
    for (jsize index = 0; index < laneCount; ++index) {
      if (laneIds[static_cast<size_t>(index)].empty() ||
          lanePaths[static_cast<size_t>(index)].empty() ||
          !std::isfinite(gains[static_cast<size_t>(index)]) ||
          gains[static_cast<size_t>(index)] < 0.0F ||
          gains[static_cast<size_t>(index)] >
              singz::kNativePlaybackMaximumLinearGain) {
        return javaJson(env, resultJson(bridge.session.failPrepareAdmission(
                                 generation,
                                 singz::NativePlaybackError::InvalidConfiguration)));
      }
      auto descriptor =
          openAuthorized(lanePaths[static_cast<size_t>(index)], roots);
      if (!descriptor.valid()) {
        return javaJson(env, resultJson(bridge.session.failPrepareAdmission(
                                 generation,
                                 singz::NativePlaybackError::DecodeFailure)));
      }
      // The authorized path is this bridge's opaque identity for the bytes:
      // the core never opens or resolves it, it only compares it when a
      // retaining unload offers an already decoded lane to the next prepare.
      lanes.push_back({laneIds[static_cast<size_t>(index)],
                       std::move(descriptor),
                       gains[static_cast<size_t>(index)],
                       muted[static_cast<size_t>(index)] == JNI_TRUE,
                       solo[static_cast<size_t>(index)] == JNI_TRUE,
                       lanePaths[static_cast<size_t>(index)]});
    }
    CancellationContext cancellation{&bridge, generation};
    const auto result = bridge.session.prepare(
        std::move(config), std::move(lanes), generation,
        {&cancellation, &cancellationRequested});
    return javaJson(env, resultJson(result));
  } catch (const std::bad_alloc &) {
    const auto failure = bridge.session.failPrepareAdmission(
        generation, singz::NativePlaybackError::ResourceExhausted);
    return javaJson(env, resultJson(failure));
  } catch (...) {
    const auto failure = bridge.session.failPrepareAdmission(
        generation, singz::NativePlaybackError::ProviderFailure);
    return javaJson(env, resultJson(failure));
  }
}

static jstring nativePlaybackConfigured(JNIEnv *env, jobject,
                                        jlong generationValue) {
  const uint64_t generation = static_cast<uint64_t>(generationValue);
  auto &bridge = owner();
  std::lock_guard<std::mutex> lock(bridge.commandMutex);
  return resultBoundary(env, generation,
                        [&] { return configuredResult(bridge, generation); });
}

static jstring nativePlaybackOpenOutput(JNIEnv *env, jobject,
                                        jlong generationValue) {
  const uint64_t generation = static_cast<uint64_t>(generationValue);
  auto &bridge = owner();
  std::lock_guard<std::mutex> lock(bridge.commandMutex);
  singz::NativePlaybackDeliveryToken token;
  try {
    const auto result = bridge.session.openOutput(generation, &token);
    const std::string json = resultJson(result);
    jstring delivered = javaJson(env, json);
    if (delivered != nullptr &&
        (!token.valid() || bridge.session.acknowledgeDelivery(token)))
      return delivered;
    if (token.valid())
      (void)bridge.session.abortDelivery(token);
    return nullptr;
  } catch (...) {
    if (token.valid())
      (void)bridge.session.abortDelivery(token);
    return javaJson(env, resultJson(providerFailure(
                             generation, "Android output open failed unexpectedly")));
  }
}

static jstring nativePlaybackStart(JNIEnv *env, jobject,
                                   jlong generationValue) {
  const uint64_t generation = static_cast<uint64_t>(generationValue);
  auto &bridge = owner();
  std::lock_guard<std::mutex> lock(bridge.commandMutex);
  singz::NativePlaybackDeliveryToken token;
  try {
    const auto result = bridge.session.start(generation, &token);
    const std::string json = resultJson(result);
    jstring delivered = javaJson(env, json);
    if (delivered != nullptr &&
        (!token.valid() || bridge.session.acknowledgeDelivery(token)))
      return delivered;
    if (token.valid())
      (void)bridge.session.abortDelivery(token);
    return nullptr;
  } catch (...) {
    if (token.valid())
      (void)bridge.session.abortDelivery(token);
    return javaJson(env, resultJson(providerFailure(
                             generation, "Android output start failed unexpectedly")));
  }
}

#define SINGZ_PLAYBACK_RESULT_JNI(name, expression)                            \
  static jstring name(JNIEnv *env, jobject, jlong generationValue) {          \
    const uint64_t generation = static_cast<uint64_t>(generationValue);       \
    auto &bridge = owner();                                                    \
    std::lock_guard<std::mutex> lock(bridge.commandMutex);                    \
    return resultBoundary(env, generation, [&] { return (expression); });     \
  }

SINGZ_PLAYBACK_RESULT_JNI(nativePlaybackStop,
                          bridge.session.stop(generation))
SINGZ_PLAYBACK_RESULT_JNI(nativePlaybackPause,
                          bridge.session.pause(generation))
SINGZ_PLAYBACK_RESULT_JNI(nativePlaybackResume,
                          bridge.session.resume(generation))
SINGZ_PLAYBACK_RESULT_JNI(nativePlaybackClearLoop,
                          bridge.session.clearLoop(generation))
SINGZ_PLAYBACK_RESULT_JNI(nativePlaybackReanchor,
                          bridge.session.reanchorTransport(generation))

#undef SINGZ_PLAYBACK_RESULT_JNI

static jstring nativePlaybackSeek(JNIEnv *env, jobject,
                                  jlong generationValue, jlong projectFrame) {
  const uint64_t generation = static_cast<uint64_t>(generationValue);
  auto &bridge = owner();
  std::lock_guard<std::mutex> lock(bridge.commandMutex);
  return resultBoundary(env, generation, [&] {
    return bridge.session.seek(generation, static_cast<int64_t>(projectFrame));
  });
}

static jstring nativePlaybackSetLoop(
    JNIEnv *env, jobject, jlong generationValue, jlong startProjectFrame,
    jlong endProjectFrame) {
  const uint64_t generation = static_cast<uint64_t>(generationValue);
  auto &bridge = owner();
  std::lock_guard<std::mutex> lock(bridge.commandMutex);
  return resultBoundary(env, generation, [&] {
    return bridge.session.setLoop(generation,
                                  static_cast<int64_t>(startProjectFrame),
                                  static_cast<int64_t>(endProjectFrame));
  });
}

static jstring nativePlaybackPreviewClick(JNIEnv *env, jobject,
                                          jlong generationValue,
                                          jint soundValue) {
  const uint64_t generation = static_cast<uint64_t>(generationValue);
  auto &bridge = owner();
  std::lock_guard<std::mutex> lock(bridge.commandMutex);
  return resultBoundary(env, generation, [&] {
    return bridge.session.previewClick(
        generation,
        static_cast<singz::NativePlaybackPreviewClickSound>(soundValue));
  });
}

static jstring nativePlaybackSetLaneControl(
    JNIEnv *env, jobject, jlong generationValue, jstring laneIdValue,
    jfloat gain, jboolean muted, jboolean solo) {
  const uint64_t generation = static_cast<uint64_t>(generationValue);
  const std::string laneId = fromJava(env, laneIdValue);
  auto &bridge = owner();
  std::lock_guard<std::mutex> lock(bridge.commandMutex);
  return resultBoundary(env, generation, [&] {
    return bridge.session.setLaneControl(generation, laneId, gain,
                                         muted == JNI_TRUE, solo == JNI_TRUE);
  });
}

static jstring nativePlaybackSetMasterGain(JNIEnv *env, jobject,
                                           jlong generationValue, jfloat gain) {
  const uint64_t generation = static_cast<uint64_t>(generationValue);
  auto &bridge = owner();
  std::lock_guard<std::mutex> lock(bridge.commandMutex);
  return resultBoundary(env, generation,
                        [&] { return bridge.session.setMasterGain(generation, gain); });
}

static jstring nativePlaybackSetTrainingEnabled(JNIEnv *env, jobject,
                                                jlong generationValue,
                                                jboolean enabled) {
  const uint64_t generation = static_cast<uint64_t>(generationValue);
  auto &bridge = owner();
  std::lock_guard<std::mutex> lock(bridge.commandMutex);
  return resultBoundary(env, generation, [&] {
    return bridge.session.setTrainingEnabled(generation, enabled == JNI_TRUE);
  });
}

static jstring unloadWithRetention(JNIEnv *env, jlong generationValue,
                                   singz::NativePlaybackLaneRetention
                                       retention) {
  const uint64_t generation = static_cast<uint64_t>(generationValue);
  auto &bridge = owner();
  std::lock_guard<std::mutex> lock(bridge.commandMutex);
  try {
    return javaJson(
        env, unloadJson(bridge.session.unloadWithCleanup(generation,
                                                         retention)));
  } catch (...) {
    singz::NativePlaybackUnloadReceipt receipt;
    receipt.playback = providerFailure(
        generation, "Android native playback cleanup failed unexpectedly");
    receipt.cleanup.safety = singz::NativePlaybackCleanupSafety::Uncertain;
    receipt.cleanup.error = singz::NativePlaybackError::TeardownUncertain;
    receipt.cleanup.generation = generation;
    receipt.cleanup.state = singz::NativePlaybackState::Quarantined;
    receipt.cleanup.physicalOwnershipRetained = true;
    return javaJson(env, unloadJson(receipt));
  }
}

// The prepared lane envelopes for one generation, published once rather than
// on every status poll. The exact twin of iOS's SingzNativePlaybackLanePeaks.
static jstring nativePlaybackLanePeaks(JNIEnv *env, jobject,
                                       jlong generationValue) {
  auto &bridge = owner();
  const auto peaks =
      bridge.session.lanePeaks(static_cast<uint64_t>(generationValue));
  std::string output = "{\"ok\":";
  output += peaks.ok ? "true" : "false";
  output += ",\"error\":";
  appendQuoted(output, singz::nativePlaybackErrorName(peaks.error));
  output += ",\"generation\":" + std::to_string(peaks.generation);
  output += ",\"bucketCount\":" + std::to_string(peaks.bucketCount);
  output += ",\"lanes\":[";
  for (size_t index = 0; index < peaks.lanes.size(); ++index) {
    if (index != 0)
      output.push_back(',');
    const auto &lane = peaks.lanes[index];
    output += "{\"id\":";
    appendQuoted(output, lane.id);
    output += ",\"peaksValid\":";
    output += lane.valid ? "true" : "false";
    output += ",\"peaks\":[";
    for (size_t bucket = 0; bucket < lane.peaks.size(); ++bucket) {
      if (bucket != 0)
        output.push_back(',');
      // %.17g, like every other number on this hop: Kotlin's parser is
      // correctly rounded, so the double JavaScript receives here is the same
      // double iOS builds straight from the core's float.
      appendDouble(output, lane.peaks[bucket]);
    }
    output.push_back(']');
    output.push_back('}');
  }
  output += "],\"message\":";
  appendQuoted(output, peaks.message);
  output.push_back('}');
  return javaJson(env, output);
}

static jstring nativePlaybackUnload(JNIEnv *env, jobject,
                                    jlong generationValue) {
  return unloadWithRetention(env, generationValue,
                             singz::NativePlaybackLaneRetention::Release);
}

// The exact twin of iOS's SingzNativePlaybackUnloadRetainingLanes: one
// argument, the same resolved JSON, and this generation's decoded lanes kept
// for the very next prepare of the same files.
static jstring nativePlaybackUnloadRetainingLanes(JNIEnv *env, jobject,
                                                  jlong generationValue) {
  return unloadWithRetention(env, generationValue,
                             singz::NativePlaybackLaneRetention::Park);
}

namespace {

// Keep the app's dynamic JNI ABI intentionally small. The appmodule export
// gate owns the existing symbol-based methods; Phase 4 playback methods are
// registered as one atomic table when libsingzcore is loaded.
static const JNINativeMethod kNativePlaybackMethods[] = {
    {const_cast<char *>("nativePlaybackStatus"),
     const_cast<char *>("()Ljava/lang/String;"),
     reinterpret_cast<void *>(nativePlaybackStatus)},
    {const_cast<char *>("nativePlaybackSession"),
     const_cast<char *>("()Ljava/lang/String;"),
     reinterpret_cast<void *>(nativePlaybackSession)},
    {const_cast<char *>("nativePlaybackClaim"),
     const_cast<char *>("(JJ)Ljava/lang/String;"),
     reinterpret_cast<void *>(nativePlaybackClaim)},
    {const_cast<char *>("nativePlaybackRequestCancellation"),
     const_cast<char *>("(J)Z"),
     reinterpret_cast<void *>(nativePlaybackRequestCancellation)},
    {const_cast<char *>("nativePlaybackPrepare"),
     const_cast<char *>(
         "(JLjava/lang/String;[IIIIFJJZJZZJJ[Ljava/lang/String;[Ljava/lang/String;"
         "[F[Z[ZZDDDZIDZ[DII[IZIJ[J[J[Ljava/lang/String;Z"
         "Z[Lcom/singzplayer/playback/NativePlaybackGraphNodeJni;"
         "[Lcom/singzplayer/playback/NativePlaybackGraphConnectionJni;"
         "[Ljava/lang/String;)Ljava/lang/String;"),
     reinterpret_cast<void *>(nativePlaybackPrepare)},
    {const_cast<char *>("nativePlaybackConfigured"),
     const_cast<char *>("(J)Ljava/lang/String;"),
     reinterpret_cast<void *>(nativePlaybackConfigured)},
    {const_cast<char *>("nativePlaybackOpenOutput"),
     const_cast<char *>("(J)Ljava/lang/String;"),
     reinterpret_cast<void *>(nativePlaybackOpenOutput)},
    {const_cast<char *>("nativePlaybackStart"),
     const_cast<char *>("(J)Ljava/lang/String;"),
     reinterpret_cast<void *>(nativePlaybackStart)},
    {const_cast<char *>("nativePlaybackStop"),
     const_cast<char *>("(J)Ljava/lang/String;"),
     reinterpret_cast<void *>(nativePlaybackStop)},
    {const_cast<char *>("nativePlaybackPause"),
     const_cast<char *>("(J)Ljava/lang/String;"),
     reinterpret_cast<void *>(nativePlaybackPause)},
    {const_cast<char *>("nativePlaybackResume"),
     const_cast<char *>("(J)Ljava/lang/String;"),
     reinterpret_cast<void *>(nativePlaybackResume)},
    {const_cast<char *>("nativePlaybackSeek"),
     const_cast<char *>("(JJ)Ljava/lang/String;"),
     reinterpret_cast<void *>(nativePlaybackSeek)},
    {const_cast<char *>("nativePlaybackSetLoop"),
     const_cast<char *>("(JJJ)Ljava/lang/String;"),
     reinterpret_cast<void *>(nativePlaybackSetLoop)},
    {const_cast<char *>("nativePlaybackClearLoop"),
     const_cast<char *>("(J)Ljava/lang/String;"),
     reinterpret_cast<void *>(nativePlaybackClearLoop)},
    {const_cast<char *>("nativePlaybackReanchor"),
     const_cast<char *>("(J)Ljava/lang/String;"),
     reinterpret_cast<void *>(nativePlaybackReanchor)},
    {const_cast<char *>("nativePlaybackPreviewClick"),
     const_cast<char *>("(JI)Ljava/lang/String;"),
     reinterpret_cast<void *>(nativePlaybackPreviewClick)},
    {const_cast<char *>("nativePlaybackSetLaneControl"),
     const_cast<char *>("(JLjava/lang/String;FZZ)Ljava/lang/String;"),
     reinterpret_cast<void *>(nativePlaybackSetLaneControl)},
    {const_cast<char *>("nativePlaybackSetMasterGain"),
     const_cast<char *>("(JF)Ljava/lang/String;"),
     reinterpret_cast<void *>(nativePlaybackSetMasterGain)},
    {const_cast<char *>("nativePlaybackSetTrainingEnabled"),
     const_cast<char *>("(JZ)Ljava/lang/String;"),
     reinterpret_cast<void *>(nativePlaybackSetTrainingEnabled)},
    {const_cast<char *>("nativePlaybackUnload"),
     const_cast<char *>("(J)Ljava/lang/String;"),
     reinterpret_cast<void *>(nativePlaybackUnload)},
    {const_cast<char *>("nativePlaybackLanePeaks"),
     const_cast<char *>("(J)Ljava/lang/String;"),
     reinterpret_cast<void *>(nativePlaybackLanePeaks)},
    {const_cast<char *>("nativePlaybackUnloadRetainingLanes"),
     const_cast<char *>("(J)Ljava/lang/String;"),
     reinterpret_cast<void *>(nativePlaybackUnloadRetainingLanes)},
};

} // namespace

extern "C" JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM *vm, void *) {
  JNIEnv *env = nullptr;
  if (vm == nullptr ||
      vm->GetEnv(reinterpret_cast<void **>(&env), JNI_VERSION_1_6) != JNI_OK ||
      env == nullptr) {
    return JNI_ERR;
  }
  jclass core = env->FindClass("com/singzplayer/split/SingzCore");
  if (core == nullptr)
    return JNI_ERR;
  const jint count = static_cast<jint>(std::size(kNativePlaybackMethods));
  const jint registered = env->RegisterNatives(core, kNativePlaybackMethods, count);
  env->DeleteLocalRef(core);
  return registered == JNI_OK ? JNI_VERSION_1_6 : JNI_ERR;
}

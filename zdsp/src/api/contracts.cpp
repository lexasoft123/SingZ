#include "zdsp/latency.h"
#include "zdsp/processor.h"

#include <cmath>
#include <limits.h>

namespace zdsp {

namespace {

Status validateTransport(const TransportContext& transport) noexcept {
  constexpr uint64_t kKnownValidFields =
      TransportValidProjectSamples | TransportValidContinuousSamples |
      TransportValidTempo | TransportValidMusicPosition |
      TransportValidCycleRange | TransportValidTimeSignature;
  constexpr uint32_t kKnownStateFlags =
      TransportStatePlaying | TransportStateRecording | TransportStateCycling;
  if ((transport.validFields & ~kKnownValidFields) != 0 ||
      (transport.stateFlags & ~kKnownStateFlags) != 0)
    return {StatusCode::InvalidArgument, 200};
  if ((transport.validFields & TransportValidTempo) != 0 &&
      (!std::isfinite(transport.tempo) || transport.tempo <= 0.0))
    return {StatusCode::InvalidArgument, 201};
  if ((transport.validFields & TransportValidMusicPosition) != 0 &&
      (!std::isfinite(transport.projectTimeMusic) ||
       !std::isfinite(transport.barPositionMusic)))
    return {StatusCode::InvalidArgument, 202};
  if ((transport.validFields & TransportValidCycleRange) != 0 &&
      (!std::isfinite(transport.cycleStartMusic) ||
       !std::isfinite(transport.cycleEndMusic) ||
       transport.cycleEndMusic <= transport.cycleStartMusic))
    return {StatusCode::InvalidArgument, 203};
  if ((transport.stateFlags & TransportStateCycling) != 0 &&
      (transport.validFields & TransportValidCycleRange) == 0)
    return {StatusCode::InvalidArgument, 204};
  if ((transport.validFields & TransportValidTimeSignature) != 0) {
    const int32_t numerator = transport.timeSignatureNumerator;
    const int32_t denominator = transport.timeSignatureDenominator;
    if (numerator <= 0 || denominator <= 0 ||
        (denominator & (denominator - 1)) != 0)
      return {StatusCode::InvalidArgument, 205};
  }
  // Signed sample positions deliberately admit negative pre-roll. Their
  // validity bits replace sentinel values, so every int64_t value is valid.
  return okStatus();
}

Status validateDiscontinuity(const ProcessContext& context) noexcept {
  constexpr uint32_t kKnownRenderTimeFlags =
      RenderTimeHostValid | RenderTimeDiscontinuous;
  constexpr uint32_t kKnownDiscontinuityFlags =
      DiscontinuityFlagResetState | DiscontinuityFlagTimeValid;
  if ((context.time.flags & ~kKnownRenderTimeFlags) != 0 ||
      (context.discontinuity.flags & ~kKnownDiscontinuityFlags) != 0 ||
      context.discontinuity.reason > DiscontinuityReason::DeviceLost)
    return {StatusCode::InvalidArgument, 210};
  const bool typed = context.discontinuity.reason != DiscontinuityReason::None;
  const bool marked = (context.time.flags & RenderTimeDiscontinuous) != 0;
  const bool resets =
      (context.discontinuity.flags & DiscontinuityFlagResetState) != 0;
  if (typed != marked || typed != resets ||
      (!typed && context.discontinuity.flags != DiscontinuityFlagNone))
    return {StatusCode::InvalidArgument, 211};
  return okStatus();
}

}  // namespace

bool isValid(const AudioBusDescriptor& descriptor) noexcept {
  if (descriptor.sampleFormat != SampleFormat::Float32Planar || descriptor.channelCount == 0 ||
      descriptor.channelCount > kMaximumChannelsPerBus) return false;
  switch (descriptor.layout) {
    case AudioChannelLayout::Mono:
      return descriptor.channelCount == 1 && descriptor.channelRoles == nullptr;
    case AudioChannelLayout::Stereo:
      return descriptor.channelCount == 2 && descriptor.channelRoles == nullptr;
    case AudioChannelLayout::Discrete:
      if (descriptor.channelRoles == nullptr) return false;
      for (uint32_t channel = 0; channel < descriptor.channelCount; ++channel) {
        const auto role = descriptor.channelRoles[channel];
        if (role < AudioChannelRole::Mono || role > AudioChannelRole::Discrete) return false;
      }
      return true;
  }
  return false;
}

Status validatePrepareSpec(const PrepareSpec& spec) noexcept {
  if (spec.interfaceVersion != kProcessorInterfaceVersion)
    return {StatusCode::VersionMismatch, spec.interfaceVersion};
  if (spec.structSize < kPrepareSpecV1RequiredSize || !std::isfinite(spec.sampleRate.value) ||
      spec.sampleRate.value <= 0.0 || spec.maximumBlockFrames.value == 0 ||
      spec.inputBusCount > kMaximumBusesPerProcessor ||
      spec.outputBusCount > kMaximumBusesPerProcessor ||
      (spec.inputBusCount != 0 && spec.inputBuses == nullptr) ||
      (spec.outputBusCount != 0 && spec.outputBuses == nullptr)) {
    return {StatusCode::InvalidArgument, 1};
  }
  for (uint32_t bus = 0; bus < spec.inputBusCount; ++bus) {
    if (!isValid(spec.inputBuses[bus])) return {StatusCode::UnsupportedFormat, bus};
  }
  for (uint32_t bus = 0; bus < spec.outputBusCount; ++bus) {
    if (!isValid(spec.outputBuses[bus])) return {StatusCode::UnsupportedFormat, bus | 0x80000000u};
  }
  return okStatus();
}

Status validateProcessContext(const ProcessContext& context) noexcept {
  if (context.interfaceVersion != kProcessContextInterfaceVersion)
    return {StatusCode::VersionMismatch, context.interfaceVersion};
  if (context.structSize < kProcessContextV1RequiredSize ||
      !std::isfinite(context.sampleRate.value) || context.sampleRate.value <= 0.0 ||
      context.parameterCount > kMaximumEventsPerBlock ||
      context.eventCount > kMaximumEventsPerBlock ||
      (context.parameterCount != 0 && context.parameters == nullptr) ||
      (context.eventCount != 0 && context.events == nullptr) ||
      (context.scratch.size != 0 && context.scratch.data == nullptr)) {
    return {StatusCode::InvalidArgument, 1};
  }
  constexpr uint32_t kKnownProcessFlags = ProcessContextFlagTailDrain;
  if ((processContextFlags(context) & ~kKnownProcessFlags) != 0)
    return {StatusCode::InvalidArgument, 2};
  if ((processContextFlags(context) & ProcessContextFlagTailDrain) != 0 &&
      (context.parameterCount != 0 || context.eventCount != 0 ||
       (context.transport != nullptr &&
        (context.transport->stateFlags &
         (TransportStatePlaying | TransportStateRecording |
          TransportStateCycling)) != 0)))
    return {StatusCode::InvalidArgument, 3};
  const Status validDiscontinuity = validateDiscontinuity(context);
  if (!succeeded(validDiscontinuity)) return validDiscontinuity;
  if (context.transport != nullptr) {
    const Status validTransport = validateTransport(*context.transport);
    if (!succeeded(validTransport)) return validTransport;
  }
  uint32_t previousOffset = 0;
  for (uint32_t event = 0; event < context.parameterCount; ++event) {
    const auto& parameter = context.parameters[event];
    const bool invalidOffset = context.frames.value == 0
        ? parameter.sampleOffset.value != 0
        : parameter.sampleOffset.value >= context.frames.value;
    if (invalidOffset || !std::isfinite(parameter.value) ||
        (parameter.curve != ParameterCurve::Step && parameter.curve != ParameterCurve::Linear) ||
        (event != 0 && parameter.sampleOffset.value < previousOffset)) {
      return {StatusCode::InvalidArgument, event + 10};
    }
    previousOffset = parameter.sampleOffset.value;
  }
  previousOffset = 0;
  for (uint32_t event = 0; event < context.eventCount; ++event) {
    const auto& musical = context.events[event];
    const bool invalidOffset = context.frames.value == 0
        ? musical.sampleOffset.value != 0
        : musical.sampleOffset.value >= context.frames.value;
    if (invalidOffset || !std::isfinite(musical.value) || musical.channel > 15 || musical.key > 127 ||
        musical.kind > MusicalEventKind::AllNotesOff ||
        (event != 0 && musical.sampleOffset.value < previousOffset)) {
      return {StatusCode::InvalidArgument, event + 100};
    }
    previousOffset = musical.sampleOffset.value;
  }
  return okStatus();
}

Status validateProcessor(const ProcessorHandle& processor) noexcept {
  if (processor.state == nullptr || processor.functions == nullptr) return {StatusCode::InvalidArgument, 1};
  const auto& functions = *processor.functions;
  if (functions.interfaceVersion != kProcessorInterfaceVersion ||
      functions.structSize < kProcessorVTableV1RequiredSize) {
    return {StatusCode::VersionMismatch, functions.interfaceVersion};
  }
  if (functions.prepare == nullptr || functions.reset == nullptr || functions.process == nullptr ||
      functions.latency == nullptr || functions.tail == nullptr || functions.deactivate == nullptr ||
      functions.destroy == nullptr) return {StatusCode::InvalidArgument, 2};
  return okStatus();
}

Status deactivateProcessor(const ProcessorHandle& processor) noexcept {
  const Status valid = validateProcessor(processor);
  if (!succeeded(valid)) return valid;
  return processor.functions->deactivate(processor.state);
}

Status destroyProcessor(ProcessorHandle* processor) noexcept {
  if (processor == nullptr) return {StatusCode::InvalidArgument, 1};
  const Status valid = validateProcessor(*processor);
  if (!succeeded(valid)) return valid;
  const Status destroyed = processor->functions->destroy(processor->state);
  if (succeeded(destroyed)) *processor = {nullptr, nullptr};
  return destroyed;
}

namespace {
bool addChecked(int64_t value, int64_t* total) noexcept {
  if ((value > 0 && *total > INT64_MAX - value) || (value < 0 && *total < INT64_MIN - value)) return false;
  *total += value;
  return true;
}
}  // namespace

Status composeRouteLatency(const RouteLatencySnapshot& snapshot,
                           LatencyComposition* result) noexcept {
  if (result == nullptr) return {StatusCode::InvalidArgument, 1};
  if (snapshot.interfaceVersion != kRouteLatencySnapshotVersion)
    return {StatusCode::VersionMismatch, snapshot.interfaceVersion};
  if (snapshot.structSize < kRouteLatencySnapshotV1RequiredSize)
    return {StatusCode::InvalidArgument, 1};
  if (snapshot.confidencePermille > 1000) return {StatusCode::InvalidArgument, 3};
  if (snapshot.captureDevice.value < 0 || snapshot.inputConversion.value < 0 ||
      snapshot.renderDevice.value < 0 || snapshot.externalRoute.value < 0 ||
      snapshot.automaticPresentation.value < 0) return {StatusCode::InvalidArgument, 2};
  int64_t capture = 0;
  if ((snapshot.flags & RouteLatencyHasCapture) != 0 && !addChecked(snapshot.captureDevice.value, &capture))
    return {StatusCode::CapacityExceeded, 1};
  if ((snapshot.flags & RouteLatencyHasInputConversion) != 0 && !addChecked(snapshot.inputConversion.value, &capture))
    return {StatusCode::CapacityExceeded, 1};
  int64_t audible = 0;
  if ((snapshot.flags & RouteLatencyAutomaticComplete) != 0) {
    audible = snapshot.automaticPresentation.value;
  } else {
    if ((snapshot.flags & RouteLatencyHasRenderDevice) != 0 && !addChecked(snapshot.renderDevice.value, &audible))
      return {StatusCode::CapacityExceeded, 2};
    if ((snapshot.flags & RouteLatencyHasExternalRoute) != 0 && !addChecked(snapshot.externalRoute.value, &audible))
      return {StatusCode::CapacityExceeded, 2};
  }
  if ((snapshot.flags & RouteLatencyHasUserTrim) != 0 && !addChecked(snapshot.userTrim.value, &audible))
    return {StatusCode::CapacityExceeded, 2};
  int64_t total = capture;
  if (!addChecked(audible, &total)) return {StatusCode::CapacityExceeded, 3};
  *result = {{capture}, {audible}, {total}};
  return okStatus();
}

}  // namespace zdsp

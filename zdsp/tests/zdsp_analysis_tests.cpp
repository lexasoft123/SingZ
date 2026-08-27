#include <zdsp/analysis/capture_adapter.h>

#include <zcore/legacy/live_input_analysis.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <limits>
#include <thread>
#include <type_traits>
#include <vector>

// Delivery adapters are routinely stack-owned by platform bridge contexts.
// Their preallocated PCM/capture ring must therefore live behind the facade,
// particularly on Windows where worker threads default to a 1 MiB stack.
static_assert(sizeof(zdsp::analysis::LiveInputAnalysisAdapter) <= 512,
              "analysis adapter must not inline its fixed capture ring");

namespace {
int failures = 0;
#if defined(__SANITIZE_ADDRESS__) || defined(__SANITIZE_THREAD__) || \
    defined(__SANITIZE_UNDEFINED__)
constexpr bool kSanitizerMacroInstrumented = true;
#else
constexpr bool kSanitizerMacroInstrumented = false;
#endif
#if defined(__has_feature)
#if __has_feature(address_sanitizer) || __has_feature(undefined_behavior_sanitizer) || \
    __has_feature(thread_sanitizer)
constexpr bool kSanitizerFeatureInstrumented = true;
#else
constexpr bool kSanitizerFeatureInstrumented = false;
#endif
#else
constexpr bool kSanitizerFeatureInstrumented = false;
#endif
// Some GCC versions expose __has_feature without reporting TSan through it,
// while still defining __SANITIZE_THREAD__. Treat the two compiler mechanisms
// independently instead of allowing a false feature probe to mask the macro.
constexpr bool kSanitizerInstrumented =
    kSanitizerMacroInstrumented || kSanitizerFeatureInstrumented;
#define CHECK(name, condition)                                                   \
  do {                                                                           \
    if (!(condition)) {                                                          \
      std::fprintf(stderr, "FAIL: %s\n", name);                                 \
      ++failures;                                                                \
    }                                                                            \
  } while (false)

singz::AudioInputBlockView block(const std::vector<float>& samples,
                                 uint64_t sequence, uint64_t sourceFrame,
                                 double sampleRate = 48000,
                                 uint64_t generation = 7,
                                 singz::AudioInputTimestampQuality quality =
                                     singz::AudioInputTimestampQuality::Hardware,
                                 uint32_t flags =
                                     singz::AudioInputSourceFrameValid |
                                     singz::AudioInputSampleHostTimeValid |
                                     singz::AudioInputCallbackHostTimeValid |
                                     singz::AudioInputTimestampQualityValid) {
  singz::AudioInputBlockView value;
  value.capture.clockDomainId = 42;
  value.capture.streamGeneration = generation;
  value.capture.sequence = sequence;
  value.capture.sourceFrame = sourceFrame;
  value.capture.sampleHostTimeNs = 1000000000ull + static_cast<uint64_t>(
      static_cast<long double>(sourceFrame) * 1000000000.0L / sampleRate);
  value.capture.callbackHostTimeNs = value.capture.sampleHostTimeNs + 1000000;
  value.capture.timestampQuality = quality;
  value.capture.flags = flags;
  value.sequence = sequence;
  value.sampleHostTimeNs = value.capture.sampleHostTimeNs;
  value.callbackHostTimeNs = value.capture.callbackHostTimeNs;
  value.timestampQuality = quality;
  value.sampleRate = sampleRate;
  value.mono = samples.data();
  value.frames = static_cast<uint32_t>(samples.size());
  return value;
}

std::vector<float> tone(size_t frames, double sampleRate,
                        uint64_t sourceFrame = 0) {
  std::vector<float> result(frames);
  for (size_t index = 0; index < frames; ++index)
    result[index] = static_cast<float>(0.25 * std::sin(
        2.0 * M_PI * 440.0 * (sourceFrame + index) / sampleRate));
  return result;
}
}  // namespace

int main() {
  std::vector<float> sine(2048);
  for (size_t index = 0; index < sine.size(); ++index)
    sine[index] = static_cast<float>(
        0.25 * std::sin(2.0 * M_PI * 440.0 * index / 48000.0));

  auto input = block(sine, 12, 4096);
  zdsp::CaptureTime adapted;
  CHECK("typed capture mapping succeeds",
        zdsp::analysis::mapCaptureMetadata(input, adapted));
  CHECK("typed capture mapping preserves identity and timestamps",
        adapted.clockDomain.value == 42 &&
            adapted.streamGeneration.value == 7 &&
            adapted.sequence == 12 && adapted.sourceFrame.value == 4096 &&
            adapted.sampleHostTime.value == input.sampleHostTimeNs &&
            adapted.callbackHostTime.value == input.callbackHostTimeNs &&
            adapted.quality == zdsp::CaptureTimestampQuality::Hardware &&
            (adapted.flags & zdsp::CaptureTimeTimestampQualityValid) != 0);
  input.capture.sequence = 999;
  CHECK("mapped metadata owns its scalar values", adapted.sequence == 12);
  input.capture.sequence = 12;
  static_assert(std::is_copy_constructible_v<zdsp::CaptureTime>);

  auto zeroFlags = input;
  zeroFlags.capture.flags = 0;
  CHECK("zero capture-validity mask maps exactly",
        zdsp::analysis::mapCaptureMetadata(zeroFlags, adapted) &&
            adapted.flags == 0);
  auto staleWithoutValidity = input;
  staleWithoutValidity.capture.flags = singz::AudioInputStaleAnchor;
  CHECK("stale source anchor without validity is rejected",
        !zdsp::analysis::mapCaptureMetadata(staleWithoutValidity, adapted));
  auto unknownSourceFlag = input;
  unknownSourceFlag.capture.flags |= 1u << 31;
  CHECK("unknown zcore capture flag is rejected rather than filtered",
        !zdsp::analysis::mapCaptureMetadata(unknownSourceFlag, adapted));

  zdsp::analysis::LiveInputAnalysisAdapter fullFlagsAdapter(6);
  auto fullFlagsBlock = input;
  fullFlagsBlock.capture.flags =
      singz::AudioInputSourceFrameValid |
      singz::AudioInputSampleHostTimeValid |
      singz::AudioInputCallbackHostTimeValid |
      singz::AudioInputTimestampQualityValid |
      singz::AudioInputStaleAnchor;
  std::vector<zdsp::analysis::AnalysisWindow> fullFlagsWindows;
  CHECK("analysis start/end CaptureTime flags remain lossless",
        fullFlagsAdapter.push(fullFlagsBlock, [&](const auto& window) {
          fullFlagsWindows.push_back(window);
        }) &&
            fullFlagsWindows.size() == 1 &&
            fullFlagsWindows[0].start.flags == 0x1fu &&
            fullFlagsWindows[0].end.flags == 0x1fu);

  const auto native = zdsp::analysis::analyzeLiveInput(
      sine.data(), sine.size(), 48000);
  const auto legacy = singz::analyzeLiveInput(sine.data(), sine.size(), 48000);
  double expectedSquares = 0;
  double expectedPeak = 0;
  for (float sample : sine) {
    expectedSquares += static_cast<double>(sample) * sample;
    expectedPeak = std::max(expectedPeak, std::fabs(static_cast<double>(sample)));
  }
  const double expectedRms = std::sqrt(expectedSquares / sine.size());
  CHECK("native peak and RMS match scalar fixture",
        std::fabs(native.peak - expectedPeak) < 1e-12 &&
            std::fabs(native.rms - expectedRms) < 1e-12);
  CHECK("migrated pitch fixture preserves legacy result",
        native.frequency == legacy.frequency &&
            native.clarity == legacy.clarity && native.peak == legacy.peak &&
            native.rms == legacy.rms &&
            native.dbfs == legacy.dbfs);

  auto nonFinite = sine;
  nonFinite[3] = std::numeric_limits<float>::quiet_NaN();
  nonFinite[17] = std::numeric_limits<float>::infinity();
  const auto contained = zdsp::analysis::analyzeLiveInput(
      nonFinite.data(), nonFinite.size(), 48000);
  const auto containedLegacy = singz::analyzeLiveInput(
      nonFinite.data(), nonFinite.size(), 48000);
  CHECK("NaN/Inf containment shares the guarded legacy implementation",
        std::isfinite(contained.frequency) && std::isfinite(contained.clarity) &&
            std::isfinite(contained.peak) && std::isfinite(contained.rms) &&
            std::isfinite(contained.dbfs) &&
            contained.frequency == containedLegacy.frequency &&
            contained.clarity == containedLegacy.clarity &&
            contained.peak == containedLegacy.peak &&
            contained.rms == containedLegacy.rms &&
            contained.dbfs == containedLegacy.dbfs);

  zdsp::analysis::LiveInputAnalysisAdapter adapter(99);
  std::vector<zdsp::analysis::AnalysisWindow> windows;
  CHECK("first analyzer block accepted",
        adapter.push(input, [&](const auto& window) { windows.push_back(window); }));
  CHECK("first complete pitch window emitted", windows.size() == 1);

  const auto checkFirstTypedBoundary = [
      &](const char* name,
          singz::AudioInputDiscontinuityReason sourceReason,
          zdsp::DiscontinuityReason expected) {
    zdsp::analysis::LiveInputAnalysisAdapter firstBoundaryAdapter(199);
    std::vector<zdsp::analysis::AnalysisWindow> emitted;
    const auto prefixSamples = tone(512, 48000, 4096);
    auto first = block(prefixSamples, 20, 4096);
    first.capture.discontinuity = sourceReason;
    first.capture.flags |= singz::AudioInputDiscontinuous;
    const bool firstAccepted = firstBoundaryAdapter.push(
        first, [&](const auto& window) { emitted.push_back(window); });
    // State is observable before any further samples arrive: the reset has
    // already been recorded and the new-domain prefix is the only buffered
    // audio. A second block must not count the same typed boundary again.
    const bool resetBeforeMoreSamples =
        firstAccepted && emitted.empty() &&
        firstBoundaryAdapter.resets() == 1 &&
        firstBoundaryAdapter.bufferedFrames() == prefixSamples.size();
    const auto remainderSamples = tone(1536, 48000, 4608);
    auto remainder = block(remainderSamples, 21, 4608);
    const bool completed = firstBoundaryAdapter.push(
        remainder, [&](const auto& window) { emitted.push_back(window); });
    CHECK(name, resetBeforeMoreSamples && completed && emitted.size() == 1 &&
                    emitted[0].start.sequence == 20 &&
                    emitted[0].end.sequence == 21 &&
                    emitted[0].resetReason == expected &&
                    emitted[0].resetCount == 1 &&
                    firstBoundaryAdapter.resets() == 1);
  };

  checkFirstTypedBoundary(
      "first sequence-gap block resets before samples",
      singz::AudioInputDiscontinuityReason::SequenceGap,
      zdsp::DiscontinuityReason::SequenceGap);
  checkFirstTypedBoundary(
      "first source-overflow block resets before samples",
      singz::AudioInputDiscontinuityReason::SourceFrameOverflow,
      zdsp::DiscontinuityReason::SourceFrameOverflow);
  checkFirstTypedBoundary(
      "first clock-reanchor block resets before samples",
      singz::AudioInputDiscontinuityReason::ClockReanchored,
      zdsp::DiscontinuityReason::ClockReanchored);
  checkFirstTypedBoundary(
      "first device-loss block resets before samples",
      singz::AudioInputDiscontinuityReason::DeviceLost,
      zdsp::DiscontinuityReason::DeviceLost);

  zdsp::analysis::LiveInputAnalysisAdapter firstCleanAdapter(200);
  std::vector<zdsp::analysis::AnalysisWindow> firstCleanWindows;
  CHECK("first clean block keeps reset telemetry empty",
        firstCleanAdapter.push(input, [&](const auto& window) {
          firstCleanWindows.push_back(window);
        }) && firstCleanAdapter.resets() == 0 &&
            firstCleanWindows.size() == 1 &&
            firstCleanWindows[0].resetReason ==
                zdsp::DiscontinuityReason::None &&
            firstCleanWindows[0].resetCount == 0);

  std::vector<float> partial(512, 0.1f);
  auto beforeGap = block(partial, 13, 6144);
  CHECK("partial old-domain block accepted",
        adapter.push(beforeGap, [&](const auto& window) { windows.push_back(window); }));
  auto afterGap = block(sine, 15, 8192);
  afterGap.capture.discontinuity =
      singz::AudioInputDiscontinuityReason::SequenceGap;
  afterGap.capture.flags |= singz::AudioInputDiscontinuous;
  CHECK("first post-gap block accepted",
        adapter.push(afterGap, [&](const auto& window) { windows.push_back(window); }));
  CHECK("continuity reset occurs before new samples",
        windows.size() == 3 && windows.back().start.sequence == 15 &&
            windows.back().end.sequence == 15 &&
            windows.back().resetReason == zdsp::DiscontinuityReason::SequenceGap &&
            windows.back().resetCount == 1);

  const auto anchorPrefix = tone(512, 48000);
  const auto anchorWindow = tone(2048, 48000, 512);
  const auto checkAnchorBoundary = [&](const char* name,
                                       singz::AudioInputBlockView second,
                                       zdsp::DiscontinuityReason expected) {
    zdsp::analysis::LiveInputAnalysisAdapter clockAdapter(301);
    std::vector<zdsp::analysis::AnalysisWindow> emitted;
    auto first = block(anchorPrefix, 0, 0);
    const bool accepted = clockAdapter.push(
        first, [&](const auto& window) { emitted.push_back(window); }) &&
        clockAdapter.push(
            second, [&](const auto& window) { emitted.push_back(window); });
    CHECK(name, accepted && emitted.size() == 1 &&
                    emitted[0].start.sequence == second.capture.sequence &&
                    emitted[0].resetReason == expected &&
                    emitted[0].resetCount == 1);
  };

  auto hardForward = block(anchorWindow, 1, 512);
  hardForward.capture.sampleHostTimeNs += 20000000;
  checkAnchorBoundary("hard forward host-time jump resets before samples",
                      hardForward, zdsp::DiscontinuityReason::ClockReanchored);
  auto hardBackward = block(anchorWindow, 1, 512);
  hardBackward.capture.sampleHostTimeNs = 999000000;
  checkAnchorBoundary("backward host-time jump resets before samples",
                      hardBackward, zdsp::DiscontinuityReason::ClockReanchored);
  auto qualityBoundary = block(
      anchorWindow, 1, 512, 48000, 7,
      singz::AudioInputTimestampQuality::CallbackEstimate);
  checkAnchorBoundary("timestamp quality transition resets before samples",
                      qualityBoundary,
                      zdsp::DiscontinuityReason::TimestampQualityChanged);
  auto validityBoundary = block(anchorWindow, 1, 512);
  validityBoundary.capture.flags &= ~singz::AudioInputSampleHostTimeValid;
  checkAnchorBoundary("sample-anchor validity transition resets before samples",
                      validityBoundary,
                      zdsp::DiscontinuityReason::ClockReanchored);
  auto staleBoundary = block(anchorWindow, 1, 512);
  staleBoundary.capture.flags |= singz::AudioInputStaleAnchor;
  checkAnchorBoundary("stale-anchor transition resets before samples",
                      staleBoundary,
                      zdsp::DiscontinuityReason::ClockReanchored);

  zdsp::analysis::LiveInputAnalysisAdapter jitterAdapter(302);
  std::vector<zdsp::analysis::AnalysisWindow> jitterWindows;
  const auto jitterSamples = tone(1536, 48000, 512);
  auto jitterSecond = block(jitterSamples, 1, 512);
  jitterSecond.capture.sampleHostTimeNs += 1000000;
  CHECK("bounded host-time jitter stays in one continuity domain",
        jitterAdapter.push(block(anchorPrefix, 0, 0), [&](const auto& window) {
          jitterWindows.push_back(window);
        }) &&
            jitterAdapter.push(jitterSecond, [&](const auto& window) {
              jitterWindows.push_back(window);
            }) &&
            jitterWindows.size() == 1 && jitterWindows[0].resetCount == 0 &&
            jitterWindows[0].resetReason == zdsp::DiscontinuityReason::None);

  const auto verifyPartition = [&](double rate, uint32_t blockFrames,
                                   uint32_t blockCount, const char* name) {
    zdsp::analysis::LiveInputAnalysisAdapter rateAdapter(
        static_cast<uint64_t>(rate));
    std::vector<zdsp::analysis::AnalysisWindow> emitted;
    uint64_t sourceFrame = 0;
    for (uint32_t sequence = 0; sequence < blockCount; ++sequence) {
      auto samples = tone(blockFrames, rate, sourceFrame);
      auto source = block(samples, sequence, sourceFrame, rate);
      if (!rateAdapter.push(source, [&](const auto& window) {
            emitted.push_back(window);
          })) {
        CHECK(name, false);
        return;
      }
      sourceFrame += blockFrames;
    }
    const double analysisRate = std::min(rate, 48000.0);
    const uint64_t expectedEndSource = static_cast<uint64_t>(
        2048.0L * rate / analysisRate);
    const uint64_t expectedEndHost = 1000000000ull + static_cast<uint64_t>(
        2048.0L * 1000000000.0L / analysisRate);
    const bool firstAligned = !emitted.empty() &&
        emitted.front().start.sourceFrame.value == 0 &&
        emitted.front().end.sourceFrame.value == expectedEndSource &&
        emitted.front().start.sampleHostTime.value == 1000000000ull &&
        emitted.front().end.sampleHostTime.value == expectedEndHost &&
        std::fabs(emitted.front().analysis.frequency - 440.0) < 2.0;
    const bool overlapAligned = emitted.size() < 2 ||
        (emitted[1].start.sourceFrame.value ==
             static_cast<uint64_t>(512.0L * rate / analysisRate) &&
         emitted[1].start.sampleHostTime.value ==
             1000000000ull + static_cast<uint64_t>(
                 512.0L * 1000000000.0L / analysisRate));
    CHECK(name, firstAligned && overlapAligned);
  };
  verifyPartition(44100, 960, 4,
                  "44.1 kHz variable 960-frame partition stays aligned");
  verifyPartition(88200, 16384, 1,
                  "88.2 kHz maximum callback resampling stays aligned");
  verifyPartition(96000, 960, 5,
                  "96 kHz variable partition resampling stays aligned");

  adapter.cancel(98);
  auto stillCurrent = block(sine, 16, 10240);
  CHECK("stale cancellation generation cannot cancel current owner",
        adapter.push(stillCurrent,
                     [&](const auto& window) { windows.push_back(window); }));
  const size_t beforeCancel = windows.size();
  adapter.cancel(99);
  CHECK("matching cancellation suppresses stale telemetry",
        !adapter.push(block(sine, 17, 12288),
                      [&](const auto& window) { windows.push_back(window); }) &&
            windows.size() == beforeCancel);

  singz::AudioInputRing ring(2, 128, 77, 88);
  std::vector<float> small(128, 0.2f);
  CHECK("capture ring accepts first two blocks",
        ring.push(small.data(), 128, 10, 20,
                  singz::AudioInputTimestampQuality::Hardware) &&
            ring.push(small.data(), 128, 30, 40,
                      singz::AudioInputTimestampQuality::Hardware));
  CHECK("capture ring drop is bounded", !ring.push(small.data(), 128, 50, 60));
  singz::AudioInputBlockView popped;
  CHECK("first ring metadata is complete",
        ring.peek(popped, 48000) && popped.capture.clockDomainId == 77 &&
            popped.capture.streamGeneration == 88 &&
            popped.capture.sequence == 0 && popped.capture.sourceFrame == 0);
  ring.consume();
  CHECK("second ring block remains ordered", ring.peek(popped, 48000));
  ring.consume();
  CHECK("ring resumes after overrun",
        ring.push(small.data(), 128, 70, 80,
                  singz::AudioInputTimestampQuality::Hardware) &&
            ring.peek(popped, 48000));
  CHECK("first block after overrun carries typed gap and source position",
        popped.capture.sequence == 3 && popped.capture.sourceFrame == 384 &&
            popped.capture.discontinuity ==
                singz::AudioInputDiscontinuityReason::SequenceGap &&
            (popped.capture.flags & singz::AudioInputDiscontinuous) != 0);
  ring.consume();
  CHECK("timestamp-quality transition remains typed",
        ring.push(small.data(), 128, 90, 100,
                  singz::AudioInputTimestampQuality::CallbackEstimate) &&
            ring.peek(popped, 48000) &&
            popped.capture.discontinuity ==
                singz::AudioInputDiscontinuityReason::TimestampQualityChanged &&
            (popped.capture.flags & singz::AudioInputStaleAnchor) != 0);
  ring.consume();
  CHECK("unknown timestamp quality is explicitly invalid",
        ring.push(small.data(), 128, 110, 120,
                  singz::AudioInputTimestampQuality::Unknown) &&
            ring.peek(popped, 48000) &&
            (popped.capture.flags &
             singz::AudioInputTimestampQualityValid) == 0);

  singz::AudioInputRing fallbackRing(8, 512, 89, 90);
  zdsp::analysis::LiveInputAnalysisAdapter fallbackAdapter(505);
  std::vector<zdsp::analysis::AnalysisWindow> fallbackWindows;
  std::vector<singz::AudioInputCaptureMetadata> fallbackMetadata;
  const auto deliverFallback = [&](uint64_t sourceFrame,
                                   singz::AudioInputTimestampQuality quality) {
    const auto samples = tone(512, 48000, sourceFrame);
    const uint64_t sampleHostTime = 1000000000ull +
        sourceFrame * 1000000000ull / 48000ull;
    if (!fallbackRing.push(samples.data(), 512, sampleHostTime,
                           sampleHostTime + 1000000, quality) ||
        !fallbackRing.peek(popped, 48000)) return false;
    fallbackMetadata.push_back(popped.capture);
    const bool accepted = fallbackAdapter.push(
        popped, [&](const auto& window) { fallbackWindows.push_back(window); });
    fallbackRing.consume();
    return accepted;
  };
  CHECK("fallback fixture starts in a clean hardware domain",
        deliverFallback(0, singz::AudioInputTimestampQuality::Hardware) &&
            fallbackAdapter.resets() == 0 &&
            fallbackAdapter.bufferedFrames() == 512);
  CHECK("four callback-estimate blocks accumulate after one entry reset",
        deliverFallback(512,
                        singz::AudioInputTimestampQuality::CallbackEstimate) &&
            fallbackAdapter.resets() == 1 &&
            fallbackAdapter.bufferedFrames() == 512 &&
            deliverFallback(1024,
                            singz::AudioInputTimestampQuality::CallbackEstimate) &&
            deliverFallback(1536,
                            singz::AudioInputTimestampQuality::CallbackEstimate) &&
            deliverFallback(2048,
                            singz::AudioInputTimestampQuality::CallbackEstimate) &&
            fallbackAdapter.resets() == 1 && fallbackWindows.size() == 1);
  CHECK("fallback metadata remains stale and emits one entry boundary",
        fallbackMetadata.size() == 5 &&
            fallbackMetadata[1].discontinuity ==
                singz::AudioInputDiscontinuityReason::TimestampQualityChanged &&
            (fallbackMetadata[1].flags & singz::AudioInputStaleAnchor) != 0 &&
            fallbackMetadata[2].discontinuity ==
                singz::AudioInputDiscontinuityReason::None &&
            fallbackMetadata[3].discontinuity ==
                singz::AudioInputDiscontinuityReason::None &&
            fallbackMetadata[4].discontinuity ==
                singz::AudioInputDiscontinuityReason::None &&
            (fallbackMetadata[2].flags & singz::AudioInputStaleAnchor) != 0 &&
            (fallbackMetadata[3].flags & singz::AudioInputStaleAnchor) != 0 &&
            (fallbackMetadata[4].flags & singz::AudioInputStaleAnchor) != 0 &&
            fallbackWindows[0].start.sequence == 1 &&
            fallbackWindows[0].end.sequence == 4 &&
            (fallbackWindows[0].start.flags &
             zdsp::CaptureTimeStaleAnchor) != 0 &&
            (fallbackWindows[0].end.flags &
             zdsp::CaptureTimeStaleAnchor) != 0 &&
            fallbackWindows[0].resetReason ==
                zdsp::DiscontinuityReason::TimestampQualityChanged &&
            fallbackWindows[0].resetCount == 1);
  CHECK("return to hardware resets exactly once and clears stale",
        deliverFallback(2560, singz::AudioInputTimestampQuality::Hardware) &&
            fallbackAdapter.resets() == 2 &&
            fallbackAdapter.bufferedFrames() == 512 &&
            fallbackMetadata[5].discontinuity ==
                singz::AudioInputDiscontinuityReason::TimestampQualityChanged &&
            (fallbackMetadata[5].flags & singz::AudioInputStaleAnchor) == 0 &&
            deliverFallback(3072, singz::AudioInputTimestampQuality::Hardware) &&
            deliverFallback(3584, singz::AudioInputTimestampQuality::Hardware) &&
            deliverFallback(4096, singz::AudioInputTimestampQuality::Hardware) &&
            fallbackAdapter.resets() == 2 && fallbackWindows.size() == 2 &&
            fallbackMetadata[6].discontinuity ==
                singz::AudioInputDiscontinuityReason::None &&
            fallbackMetadata[7].discontinuity ==
                singz::AudioInputDiscontinuityReason::None &&
            fallbackMetadata[8].discontinuity ==
                singz::AudioInputDiscontinuityReason::None &&
            fallbackWindows[1].start.sequence == 5 &&
            fallbackWindows[1].end.sequence == 8 &&
            (fallbackWindows[1].start.flags &
             zdsp::CaptureTimeStaleAnchor) == 0 &&
            (fallbackWindows[1].end.flags &
             zdsp::CaptureTimeStaleAnchor) == 0 &&
            fallbackWindows[1].resetReason ==
                zdsp::DiscontinuityReason::TimestampQualityChanged &&
            fallbackWindows[1].resetCount == 2);

  singz::AudioInputRing rejectedRing(4, 128, 91, 92);
  std::vector<float> oversize(129, 0.1f);
  CHECK("null callback is rejected",
        !rejectedRing.push(nullptr, 64, 1, 2,
                           singz::AudioInputTimestampQuality::Hardware));
  CHECK("oversize callback is rejected",
        !rejectedRing.push(oversize.data(), 129, 3, 4,
                           singz::AudioInputTimestampQuality::Hardware));
  CHECK("accepted callback after rejections is published",
        rejectedRing.push(small.data(), 128, 5, 6,
                          singz::AudioInputTimestampQuality::Hardware) &&
            rejectedRing.peek(popped, 48000));
  CHECK("rejected callbacks still advance attempted source time",
        popped.capture.sequence == 2 && popped.capture.sourceFrame == 193 &&
            popped.capture.discontinuity ==
                singz::AudioInputDiscontinuityReason::SequenceGap);

  singz::AudioInputRing overflowRing(
      8, 512, 93, 94, std::numeric_limits<uint64_t>::max() - 128);
  zdsp::analysis::LiveInputAnalysisAdapter overflowAdapter(606);
  std::vector<zdsp::analysis::AnalysisWindow> overflowWindows;
  std::vector<singz::AudioInputCaptureMetadata> overflowMetadata;
  const auto deliverOverflow = [&](uint64_t sequence) {
    const auto samples = tone(512, 48000, sequence * 512);
    const uint64_t sampleHostTime =
        2000000000ull + sequence * 512 * 1000000000ull / 48000ull;
    if (!overflowRing.push(samples.data(), 512, sampleHostTime,
                           sampleHostTime + 1000000,
                           singz::AudioInputTimestampQuality::Hardware) ||
        !overflowRing.peek(popped, 48000)) return false;
    overflowMetadata.push_back(popped.capture);
    const bool accepted = overflowAdapter.push(
        popped, [&](const auto& window) { overflowWindows.push_back(window); });
    overflowRing.consume();
    return accepted;
  };
  CHECK("overflow domain accumulates four blocks after one reset",
        deliverOverflow(0) && overflowAdapter.resets() == 1 &&
            overflowAdapter.bufferedFrames() == 512 && deliverOverflow(1) &&
            deliverOverflow(2) && deliverOverflow(3) &&
            overflowAdapter.resets() == 1 && overflowWindows.size() == 1);
  CHECK("source overflow is typed only on valid-to-invalid transition",
        overflowMetadata.size() == 4 &&
            overflowMetadata[0].sequence == 0 &&
            overflowMetadata[0].sourceFrame ==
                std::numeric_limits<uint64_t>::max() - 128 &&
            overflowMetadata[0].discontinuity ==
                singz::AudioInputDiscontinuityReason::SourceFrameOverflow &&
            (overflowMetadata[0].flags &
             singz::AudioInputSourceFrameValid) == 0 &&
            overflowMetadata[1].sequence == 1 &&
            overflowMetadata[1].sourceFrame ==
                std::numeric_limits<uint64_t>::max() &&
            overflowMetadata[1].discontinuity ==
                singz::AudioInputDiscontinuityReason::None &&
            overflowMetadata[2].discontinuity ==
                singz::AudioInputDiscontinuityReason::None &&
            overflowMetadata[3].discontinuity ==
                singz::AudioInputDiscontinuityReason::None &&
            (overflowMetadata[1].flags &
             singz::AudioInputSourceFrameValid) == 0 &&
            (overflowMetadata[2].flags &
             singz::AudioInputSourceFrameValid) == 0 &&
            (overflowMetadata[3].flags &
             singz::AudioInputSourceFrameValid) == 0 &&
            overflowWindows[0].start.sequence == 0 &&
            overflowWindows[0].end.sequence == 3 &&
            overflowWindows[0].start.sourceFrame.value ==
                std::numeric_limits<uint64_t>::max() - 128 &&
            overflowWindows[0].end.sourceFrame.value ==
                std::numeric_limits<uint64_t>::max() &&
            (overflowWindows[0].start.flags &
             zdsp::CaptureTimeSourceFrameValid) == 0 &&
            (overflowWindows[0].end.flags &
             zdsp::CaptureTimeSourceFrameValid) == 0 &&
            overflowWindows[0].resetReason ==
                zdsp::DiscontinuityReason::SourceFrameOverflow &&
            overflowWindows[0].resetCount == 1);

  zdsp::analysis::LiveInputAnalysisAdapter raceAdapter(707);
  const auto raceTone = tone(16384, 48000);
  const auto raceBlock = block(raceTone, 0, 0);
  std::atomic<bool> sinkEntered{false};
  std::atomic<bool> releaseSink{false};
  std::atomic<uint32_t> raceEmissions{0};
  std::thread delivery([&] {
    (void)raceAdapter.push(raceBlock, [&](const auto&) {
      raceEmissions.fetch_add(1, std::memory_order_relaxed);
      sinkEntered.store(true, std::memory_order_release);
      while (!releaseSink.load(std::memory_order_acquire))
        std::this_thread::yield();
    });
  });
  while (!sinkEntered.load(std::memory_order_acquire))
    std::this_thread::yield();
  raceAdapter.cancel(707);
  releaseSink.store(true, std::memory_order_release);
  delivery.join();
  CHECK("stop-vs-delivery cancellation is atomic and suppresses later windows",
        raceEmissions.load(std::memory_order_acquire) == 1 &&
            !raceAdapter.push(raceBlock, [&](const auto&) {
              raceEmissions.fetch_add(1, std::memory_order_relaxed);
            }));

  const auto started = std::chrono::steady_clock::now();
  double checksum = 0;
  for (int iteration = 0; iteration < 20; ++iteration)
    checksum += zdsp::analysis::analyzeLiveInput(
                    sine.data(), sine.size(), 48000).frequency;
  const double averageMs = std::chrono::duration<double, std::milli>(
      std::chrono::steady_clock::now() - started).count() / 20.0;
  std::printf("analysis handoff average: %.3f ms; window: %zu frames; hop: %zu frames; "
              "sanitizer: %s\n",
              averageMs,
              zdsp::analysis::LiveInputAnalysisAdapter::analysisFrames(),
              zdsp::analysis::LiveInputAnalysisAdapter::hopFrames(),
              kSanitizerInstrumented ? "yes" : "no");
  CHECK("fake analyzer fixture produces stable pitch", checksum > 0);
  // Sanitizer wall time is intentionally not a latency result. Strict Release
  // retains the real portable 10 ms gate; sanitizer builds retain the same
  // functional, ownership, and race coverage without weakening that budget.
  if constexpr (!kSanitizerInstrumented)
    CHECK("fake analyzer handoff stays under portable 10 ms budget",
          averageMs < 10.0);
  CHECK("analyzer window latency remains separately declared",
        zdsp::analysis::LiveInputAnalysisAdapter::analysisFrames() == 2048 &&
            zdsp::analysis::LiveInputAnalysisAdapter::hopFrames() == 512);
  const auto preset = zdsp::analysis::vocalTrainingCapturePreset();
  CHECK("capture-only training preset cannot own output",
        preset.levelTap && preset.pitchTap && !preset.outputEnabled);

  if (failures == 0) std::puts("zdsp analysis tests passed");
  return failures == 0 ? 0 : 1;
}

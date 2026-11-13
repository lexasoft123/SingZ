#pragma once
#include <atomic>
#include <cmath>
#include <cstdint>
#include <zcore/device/audio_host_render.h>

namespace singz {
// Diagnostic only: callback-owned history, lock-free scalar publications.
// Positive gaps use hardware presentation timestamps, not control-thread time.
// They quantify supplied timestamp coverage; they do not prove acoustic silence.
struct OutputCallbackDiagnostics {
  static_assert(std::atomic<uint64_t>::is_always_lock_free);
  std::atomic<uint64_t> callbacks{0}, deliveredFrames{0}, periodChanges{0};
  std::atomic<uint64_t> sequenceGaps{0}, timestampChanges{0}, clockChanges{0}, routeChanges{0};
  std::atomic<uint64_t> positiveSampleGapFrames{0}, sampleRegressions{0};
  std::atomic<uint64_t> maxCallbackExcessNs{0}, maxOutputExcessNs{0}, periodOutputExcessNs{0};
  std::atomic<uint64_t> lastFlags{0}, lastFrames{0};
  uint64_t previousCallbackNs{0}, previousOutputNs{0}, expectedOutputFrame{0};
  uint64_t stream{0}, route{0};
  uint32_t previousFrames{0}, periodWindow{0};
  double previousRate{0};
  static uint64_t excess(uint64_t now,uint64_t previous,uint64_t duration) noexcept {
    return now>previous && now-previous>duration ? now-previous-duration : 0;
  }
  static void maximum(std::atomic<uint64_t>& value,uint64_t sample) noexcept {
    if(sample>value.load(std::memory_order_relaxed))value.store(sample,std::memory_order_relaxed);
  }
  void observe(const AudioHostRenderBlock& b) noexcept {
    callbacks.fetch_add(1,std::memory_order_relaxed);deliveredFrames.fetch_add(b.frames,std::memory_order_relaxed);
    lastFlags.store(b.discontinuity,std::memory_order_relaxed);lastFrames.store(b.frames,std::memory_order_relaxed);
    if(b.discontinuity & AudioHostDiscontinuitySequenceGap)sequenceGaps.fetch_add(1,std::memory_order_relaxed);
    if(b.discontinuity & AudioHostDiscontinuityTimestampQualityChanged)timestampChanges.fetch_add(1,std::memory_order_relaxed);
    if(b.discontinuity & AudioHostDiscontinuityClockReanchored)clockChanges.fetch_add(1,std::memory_order_relaxed);
    if(b.discontinuity & AudioHostDiscontinuityRouteChanged)routeChanges.fetch_add(1,std::memory_order_relaxed);
    const bool same=previousFrames && stream==b.streamGeneration && route==b.routeGeneration && previousRate==b.sampleRate;
    if(same && previousRate>=1 && std::isfinite(previousRate)) {
      const auto ns=static_cast<uint64_t>(static_cast<double>(previousFrames)*1.e9/previousRate);
      if(previousFrames!=b.frames){periodChanges.fetch_add(1,std::memory_order_relaxed);periodWindow=4;}
      maximum(maxCallbackExcessNs,excess(b.callbackHostTimeNs,previousCallbackNs,ns));
      if(b.outputTimestampHardware && previousOutputNs) {
        const auto gap=excess(b.outputHostTimeNs,previousOutputNs,ns);
        maximum(maxOutputExcessNs,gap);
        if(periodWindow && gap>1000000)periodOutputExcessNs.fetch_add(gap,std::memory_order_relaxed);
      }
      if(b.outputFrame>expectedOutputFrame)positiveSampleGapFrames.fetch_add(b.outputFrame-expectedOutputFrame,std::memory_order_relaxed);
      else if(b.outputFrame<expectedOutputFrame)sampleRegressions.fetch_add(1,std::memory_order_relaxed);
      if(periodWindow)--periodWindow;
    } else periodWindow=0;
    previousFrames=b.frames;previousRate=b.sampleRate;stream=b.streamGeneration;route=b.routeGeneration;
    previousCallbackNs=b.callbackHostTimeNs;previousOutputNs=b.outputTimestampHardware?b.outputHostTimeNs:0;
    expectedOutputFrame=b.outputFrame+b.frames;
  }
};
struct OutputCallbackDiagnosticSnapshot {
  uint64_t callbacks,deliveredFrames,periodChanges,sequenceGaps,timestampChanges,clockChanges,routeChanges;
  uint64_t positiveSampleGapFrames,sampleRegressions,maxCallbackExcessNs,maxOutputExcessNs,periodOutputExcessNs,lastFlags,lastFrames;
};
inline OutputCallbackDiagnosticSnapshot snapshotOutputCallbacks(const OutputCallbackDiagnostics& d) noexcept {
  return {d.callbacks.load(),d.deliveredFrames.load(),d.periodChanges.load(),d.sequenceGaps.load(),
    d.timestampChanges.load(),d.clockChanges.load(),d.routeChanges.load(),d.positiveSampleGapFrames.load(),
    d.sampleRegressions.load(),d.maxCallbackExcessNs.load(),d.maxOutputExcessNs.load(),d.periodOutputExcessNs.load(),
    d.lastFlags.load(),d.lastFrames.load()};
}
}

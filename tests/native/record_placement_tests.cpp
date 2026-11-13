#include "native/playback/record_placement.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <initializer_list>

using namespace singz;
#define CHECK(x) do { if (!(x)) { std::fprintf(stderr, "%s:%d %s\n", __FILE__, __LINE__, #x); std::abort(); } } while (false)
namespace {
constexpr uint64_t origin = 10000000000;
void append(PlaybackPresentationHistory &h, uint64_t ms, double frame,
            double rate = 1, uint64_t seeks = 0, uint64_t loops = 0, bool nonAffine = false) {
  PlaybackPresentationEntry e;
  e.hostTimeNs = origin + ms * 1000000;
  e.frames = 4800; e.sampleRate = 48000; e.projectFrame = frame; e.rate = rate;
  e.generation = 1; e.seekCount = seeks; e.loopCount = loops; e.nonAffine = nonAffine;
  e.continuousFrame = ms * 48; e.paused = rate == 0;
  CHECK(h.append(e));
}
RecordPlacementInput input(uint64_t captureMs) {
  RecordPlacementInput i;
  i.firstSampleHostNs = origin + captureMs * 1000000;
  i.sampleRate = 48000;
  i.inputLatencyFrames = 480; i.outputLatencyFrames = 960; i.graphLatencyFrames = 1440;
  return i; // 60 ms total wall-time delay, not 60 ms of current song tempo.
}
void steadyAndSign() {
  PlaybackPresentationHistory h;
  append(h, 0, 480000); append(h, 100, 484800);
  // Capture C=150 ms: singing happened at C-I=140 ms; the singer heard
  // material rendered O+G=50 ms earlier, at 90 ms => song position 10.09 s.
  const auto p = recordPlacement(h, input(150));
  CHECK(p.fault == RecordPlacementFault::None);
  CHECK(p.alignedHostNs == origin + 90000000);
  CHECK(std::abs(p.startPositionSec - 10.09) < 1e-12);
  // Independent deliberately-wrong sign: advancing instead of subtracting
  // puts this take 120 ms late. The regression must discriminate that value.
  append(h, 200, 489600);
  const auto wrong = h.query(origin + 210000000);
  CHECK(wrong.found && std::abs(wrong.songSeconds - p.startPositionSec) > .119);
  auto shifted = input(150); shifted.firstSampleHostNs += 10000000;
  CHECK(std::abs(recordPlacement(h, shifted).startPositionSec - p.startPositionSec) > .009);
  // Hardware sample timestamps already compensated for input use zero I.
  auto hardware = input(140); hardware.inputLatencyFrames = 0;
  CHECK(recordPlacement(h, hardware).startPositionSec == p.startPositionSec);
}
void pauseAndRateChange() {
  PlaybackPresentationHistory h;
  append(h, 0, 0); append(h, 100, 4800, 0); append(h, 200, 4800, .85);
  CHECK(std::abs(recordPlacement(h, input(210)).startPositionSec - .1) < 1e-12);
  CHECK(std::abs(recordPlacement(h, input(310)).startPositionSec - .1425) < 1e-12);
  // Capture is after the rate change but its latency-adjusted sample belongs
  // BEFORE it. Subtracting delay at today's .85 rate gives a different answer.
  CHECK(std::abs(recordPlacement(h, input(250)).startPositionSec - .1) < 1e-12);
}
void nonUnityStartupAndLongTake() {
  for (double rate : {.25, .5, 2.0}) {
    PlaybackPresentationHistory h;
    append(h, 0, 720000, rate);
    auto early = input(10); early.inputLatencyFrames = 0;
    early.outputLatencyFrames = 480; early.graphLatencyFrames = 7200;
    // Negative control: first block before graph presentation has no mapping.
    CHECK(recordPlacement(h, early).fault == RecordPlacementFault::HistoryMiss);
    for (unsigned ms = 100; ms <= 300000; ms += 100)
      append(h, ms, 720000 + ms * 48 * rate, rate);
    auto ready = early; ready.firstSampleHostNs = origin + 300050000000ull;
    const auto placed = recordPlacement(h, ready);
    CHECK(placed.fault == RecordPlacementFault::None);
    CHECK(std::abs(placed.startPositionSec - (15 + 299.89 * rate)) < 1e-8);
    // Wrong song-seconds subtraction would remove 160ms at every rate.
    CHECK(std::abs(placed.startPositionSec - (15 + 300.05 * rate - .16)) > .07);
  }
}
void missingAndSeek() {
  PlaybackPresentationHistory h;
  append(h, 100, 4800);
  CHECK(recordPlacement(h, input(150)).fault == RecordPlacementFault::HistoryMiss);
  CHECK(recordPlacement(h, input(400)).fault == RecordPlacementFault::HistoryMiss);
  auto i = input(200); const auto start = recordPlacement(h, i);
  CHECK(start.fault == RecordPlacementFault::None);
  append(h, 200, 96000, 1, 1);
  i = input(310); i.hasInitialDiscontinuitySerial = true;
  i.initialDiscontinuitySerial = start.discontinuitySerial;
  CHECK(recordPlacement(h, i).fault == RecordPlacementFault::SeekDuringTake);
  append(h, 300, 96000, 1, 1, 1, true);
  CHECK(recordPlacement(h, input(410)).fault == RecordPlacementFault::SeekDuringTake);
  i = input(200); i.sampleRate = 0;
  CHECK(recordPlacement(h, i).fault == RecordPlacementFault::ClockUnavailable);
  i = input(200); i.firstSampleHostNs = 0;
  CHECK(recordPlacement(h, i).fault == RecordPlacementFault::ClockUnavailable);
  i = input(200); i.inputLatencyFrames = UINT64_MAX;
  CHECK(recordPlacement(h, i).fault == RecordPlacementFault::ClockUnavailable);
}
}
int main() {
  steadyAndSign(); pauseAndRateChange(); nonUnityStartupAndLongTake(); missingAndSeek();
  std::puts("record placement tests passed");
}

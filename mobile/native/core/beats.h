#pragma once
#include <cstddef>
#include <string>
#include <vector>

#include "analysis.h"

// The beat detector (src/renderer/src/audio/analysis.ts `detectBeats` and the
// courts it calls), ported into the core under the same rules as melody.cpp
// and analysis.cpp: bit-identical to the TypeScript, no stamp moved.
//
// This is the largest of the three detectors by an order of magnitude — the
// TS is ~4300 lines across analysis.ts and courts.ts — and unlike melody and
// key it is ONE pipeline with no exported seams, so a wrong answer cannot be
// bisected from the outside. The port therefore mirrors the TS's own `debug`
// object stage for stage (tau, consistency, fill, octaves, …): the parity
// harness compares those first and the final grid second, so a divergence
// names the stage that caused it instead of just the song.
//
// Landing in pieces, front to back. Present so far: the onset front-end, the
// instrument fill, the tempo family, and the DP tracker's octave choice.
namespace singz {

/** The stamp this file reproduces — analysis.ts's BEAT_DETECT_VERSION. */
constexpr int kBeatDetectVersion = 21;

/** What the TS's `debug` object carries at the stages ported so far. Every
 *  field is one the TS writes under the same name; the harness compares them
 *  by name, so a field added here without a TS counterpart is a bug. */
struct BeatDebug {
  int frames = 0;
  double fluxSum = 0;
  double fluxMean = 0;
  int drumPeaks = 0;
  int peaks = 0;
  // debug.fill — absent when there was nothing to fill with.
  bool fillApplied = false;
  bool fillSkipped = false;
  double fillAlpha = 0, fillDTop = 0, fillITop = 0, fillGSum = 0;
  int fillInstMaxima = 0;
  // debug.tau / debug.consistency
  double tau = 0;
  double consistency = 0;
  int windows = 0;
  // debug.octaves — one row per candidate multiplier that survived the range
  // check, in the TS's order (1, 2, 0.5).
  struct Octave {
    double bpm, support, steadiness, alternation, rough, prior, score;
  };
  std::vector<Octave> octaves;
  double chosenBpm = 0;
  // debug.support / activeFrac / steadiness / rough — the CHOSEN candidate's,
  // which `octaves` cannot express: those rows stay in the TS's mult order
  // (1, 2, 0.5), so a port that picked a different octave would move nothing
  // visible without these.
  double support = 0, activeFrac = 0, steadiness = 0, rough = 0;
  // debug.spanOk — one row per fill span, in span order.
  struct SpanOk {
    int a, b;
    bool ok;
  };
  std::vector<SpanOk> spanOk;
  int beats = 0;      // the lattice's own length, once placed
  double medSec = 0;  // its median interval
  // debug.reject — empty when the tracker did not refuse.
  std::string reject;
};

/** A drum-free span the fill was applied to, in seconds — the caller's cue
 *  that a stretch was carried by other stems (or, when `filled` is false,
 *  that the DP coasted through it and the neural lattice may replace it). */
struct BeatVoid {
  double aSec = 0, bSec = 0;
  bool leading = false, trailing = false, filled = false;
};

/** What `trackFromDrums` hands back: the beat lattice plus the (fill-aware)
 *  meter envelope the downbeat vote reads. */
struct DrumLattice {
  std::vector<double> beatsSec;
  double medSec = 0;
  std::vector<float> O;
  std::vector<BeatVoid> voids;
  bool ok = false;  // false = the TS returned null; dbg.reject says which gate
};

/**
 * The original drums-first pipeline: instrument fill, tempo family and
 * octave, DP placement, span quality gates, onset snap — analysis.ts's
 * `trackFromDrums` entire. Not ok when no steady pulse deserves a metronome.
 *
 * `drums` is the drums stem; `inst` the remaining instrument stems, which
 * serve as fill material only (never as votes) — bass is deliberately not
 * among them, its sustained eighths once octave-doubled a song.
 */
DrumLattice trackFromDrums(const AnalysisStem& drums, const std::vector<AnalysisStem>& inst, BeatDebug& dbg);

}  // namespace singz

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
  // debug.reject — empty when the tracker did not refuse.
  std::string reject;
};

/**
 * The tracker's front half: onset flux from the drums, the instrument fill,
 * the tempo family and the octave choice. Returns false when the TS would
 * have returned null at this point (with `dbg.reject` saying which gate),
 * true with `dbg` filled otherwise.
 *
 * `drums` is the drums stem; `inst` the remaining instrument stems, which
 * serve as fill material only (never as votes) — bass is deliberately not
 * among them, its sustained eighths once octave-doubled a song.
 */
bool trackTempo(const AnalysisStem& drums, const std::vector<AnalysisStem>& inst, BeatDebug& dbg);

}  // namespace singz

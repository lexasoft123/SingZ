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

/** What the TS's `debug` object carries at the stages ported so far. A field
 *  named after a TS one must mean exactly what the TS's does — the harness
 *  compares by name. The four meter figures below are the only additions, and
 *  they are marked as such. */
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
  // The meter/phase pass. `beatsPerBar` is the TS's own; the four below it
  // are NOT — the TS's bar phase is inlined in detectBeats and records no
  // such figures. They exist so the host tests can assert a click train reads
  // 4/4 without needing a library project, and the parity harness compares
  // none of them.
  int beatsPerBar = 0;
  int activeBeats = 0;
  int segments = 0;
  double acAt3 = 0, acAt4 = 0;
  // debug.segCues — one row per segment, in segment order.
  struct SegCue {
    int a, b, rot;
    double conf;
    // debug.segCues[].cues — the six distributions themselves, in the TS's
    // insertion order (kick, ent, slam, bass, voc, line), each bpb long and
    // rounded to 2dp as the TS rounds them. Without these a single cue could
    // diverge while the argmax and the margin both survived, and the harness
    // would see it only much later, as a wrong bar line.
    std::vector<std::vector<double>> cues;
  };
  std::vector<SegCue> segCues;
  // debug.phaseCuts — beat indices where the bar phase was re-cut (empty when
  // no cut survived the global harmonic-gain test, which is the common case).
  std::vector<int> phaseCuts;
  // debug.harmGain — only written when a cut was proposed at all, so the
  // harness must compare "was it written" before comparing the numbers.
  bool hasHarmGain = false;
  double harmGainPlain = 0, harmGainCut = 0;
  // debug.sanitized — only written when sanitizeBars actually changed the count.
  bool hasSanitized = false;
  int sanitizedBefore = 0, sanitizedAfter = 0;
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
  // What the bar-phase pass needs from the tracker's own working state: the
  // low-band flux (the kick), the drum-only onsets (the activity mask — a
  // filled guitar intro is not playing drums), and the frame count.
  std::vector<float> lowFlux;
  std::vector<int> drumPeaks;
  int frames = 0;
  bool ok = false;  // false = the TS returned null; dbg.reject says which gate
};

/** Aux evidence for the downbeat vote — whatever the caller has loaded.
 *  `bass` votes chord changes AND is the chroma the calibrated cue reads;
 *  `inst` doubles as the fill material and as the harmonic layer; `vocals`
 *  votes phrase entries; `lineStarts` are lyric line times in seconds. The
 *  ML lattice is not here: it is not ported, and its absence is the
 *  no-pack path the desktop has always had. */
struct BeatAux {
  const AnalysisStem* bass = nullptr;
  const AnalysisStem* vocals = nullptr;
  // A POINTER, like bass and vocals: by value this deep-copied every stem's
  // samples at the assignment, ~53 MB each on a five-minute song, before the
  // vote had converted anything.
  const std::vector<AnalysisStem>* inst = nullptr;
  std::vector<double> lineStarts;
};

/** What the meter/phase pass works out on top of the lattice. */
struct BarPhase {
  int beatsPerBar = 4;
  int downbeat = 0;
  std::vector<int> downbeats;  // bar starts as beat INDICES (the BeatInfo contract)
  bool ok = false;
};

/**
 * Bar phase and meter over a lattice: the meter test (dominant 3-beat
 * periodicity means the tracked pulse is the eighth of a compound song), the
 * activity mask, the segments, and the per-segment rotation vote — kick
 * energy alone is a coin flip between beats 1 and 3, so sharp musical events
 * decide instead — the phase cuts, and sanitizeBars. Beat TIMES are never
 * touched here: a rotation change leaves the boundary bar an odd length,
 * which is honest, rather than re-spacing beats to force one global phase.
 */
BarPhase barPhase(const DrumLattice& lat, const AnalysisStem& drums, const BeatAux& aux, BeatDebug& dbg);

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

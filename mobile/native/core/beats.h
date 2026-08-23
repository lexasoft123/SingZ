#pragma once
#include <cstddef>
#include <string>
#include <vector>

#include <memory>

#include "analysis.h"
#include "beat_this.h"  // MlGrid — the neural lattice, exactly as beat_this produces it
#include "courts.h"     // the v20 courts, which detectBeats runs as its last stage

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

/** The stamp this file reproduces — analysis.ts's BEAT_DETECT_VERSION.
 *  v22 moved for the desktop's INPUT, not the detector: it now reads stems
 *  from their files at the file's own rate (which this core always did), so
 *  the port itself is unchanged and the parity gates hold across the bump. */
constexpr int kBeatDetectVersion = 23;

/** A drum-free span the fill was applied to, in seconds — the caller's cue
 *  that a stretch was carried by other stems (or, when `filled` is false,
 *  that the DP coasted through it and the neural lattice may replace it). */
struct BeatVoid {
  double aSec = 0, bSec = 0;
  bool leading = false, trailing = false, filled = false;
};

/** What the TS's `debug` object carries at the stages ported so far. A field
 *  named after a TS one must mean exactly what the TS's does — the harness
 *  compares by name. The four meter figures below are the only additions, and
 *  they are marked as such. */
struct BeatDebug {
  int frames = 0;
  /** Which of the tracker's debug groups were actually REACHED. Every field
   *  below defaults to 0, and a printed 0 is indistinguishable from a measured
   *  one — while the TS simply leaves its keys unwritten. Two ways to get
   *  there: the ML fork can return before the tracker entirely (the bare-mix
   *  path, the waltz adoption), and the tracker can refuse part way, which is
   *  why these are per-GROUP rather than one "did it run" — a song that dies
   *  at the flux gate has no tau, and reporting 0 for it puts a number against
   *  the TS's absence and reads as a divergence in the port. Each flag is set
   *  at exactly the line the TS writes its matching key. */
  bool hasTau = false;         // debug.tau, debug.consistency
  bool hasOctaves = false;     // debug.octaves
  bool hasChosen = false;      // debug.support / activeFrac / steadiness / rough
  bool hasLattice = false;     // the tracker got a lattice out (beats, medSec)
  double fluxSum = 0;
  double fluxMean = 0;
  int drumPeaks = 0;
  int peaks = 0;
  // debug.fill — absent when there was nothing to fill with.
  bool fillApplied = false;
  bool fillSkipped = false;
  double fillAlpha = 0, fillDTop = 0, fillITop = 0, fillGSum = 0;
  int fillInstMaxima = 0;
  // debug.octaveTie — the near-tie window and the model's own ambivalence.
  // Written on EVERY drums-path song, even one with no octave candidate at
  // all: the TS writes it before the `if (!chosen) return null` below it.
  bool hasOctaveTie = false;
  double octaveTieWin = 0, octaveTieMlBimodal = 0;
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
  // debug.headWhy — the backcast's verdict. `none` = never reached (the TS
  // leaves the field unset); the other three are its three exit shapes.
  enum class HeadWhy { none, noAnchor, headOk, judged };
  HeadWhy headWhy = HeadWhy::none;
  int headAnchor = 0;
  double headAt = 0, headFirst = 0;
  bool headUnsteady = false, headMissing = false, headOnsetsTrusted = false;
  int headOnsetCount = 0;
  // …and the second half of headWhy, written only once the onset test has
  // been passed — the TS Object.assigns it onto the same object later.
  bool headHasVerdict = false, headTracked = false, headReplace = false;
  bool headWalkEmpty = false;
  // debug.headOnsets — written only when there were >= 3 onsets to grade.
  bool hasHeadOnsets = false;
  double headOnsetsPer = 0;
  int headOnsetsPeriodic = 0, headOnsetsOf = 0;
  std::vector<double> headOnsetsT;
  // debug.headBackcast — written only when the head was actually rebuilt AND
  // the song had bars to re-lay. Testing for THIS is testing for an action:
  // the backcast can rebuild the lattice without writing it, which is why the
  // harness gates on headWhy instead.
  bool hasHeadBackcast = false;
  int headBackcastReplaced = 0, headBackcastAdded = 0, headBackcastSnapped = 0;
  bool headBackcastChords = false;
  // debug.voids — the tracker's own void list, carried out through the debug
  // channel because the grid itself has no place for it.
  std::vector<BeatVoid> voids;
  // debug.reject — empty when the tracker did not refuse.
  std::string reject;

  // ---- the neural lattice's own stages ------------------------------------
  //
  // Each mirrors one key the TS writes onto `debug`, and each carries its own
  // `has` flag: the TS writes these keys CONDITIONALLY, and a zero-valued
  // struct is not the same evidence as an absent one. The harness compares
  // "was it written" before it compares a single number.
  //
  // debug.mlDouble — written whenever the octave test was REACHED (the prior
  // clearly prefers twice this tempo), whether or not it fired.
  bool hasMlDouble = false;
  double mlDoubleBpm0 = 0, mlDoubleGain = 0, mlDoubleMultiLevel = 0;
  bool mlDoubleDoubled = false;
  // debug.mlLattice — the steadiness verdict, written on every grid that got
  // as far as being measured.
  bool hasMlLattice = false;
  double mlLatticeBpm0 = 0, mlLatticeSteadyFrac = 0;
  bool mlLatticeDoubled = false;
  int mlLatticeWins = 0;
  // debug.mlReject — the refusal text; empty = the lattice was accepted (or
  // never offered).
  std::string mlReject;
  // debug.mlNormalized — v17 flattened an adopted lattice onto one level.
  bool hasMlNormalized = false;
  int mlNormalizedFrom = 0, mlNormalizedTo = 0;
  double mlNormalizedMedSec = 0;
  // debug.mlView — the level-matched view the splice family picked.
  bool hasMlView = false;
  double mlViewRatio = 0;
  int mlViewScoreA = 0, mlViewScoreB = 0, mlViewPicked = 0;
  // debug.mlSplice — one row per span the model's beats replaced. `ca`/`cb`
  // are the TS's OPTIONAL bar-carry counts, present only where the per-span
  // parity vote actually ran.
  struct MlSplice {
    double aSec, bSec;
    int removed, added;
    std::string why;
    bool hasCarry = false;
    int ca = 0, cb = 0;
  };
  std::vector<MlSplice> mlSplice;
  // debug.mlSeams — beat indices where a model bar mark of an impossible
  // length cut a segment in two.
  std::vector<int> mlSeams;
  // debug.spanPhase — one row per interior spliced span whose rotation was
  // re-voted by chord mass and the model's downbeat head.
  struct SpanPhase {
    double aSec, bSec, margin;
    int rot;
  };
  std::vector<SpanPhase> spanPhase;
  // debug.lattice — which lattice shipped: "drums", "ml", or "ml-verbatim"
  // (the bare-mix path, which returns before any of the above).
  std::string lattice;

  // debug.v20 — the courts' own record. Always written once they were asked;
  // `abstained` is their answer when there was nothing to testify with.
  bool hasV20 = false;
  CourtsDbg v20;
  // debug.headAfterHalve — the second head backcast, run only on a grid the
  // octave court halved. A whole BeatDebug because that is what the TS puts
  // there (a fresh debug object passed to the same function), and null-vs-empty
  // is the difference between "the halve happened and the head was re-judged"
  // and "no halve" — which is exactly what the harness needs to tell apart.
  std::shared_ptr<BeatDebug> headAfterHalve;
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
 *  votes phrase entries; `lineStarts` are lyric line times in seconds. */
struct BeatAux {
  const AnalysisStem* bass = nullptr;
  const AnalysisStem* vocals = nullptr;
  // A POINTER, like bass and vocals: by value this deep-copied every stem's
  // samples at the assignment, ~53 MB each on a five-minute song, before the
  // vote had converted anything.
  const std::vector<AnalysisStem>* inst = nullptr;
  std::vector<double> lineStarts;
  /** Aligned word times (start, end) in seconds. `detectBeats` itself never
   *  reads them — they are the v20 meter court's witness — but BeatAux is
   *  what the caller fills, so they arrive here like every other stem. */
  std::vector<std::pair<double, double>> words;
  /** The neural beat lattice (Beat This!, from the phone's own beatThis() or
   *  the desktop pack's runner). Null = no model on this device, which is the
   *  homegrown path a packless desktop has always taken and a legitimate grid
   *  at this same detVersion — never an error.
   *
   *  Optionality INSIDE it is by emptiness: the TS's `beatProb?`/`downbeatProb?`
   *  /`fps?` are `undefined` when the producer omitted them, and an empty
   *  vector (or `fps <= 0`) means exactly that here. The one shape this cannot
   *  express is a prob array PRESENT BUT EMPTY — `[]` is truthy in JS, so the
   *  TS would add the `mld` cue at zero mass and divide every segment
   *  confidence by a larger weight sum than this side would. It cannot arise
   *  from beatThis(), and eval/beats-parity.mjs refuses a fixture carrying one
   *  rather than let that difference hide inside a passing run. */
  const MlGrid* ml = nullptr;
};

/** What the ML fork decided, carried forward into the bar-phase pass.
 *  Default-constructed is "no model on this device" — every field then reads
 *  exactly as the TS reads an absent `aux.ml`, so the no-pack path is the
 *  same code with the same answers. */
struct MlPhaseCtx {
  /** The shipping lattice IS the model's own, untransposed. After an octave
   *  doubling the model's bar opinions describe a different level and are
   *  dropped — which is why this is not simply `aux.ml != nullptr`. */
  bool phase = false;
  /** dominantMlBarLen: the model's own modal bar length in beats, or 0 when
   *  no length holds 60% of its bars. */
  int dom = 0;
  /** End (seconds) of an ML-spliced LEADING span; -1 = none. Its bars follow
   *  the model's own marks — backward extension from the band entrance
   *  accents the wrong "1" over an intro at its own tempo. */
  double leadEnd = -1;
  /** Interior spliced spans (seconds). The model repaired their timing, but
   *  their "1" was blind extension from the surrounding anchors, so each gets
   *  a harmonic re-vote. */
  std::vector<std::pair<double, double>> spliceRanges;
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
 * decide instead — and the phase cuts. It does NOT sanitize: the TS runs
 * sanitizeBars after the head backcast, which detectBeats reproduces.
 * Beat TIMES are never touched here: a rotation change leaves the boundary bar an odd length,
 * which is honest, rather than re-spacing beats to force one global phase.
 */
BarPhase barPhase(const DrumLattice& lat, const AnalysisStem& drums, const BeatAux& aux, const MlPhaseCtx& mlc,
                  BeatDebug& dbg);

/** What `backcastHead` hands back. `ok` false = the TS returned null and the
 *  caller keeps the lattice it had. */
struct HeadBackcast {
  std::vector<double> beats;
  std::vector<int> downbeats;
  bool hasDownbeats = false;
  std::vector<double> headBarTimes;
  int indexShift = 0;
  bool ok = false;
};

/** detectBeats' return value: the grid a player draws. */
struct BeatGrid {
  std::vector<double> beats;
  double bpm = 0;
  int beatsPerBar = 4;
  int downbeat = 0;
  std::vector<int> downbeats;
  bool hasDownbeats = false;  // the TS's `undefined`, which [] is NOT
  std::vector<double> suspectAt;
  bool ok = false;  // false = the TS returned null
};

/**
 * analysis.ts's `detectBeats`, end to end and complete: the front-end, the
 * neural lattice's adoption and splices, the drums-first tracker, the bar
 * phase, the head backcast, and the v20 courts.
 *
 * It carried the name `detectBeatsNoCourts` while two stages were missing,
 * with instructions not to rename it until they landed. They have: courts.cpp
 * decides, and the ML fork above is ported. What the caller supplies decides
 * what runs — no `aux.ml` is the packless-desktop path, no harmonic stems is
 * the courts' abstention — and both are grids at this same detVersion, not
 * degraded ones.
 */
BeatGrid detectBeats(const AnalysisStem& drums, const BeatAux& aux, BeatDebug& dbg);

/**
 * The head backcast (analysis.ts's `backcastHead`): count the stable pulse
 * BACKWARD over a lead-in the tracker got wrong or never covered, re-anchoring
 * on the intro's own onsets. A singer keeps counting through material like
 * that; the count does not stop because the drums have not started. Every
 * rebuilt bar line is a principled guess and the caller marks it suspect.
 *
 * `bars` may be null (a song whose structure lives in the rotation index
 * alone). `chordOnsets` is the TS's optional last parameter — empty for the
 * v19 pass, and the halved grid's chord-change times for the courts' second
 * chance, which is the call that needs them: at the notation's octave the
 * lead-in's own chords are what the rebuilt head anchors on.
 */
HeadBackcast backcastHead(const std::vector<double>& beats, const std::vector<int>* bars, int bpb,
                          const std::vector<float>& drumsMono, const BeatAux& aux, BeatDebug& dbg,
                          const std::vector<double>& chordOnsets = {});

/**
 * The original drums-first pipeline: instrument fill, tempo family and
 * octave, DP placement, span quality gates, onset snap — analysis.ts's
 * `trackFromDrums` entire. Not ok when no steady pulse deserves a metronome.
 *
 * `drums` is the drums stem; `aux.inst` the remaining instrument stems, which
 * serve as fill material only (never as votes) — bass is deliberately not
 * among them, its sustained eighths once octave-doubled a song.
 *
 * It takes the whole aux, not just the fill stems, because the octave race
 * reads `aux.ml` too: how wide a "near tie" is depends on whether the MODEL
 * could decide either way (v16). That is the one ML touchpoint inside the
 * tracker, and it is easy to miss from the outside — it decides a whole-song
 * halve or double and leaves no other trace than `debug.octaveTie`.
 */
DrumLattice trackFromDrums(const AnalysisStem& drums, const BeatAux& aux, BeatDebug& dbg);

}  // namespace singz

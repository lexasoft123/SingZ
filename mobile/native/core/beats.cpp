// See beats.h. Section headers name the TS function each block reproduces.
#include "beats.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdlib>
#include <functional>
#include <limits>

// Same no-FMA rule as melody.cpp and analysis.cpp — this file's whole claim
// is "rounds where the TS rounds".
#if defined(__clang__)
#pragma clang fp contract(off)
#elif defined(_MSC_VER)
#pragma fp_contract(off)
#elif defined(__GNUC__)
#pragma GCC optimize("fp-contract=off")
#endif

namespace singz {
namespace {

/** The TS's `[]` for an untrusted snap list — a named empty so the reference
 *  binding below has something with a lifetime. */
const std::vector<double> kNoOnsets;

constexpr double ANALYSIS_SR = 44100;
constexpr int HOP = 512;

inline double jsRound(double x) { return std::floor(x + 0.5); }

/** JS `arr.sort((a,b) => a-b)` then `arr[Math.floor(arr.length * q)]`. */
double quantileOfSorted(const std::vector<double>& sorted, double q) {
  if (sorted.empty()) return 0;
  const size_t i = static_cast<size_t>(std::floor(sorted.size() * q));
  return i < sorted.size() ? sorted[i] : 0;
}

// ---- analysis.ts: normStrength --------------------------------------------
//
// Local-mean normalized onset strength: loud and quiet sections weigh alike.
std::vector<float> normStrength(const std::vector<float>& src, double srcMean, int frames, double fps) {
  std::vector<float> out(static_cast<size_t>(frames));
  const int W = static_cast<int>(jsRound(fps));
  std::vector<double> pref(static_cast<size_t>(frames) + 1, 0.0);
  for (int i = 0; i < frames; i++)
    pref[static_cast<size_t>(i) + 1] = pref[static_cast<size_t>(i)] + static_cast<double>(src[static_cast<size_t>(i)]);
  for (int i = 0; i < frames; i++) {
    const int a = std::max(0, i - W);
    const int b = std::min(frames, i + W);
    const double local = (pref[static_cast<size_t>(b)] - pref[static_cast<size_t>(a)]) / (b - a);
    out[static_cast<size_t>(i)] = static_cast<float>(
        std::min(10.0, static_cast<double>(src[static_cast<size_t>(i)]) / (local * 0.8 + srcMean * 0.2 + 1e-12)));
  }
  return out;
}

/** The TS's `topMean(xs, k)`: mean of the k largest, descending sort. */
double topMean(std::vector<double> xs, size_t k) {
  std::sort(xs.begin(), xs.end(), [](double a, double b) { return a > b; });
  if (xs.size() > k) xs.resize(k);
  if (xs.empty()) return 0;
  double sum = 0;
  for (const double v : xs) sum += v;
  return sum / xs.size();
}

/** The TS's `fold(bpm)`: into [70, 140). */
double fold(double bpm) {
  while (bpm < 70) bpm *= 2;
  while (bpm >= 140) bpm /= 2;
  return bpm;
}

struct Quality {
  double support = 0, activeFrac = 0, steadiness = 0, alternation = 0, rough = 0, med = 0;
};

// ---- detectBeats: the downbeat cues ---------------------------------------

/** analysis.ts's `nearestBeatIdx` — binary search, ties to the earlier beat. */
int nearestBeatIdx(const std::vector<double>& beats, double t) {
  int lo = 0, hi = static_cast<int>(beats.size()) - 1;
  while (lo < hi) {
    const int mid = (lo + hi) >> 1;
    if (beats[static_cast<size_t>(mid)] < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && std::fabs(beats[static_cast<size_t>(lo - 1)] - t) < std::fabs(beats[static_cast<size_t>(lo)] - t))
    lo--;
  return lo;
}

/** Chord-change strength per beat: chroma novelty between consecutive beats,
 *  kept only at gated local maxima and weighted by how pure the new chroma is.
 *  Empty = the TS's null (too little energy, or too few changes, to judge). */
std::vector<double> harmonicChangeVotes(const std::vector<float>& data, const std::vector<double>& beats, int bpb) {
  const double sr = ANALYSIS_SR;
  const size_t nCh = beats.size() > 1 ? beats.size() - 1 : 0;
  std::vector<std::array<double, 12>> chromas(nCh);
  std::vector<double> eng(nCh, 0.0);
  for (size_t k = 0; k < nCh; k++) {
    const double aD = jsRound(beats[k] * sr);
    const double bD = jsRound(beats[k + 1] * sr);
    const size_t a = aD < 0 ? 0 : static_cast<size_t>(aD);
    const size_t b = bD > static_cast<double>(data.size()) ? data.size() : static_cast<size_t>(std::max(0.0, bD));
    std::array<double, 12> ch{};
    ch.fill(0.0);
    double e = 0;
    if (b > a && b - a > 1024) {
      for (int s = 0; s < 36; s++)
        ch[static_cast<size_t>(s % 12)] += goertzelPublic(data, a, b, 41.2 * std::pow(2.0, s / 12.0), sr);
      for (size_t i = a; i < b; i += 4) e += static_cast<double>(data[i]) * static_cast<double>(data[i]);
      e /= static_cast<double>(b - a) / 4.0;
    }
    chromas[k] = ch;
    eng[k] = e;
  }
  std::vector<double> engSorted;
  for (const double x : eng)
    if (x > 0) engSorted.push_back(x);
  std::sort(engSorted.begin(), engSorted.end());
  if (engSorted.size() < static_cast<size_t>(bpb) * 4) return {};
  const double eMed = engSorted[engSorted.size() / 2];
  std::vector<double> nov(nCh, 0.0);
  for (size_t k = 1; k < nCh; k++) {
    if (eng[k] < 0.15 * eMed || eng[k - 1] < 0.15 * eMed) continue;
    double num = 0, dx = 0, dy = 0;
    for (size_t i = 0; i < 12; i++) {
      num += chromas[k][i] * chromas[k - 1][i];
      dx += chromas[k][i] * chromas[k][i];
      dy += chromas[k - 1][i] * chromas[k - 1][i];
    }
    if (dx > 1e-12 && dy > 1e-12) nov[k] = 1 - num / std::sqrt(dx * dy);
  }
  std::vector<double> gated;
  for (const double x : nov)
    if (x > 0) gated.push_back(x);
  std::sort(gated.begin(), gated.end());
  if (gated.size() < static_cast<size_t>(bpb) * 2) return {};
  const double nMed = gated[gated.size() / 2];
  std::vector<double> votes(nCh, 0.0);
  for (size_t k = 1; k + 1 < nov.size(); k++) {
    if (nov[k] > 1.5 * nMed && nov[k] >= nov[k - 1] && nov[k] >= nov[k + 1]) {
      const std::array<double, 12>& ch = chromas[k];
      double tot = 0, mx = 0;
      for (size_t i = 0; i < 12; i++) {
        tot += ch[i];
        if (ch[i] > mx) mx = ch[i];
      }
      votes[k] = nov[k] * (tot > 1e-12 ? mx / tot : 0);
    }
  }
  return votes;
}

struct VocHit {
  int k;
  double w;
};

/** Vocal phrase entries: the loudest moment shortly after each >= 2-bar rest,
 *  when it lands on a beat. `used` false = the TS's null. */
std::vector<VocHit> vocalEntryVotes(const AnalysisStem& vocals, const std::vector<double>& beats, double med, int bpb,
                                    bool& used) {
  used = false;
  const double sr = ANALYSIS_SR;
  const std::vector<float> data = monoAt44kPublic(vocals);
  const double fps = sr / HOP;
  const int n = static_cast<int>(data.size() / HOP);
  if (n <= 0) return {};
  std::vector<float> env(static_cast<size_t>(n), 0.0f);
  for (int i = 0; i < n; i++) {
    double s = 0;
    const size_t off = static_cast<size_t>(i) * HOP;
    for (int j = 0; j < HOP; j += 4) s += static_cast<double>(data[off + j]) * static_cast<double>(data[off + j]);
    env[static_cast<size_t>(i)] = static_cast<float>(s);
  }
  for (int i = 1; i < n; i++)
    env[static_cast<size_t>(i)] = static_cast<float>(0.6 * static_cast<double>(env[static_cast<size_t>(i)]) +
                                                     0.4 * static_cast<double>(env[static_cast<size_t>(i - 1)]));
  std::vector<double> sorted;
  sorted.reserve(static_cast<size_t>(n));
  for (const float x : env) sorted.push_back(static_cast<double>(x));
  std::sort(sorted.begin(), sorted.end());
  const size_t p90i = static_cast<size_t>(std::floor(n * 0.9));
  const double p90 = p90i < sorted.size() ? sorted[p90i] : 0.0;
  if (!(p90 > 0)) return {};
  used = true;
  const double thr = 0.15 * p90;
  const int restF = static_cast<int>(jsRound(2 * bpb * med * fps));
  const double loudest = sorted.back();
  const double denom = loudest != 0 ? loudest : 1.0;
  std::vector<VocHit> hits;
  int below = restF;
  int i = 0;
  while (i < n) {
    if (static_cast<double>(env[static_cast<size_t>(i)]) < thr) {
      below++;
      i++;
      continue;
    }
    if (below >= restF) {
      const int end = std::min(n, i + static_cast<int>(jsRound(1.5 * bpb * med * fps)));
      int best = i;
      for (int j = i; j < end; j++)
        if (env[static_cast<size_t>(j)] > env[static_cast<size_t>(best)]) best = j;
      const double t = (static_cast<double>(best) * HOP) / sr;
      const int bk = nearestBeatIdx(beats, t);
      if (bk >= 0 && std::fabs(beats[static_cast<size_t>(bk)] - t) < 0.35 * med)
        hits.push_back({bk, static_cast<double>(env[static_cast<size_t>(best)]) / denom});
    }
    below = 0;
    i++;
  }
  return hits;
}

/** analysis.ts's `sanitizeBars` — split over-long bars (ceil, not round: at
 *  bpb 6 rounding left 8-beat bars behind), then drop the cheaper side of any
 *  bar under 2 beats. */
std::vector<int> sanitizeBars(const std::vector<int>& downbeats, int bpb, int nBeats) {
  if (downbeats.size() < 3 || bpb < 2) return downbeats;
  std::vector<int> db{downbeats[0]};
  for (size_t i = 1; i < downbeats.size(); i++) {
    const int a = downbeats[i - 1], b = downbeats[i];
    if (b - a > 7) {
      const int n = std::max(2, static_cast<int>(std::ceil(static_cast<double>(b - a) / bpb)));
      for (int k = 1; k < n; k++) {
        const int t = a + k * bpb;
        if (t - db.back() >= 2 && b - t >= 2) db.push_back(t);
      }
    }
    db.push_back(b);
  }
  const auto cost = [&](const std::vector<int>& arr) {
    long long c = 0;
    for (size_t i = 1; i < arr.size(); i++) c += std::llabs(static_cast<long long>(arr[i] - arr[i - 1] - bpb));
    return c;
  };
  for (int guard = 0; guard < 16; guard++) {
    int hit = -1;
    for (size_t i = 1; i < db.size(); i++) {
      if (db[i] - db[i - 1] < 2) {
        hit = static_cast<int>(i);
        break;
      }
    }
    if (hit < 0) break;
    std::vector<int> dropHi, dropLo;
    for (size_t k = 0; k < db.size(); k++) {
      if (static_cast<int>(k) != hit) dropHi.push_back(db[k]);
      if (static_cast<int>(k) != hit - 1) dropLo.push_back(db[k]);
    }
    db = cost(dropHi) <= cost(dropLo) ? dropHi : dropLo;
  }
  std::vector<int> out;
  for (const int k : db)
    if (k >= 0 && k < nBeats) out.push_back(k);
  return out;
}

/**
 * detectBeats' own front-end: the broadband and low-band flux and the
 * drum-only onsets. In the TS this is inlined at the top of detectBeats and
 * its outputs are handed to trackFromDrums; here it is a function because
 * latticeFromMl needs `drumFlux` as well (it normalizes it into the ML
 * lattice's envelope) and the fork between the two happens before either
 * has run. Computing it once is not an optimization — running this pass
 * twice over a five-minute stem is seconds on a phone.
 */
struct DrumFrontEnd {
  std::vector<float> mono;
  int frames = 0;
  double fps = 0;
  std::vector<float> drumFlux;
  std::vector<float> lowFlux;
  std::vector<int> drumPeaks;
  bool ok = false;  // false = the TS's `frames < 400` -> return null
};

DrumFrontEnd drumFrontEnd(const AnalysisStem& drums, BeatDebug& dbg) {
  DrumFrontEnd out;
  const double sr = ANALYSIS_SR;
  const double fps = sr / HOP;
  std::vector<float> mono = monoAt44kPublic(drums);
  const int frames = static_cast<int>(mono.size() / HOP) - 1;
  dbg.frames = frames;
  if (frames < 400) {
    dbg.reject = "too short";
    return out;
  }


  // ---- detectBeats: broadband energy + low band ---------------------------
  //
  // Broadband energy (any onset) + low band (kick — used for the downbeat).
  std::vector<float> energy(static_cast<size_t>(frames), 0.0f);
  std::vector<float> lowEnergy(static_cast<size_t>(frames), 0.0f);
  const double lpA = 1 - std::exp((-2 * M_PI * 150) / (sr / 2));
  double lp = 0;
  for (int i = 0; i < frames; i++) {
    double sum = 0;
    double low = 0;
    const size_t off = static_cast<size_t>(i) * HOP;
    for (int j = 0; j < HOP; j += 2) {
      const double v = mono[off + static_cast<size_t>(j)];
      if (j % 4 == 0) sum += v * v;
      lp += lpA * (v - lp);
      low += lp * lp;
    }
    energy[static_cast<size_t>(i)] = static_cast<float>(sum);
    lowEnergy[static_cast<size_t>(i)] = static_cast<float>(low);
  }
  std::vector<float> drumFlux(static_cast<size_t>(frames), 0.0f);
  std::vector<float> lowFlux(static_cast<size_t>(frames), 0.0f);
  for (int i = 1; i < frames; i++) {
    drumFlux[static_cast<size_t>(i)] = static_cast<float>(
        std::max(0.0, static_cast<double>(energy[static_cast<size_t>(i)]) -
                          static_cast<double>(energy[static_cast<size_t>(i) - 1])));
    lowFlux[static_cast<size_t>(i)] = static_cast<float>(
        std::max(0.0, static_cast<double>(lowEnergy[static_cast<size_t>(i)]) -
                          static_cast<double>(lowEnergy[static_cast<size_t>(i) - 1])));
  }

  // Drum-only onsets — they gate the instrument fill below.
  std::vector<int> drumPeaks;
  {
    double dSum = 0;
    for (int i = 1; i < frames; i++) dSum += static_cast<double>(drumFlux[static_cast<size_t>(i)]);
    const double dMean = dSum / frames;
    const int minSep = static_cast<int>(jsRound(0.12 * fps));
    int last = -minSep;
    for (int i = 2; i < frames - 2; i++) {
      const double f = drumFlux[static_cast<size_t>(i)];
      if (dMean > 0 && f > 4 * dMean && f >= drumFlux[static_cast<size_t>(i) - 1] &&
          f > drumFlux[static_cast<size_t>(i) + 1] && f > drumFlux[static_cast<size_t>(i) - 2] &&
          f > drumFlux[static_cast<size_t>(i) + 2] && i - last >= minSep) {
        drumPeaks.push_back(i);
        last = i;
      }
    }
  }
  dbg.drumPeaks = static_cast<int>(drumPeaks.size());

  out.mono = std::move(mono);
  out.frames = frames;
  out.fps = fps;
  out.drumFlux = std::move(drumFlux);
  out.lowFlux = std::move(lowFlux);
  out.drumPeaks = std::move(drumPeaks);
  out.ok = true;
  return out;
}

// ---- detectBeats: the neural lattice --------------------------------------
//
// analysis.ts's dominantMlBarLen / levelMix / levelNormalize / latticeFromMl.
// These four decide whether the model's grid is usable at all and at which
// level, before anything downstream is allowed to read it.

/** analysis.ts's `dominantMlBarLen`: the model's own modal bar length in
 *  beats, or 0 when no length holds 60% of its bars.
 *
 *  The histogram is a VECTOR in insertion order, not a std::map: the TS reads
 *  a JS Map, whose iteration order is insertion order, and picks its maximum
 *  with a strict `>` — so ties go to the length seen FIRST. Keyed order would
 *  hand them to the smallest length instead, which is a different answer on
 *  any song whose bars split evenly between two readings. */
int dominantMlBarLen(const MlGrid& ml) {
  if (ml.downbeats.size() < 8) return 0;
  std::vector<std::pair<int, int>> hist;  // (barLenInBeats, count), insertion order
  size_t bi = 0;
  int prev = -1;
  for (const double t : ml.downbeats) {
    while (bi < ml.beats.size() && ml.beats[bi] < t - 1e-3) bi++;
    const int b = static_cast<int>(bi);
    if (prev >= 0 && b > prev) {
      const int len = b - prev;
      bool found = false;
      for (auto& e : hist)
        if (e.first == len) {
          e.second++;
          found = true;
          break;
        }
      if (!found) hist.push_back({len, 1});
    }
    if (b > prev) prev = b;
  }
  int dom = 0, domN = 0, total = 0;
  for (const auto& e : hist) {
    total += e.second;
    if (e.second > domN) {
      dom = e.first;
      domN = e.second;
    }
  }
  return total > 0 && static_cast<double>(domN) / total >= 0.6 ? dom : 0;
}

/** The upper median the TS takes everywhere in this stage: `s[s.length >> 1]`
 *  of the SORTED copy, which for an even count is the higher of the two
 *  middles — not their mean. */
double upperMedian(std::vector<double> xs) {
  if (xs.empty()) return 0;
  std::sort(xs.begin(), xs.end());
  return xs[xs.size() >> 1];
}

std::vector<double> intervalsOf(const std::vector<double>& beats) {
  std::vector<double> iv;
  for (size_t i = 1; i < beats.size(); i++) iv.push_back(beats[i] - beats[i - 1]);
  return iv;
}

/** analysis.ts's `levelMix`: how much of a lattice sits at HALF or TWICE its
 *  own modal interval — how often the model changed its mind about the beat
 *  level inside one song. */
double levelMix(const std::vector<double>& beats, double med) {
  if (beats.size() < 24 || !(med > 0)) return 0;
  const std::vector<double> iv = intervalsOf(beats);
  int hit = 0;
  for (const double x : iv)
    if (std::fabs(x - 2 * med) <= 0.3 * med || std::fabs(x - med / 2) <= 0.075 * med) hit++;
  return static_cast<double>(hit) / iv.size();
}

/**
 * analysis.ts's `levelNormalize` (v17): flatten a lattice that runs at more
 * than one level onto its modal one.
 *
 * `sameArray` reports what the TS's caller tests: `adopt` compares the result
 * against the input by OBJECT IDENTITY, so the two early returns (too short,
 * or a thin that left fewer than 16 beats) mean "unchanged" while a thin that
 * happens to reproduce the same times exactly does NOT — it is a new array
 * there, and the caller re-medians and writes debug.mlNormalized. Comparing
 * contents here would silently drop that record on any song where the
 * normalization is a no-op in value but not in identity.
 */
std::vector<double> levelNormalize(const std::vector<double>& beats, double med,
                                   const std::vector<double>* bars, bool& sameArray) {
  sameArray = true;
  const int n = static_cast<int>(beats.size());
  if (n < 8 || !(med > 0)) return beats;
  const auto localIv = [&](int i) {
    const int from = std::max(1, i - 3);
    const int to = std::min(n - 1, i + 3);
    std::vector<double> w;
    for (int k = from; k <= to; k++) w.push_back(beats[static_cast<size_t>(k)] - beats[static_cast<size_t>(k) - 1]);
    // `w[w.length >> 1] ?? med` — the window is empty only when from > to,
    // i.e. n < 2, which the n < 8 guard above has already refused.
    return w.empty() ? med : upperMedian(w);
  };
  const auto barAt = [&](double t) {
    if (!bars) return false;
    for (const double b : *bars)
      if (std::fabs(b - t) <= 0.25 * med) return true;
    return false;
  };
  std::vector<double> out;
  const auto push = [&](double t, bool bar) {
    const double last = out.empty() ? -std::numeric_limits<double>::infinity() : out.back();
    if (t - last >= 0.7 * med) out.push_back(t);
    else if (bar && !out.empty()) out.back() = t;
  };
  for (int i = 0; i < n; i++) {
    if (localIv(i) >= 0.7 * med) push(beats[static_cast<size_t>(i)], true);
    else push(beats[static_cast<size_t>(i)], barAt(beats[static_cast<size_t>(i)]));
  }
  if (out.size() < 16) return beats;
  sameArray = false;
  return out;
}

/** latticeFromMl's return — the TS's `{beatsSec, medSec, O, doubled}` or null. */
struct MlLattice {
  std::vector<double> beatsSec;
  double medSec = 0;
  std::vector<float> O;
  bool doubled = false;
  bool ok = false;
};

/**
 * analysis.ts's `latticeFromMl`: adopt the neural beat lattice when it is
 * usable. Two guards, both from measurement on the library — an octave test
 * against the singable-tempo prior, and a windowed steadiness test that
 * refuses true rubato and hands the decision back to the homegrown tracker.
 */
MlLattice latticeFromMl(const MlGrid* ml, int frames, double fps, const std::vector<float>& drumFlux,
                        BeatDebug& dbg) {
  MlLattice out;
  if (!ml || ml->beats.size() < 16) return out;
  std::vector<double> beats;
  for (const double t : ml->beats) {
    if (!std::isfinite(t) || t < 0) continue;
    if (beats.empty() || t > beats.back() + 1e-3) beats.push_back(t);
  }
  if (beats.size() < 16) return out;
  double med = upperMedian(intervalsOf(beats));
  if (!(med > 0)) return out;
  const auto prior = [](double bpm) {
    const double z = (std::log2(bpm / 105) / 0.6);
    return std::exp(-0.5 * z * z);
  };
  const double bpm0 = 60 / med;
  double dSum = 0;
  for (int i = 1; i < frames; i++) dSum += static_cast<double>(drumFlux[static_cast<size_t>(i)]);
  const std::vector<float> env = normStrength(drumFlux, dSum / frames, frames, fps);
  // v17: a median is only a LEVEL if the model stayed on one. Where it changed
  // its mind mid-song the median describes neither stretch, and doubling it
  // produces a lattice that is wrong everywhere.
  const double multiLevel = levelMix(beats, med);
  const double gain = prior(bpm0 * 2) - prior(bpm0);
  bool doubled = false;
  if (bpm0 * 2 <= 220 && gain > 0.2) {
    dbg.hasMlDouble = true;
    dbg.mlDoubleBpm0 = jsRound(bpm0 * 10) / 10;
    dbg.mlDoubleGain = jsRound(gain * 1000) / 1000;
    dbg.mlDoubleMultiLevel = jsRound(multiLevel * 100) / 100;
    dbg.mlDoubleDoubled = multiLevel < 0.1;
  }
  if (bpm0 * 2 <= 220 && gain > 0.2 && multiLevel < 0.1) {
    std::vector<double> dbl;
    for (size_t i = 0; i < beats.size(); i++) {
      dbl.push_back(beats[i]);
      // subdivide steady gaps only — never bridge a silence with midpoints
      if (i + 1 < beats.size() && beats[i + 1] - beats[i] < 1.8 * med)
        dbl.push_back((beats[i] + beats[i + 1]) / 2);
    }
    beats = std::move(dbl);
    med = med / 2;
    doubled = true;
  }
  const std::vector<double> iv2 = intervalsOf(beats);
  int wins = 0, steady = 0;
  for (size_t s = 0; s + 16 <= iv2.size(); s += 8) {
    const std::vector<double> w(iv2.begin() + static_cast<long>(s), iv2.begin() + static_cast<long>(s) + 16);
    const double wMed = upperMedian(w);
    int okN = 0;
    for (const double x : w)
      if (std::fabs(x - wMed) <= 0.12 * wMed) okN++;
    wins++;
    if (static_cast<double>(okN) / w.size() >= 0.75) steady++;
  }
  const double steadyFrac = wins > 0 ? static_cast<double>(steady) / wins : 0;
  dbg.hasMlLattice = true;
  dbg.mlLatticeBpm0 = jsRound(bpm0 * 10) / 10;
  dbg.mlLatticeDoubled = doubled;
  dbg.mlLatticeSteadyFrac = jsRound(steadyFrac * 100) / 100;
  dbg.mlLatticeWins = wins;
  if (wins < 3 || steadyFrac < 0.55) {
    char buf[64];
    std::snprintf(buf, sizeof buf, "lattice unsteady (%d%% of windows)",
                  static_cast<int>(jsRound(steadyFrac * 100)));
    dbg.mlReject = buf;
    return out;
  }
  out.beatsSec = std::move(beats);
  out.medSec = med;
  out.O = env;
  out.doubled = doubled;
  out.ok = true;
  return out;
}

/** What the splice pass hands the bar-phase stage: the TS's `mlLeadEnd` and
 *  `mlSpliceRanges`, which no later stage can reconstruct. */
struct MlSpliceOut {
  double leadEnd = -1;
  std::vector<std::pair<double, double>> ranges;
};

/**
 * analysis.ts's v11/v12/v13/v15/v16 splice family: where the drums-first
 * lattice has NOTHING (refused voids) or is physically SUSPECT (interval
 * defects), the model's beats replace the stretch.
 *
 * `L` is mutated in place, and WHEN each helper reads it matters — the TS
 * reassigns `L.beatsSec` to a fresh array on every successful splice, so
 * anything holding the old one keeps the old one. Both places that depend on
 * that are marked below.
 *
 * Every gate here was set by measurement on the library; the comments naming
 * songs are the TS's own and are kept because they are the only record of
 * what each threshold is protecting.
 */
void spliceFromMl(DrumLattice& L, const MlLattice& mlChoice, const MlGrid& ml, MlSpliceOut& res,
                  BeatDebug& dbg) {
  const double med = L.medSec;
  const double ratio = med / mlChoice.medSec;
  // Level-matched view of the model lattice. The model sometimes rides our
  // eighths for a WHOLE song (Turn The Page subdivides its bridge and the
  // model stays on eighths throughout, ratio 1.88) — a raw ratio gate would
  // disable every repair for such songs. A halved view — every other model
  // beat, greedily thinned so silence gaps self-heal, parity picked by which
  // one lands on our drum-anchored body — restores level compatibility.
  // Doubling views (model on half notes) are not built: no song has needed
  // one; the adopted-lattice path handles SoF's case.
  std::vector<double> mlB;
  bool haveMlB = false;
  std::vector<double> thinA, thinB;
  bool haveThinViews = false;
  const std::vector<double>* mlBarTimes = nullptr;
  const std::vector<double>& src = mlChoice.beatsSec;
  if (ratio > 0.9 && ratio < 1.1) {
    mlB = mlChoice.beatsSec;
    haveMlB = true;
  } else if (ratio > 1.7 && ratio < 2.3) {
    const auto thin = [&](size_t start) {
      std::vector<double> o;
      for (size_t i = start; i < src.size(); i++)
        if (o.empty() || src[i] - o.back() >= 0.7 * med) o.push_back(src[i]);
      return o;
    };
    const auto score = [&](const std::vector<double>& v) {
      std::vector<double> ds;
      for (size_t i = 0; i < v.size(); i += 4) {
        double best = std::numeric_limits<double>::infinity();
        for (const double t : L.beatsSec) {
          const double d = std::fabs(t - v[i]);
          if (d < best) best = d;
        }
        ds.push_back(best);
      }
      // `ds[ds.length >> 1] ?? Infinity` — an empty view scores worst.
      if (ds.empty()) return std::numeric_limits<double>::infinity();
      std::sort(ds.begin(), ds.end());
      return ds[ds.size() >> 1];
    };
    const std::vector<double> a = thin(0);
    const std::vector<double> b = thin(1);
    const double sa = score(a);
    const double sb = score(b);
    mlB = sa <= sb ? a : b;
    haveMlB = true;
    // v15: parity views for the PER-SPAN choice below. Greedy thin(0)/thin(1)
    // converge onto one subsequence at the first interval anomaly (an
    // ornament, an odd bar) — measured IDENTICAL through Puppe's verse, so
    // they cannot express "the other parity" there. Partition instead by
    // offset from the PRECEDING model bar line: even offsets are the
    // half-rate beat that carries the "1", odd offsets are the off-beat.
    // Re-anchoring at every bar line survives ornaments and odd bars (the
    // phase shift lands exactly at a bar line, where music puts it). The
    // GLOBAL view keeps the greedy thin — its silence-healing matters for
    // whole-song repairs and v13 behavior stays byte-stable.
    const std::vector<double>& dts0 = ml.downbeats;
    if (dts0.size() >= 2) {
      mlBarTimes = &dts0;
      std::vector<double> evenV, oddV;
      const double tolD = 0.25 * mlChoice.medSec;
      int j0 = -1;
      {
        double best = std::numeric_limits<double>::infinity();
        for (size_t i = 0; i < src.size(); i++) {
          const double d = std::fabs(src[i] - dts0[0]);
          if (d < best) {
            best = d;
            j0 = static_cast<int>(i);
          }
        }
        if (best > tolD) j0 = -1;
      }
      /** v16: the model's beat level can change INSIDE one song. Wild World's
       *  model rides 0.39 s eighths through the choruses and 0.78 s quarters
       *  through the verses, all under bars 1.57 s apart — one global "halve
       *  it" then clicks the verses at half tempo (55 s of 1.56 s gaps, which
       *  is what the singer heard). A beat whose own neighbourhood is ALREADY
       *  our interval is not a subdivision of anything: it belongs to both
       *  alternate sets, so whichever one a span picks still clicks at our
       *  rate. */
      const auto localIv = [&](int i) {
        const int from = std::max(1, i - 3);
        const int to = std::min(static_cast<int>(src.size()) - 1, i + 3);
        std::vector<double> w;
        for (int k2 = from; k2 <= to; k2++)
          w.push_back(src[static_cast<size_t>(k2)] - src[static_cast<size_t>(k2) - 1]);
        return w.empty() ? 0.0 : upperMedian(w);  // the TS's `?? 0`, not `?? med`
      };
      size_t di = 0;
      int k = -1;
      for (int i = 0; i < static_cast<int>(src.size()); i++) {
        const double t = src[static_cast<size_t>(i)];
        while (di < dts0.size() && dts0[di] < t - tolD) di++;
        if (di < dts0.size() && std::fabs(dts0[di] - t) <= tolD) {
          k = 0;
          di++;
        } else if (k >= 0) {
          k++;
        }
        // `(j0 - i) % 2` is NEGATIVE in JS for i > j0 and stays negative here
        // — which is the point: only an exact 0 selects the even set.
        const int par = k >= 0 ? k % 2 : (j0 >= 0 ? (j0 - i) % 2 : 0);
        if (localIv(i) > 0.7 * med) {
          evenV.push_back(t);
          oddV.push_back(t);
        } else if (par == 0) {
          evenV.push_back(t);
        } else {
          oddV.push_back(t);
        }
      }
      if (evenV.size() >= 8 && oddV.size() >= 8) {
        thinA = std::move(evenV);
        thinB = std::move(oddV);
        haveThinViews = true;
      }
    }
    dbg.hasMlView = true;
    dbg.mlViewRatio = jsRound(ratio * 100) / 100;
    dbg.mlViewScoreA = static_cast<int>(jsRound(sa * 1000));
    dbg.mlViewScoreB = static_cast<int>(jsRound(sb * 1000));
    dbg.mlViewPicked = sa <= sb ? 0 : 1;
  }
  if (!haveMlB || mlB.size() < 16) return;

  const std::vector<double>& view = mlB;
  /** Fraction of the model's intervals within tol of their own median across
   *  [a,b] — the local "is this a real pulse" gate. */
  const auto steadyOf = [](const std::vector<double>& seg, double tol) {
    if (seg.size() < 5) return 0.0;
    const std::vector<double> iv = intervalsOf(seg);
    const double m = upperMedian(iv);
    int n = 0;
    for (const double x : iv)
      if (std::fabs(x - m) <= tol * m) n++;
    return static_cast<double>(n) / iv.size();
  };
  const auto between = [](const std::vector<double>& xs, double a, double b) {
    std::vector<double> o;
    for (const double t : xs)
      if (t >= a && t <= b) o.push_back(t);
    return o;
  };
  const auto mlSteadyIn = [&](double a, double b, double tol) {
    return steadyOf(between(view, a, b), tol);
  };
  /** Median distance from each of `edges` to its nearest beat in `v`. */
  const auto fitTo = [](const std::vector<double>& v, const std::vector<double>& edges) {
    std::vector<double> ds;
    for (const double e : edges) {
      double m = std::numeric_limits<double>::infinity();
      for (const double t : v) m = std::min(m, std::fabs(t - e));
      ds.push_back(m);
    }
    std::sort(ds.begin(), ds.end());
    return ds.empty() ? std::numeric_limits<double>::quiet_NaN() : ds[ds.size() >> 1];
  };
  /** Local level-matched view for ONE zone. The model's beat level changes
   *  inside a song (v16) — Panzerkampf's model rides steady eighths through
   *  the guitar solo while the song's global ratio is ~1, so no whole-song
   *  thin view exists, the raw view is "steady" at the wrong level, and the
   *  v16 level guard (correctly) refuses the splice — leaving the tracker's
   *  wobble in place: beats snapped onto fill accents, intervals swinging
   *  +-25% between correct downbeats. Thin the zone's own eighths to quarters
   *  with the v15 bar-anchored parity partition; continuity with our surviving
   *  lattice at the zone edges picks the parity. */
  const auto localHalvedView = [&](double aSec, double bSec, std::vector<double>& outView) {
    const std::vector<double> zsrc = between(mlChoice.beatsSec, aSec - 2 * med, bSec + 2 * med);
    if (zsrc.size() < 8) return false;
    const double lm = upperMedian(intervalsOf(zsrc));
    const double r = med / lm;
    // strict scope: only zones whose model is LOCALLY on eighths get a view.
    // A relaxed (output-gated) variant was measured and reverted within the
    // hour: it moved Wanted Dead Or Alive's ear-approved grid — the
    // widened-splice-authority trap, again — while leaving the target seam
    // untouched.
    if (!(r > 1.7 && r < 2.3)) return false;
    const std::vector<double>& dts = ml.downbeats;
    const double tolD = 0.25 * lm;
    const auto localIv = [&](int i) {
      const int from = std::max(1, i - 3);
      const int to = std::min(static_cast<int>(zsrc.size()) - 1, i + 3);
      std::vector<double> w;
      for (int k2 = from; k2 <= to; k2++)
        w.push_back(zsrc[static_cast<size_t>(k2)] - zsrc[static_cast<size_t>(k2) - 1]);
      return w.empty() ? 0.0 : upperMedian(w);
    };
    std::vector<double> evenV, oddV;
    size_t di = 0;
    int k = -1;
    for (int i = 0; i < static_cast<int>(zsrc.size()); i++) {
      const double t = zsrc[static_cast<size_t>(i)];
      while (di < dts.size() && dts[di] < t - tolD) di++;
      if (di < dts.size() && std::fabs(dts[di] - t) <= tolD) {
        k = 0;
        di++;
      } else if (k >= 0) {
        k++;
      }
      const int par = k >= 0 ? k % 2 : i % 2;
      if (localIv(i) > 0.7 * med) {
        evenV.push_back(t);
        oddV.push_back(t);
      } else if (par == 0) {
        evenV.push_back(t);
      } else {
        oddV.push_back(t);
      }
    }
    if (evenV.size() < 4 || oddV.size() < 4) return false;
    // L.beatsSec is read LIVE here: earlier splices in this same pass have
    // already rewritten it, and the edges that pick the parity are whatever
    // survived them.
    std::vector<double> edges = between(L.beatsSec, aSec - 4 * med, aSec);
    for (const double t : L.beatsSec)
      if (t >= bSec && t <= bSec + 4 * med) edges.push_back(t);
    if (edges.empty()) return false;
    const double fa = fitTo(evenV, edges);
    const double fb = fitTo(oddV, edges);
    const std::vector<double>& picked = fa <= fb ? evenV : oddV;
    // Flip seams: the +-3-window level test straddles the quarter->eighth
    // boundary and puts two ADJACENT eighths into both sets, while the correct
    // next beat sits in the other parity. Thin the picked view at our level,
    // then refill each hole the thin leaves from the model's own beats, one
    // med-step at a time — the refill is the dropped duplicate's correct
    // neighbor.
    std::vector<double> thinned;
    for (const double t : picked)
      if (thinned.empty() || t - thinned.back() >= 0.7 * med) thinned.push_back(t);
    std::vector<double> o;
    for (const double t : thinned) {
      while (!o.empty() && t - o.back() >= 1.5 * med) {
        const double want = o.back() + med;
        double best = -1;
        for (const double s2 : zsrc) {
          if (std::fabs(s2 - want) <= 0.25 * med &&
              (best < 0 || std::fabs(s2 - want) < std::fabs(best - want))) {
            best = s2;
          }
        }
        if (best < 0) break;
        o.push_back(best);
      }
      o.push_back(t);
    }
    outView = std::move(o);
    return true;
  };
  /** v15: which alternate set to insert for THIS span. When the surviving
   *  lattice at BOTH span edges agrees with the global view, the body's phase
   *  is continuous across the span and the v13 pick stands — TTP's
   *  ear-approved bridge and solo repairs live here. When the edges DISAGREE
   *  (Puppe free-runs a 43 s verse and re-locks half a beat off at 67 s —
   *  pre-edge and post-edge on opposite parities), continuity cannot decide,
   *  and the model's bar lines do: the alternate set that carries them is the
   *  beat, the other is the off-beat (Puppe's verse clicked 2-and-4 of every
   *  model bar for 34 s — the drift the singer heard). Bar-less spans keep the
   *  global pick. */
  bool haveCarry = false;
  int carryA = 0, carryB = 0;
  const auto viewFor = [&](double aSec, double bSec) -> const std::vector<double>& {
    if (!haveThinViews) return view;
    const double lo = aSec + 0.5 * med;
    const double hi = bSec - 0.5 * med;
    std::vector<double> pre, post;
    for (const double t : L.beatsSec) {
      if (t <= lo && t > lo - 4 * med) pre.push_back(t);
      if (t >= hi && t < hi + 4 * med) post.push_back(t);
    }
    const auto sideOk = [&](const std::vector<double>& v, const std::vector<double>& side) {
      if (side.empty()) return true;  // no evidence = no veto
      return fitTo(v, side) < 0.3 * med;
    };
    if (sideOk(view, pre) && sideOk(view, post)) return view;
    if (!mlBarTimes || mlBarTimes->empty()) return view;
    const double tol = 0.25 * mlChoice.medSec;
    const auto carry = [&](const std::vector<double>& v) {
      int c = 0;
      for (const double d : *mlBarTimes) {
        if (d < aSec || d > bSec) continue;
        double best = std::numeric_limits<double>::infinity();
        for (const double t : v) best = std::min(best, std::fabs(t - d));
        if (best < tol) c++;
      }
      return c;
    };
    carryA = carry(thinA);
    carryB = carry(thinB);
    haveCarry = true;
    if (carryA == carryB) return view;
    return carryA > carryB ? thinA : thinB;
  };
  const auto splice = [&](double aSec, double bSec, const char* why,
                          const std::vector<double>* viewOverride) {
    const double lo = aSec + 0.5 * med;
    const double hi = bSec - 0.5 * med;
    if (hi <= lo) return false;
    const std::vector<double>& chosen = viewOverride ? *viewOverride : viewFor(aSec, bSec);
    std::vector<double> ins;
    for (const double t : chosen)
      if (t > lo && t < hi) ins.push_back(t);
    // the model must have actually tracked the stretch — one it also gave up
    // on keeps the old path
    if (static_cast<double>(ins.size()) < (0.5 * (bSec - aSec)) / med) return false;
    // v16: and it must click at OUR rate. A view sitting at the wrong level
    // passes every steadiness gate — it is perfectly steady at half the tempo
    // — and the count gate above missed Wild World's halved last third by a
    // single beat. Genuine tempo seams stay in (Mr Crowley's 88 bpm intro
    // under a 107 bpm body is 1.22x).
    if (ins.size() >= 3) {
      const double m = upperMedian(intervalsOf(ins));
      if (!(m > 0.6 * med && m < 1.6 * med)) return false;
    }
    const size_t before = L.beatsSec.size();
    std::vector<double> kept;
    for (const double t : L.beatsSec)
      if (t <= lo || t >= hi) kept.push_back(t);
    std::vector<double> merged = kept;
    merged.insert(merged.end(), ins.begin(), ins.end());
    // STABLE: the TS concatenates kept-then-ins and sorts, and JS's sort is
    // stable, so an inserted beat landing on exactly a kept one loses the
    // dedup below to the kept one.
    std::stable_sort(merged.begin(), merged.end());
    std::vector<double> o;
    for (const double t : merged)
      if (o.empty() || t - o.back() >= 0.5 * med) o.push_back(t);
    L.beatsSec = std::move(o);
    BeatDebug::MlSplice row;
    row.aSec = jsRound(aSec * 10) / 10;
    row.bSec = jsRound(bSec * 10) / 10;
    row.removed = static_cast<int>(before - kept.size());
    row.added = static_cast<int>(ins.size());
    row.why = why;
    // The TS spreads `lastCarry ?? {}` here and clears it only on a SUCCESSFUL
    // splice — a refused one leaves the carry counts standing, so the next
    // successful row can inherit the previous span's vote. Faithful on
    // purpose: it is the record the harness compares.
    row.hasCarry = haveCarry;
    row.ca = carryA;
    row.cb = carryB;
    dbg.mlSplice.push_back(std::move(row));
    haveCarry = false;
    return true;
  };

  for (const BeatVoid& v : L.voids) {
    if (v.trailing) continue;
    if (v.leading) {
      // filled leading spans are the proven fill-tracked intros (NEM) —
      // untouched; refused ones splice when the model is strictly steady
      if (!v.filled && mlSteadyIn(v.aSec, v.bSec, 0.15) >= 0.85) {
        splice(v.aSec, v.bSec, "leading", nullptr);
        res.leadEnd = std::max(res.leadEnd, v.bSec);
      }
      continue;
    }
    if (v.filled) {
      // fill-tracked interior spans are usually fine — but TTP's bridge is
      // fill-ACCEPTED yet sits 130-190 ms off the model's pulse. When the
      // model is clearly steady across the span, its beats win.
      if (mlSteadyIn(v.aSec, v.bSec, 0.15) >= 0.85) {
        splice(v.aSec, v.bSec, "void-filled", nullptr);
        res.ranges.push_back({v.aSec, v.bSec});
      }
      continue;
    }
    splice(v.aSec, v.bSec, "void", nullptr);
    res.ranges.push_back({v.aSec, v.bSec});
  }
  std::vector<std::pair<double, double>> zones;
  // A COPY, not a reference: the TS binds `bs` to the array object the voids
  // pass left behind, and `splice` REPLACES L.beatsSec rather than editing it
  // — so the zone list is computed once, off the post-voids lattice, and does
  // not shift under the loop that consumes it.
  const std::vector<double> bs = L.beatsSec;
  for (size_t i = 1; i < bs.size(); i++) {
    const double d = std::fabs(bs[i] - bs[i - 1] - med) / med;
    if (d < 0.2) continue;
    const double a = bs[i] - 8 * med;
    const double b = bs[i] + 8 * med;
    if (!zones.empty() && a <= zones.back().second) zones.back().second = b;
    else zones.push_back({a, b});
  }
  for (const auto& z : zones) {
    if (mlSteadyIn(z.first, z.second, 0.15) >= 0.85 && splice(z.first, z.second, "defect", nullptr))
      continue;
    // The raw view was refused — either unsteady at its own level (a window
    // mixing eighths and quarters) or steady at the WRONG level (the v16 guard
    // inside splice). Both are the same situation seen from different windows:
    // the model subdivides here. A zone-local halved view repairs what the
    // global machinery cannot see.
    std::vector<double> lv;
    if (localHalvedView(z.first, z.second, lv) &&
        steadyOf(between(lv, z.first, z.second), 0.15) >= 0.85) {
      splice(z.first, z.second, "defect-2x", &lv);
    }
  }
}

}  // namespace

namespace {
DrumLattice trackFromDrumsCore(const DrumFrontEnd& fe, const BeatAux& aux, BeatDebug& dbg) {
  static const std::vector<AnalysisStem> kNoInst;
  const std::vector<AnalysisStem>& inst = aux.inst != nullptr ? *aux.inst : kNoInst;
  DrumLattice out;
  const double sr = ANALYSIS_SR;
  const double fps = fe.fps;
  const int frames = fe.frames;
  const std::vector<float>& drumFlux = fe.drumFlux;
  std::vector<float> lowFlux = fe.lowFlux;
  const std::vector<int>& drumPeaks = fe.drumPeaks;
  // ---- trackFromDrums: the instrument fill --------------------------------
  //
  // Where the drums are silent for seconds at a stretch, the other stems'
  // IMPULSIVE onsets carry the pulse (picked intros, breakdowns). Gated by
  // distance to the nearest drum onset — never inside playing drums — and
  // skipped outright when the fill material has no sharp attacks to offer.
  std::vector<float> flux = drumFlux;
  // Drum-free spans (frame units) the fill was applied to — placement is
  // spliced to these, everything outside stays the drums-only path.
  std::vector<std::pair<int, int>> fillSpans;
  if (!inst.empty() && !drumPeaks.empty()) {
    std::vector<float> instFlux(static_cast<size_t>(frames), 0.0f);
    for (const AnalysisStem& fb : inst) {
      const std::vector<float> d = monoAt44kPublic(fb);
      const int fFrames = std::min<int>(frames, static_cast<int>(d.size() / HOP) - 1);
      double prev = 0;
      for (int i = 0; i < fFrames; i++) {
        double sum = 0;
        const size_t off = static_cast<size_t>(i) * HOP;
        for (int j = 0; j < HOP; j += 4) {
          const double v = d[off + static_cast<size_t>(j)];
          sum += v * v;
        }
        if (i > 0)
          instFlux[static_cast<size_t>(i)] = static_cast<float>(
              static_cast<double>(instFlux[static_cast<size_t>(i)]) + std::max(0.0, sum - prev));
        prev = sum;
      }
    }
    double iSum = 0;
    for (int i = 1; i < frames; i++) iSum += static_cast<double>(instFlux[static_cast<size_t>(i)]);
    const double iMean = iSum / frames;
    std::vector<double> instMaxima;
    for (int i = 2; i < frames - 2; i++) {
      const double f = instFlux[static_cast<size_t>(i)];
      if (f > 4 * iMean && f >= instFlux[static_cast<size_t>(i) - 1] && f > instFlux[static_cast<size_t>(i) + 1])
        instMaxima.push_back(f);
    }
    std::vector<double> drumPeakFlux;
    drumPeakFlux.reserve(drumPeaks.size());
    for (const int i : drumPeaks) drumPeakFlux.push_back(drumFlux[static_cast<size_t>(i)]);
    const double dTop = topMean(drumPeakFlux, 32);
    const double iTop = topMean(instMaxima, 32);
    dbg.fillInstMaxima = static_cast<int>(instMaxima.size());
    double gSum = 0;
    if (instMaxima.size() >= 8 && dTop > 0 && iTop > 0) {
      const double alpha = dTop / iTop;
      // Fill only inside DRUM-FREE SPANS of at least 8 s (intros, outros,
      // long breakdowns) — a two-bar break must not attract fill, and the
      // 1 s→2 s ramp keeps span edges gentle. Span edges use a PERMISSIVE
      // presence threshold (1.5x vs the vote-worthy 4x): lightly-drummed
      // verses are drums, not a vacuum.
      std::vector<int> presence;
      {
        double dSum2 = 0;
        for (int i = 1; i < frames; i++) dSum2 += static_cast<double>(drumFlux[static_cast<size_t>(i)]);
        const double dMean2 = dSum2 / frames;
        const int minSep = static_cast<int>(jsRound(0.12 * fps));
        int last = -minSep;
        for (int i = 1; i < frames - 1; i++) {
          const double f = drumFlux[static_cast<size_t>(i)];
          if (dMean2 > 0 && f > 1.5 * dMean2 && f >= drumFlux[static_cast<size_t>(i) - 1] &&
              f > drumFlux[static_cast<size_t>(i) + 1] && i - last >= minSep) {
            presence.push_back(i);
            last = i;
          }
        }
      }
      std::vector<int> edges;
      edges.push_back(-1);
      edges.insert(edges.end(), presence.begin(), presence.end());
      edges.push_back(frames);
      for (size_t e = 1; e < edges.size(); e++)
        if (edges[e] - edges[e - 1] > 8 * fps) fillSpans.push_back({edges[e - 1], edges[e]});
      for (const auto& sp : fillSpans) {
        for (int i = std::max(0, sp.first + 1); i < std::min(frames, sp.second); i++) {
          const double dNear = std::min(i - sp.first, sp.second - i);
          const double g = std::max(0.0, std::min(1.0, (dNear - fps) / fps));
          if (g > 0) {
            flux[static_cast<size_t>(i)] = static_cast<float>(
                static_cast<double>(flux[static_cast<size_t>(i)]) +
                g * alpha * static_cast<double>(instFlux[static_cast<size_t>(i)]));
            gSum += g;
          }
        }
      }
      dbg.fillApplied = true;
      dbg.fillAlpha = alpha;
      dbg.fillDTop = dTop;
      dbg.fillITop = iTop;
      dbg.fillGSum = gSum;
    } else {
      dbg.fillSkipped = true;
    }
  }

  double fluxSum = 0;
  for (int i = 1; i < frames; i++) fluxSum += static_cast<double>(flux[static_cast<size_t>(i)]);
  if (fluxSum <= 1e-9) {
    dbg.reject = "no flux";
    return out;
  }
  const double fluxMean = fluxSum / frames;
  dbg.fluxSum = fluxSum;
  dbg.fluxMean = fluxMean;
  // Beat-like flux is sparse impulses; dense low ripple (pads, noise) can be
  // periodic enough to vote yet must never earn a metronome.
  {
    double peaky = 0;
    for (int i = 1; i < frames; i++)
      if (flux[static_cast<size_t>(i)] > 4 * fluxMean) peaky += static_cast<double>(flux[static_cast<size_t>(i)]);
    if (peaky < 0.3 * fluxSum) {
      dbg.reject = "no impulsive onsets";
      return out;
    }
  }

  // Strong discrete onsets (support gates and the final snap).
  std::vector<int> peaks;
  {
    const int minSep = static_cast<int>(jsRound(0.12 * fps));
    int last = -minSep;
    for (int i = 2; i < frames - 2; i++) {
      const double f = flux[static_cast<size_t>(i)];
      if (f > 4 * fluxMean && f >= flux[static_cast<size_t>(i) - 1] && f > flux[static_cast<size_t>(i) + 1] &&
          f > flux[static_cast<size_t>(i) - 2] && f > flux[static_cast<size_t>(i) + 2] && i - last >= minSep) {
        peaks.push_back(i);
        last = i;
      }
    }
  }
  dbg.peaks = static_cast<int>(peaks.size());
  if (peaks.size() < 24) {
    dbg.reject = "too few onsets (" + std::to_string(peaks.size()) + ")";
    return out;
  }

  // The tempo/octave DECISION reads the drums alone (fill must never re-vote
  // the tempo family); beat PLACEMENT reads the filled envelope.
  const std::vector<float> O = normStrength(flux, fluxMean, frames, fps);
  double drumMeanSum = 0;
  for (int i = 1; i < frames; i++) drumMeanSum += static_cast<double>(drumFlux[static_cast<size_t>(i)]);
  const std::vector<float> Otempo =
      !inst.empty() ? normStrength(drumFlux, drumMeanSum / frames, frames, fps) : O;

  // ---- windowed autocorrelation → one tempo family ------------------------
  const int winF = static_cast<int>(jsRound(20 * fps));
  const int hopF = static_cast<int>(jsRound(10 * fps));
  const int lagMin = static_cast<int>(jsRound((60.0 / 220) * fps));
  const int lagMax = static_cast<int>(jsRound((60.0 / 50) * fps));
  struct Peak {
    double bpm, w;
  };
  std::vector<std::vector<Peak>> windows;
  for (int s = 0; s + winF <= frames || (s == 0 && frames > lagMax * 3); s += hopF) {
    const int e = std::min(frames, s + winF);
    std::vector<double> ac(static_cast<size_t>(lagMax) + 1, 0.0);
    double mean = 0;
    for (int lag = lagMin; lag <= lagMax; lag++) {
      double sum = 0;
      for (int i = s + lag; i < e; i++)
        sum += static_cast<double>(Otempo[static_cast<size_t>(i)]) *
               static_cast<double>(Otempo[static_cast<size_t>(i - lag)]);
      ac[static_cast<size_t>(lag)] = static_cast<float>(sum / std::max(1, e - s - lag));
      mean += ac[static_cast<size_t>(lag)];
    }
    mean /= lagMax - lagMin + 1;
    std::vector<Peak> pk;
    for (int lag = lagMin + 1; lag < lagMax; lag++) {
      const double a0 = ac[static_cast<size_t>(lag) - 1], a1 = ac[static_cast<size_t>(lag)],
                   a2 = ac[static_cast<size_t>(lag) + 1];
      if (a1 > a0 && a1 >= a2 && a1 > mean) {
        const double den = a0 - 2 * a1 + a2;
        const double shift = den != 0 ? std::max(-0.5, std::min(0.5, (0.5 * (a0 - a2)) / den)) : 0;
        pk.push_back({(60 * fps) / (lag + shift), a1 / mean});
      }
    }
    // JS Array.prototype.sort is STABLE (spec since ES2019) — equal weights
    // keep their lag order, and the top-5 slice can depend on it.
    std::stable_sort(pk.begin(), pk.end(), [](const Peak& a, const Peak& b) { return b.w < a.w; });
    if (pk.size() > 5) pk.resize(5);
    windows.push_back(std::move(pk));
    if (e >= frames) break;
  }
  dbg.windows = static_cast<int>(windows.size());
  std::vector<Peak> votes;
  for (const auto& w : windows)
    for (const Peak& p : w) votes.push_back({fold(p.bpm), p.w});
  double family = 0;
  double familyWeight = -1;
  for (const Peak& v : votes) {
    double sum = 0;
    for (const Peak& u : votes) {
      const double r = u.bpm / v.bpm;
      if (r > 0.975 && r < 1.026) sum += u.w;
    }
    if (sum > familyWeight) {
      familyWeight = sum;
      family = v.bpm;
    }
  }
  if (familyWeight <= 0) {
    dbg.reject = "no tempo family";
    return out;
  }
  double num = 0, den = 0;
  for (const Peak& u : votes) {
    const double r = u.bpm / family;
    if (r > 0.975 && r < 1.026) {
      num += u.w * u.bpm;
      den += u.w;
    }
  }
  const double tau = num / den;
  int agreeing = 0;
  for (const auto& w : windows) {
    bool any = false;
    for (const Peak& p : w) {
      const double r = fold(p.bpm) / tau;
      if (r > 0.975 && r < 1.026) {
        any = true;
        break;
      }
    }
    if (any) agreeing++;
  }
  const double consistency = static_cast<double>(agreeing) / std::max<size_t>(1, windows.size());
  dbg.tau = tau;
  dbg.consistency = consistency;
  dbg.hasTau = true;
  if (consistency < 0.6) {
    dbg.reject = "windows disagree on a tempo (rubato?)";
    return out;
  }

  // ---- DP beat placement --------------------------------------------------
  //
  // alpha holds the pulse steady against gallops and section changes while
  // still following slow drift.
  auto track = [&](double bpm, const std::vector<float>& env) {
    const double P = (60 * fps) / bpm;
    const double alpha = 50;
    std::vector<float> score(static_cast<size_t>(frames), 0.0f);
    std::vector<int32_t> bp(static_cast<size_t>(frames), -1);
    const int lo = std::max(1, static_cast<int>(jsRound(P * 0.6)));
    const int hi = static_cast<int>(jsRound(P * 1.6));
    for (int i = 0; i < frames; i++) {
      double bestS = 0;
      int bestJ = -1;
      const int from = std::max(0, i - hi);
      const int to = i - lo;
      for (int j = from; j <= to; j++) {
        const double d = std::log((i - j) / P);
        const double s = static_cast<double>(score[static_cast<size_t>(j)]) - alpha * d * d;
        if (s > bestS) {
          bestS = s;
          bestJ = j;
        }
      }
      score[static_cast<size_t>(i)] =
          static_cast<float>(static_cast<double>(env[static_cast<size_t>(i)]) + bestS);
      bp[static_cast<size_t>(i)] = bestJ;
    }
    int end = frames - 1;
    for (int i = std::max(0, frames - static_cast<int>(jsRound(P * 2))); i < frames; i++)
      if (score[static_cast<size_t>(i)] > score[static_cast<size_t>(end)]) end = i;
    std::vector<double> beats;
    for (int i = end; i >= 0; i = bp[static_cast<size_t>(i)]) {
      beats.push_back(i);
      if (bp[static_cast<size_t>(i)] < 0) break;
    }
    std::reverse(beats.begin(), beats.end());
    return beats;
  };

  // ---- the octave gates ---------------------------------------------------
  auto evaluate = [&](const std::vector<double>& beatsF) {
    Quality q;
    std::vector<double> ivRaw;
    for (size_t i = 1; i < beatsF.size(); i++) ivRaw.push_back(beatsF[i] - beatsF[i - 1]);
    std::vector<double> iv = ivRaw;
    std::sort(iv.begin(), iv.end());
    const double med = iv.empty() ? 1 : (iv[iv.size() / 2] != 0 ? iv[iv.size() / 2] : 1);
    const double tol = std::min(0.045 * fps, med * 0.2);
    // Judged against DRUM onsets only: the tempo octave and the accept/reject
    // gates must be blind to fill onsets, or subdivisions picked in fill
    // spans buy a double-tempo octave its support.
    const std::vector<int>& judge = !drumPeaks.empty() ? drumPeaks : peaks;
    int active = 0, hit = 0;
    size_t pi = 0;
    for (const double b : beatsF) {
      while (pi < judge.size() && judge[pi] < b - med * 0.75) pi++;
      bool near = false, on = false;
      for (size_t k = pi; k < judge.size() && judge[k] <= b + med * 0.75; k++) {
        near = true;
        if (std::fabs(judge[k] - b) < tol) on = true;
      }
      if (near) {
        active++;
        if (on) hit++;
      }
    }
    std::vector<double> dev;
    dev.reserve(iv.size());
    for (const double x : iv) dev.push_back(std::fabs(x - med) / med);
    std::sort(dev.begin(), dev.end());
    const double p90 = quantileOfSorted(dev, 0.9);
    // Local roughness: successive-interval jumps. Median, not a high
    // percentile — fills and section changes make any real song's tail
    // jumpy, so chasing has to be the NORM to disqualify.
    std::vector<double> jumps;
    for (size_t i = 1; i < ivRaw.size(); i++) jumps.push_back(std::fabs(ivRaw[i] - ivRaw[i - 1]) / med);
    std::sort(jumps.begin(), jumps.end());
    const double rough = quantileOfSorted(jumps, 0.5);
    // Alternating strong/weak beats mean this octave is subdividing (hats,
    // gallops): the even/odd onset-strength ratio penalizes it.
    double evenS = 0, oddS = 0;
    for (size_t k = 0; k < beatsF.size(); k++) {
      const int f = static_cast<int>(jsRound(beatsF[k]));
      const double v = f > 0 && f < frames ? Otempo[static_cast<size_t>(f)] : 0;
      if (k % 2 == 0) evenS += v;
      else oddS += v;
    }
    const double hi2 = std::max(evenS, oddS) / std::ceil(beatsF.size() / 2.0);
    const double lo2 = std::min(evenS, oddS) / std::floor(beatsF.size() / 2.0);
    q.support = active > 0 ? static_cast<double>(hit) / active : 0;
    q.activeFrac = !beatsF.empty() ? static_cast<double>(active) / beatsF.size() : 0;
    q.steadiness = 1 / (1 + 5 * p90);
    q.alternation = hi2 > 0 ? lo2 / hi2 : 1;
    q.rough = rough;
    q.med = med;
    return q;
  };

  // Tempo octave: support x steadiness x a gentle singable-tempo prior.
  struct Cand {
    double bpm;
    std::vector<double> beatsF;
    Quality q;
    double score;
  };
  std::vector<Cand> cands;
  for (const double mult : {1.0, 2.0, 0.5}) {
    const double bpm = tau * mult;
    if (bpm < 50 || bpm > 220) continue;
    // Octave SELECTION runs on the drums-only envelope — with identical
    // inputs to the fill-less detector, the chosen octave cannot change.
    std::vector<double> beatsF = track(bpm, Otempo);
    if (beatsF.size() < 24) continue;
    const Quality q = evaluate(beatsF);
    const double prior = std::exp(-0.5 * std::pow(std::log2(bpm / 105) / 0.6, 2));
    const double s = q.support * q.steadiness * (0.5 + 0.5 * prior) * (0.55 + 0.45 * q.alternation);
    const auto r3 = [](double x) { return jsRound(x * 1000) / 1000; };
    dbg.octaves.push_back({jsRound(bpm * 10) / 10, r3(q.support), r3(q.steadiness), r3(q.alternation),
                           r3(q.rough), r3(prior), jsRound(s * 10000) / 10000});
    cands.push_back({bpm, std::move(beatsF), q, s});
  }
  // The TS assigns `debug.octaves` HERE, after the candidate loop and before
  // any of the gates below can refuse — so an empty list is still a WRITTEN
  // one, and only a return above this line leaves the key absent.
  dbg.hasOctaves = true;
  std::stable_sort(cands.begin(), cands.end(), [](const Cand& x, const Cand& y) { return y.score < x.score; });
  // v15: near-ties resolve on acoustic evidence alone. WebAudio and ffmpeg
  // decode the same FLACs a hair apart, and Puppe's octave race measured
  // 0.48% — the SAME code shipped a 117.8 bpm grid from the eval harness and
  // a 58.9 bpm grid from the app. Within a 3% tie the prior is opinion at
  // noise level; support x alternation measured a 2x gap and survives any
  // decoder. The margin must stay well under Sixteen Tons' 11%.
  //
  // v16/v17: how wide "near" is depends on whether the MODEL could decide
  // either way. When a large minority of its intervals sit at half or twice
  // its own modal one, it tracked both levels in one song and is saying, in
  // its own voice, that the race is real — Wild World measures 44% against a
  // library median of 4%. There a 3% window is far too narrow for a race
  // decode noise swings by 8%: the same code shipped 156.6 bpm from the app
  // and 77.4 from the harness. This is the ONLY ML touchpoint inside the
  // tracker and it decides a whole-song octave, so it is worth saying twice:
  // it is not reachable from detectBeats' own ML fork, and nothing but
  // `debug.octaveTie` records that it happened.
  const double mlBimodal = [&]() -> double {
    if (aux.ml == nullptr || aux.ml->beats.size() < 24) return 0.0;
    const std::vector<double>& mb = aux.ml->beats;
    // The RAW lattice, not latticeFromMl's deduped or doubled one: this asks
    // what the model itself did, before anything here reinterpreted it.
    return levelMix(mb, upperMedian(intervalsOf(mb)));
  }();
  const double tieWin = mlBimodal >= 0.25 ? 0.12 : 0.03;
  // Written BEFORE the empty check, where the TS writes it — a song with no
  // candidate at all still records the window it would have used.
  dbg.hasOctaveTie = true;
  dbg.octaveTieWin = tieWin;
  dbg.octaveTieMlBimodal = jsRound(mlBimodal * 100) / 100;
  if (cands.empty()) {
    dbg.reject = "no octave candidate";
    return out;
  }
  size_t chosen = 0;
  if (cands.size() >= 2 && cands[0].score - cands[1].score < tieWin * cands[0].score) {
    const auto acoustic = [](const Cand& c) { return c.q.support * c.q.alternation; };
    chosen = acoustic(cands[1]) > acoustic(cands[0]) ? 1 : 0;
  }
  dbg.chosenBpm = cands[chosen].bpm;
  dbg.hasChosen = true;
  // The chosen candidate's own numbers, as the TS writes them for the WINNER
  // (debug.support/activeFrac/steadiness/rough) — distinct from the
  // per-candidate `octaves` rows, which stay in mult order (1, 2, 0.5) and so
  // never say which one won. Written BEFORE the gates below, where the TS
  // writes them: on a refused song its debug carries these and a mirror that
  // zeroed them would be untrue exactly where the next slice will look.
  dbg.support = cands[chosen].q.support;
  dbg.activeFrac = cands[chosen].q.activeFrac;
  dbg.steadiness = cands[chosen].q.steadiness;
  dbg.rough = cands[chosen].q.rough;
  // Sparse-anchor material (rubato ballads): most tracked beats float free.
  if (cands[chosen].q.activeFrac < 0.2 || cands[chosen].q.support < 0.7) {
    dbg.reject = "beats do not sit on real onsets";
    return out;
  }
  // Onset-chasing (loose timing, no pulse): locally rough inter-beat
  // intervals. Real steady/drifting songs measure <= ~0.025 here; chasing
  // jittery hits measures >= ~0.08 even after the DP smooths it.
  if (cands[chosen].q.rough > 0.05) {
    dbg.reject = "no steady pulse (intervals jump around)";
    return out;
  }

  // ---- PLACEMENT: re-track on the filled envelope, then SPLICE ------------
  //
  // Only beats inside fill spans come from the filled path — the global DP
  // would otherwise bend the path across lightly-drummed verses neighbouring
  // a span (WDOA's early bars drifted ~90 s deep). Outside the spans the
  // drums-only path is kept bit-for-bit.
  std::vector<bool> spanOkOut;
  bool haveSpanOk = false;
  if (!inst.empty() && !fillSpans.empty()) {
    const std::vector<double> placed = track(cands[chosen].bpm, O);
    if (placed.size() >= 24) {
      // Per-span quality gate: a filled span is kept only when its material
      // agrees with the SONG's tempo family — the same autocorrelation test
      // the detector trusts globally. An in-tempo picked intro agrees;
      // material in its own tempo or rubato does not, and the span reverts to
      // the old path rather than force the body tempo onto music that fights
      // it.
      std::vector<bool> spanOk;
      for (const auto& sp : fillSpans) {
        const int len = sp.second - sp.first;
        if (len < lagMax * 3) {
          spanOk.push_back(false);
          continue;
        }
        const int winLen = std::min(len, winF);
        int agree = 0, total = 0;
        for (int ws = sp.first; ws + winLen <= sp.second || ws == sp.first; ws += hopF) {
          const int w0 = std::max(0, ws);  // leading spans start at frame -1
          const int we = std::min(sp.second, w0 + winLen);
          std::vector<double> ac(static_cast<size_t>(lagMax) + 1, 0.0);
          double acMean = 0;
          for (int lag = lagMin; lag <= lagMax; lag++) {
            double sum = 0;
            for (int i = w0 + lag; i < we; i++)
              sum += static_cast<double>(O[static_cast<size_t>(i)]) *
                     static_cast<double>(O[static_cast<size_t>(i - lag)]);
            ac[static_cast<size_t>(lag)] = static_cast<float>(sum / std::max(1, we - w0 - lag));
            acMean += ac[static_cast<size_t>(lag)];
          }
          acMean /= lagMax - lagMin + 1;
          bool okWin = false;
          for (int lag = lagMin + 1; lag < lagMax && !okWin; lag++) {
            const double a0 = ac[static_cast<size_t>(lag) - 1], a1 = ac[static_cast<size_t>(lag)],
                         a2 = ac[static_cast<size_t>(lag) + 1];
            if (a1 > a0 && a1 >= a2 && a1 > acMean) {
              const double r = fold((60 * fps) / lag) / tau;
              if (r > 0.975 && r < 1.026) okWin = true;
            }
          }
          total++;
          if (okWin) agree++;
        }
        if (!(total > 0 && static_cast<double>(agree) / total >= 0.6)) {
          spanOk.push_back(false);
          continue;
        }
        // …and the beats must form a steady pulse AFTER snapping to the
        // material's real onsets — the DP grid itself is smooth by
        // construction; snapping is what exposes free-time playing.
        std::vector<double> inBeats;
        for (const double f : placed)
          if (f > sp.first + 1 && f < sp.second - 1) inBeats.push_back(f);
        if (inBeats.size() < 5) {
          spanOk.push_back(false);
          continue;
        }
        std::vector<double> iv0;
        for (size_t i = 1; i < inBeats.size(); i++) iv0.push_back(inBeats[i] - inBeats[i - 1]);
        std::vector<double> iv0s = iv0;
        std::sort(iv0s.begin(), iv0s.end());
        const double medRaw = iv0s[iv0.size() / 2];
        const double tol = std::min(0.045 * fps, medRaw * 0.2);
        size_t pi = 0;
        std::vector<double> snapped;
        for (const double b : inBeats) {
          while (pi + 1 < peaks.size() && peaks[pi + 1] <= b) pi++;
          double f = b;
          double bestD = tol;
          for (const size_t k : {pi, pi + 1}) {
            if (k < peaks.size() && std::fabs(peaks[k] - b) < bestD) {
              bestD = std::fabs(peaks[k] - b);
              f = peaks[k];
            }
          }
          snapped.push_back(f);
        }
        std::vector<double> iv;
        for (size_t i = 1; i < snapped.size(); i++) iv.push_back(std::max(1.0, snapped[i] - snapped[i - 1]));
        std::vector<double> sorted = iv;
        std::sort(sorted.begin(), sorted.end());
        const double med = sorted[sorted.size() / 2];
        std::vector<double> dev;
        for (const double x : iv) dev.push_back(std::fabs(x - med) / med);
        std::sort(dev.begin(), dev.end());
        spanOk.push_back(dev[static_cast<size_t>(std::floor(dev.size() * 0.9))] <= 0.15);
      }
      for (size_t i = 0; i < fillSpans.size(); i++)
        dbg.spanOk.push_back({fillSpans[i].first, fillSpans[i].second, spanOk[i]});
      spanOkOut = spanOk;
      haveSpanOk = true;
      const auto inKeptSpan = [&](double f) {
        for (size_t i = 0; i < fillSpans.size(); i++)
          if (spanOk[i] && f > fillSpans[i].first + 1 && f < fillSpans[i].second - 1) return true;
        return false;
      };
      if (std::any_of(spanOk.begin(), spanOk.end(), [](bool b) { return b; })) {
        std::vector<double> merged;
        for (const double f : cands[chosen].beatsF)
          if (!inKeptSpan(f)) merged.push_back(f);
        for (const double f : placed)
          if (inKeptSpan(f)) merged.push_back(f);
        std::stable_sort(merged.begin(), merged.end());
        const double minGap = ((60 * fps) / cands[chosen].bpm) * 0.5;
        std::vector<double> spliced;
        for (const double f : merged)
          if (spliced.empty() || f - spliced.back() >= minGap) spliced.push_back(f);
        cands[chosen].beatsF = spliced;
        cands[chosen].q = evaluate(spliced);
      }
      // Rejected spans keep the drums-only path — for a span the old detector
      // never covered (leading silence), those beats simply do not exist.
    }
  }

  // ---- snap each beat to an adjacent strong onset -------------------------
  //
  // The frame grid is ~12 ms coarse; unsnapped beats keep their DP position.
  const double snapTol = std::min(0.045 * fps, cands[chosen].q.med * 0.2);
  std::vector<double> beatsSec;
  {
    size_t pi = 0;
    for (const double b : cands[chosen].beatsF) {
      while (pi + 1 < peaks.size() && peaks[pi + 1] <= b) pi++;
      double f = b;
      double bestD = snapTol;
      for (const size_t k : {pi, pi + 1}) {
        if (k < peaks.size()) {
          const double d = std::fabs(peaks[k] - b);
          if (d < bestD) {
            bestD = d;
            f = peaks[k];
          }
        }
      }
      beatsSec.push_back((f * HOP) / sr);
    }
  }
  for (size_t i = 1; i < beatsSec.size(); i++)
    if (beatsSec[i] <= beatsSec[i - 1]) beatsSec[i] = beatsSec[i - 1] + 0.001;

  std::vector<double> ivSec;
  for (size_t i = 1; i < beatsSec.size(); i++) ivSec.push_back(beatsSec[i] - beatsSec[i - 1]);
  std::sort(ivSec.begin(), ivSec.end());
  const double medSec = ivSec.empty() ? 0 : ivSec[ivSec.size() / 2];

  for (size_t i = 0; i < fillSpans.size(); i++) {
    BeatVoid v;
    v.aSec = (std::max(0, fillSpans[i].first + 1) * static_cast<double>(HOP)) / sr;
    v.bSec = (std::min(frames, fillSpans[i].second) * static_cast<double>(HOP)) / sr;
    v.leading = fillSpans[i].first < 0;
    v.trailing = fillSpans[i].second >= frames;
    v.filled = haveSpanOk ? spanOkOut[i] : false;
    out.voids.push_back(v);
  }
  out.beatsSec = std::move(beatsSec);
  out.medSec = medSec;
  out.O = O;
  out.lowFlux = std::move(lowFlux);
  out.drumPeaks = drumPeaks;
  out.frames = frames;
  out.ok = true;
  dbg.beats = static_cast<int>(out.beatsSec.size());
  dbg.medSec = medSec;
  dbg.hasLattice = true;
  return out;
}

}  // namespace

DrumLattice trackFromDrums(const AnalysisStem& drums, const BeatAux& aux, BeatDebug& dbg) {
  const DrumFrontEnd fe = drumFrontEnd(drums, dbg);
  if (!fe.ok) return DrumLattice();
  return trackFromDrumsCore(fe, aux, dbg);
}

// ---- detectBeats: bar phase & meter ---------------------------------------
//
// Kick energy alone is a coin flip between beats 1 and 3 (both carry kick in
// most grooves), so bar rotation is voted by sharp musical events instead.
// Beat TIMES are never touched by phase logic. This pass so far: the activity
// mask, the kick-energy-per-beat, the meter test and the segments — the vote
// itself is the next slice.
BarPhase barPhase(const DrumLattice& lat, const AnalysisStem& drums, const BeatAux& aux, const MlPhaseCtx& mlc,
                  BeatDebug& dbg) {
  (void)drums;
  BarPhase out;
  if (!lat.ok || lat.beatsSec.empty()) return out;
  const double sr = ANALYSIS_SR;
  const double fps = sr / HOP;
  const int frames = lat.frames;
  const std::vector<double>& beatsSec = lat.beatsSec;
  const double medSec = lat.medSec;

  std::vector<int> beatFrames;
  beatFrames.reserve(beatsSec.size());
  for (const double b : beatsSec) beatFrames.push_back(static_cast<int>(jsRound((b * sr) / HOP)));

  std::vector<bool> active(beatsSec.size(), false);
  {
    size_t pi = 0;
    const double tol = 0.3 * medSec * fps;
    for (size_t k = 0; k < beatsSec.size(); k++) {
      while (pi < lat.drumPeaks.size() && lat.drumPeaks[pi] < beatFrames[k] - tol) pi++;
      if (pi < lat.drumPeaks.size() && std::fabs(lat.drumPeaks[pi] - beatFrames[k]) < tol) active[k] = true;
    }
  }
  std::vector<double> kickE(beatsSec.size(), 0.0);
  for (size_t k = 0; k < beatsSec.size(); k++) {
    const int w = std::max(1, static_cast<int>(jsRound(0.035 * fps)));
    double s = 0;
    for (int f = std::max(1, beatFrames[k] - w); f <= std::min(frames - 1, beatFrames[k] + w); f++)
      s += static_cast<double>(lat.lowFlux[static_cast<size_t>(f)]);
    kickE[k] = s;
  }

  // Meter: dominant 3-beat periodicity means the tracked pulse is the eighth
  // of a compound (6/8) song — accents then group in 6, not 4. Each multiple
  // takes the best lag in a small window: the median period is a fraction of
  // a frame off, and by x4 that lands between sharp onset peaks.
  const auto acAt = [&](double mult) {
    const double center = medSec * mult * fps;
    double best = 0;
    for (int lag = static_cast<int>(std::floor(center)) - 3; lag <= static_cast<int>(std::ceil(center)) + 3; lag++) {
      if (lag < 1 || lag >= frames - 1) continue;
      double s = 0;
      for (int i = lag; i < frames; i++)
        s += static_cast<double>(lat.O[static_cast<size_t>(i)]) *
             static_cast<double>(lat.O[static_cast<size_t>(i - lag)]);
      best = std::max(best, s / (frames - lag));
    }
    return best;
  };
  const double ac3 = acAt(3), ac4 = acAt(4);
  dbg.acAt3 = ac3;
  dbg.acAt4 = ac4;
  int activeN = 0;
  for (const bool a : active)
    if (a) activeN++;
  dbg.activeBeats = activeN;
  const int bpb = [&] {
    // Waltz: the model's own bars are 3 beats with real dominance — a meter
    // the drums-first autocorrelation test cannot even emit (it knows 4 and
    // 6). Ballroom 3/4 signature: 0.000 without this, 0.99 with.
    if (mlc.phase && mlc.dom == 3) return 3;
    if (static_cast<double>(activeN) / std::max<size_t>(1, active.size()) >= 0.3 || !mlc.phase || !aux.ml)
      return ac3 > 1.5 * ac4 ? 6 : 4;
    // Too little drumming for the autocorrelation meter test (the envelope is
    // bleed) — count the model's own bars instead: dominant bar length,
    // clamped to meters the app renders. This is the drumless-waltz path;
    // every drummed song keeps the proven test above.
    std::vector<std::pair<int, int>> hist;  // (barLen, count) in INSERTION order
    int prev = -1;
    for (const double t : aux.ml->downbeats) {
      const int i = nearestBeatIdx(beatsSec, t);
      if (i > prev) {
        if (prev >= 0) {
          const int len = i - prev;
          bool found = false;
          for (auto& e : hist)
            if (e.first == len) {
              e.second++;
              found = true;
              break;
            }
          if (!found) hist.push_back({len, 1});
        }
        prev = i;
      }
    }
    // The TS sorts the Map's entries by count descending and takes the first.
    // JS's sort is stable and a Map yields insertion order, so a tie goes to
    // the bar length seen FIRST — stable_sort over the insertion-ordered
    // vector is the only arrangement that reproduces that.
    std::stable_sort(hist.begin(), hist.end(),
                     [](const std::pair<int, int>& x, const std::pair<int, int>& y) { return x.second > y.second; });
    const int dom = hist.empty() ? 0 : hist[0].first;
    return dom == 3 || dom == 4 || dom == 6 ? dom : 4;
  }();
  dbg.beatsPerBar = bpb;

  // Segments: maximal active stretches split by gaps of >= 2 bars.
  std::vector<std::pair<int, int>> segs;
  {
    const int gapLen = 2 * bpb;
    const int n = static_cast<int>(beatsSec.size());
    int i = 0;
    while (i < n) {
      if (!active[static_cast<size_t>(i)]) {
        i++;
        continue;
      }
      int j = i, lastAct = i;
      while (j < n) {
        if (active[static_cast<size_t>(j)]) lastAct = j;
        else if (j - lastAct >= gapLen) break;
        j++;
      }
      segs.push_back({i, lastAct});
      i = lastAct + 1;
      while (i < n && !active[static_cast<size_t>(i)]) i++;
    }
  }
  // ML lattices occasionally insert or drop a beat MUSICALLY — a push, a fill
  // (NEM hides one mid-song; Zeit has a dozen) — leaving no interval defect,
  // but flipping every index class downstream, and one rotation per segment
  // cannot hold across the flip. The model's own bar marks expose these seams:
  // a bar whose length is neither the meter nor its half (half-bar marks are
  // its normal habit) is a lattice hiccup — cut the segment there so each side
  // votes its own rotation; the seam bar simply comes out an odd length,
  // exactly like a fermata bar.
  if (mlc.phase && aux.ml) {
    std::vector<int> seams;
    int prev = -1;
    for (const double t : aux.ml->downbeats) {
      const int i = nearestBeatIdx(beatsSec, t);
      if (i <= prev) continue;
      if (prev >= 0) {
        const int len = i - prev;
        const bool normal = len == bpb || (bpb % 2 == 0 && len == bpb / 2);
        if (!normal) seams.push_back(i);
      }
      prev = i;
    }
    if (!seams.empty()) {
      std::vector<std::pair<int, int>> cutSegs;
      for (const auto& sg : segs) {
        int a = sg.first;
        for (const int c : seams) {
          if (c > a && c <= sg.second) {
            cutSegs.push_back({a, c - 1});
            a = c;
          }
        }
        cutSegs.push_back({a, sg.second});
      }
      segs.clear();
      for (const auto& sg : cutSegs)
        if (sg.second > sg.first) segs.push_back(sg);
      dbg.mlSeams = std::move(seams);
    }
  }
  dbg.segments = static_cast<int>(segs.size());

  // ---- the cues -----------------------------------------------------------
  //
  // Chord changes are downbeat evidence wherever ANY harmonic instrument plays
  // them (the organ that carries Mr Crowley lives in `other`, not bass), so the
  // slip-detection windows read the SUM of every harmonic stem. The segment
  // vote keeps the calibrated bass-only chroma — walking bass and comping churn
  // were tuned around it.
  //
  // Never all at once: the TS can keep every converted stem because its
  // monoAt44k hands back a mono buffer's own channel data, where this side
  // must copy — four stems of a five-minute song is ~210 MB, on a queue that
  // may run beside a player holding the same song. Each is converted, added
  // and dropped, in the TS's own order (bass, then each inst, each ascending),
  // so the float-per-add rounding is untouched. Same fix, same reason, as
  // estimateKeyFromStems.
  static const std::vector<AnalysisStem> kNoInst;
  const std::vector<AnalysisStem>& instStems = aux.inst ? *aux.inst : kNoInst;
  const size_t nHarm = (aux.bass ? 1 : 0) + instStems.size();
  // The bass conversion is used twice (its own calibrated vote, and the sum),
  // so it alone is kept — the TS reuses one array there for the same reason.
  std::vector<float> bassMono;
  if (aux.bass) bassMono = monoAt44kPublic(*aux.bass);
  std::vector<double> bassNov;
  bool hasBassNov = false;
  if (aux.bass) {
    bassNov = harmonicChangeVotes(bassMono, beatsSec, bpb);
    hasBassNov = !bassNov.empty();
  }
  std::vector<double> harmNov;
  bool hasHarmNov = false;
  if (nHarm > 1) {
    size_t hLen = aux.bass ? bassMono.size() : 0;
    for (const AnalysisStem& fb : instStems) hLen = std::max(hLen, resampledLengthPublic(fb));
    std::vector<float> harmData(hLen, 0.0f);
    // Bounded by the ARRAY, not by resampledLength's prediction of it — the
    // failure mode of a prediction that came in low is a heap overwrite.
    const auto addInto = [&](const std::vector<float>& d) {
      const size_t nAdd = std::min(d.size(), harmData.size());
      for (size_t i = 0; i < nAdd; i++)
        harmData[i] = static_cast<float>(static_cast<double>(harmData[i]) + static_cast<double>(d[i]));
    };
    if (aux.bass) addInto(bassMono);
    for (const AnalysisStem& fb : instStems) {
      const std::vector<float> p = monoAt44kPublic(fb);
      addInto(p);
    }
    harmNov = harmonicChangeVotes(harmData, beatsSec, bpb);
    hasHarmNov = !harmNov.empty();
  } else {
    harmNov = bassNov;
    hasHarmNov = hasBassNov;
  }
  bassMono.clear();
  bassMono.shrink_to_fit();
  std::vector<VocHit> vocHits;
  bool hasVoc = false;
  if (aux.vocals) vocHits = vocalEntryVotes(*aux.vocals, beatsSec, medSec, bpb, hasVoc);
  // Neural downbeat head sampled on the lattice — only when the lattice is the
  // model's OWN and untransposed: after an octave doubling its bar opinions
  // describe a different level and are dropped.
  std::vector<double> mlDownE;
  const bool hasMlDownE = mlc.phase && aux.ml && !aux.ml->downbeatProb.empty() && aux.ml->fps > 0;
  if (hasMlDownE) {
    const std::vector<double>& p = aux.ml->downbeatProb;
    for (const double t : beatsSec) {
      const int f = static_cast<int>(jsRound(t * aux.ml->fps));
      double best = 0;
      for (const int g : {f - 1, f, f + 1})
        if (g >= 0 && g < static_cast<int>(p.size()) && p[static_cast<size_t>(g)] > best)
          best = p[static_cast<size_t>(g)];
      mlDownE.push_back(best);
    }
  }
  std::vector<int> lineHits;
  if (aux.lineStarts.size() >= 6) {
    for (const double t : aux.lineStarts) {
      const int bk = nearestBeatIdx(beatsSec, t);
      if (bk >= 0 && std::fabs(beatsSec[static_cast<size_t>(bk)] - t) < 0.2 * medSec) lineHits.push_back(bk);
    }
  }

  double kickMax = 1e-12;
  for (const double x : kickE) kickMax = std::max(kickMax, x);

  const int nb = static_cast<int>(beatsSec.size());
  const auto uniform = [&]() { return std::vector<double>(static_cast<size_t>(bpb), 1.0 / bpb); };
  const auto normDist = [&](const std::vector<double>& a) {
    double s = 0;
    for (const double x : a) s += x;
    if (!(s > 1e-12)) return uniform();
    std::vector<double> out(a.size());
    for (size_t i = 0; i < a.size(); i++) out[i] = a[i] / s;
    return out;
  };

  struct Scored {
    int a, b, rot;
    double conf;
    std::vector<std::vector<double>> cues;
  };
  const auto scoreSegment = [&](int a, int b) {
    const size_t B = static_cast<size_t>(bpb);
    const std::vector<double> kick = [&] {
      std::vector<double> sums(B, 0.0);
      std::vector<int> ns(B, 0);
      for (int k = a; k <= b; k++) {
        if (!active[static_cast<size_t>(k)]) continue;
        sums[static_cast<size_t>(k % bpb)] += kickE[static_cast<size_t>(k)];
        ns[static_cast<size_t>(k % bpb)]++;
      }
      int over = 0;
      for (const int n : ns)
        if (n > 2) over++;
      if (over < bpb) return uniform();
      std::vector<double> avg(B);
      for (size_t i = 0; i < B; i++) avg[i] = ns[i] ? sums[i] / ns[i] : 0.0;
      return normDist(avg);
    }();
    // the heaviest hit in the segment's first bar — only when it truly enters
    // out of silence (a real intro also counts at the track edge)
    const std::vector<double> ent = [&] {
      int quiet = 0;
      for (int j = a - 1; j >= 0 && !active[static_cast<size_t>(j)]; j--) quiet++;
      const bool edge = a - quiet == 0;
      if (quiet < bpb || (edge && quiet < 2 * bpb)) return uniform();
      int best = a, nAct = 0;
      for (int j = a; j < std::min(nb, a + bpb); j++) {
        if (active[static_cast<size_t>(j)]) nAct++;
        if (kickE[static_cast<size_t>(j)] > kickE[static_cast<size_t>(best)]) best = j;
      }
      if (nAct < 2 || kickE[static_cast<size_t>(best)] < 0.2 * kickMax) return uniform();
      std::vector<double> votes(B, 0.0);
      votes[static_cast<size_t>(best % bpb)] = 1;
      return votes;
    }();
    const std::vector<double> slam = [&] {
      std::vector<int> idx;
      for (int k = a; k <= b; k++)
        if (active[static_cast<size_t>(k)]) idx.push_back(k);
      // JS sort is stable (ES2019), and equal kick energies are common in
      // quiet stretches, so ties must keep ascending index order.
      std::stable_sort(idx.begin(), idx.end(),
                       [&](int x, int y) { return kickE[static_cast<size_t>(y)] < kickE[static_cast<size_t>(x)]; });
      std::vector<double> votes(B, 0.0);
      std::vector<int> taken;
      for (const int k : idx) {
        if (taken.size() >= 6) break;
        bool near = false;
        for (const int t : taken)
          if (std::abs(t - k) < 2 * bpb) near = true;
        if (near) continue;
        taken.push_back(k);
        votes[static_cast<size_t>(k % bpb)] += kickE[static_cast<size_t>(k)] / kickMax;
      }
      if (taken.size() < 3) return uniform();
      return normDist(votes);
    }();
    const auto inSeg = [&](const std::vector<std::pair<int, double>>& events, int minN) {
      std::vector<double> dist(B, 0.0);
      int used = 0;
      for (const auto& e : events) {
        if (e.first >= a && e.first <= b) {
          dist[static_cast<size_t>(e.first % bpb)] += e.second;
          used++;
        }
      }
      return used < minN ? uniform() : normDist(dist);
    };
    std::vector<double> bass;
    if (hasBassNov) {
      std::vector<std::pair<int, double>> ev;
      for (size_t k = 0; k < bassNov.size(); k++)
        if (bassNov[k] > 0) ev.push_back({static_cast<int>(k), bassNov[k]});
      bass = inSeg(ev, bpb);
    } else {
      bass = uniform();
    }
    // Phrase starts are weak downbeat evidence — NEM's verses enter two to
    // three eighths AFTER the bar line — so no pickup folding: raw positions,
    // low weights, never decisive.
    std::vector<double> voc;
    if (hasVoc) {
      std::vector<std::pair<int, double>> ev;
      for (const VocHit& h : vocHits) ev.push_back({h.k, h.w});
      voc = inSeg(ev, 2);
    } else {
      voc = uniform();
    }
    std::vector<std::pair<int, double>> lev;
    for (const int k : lineHits) lev.push_back({k, 1.0});
    const std::vector<double> line = inSeg(lev, 4);
    // Neural downbeat head: one voter among the stems. Reliable on straight
    // meters (dead-on Sixteen Tons' re-phased bar), but its 6/8 bar sits a
    // beat off the drummer's notation (NEM +1 eighth), so compound weight is
    // token — never decisive against the band-entrance/chord evidence.
    std::vector<double> mld;
    if (hasMlDownE) {
      std::vector<double> sums(B, 0.0);
      double mass = 0;
      for (int k = a; k <= b && k < static_cast<int>(mlDownE.size()); k++) {
        sums[static_cast<size_t>(k % bpb)] += mlDownE[static_cast<size_t>(k)];
        mass += mlDownE[static_cast<size_t>(k)];
      }
      mld = mass >= 1 ? normDist(sums) : uniform();
    } else {
      mld = uniform();
    }
    // compound meter: the per-beat kick pattern stops deciding (the mid-bar tom
    // is idiomatic) — but entrances and separated slams are structural events,
    // not groove, and stay meaningful.
    struct Cue {
      const std::vector<double>* d;
      double w;
    };
    // Insertion order IS the summation order (the TS iterates Object.entries),
    // and without ML data the cue is OMITTED rather than made uniform: `conf`
    // divides by the summed weights, so a uniform seventh voter would shift
    // every calibrated no-pack confidence against ANCHOR_CONF.
    std::vector<Cue> cues = {{&kick, bpb == 6 ? 0.05 : 0.2},  {&ent, bpb == 6 ? 0.15 : 0.18},
                             {&slam, bpb == 6 ? 0.1 : 0.15},  {&bass, bpb == 6 ? 0.4 : 0.15},
                             {&voc, bpb == 6 ? 0.05 : 0.05},  {&line, bpb == 6 ? 0.25 : 0.15}};
    if (hasMlDownE) cues.push_back({&mld, bpb == 6 ? 0.05 : 0.2});
    std::vector<double> score(B, 0.0);
    double total = 0;
    for (const Cue& c : cues) {
      total += c.w;
      for (size_t r = 0; r < B; r++) score[r] += c.w * (*c.d)[r];
    }
    size_t rot = 0;
    for (size_t r = 1; r < B; r++)
      if (score[r] > score[rot]) rot = r;
    std::vector<double> sorted = score;
    std::sort(sorted.begin(), sorted.end(), std::greater<double>());
    std::vector<std::vector<double>> rounded;
    for (const Cue& c : cues) {
      std::vector<double> r(B);
      for (size_t i = 0; i < B; i++) r[i] = jsRound((*c.d)[i] * 100) / 100;
      rounded.push_back(std::move(r));
    }
    return Scored{a, b, static_cast<int>(rot), (sorted[0] - sorted[1]) / total, std::move(rounded)};
  };

  // Confident segments pin their own downbeat. Each anchor's rotation owns the
  // beats from its start to the next anchor's start; agreeing neighbours chain
  // into one uniform grid, and a phase change leaves the boundary bar an odd
  // length — so the beat TIMES stay exactly as tracked.
  const int MIN_BARS = 4;
  const double ANCHOR_CONF = 0.08;
  std::vector<Scored> scored;
  for (const auto& sg : segs) scored.push_back(scoreSegment(sg.first, sg.second));
  for (const Scored& s : scored)
    dbg.segCues.push_back({s.a, s.b, s.rot, jsRound(s.conf * 1000) / 1000, s.cues});
  std::vector<Scored> anchors;
  for (const Scored& s : scored)
    if (static_cast<double>(s.b - s.a) / bpb >= MIN_BARS && s.conf >= ANCHOR_CONF) anchors.push_back(s);

  int downbeat = 0;
  std::vector<int> downbeats;
  bool haveDownbeats = false;

  /** Rotation vote over one index window: kick pattern + chord changes + lyric
   *  lines. Chord changes vote regardless of drum activity — a slip is visible
   *  in the harmony even where the kit is thin. */
  const auto windowRot = [&](int a, int b, int& rotOut) {
    const size_t B = static_cast<size_t>(bpb);
    const double wKick = bpb == 6 ? 0.1 : 0.3, wHarm = bpb == 6 ? 0.6 : 0.45, wLine = bpb == 6 ? 0.3 : 0.25;
    std::vector<double> kick(B, 0.0);
    std::vector<int> kn(B, 0);
    for (int k = a; k < b; k++) {
      if (!active[static_cast<size_t>(k)]) continue;
      kick[static_cast<size_t>(k % bpb)] += kickE[static_cast<size_t>(k)];
      kn[static_cast<size_t>(k % bpb)]++;
    }
    bool allOver = true;
    for (const int n : kn)
      if (!(n > 1)) allOver = false;
    std::vector<double> kickD;
    if (allOver) {
      std::vector<double> avg(B);
      for (size_t i = 0; i < B; i++) avg[i] = kn[i] ? kick[i] / kn[i] : 0.0;
      kickD = normDist(avg);
    } else {
      kickD = uniform();
    }
    std::vector<double> harm(B, 0.0);
    int hUsed = 0;
    if (hasHarmNov) {
      for (int k = a; k < b && k < static_cast<int>(harmNov.size()); k++) {
        if (harmNov[static_cast<size_t>(k)] > 0) {
          harm[static_cast<size_t>(k % bpb)] += harmNov[static_cast<size_t>(k)];
          hUsed++;
        }
      }
    }
    const std::vector<double> harmD = hUsed >= bpb ? normDist(harm) : uniform();
    std::vector<double> line(B, 0.0);
    int lUsed = 0;
    for (const int k : lineHits) {
      if (k >= a && k < b) {
        line[static_cast<size_t>(k % bpb)] += 1;
        lUsed++;
      }
    }
    const std::vector<double> lineD = lUsed >= 2 ? normDist(line) : uniform();
    if (hUsed < bpb && lUsed < 2) return false;  // nothing but drums — undecided
    std::vector<double> score(B, 0.0);
    for (size_t r = 0; r < B; r++) score[r] = wKick * kickD[r] + wHarm * harmD[r] + wLine * lineD[r];
    size_t rot = 0;
    for (size_t r = 1; r < B; r++)
      if (score[r] > score[rot]) rot = r;
    std::vector<double> sorted = score;
    std::sort(sorted.begin(), sorted.end(), std::greater<double>());
    if (!(sorted[0] - sorted[1] >= 0.1)) return false;
    rotOut = static_cast<int>(rot);
    return true;
  };

  std::vector<int> phaseCutsDbg;
  struct Piece {
    int start, rot;
  };
  /** Stable rotation flips inside [from,to), beginning with the anchor's own. */
  const auto phasePieces = [&](int from, int to, int rot0) {
    std::vector<Piece> pieces{{from, rot0}};
    const int winB = 12 * bpb, hopB = 4 * bpb;
    if (to - from < winB * 2) return pieces;
    struct Win {
      double center;
      int rot;
    };
    std::vector<Win> wins;
    for (int a = from; a + winB <= to; a += hopB) {
      int r = 0;
      if (windowRot(a, a + winB, r)) wins.push_back({a + winB / 2.0, r});
    }
    const int RUN = 4;
    int cur = rot0;
    size_t i = 0;
    while (i + RUN <= wins.size()) {
      const int r = wins[i].rot;
      bool allSame = true;
      for (size_t j = i; j < i + RUN; j++)
        if (wins[j].rot != r) allSame = false;
      if (r != cur && allSame) {
        // boundary at the biggest interval anomaly between the previous
        // window's center and this run's center — slips live at tracked-
        // interval defects — else at the run's first center.
        const int lo = i > 0 ? static_cast<int>(jsRound(wins[i - 1].center)) : from;
        const int hi = static_cast<int>(jsRound(wins[i].center));
        int cut = hi;
        double worst = 0;
        for (int k = std::max(from + 1, lo); k < std::min(hi, nb - 1); k++) {
          const double d = std::fabs(beatsSec[static_cast<size_t>(k + 1)] - beatsSec[static_cast<size_t>(k)] - medSec) /
                           medSec;
          if (d > worst) {
            worst = d;
            cut = k + 1;
          }
        }
        // A real phase slip leaves a physical defect in the tracked intervals
        // at the cut (Mr Crowley's measures 0.26); harmonic ambiguity over a
        // clean grid (0.05, 0.17) must never re-phase. Without an ML lattice
        // the gate always applies — smooth-by-construction model grids are the
        // only case it is void for.
        // ML lattices are smooth by construction even at REAL musical seams —
        // NEM loses an eighth mid-song (414 true eighths crossed in 413 model
        // beats) with no interval defect anywhere — so for them this gate is
        // void and the global harmonic arbiter below is the only judge.
        // Homegrown grids keep it: their slips leave measurable defects
        // (Mr Crowley's measure 0.26).
        if (worst < 0.2 && !mlc.phase) {
          i += RUN;
          continue;
        }
        pieces.push_back({cut, r});
        phaseCutsDbg.push_back(cut);
        cur = r;
        i += RUN;
      } else {
        i++;
      }
    }
    return pieces;
  };

  if (!anchors.empty()) {
    const auto buildBars = [&](bool withCuts) {
      std::vector<int> out;
      for (size_t i = 0; i < anchors.size(); i++) {
        const int rot = anchors[i].rot % bpb;
        const int from = i == 0 ? 0 : anchors[i].a;
        const int to = i + 1 < anchors.size() ? anchors[i + 1].a : nb;
        const std::vector<Piece> pieces = withCuts ? phasePieces(from, to, rot) : std::vector<Piece>{{from, rot}};
        for (size_t j = 0; j < pieces.size(); j++) {
          const int end = j + 1 < pieces.size() ? pieces[j + 1].start : to;
          const int r = pieces[j].rot % bpb;
          for (int k = pieces[j].start + (((r - pieces[j].start) % bpb) + bpb) % bpb; k < end; k += bpb) out.push_back(k);
        }
      }
      return out;
    };
    // Cuts must pay for themselves globally: the fraction of chord-change mass
    // landing ON downbeats has to improve by a WIDE margin (measured keeps
    // +0.63/+0.54/+0.33, revert +0.16). Only re-phase when the harmony
    // overwhelmingly demands it.
    const auto harmOnBars = [&](const std::vector<int>& bars) {
      if (!hasHarmNov) return 0.0;
      std::vector<bool> isBar(harmNov.size(), false);
      for (const int k : bars)
        if (k >= 0 && k < static_cast<int>(harmNov.size())) isBar[static_cast<size_t>(k)] = true;
      double on = 0, tot = 0;
      for (size_t k = 0; k < harmNov.size(); k++) {
        if (harmNov[k] > 0) {
          tot += harmNov[k];
          if (isBar[k]) on += harmNov[k];
        }
      }
      return tot > 0 ? on / tot : 0.0;
    };
    const std::vector<int> plain = buildBars(false);
    const std::vector<int> cut = buildBars(true);
    if (!phaseCutsDbg.empty()) {
      dbg.harmGainPlain = harmOnBars(plain);
      dbg.harmGainCut = harmOnBars(cut);
      dbg.hasHarmGain = true;
    }
    if (!phaseCutsDbg.empty() && hasHarmNov && harmOnBars(cut) >= harmOnBars(plain) + 0.3) {
      downbeats = cut;
    } else {
      phaseCutsDbg.clear();
      downbeats = plain;
    }
    // Spliced leading span: the model's own bar marks rule the intro — the
    // only downbeat evidence over a drum-free intro at its own tempo. The
    // boundary bar into the first anchored region comes out odd, which is
    // honest: the intro-to-body seam is a real tempo change.
    if (mlc.leadEnd > 0 && aux.ml && !downbeats.empty()) {
      const int firstOwn = anchors[0].a;
      // `beatsSec[firstOwn] ?? mlLeadEnd` — an out-of-range index is undefined
      // in JS and the min then falls back to the span end.
      const double boundarySec =
          firstOwn >= 0 && firstOwn < nb ? std::min(mlc.leadEnd, beatsSec[static_cast<size_t>(firstOwn)])
                                         : mlc.leadEnd;
      std::vector<int> intro;
      int prevI = -1;
      for (const double t : aux.ml->downbeats) {
        if (t >= boundarySec - 0.2) break;
        const int i = nearestBeatIdx(beatsSec, t);
        if (i > prevI && std::fabs(beatsSec[static_cast<size_t>(i)] - t) < 0.15) {
          intro.push_back(i);
          prevI = i;
        }
      }
      if (intro.size() >= 2) {
        std::vector<int> merged = intro;
        for (const int k : downbeats)
          if (k >= firstOwn && k > intro.back()) merged.push_back(k);
        downbeats = std::move(merged);
      }
    }
    // Interior spliced spans: the model repaired their TIMING, but the "1" was
    // blind extension from the surrounding anchors — nothing musical ever
    // voted it (TTP's bass solo walks chord changes on bars the extension
    // missed). Chord-change mass plus the model's downbeat head re-vote the
    // rotation per span; only a confident margin overrides, and the boundary
    // bars come out odd — the fermata mechanics.
    if (!mlc.spliceRanges.empty() && !downbeats.empty()) {
      const bool hasDbp = aux.ml && !aux.ml->downbeatProb.empty() && aux.ml->fps > 0;
      for (const auto& rg : mlc.spliceRanges) {
        const int a = std::max(0, nearestBeatIdx(beatsSec, rg.first));
        const int b = std::min(nb - 1, nearestBeatIdx(beatsSec, rg.second));
        if (b - a < 2 * bpb) continue;
        std::vector<double> harm(static_cast<size_t>(bpb), 0.0);
        std::vector<double> mld2(static_cast<size_t>(bpb), 0.0);
        double hMass = 0;
        for (int k = a; k <= b; k++) {
          const double hv = hasHarmNov && k < static_cast<int>(harmNov.size())
                                ? harmNov[static_cast<size_t>(k)]
                                : 0.0;
          if (hv > 0) {
            harm[static_cast<size_t>(k % bpb)] += hv;
            hMass += hv;
          }
          if (hasDbp) {
            const std::vector<double>& dbp = aux.ml->downbeatProb;
            const int f = static_cast<int>(jsRound(beatsSec[static_cast<size_t>(k)] * aux.ml->fps));
            double best = 0;
            for (const int g : {f - 1, f, f + 1})
              if (g >= 0 && g < static_cast<int>(dbp.size()) && dbp[static_cast<size_t>(g)] > best)
                best = dbp[static_cast<size_t>(g)];
            mld2[static_cast<size_t>(k % bpb)] += best;
          }
        }
        if (hMass <= 0) continue;
        const auto norm = [&](const std::vector<double>& xs) {
          double t = 0;
          for (const double x : xs) t += x;
          std::vector<double> o(xs.size());
          for (size_t i = 0; i < xs.size(); i++) o[i] = t > 1e-9 ? xs[i] / t : 1.0 / bpb;
          return o;
        };
        const std::vector<double> hd = norm(harm);
        const std::vector<double> md = norm(mld2);
        std::vector<double> score(static_cast<size_t>(bpb));
        for (int r = 0; r < bpb; r++)
          score[static_cast<size_t>(r)] = 0.7 * hd[static_cast<size_t>(r)] + 0.3 * md[static_cast<size_t>(r)];
        int rot = 0;
        for (int r = 1; r < bpb; r++)
          if (score[static_cast<size_t>(r)] > score[static_cast<size_t>(rot)]) rot = r;
        std::vector<double> sorted = score;
        std::sort(sorted.begin(), sorted.end(), std::greater<double>());
        const double margin = sorted[0] - sorted[1];
        if (margin < 0.15) continue;
        std::vector<int> merged;
        for (const int k : downbeats)
          if (k < a || k > b) merged.push_back(k);
        for (int k = a + ((((rot - a) % bpb) + bpb) % bpb); k <= b; k += bpb) merged.push_back(k);
        // Stable, then drop duplicates keeping the first — a re-voted bar
        // landing on a kept one must not appear twice.
        std::stable_sort(merged.begin(), merged.end());
        downbeats.clear();
        for (size_t i = 0; i < merged.size(); i++)
          if (i == 0 || merged[i] > merged[i - 1]) downbeats.push_back(merged[i]);
        dbg.spanPhase.push_back({rg.first, rg.second, jsRound(margin * 100) / 100, rot});
      }
      // (The TS re-derives `downbeat` here; the line below overwrites it
      // unconditionally, so it is not reproduced.)
    }
    haveDownbeats = !downbeats.empty();
    downbeat = haveDownbeats ? downbeats[0] % bpb : anchors[0].rot % bpb;
    dbg.phaseCuts = phaseCutsDbg;
  } else if (!scored.empty()) {
    const Scored* best = &scored[0];
    for (const Scored& s : scored)
      if (s.conf > best->conf) best = &s;
    downbeat = best->rot % bpb;
  } else if (mlc.phase && aux.ml) {
    // No segments at all (drumless song on the ML lattice): the stems offer
    // zero phase evidence, so the model's own bar marks stand rather than a
    // downbeat of 0 by luck.
    std::vector<int> dbI;
    for (const double t : aux.ml->downbeats) {
      const int i = nearestBeatIdx(beatsSec, t);
      if (i >= 0 && (dbI.empty() || i > dbI.back())) dbI.push_back(i);
    }
    if (dbI.size() >= 2) {
      downbeats = dbI;
      haveDownbeats = true;
    }
    downbeat = !dbI.empty() ? dbI[0] % bpb : 0;
  }

  // NOT sanitized here: the TS runs sanitizeBars AFTER the head backcast
  // (analysis.ts:1543), and the backcast can both add bars and change the beat
  // count they are bounded by. detectBeats does it in that order.
  out.beatsPerBar = bpb;
  out.downbeat = downbeat;
  out.downbeats = downbeats;
  out.ok = true;
  return out;
}

// ---- detectBeats: the head backcast ---------------------------------------
//
// analysis.ts's `backcastHead`. Two triggers, both judged from the grid alone
// before any audio is touched: an UNSTEADY lead-in (the intervals before the
// first stable run wobble) or a MISSING one (the grid simply starts more than
// two bars in). A singer keeps counting through material like that; the count
// does not stop because the drums have not.
HeadBackcast backcastHead(const std::vector<double>& beats, const std::vector<int>* bars, int bpb,
                          const std::vector<float>& drumsMono, const BeatAux& aux, BeatDebug& dbg,
                          const std::vector<double>& chordOnsets) {
  HeadBackcast out;
  if (beats.size() < 32) return out;
  std::vector<double> iv;
  for (size_t i = 1; i < beats.size(); i++) iv.push_back(beats[i] - beats[i - 1]);
  std::vector<double> ivSorted = iv;
  std::sort(ivSorted.begin(), ivSorted.end());
  const double med = ivSorted[ivSorted.size() >> 1];
  if (!(med > 0)) return out;

  // the anchor: start of the first run of 12 intervals within 8% of median
  int anchor = -1;
  for (size_t i = 0; i + 12 <= iv.size(); i++) {
    bool ok = true;
    for (size_t k = i; k < i + 12; k++) {
      if (std::fabs(iv[k] - med) > 0.08 * med) {
        ok = false;
        break;
      }
    }
    if (ok) {
      anchor = static_cast<int>(i);
      break;
    }
  }
  if (anchor < 0) {
    dbg.headWhy = BeatDebug::HeadWhy::noAnchor;
    return out;
  }

  int off = 0;
  for (int i = 0; i < anchor; i++)
    if (std::fabs(iv[static_cast<size_t>(i)] - med) > 0.15 * med) off++;
  const bool unsteady = anchor > 0 && static_cast<double>(off) / std::max(1, anchor) > 0.25;
  // the gap BEFORE the grid, not the time of the anchor — testing the anchor's
  // time made any song with a wobbly first few beats read as "missing head"
  // however early its grid actually started
  const bool missing = beats[0] > 2 * bpb * med;
  dbg.headAnchor = anchor;
  dbg.headAt = beats[static_cast<size_t>(anchor)];
  dbg.headFirst = beats[0];
  if (!unsteady && !missing) {
    dbg.headWhy = BeatDebug::HeadWhy::headOk;
    return out;
  }

  // local period at the anchor — the pulse actually being carried back
  std::vector<double> local(iv.begin() + anchor, iv.begin() + std::min(iv.size(), static_cast<size_t>(anchor) + 24));
  std::sort(local.begin(), local.end());
  const double per = local[local.size() >> 1];

  // Onsets over the head window, per part so sample rates never mix. Folded-
  // band flux per stem, not broadband RMS: broadband energy ranks an intro's
  // arpeggio notes above its chord attacks, while the fold sees the wide
  // spectral splash of a chord landing and puts the anchors on top.
  //
  // NOTE the TS reads `fb.getChannelData(0)` for inst and bass here — channel
  // ZERO, not the fold it uses everywhere else — while drums arrives already
  // folded. This side has only the fold (AnalysisStem is mono by
  // construction), which is identical for the mono buffers the parity harness
  // and the phone both supply, and differs from the desktop renderer's own
  // stereo AudioBuffers. Recorded rather than silently "fixed": matching the
  // TS is this file's whole contract, and the fold is the better input, so
  // the desktop swap is where that gets reconciled, deliberately and once.
  struct Part {
    const std::vector<float>* x;
    double sr;
  };
  std::vector<Part> parts{{&drumsMono, ANALYSIS_SR}};
  if (aux.inst)
    for (const AnalysisStem& fb : *aux.inst) parts.push_back({&fb.mono, fb.sampleRate});
  if (aux.bass) parts.push_back({&aux.bass->mono, aux.bass->sampleRate});

  const double tEnd = beats[static_cast<size_t>(anchor)] + 2 * per;
  struct Cand {
    double t, v;
  };
  std::vector<Cand> cand;
  constexpr int NFF = 4096;
  constexpr int HOPF = 1024;
  std::vector<double> win(NFF);
  for (int i = 0; i < NFF; i++) win[static_cast<size_t>(i)] = 0.5 - 0.5 * std::cos((2 * M_PI * i) / NFF);
  for (const Part& p : parts) {
    const double nD = std::floor(tEnd * p.sr);
    const size_t n = std::min(p.x->size(), nD > 0 ? static_cast<size_t>(nD) : 0);
    const long long frames = (static_cast<long long>(n) - NFF) / HOPF;
    if (frames < 20) continue;
    double peak = 0;
    for (size_t i = 0; i < n; i++) {
      const double a = std::fabs(static_cast<double>((*p.x)[i]));
      if (a > peak) peak = a;
    }
    if (peak < 1e-3) continue;  // silent stem
    std::vector<double> prev(64, 0.0);
    bool havePrev = false;
    std::vector<double> flux;
    flux.reserve(static_cast<size_t>(frames));
    for (long long f = 0; f < frames; f++) {
      std::vector<double> seg(64, 0.0);
      const size_t base = static_cast<size_t>(f) * HOPF;
      for (int i = 0; i < NFF; i++) {
        const double v = static_cast<double>((*p.x)[base + static_cast<size_t>(i)]) * win[static_cast<size_t>(i)];
        seg[static_cast<size_t>(i & 63)] += v * v;
      }
      double d = 0;
      if (havePrev)
        for (int k = 0; k < 64; k++) d += std::max(0.0, seg[static_cast<size_t>(k)] - prev[static_cast<size_t>(k)]);
      flux.push_back(d);
      prev = std::move(seg);
      havePrev = true;
    }
    std::vector<double> fs = flux;
    std::sort(fs.begin(), fs.end());
    const double thr = fs[static_cast<size_t>(std::floor(static_cast<double>(fs.size()) * 0.97))];
    for (long long f = 1; f < frames - 1; f++) {
      const size_t fi = static_cast<size_t>(f);
      if (flux[fi] > thr && flux[fi] >= flux[fi - 1] && flux[fi] >= flux[fi + 1])
        cand.push_back({(static_cast<double>(f) * HOPF + NFF / 2.0) / p.sr, flux[fi]});
    }
  }
  // non-maximum suppression at beat scale: strongest first, each claiming
  // +/-1.4 beats — about one survivor per musical event, none for its echoes
  std::stable_sort(cand.begin(), cand.end(), [](const Cand& a, const Cand& b) { return b.v < a.v; });
  const int cap = std::max(8.0, std::ceil(beats[static_cast<size_t>(anchor)] / per / 2));
  std::vector<double> taken;
  for (const Cand& c : cand) {
    if (static_cast<int>(taken.size()) >= cap) break;
    bool clear = true;
    for (const double t : taken)
      if (!(std::fabs(t - c.t) > 1.4 * per)) clear = false;
    if (clear) taken.push_back(c.t);
  }
  std::vector<double> fluxMerged = taken;
  std::sort(fluxMerged.begin(), fluxMerged.end());
  // Chord-change evidence replaces the flux events when offered. The walk's
  // stopping point stays acoustic (fluxMerged below): the fade-in chord the
  // decoder missed is still audible, and the count should reach it.
  std::vector<double> chordSorted;
  if (chordOnsets.size() >= 3) {
    chordSorted = chordOnsets;
    std::sort(chordSorted.begin(), chordSorted.end());
  }
  const std::vector<double>& merged = chordSorted.empty() ? fluxMerged : chordSorted;

  // Interval scatter alone cannot tell a WRONG head from a LOOSE one, so the
  // marks are put to the audible onsets — and the onsets must earn that
  // authority first, because energy flux on a legato organ yields peaks on
  // swells and vibrato, junk that would condemn a perfectly tracked head.
  // Judged away from the seam: the final two bars before the anchor are the
  // band arriving, and their dense attacks drown the intro's own evidence.
  std::vector<double> headOn;
  for (const double o : merged)
    if (o <= beats[static_cast<size_t>(anchor)] - 2 * bpb * per) headOn.push_back(o);
  bool onsetsTrusted = false;
  if (headOn.size() >= 3) {
    // Residual against the pulse, ABSOLUTE — real intros carry ornaments whose
    // 0.1 s residual is fine as a fifth of a beat and hopeless as a fifth of
    // itself. Junk spreads residuals uniformly (~40% pass by luck), so the bar
    // is 60%, which clean evidence clears at 90+.
    int periodic = 0;
    for (size_t i = 1; i < headOn.size(); i++) {
      const double gap = headOn[i] - headOn[i - 1];
      const double mult = std::max(1.0, jsRound(gap / per));
      if (mult <= 6 && std::fabs(gap - mult * per) <= 0.2 * per) periodic++;
    }
    onsetsTrusted = static_cast<double>(periodic) / (headOn.size() - 1) >= 0.6;
    dbg.hasHeadOnsets = true;
    dbg.headOnsetsPer = jsRound(per * 1000) / 1000;
    dbg.headOnsetsPeriodic = periodic;
    dbg.headOnsetsOf = static_cast<int>(headOn.size()) - 1;
    for (const double o : headOn) dbg.headOnsetsT.push_back(jsRound(o * 100) / 100);
  }
  // Four honest cases:
  //   tracked head + gap        -> extend only, at the head's own period
  //   wrong head + trusted ons  -> replace from the anchor, snapping
  //   wrong head + junk onsets  -> no evidence to act on; leave it alone
  //   tracked head, no gap      -> already returned above
  bool headTracked = !unsteady;
  if (unsteady && onsetsTrusted) {
    // fraction, not median: a window spanning both the broken intro and the
    // start of the tracked body mixes explained and unexplained onsets, and a
    // median over that mixture hides the broken half entirely
    int unexplained = 0;
    for (const double o : headOn) {
      double d = std::numeric_limits<double>::infinity();
      for (int i = 0; i <= anchor; i++) d = std::min(d, std::fabs(beats[static_cast<size_t>(i)] - o));
      if (d > 0.2 * per) unexplained++;
    }
    headTracked = static_cast<double>(unexplained) / headOn.size() < 0.4;
  }
  dbg.headWhy = BeatDebug::HeadWhy::judged;
  dbg.headUnsteady = unsteady;
  dbg.headMissing = missing;
  dbg.headOnsetCount = static_cast<int>(headOn.size());
  dbg.headOnsetsTrusted = onsetsTrusted;
  if (unsteady && !onsetsTrusted) return out;
  const bool replace = unsteady && !headTracked;
  dbg.headHasVerdict = true;
  dbg.headTracked = headTracked;
  dbg.headReplace = replace;
  if (!replace && !missing) return out;
  const std::vector<double>& snapList = onsetsTrusted ? merged : kNoOnsets;

  // replace: re-lay everything before the anchor at the anchor's pulse.
  // extend: the head is fine — count back only over the gap in front of it, at
  // the period the head itself establishes.
  const int cutIdx = replace ? anchor : 0;
  double perLocal = per;
  if (!(replace || !headTracked)) {
    // the head's own intervals set the extension pace only when the head is
    // actually TRACKING; a wrong head extending at its own wrong period is how
    // a broken intro once grew three bar-sized "beats" in front of itself
    std::vector<double> first(iv.begin(), iv.begin() + std::min(iv.size(), static_cast<size_t>(12)));
    std::sort(first.begin(), first.end());
    perLocal = first[first.size() >> 1];
  }

  // count backward, snapping to whatever is audible
  const double firstAudible = !fluxMerged.empty() ? fluxMerged[0] : (!merged.empty() ? merged[0] : beats[0]);
  std::vector<double> head;
  double t = beats[static_cast<size_t>(cutIdx)];
  int snapped = 0;
  for (int guard = 0; guard < 400; guard++) {
    double next = t - perLocal;
    if (next < 0.25 || next < firstAudible - 0.6 * perLocal) break;
    double best = -1;
    for (const double o : snapList) {
      if (std::fabs(o - next) <= 0.28 * perLocal && (best < 0 || std::fabs(o - next) < std::fabs(best - next)))
        best = o;
    }
    if (best >= 0 && t - best >= 0.7 * perLocal && t - best <= 1.45 * perLocal) {
      next = best;
      snapped++;
    }
    head.push_back(next);
    t = next;
  }
  if (head.empty()) {
    dbg.headWalkEmpty = true;
    return out;
  }
  std::reverse(head.begin(), head.end());

  std::vector<double> outBeats = head;
  outBeats.insert(outBeats.end(), beats.begin() + cutIdx, beats.end());
  const int K = static_cast<int>(head.size());

  // bars: keep the body's, re-indexed; lay the head's backward from the seam
  std::vector<int> downbeats;
  bool hasDownbeats = false;
  std::vector<double> headBarTimes;
  if (bars && !bars->empty()) {
    std::vector<int> body;
    for (const int k : *bars)
      if (k >= cutIdx) body.push_back(k - cutIdx + K);
    if (!body.empty()) {
      // carried phase: straight back from the first body bar
      std::vector<int> carried;
      for (int j = body[0] - bpb; j >= 0; j -= bpb) carried.push_back(j);
      std::reverse(carried.begin(), carried.end());
      // chord phase: do the head's strong onsets agree on a beat-of-bar?
      std::vector<int> voteKey;
      std::vector<int> voteN;
      for (const double o : snapList) {
        int bi = -1;
        for (int i = 0; i < K; i++) {
          const double d = std::fabs(outBeats[static_cast<size_t>(i)] - o);
          if (d <= 0.3 * per && (bi < 0 || d < std::fabs(outBeats[static_cast<size_t>(bi)] - o))) bi = i;
        }
        if (bi >= 0) {
          const int key = bi % bpb;
          size_t at = voteKey.size();
          for (size_t q = 0; q < voteKey.size(); q++)
            if (voteKey[q] == key) at = q;
          if (at == voteKey.size()) {
            voteKey.push_back(key);
            voteN.push_back(0);
          }
          voteN[at]++;
        }
      }
      std::vector<int> headBars = carried;
      bool usedChords = false;
      if (!voteKey.empty()) {
        // Map insertion order + a stable sort by count reproduce the TS's
        // `[...votes.entries()].sort((a,b) => b[1]-a[1])[0]` exactly: a JS Map
        // iterates in insertion order and Array.sort has been stable since
        // ES2019, so tied counts keep first-seen order.
        std::vector<size_t> order(voteKey.size());
        for (size_t q = 0; q < order.size(); q++) order[q] = q;
        std::stable_sort(order.begin(), order.end(), [&](size_t a, size_t b) { return voteN[b] < voteN[a]; });
        const size_t topI = order[0];
        int totalVotes = 0;
        for (const int v : voteN) totalVotes += v;
        if (voteN[topI] >= 2 && voteN[topI] >= 0.7 * totalVotes) {
          std::vector<int> chord;
          for (int j = K - 1 - ((((K - 1 - voteKey[topI]) % bpb) + bpb) % bpb); j >= 0; j -= bpb) chord.push_back(j);
          std::reverse(chord.begin(), chord.end());
          const int seam = !chord.empty() ? body[0] - chord.back() : bpb;
          if (seam >= 2 && seam <= 7) {
            headBars = chord;
            usedChords = true;
          }
        }
      }
      downbeats = headBars;
      downbeats.insert(downbeats.end(), body.begin(), body.end());
      hasDownbeats = true;
      for (const int j : headBars) headBarTimes.push_back(outBeats[static_cast<size_t>(j)]);
      dbg.hasHeadBackcast = true;
      dbg.headBackcastReplaced = cutIdx;
      dbg.headBackcastAdded = K;
      dbg.headBackcastSnapped = snapped;
      dbg.headBackcastChords = usedChords;
    } else {
      for (const int k : *bars)
        if (k - cutIdx + K >= 0) downbeats.push_back(k - cutIdx + K);
      hasDownbeats = true;
    }
  }
  out.beats = std::move(outBeats);
  out.downbeats = std::move(downbeats);
  out.hasDownbeats = hasDownbeats;
  out.headBarTimes = std::move(headBarTimes);
  out.indexShift = K - cutIdx;
  out.ok = true;
  return out;
}

// ---- detectBeats, minus the courts and the ML lattice ---------------------

BeatGrid detectBeats(const AnalysisStem& drums, const BeatAux& aux, BeatDebug& dbg) {
  BeatGrid out;
  const DrumFrontEnd fe = drumFrontEnd(drums, dbg);
  if (!fe.ok) return out;

  // Neural lattice (Beat This!) + the homegrown tracker, fused by measurement,
  // not ideology:
  // - On drum-strong songs the HOMEGROWN lattice wins outright: its beat count
  //   follows real drum onsets through musical seams (NEM eats an eighth
  //   mid-song — 414 true eighths crossed in 413 model beats, no interval
  //   defect anywhere) that the model smooths away, shifting every downstream
  //   bar by one. 12/14 ML-first vs 14/14 this way.
  // - ML takes over where homegrown FAILS (rejects) — drumless songs, soft
  //   material — and where homegrown cannot even express the answer: a steady
  //   lattice whose dominant bar is 3 beats is a waltz, a meter the drums-first
  //   path structurally mislabels as 4/4 (Ballroom 3/4 signature: 0.000
  //   homegrown, 0.992 model).
  // - An unsteady lattice (true rubato — The Music Of The Night) is refused,
  //   and homegrown rejection then stands: no grid, wall-clock count-in.
  // No model, no change: trackFromDrums is the v9 pipeline verbatim, and
  // without aux.ml nothing below alters a single vote.
  const MlLattice mlChoice = latticeFromMl(aux.ml, fe.frames, fe.fps, fe.drumFlux, dbg);
  const int mlDom = mlChoice.ok && aux.ml ? dominantMlBarLen(*aux.ml) : 0;
  // No harmonic stems = nothing to verify WITH: the stem-vote machinery's
  // authority comes entirely from bass/instrument evidence, and on bare mixes
  // it degrades badly (Ballroom 4/4 downbeat F 0.60 re-voted vs 0.985 taking
  // the model's word). Mix-only inputs get the model verbatim. Every real
  // project has all six stems and takes the verified path below.
  if (mlChoice.ok && !mlChoice.doubled && aux.ml && !aux.bass && !(aux.inst && !aux.inst->empty())) {
    const std::vector<double>& beats = mlChoice.beatsSec;
    std::vector<int> dbI;
    for (const double t : aux.ml->downbeats) {
      const int i = nearestBeatIdx(beats, t);
      if (i >= 0 && (dbI.empty() || i > dbI.back())) dbI.push_back(i);
    }
    const int bpbMl = mlDom == 3 || mlDom == 4 || mlDom == 6 ? mlDom : 4;
    dbg.lattice = "ml-verbatim";
    out.beats = beats;
    out.bpm = 60 / mlChoice.medSec;
    out.beatsPerBar = bpbMl;
    out.downbeat = !dbI.empty() ? dbI[0] % bpbMl : 0;
    if (dbI.size() >= 2) {
      out.downbeats = std::move(dbI);
      out.hasDownbeats = true;
    }
    out.ok = true;
    return out;
  }

  DrumLattice lat;
  bool mlPhase = false;
  /** Whether `lat` IS the model's lattice. The TS used object identity until
   *  v17's normalization started returning a new object — which would have
   *  silently handed the adopted path to the splice family (which exists to
   *  repair the DRUMS lattice) and mislabelled it in the debug trail. */
  bool adopted = false;
  /** v17: an adopted lattice IS the click, and nothing below re-levels it —
   *  the splice family runs only when the drums-first tracker won. Flatten a
   *  model that changed level mid-song onto one tempo on the way in. */
  const auto adopt = [&](const MlLattice& c) {
    DrumLattice o;
    o.medSec = c.medSec;
    o.O = c.O;
    bool same = false;
    std::vector<double> beats =
        levelNormalize(c.beatsSec, c.medSec, aux.ml ? &aux.ml->downbeats : nullptr, same);
    if (same) {
      o.beatsSec = c.beatsSec;
    } else {
      const double m = beats.size() >= 2 ? upperMedian(intervalsOf(beats)) : c.medSec;
      dbg.hasMlNormalized = true;
      dbg.mlNormalizedFrom = static_cast<int>(c.beatsSec.size());
      dbg.mlNormalizedTo = static_cast<int>(beats.size());
      dbg.mlNormalizedMedSec = jsRound(m * 1000) / 1000;
      o.beatsSec = std::move(beats);
      o.medSec = m;
    }
    // The bar-phase pass reads these off the lattice, and for an adopted one
    // they are the front-end's — the TS keeps them as detectBeats locals, so
    // the model's grid is measured against the same drum activity.
    o.lowFlux = fe.lowFlux;
    o.drumPeaks = fe.drumPeaks;
    o.frames = fe.frames;
    o.ok = true;
    return o;
  };
  if (mlChoice.ok && !mlChoice.doubled && mlDom == 3) {
    lat = adopt(mlChoice);
    mlPhase = true;
    adopted = true;
  }
  if (!lat.ok) {
    lat = trackFromDrumsCore(fe, aux, dbg);
    // A refusal writes dbg.reject; the ML fallback below may still produce a
    // grid, and the TS leaves that reason standing in the debug either way.
  }
  if (!lat.ok && mlChoice.ok) {
    lat = adopt(mlChoice);
    mlPhase = !mlChoice.doubled;
    adopted = true;
  }
  if (!lat.ok) return out;

  MlPhaseCtx mlc;
  mlc.phase = mlPhase;
  mlc.dom = mlDom;
  // v11/v12: where the drums-first lattice has NOTHING (refused voids) or is
  // physically SUSPECT (interval defects), the model's beats replace the
  // stretch — see spliceFromMl for the three sources and their gates.
  if (!adopted && mlChoice.ok && aux.ml && lat.beatsSec.size() >= 16) {
    MlSpliceOut sp;
    spliceFromMl(lat, mlChoice, *aux.ml, sp, dbg);
    mlc.leadEnd = sp.leadEnd;
    mlc.spliceRanges = std::move(sp.ranges);
  }
  dbg.lattice = adopted ? "ml" : "drums";
  dbg.voids = lat.voids;

  const BarPhase ph = barPhase(lat, drums, aux, mlc, dbg);
  const int bpb = ph.beatsPerBar;
  int downbeat = ph.downbeat;
  std::vector<int> downbeats = ph.downbeats;
  // The TS's `downbeats` is undefined rather than [] when the vote produced
  // none, and the difference is load-bearing: an empty array is truthy.
  bool hasDownbeats = !downbeats.empty();

  std::vector<double> outBeats = lat.beatsSec;
  std::vector<double> headBarTimes;
  {
    const HeadBackcast rebuilt =
        backcastHead(lat.beatsSec, hasDownbeats ? &downbeats : nullptr, bpb, fe.mono, aux, dbg);
    if (rebuilt.ok) {
      outBeats = rebuilt.beats;
      downbeats = rebuilt.downbeats;
      hasDownbeats = rebuilt.hasDownbeats;
      // A song with no downbeats[] carries its whole bar structure in the
      // `downbeat` rotation index, and replacing the head shifts every beat
      // index by (added - removed) — without this correction every bar in the
      // song silently rotates.
      downbeat = hasDownbeats && !downbeats.empty()
                     ? downbeats[0] % bpb
                     : ((((downbeat + rebuilt.indexShift) % bpb) + bpb) % bpb);
      headBarTimes = rebuilt.headBarTimes;
    }
  }

  if (hasDownbeats) {
    const std::vector<int> clean = sanitizeBars(downbeats, bpb, static_cast<int>(outBeats.size()));
    if (clean.size() != downbeats.size()) {
      dbg.sanitizedBefore = static_cast<int>(downbeats.size());
      dbg.sanitizedAfter = static_cast<int>(clean.size());
      dbg.hasSanitized = true;
    }
    downbeats = clean;
    if (!downbeats.empty()) downbeat = downbeats[0] % bpb;
  }

  // v20: the courts. The finished grid — exactly what the eval battery fed
  // them — goes in; what comes back may be halved to the notation's octave,
  // doubled to the model's conviction, or carry newly placed odd bars. Runs
  // only when harmonic stems exist to testify: a bare mix (Ballroom's shape)
  // skips the block entirely and ships the grid untouched, which is the
  // abstention contract the battery verified sixteen times over.
  double outBpm = 60 / lat.medSec;
  int outBpb = bpb;
  {
    const bool haveHarm = (aux.inst && !aux.inst->empty()) || aux.bass || aux.vocals;
    if (haveHarm) {
      CourtGrid det0;
      det0.bpm = outBpm;
      det0.beatsPerBar = outBpb;
      det0.downbeat = downbeat;
      det0.beats = outBeats;
      det0.downbeats = downbeats;
      det0.hasDownbeats = hasDownbeats;
      CourtSources srcs;
      srcs.harm = aux.inst;
      srcs.bass = aux.bass;
      srcs.vocals = aux.vocals;
      srcs.words = aux.words;
      CourtEvidence ev = buildCourtEvidence(det0, srcs);
      // CourtSources deliberately has no `ml` — the lattice arrives from
      // beat_this, not from audio — so the caller fills ev.ml itself. Forget
      // this and doubleCourt, whose only witness IS the model, silently never
      // fires and no parity run can see it (both sides agree on nothing
      // happening). courts.h says so at the struct; this is the call site it
      // is talking about.
      if (aux.ml) ev.ml = mlLevelStats(aux.ml->beats, ev.hasMl);
      CourtsDbg courtDbg;
      const CourtGrid courted = applyCourts(det0, ev, courtDbg);
      const bool courtsMoved = courtDbg.changed;
      dbg.v20 = std::move(courtDbg);
      dbg.hasV20 = true;
      if (courtsMoved) {
        // adopt only the grid fields — the courts' working notes
        // (originalBars, halvedFrom) never leave this block
        outBeats = courted.beats;
        outBpm = courted.bpm;
        outBpb = courted.beatsPerBar;
        downbeat = courted.downbeat;
        downbeats = courted.downbeats;
        hasDownbeats = courted.hasDownbeats;
        if (hasDownbeats) {
          // a court insert can leave an impossible tail bar; same net as every
          // other grid
          downbeats = sanitizeBars(downbeats, outBpb, static_cast<int>(outBeats.size()));
          if (!downbeats.empty()) downbeat = downbeats[0] % outBpb;
        }
        // A halved grid gets the head backcast a second chance. The v19 pass
        // judged the lead-in against the pre-halve pulse and refused —
        // correctly: Zeit's piano chords fit the shipped 123 at 21%. At the
        // notation's octave the same onsets fit at 71%, which is the measured
        // finding that predicted this moment: the head fix flows through the
        // octave verdict. Doubled grids keep their head — it was tracked at
        // the level the music actually carries there.
        if (courted.hasHalvedFrom) {
          BeatDebug d2;
          std::vector<double> chordOnsets;
          for (const ChordRun& r : changePoints(ev.runs)) chordOnsets.push_back(r.t);
          const HeadBackcast again =
              backcastHead(outBeats, hasDownbeats ? &downbeats : nullptr, outBpb, fe.mono, aux, d2, chordOnsets);
          dbg.headAfterHalve = std::make_shared<BeatDebug>(std::move(d2));
          if (again.ok) {
            outBeats = again.beats;
            if (again.hasDownbeats) {
              downbeats = again.downbeats;
              hasDownbeats = true;
            }
            headBarTimes = again.headBarTimes;
            if (hasDownbeats) {
              downbeats = sanitizeBars(downbeats, outBpb, static_cast<int>(outBeats.size()));
              if (!downbeats.empty()) downbeat = downbeats[0] % outBpb;
            }
          }
        }
      }
    }
  }

  // Where the detector already knows it was guessing. Three sources, all free:
  // spans it filled by extending the surrounding phase instead of voting (the
  // splice ranges), bars whose length disagrees with the song's own meter, and
  // every bar line the head backcast laid down. None is a claim that the grid
  // is wrong there — it is a claim that this is where to look first.
  std::vector<double> suspect = headBarTimes;
  for (const auto& rg : mlc.spliceRanges) {
    const int a = nearestBeatIdx(outBeats, rg.first);
    if (a >= 0 && a < static_cast<int>(outBeats.size())) suspect.push_back(outBeats[static_cast<size_t>(a)]);
  }
  if (hasDownbeats) {
    for (size_t i = 1; i < downbeats.size(); i++) {
      if (downbeats[i] - downbeats[i - 1] != outBpb)
        suspect.push_back(outBeats[static_cast<size_t>(downbeats[i - 1])]);
    }
  }
  // `[...new Set(x)].sort(asc)` — dedup first (insertion order), then sort.
  std::vector<double> suspectAt;
  for (const double v : suspect) {
    bool seen = false;
    for (const double u : suspectAt)
      if (u == v) seen = true;
    if (!seen) suspectAt.push_back(v);
  }
  std::sort(suspectAt.begin(), suspectAt.end());

  out.beats = std::move(outBeats);
  out.bpm = outBpm;
  out.beatsPerBar = outBpb;
  out.downbeat = downbeat;
  out.downbeats = std::move(downbeats);
  out.hasDownbeats = hasDownbeats;
  out.suspectAt = std::move(suspectAt);
  out.ok = true;
  return out;
}
}  // namespace singz

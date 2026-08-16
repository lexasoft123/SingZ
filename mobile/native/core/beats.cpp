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

}  // namespace

DrumLattice trackFromDrums(const AnalysisStem& drums, const std::vector<AnalysisStem>& inst, BeatDebug& dbg) {
  DrumLattice out;
  const double sr = ANALYSIS_SR;
  const double fps = sr / HOP;
  const std::vector<float> mono = monoAt44kPublic(drums);
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
  std::stable_sort(cands.begin(), cands.end(), [](const Cand& x, const Cand& y) { return y.score < x.score; });
  if (cands.empty()) {
    dbg.reject = "no octave candidate";
    return out;
  }
  size_t chosen = 0;
  // v15/v16: near-ties resolve on acoustic evidence alone; how wide "near"
  // is depends on the ML model's own ambivalence, which without a pack is
  // absent — the tie window is then the narrow 3%.
  const double tieWin = 0.03;
  if (cands.size() >= 2 && cands[0].score - cands[1].score < tieWin * cands[0].score) {
    const auto acoustic = [](const Cand& c) { return c.q.support * c.q.alternation; };
    chosen = acoustic(cands[1]) > acoustic(cands[0]) ? 1 : 0;
  }
  dbg.chosenBpm = cands[chosen].bpm;
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
  return out;
}

// ---- detectBeats: bar phase & meter ---------------------------------------
//
// Kick energy alone is a coin flip between beats 1 and 3 (both carry kick in
// most grooves), so bar rotation is voted by sharp musical events instead.
// Beat TIMES are never touched by phase logic. This pass so far: the activity
// mask, the kick-energy-per-beat, the meter test and the segments — the vote
// itself is the next slice.
BarPhase barPhase(const DrumLattice& lat, const AnalysisStem& drums, const BeatAux& aux, BeatDebug& dbg) {
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
  // Without an ML grid the TS's waltz branch and its drumless fallback are
  // both unreachable (`!aux?.ml` short-circuits the activity test), so this
  // IS the whole meter decision on the no-pack path the phones take.
  const double ac3 = acAt(3), ac4 = acAt(4);
  const int bpb = ac3 > 1.5 * ac4 ? 6 : 4;
  dbg.acAt3 = ac3;
  dbg.acAt4 = ac4;
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
  int activeN = 0;
  for (const bool a : active)
    if (a) activeN++;
  dbg.activeBeats = activeN;
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
    // compound meter: the per-beat kick pattern stops deciding (the mid-bar tom
    // is idiomatic) — but entrances and separated slams are structural events,
    // not groove, and stay meaningful.
    struct Cue {
      const std::vector<double>* d;
      double w;
    };
    // Insertion order IS the summation order (Object.entries) — and the ML cue
    // is OMITTED rather than uniform on this path: conf divides by the summed
    // weights, and diluting it would shift every calibrated confidence against
    // ANCHOR_CONF.
    const Cue cues[6] = {{&kick, bpb == 6 ? 0.05 : 0.2},  {&ent, bpb == 6 ? 0.15 : 0.18},
                         {&slam, bpb == 6 ? 0.1 : 0.15},  {&bass, bpb == 6 ? 0.4 : 0.15},
                         {&voc, bpb == 6 ? 0.05 : 0.05},  {&line, bpb == 6 ? 0.25 : 0.15}};
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
        if (worst < 0.2) {
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
    haveDownbeats = !downbeats.empty();
    downbeat = haveDownbeats ? downbeats[0] % bpb : anchors[0].rot % bpb;
    dbg.phaseCuts = phaseCutsDbg;
  } else if (!scored.empty()) {
    const Scored* best = &scored[0];
    for (const Scored& s : scored)
      if (s.conf > best->conf) best = &s;
    downbeat = best->rot % bpb;
  }
  // (The TS's third branch is the drumless ML-lattice case — unreachable with
  // no model, like the waltz branch above.)

  if (haveDownbeats) {
    const std::vector<int> clean = sanitizeBars(downbeats, bpb, nb);
    if (clean.size() != downbeats.size()) {
      dbg.sanitizedBefore = static_cast<int>(downbeats.size());
      dbg.sanitizedAfter = static_cast<int>(clean.size());
      dbg.hasSanitized = true;
    }
    downbeats = clean;
    if (!downbeats.empty()) downbeat = downbeats[0] % bpb;
  }

  out.beatsPerBar = bpb;
  out.downbeat = downbeat;
  out.downbeats = downbeats;
  out.ok = true;
  return out;
}

}  // namespace singz

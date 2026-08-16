// See beats.h. Section headers name the TS function each block reproduces.
#include "beats.h"

#include <algorithm>
#include <cmath>
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

}  // namespace

bool trackTempo(const AnalysisStem& drums, const std::vector<AnalysisStem>& inst, BeatDebug& dbg) {
  const double sr = ANALYSIS_SR;
  const double fps = sr / HOP;
  const std::vector<float> mono = monoAt44kPublic(drums);
  const int frames = static_cast<int>(mono.size() / HOP) - 1;
  dbg.frames = frames;
  if (frames < 400) {
    dbg.reject = "too short";
    return false;
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
  for (int i = 1; i < frames; i++)
    drumFlux[static_cast<size_t>(i)] = static_cast<float>(
        std::max(0.0, static_cast<double>(energy[static_cast<size_t>(i)]) -
                          static_cast<double>(energy[static_cast<size_t>(i) - 1])));

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
      std::vector<std::pair<int, int>> fillSpans;
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
    return false;
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
      return false;
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
    return false;
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
    return false;
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
    return false;
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
    return false;
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
    return false;
  }
  // Onset-chasing (loose timing, no pulse): locally rough inter-beat
  // intervals. Real steady/drifting songs measure <= ~0.025 here; chasing
  // jittery hits measures >= ~0.08 even after the DP smooths it.
  if (cands[chosen].q.rough > 0.05) {
    dbg.reject = "no steady pulse (intervals jump around)";
    return false;
  }
  return true;
}

}  // namespace singz

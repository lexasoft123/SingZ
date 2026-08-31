// See melody.h. Section headers name the TS function each block reproduces;
// the comments that mattered on the desktop travel with the code.
#include <zcore/legacy/melody.h>

#include <algorithm>
#include <cmath>
#include <cstdint>

// No fused multiply-add anywhere in this file: the port's parity claim is
// "rounds where the TS rounds", and a contracted a*b+c rounds once where V8
// rounds twice. Measured invisible after the float32 stores on eight files,
// but a claim that holds by measurement on one compiler is not the claim —
// this makes it hold by construction on clang (phones, mac), MSVC (the
// Windows CLI) and GCC alike.
#if defined(__clang__)
#pragma clang fp contract(off)
#elif defined(_MSC_VER)
#pragma fp_contract(off)
#elif defined(__GNUC__)
#pragma GCC optimize("fp-contract=off")
#endif

namespace singz {
namespace {

// ---- pitch.ts: cmndProfile ------------------------------------------------
//
// Cumulative-mean-normalized difference profile of one frame — the core of
// YIN. 0 at lag τ means "repeats perfectly every τ samples".
struct CmndProfile {
  std::vector<float> cmnd;  // Float32Array(tauMax + 1)
  int tauMin = 0;
  int tauMax = 0;
  bool ok = false;
};

CmndProfile cmndProfile(const float* buf, int n, double sampleRate, double fMin, double fMax) {
  CmndProfile p;
  const int tauMin = std::max(2, static_cast<int>(std::floor(sampleRate / fMax)));
  const int tauMax = std::min(static_cast<int>(std::floor(sampleRate / fMin)), n / 2);
  if (tauMax <= tauMin + 2) return p;

  const int w = n - tauMax;
  std::vector<float> d(static_cast<size_t>(tauMax) + 1, 0.0f);
  // The difference function is the whole cost of the tracker, and its sum
  // must round exactly as the TS's does: float32 − float32 is exact in
  // double, and so is its square, so only the running sum rounds — and it
  // rounds in ORDER, i ascending, one lag at a time. That forbids the usual
  // reassociation a vectorizer wants. What it does not forbid is running
  // several LAGS side by side, each with its own accumulator in that same
  // order — the lanes are independent sums, so the compiler vectorizes
  // across them and every lag still adds its terms in the sequence the TS
  // did. Bit-identical, and 3-4x the throughput of the scalar loop.
  constexpr int LANES = 8;
  int tau = 1;
  for (; tau + LANES - 1 <= tauMax; tau += LANES) {
    double sums[LANES] = {0, 0, 0, 0, 0, 0, 0, 0};
    for (int i = 0; i < w; i++) {
      const double x = static_cast<double>(buf[i]);
      for (int l = 0; l < LANES; l++) {
        const double diff = x - static_cast<double>(buf[i + tau + l]);
        sums[l] += diff * diff;
      }
    }
    for (int l = 0; l < LANES; l++) d[static_cast<size_t>(tau + l)] = static_cast<float>(sums[l]);
  }
  for (; tau <= tauMax; tau++) {
    double sum = 0;
    for (int i = 0; i < w; i++) {
      const double diff = static_cast<double>(buf[i]) - static_cast<double>(buf[i + tau]);
      sum += diff * diff;
    }
    d[static_cast<size_t>(tau)] = static_cast<float>(sum);
  }

  p.cmnd.assign(static_cast<size_t>(tauMax) + 1, 0.0f);
  p.cmnd[0] = 1.0f;
  double running = 0;
  for (int tau = 1; tau <= tauMax; tau++) {
    running += static_cast<double>(d[static_cast<size_t>(tau)]);
    p.cmnd[static_cast<size_t>(tau)] =
        running == 0 ? 1.0f
                     : static_cast<float>((static_cast<double>(d[static_cast<size_t>(tau)]) * tau) / running);
  }
  p.tauMin = tauMin;
  p.tauMax = tauMax;
  p.ok = true;
  return p;
}

// ---- pyin.ts --------------------------------------------------------------
//
// Probabilistic YIN (Mauch & Dixon 2014): instead of one pitch per frame,
// every CMND trough becomes a weighted candidate (thresholds drawn from a
// Beta(2,18) prior, Boltzmann-biased against subharmonics), and a banded
// Viterbi over pitch × {voiced, unvoiced} states picks the most probable
// melody path through the whole song.
constexpr double FMIN = 65;
constexpr double FMAX = 1000;
constexpr int BINS_PER_ST = 2;  // 50-cent decode grid; output keeps candidate precision
constexpr double SWITCH_PROB = 0.01;
constexpr double NO_TROUGH_PROB = 0.01;
constexpr double MAX_OCT_PER_SEC = 35.92;
constexpr int N_THRESH = 100;
constexpr double LOG0 = -1e10;

// Math.ceil(12 * Math.log2(FMAX / FMIN)) * BINS_PER_ST — computed at runtime
// with the same libm call the rest of the file uses, so a log2 that differs
// in its last ulp cannot silently give this file a different bin count from
// the TS (12 * log2(1000/65) = 47.32…, comfortably off an integer).
int nBins() {
  static const int n = static_cast<int>(std::ceil(12 * std::log2(FMAX / FMIN))) * BINS_PER_ST;
  return n;
}

struct Trough {
  double tau;
  double val;
  double f0;
};

// Regularized incomplete beta I_x(2,18), the threshold prior's CDF.
double betaCdf218(double x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const double q = 1 - x;
  return 1 - std::pow(q, 19) - 19 * x * std::pow(q, 18);
}

std::vector<Trough> findTroughs(const float* buf, int n, double sr) {
  std::vector<Trough> troughs;
  const CmndProfile p = cmndProfile(buf, n, sr, FMIN, FMAX);
  if (!p.ok) return troughs;
  const std::vector<float>& cmnd = p.cmnd;
  for (int t = std::max(p.tauMin, 2); t < p.tauMax; t++) {
    const size_t ti = static_cast<size_t>(t);
    if (cmnd[ti] < cmnd[ti - 1] && cmnd[ti] <= cmnd[ti + 1]) {
      double tau = t;
      const double s0 = cmnd[ti - 1];
      const double s1 = cmnd[ti];
      const double s2 = cmnd[ti + 1];
      const double denom = 2 * (2 * s1 - s2 - s0);
      double val = s1;
      if (std::fabs(denom) > 1e-9) {
        const double delta = (s2 - s0) / denom;
        if (std::fabs(delta) < 1) {
          tau = t + delta;
          val = s1 - ((s2 - s0) * delta) / 4;
        }
      }
      troughs.push_back({tau, std::max(0.0, val), sr / tau});
    }
  }
  return troughs;
}

struct Emissions {
  std::vector<float> probs;  // Float32Array(troughs.length) — accumulates in float32
  double voicedP = 0;
};

Emissions frameEmissions(const std::vector<Trough>& troughs) {
  Emissions e;
  e.probs.assign(troughs.size(), 0.0f);
  double voicedP = 0;
  if (!troughs.empty()) {
    size_t best = 0;
    for (size_t i = 1; i < troughs.size(); i++)
      if (troughs[i].val < troughs[best].val) best = i;
    std::vector<double> prior(troughs.size());
    for (size_t i = 0; i < troughs.size(); i++) prior[i] = std::exp(-static_cast<double>(i) / 2);
    double prevCdf = 0;
    for (int k = 1; k <= N_THRESH; k++) {
      const double thresh = static_cast<double>(k) / N_THRESH;
      const double cdf = betaCdf218(thresh);
      const double wgt = cdf - prevCdf;
      prevCdf = cdf;
      double mass = 0;
      for (size_t i = 0; i < troughs.size(); i++)
        if (troughs[i].val < thresh) mass += prior[i];
      if (mass > 0) {
        for (size_t i = 0; i < troughs.size(); i++) {
          if (troughs[i].val < thresh)
            e.probs[i] = static_cast<float>(static_cast<double>(e.probs[i]) + (wgt * prior[i]) / mass);
        }
      } else {
        e.probs[best] = static_cast<float>(static_cast<double>(e.probs[best]) + wgt * NO_TROUGH_PROB);
      }
    }
    for (size_t i = 0; i < troughs.size(); i++) voicedP += static_cast<double>(e.probs[i]);
  }
  e.voicedP = std::min(1.0, voicedP);
  return e;
}

// JS Math.round: half toward +∞ (C's round is half away from zero — the two
// differ for negative halves, which log2 ratios can produce).
inline double jsRound(double x) { return std::floor(x + 0.5); }

int binOfHz(double hz) { return static_cast<int>(jsRound(12 * std::log2(hz / FMIN) * BINS_PER_ST)); }

// Track the melody of decimated mono audio. Returns f0 per hop (0 =
// unvoiced) at `hop` samples spacing; reports progress 0..1.
std::vector<float> pyinTrack(const std::vector<float>& dec, double sr, int win, int hop,
                             const Progress* progress, bool* cancelled) {
  const int N_BINS = nBins();
  const int64_t nn = static_cast<int64_t>(dec.size());
  const int frames = static_cast<int>(std::max<int64_t>(0, (nn - win) / hop));
  const double hopSec = static_cast<double>(hop) / sr;
  const int N_STATES = 2 * N_BINS;
  const int band = std::max(2, static_cast<int>(jsRound(12 * MAX_OCT_PER_SEC * hopSec * BINS_PER_ST)));

  std::vector<float> transW(static_cast<size_t>(2 * band + 1));
  double transSum = 0;
  for (int k = -band; k <= band; k++) {
    transW[static_cast<size_t>(k + band)] = static_cast<float>(band + 1 - std::abs(k));
    transSum += static_cast<double>(transW[static_cast<size_t>(k + band)]);
  }
  std::vector<float> logTransW(transW.size());
  for (size_t k = 0; k < transW.size(); k++)
    logTransW[k] = static_cast<float>(std::log(static_cast<double>(transW[k]) / transSum));

  std::vector<double> prev(static_cast<size_t>(N_STATES), std::log(1.0 / N_STATES));
  std::vector<double> cur(static_cast<size_t>(N_STATES));
  std::vector<std::vector<int32_t>> back;
  std::vector<std::vector<float>> frameHz;
  back.reserve(static_cast<size_t>(frames));
  frameHz.reserve(static_cast<size_t>(frames));
  const double logStay = std::log(1 - SWITCH_PROB);
  const double logSwitch = std::log(SWITCH_PROB);

  std::vector<float> em(static_cast<size_t>(N_BINS));
  for (int fi = 0; fi < frames; fi++) {
    if (progress != nullptr && progress->cancelled()) {
      *cancelled = true;
      return {};
    }
    const std::vector<Trough> troughs = findTroughs(dec.data() + static_cast<size_t>(fi) * hop, win, sr);
    const Emissions emis = frameEmissions(troughs);

    std::fill(em.begin(), em.end(), 0.0f);
    std::vector<float> binHz(static_cast<size_t>(N_BINS), 0.0f);
    for (size_t i = 0; i < troughs.size(); i++) {
      const double hz = troughs[i].f0;
      if (hz < FMIN || hz > FMAX) continue;
      const int b = binOfHz(hz);
      if (b < 0 || b >= N_BINS) continue;
      const size_t bi = static_cast<size_t>(b);
      if (emis.probs[i] > em[bi]) binHz[bi] = static_cast<float>(hz);
      em[bi] = static_cast<float>(static_cast<double>(em[bi]) + static_cast<double>(emis.probs[i]));
    }
    frameHz.push_back(binHz);
    const double logEmU = std::log(std::max(1e-8, (1 - emis.voicedP) / N_BINS));

    std::fill(cur.begin(), cur.end(), LOG0);
    std::vector<int32_t> bk(static_cast<size_t>(N_STATES), 0);
    for (int d = 0; d < N_BINS; d++) {
      const double logEmV = std::log(std::max(1e-8, static_cast<double>(em[static_cast<size_t>(d)])));
      double bestV = LOG0;
      int bestVi = 0;
      double bestU = LOG0;
      int bestUi = 0;
      const int lo = std::max(0, d - band);
      const int hi = std::min(N_BINS - 1, d + band);
      for (int s = lo; s <= hi; s++) {
        const double w = static_cast<double>(logTransW[static_cast<size_t>(d - s + band)]);
        const double pv = prev[static_cast<size_t>(s)] + w;
        if (pv > bestV) {
          bestV = pv;
          bestVi = s;
        }
        const double pu = prev[static_cast<size_t>(N_BINS + s)] + w;
        if (pu > bestU) {
          bestU = pu;
          bestUi = N_BINS + s;
        }
      }
      const double toVfromV = bestV + logStay;
      const double toVfromU = bestU + logSwitch;
      const size_t di = static_cast<size_t>(d);
      if (toVfromV >= toVfromU) {
        cur[di] = toVfromV + logEmV;
        bk[di] = bestVi;
      } else {
        cur[di] = toVfromU + logEmV;
        bk[di] = bestUi;
      }
      const double toUfromU = bestU + logStay;
      const double toUfromV = bestV + logSwitch;
      const size_t ui = static_cast<size_t>(N_BINS + d);
      if (toUfromU >= toUfromV) {
        cur[ui] = toUfromU + logEmU;
        bk[ui] = bestUi;
      } else {
        cur[ui] = toUfromV + logEmU;
        bk[ui] = bestVi;
      }
    }
    double mx = LOG0;
    for (int s = 0; s < N_STATES; s++)
      if (cur[static_cast<size_t>(s)] > mx) mx = cur[static_cast<size_t>(s)];
    for (int s = 0; s < N_STATES; s++) cur[static_cast<size_t>(s)] -= mx;
    back.push_back(std::move(bk));
    std::swap(prev, cur);

    if (fi % 250 == 0 && progress != nullptr)
      progress->report("melody", frames == 0 ? 1.0f : static_cast<float>(fi) / static_cast<float>(frames));
  }

  std::vector<float> f0(static_cast<size_t>(frames), 0.0f);
  if (frames > 0) {
    int s = 0;
    for (int i = 1; i < N_STATES; i++)
      if (prev[static_cast<size_t>(i)] > prev[static_cast<size_t>(s)]) s = i;
    for (int fi = frames - 1; fi >= 0; fi--) {
      if (s < N_BINS) {
        const float hz = frameHz[static_cast<size_t>(fi)][static_cast<size_t>(s)];
        f0[static_cast<size_t>(fi)] =
            hz > 0 ? hz : static_cast<float>(FMIN * std::pow(2.0, static_cast<double>(s) / (12 * BINS_PER_ST)));
      }
      s = back[static_cast<size_t>(fi)][static_cast<size_t>(s)];
    }
  }
  return f0;
}

// ---- pitch-core.ts --------------------------------------------------------
constexpr int DECIM = 3;
constexpr int WIN = 1024;
constexpr double HOP_SEC = 0.025;  // analysis hop in seconds (hop = round(sr * HOP_SEC))
constexpr int MIN_RUN = 4;         // a real note holds for at least this many frames (~100 ms)

inline double centsOf(double hz) { return 1200 * std::log2(hz / 55); }
inline double hzOf(double cents) { return 55 * std::pow(2.0, cents / 1200); }

// JS `vals.sort((a,b) => a-b)` then `vals[floor(len/2)]`.
double medianOf(std::vector<double> vals) {
  std::sort(vals.begin(), vals.end());
  return vals[vals.size() / 2];
}

// pYIN's Viterbi already owns the voicing and octave decisions; what remains
// here is stem reality: demucs vocal stems carry bleed and reverb tails that
// are genuinely periodic at −50 dB and CMND is level-blind, so frames with no
// vocal energy must be gated by RMS, not by periodicity. Pitch repairs stay
// local and conservative — sung melodies legitimately span octaves (G2–D5 in
// one song), so any "pull toward the melody's center" rule rewrites correct
// climax notes; only isolated frames that disagree with an internally
// consistent neighborhood get refolded, and outlier runs are dropped only
// when they are also quiet (bleed and harmonic locks are weak; a belted top
// note is not).
std::vector<float> cleanMelody(const std::vector<float>& raw, const std::vector<float>& rms) {
  const size_t n = raw.size();
  std::vector<float> out(n, 0.0f);

  // Silence gate: 2% of the loud-singing level (p95). Confirmed hallucinations
  // sit at 0.4–0.9% of p95, the softest real singing at 4.5%+.
  std::vector<double> sorted(rms.begin(), rms.end());
  std::sort(sorted.begin(), sorted.end());
  const double p95 = sorted.empty() ? 0 : sorted[static_cast<size_t>(std::floor(sorted.size() * 0.95))];
  const double gate = std::max(5e-4, p95 * 0.02);

  std::vector<float> cents(n, 0.0f);
  for (size_t i = 0; i < n; i++)
    cents[i] = raw[i] > 0 && rms[i] >= gate ? static_cast<float>(centsOf(raw[i])) : 0.0f;

  // Refold isolated octave blips: a frame ≥700 cents from its neighborhood
  // median, where the neighbors agree among themselves (spread < 300) and an
  // octave shift lands inside them. A real octave leap never qualifies — its
  // neighborhood straddles both octaves, so the spread check fails.
  const int NB = 5;
  const int ni = static_cast<int>(n);
  for (int i = 0; i < ni; i++) {
    const size_t ii = static_cast<size_t>(i);
    if (cents[ii] <= 0) continue;
    std::vector<double> nb;
    for (int j = std::max(0, i - NB); j < std::min(ni, i + NB + 1); j++) {
      if (j != i && cents[static_cast<size_t>(j)] > 0) nb.push_back(cents[static_cast<size_t>(j)]);
    }
    if (nb.size() < 4) continue;
    std::sort(nb.begin(), nb.end());
    if (nb.back() - nb.front() >= 300) continue;
    const double ref = nb[nb.size() / 2];
    if (std::fabs(static_cast<double>(cents[ii]) - ref) <= 700) continue;
    for (const double shift : {-2400.0, -1200.0, 1200.0, 2400.0}) {
      if (std::fabs(static_cast<double>(cents[ii]) + shift - ref) < 300) {
        cents[ii] = static_cast<float>(static_cast<double>(cents[ii]) + shift);
        break;
      }
    }
  }

  // Collect voiced runs, then keep only the credible ones.
  std::vector<std::pair<int, int>> runs;
  int start = -1;
  for (int i = 0; i <= ni; i++) {
    const bool voiced = i < ni && cents[static_cast<size_t>(i)] > 0;
    if (voiced && start == -1) start = i;
    if (!voiced && start != -1) {
      runs.push_back({start, i});
      start = -1;
    }
  }

  std::vector<double> allVoiced;
  for (size_t i = 0; i < n; i++)
    if (cents[i] > 0) allVoiced.push_back(cents[i]);
  std::sort(allVoiced.begin(), allVoiced.end());
  const double globalMed = allVoiced.empty() ? 0 : allVoiced[allVoiced.size() / 2];

  const int ctxFrames = static_cast<int>(jsRound(3 / HOP_SEC));
  for (const auto& run : runs) {
    const int s = run.first;
    const int e = run.second;
    if (e - s < MIN_RUN) continue;
    const double lenSec = (e - s) * HOP_SEC;
    std::vector<double> runVals;
    for (int j = s; j < e; j++) runVals.push_back(cents[static_cast<size_t>(j)]);
    const double m = medianOf(std::move(runVals));
    std::vector<double> runRms(rms.begin() + s, rms.begin() + e);
    const bool quiet = medianOf(std::move(runRms)) < p95 * 0.25;
    if (quiet && globalMed > 0 && lenSec < 1.0 && m - globalMed > 1500) continue;
    if (quiet && lenSec < 0.6) {
      std::vector<double> ctx;
      for (int j = std::max(0, s - ctxFrames); j < std::min(ni, e + ctxFrames); j++) {
        if (cents[static_cast<size_t>(j)] > 0 && (j < s || j >= e)) ctx.push_back(cents[static_cast<size_t>(j)]);
      }
      if (ctx.size() >= 12 && std::fabs(m - medianOf(std::move(ctx))) > 650) continue;
    }
    for (int j = s; j < e; j++) out[static_cast<size_t>(j)] = static_cast<float>(hzOf(cents[static_cast<size_t>(j)]));
  }
  return out;
}

}  // namespace

// Decimate, track (pYIN), frame-RMS, clean — trackMelodyCore's body.
MelodyTrack trackMelody(const float* mono, size_t n, double sampleRate, const Progress* progress) {
  MelodyTrack t;
  const double sr = sampleRate / DECIM;

  // average-pooling decimation — plenty for pitch, 3x less work
  const size_t dn = n / DECIM;
  std::vector<float> dec(dn);
  for (size_t i = 0; i < dn; i++) {
    const size_t j = i * DECIM;
    dec[i] = static_cast<float>(
        ((static_cast<double>(mono[j]) + static_cast<double>(mono[j + 1])) + static_cast<double>(mono[j + 2])) / 3);
  }

  const int hop = static_cast<int>(jsRound(sr * HOP_SEC));
  bool cancelled = false;
  std::vector<float> raw = pyinTrack(dec, sr, WIN, hop, progress, &cancelled);
  if (cancelled) return t;

  // Same framing as pyinTrack, so rms[i] describes the window raw[i] came from.
  std::vector<float> rms(raw.size());
  for (size_t i = 0; i < raw.size(); i++) {
    const size_t s = i * static_cast<size_t>(hop);
    double acc = 0;
    for (size_t j = s; j < s + WIN; j++) acc += static_cast<double>(dec[j]) * static_cast<double>(dec[j]);
    rms[i] = static_cast<float>(std::sqrt(acc / WIN));
  }

  t.f0 = cleanMelody(raw, rms);
  t.raw = std::move(raw);
  t.rms = std::move(rms);
  t.hopSec = static_cast<double>(hop) / sr;
  return t;
}

}  // namespace singz

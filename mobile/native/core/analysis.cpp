// See analysis.h. Section headers name the TS function each block
// reproduces; the comments that earned their place on the desktop travel
// with the code.
#include "analysis.h"

#include <algorithm>
#include <cmath>
#include <limits>

// The same no-fused-multiply-add rule melody.cpp states, for the same reason:
// a contracted a*b+c rounds once where V8 rounds twice, and this file's whole
// claim is "rounds where the TS rounds".
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

const double MAJ[12] = {6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88};
const double MIN_[12] = {6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17};

// JS Math.round: half toward +∞.
inline double jsRound(double x) { return std::floor(x + 0.5); }

// ---- analysis.ts: monoAt44k -----------------------------------------------

// What monoAt44k will produce, without producing it — so the instrument sum
// can be sized before any conversion exists.
size_t resampledLength(const AnalysisStem& stem) {
  if (stem.sampleRate == ANALYSIS_SR) return stem.mono.size();
  return static_cast<size_t>(std::floor(stem.mono.size() / (stem.sampleRate / ANALYSIS_SR)));
}

// All channels averaged and resampled to ANALYSIS_SR (linear interpolation —
// plenty for energy/chroma features). The channel fold happened on the way in
// here (wav.h's reader), so this is the resample half; a stem already at
// 44.1 kHz is handed back untouched, exactly as the TS returns `mono`.
std::vector<float> monoAt44k(const AnalysisStem& stem) {
  if (stem.sampleRate == ANALYSIS_SR) return stem.mono;
  const double ratio = stem.sampleRate / ANALYSIS_SR;
  const size_t outN = static_cast<size_t>(std::floor(stem.mono.size() / ratio));
  std::vector<float> out(outN);
  for (size_t i = 0; i < outN; i++) {
    const double x = static_cast<double>(i) * ratio;
    const size_t k = static_cast<size_t>(std::floor(x));
    const double f = x - static_cast<double>(k);
    const double a = static_cast<double>(stem.mono[k]);
    const double b = k + 1 < stem.mono.size() ? static_cast<double>(stem.mono[k + 1]) : a;
    out[i] = static_cast<float>(a * (1 - f) + b * f);
  }
  return out;
}

// ---- analysis.ts: goertzel ------------------------------------------------
double goertzel(const std::vector<float>& data, size_t start, size_t end, double freq, double sr) {
  const int stride = 4;
  const double w = (2 * M_PI * freq) / (sr / stride);
  const double c = 2 * std::cos(w);
  double s0 = 0, s1 = 0, s2 = 0;
  for (size_t i = start; i < end; i += stride) {
    s0 = static_cast<double>(data[i]) + c * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - c * s1 * s2;
}

// ---- analysis.ts: correlate -----------------------------------------------
double correlate(const double hist[12], const double profile[12], int rot) {
  const int n = 12;
  double mh = 0, mp = 0;
  for (int i = 0; i < n; i++) {
    mh += hist[i];
    mp += profile[i];
  }
  mh /= n;
  mp /= n;
  double num = 0, dh = 0, dp = 0;
  for (int i = 0; i < n; i++) {
    const double a = hist[(i + rot) % 12] - mh;
    const double b = profile[i] - mp;
    num += a * b;
    dh += a * a;
    dp += b * b;
  }
  return dh > 0 && dp > 0 ? num / std::sqrt(dh * dp) : 0;
}

}  // namespace

std::vector<float> monoAt44kPublic(const AnalysisStem& stem) { return monoAt44k(stem); }

double goertzelPublic(const std::vector<float>& data, size_t start, size_t end, double freq, double sr) {
  return goertzel(data, start, end, freq, sr);
}

size_t resampledLengthPublic(const AnalysisStem& stem) { return resampledLength(stem); }

KeyGuess estimateKey(const float* f0, size_t n) {
  KeyGuess best;
  double hist[12] = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0};
  int voiced = 0;
  for (size_t i = 0; i < n; i++) {
    const double f = f0[i];
    if (f <= 0) continue;
    const double r = jsRound(69 + 12 * std::log2(f / 440));
    const int pc = static_cast<int>(std::fmod(std::fmod(r, 12) + 12, 12));
    hist[pc]++;
    voiced++;
  }
  if (voiced < 100) return best;
  double bestScore = -std::numeric_limits<double>::infinity();
  for (int pc = 0; pc < 12; pc++) {
    const double maj = correlate(hist, MAJ, pc);
    const double min = correlate(hist, MIN_, pc);
    if (maj > bestScore) {
      bestScore = maj;
      best = {pc, false, true};
    }
    if (min > bestScore) {
      bestScore = min;
      best = {pc, true, true};
    }
  }
  return best;
}

KeyGuess estimateKeyFromStems(const std::vector<AnalysisStem>& inst, const AnalysisStem* bass) {
  KeyGuess none;
  // The TS builds every converted stem first and then sums them; here each is
  // converted, added and dropped, so only ONE conversion is resident at a
  // time beside the sum. Same per-element order (stem 0, then 1, then 2, each
  // ascending), so the arithmetic is untouched — the TS can afford to keep
  // them because its monoAt44k hands back the buffer's own channel data for a
  // mono stem, where this side must copy. Worth ~160 MB on a five-minute
  // song, on a queue that may run beside a player holding the same song.
  std::vector<float> harm;
  if (!inst.empty()) {
    size_t len = 0;
    for (const AnalysisStem& s : inst) len = std::max(len, resampledLength(s));
    harm.assign(len, 0.0f);
    for (const AnalysisStem& s : inst) {
      const std::vector<float> p = monoAt44k(s);
      // Bounded by the ARRAY, not by resampledLength's prediction of it. The
      // two agree today and the resample branch is dead in this app (every
      // stem is 44.1 kHz), which is exactly why nothing would catch them
      // drifting apart — and the failure mode of a prediction that came in
      // low is a heap overwrite, not a wrong key.
      const size_t nAdd = std::min(p.size(), harm.size());
      for (size_t i = 0; i < nAdd; i++)
        harm[i] = static_cast<float>(static_cast<double>(harm[i]) + static_cast<double>(p[i]));
    }
  }
  std::vector<float> bassMono;
  const bool haveBass = bass != nullptr;
  if (haveBass) bassMono = monoAt44k(*bass);

  const double sr = ANALYSIS_SR;
  const size_t WIN = 16384;  // 0.37 s frames, contiguous — the Viterbi wants neighbours
  // basePc names the pitch class of baseHz: chroma bin 0 must be C no matter
  // where the sweep starts, or every answer comes out rotated (an E base read
  // as C shifted G-major songs to "D# major" before this was caught).
  auto collect = [&](const std::vector<float>& data, bool present, double baseHz, int basePc,
                     int semis) -> std::vector<std::vector<double>> {
    std::vector<std::vector<double>> chromas;
    if (present) {
      for (size_t a = 0; a + WIN <= data.size(); a += WIN) {
        std::vector<double> ch(12, 0.0);
        for (int s = 0; s < semis; s++)
          ch[static_cast<size_t>((basePc + s) % 12)] +=
              goertzel(data, a, a + WIN, baseHz * std::pow(2.0, s / 12.0), sr);
        chromas.push_back(std::move(ch));
      }
    }
    return chromas;
  };
  // Instruments: E2 up four octaves; bass: E1 up two — the register it names
  // roots in (fifths above would muddy the root vote).
  const std::vector<std::vector<double>> Ch = collect(harm, !inst.empty(), 82.41, 4, 48);
  const std::vector<std::vector<double>> Cb = collect(bassMono, haveBass, 41.2, 4, 24);
  const size_t n = std::max(Ch.size(), Cb.size());
  if (n < 8) return none;

  // 24 L2-normalized triad templates: root 1.0, third 0.8, fifth 0.9
  // (major 0-11, minor 12-23) — the phase-5a chord extractor's shapes.
  std::vector<std::vector<double>> T;
  for (const int third : {4, 3}) {
    for (int r = 0; r < 12; r++) {
      std::vector<double> t(12, 0.0);
      t[static_cast<size_t>(r)] = 1.0;
      t[static_cast<size_t>((r + third) % 12)] = 0.8;
      t[static_cast<size_t>((r + 7) % 12)] = 0.9;
      const double norm = std::sqrt(1 + 0.64 + 0.81);
      for (int i = 0; i < 12; i++) t[static_cast<size_t>(i)] /= norm;
      T.push_back(std::move(t));
    }
  }

  std::vector<std::vector<double>> emit;
  std::vector<bool> voiced;
  emit.reserve(n);
  voiced.reserve(n);
  for (size_t k = 0; k < n; k++) {
    std::vector<double> e(24, 0.0);
    bool heard = false;
    if (k < Ch.size()) {
      const std::vector<double>& ch = Ch[k];
      double norm = 0;
      for (int i = 0; i < 12; i++) norm += ch[static_cast<size_t>(i)] * ch[static_cast<size_t>(i)];
      norm = std::sqrt(norm);
      if (norm > 0) {
        heard = true;
        for (int j = 0; j < 24; j++) {
          double d = 0;
          for (int i = 0; i < 12; i++)
            d += (ch[static_cast<size_t>(i)] / norm) * T[static_cast<size_t>(j)][static_cast<size_t>(i)];
          e[static_cast<size_t>(j)] = d;
        }
      }
    }
    if (k < Cb.size()) {
      const std::vector<double>& cb = Cb[k];
      int root = -1;
      double best = 0;
      for (int i = 0; i < 12; i++)
        if (cb[static_cast<size_t>(i)] > best) {
          best = cb[static_cast<size_t>(i)];
          root = i;
        }
      if (root >= 0) {
        heard = true;
        e[static_cast<size_t>(root)] += 0.25;
        e[static_cast<size_t>(12 + root)] += 0.25;
      }
    }
    emit.push_back(std::move(e));
    voiced.push_back(heard);
  }
  int voicedCount = 0;
  for (const bool v : voiced)
    if (v) voicedCount++;
  if (voicedCount < 8) return none;

  // Sticky Viterbi, then duration-weighted chord occupancy.
  const double STAY = 0.35;
  std::vector<double> dp = emit[0];
  std::vector<std::vector<int8_t>> bp;
  bp.reserve(n > 0 ? n - 1 : 0);
  for (size_t k = 1; k < n; k++) {
    std::vector<double> nd(24, 0.0);
    std::vector<int8_t> row(24, 0);
    double stayBest = -std::numeric_limits<double>::infinity();
    int stayArg = 0;
    for (int j = 0; j < 24; j++)
      if (dp[static_cast<size_t>(j)] > stayBest) {
        stayBest = dp[static_cast<size_t>(j)];
        stayArg = j;
      }
    for (int j = 0; j < 24; j++) {
      const size_t jj = static_cast<size_t>(j);
      const double hold = dp[jj] + STAY;
      if (hold >= stayBest) {
        nd[jj] = emit[k][jj] + hold;
        row[jj] = static_cast<int8_t>(j);
      } else {
        nd[jj] = emit[k][jj] + stayBest;
        row[jj] = static_cast<int8_t>(stayArg);
      }
    }
    dp = std::move(nd);
    bp.push_back(std::move(row));
  }
  int cur = 0;
  for (int j = 1; j < 24; j++)
    if (dp[static_cast<size_t>(j)] > dp[static_cast<size_t>(cur)]) cur = j;
  std::vector<double> occ(24, 0.0);
  if (voiced[n - 1]) occ[static_cast<size_t>(cur)]++;
  for (size_t k = n - 1; k-- > 0;) {
    cur = bp[k][static_cast<size_t>(cur)];
    if (voiced[k]) occ[static_cast<size_t>(cur)]++;
  }
  for (int j = 0; j < 24; j++) occ[static_cast<size_t>(j)] /= voicedCount;

  // Each candidate key scores its diatonic chords by occupancy. Tonic triad
  // dominates by design; IV-major in minor keys is the dorian borrow every
  // other rock song makes (Zeit's C over a Gm tonic).
  auto M = [&](int pc) { return occ[static_cast<size_t>(((pc % 12) + 12) % 12)]; };
  auto m = [&](int pc) { return occ[static_cast<size_t>(12 + (((pc % 12) + 12) % 12))]; };
  KeyGuess best;
  double bestScore = -std::numeric_limits<double>::infinity();
  for (int t = 0; t < 12; t++) {
    const double major =
        3 * M(t) + 1.25 * M(t + 7) + m(t + 7) * 0.25 + M(t + 5) + 0.5 * (m(t + 2) + m(t + 4) + m(t + 9));
    const double minor = 3 * m(t) + 1.25 * M(t + 7) + 0.75 * m(t + 7) + m(t + 5) +
                         0.5 * (M(t + 5) + M(t + 3) + M(t + 8) + M(t + 10));
    if (major > bestScore) {
      bestScore = major;
      best = {t, false, true};
    }
    if (minor > bestScore) {
      bestScore = minor;
      best = {t, true, true};
    }
  }
  return best;
}

}  // namespace singz

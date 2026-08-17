// See courts.h. Section headers name the TS function each block reproduces.
#include "courts.h"

#include <algorithm>
#include <cmath>
#include <limits>

// Same no-FMA rule as the rest of the core — this file's whole claim is
// "rounds where the TS rounds".
#if defined(__clang__)
#pragma clang fp contract(off)
#elif defined(_MSC_VER)
#pragma fp_contract(off)
#elif defined(__GNUC__)
#pragma GCC optimize("fp-contract=off")
#endif

namespace singz {
namespace {

// The rate and frame geometry every chord/voice threshold was calibrated at.
constexpr double COURT_SR = 22050;
constexpr int NFFT = 4096;
constexpr int COURT_HOP = 1024;

/** JS `Math.round`: half away from zero for positives, which is what every
 *  call site here feeds it. Same helper the other core files use. */
inline double jsRound(double x) { return std::floor(x + 0.5); }

}  // namespace

// ---- courts.ts: to22k ------------------------------------------------------

std::vector<float> to22k(const std::vector<float>& x) {
  const size_t n = x.size() >> 1;
  std::vector<float> out(n);
  for (size_t i = 0; i < n; i++)
    out[i] = static_cast<float>((static_cast<double>(x[2 * i]) + static_cast<double>(x[2 * i + 1])) / 2);
  return out;
}

// ---- courts.ts: fftComplex -------------------------------------------------

void fftComplex(std::vector<double>& re, std::vector<double>& im) {
  const size_t n = re.size();
  for (size_t i = 1, j = 0; i < n; i++) {
    size_t bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      std::swap(re[i], re[j]);
      std::swap(im[i], im[j]);
    }
  }
  for (size_t len = 2; len <= n; len <<= 1) {
    const double ang = (-2 * M_PI) / static_cast<double>(len);
    const double wr = std::cos(ang);
    const double wi = std::sin(ang);
    for (size_t i = 0; i < n; i += len) {
      double cr = 1;
      double ci = 0;
      for (size_t k = 0; k < len / 2; k++) {
        const double ur = re[i + k];
        const double ui = im[i + k];
        const double vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const double vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const double ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

// ---- courts.ts: chromaFrames ----------------------------------------------

std::vector<std::vector<float>> chromaFrames(const std::vector<float>& x, double loHz, double hiHz) {
  std::vector<float> win(NFFT);
  for (int i = 0; i < NFFT; i++)
    win[static_cast<size_t>(i)] = static_cast<float>(0.5 - 0.5 * std::cos((2 * M_PI * i) / NFFT));
  // Int16Array(-1) in the TS: the pitch class of each bin, or -1 for bins
  // outside the band.
  std::vector<int> pc(static_cast<size_t>(NFFT / 2 + 1), -1);
  for (int k = 1; k <= NFFT / 2; k++) {
    const double f = (k * COURT_SR) / NFFT;
    if (f >= loHz && f < hiHz) {
      const double semi = jsRound(12 * std::log2(f / 440) + 69);
      // JS `%` truncates toward zero, so the ((x % 12) + 12) % 12 idiom is
      // needed for negatives on both sides; C++ `%` truncates the same way,
      // but `semi` is a double here so fmod is what matches.
      const double m = std::fmod(semi, 12.0);
      pc[static_cast<size_t>(k)] = static_cast<int>(std::fmod(m + 12, 12.0));
    }
  }
  const long long frames =
      std::max(0LL, 1 + (static_cast<long long>(x.size()) - NFFT) / COURT_HOP);
  // `1 + Math.floor((len - NFFT) / HOP)` is negative-safe in JS via Math.max;
  // C++ integer division truncates toward zero, so a short buffer would give
  // a wrong (too large) count without the explicit guard below.
  const long long n = static_cast<long long>(x.size()) < NFFT ? 0 : frames;
  std::vector<std::vector<float>> out;
  out.reserve(static_cast<size_t>(std::max(0LL, n)));
  std::vector<double> re(NFFT), im(NFFT);
  for (long long f = 0; f < n; f++) {
    for (int i = 0; i < NFFT; i++) {
      re[static_cast<size_t>(i)] =
          static_cast<double>(x[static_cast<size_t>(f) * COURT_HOP + static_cast<size_t>(i)]) *
          static_cast<double>(win[static_cast<size_t>(i)]);
      im[static_cast<size_t>(i)] = 0;
    }
    fftComplex(re, im);
    std::vector<float> c(12, 0.0f);
    for (int k = 1; k <= NFFT / 2; k++) {
      const int p = pc[static_cast<size_t>(k)];
      if (p >= 0)
        c[static_cast<size_t>(p)] = static_cast<float>(
            static_cast<double>(c[static_cast<size_t>(p)]) +
            std::log1p(std::hypot(re[static_cast<size_t>(k)], im[static_cast<size_t>(k)])));
    }
    out.push_back(std::move(c));
  }
  return out;
}

// ---- courts.ts: beatSyncChroma --------------------------------------------

std::vector<std::vector<float>> beatSyncChroma(const std::vector<std::vector<float>>& chroma,
                                               const std::vector<double>& beats) {
  const double fps = COURT_SR / COURT_HOP;
  std::vector<std::vector<float>> out;
  for (size_t i = 0; i + 1 < beats.size(); i++) {
    const long long a = static_cast<long long>(std::floor(beats[i] * fps));
    const long long b = std::max(a + 1, static_cast<long long>(std::floor(beats[i + 1] * fps)));
    std::vector<float> v(12, 0.0f);
    int n = 0;
    for (long long f = a; f < std::min(b, static_cast<long long>(chroma.size())); f++) {
      if (f < 0) continue;  // a negative beat time cannot index the TS's array either
      for (size_t k = 0; k < 12; k++)
        v[k] = static_cast<float>(static_cast<double>(v[k]) +
                                  static_cast<double>(chroma[static_cast<size_t>(f)][k]));
      n++;
    }
    double norm = 0;
    for (size_t k = 0; k < 12; k++) norm += static_cast<double>(v[k]) * static_cast<double>(v[k]);
    norm = std::sqrt(norm);
    if (n > 0 && norm > 0)
      for (size_t k = 0; k < 12; k++) v[k] = static_cast<float>(static_cast<double>(v[k]) / norm);
    out.push_back(std::move(v));
  }
  return out;
}

// ---- courts.ts: chordRuns --------------------------------------------------

std::vector<ChordSeg> chordRuns(const std::vector<std::vector<float>>& Ch,
                                const std::vector<std::vector<float>>& Cb, const std::vector<double>& beats) {
  // Only 8 of these 24 labels are ever produced by the sample corpus — a
  // reviewer permuted the other 16 and the gate stayed green, correctly, since
  // downstream only equality-compares a label. Unwitnessed rather than broken,
  // and worth knowing before anyone reads a passing gate as covering them.
  static const char* kNames[24] = {"C",  "C#", "D",  "D#", "E",  "F",  "F#", "G",  "G#", "A",  "A#", "B",
                                   "Cm", "C#m", "Dm", "D#m", "Em", "Fm", "F#m", "Gm", "G#m", "Am", "A#m", "Bm"};
  // 12 major then 12 minor templates, L2-normalised — float storage, as the TS
  // holds them in Float32Arrays.
  std::vector<std::vector<float>> T;
  for (int r = 0; r < 12; r++) {
    std::vector<float> t(12, 0.0f);
    t[static_cast<size_t>(r)] = 1.0f;
    t[static_cast<size_t>((r + 4) % 12)] = 0.8f;
    t[static_cast<size_t>((r + 7) % 12)] = 0.9f;
    T.push_back(std::move(t));
  }
  for (int r = 0; r < 12; r++) {
    std::vector<float> t(12, 0.0f);
    t[static_cast<size_t>(r)] = 1.0f;
    t[static_cast<size_t>((r + 3) % 12)] = 0.8f;
    t[static_cast<size_t>((r + 7) % 12)] = 0.9f;
    T.push_back(std::move(t));
  }
  for (std::vector<float>& t : T) {
    double n = 0;
    for (size_t k = 0; k < 12; k++) n += static_cast<double>(t[k]) * static_cast<double>(t[k]);
    n = std::sqrt(n);
    for (size_t k = 0; k < 12; k++) t[k] = static_cast<float>(static_cast<double>(t[k]) / n);
  }
  const size_t n = Ch.size();
  if (n == 0) return {};
  std::vector<std::vector<double>> emit;
  emit.reserve(n);
  for (size_t i = 0; i < n; i++) {
    std::vector<double> e(24, 0.0);
    for (size_t j = 0; j < 24; j++) {
      double d = 0;
      for (size_t k = 0; k < 12; k++) d += static_cast<double>(Ch[i][k]) * static_cast<double>(T[j][k]);
      e[j] = d;
    }
    int root = -1;
    double best = 0;
    // Bounded by Cb, not by Ch. Every caller passes two beatSyncChroma results
    // over the SAME lattice so the lengths match — but where the TS would
    // throw on a short Cb, this side would read off the end, and a silent bad
    // read is worse than a throw. (The `s < beats.size()` guard further down
    // is unreachable for the same structural reason; this is the index that
    // could ever matter.)
    const bool haveBass = i < Cb.size() && Cb[i].size() >= 12;
    for (size_t k = 0; haveBass && k < 12; k++) {
      if (static_cast<double>(Cb[i][k]) > best) {
        best = static_cast<double>(Cb[i][k]);
        root = static_cast<int>(k);
      }
    }
    if (root >= 0 && best > 0) {
      e[static_cast<size_t>(root)] += 0.25;
      e[static_cast<size_t>(12 + root)] += 0.25;
    }
    emit.push_back(std::move(e));
  }
  const double STAY = 0.35;
  std::vector<double> dp = emit[0];
  std::vector<std::vector<signed char>> bp;
  for (size_t i = 1; i < n; i++) {
    std::vector<double> nd(24, 0.0);
    std::vector<signed char> row(24, 0);
    for (size_t j = 0; j < 24; j++) {
      int bj = -1;
      double bv = -std::numeric_limits<double>::infinity();
      // Strict `>`, so the FIRST maximum wins and k ascends — the TS's tie
      // rule, and a tie is common on a held chord where the stay bonus is the
      // only thing separating two states.
      for (size_t k = 0; k < 24; k++) {
        const double v = dp[k] + (k == j ? STAY : 0);
        if (v > bv) {
          bv = v;
          bj = static_cast<int>(k);
        }
      }
      nd[j] = emit[i][j] + bv;
      row[j] = static_cast<signed char>(bj);
    }
    dp = std::move(nd);
    bp.push_back(std::move(row));
  }
  std::vector<int> path(n, 0);
  size_t cur = 0;
  for (size_t j = 1; j < 24; j++)
    if (dp[j] > dp[cur]) cur = j;
  path[n - 1] = static_cast<int>(cur);
  for (size_t i = n - 1; i-- > 0;) path[i] = bp[i][static_cast<size_t>(path[i + 1])];
  std::vector<ChordSeg> runs;
  size_t s = 0;
  for (size_t i = 1; i <= n; i++) {
    if (i == n || path[i] != path[s]) {
      runs.push_back({kNames[path[s]], s < beats.size() ? beats[s] : 0.0, static_cast<int>(i - s)});
      s = i;
    }
  }
  return runs;
}

// ---- courts.ts: rmsEnvelope ------------------------------------------------

RmsEnvelope rmsEnvelope(const std::vector<float>& buf) {
  RmsEnvelope out;
  out.fps = COURT_SR / COURT_HOP;
  const long long n =
      static_cast<long long>(buf.size()) < NFFT
          ? 0
          : 1 + (static_cast<long long>(buf.size()) - NFFT) / COURT_HOP;
  out.rms.assign(static_cast<size_t>(std::max(0LL, n)), 0.0f);
  for (long long f = 0; f < n; f++) {
    double s = 0;
    for (int i = 0; i < NFFT; i += 4) {
      const double v = static_cast<double>(buf[static_cast<size_t>(f) * COURT_HOP + static_cast<size_t>(i)]);
      s += v * v;
    }
    out.rms[static_cast<size_t>(f)] = static_cast<float>(std::sqrt(s / (NFFT / 4)));
  }
  std::vector<double> sorted;
  sorted.reserve(out.rms.size());
  for (const float v : out.rms) sorted.push_back(static_cast<double>(v));
  std::sort(sorted.begin(), sorted.end());
  const size_t at = static_cast<size_t>(std::floor(static_cast<double>(sorted.size()) * 0.95));
  // `sorted[...] || 0` — JS's `||` is falsy-based, so it also swallows NaN
  // and -0, not merely an out-of-range read.
  const double v = at < sorted.size() ? sorted[at] : 0.0;
  out.p95 = (v != 0 && !std::isnan(v)) ? v : 0.0;
  return out;
}

// ---- courts.ts: medianOf / phraseSegments ---------------------------------

namespace {

double medianOf(const std::vector<double>& xs) {
  std::vector<double> s = xs;
  std::sort(s.begin(), s.end());
  return s.empty() ? std::numeric_limits<double>::quiet_NaN() : s[s.size() >> 1];
}

struct PhraseSeg {
  double a, b, gapSec;
};

/** Voiced stretches, merged across sub-0.3-beat gaps, kept when the silence
 *  AFTER them is at least `minGap`. */
std::vector<PhraseSeg> phraseSegments(const RmsEnvelope& env, double med, double minGap) {
  const std::vector<float>& rms = env.rms;
  const double fps = env.fps;
  const long long n = static_cast<long long>(rms.size());
  const double thr = 0.08 * env.p95;
  std::vector<std::pair<long long, long long>> voiced;
  long long s0 = -1;
  for (long long f = 0; f <= n; f++) {
    const bool on = f < n && static_cast<double>(rms[static_cast<size_t>(f)]) > thr;
    if (on && s0 < 0) s0 = f;
    if (!on && s0 >= 0) {
      voiced.push_back({s0, f});
      s0 = -1;
    }
  }
  std::vector<std::pair<long long, long long>> merged;
  for (const auto& seg : voiced) {
    if (!merged.empty() && (static_cast<double>(seg.first - merged.back().second)) / fps < 0.3 * med)
      merged.back().second = seg.second;
    else
      merged.push_back(seg);
  }
  std::vector<PhraseSeg> segs;
  for (size_t k = 0; k < merged.size(); k++) {
    const long long a = merged[k].first, b = merged[k].second;
    const long long nextA = k + 1 < merged.size() ? merged[k + 1].first : n;
    const double gapSec = static_cast<double>(nextA - b) / fps;
    if (gapSec >= minGap) segs.push_back({static_cast<double>(a) / fps, static_cast<double>(b) / fps, gapSec});
  }
  return segs;
}

}  // namespace

// ---- courts.ts: vocalEvidence ---------------------------------------------

std::vector<VoiceHit> vocalEvidence(const RmsEnvelope& env, const std::vector<double>& beats,
                                    const std::vector<std::pair<double, double>>* words) {
  std::vector<double> iv;
  for (size_t i = 1; i < beats.size(); i++) iv.push_back(beats[i] - beats[i - 1]);
  const double med = medianOf(iv);
  const double minHold = 1.2 * med;
  const double minGap = 1.5 * med;
  const std::vector<float>& rms = env.rms;
  const double fps = env.fps;
  std::vector<VoiceHit> out;

  if (words && !words->empty()) {
    // Stable, like JS sort since ES2019 — words sharing a start keep their
    // original order, which the dedup key below is sensitive to.
    std::vector<std::pair<double, double>> ws = *words;
    std::stable_sort(ws.begin(), ws.end(),
                     [](const std::pair<double, double>& a, const std::pair<double, double>& b) {
                       return a.first < b.first;
                     });
    const double thr = 0.08 * env.p95;
    std::vector<long long> seen;  // the TS's Set, in insertion order
    for (size_t i = 0; i < ws.size(); i++) {
      const double nextS =
          i + 1 < ws.size() ? ws[i + 1].first : std::numeric_limits<double>::infinity();
      const double gapToNext = nextS - ws[i].first;
      if (gapToNext < 2.5 * med) continue;
      const long long a = static_cast<long long>(jsRound(ws[i].first * fps));
      const double capT = std::min(ws[i].first + 8, i + 1 < ws.size() ? ws[i + 1].first : ws[i].first + 8);
      const long long cap = static_cast<long long>(jsRound(capT * fps));
      long long end = a;
      long long quiet = 0;
      for (long long f = a; f < std::min(cap, static_cast<long long>(rms.size())); f++) {
        if (f < 0) continue;
        if (static_cast<double>(rms[static_cast<size_t>(f)]) > thr) {
          end = f;
          quiet = 0;
        } else if (static_cast<double>(++quiet) * (1 / fps) > 0.3 * med) {
          break;
        }
      }
      const double hold = static_cast<double>(end - a) / fps;
      const bool sectionFinal = gapToNext >= 8 * med;
      if (hold < minHold && !sectionFinal) continue;
      const long long key = static_cast<long long>(jsRound(ws[i].first * 10));
      if (std::find(seen.begin(), seen.end(), key) == seen.end()) {
        seen.push_back(key);
        out.push_back({jsRound(ws[i].first * 100) / 100, jsRound(hold * 100) / 100,
                       // Infinity/100 is Infinity in JS too, so a final word
                       // with no successor keeps an infinite gap rather than
                       // rounding to something finite.
                       std::isinf(gapToNext) ? gapToNext : jsRound(gapToNext * 100) / 100});
      }
    }
    return out;
  }

  // no lyrics: energy segments, last-rise hold detection
  const std::vector<PhraseSeg> segs = phraseSegments(env, med, minGap);
  for (const PhraseSeg& seg : segs) {
    const long long a = static_cast<long long>(jsRound(seg.a * fps));
    const long long b = static_cast<long long>(jsRound(seg.b * fps));
    long long lastRise = a;
    for (long long f = a + 2; f < b; f++) {
      if (f < 2 || f >= static_cast<long long>(rms.size())) continue;
      const double v = static_cast<double>(rms[static_cast<size_t>(f)]);
      if (v > 1.6 * static_cast<double>(rms[static_cast<size_t>(f - 2)]) && v > 0.25 * env.p95) lastRise = f;
    }
    const double holdSec = static_cast<double>(b - lastRise) / fps;
    if (holdSec >= minHold)
      out.push_back({jsRound((static_cast<double>(lastRise) / fps) * 100) / 100, jsRound(holdSec * 100) / 100,
                     jsRound(seg.gapSec * 100) / 100});
  }
  return out;
}

// ---- courts.ts: formSeams -------------------------------------------------

std::vector<double> formSeams(const std::vector<std::vector<float>>& Ch, const RmsEnvelope& vocalEnv,
                              const std::vector<double>& beats) {
  const std::vector<float>& rms = vocalEnv.rms;
  const double fps = vocalEnv.fps;
  const long long n0 = static_cast<long long>(rms.size());
  const double thr = 0.08 * vocalEnv.p95;
  std::vector<float> vocal(Ch.size(), 0.0f);
  for (size_t i = 0; i + 1 < beats.size(); i++) {
    if (i >= vocal.size()) break;
    const long long a = static_cast<long long>(std::floor(beats[i] * fps));
    const long long b = std::max(a + 1, static_cast<long long>(std::floor(beats[i + 1] * fps)));
    long long on = 0, tot = 0;
    for (long long f = a; f < std::min(b, n0); f++) {
      if (f < 0) continue;
      tot++;
      if (static_cast<double>(rms[static_cast<size_t>(f)]) > thr) on++;
    }
    vocal[i] = tot ? static_cast<float>(static_cast<double>(on) / static_cast<double>(tot)) : 0.0f;
  }
  const double W = 0.35;
  // Half-bar chroma: two beats stacked, with the vocal activity of each
  // appended as dimensions 24 and 25 — so a section that changes only in
  // whether anyone is singing still registers as novelty.
  std::vector<std::vector<float>> hb;
  std::vector<double> hbT;
  for (size_t h = 0; h + 1 < Ch.size(); h += 2) {
    std::vector<float> v(26, 0.0f);
    for (size_t k = 0; k < 12; k++) {
      v[k] = Ch[h][k];
      v[12 + k] = Ch[h + 1][k];
    }
    v[24] = static_cast<float>(W * static_cast<double>(vocal[h]));
    v[25] = static_cast<float>(W * static_cast<double>(vocal[h + 1]));
    double norm = 0;
    for (size_t k = 0; k < 26; k++) norm += static_cast<double>(v[k]) * static_cast<double>(v[k]);
    norm = std::sqrt(norm);
    if (norm > 0)
      for (size_t k = 0; k < 26; k++) v[k] = static_cast<float>(static_cast<double>(v[k]) / norm);
    hb.push_back(std::move(v));
    hbT.push_back(h < beats.size() ? beats[h] : 0.0);
  }
  const long long n = static_cast<long long>(hb.size());
  const auto cosim = [&](long long a, long long b) {
    double s = 0;
    for (size_t k = 0; k < 26; k++)
      s += static_cast<double>(hb[static_cast<size_t>(a)][k]) * static_cast<double>(hb[static_cast<size_t>(b)][k]);
    return s;
  };
  const long long K = 8;
  std::vector<float> nov(static_cast<size_t>(std::max(0LL, n)), 0.0f);
  for (long long h = K; h < n - K; h++) {
    double within = 0, cross = 0;
    long long nw = 0, nc = 0;
    for (long long i = 0; i < K; i++) {
      for (long long j = 0; j < K; j++) {
        cross += cosim(h - 1 - i, h + j);
        nc++;
        if (i < j) {
          within += cosim(h - 1 - i, h - 1 - j) + cosim(h + i, h + j);
          nw += 2;
        }
      }
    }
    nov[static_cast<size_t>(h)] =
        static_cast<float>((nw ? within / static_cast<double>(nw) : 0) - (nc ? cross / static_cast<double>(nc) : 0));
  }
  std::vector<double> vals;
  for (const float x : nov)
    if (static_cast<double>(x) != 0) vals.push_back(static_cast<double>(x));
  double sum = 0;
  for (const double v : vals) sum += v;
  const double mean = sum / (vals.empty() ? 1.0 : static_cast<double>(vals.size()));
  double sq = 0;
  for (const double v : vals) sq += (v - mean) * (v - mean);
  const double sd = std::sqrt(sq / (vals.empty() ? 1.0 : static_cast<double>(vals.size())));
  std::vector<double> seams;
  for (long long h = K; h < n - K; h++) {
    if (static_cast<double>(nov[static_cast<size_t>(h)]) < mean + sd) continue;
    bool isPeak = true;
    for (long long d = 1; d <= K; d++) {
      if ((h - d >= 0 && nov[static_cast<size_t>(h - d)] > nov[static_cast<size_t>(h)]) ||
          (h + d < n && nov[static_cast<size_t>(h + d)] > nov[static_cast<size_t>(h)])) {
        isPeak = false;
        break;
      }
    }
    if (isPeak) seams.push_back(hbT[static_cast<size_t>(h)]);
  }
  return seams;
}

}  // namespace singz

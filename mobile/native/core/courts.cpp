// See courts.h. Section headers name the TS function each block reproduces.
#include "courts.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <functional>
#include <limits>
#include <sstream>

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
        // NOT behaviour-preserving if it ever fired: the TS would read
        // undefined here and still increment `quiet`, where this skips. It
        // cannot fire — `a` comes from a lyrics word start, which is never
        // negative — so this is a bounds belt, not a port decision.
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
      // Same shape, same reasoning as the guard in vocalEvidence: the TS would
      // count `tot++` on an out-of-range frame and this skips it. Unreachable
      // because the backcast walk breaks at `next < 0.25`, so no beat is
      // negative.
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

// ---- courts.ts: buildCourtEvidence ----------------------------------------

CourtEvidence buildCourtEvidence(const CourtGrid& det, const CourtSources& src) {
  CourtEvidence ev;
  const double latPer = 60 / det.bpm;
  const std::vector<double>& lattice = det.beats;
  const auto r3 = [](double x) { return jsRound(x * 1000) / 1000; };
  const auto r2 = [](double x) { return jsRound(x * 100) / 100; };

  // The chord layer needs at least one harmonic stem AND the bass root-namer.
  // Converted one at a time rather than all at once: the TS can hold every
  // to22k result because its monoAt44k hands back the buffer's own data, and
  // this side must copy — the same ~30 MB-per-song-minute lesson analysis.cpp
  // and beats.cpp both had to learn.
  std::vector<std::vector<float>> Ch;
  bool haveCh = false;
  if (src.harm && !src.harm->empty()) {
    std::vector<float> harmSum = to22k(monoAt44kPublic((*src.harm)[0]));
    for (size_t s = 1; s < src.harm->size(); s++) {
      const std::vector<float> y = to22k(monoAt44kPublic((*src.harm)[s]));
      const size_t m = std::min(harmSum.size(), y.size());
      std::vector<float> sum(m);
      for (size_t i = 0; i < m; i++)
        sum[i] = static_cast<float>(static_cast<double>(harmSum[i]) + static_cast<double>(y[i]));
      harmSum = std::move(sum);
    }
    Ch = beatSyncChroma(chromaFrames(harmSum, 55, 2000), lattice);
    haveCh = true;
    harmSum.clear();
    harmSum.shrink_to_fit();
    if (src.bass) {
      // Scoped so the 22k copy dies before chordRuns runs — ~26 MB that has no
      // reader past the chroma.
      const std::vector<std::vector<float>> Cb = [&] {
        const std::vector<float> bass22 = to22k(monoAt44kPublic(*src.bass));
        return beatSyncChroma(chromaFrames(bass22, 41, 400), lattice);
      }();
      for (const ChordSeg& r : chordRuns(Ch, Cb, lattice))
        ev.runs.push_back({r3(r.t), r3(r.len * latPer), r.name});
    }
  }
  if (src.vocals) {
    const RmsEnvelope env = [&] {
      const std::vector<float> vocals22 = to22k(monoAt44kPublic(*src.vocals));
      return rmsEnvelope(vocals22);
    }();
    for (const VoiceHit& v : vocalEvidence(env, lattice, src.words.empty() ? nullptr : &src.words))
      ev.voice.push_back({r3(v.t), r2(v.gapSec)});
    if (haveCh)
      for (const double t : formSeams(Ch, env, lattice)) ev.seams.push_back(r3(t));
  }
  for (const auto& w : src.words) ev.words.push_back({r2(w.first), r2(w.second)});
  // `notes` stays empty — the app has no polyphonic transcriber and the TS
  // passes [] unconditionally. `ml` is absent for the same reason it is absent
  // from BeatAux: not ported.
  return ev;
}


// ---- courts.ts: the courts themselves --------------------------------------
//
// Ported verbatim, with the file's standing rules: same order of operations,
// same widths, no FMA. Two shapes recur and both are deliberate.
//
// `Math.round(x * 100) / 100` rounds the SCALED value, and std::round matches
// it on everything roundTo() is given here — but NOT in general, and the
// difference is a trap worth naming: JS's Math.round is half-toward-+INF
// (Math.round(-0.5) is -0) while C's round is half-AWAY-from-zero
// (std::round(-0.5) is -1). They agree on non-negative values, which is all
// that reaches this function; a negative one would diverge at the .5. `gain`
// is the only field here that can go negative (the cadence and sibling
// floors admit `after >= before - 0.01`) and it is dbg-only, compared
// exactly by the harness. Reach for std::round on a genuinely signed value
// and this comment stops being true.
//
// The dbg strings are built here rather than by the caller because the parity
// harness compares them: they are the TS's own wording and key order, and a
// paraphrase would fail a gate that is otherwise about arithmetic.

namespace {

/** JS `Math.round(v * p) / p` — half away from zero, on the scaled value. */
double roundTo(double v, double p) { return std::round(v * p) / p; }

/** The TS's `median` over a plain array: sort, take [len >> 1]. Empty is 0
 *  there (not NaN — `medianOf` above is the other one, for the extractors). */
double medianCourt(const std::vector<double>& a) {
  if (a.empty()) return 0;
  std::vector<double> s = a;
  std::sort(s.begin(), s.end());
  return s[s.size() >> 1];
}

std::string num(double v) {
  char buf[64];
  std::snprintf(buf, sizeof buf, "%.17g", v);
  return buf;
}

}  // namespace

MlLevel mlLevelStats(const std::vector<double>& mlBeats, bool& ok) {
  ok = false;
  MlLevel out;
  if (mlBeats.size() < 32) return out;
  std::vector<double> iv;
  iv.reserve(mlBeats.size() - 1);
  for (size_t i = 1; i < mlBeats.size(); i++) iv.push_back(mlBeats[i] - mlBeats[i - 1]);
  std::sort(iv.begin(), iv.end());
  const double med = iv[iv.size() >> 1];
  size_t within = 0;
  for (const double x : iv) {
    if (std::fabs(x - med) <= 0.1 * med) within++;
  }
  out.bpm = 60.0 / med;
  out.uni = roundTo(static_cast<double>(within) / static_cast<double>(iv.size()), 100.0);
  ok = true;
  return out;
}

std::vector<ChordRun> changePoints(const std::vector<ChordRun>& runs, double minHold) {
  std::vector<ChordRun> merged;
  for (const ChordRun& r : runs) {
    if (!merged.empty()) {
      ChordRun& last = merged.back();
      if (r.c == last.c && r.t - (last.t + last.sec) < 1.0) {
        last.sec = roundTo(r.t + r.sec - last.t, 1000.0);
        continue;
      }
    }
    merged.push_back({r.t, r.sec, r.c});
  }
  std::vector<ChordRun> out;
  for (size_t i = 0; i < merged.size(); i++) {
    const ChordRun& r = merged[i];
    if (r.sec < minHold) {
      if (!(i + 1 < merged.size() && merged[i + 1].c == r.c)) continue;
    }
    out.push_back(r);
  }
  return out;
}

std::vector<double> barTimes(const CourtGrid& det) {
  if (det.hasDownbeats && det.downbeats.size() > 2) {
    std::vector<double> out;
    out.reserve(det.downbeats.size());
    for (const int i : det.downbeats) out.push_back(det.beats[static_cast<size_t>(i)]);
    return out;
  }
  std::vector<double> out;
  for (size_t i = static_cast<size_t>(det.downbeat); i < det.beats.size();
       i += static_cast<size_t>(det.beatsPerBar)) {
    out.push_back(det.beats[i]);
  }
  return out;
}

double chordsOnBars(const std::vector<double>& starts, const std::vector<double>& bars, double tol) {
  if (starts.empty()) return 0;
  size_t on = 0;
  for (const double t : starts) {
    double d = std::numeric_limits<double>::infinity();
    for (const double x : bars) d = std::min(d, std::fabs(x - t));
    if (d <= tol) on++;
  }
  return static_cast<double>(on) / static_cast<double>(starts.size());
}

CourtVerdict octaveCourt(const CourtGrid& det, const CourtEvidence& ev) {
  CourtVerdict v;
  const double per = 60.0 / det.bpm;
  const std::vector<double> bars = barTimes(det);
  if (det.beatsPerBar == 6 || det.bpm < 100 || bars.size() < 24) {
    v.dbg = "{\"action\":\"keep\",\"why\":\"out of scope (bpb 6 / bpm < 100 / short)\"}";
    return v;
  }
  const std::vector<ChordRun> cps = changePoints(ev.runs, 0.9);
  std::vector<double> starts;
  starts.reserve(cps.size());
  for (const ChordRun& r : cps) starts.push_back(r.t);

  // E1: harmonic rhythm — the median gap BETWEEN chord changes. Two of our
  // bars per chord says the real bar is twice ours.
  std::vector<ChordRun> holds;
  for (const ChordRun& r : cps) {
    if (r.sec >= 1.2) holds.push_back(r);
  }
  std::vector<double> gaps1;
  for (size_t i = 1; i < holds.size(); i++) gaps1.push_back(holds[i].t - holds[i - 1].t);
  const double medSpan = medianCourt(gaps1);
  const bool e1 = gaps1.size() >= 8 && medSpan >= 1.5 * det.beatsPerBar * per;

  // E2: windowed parity concentration of chord changes over our bars —
  // windowed because a real 2/4 flips the parity and a whole-song count
  // would cancel itself out.
  bool e2 = false;
  {
    const double W = 45;
    std::vector<double> fr;
    for (double a = bars[0]; a + W < bars[bars.size() - 1]; a += W / 2) {
      std::vector<double> w;
      for (const double t : starts) {
        if (t >= a && t < a + W) w.push_back(t);
      }
      if (w.size() < 6) continue;
      long long even = 0, on = 0;
      for (const double t : w) {
        size_t bi = 0;
        for (size_t k = 0; k < bars.size(); k++) {
          if (std::fabs(bars[k] - t) < std::fabs(bars[bi] - t)) bi = k;
        }
        if (std::fabs(bars[bi] - t) <= 0.35 * per * 2) {
          on++;
          if (bi % 2 == 0) even++;
        }
      }
      if (on >= 5) fr.push_back(static_cast<double>(std::max(even, on - even)) / static_cast<double>(on));
    }
    e2 = fr.size() >= 2 && medianCourt(fr) >= 0.8;
  }

  // E3: quiet-zone pulse — do the strongest events fit the half pulse far
  // better than ours?
  bool e3 = false;
  {
    std::vector<double> gaps;
    for (size_t i = 1; i < starts.size(); i++) gaps.push_back(starts[i] - starts[i - 1]);
    const auto fit = [&gaps](double p) {
      long long ok = 0;
      for (const double g : gaps) {
        const double m = std::max(1.0, std::round(g / p));
        if (m <= 6 && std::fabs(g - m * p) <= 0.2 * p) ok++;
      }
      return gaps.empty() ? 0.0 : static_cast<double>(ok) / static_cast<double>(gaps.size());
    };
    const double fHalf = fit(2 * per);
    const double fCur = fit(per);
    e3 = fHalf >= 0.6 && fHalf - fCur >= 0.2;
  }

  const int votes = (e1 ? 1 : 0) + (e2 ? 1 : 0) + (e3 ? 1 : 0);
  v.fire = votes >= 2;
  std::ostringstream o;
  o << "{\"e1\":" << (e1 ? "true" : "false") << ",\"e2\":" << (e2 ? "true" : "false")
    << ",\"e3\":" << (e3 ? "true" : "false") << ",\"medSpan\":" << num(roundTo(medSpan, 100.0))
    << ",\"action\":\"" << (v.fire ? "halve" : "keep") << "\"}";
  v.dbg = o.str();
  return v;
}

CourtVerdict doubleCourt(const CourtGrid& det, const CourtEvidence& ev) {
  CourtVerdict v;
  if (!ev.hasMl || det.beatsPerBar == 6 || det.bpm >= 80) return v;  // 'keep', no dbg — as the TS
  const double ratio = ev.ml.bpm / det.bpm;
  const double dbl = det.bpm * 2;
  v.fire = ratio >= 1.85 && ratio <= 2.15 && ev.ml.uni >= 0.7 && dbl >= 95 && dbl <= 140;
  std::ostringstream o;
  o << "{\"mlBpm\":" << num(roundTo(ev.ml.bpm, 10.0)) << ",\"uni\":" << num(ev.ml.uni)
    << ",\"ratio\":" << num(roundTo(ratio, 100.0)) << ",\"action\":\"" << (v.fire ? "double" : "keep")
    << "\"}";
  v.dbg = o.str();
  return v;
}

CourtGrid doubleGrid(const CourtGrid& det, const CourtEvidence& ev) {
  const double per = 60.0 / det.bpm;
  std::vector<double> beats;
  for (size_t i = 0; i < det.beats.size(); i++) {
    beats.push_back(det.beats[i]);
    if (i + 1 < det.beats.size()) {
      beats.push_back(roundTo((det.beats[i] + det.beats[i + 1]) / 2, 1000.0));
    }
  }
  std::vector<double> starts;
  for (const ChordRun& r : changePoints(ev.runs, 0.9)) {
    if (r.sec >= per) starts.push_back(r.t);
  }
  // The TS seeds `best` with null and takes STRICTLY greater, so a tie keeps
  // the first offset tried — 0.
  double bestS = 0;
  int bestOff = 0;
  bool have = false;
  for (const int off : {0, 2}) {
    std::vector<double> bars;
    for (size_t i = static_cast<size_t>(off); i < beats.size(); i += 4) bars.push_back(beats[i]);
    const double sScore = chordsOnBars(starts, bars, 0.35 * per);
    if (!have || sScore > bestS) {
      bestS = sScore;
      bestOff = off;
      have = true;
    }
  }
  CourtGrid out;
  out.bpm = det.bpm * 2;
  out.beatsPerBar = 4;
  out.beats = beats;
  for (size_t i = static_cast<size_t>(bestOff); i < beats.size(); i += 4) {
    out.downbeats.push_back(static_cast<int>(i));
  }
  out.hasDownbeats = true;
  out.downbeat = out.downbeats.empty() ? 0 : out.downbeats[0] % 4;
  out.doubledFrom = det.bpm;
  out.hasDoubledFrom = true;
  return out;
}

CourtGrid halveGrid(const CourtGrid& det, const CourtEvidence& ev) {
  const double per = 60.0 / det.bpm;
  std::vector<double> starts;
  for (const ChordRun& r : changePoints(ev.runs, 0.9)) {
    if (r.sec >= 2 * per) starts.push_back(r.t);
  }
  const auto score = [&starts, per](const std::vector<double>& bs) {
    std::vector<double> bars;
    for (size_t i = 0; i < bs.size(); i += 4) bars.push_back(bs[i]);
    return chordsOnBars(starts, bars, 0.35 * per * 2);
  };
  // four candidates: two beat parities x two bar phases each. Strictly
  // greater again, so the first (off 0, rot 0) survives a tie.
  double bestS = 0;
  std::vector<double> bestBeats;
  bool have = false;
  for (const int off : {0, 1}) {
    std::vector<double> bs;
    for (size_t i = 0; i < det.beats.size(); i++) {
      if (static_cast<int>(i % 2) == off) bs.push_back(det.beats[i]);
    }
    for (const int rot : {0, 2}) {
      std::vector<double> shifted(bs.begin() + std::min<size_t>(static_cast<size_t>(rot), bs.size()),
                                  bs.end());
      const double s = score(shifted);
      if (!have || s > bestS) {
        bestS = s;
        bestBeats = shifted;
        have = true;
      }
    }
  }
  CourtGrid out;
  out.bpm = det.bpm / 2;
  out.beatsPerBar = 4;
  out.downbeat = 0;
  out.beats = bestBeats;
  for (size_t i = 0; i < out.beats.size(); i += 4) out.downbeats.push_back(static_cast<int>(i));
  out.hasDownbeats = true;
  out.halvedFrom = det.bpm;
  out.hasHalvedFrom = true;
  // the pre-halve bar lattice rides along: it is the ruler the parity test
  // measures 2/4s against
  out.originalBars = barTimes(det);
  out.hasOriginalBars = true;
  return out;
}

// ---- courts.ts: the meter court -------------------------------------------

namespace {

/** JS `[...new Set(xs)].sort((a,b)=>a-b)` over ints. */
std::vector<int> uniqSorted(std::vector<int> xs) {
  std::sort(xs.begin(), xs.end());
  xs.erase(std::unique(xs.begin(), xs.end()), xs.end());
  return xs;
}

/** The TS's `mod` — a true modulus, negatives folded up. */
int modInt(int a, int m) { return ((a % m) + m) % m; }

/** Nearest beat index to `t` — the TS's `idxOf`, ties keeping the earlier
 *  index because the comparison is strict. */
size_t idxOfBeat(const std::vector<double>& beats, double t) {
  size_t i = 0;
  for (size_t k = 0; k < beats.size(); k++) {
    if (std::fabs(beats[k] - t) < std::fabs(beats[i] - t)) i = k;
  }
  return i;
}

struct SeamCand {
  double t = 0;
  std::string why;
};

/** Seam candidates: line ends before a vocal gap, held-note onsets, form
 *  seams. Nothing else is ever considered. Entry is GENEROUS on purpose —
 *  the phase test and the accept-if-better guard do the protecting. */
std::vector<SeamCand> seamCandidates(const CourtGrid& det, const CourtEvidence& ev) {
  const double per = 60.0 / det.bpm;
  const double barLen = det.beatsPerBar * per;
  std::vector<SeamCand> out;
  const auto push = [&](double t, const char* why) {
    if (det.beats.empty()) return;
    if (t < det.beats[0] + 2 * barLen || t > det.beats[det.beats.size() - 1] - barLen) return;
    for (const SeamCand& o : out) {
      if (std::fabs(o.t - t) < 1.5) return;
    }
    out.push_back({t, why});
  };
  const std::vector<std::pair<double, double>>& ws = ev.words;
  for (size_t i = 0; i + 1 < ws.size(); i++) {
    if (ws[i + 1].first - ws[i].second >= 0.7 * barLen) push(ws[i].second, "line end + gap");
  }
  for (const VoiceHold& v : ev.voice) {
    if (v.gapSec >= 0.7 * barLen) push(v.t, "held note");
  }
  for (const double s : ev.seams) push(s, "form seam");
  std::stable_sort(out.begin(), out.end(), [](const SeamCand& a, const SeamCand& b) { return a.t < b.t; });
  return out;
}

/** Force a bar line at `at` (snapped to a beat): upstream bars keep their
 *  places, the bar the new line cuts short takes whatever length falls out,
 *  and downstream re-lays at bpb. */
CourtGrid withInsert(const CourtGrid& det, double at) {
  const int bpb = det.beatsPerBar;
  const std::vector<double> bars = barTimes(det);
  const std::vector<double>& beats = det.beats;
  const int forced = static_cast<int>(idxOfBeat(beats, at));
  std::vector<int> db;
  for (const double b : bars) {
    const int i = static_cast<int>(idxOfBeat(beats, b));
    if (i <= forced - 2) db.push_back(i);
  }
  db.push_back(forced);
  for (int j = forced + bpb; j < static_cast<int>(beats.size()); j += bpb) db.push_back(j);
  CourtGrid out = det;
  out.downbeats = db;
  out.hasDownbeats = true;
  out.downbeat = db.empty() ? 0 : modInt(db[0], bpb);
  return out;
}

/** Force bars at BOTH edges of the odd-bar chord. Returns ok=false where the
 *  TS returns null (the two edges land less than two beats apart). */
bool withEdgePair(const CourtGrid& det, double t0, double t1, CourtGrid& out) {
  const int bpb = det.beatsPerBar;
  const std::vector<double> bars = barTimes(det);
  const std::vector<double>& beats = det.beats;
  const int a = static_cast<int>(idxOfBeat(beats, t0));
  const int b = static_cast<int>(idxOfBeat(beats, t1));
  if (b - a < 2) return false;
  std::vector<int> all;
  all.reserve(bars.size());
  for (const double x : bars) all.push_back(static_cast<int>(idxOfBeat(beats, x)));
  std::vector<int> db;
  for (const int i : all) {
    if (i <= a - 2) db.push_back(i);
  }
  db.push_back(a);
  db.push_back(b);
  for (const int i : all) {
    if (i >= b + 2) db.push_back(i);
  }
  out = det;
  // `downbeat` is taken from db BEFORE the dedupe/sort, as the TS does
  // (`db[0] % bpb` on the unsorted array).
  const int first = db.empty() ? 0 : db[0];
  out.downbeats = uniqSorted(db);
  out.hasDownbeats = true;
  out.downbeat = modInt(first, bpb);
  return true;
}

struct ParityFlip {
  double d = 0;
  double P = 0;
};

/** The halved-grid 2/4 test: majority parity of chord changes on the
 *  PRE-halve bar lattice, +/-14 s each side. Clean-span guarded. */
bool parityFlipAt(const std::vector<double>& origBars, const std::vector<double>& starts, double candT) {
  std::vector<double> spacing;
  for (size_t i = 1; i < origBars.size(); i++) spacing.push_back(origBars[i] - origBars[i - 1]);
  const double medBar = medianCourt(spacing);
  const auto parityOf = [&](double t, int& p) -> bool {
    if (origBars.empty()) return false;
    size_t bi = 0;
    for (size_t k = 0; k < origBars.size(); k++) {
      if (std::fabs(origBars[k] - t) < std::fabs(origBars[bi] - t)) bi = k;
    }
    if (std::fabs(origBars[bi] - t) > 0.4 * medBar) return false;
    // clean-span guard: the ruler must be intact where it measures
    const double a = origBars[bi == 0 ? 0 : bi - 1];
    const double b = origBars[std::min(origBars.size() - 1, bi + 1)];
    if (std::fabs((b - a) / 2 - medBar) > 0.08 * medBar) return false;
    p = static_cast<int>(bi % 2);
    return true;
  };
  const auto grab = [&](double a, double b) {
    std::vector<int> out;
    for (const double t : starts) {
      if (t >= a && t < b) {
        int p = 0;
        if (parityOf(t, p)) out.push_back(p);
      }
    }
    return out;
  };
  const std::vector<int> before = grab(candT - 14, candT - 0.2);
  const std::vector<int> after = grab(candT + 0.2, candT + 14);
  if (before.size() < 3 || after.size() < 3) return false;
  const auto majF = [](const std::vector<int>& xs) {
    double s = 0;
    for (const int x : xs) s += x;
    return s / static_cast<double>(xs.size());
  };
  const double A = majF(before);
  const double B = majF(after);
  const auto clean = [](double x) { return x <= 0.35 || x >= 0.65; };
  const auto lean = [](double x) { return x <= 0.45 || x >= 0.55; };
  return (clean(A) || clean(B)) && lean(A) && lean(B) && std::round(A) != std::round(B);
}

struct PulseVerdict {
  enum Kind { None, Step, Split } kind = None;
  int lambda = 0;
  int resid = 0;
};

/** Native-level step test: the carried rigid pulse, across the seam. */
PulseVerdict carriedPulseAt(const CourtGrid& grid, const std::vector<double>& starts, double candT) {
  PulseVerdict v;
  const double per = 60.0 / grid.bpm;
  const int bpb = grid.beatsPerBar;
  const std::vector<double> bars = barTimes(grid);
  const double W = 20 * per;
  std::vector<double> L, R;
  for (const double t : starts) {
    if (t >= candT - W && t < candT - 0.2) L.push_back(t);
    if (t > candT + 0.2 && t <= candT + W) R.push_back(t);
  }
  if (L.size() < 2 || R.size() < 3) return v;
  // a candidate whose window touches an odd bar the grid ALREADY carries is
  // out of jurisdiction
  const std::vector<int>& db0 = grid.downbeats;
  for (size_t k = 1; k < db0.size(); k++) {
    if (db0[k] - db0[k - 1] != bpb) {
      const double tOdd = grid.beats[static_cast<size_t>(db0[k - 1])];
      if (std::fabs(tOdd - candT) < W + 2) return v;
    }
  }
  // the left anchor must itself sit on a bar of the local grid
  bool haveAnchor = false;
  double anchor = 0;
  for (size_t i = L.size(); i-- > 0;) {
    double d = std::numeric_limits<double>::infinity();
    for (const double b : bars) d = std::min(d, std::fabs(b - L[i]));
    if (d <= 0.3 * per) {
      anchor = L[i];
      haveAnchor = true;
      break;
    }
  }
  if (!haveAnchor) return v;
  // Insertion-ordered, like a JS Map: the top vote is chosen by a stable
  // sort on count, so which residual wins a tie depends on this order.
  std::vector<std::pair<int, int>> votes;
  long long counted = 0;
  for (const double r : R) {
    const double k = (r - anchor) / per;
    if (std::fabs(k - std::round(k)) > 0.28) continue;  // not on the pulse
    counted++;
    const int resid = modInt(static_cast<int>(std::round(k)), bpb);
    bool found = false;
    for (auto& e : votes) {
      if (e.first == resid) {
        e.second++;
        found = true;
        break;
      }
    }
    if (!found) votes.push_back({resid, 1});
  }
  if (counted < 3) return v;
  std::vector<std::pair<int, int>> sorted = votes;
  std::stable_sort(sorted.begin(), sorted.end(),
                   [](const std::pair<int, int>& a, const std::pair<int, int>& b) { return b.second < a.second; });
  const std::pair<int, int> top = sorted[0];
  if (static_cast<double>(top.second) / static_cast<double>(counted) < 0.7 || top.first == 0) {
    // a SPLIT vote is not "no evidence" — it is the half-bar blindness
    // diagnosis, and it hands jurisdiction to the cadence test
    int v0 = 0, v2 = 0;
    for (const auto& e : votes) {
      if (e.first == 0) v0 = e.second;
      if (e.first == 2) v2 = e.second;
    }
    if (v0 >= 2 && v2 >= 2) {
      v.kind = PulseVerdict::Split;
      return v;
    }
    return v;
  }
  v.kind = PulseVerdict::Step;
  v.resid = top.first;
  v.lambda = top.first == 1 ? bpb + 1 : top.first;  // 2->2/4, 3->3/4, 1->5/4
  return v;
}

/** The cadence-bar test — the symmetry breaker for half-bar harmony. */
bool songIsHalfBar(const CourtEvidence& ev, const CourtGrid& grid) {
  const double per = 60.0 / grid.bpm;
  const std::vector<ChordRun> cps = changePoints(ev.runs, 0.9);
  std::vector<double> spans;
  for (const ChordRun& r : cps) {
    const double x = r.sec / per;
    if (x >= 1) spans.push_back(x);
  }
  if (spans.size() < 12) return false;
  const double m = medianCourt(spans);
  return m >= 1.6 && m <= 2.4;
}

struct Cadence {
  double rStart = 0;
  double hStart = 0;
  int lambda = 0;
};

bool cadenceBarAt(const CourtGrid& grid, const CourtEvidence& ev, double candT, Cadence& out) {
  const double per = 60.0 / grid.bpm;
  const int bpb = grid.beatsPerBar;
  const std::vector<ChordRun> cps = changePoints(ev.runs, 0.9);
  // the long hold arriving at/after the candidate
  const ChordRun* H = nullptr;
  for (const ChordRun& r : cps) {
    if (r.sec >= 4.5 * per && std::fabs(r.t - candT) <= 2.5 * bpb * per * 0.5) {
      if (H == nullptr || std::fabs(r.t - candT) < std::fabs(H->t - candT)) H = &r;
    }
  }
  if (H == nullptr) return false;
  long long idx = -1;
  for (size_t i = 0; i < cps.size(); i++) {
    if (cps[i].t == H->t) {
      idx = static_cast<long long>(i);
      break;
    }
  }
  if (idx < 3) return false;
  const ChordRun& R = cps[static_cast<size_t>(idx - 1)];
  const size_t chainFrom = static_cast<size_t>(std::max<long long>(0, idx - 4));
  size_t halfish = 0;
  std::vector<std::string> labels;
  for (size_t i = chainFrom; i + 1 <= static_cast<size_t>(idx - 1); i++) {
    if (i >= cps.size()) break;
    if (std::fabs(cps[i].sec / per - 2) <= 1.0) halfish++;
    if (std::find(labels.begin(), labels.end(), cps[i].c) == labels.end()) labels.push_back(cps[i].c);
  }
  if (halfish < 2 || labels.size() < 2) return false;
  // the odd bar's length is R's OWN span
  const int lam = static_cast<int>(std::round(R.sec / per));
  if (lam < 2 || lam > bpb + 1) return false;
  out.rStart = R.t;
  out.hStart = H->t;
  out.lambda = lam;
  return true;
}

struct Placement {
  CourtGrid cand2;
  double after = 0;
  double t = 0;
  int L = 0;
};

/** Step placement: L from the residual court, the edge from a section hold
 *  when one exists (doubly attested -> no-loss acceptance), else the next
 *  chords (singly attested -> must gain). */
bool tryStepPlacement(const CourtGrid& grid, const CourtEvidence& ev, const std::vector<double>& starts,
                      double candT, int lambda, double per, double before, double baseTol,
                      Placement& site) {
  struct Try {
    double e0, e1;
    bool dual;
  };
  std::vector<Try> tries;
  {
    const std::vector<ChordRun> cps2 = changePoints(ev.runs, 0.9);
    const ChordRun* H = nullptr;
    for (const ChordRun& r : cps2) {
      if (r.sec >= 4.5 * per && r.t >= candT - 2 * grid.beatsPerBar * per &&
          r.t <= candT + grid.beatsPerBar * per) {
        if (H == nullptr || std::fabs(r.t - candT) < std::fabs(H->t - candT)) H = &r;
      }
    }
    if (H != nullptr) tries.push_back({H->t - lambda * per, H->t, true});
  }
  {
    int taken = 0;
    for (const double t : starts) {
      if (t > candT + 0.2 && t <= candT + 20 * per) {
        tries.push_back({t - lambda * per, t, false});
        if (++taken == 3) break;
      }
    }
  }
  bool have = false;
  for (const Try& tr : tries) {
    CourtGrid cand2t;
    if (!withEdgePair(grid, tr.e0, tr.e1, cand2t)) continue;
    const std::vector<int>& db2 = cand2t.downbeats;
    bool okLen = false;
    for (size_t k = 1; k < db2.size(); k++) {
      if (std::fabs(grid.beats[static_cast<size_t>(db2[k - 1])] - tr.e0) < 0.35 &&
          db2[k] - db2[k - 1] == lambda) {
        okLen = true;
      }
    }
    if (!okLen) continue;
    const double after2 = chordsOnBars(starts, barTimes(cand2t), baseTol);
    const double floorV = tr.dual ? before - 0.01 : before + 0.02;
    if (after2 >= floorV && (!have || after2 > site.after)) {
      site.cand2 = cand2t;
      site.after = after2;
      site.t = tr.e0;
      site.L = lambda;
      have = true;
    }
  }
  return have;
}

CourtGrid meterCourt(const CourtGrid& det, const CourtEvidence& ev, CourtsDbg& dbg) {
  const double per = 60.0 / det.bpm;
  // long holds only: fragments and half-bar movement drown the phase tests
  std::vector<double> starts;
  for (const ChordRun& r : changePoints(ev.runs, 0.9)) {
    if (r.sec >= 1.5 * per) starts.push_back(r.t);
  }
  const std::vector<SeamCand> cands = seamCandidates(det, ev);
  dbg.cands = static_cast<int>(cands.size());
  CourtGrid grid = det;
  if (!(det.hasDownbeats && det.downbeats.size() > 2)) {
    std::vector<int> db;
    for (const double t : barTimes(det)) {
      for (size_t i = 0; i < det.beats.size(); i++) {
        if (det.beats[i] == t) {
          db.push_back(static_cast<int>(i));
          break;
        }
      }
    }
    grid.downbeats = db;
    grid.hasDownbeats = true;
    // This changes no verdict — it only gives the tests below a bar array to
    // measure against — but the TS builds a NEW OBJECT to do it, and its
    // caller tests `courted !== det0` by identity. So a grid that arrives here
    // with no bars leaves the courts WITH them even when every court declines,
    // and the caller adopts them. Measured on Panzerkampf and Primo Victoria:
    // neither has a confident enough segment to anchor a rotation, so the
    // phase pass produces no bars at all, and these uniform ones are the
    // 129/64 the app draws. Missing this flag cost both songs their bar lines
    // on this side while every court field still compared equal.
    dbg.changed = true;
  }
  std::vector<AppliedStep> applied;
  const double baseTol = 0.35 * per;

  // HALVED grids get the joint plan: with several real 2/4s, fixing the
  // first span breaks the accidentally-aligned second, so any one insert
  // gains ~nothing and a greedy gate refuses them all.
  if (det.hasOriginalBars) {
    std::vector<double> sites;
    for (const SeamCand& cand : cands) {
      if (parityFlipAt(det.originalBars, starts, cand.t) &&
          (sites.empty() || cand.t - sites.back() > 8)) {
        sites.push_back(cand.t);
      }
    }
    if (!sites.empty() && sites.size() <= 6) {
      const double tol2 = baseTol;
      const double before = chordsOnBars(starts, barTimes(grid), tol2);
      struct Plan {
        CourtGrid plan;
        double after = 0;
        std::vector<double> combo;  // NaN = the TS's null
        double local = 0;
        double dist = 0;
      };
      Plan best;
      bool haveBest = false;
      // Recursive by hand: options are PLAN-DEPENDENT, so each site's
      // candidates are judged against the plan so far.
      std::function<void(size_t, const CourtGrid&, std::vector<double>)> grow =
          [&](size_t k, const CourtGrid& plan, std::vector<double> combo) {
            if (k == sites.size()) {
              const double after = chordsOnBars(starts, barTimes(plan), tol2);
              const std::vector<double> bt = barTimes(plan);
              double local = 0;
              for (const double t : sites) {
                for (const double x : starts) {
                  if (std::fabs(x - t) <= 4.2) {
                    double d = std::numeric_limits<double>::infinity();
                    for (const double b : bt) d = std::min(d, std::fabs(b - x));
                    local += std::exp(-(d * d) / (2 * 0.35 * 0.35));
                  }
                }
              }
              double dist = 0;
              for (size_t i = 0; i < combo.size(); i++) {
                if (!std::isnan(combo[i])) dist += std::fabs(combo[i] - sites[i]);
              }
              const bool wins =
                  !haveBest || after > best.after + 0.02 ||
                  (after > best.after - 0.02 &&
                   (local > best.local + 0.25 ||
                    (std::fabs(local - best.local) <= 0.25 && dist < best.dist - 0.2)));
              if (wins) {
                best.plan = plan;
                best.after = after;
                best.combo = combo;
                best.local = local;
                best.dist = dist;
                haveBest = true;
              }
              return;
            }
            const double t = sites[k];
            const std::vector<double> cur = barTimes(plan);
            std::vector<double> opts;
            for (const double x : det.originalBars) {
              bool isBar = false;
              for (const double b : cur) {
                if (std::fabs(b - x) < 0.4) {
                  isBar = true;
                  break;
                }
              }
              if (!isBar && std::fabs(x - t) < 4) opts.push_back(x);
            }
            std::stable_sort(opts.begin(), opts.end(),
                             [t](double a, double b) { return std::fabs(a - t) < std::fabs(b - t); });
            if (opts.size() > 2) opts.resize(2);
            if (opts.empty()) {
              std::vector<double> c2 = combo;
              c2.push_back(std::numeric_limits<double>::quiet_NaN());
              grow(k + 1, plan, c2);
              return;
            }
            for (const double o : opts) {
              std::vector<double> c2 = combo;
              c2.push_back(o);
              grow(k + 1, withInsert(plan, o), c2);
            }
          };
      grow(0, grid, {});
      {
        std::ostringstream o;
        o << "{\"sites\":[";
        for (size_t i = 0; i < sites.size(); i++) o << (i ? "," : "") << num(roundTo(sites[i], 10.0));
        o << "],\"chosen\":[";
        for (size_t i = 0; i < best.combo.size(); i++) {
          o << (i ? "," : "");
          if (std::isnan(best.combo[i])) o << "null";
          else o << num(roundTo(best.combo[i], 10.0));
        }
        o << "],\"before\":" << num(std::round(before * 100)) << ",\"after\":" << num(std::round(best.after * 100))
          << "}";
        dbg.plan = o.str();
      }
      if (best.after >= before + 0.04) {
        for (const double tb : best.combo) {
          if (!std::isnan(tb)) {
            applied.push_back({roundTo(tb, 10.0), 2, "parity flip", std::round((best.after - before) * 100)});
          }
        }
        grid = best.plan;
        dbg.changed = true;
      }
    }
    dbg.applied = applied;
    return grid;
  }

  const bool halfBar = songIsHalfBar(ev, det);
  dbg.halfBar = halfBar;

  // Corroboration census: a cadence shape that is REAL recurs at the song's
  // form repeats. A singleton with the same chord shape is a transition.
  std::vector<std::pair<int, int>> cadenceCount;  // insertion-ordered, like a JS Map
  {
    const double perC = 60.0 / det.bpm;
    std::vector<double> startsC;
    for (const ChordRun& r : changePoints(ev.runs, 0.9)) {
      if (r.sec >= 1.5 * perC) startsC.push_back(r.t);
    }
    const double beforeC = chordsOnBars(startsC, barTimes(det), 0.35 * perC);
    for (const SeamCand& cand : cands) {
      // a site the step court can actually PLACE on must not corroborate a
      // cadence; a false step VERDICT that cannot place excludes nothing.
      const PulseVerdict stC = carriedPulseAt(det, startsC, cand.t);
      if (stC.kind == PulseVerdict::Step) {
        Placement ignored;
        if (tryStepPlacement(det, ev, startsC, cand.t, stC.lambda, perC, beforeC, 0.35 * perC, ignored)) {
          continue;
        }
      }
      Cadence c;
      if (cadenceBarAt(det, ev, cand.t, c) && c.lambda != det.beatsPerBar) {
        bool found = false;
        for (auto& e : cadenceCount) {
          if (e.first == c.lambda) {
            e.second++;
            found = true;
            break;
          }
        }
        if (!found) cadenceCount.push_back({c.lambda, 1});
      }
    }
  }
  {
    std::ostringstream o;
    o << "{";
    for (size_t i = 0; i < cadenceCount.size(); i++) {
      o << (i ? "," : "") << "\"" << cadenceCount[i].first << "\":" << cadenceCount[i].second;
    }
    o << "}";
    dbg.cadenceCensus = o.str();
  }
  const auto censusOf = [&cadenceCount](int lam) {
    for (const auto& e : cadenceCount) {
      if (e.first == lam) return e.second;
    }
    return 0;
  };

  std::vector<int> sibling;  // cadence convictions, for decoder-merged classmates
  for (int round = 0; round < 6; round++) {
    const double before = chordsOnBars(starts, barTimes(grid), baseTol);
    struct Best {
      CourtGrid cand2;
      double after = 0;
      double t = 0;
      int L = 0;
      std::string why;
      bool sib = false;
    };
    Best best;
    bool haveBest = false;
    for (const SeamCand& cand : cands) {
      bool skip = false;
      for (const AppliedStep& a : applied) {
        if (std::fabs(a.t - cand.t) < 6) {
          skip = true;
          break;
        }
      }
      if (skip) continue;
      const PulseVerdict st = carriedPulseAt(grid, starts, cand.t);
      // The step court goes first and, when it PLACES, owns the site.
      bool stepPlaced = false;
      if (st.kind == PulseVerdict::Step) {
        Placement placed;
        if (tryStepPlacement(grid, ev, starts, cand.t, st.lambda, per, before, baseTol, placed) &&
            (!haveBest || placed.after > best.after)) {
          best.cand2 = placed.cand2;
          best.after = placed.after;
          best.t = placed.t;
          best.L = placed.L;
          best.why = cand.why;
          best.sib = false;
          haveBest = true;
          stepPlaced = true;
        }
      }
      const bool blind = st.kind == PulseVerdict::Split || (st.kind == PulseVerdict::None && halfBar) ||
                         (st.kind == PulseVerdict::Step && !stepPlaced && halfBar);
      Cadence cad;
      const bool haveCad = !stepPlaced && blind && cadenceBarAt(grid, ev, cand.t, cad);
      bool cadencePlaced = false;
      if (haveCad && cad.lambda != grid.beatsPerBar && censusOf(cad.lambda) >= 2) {
        // two placements per conviction: anchored on the odd chord's own
        // onset, or ending at the section hold's arrival
        const double variants[2][2] = {{cad.rStart, cad.rStart + cad.lambda * per},
                                       {cad.hStart - cad.lambda * per, cad.hStart}};
        for (const auto& vpair : variants) {
          CourtGrid cand2;
          if (!withEdgePair(grid, vpair[0], vpair[1], cand2)) continue;
          const std::vector<int>& db2 = cand2.downbeats;
          bool okLen = false;
          for (size_t k = 1; k < db2.size(); k++) {
            if (std::fabs(grid.beats[static_cast<size_t>(db2[k - 1])] - vpair[0]) < 0.35 &&
                db2[k] - db2[k - 1] == cad.lambda) {
              okLen = true;
            }
          }
          if (!okLen) continue;
          const double after = chordsOnBars(starts, barTimes(cand2), baseTol);
          if (after >= before - 0.01 && (!haveBest || after > best.after)) {
            best.cand2 = cand2;
            best.after = after;
            best.t = vpair[0];
            best.L = cad.lambda;
            best.why = cand.why + " (cadence)";
            best.sib = true;
            haveBest = true;
            cadencePlaced = true;
          }
        }
      }
      if (cadencePlaced) continue;
      // Break-start candidates: a long instrumental gap follows the seam,
      // the odd bar precedes it, and the residual court has NO verdict.
      if (st.kind == PulseVerdict::None) {
        const double barLen2 = grid.beatsPerBar * per;
        bool gapAfter = true;
        for (const auto& w : ev.words) {
          if (!(w.first < cand.t + 0.5 || w.first > cand.t + 2 * barLen2)) {
            gapAfter = false;
            break;
          }
        }
        if (gapAfter) {
          std::vector<ChordRun> cps3;
          for (const ChordRun& r : changePoints(ev.runs, 0.9)) {
            if (r.t >= cand.t - 2.5 * barLen2 && r.t <= cand.t + 0.5 * barLen2) cps3.push_back(r);
          }
          for (size_t i = 0; i < cps3.size(); i++) {
            for (size_t j = i + 1; j < cps3.size(); j++) {
              const double span = cps3[j].t - cps3[i].t;
              const int lam = static_cast<int>(std::round(span / per));
              // the desert sits mid-slip, so the lattice is itself adrift
              if (lam < 2 || lam > 3 || std::fabs(span - lam * per) > 0.33 * per) continue;
              CourtGrid cand2;
              if (!withEdgePair(grid, cps3[i].t, cps3[j].t, cand2)) continue;
              const std::vector<int>& db2 = cand2.downbeats;
              bool okLen = false;
              for (size_t k = 1; k < db2.size(); k++) {
                if (std::fabs(grid.beats[static_cast<size_t>(db2[k - 1])] - cps3[i].t) < 0.35 &&
                    db2[k] - db2[k - 1] == lam) {
                  okLen = true;
                }
              }
              if (!okLen) continue;
              const double after = chordsOnBars(starts, barTimes(cand2), baseTol);
              if (after >= before + 0.02 && (!haveBest || after > best.after)) {
                best.cand2 = cand2;
                best.after = after;
                best.t = cps3[i].t;
                best.L = lam;
                best.why = cand.why + " (break pair)";
                best.sib = false;
                haveBest = true;
              }
            }
          }
          // The TS's note-pair form reads `ev.notes` — onset clusters from a
          // polyphonic transcriber. The app ships without one and the TS
          // always passes [], so that block cannot fire; there is no `notes`
          // on this side at all, which is the same behaviour by construction.
          // Kept as a note rather than as dead code: see courts.ts for the
          // two refuted judge designs and the one bar it would affect.
        }
      }
    }
    if (!haveBest) break;
    grid = best.cand2;
    dbg.changed = true;
    if (best.sib) sibling.push_back(best.L);
    applied.push_back({roundTo(best.t, 10.0), best.L, best.why, std::round((best.after - before) * 100)});
  }

  // Sibling pass: verses repeat, decoders flap.
  if (sibling.size() >= 2) {
    // The TS sorts with the DEFAULT comparator — lexicographic on stringified
    // numbers. Every lambda here is a single digit (2..bpb+1, and bpb is 4 or
    // 6), so lexicographic and numeric agree; sorting numerically is the same
    // answer and says what it means.
    std::vector<int> s = sibling;
    std::sort(s.begin(), s.end());
    const int lamS = s[s.size() >> 1];
    for (const SeamCand& cand : cands) {
      bool skip = false;
      for (const AppliedStep& a : applied) {
        if (std::fabs(a.t - cand.t) < 6) {
          skip = true;
          break;
        }
      }
      if (skip) continue;
      Cadence cad;
      if (!cadenceBarAt(grid, ev, cand.t, cad) || cad.lambda != grid.beatsPerBar) continue;
      CourtGrid cand2;
      if (!withEdgePair(grid, cad.rStart, cad.rStart + lamS * (60.0 / grid.bpm), cand2)) continue;
      const double b0 = chordsOnBars(starts, barTimes(grid), baseTol);
      const double a0 = chordsOnBars(starts, barTimes(cand2), baseTol);
      if (a0 >= b0 - 0.01) {
        grid = cand2;
        dbg.changed = true;
        applied.push_back({roundTo(cad.rStart, 10.0), lamS, cand.why + " (sibling)",
                           std::round((a0 - b0) * 100)});
      }
    }
  }
  dbg.applied = applied;
  return grid;
}

}  // namespace

CourtGrid applyCourts(const CourtGrid& det, const CourtEvidence& ev, CourtsDbg& dbg) {
  // No evidence, no opinion: a stems-less track (Ballroom, a bare mix) must
  // pass through untouched — not even a materialized downbeats array.
  if (ev.runs.size() < 8 && !ev.hasMl) {
    dbg.abstained = true;
    return det;
  }
  CourtGrid grid = det;
  const CourtVerdict oc = octaveCourt(grid, ev);
  dbg.oct = oc.dbg;
  if (oc.fire) {
    grid = halveGrid(grid, ev);
    dbg.changed = true;
  } else {
    const CourtVerdict dc = doubleCourt(grid, ev);
    dbg.dbl = dc.dbg;
    if (dc.fire) {
      grid = doubleGrid(grid, ev);
      dbg.changed = true;
    }
  }
  grid = meterCourt(grid, ev, dbg);
  return grid;
}

}  // namespace singz

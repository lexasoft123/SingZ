// See beat_this.h. Section headers name the python function each block
// reproduces, from scripts/beat_runner_onnx.py.
#include "beat_this.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <sstream>

// Same no-FMA rule as the rest of the core.
#if defined(__clang__)
#pragma clang fp contract(off)
#elif defined(_MSC_VER)
#pragma fp_contract(off)
#elif defined(__GNUC__)
#pragma GCC optimize("fp-contract=off")
#endif

namespace singz {
namespace {

constexpr int kMel = 128;

/** Python's `round(x, 3)` for the JSON contract, via the one route that agrees
 *  with it on ties: both CPython's round and a correct printf round the EXACT
 *  binary value to three decimals, half-to-even. Doing it as `nearbyint(x *
 *  1000) / 1000` does not — the multiply moves the value before the decision,
 *  which is how a tie flips. Slow, and only ever run on output. */
double round3(double x) {
  char buf[64];
  snprintf(buf, sizeof(buf), "%.3f", x);
  return strtod(buf, nullptr);
}

void appendNums(std::ostringstream& out, const std::vector<double>& v) {
  out << '[';
  for (size_t i = 0; i < v.size(); i++) {
    if (i > 0) out << ',';
    char buf[64];
    snprintf(buf, sizeof(buf), "%.17g", v[i]);
    out << buf;
  }
  out << ']';
}

}  // namespace

double sigmoidProb(float logit) {
  // float32 throughout: numpy computes this on a float32 array, so promoting to
  // double here would round differently in the last place before round3 sees it.
  const float c = logit < -80.0f ? -80.0f : (logit > 80.0f ? 80.0f : logit);
  return static_cast<double>(1.0f / (1.0f + std::exp(-c)));
}

// --- split_piece / split_starts ---

std::vector<int> splitStarts(int nFrames) {
  const int step = kBeatThisChunk - 2 * kBeatThisBorder;  // 1488
  std::vector<int> starts;
  for (int s = -kBeatThisBorder; s < nFrames - kBeatThisBorder; s += step) starts.push_back(s);
  // avoid_short_end: pull the last chunk back so it ends on the last frame.
  // The python guard cannot index an empty list — when nFrames > step the
  // range above is non-empty by construction — but the check is cheap.
  if (nFrames > step && !starts.empty()) {
    starts.back() = nFrames - (kBeatThisChunk - kBeatThisBorder);
  }
  return starts;
}

// --- compute_logmel's framing half ---

std::vector<float> frameSignal(const std::vector<float>& signal, int& nFrames) {
  // np.pad(signal, (0, N_FFT - size)) — zeros on the RIGHT only, and ONLY for
  // a signal shorter than one window. Copying unconditionally would double the
  // input's footprint (21 MB for a 4-minute song at 22.05 kHz) for a branch no
  // real song takes.
  std::vector<float> shortPad;
  if (signal.size() < static_cast<size_t>(kBeatThisNFft)) {
    shortPad = signal;
    shortPad.resize(kBeatThisNFft, 0.0f);
  }
  const std::vector<float>& sig = shortPad.empty() ? signal : shortPad;

  const int pad = kBeatThisNFft / 2;  // 512
  const int n = static_cast<int>(sig.size());
  // numpy `mode="reflect"` does not repeat the edge sample: the pad reads
  // sig[1..pad] backwards on the left and sig[n-2..n-1-pad] on the right. One
  // reflection always suffices here because n >= 1024 > pad.
  std::vector<float> padded(static_cast<size_t>(n + 2 * pad));
  for (int i = 0; i < n; i++) padded[static_cast<size_t>(pad + i)] = sig[static_cast<size_t>(i)];
  for (int k = 1; k <= pad; k++) {
    padded[static_cast<size_t>(pad - k)] = sig[static_cast<size_t>(k)];
    padded[static_cast<size_t>(pad + n - 1 + k)] = sig[static_cast<size_t>(n - 1 - k)];
  }

  // sliding_window_view(padded, N_FFT)[::HOP] — windows at 0, HOP, 2*HOP, …
  const int windows = static_cast<int>(padded.size()) - kBeatThisNFft + 1;
  nFrames = (windows + kBeatThisHop - 1) / kBeatThisHop;
  std::vector<float> frames(static_cast<size_t>(nFrames) * kBeatThisNFft);
  for (int f = 0; f < nFrames; f++) {
    const int a = f * kBeatThisHop;
    std::copy(padded.begin() + a, padded.begin() + a + kBeatThisNFft,
              frames.begin() + static_cast<size_t>(f) * kBeatThisNFft);
  }
  return frames;
}

// --- deduplicate_peaks ---

std::vector<double> deduplicatePeaks(const std::vector<int>& peaks, int width) {
  std::vector<double> result;
  if (peaks.empty()) return result;
  // `p` starts an int and becomes a running MEAN on the first merge, which is
  // why it is a double here and an int-then-float in python.
  double p = peaks[0];
  int c = 1;
  for (size_t i = 1; i < peaks.size(); i++) {
    const int p2 = peaks[i];
    if (static_cast<double>(p2) - p <= static_cast<double>(width)) {
      c += 1;
      p += (static_cast<double>(p2) - p) / c;
    } else {
      result.push_back(p);
      p = p2;
      c = 1;
    }
  }
  result.push_back(p);
  return result;
}

// --- peak_times ---

std::vector<double> peakTimes(const std::vector<float>& logits) {
  const int n = static_cast<int>(logits.size());
  std::vector<int> frames;
  for (int i = 0; i < n; i++) {
    // np.pad(logits, 3, constant_values=-inf) then a 7-wide sliding max: the
    // window over frame i is [i-3, i+3], out-of-range reading as -inf.
    float m = -std::numeric_limits<float>::infinity();
    for (int k = i - 3; k <= i + 3; k++) {
      if (k >= 0 && k < n && logits[static_cast<size_t>(k)] > m) m = logits[static_cast<size_t>(k)];
    }
    if (logits[static_cast<size_t>(i)] == m && logits[static_cast<size_t>(i)] > 0.0f) {
      frames.push_back(i);
    }
  }
  std::vector<double> out = deduplicatePeaks(frames, 1);
  for (double& t : out) t /= static_cast<double>(kBeatThisFps);
  return out;
}

// --- postprocess ---

void postprocess(const std::vector<float>& beatLogits, const std::vector<float>& downLogits,
                 std::vector<double>& beats, std::vector<double>& downbeats) {
  beats = peakTimes(beatLogits);
  downbeats = peakTimes(downLogits);
  if (!beats.empty()) {
    for (size_t i = 0; i < downbeats.size(); i++) {
      // np.argmin returns the FIRST minimum, so this keeps `<` rather than `<=`.
      size_t best = 0;
      double bestD = std::fabs(beats[0] - downbeats[i]);
      for (size_t j = 1; j < beats.size(); j++) {
        const double d = std::fabs(beats[j] - downbeats[i]);
        if (d < bestD) {
          bestD = d;
          best = j;
        }
      }
      downbeats[i] = beats[best];
    }
  }
  // np.unique: sort, then drop exact duplicates. Snapping routinely lands two
  // downbeats on one beat, which is the whole reason it is here.
  std::sort(downbeats.begin(), downbeats.end());
  downbeats.erase(std::unique(downbeats.begin(), downbeats.end()), downbeats.end());
}

// --- split_predict_aggregate, overlap_mode=keep_first ---

bool runChunks(const std::vector<float>& spect, int nFrames, const BeatThisModels& models,
               std::vector<float>& beatLogits, std::vector<float>& downLogits,
               const BeatThisProgress& progress) {
  const std::vector<int> starts = splitStarts(nFrames);
  beatLogits.assign(static_cast<size_t>(nFrames), -1000.0f);
  downLogits.assign(static_cast<size_t>(nFrames), -1000.0f);
  if (starts.empty()) return true;

  int done = 0;
  // REVERSE order is keep_first: an earlier chunk overwrites whatever a later
  // one already wrote into the frames they share.
  for (int si = static_cast<int>(starts.size()) - 1; si >= 0; si--) {
    const int start = starts[si];
    const int from = std::max(start, 0);
    const int to = std::min(start + kBeatThisChunk, nFrames);
    const int left = std::max(0, -start);
    const int right = std::max(0, std::min(kBeatThisBorder, start + kBeatThisChunk - nFrames));
    const int rows = std::max(0, to - from);
    // `n` is the length the torch flavor would have fed the model — AFTER the
    // left/right zero pad but BEFORE the pad up to the graph's fixed 1500.
    const int n = left + rows + right;

    std::vector<float> chunk(static_cast<size_t>(kBeatThisChunk) * kMel, 0.0f);
    for (int r = 0; r < rows && left + r < kBeatThisChunk; r++) {
      const size_t src = static_cast<size_t>(from + r) * kMel;
      std::copy(spect.begin() + src, spect.begin() + src + kMel,
                chunk.begin() + static_cast<size_t>(left + r) * kMel);
    }

    std::vector<float> b;
    std::vector<float> d;
    if (!models.model(chunk, b, d)) return false;
    if (b.size() < static_cast<size_t>(kBeatThisChunk) ||
        d.size() < static_cast<size_t>(kBeatThisChunk)) {
      return false;
    }

    // b_seg = b[:n][BORDER:-BORDER]; beat[lo:hi] = b_seg[:hi-lo]
    const int lo = start + kBeatThisBorder;
    const int hi = std::min(start + kBeatThisChunk - kBeatThisBorder, nFrames);
    const int segLen = std::max(0, n - 2 * kBeatThisBorder);
    for (int i = lo; i < hi; i++) {
      const int j = i - lo;
      // numpy would raise if b_seg were shorter than the destination, so this
      // bound never trims in practice; it is here because reading past the
      // segment would be silent where python is loud.
      if (j >= segLen) break;
      const size_t src = static_cast<size_t>(kBeatThisBorder + j);
      beatLogits[static_cast<size_t>(i)] = b[src];
      downLogits[static_cast<size_t>(i)] = d[src];
    }

    done++;
    if (progress) progress(0.30 + 0.65 * done / static_cast<double>(starts.size()));
  }
  return true;
}

// --- main() ---

MlGrid beatThis(const std::vector<float>& signal22k, const BeatThisModels& models,
                const BeatThisProgress& progress) {
  MlGrid grid;
  if (signal22k.empty()) {
    grid.error = "empty input";
    return grid;
  }
  if (!models.logmel || !models.model) {
    grid.error = "beat models not loaded";
    return grid;
  }

  int nFrames = 0;
  std::vector<float> spect;
  {
    // The frames are ~9.3 bytes per input sample — about 49 MB for a 4-minute
    // song — and nothing reads them once the mel graph has run. Scoped so they
    // are gone before the chunk loop, which is where ORT wants the headroom.
    const std::vector<float> frames = frameSignal(signal22k, nFrames);
    spect = models.logmel(frames, nFrames);
  }
  if (spect.size() != static_cast<size_t>(nFrames) * kMel) {
    grid.error = "logmel returned " + std::to_string(spect.size()) + " values, expected " +
                 std::to_string(static_cast<size_t>(nFrames) * kMel);
    return grid;
  }

  std::vector<float> beatLogits;
  std::vector<float> downLogits;
  if (!runChunks(spect, nFrames, models, beatLogits, downLogits, progress)) {
    grid.error = "beat_this inference failed";
    return grid;
  }

  postprocess(beatLogits, downLogits, grid.beats, grid.downbeats);
  grid.beatProb.reserve(beatLogits.size());
  grid.downbeatProb.reserve(downLogits.size());
  for (const float v : beatLogits) grid.beatProb.push_back(sigmoidProb(v));
  for (const float v : downLogits) grid.downbeatProb.push_back(sigmoidProb(v));
  grid.ok = true;
  return grid;
}

MlGrid mlGridRounded(const MlGrid& grid) {
  MlGrid out = grid;
  for (double& v : out.beats) v = round3(v);
  for (double& v : out.downbeats) v = round3(v);
  for (double& v : out.beatProb) v = round3(v);
  for (double& v : out.downbeatProb) v = round3(v);
  return out;
}

std::string mlGridJson(const MlGrid& grid) {
  // Rounded exactly where the python runner rounds. Interchangeable by VALUE
  // with a pack-produced line, not by byte: see mlGridJson's declaration.
  // One rounding implementation, two consumers — the iOS binding reads the
  // same numbers straight off mlGridRounded rather than parsing this back.
  const MlGrid r = mlGridRounded(grid);

  std::ostringstream out;
  out << "{\"beats\":";
  appendNums(out, r.beats);
  out << ",\"downbeats\":";
  appendNums(out, r.downbeats);
  out << ",\"beat_prob\":";
  appendNums(out, r.beatProb);
  out << ",\"downbeat_prob\":";
  appendNums(out, r.downbeatProb);
  out << ",\"fps\":" << r.fps << "}";
  return out.str();
}

}  // namespace singz

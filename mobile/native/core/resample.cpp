#include "resample.h"

#include <algorithm>
#include <cmath>
#include <numeric>

namespace singz {
namespace {

// Modified Bessel function of the first kind, order 0 (for the Kaiser window).
double besselI0(double x) {
  double sum = 1.0;
  double term = 1.0;
  const double half = x / 2.0;
  for (int k = 1; k < 64; k++) {
    term *= (half / k) * (half / k);
    sum += term;
    if (term < 1e-12 * sum) break;
  }
  return sum;
}

}  // namespace

Resampler::Resampler(int srcRate, int dstRate, int channels) : channels_(channels) {
  const int g = std::gcd(srcRate, dstRate);
  up_ = dstRate / g;
  down_ = srcRate / g;
  if (passthrough()) return;

  // Kaiser-windowed sinc lowpass at the tighter Nyquist, beta 10.056
  // (~100 dB stopband), built once per job.
  //
  // The tap count per OUTPUT sample has to scale with the decimation. Each
  // output sample reads exactly tapsPerPhase_ INPUT frames at every ratio
  // (the base-j loop in process), so the prototype spans T input samples
  // and its transition band is ~27% of the INPUT rate for T=24 whatever the
  // ratio. At 48k->44.1k that transition sits above the new Nyquist and
  // costs only the top of the band (-1.5 dB at 20 kHz, 23 kHz folding back
  // at -10 dB — tolerable for stems, and frozen by the split parity gate).
  // At 44.1k->22.05k that same width exceeds the whole output band: measured
  // before this line existed, -3 dB at 10 kHz and content at 12-14 kHz
  // aliasing back at only -10..-25 dB — cymbals and sibilance folding onto
  // the band the beat model listens to, 16.8 dB SNR against soxr on a real
  // mix, and a different grid. The 110 dB figure the header quotes was
  // measured with a 1 kHz tone at that near-unity ratio, where none of this
  // can show. 48 taps per unit of NET decimation (down_/up_, integer) makes
  // the 2:1 case a 96-tap prototype (flat to 10 kHz, 14 kHz aliasing at
  // -134 dB) and leaves every ratio with down_ < 2*up_ — the split engine's
  // 48k->44.1k among them — at the 24 it was gated with, byte for byte.
  const int64_t netDown = down_ / up_;  // 48k->44.1k: 1; 44.1k->22.05k: 2
  // Decimating ratios take swresample's published design instead of the
  // near-unity one: 32 taps per unit of net decimation, beta 9, cutoff at
  // 0.97 of the output Nyquist. Chosen by measurement, not taste: on the
  // 17-song library the beat model's FUSED grids scored 54/55 GT checks
  // from an ffmpeg-swr mix against 52/55 from Chromium's (what shipped) and
  // 50/55 from the old beta-10/96-tap brick wall here — two downbeat
  // ROTATIONS flipped under the brick wall (Father and Son, Zeit) and both
  // renders that keep the transition band gentler agree with the ground
  // truth. The near-unity branch (the split engine's 48k->44.1k) keeps its
  // 24/10.056/full-cutoff design, byte for byte, frozen by the split
  // parity gate.
  const bool decimating = netDown >= 2;
  // Odd tap count: the total latency (history priming + group delay,
  // 3*(taps-1)/2 input samples) becomes an integer number of OUTPUT frames,
  // so latencyOutFrames() can compensate exactly — the model's input must be
  // time-true, or every lattice beat sits ~2 ms behind the homegrown
  // features it is fused against (measured: impulse at 2095 of 2048).
  tapsPerPhase_ = decimating ? static_cast<int>(32 * netDown) + 1 : 24;
  const int64_t n = static_cast<int64_t>(tapsPerPhase_) * up_;
  const double cutoff =
      (decimating ? 0.97 : 1.0) * 0.5 / std::max(up_, down_);  // cycles per zero-stuffed sample
  const double beta = decimating ? 9.0 : 10.056;
  const double denom = besselI0(beta);
  filter_.resize(static_cast<size_t>(n));
  const double center = (static_cast<double>(n) - 1.0) / 2.0;
  for (int64_t i = 0; i < n; i++) {
    const double t = static_cast<double>(i) - center;
    const double sincArg = 2.0 * cutoff * t;
    const double sinc =
        sincArg == 0.0 ? 1.0 : std::sin(M_PI * sincArg) / (M_PI * sincArg);
    const double frac = t / center;  // [-1, 1]
    const double window =
        besselI0(beta * std::sqrt(std::max(0.0, 1.0 - frac * frac))) / denom;
    // gain up_ compensates the zero-stuffing loss
    filter_[static_cast<size_t>(i)] =
        static_cast<float>(2.0 * cutoff * up_ * sinc * window);
  }
  history_.assign(static_cast<size_t>(tapsPerPhase_ - 1) * channels_, 0.0f);
}

void Resampler::process(const float* in, int64_t frames, std::vector<float>& out) {
  if (passthrough()) {
    out.insert(out.end(), in, in + frames * channels_);
    return;
  }
  // Work buffer = history + new input, so taps can straddle the boundary.
  // phase_ counts in 1/up_ input frames, RELATIVE TO THE BUFFER START; it is
  // rebased when history rolls forward at the end of each call.
  const int histFrames = tapsPerPhase_ - 1;
  std::vector<float> buf(history_.size() + static_cast<size_t>(frames) * channels_);
  std::copy(history_.begin(), history_.end(), buf.begin());
  std::copy(in, in + frames * channels_,
            buf.begin() + static_cast<int64_t>(history_.size()));
  const int64_t bufFrames = histFrames + frames;

  // Polyphase decomposition of the prototype: output at phase P reads input
  // frames [base-T+1 .. base] (base = P/up, poly = P%up):
  //   y = sum_j proto[j*up + poly] * x[base - j]
  for (;;) {
    const int64_t base = phase_ / up_;
    if (base >= bufFrames) break;  // needs input we don't have yet
    const int64_t poly = phase_ % up_;
    for (int c = 0; c < channels_; c++) {
      double acc = 0.0;
      for (int j = 0; j < tapsPerPhase_; j++) {
        const int64_t frame = base - j;
        if (frame < 0) break;  // leading edge: history was zero-seeded anyway
        acc += static_cast<double>(filter_[static_cast<size_t>(j) * up_ + poly]) *
               static_cast<double>(buf[frame * channels_ + c]);
      }
      out.push_back(static_cast<float>(acc));
    }
    phase_ += down_;
  }

  // Keep the newest histFrames frames as history; rebase phase_ to it.
  const int64_t keepFrom = bufFrames - histFrames;
  history_.assign(buf.begin() + keepFrom * channels_, buf.end());
  phase_ -= keepFrom * up_;
}

void Resampler::flush(std::vector<float>& out) {
  if (passthrough()) return;
  // Silence long enough to push every tap still holding real input through.
  std::vector<float> zeros(static_cast<size_t>(tapsPerPhase_) * channels_, 0.0f);
  process(zeros.data(), tapsPerPhase_, out);
}

}  // namespace singz

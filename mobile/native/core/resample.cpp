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
  // (~100 dB stopband). 24 taps per output sample keeps 48k->44.1k
  // (up=147) at a ~3.5k-tap prototype — built once per job.
  tapsPerPhase_ = 24;
  const int64_t n = static_cast<int64_t>(tapsPerPhase_) * up_;
  const double cutoff = 0.5 / std::max(up_, down_);  // cycles per zero-stuffed sample
  const double beta = 10.056;
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

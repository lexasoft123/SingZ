#include <zcore/legacy/live_input_analysis.h>

#include <algorithm>
#include <cmath>
#include <limits>
#include <vector>

namespace singz {

namespace {
bool isFinitePositive(double value) { return std::isfinite(value) && value > 0; }
}  // namespace

LiveInputFrame analyzeLiveInput(const float* mono, size_t frames,
                                double sampleRate, double minFrequency,
                                double maxFrequency) {
  LiveInputFrame result;
  if (!mono || frames < 32 || !isFinitePositive(sampleRate) ||
      !isFinitePositive(minFrequency) || !isFinitePositive(maxFrequency) ||
      minFrequency >= maxFrequency) {
    return result;
  }

  const float* data = mono;
  std::vector<float> sanitized;
  for (size_t i = 0; i < frames; ++i) {
    if (!std::isfinite(mono[i])) {
      sanitized.assign(mono, mono + frames);
      for (float& sample : sanitized)
        if (!std::isfinite(sample)) sample = 0;
      data = sanitized.data();
      break;
    }
  }
  double sumSquares = 0;
  for (size_t i = 0; i < frames; ++i) {
    const double sample = data[i];
    sumSquares += sample * sample;
  }
  result.rms = std::sqrt(sumSquares / static_cast<double>(frames));
  result.dbfs = result.rms > 0
                    ? std::max(-120.0, 20.0 * std::log10(result.rms))
                    : -120.0;
  if (result.rms < 0.01) return result;

  const size_t minTau = std::max<size_t>(
      2, static_cast<size_t>(std::floor(sampleRate / maxFrequency)));
  const size_t maxTau = std::min(
      frames / 2,
      static_cast<size_t>(std::floor(sampleRate / minFrequency)));
  if (maxTau <= minTau + 2) return result;

  std::vector<float> difference(maxTau + 1, 0.0f);
  std::vector<float> cmnd(maxTau + 1, 0.0f);
  cmnd[0] = 1.0f;
  const size_t window = frames - maxTau;
  for (size_t tau = 1; tau <= maxTau; ++tau) {
    double sum = 0;
    for (size_t i = 0; i < window; ++i) {
      const double delta = static_cast<double>(data[i]) - data[i + tau];
      sum += delta * delta;
    }
    difference[tau] = static_cast<float>(sum);
  }
  double running = 0;
  for (size_t tau = 1; tau <= maxTau; ++tau) {
    running += difference[tau];
    cmnd[tau] = running == 0
                    ? 1.0f
                    : static_cast<float>(difference[tau] *
                                         static_cast<double>(tau) / running);
  }

  size_t tau = minTau;
  constexpr double threshold = 0.15;
  for (; tau <= maxTau; ++tau) {
    if (cmnd[tau] < threshold) {
      while (tau + 1 <= maxTau && cmnd[tau + 1] < cmnd[tau]) ++tau;
      break;
    }
  }
  if (tau > maxTau) {
    tau = static_cast<size_t>(
        std::min_element(cmnd.begin() + static_cast<std::ptrdiff_t>(minTau),
                         cmnd.end()) -
        cmnd.begin());
    if (cmnd[tau] > 0.3f) return result;
  }

  double refined = static_cast<double>(tau);
  if (tau > 1 && tau < maxTau) {
    const double left = cmnd[tau - 1];
    const double center = cmnd[tau];
    const double right = cmnd[tau + 1];
    const double denom = 2.0 * (2.0 * center - left - right);
    if (std::fabs(denom) > 1e-9) refined += (right - left) / denom;
  }
  if (refined > 0) {
    result.frequency = sampleRate / refined;
    result.clarity = std::clamp(1.0 - cmnd[tau], 0.0, 1.0);
  }
  return result;
}

}  // namespace singz

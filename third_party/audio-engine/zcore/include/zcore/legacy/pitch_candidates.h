#pragma once

#include <algorithm>
#include <cmath>
#include <vector>

namespace singz::pitch {
// Mirrors audio/pitch.ts. Shared by native live capture and offline pYIN.
struct Candidate { double tau; double val; double f0; double weight = 1; };
inline double fractionalResidual(const float* buf, int n, double tau, int tauMax) {
  const int lag = static_cast<int>(std::floor(tau));
  const double u = tau - lag;
  double difference = 0, energy = 0;
  for (int i = 1; i < n - tauMax - 2; ++i) {
    const int j = i + lag;
    const double p0 = buf[j - 1], p1 = buf[j], p2 = buf[j + 1], p3 = buf[j + 2];
    const double shifted = p1 + 0.5 * u * (p2 - p0 + u * (2 * p0 - 5 * p1 + 4 * p2 - p3 + u * (3 * (p1 - p2) + p3 - p0)));
    const double delta = static_cast<double>(buf[i]) - shifted;
    difference += delta * delta;
    energy += static_cast<double>(buf[i]) * buf[i] + shifted * shifted;
  }
  return energy > 0 ? difference / energy : 1;
}
inline std::vector<Candidate> candidates(const std::vector<float>& cmnd,
                                         int tauMin, int tauMax, double sr, const float* buf, int n, bool retainAlternatives = false) {
  std::vector<Candidate> all;
  for (int t = tauMin; t < tauMax; ++t) {
    if (!(cmnd[t] < cmnd[t - 1] && cmnd[t] <= cmnd[t + 1])) continue;
    const double s0 = cmnd[t - 1], s1 = cmnd[t], s2 = cmnd[t + 1];
    const double denom = 2 * (2 * s1 - s2 - s0);
    const double delta = std::fabs(denom) > 1e-9 ? (s2 - s0) / denom : 0;
    const double offset = std::fabs(delta) < 1 ? delta : 0;
    const double tau = t + offset;
    all.push_back({tau, std::max(0.0, s1 + (s2 - s0) * offset / 4), sr / tau});
  }
  std::vector<double> residuals(all.size(), -1);
  const auto residual = [&](size_t i) {
    if (residuals[i] < 0) residuals[i] = fractionalResidual(buf, n, all[i].tau, tauMax);
    return residuals[i];
  };
  std::vector<Candidate> kept;
  for (size_t i = 0; i < all.size(); ++i) {
    bool dominated = false;
    for (size_t j = i + 1; j < all.size(); ++j) {
      const double ratio = all[j].tau / all[i].tau;
      if (ratio > 1.2 && ratio <= 4.04 &&
          all[i].val - all[j].val > 0.01 && all[j].val < all[i].val * 0.5) {
        const double current = residual(i), longer = residual(j);
        if (current - longer > 0.01 && longer < current * 0.5) {
          dominated = true;
          break;
        }
      }
    }
    if (dominated && retainAlternatives) all[i].weight = 0.5;
    if (!dominated || retainAlternatives) kept.push_back(all[i]);
  }
  return kept;
}
}  // namespace singz::pitch

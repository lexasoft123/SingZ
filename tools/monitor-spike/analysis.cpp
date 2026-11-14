#include "analysis.h"
#include <algorithm>
#include <cmath>
#include <limits>
namespace monitor_spike {
namespace {
std::vector<float> project(std::span<const Point> points, uint64_t begin, double rate, size_t count) {
  std::vector<float> out(count, std::numeric_limits<float>::quiet_NaN());
  // Reconstruct each closed callback interval from its two hardware anchors.
  // Per-sample nominal interpolation alone would inject block-shaped phase
  // error when the two hardware rates differ by a few thousand ppm.
  std::vector<uint64_t> times;
  times.reserve(points.size());
  for (const auto& point:points) times.push_back(point.ns);
  for (size_t block=0;block<points.size();++block) {
    const auto frames=points[block].blockFrames;
    if (!frames || frames>=points.size()-block || !points[block+frames].blockFrames ||
        points[block+frames].ns<=points[block].ns) continue;
    const auto interval=points[block+frames].ns-points[block].ns;
    if (frames<2 || points[block+1].ns<=points[block].ns) continue;
    const auto expected=static_cast<double>(points[block+1].ns-points[block].ns)*frames;
    if (std::abs(static_cast<double>(interval)-expected)>
        std::max(2*expected/frames,expected*.005+1000)) continue;
    for (size_t i=0;i<frames;++i)
      times[block+i]=points[block].ns+static_cast<uint64_t>(static_cast<long double>(interval)*i/frames);
    block+=frames-1;
  }
  uint64_t sourceStep=frameNs(1,rate);
  for (size_t i=1;i<std::min(points.size(),size_t{1024});++i)
    if (!points[i].blockFrames && times[i]>times[i-1]) { sourceStep=times[i]-times[i-1]; break; }
  size_t p = 0;
  for (size_t i = 0; i < count; ++i) {
    const auto t = begin + frameNs(i, rate);
    while (p + 1 < points.size() && times[p + 1] <= t) ++p;
    if (p + 1 >= points.size() || times[p] > t || times[p+1] <= times[p] ||
        times[p+1] - times[p] > sourceStep*3) continue;
    const double f = static_cast<double>(t - times[p]) / (times[p+1] - times[p]);
    out[i] = static_cast<float>(points[p].value + f * (points[p+1].value - points[p].value));
  }
  return out;
}
double similarity(const std::vector<float>& a, const std::vector<float>& b,
                  size_t start, size_t count, double lag, size_t stride) {
  double aa=0, bb=0, ab=0, sa=0, sb=0, n=0;
  for (size_t i=0; i<count; i+=stride) {
    const auto shift=static_cast<size_t>(lag);
    const double fraction=lag-shift;
    const auto x=a[start+i];
    const auto y=static_cast<float>(b[start+i+shift]+fraction*(b[start+i+shift+1]-b[start+i+shift]));
    if (!std::isfinite(x) || !std::isfinite(y)) return -1;
    aa+=x*x; bb+=y*y; ab+=x*y; sa+=x; sb+=y; ++n;
  }
  aa-=sa*sa/n; bb-=sb*sb/n; ab-=sa*sb/n;
  return aa > 1e-9 && bb > 1e-12 ? ab/std::sqrt(aa*bb) : -1;
}
}
WaveformResult correlate(std::span<const Point> source, std::span<const Point> returned,
                         uint64_t begin, double rate, double maxLagMs, double threshold, double controlRmsLimit) {
  WaveformResult r;
  if (source.empty() || returned.empty() || !std::isfinite(rate) || rate<8000 ||
      rate>192000 || !std::isfinite(maxLagMs) || maxLagMs<=0 || maxLagMs>500) return r;
  const size_t total=static_cast<size_t>(12*rate), window=static_cast<size_t>(.5*rate);
  const size_t maxLag=static_cast<size_t>(maxLagMs*rate/1000);
  auto a=project(source,begin,rate,total), b=project(returned,begin,rate,total);
  double energy=0, sourceEnergy=0; size_t count=0;
  for (size_t i=static_cast<size_t>(rate); i<static_cast<size_t>(3*rate); ++i) {
    if (!std::isfinite(a[i]) || !std::isfinite(b[i])) return r;
    sourceEnergy+=a[i]*a[i]; energy+=b[i]*b[i]; ++count;
  }
  if (sourceEnergy<1e-6) return r;
  r.controlRms=std::sqrt(energy/count);
  // A relaxed analog noise limit must not allow an unmuted correlated signal.
  const size_t controlStart=static_cast<size_t>(rate);
  for (size_t lag=0; lag<=maxLag; ++lag)
    r.controlCorrelation=std::max(r.controlCorrelation,
      similarity(a,b,controlStart,static_cast<size_t>(2*rate),lag,16));
  r.controlSilent=r.controlRms<controlRmsLimit && r.controlCorrelation<.2;
  r.minCorrelation=1;
  Moments delays;
  for (size_t segment=0; segment<2; ++segment) {
    size_t seek=static_cast<size_t>((4.1+4*segment)*rate);
    for (size_t w=0; w<3; ++w) {
      // Find a chirp, then include a short quiet lead. Do not select windows by
      // their returned waveform: absent output must reject the measurement.
      const auto limit=static_cast<size_t>((7.3+4*segment)*rate);
      while (seek<limit && (!std::isfinite(a[seek]) || std::abs(a[seek])<.02f)) ++seek;
      if (seek>=limit) return r;
      const size_t start=seek>static_cast<size_t>(.01*rate) ? seek-static_cast<size_t>(.01*rate) : seek;
      if (start+window+maxLag+1>=total) return r;
      double best=-1; size_t bestLag=0;
      // Coarse search at every eighth sample, then an exact sample search.
      for (size_t lag=0; lag<=maxLag; lag+=8) {
        const auto c=similarity(a,b,start,window,lag,8);
        if (c>best) { best=c; bestLag=lag; }
      }
      const auto lo=bestLag>16 ? bestLag-16 : 0, hi=std::min(maxLag,bestLag+16);
      best=-1;
      for (size_t lag=lo; lag<=hi; ++lag) {
        const auto c=similarity(a,b,start,window,lag,1);
        if (c>best) { best=c; bestLag=lag; }
      }
      double refined=bestLag;
      const double refineLo=std::max(0.0,static_cast<double>(bestLag)-1);
      const double refineHi=std::min(static_cast<double>(maxLag),static_cast<double>(bestLag)+1);
      for (double lag=refineLo; lag<=refineHi; lag+=.02) {
        const auto c=similarity(a,b,start,window,lag,1);
        if (c>best) { best=c; refined=lag; }
      }
      r.minCorrelation=std::min(r.minCorrelation,best);
      if (best<threshold) return r;
      delays.add(1000.0*refined/rate); ++r.windows;
      seek=start+static_cast<size_t>(.9*rate);
    }
  }
  r.delayMs=delays.mean; r.spreadMs=delays.maximum-delays.minimum;
  r.measured=r.controlSilent && r.windows==6 && r.spreadMs<=1000.0/rate;
  return r;
}
}

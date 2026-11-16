#pragma once
#include "diagnostics.h"
#include <iomanip>
#include <ostream>

namespace monitor_spike {
// Control-thread serialization only. No PCM, device UID or machine paths.
inline void writeDiagnostics(std::ostream& out, const Diagnostics& d, uint64_t origin, bool json) {
  out << std::setprecision(17);
  if (json) out << "{\"schema\":1,\"origin_ns\":" << origin << ",\"dropped\":" << d.dropped << ",\"rows\":[\n";
  else out << "since_start_s,host_ns,frame,flags,delta_ns,expected_ns,expected_frames,got_frames,correction_ns,nominal_hz,estimated_hz,queue_before_ms,queue_after_ms,history_discontinuities,clock_missing,support_missing,unpublished,expired,racing,callback_host_ns,callback_delta_ns,timestamp_quality\n";
  for (size_t i=0;i<d.used;++i) {
    const auto& r=d.rows[i];
    const double seconds=static_cast<double>(static_cast<long double>(r.ns)-origin)/1e9;
    if (json) {
      if (i) out << ",\n";
      out << "{\"since_start_s\":" << seconds << ",\"host_ns\":" << r.ns << ",\"frame\":" << r.frame
          << ",\"flags\":" << r.flags << ",\"delta_ns\":" << r.deltaNs << ",\"expected_ns\":" << r.expectedNs
          << ",\"expected_frames\":" << r.expectedFrames << ",\"got_frames\":" << r.gotFrames
          << ",\"correction_ns\":" << r.correctionNs << ",\"nominal_hz\":" << r.nominalHz << ",\"estimated_hz\":" << r.estimatedHz
          << ",\"queue_before_ms\":" << r.queueBeforeMs << ",\"queue_after_ms\":" << r.queueAfterMs
          << ",\"history_discontinuities\":" << r.historyDiscontinuities << ",\"clock_missing\":" << r.clockMissing
          << ",\"support_missing\":" << r.supportMissing << ",\"unpublished\":" << r.unpublished
          << ",\"expired\":" << r.expired << ",\"racing\":" << r.racing
          << ",\"callback_host_ns\":" << r.callbackNs << ",\"callback_delta_ns\":" << r.callbackDeltaNs
          << ",\"timestamp_quality\":" << r.timestampQuality << '}';
    } else out << seconds << ',' << r.ns << ',' << r.frame << ',' << r.flags << ',' << r.deltaNs << ',' << r.expectedNs
      << ',' << r.expectedFrames << ',' << r.gotFrames << ',' << r.correctionNs << ',' << r.nominalHz << ',' << r.estimatedHz
      << ',' << r.queueBeforeMs << ',' << r.queueAfterMs << ',' << r.historyDiscontinuities << ',' << r.clockMissing
      << ',' << r.supportMissing << ',' << r.unpublished << ',' << r.expired << ',' << r.racing
      << ',' << r.callbackNs << ',' << r.callbackDeltaNs << ',' << r.timestampQuality << '\n';
  }
  if (json) {
    out << "\n],\"delta_histogram\":[";
    for (size_t i=0;i<d.deltaHistogram.size();++i) { if (i) out << ','; out << d.deltaHistogram[i]; }
    out << "]}\n";
  }
}
inline void writeHistogram(std::ostream& out,const Diagnostics& d) {
  out << "delta_period_ratio_low,delta_period_ratio_high,count\n";
  for (size_t i=0;i<256;++i) out << i/64.0 << ',' << (i+1)/64.0 << ',' << d.deltaHistogram[i] << '\n';
  out << "4,inf," << d.deltaHistogram[256] << "\nnonmonotonic,nonmonotonic," << d.deltaHistogram[257] << '\n';
}
} // namespace monitor_spike

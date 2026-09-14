// The desktop open's lane measure against the full decode.
//
// The renderer used to take three things off Chromium's AudioBuffer for every
// lane before a song was on screen: the lane waveform (computePeaks), the
// phones' seek-bar envelope (laneEnvelope, the port of summarizeLanePeaks)
// and the silent-lane test. `measureLanes` takes the same three off the FILE
// through the streaming source, in blocks, on a thread per lane. This suite
// holds it to the up-front decode: the references below are the renderer's
// two algorithms transcribed literally over `prepareDecodedAudio`'s samples,
// partition and accumulation order included, so a bucket that lands one
// frame over fails here rather than as a lane that redraws when the singer
// presses Play and the Web Audio fallback decodes it for real.
#include "lane_measure.h"

#include <zcore/media/decoded_audio.h>

#include <FLAC/stream_encoder.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#if defined(_WIN32)
#include <fcntl.h>
#include <io.h>
#else
#include <fcntl.h>
#include <unistd.h>
#endif

namespace {

int failures = 0;

void check(bool ok, const char* what) {
  if (!ok) {
    std::fprintf(stderr, "FAIL  %s\n", what);
    failures++;
  }
}

std::string tempPath(const char* suffix) {
  static int counter = 0;
  const std::string base =
#if defined(_WIN32)
      std::string(std::getenv("TEMP") != nullptr ? std::getenv("TEMP") : ".");
#else
      std::string("/tmp");
#endif
  return base + "/singz_measure_" + std::to_string(counter++) + suffix;
}

singz::OwnedFileDescriptor openRead(const std::string& path) {
#if defined(_WIN32)
  int fd = -1;
  _sopen_s(&fd, path.c_str(), _O_RDONLY | _O_BINARY, _SH_DENYNO, 0);
#else
  const int fd = ::open(path.c_str(), O_RDONLY);
#endif
  return singz::OwnedFileDescriptor(fd);
}

// A stereo (or mono) FLAC with a different tone per channel and a beat of
// silence in the middle, so the envelope has shape and a bucket can be empty.
std::string encodeFlac(uint64_t frames, uint32_t rate, unsigned channels,
                       double amplitude = 9000.0) {
  const std::string path = tempPath(".flac");
  FLAC__StreamEncoder* e = FLAC__stream_encoder_new();
  FLAC__stream_encoder_set_channels(e, channels);
  FLAC__stream_encoder_set_bits_per_sample(e, 16);
  FLAC__stream_encoder_set_sample_rate(e, rate);
  FLAC__stream_encoder_set_compression_level(e, 5);
  FLAC__stream_encoder_set_total_samples_estimate(e, frames);
  if (FLAC__stream_encoder_init_file(e, path.c_str(), nullptr, nullptr) !=
      FLAC__STREAM_ENCODER_INIT_STATUS_OK) {
    FLAC__stream_encoder_delete(e);
    return {};
  }
  std::vector<FLAC__int32> block(4096 * channels);
  uint64_t at = 0;
  const uint64_t quietFrom = frames / 3;
  const uint64_t quietTo = frames / 3 + frames / 10;
  while (at < frames) {
    const uint64_t n = std::min<uint64_t>(4096, frames - at);
    for (uint64_t i = 0; i < n; i++) {
      const uint64_t frame = at + i;
      const bool quiet = frame >= quietFrom && frame < quietTo;
      for (unsigned c = 0; c < channels; c++)
        block[i * channels + c] =
            quiet ? 0
                  : static_cast<FLAC__int32>(std::lround(
                        amplitude * std::sin(frame * (0.011 + 0.003 * c))));
    }
    FLAC__stream_encoder_process_interleaved(e, block.data(),
                                             static_cast<unsigned>(n));
    at += n;
  }
  FLAC__stream_encoder_finish(e);
  FLAC__stream_encoder_delete(e);
  return path;
}

std::string writeWav(uint32_t frames, uint32_t rate) {
  const std::string path = tempPath(".wav");
  std::FILE* f = std::fopen(path.c_str(), "wb");
  if (f == nullptr) return {};
  const uint32_t dataBytes = frames * 2 * 2;
  auto u32 = [&](uint32_t v) { std::fwrite(&v, 4, 1, f); };
  auto u16 = [&](uint16_t v) { std::fwrite(&v, 2, 1, f); };
  std::fwrite("RIFF", 1, 4, f);
  u32(36 + dataBytes);
  std::fwrite("WAVE", 1, 4, f);
  std::fwrite("fmt ", 1, 4, f);
  u32(16);
  u16(1);
  u16(2);
  u32(rate);
  u32(rate * 4);
  u16(4);
  u16(16);
  std::fwrite("data", 1, 4, f);
  u32(dataBytes);
  for (uint32_t i = 0; i < frames * 2; i++) u16(static_cast<uint16_t>(i * 37));
  std::fclose(f);
  return path;
}

// computePeaks (src/renderer/src/audio/peaks.ts) before its normalization,
// transcribed: `step = length / buckets`, `start = floor(b * step)`,
// `end = b + 1 < buckets ? max(start + 1, floor((b + 1) * step)) : length`,
// the first two channels, `v > max`.
std::vector<float> referencePeaks(const singz::DecodedAudio& audio,
                                  uint32_t buckets) {
  std::vector<float> peaks(buckets, 0.0F);
  const uint64_t length = audio.frameCount();
  if (length == 0) return peaks;
  const double step = static_cast<double>(length) / static_cast<double>(buckets);
  const uint32_t channels = std::min<uint32_t>(2, audio.channelCount());
  for (uint32_t c = 0; c < channels; ++c) {
    const float* data = audio.channelData(c);
    for (uint32_t b = 0; b < buckets; ++b) {
      const uint64_t start =
          static_cast<uint64_t>(std::floor(static_cast<double>(b) * step));
      const uint64_t end =
          b + 1 < buckets
              ? std::max(start + 1, static_cast<uint64_t>(std::floor(
                                        static_cast<double>(b + 1) * step)))
              : length;
      float max = peaks[b];
      for (uint64_t i = start; i < end; ++i) {
        const float v = data[i] < 0 ? -data[i] : data[i];
        if (v > max) max = v;
      }
      peaks[b] = max;
    }
  }
  return peaks;
}

// summarizeLanePeaks (native_playback_session.cpp), transcribed.
std::array<float, singz::kLaneMeasureEnvelopeBuckets> referenceEnvelope(
    const singz::DecodedAudio& audio) {
  constexpr uint64_t buckets = singz::kLaneMeasureEnvelopeBuckets;
  std::array<float, buckets> out{};
  std::array<double, buckets> energy{};
  std::array<uint64_t, buckets> counted{};
  const uint64_t frames = audio.frameCount();
  for (uint32_t channel = 0; channel < audio.channelCount(); ++channel) {
    const float* samples = audio.channelData(channel);
    for (uint64_t bucket = 0; bucket < buckets; ++bucket) {
      const uint64_t begin = bucket * frames / buckets;
      uint64_t end = (bucket + 1) * frames / buckets;
      if (end <= begin) end = begin + 1;
      if (end > frames) end = frames;
      for (uint64_t frame = begin; frame < end; ++frame) {
        const float sample = samples[frame];
        if (!std::isfinite(sample)) continue;
        energy[bucket] += static_cast<double>(sample) * static_cast<double>(sample);
        ++counted[bucket];
      }
    }
  }
  for (uint64_t bucket = 0; bucket < buckets; ++bucket) {
    const double level =
        counted[bucket] == 0
            ? 0.0
            : std::sqrt(energy[bucket] / static_cast<double>(counted[bucket]));
    out[bucket] = level > 1.0 ? 1.0F : static_cast<float>(level);
  }
  return out;
}

double referenceRms(const singz::DecodedAudio& audio) {
  double sum = 0.0;
  uint64_t count = 0;
  for (uint32_t channel = 0; channel < audio.channelCount(); ++channel) {
    const float* samples = audio.channelData(channel);
    for (uint64_t frame = 0; frame < audio.frameCount(); ++frame) {
      sum += static_cast<double>(samples[frame]) * static_cast<double>(samples[frame]);
      ++count;
    }
  }
  return count == 0 ? 0.0 : std::sqrt(sum / static_cast<double>(count));
}

singz::DecodedAudioResult decodeAll(const std::string& path) {
  singz::DecodedAudioPrepareOptions options{};
  return singz::prepareDecodedAudio(openRead(path), options, {});
}

singz::LaneMeasureRequest request(const char* id, const std::string& path,
                                  singz::LaneMeasurePolicy policy = {}) {
  singz::LaneMeasureRequest r;
  r.id = id;
  r.descriptor = openRead(path);
  r.policy = policy;
  return r;
}

// Holds a measured lane against the two transcriptions and the header.
void compareLane(const singz::LaneMeasure& lane, const std::string& path,
                 uint32_t rate, uint32_t channels, const char* label) {
  const singz::DecodedAudioResult decoded = decodeAll(path);
  check(decoded.ok(), "the reference decode succeeds");
  if (!decoded.ok()) return;
  const singz::DecodedAudio& audio = *decoded.audio;
  std::string what;
  what = std::string(label) + ": the lane measured";
  check(lane.ok && lane.status == singz::DecodedAudioStatus::Ok, what.c_str());
  what = std::string(label) + ": the rate comes from the header";
  check(lane.sampleRate == rate, what.c_str());
  what = std::string(label) + ": the channel count comes from the header";
  check(lane.channels == channels, what.c_str());
  what = std::string(label) + ": the frame count is the decode's";
  check(lane.frameCount == audio.frameCount(), what.c_str());
  what = std::string(label) + ": the duration is frames over rate";
  check(std::fabs(lane.durationSeconds -
                  static_cast<double>(audio.frameCount()) / rate) < 1e-9,
        what.c_str());

  const uint32_t buckets = singz::laneMeasurePeakBuckets(lane.durationSeconds, {});
  what = std::string(label) + ": the bucket count is computePeaks' bucketsFor";
  check(lane.peaks.size() == buckets, what.c_str());
  const std::vector<float> peaks = referencePeaks(audio, buckets);
  size_t peakMismatches = 0;
  for (size_t b = 0; b < std::min(peaks.size(), lane.peaks.size()); ++b)
    if (peaks[b] != lane.peaks[b]) ++peakMismatches;
  what = std::string(label) + ": every fine peak equals computePeaks' (max is order-free)";
  check(peakMismatches == 0 && peaks.size() == lane.peaks.size(), what.c_str());
  bool anyPeak = false;
  for (float p : lane.peaks) anyPeak = anyPeak || p > 0.0F;
  what = std::string(label) + ": the peaks are not all zero";
  check(anyPeak, what.c_str());

  const auto envelope = referenceEnvelope(audio);
  double worstEnvelope = 0.0;
  for (size_t b = 0; b < envelope.size(); ++b)
    worstEnvelope = std::max(worstEnvelope,
                             std::fabs(static_cast<double>(envelope[b]) - lane.envelope[b]));
  // Per-frame-then-channel against per-channel-then-frame: the same doubles
  // summed in a different order, which agrees to rounding and no further.
  what = std::string(label) + ": the envelope is summarizeLanePeaks' to rounding";
  check(worstEnvelope < 1e-6, what.c_str());
  what = std::string(label) + ": the envelope has a quiet stretch and a loud one";
  float lo = 1.0F, hi = 0.0F;
  for (float v : lane.envelope) {
    lo = std::min(lo, v);
    hi = std::max(hi, v);
  }
  check(lo < 0.01F && hi > 0.1F, what.c_str());

  what = std::string(label) + ": the whole-lane RMS is the decode's to rounding";
  check(std::fabs(referenceRms(audio) - lane.rms) < 1e-6, what.c_str());
}

bool alwaysCancel(void*) noexcept { return true; }

}  // namespace

int main() {
  // 1. A stereo lane the length of a short song: the streaming regime.
  {
    const std::string flac = encodeFlac(44100 * 9 + 123, 44100, 2);
    check(!flac.empty(), "the stereo fixture encodes");
    if (flac.empty()) return 1;
    const singz::LaneMeasure lane = singz::measureLane(request("vocals", flac), {});
    check(lane.id == "vocals", "the id comes back");
    compareLane(lane, flac, 44100, 2, "stereo");
    std::remove(flac.c_str());
  }

  // 2. Mono at 48 kHz: one channel of peaks, the envelope over one channel.
  {
    const std::string flac = encodeFlac(48000 * 4 + 7, 48000, 1);
    check(!flac.empty(), "the mono fixture encodes");
    if (!flac.empty()) {
      const singz::LaneMeasure lane = singz::measureLane(request("drums", flac), {});
      compareLane(lane, flac, 48000, 1, "mono");
      std::remove(flac.c_str());
    }
  }

  // 3. The overlapping regime: fewer frames than the minimum bucket count.
  //    computePeaks counts a frame toward every bucket whose range holds it.
  {
    const std::string flac = encodeFlac(1000, 44100, 2);
    check(!flac.empty(), "the tiny fixture encodes");
    if (!flac.empty()) {
      const singz::LaneMeasure lane = singz::measureLane(request("tiny", flac), {});
      check(lane.peaks.size() == 2400, "a tiny lane still gets the minimum bucket count");
      compareLane(lane, flac, 44100, 2, "tiny");
      std::remove(flac.c_str());
    }
  }

  // 4. The bucket policy is bucketsFor: clamp(round(seconds * 1000), 2400, 400000).
  {
    check(singz::laneMeasurePeakBuckets(0.0, {}) == 2400, "zero seconds takes the minimum");
    check(singz::laneMeasurePeakBuckets(1.0, {}) == 2400, "one second takes the minimum");
    check(singz::laneMeasurePeakBuckets(2.4, {}) == 2400, "2.4 s is exactly the minimum");
    check(singz::laneMeasurePeakBuckets(2.4005, {}) == 2401, "2.4005 s rounds up past it");
    check(singz::laneMeasurePeakBuckets(323.06, {}) == 323060, "a five-minute song is one bucket per ms");
    check(singz::laneMeasurePeakBuckets(400.0, {}) == 400000, "400 s is exactly the maximum");
    check(singz::laneMeasurePeakBuckets(1200.0, {}) == 400000, "a long song takes the maximum");
    singz::LaneMeasurePolicy coarse;
    coarse.peaksPerSecond = 10;
    coarse.minimumPeaks = 5;
    coarse.maximumPeaks = 50;
    check(singz::laneMeasurePeakBuckets(3.0, coarse) == 30, "the policy is the caller's");
    check(singz::laneMeasurePeakBuckets(30.0, coarse) == 50, "and so is its ceiling");
    singz::LaneMeasurePolicy inverted;
    inverted.minimumPeaks = 100;
    inverted.maximumPeaks = 10;
    check(singz::laneMeasurePeakBuckets(1000.0, inverted) == 100,
          "a ceiling below the floor is raised to it rather than emptied");
  }

  // 5. Silence measures as silence: the rule that hides a guitar/piano lane.
  {
    const std::string flac = encodeFlac(44100 * 3, 44100, 2, 0.0);
    check(!flac.empty(), "the silent fixture encodes");
    if (!flac.empty()) {
      const singz::LaneMeasure lane = singz::measureLane(request("piano", flac), {});
      check(lane.ok, "a silent lane measures");
      check(lane.rms == 0.0F, "a silent lane's RMS is zero");
      bool allZero = true;
      for (float p : lane.peaks) allZero = allZero && p == 0.0F;
      for (float p : lane.envelope) allZero = allZero && p == 0.0F;
      check(allZero, "and every bucket is zero");
      std::remove(flac.c_str());
    }
  }

  // 6. What the source cannot open comes back refused with a status, so the
  //    caller decodes that one lane the old way.
  {
    const std::string wav = writeWav(4000, 44100);
    check(!wav.empty(), "the WAV fixture writes");
    if (!wav.empty()) {
      const singz::LaneMeasure lane = singz::measureLane(request("other", wav), {});
      check(!lane.ok, "a WAV is refused — the streaming source reads FLAC");
      check(lane.status != singz::DecodedAudioStatus::Ok, "and says why");
      check(lane.peaks.empty(), "a refused lane carries no peaks");
      std::remove(wav.c_str());
    }
    singz::LaneMeasureRequest missing;
    missing.id = "missing";
    missing.descriptor = singz::OwnedFileDescriptor(-1);
    const singz::LaneMeasure lane = singz::measureLane(std::move(missing), {});
    check(!lane.ok && lane.id == "missing", "a lane with no descriptor is refused, and named");
  }

  // 7. Cancellation is honoured between blocks.
  {
    const std::string flac = encodeFlac(44100 * 6, 44100, 2);
    if (!flac.empty()) {
      singz::DecodeCancellation cancel;
      cancel.requested = alwaysCancel;
      const singz::LaneMeasure lane = singz::measureLane(request("bass", flac), cancel);
      check(!lane.ok && lane.status == singz::DecodedAudioStatus::Cancelled,
            "a cancelled measure reports Cancelled and nothing else");
      std::remove(flac.c_str());
    }
  }

  // 8. Several lanes at once: one thread each, results in request order, a
  //    refused lane beside measured ones.
  {
    const std::string a = encodeFlac(44100 * 5, 44100, 2);
    const std::string b = encodeFlac(48000 * 3, 48000, 2);
    const std::string w = writeWav(3000, 44100);
    const std::string c = encodeFlac(44100 * 2, 44100, 1);
    if (!a.empty() && !b.empty() && !w.empty() && !c.empty()) {
      std::vector<singz::LaneMeasureRequest> requests;
      requests.push_back(request("vocals", a));
      requests.push_back(request("drums", b));
      requests.push_back(request("other", w));
      requests.push_back(request("bass", c));
      const std::vector<singz::LaneMeasure> lanes =
          singz::measureLanes(std::move(requests), {});
      check(lanes.size() == 4, "every lane answers");
      if (lanes.size() == 4) {
        check(lanes[0].id == "vocals" && lanes[1].id == "drums" &&
                  lanes[2].id == "other" && lanes[3].id == "bass",
              "results come back in request order");
        compareLane(lanes[0], a, 44100, 2, "parallel vocals");
        compareLane(lanes[1], b, 48000, 2, "parallel drums");
        check(!lanes[2].ok, "the WAV is refused in the middle of the set");
        compareLane(lanes[3], c, 44100, 1, "parallel bass");
      }
    } else {
      check(false, "the parallel fixtures encode");
    }
    for (const std::string& p : {a, b, w, c})
      if (!p.empty()) std::remove(p.c_str());
  }

  if (failures == 0) std::printf("lane_measure_tests: all checks passed\n");
  return failures == 0 ? 0 : 1;
}

// Host-compiled checks for the ORT-free half of mobile/native/core: the
// resampler's quality claim and the WAV writer's byte contract. The
// overlap-add loop and the resume tail live inside split_engine.cpp next to
// the ORT session and are proven on-device instead (the LSB-parity gate and
// the kill/resume run in mobile/tests/split-android.cjs) — reimplementing
// them here would test the reimplementation.
//
// Built by scripts/run-core-host-tests.sh (plain c++, no NDK), run by the
// Android CI canary.
#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "resample.h"
#include "wav.h"

static int failures = 0;
#define CHECK(label, cond)                                        \
  do {                                                            \
    const bool ok = (cond);                                       \
    std::printf("%s  %s\n", ok ? "PASS" : "FAIL", label);         \
    if (!ok) failures++;                                          \
  } while (0)

static std::vector<float> sine(double hz, int rate, int frames, int channels) {
  std::vector<float> out(static_cast<size_t>(frames) * channels);
  for (int i = 0; i < frames; i++) {
    const float v = static_cast<float>(0.5 * std::sin(2.0 * M_PI * hz * i / rate));
    for (int c = 0; c < channels; c++) out[static_cast<size_t>(i) * channels + c] = v;
  }
  return out;
}

static void resamplerTests() {
  {
    singz::Resampler r(44100, 44100, 2);
    CHECK("identity rate is passthrough", r.passthrough());
  }
  {
    // 48k -> 44.1k, 1 kHz sine: compare against the ideal output sine.
    // Phase is preserved by the polyphase design; skip the warm-up head and
    // the tail, measure SNR over the steady middle.
    const int srcRate = 48000, dstRate = 44100, seconds = 2;
    singz::Resampler r(srcRate, dstRate, 2);
    const auto in = sine(1000.0, srcRate, srcRate * seconds, 2);
    std::vector<float> out;
    r.process(in.data(), srcRate * seconds, out);
    r.flush(out);
    const int outFrames = static_cast<int>(out.size() / 2);
    {
      char label[96];
      std::snprintf(label, sizeof label,
                    "48k->44.1k frame count within the filter tail (delta %d)",
                    outFrames - dstRate * seconds);
      // flush() pushes the filter history through, so up to a tap's worth of
      // extra frames is by design; the engine sizes from the file, not from
      // arithmetic.
      CHECK(label, outFrames >= dstRate * seconds &&
                       outFrames <= dstRate * seconds + 64);
    }

    // Fit A*sin + B*cos at the test frequency over the steady middle — the
    // residual is genuine distortion + aliasing, immune to this harness's
    // guesses about group delay or passband gain (a quarter-sample delay
    // error alone reads as ~37 dB and says nothing about the filter).
    const int head = dstRate / 10, tail = dstRate / 10;
    double ss = 0, sc = 0, cc = 0, ys = 0, yc = 0;
    for (int i = head; i < outFrames - tail; i++) {
      const double ph = 2.0 * M_PI * 1000.0 * i / dstRate;
      const double sn = std::sin(ph), cs = std::cos(ph);
      const double y = out[static_cast<size_t>(i) * 2];
      ss += sn * sn; sc += sn * cs; cc += cs * cs;
      ys += y * sn; yc += y * cs;
    }
    const double det = ss * cc - sc * sc;
    const double A = (ys * cc - yc * sc) / det;
    const double B = (yc * ss - ys * sc) / det;
    double sig = 0, noise = 0;
    for (int i = head; i < outFrames - tail; i++) {
      const double ph = 2.0 * M_PI * 1000.0 * i / dstRate;
      const double fit = A * std::sin(ph) + B * std::cos(ph);
      const double e = out[static_cast<size_t>(i) * 2] - fit;
      sig += fit * fit;
      noise += e * e;
    }
    const double snr = 10.0 * std::log10(sig / (noise > 0 ? noise : 1e-30));
    char label[96];
    std::snprintf(label, sizeof label, "in-band sine SNR > 90 dB (measured %.1f dB)", snr);
    CHECK(label, snr > 90.0);
    const double gain = std::sqrt(A * A + B * B) / 0.5;
    std::snprintf(label, sizeof label, "passband gain within 0.1 dB (%.4f)", gain);
    CHECK(label, gain > 0.9886 && gain < 1.0116);
  }
  {
    // Streaming in blocks must equal one-shot processing byte for byte —
    // the history rebase is exactly the thing that can go quietly wrong.
    const int srcRate = 22050, dstRate = 44100;
    const auto in = sine(440.0, srcRate, srcRate, 2);
    singz::Resampler oneShot(srcRate, dstRate, 2);
    std::vector<float> a;
    oneShot.process(in.data(), srcRate, a);
    oneShot.flush(a);
    singz::Resampler streamed(srcRate, dstRate, 2);
    std::vector<float> b;
    const int block = 1024;
    for (int at = 0; at < srcRate; at += block) {
      const int n = std::min(block, srcRate - at);
      streamed.process(in.data() + static_cast<size_t>(at) * 2, n, b);
    }
    streamed.flush(b);
    bool same = a.size() == b.size();
    for (size_t i = 0; same && i < a.size(); i++) same = a[i] == b[i];
    CHECK("streamed == one-shot, bit for bit", same);
  }
}

static std::vector<unsigned char> slurp(const std::string& path) {
  std::vector<unsigned char> out;
  std::FILE* f = std::fopen(path.c_str(), "rb");
  if (!f) return out;
  std::fseek(f, 0, SEEK_END);
  out.resize(static_cast<size_t>(std::ftell(f)));
  std::fseek(f, 0, SEEK_SET);
  if (!out.empty() && std::fread(out.data(), 1, out.size(), f) != out.size()) out.clear();
  std::fclose(f);
  return out;
}

static void wavTests() {
  const std::string path = "/tmp/singz-core-host-test.wav";
  std::remove(path.c_str());
  {
    // Golden bytes: header fields + lrintf scaling, including the clamp.
    singz::WavWriter w;
    CHECK("fresh open", w.open(path, 44100, 2));
    const float frames[8] = {0.0f, 0.5f, -0.5f, 1.0f, -1.0f, 2.0f, -2.0f, 0.25f};
    CHECK("write 4 frames", w.append(frames, 4));
    CHECK("finalize", w.finalize());
    CHECK("finalize twice is fine", w.finalize());
    const auto b = slurp(path);
    CHECK("file is 44 + 16 bytes", b.size() == 60);
    CHECK("RIFF/WAVE/fmt/data markers",
          !std::memcmp(&b[0], "RIFF", 4) && !std::memcmp(&b[8], "WAVE", 4) &&
          !std::memcmp(&b[12], "fmt ", 4) && !std::memcmp(&b[36], "data", 4));
    auto u32 = [&](size_t at) {
      return static_cast<uint32_t>(b[at]) | (static_cast<uint32_t>(b[at + 1]) << 8) |
             (static_cast<uint32_t>(b[at + 2]) << 16) | (static_cast<uint32_t>(b[at + 3]) << 24);
    };
    auto s16 = [&](size_t frame, int ch) {
      const size_t at = 44 + (frame * 2 + static_cast<size_t>(ch)) * 2;
      return static_cast<int16_t>(static_cast<uint16_t>(b[at]) |
                                  (static_cast<uint16_t>(b[at + 1]) << 8));
    };
    CHECK("RIFF size", u32(4) == 52);
    CHECK("sample rate 44100", u32(24) == 44100);
    CHECK("byte rate", u32(28) == 44100u * 4u);
    CHECK("data size 16", u32(40) == 16);
    CHECK("0.0 -> 0", s16(0, 0) == 0);
    CHECK("0.5 -> 16384 (lrintf, not truncation)", s16(0, 1) == 16384);
    CHECK("-0.5 -> -16384", s16(1, 0) == -16384);
    CHECK("1.0 -> 32767", s16(1, 1) == 32767);
    CHECK("-1.0 -> -32767 (symmetric scale)", s16(2, 0) == -32767);
    CHECK("+2.0 clamps to 32767", s16(2, 1) == 32767);
    CHECK("-2.0 clamps to -32768 (the desktop renderer's floor)", s16(3, 0) == -32768);
    CHECK("0.25 -> 8192", s16(3, 1) == 8192);
  }
  {
    // Append-resume: reopen claiming 4 existing frames, add 2, and the
    // header must account for all 6.
    singz::WavWriter w;
    CHECK("append open with matching size", w.open(path, 44100, 2, 4));
    const float more[4] = {0.25f, 0.25f, -0.25f, -0.25f};
    CHECK("append 2 frames", w.append(more, 2));
    CHECK("flush is callable", w.flush());
    CHECK("finalize appended", w.finalize());
    const auto b = slurp(path);
    CHECK("6 frames on disk", b.size() == 44 + 24);
    auto u32 = [&](size_t at) {
      return static_cast<uint32_t>(b[at]) | (static_cast<uint32_t>(b[at + 1]) << 8) |
             (static_cast<uint32_t>(b[at + 2]) << 16) | (static_cast<uint32_t>(b[at + 3]) << 24);
    };
    // The header must ACCOUNT for the pre-existing frames, not just the
    // appended ones — dropping existingFrames in open() would still pass a
    // bare size check.
    CHECK("RIFF size counts all 6 frames", u32(4) == 60);
    CHECK("data size counts all 6 frames", u32(40) == 24);
  }
  {
    // The size backstop: a tail claiming more frames than the file holds
    // must refuse the append (the engine then falls back to a fresh start).
    singz::WavWriter w;
    CHECK("append open with an overstated tail refuses", !w.open(path, 44100, 2, 100));
  }
  std::remove(path.c_str());
}

int main() {
  resamplerTests();
  wavTests();
  std::printf(failures == 0 ? "\nALL CORE HOST TESTS PASS\n" : "\n%d FAILURE(S)\n", failures);
  return failures == 0 ? 0 : 1;
}

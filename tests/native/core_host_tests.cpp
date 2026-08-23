// Host-compiled checks for the ORT-free half of mobile/native/core: the
// resampler's quality claim and the WAV writer's byte contract. The
// overlap-add loop and the resume tail live inside split_engine.cpp next to
// the ORT session and are proven on-device instead (the LSB-parity gate and
// the kill/resume run in mobile/tests/split-android.cjs) — reimplementing
// them here would test the reimplementation.
//
// Built by scripts/run-core-host-tests.sh (plain c++, no NDK), run by the
// Android CI canary.
#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "analysis.h"
#include "flac_io.h"
#include "beat_this.h"
#include "beats.h"
#include "melody.h"
#include "resample.h"
#include "wav.h"

static int failures = 0;

// Scratch directory for the wav/flac fixtures the suites write. TMPDIR is the
// POSIX answer; Windows sets TEMP (never TMPDIR) and has no /tmp, which made
// every hardcoded literal here a harness failure on the first MSVC run — the
// core was healthy, the paths were not.
static std::string scratchDir() {
  if (const char* t = std::getenv("TMPDIR")) return t;
  if (const char* t = std::getenv("TEMP")) return t;
  return "/tmp";
}
// The internal name is deliberately ugly: it used to be `ok`, and a test
// whose own local was called `ok` expanded to `const bool ok = (ok);` —
// self-initialisation, so the check read garbage and reported FAIL on code
// that was working (measured: the beats front-end, which the CLI and a
// standalone probe both ran correctly at the same moment). A macro that
// silently captures the caller's names is a trap for every test after it.
#define CHECK(label, cond)                                        \
  do {                                                            \
    const bool check_ok_ = (cond);                                \
    std::printf("%s  %s\n", check_ok_ ? "PASS" : "FAIL", label);  \
    if (!check_ok_) failures++;                                   \
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
    // 44.1k -> 22.05k, the Beat This! input path: a DECIMATION, where the
    // filter actually has to work. The 1 kHz/48k->44.1k check above is
    // nearly unity ratio and cannot see a short filter — it read 110 dB while
    // the 2:1 case was a 24-tap lowpass aliasing 14 kHz back at -25 dB
    // (measured; cymbals onto the band the beat model listens to, a
    // different grid from the same stems). Gate the alias floor and the
    // passband edge, not a tone that sits comfortably in the middle.
    const int srcRate = 44100, dstRate = 22050, seconds = 2;
    auto gainAt = [&](double hz) {
      singz::Resampler r(srcRate, dstRate, 1);
      const auto in = sine(hz, srcRate, srcRate * seconds, 1);
      std::vector<float> out;
      r.process(in.data(), srcRate * seconds, out);
      r.flush(out);
      const int n = static_cast<int>(out.size()), head = dstRate / 10, tail = dstRate / 10;
      // above the new Nyquist a tone lands at its alias
      const double f = hz < dstRate / 2.0 ? hz : std::fabs(hz - dstRate);
      double ss = 0, sc = 0, cc = 0, ys = 0, yc = 0;
      for (int i = head; i < n - tail; i++) {
        const double ph = 2.0 * M_PI * f * i / dstRate, sn = std::sin(ph), cs = std::cos(ph), y = out[i];
        ss += sn * sn; sc += sn * cs; cc += cs * cs; ys += y * sn; yc += y * cs;
      }
      const double det = ss * cc - sc * sc, A = (ys * cc - yc * sc) / det, B = (yc * ss - ys * sc) / det;
      return 20.0 * std::log10(std::sqrt(A * A + B * B) / 0.5);
    };
    char label[128];
    const double g9k = gainAt(9000.0), g10k = gainAt(10000.0), a14k = gainAt(14000.0), a12k = gainAt(12000.0);
    // The decimating design is swresample's published one (32 taps/net
    // decimation, beta 9, cutoff 0.97) — adopted by GT measurement over the
    // old brick wall (resample.cpp says why). Its passband edge droops like
    // the winner's: ffmpeg-swr itself measures -0.01 dB at 9 kHz and
    // -1.29 dB at 10 kHz on this exact ratio, and our port sits within
    // 0.11 dB of that. Gate the shape we adopted, not the wall we left.
    std::snprintf(label, sizeof label, "2:1 passband flat to 9 kHz (%.2f dB)", g9k);
    CHECK(label, g9k > -0.15);
    std::snprintf(label, sizeof label, "2:1 edge at 10 kHz within swr's droop (%.2f dB)", g10k);
    CHECK(label, g10k > -2.0 && g10k < -0.7);
    std::snprintf(label, sizeof label, "2:1 alias of 14 kHz below -60 dB (%.1f dB)", a14k);
    CHECK(label, a14k < -60.0);
    std::snprintf(label, sizeof label, "2:1 alias of 12 kHz below -30 dB (%.1f dB)", a12k);
    CHECK(label, a12k < -30.0);
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
  const std::string path = scratchDir() + "/singz-core-host-test.wav";
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

// The melody tracker (melody.cpp) — a synthetic phrase with known pitches
// comes back at those pitches, voiced where sung and silent in the rest,
// and the WAV reader feeds it the same samples the raw path gets. The
// bit-parity claim against the desktop TS is NOT provable here (it needs
// node): eval/melody-parity.mjs runs singz-analyze against trackMelodyCore
// over real stems, and mobile/tests asserts it on device.
static void melodyTests() {
  const int sr = 44100;
  const int frames = sr * 6;
  std::vector<float> mono(static_cast<size_t>(frames), 0.0f);
  // 2 s of A3 (220 Hz), 1 s of rest, 2 s of E4 (329.63 Hz), 1 s of rest —
  // with a touch of second harmonic so it looks like a voice to CMND.
  double ph = 0;
  for (int i = 0; i < frames; i++) {
    const double t = static_cast<double>(i) / sr;
    double hz = 0;
    if (t < 2) hz = 220;
    else if (t >= 3 && t < 5) hz = 329.63;
    if (hz > 0) {
      ph += 2 * M_PI * hz / sr;
      mono[static_cast<size_t>(i)] = static_cast<float>(0.3 * std::sin(ph) + 0.05 * std::sin(2 * ph));
    }
  }
  const singz::MelodyTrack t = singz::trackMelody(mono.data(), mono.size(), sr, nullptr);
  CHECK("melody: hop is 25 ms of the decimated rate", std::fabs(t.hopSec - 368.0 / 14700.0) < 1e-12);
  CHECK("melody: one frame per hop over the song", t.f0.size() == static_cast<size_t>((frames / 3 - 1024) / 368));
  auto median = [&](double t0, double t1) {
    std::vector<double> v;
    for (size_t i = 0; i < t.f0.size(); i++) {
      const double tt = i * t.hopSec;
      if (tt >= t0 && tt < t1 && t.f0[i] > 0) v.push_back(t.f0[i]);
    }
    if (v.empty()) return 0.0;
    std::sort(v.begin(), v.end());
    return v[v.size() / 2];
  };
  auto voicedFrac = [&](double t0, double t1) {
    int n = 0, v = 0;
    for (size_t i = 0; i < t.f0.size(); i++) {
      const double tt = i * t.hopSec;
      if (tt >= t0 && tt < t1) {
        n++;
        if (t.f0[i] > 0) v++;
      }
    }
    return n ? static_cast<double>(v) / n : 0.0;
  };
  const double a3 = median(0.2, 1.8), e4 = median(3.2, 4.8);
  CHECK("melody: A3 phrase tracked within 2 cents", a3 > 0 && std::fabs(1200 * std::log2(a3 / 220)) < 2);
  CHECK("melody: E4 phrase tracked within 2 cents", e4 > 0 && std::fabs(1200 * std::log2(e4 / 329.63)) < 2);
  CHECK("melody: sung stretches are voiced", voicedFrac(0.2, 1.8) > 0.95 && voicedFrac(3.2, 4.8) > 0.95);
  CHECK("melody: rests are silent (RMS gate)", voicedFrac(2.2, 2.9) < 0.05 && voicedFrac(5.2, 5.9) < 0.05);

  // The reader: write the phrase as PCM16 stereo (the split's own format),
  // read it back mono, track — same pitches; and the fold matches the JS
  // fold to the bit on a stereo pair (L != R).
  const std::string path = scratchDir() + "/singz-melody-test.wav";
  {
    singz::WavWriter w;
    CHECK("reader: fixture written", w.open(path, sr, 2));
    std::vector<float> st(static_cast<size_t>(frames) * 2);
    for (int i = 0; i < frames; i++) {
      st[static_cast<size_t>(i) * 2] = mono[static_cast<size_t>(i)];
      st[static_cast<size_t>(i) * 2 + 1] = mono[static_cast<size_t>(i)] * 0.5f;
    }
    w.append(st.data(), frames);
    w.finalize();
  }
  const singz::MonoWav r = singz::readWavMono(path);
  CHECK("reader: PCM16 stereo read", r.ok && r.sampleRate == sr && r.channels == 2 && r.samples.size() == static_cast<size_t>(frames));
  if (r.ok) {
    // JS fold of the same PCM16 pair — ((0 + L/2) as f32 + R/2) as f32 with
    // L, R = s / 32768 — computed from the shorts ON DISK (the writer's own
    // 44-byte header, then interleaved int16), so this checks the reader's
    // fold and nothing about the writer's rounding.
    bool foldOk = true;
    std::FILE* f = std::fopen(path.c_str(), "rb");
    if (f != nullptr) {
      std::fseek(f, 44, SEEK_SET);
      std::vector<int16_t> pcm(static_cast<size_t>(frames) * 2);
      const size_t got = std::fread(pcm.data(), sizeof(int16_t), pcm.size(), f);
      std::fclose(f);
      if (got != pcm.size()) foldOk = false;
      for (int i = 0; i < frames && foldOk; i += 997) {
        const double L = pcm[static_cast<size_t>(i) * 2] / 32768.0;
        const double R = pcm[static_cast<size_t>(i) * 2 + 1] / 32768.0;
        const float js = static_cast<float>(static_cast<double>(static_cast<float>(0 + L / 2)) + R / 2);
        if (js != r.samples[static_cast<size_t>(i)]) foldOk = false;
      }
    } else {
      foldOk = false;
    }
    CHECK("reader: channel fold matches the JS fold to the bit", foldOk);
    const singz::MelodyTrack t2 = singz::trackMelody(r.samples.data(), r.samples.size(), r.sampleRate, nullptr);
    CHECK("reader→tracker: same frame count", t2.f0.size() == t.f0.size());
  }
  // The header alone says the same, without reading a sample.
  const singz::WavInfo info = singz::readWavInfo(path);
  CHECK("reader: header-only info matches", info.ok && info.sampleRate == sr && info.channels == 2 && info.frames == frames);
  // A header that lies about its size (streaming encoders write 0xFFFFFFFF;
  // a truncated file states more than it holds) must clamp to the bytes on
  // disk, never allocate what it claims.
  {
    std::FILE* f = std::fopen(path.c_str(), "r+b");
    if (f != nullptr) {
      const unsigned char huge[4] = {0xFF, 0xFF, 0xFF, 0xFF};
      std::fseek(f, 40, SEEK_SET);  // canonical header: data size at 40
      std::fwrite(huge, 1, 4, f);
      std::fclose(f);
    }
    const singz::WavInfo lying = singz::readWavInfo(path);
    CHECK("reader: a lying data size clamps to the file", lying.ok && lying.frames == frames);
    const singz::MonoWav r2 = singz::readWavMono(path);
    CHECK("reader: and reads what is there", r2.ok && r2.samples.size() == static_cast<size_t>(frames));
  }
  std::remove(path.c_str());
}

// The key detector (analysis.cpp): a synthetic C-major triad bed comes back
// as C major, and a silent bed has no answer at all. The bit-parity claim
// against the desktop TS lives in eval/key-parity.mjs (node-side, over real
// projects) — this is the shape check that runs with no corpus.
static void keyTests() {
  const int sr = 44100;
  const int frames = sr * 12;
  auto tone = [&](double hz, std::vector<float>& out, double amp) {
    double ph = 0;
    for (int i = 0; i < frames; i++) {
      ph += 2 * M_PI * hz / sr;
      out[static_cast<size_t>(i)] += static_cast<float>(amp * std::sin(ph));
    }
  };
  // C major: C3 (130.81), E3 (164.81), G3 (196.00), with C2 in the bass.
  singz::AnalysisStem inst;
  inst.mono.assign(static_cast<size_t>(frames), 0.0f);
  inst.sampleRate = sr;
  tone(130.81, inst.mono, 0.25);
  tone(164.81, inst.mono, 0.20);
  tone(196.00, inst.mono, 0.22);
  singz::AnalysisStem bass;
  bass.mono.assign(static_cast<size_t>(frames), 0.0f);
  bass.sampleRate = sr;
  tone(65.41, bass.mono, 0.30);
  const singz::KeyGuess k = singz::estimateKeyFromStems({inst}, &bass);
  CHECK("key: a C-major triad bed reads as C major", k.ok && k.pc == 0 && !k.minor);
  CHECK("key: stamp is the TS's KEY_DETECT_VERSION", singz::kKeyDetectVersion == 2);

  singz::AnalysisStem silent;
  silent.mono.assign(static_cast<size_t>(frames), 0.0f);
  silent.sampleRate = sr;
  const singz::KeyGuess q = singz::estimateKeyFromStems({silent}, nullptr);
  CHECK("key: a silent bed has no answer (never a stored key)", !q.ok);

  // Too little audio to judge: fewer than 8 chroma frames is the TS's floor.
  singz::AnalysisStem tiny;
  tiny.mono.assign(16384 * 4, 0.1f);
  tiny.sampleRate = sr;
  CHECK("key: too short to judge answers nothing", !singz::estimateKeyFromStems({tiny}, nullptr).ok);

  // estimateKey — the melody-histogram fallback. Nothing in the app reaches
  // it yet (the phone shows no key readout), so without this it would be a
  // ported detector with no coverage at all, which is where a parity defect
  // waits until the day it is wired up. A C-major scale weighted toward the
  // tonic reads C major; under 100 voiced frames there is no answer.
  {
    const double scale[7] = {261.63, 293.66, 329.63, 349.23, 392.00, 440.00, 493.88};  // C D E F G A B
    std::vector<float> f0;
    for (int rep = 0; rep < 40; rep++)
      for (int i = 0; i < 7; i++) {
        // The tonic and dominant held longer, as a real melody does — a flat
        // histogram has no key and the correlation would pick arbitrarily.
        const int hold = (i == 0 || i == 4) ? 4 : 2;
        for (int h = 0; h < hold; h++) f0.push_back(static_cast<float>(scale[i]));
      }
    const singz::KeyGuess mk = singz::estimateKey(f0.data(), f0.size());
    CHECK("key: a C-major melody histogram reads as C major", mk.ok && mk.pc == 0 && !mk.minor);
    CHECK("key: under 100 voiced frames there is no answer",
          !singz::estimateKey(f0.data(), 99).ok);
  }
}

// The beat tracker's front end (beats.cpp): a synthetic click train at a
// known tempo is found at that tempo and not at an octave of it, and material
// with no impulsive onsets is refused rather than given a metronome. The
// bit-parity claim against the desktop TS lives in eval/beats-parity.mjs,
// which compares stage by stage over real stems.
static void beatsTests() {
  const int sr = 44100;
  const int frames = sr * 30;
  singz::AnalysisStem drums;
  drums.mono.assign(static_cast<size_t>(frames), 0.0f);
  drums.sampleRate = sr;
  // 120 bpm: a click every 0.5 s, accented every fourth.
  const double period = 0.5 * sr;
  for (int b = 0; b * period < frames - 400; b++) {
    const int st = static_cast<int>(std::lrint(b * period));
    const double amp = (b % 4 == 0) ? 0.95 : 0.6;
    for (int i = 0; i < 300; i++)
      drums.mono[static_cast<size_t>(st + i)] += static_cast<float>(amp * std::exp(-i / 30.0) * std::sin(i * 0.5));
  }
  singz::BeatDebug d;
  const singz::DrumLattice lat = singz::trackFromDrums(drums, {}, d);
  const bool ok = lat.ok;
  CHECK("beats: a 120 bpm click train is tracked", ok);
  CHECK("beats: at 120 bpm, not an octave of it",
        ok && std::fabs(d.chosenBpm - 120) < 2.0);
  CHECK("beats: the windows agree (not rubato)", ok && d.consistency >= 0.6);
  CHECK("beats: the lattice has a beat every ~0.5 s", ok && std::fabs(lat.medSec - 0.5) < 0.02 &&
        lat.beatsSec.size() > 50);
  CHECK("beats: stamp is the TS's BEAT_DETECT_VERSION", singz::kBeatDetectVersion == 23);

  // The meter test: a straight 4/4 click train must NOT read as compound.
  // (Its 6/8 counterpart is a library fact rather than a synthesis one —
  // Nothing Else Matters measures ac3/ac4 = 2.61 and comes out 6, which the
  // parity harness checks against the TS on the real stem.)
  singz::BeatAux noAux;
  // MlPhaseCtx{} is "no model on this device" — every field then reads as the
  // TS reads an absent aux.ml, which is the path this fixture is about.
  const singz::BarPhase phase = singz::barPhase(lat, drums, noAux, singz::MlPhaseCtx{}, d);
  CHECK("beats: a straight click train is 4/4, not compound", phase.ok && phase.beatsPerBar == 4);
  CHECK("beats: and its beats are nearly all active", phase.ok && d.activeBeats > 50);

  // A sustained pad has periodicity but no attacks — it must be refused.
  singz::AnalysisStem pad;
  pad.mono.assign(static_cast<size_t>(frames), 0.0f);
  pad.sampleRate = sr;
  double ph = 0;
  for (int i = 0; i < frames; i++) {
    ph += 2 * M_PI * 220 / sr;
    pad.mono[static_cast<size_t>(i)] = static_cast<float>(0.3 * std::sin(ph));
  }
  singz::BeatDebug pd;
  CHECK("beats: a sustained pad earns no metronome", !singz::trackFromDrums(pad, {}, pd).ok);
  CHECK("beats: and says why", !pd.reject.empty());
}

// sumStemsTo22k (beat_this.cpp) — the from-stems ML input. The resampler's
// QUALITY is gated above; these gate the wiring around it: the pad-to-max
// sum, the 44.1 kHz refusal, and that the whole path equals Resampler(sum) —
// so a future "optimisation" that resamples per stem, drops the tail flush
// or truncates to the shortest stem turns a light red here instead of a
// slightly different grid on a phone.
static void sumStemsTests() {
  const std::string a = scratchDir() + "/singz-core-host-sum-a.wav";
  const std::string b = scratchDir() + "/singz-core-host-sum-b.wav";
  // Quarters survive the writer/reader pair exactly (0.25 -> 8192 -> 0.25:
  // the writer scales by 32767 with lrintf, the reader divides by 32768), so
  // the sum below is checked with == and not a tolerance.
  const int an = 1200;
  const int bn = 700;  // shorter: the tail of `a` must arrive unsummed
  std::vector<float> av(an), bv(bn);
  for (int i = 0; i < an; i++) av[static_cast<size_t>(i)] = (i % 2 == 0) ? 0.25f : -0.5f;
  for (int i = 0; i < bn; i++) bv[static_cast<size_t>(i)] = (i % 3 == 0) ? 0.5f : -0.25f;
  {
    singz::WavWriter w;
    w.open(a, 44100, 1);
    w.append(av.data(), an);
    w.finalize();
  }
  {
    singz::WavWriter w;
    w.open(b, 44100, 1);
    w.append(bv.data(), bn);
    w.finalize();
  }

  std::string err;
  const std::vector<float> got = singz::sumStemsTo22k({a, b}, err);
  CHECK("two stems sum without error", err.empty());

  // The reference: hand-sum (padding b with silence), the equal-power gain,
  // then the very Resampler the function is contracted to use, made
  // time-true the same way — latency dropped, tail cut to inLen/2. The
  // contract this pins moved twice by measurement (beat_this.cpp says why):
  // the model's input is sample i == the song at i/22050 s, at -3 dB
  // pan-law level.
  std::vector<float> mix(static_cast<size_t>(an), 0.0f);
  for (int i = 0; i < an; i++) mix[static_cast<size_t>(i)] += av[static_cast<size_t>(i)];
  for (int i = 0; i < bn; i++) mix[static_cast<size_t>(i)] += bv[static_cast<size_t>(i)];
  for (float& v : mix) v *= 1.4142135623730951f;
  singz::Resampler rs(44100, singz::kBeatThisSr, 1);
  std::vector<float> want;
  rs.process(mix.data(), an, want);
  rs.flush(want);
  const size_t latency = static_cast<size_t>(rs.latencyOutFrames());
  if (want.size() > latency) want.erase(want.begin(), want.begin() + static_cast<long>(latency));
  if (want.size() > static_cast<size_t>(an) / 2) want.resize(static_cast<size_t>(an) / 2);
  bool same = got.size() == want.size();
  for (size_t i = 0; same && i < got.size(); i++) same = got[i] == want[i];
  CHECK("sum+decimate == Resampler(hand-sum), time-true", same);
  // Exactly half the frames now: latency dropped at the head, the flush
  // tail cut at inLen/2 — time-true output has no filter overhang. A
  // missing flush() would come up short and fail the identity check above.
  CHECK("output is exactly half the frames (time-true)",
        got.size() == static_cast<size_t>(an / 2));

  // Refusals say why, with the path in the message.
  const std::vector<float> none = singz::sumStemsTo22k({}, err);
  CHECK("no stems is an error", !err.empty() && none.empty());
  const std::vector<float> gone = singz::sumStemsTo22k({scratchDir() + "/singz-no-such-stem.wav"}, err);
  CHECK("a missing stem names itself", !err.empty() && gone.empty() &&
        err.find("singz-no-such-stem") != std::string::npos);
  {
    singz::WavWriter w;
    w.open(b, 48000, 1);
    w.append(bv.data(), bn);
    w.finalize();
  }
  const std::vector<float> wrong = singz::sumStemsTo22k({a, b}, err);
  CHECK("a 48 kHz stem is refused, not resampled", !err.empty() && wrong.empty() &&
        err.find("48000") != std::string::npos);

  std::remove(a.c_str());
  std::remove(b.c_str());
}

// The core's FLAC path (Phase 5, docs/PHONE-STANDALONE.md): what these hold
// is that a FLAC stem answers IDENTICALLY to the WAV it was encoded from —
// same samples, same fold, through the same readWavMono the detectors call —
// so a compacted project's grid cannot drift from its own pre-compact grid.
// Losslessness alone does not give that: the mono fold squeezes the running
// sum through float32 per channel, and a FLAC path that folded in double
// would differ in the last bit while every byte on disk was correct.
static void flacTests() {
  const std::string dir = scratchDir();
  const std::string wav = dir + "/singz-flac-io-test.wav";
  const std::string wavKeep = dir + "/singz-flac-io-keep.wav";
  const std::string flac = dir + "/singz-flac-io-test.flac";
  std::remove(wav.c_str());
  std::remove(wavKeep.c_str());
  std::remove(flac.c_str());

  // Two seconds of full-range stereo: tones plus deterministic noise, values
  // that exercise both channels differently so the fold has work to do.
  const int rate = 44100, frames = 2 * rate;
  std::vector<float> pcm(static_cast<size_t>(frames) * 2);
  unsigned seed = 424242u;
  for (int i = 0; i < frames; i++) {
    seed = seed * 1103515245u + 12345u;
    const double t = static_cast<double>(i) / rate;
    pcm[static_cast<size_t>(i) * 2] =
        static_cast<float>(0.5 * std::sin(2 * M_PI * 220.0 * t) +
                           0.05 * (static_cast<int16_t>(seed >> 16) / 32768.0));
    pcm[static_cast<size_t>(i) * 2 + 1] =
        static_cast<float>(0.4 * std::sin(2 * M_PI * 333.0 * t + 0.7));
  }
  {
    singz::WavWriter w;
    w.open(wav, rate, 2);
    w.append(pcm.data(), frames);
    w.finalize();
  }
  {
    singz::WavWriter w;  // a copy compactStem will not eat, for the comparison
    w.open(wavKeep, rate, 2);
    w.append(pcm.data(), frames);
    w.finalize();
  }

  // The upgrade's own op writes the FLAC (level 5, verify on, .part rename).
  const singz::CompactResult enc = singz::compactStem(wav, flac);
  CHECK("compactStem encodes a canonical stem", enc.ok && !enc.skipped && enc.bytes > 0);
  CHECK("…and the wav is gone afterwards", std::fopen(wav.c_str(), "rb") == nullptr);
  {
    std::FILE* pf = std::fopen((flac + ".part").c_str(), "rb");
    CHECK("…and no .part is left behind", pf == nullptr);
    if (pf != nullptr) std::fclose(pf);
  }

  // Idempotence: the kill-between-rename-and-unlink state heals itself.
  {
    singz::WavWriter w;
    w.open(wav, rate, 2);
    w.append(pcm.data(), frames);
    w.finalize();
  }
  const singz::CompactResult again = singz::compactStem(wav, flac);
  CHECK("a re-run with the flac already there skips and removes the wav",
        again.ok && again.skipped && std::fopen(wav.c_str(), "rb") == nullptr);

  // THE parity check: the FLAC through readWavMono — magic dispatch, not the
  // suffix — equals the WAV, sample for sample, no tolerance.
  const singz::MonoWav a = singz::readWavMono(wavKeep);
  const singz::MonoWav b = singz::readWavMono(flac);
  CHECK("both readers report ok", a.ok && b.ok);
  CHECK("same length", a.samples.size() == b.samples.size());
  size_t bad = 0, firstBad = 0;
  for (size_t i = 0; i < std::min(a.samples.size(), b.samples.size()); i++)
    if (a.samples[i] != b.samples[i]) {
      if (bad == 0) firstBad = i;
      bad++;
    }
  if (bad > 0)
    std::printf("      %zu samples differ; first at %zu: % .9f vs % .9f\n", bad, firstBad,
                static_cast<double>(a.samples[firstBad]), static_cast<double>(b.samples[firstBad]));
  CHECK("FLAC folds to the SAME mono as its source WAV, bit for bit", bad == 0 && a.ok && b.ok);

  // readWavInfo answers off STREAMINFO, no samples read.
  const singz::WavInfo wi = singz::readWavInfo(wavKeep);
  const singz::WavInfo fi = singz::readWavInfo(flac);
  CHECK("info: rate/channels/frames agree across the formats",
        wi.ok && fi.ok && wi.sampleRate == fi.sampleRate && wi.channels == fi.channels &&
            wi.frames == fi.frames);

  // The dispatch trusts magic, not names: the same FLAC bytes under a .wav
  // name still decode (a copied file wearing the wrong suffix answers
  // plausibly-and-wrong if the suffix decides).
  const std::string lie = dir + "/singz-flac-io-lie.wav";
  std::remove(lie.c_str());
  {
    std::FILE* in = std::fopen(flac.c_str(), "rb");
    std::FILE* outF = std::fopen(lie.c_str(), "wb");
    char buf[65536];
    size_t n;
    while ((n = std::fread(buf, 1, sizeof buf, in)) > 0) std::fwrite(buf, 1, n, outF);
    std::fclose(in);
    std::fclose(outF);
  }
  const singz::MonoWav c = singz::readWavMono(lie);
  CHECK("a FLAC named .wav decodes by magic, identically",
        c.ok && c.samples.size() == b.samples.size() &&
            std::memcmp(c.samples.data(), b.samples.data(),
                        b.samples.size() * sizeof(float)) == 0);

  // And a stem that is neither is an error, not a guess.
  const singz::CompactResult junk = singz::compactStem(lie, dir + "/singz-flac-io-junk.flac");
  CHECK("compactStem refuses a non-PCM16 source", !junk.ok);

  std::remove(wavKeep.c_str());
  std::remove(flac.c_str());
  std::remove(lie.c_str());
}

int main() {
  resamplerTests();
  wavTests();
  flacTests();
  melodyTests();
  keyTests();
  beatsTests();
  sumStemsTests();
  std::printf(failures == 0 ? "\nALL CORE HOST TESTS PASS\n" : "\n%d FAILURE(S)\n", failures);
  return failures == 0 ? 0 : 1;
}

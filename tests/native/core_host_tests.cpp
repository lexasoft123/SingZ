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
#include "beats.h"
#include "melody.h"
#include "resample.h"
#include "wav.h"

static int failures = 0;
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
  const std::string path = std::string(std::getenv("TMPDIR") ? std::getenv("TMPDIR") : "/tmp") + "/singz-melody-test.wav";
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
  CHECK("beats: stamp is the TS's BEAT_DETECT_VERSION", singz::kBeatDetectVersion == 21);

  // The meter test: a straight 4/4 click train must NOT read as compound.
  // (Its 6/8 counterpart is a library fact rather than a synthesis one —
  // Nothing Else Matters measures ac3/ac4 = 2.61 and comes out 6, which the
  // parity harness checks against the TS on the real stem.)
  singz::BeatAux noAux;
  const singz::BarPhase phase = singz::barPhase(lat, drums, noAux, d);
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

int main() {
  resamplerTests();
  wavTests();
  melodyTests();
  keyTests();
  beatsTests();
  std::printf(failures == 0 ? "\nALL CORE HOST TESTS PASS\n" : "\n%d FAILURE(S)\n", failures);
  return failures == 0 ? 0 : 1;
}

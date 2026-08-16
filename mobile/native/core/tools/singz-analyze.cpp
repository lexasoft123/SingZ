// singz-analyze — the core's detectors as a command-line tool: the desktop's
// way in (spawned by main like whisper-cli; docs/PHONE-STANDALONE.md, Phase
// 4c) and the parity harness's oracle (tests compare its output with the TS
// detectors' on the same samples). One implementation, every platform.
//
//   singz-analyze melody --f32 <mono float32 file> --sr <rate> [--raw]
//   singz-analyze melody --wav <file> [--raw]        (any channel count; folded)
//   singz-analyze key --inst <a.wav> [--inst <b.wav> ...] [--bass <c.wav>]
//   singz-analyze beats --drums <d.wav> [--inst <a.wav> ...]   (staged debug)
//
// Prints one JSON object on stdout. Floats are printed with 9 significant
// digits, which round-trips float32 exactly — the parity harness compares
// values, not text.
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "../analysis.h"
#include "../beats.h"
#include "../melody.h"
#include "../wav.h"

static std::vector<float> readF32(const std::string& path) {
  std::vector<float> out;
  std::FILE* f = std::fopen(path.c_str(), "rb");
  if (f == nullptr) return out;
  std::fseek(f, 0, SEEK_END);
  const long bytes = std::ftell(f);
  std::fseek(f, 0, SEEK_SET);
  if (bytes > 0) {
    out.resize(static_cast<size_t>(bytes) / sizeof(float));
    const size_t got = std::fread(out.data(), sizeof(float), out.size(), f);
    out.resize(got);
  }
  std::fclose(f);
  return out;
}

static void printFloats(const std::vector<float>& v) {
  std::printf("[");
  for (size_t i = 0; i < v.size(); i++) std::printf(i ? ",%.9g" : "%.9g", static_cast<double>(v[i]));
  std::printf("]");
}

static void onProgress(void*, const char* stage, float frac) {
  std::fprintf(stderr, "progress %s %.3f\n", stage, static_cast<double>(frac));
}

int main(int argc, char** argv) {
  if (argc < 2) {
    std::fprintf(stderr, "usage: singz-analyze melody --f32 <path> --sr <rate> [--raw]\n");
    return 2;
  }
  const std::string cmd = argv[1];
  std::string f32, wav;
  double sr = 44100;
  bool raw = false;
  for (int i = 2; i < argc; i++) {
    if (std::strcmp(argv[i], "--f32") == 0 && i + 1 < argc) f32 = argv[++i];
    else if (std::strcmp(argv[i], "--wav") == 0 && i + 1 < argc) wav = argv[++i];
    else if (std::strcmp(argv[i], "--sr") == 0 && i + 1 < argc) sr = std::atof(argv[++i]);
    else if (std::strcmp(argv[i], "--raw") == 0) raw = true;
  }
  if (cmd == "melody") {
    std::vector<float> mono;
    if (!wav.empty()) {
      singz::MonoWav w = singz::readWavMono(wav);
      if (!w.ok) {
        std::fprintf(stderr, "could not read %s: %s\n", wav.c_str(), w.error.c_str());
        return 1;
      }
      mono = std::move(w.samples);
      sr = w.sampleRate;
    } else {
      mono = readF32(f32);
    }
    if (mono.empty()) {
      std::fprintf(stderr, "could not read %s\n", (wav.empty() ? f32 : wav).c_str());
      return 1;
    }
    singz::Progress progress;
    progress.cb = onProgress;
    const singz::MelodyTrack t = singz::trackMelody(mono.data(), mono.size(), sr, &progress);
    std::printf("{\"detVersion\":%d,\"hopSec\":%.17g,\"frames\":%zu,\"f0\":", singz::kPitchDetectVersion, t.hopSec,
                t.f0.size());
    printFloats(t.f0);
    if (raw) {
      std::printf(",\"raw\":");
      printFloats(t.raw);
      std::printf(",\"rms\":");
      printFloats(t.rms);
    }
    std::printf("}\n");
    return 0;
  }
  if (cmd == "key") {
    // The harmonic stems, in the order the caller names them — the TS sums
    // `inst` into one chord layer and asks `bass` for roots.
    std::vector<singz::AnalysisStem> inst;
    singz::AnalysisStem bassStem;
    bool haveBass = false;
    for (int i = 2; i < argc; i++) {
      const bool isInst = std::strcmp(argv[i], "--inst") == 0;
      const bool isBass = std::strcmp(argv[i], "--bass") == 0;
      if (!(isInst || isBass) || i + 1 >= argc) continue;
      const std::string path = argv[++i];
      singz::MonoWav w = singz::readWavMono(path);
      if (!w.ok) {
        std::fprintf(stderr, "could not read %s: %s\n", path.c_str(), w.error.c_str());
        return 1;
      }
      singz::AnalysisStem st;
      st.mono = std::move(w.samples);
      st.sampleRate = w.sampleRate;
      if (isInst) inst.push_back(std::move(st));
      else {
        bassStem = std::move(st);
        haveBass = true;
      }
    }
    const singz::KeyGuess k = singz::estimateKeyFromStems(inst, haveBass ? &bassStem : nullptr);
    if (!k.ok) {
      std::printf("{\"detVersion\":%d,\"key\":null}\n", singz::kKeyDetectVersion);
      return 0;
    }
    std::printf("{\"detVersion\":%d,\"key\":{\"pc\":%d,\"minor\":%s}}\n", singz::kKeyDetectVersion, k.pc,
                k.minor ? "true" : "false");
    return 0;
  }
  if (cmd == "beats") {
    // The tracker's staged debug, named exactly as analysis.ts's own `debug`
    // object names each field — the harness compares stage by stage, so a
    // divergence points at the stage that caused it, not just the song.
    singz::AnalysisStem drums;
    std::vector<singz::AnalysisStem> inst;
    bool haveDrums = false;
    for (int i = 2; i < argc; i++) {
      const bool isDrums = std::strcmp(argv[i], "--drums") == 0;
      const bool isInst = std::strcmp(argv[i], "--inst") == 0;
      if (!(isDrums || isInst) || i + 1 >= argc) continue;
      const std::string path = argv[++i];
      singz::MonoWav w = singz::readWavMono(path);
      if (!w.ok) {
        std::fprintf(stderr, "could not read %s: %s\n", path.c_str(), w.error.c_str());
        return 1;
      }
      singz::AnalysisStem st;
      st.mono = std::move(w.samples);
      st.sampleRate = w.sampleRate;
      if (isDrums) {
        drums = std::move(st);
        haveDrums = true;
      } else {
        inst.push_back(std::move(st));
      }
    }
    if (!haveDrums) {
      std::fprintf(stderr, "beats needs --drums\n");
      return 2;
    }
    singz::BeatDebug d;
    const singz::DrumLattice lat = singz::trackFromDrums(drums, inst, d);
    const bool ok = lat.ok;
    std::printf("{\"detVersion\":%d,\"ok\":%s,\"frames\":%d,\"drumPeaks\":%d,\"peaks\":%d,",
                singz::kBeatDetectVersion, ok ? "true" : "false", d.frames, d.drumPeaks, d.peaks);
    std::printf("\"fluxSum\":%.17g,\"fluxMean\":%.17g,\"windows\":%d,", d.fluxSum, d.fluxMean, d.windows);
    std::printf("\"tau\":%.17g,\"consistency\":%.17g,\"chosenBpm\":%.17g,", d.tau, d.consistency, d.chosenBpm);
    std::printf("\"support\":%.17g,\"activeFrac\":%.17g,\"steadiness\":%.17g,\"rough\":%.17g,", d.support,
                d.activeFrac, d.steadiness, d.rough);
    std::printf("\"beats\":%d,\"medSec\":%.17g,", d.beats, d.medSec);
    std::printf("\"spanOk\":[");
    for (size_t i = 0; i < d.spanOk.size(); i++)
      std::printf("%s{\"a\":%d,\"b\":%d,\"ok\":%s}", i ? "," : "", d.spanOk[i].a, d.spanOk[i].b,
                  d.spanOk[i].ok ? "true" : "false");
    std::printf("],\"beatsSec\":[");
    for (size_t i = 0; i < lat.beatsSec.size(); i++) std::printf(i ? ",%.17g" : "%.17g", lat.beatsSec[i]);
    std::printf("],\"voids\":[");
    for (size_t i = 0; i < lat.voids.size(); i++)
      std::printf("%s{\"aSec\":%.17g,\"bSec\":%.17g,\"leading\":%s,\"trailing\":%s,\"filled\":%s}", i ? "," : "",
                  lat.voids[i].aSec, lat.voids[i].bSec, lat.voids[i].leading ? "true" : "false",
                  lat.voids[i].trailing ? "true" : "false", lat.voids[i].filled ? "true" : "false");
    std::printf("],");
    if (d.fillApplied)
      std::printf("\"fill\":{\"alpha\":%.17g,\"dTop\":%.17g,\"iTop\":%.17g,\"instMaxima\":%d,\"gSum\":%.17g},",
                  d.fillAlpha, d.fillDTop, d.fillITop, d.fillInstMaxima, d.fillGSum);
    else if (d.fillSkipped)
      std::printf("\"fill\":{\"skipped\":true,\"instMaxima\":%d},", d.fillInstMaxima);
    else
      std::printf("\"fill\":null,");
    std::printf("\"octaves\":[");
    for (size_t i = 0; i < d.octaves.size(); i++) {
      const singz::BeatDebug::Octave& o = d.octaves[i];
      std::printf("%s{\"bpm\":%.17g,\"support\":%.17g,\"steadiness\":%.17g,\"alternation\":%.17g,"
                  "\"rough\":%.17g,\"prior\":%.17g,\"score\":%.17g}",
                  i ? "," : "", o.bpm, o.support, o.steadiness, o.alternation, o.rough, o.prior, o.score);
    }
    std::printf("],\"reject\":");
    if (d.reject.empty()) std::printf("null}\n");
    else std::printf("\"%s\"}\n", d.reject.c_str());
    return 0;
  }
  std::fprintf(stderr, "unknown command %s\n", cmd.c_str());
  return 2;
}

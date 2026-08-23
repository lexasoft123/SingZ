// singz-analyze — the core's detectors as a command-line tool: the desktop's
// way in (spawned by main like whisper-cli; docs/PHONE-STANDALONE.md, Phase
// 4c) and the parity harness's oracle (tests compare its output with the TS
// detectors' on the same samples). One implementation, every platform.
//
//   singz-analyze melody --f32 <mono float32 file> --sr <rate> [--raw]
//   singz-analyze melody --wav <file> [--raw]        (any channel count; folded)
//   singz-analyze key --inst <a.wav> [--inst <b.wav> ...] [--bass <c.wav>]
//   singz-analyze courts --wav <f.wav> [--lo <hz>] [--hi <hz>]
//                        [--bass-wav <b.wav>] [--vocals-wav <v.wav>]
//                        [--word <s>:<e> ...]                    (extractors)
//   singz-analyze beats --drums <d.wav> [--inst <a.wav> ...] [--vocals <v.wav>]
//                        [--bass <b.wav>] [--line <sec> ...]         (staged debug)
//   singz-analyze courtsjudge --wav <harm.wav> --bpm <x> [--bpb <n>] [--t0 <s>]
//                        [--dur <s>] [--bass-wav <b>] [--vocals-wav <v>]
//                        [--word <s>:<e> ...] [--ml-beats <csv>]        (courts)
//                        [--runs <t:sec:label,...>] [--voice <t:gap,...>]
//                        [--seam <t,...>]        (synthetic evidence; skips audio)
//
// Prints one JSON object on stdout. Floats are printed with 9 significant
// digits, which round-trips float32 exactly — the parity harness compares
// values, not text.
#include <cstdio>
#include <cstdlib>
#include <cmath>
#include <cstring>
#include <string>
#include <vector>

#include "../analysis.h"
#include "../beat_this.h"
#include "../beats.h"
#include "../courts.h"
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

// The neural grid's token format, shared by --ml <file> (the parity
// harness's path) and the analyze subcommand's --ml-stdin (the desktop's:
// main writes the grid when its own model run finishes, which is what lets
// melody and key start before the lattice exists). Empty text = no grid,
// deliberately: a packless desktop closes stdin with nothing.
struct StdinAux {
  std::vector<double> lineStarts;
  std::vector<std::pair<double, double>> words;
};

static std::string readMlText(const std::string& text, singz::MlGrid& g, StdinAux* aux = nullptr) {
  if (text.find_first_not_of(" \t\r\n") == std::string::npos) return "empty";
  size_t pos = 0;
    const auto token = [&](std::string& t) {
      while (pos < text.size() && std::isspace(static_cast<unsigned char>(text[pos]))) pos++;
      const size_t start = pos;
      while (pos < text.size() && !std::isspace(static_cast<unsigned char>(text[pos]))) pos++;
      t.assign(text, start, pos - start);
      return !t.empty();
    };
    const auto number = [&](double& v) {
      std::string t;
      if (!token(t)) return false;
      char* end = nullptr;
      v = std::strtod(t.c_str(), &end);
      return end == t.c_str() + t.size() && std::isfinite(v);
    };
    const auto array = [&](std::vector<double>& into) -> std::string {
      double count = 0;
      if (!number(count) || count < 0) return "bad count";
      into.resize(static_cast<size_t>(count));
      for (size_t i = 0; i < into.size(); i++)
        if (!number(into[i])) return "short array";
      return "";
    };
    std::string key;
    bool sawFps = false;
    while (token(key)) {
      std::string err;
      if (key == "fps") {
        double v = 0;
        if (!number(v)) return "bad fps";
        g.fps = static_cast<int>(v);
        sawFps = true;
      } else if (key == "beats") err = array(g.beats);
      else if (key == "downbeats") err = array(g.downbeats);
      else if (key == "beatProb") err = array(g.beatProb);
      else if (key == "downbeatProb") err = array(g.downbeatProb);
      else if (key == "lineStarts" && aux != nullptr) err = array(aux->lineStarts);
      else if (key == "words" && aux != nullptr) {
        // `words <n> <v> ...` — n counts VALUES (start,end per word)
        std::vector<double> flat;
        err = array(flat);
        if (err.empty() && flat.size() % 2 != 0) err = "odd word values";
        if (err.empty())
          for (size_t i2 = 0; i2 + 1 < flat.size(); i2 += 2) aux->words.push_back({flat[i2], flat[i2 + 1]});
      }
      else return "unknown section " + key;
      if (!err.empty()) return err + " in " + key;
    }
  if (!sawFps && !(g.beats.empty() && g.beatProb.empty() && g.downbeats.empty() && g.downbeatProb.empty()))
    return "no fps line";
  if (!sawFps) return "no-grid";
  return "";
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
  if (cmd == "analyze") {
    // The whole analysis in ONE child — melody, key and beats, each opt-in:
    //   singz-analyze analyze [--melody [--raw]] [--key] [--beats]
    //     [--vocals v] [--drums d] [--bass b] [--inst a]...
    //     [--line t]... [--word s:e]... [--ml file | --ml-stdin]
    // Every stem file is read ONCE and shared by every detector that wants
    // it. --ml-stdin is the desktop's lattice hand-off: melody and key run
    // while the caller's own model is still working, and the beats stage
    // blocks on stdin only when it is actually reached — the caller writes
    // the token-format grid (or closes stdin empty on a packless machine)
    // whenever its render finishes. Output is one JSON object with a
    // sub-object per requested part, production fields only; the staged
    // debug stays with the plain `beats` subcommand, which the parity
    // harness drives.
    bool wantMelody = false, wantKey = false, wantBeats = false, raw = false, mlStdin = false;
    std::string drumsPath, bassPath, vocalsPath, mlPath;
    std::vector<std::string> instPaths;
    std::vector<double> lineStarts;
    std::vector<std::pair<double, double>> words;
    for (int i = 2; i < argc; i++) {
      const std::string a = argv[i];
      const auto pathArg = [&](std::string& into) {
        if (i + 1 >= argc) {
          std::fprintf(stderr, "analyze: %s needs a value\n", a.c_str());
          std::exit(2);
        }
        into = argv[++i];
      };
      if (a == "--melody") wantMelody = true;
      else if (a == "--key") wantKey = true;
      else if (a == "--beats") wantBeats = true;
      else if (a == "--raw") raw = true;
      else if (a == "--ml-stdin") mlStdin = true;
      else if (a == "--drums") pathArg(drumsPath);
      else if (a == "--bass") pathArg(bassPath);
      else if (a == "--vocals") pathArg(vocalsPath);
      else if (a == "--ml") pathArg(mlPath);
      else if (a == "--inst") {
        std::string p2;
        pathArg(p2);
        instPaths.push_back(p2);
      } else if (a == "--line") {
        // strtod with a full-token check, like `beats` — atof's silent 0.0
        // is the trap that subcommand's comment already documents
        std::string v;
        pathArg(v);
        char* end = nullptr;
        const double t = std::strtod(v.c_str(), &end);
        if (end != v.c_str() + v.size() || !std::isfinite(t)) {
          std::fprintf(stderr, "analyze: --line wants a number, got %s\n", v.c_str());
          return 2;
        }
        lineStarts.push_back(t);
      } else if (a == "--word") {
        std::string w;
        pathArg(w);
        const size_t colon = w.find(':');
        char* e1 = nullptr;
        char* e2 = nullptr;
        const double ws = colon == std::string::npos ? 0 : std::strtod(w.c_str(), &e1);
        const double we = colon == std::string::npos ? 0 : std::strtod(w.c_str() + colon + 1, &e2);
        if (colon == std::string::npos || e1 != w.c_str() + colon || *e2 != '\0' ||
            !std::isfinite(ws) || !std::isfinite(we)) {
          std::fprintf(stderr, "analyze: --word wants <start>:<end>, got %s\n", w.c_str());
          return 2;
        }
        words.push_back({ws, we});
      } else {
        std::fprintf(stderr, "analyze: unknown argument %s\n", a.c_str());
        return 2;
      }
    }
    if (!wantMelody && !wantKey && !wantBeats) {
      std::fprintf(stderr, "analyze: nothing requested (--melody/--key/--beats)\n");
      return 2;
    }
    if (wantMelody && vocalsPath.empty()) {
      std::fprintf(stderr, "analyze: --melody needs --vocals\n");
      return 2;
    }
    if (wantBeats && drumsPath.empty()) {
      std::fprintf(stderr, "analyze: --beats needs --drums\n");
      return 2;
    }
    if (wantKey && instPaths.empty() && bassPath.empty()) {
      std::fprintf(stderr, "analyze: --key needs --inst or --bass\n");
      return 2;
    }

    // one read per file, shared by every consumer
    const auto load = [&](const std::string& path, singz::AnalysisStem& into) {
      singz::MonoWav w = singz::readWavMono(path);
      if (!w.ok) {
        std::fprintf(stderr, "could not read %s: %s\n", path.c_str(), w.error.c_str());
        std::exit(1);
      }
      into.mono = std::move(w.samples);
      into.sampleRate = w.sampleRate;
    };
    singz::AnalysisStem drums, bass, vocals;
    std::vector<singz::AnalysisStem> inst(instPaths.size());
    if (!drumsPath.empty()) load(drumsPath, drums);
    if (!bassPath.empty()) load(bassPath, bass);
    if (!vocalsPath.empty()) load(vocalsPath, vocals);
    for (size_t i = 0; i < instPaths.size(); i++) load(instPaths[i], inst[i]);

    // One JSON line PER PART, flushed as each detector finishes — the
    // caller adopts the melody seconds before the beats stage has even
    // received its lattice. A single end-of-run object would hold the pitch
    // strip hostage to the model render (measured: melody adoption went
    // 0.5 s -> 4.9 s that way).
    if (wantMelody) {
      singz::Progress progress;
      progress.cb = onProgress;
      const singz::MelodyTrack t =
          singz::trackMelody(vocals.mono.data(), vocals.mono.size(), vocals.sampleRate, &progress);
      std::printf("{\"melody\":{\"detVersion\":%d,\"hopSec\":%.17g,\"frames\":%zu,\"f0\":",
                  singz::kPitchDetectVersion, t.hopSec, t.f0.size());
      printFloats(t.f0);
      if (raw) {
        std::printf(",\"raw\":");
        printFloats(t.raw);
        std::printf(",\"rms\":");
        printFloats(t.rms);
      }
      std::printf("}}\n");
      std::fflush(stdout);
    }

    if (wantKey) {
      const singz::KeyGuess k = singz::estimateKeyFromStems(inst, bassPath.empty() ? nullptr : &bass);
      if (!k.ok) std::printf("{\"key\":{\"detVersion\":%d,\"key\":null}}\n", singz::kKeyDetectVersion);
      else
        std::printf("{\"key\":{\"detVersion\":%d,\"key\":{\"pc\":%d,\"minor\":%s}}}\n",
                    singz::kKeyDetectVersion, k.pc, k.minor ? "true" : "false");
      std::fflush(stdout);
    }

    if (wantBeats) {
      // The lattice, from wherever the caller put it — read HERE, not at
      // startup: with --ml-stdin the melody and key above have already run
      // and printed their progress while the caller's model was still busy.
      singz::MlGrid ml;
      bool haveMl = false;
      if (!mlPath.empty()) {
        std::FILE* f = std::fopen(mlPath.c_str(), "rb");
        if (f) {
          std::string text;
          char chunk[65536];
          size_t n;
          while ((n = std::fread(chunk, 1, sizeof chunk, f)) > 0) text.append(chunk, n);
          std::fclose(f);
          haveMl = readMlText(text, ml).empty();
        }
      } else if (mlStdin) {
        std::string text;
        char chunk[65536];
        size_t n;
        while ((n = std::fread(chunk, 1, sizeof chunk, stdin)) > 0) text.append(chunk, n);
        StdinAux late;
        const std::string err = readMlText(text, ml, &late);
        haveMl = err.empty();
        if (!haveMl && err != "empty" && err != "no-grid") {
          std::fprintf(stderr, "analyze: --ml-stdin grid unusable: %s\n", err.c_str());
          return 2;
        }
        // the lyric aux is only KNOWN late — lyrics load while melody and
        // key already run — so it rides stdin beside the lattice and wins
        // over whatever argv carried at spawn
        if (!late.lineStarts.empty()) lineStarts = late.lineStarts;
        if (!late.words.empty()) words = late.words;
      }
      singz::BeatAux aux;
      aux.inst = &inst;
      if (!vocalsPath.empty()) aux.vocals = &vocals;
      if (!bassPath.empty()) aux.bass = &bass;
      aux.lineStarts = lineStarts;
      aux.words = words;
      if (haveMl) aux.ml = &ml;
      singz::BeatDebug d;
      const singz::BeatGrid grid = singz::detectBeats(drums, aux, d);
      std::printf("{\"beats\":{\"detVersion\":%d,\"ok\":%s,", singz::kBeatDetectVersion,
                  grid.ok ? "true" : "false");
      std::printf("\"bpm\":%.17g,\"beatsPerBar\":%d,\"downbeat\":%d,\"hasDownbeats\":%s,", grid.bpm,
                  grid.beatsPerBar, grid.downbeat, grid.hasDownbeats ? "true" : "false");
      std::printf("\"beatsSec\":[");
      for (size_t i = 0; i < grid.beats.size(); i++) std::printf("%s%.17g", i ? "," : "", grid.beats[i]);
      std::printf("],\"downbeats\":[");
      for (size_t i = 0; i < grid.downbeats.size(); i++) std::printf("%s%d", i ? "," : "", grid.downbeats[i]);
      std::printf("],\"suspectAt\":[");
      for (size_t i = 0; i < grid.suspectAt.size(); i++)
        std::printf("%s%.17g", i ? "," : "", grid.suspectAt[i]);
      std::printf("]}}\n");
      std::fflush(stdout);
    }

    return 0;
  }
  if (cmd == "mlmix") {
    // Dev/eval: the Beat This input as the CORE renders it (sumStemsTo22k),
    // raw float32 mono 22.05 kHz — the render-study's core leg, and the
    // reference for any desktop switch off Chromium's render.
    if (argc < 4) {
      std::fprintf(stderr, "usage: singz-analyze mlmix <out.f32> <stem> [<stem>...]\n");
      return 2;
    }
    std::vector<std::string> stems;
    for (int i = 3; i < argc; i++) stems.emplace_back(argv[i]);
    std::string err;
    const std::vector<float> mix = singz::sumStemsTo22k(stems, err);
    if (!err.empty()) {
      std::fprintf(stderr, "mlmix: %s\n", err.c_str());
      return 1;
    }
    FILE* f = std::fopen(argv[2], "wb");
    if (!f) {
      std::fprintf(stderr, "mlmix: cannot write %s\n", argv[2]);
      return 1;
    }
    const size_t wrote = std::fwrite(mix.data(), sizeof(float), mix.size(), f);
    std::fclose(f);
    if (wrote != mix.size()) {
      std::fprintf(stderr, "mlmix: short write\n");
      return 1;
    }
    std::printf("{\"samples\":%zu,\"sr\":22050}\n", mix.size());
    return 0;
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
      // Strict, like `beats` and `courts`: a lenient loop here would be the
      // same trap in the subcommand that ALREADY takes --bass.
      if (!(isInst || isBass)) {
        std::fprintf(stderr, "key: unknown argument %s\n", argv[i]);
        return 2;
      }
      if (i + 1 >= argc) {
        std::fprintf(stderr, "key: %s needs a path\n", argv[i]);
        return 2;
      }
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
    /**
     * `--ml <file>`: the neural lattice, in a whitespace-token format rather
     * than the runner's JSON — the core has no JSON parser and does not want
     * one here, and this side of the gate must hold the SAME doubles as the
     * TypeScript side, not a re-rounded copy of them.
     *
     *   fps <v>
     *   beats <n> <v> ...          downbeats <n> <v> ...
     *   beatProb <n> <v> ...       downbeatProb <n> <v> ...
     *
     * A section may be omitted; absent is the TS's `undefined`, which is what
     * the detector branches on. The harness writes each value with JS's
     * `String(x)` (shortest round-trip) and this reads it with strtod
     * (correctly rounded), so every value is bit-identical on both sides —
     * the one property a %.17g hop through Foundation would NOT give us.
     */
    const auto readMlFile = [](const std::string& path, singz::MlGrid& g) -> std::string {
      std::FILE* f = std::fopen(path.c_str(), "rb");
      if (!f) return "cannot open " + path;
      std::string text;
      char chunk[65536];
      size_t n;
      while ((n = std::fread(chunk, 1, sizeof chunk, f)) > 0) text.append(chunk, n);
      std::fclose(f);
      return readMlText(text, g);
    };
    // The tracker's staged debug, named exactly as analysis.ts's own `debug`
    // object names each field — the harness compares stage by stage, so a
    // divergence points at the stage that caused it, not just the song.
    singz::AnalysisStem drums;
    singz::AnalysisStem vocals;
    singz::AnalysisStem bass;
    std::vector<singz::AnalysisStem> inst;
    std::vector<double> lineStarts;
    std::vector<std::pair<double, double>> words;
    singz::MlGrid ml;
    bool haveDrums = false, haveVocals = false, haveBass = false, haveMl = false;
    for (int i = 2; i < argc; i++) {
      if (std::strcmp(argv[i], "--ml") == 0) {
        if (i + 1 >= argc) {
          std::fprintf(stderr, "beats: --ml needs a path\n");
          return 2;
        }
        const std::string err = readMlFile(argv[++i], ml);
        if (!err.empty()) {
          std::fprintf(stderr, "beats: --ml %s\n", err.c_str());
          return 2;
        }
        haveMl = true;
        continue;
      }
      if (std::strcmp(argv[i], "--word") == 0) {
        if (i + 1 >= argc) {
          std::fprintf(stderr, "beats: --word needs <start>:<end>\n");
          return 2;
        }
        const std::string w = argv[++i];
        const size_t colon = w.find(':');
        char* e1 = nullptr;
        char* e2 = nullptr;
        const double a = colon == std::string::npos ? 0 : std::strtod(w.c_str(), &e1);
        const double b = colon == std::string::npos ? 0 : std::strtod(w.c_str() + colon + 1, &e2);
        if (colon == std::string::npos || e1 != w.c_str() + colon || *e2 != '\0' ||
            !std::isfinite(a) || !std::isfinite(b)) {
          std::fprintf(stderr, "beats: --word wants <start>:<end>, got %s\n", w.c_str());
          return 2;
        }
        words.push_back({a, b});
        continue;
      }
      if (std::strcmp(argv[i], "--line") == 0) {
        if (i + 1 >= argc) {
          std::fprintf(stderr, "beats: --line needs a value\n");
          return 2;
        }
        // strtod, not atof: atof returns 0.0 for anything unparseable, so a
        // typo'd or shell-mangled time silently became a line start at t=0 —
        // the same silent-argument hazard the unknown-flag check above exists
        // to remove, one line below it.
        const char* raw = argv[++i];
        char* end = nullptr;
        const double v = std::strtod(raw, &end);
        if (end == raw || *end != '\0' || !std::isfinite(v)) {
          std::fprintf(stderr, "beats: --line wants a number, got %s\n", raw);
          return 2;
        }
        lineStarts.push_back(v);
        continue;
      }
      const bool isDrums = std::strcmp(argv[i], "--drums") == 0;
      const bool isInst = std::strcmp(argv[i], "--inst") == 0;
      const bool isVocals = std::strcmp(argv[i], "--vocals") == 0;
      const bool isBass = std::strcmp(argv[i], "--bass") == 0;
      // FATAL, not skipped. A flag this loop does not recognise used to fall
      // through in silence, so `--bass x.wav` ran the TypeScript with a bass
      // stem and this side without one — and the vote stages would then
      // diverge in a shape that reads exactly like a bug in the port.
      if (!(isDrums || isInst || isVocals || isBass)) {
        std::fprintf(stderr, "beats: unknown argument %s\n", argv[i]);
        return 2;
      }
      if (i + 1 >= argc) {
        std::fprintf(stderr, "beats: %s needs a path\n", argv[i]);
        return 2;
      }
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
      } else if (isVocals) {
        vocals = std::move(st);
        haveVocals = true;
      } else if (isBass) {
        bass = std::move(st);
        haveBass = true;
      } else {
        inst.push_back(std::move(st));
      }
    }
    if (!haveDrums) {
      std::fprintf(stderr, "beats needs --drums\n");
      return 2;
    }
    singz::BeatDebug d;
    singz::BeatAux aux;
    aux.inst = &inst;  // the fill stems double as the harmonic layer
    if (haveVocals) aux.vocals = &vocals;
    if (haveBass) aux.bass = &bass;
    aux.lineStarts = lineStarts;
    aux.words = words;
    if (haveMl) {
      ml.ok = true;
      aux.ml = &ml;
    }
    // The whole pipeline, as detectBeats runs it — tracker, vote, head
    // backcast, sanitize — so what is printed below is the grid itself and not
    // an intermediate the harness would have to reassemble.
    const singz::BeatGrid grid = singz::detectBeats(drums, aux, d);
    const bool ok = grid.ok;
    std::printf("{\"detVersion\":%d,\"ok\":%s,\"frames\":%d,\"drumPeaks\":%d,\"peaks\":%d,",
                singz::kBeatDetectVersion, ok ? "true" : "false", d.frames, d.drumPeaks, d.peaks);
    std::printf("\"fluxSum\":%.17g,\"fluxMean\":%.17g,", d.fluxSum, d.fluxMean);
    // The tracker's own stages, each OMITTED when it did not reach that group.
    // Two ways to miss one: the ML fork can return before the tracker entirely
    // (the bare-mix path, the waltz adoption), or the tracker can refuse part
    // way — a song that dies at the flux gate has no tau. The TS just leaves
    // its keys unwritten in both cases, and printing the zero defaults instead
    // would put a measured-looking 0 against that absence, which the harness
    // must read as a divergence and which would be one only in the report.
    if (d.hasTau)
      std::printf("\"windows\":%d,\"tau\":%.17g,\"consistency\":%.17g,", d.windows, d.tau, d.consistency);
    // The octave near-tie window and the model's own ambivalence that widened
    // it. Its own flag because the TS writes the key even for a song with no
    // octave candidate at all.
    if (d.hasOctaveTie)
      std::printf("\"octaveTie\":{\"win\":%.17g,\"mlBimodal\":%.17g},", d.octaveTieWin,
                  d.octaveTieMlBimodal);
    if (d.hasChosen) {
      std::printf("\"chosenBpm\":%.17g,", d.chosenBpm);
      std::printf("\"support\":%.17g,\"activeFrac\":%.17g,\"steadiness\":%.17g,\"rough\":%.17g,", d.support,
                  d.activeFrac, d.steadiness, d.rough);
    }
    if (d.hasLattice) std::printf("\"beats\":%d,\"medSec\":%.17g,", d.beats, d.medSec);
    // beatsPerBar off the GRID, like medSec and beats.length — the debug copy
    // is recorded before the return and the TS side reads the return.
    std::printf("\"beatsPerBar\":%d,\"activeBeats\":%d,\"segments\":%d,\"acAt3\":%.17g,\"acAt4\":%.17g,",
                grid.beatsPerBar, d.activeBeats, d.segments, d.acAt3, d.acAt4);
    // `beatsSec` is the GRID's now, not the tracker's — the backcast can
    // rebuild the head, and that is precisely what wants comparing.
    std::printf("\"gridBeats\":%d,\"beatsSec\":[", static_cast<int>(grid.beats.size()));
    for (size_t i = 0; i < grid.beats.size(); i++) std::printf("%s%.17g", i ? "," : "", grid.beats[i]);
    std::printf("],");
    {
      const char* why = d.headWhy == singz::BeatDebug::HeadWhy::noAnchor ? "no stable anchor"
                        : d.headWhy == singz::BeatDebug::HeadWhy::headOk  ? "head ok"
                        : d.headWhy == singz::BeatDebug::HeadWhy::judged  ? "judged"
                                                                         : "";
      std::printf("\"headWhy\":\"%s\",", why);
      if (d.headWhy == singz::BeatDebug::HeadWhy::headOk)
        std::printf("\"headOk\":{\"anchor\":%d,\"at\":%.17g,\"first\":%.17g},", d.headAnchor, d.headAt,
                    d.headFirst);
      if (d.headWhy == singz::BeatDebug::HeadWhy::judged) {
        std::printf("\"headJudged\":{\"anchor\":%d,\"at\":%.17g,\"unsteady\":%s,\"missing\":%s,\"onsets\":%d,"
                    "\"onsetsTrusted\":%s",
                    d.headAnchor, d.headAt, d.headUnsteady ? "true" : "false", d.headMissing ? "true" : "false",
                    d.headOnsetCount, d.headOnsetsTrusted ? "true" : "false");
        if (d.headHasVerdict)
          std::printf(",\"headTracked\":%s,\"replace\":%s", d.headTracked ? "true" : "false",
                      d.headReplace ? "true" : "false");
        if (d.headWalkEmpty) std::printf(",\"walk\":\"empty\"");
        std::printf("},");
      }
      if (d.hasHeadOnsets) {
        std::printf("\"headOnsets\":{\"per\":%.17g,\"periodic\":%d,\"of\":%d,\"t\":[", d.headOnsetsPer,
                    d.headOnsetsPeriodic, d.headOnsetsOf);
        for (size_t i = 0; i < d.headOnsetsT.size(); i++) std::printf("%s%.17g", i ? "," : "", d.headOnsetsT[i]);
        std::printf("]},");
      }
      if (d.hasHeadBackcast)
        std::printf("\"headBackcast\":{\"replaced\":%d,\"added\":%d,\"snapped\":%d,\"phase\":\"%s\"},",
                    d.headBackcastReplaced, d.headBackcastAdded, d.headBackcastSnapped,
                    d.headBackcastChords ? "chords" : "carried");
      std::printf("\"suspectAt\":[");
      for (size_t i = 0; i < grid.suspectAt.size(); i++) std::printf("%s%.17g", i ? "," : "", grid.suspectAt[i]);
      std::printf("],");
    }
    // hasDownbeats carries the TS's `undefined`-vs-`[]` distinction (see the
    // struct) — the desktop runner adopts this object as the production grid,
    // so the marker has to cross with it.
    std::printf("\"hasDownbeats\":%s,", grid.hasDownbeats ? "true" : "false");
    std::printf("\"bpm\":%.17g,\"downbeat\":%d,\"downbeats\":[", grid.bpm, grid.downbeat);
    for (size_t i = 0; i < grid.downbeats.size(); i++) std::printf("%s%d", i ? "," : "", grid.downbeats[i]);
    std::printf("],\"phaseCuts\":[");
    for (size_t i = 0; i < d.phaseCuts.size(); i++) std::printf("%s%d", i ? "," : "", d.phaseCuts[i]);
    std::printf("],");
    if (d.hasHarmGain)
      std::printf("\"harmGain\":{\"plain\":%.17g,\"cut\":%.17g},", d.harmGainPlain, d.harmGainCut);
    if (d.hasSanitized)
      std::printf("\"sanitized\":{\"before\":%d,\"after\":%d},", d.sanitizedBefore, d.sanitizedAfter);
    std::printf("\"segCues\":[");
    for (size_t i = 0; i < d.segCues.size(); i++)
      {
        std::printf("%s{\"a\":%d,\"b\":%d,\"rot\":%d,\"conf\":%.17g,\"cues\":[", i ? "," : "", d.segCues[i].a,
                    d.segCues[i].b, d.segCues[i].rot, d.segCues[i].conf);
        for (size_t j = 0; j < d.segCues[i].cues.size(); j++) {
          std::printf("%s[", j ? "," : "");
          for (size_t k = 0; k < d.segCues[i].cues[j].size(); k++)
            std::printf("%s%.17g", k ? "," : "", d.segCues[i].cues[j][k]);
          std::printf("]");
        }
        std::printf("]}");
      }
    std::printf("],\"spanOk\":[");
    for (size_t i = 0; i < d.spanOk.size(); i++)
      std::printf("%s{\"a\":%d,\"b\":%d,\"ok\":%s}", i ? "," : "", d.spanOk[i].a, d.spanOk[i].b,
                  d.spanOk[i].ok ? "true" : "false");
    std::printf("],\"voids\":[");
    for (size_t i = 0; i < d.voids.size(); i++)
      std::printf("%s{\"aSec\":%.17g,\"bSec\":%.17g,\"leading\":%s,\"trailing\":%s,\"filled\":%s}", i ? "," : "",
                  d.voids[i].aSec, d.voids[i].bSec, d.voids[i].leading ? "true" : "false",
                  d.voids[i].trailing ? "true" : "false", d.voids[i].filled ? "true" : "false");
    std::printf("],");
    if (d.fillApplied)
      std::printf("\"fill\":{\"alpha\":%.17g,\"dTop\":%.17g,\"iTop\":%.17g,\"instMaxima\":%d,\"gSum\":%.17g},",
                  d.fillAlpha, d.fillDTop, d.fillITop, d.fillInstMaxima, d.fillGSum);
    else if (d.fillSkipped)
      std::printf("\"fill\":{\"skipped\":true,\"instMaxima\":%d},", d.fillInstMaxima);
    else
      std::printf("\"fill\":null,");
    // `null`, not `[]`: `c.octaves?.length` must come out undefined so it
    // compares equal to the TS's unwritten key, and an empty array would
    // report 0 against nothing.
    if (!d.hasOctaves) {
      std::printf("\"octaves\":null,");
    } else {
      std::printf("\"octaves\":[");
      for (size_t i = 0; i < d.octaves.size(); i++) {
        const singz::BeatDebug::Octave& o = d.octaves[i];
        std::printf("%s{\"bpm\":%.17g,\"support\":%.17g,\"steadiness\":%.17g,\"alternation\":%.17g,"
                    "\"rough\":%.17g,\"prior\":%.17g,\"score\":%.17g}",
                    i ? "," : "", o.bpm, o.support, o.steadiness, o.alternation, o.rough, o.prior, o.score);
      }
      std::printf("],");
    }
    // ---- the neural lattice's stages, each written only when the TS writes
    // its key: an absent field and a zeroed one are different evidence, and
    // the harness compares "was it written" before it compares a number.
    std::printf("\"lattice\":");
    if (d.lattice.empty()) std::printf("null,");
    else std::printf("\"%s\",", d.lattice.c_str());
    if (d.hasMlDouble)
      std::printf("\"mlDouble\":{\"bpm0\":%.17g,\"gain\":%.17g,\"multiLevel\":%.17g,\"doubled\":%s},",
                  d.mlDoubleBpm0, d.mlDoubleGain, d.mlDoubleMultiLevel, d.mlDoubleDoubled ? "true" : "false");
    if (d.hasMlLattice)
      std::printf("\"mlLattice\":{\"bpm0\":%.17g,\"doubled\":%s,\"steadyFrac\":%.17g,\"wins\":%d},",
                  d.mlLatticeBpm0, d.mlLatticeDoubled ? "true" : "false", d.mlLatticeSteadyFrac, d.mlLatticeWins);
    if (!d.mlReject.empty()) std::printf("\"mlReject\":\"%s\",", d.mlReject.c_str());
    if (d.hasMlNormalized)
      std::printf("\"mlNormalized\":{\"from\":%d,\"to\":%d,\"medSec\":%.17g},", d.mlNormalizedFrom,
                  d.mlNormalizedTo, d.mlNormalizedMedSec);
    if (d.hasMlView)
      std::printf("\"mlView\":{\"ratio\":%.17g,\"scoreA\":%d,\"scoreB\":%d,\"picked\":%d},", d.mlViewRatio,
                  d.mlViewScoreA, d.mlViewScoreB, d.mlViewPicked);
    if (!d.mlSplice.empty()) {
      std::printf("\"mlSplice\":[");
      for (size_t i = 0; i < d.mlSplice.size(); i++) {
        const singz::BeatDebug::MlSplice& r = d.mlSplice[i];
        std::printf("%s{\"aSec\":%.17g,\"bSec\":%.17g,\"removed\":%d,\"added\":%d,\"why\":\"%s\"", i ? "," : "",
                    r.aSec, r.bSec, r.removed, r.added, r.why.c_str());
        if (r.hasCarry) std::printf(",\"ca\":%d,\"cb\":%d", r.ca, r.cb);
        std::printf("}");
      }
      std::printf("],");
    }
    if (!d.mlSeams.empty()) {
      std::printf("\"mlSeams\":[");
      for (size_t i = 0; i < d.mlSeams.size(); i++) std::printf("%s%d", i ? "," : "", d.mlSeams[i]);
      std::printf("],");
    }
    if (!d.spanPhase.empty()) {
      std::printf("\"spanPhase\":[");
      for (size_t i = 0; i < d.spanPhase.size(); i++) {
        const singz::BeatDebug::SpanPhase& r = d.spanPhase[i];
        std::printf("%s{\"aSec\":%.17g,\"bSec\":%.17g,\"rot\":%d,\"margin\":%.17g}", i ? "," : "", r.aSec,
                    r.bSec, r.rot, r.margin);
      }
      std::printf("],");
    }
    // The courts' own record. `abstained` is their answer when nothing could
    // testify; `changed` is the TS's `courted !== det0`, which decides whether
    // the whole adoption block downstream ran at all.
    if (d.hasV20)
      std::printf("\"v20\":{\"abstained\":%s,\"changed\":%s,\"cands\":%d,\"halfBar\":%s,\"applied\":%d},",
                  d.v20.abstained ? "true" : "false", d.v20.changed ? "true" : "false", d.v20.cands,
                  d.v20.halfBar ? "true" : "false", static_cast<int>(d.v20.applied.size()));
    if (d.headAfterHalve) {
      const singz::BeatDebug& h = *d.headAfterHalve;
      const char* hw = h.headWhy == singz::BeatDebug::HeadWhy::noAnchor ? "no stable anchor"
                       : h.headWhy == singz::BeatDebug::HeadWhy::headOk  ? "head ok"
                       : h.headWhy == singz::BeatDebug::HeadWhy::judged  ? "judged"
                                                                        : "";
      std::printf("\"headAfterHalve\":{\"headWhy\":\"%s\",\"backcast\":", hw);
      if (h.hasHeadBackcast)
        std::printf("{\"replaced\":%d,\"added\":%d,\"snapped\":%d,\"phase\":\"%s\"}}, ",
                    h.headBackcastReplaced, h.headBackcastAdded, h.headBackcastSnapped,
                    h.headBackcastChords ? "chords" : "carried");
      else std::printf("null},");
    }
    std::printf("\"reject\":");
    if (d.reject.empty()) std::printf("null}\n");
    else std::printf("\"%s\"}\n", d.reject.c_str());
    return 0;
  }
  if (std::strcmp(argv[1], "courts") == 0) {
    // The courts' extractor layer on ONE stem, dumped in full. Values, not a
    // digest: the whole reason this subcommand exists is that the layer runs
    // on libm rather than on arithmetic the porting rules can pin, so a
    // checksum that happened to collide would hide exactly the failure it is
    // here to find.
    std::string path, bassPath, vocalsPath;
    std::vector<std::pair<double, double>> words;
    double lo = 55, hi = 2000;
    for (int i = 2; i < argc; i++) {
      const bool isWav = std::strcmp(argv[i], "--wav") == 0;
      const bool isBassWav = std::strcmp(argv[i], "--bass-wav") == 0;
      const bool isVocalsWav = std::strcmp(argv[i], "--vocals-wav") == 0;
      if (std::strcmp(argv[i], "--word") == 0) {
        if (i + 1 >= argc) {
          std::fprintf(stderr, "courts: --word needs <start>:<end>\n");
          return 2;
        }
        const char* raw = argv[++i];
        char* end = nullptr;
        const double a = std::strtod(raw, &end);
        if (end == raw || *end != ':') {
          std::fprintf(stderr, "courts: --word wants <start>:<end>, got %s\n", raw);
          return 2;
        }
        const char* raw2 = end + 1;
        char* end2 = nullptr;
        const double b2 = std::strtod(raw2, &end2);
        if (end2 == raw2 || *end2 != '\0' || !std::isfinite(a) || !std::isfinite(b2)) {
          std::fprintf(stderr, "courts: --word wants <start>:<end>, got %s\n", raw);
          return 2;
        }
        words.push_back({a, b2});
        continue;
      }
      const bool isLo = std::strcmp(argv[i], "--lo") == 0;
      const bool isHi = std::strcmp(argv[i], "--hi") == 0;
      if (!(isWav || isBassWav || isVocalsWav || isLo || isHi)) {
        std::fprintf(stderr, "courts: unknown argument %s\n", argv[i]);
        return 2;
      }
      if (i + 1 >= argc) {
        std::fprintf(stderr, "courts: %s needs a value\n", argv[i]);
        return 2;
      }
      if (isWav) {
        path = argv[++i];
      } else if (isBassWav) {
        bassPath = argv[++i];
      } else if (isVocalsWav) {
        vocalsPath = argv[++i];
      } else {
        // strtod with full consumption, same as --line: std::atof turns a
        // mistyped band into 0.0 and analyses [0,2000) while reporting
        // success, which during a band-by-band comparison reads as a
        // divergence in the port. Verified: `--lo abc` used to exit 0.
        const char* raw = argv[++i];
        char* end = nullptr;
        const double v = std::strtod(raw, &end);
        if (end == raw || *end != '\0' || !std::isfinite(v)) {
          std::fprintf(stderr, "courts: %s wants a number, got %s\n", isLo ? "--lo" : "--hi", raw);
          return 2;
        }
        if (isLo) lo = v;
        else hi = v;
      }
    }
    if (path.empty()) {
      std::fprintf(stderr, "courts needs --wav\n");
      return 2;
    }
    singz::MonoWav w = singz::readWavMono(path);
    if (!w.ok) {
      std::fprintf(stderr, "could not read %s: %s\n", path.c_str(), w.error.c_str());
      return 1;
    }
    singz::AnalysisStem st;
    st.mono = std::move(w.samples);
    st.sampleRate = w.sampleRate;
    const std::vector<float> at44 = singz::monoAt44kPublic(st);
    const std::vector<float> x = singz::to22k(at44);
    const std::vector<std::vector<float>> ch = singz::chromaFrames(x, lo, hi);
    const singz::RmsEnvelope env = singz::rmsEnvelope(x);
    std::printf("{\"to22kLen\":%zu,\"chromaFrames\":%zu,\"rmsFrames\":%zu,\"rmsP95\":%.17g,\"fps\":%.17g,",
                x.size(), ch.size(), env.rms.size(), env.p95, env.fps);
    std::printf("\"chroma\":[");
    for (size_t f = 0; f < ch.size(); f++) {
      std::printf("%s[", f ? "," : "");
      // %.17g, not %.9g. 9 significant digits round-trips a float32 as a
      // VALUE, but the two sides render the halfway case differently — JS
      // toPrecision rounds half away from zero, C's %g rounds half to even —
      // so 22.64453125 printed as 22.6445313 against 22.6445312 read as a
      // divergence in three of six stems when nothing had diverged at all.
      // 17 digits is the exact double, and JSON.parse returns it exactly.
      for (size_t k = 0; k < 12; k++) std::printf("%s%.17g", k ? "," : "", static_cast<double>(ch[f][k]));
      std::printf("]");
    }
    std::printf("],\"beatSync\":[");
    {
      // A synthetic beat grid, so the harness can compare beatSyncChroma —
      // the one extractor with a deliberate deviation from the TS (a negative
      // frame index, which C++ skips where JS would throw) and, until now,
      // the one with no gate over it at all. Half-second beats over the whole
      // file: the point is to exercise the averaging and the L2 normalise,
      // not to be musical.
      std::vector<double> beats;
      const double dur = static_cast<double>(x.size()) / 22050.0;
      for (double t = 0; t < dur; t += 0.5) beats.push_back(t);
      const std::vector<std::vector<float>> bs = singz::beatSyncChroma(ch, beats);
      for (size_t f = 0; f < bs.size(); f++) {
        std::printf("%s[", f ? "," : "");
        for (size_t k = 0; k < 12; k++) std::printf("%s%.17g", k ? "," : "", static_cast<double>(bs[f][k]));
        std::printf("]");
      }
    }
    // ONE assembly, not two. This block used to hand-build the same
    // Ch/Cb/chordRuns and rmsEnvelope->vocalEvidence->formSeams pipeline that
    // buildCourtEvidence now owns — so the parity gate watched a copy of the
    // real function rather than the function. Calling it here gates it and
    // retires the duplicate in one move.
    std::printf("],");
    {
      std::vector<double> beats;
      const double dur = static_cast<double>(x.size()) / 22050.0;
      for (double t = 0; t < dur; t += 0.5) beats.push_back(t);

      std::vector<singz::AnalysisStem> harm;
      harm.push_back(st);
      singz::AnalysisStem bassStem, vocalStem;
      singz::CourtSources src;
      src.harm = &harm;
      if (!bassPath.empty()) {
        singz::MonoWav bw = singz::readWavMono(bassPath);
        if (!bw.ok) {
          std::fprintf(stderr, "could not read %s: %s\n", bassPath.c_str(), bw.error.c_str());
          return 1;
        }
        bassStem.mono = std::move(bw.samples);
        bassStem.sampleRate = bw.sampleRate;
        src.bass = &bassStem;
      }
      if (!vocalsPath.empty()) {
        singz::MonoWav vw = singz::readWavMono(vocalsPath);
        if (!vw.ok) {
          std::fprintf(stderr, "could not read %s: %s\n", vocalsPath.c_str(), vw.error.c_str());
          return 1;
        }
        vocalStem.mono = std::move(vw.samples);
        vocalStem.sampleRate = vw.sampleRate;
        src.vocals = &vocalStem;
      }
      src.words = words;

      singz::CourtGrid det;
      // 0.5 s beats -> 120 bpm, so `sec` below is len * 0.5 exactly.
      det.bpm = 120;
      det.beats = beats;
      const singz::CourtEvidence ev = singz::buildCourtEvidence(det, src);

      std::printf("\"chordRuns\":[");
      for (size_t i2 = 0; i2 < ev.runs.size(); i2++)
        std::printf("%s{\"name\":\"%s\",\"t\":%.17g,\"sec\":%.17g}", i2 ? "," : "", ev.runs[i2].c.c_str(),
                    ev.runs[i2].t, ev.runs[i2].sec);
      std::printf("],\"voice\":[");
      for (size_t i2 = 0; i2 < ev.voice.size(); i2++) {
        std::printf("%s{\"t\":%.17g,\"gapSec\":", i2 ? "," : "", ev.voice[i2].t);
        const double g = ev.voice[i2].gapSec;
        if (std::isinf(g)) std::printf("%s}", g > 0 ? "1e999" : "-1e999");
        else std::printf("%.17g}", g);
      }
      std::printf("],\"seams\":[");
      for (size_t i2 = 0; i2 < ev.seams.size(); i2++) std::printf("%s%.17g", i2 ? "," : "", ev.seams[i2]);
      // seams is closed by the `],"rms":[` that follows — do NOT close it here.
    }
    std::printf("],\"rms\":[");
    for (size_t f = 0; f < env.rms.size(); f++)
      std::printf("%s%.17g", f ? "," : "", static_cast<double>(env.rms[f]));
    std::printf("]}\n");
    return 0;
  }

  if (std::strcmp(argv[1], "mlgrid") == 0) {
    // The Beat This! runner with its two graph calls REPLAYED from recordings
    // rather than run. The host has no ONNX Runtime, and it does not need one
    // to gate this: every way the port can be wrong — the reflect padding, the
    // hop arithmetic, the chunk starts, the keep_first ordering, the border
    // trim, the peak picking, the dedupe, the downbeat snap, the rounding —
    // lives on this side of the model. eval/mlgrid-parity.mjs feeds this the
    // tensors scripts/beat_runner_onnx.py actually fed ORT, and compares what
    // comes back. The graphs themselves are proved on-device, where they run.
    std::string f32Path, spectPath, chunkBeatPath, chunkDownPath, framesOut, logitsOut;
    std::string logitsBeatPath, logitsDownPath;
    for (int i = 2; i < argc; i++) {
      const bool isF32 = std::strcmp(argv[i], "--f32") == 0;
      const bool isSpect = std::strcmp(argv[i], "--spect") == 0;
      const bool isCb = std::strcmp(argv[i], "--chunk-beat") == 0;
      const bool isCd = std::strcmp(argv[i], "--chunk-down") == 0;
      const bool isFramesOut = std::strcmp(argv[i], "--frames-out") == 0;
      const bool isLogitsOut = std::strcmp(argv[i], "--logits-out") == 0;
      const bool isLb = std::strcmp(argv[i], "--logits-beat") == 0;
      const bool isLd = std::strcmp(argv[i], "--logits-down") == 0;
      if (!(isF32 || isSpect || isCb || isCd || isFramesOut || isLogitsOut || isLb || isLd)) {
        std::fprintf(stderr, "mlgrid: unknown argument %s\n", argv[i]);
        return 2;
      }
      if (i + 1 >= argc) {
        std::fprintf(stderr, "mlgrid: %s needs a value\n", argv[i]);
        return 2;
      }
      if (isF32) f32Path = argv[++i];
      else if (isSpect) spectPath = argv[++i];
      else if (isCb) chunkBeatPath = argv[++i];
      else if (isCd) chunkDownPath = argv[++i];
      else if (isFramesOut) framesOut = argv[++i];
      else if (isLb) logitsBeatPath = argv[++i];
      else if (isLd) logitsDownPath = argv[++i];
      else logitsOut = argv[++i];
    }

    // Postprocess-only mode: logits straight in, no framing and no chunks. The
    // real song reaches none of the postprocessor's edges — measured on the
    // sample, 89 peaks with not one adjacent pair, so the dedupe never merges;
    // no logit within 65 of the sigmoid clip; no exact zero; no snap tie. Every
    // one of those is a live branch that a real input simply does not visit, so
    // the fixture feeds them directly. Same reasoning as eval/beats/fixtures.mjs.
    if (!logitsBeatPath.empty() || !logitsDownPath.empty()) {
      if (logitsBeatPath.empty() || logitsDownPath.empty()) {
        std::fprintf(stderr, "mlgrid: --logits-beat and --logits-down go together\n");
        return 2;
      }
      const std::vector<float> lb = readF32(logitsBeatPath);
      const std::vector<float> ld = readF32(logitsDownPath);
      if (lb.empty() || lb.size() != ld.size()) {
        std::fprintf(stderr, "mlgrid: logit rows are %zu and %zu floats\n", lb.size(), ld.size());
        return 1;
      }
      singz::MlGrid g;
      singz::postprocess(lb, ld, g.beats, g.downbeats);
      g.beatProb.reserve(lb.size());
      g.downbeatProb.reserve(ld.size());
      for (const float v : lb) g.beatProb.push_back(singz::sigmoidProb(v));
      for (const float v : ld) g.downbeatProb.push_back(singz::sigmoidProb(v));
      g.ok = true;
      std::fprintf(stderr, "mlgrid: postprocess-only, %zu frames, %zu beats, %zu downbeats\n",
                   lb.size(), g.beats.size(), g.downbeats.size());
      std::printf("%s\n", singz::mlGridJson(g).c_str());
      return 0;
    }

    if (f32Path.empty() || spectPath.empty() || chunkBeatPath.empty() || chunkDownPath.empty()) {
      std::fprintf(stderr,
                   "usage: singz-analyze mlgrid --f32 <in> --spect <spect.f32> "
                   "--chunk-beat <b.f32> --chunk-down <d.f32> [--frames-out <p>] "
                   "[--logits-out <prefix>]\n");
      return 2;
    }

    const std::vector<float> signal = readF32(f32Path);
    if (signal.empty()) {
      std::fprintf(stderr, "mlgrid: could not read %s\n", f32Path.c_str());
      return 1;
    }
    int nFrames = 0;
    const std::vector<float> frames = singz::frameSignal(signal, nFrames);
    if (!framesOut.empty()) {
      FILE* fo = std::fopen(framesOut.c_str(), "wb");
      if (!fo) {
        std::fprintf(stderr, "mlgrid: could not write %s\n", framesOut.c_str());
        return 1;
      }
      std::fwrite(frames.data(), sizeof(float), frames.size(), fo);
      std::fclose(fo);
    }

    const std::vector<float> spect = readF32(spectPath);
    if (spect.size() != static_cast<size_t>(nFrames) * 128) {
      std::fprintf(stderr, "mlgrid: spect has %zu floats, this port framed %d rows (%zu)\n",
                   spect.size(), nFrames, static_cast<size_t>(nFrames) * 128);
      return 1;
    }
    const std::vector<float> cb = readF32(chunkBeatPath);
    const std::vector<float> cd = readF32(chunkDownPath);
    const size_t chunkLen = static_cast<size_t>(singz::kBeatThisChunk);
    if (cb.size() % chunkLen != 0 || cb.size() != cd.size()) {
      std::fprintf(stderr, "mlgrid: chunk logits are %zu/%zu floats, not whole %zu-frame rows\n",
                   cb.size(), cd.size(), chunkLen);
      return 1;
    }
    const size_t recorded = cb.size() / chunkLen;

    // Replay in call order. A port that asked for a different NUMBER of chunks,
    // or in the other order, would silently line up against the wrong logits —
    // so the count is checked against the recording afterwards, and the
    // callback refuses to run off the end.
    size_t call = 0;
    singz::BeatThisModels models;
    models.logmel = [](const std::vector<float>&, int) { return std::vector<float>(); };
    models.model = [&](const std::vector<float>&, std::vector<float>& b, std::vector<float>& d) {
      if (call >= recorded) return false;
      b.assign(cb.begin() + static_cast<long>(call * chunkLen),
               cb.begin() + static_cast<long>((call + 1) * chunkLen));
      d.assign(cd.begin() + static_cast<long>(call * chunkLen),
               cd.begin() + static_cast<long>((call + 1) * chunkLen));
      call++;
      return true;
    };

    std::vector<float> beatLogits, downLogits;
    if (!singz::runChunks(spect, nFrames, models, beatLogits, downLogits, nullptr)) {
      std::fprintf(stderr, "mlgrid: runChunks failed after %zu of %zu recorded chunks\n", call,
                   recorded);
      return 1;
    }
    if (call != recorded) {
      std::fprintf(stderr, "mlgrid: replayed %zu chunks, the recording has %zu\n", call, recorded);
      return 1;
    }
    if (!logitsOut.empty()) {
      for (int which = 0; which < 2; which++) {
        const std::vector<float>& v = which == 0 ? beatLogits : downLogits;
        const std::string p = logitsOut + (which == 0 ? "-beat.f32" : "-down.f32");
        FILE* fo = std::fopen(p.c_str(), "wb");
        if (!fo) {
          std::fprintf(stderr, "mlgrid: could not write %s\n", p.c_str());
          return 1;
        }
        std::fwrite(v.data(), sizeof(float), v.size(), fo);
        std::fclose(fo);
      }
    }

    singz::MlGrid grid;
    singz::postprocess(beatLogits, downLogits, grid.beats, grid.downbeats);
    grid.beatProb.reserve(beatLogits.size());
    grid.downbeatProb.reserve(downLogits.size());
    for (const float v : beatLogits) grid.beatProb.push_back(singz::sigmoidProb(v));
    for (const float v : downLogits) grid.downbeatProb.push_back(singz::sigmoidProb(v));
    grid.ok = true;
    std::fprintf(stderr, "mlgrid: %d frames, %zu chunks, %zu beats, %zu downbeats\n", nFrames,
                 recorded, grid.beats.size(), grid.downbeats.size());
    std::printf("%s\n", singz::mlGridJson(grid).c_str());
    return 0;
  }

  // ---- the courts, judged on a stated grid ---------------------------------
  //
  // The evidence side already has a gate (`courts`); this is the deciding
  // side. The grid is UNIFORM and built from --bpm/--bpb/--t0/--dur rather
  // than passed as hundreds of times on a command line: both sides construct
  // it by the same arithmetic, so what is being compared is the courts, not a
  // serialisation. Real stems still supply the evidence, so the chord runs
  // the courts weigh are the real ones.
  if (cmd == "courtsjudge") {
    std::string harmPath, bassPath, vocalsPath, mlBeatsCsv;
    std::string runsCsv, voiceCsv, seamCsv;
    double bpm = 0, t0 = 0, dur = 0;
    int bpb = 4;
    std::vector<std::pair<double, double>> words;
    for (int i = 2; i < argc; i++) {
      const std::string a = argv[i];
      auto need = [&](const char* what) -> const char* {
        if (i + 1 >= argc) {
          std::fprintf(stderr, "courtsjudge: %s needs a value\n", what);
          std::exit(2);
        }
        return argv[++i];
      };
      if (a == "--wav") harmPath = need("--wav");
      else if (a == "--bass-wav") bassPath = need("--bass-wav");
      else if (a == "--vocals-wav") vocalsPath = need("--vocals-wav");
      else if (a == "--bpm") bpm = std::atof(need("--bpm"));
      else if (a == "--bpb") bpb = std::atoi(need("--bpb"));
      else if (a == "--t0") t0 = std::atof(need("--t0"));
      else if (a == "--dur") dur = std::atof(need("--dur"));
      else if (a == "--ml-beats") mlBeatsCsv = need("--ml-beats");
      // Synthetic evidence, for the branches no real stem in the corpus
      // reaches (the cadence and sibling courts). When --runs is given the
      // audio is not read at all: what is under test is the deciding side,
      // and the extractors have their own gate.
      else if (a == "--runs") runsCsv = need("--runs");
      else if (a == "--voice") voiceCsv = need("--voice");
      else if (a == "--seam") seamCsv = need("--seam");
      else if (a == "--word") {
        const std::string w = need("--word");
        const size_t colon = w.find(':');
        if (colon == std::string::npos) {
          std::fprintf(stderr, "courtsjudge: --word wants <start>:<end>, got %s\n", w.c_str());
          return 2;
        }
        words.push_back({std::atof(w.substr(0, colon).c_str()), std::atof(w.substr(colon + 1).c_str())});
      } else {
        std::fprintf(stderr, "courtsjudge: unknown argument %s\n", a.c_str());
        return 2;
      }
    }
    const bool synthetic = !runsCsv.empty();
    if (bpm <= 0 || (harmPath.empty() && !synthetic)) {
      std::fprintf(stderr, "courtsjudge needs --bpm, and --wav unless --runs is given\n");
      return 2;
    }
    singz::AnalysisStem harmStem;
    if (!synthetic) {
      singz::MonoWav hw = singz::readWavMono(harmPath);
      if (!hw.ok) {
        std::fprintf(stderr, "could not read %s: %s\n", harmPath.c_str(), hw.error.c_str());
        return 1;
      }
      harmStem.mono = std::move(hw.samples);
      harmStem.sampleRate = hw.sampleRate;
      if (dur <= 0) {
        dur = static_cast<double>(harmStem.mono.size()) / static_cast<double>(harmStem.sampleRate);
      }
    }
    if (dur <= 0) {
      std::fprintf(stderr, "courtsjudge needs --dur when --runs replaces the audio\n");
      return 2;
    }

    // The uniform grid. `t + i * per`, not a running sum: an accumulator
    // would drift differently once the two languages' roundings diverged,
    // and the point here is that both sides hold the SAME lattice.
    singz::CourtGrid det;
    det.bpm = bpm;
    det.beatsPerBar = bpb;
    det.downbeat = 0;
    {
      const double per = 60.0 / bpm;
      for (int i = 0;; i++) {
        const double t = t0 + i * per;
        if (t > dur) break;
        det.beats.push_back(t);
      }
    }

    singz::CourtEvidence ev;
    if (synthetic) {
      // "t:sec:label,..." / "t:gap,..." / "t,..." — the same three strings the
      // harness parses on its side, so both hold the identical pack.
      const auto fields = [](const std::string& row, char sep) {
        std::vector<std::string> out;
        size_t at = 0;
        for (;;) {
          const size_t k = row.find(sep, at);
          out.push_back(row.substr(at, k == std::string::npos ? std::string::npos : k - at));
          if (k == std::string::npos) break;
          at = k + 1;
        }
        return out;
      };
      for (const std::string& row : fields(runsCsv, ',')) {
        if (row.empty()) continue;
        const std::vector<std::string> f = fields(row, ':');
        if (f.size() < 3) {
          std::fprintf(stderr, "courtsjudge: --runs wants t:sec:label, got %s\n", row.c_str());
          return 2;
        }
        ev.runs.push_back({std::atof(f[0].c_str()), std::atof(f[1].c_str()), f[2]});
      }
      for (const std::string& row : fields(voiceCsv, ',')) {
        if (row.empty()) continue;
        const std::vector<std::string> f = fields(row, ':');
        if (f.size() < 2) continue;
        ev.voice.push_back({std::atof(f[0].c_str()), std::atof(f[1].c_str())});
      }
      for (const std::string& row : fields(seamCsv, ',')) {
        if (row.empty()) continue;
        ev.seams.push_back(std::atof(row.c_str()));
      }
      ev.words = words;
    }

    std::vector<singz::AnalysisStem> harm;
    // MOVED, not copied: harmStem holds the whole decoded stem, and the copy
    // is the very one CourtSources' header warns about a few lines below its
    // own pointer members. harmStem is dead after this.
    harm.push_back(std::move(harmStem));
    singz::AnalysisStem bassStem, vocalStem;
    singz::CourtSources src;
    src.harm = &harm;
    if (!bassPath.empty() && !synthetic) {
      singz::MonoWav bw = singz::readWavMono(bassPath);
      if (!bw.ok) {
        std::fprintf(stderr, "could not read %s: %s\n", bassPath.c_str(), bw.error.c_str());
        return 1;
      }
      bassStem.mono = std::move(bw.samples);
      bassStem.sampleRate = bw.sampleRate;
      src.bass = &bassStem;
    }
    if (!vocalsPath.empty() && !synthetic) {
      singz::MonoWav vw = singz::readWavMono(vocalsPath);
      if (!vw.ok) {
        std::fprintf(stderr, "could not read %s: %s\n", vocalsPath.c_str(), vw.error.c_str());
        return 1;
      }
      vocalStem.mono = std::move(vw.samples);
      vocalStem.sampleRate = vw.sampleRate;
      src.vocals = &vocalStem;
    }
    src.words = words;

    if (!synthetic) ev = singz::buildCourtEvidence(det, src);
    if (!mlBeatsCsv.empty()) {
      std::vector<double> mlBeats;
      size_t at = 0;
      while (at < mlBeatsCsv.size()) {
        const size_t comma = mlBeatsCsv.find(',', at);
        const std::string tok = mlBeatsCsv.substr(at, comma == std::string::npos ? std::string::npos : comma - at);
        if (!tok.empty()) mlBeats.push_back(std::atof(tok.c_str()));
        if (comma == std::string::npos) break;
        at = comma + 1;
      }
      bool ok = false;
      const singz::MlLevel lvl = singz::mlLevelStats(mlBeats, ok);
      ev.ml = lvl;
      ev.hasMl = ok;
    }

    singz::CourtsDbg cdbg;
    const singz::CourtGrid ruled = singz::applyCourts(det, ev, cdbg);
    const std::vector<singz::ChordRun> cps = singz::changePoints(ev.runs, 0.9);
    const std::vector<double> bars = singz::barTimes(det);

    auto printGrid = [](const char* name, const singz::CourtGrid& g) {
      std::printf("\"%s\":{\"bpm\":%.17g,\"beatsPerBar\":%d,\"downbeat\":%d,\"beats\":[", name, g.bpm,
                  g.beatsPerBar, g.downbeat);
      for (size_t i = 0; i < g.beats.size(); i++) std::printf("%s%.17g", i ? "," : "", g.beats[i]);
      std::printf("],\"downbeats\":[");
      for (size_t i = 0; i < g.downbeats.size(); i++) std::printf("%s%d", i ? "," : "", g.downbeats[i]);
      std::printf("]}");
    };
    std::printf("{\"lattice\":%zu,\"runs\":%zu,", det.beats.size(), ev.runs.size());
    std::printf("\"hasMl\":%s,", ev.hasMl ? "true" : "false");
    if (ev.hasMl) std::printf("\"ml\":{\"bpm\":%.17g,\"uni\":%.17g},", ev.ml.bpm, ev.ml.uni);
    std::printf("\"abstained\":%s,", cdbg.abstained ? "true" : "false");
    std::printf("\"oct\":%s,", cdbg.oct.empty() ? "null" : cdbg.oct.c_str());
    std::printf("\"dbl\":%s,", cdbg.dbl.empty() ? "null" : cdbg.dbl.c_str());
    std::printf("\"cands\":%d,\"halfBar\":%s,", cdbg.cands, cdbg.halfBar ? "true" : "false");
    std::printf("\"cadenceCensus\":%s,",
                cdbg.cadenceCensus.empty() ? "{}" : cdbg.cadenceCensus.c_str());
    std::printf("\"plan\":%s,", cdbg.plan.empty() ? "null" : cdbg.plan.c_str());
    std::printf("\"applied\":[");
    for (size_t i = 0; i < cdbg.applied.size(); i++) {
      std::printf("%s{\"t\":%.17g,\"L\":%d,\"why\":\"%s\",\"gain\":%.17g}", i ? "," : "",
                  cdbg.applied[i].t, cdbg.applied[i].L, cdbg.applied[i].why.c_str(),
                  cdbg.applied[i].gain);
    }
    std::printf("],\"changePoints\":[");
    for (size_t i = 0; i < cps.size(); i++) {
      std::printf("%s{\"t\":%.17g,\"sec\":%.17g,\"c\":\"%s\"}", i ? "," : "", cps[i].t, cps[i].sec,
                  cps[i].c.c_str());
    }
    std::printf("],\"barTimes\":[");
    for (size_t i = 0; i < bars.size(); i++) std::printf("%s%.17g", i ? "," : "", bars[i]);
    std::printf("],");
    printGrid("ruled", ruled);
    std::printf("}\n");
    return 0;
  }

  std::fprintf(stderr, "unknown command %s\n", cmd.c_str());
  return 2;
}

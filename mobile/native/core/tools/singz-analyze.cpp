// singz-analyze — the core's detectors as a command-line tool: the desktop's
// way in (spawned by main like whisper-cli; docs/PHONE-STANDALONE.md, Phase
// 4c) and the parity harness's oracle (tests compare its output with the TS
// detectors' on the same samples). One implementation, every platform.
//
//   singz-analyze melody --f32 <mono float32 file> --sr <rate> [--raw]
//   singz-analyze melody --wav <file> [--raw]        (any channel count; folded)
//   singz-analyze key --inst <a.wav> [--inst <b.wav> ...] [--bass <c.wav>]
//   singz-analyze beats --drums <d.wav> [--inst <a.wav> ...] [--vocals <v.wav>]
//                        [--line <sec> ...]                          (staged debug)
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
    singz::AnalysisStem vocals;
    std::vector<singz::AnalysisStem> inst;
    std::vector<double> lineStarts;
    bool haveDrums = false, haveVocals = false;
    for (int i = 2; i < argc; i++) {
      if (std::strcmp(argv[i], "--line") == 0 && i + 1 < argc) {
        lineStarts.push_back(std::atof(argv[++i]));
        continue;
      }
      const bool isDrums = std::strcmp(argv[i], "--drums") == 0;
      const bool isInst = std::strcmp(argv[i], "--inst") == 0;
      const bool isVocals = std::strcmp(argv[i], "--vocals") == 0;
      if (!(isDrums || isInst || isVocals) || i + 1 >= argc) continue;
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
    aux.lineStarts = lineStarts;
    // The whole pipeline, as detectBeats runs it — tracker, vote, head
    // backcast, sanitize — so what is printed below is the grid itself and not
    // an intermediate the harness would have to reassemble.
    const singz::BeatGrid grid = singz::detectBeatsNoCourts(drums, aux, d);
    const bool ok = grid.ok;
    std::printf("{\"detVersion\":%d,\"ok\":%s,\"frames\":%d,\"drumPeaks\":%d,\"peaks\":%d,",
                singz::kBeatDetectVersion, ok ? "true" : "false", d.frames, d.drumPeaks, d.peaks);
    std::printf("\"fluxSum\":%.17g,\"fluxMean\":%.17g,\"windows\":%d,", d.fluxSum, d.fluxMean, d.windows);
    std::printf("\"tau\":%.17g,\"consistency\":%.17g,\"chosenBpm\":%.17g,", d.tau, d.consistency, d.chosenBpm);
    std::printf("\"support\":%.17g,\"activeFrac\":%.17g,\"steadiness\":%.17g,\"rough\":%.17g,", d.support,
                d.activeFrac, d.steadiness, d.rough);
    std::printf("\"beats\":%d,\"medSec\":%.17g,", d.beats, d.medSec);
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

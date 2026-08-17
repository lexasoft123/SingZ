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
    // The tracker's staged debug, named exactly as analysis.ts's own `debug`
    // object names each field — the harness compares stage by stage, so a
    // divergence points at the stage that caused it, not just the song.
    singz::AnalysisStem drums;
    singz::AnalysisStem vocals;
    singz::AnalysisStem bass;
    std::vector<singz::AnalysisStem> inst;
    std::vector<double> lineStarts;
    bool haveDrums = false, haveVocals = false, haveBass = false;
    for (int i = 2; i < argc; i++) {
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

  std::fprintf(stderr, "unknown command %s\n", cmd.c_str());
  return 2;
}

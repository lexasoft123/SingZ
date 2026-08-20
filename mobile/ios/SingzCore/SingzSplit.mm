// iOS binding of the shared C++ engine core (mobile/native/core) — the same
// marshalling-only rule as Android's singz_core_jni.cpp/SplitModule.kt: the
// module name, method arity and the event payloads are identical on both
// platforms, so the JS pipeline has one surface (service.ts flips on via its
// splitAvailable probe the moment startSplit exists here). The job itself
// lives in SingzSplitRunner — in-process, iOS has no :split to isolate into.
#import <QuartzCore/QuartzCore.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>
#import <React/RCTLog.h>

#include <cstdio>
#include <string>
#include <vector>

#import "SingzSplitRunner.h"

#include "ort_env.h"
#include "analysis.h"
#include "beat_this.h"
#include "beats.h"
#include "melody.h"
#include "wav.h"

@interface SingzSplit : RCTEventEmitter <RCTBridgeModule>
@end

@implementation SingzSplit

RCT_EXPORT_MODULE(SingzSplit)

// Ungated emission, the Android DeviceEventEmitter semantics: the JS side
// subscribes with DeviceEventEmitter.addListener, which never calls this
// module's exported addListener — with observation ENABLED, RCTEventEmitter
// counts zero listeners and silently drops every event (measured in review:
// the card would sit at "Starting…" for a whole split).
- (instancetype)init {
  return [super initWithDisabledObservation];
}

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

- (NSArray<NSString *> *)supportedEvents {
  return @[ @"singzSplitProgress", @"singzSplitState" ];
}

- (void)emitSafely:(NSString *)name body:(NSDictionary *)body {
  // Belt over the disabled-observation braces: an emitter racing teardown
  // must never take the app down for firing late.
  @try {
    [self sendEventWithName:name body:body];
  } @catch (NSException *e) {
  }
}

RCT_EXPORT_METHOD(startSplit:(NSString *)srcPath
                  modelPath:(NSString *)modelPath
                  projectDir:(NSString *)projectDir
                  resume:(BOOL)resume
                  watchdogCapMs:(double)watchdogCapMs
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  __weak SingzSplit *weakSelf = self;
  const BOOL started = [[SingzSplitRunner shared]
      startWithSrc:srcPath
             model:modelPath
        projectDir:projectDir
            resume:resume
     watchdogCapMs:(int64_t)watchdogCapMs
          progress:^(NSString *stage, double frac, int64_t done, int64_t total,
                     double footprintMb, double headroomMb, double cpuPct) {
            [weakSelf emitSafely:@"singzSplitProgress"
                            body:@{
                              @"stage" : stage,
                              @"frac" : @(frac),
                              @"done" : @((double)done),
                              @"total" : @((double)total),
                              @"memMb" : @(footprintMb),
                              @"freeMb" : @(headroomMb),
                              @"cpuPct" : @(cpuPct)
                            }];
          }
             state:^(NSString *state, NSString *_Nullable error) {
               NSMutableDictionary *body = [@{@"state" : state} mutableCopy];
               if (error) body[@"error"] = error;
               [weakSelf emitSafely:@"singzSplitState" body:body];
             }];
  if (started) {
    resolve(@YES);
  } else {
    // One job at a time; the app checks splitStatus before starting.
    [self emitSafely:@"singzSplitState" body:@{@"state" : @"busy"}];
    resolve(@NO);
  }
}

RCT_EXPORT_METHOD(cancelSplit:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  [[SingzSplitRunner shared] cancel];
  resolve(@YES);
}

RCT_EXPORT_METHOD(splitStatus:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  NSDictionary *status = [SingzSplitRunner jobStatus];
  resolve(status ?: (id)kCFNull);
}

RCT_EXPORT_METHOD(attachSplitEvents:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  // In-process: events flow whenever the app lives — no binder to rebind.
  resolve(@YES);
}

RCT_EXPORT_METHOD(clearJob:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  [SingzSplitRunner clearJobDir];
  resolve(@YES);
}

RCT_EXPORT_METHOD(splitVitals:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  resolve([SingzSplitRunner vitals]);
}

RCT_EXPORT_METHOD(takeSplitTrail:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  resolve([SingzSplitRunner takeVitalsTrail] ?: (id)kCFNull);
}

// Phase 4c: the melody tracker in the core (melody.cpp — the desktop's
// pyin.ts/pitch-core.ts, bit-identical). Reads the stem WAV itself, tracks
// on a utility queue, answers f0 per hop; ~0.6 s for a four-minute song
// where the worklet-hosted TS took a minute and a half.
RCT_EXPORT_METHOD(analyzeMelody:(NSString *)wavPath
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  NSString *path = wavPath ?: @"";
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    singz::MonoWav wav = singz::readWavMono(std::string(path.UTF8String));
    if (!wav.ok) {
      reject(@"melody_read", [NSString stringWithFormat:@"%@: %s", path.lastPathComponent, wav.error.c_str()], nil);
      return;
    }
    const singz::MelodyTrack t = singz::trackMelody(wav.samples.data(), wav.samples.size(), wav.sampleRate, nullptr);
    NSMutableArray *f0 = [NSMutableArray arrayWithCapacity:t.f0.size()];
    for (const float v : t.f0) [f0 addObject:@(v)];
    resolve(@{
      @"f0" : f0,
      @"hopSec" : @(t.hopSec),
      @"frames" : @(t.f0.size()),
      @"detVersion" : @(singz::kPitchDetectVersion),
      @"sampleRate" : @(wav.sampleRate),
      @"durationSec" : @(static_cast<double>(wav.samples.size()) / wav.sampleRate)
    });
  });
}

// Phase 4b: the Beat This! grid (core beat_this.cpp — the desktop packs'
// beat_runner_onnx.py, ported). `wavPath` must be 22 050 Hz MONO and is
// CHECKED, never resampled: at 44.1 kHz this would return a confident grid at
// half the real tempo with nothing anywhere reporting a problem.
//
// Resolves the same SHAPE Android returns — the desktop's own fields, off the
// same core — but built from the core's doubles rather than parsed out of
// mlGridJson; see the note at the resolve for why the text hop had to go. A
// core-side error becomes a REJECTION here: a caller that saw {error: …} as a
// normal result would store a grid-less analysis and stamp it as done.
//
// Off the calling thread, like the melody tracker above: this is ~20 s of
// work for a 40 s song and the JS thread must not wait on it.
// dumpDir is the third parameter because ANDROID HAS ONE, and this file's own
// rule at the top is that the arity matches. It shipped without it, and the
// cost was not a missing tee: JS passing three arguments to a two-argument
// method never dispatched at all, and the promise then never settled — no
// work, no rejection, no red box, the app sitting on its main screen looking
// perfectly healthy while a driver polled for ten minutes. A signature skew
// between the platforms is silent in exactly the direction that wastes the
// most time, which is why the rule is written down.
// With a dump dir, TEE what the two graphs return on their way past — the
// same wrapper Android's JNI installs, for the same reason: the host parity
// gate replays recorded logits, so it proves the pure logic and says nothing
// about this file's marshalling, which is the one half that only ever runs
// here. Wrapping the production callables means the dumped tensors are the
// real path's, not a parallel one. Dead for every real caller: the pipeline
// passes "" and the models come back untouched.
static singz::BeatThisModels TapBeatThisModels(const singz::BeatThisModels &m,
                                               const std::string &dump)
{
  singz::BeatThisModels tapped = m;
  if (dump.empty()) return tapped;
  const auto write = [dump](const char *name, const std::vector<float> &v, const char *mode) {
    FILE *f = std::fopen((dump + "/" + name).c_str(), mode);
    if (f == nullptr) {
      // A tee that fails quietly is its own false pass — a reader slicing
      // to the recording's length would take whatever was there before
      // and call it this run's tensors. RCTLogWarn, not fprintf: an app's
      // fd 2 is nobody's console unless it was launched from one, and the
      // Android half of this lesson was a silent fix for silence.
      RCTLogWarn(@"mlGrid tee could not open %s/%s", dump.c_str(), name);
      return;
    }
    std::fwrite(v.data(), sizeof(float), v.size(), f);
    std::fclose(f);
  };
  // The chunk tees append (one write per chunk, in call order), so a
  // second run into the same dir would leave BOTH runs concatenated with
  // the stale bytes at the head — exactly where a reader looks.
  for (const char *n : {"dev-chunk-in.f32", "dev-chunk-beat.f32", "dev-chunk-down.f32"}) {
    FILE *f = std::fopen((dump + "/" + n).c_str(), "wb");
    if (f != nullptr) std::fclose(f);
  }
  const singz::BeatThisModels inner = m;
  tapped.logmel = [inner, write](const std::vector<float> &frames, int n) {
    const std::vector<float> spect = inner.logmel(frames, n);
    write("dev-frames.f32", frames, "wb");
    write("dev-spect.f32", spect, "wb");
    return spect;
  };
  tapped.model = [inner, write](const std::vector<float> &spect, std::vector<float> &b,
                                std::vector<float> &d) {
    const bool ok = inner.model(spect, b, d);
    if (ok) {
      // Appended in CALL order, which is reversed starts — the same order
      // the recording stores them in.
      write("dev-chunk-in.f32", spect, "ab");
      write("dev-chunk-beat.f32", b, "ab");
      write("dev-chunk-down.f32", d, "ab");
    }
    return ok;
  };
  return tapped;
}

// Built from the core's doubles, NOT parsed back out of mlGridJson. The JS
// surface is still the object Android resolves — same keys, same numbers,
// so pipeline code never learns which platform it is on — but the numbers
// get here without a decimal round trip.
//
// Going through the string cost 49 of 2041 probabilities their last bit:
// the core writes %.17g and Foundation's JSON parser is not correctly
// rounded on 17 significant digits (it reads "0.053999999999999999" as
// 0.054000000000000006). Android never saw it because Kotlin's parser is
// correctly rounded. A grid comparison cannot see this at all — the beats
// and downbeats were identical throughout — so only comparing every value
// caught it.
static NSDictionary *MlGridDict(const singz::MlGrid &grid, double elapsedMs)
{
  const singz::MlGrid r = singz::mlGridRounded(grid);
  const auto nums = [](const std::vector<double> &v) {
    NSMutableArray<NSNumber *> *a = [NSMutableArray arrayWithCapacity:v.size()];
    for (const double x : v) [a addObject:@(x)];
    return a;
  };
  return @{
    @"beats" : nums(r.beats),
    @"downbeats" : nums(r.downbeats),
    @"beat_prob" : nums(r.beatProb),
    @"downbeat_prob" : nums(r.downbeatProb),
    @"fps" : @(r.fps),
    @"elapsedMs" : @(elapsedMs)
  };
}

RCT_EXPORT_METHOD(mlGrid:(NSString *)wavPath
                  modelsDir:(NSString *)modelsDir
                  dumpDir:(NSString *)dumpDir
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  NSString *path = wavPath ?: @"";
  NSString *models = modelsDir ?: @"";
  const std::string dump = dumpDir != nil ? std::string(dumpDir.UTF8String) : std::string();
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    singz::MonoWav wav = singz::readWavMono(std::string(path.UTF8String));
    if (!wav.ok) {
      reject(@"mlgrid_read", [NSString stringWithFormat:@"%@: %s", path.lastPathComponent, wav.error.c_str()], nil);
      return;
    }
    if (wav.sampleRate != singz::kBeatThisSr) {
      reject(@"mlgrid_rate",
             [NSString stringWithFormat:@"beat models want %d Hz, got %d", singz::kBeatThisSr, wav.sampleRate],
             nil);
      return;
    }
    std::string error;
    const singz::BeatThisModels m = singz::loadBeatThisModels(std::string(models.UTF8String), error);
    if (!error.empty()) {
      reject(@"mlgrid_models", [NSString stringWithUTF8String:error.c_str()], nil);
      return;
    }
    const singz::BeatThisModels tapped = TapBeatThisModels(m, dump);

    // NOTE for anyone comparing platforms: this t0 starts AFTER the wav read
    // and the model load, so `elapsedMs` here is inference only, while
    // SplitModule.kt starts its clock before the JNI call and so includes
    // both. Same key, same shape, different span — do not put the two in one
    // table. The honest cross-platform number is the caller's own wall time.
    const double t0 = CACurrentMediaTime() * 1000.0;
    const singz::MlGrid grid = singz::beatThis(wav.samples, tapped, nullptr);
    if (!grid.ok) {
      reject(@"mlgrid", [NSString stringWithUTF8String:grid.error.c_str()], nil);
      return;
    }
    resolve(MlGridDict(grid, CACurrentMediaTime() * 1000.0 - t0));
  });
}

// The same grid from the project's STEMS: the analysis pipeline's entry
// point. Paths to 44.1 kHz wavs in, the core sums and decimates them to the
// model's 22.05 kHz itself (sumStemsTo22k — the desktop's fetchMlGrid mix,
// natively), so no audio ever crosses a JS runtime for this. Same payload
// and arity as Android's mlGridFromStems, per the rule at the top of this
// file.
RCT_EXPORT_METHOD(mlGridFromStems:(NSArray<NSString *> *)stemPaths
                  modelsDir:(NSString *)modelsDir
                  dumpDir:(NSString *)dumpDir
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  NSArray<NSString *> *stems = stemPaths ?: @[];
  NSString *models = modelsDir ?: @"";
  const std::string dump = dumpDir != nil ? std::string(dumpDir.UTF8String) : std::string();
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    std::vector<std::string> paths;
    paths.reserve(stems.count);
    for (NSString *p in stems) paths.push_back(std::string(p.UTF8String));

    std::string error;
    const singz::BeatThisModels m = singz::loadBeatThisModels(std::string(models.UTF8String), error);
    if (!error.empty()) {
      reject(@"mlgrid_models", [NSString stringWithUTF8String:error.c_str()], nil);
      return;
    }
    const singz::BeatThisModels tapped = TapBeatThisModels(m, dump);

    const double t0 = CACurrentMediaTime() * 1000.0;
    const singz::MlGrid grid = singz::beatThisFromStems(paths, tapped, nullptr);
    if (!grid.ok) {
      reject(@"mlgrid", [NSString stringWithUTF8String:grid.error.c_str()], nil);
      return;
    }
    resolve(MlGridDict(grid, CACurrentMediaTime() * 1000.0 - t0));
  });
}

// Phase 4d: the beat detector in the core — `singz::detectBeats`, the
// desktop's whole pipeline (neural fork, drums-first tracker, splices, bar
// phase, head backcast, v20 courts) bit-identical, reading its stems from
// disk so no audio crosses a JS runtime.
//
// Same module, method NAME and ARITY as Android's analyzeBeats — seven
// arguments plus the promise pair. What deliberately differs is the
// marshalling: Android crosses a JSON line from C++ and parses it in Kotlin,
// while this builds its dictionary from the core's doubles directly. That is
// not a style choice. Foundation's JSON number parser is not correctly
// rounded on 17-significant-digit input (measured, see beat_this.h), so beat
// times through a text hop would arrive one ULP off here and exactly right
// there — invisible in any grid comparison and loud in a value one.
//
// `ml` is the neural lattice or nil, and carries only what the detector
// reads: beats, downbeats, downbeatProb, fps. `beatProb` is not among them —
// nothing in detectBeats or the courts touches it, and it is ~12 000 numbers
// per four-minute song that would cross for nothing.
RCT_EXPORT_METHOD(analyzeBeats:(NSString *)drumsPath
                  bass:(NSString *)bassPath
                  vocals:(NSString *)vocalsPath
                  inst:(NSArray<NSString *> *)instPaths
                  lineStarts:(NSArray<NSNumber *> *)lineStarts
                  words:(NSArray<NSNumber *> *)words
                  ml:(NSDictionary *)ml
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  NSString *drums = drumsPath ?: @"";
  NSString *bass = bassPath ?: @"";
  NSString *vocals = vocalsPath ?: @"";
  NSArray<NSString *> *inst = instPaths ?: @[];
  NSArray<NSNumber *> *lines = lineStarts ?: @[];
  NSArray<NSNumber *> *flatWords = words ?: @[];
  NSDictionary *mlIn = ml;
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    const auto readStem = [&](NSString *path, singz::AnalysisStem &into) {
      singz::MonoWav w = singz::readWavMono(std::string(path.UTF8String));
      if (!w.ok) {
        reject(@"beats_read", [NSString stringWithFormat:@"%@: %s", path.lastPathComponent, w.error.c_str()], nil);
        return false;
      }
      into.mono = std::move(w.samples);
      into.sampleRate = w.sampleRate;
      return true;
    };
    singz::AnalysisStem drumsStem;
    if (!readStem(drums, drumsStem)) return;

    singz::AnalysisStem bassStem, vocalsStem;
    bool haveBass = false, haveVocals = false;
    if (bass.length > 0) {
      if (!readStem(bass, bassStem)) return;
      haveBass = true;
    }
    if (vocals.length > 0) {
      if (!readStem(vocals, vocalsStem)) return;
      haveVocals = true;
    }
    std::vector<singz::AnalysisStem> instStems;
    instStems.reserve(inst.count);
    for (NSString *p in inst) {
      singz::AnalysisStem st;
      if (!readStem(p, st)) return;
      instStems.push_back(std::move(st));
    }

    singz::BeatAux aux;
    aux.inst = &instStems;
    if (haveBass) aux.bass = &bassStem;
    if (haveVocals) aux.vocals = &vocalsStem;
    for (NSNumber *t in lines) aux.lineStarts.push_back(t.doubleValue);
    // A FLAT [s0,e0,s1,e1,…] array, like Android's. An odd length is a caller
    // bug and is refused rather than silently dropping half a word.
    if (flatWords.count % 2 != 0) {
      reject(@"beats_words", @"words must be a flat [start, end, …] array", nil);
      return;
    }
    for (NSUInteger i = 0; i + 1 < flatWords.count; i += 2)
      aux.words.push_back({flatWords[i].doubleValue, flatWords[i + 1].doubleValue});

    singz::MlGrid mlGrid;
    // RN marshals a JS `null` as NSNull on some paths and nil on others, so
    // ask the class rather than trusting nil.
    if ([mlIn isKindOfClass:[NSDictionary class]]) {
      const auto take = [&](NSString *key, std::vector<double> &into) {
        NSArray<NSNumber *> *a = mlIn[key];
        if (![a isKindOfClass:[NSArray class]]) return;
        into.reserve(a.count);
        for (NSNumber *v in a) into.push_back(v.doubleValue);
      };
      take(@"beats", mlGrid.beats);
      take(@"downbeats", mlGrid.downbeats);
      take(@"downbeatProb", mlGrid.downbeatProb);
      NSNumber *fps = mlIn[@"fps"];
      mlGrid.fps = [fps isKindOfClass:[NSNumber class]] ? fps.intValue : 0;
      mlGrid.ok = !mlGrid.beats.empty();
      if (mlGrid.ok) aux.ml = &mlGrid;
    }

    const double t0 = CACurrentMediaTime() * 1000.0;
    singz::BeatDebug dbg;
    const singz::BeatGrid grid = singz::detectBeats(drumsStem, aux, dbg);
    const double elapsed = CACurrentMediaTime() * 1000.0 - t0;
    // The detector's OWN refusal — no steady pulse deserves a metronome — is
    // null, exactly as the TS returns, and the pipeline stores that verdict.
    // A stem it could not READ rejected above; the two must stay distinct.
    if (!grid.ok) {
      resolve((id)kCFNull);
      return;
    }
    NSMutableArray<NSNumber *> *beats = [NSMutableArray arrayWithCapacity:grid.beats.size()];
    for (const double t : grid.beats) [beats addObject:@(t)];
    NSMutableDictionary *out = [@{
      @"beats" : beats,
      @"bpm" : @(grid.bpm),
      @"beatsPerBar" : @(grid.beatsPerBar),
      @"downbeat" : @(grid.downbeat),
      @"detVersion" : @(singz::kBeatDetectVersion),
      @"elapsedMs" : @(elapsed)
    } mutableCopy];
    // Present only when the vote found bars: the TS's `downbeats` is
    // undefined there, and an empty array is truthy — the app stores the
    // difference.
    if (grid.hasDownbeats) {
      NSMutableArray<NSNumber *> *db = [NSMutableArray arrayWithCapacity:grid.downbeats.size()];
      for (const int k : grid.downbeats) [db addObject:@(k)];
      out[@"downbeats"] = db;
    }
    if (!grid.suspectAt.empty()) {
      NSMutableArray<NSNumber *> *sa = [NSMutableArray arrayWithCapacity:grid.suspectAt.size()];
      for (const double t : grid.suspectAt) [sa addObject:@(t)];
      out[@"suspectAt"] = sa;
    }
    resolve(out);
  });
}

// Phase 4c: the key detector in the core (analysis.cpp — the desktop's
// estimateKeyFromStems, bit-identical). Reads the harmonic stems itself;
// `inst` is the chord layer, `bass` names roots and may be empty.
RCT_EXPORT_METHOD(analyzeKey:(NSArray<NSString *> *)instPaths
                  bass:(NSString *)bassPath
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  NSArray<NSString *> *inst = instPaths ?: @[];
  NSString *bass = bassPath ?: @"";
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    std::vector<singz::AnalysisStem> stems;
    stems.reserve(inst.count);
    for (NSString *p in inst) {
      singz::MonoWav w = singz::readWavMono(std::string(p.UTF8String));
      if (!w.ok) {
        reject(@"key_read", [NSString stringWithFormat:@"%@: %s", p.lastPathComponent, w.error.c_str()], nil);
        return;
      }
      singz::AnalysisStem st;
      st.mono = std::move(w.samples);
      st.sampleRate = w.sampleRate;
      stems.push_back(std::move(st));
    }
    singz::AnalysisStem bassStem;
    bool haveBass = false;
    if (bass.length > 0) {
      singz::MonoWav w = singz::readWavMono(std::string(bass.UTF8String));
      if (!w.ok) {
        reject(@"key_read", [NSString stringWithFormat:@"%@: %s", bass.lastPathComponent, w.error.c_str()], nil);
        return;
      }
      bassStem.mono = std::move(w.samples);
      bassStem.sampleRate = w.sampleRate;
      haveBass = true;
    }
    const singz::KeyGuess k = singz::estimateKeyFromStems(stems, haveBass ? &bassStem : nullptr);
    // A silent harmonic bed has no answer — null, exactly as the TS returns,
    // and the pipeline records that verdict rather than storing a key.
    resolve(k.ok ? @{@"pc" : @(k.pc), @"minor" : @(k.minor), @"detVersion" : @(singz::kKeyDetectVersion)}
                 : (id)kCFNull);
  });
}

// The stem's length without decoding it in JS — the melody-fit rule needs it
// before anything is tracked.
RCT_EXPORT_METHOD(wavInfo:(NSString *)wavPath
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  NSString *path = wavPath ?: @"";
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    const singz::WavInfo wav = singz::readWavInfo(std::string(path.UTF8String));  // header only
    if (!wav.ok) {
      reject(@"wav_read", [NSString stringWithFormat:@"%@: %s", path.lastPathComponent, wav.error.c_str()], nil);
      return;
    }
    resolve(@{
      @"sampleRate" : @(wav.sampleRate),
      @"channels" : @(wav.channels),
      @"frames" : @(wav.frames),
      @"durationSec" : @(static_cast<double>(wav.frames) / wav.sampleRate)
    });
  });
}

RCT_EXPORT_METHOD(ortProbe:(NSString *)modelPath
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  // A probe on a 136 MB graph blocks for seconds — never on the JS thread.
  NSString *path = modelPath ?: @"";
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    const std::string json = singz::ortProbeJson(std::string(path.UTF8String));
    resolve([NSString stringWithUTF8String:json.c_str()]);
  });
}

@end

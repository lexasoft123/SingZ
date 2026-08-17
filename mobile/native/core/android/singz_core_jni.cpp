// JNI shim over mobile/native/core — kept to marshalling only; everything
// with behavior (including the JSON the probe reports) lives in the shared
// core so iOS binds the same code.
#include <android/log.h>
#include <jni.h>

#include <atomic>
#include <cstdio>
#include <string>

#include "analysis.h"
#include "beat_this.h"
#include "melody.h"
#include "ort_env.h"
#include "progress.h"
#include "split_engine.h"
#include "wav.h"

namespace {

std::string toStd(JNIEnv* env, jstring s) {
  if (s == nullptr) return "";
  const char* chars = env->GetStringUTFChars(s, nullptr);
  std::string out = chars != nullptr ? chars : "";
  if (chars != nullptr) env->ReleaseStringUTFChars(s, chars);
  return out;
}

// One split at a time per process (the :split service enforces that too).
// The Progress lives at namespace scope so cancelSplit can never write into
// a dead stack frame; runSplit resets the flag at entry (a cancel pressed
// before the next job starts targets the job that was running, not the new
// one).
singz::Progress gProgress;

struct JniCallback {
  JNIEnv* env;
  jobject listener;  // com.singzplayer.split.SingzCore.SplitListener
  jmethodID onStage;
  jmethodID onChunk;
};

void progressTramp(void* user, const char* stage, float frac) {
  auto* cb = static_cast<JniCallback*>(user);
  if (cb == nullptr || cb->listener == nullptr) return;
  jstring s = cb->env->NewStringUTF(stage);
  cb->env->CallVoidMethod(cb->listener, cb->onStage, s, static_cast<jfloat>(frac));
  cb->env->DeleteLocalRef(s);
  if (cb->env->ExceptionCheck()) cb->env->ExceptionClear();
}

void chunkTramp(void* user, int64_t done, int64_t total) {
  auto* cb = static_cast<JniCallback*>(user);
  if (cb == nullptr || cb->listener == nullptr) return;
  cb->env->CallVoidMethod(cb->listener, cb->onChunk, static_cast<jlong>(done),
                          static_cast<jlong>(total));
  if (cb->env->ExceptionCheck()) cb->env->ExceptionClear();
}

}  // namespace

extern "C" JNIEXPORT jstring JNICALL
Java_com_singzplayer_split_SingzCore_ortProbe(JNIEnv* env, jobject /*thiz*/,
                                              jstring modelPath) {
  const std::string json = singz::ortProbeJson(toStd(env, modelPath));
  return env->NewStringUTF(json.c_str());
}

// Runs the whole split ON THE CALLING THREAD (the service owns a worker
// thread for it); callbacks re-enter Java on that same thread, so no
// attach/detach dance. Returns "" on ok, "cancelled", or an error message.
extern "C" JNIEXPORT jstring JNICALL
Java_com_singzplayer_split_SingzCore_runSplit(JNIEnv* env, jobject /*thiz*/,
                                              jstring modelPath, jstring mixPath,
                                              jstring jobDir, jint srcRate,
                                              jlong resumeChunk, jint threads,
                                              jobject listener) {
  JniCallback cb{env, listener, nullptr, nullptr};
  if (listener != nullptr) {
    jclass cls = env->GetObjectClass(listener);
    cb.onStage = env->GetMethodID(cls, "onStage", "(Ljava/lang/String;F)V");
    cb.onChunk = env->GetMethodID(cls, "onChunk", "(JJ)V");
  }

  singz::SplitJobConfig config;
  config.modelPath = toStd(env, modelPath);
  config.mixPcmPath = toStd(env, mixPath);
  config.jobDir = toStd(env, jobDir);
  config.srcRate = srcRate;
  config.resumeChunk = resumeChunk;
  config.intraOpThreads = threads;
  config.onChunkDone = &chunkTramp;
  config.onChunkUser = &cb;

  gProgress.cancel.store(false);
  gProgress.cb = &progressTramp;
  gProgress.user = &cb;
  std::string error;
  const singz::SplitResult result = singz::runSplit(config, gProgress, error);
  gProgress.cb = nullptr;
  gProgress.user = nullptr;

  switch (result) {
    case singz::SplitResult::ok:
      return env->NewStringUTF("");
    case singz::SplitResult::cancelled:
      return env->NewStringUTF("cancelled");
    case singz::SplitResult::failed:
    default:
      return env->NewStringUTF(error.empty() ? "split failed" : error.c_str());
  }
}

extern "C" JNIEXPORT void JNICALL
Java_com_singzplayer_split_SingzCore_cancelSplit(JNIEnv* /*env*/, jobject /*thiz*/) {
  gProgress.cancel.store(true);
}

// ---- Phase 4c: the melody tracker (melody.cpp) -----------------------------
//
// Reads the stem WAV itself and returns [hopSec, sampleRate, durationSec,
// detVersion, f0...] as one double array — one JNI copy (a boxed list of
// 10k values would not be), and doubles so hopSec keeps every bit the TS
// stores (a float32 hop would round it). An empty array = "could not
// read".
extern "C" JNIEXPORT jdoubleArray JNICALL
Java_com_singzplayer_split_SingzCore_analyzeMelody(JNIEnv* env, jobject /*thiz*/, jstring jpath) {
  const char* c = env->GetStringUTFChars(jpath, nullptr);
  if (c == nullptr) return nullptr;  // OOM, exception pending — let it surface
  const std::string path(c);
  env->ReleaseStringUTFChars(jpath, c);
  singz::MonoWav wav = singz::readWavMono(path);
  if (!wav.ok) return env->NewDoubleArray(0);
  const singz::MelodyTrack t = singz::trackMelody(wav.samples.data(), wav.samples.size(), wav.sampleRate, nullptr);
  std::vector<double> out;
  out.reserve(4 + t.f0.size());
  out.push_back(t.hopSec);
  out.push_back(static_cast<double>(wav.sampleRate));
  out.push_back(static_cast<double>(wav.samples.size()) / wav.sampleRate);
  out.push_back(static_cast<double>(singz::kPitchDetectVersion));
  for (const float v : t.f0) out.push_back(static_cast<double>(v));
  jdoubleArray arr = env->NewDoubleArray(static_cast<jsize>(out.size()));
  env->SetDoubleArrayRegion(arr, 0, static_cast<jsize>(out.size()), out.data());
  return arr;
}

// [sampleRate, channels, frames, durationSec], or empty when unreadable.
extern "C" JNIEXPORT jdoubleArray JNICALL
Java_com_singzplayer_split_SingzCore_wavInfo(JNIEnv* env, jobject /*thiz*/, jstring jpath) {
  const char* c = env->GetStringUTFChars(jpath, nullptr);
  if (c == nullptr) return nullptr;
  const std::string path(c);
  env->ReleaseStringUTFChars(jpath, c);
  const singz::WavInfo wav = singz::readWavInfo(path);  // header only — no samples read
  if (!wav.ok) return env->NewDoubleArray(0);
  const double v[4] = {static_cast<double>(wav.sampleRate), static_cast<double>(wav.channels),
                       static_cast<double>(wav.frames), static_cast<double>(wav.frames) / wav.sampleRate};
  jdoubleArray arr = env->NewDoubleArray(4);
  env->SetDoubleArrayRegion(arr, 0, 4, v);
  return arr;
}

// [pc, minor(0/1), detVersion]; EMPTY means "no key in this audio" (the TS
// null — a silent harmonic bed), which the pipeline stores as a verdict and
// never asks about again. A stem that cannot be READ is a different answer
// and must not be mistaken for it: null, so Kotlin rejects and iOS's
// behaviour is matched. `paths` is the instrument stems; `bassPath` may be "".
extern "C" JNIEXPORT jdoubleArray JNICALL
Java_com_singzplayer_split_SingzCore_analyzeKey(JNIEnv* env, jobject /*thiz*/, jobjectArray paths,
                                                jstring jbass) {
  std::vector<singz::AnalysisStem> stems;
  const jsize n = paths != nullptr ? env->GetArrayLength(paths) : 0;
  for (jsize i = 0; i < n; i++) {
    jstring js = static_cast<jstring>(env->GetObjectArrayElement(paths, i));
    const char* c = env->GetStringUTFChars(js, nullptr);
    if (c == nullptr) return nullptr;
    singz::MonoWav w = singz::readWavMono(std::string(c));
    env->ReleaseStringUTFChars(js, c);
    env->DeleteLocalRef(js);  // a long inst list would otherwise fill the local frame
    if (!w.ok) return nullptr;  // unreadable ≠ silent
    singz::AnalysisStem st;
    st.mono = std::move(w.samples);
    st.sampleRate = w.sampleRate;
    stems.push_back(std::move(st));
  }
  singz::AnalysisStem bassStem;
  bool haveBass = false;
  if (jbass != nullptr) {
    const char* c = env->GetStringUTFChars(jbass, nullptr);
    if (c == nullptr) return nullptr;
    const std::string path(c);
    env->ReleaseStringUTFChars(jbass, c);
    if (!path.empty()) {
      singz::MonoWav w = singz::readWavMono(path);
      if (!w.ok) return nullptr;  // unreadable ≠ silent
      bassStem.mono = std::move(w.samples);
      bassStem.sampleRate = w.sampleRate;
      haveBass = true;
    }
  }
  const singz::KeyGuess k = singz::estimateKeyFromStems(stems, haveBass ? &bassStem : nullptr);
  if (!k.ok) return env->NewDoubleArray(0);
  const double v[3] = {static_cast<double>(k.pc), k.minor ? 1.0 : 0.0,
                       static_cast<double>(singz::kKeyDetectVersion)};
  jdoubleArray arr = env->NewDoubleArray(3);
  env->SetDoubleArrayRegion(arr, 0, 3, v);
  return arr;
}

/**
 * Beat This! on the phone: a 22.05 kHz MONO wav plus a directory holding
 * logmel.onnx and beat_this.onnx, in; the desktop's one JSON line, out.
 *
 * One string and nothing else, for the same reason ortProbe returns one — it
 * is the shape iOS marshals too, so the two platforms cannot drift in what
 * they report. Errors come back as `{"error":"…"}` rather than an empty
 * string, because "no grid" and "the models are missing" are different
 * answers and the caller has to be able to tell them apart.
 *
 * The rate is CHECKED, not resampled. Feeding this 44.1 kHz would produce a
 * grid at half the real tempo with nothing anywhere reporting a problem, and
 * the decimation the desktop does on its way to 22.05 kHz has its own parity
 * question that this binding is not the place to answer.
 */
extern "C" JNIEXPORT jstring JNICALL
Java_com_singzplayer_split_SingzCore_mlGrid(JNIEnv* env, jobject /*thiz*/, jstring jwav,
                                            jstring jmodels, jstring jdump) {
  const std::string wavPath = toStd(env, jwav);
  const std::string modelsDir = toStd(env, jmodels);
  const std::string dumpDir = toStd(env, jdump);  // "" = no tee

  const auto fail = [env](const std::string& why) {
    // Escaped, because the only interpolated text is ORT's e.what(): a quote
    // or newline in a model-load message would otherwise make the Kotlin side
    // throw a JSONException and report a parse error instead of the reason.
    std::string esc;
    esc.reserve(why.size() + 16);
    for (const char c : why) {
      if (c == '"' || c == '\\') { esc += '\\'; esc += c; }
      else if (c == '\n') esc += "\\n";
      else if (c == '\r') esc += "\\r";
      else if (c == '\t') esc += "\\t";
      else if (static_cast<unsigned char>(c) < 0x20) esc += ' ';
      else esc += c;
    }
    return env->NewStringUTF(("{\"error\":\"" + esc + "\"}").c_str());
  };

  singz::MonoWav wav = singz::readWavMono(wavPath);
  if (!wav.ok) return fail("could not read the wav: " + wav.error);
  if (wav.sampleRate != singz::kBeatThisSr) {
    return fail("beat models want " + std::to_string(singz::kBeatThisSr) + " Hz, got " +
                std::to_string(wav.sampleRate));
  }

  std::string error;
  const singz::BeatThisModels models = singz::loadBeatThisModels(modelsDir, error);
  if (!error.empty()) return fail(error);

  // With a dump dir, TEE what the two graphs return on their way past. The
  // host parity gate replays recorded logits, so it proves the pure logic and
  // says nothing about this file's marshalling — which is the one half that
  // only ever runs here. Wrapping the callables rather than changing the core
  // means the dumped tensors are the production path's, not a parallel one.
  singz::BeatThisModels tapped = models;
  if (!dumpDir.empty()) {
    const auto write = [dumpDir](const char* name, const std::vector<float>& v, const char* mode) {
      FILE* f = std::fopen((dumpDir + "/" + name).c_str(), mode);
      if (f == nullptr) {
        // Silence here would be the tee's own version of a false pass: a
        // reader slicing to the recording's length would read whatever was
        // there before and call it this run's tensors. logcat, NOT stderr —
        // an app process's fd 2 goes to /dev/null unless log.redirect-stdio
        // is set, which it is not on the AVD this suite drives, so a printf
        // here would have been a silent fix for silence.
        __android_log_print(ANDROID_LOG_WARN, "singz", "mlGrid tee could not open %s/%s",
                            dumpDir.c_str(), name);
        return;
      }
      std::fwrite(v.data(), sizeof(float), v.size(), f);
      std::fclose(f);
    };
    // The chunk tees append (one write per chunk, in call order), so a second
    // run into the same dir would leave BOTH runs concatenated with the stale
    // bytes at the head — exactly where a reader looks. Truncate once here.
    for (const char* n : {"dev-chunk-in.f32", "dev-chunk-beat.f32", "dev-chunk-down.f32"}) {
      FILE* f = std::fopen((dumpDir + "/" + n).c_str(), "wb");
      if (f != nullptr) std::fclose(f);
    }
    const singz::BeatThisModels inner = models;
    tapped.logmel = [inner, write](const std::vector<float>& frames, int n) {
      const std::vector<float> spect = inner.logmel(frames, n);
      write("dev-frames.f32", frames, "wb");
      write("dev-spect.f32", spect, "wb");
      return spect;
    };
    tapped.model = [inner, write](const std::vector<float>& spect, std::vector<float>& b,
                                  std::vector<float>& d) {
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
  }

  const singz::MlGrid grid = singz::beatThis(wav.samples, tapped, nullptr);
  if (!grid.ok) return fail(grid.error);
  return env->NewStringUTF(singz::mlGridJson(grid).c_str());
}

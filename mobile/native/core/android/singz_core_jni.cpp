// JNI shim over mobile/native/core — kept to marshalling only; everything
// with behavior (including the JSON the probe reports) lives in the shared
// core so iOS binds the same code.
#include <jni.h>

#include <atomic>
#include <string>

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

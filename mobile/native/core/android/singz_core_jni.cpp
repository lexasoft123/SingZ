// JNI shim over mobile/native/core — kept to marshalling only; everything
// with behavior (including the JSON the probe reports) lives in the shared
// core so iOS binds the same code.
#include <jni.h>

#include <atomic>
#include <string>

#include "ort_env.h"
#include "progress.h"
#include "split_engine.h"

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

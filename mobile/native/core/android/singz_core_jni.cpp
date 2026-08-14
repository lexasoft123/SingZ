// JNI shim over mobile/native/core — kept to marshalling only; everything
// with behavior (including the JSON the probe reports) lives in the shared
// core so iOS binds the same code.
#include <jni.h>

#include <string>

#include "ort_env.h"

extern "C" JNIEXPORT jstring JNICALL
Java_com_singzplayer_split_SingzCore_ortProbe(JNIEnv* env, jobject /*thiz*/,
                                              jstring modelPath) {
  const char* pathChars = env->GetStringUTFChars(modelPath, nullptr);
  const std::string path = pathChars != nullptr ? pathChars : "";
  if (pathChars != nullptr) env->ReleaseStringUTFChars(modelPath, pathChars);

  const std::string json = singz::ortProbeJson(path);
  return env->NewStringUTF(json.c_str());
}

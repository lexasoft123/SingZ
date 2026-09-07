#include <jni.h>

#include <string>
#include <vector>

#include "tests/fixtures/codecs/target/target_codec_proof.h"

extern "C" JNIEXPORT jstring JNICALL
Java_com_singzplayer_split_SingzCore_nativeCodecTargetProof(
    JNIEnv* env, jobject /* thiz */, jobjectArray fixturePaths) {
#if defined(SINGZ_CODEC_TARGET_PROOF)
  if (fixturePaths == nullptr || env->GetArrayLength(fixturePaths) != 12) {
    return env->NewStringUTF(
        "{\"format\":1,\"execution\":\"actual-packaged-zcore-runtime\","
        "\"result\":\"failed\",\"error\":\"exactly 12 fixtures required\"}");
  }
  std::vector<std::string> paths;
  paths.reserve(12);
  for (jsize index = 0; index < 12; ++index) {
    auto* value = static_cast<jstring>(
        env->GetObjectArrayElement(fixturePaths, index));
    if (value == nullptr) {
      paths.emplace_back();
      continue;
    }
    const char* bytes = env->GetStringUTFChars(value, nullptr);
    paths.emplace_back(bytes == nullptr ? "" : bytes);
    if (bytes != nullptr) env->ReleaseStringUTFChars(value, bytes);
    env->DeleteLocalRef(value);
  }
  const std::string result = singz::codec_target_proof::run(paths);
  return env->NewStringUTF(result.c_str());
#else
  (void)fixturePaths;
  return env->NewStringUTF(
      "{\"format\":1,\"execution\":\"disabled\",\"result\":\"failed\","
      "\"error\":\"codec target proof was not compiled into this build\"}");
#endif
}

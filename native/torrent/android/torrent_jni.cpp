#include "../torrent_engine.h"
#include <jni.h>
#include <string>
#include <vector>
static std::string utf8(JNIEnv *env, jstring value) {
  if (!value)
    return {};
  auto cls = env->FindClass("java/lang/String");
  auto get = env->GetMethodID(cls, "getBytes", "(Ljava/lang/String;)[B");
  auto encoding = env->NewStringUTF("UTF-8");
  auto bytes =
      static_cast<jbyteArray>(env->CallObjectMethod(value, get, encoding));
  if (!bytes)
    return {};
  auto n = env->GetArrayLength(bytes);
  std::string result(n, '\0');
  env->GetByteArrayRegion(bytes, 0, n,
                          reinterpret_cast<jbyte *>(result.data()));
  env->DeleteLocalRef(bytes);
  env->DeleteLocalRef(encoding);
  env->DeleteLocalRef(cls);
  return result;
}
static jstring javaString(JNIEnv *env, std::string const &value) {
  auto bytes = env->NewByteArray(value.size());
  env->SetByteArrayRegion(bytes, 0, value.size(),
                          reinterpret_cast<jbyte const *>(value.data()));
  auto cls = env->FindClass("java/lang/String");
  auto init = env->GetMethodID(cls, "<init>", "([BLjava/lang/String;)V");
  auto encoding = env->NewStringUTF("UTF-8");
  auto result =
      static_cast<jstring>(env->NewObject(cls, init, bytes, encoding));
  env->DeleteLocalRef(bytes);
  env->DeleteLocalRef(encoding);
  env->DeleteLocalRef(cls);
  return result;
}
extern "C" JNIEXPORT jstring JNICALL Java_com_singzplayer_TorrentNative_call(
    JNIEnv *env, jclass, jstring root, jstring op, jstring release, jint index,
    jbyteArray metadata) {
  auto r = utf8(env, root), o = utf8(env, op), id = utf8(env, release);
  std::vector<unsigned char> bytes;
  if (metadata) {
    auto n = env->GetArrayLength(metadata);
    if (n > 16 * 1024 * 1024)
      return javaString(
          env, "{\"ok\":false,\"error\":\"Torrent metadata is too large\"}");
    bytes.resize(n);
    env->GetByteArrayRegion(metadata, 0, n,
                            reinterpret_cast<jbyte *>(bytes.data()));
  }
  char *out = singz_torrent_call(r.c_str(), o.c_str(), id.c_str(), index,
                                 bytes.data(), bytes.size());
  auto result = javaString(
      env,
      out ? out
          : "{\"ok\":false,\"error\":\"Torrent engine ran out of memory\"}");
  singz_torrent_free(out);
  return result;
}
extern "C" JNIEXPORT void JNICALL
Java_com_singzplayer_TorrentNative_shutdown(JNIEnv *env, jclass, jstring root) {
  auto r = utf8(env, root);
  singz_torrent_shutdown(r.c_str());
}

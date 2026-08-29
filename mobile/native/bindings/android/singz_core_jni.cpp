// JNI shim over top-level zcore — kept to marshalling only; everything
// with behavior (including the JSON the probe reports) lives in the shared
// core so iOS binds the same code.
#include <android/log.h>
#include <jni.h>

#include <algorithm>
#include <atomic>
#include <bit>
#include <cmath>
#include <cstdio>
#include <memory>
#include <mutex>
#include <string>
#include <utility>
#include <vector>

#include <zcore/legacy/analysis.h>
#include <zcore/device/audio_input.h>
#include <zdsp/analysis/capture_adapter.h>
#include <zcore/device/audio_input_android_registry.h>
#include <zcore/legacy/beat_this.h>
#include <zcore/legacy/beats.h>
#include <zcore/legacy/melody.h>
#include <zcore/legacy/ort_env.h>
#include <zcore/base/progress.h>
#include <zcore/legacy/resample.h>
#include <zcore/legacy/split_engine.h>
#include <zcore/media/wav.h>
#include <zcore/media/flac_io.h>

namespace {

std::string toStd(JNIEnv* env, jstring s) {
  if (s == nullptr) return "";
  const char* chars = env->GetStringUTFChars(s, nullptr);
  std::string out = chars != nullptr ? chars : "";
  if (chars != nullptr) env->ReleaseStringUTFChars(s, chars);
  return out;
}

jlong unsignedBits(uint64_t value) noexcept {
  static_assert(sizeof(jlong) == sizeof(value));
  return std::bit_cast<jlong>(value);
}

jobjectArray stringArray(JNIEnv* env, const std::vector<std::string>& values) {
  jclass stringClass = env->FindClass("java/lang/String");
  if (!stringClass) return nullptr;
  jobjectArray result =
      env->NewObjectArray(static_cast<jsize>(values.size()), stringClass, nullptr);
  env->DeleteLocalRef(stringClass);
  if (!result) return nullptr;
  for (jsize i = 0; i < static_cast<jsize>(values.size()); ++i) {
    jstring value = env->NewStringUTF(values[static_cast<size_t>(i)].c_str());
    if (!value) return result;
    env->SetObjectArrayElement(result, i, value);
    env->DeleteLocalRef(value);
  }
  return result;
}

// One split at a time per process (the :split service enforces that too).
// The Progress lives at namespace scope so cancelSplit can never write into
// a dead stack frame; runSplit resets the flag at entry (a cancel pressed
// before the next job starts targets the job that was running, not the new
// one).
singz::Progress gProgress;

std::mutex gAudioInputMutex;
std::unique_ptr<singz::AudioInput> gAudioInput;

struct AudioInputListenerBridge {
  JavaVM* vm = nullptr;
  jobject listener = nullptr;
  jmethodID onFrame = nullptr;
  std::atomic<bool> active{true};
  explicit AudioInputListenerBridge(uint64_t generation)
      : analysisAdapter(generation) {}

  zdsp::analysis::LiveInputAnalysisAdapter analysisAdapter;
  // Largest lift the adapter has applied, ×100. Reported through stats so a
  // field log can prove the normalization is IN this binary and doing work —
  // a .cpp change that never made it into the APK otherwise reads as green.
  std::atomic<uint32_t> peakGainX100{0};

  ~AudioInputListenerBridge() {
    active.store(false, std::memory_order_release);
    if (!vm || !listener) return;
    JNIEnv* env = nullptr;
    bool attached = false;
    if (vm->GetEnv(reinterpret_cast<void**>(&env), JNI_VERSION_1_6) != JNI_OK) {
      if (vm->AttachCurrentThread(&env, nullptr) != JNI_OK) return;
      attached = true;
    }
    env->DeleteGlobalRef(listener);
    if (attached) vm->DetachCurrentThread();
  }

  void emit(const singz::AudioInputBlockView& block) {
    if (!active.load(std::memory_order_acquire) || !vm || !listener || !onFrame) return;
    (void)analysisAdapter.push(block, [&](const zdsp::analysis::AnalysisWindow& window) {
      if (!active.load(std::memory_order_acquire)) return;
      JNIEnv* env = nullptr;
      bool attached = false;
      if (vm->GetEnv(reinterpret_cast<void**>(&env), JNI_VERSION_1_6) != JNI_OK) {
        if (vm->AttachCurrentThread(&env, nullptr) != JNI_OK) return;
        attached = true;
      }
      env->CallVoidMethod(listener, onFrame,
                          static_cast<jlong>(window.ownershipGeneration),
                          unsignedBits(window.start.clockDomain.value),
                          unsignedBits(window.start.streamGeneration.value),
                          unsignedBits(window.start.sequence),
                          unsignedBits(window.end.sequence),
                          unsignedBits(window.start.sourceFrame.value),
                          unsignedBits(window.end.sourceFrame.value),
                          unsignedBits(window.start.sampleHostTime.value),
                          unsignedBits(window.end.sampleHostTime.value),
                          unsignedBits(window.deliveredAt.value),
                          static_cast<jint>(window.start.flags),
                          static_cast<jint>(window.end.flags),
                          static_cast<jint>(
                              window.start.quality ==
                                      zdsp::CaptureTimestampQuality::Hardware
                                  ? 1
                                  : window.start.quality ==
                                            zdsp::CaptureTimestampQuality::Estimated
                                        ? 2
                                        : 0),
                          static_cast<jint>(window.resetReason),
                          unsignedBits(window.resetCount),
                          static_cast<jdouble>(window.sampleRate.value),
                          static_cast<jdouble>(window.analysis.frequency),
                          static_cast<jdouble>(window.analysis.clarity),
                          static_cast<jdouble>(window.analysis.peak),
                          static_cast<jdouble>(window.analysis.rms),
                          static_cast<jdouble>(window.analysis.dbfs));
      if (env->ExceptionCheck()) env->ExceptionClear();
      if (attached) vm->DetachCurrentThread();
      // Per WINDOW, not once per push: one maximum-size callback emits 29
      // windows, and sampling after push() returns reports only the last —
      // measured reporting 1.00x for a callback that lifted 16.13x, which
      // reads as "normalization did nothing", the exact wrong conclusion for
      // the one line meant to be trustworthy evidence from a phone nobody can
      // attach a debugger to.
      const auto gain =
          static_cast<uint32_t>(analysisAdapter.appliedGain() * 100.0f + 0.5f);
      uint32_t seen = peakGainX100.load(std::memory_order_relaxed);
      while (gain > seen &&
             !peakGainX100.compare_exchange_weak(seen, gain,
                                                 std::memory_order_relaxed)) {
      }
    });
  }
};

std::shared_ptr<AudioInputListenerBridge> gAudioInputListener;

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

extern "C" JNIEXPORT void JNICALL
Java_com_singzplayer_split_SingzCore_replaceAudioInputDevices(
    JNIEnv* env, jobject /*thiz*/, jobjectArray juids, jobjectArray jlabels,
    jdoubleArray jrates, jintArray jchannels) {
  if (!juids || !jlabels || !jrates || !jchannels) {
    singz::replaceAndroidAudioInputDevices({});
    return;
  }
  const jsize count = env->GetArrayLength(juids);
  if (count < 0 || count > 256 || env->GetArrayLength(jlabels) != count ||
      env->GetArrayLength(jrates) != count || env->GetArrayLength(jchannels) != count) {
    singz::replaceAndroidAudioInputDevices({});
    return;
  }
  std::vector<jdouble> rates(static_cast<size_t>(count));
  std::vector<jint> channels(static_cast<size_t>(count));
  if (count) {
    env->GetDoubleArrayRegion(jrates, 0, count, rates.data());
    env->GetIntArrayRegion(jchannels, 0, count, channels.data());
  }
  std::vector<singz::AudioInputDevice> devices;
  devices.reserve(static_cast<size_t>(count));
  for (jsize i = 0; i < count; ++i) {
    auto* juid = static_cast<jstring>(env->GetObjectArrayElement(juids, i));
    auto* jlabel = static_cast<jstring>(env->GetObjectArrayElement(jlabels, i));
    singz::AudioInputDevice device;
    device.uid = toStd(env, juid);
    device.label = toStd(env, jlabel);
    device.sampleRate = rates[static_cast<size_t>(i)];
    device.channels = channels[static_cast<size_t>(i)] > 0
                          ? static_cast<uint32_t>(channels[static_cast<size_t>(i)])
                          : 0;
    // Android has no public "active/default capture endpoint" query. The UI
    // carries its own explicitly named isPreferred heuristic; the portable
    // core must not misrepresent that as an OS default.
    device.isDefault = false;
    device.channelLabels.reserve(device.channels);
    for (uint32_t channel = 0; channel < device.channels; ++channel)
      device.channelLabels.push_back("Channel " + std::to_string(channel + 1));
    devices.push_back(std::move(device));
    if (juid) env->DeleteLocalRef(juid);
    if (jlabel) env->DeleteLocalRef(jlabel);
  }
  singz::replaceAndroidAudioInputDevices(std::move(devices));
}

extern "C" JNIEXPORT jobjectArray JNICALL
Java_com_singzplayer_split_SingzCore_startAudioInput(
    JNIEnv* env, jobject /*thiz*/, jstring juid, jint channel,
    jlong ownershipGeneration, jobject listener) {
  if (channel < 0 || ownershipGeneration <= 0 || !listener)
    return stringArray(env, {"Android audio input arguments are invalid"});
  std::lock_guard<std::mutex> lock(gAudioInputMutex);
  if (gAudioInput)
    return stringArray(env, {"Another Android audio input owner is active"});

  auto bridge = std::make_shared<AudioInputListenerBridge>(
      static_cast<uint64_t>(ownershipGeneration));
  env->GetJavaVM(&bridge->vm);
  bridge->listener = env->NewGlobalRef(listener);
  jclass listenerClass = env->GetObjectClass(listener);
  bridge->onFrame = env->GetMethodID(
      listenerClass, "onFrame", "(JJJJJJJJJJIIIIJDDDDDD)V");
  env->DeleteLocalRef(listenerClass);
  if (!bridge->vm || !bridge->listener || !bridge->onFrame) {
    if (env->ExceptionCheck()) env->ExceptionClear();
    return stringArray(env, {"Android audio input listener is invalid"});
  }

  auto input = std::make_unique<singz::AudioInput>();
  singz::AudioInputConfig config;
  config.deviceUid = toStd(env, juid);
  config.channel = static_cast<uint32_t>(channel);
  config.ringBlocks = 32;
  const singz::AudioInputResult result = input->start(
      config, [bridge](const singz::AudioInputBlockView& block) { bridge->emit(block); });
  if (!result.ok) {
    bridge->active.store(false, std::memory_order_release);
    return stringArray(env, {result.error});
  }
  gAudioInputListener = std::move(bridge);
  gAudioInput = std::move(input);
  return stringArray(
      env, {"", result.deviceUid, std::to_string(result.sampleRate),
            std::to_string(result.deviceChannels), std::to_string(result.channel),
            result.sampleFormat, result.sharingMode, result.performanceMode,
            result.inputPreset, result.timestampSource,
            zdsp::analysis::analysisBuildId()});
}

extern "C" JNIEXPORT jboolean JNICALL
Java_com_singzplayer_split_SingzCore_stopAudioInput(JNIEnv*, jobject /*thiz*/) {
  std::unique_ptr<singz::AudioInput> input;
  std::shared_ptr<AudioInputListenerBridge> listener;
  {
    std::lock_guard<std::mutex> lock(gAudioInputMutex);
    input = std::move(gAudioInput);
    listener = std::move(gAudioInputListener);
    if (listener) listener->active.store(false, std::memory_order_release);
  }
  if (input) input->stop();
  // AudioInput::stop joins delivery and the platform backend synchronously.
  // Kotlin must retain its ownership token until this confirmation returns.
  return JNI_TRUE;
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_singzplayer_split_SingzCore_audioInputState(JNIEnv* env, jobject /*thiz*/) {
  std::lock_guard<std::mutex> lock(gAudioInputMutex);
  if (!gAudioInput) return env->NewStringUTF("idle");
  return env->NewStringUTF(singz::audioInputStateName(gAudioInput->state()));
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_singzplayer_split_SingzCore_audioInputLastError(JNIEnv* env, jobject /*thiz*/) {
  std::lock_guard<std::mutex> lock(gAudioInputMutex);
  const std::string error = gAudioInput ? gAudioInput->lastError() : "";
  return env->NewStringUTF(error.c_str());
}

extern "C" JNIEXPORT jlongArray JNICALL
Java_com_singzplayer_split_SingzCore_audioInputStats(JNIEnv* env, jobject /*thiz*/) {
  std::lock_guard<std::mutex> lock(gAudioInputMutex);
  const singz::AudioInputStats stats = gAudioInput ? gAudioInput->stats()
                                                   : singz::AudioInputStats{};
  const jlong values[] = {
      static_cast<jlong>(stats.deliveredBlocks),
      static_cast<jlong>(stats.deliveredFrames),
      static_cast<jlong>(stats.overruns),
      static_cast<jlong>(stats.deliveryWakeups),
      static_cast<jlong>(gAudioInputListener
                             ? gAudioInputListener->peakGainX100.load(
                                   std::memory_order_relaxed)
                             : 0)};
  jlongArray result = env->NewLongArray(5);
  if (result) env->SetLongArrayRegion(result, 0, 5, values);
  return result;
}

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

// One stem of the v1->v2 upgrade (Phase 5): compactStem in the core —
// level 5, verify on, .part rename, wav deleted on success, idempotent when
// the flac already exists. One JSON line out, the Android marshalling rule:
// {"ok":true,"bytes":N,"skipped":bool} or {"ok":false,"error":"…"} — sizes
// and booleans survive a text hop fine; it is only the core's DOUBLES that
// must never cross as text, and none does here.
extern "C" JNIEXPORT jstring JNICALL
Java_com_singzplayer_split_SingzCore_encodeFlac(JNIEnv* env, jobject /*thiz*/, jstring jwav,
                                                jstring jflac) {
  const char* cw = env->GetStringUTFChars(jwav, nullptr);
  const char* cf = env->GetStringUTFChars(jflac, nullptr);
  if (cw == nullptr || cf == nullptr) return nullptr;
  const std::string wav(cw), flac(cf);
  env->ReleaseStringUTFChars(jwav, cw);
  env->ReleaseStringUTFChars(jflac, cf);
  const singz::CompactResult r = singz::compactStem(wav, flac);
  std::string json;
  if (r.ok) {
    json = "{\"ok\":true,\"bytes\":" + std::to_string(r.bytes) +
           ",\"skipped\":" + (r.skipped ? "true" : "false") + "}";
  } else {
    std::string esc;
    for (char ch : r.error) {
      if (ch == '"' || ch == '\\') esc += '\\';
      esc += ch;
    }
    json = "{\"ok\":false,\"error\":\"" + esc + "\"}";
  }
  return env->NewStringUTF(json.c_str());
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
 * The beat detector in the core — `singz::detectBeats`, the desktop's whole
 * pipeline (ML fork, tracker, splices, bar phase, head backcast, v20 courts)
 * bit-identical, reading its stems from disk on a native thread.
 *
 * The aux is the app's: `bassPath`/`vocalsPath` may be "" (absent), `instPaths`
 * is the harmonic bed, `lineStarts` are lyric line times, `words` are aligned
 * word times as a FLAT [s0,e0,s1,e1,…] array (a nested one marshals awkwardly
 * on both bridges and an odd length is a caller bug worth failing on), and
 * `ml` is the neural lattice as three arrays plus its fps — `beatProb` is
 * deliberately NOT taken: nothing in detectBeats or the courts reads it, and
 * it is ~12 000 doubles per four-minute song that would cross the bridge for
 * nothing.
 *
 * Out: the desktop's one JSON line, like mlGrid and for the same reason —
 * it is a shape iOS can be held to as well, so the two platforms cannot
 * drift in what they report. `null` means the stems could not be READ;
 * `{"ok":false}` means the detector refused (the TS's null return), which is
 * a legitimate verdict the pipeline stores. Kotlin's JSON number parser is
 * correctly rounded, so the beat times survive the text hop exactly — the
 * iOS binding builds its dictionary from the same doubles WITHOUT text,
 * because Foundation's parser is not (see beat_this.h).
 */
extern "C" JNIEXPORT jstring JNICALL
Java_com_singzplayer_split_SingzCore_analyzeBeats(JNIEnv* env, jobject /*thiz*/, jstring jdrums,
                                                  jstring jbass, jstring jvocals,
                                                  jobjectArray jinst, jdoubleArray jlines,
                                                  jdoubleArray jwords, jdoubleArray jmlBeats,
                                                  jdoubleArray jmlDownbeats,
                                                  jdoubleArray jmlDownbeatProb, jint jmlFps) {
  const auto readStem = [&](const std::string& path, singz::AnalysisStem& into) {
    singz::MonoWav w = singz::readWavMono(path);
    if (!w.ok) return false;
    into.mono = std::move(w.samples);
    into.sampleRate = w.sampleRate;
    return true;
  };
  const auto readDoubles = [&](jdoubleArray a) {
    std::vector<double> out;
    if (a == nullptr) return out;
    const jsize n = env->GetArrayLength(a);
    out.resize(static_cast<size_t>(n));
    if (n > 0) env->GetDoubleArrayRegion(a, 0, n, out.data());
    return out;
  };

  singz::AnalysisStem drums;
  if (!readStem(toStd(env, jdrums), drums)) return nullptr;

  singz::AnalysisStem bass, vocals;
  bool haveBass = false, haveVocals = false;
  const std::string bassPath = toStd(env, jbass);
  if (!bassPath.empty()) {
    if (!readStem(bassPath, bass)) return nullptr;
    haveBass = true;
  }
  const std::string vocalsPath = toStd(env, jvocals);
  if (!vocalsPath.empty()) {
    if (!readStem(vocalsPath, vocals)) return nullptr;
    haveVocals = true;
  }
  std::vector<singz::AnalysisStem> inst;
  const jsize nInst = jinst != nullptr ? env->GetArrayLength(jinst) : 0;
  for (jsize i = 0; i < nInst; i++) {
    jstring js = static_cast<jstring>(env->GetObjectArrayElement(jinst, i));
    const std::string path = toStd(env, js);
    env->DeleteLocalRef(js);  // a long inst list would otherwise fill the local frame
    singz::AnalysisStem st;
    if (!readStem(path, st)) return nullptr;
    inst.push_back(std::move(st));
  }

  singz::BeatAux aux;
  aux.inst = &inst;
  if (haveBass) aux.bass = &bass;
  if (haveVocals) aux.vocals = &vocals;
  aux.lineStarts = readDoubles(jlines);
  const std::vector<double> flatWords = readDoubles(jwords);
  if (flatWords.size() % 2 != 0) return nullptr;  // a caller bug, not a silent half-word
  for (size_t i = 0; i + 1 < flatWords.size(); i += 2)
    aux.words.push_back({flatWords[i], flatWords[i + 1]});

  singz::MlGrid ml;
  ml.beats = readDoubles(jmlBeats);
  ml.downbeats = readDoubles(jmlDownbeats);
  ml.downbeatProb = readDoubles(jmlDownbeatProb);
  ml.fps = static_cast<int>(jmlFps);
  ml.ok = !ml.beats.empty();
  if (ml.ok) aux.ml = &ml;

  singz::BeatDebug dbg;
  const singz::BeatGrid grid = singz::detectBeats(drums, aux, dbg);

  std::string out = "{\"ok\":";
  if (!grid.ok) {
    out += "false}";
    return env->NewStringUTF(out.c_str());
  }
  char buf[64];
  const auto num = [&](double v) {
    std::snprintf(buf, sizeof buf, "%.17g", v);
    out += buf;
  };
  out += "true,\"bpm\":";
  num(grid.bpm);
  std::snprintf(buf, sizeof buf, ",\"beatsPerBar\":%d,\"downbeat\":%d,\"beats\":[", grid.beatsPerBar,
                grid.downbeat);
  out += buf;
  for (size_t i = 0; i < grid.beats.size(); i++) {
    if (i) out += ',';
    num(grid.beats[i]);
  }
  out += ']';
  // ABSENT, not empty: the TS's `downbeats` is undefined when the vote found
  // no bars, and the app stores the difference (an empty array is truthy).
  if (grid.hasDownbeats) {
    out += ",\"downbeats\":[";
    for (size_t i = 0; i < grid.downbeats.size(); i++) {
      if (i) out += ',';
      std::snprintf(buf, sizeof buf, "%d", grid.downbeats[i]);
      out += buf;
    }
    out += ']';
  }
  if (!grid.suspectAt.empty()) {
    out += ",\"suspectAt\":[";
    for (size_t i = 0; i < grid.suspectAt.size(); i++) {
      if (i) out += ',';
      num(grid.suspectAt[i]);
    }
    out += ']';
  }
  std::snprintf(buf, sizeof buf, ",\"detVersion\":%d}", singz::kBeatDetectVersion);
  out += buf;
  return env->NewStringUTF(out.c_str());
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
// The `{"error":"…"}` line both mlGrid entry points return on failure.
// Escaped, because the only interpolated text is ORT's e.what(): a quote or
// newline in a model-load message would otherwise make the Kotlin side throw
// a JSONException and report a parse error instead of the reason.
static jstring mlGridFailJson(JNIEnv* env, const std::string& why) {
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
}

// With a dump dir, TEE what the two graphs return on their way past. The
// host parity gate replays recorded logits, so it proves the pure logic and
// says nothing about this file's marshalling — which is the one half that
// only ever runs here. Wrapping the callables rather than changing the core
// means the dumped tensors are the production path's, not a parallel one.
// An empty dumpDir returns the models untouched — every real caller.
static singz::BeatThisModels tapBeatThisModels(const singz::BeatThisModels& models,
                                               const std::string& dumpDir) {
  singz::BeatThisModels tapped = models;
  if (dumpDir.empty()) return tapped;
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
  return tapped;
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_singzplayer_split_SingzCore_mlGrid(JNIEnv* env, jobject /*thiz*/, jstring jwav,
                                            jstring jmodels, jstring jdump) {
  const std::string wavPath = toStd(env, jwav);
  const std::string modelsDir = toStd(env, jmodels);
  const std::string dumpDir = toStd(env, jdump);  // "" = no tee

  singz::MonoWav wav = singz::readWavMono(wavPath);
  if (!wav.ok) return mlGridFailJson(env, "could not read the wav: " + wav.error);
  if (wav.sampleRate != singz::kBeatThisSr) {
    return mlGridFailJson(env, "beat models want " + std::to_string(singz::kBeatThisSr) +
                                   " Hz, got " + std::to_string(wav.sampleRate));
  }

  std::string error;
  const singz::BeatThisModels models = singz::loadBeatThisModels(modelsDir, error);
  if (!error.empty()) return mlGridFailJson(env, error);

  const singz::BeatThisModels tapped = tapBeatThisModels(models, dumpDir);
  const singz::MlGrid grid = singz::beatThis(wav.samples, tapped, nullptr);
  if (!grid.ok) return mlGridFailJson(env, grid.error);
  return env->NewStringUTF(singz::mlGridJson(grid).c_str());
}

/**
 * The same grid from the project's STEMS: the pipeline's entry point. Paths
 * to 44.1 kHz mono-foldable wavs in, the core sums and decimates them to the
 * model's 22.05 kHz itself (sumStemsTo22k — the desktop's fetchMlGrid mix,
 * natively), so no audio ever crosses a JS runtime for this. Same JSON line
 * out, same tee, same escaping, same arity as iOS — the rule at the top of
 * SingzSplit.mm.
 */
extern "C" JNIEXPORT jstring JNICALL
Java_com_singzplayer_split_SingzCore_mlGridFromStems(JNIEnv* env, jobject /*thiz*/,
                                                     jobjectArray jpaths, jstring jmodels,
                                                     jstring jdump) {
  std::vector<std::string> paths;
  const jsize n = env->GetArrayLength(jpaths);
  paths.reserve(static_cast<size_t>(n));
  for (jsize i = 0; i < n; i++) {
    auto* js = static_cast<jstring>(env->GetObjectArrayElement(jpaths, i));
    paths.push_back(toStd(env, js));
    env->DeleteLocalRef(js);
  }
  const std::string modelsDir = toStd(env, jmodels);
  const std::string dumpDir = toStd(env, jdump);  // "" = no tee

  std::string error;
  const singz::BeatThisModels models = singz::loadBeatThisModels(modelsDir, error);
  if (!error.empty()) return mlGridFailJson(env, error);

  const singz::BeatThisModels tapped = tapBeatThisModels(models, dumpDir);
  const singz::MlGrid grid = singz::beatThisFromStems(paths, tapped, nullptr);
  if (!grid.ok) return mlGridFailJson(env, grid.error);
  return env->NewStringUTF(singz::mlGridJson(grid).c_str());
}

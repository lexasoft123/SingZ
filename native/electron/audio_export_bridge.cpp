#include "audio_export_bridge.h"
#include <zcore/media/audio_export.h>
#include <atomic>
#include <memory>
#include <string>
#include <unordered_map>
#ifdef _WIN32
#include <io.h>
#include <fcntl.h>
#include <windows.h>
#include <uv.h>
#else
#include <unistd.h>
#endif

namespace singz {
namespace {
int duplicateDescriptor(int fd, bool writable) {
#ifdef _WIN32
  // Node/libuv descriptors do not belong to this addon's CRT descriptor table.
  const auto handle = uv_get_osfhandle(fd);
  HANDLE copy = nullptr;
  if (handle == INVALID_HANDLE_VALUE ||
      !DuplicateHandle(GetCurrentProcess(), handle, GetCurrentProcess(), &copy,
                       0, FALSE, DUPLICATE_SAME_ACCESS)) return -1;
  const int result = _open_osfhandle(reinterpret_cast<intptr_t>(copy),
      _O_BINARY | (writable ? _O_WRONLY : _O_RDONLY));
  if (result < 0) CloseHandle(copy);
  return result;
#else
  (void)writable;
  return dup(fd);
#endif
}
struct Job {
  napi_async_work work{};
  napi_deferred deferred{};
  std::string id;
  std::vector<OwnedFileDescriptor> sources;
  OwnedFileDescriptor destination;
  AudioExportFormat format{};
  std::atomic<bool> cancelled{false};
  AudioExportResult result;
};
// Accessed only from the environment's JS thread; workers read their flag.
std::unordered_map<std::string, std::shared_ptr<Job>> jobs;
napi_value resultValue(napi_env env, const AudioExportResult& result) {
  napi_value object, ok, error;
  napi_create_object(env, &object);
  napi_get_boolean(env, result.ok, &ok);
  napi_set_named_property(env, object, "ok", ok);
  if (!result.ok) {
    napi_create_string_utf8(env, result.error.c_str(), result.error.size(), &error);
    napi_set_named_property(env, object, "error", error);
  }
  return object;
}
bool stringArg(napi_env env, napi_value value, std::string& text) {
  size_t size = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &size) != napi_ok || size > 128) return false;
  text.resize(size + 1);
  if (napi_get_value_string_utf8(env, value, text.data(), text.size(), &size) != napi_ok) return false;
  text.resize(size);
  return true;
}
void execute(napi_env, void* data) {
  auto* job = static_cast<Job*>(data);
  job->result = exportAudioMix(std::move(job->sources), std::move(job->destination), job->format,
      {job, [](void* context) noexcept { return static_cast<Job*>(context)->cancelled.load(std::memory_order_relaxed); }});
}
void complete(napi_env env, napi_status status, void* data) {
  auto* job = static_cast<Job*>(data);
  if (status != napi_ok) job->result = {false, "Export worker cancelled"};
  napi_resolve_deferred(env, job->deferred, resultValue(env, job->result));
  napi_delete_async_work(env, job->work);
  jobs.erase(job->id);
}
napi_value begin(napi_env env, napi_callback_info info) {
  napi_value args[4]{};
  size_t argc = 4;
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  auto job = std::make_shared<Job>();
  int32_t source = -1, destination = -1;
  std::string format;
  napi_value promise;
  napi_create_promise(env, &job->deferred, &promise);
  if (argc != 4 || napi_get_value_int32(env, args[1], &destination) != napi_ok || destination < 0 ||
      !stringArg(env, args[2], format) || !stringArg(env, args[3], job->id) || job->id.empty() ||
      jobs.contains(job->id) || (format != "wav" && format != "flac" && format != "mp3")) {
    napi_resolve_deferred(env, job->deferred, resultValue(env, {false, "Invalid export request"}));
    return promise;
  }
  bool array = false;
  napi_is_array(env, args[0], &array);
  uint32_t count = 1;
  if (array && napi_get_array_length(env, args[0], &count) != napi_ok) count = 0;
  if (count == 0 || count > 64) {
    napi_resolve_deferred(env, job->deferred, resultValue(env, {false, "Invalid export sources"}));
    return promise;
  }
  for (uint32_t i = 0; i < count; ++i) {
    napi_value value = args[0];
    if (array) napi_get_element(env, args[0], i, &value);
    if (napi_get_value_int32(env, value, &source) != napi_ok || source < 0) {
      napi_resolve_deferred(env, job->deferred, resultValue(env, {false, "Invalid audio descriptor"}));
      return promise;
    }
    job->sources.emplace_back(duplicateDescriptor(source, false));
    if (!job->sources.back().valid()) {
      napi_resolve_deferred(env, job->deferred, resultValue(env, {false, "Could not duplicate audio descriptors"}));
      return promise;
    }
  }
  job->destination = OwnedFileDescriptor(duplicateDescriptor(destination, true));
  if (!job->destination.valid()) {
    napi_resolve_deferred(env, job->deferred, resultValue(env, {false, "Could not duplicate audio descriptors"}));
    return promise;
  }
  job->format = format == "wav" ? AudioExportFormat::Wav : format == "flac" ? AudioExportFormat::Flac : AudioExportFormat::Mp3;
  napi_value name;
  napi_create_string_utf8(env, "singz:audio-export", NAPI_AUTO_LENGTH, &name);
  if (napi_create_async_work(env, nullptr, name, execute, complete, job.get(), &job->work) != napi_ok) {
    napi_resolve_deferred(env, job->deferred, resultValue(env, {false, "Could not create export worker"}));
    return promise;
  }
  jobs.emplace(job->id, job);
  if (napi_queue_async_work(env, job->work) != napi_ok) {
    napi_delete_async_work(env, job->work);
    jobs.erase(job->id);
    napi_resolve_deferred(env, job->deferred, resultValue(env, {false, "Could not queue export worker"}));
  }
  return promise;
}
napi_value cancel(napi_env env, napi_callback_info info) {
  napi_value arg{};
  size_t argc = 1;
  napi_get_cb_info(env, info, &argc, &arg, nullptr, nullptr);
  std::string id;
  if (argc == 1 && stringArg(env, arg, id)) {
    const auto found = jobs.find(id);
    if (found != jobs.end()) found->second->cancelled.store(true, std::memory_order_relaxed);
  }
  napi_value result; napi_get_undefined(env, &result); return result;
}
}
void defineAudioExport(napi_env env, napi_value exports) {
  const napi_property_descriptor properties[] = {
    {"exportAudio", nullptr, begin, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"cancelAudioExport", nullptr, cancel, nullptr, nullptr, nullptr, napi_default, nullptr}
  };
  napi_define_properties(env, exports, 2, properties);
  napi_add_env_cleanup_hook(env, [](void*) { for (auto& [id, job] : jobs) { (void)id; job->cancelled.store(true, std::memory_order_relaxed); } }, nullptr);
}
}

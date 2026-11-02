#include "torrent_engine.h"
#include <memory>
#include <node_api.h>
#include <string>
#include <vector>
namespace {
struct Work {
  napi_env env;
  napi_deferred deferred;
  napi_async_work work;
  std::string root, op, release, result;
  int index = -1;
  std::vector<unsigned char> bytes;
};
std::string text(napi_env env, napi_value value) {
  size_t n = 0;
  napi_get_value_string_utf8(env, value, nullptr, 0, &n);
  if (n > 8192)
    return {};
  std::string s(n + 1, '\0');
  napi_get_value_string_utf8(env, value, s.data(), s.size(), &n);
  s.resize(n);
  return s;
}
napi_value request(napi_env env, napi_callback_info info) {
  napi_value args[5];
  size_t count = 5;
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  if (count < 4) {
    napi_throw_type_error(env, nullptr,
                          "Expected root, operation, release and file index");
    return nullptr;
  }
  auto w = std::make_unique<Work>();
  w->env = env;
  w->root = text(env, args[0]);
  w->op = text(env, args[1]);
  w->release = text(env, args[2]);
  napi_get_value_int32(env, args[3], &w->index);
  if (count == 5) {
    bool buffer = false;
    napi_is_buffer(env, args[4], &buffer);
    if (buffer) {
      void *data = nullptr;
      size_t size = 0;
      napi_get_buffer_info(env, args[4], &data, &size);
      if (size > 16 * 1024 * 1024) {
        napi_throw_range_error(env, nullptr, "Torrent metadata is too large");
        return nullptr;
      }
      auto *bytes = static_cast<unsigned char *>(data);
      w->bytes.assign(bytes, bytes + size);
    }
  }
  napi_value promise, label;
  napi_create_promise(env, &w->deferred, &promise);
  napi_create_string_utf8(env, "SingZ torrent", NAPI_AUTO_LENGTH, &label);
  napi_create_async_work(
      env, nullptr, label,
      [](napi_env, void *ptr) {
        auto *w = static_cast<Work *>(ptr);
        char *result = singz_torrent_call(w->root.c_str(), w->op.c_str(),
                                          w->release.c_str(), w->index,
                                          w->bytes.data(), w->bytes.size());
        w->result = result ? result
                           : "{\"ok\":false,\"error\":\"Torrent engine ran out "
                             "of memory\"}";
        singz_torrent_free(result);
      },
      [](napi_env env, napi_status, void *ptr) {
        std::unique_ptr<Work> w(static_cast<Work *>(ptr));
        napi_value result;
        napi_create_string_utf8(env, w->result.c_str(), w->result.size(),
                                &result);
        napi_resolve_deferred(env, w->deferred, result);
        napi_delete_async_work(env, w->work);
      },
      w.get(), &w->work);
  napi_queue_async_work(env, w->work);
  w.release();
  return promise;
}
napi_value shutdown(napi_env env, napi_callback_info info) {
  napi_value args[1];
  size_t n = 1;
  napi_get_cb_info(env, info, &n, args, nullptr, nullptr);
  if (n == 1) {
    auto root = text(env, args[0]);
    singz_torrent_shutdown(root.c_str());
  }
  return nullptr;
}
} // namespace
NAPI_MODULE_INIT() {
  napi_property_descriptor methods[] = {
      {"request", nullptr, request, nullptr, nullptr, nullptr, napi_default,
       nullptr},
      {"shutdown", nullptr, shutdown, nullptr, nullptr, nullptr, napi_default,
       nullptr}};
  napi_define_properties(env, exports, 2, methods);
  napi_value stamp;
  napi_create_string_utf8(env, singz_torrent_source_stamp(), NAPI_AUTO_LENGTH,
                          &stamp);
  napi_set_named_property(env, exports, "sourceStamp", stamp);
  return exports;
}

#include "box_routing_bridge.h"
#include "../playback/box_routing_owner.h"
#include <exception>
#include <string>
namespace singz {
namespace {
napi_value text(napi_env env, const std::string& value) {
  napi_value result; napi_create_string_utf8(env, value.data(), value.size(), &result); return result;
}
napi_value boolean(napi_env env, bool value) {
  napi_value result; napi_get_boolean(env, value, &result); return result;
}
bool argument(napi_env env, napi_callback_info info, std::string& value) {
  size_t argc = 1; napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  napi_valuetype type;
  if (argc != 1 || napi_typeof(env, argv[0], &type) != napi_ok || type != napi_string) {
    napi_throw_type_error(env, nullptr, "Expected one string argument"); return false;
  }
  size_t size = 0; napi_get_value_string_utf8(env, argv[0], nullptr, 0, &size);
  if (size > 1048576) { napi_throw_range_error(env, nullptr, "Routing argument exceeds limit"); return false; }
  value.resize(size + 1); napi_get_value_string_utf8(env, argv[0], value.data(), value.size(), &size);
  value.resize(size); return true;
}
napi_value empty(napi_env env) { napi_value value; napi_get_undefined(env, &value); return value; }
napi_value initialize(napi_env env, napi_callback_info info) {
  std::string path; if (!argument(env, info, path)) return nullptr;
  std::string error; const bool ok = initializeBoxRouting(path, error);
  napi_value result; napi_create_object(env, &result);
  napi_set_named_property(env, result, "ok", boolean(env, ok));
  if (!ok) napi_set_named_property(env, result, "error", text(env, error));
  return result;
}
napi_value request(napi_env env, napi_callback_info info) {
  std::string bytes; if (!argument(env, info, bytes)) return nullptr;
  try { return text(env, boxRoutingRequest(bytes)); }
  catch (const std::exception& ex) { napi_throw_error(env, nullptr, ex.what()); return nullptr; }
}
napi_value poll(napi_env env, napi_callback_info) {
  try { pollBoxRouting(); return empty(env); }
  catch (const std::exception& ex) { napi_throw_error(env, nullptr, ex.what()); return nullptr; }
}
napi_value shutdown(napi_env env, napi_callback_info) { shutdownBoxRouting(); return empty(env); }
napi_value capabilities(napi_env env, napi_callback_info) {
  napi_value result; napi_create_object(env, &result);
  napi_set_named_property(env, result, "supported", boolean(env, true));
  napi_set_named_property(env, result, "initialized", boolean(env, boxRoutingInitialized()));
  napi_set_named_property(env, result, "nativeSource", text(env, "native:singz"));
  napi_set_named_property(env, result, "audibleClockSupported", boolean(env, true));
  napi_set_named_property(env, result, "timingCoverageLost", boolean(env, boxRoutingTimingCoverageLost()));
  napi_set_named_property(env, result, "timestampQuality", text(env, "estimated-software-presentation"));
  return result;
}
}
void defineBoxRoutingExports(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    {"boxRoutingInitialize", nullptr, initialize, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"boxRoutingRequest", nullptr, request, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"boxRoutingPoll", nullptr, poll, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"boxRoutingCapabilities", nullptr, capabilities, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"boxRoutingShutdown", nullptr, shutdown, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
}
} // namespace singz

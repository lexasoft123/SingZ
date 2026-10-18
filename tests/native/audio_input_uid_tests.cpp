#include "zcore/platform/windows/audio_input_uid.h"
#include <cstdio>
#include <cstdlib>

#define CHECK(value) do { if (!(value)) { std::fprintf(stderr, "failed line %d: %s\n", __LINE__, #value); std::abort(); } } while (false)

int main() {
  using singz::detail::wasapiCaptureEndpointId;
  constexpr auto endpoint = "{0.0.1.00000000}.{12345678-1234-1234-1234-123456789abc}";
  CHECK(wasapiCaptureEndpointId(endpoint) == endpoint);
  CHECK(wasapiCaptureEndpointId("wasapi:{0.0.1.00000000}.{12345678-1234-1234-1234-123456789abc}") == endpoint);
  CHECK(wasapiCaptureEndpointId("").empty());
  CHECK(wasapiCaptureEndpointId("wasapi:").empty());
  return 0;
}

#pragma once

#include <string_view>

namespace singz::detail {

// Shared AudioHost inventories use raw MMDevice endpoint IDs. Older capture
// inventories and saved selections used a wasapi: prefix for the same endpoint.
inline std::string_view wasapiCaptureEndpointId(std::string_view uid) noexcept {
  constexpr std::string_view prefix = "wasapi:";
  if (uid.starts_with(prefix)) uid.remove_prefix(prefix.size());
  return uid;
}

}  // namespace singz::detail

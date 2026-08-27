#pragma once

#include <cstdint>
#include <string>

namespace singz::tools {

inline std::string jsonString(const std::string& value) {
  static constexpr char hex[] = "0123456789abcdef";
  std::string result;
  result.reserve(value.size() + 2);
  result.push_back('"');
  for (char character : value) {
    const auto byte = static_cast<uint8_t>(character);
    switch (byte) {
      case '"': result += "\\\""; break;
      case '\\': result += "\\\\"; break;
      case '\b': result += "\\b"; break;
      case '\f': result += "\\f"; break;
      case '\n': result += "\\n"; break;
      case '\r': result += "\\r"; break;
      case '\t': result += "\\t"; break;
      default:
        if (byte < 0x20) {
          result += "\\u00";
          result.push_back(hex[byte >> 4]);
          result.push_back(hex[byte & 0x0f]);
        } else {
          // Device strings are UTF-8. Preserve every non-control byte instead
          // of interpreting high-bit bytes through the platform's signed char.
          result.push_back(character);
        }
    }
  }
  result.push_back('"');
  return result;
}

}  // namespace singz::tools

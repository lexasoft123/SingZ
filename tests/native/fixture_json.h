// The JSON reader the native tests use to read tests/shared/*.json.
//
// It lived inside playback_cue_plan_tests.cpp until a second native test
// needed the same shared fixtures. Two copies of a parser is how two tests
// come to disagree about what a fixture says, which would defeat the point of
// having one file both languages read.
//
// Deliberately small and strict: no unicode escapes, no duplicate keys, no
// trailing data. Every fixture it reads is checked in beside it, so a parser
// that refuses anything unusual is a feature — the alternative is a test
// silently reading a document nobody meant to write.

#ifndef SINGZ_TESTS_NATIVE_FIXTURE_JSON_H
#define SINGZ_TESTS_NATIVE_FIXTURE_JSON_H

#include <cstdlib>
#include <fstream>
#include <iterator>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>

namespace singz::testfixture {

struct Json {
  enum class Kind { Null, Boolean, Number, String, Array, Object };
  Kind kind{Kind::Null};
  bool boolean{false};
  double number{0.0};
  std::string string;
  std::vector<Json> array;
  std::map<std::string, Json> object;

  const Json &at(const std::string &key) const { return object.at(key); }
};

class JsonParser {
public:
  explicit JsonParser(std::string text) : text_(std::move(text)) {}

  Json parse() {
    Json value = parseValue();
    whitespace();
    if (position_ != text_.size()) {
      throw std::runtime_error("trailing JSON data");
    }
    return value;
  }

private:
  Json parseValue() {
    whitespace();
    if (position_ >= text_.size()) {
      throw std::runtime_error("unexpected JSON end");
    }
    const char token = text_[position_];
    if (token == '{') {
      return parseObject();
    }
    if (token == '[') {
      return parseArray();
    }
    if (token == '"') {
      Json out;
      out.kind = Json::Kind::String;
      out.string = parseString();
      return out;
    }
    if (token == 't' || token == 'f') {
      Json out;
      out.kind = Json::Kind::Boolean;
      if (text_.compare(position_, 4, "true") == 0) {
        out.boolean = true;
        position_ += 4;
      } else if (text_.compare(position_, 5, "false") == 0) {
        out.boolean = false;
        position_ += 5;
      } else {
        throw std::runtime_error("invalid JSON boolean");
      }
      return out;
    }
    if (text_.compare(position_, 4, "null") == 0) {
      position_ += 4;
      return {};
    }
    return parseNumber();
  }

  Json parseObject() {
    Json out;
    out.kind = Json::Kind::Object;
    ++position_;
    whitespace();
    if (consume('}')) {
      return out;
    }
    for (;;) {
      whitespace();
      if (position_ >= text_.size() || text_[position_] != '"') {
        throw std::runtime_error("JSON object key expected");
      }
      const std::string key = parseString();
      whitespace();
      require(':');
      if (!out.object.emplace(key, parseValue()).second) {
        throw std::runtime_error("duplicate JSON object key");
      }
      whitespace();
      if (consume('}')) {
        return out;
      }
      require(',');
    }
  }

  Json parseArray() {
    Json out;
    out.kind = Json::Kind::Array;
    ++position_;
    whitespace();
    if (consume(']')) {
      return out;
    }
    for (;;) {
      out.array.push_back(parseValue());
      whitespace();
      if (consume(']')) {
        return out;
      }
      require(',');
    }
  }

  std::string parseString() {
    require('"');
    std::string out;
    while (position_ < text_.size()) {
      const char value = text_[position_++];
      if (value == '"') {
        return out;
      }
      if (value == '\\') {
        if (position_ >= text_.size()) {
          throw std::runtime_error("truncated JSON escape");
        }
        const char escaped = text_[position_++];
        switch (escaped) {
        case '"':
        case '\\':
        case '/':
          out.push_back(escaped);
          break;
        case 'b':
          out.push_back('\b');
          break;
        case 'f':
          out.push_back('\f');
          break;
        case 'n':
          out.push_back('\n');
          break;
        case 'r':
          out.push_back('\r');
          break;
        case 't':
          out.push_back('\t');
          break;
        default:
          throw std::runtime_error("unsupported JSON string escape");
        }
      } else {
        out.push_back(value);
      }
    }
    throw std::runtime_error("unterminated JSON string");
  }

  Json parseNumber() {
    const char *begin = text_.c_str() + position_;
    char *end = nullptr;
    const double number = std::strtod(begin, &end);
    if (end == begin) {
      throw std::runtime_error("invalid JSON number");
    }
    position_ += static_cast<size_t>(end - begin);
    Json out;
    out.kind = Json::Kind::Number;
    out.number = number;
    return out;
  }

  void whitespace() {
    while (position_ < text_.size() &&
           (text_[position_] == ' ' || text_[position_] == '\n' ||
            text_[position_] == '\r' || text_[position_] == '\t')) {
      ++position_;
    }
  }

  bool consume(char expected) {
    if (position_ < text_.size() && text_[position_] == expected) {
      ++position_;
      return true;
    }
    return false;
  }

  void require(char expected) {
    if (!consume(expected)) {
      throw std::runtime_error("unexpected JSON token");
    }
  }

  std::string text_;
  size_t position_{0};
};

/// Reads and parses a fixture, naming the file in any failure — a test that
/// cannot find its fixture must say which one rather than reporting an empty
/// document as a passing comparison.
inline Json readFixture(const std::string &path) {
  std::ifstream stream(path, std::ios::in | std::ios::binary);
  if (!stream) {
    throw std::runtime_error("could not open fixture: " + path);
  }
  const std::string text((std::istreambuf_iterator<char>(stream)),
                         std::istreambuf_iterator<char>());
  if (text.empty()) {
    throw std::runtime_error("fixture is empty: " + path);
  }
  return JsonParser(text).parse();
}

} // namespace singz::testfixture

#endif // SINGZ_TESTS_NATIVE_FIXTURE_JSON_H

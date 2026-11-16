#pragma once
#include <cstdio>
#include <filesystem>
#include <stdexcept>
#include <string>
namespace singz {
enum class FilePathFailure {InvalidPath,ComponentTooLong,TooLong};
class FilePathError: public std::runtime_error {
 public: FilePathError(FilePathFailure code,const std::string &detail):std::runtime_error(detail),code_(code){} FilePathFailure code() const noexcept{return code_;}
 private: FilePathFailure code_;
};
// Control/worker plane only. Resolve and normalise before adding the Windows
// extended namespace; POSIX paths retain their original bytes.
std::wstring windowsFilePath(std::wstring absolute);
std::filesystem::path nativeFilePath(const std::string &utf8);
std::string nativeFilePathUtf8(const std::string &utf8);
int openNativeReadOnly(const std::string &utf8);
std::FILE *openNativeFile(const std::string &utf8,const char *mode);
} // namespace singz

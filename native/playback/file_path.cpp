#include "file_path.h"
#include <algorithm>
#include <cerrno>
#include <cstring>
#include <utility>
#include <vector>
#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <fcntl.h>
#include <io.h>
#else
#include <fcntl.h>
#include <unistd.h>
#endif
namespace singz {
namespace { void requirePath(bool ok,const char *detail,FilePathFailure code=FilePathFailure::InvalidPath) {if(!ok)throw FilePathError(code,detail);} }
std::wstring windowsFilePath(std::wstring full) {
  // Like TS win32.resolve, intentionally preserve trailing dots/spaces in each
  // component. The extended namespace must address the same literal name in both paths.
  std::replace(full.begin(),full.end(),L'/',L'\\');
  const auto units=[](wchar_t c)->size_t {if constexpr(sizeof(wchar_t)>2) return static_cast<uint32_t>(c)>0xffff?2:1;else { (void)c;return 1; }};
  if (full.rfind(L"\\\\?\\UNC\\",0)==0) full=L"\\\\"+full.substr(8);
  else if (full.rfind(L"\\\\?\\",0)==0) full=full.substr(4);
  // Preserve the drive or UNC share root while collapsing dot segments.
  const bool unc=full.rfind(L"\\\\",0)==0;
  size_t rootLength=3;
  if (unc) {
    const auto serverEnd=full.find(L'\\',2);
    requirePath(serverEnd!=std::wstring::npos && serverEnd>2,"Invalid UNC server");
    requirePath(serverEnd+1<full.size() && full[serverEnd+1]!=L'\\',"Invalid UNC share");
    const auto shareEnd=full.find(L'\\',serverEnd+1);
    rootLength=shareEnd==std::wstring::npos?full.size():shareEnd+1;
    requirePath(rootLength>serverEnd+1,"Invalid UNC share");
  } else requirePath(full.size()>=3 && full[1]==L':' && full[2]==L'\\',"Invalid drive path");
  std::wstring root=full.substr(0,rootLength);
  if (root.back()!=L'\\') root+=L'\\';
  std::vector<std::wstring> parts;
  for (size_t begin=rootLength;begin<full.size();) {
    const auto end=full.find(L'\\',begin);const auto part=full.substr(begin,end==std::wstring::npos?std::wstring::npos:end-begin);
    if (part==L"..") {if (!parts.empty()) parts.pop_back();}
    else if (!part.empty() && part!=L".") parts.push_back(part);
    if (end==std::wstring::npos) break;begin=end+1;
  }
  full=root;
  for (const auto &part:parts) {if (full.back()!=L'\\') full+=L'\\';full+=part;}
  size_t component=0;
  for (wchar_t c:full) {
    component=c==L'\\'?0:component+units(c);
    requirePath(component<=255,"File path component exceeds Windows length limit",FilePathFailure::ComponentTooLong);
  }
  const std::wstring extended=full.rfind(L"\\\\",0)==0?L"\\\\?\\UNC\\"+full.substr(2):L"\\\\?\\"+full;
  size_t total=0;for(wchar_t c:extended)total+=units(c);
  requirePath(total<32767,"File path exceeds Windows length limit",FilePathFailure::TooLong);
  return extended;
}
std::filesystem::path nativeFilePath(const std::string &s) {
  requirePath(s.size()<=131068,"File path exceeds UTF-8 length limit",FilePathFailure::TooLong);
  requirePath(!s.empty() && s.find('\0')==std::string::npos,"Invalid conform path");
#if defined(_WIN32)
  std::u8string utf8;utf8.reserve(s.size());for (unsigned char c:s) utf8.push_back(static_cast<char8_t>(c));
  std::wstring ordinary=std::filesystem::path(utf8).native();
  std::replace(ordinary.begin(),ordinary.end(),L'/',L'\\');
  if (ordinary.rfind(L"\\\\?\\UNC\\",0)==0) ordinary=L"\\\\"+ordinary.substr(8);
  else if (ordinary.rfind(L"\\\\?\\",0)==0 && ordinary.size()>6 && ordinary[5]==L':' && ordinary[6]==L'\\') ordinary=ordinary.substr(4);
  requirePath(ordinary.rfind(L"\\\\?\\",0)!=0 && ordinary.rfind(L"\\\\.\\",0)!=0,"Unsupported file device path");
  requirePath(ordinary.size()<32767,"File path exceeds Windows length limit",FilePathFailure::TooLong);
  // Only ask Win32 for a short current-directory/drive root. Resolving a
  // whole unprefixed long path would depend on the host's long-path opt-in.
  std::wstring full=ordinary;
  const bool driveAbsolute=ordinary.size()>=3 && ordinary[1]==L':' && ordinary[2]==L'\\';
  if (!driveAbsolute && ordinary.rfind(L"\\\\",0)!=0) {
    const bool driveRelative=ordinary.size()>=2 && ordinary[1]==L':';
    const bool rooted=!ordinary.empty() && ordinary[0]==L'\\';
    const std::wstring base=driveRelative?ordinary.substr(0,2)+L".":rooted?L"\\":L".";
    const DWORD count=GetFullPathNameW(base.c_str(),0,nullptr,nullptr);
    requirePath(count>0 && count<32767,"Cannot resolve Windows directory");
    std::vector<wchar_t> buffer(count);
    const DWORD length=GetFullPathNameW(base.c_str(),count,buffer.data(),nullptr);
    requirePath(length>0 && length<count,"Cannot resolve Windows directory");
    full.assign(buffer.data(),length);
    if (full.back()!=L'\\') full+=L'\\';
    full+=ordinary.substr(driveRelative?2:rooted?1:0);
  }
  return std::filesystem::path(windowsFilePath(std::move(full)));
#else
  return std::filesystem::path(s);
#endif
}
int openNativeReadOnly(const std::string &path) {
  const auto file=nativeFilePath(path);
#ifdef SINGZ_PATH_NEGATIVE_LEGACY_LIMIT
  if(path.size()>=260) {errno=ENAMETOOLONG;return -1;}
#endif
#if defined(_WIN32)
  return _wopen(file.c_str(),_O_RDONLY|_O_BINARY);
#else
  return ::open(file.c_str(),O_RDONLY|O_CLOEXEC);
#endif
}
std::FILE *openNativeFile(const std::string &path,const char *mode) {
  const auto file=nativeFilePath(path);
#if defined(_WIN32)
  const std::wstring wideMode(mode,mode+std::strlen(mode));
  return _wfopen(file.c_str(),wideMode.c_str());
#else
  return std::fopen(file.c_str(),mode);
#endif
}
std::string nativeFilePathUtf8(const std::string &path) {const auto file=nativeFilePath(path).u8string();return {file.begin(),file.end()};}
} // namespace singz

#include "file_path.h"
#include "lane_measure.h"
#include <zcore/media/wav.h>
#include <zcore/media/decoded_audio.h>
#include <cmath>
#include <cstdio>
#include <vector>
#include <iostream>
#include <chrono>
#if defined(_WIN32)
#include <io.h>
#else
#include <unistd.h>
#endif
void check(bool ok,const char *why){if(!ok)throw std::runtime_error(why);}
int main(){try{
 using namespace singz;
 check(windowsFilePath(LR"(C:\one\..\two.wav)")==LR"(\\?\C:\two.wav)","Windows drive normalization");
 check(windowsFilePath(LR"(\\host\share\one\..\two.wav)")==LR"(\\?\UNC\host\share\two.wav)","UNC namespace normalization");
 std::wstring oversized=L"C:\\";for(int i=0;i<164;++i)oversized+=std::wstring(200,L'p')+L"\\";
 bool tooLong=false;try{windowsFilePath(oversized);}catch(const FilePathError&e){tooLong=e.code()==FilePathFailure::TooLong;}
 check(tooLong,"Only the extended total-length limit should be path-too-long");
 bool badComponent=false;try{windowsFilePath(std::wstring(L"C:\\")+std::wstring(256,L'p'));}catch(const FilePathError&e){badComponent=e.code()==FilePathFailure::ComponentTooLong;}
 check(badComponent,"Invalid components must not be mislabelled as extended-length paths");
 const auto utf8=[](const std::filesystem::path &p){const auto s=p.u8string();return std::string(s.begin(),s.end());};
 const auto ordinary=std::filesystem::temp_directory_path()/("singz-stem-path-"+std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
 const auto root=nativeFilePath(utf8(ordinary));
 struct Cleanup{std::filesystem::path path;~Cleanup(){std::error_code e;std::filesystem::remove_all(path,e);}} cleanup{root};
 const auto deep=root/std::string(100,'a')/std::string(100,'b')/std::string(100,'c');std::filesystem::create_directories(deep);
 const auto file=deep/"vocals.wav";const auto source=utf8(file);
 check(source.size()>300,"Stem fixture directory must exceed 300 characters");
 // Library paths stay ordinary; only IO is namespaced, including core WAV IO.
 WavWriter writer;check(writer.open(nativeFilePathUtf8(source),48000,1),"Long stem WAV writer open");
 std::vector<float> pcm(4800);for(size_t i=0;i<pcm.size();++i)pcm[i]=float(.3*std::sin(i*440*2*3.141592653589793/48000));
 check(writer.append(pcm.data(),pcm.size())&&writer.finalize(),"Long stem fixture write");
 const auto withoutNamespace=[&](){auto p=source;if(p.rfind("\\\\?\\UNC\\",0)==0)return std::string("\\\\")+p.substr(8);if(p.rfind("\\\\?\\",0)==0)return p.substr(4);return p;}();
 // Negative target emulates the legacy Windows MAX_PATH opener on every host.
 const int fd=openNativeReadOnly(withoutNamespace);
 check(fd>=0,"Long stem must open as a descriptor");
 const auto measured=measureLane({"vocals",OwnedFileDescriptor(fd),{1000,1,10000}},{});
 check(measured.ok && measured.frameCount==pcm.size() && measured.rms>.1F,"Long-path lane measure/stream decoder must succeed");
 const auto decoded=prepareDecodedAudio(OwnedFileDescriptor(openNativeReadOnly(withoutNamespace)),{});
 check(decoded.ok(),"Long-path session decoder must succeed");
#if defined(_WIN32)
 check(nativeFilePath(withoutNamespace).native().rfind(L"\\\\?\\",0)==0,"Native IO must add namespace without registry opt-in");
 // The historical opener is probed as evidence; the forced negative target is
 // mandatory even on hosts whose manifest/registry opt-ins make this work.
 auto *legacy=std::fopen(withoutNamespace.c_str(),"rb");std::cout<<"legacy narrow long-path open: "<<(legacy?"host opted in":"refused")<<'\n';if(legacy)std::fclose(legacy);
#endif
 std::cout<<"300-character stem path measure/decode: ok\n";return 0;
}catch(const std::exception &e){std::cerr<<e.what()<<'\n';return 1;}}

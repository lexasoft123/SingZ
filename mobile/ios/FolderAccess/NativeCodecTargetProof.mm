#import "NativeCodecTargetProof.h"

#if defined(SINGZ_CODEC_TARGET_PROOF)

#import <CommonCrypto/CommonDigest.h>
#import <TargetConditionals.h>
#import <UIKit/UIKit.h>

#include <dlfcn.h>

#include <array>
#include <string>
#include <vector>

#include "CodecTargetProof/target_codec_proof.h"

extern "C" {
unsigned avcodec_version(void);
unsigned avformat_version(void);
unsigned avutil_version(void);
unsigned swresample_version(void);
}

namespace {

NSArray<NSString*>* fixtureNames() {
  return @[
    @"tone.mp3", @"tone.aac", @"tone-aac.m4a", @"tone-alac.m4a",
    @"tone.ogg", @"tone.opus", @"tone.aiff", @"tone.aifc",
    @"audio-plus-video.m4a", @"video-only.m4a",
    @"unsupported-flac.ogg", @"cancel-long.mp3"
  ];
}

NSString* sha256Data(NSData* data) {
  unsigned char digest[CC_SHA256_DIGEST_LENGTH]{};
  CC_SHA256(data.bytes, static_cast<CC_LONG>(data.length), digest);
  NSMutableString* result =
      [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
  for (unsigned char byte : digest) [result appendFormat:@"%02x", byte];
  return result;
}

NSDictionary* fileEvidence(NSString* path) {
  NSData* data = [NSData dataWithContentsOfFile:path options:NSDataReadingMappedIfSafe
                                         error:nil];
  if (data == nil) return nil;
  return @{
    @"path": path,
    @"bytes": @(data.length),
    @"sha256": sha256Data(data),
  };
}

NSString* imagePath(const void* symbol) {
  Dl_info info{};
  if (symbol == nullptr || dladdr(symbol, &info) == 0 || info.dli_fname == nullptr)
    return nil;
  return [NSString stringWithUTF8String:info.dli_fname];
}

NSDictionary* runtimeEvidence(NSString* component, const void* symbol) {
  NSString* path = imagePath(symbol);
  NSDictionary* file = path == nil ? nil : fileEvidence(path);
  if (file == nil) return nil;
  return @{
    @"component": component,
    @"path": file[@"path"],
    @"bytes": file[@"bytes"],
    @"sha256": file[@"sha256"],
  };
}

NSString* proofTarget() {
#if TARGET_OS_SIMULATOR
#if defined(__arm64__)
  return @"ios-simulator-arm64";
#elif defined(__x86_64__)
  return @"ios-simulator-x64";
#else
  return @"unsupported-ios-simulator";
#endif
#else
#if defined(__arm64__)
  return @"ios-arm64";
#else
  return @"unsupported-ios-device";
#endif
#endif
}

NSString* proofArchitecture() {
#if defined(__arm64__)
  return @"arm64";
#elif defined(__x86_64__)
  return @"x86_64";
#else
  return @"unsupported";
#endif
}

NSString* findBundledFile(NSString* bundleName, NSString* name,
                          NSString* extension) {
  NSString* bundlePath = [[NSBundle mainBundle] pathForResource:bundleName
                                                         ofType:@"bundle"];
  NSBundle* bundle = bundlePath == nil ? nil : [NSBundle bundleWithPath:bundlePath];
  return [bundle pathForResource:name ofType:extension];
}

NSError* proofError(NSString* message) {
  return [NSError errorWithDomain:@"SingzCodecTargetProof" code:1
                         userInfo:@{NSLocalizedDescriptionKey: message}];
}

}  // namespace

#endif

void SingzRunCodecTargetProof(RCTPromiseResolveBlock resolve,
                              RCTPromiseRejectBlock reject) {
#if !defined(SINGZ_CODEC_TARGET_PROOF)
  reject(@"E_CODEC_TARGET_PROOF_DISABLED",
         @"Codec target proof was not compiled into this build", nil);
#else
  @autoreleasepool {
    NSMutableArray<NSString*>* paths = [NSMutableArray arrayWithCapacity:12];
    NSMutableArray<NSDictionary*>* fixtures = [NSMutableArray arrayWithCapacity:12];
    for (NSString* name in fixtureNames()) {
      NSString* extension = name.pathExtension;
      NSString* stem = [name stringByDeletingPathExtension];
      NSString* path = findBundledFile(@"SingzCodecTargetFixtures", stem, extension);
      NSDictionary* evidence = path == nil ? nil : fileEvidence(path);
      if (evidence == nil) {
        reject(@"E_CODEC_TARGET_PROOF_FIXTURE",
               [NSString stringWithFormat:@"Missing packaged codec fixture %@", name],
               proofError(@"Missing codec target fixture"));
        return;
      }
      [paths addObject:path];
      [fixtures addObject:@{
        @"name": name,
        @"bytes": evidence[@"bytes"],
        @"sha256": evidence[@"sha256"],
      }];
    }

    std::vector<std::string> nativePaths;
    nativePaths.reserve(paths.count);
    for (NSString* path in paths) nativePaths.emplace_back(path.UTF8String);
    const std::string nativeText = singz::codec_target_proof::run(nativePaths);
    NSString* nativeOutput = [NSString stringWithUTF8String:nativeText.c_str()];
    NSData* nativeData = [nativeOutput dataUsingEncoding:NSUTF8StringEncoding];
    NSDictionary* nativeJson = [NSJSONSerialization JSONObjectWithData:nativeData
                                                                options:0 error:nil];
    if (![nativeJson[@"result"] isEqual:@"full dynamic matrix ok"] ||
        ![nativeJson[@"execution"] isEqual:@"actual-packaged-zcore-runtime"]) {
      reject(@"E_CODEC_TARGET_PROOF_NATIVE", nativeOutput,
             proofError(@"Packaged zcore codec matrix failed"));
      return;
    }

    const std::array<std::pair<NSString*, const void*>, 4> symbols{{
      {@"avcodec", reinterpret_cast<const void*>(&avcodec_version)},
      {@"avformat", reinterpret_cast<const void*>(&avformat_version)},
      {@"avutil", reinterpret_cast<const void*>(&avutil_version)},
      {@"swresample", reinterpret_cast<const void*>(&swresample_version)},
    }};
    NSMutableArray<NSDictionary*>* libraries = [NSMutableArray arrayWithCapacity:4];
    for (const auto& [component, symbol] : symbols) {
      NSDictionary* evidence = runtimeEvidence(component, symbol);
      if (evidence == nil) {
        reject(@"E_CODEC_TARGET_PROOF_RUNTIME",
               [NSString stringWithFormat:@"Could not hash loaded %@ runtime", component],
               proofError(@"Loaded FFmpeg runtime is unavailable"));
        return;
      }
      [libraries addObject:evidence];
    }

    NSString* selectionPath = findBundledFile(
        @"SingzCoreFfmpegNotices", @"singz-ffmpeg-selection", @"json");
    NSDictionary* selectionFile =
        selectionPath == nil ? nil : fileEvidence(selectionPath);
    NSData* selectionData = selectionPath == nil
        ? nil
        : [NSData dataWithContentsOfFile:selectionPath];
    if (selectionFile == nil || selectionData == nil) {
      reject(@"E_CODEC_TARGET_PROOF_SELECTION",
             @"The packaged FFmpeg selection receipt is missing",
             proofError(@"FFmpeg selection receipt is not packaged"));
      return;
    }

    NSString* executable = NSBundle.mainBundle.executablePath;
    NSDictionary* binaryFile = executable == nil ? nil : fileEvidence(executable);
    NSDictionary* info = NSBundle.mainBundle.infoDictionary;
    if (binaryFile == nil) {
      reject(@"E_CODEC_TARGET_PROOF_BINARY", @"Could not hash the app executable",
             proofError(@"App executable is unavailable"));
      return;
    }
    NSString* configuration = nativeJson[@"runtimeConfiguration"];
    NSData* configurationData = [configuration dataUsingEncoding:NSUTF8StringEncoding];
    NSString* binaryId = [NSString stringWithFormat:@"%@:%@:%@:%@",
        NSBundle.mainBundle.bundleIdentifier ?: @"unknown",
        info[@"CFBundleShortVersionString"] ?: @"unknown",
        info[@"CFBundleVersion"] ?: @"unknown",
        proofArchitecture()];
    NSString* selectionJson =
        [[NSString alloc] initWithData:selectionData encoding:NSUTF8StringEncoding];
    NSDictionary* evidence = @{
      @"format": @1,
      @"executionMode": @"actual-packaged-runtime",
      @"platform": @"ios",
      @"target": proofTarget(),
      @"architecture": proofArchitecture(),
      @"osVersion": UIDevice.currentDevice.systemVersion,
      @"result": @"full dynamic matrix ok",
      @"nativeOutput": nativeOutput,
      @"outputSha256": sha256Data(nativeData),
      @"configurationSha256": sha256Data(configurationData),
      @"runtimeLibraries": libraries,
      @"binary": @{
        @"id": binaryId,
        @"path": binaryFile[@"path"],
        @"bytes": binaryFile[@"bytes"],
        @"sha256": binaryFile[@"sha256"],
      },
      @"selectionReceipt": @{
        @"path": @"SingzCoreFfmpegNotices.bundle/singz-ffmpeg-selection.json",
        @"bytes": selectionFile[@"bytes"],
        @"sha256": selectionFile[@"sha256"],
        @"json": selectionJson,
      },
      @"fixtures": fixtures,
    };
    NSData* encoded = [NSJSONSerialization dataWithJSONObject:evidence
        options:(NSJSONWritingPrettyPrinted | NSJSONWritingSortedKeys) error:nil];
    resolve([[NSString alloc] initWithData:encoded encoding:NSUTF8StringEncoding]);
  }
#endif
}

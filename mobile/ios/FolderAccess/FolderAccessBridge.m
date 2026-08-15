#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE (FolderAccess, NSObject)

RCT_EXTERN_METHOD(pickFolder : (RCTPromiseResolveBlock)resolve
                  reject : (RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(getRoot : (RCTPromiseResolveBlock)resolve
                  reject : (RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(clearRoot : (RCTPromiseResolveBlock)resolve
                  reject : (RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(listProjects : (RCTPromiseResolveBlock)resolve
                  reject : (RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(readText : (NSString *)project
                  file : (NSString *)file
                  resolve : (RCTPromiseResolveBlock)resolve
                  reject : (RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(localFile : (NSString *)project
                  file : (NSString *)file
                  resolve : (RCTPromiseResolveBlock)resolve
                  reject : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(cacheUsage : (RCTPromiseResolveBlock)resolve
                  rejecter : (RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(clearCache : (NSString *)project
                  resolver : (RCTPromiseResolveBlock)resolve
                  rejecter : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(oauthStart : (RCTPromiseResolveBlock)resolve
                  rejecter : (RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(oauthWait : (RCTPromiseResolveBlock)resolve
                  rejecter : (RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(oauthPresent : (NSString *)url
                  resolver : (RCTPromiseResolveBlock)resolve
                  rejecter : (RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(fetchToCache : (NSString *)project
                  file : (NSString *)file
                  url : (NSString *)url
                  auth : (NSString *)auth
                  expectedMd5 : (NSString *)expectedMd5
                  expectedBytes : (nonnull NSNumber *)expectedBytes
                  resolver : (RCTPromiseResolveBlock)resolve
                  rejecter : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(pickAudioFile : (RCTPromiseResolveBlock)resolve
                  rejecter : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(ensureProjectDir : (NSString *)name
                  resolver : (RCTPromiseResolveBlock)resolve
                  rejecter : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(writeText : (NSString *)project
                  file : (NSString *)file
                  text : (NSString *)text
                  resolver : (RCTPromiseResolveBlock)resolve
                  rejecter : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(moveIntoProject : (NSString *)project
                  relPath : (NSString *)relPath
                  srcPath : (NSString *)srcPath
                  resolver : (RCTPromiseResolveBlock)resolve
                  rejecter : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(copyIntoProject : (NSString *)project
                  relPath : (NSString *)relPath
                  srcPath : (NSString *)srcPath
                  resolver : (RCTPromiseResolveBlock)resolve
                  rejecter : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(statFile : (NSString *)project
                  relPath : (NSString *)relPath
                  resolver : (RCTPromiseResolveBlock)resolve
                  rejecter : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(deleteProject : (NSString *)project
                  resolver : (RCTPromiseResolveBlock)resolve
                  rejecter : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(readMediaTags : (NSString *)path
                  resolver : (RCTPromiseResolveBlock)resolve
                  rejecter : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(deleteFile : (NSString *)project
                  relPath : (NSString *)relPath
                  resolver : (RCTPromiseResolveBlock)resolve
                  rejecter : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(downloadProgress : (RCTPromiseResolveBlock)resolve
                  rejecter : (RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(downloadFile : (NSString *)name
                  url : (NSString *)url
                  expectedSha256 : (NSString *)expectedSha256
                  expectedBytes : (nonnull NSNumber *)expectedBytes
                  resolver : (RCTPromiseResolveBlock)resolve
                  rejecter : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(cancelDownload : (RCTPromiseResolveBlock)resolve
                  rejecter : (RCTPromiseRejectBlock)reject)

@end

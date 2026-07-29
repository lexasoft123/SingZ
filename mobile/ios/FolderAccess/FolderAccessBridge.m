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
                  expectedBytes : (nonnull NSNumber *)expectedBytes
                  resolver : (RCTPromiseResolveBlock)resolve
                  rejecter : (RCTPromiseRejectBlock)reject)

@end

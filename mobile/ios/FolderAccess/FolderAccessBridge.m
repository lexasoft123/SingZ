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

@end

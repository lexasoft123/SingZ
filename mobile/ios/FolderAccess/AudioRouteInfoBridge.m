#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE (AudioRouteInfo, NSObject)

RCT_EXTERN_METHOD(getOutput : (RCTPromiseResolveBlock)resolve
                  reject : (RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(getPref : (NSString *)key
                  resolve : (RCTPromiseResolveBlock)resolve
                  reject : (RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(setPref : (NSString *)key
                  value : (double)value
                  resolve : (RCTPromiseResolveBlock)resolve
                  reject : (RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(getTextPref : (NSString *)key
                  resolve : (RCTPromiseResolveBlock)resolve
                  reject : (RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(setTextPref : (NSString *)key
                  value : (NSString *)value
                  resolve : (RCTPromiseResolveBlock)resolve
                  reject : (RCTPromiseRejectBlock)reject)

@end

#include "rutracker_scripts.h"
#import <React/RCTBridgeModule.h>
#import <UIKit/UIKit.h>
#import <WebKit/WebKit.h>
#include <torrent_engine.h>

static NSError *SZError(NSString *text) {
  return [NSError errorWithDomain:@"SingzTorrent"
                             code:1
                         userInfo:@{NSLocalizedDescriptionKey : text}];
}
static NSString *SZFailure(NSString *text) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:@{
    @"ok" : @NO,
    @"error" : text ?: @"Torrent operation failed"
  }
                                                 options:0
                                                   error:nil];
  return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
}
static NSString *SZCore(NSString *root, NSString *op, NSString *release,
                        NSInteger index, NSData *bytes) {
  char *output = singz_torrent_call(
      root.UTF8String, op.UTF8String, (release ?: @"").UTF8String, (int)index,
      static_cast<unsigned char const *>(bytes.bytes), bytes.length);
  NSString *result = output ? [NSString stringWithUTF8String:output]
                            : SZFailure(@"Torrent engine ran out of memory");
  singz_torrent_free(output);
  return result ?: SZFailure(@"Invalid torrent engine response");
}
// Use the document picker's import ownership and cancellation cleanup.
static NSString *SZConsume(NSString *root) {
  NSFileManager *fm = NSFileManager.defaultManager;
  NSDictionary *status = [NSJSONSerialization
      JSONObjectWithData:[SZCore(root, @"status", @"", -1, nil)
                             dataUsingEncoding:NSUTF8StringEncoding]
                 options:0
                   error:nil];
  NSDictionary *job = status[@"data"];
  if (![job isKindOfClass:NSDictionary.class] ||
      ![job[@"state"] isEqual:@"complete"])
    return SZFailure(@"The song has not finished downloading");
  NSURL *source = [NSURL fileURLWithPath:job[@"path"]];
  NSURL *support = [fm URLsForDirectory:NSApplicationSupportDirectory
                              inDomains:NSUserDomainMask]
                       .firstObject;
  NSURL *dir = [[support URLByAppendingPathComponent:@"singz-projects/imports"
                                         isDirectory:YES]
      URLByAppendingPathComponent:NSUUID.UUID.UUIDString
                      isDirectory:YES];
  NSURL *destination =
      [dir URLByAppendingPathComponent:source.lastPathComponent];
  NSError *error = nil;
  if (![fm createDirectoryAtURL:dir
          withIntermediateDirectories:YES
                           attributes:nil
                                error:&error] ||
      ![fm copyItemAtURL:source toURL:destination error:&error]) {
    [fm removeItemAtURL:dir error:nil];
    return SZFailure(@"Could not prepare the downloaded song. Check free "
                     @"storage and try again.");
  }
  [dir setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey error:nil];
  NSMutableDictionary *result = [[NSJSONSerialization
      JSONObjectWithData:[SZCore(root, @"consume", @"", -1, nil)
                             dataUsingEncoding:NSUTF8StringEncoding]
                 options:NSJSONReadingMutableContainers
                   error:nil] mutableCopy];
  if (![result[@"ok"] boolValue]) {
    [fm removeItemAtURL:dir error:nil];
    return SZFailure(@"Could not prepare the downloaded song. Try again.");
  }
  result[@"data"][@"path"] = destination.path;
  [fm removeItemAtURL:source error:nil];
  [fm removeItemAtURL:source.URLByDeletingLastPathComponent error:nil];
  NSData *data = [NSJSONSerialization dataWithJSONObject:result
                                                 options:0
                                                   error:nil];
  return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
}
typedef void (^SZCompletion)(id, NSError *);
@interface SZTorrentSite : NSObject <WKNavigationDelegate, WKUIDelegate,
                                     UIAdaptivePresentationControllerDelegate>
@property(nonatomic, strong) WKWebView *web;
@property(nonatomic, copy) SZCompletion pending;
@property(nonatomic, copy) NSString *script;
@property(nonatomic, copy) void (^auth)(BOOL);
@property(nonatomic, strong) UINavigationController *browser;
@property(nonatomic) NSUInteger sequence;
- (void)page:(NSString *)url
        script:(NSString *)script
    completion:(SZCompletion)completion;
- (void)connect:(void (^)(BOOL))completion;
- (void)metadata:(NSString *)topic completion:(SZCompletion)completion;
@end
@implementation SZTorrentSite
- (instancetype)init {
  if ((self = [super init])) {
    WKWebViewConfiguration *config = [WKWebViewConfiguration new];
    config.websiteDataStore = WKWebsiteDataStore.defaultDataStore;
    _web = [[WKWebView alloc] initWithFrame:CGRectMake(0, 0, 800, 700)
                              configuration:config];
    _web.navigationDelegate = self;
    _web.UIDelegate = self;
  }
  return self;
}
- (void)finish:(id)value error:(NSError *)error {
  SZCompletion callback = self.pending;
  self.pending = nil;
  self.script = nil;
  ++self.sequence;
  if (callback)
    callback(value, error);
}
- (void)page:(NSString *)url
        script:(NSString *)script
    completion:(SZCompletion)completion {
  if (self.pending || self.auth) {
    completion(nil, SZError(@"Another RuTracker request is in progress"));
    return;
  }
  self.pending = completion;
  self.script = script;
  NSUInteger ticket = ++self.sequence;
  [self.web
      loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:url]]];
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 40 * NSEC_PER_SEC),
                 dispatch_get_main_queue(), ^{
                   if (ticket == self.sequence && self.pending) {
                     [self.web stopLoading];
                     [self finish:nil
                            error:SZError(@"Could not reach RuTracker. Check "
                                          @"your connection and try again.")];
                   }
                 });
}
- (void)webView:(WKWebView *)web
    requestMediaCapturePermissionForOrigin:(WKSecurityOrigin *)origin
                          initiatedByFrame:(WKFrameInfo *)frame
                                      type:(WKMediaCaptureType)type
                           decisionHandler:
                               (void (^)(WKPermissionDecision))decision {
  decision(WKPermissionDecisionDeny);
}
- (void)navigationFailed:(NSError *)error {
  if (error.code == NSURLErrorCancelled)
    return;
  if (self.auth) {
    [self cancelAuth];
    return;
  }
  [self finish:nil
         error:SZError(@"Could not load RuTracker. Check your connection and "
                       @"try again.")];
}
- (void)webView:(WKWebView *)web
    didFailNavigation:(WKNavigation *)navigation
            withError:(NSError *)error {
  [self navigationFailed:error];
}
- (void)webView:(WKWebView *)web
    didFailProvisionalNavigation:(WKNavigation *)navigation
                       withError:(NSError *)error {
  [self navigationFailed:error];
}
- (void)webView:(WKWebView *)web
    decidePolicyForNavigationAction:(WKNavigationAction *)action
                    decisionHandler:
                        (void (^)(WKNavigationActionPolicy))decision {
  NSURL *url = action.request.URL;
  BOOL trusted = [url.scheme isEqualToString:@"https"] &&
                 [url.host isEqualToString:@"rutracker.org"] &&
                 (!url.port || url.port.integerValue == 443);
  decision(trusted ? WKNavigationActionPolicyAllow
                   : WKNavigationActionPolicyCancel);
}
- (void)webView:(WKWebView *)web
    didFinishNavigation:(WKNavigation *)navigation {
  if (self.auth) {
    [web evaluateJavaScript:@(sz_account_script)
          completionHandler:^(id result, NSError *error) {
            if ([result isEqual:@YES])
              [self completeAuth:YES];
          }];
  } else if (self.pending) {
    NSString *script = self.script;
    [web evaluateJavaScript:script
          completionHandler:^(id result, NSError *error) {
            [self finish:result error:error];
          }];
  }
}
- (UIViewController *)presenter {
  for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
    if (scene.activationState != UISceneActivationStateForegroundActive ||
        ![scene isKindOfClass:UIWindowScene.class])
      continue;
    for (UIWindow *window in ((UIWindowScene *)scene).windows)
      if (window.isKeyWindow) {
        UIViewController *presenter = window.rootViewController;
        while (presenter.presentedViewController)
          presenter = presenter.presentedViewController;
        return presenter;
      }
  }
  return nil;
}
- (void)connect:(void (^)(BOOL))completion {
  if (self.pending || self.auth) {
    completion(NO);
    return;
  }
  UIViewController *presenter = [self presenter];
  if (!presenter) {
    completion(NO);
    return;
  }
  self.auth = completion;
  UIViewController *content = [UIViewController new];
  content.title = @"Sign in to RuTracker";
  content.navigationItem.leftBarButtonItem = [[UIBarButtonItem alloc]
      initWithBarButtonSystemItem:UIBarButtonSystemItemCancel
                           target:self
                           action:@selector(cancelAuth)];
  self.web.frame = content.view.bounds;
  self.web.autoresizingMask =
      UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
  [content.view addSubview:self.web];
  self.browser =
      [[UINavigationController alloc] initWithRootViewController:content];
  [presenter
      presentViewController:self.browser
                   animated:YES
                 completion:^{
                   self.browser.presentationController.delegate = self;
                   [self.web
                       loadRequest:[NSURLRequest
                                       requestWithURL:
                                           [NSURL URLWithString:
                                                      @"https://rutracker.org/"
                                                      @"forum/login.php"]]];
                 }];
}
- (void)completeAuth:(BOOL)connected {
  void (^callback)(BOOL) = self.auth;
  self.auth = nil;
  if (!callback)
    return;
  [self.browser dismissViewControllerAnimated:YES
                                   completion:^{
                                     [self.web removeFromSuperview];
                                     self.browser = nil;
                                     callback(connected);
                                   }];
}
- (void)cancelAuth {
  [self completeAuth:NO];
}
- (void)presentationControllerDidDismiss:
    (UIPresentationController *)controller {
  void (^callback)(BOOL) = self.auth;
  self.auth = nil;
  [self.web removeFromSuperview];
  self.browser = nil;
  if (callback)
    callback(NO);
}
- (void)metadata:(NSString *)topic completion:(SZCompletion)completion {
  // Authenticate the browser context before a same-origin bounded fetch.
  [self page:@"https://rutracker.org/forum/index.php"
          script:@(sz_account_script)
      completion:^(id connected, NSError *error) {
        if (error || ![connected isEqual:@YES]) {
          completion(nil, error
                              ?: SZError(@"Your RuTracker session has expired. "
                                         @"Sign in again."));
          return;
        }
        [self.web callAsyncJavaScript:@(sz_metadata_script)
                            arguments:@{@"topic" : topic}
                              inFrame:nil
                       inContentWorld:WKContentWorld.pageWorld
                    completionHandler:completion];
      }];
}
@end

@interface SingzTorrent : NSObject <RCTBridgeModule>
@property(nonatomic, strong) SZTorrentSite *site;
@property(nonatomic, copy) NSString *root;
@end
@implementation SingzTorrent
RCT_EXPORT_MODULE(SingzTorrent)
+ (BOOL)requiresMainQueueSetup {
  return YES;
}
- (instancetype)init {
  if ((self = [super init])) {
    _site = [SZTorrentSite new];
    NSURL *root = [NSFileManager.defaultManager
                      URLsForDirectory:NSApplicationSupportDirectory
                             inDomains:NSUserDomainMask]
                      .firstObject;
    root = [root URLByAppendingPathComponent:@"torrent-downloads"
                                 isDirectory:YES];
    [NSFileManager.defaultManager createDirectoryAtURL:root
                           withIntermediateDirectories:YES
                                            attributes:nil
                                                 error:nil];
    [root setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey error:nil];
    _root = root.path;
    [NSNotificationCenter.defaultCenter
        addObserver:self
           selector:@selector(background)
               name:UIApplicationDidEnterBackgroundNotification
             object:nil];
  }
  return self;
}
- (void)background {
  NSString *root = self.root;
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    SZCore(root, @"pause", @"", -1, nil);
  });
}
- (void)dealloc {
  [NSNotificationCenter.defaultCenter removeObserver:self];
  singz_torrent_shutdown(_root.UTF8String);
}
RCT_EXPORT_METHOD(request : (NSString *)input resolver : (
    RCTPromiseResolveBlock)resolve rejecter : (RCTPromiseRejectBlock)reject) {
  if (![input isKindOfClass:NSString.class] || input.length > 8192) {
    resolve(SZFailure(@"Invalid torrent request"));
    return;
  }
  NSDictionary *request = [NSJSONSerialization
      JSONObjectWithData:[input dataUsingEncoding:NSUTF8StringEncoding]
                 options:0
                   error:nil];
  if (![request isKindOfClass:NSDictionary.class]) {
    resolve(SZFailure(@"Invalid torrent request"));
    return;
  }
  NSString *op =
      [request[@"op"] isKindOfClass:NSString.class] ? request[@"op"] : @"";
  if ([input length] > 8192) {
    resolve(SZFailure(@"Torrent request is too large"));
    return;
  }
  if ([@[
        @"status", @"start", @"pause", @"resume", @"cancel", @"consume",
        @"capabilities"
      ] containsObject:op]) {
    NSString *release = [request[@"release"] isKindOfClass:NSString.class]
                            ? request[@"release"]
                            : @"";
    NSInteger index =
        [request[@"index"] respondsToSelector:@selector(integerValue)]
            ? [request[@"index"] integerValue]
            : -1;
    NSString *root = self.root;
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
      resolve([op isEqual:@"consume"] ? SZConsume(root)
                                      : SZCore(root, op, release, index, nil));
    });
    return;
  }
  dispatch_async(dispatch_get_main_queue(), ^{
    if ([op isEqual:@"connect"]) {
      [self.site connect:^(BOOL connected) {
        resolve(connected ? @"{\"ok\":true,\"data\":{\"connected\":true}}"
                          : @"{\"ok\":true,\"data\":{\"connected\":false}}");
      }];
      return;
    }
    if ([op isEqual:@"logout"]) {
      WKHTTPCookieStore *store =
          self.site.web.configuration.websiteDataStore.httpCookieStore;
      [store getAllCookies:^(NSArray<NSHTTPCookie *> *cookies) {
        dispatch_group_t group = dispatch_group_create();
        for (NSHTTPCookie *cookie in cookies)
          if ([cookie.domain isEqual:@"rutracker.org"] ||
              [cookie.domain hasSuffix:@".rutracker.org"]) {
            dispatch_group_enter(group);
            [store deleteCookie:cookie
                completionHandler:^{
                  dispatch_group_leave(group);
                }];
          }
        dispatch_group_notify(group, dispatch_get_main_queue(), ^{
          resolve(@"{\"ok\":true,\"data\":{\"connected\":false}}");
        });
      }];
      return;
    }
    if ([op isEqual:@"account"]) {
      [self.site.web.configuration.websiteDataStore.httpCookieStore
          getAllCookies:^(NSArray<NSHTTPCookie *> *cookies) {
            BOOL connected = NO;
            for (NSHTTPCookie *cookie in cookies)
              if ([cookie.name isEqual:@"bb_data"] && cookie.value.length > 0 &&
                  ([cookie.domain isEqual:@"rutracker.org"] ||
                   [cookie.domain hasSuffix:@".rutracker.org"])) {
                connected = YES;
                break;
              }
            resolve(connected
                        ? @"{\"ok\":true,\"data\":{\"connected\":true}}"
                        : @"{\"ok\":true,\"data\":{\"connected\":false}}");
          }];
      return;
    }
    if ([op isEqual:@"search"]) {
      NSString *url = [request[@"url"] isKindOfClass:NSString.class]
                          ? request[@"url"]
                          : @"";
      NSURL *parsed = [NSURL URLWithString:url];
      if (![parsed.scheme isEqual:@"https"] ||
          ![parsed.host isEqual:@"rutracker.org"] ||
          ![parsed.path isEqual:@"/forum/tracker.php"]) {
        resolve(SZFailure(@"Invalid RuTracker search"));
        return;
      }
      [self.site page:url
               script:@(sz_search_script)
           completion:^(id value, NSError *error) {
             resolve(error ? SZFailure(error.localizedDescription) : value);
           }];
      return;
    }
    if ([op isEqual:@"files"]) {
      NSString *release = [request[@"release"] isKindOfClass:NSString.class]
                              ? request[@"release"]
                              : @"";
      if ([release rangeOfString:@"^[1-9][0-9]{0,11}$"
                         options:NSRegularExpressionSearch]
              .location == NSNotFound) {
        resolve(SZFailure(@"Invalid RuTracker release"));
        return;
      }
      [self.site
            metadata:release
          completion:^(id value, NSError *error) {
            NSData *bytes =
                [value isKindOfClass:NSString.class]
                    ? [[NSData alloc] initWithBase64EncodedString:value
                                                          options:0]
                    : nil;
            if (error || !bytes || bytes.length > 16 * 1024 * 1024) {
              resolve(SZFailure(error.localizedDescription
                                    ?: @"Invalid torrent metadata"));
              return;
            }
            NSString *root = self.root;
            dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
              resolve(SZCore(root, @"inspect", release, -1, bytes));
            });
          }];
      return;
    }
    resolve(SZFailure(@"Unknown torrent command"));
  });
}
@end

#pragma once
#import <Foundation/Foundation.h>

// Use the current cookie and retain compatibility with older sessions. Never
// mistake Cloudflare clearance or tracking cookies for a RuTracker login.
static inline BOOL SZTorrentHasSession(NSArray<NSHTTPCookie *> *cookies) {
  for (NSHTTPCookie *cookie in cookies) {
    NSString *domain = cookie.domain.lowercaseString;
    BOOL host = [domain isEqualToString:@"rutracker.org"] ||
                [domain isEqualToString:@".rutracker.org"];
    BOOL path = [@[ @"/", @"/forum", @"/forum/" ] containsObject:cookie.path];
    BOOL current =
        !cookie.expiresDate || [cookie.expiresDate timeIntervalSinceNow] > 0;
    if (host && path && current && cookie.value.length > 0 &&
        ([cookie.name isEqualToString:@"bb_session"] ||
         [cookie.name isEqualToString:@"bb_data"]))
      return YES;
  }
  return NO;
}

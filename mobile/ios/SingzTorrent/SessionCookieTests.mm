#import "SessionCookie.h"
#include <cstdio>

static NSHTTPCookie *cookie(NSString *name, NSString *value,
                            NSString *domain = @".rutracker.org",
                            NSString *path = @"/", NSDate *expiry = nil) {
  NSMutableDictionary *properties = [@{
    NSHTTPCookieName : name,
    NSHTTPCookieValue : value,
    NSHTTPCookieDomain : domain,
    NSHTTPCookiePath : path,
    NSHTTPCookieSecure : @"TRUE"
  } mutableCopy];
  if (expiry)
    properties[NSHTTPCookieExpires] = expiry;
  return [NSHTTPCookie cookieWithProperties:properties];
}
int main() {
  @autoreleasepool {
    NSArray *positive = @[
      @[ cookie(@"bb_session", @"fixture-current") ],
      @[ cookie(@"bb_data", @"fixture-legacy") ],
      @[ cookie(@"bb_session", @"fixture", @"rutracker.org", @"/forum/") ],
      @[ cookie(@"bb_session", @"fixture", @"rutracker.org", @"/forum") ]
    ];
    NSArray *negative = @[
      @[], @[ cookie(@"bb_session", @"") ],
      @[ cookie(@"cf_clearance", @"fixture"), cookie(@"bb_guid", @"fixture") ],
      @[ cookie(@"bb_session", @"fixture", @"evil.test") ],
      @[ cookie(@"bb_session", @"fixture", @"evil.rutracker.org") ],
      @[ cookie(@"bb_session", @"fixture", @"rutracker.org",
                @"/forum/private") ],
      @[ cookie(@"bb_session", @"fixture", @"rutracker.org", @"/",
                [NSDate dateWithTimeIntervalSinceNow:-3600]) ]
    ];
    for (NSArray *cookies in positive)
      if (!SZTorrentHasSession(cookies))
        return 1;
    for (NSArray *cookies in negative)
      if (SZTorrentHasSession(cookies))
        return 1;
    std::puts("PASS: current and legacy sessions, empty/expired cookies, "
              "domain/path scope and clearance-only checks");
  }
}

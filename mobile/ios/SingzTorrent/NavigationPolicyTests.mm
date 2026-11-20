#import "NavigationPolicy.h"
#include <cstdio>
int main() {
  @autoreleasepool {
    struct Case {
      const char *url;
      bool target;
      bool main;
      bool allowed;
    };
    Case cases[] = {
        {"https://rutracker.org/forum/login.php", true, true, true},
        {"https://rutracker.org/cdn-cgi/challenge-platform/", true, false,
         true},
        {"https://challenges.cloudflare.com/turnstile/v0/api.js", true, false,
         true},
        {"https://challenges.cloudflare.com:443/frame", true, false, true},
        {"about:blank", true, false, true},
        {"about:srcdoc", true, false, true},
        {"https://challenges.cloudflare.com/frame", true, true, false},
        {"https://challenges.cloudflare.com/frame", false, false, false},
        {"https://rutracker.org/forum/login.php", false, false, false},
        {"http://challenges.cloudflare.com/frame", true, false, false},
        {"https://challenges.cloudflare.com:8443/frame", true, false, false},
        {"https://challenges.cloudflare.com.evil.test/frame", true, false,
         false},
        {"https://rutracker.org.evil.test/", true, true, false},
        {"https://evil.test/", true, false, false},
        {"about:blank", true, true, false},
        {"about:srcdoc", true, true, false},
        {"file:///etc/passwd", true, false, false},
        {"javascript:alert(1)", true, false, false}};
    for (auto c : cases) {
      BOOL got = SZTorrentNavigationAllowed([NSURL URLWithString:@(c.url)],
                                            c.target, c.main);
      if (got != c.allowed) {
        std::fprintf(stderr, "FAIL: %s\n", c.url);
        return 1;
      }
    }
    if (SZTorrentNavigationAllowed(nil, YES, NO))
      return 1;
    std::puts("PASS: 19 navigation cases, Cloudflare frames allowed; "
              "top-level, popup and untrusted URLs blocked");
  }
}

#pragma once
#import <Foundation/Foundation.h>

// Cloudflare embeds its challenge in a cross-origin frame. Only these
// supporting frames may leave the RuTracker origin; top-level navigation
// and popup windows remain restricted.
static inline BOOL SZTorrentNavigationAllowed(NSURL *url, BOOL hasTarget,
                                              BOOL mainFrame) {
  if (!hasTarget || !url)
    return NO;
  BOOL https = [url.scheme.lowercaseString isEqualToString:@"https"] &&
               (!url.port || url.port.integerValue == 443);
  if (https && [url.host.lowercaseString isEqualToString:@"rutracker.org"])
    return YES;
  if (mainFrame)
    return NO;
  if (https &&
      [url.host.lowercaseString isEqualToString:@"challenges.cloudflare.com"])
    return YES;
  return [url.absoluteString isEqualToString:@"about:blank"] ||
         [url.absoluteString isEqualToString:@"about:srcdoc"];
}

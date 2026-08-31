#pragma once

#import <Foundation/Foundation.h>

#import <SingzPlaybackSession/native_playback_session.h>

// Foundation-only result composition shared by the React bridge and the
// bridge schema runner. These functions may allocate/raise and must be called
// inside SingzPlaybackBridgeBoundary.
NSDictionary* SingzNativePlaybackResultDictionary(
    const singz::NativePlaybackResult& result);
NSDictionary* SingzNativePlaybackCleanupDictionary(
    const singz::NativePlaybackCleanupResult& cleanup);
NSDictionary* SingzNativePlaybackUnloadResultDictionary(
    const singz::NativePlaybackResult& result,
    const singz::NativePlaybackCleanupResult& cleanup);

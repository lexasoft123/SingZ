#pragma once

#import <Foundation/Foundation.h>

#include <string>
#include <vector>

#include <zcore/media/decoded_audio.h>

singz::OwnedFileDescriptor SingzOpenAuthorizedPlaybackPath(
    NSString* path, std::string* error);

// Foundation-only deterministic boundary used by the standalone bridge test.
// Production calls the wrapper above, which supplies the app's container and
// bundle roots.
singz::OwnedFileDescriptor SingzOpenAuthorizedPlaybackPathAtRoots(
    NSString* path, const std::vector<std::string>& authorizedRoots,
    std::string* error);

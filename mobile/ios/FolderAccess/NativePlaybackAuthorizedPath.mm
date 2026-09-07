#import "NativePlaybackAuthorizedPath.h"

#import "NativePlaybackBridgeBoundary.h"

#include <algorithm>
#include <string>
#include <vector>

#include <fcntl.h>
#include <limits.h>
#include <sys/stat.h>
#include <unistd.h>

namespace {

bool pathInside(const std::string& path, const std::string& root)
{
  if (path == root || path.size() <= root.size() ||
      path.compare(0, root.size(), root) != 0)
    return false;
  return root.back() == '/' || path[root.size()] == '/';
}

std::vector<std::string> appAuthorizedRoots()
{
  std::vector<std::string> roots;
  NSMutableArray<NSURL*>* urls = [NSMutableArray array];
  NSURL* documents =
      [NSFileManager.defaultManager URLsForDirectory:NSDocumentDirectory
                                           inDomains:NSUserDomainMask].firstObject;
  NSURL* support =
      [NSFileManager.defaultManager
          URLsForDirectory:NSApplicationSupportDirectory
                  inDomains:NSUserDomainMask].firstObject;
  if (documents != nil) [urls addObject:documents];
  if (support != nil) [urls addObject:support];
  if (NSBundle.mainBundle.bundleURL != nil)
    [urls addObject:NSBundle.mainBundle.bundleURL];
  for (NSURL* url in urls) {
    if (url == nil) continue;
    char canonical[PATH_MAX]{};
    if (realpath(url.fileSystemRepresentation, canonical) != nullptr)
      roots.emplace_back(canonical);
  }
  return roots;
}

}  // namespace

singz::OwnedFileDescriptor SingzOpenAuthorizedPlaybackPathAtRoots(
    NSString* path, const std::vector<std::string>& authorizedRoots,
    std::string* error)
{
  if (error != nullptr) error->clear();
  if (path.length == 0) {
    if (error != nullptr) *error = "A playback lane path is empty";
    return {};
  }
  // Ownership begins before any path canonicalization, container creation or
  // error-string assignment can allocate or throw.
  singz::OwnedFileDescriptor owner(::open(
      path.fileSystemRepresentation, O_RDONLY | O_CLOEXEC | O_NOFOLLOW));
  if (!owner.valid()) {
    if (error != nullptr) *error = "A playback lane could not be opened";
    return {};
  }
  SingzPlaybackInjectPrepareFault(
      SingzPlaybackPrepareFaultPoint::PostDescriptorOpen, owner.get());
  struct stat info {};
  if (fstat(owner.get(), &info) != 0 || !S_ISREG(info.st_mode)) {
    if (error != nullptr) *error = "A playback lane is not a regular file";
    return {};
  }
  char openedPath[PATH_MAX]{};
  if (fcntl(owner.get(), F_GETPATH, openedPath) != 0) {
    if (error != nullptr)
      *error = "The opened playback lane path is unavailable";
    return {};
  }
  char canonical[PATH_MAX]{};
  if (realpath(openedPath, canonical) == nullptr) {
    if (error != nullptr) *error = "The playback lane path is not canonical";
    return {};
  }
  const std::string candidate(canonical);
  const bool allowed = std::any_of(
      authorizedRoots.begin(), authorizedRoots.end(),
      [&](const std::string& root) { return pathInside(candidate, root); });
  if (!allowed) {
    if (error != nullptr)
      *error = "The playback lane is outside the app's authorized local roots";
    return {};
  }
  return owner;
}

singz::OwnedFileDescriptor SingzOpenAuthorizedPlaybackPath(
    NSString* path, std::string* error)
{
  return SingzOpenAuthorizedPlaybackPathAtRoots(
      path, appAuthorizedRoots(), error);
}

# RuTracker song downloads

The desktop drop screen and mobile catalog open **Search RuTracker**. Sign in
in the real site browser (including any CAPTCHA), search releases ordered by
seeders descending, open a release and choose one audio file. The interface
shows release size separately from the selected song size. It does not display
or rank by leechers. Completed audio enters the existing Add song flow.

Phones default to MP3 release searches; All formats includes lossless audio.
Desktop exposes the same choice and defaults to All formats. MP3 adds the
format keyword to the site search while preserving seeders-descending order.
Opening a release checks its actual metadata and offers only .mp3 files in
MP3 mode. A release title is not treated as proof of its contents; a release
without MP3 files gets an explicit message instead of offering FLAC.
This searches release titles; catalog-wide filename search remains gated below.

The downloader uses C++ libtorrent-rasterbar, linked statically with OpenSSL;
there is no Go runtime or daemon. Shared TypeScript owns the screen state,
CP1251 search encoding and site extraction scripts. Electron uses a stable
N-API addon; iOS uses a local Objective-C++ pod; Android uses JNI. Website
credentials stay in the platform browser session. On iOS, Cloudflare challenge
frames at `challenges.cloudflare.com` and `about:blank`/`about:srcdoc` are
allowed as embedded frames; main-page navigation remains on RuTracker. Passwords are not stored in
SingZ settings or passed to the torrent engine.

## Direct artist and song search

Songs is the default search mode on desktop and phones. Enter an artist and a
song title, then Find song. SingZ searches artist releases in seeder order and
reads their actual torrent metadata; matching audio basenames appear as
individual result cards with file size, album/path, source release and seeders.
Add to queue rechecks that the file still has the same index, name, path and size
before starting its selective download. No song payload is fetched during search.

Each batch checks up to ten releases. Progress states how many loaded releases
were checked; Stop search finishes the in-flight request and starts no next
request. Search more releases continues the remaining artist releases and site
pages. Failed metadata stays at the cursor so Continue retries it; an unavailable
file list is not treated as a successful search with no matches. At most two
site pages are fetched per batch, preventing endless duplicate-page loops.

This is artist-scoped discovery, not a claim to have indexed every RuTracker
file. It handles tracks inside discographies even when release titles omit the
song. Matching uses complete Unicode-normalized words in audio basenames,
ignoring case, accents and punctuation; folder-only matches are excluded. MP3
mode filters actual extensions. Up to 100 result cards are displayed; larger
result sets explicitly ask for a more specific title. Releases mode preserves
the existing manual release/file picker.

Live acceptance: Joe Cocker / First We Take Manhattan returns seven verified
MP3 files in topic 5859639, including file 1582 in ORIGINAL CD/1999 - No Ordinary
World (8,957,887 bytes). The implementation contains no artist/topic special case.

## Build

Requirements: Python 3.12+, CMake, a C++17 toolchain, Perl and make. Windows
uses native MSWin32 Perl (such as Strawberry) and the x64 Visual Studio C++
toolchain. The SDK producer discovers both and prepares its child environment.
It resolves executable paths against that prepared PATH before launching them:
[Python’s Windows process launcher](https://docs.python.org/3/library/subprocess.html#popen-constructor)
does not use a supplied child PATH to locate bare tool names such as `nmake`. These are build tools only. See [OpenSSL's Windows prerequisites](https://raw.githubusercontent.com/openssl/openssl/openssl-3.5.9/NOTES-WINDOWS.md).
Android needs the pinned NDK
27.1.12297006; set ANDROID_NDK_HOME, or ANDROID_HOME to its SDK parent. iOS
requires Xcode. Dependency archives are pinned and SHA256 checked. SDKs and
build outputs are ignored; do not copy another worktree's torrent binaries.

```sh
# Desktop (defaults to host OS/architecture)
python3 scripts/vendor-torrent.py
node scripts/build-torrent-addon.cjs
npm run build

# Cross-architecture macOS example
python3 scripts/vendor-torrent.py darwin-x64
node scripts/build-torrent-addon.cjs darwin-x64

# iOS: device + Apple Silicon Simulator XCFramework, before pod install
python3 scripts/build-torrent-ios.py
(cd mobile/ios && LANG=en_US.UTF-8 pod install)

# Android shipping ABIs; use android-arm64-v8a for an ARM64 emulator too
python3 scripts/vendor-torrent.py android-armeabi-v7a
python3 scripts/vendor-torrent.py android-arm64-v8a
(cd mobile/android && ./gradlew :app:assembleDebug)
```

`npm run dist` builds each requested desktop SDK/addon before packaging.
Android workflows provision the shipping-ABI SDKs explicitly. iOS store Release
workflows omit the torrent SDK and verify its exclusion from the built app.
A full worktree setup builds the iOS XCFramework for Debug/AdHoc before
integrating pods. Normal app builds
do not fetch torrent dependencies. Windows builds disable OpenSSL assembly
to avoid a NASM dependency. The vendored Mozilla CA snapshot supplies HTTPS
trust roots on phones while certificate and hostname verification stay on.
Notices ship with the addon, pod and APK.

Account restoration recognizes the current `bb_session` and legacy `bb_data`
cookies from the browser store; clearance cookies alone never indicate a
RuTracker login. The account panel shows Back to search and Sign out for a
connected session. `mobile/scripts/test-torrent-session.sh` exercises the iOS
cookie policy; the TypeScript unit suite covers reopening and logout.

## Lifecycle and storage

Inspection only fetches torrent metadata. Every payload filename is mapped to
an internal numeric filename; all unselected files have zero priority.
Libtorrent may still fetch boundary pieces shared with the chosen file.
The downloaded song is hash verified before export. Symlink entries, unsafe
portable filenames, metadata above 16 MiB and selected files above 5 GiB are
rejected. Up to 200 songs can be retained across the queue and completed downloads.
One song downloads at a time; completing it starts the next queued song.
The Downloads tab remains available while browsing for more songs.

Pause saves resume data and pauses the entire queue. A restarted app restores
unfinished work paused; Resume continues it. Cancel removes only the selected
queued or active song; other queued songs remain. On iOS, backgrounding pauses
work; downloads need the app in the foreground. Android uses a dataSync
foreground service with a progress notification and Pause action. Notification
permission is requested at the initiating tap; denying it does not deny the
download. OS process termination can interrupt either platform; reopen and
resume the durable job.

Mobile jobs live outside `singz-projects`, under durable private
`torrent-downloads`. On import, a completed file is copied to the existing
`singz-projects/imports/<uuid>` staging area. The original remains in Ready to add
until the user explicitly removes it, including after closing or cancelling Add
song. Repeated handoffs create independent disposable copies. iOS storage is
excluded from backup. Desktop jobs live in userData/torrent-downloads and use
allowlisted copies in userData/torrent-imports (discarded on next launch).
The native queue is atomically persisted in queue.bencode, with a bounded v1
job migration and recovery of v1 exported originals using their saved metadata.
A malformed queue returns an error rather than crashing.

The libtorrent SDK is always Release. Its exported Debug assertion definition
is removed for consumers because it changes public C++ object layouts. This
is required even when the surrounding Android application is Debug.

## Verification

Unit coverage exercises request boundaries, Cyrillic encoding, seeder sorting,
selection, pagination, recovery and late-result disposal. The native integration
test runs a real local TCP seeder, selective transfer, pause/restart/resume,
byte verification, unselected-file exclusion, queue advancement, repeated
handoff, malformed persisted records, legacy recovery and targeted removal:

```sh
cmake -S native/torrent -B .engines-src/torrent/tests \
  -DCMAKE_BUILD_TYPE=Debug -DSINGZ_TORRENT_TESTS=ON \
  -DCMAKE_PREFIX_PATH="$PWD/vendor/torrent/darwin-arm64" \
  -DOPENSSL_ROOT_DIR="$PWD/vendor/torrent/darwin-arm64" \
  -DOPENSSL_USE_STATIC_LIBS=ON
cmake --build .engines-src/torrent/tests --parallel 4
ctest --test-dir .engines-src/torrent/tests --output-on-failure
```

Run `mobile/scripts/test-torrent-navigation.sh` on macOS for the iOS navigation
allowlist regression cases (including Cloudflare frames and blocked external
main-page/popup navigation).

The test-only peer connector is excluded from production builds. Device E2E
uses fixture provider responses and the real native downloader, then drives
the existing Add song handoff. Live RuTracker authentication/search requires
a user's own site session and was not verified with real account credentials.


## Search by filename across torrents

`services/torrent-index` is the metadata index and read-only HTTP service. It
searches actual audio basenames, groups matching files by release, and sorts
releases by seeders descending. An album title does not have to contain the
search term. Both apps can display matching file previews and catalog coverage.

This requires a separately populated catalog of topic IDs and verified torrent
metadata. The service has not been deployed and no RuTracker-wide metadata
corpus has been imported. Release-title search remains the default. The
filename tab is hidden until the verified catalog is published and
`TORRENT_FILENAME_SEARCH_ENABLED` is enabled; the client never silently uses
title search or claims a partial catalog covers all RuTracker torrents. See
[the service instructions](../services/torrent-index/README.md).

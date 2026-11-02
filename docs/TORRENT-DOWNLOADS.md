# RuTracker song downloads

The desktop drop screen and mobile catalog open **Search RuTracker**. Sign in
in the real site browser (including any CAPTCHA), search releases ordered by
seeders descending, open a release and choose one audio file. The interface
shows release size separately from the selected song size. It does not display
or rank by leechers. Completed audio enters the existing Add song flow.

The downloader uses C++ libtorrent-rasterbar, linked statically with OpenSSL;
there is no Go runtime or daemon. Shared TypeScript owns the screen state,
CP1251 search encoding and site extraction scripts. Electron uses a stable
N-API addon; iOS uses a local Objective-C++ pod; Android uses JNI. Website
credentials stay in the platform browser session. On iOS, Cloudflare challenge
frames at `challenges.cloudflare.com` and `about:blank`/`about:srcdoc` are
allowed as embedded frames; main-page navigation remains on RuTracker. Passwords are not stored in
SingZ settings or passed to the torrent engine.

## Build

Requirements: Python 3.12+, CMake, a C++17 toolchain, Perl and make (nmake in a
Windows Developer Command Prompt). Android needs the pinned NDK
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
The iOS/Android workflows provision their SDKs explicitly. A full worktree
setup builds the iOS XCFramework before integrating pods. Normal app builds
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

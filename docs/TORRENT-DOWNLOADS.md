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
credentials stay in the platform browser session. Passwords are not stored in
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

## Lifecycle and storage

Inspection only fetches torrent metadata. Every payload filename is mapped to
an internal numeric filename; all unselected files have zero priority.
Libtorrent may still fetch boundary pieces shared with the chosen file.
The downloaded song is hash verified before export. Symlink entries, unsafe
portable filenames, metadata above 16 MiB and selected files above 5 GiB are
rejected. At most one active song download exists per app storage root.

Pause saves resume data. A restarted app restores the job paused; Resume
continues it. Cancel removes the partial job. On iOS, backgrounding pauses
work; downloads need the app in the foreground. Android uses a dataSync
foreground service with a progress notification and Pause action. Notification
permission is requested at the initiating tap; denying it does not deny the
download. OS process termination can interrupt either platform; reopen and
resume the durable job.

Mobile jobs live outside `singz-projects`, under durable private
`torrent-downloads`. On import, a completed file is copied to the existing
`singz-projects/imports/<uuid>` staging area before retiring the job. Cancelling
Add song uses the same cleanup as a document picker import. iOS storage is
excluded from backup. Desktop jobs live in userData/torrent-downloads and the
completed file is allowlisted for the existing loader.

The libtorrent SDK is always Release. Its exported Debug assertion definition
is removed for consumers because it changes public C++ object layouts. This
is required even when the surrounding Android application is Debug.

## Verification

Unit coverage exercises request boundaries, Cyrillic encoding, seeder sorting,
selection, pagination, recovery and late-result disposal. The native integration
test runs a real local TCP seeder, selective transfer, pause/restart/resume,
byte verification, unselected-file exclusion and cancellation:

```sh
cmake -S native/torrent -B .engines-src/torrent/tests \
  -DCMAKE_BUILD_TYPE=Debug -DSINGZ_TORRENT_TESTS=ON \
  -DCMAKE_PREFIX_PATH="$PWD/vendor/torrent/darwin-arm64" \
  -DOPENSSL_ROOT_DIR="$PWD/vendor/torrent/darwin-arm64" \
  -DOPENSSL_USE_STATIC_LIBS=ON
cmake --build .engines-src/torrent/tests --parallel 4
ctest --test-dir .engines-src/torrent/tests --output-on-failure
```

The test-only peer connector is excluded from production builds. Device E2E
uses fixture provider responses and the real native downloader, then drives
the existing Add song handoff. Live RuTracker authentication/search requires
a user's own site session and was not verified with real account credentials.

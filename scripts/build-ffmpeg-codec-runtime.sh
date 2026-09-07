#!/usr/bin/env bash
set -euo pipefail

# Build one immutable, decode-only LGPL FFmpeg slice for the Phase 4 codec
# matrix. This script never installs into the machine. Outputs are finalized
# under ignored vendor/ffmpeg-codec/<target>/ only after checksum/profile
# validation. Keep the hard eight-job ceiling in sync with the native app
# build policy; multiple callers must still serialize native builds globally.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:?usage: scripts/build-ffmpeg-codec-runtime.sh <target>}"
MODE="${2:-build}"
case "$MODE" in
  build|--prove-existing) ;;
  *) echo "usage: scripts/build-ffmpeg-codec-runtime.sh <target> [--prove-existing]" >&2; exit 2 ;;
esac
if [ -z "${SINGZ_NATIVE_BUILD_LOCK_HELD:-}" ]; then
  exec node "$ROOT/scripts/with-native-build-lock.mjs" \
    --owner "ffmpeg-codec:$TARGET:$MODE" -- \
    bash "$ROOT/scripts/build-ffmpeg-codec-runtime.sh" "$@"
fi
node "$ROOT/scripts/assert-native-build-lock.cjs"
VERSION=8.0.1
SOURCE_SHA256=05ee0b03119b45c0bdb4df654b96802e909e0a752f72e4fe3794f487229e5a41
SOURCE_URL="https://ffmpeg.org/releases/ffmpeg-${VERSION}.tar.xz"
AVCODEC_MAJOR=62
AVFORMAT_MAJOR=62
AVUTIL_MAJOR=60
SWRESAMPLE_MAJOR=6
JOBS="${SINGZ_NATIVE_JOBS:-8}"
case "$JOBS" in
  ''|*[!0-9]*) echo "SINGZ_NATIVE_JOBS must be an integer from 1 through 8" >&2; exit 2 ;;
esac
if [ "$JOBS" -lt 1 ] || [ "$JOBS" -gt 8 ]; then
  echo "SINGZ_NATIVE_JOBS must be from 1 through 8 (got $JOBS)" >&2
  exit 2
fi

WORK="$ROOT/.engines-src/ffmpeg-codec/$TARGET"
ARCHIVE="${SINGZ_FFMPEG_SOURCE_ARCHIVE:-$ROOT/.engines-src/ffmpeg-codec/ffmpeg-${VERSION}.tar.xz}"
SOURCE="$WORK/source"
BUILD="$WORK/build"
STAGE="$WORK/stage"
FIXTURES="$WORK/fixtures"
RECEIPT="$WORK/fixture-receipt.json"
mkdir -p "$(dirname "$ARCHIVE")" "$WORK"
if [ ! -f "$ARCHIVE" ]; then
  partial="$ARCHIVE.part-$$"
  trap 'rm -f "${partial:-}"' EXIT
  curl -fL --retry 3 --output "$partial" "$SOURCE_URL"
  mv "$partial" "$ARCHIVE"
  trap - EXIT
fi
actual="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
if [ "$actual" != "$SOURCE_SHA256" ]; then
  echo "FFmpeg source checksum mismatch: $actual" >&2
  exit 2
fi

if [ "$MODE" = build ]; then
  rm -rf "$SOURCE" "$BUILD" "$STAGE"
  mkdir -p "$SOURCE" "$BUILD" "$STAGE"
  tar -xf "$ARCHIVE" -C "$SOURCE" --strip-components=1
else
  node "$ROOT/scripts/verify-staged-ffmpeg-codec-runtime.mjs" "$TARGET" "$STAGE"
fi

DEMUXERS=aac,aiff,mov,mp3,ogg
DECODERS=aac,alac,flac,mp3,opus,vorbis,pcm_s8,pcm_u8,pcm_s16be,pcm_s16le,pcm_s24be,pcm_s24le,pcm_s32be,pcm_s32le,pcm_f32be,pcm_f32le,pcm_f64be,pcm_f64le,pcm_alaw,pcm_mulaw
PARSERS=aac,mpegaudio,opus,vorbis
configure=(
  "$SOURCE/configure"
  "--prefix=$STAGE"
  --disable-everything
  --disable-static
  --enable-shared
  --disable-programs
  --disable-doc
  --disable-avdevice
  --disable-avfilter
  --disable-swscale
  --disable-network
  --disable-protocols
  --disable-devices
  --disable-filters
  --disable-encoders
  --disable-muxers
  --disable-hwaccels
  --disable-autodetect
  --disable-debug
  --enable-small
  --enable-pic
  "--enable-demuxer=$DEMUXERS"
  "--enable-decoder=$DECODERS"
  "--enable-parser=$PARSERS"
)

# The compiler cache must carry its path normalization with the build. Merely
# sharing CCACHE_DIR gives sibling worktrees zero hits because FFmpeg records
# absolute source/build paths. Keep one launcher: --cc receives ccache plus
# the real compiler below, rather than stacking a second wrapper in make.
if command -v ccache >/dev/null 2>&1; then
  export CCACHE_BASEDIR="$ROOT"
  export CCACHE_NOHASHDIR=1
  export CCACHE_COMPILERCHECK=content
  CCACHE="$(command -v ccache)"
else
  CCACHE=
fi
# The user-visible ceiling is the exact count of process command lines which
# contain `clang`, not make's edge count. One edge may expose a recipe shell,
# compiler launcher, driver and frontend. Serialize even without ccache until
# an independently measured launcher proves a larger edge count remains <= 8.
COMPILE_JOBS=1
ccache_state=disabled
[ -z "$CCACHE" ] || ccache_state=enabled
echo "FFmpeg native compile edges: $COMPILE_JOBS (requested $JOBS; ccache $ccache_state)"
if [ "$(uname -s)" = Darwin ]; then
  host_sdk="$(xcrun --sdk macosx --show-sdk-path)"
  host_cc="$(xcrun --sdk macosx --find clang) --sysroot=$host_sdk"
  [ -z "$CCACHE" ] || host_cc="$CCACHE $host_cc"
  configure+=("--host-cc=$host_cc")
fi

case "$TARGET" in
  darwin-arm64|darwin-x64)
    [ "$(uname -s)" = Darwin ] || { echo "$TARGET requires macOS" >&2; exit 2; }
    arch=arm64; [ "$TARGET" = darwin-x64 ] && arch=x86_64
    sdk="$(xcrun --sdk macosx --show-sdk-path)"
    cc="$(xcrun --sdk macosx --find clang)"
    [ -z "$CCACHE" ] || cc="$CCACHE $cc"
    configure+=(
      --target-os=darwin "--arch=$arch" "--cc=$cc" "--sysroot=$sdk"
      --install-name-dir=@rpath
      "--extra-cflags=-arch $arch -mmacosx-version-min=11.0"
      "--extra-ldflags=-arch $arch -mmacosx-version-min=11.0"
    )
    ;;
  ios-arm64|ios-simulator-arm64|ios-simulator-x64)
    [ "$(uname -s)" = Darwin ] || { echo "$TARGET requires macOS" >&2; exit 2; }
    sdk_name=iphoneos; arch=arm64; minimum=-miphoneos-version-min=15.1
    if [ "$TARGET" != ios-arm64 ]; then
      sdk_name=iphonesimulator
      minimum=-mios-simulator-version-min=15.1
      if [ "$TARGET" = ios-simulator-x64 ]; then
        arch=x86_64
        # The Intel simulator slice is a compatibility build and must remain
        # reproducible on Apple Silicon hosts that do not install NASM. Clang's
        # generated code is sufficient for this non-device decode-test slice.
        configure+=(--disable-x86asm)
      fi
    fi
    sdk="$(xcrun --sdk "$sdk_name" --show-sdk-path)"
    cc="$(xcrun --sdk "$sdk_name" --find clang)"
    [ -z "$CCACHE" ] || cc="$CCACHE $cc"
    configure+=(
      --target-os=darwin --enable-cross-compile "--arch=$arch"
      "--cc=$cc" "--sysroot=$sdk" --install-name-dir=@rpath
      "--extra-cflags=-arch $arch $minimum"
      "--extra-ldflags=-arch $arch $minimum"
    )
    ;;
  android-arm64-v8a|android-armeabi-v7a|android-x86|android-x86_64)
    ndk="${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-}}"
    if [ -z "$ndk" ] && [ -n "${ANDROID_HOME:-}" ]; then
      ndk="$ANDROID_HOME/ndk/27.1.12297006"
    fi
    [ -x "$ndk/toolchains/llvm/prebuilt/$(uname -s | tr '[:upper:]' '[:lower:]')-x86_64/bin/llvm-ar" ] || {
      # Google's Darwin NDK directory remains darwin-x86_64 on Apple Silicon.
      case "$(uname -s)" in Darwin) host=darwin-x86_64;; Linux) host=linux-x86_64;; *) host=windows-x86_64;; esac
    }
    host="${host:-$(uname -s | tr '[:upper:]' '[:lower:]')-x86_64}"
    tools="$ndk/toolchains/llvm/prebuilt/$host/bin"
    [ -x "$tools/llvm-ar" ] || { echo "Pinned Android NDK toolchain not found: $tools" >&2; exit 2; }
    case "$TARGET" in
      android-arm64-v8a) arch=aarch64; triple=aarch64-linux-android; cpu_flags= ;;
      android-armeabi-v7a) arch=arm; triple=armv7a-linux-androideabi; cpu_flags='-march=armv7-a -mfloat-abi=softfp' ;;
      android-x86) arch=x86; triple=i686-linux-android; cpu_flags=-march=i686 ;;
      android-x86_64) arch=x86_64; triple=x86_64-linux-android; cpu_flags=-march=x86-64 ;;
    esac
    # Intel Android ABIs are compatibility/emulator slices. Avoid making them
    # depend on host NASM; ARM shipping/device slices remain optimized.
    case "$TARGET" in
      android-x86|android-x86_64) configure+=(--disable-x86asm) ;;
    esac
    api=21
    cross_cc="$tools/${triple}${api}-clang"
    cross_cxx="$tools/${triple}${api}-clang++"
    if [ -n "$CCACHE" ]; then
      cross_cc="$CCACHE $cross_cc"
      cross_cxx="$CCACHE $cross_cxx"
    fi
    configure+=(
      --target-os=android --enable-cross-compile --disable-symver
      "--arch=$arch" "--cc=$cross_cc"
      "--cxx=$cross_cxx" "--ar=$tools/llvm-ar"
      "--nm=$tools/llvm-nm" "--ranlib=$tools/llvm-ranlib"
      "--strip=$tools/llvm-strip" "--sysroot=$ndk/toolchains/llvm/prebuilt/$host/sysroot"
      "--extra-cflags=-fPIC -Wl,-z,max-page-size=16384 $cpu_flags"
      "--extra-ldflags=-Wl,-z,max-page-size=16384 -Wl,-z,common-page-size=16384"
    )
    ;;
  win32-x64)
    command -v cl.exe >/dev/null 2>&1 || {
      echo "win32-x64 must run from an MSYS2/Git Bash shell initialized by a Visual Studio x64 developer prompt" >&2
      exit 2
    }
    configure+=(
      --target-os=win64 --arch=x86_64 --toolchain=msvc
      --disable-x86asm --cc=cl.exe --ld=link.exe --ar=lib.exe
    )
    ;;
  *) echo "Unsupported FFmpeg codec target: $TARGET" >&2; exit 2 ;;
esac

if [ "$MODE" = build ]; then
  cd "$BUILD"
  "${configure[@]}"
  make -j"$COMPILE_JOBS"
  make install
  mkdir -p "$STAGE/share/singz-ffmpeg"
  printf '%s ' "${configure[@]:1}" > "$STAGE/share/singz-ffmpeg/configuration.txt"
  printf '\n' >> "$STAGE/share/singz-ffmpeg/configuration.txt"
  node "$ROOT/scripts/verify-staged-ffmpeg-codec-runtime.mjs" "$TARGET" "$STAGE"
fi

fixture_args=()
verify_args=()
case "$TARGET/$(uname -s)/$(uname -m)" in
  darwin-arm64/Darwin/arm64|darwin-x64/Darwin/x86_64)
    # Execute the immutable, hash-bound corpus. Ogg stream serial numbers make
    # freshly encoded files byte-variable even when their decoded PCM agrees,
    # so generation is never acceptable as release-proof input.
    proof_fixtures="$ROOT/tests/fixtures/codecs/data"
    proof_build="$WORK/proof-build"
    rm -rf "$proof_build"
    proof_launcher_args=()
    if [ -n "$CCACHE" ]; then
      proof_launcher_args=(
        "-DCMAKE_C_COMPILER_LAUNCHER=$CCACHE"
        "-DCMAKE_CXX_COMPILER_LAUNCHER=$CCACHE"
      )
    fi
    # The provisioning target lives in the host-test block. CMake only
    # creates that block when host tools are enabled; selecting the single
    # target below still avoids compiling the unrelated CLIs/tests.
    cmake -S "$ROOT" -B "$proof_build" \
      -DSINGZ_BUILD_HOST_TOOLS=ON -DSINGZ_CORE_TESTS=ON \
      -DSINGZ_ENABLE_FFMPEG_CODECS=ON \
      -DSINGZ_FFMPEG_INCLUDE_DIR="$STAGE/include" \
      -DSINGZ_FFMPEG_AVCODEC_LIBRARY="$STAGE/lib/libavcodec.$AVCODEC_MAJOR.dylib" \
      -DSINGZ_FFMPEG_AVFORMAT_LIBRARY="$STAGE/lib/libavformat.$AVFORMAT_MAJOR.dylib" \
      -DSINGZ_FFMPEG_AVUTIL_LIBRARY="$STAGE/lib/libavutil.$AVUTIL_MAJOR.dylib" \
      -DSINGZ_FFMPEG_SWRESAMPLE_LIBRARY="$STAGE/lib/libswresample.$SWRESAMPLE_MAJOR.dylib" \
      -DCMAKE_BUILD_TYPE=Release "${proof_launcher_args[@]}"
    cmake --build "$proof_build" --target codec_provisioning_tests --parallel "$COMPILE_JOBS"
    node "$ROOT/scripts/prove-ffmpeg-codec-runtime.mjs" \
      --target "$TARGET" --stage "$STAGE" \
      --test "$proof_build/codec_provisioning_tests" \
      --fixtures "$proof_fixtures" --output "$RECEIPT"
    fixture_args=(--fixture-receipt "$RECEIPT")
    verify_args=(--require-full)
    ;;
esac

if [ "$MODE" = --prove-existing ] && [ ${#fixture_args[@]} -gt 0 ] && \
    [ -f "$ROOT/vendor/ffmpeg-codec/$TARGET/manifest.json" ]; then
  node "$ROOT/scripts/promote-ffmpeg-host-proof.mjs" \
    --target "$TARGET" --receipt "$RECEIPT"
else
  node "$ROOT/scripts/finalize-ffmpeg-codec-runtime.mjs" \
    "$TARGET" "$STAGE" "${fixture_args[@]}"
fi
node "$ROOT/scripts/verify-ffmpeg-codec-pack.mjs" \
  --target "$TARGET" "${verify_args[@]}"

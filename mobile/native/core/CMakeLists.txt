# The core's HOST build — singz-analyze and the host test suite, for any
# desktop platform (macOS, Linux, Windows/MSVC). This is the ONE definition of
# how the core compiles outside the phones: scripts/build-analyze-host.sh and
# scripts/run-core-host-tests.sh are thin wrappers over it, the vendor step
# (scripts/vendor-analyze.sh) ships its output beside whisper-cli, and the
# core-win workflow builds and tests it on Windows — ground the bash scripts
# never touched (docs/PHONE-STANDALONE.md, Phase 4c: the desktop reaches the
# core through the singz-analyze CLI, spawned by main like whisper-cli).
#
# The phones do NOT use this file: Android's CMakeLists (app/src/main/cpp)
# names the core sources directly, and the SingzCore podspec globs
# core/*.{h,cpp} — a CMakeLists.txt matches neither. Keep it that way; a
# second project() inside their builds would be a mess.
#
# Deliberately ORT-free: beat_this_ort.cpp, ort_env.cpp and split_engine.cpp
# are not here. The neural grid reaches the CLI as a --ml recording, which is
# what lets the parity harness replay tensors with no model and no runtime —
# and lets this build need nothing but a C/C++ toolchain.
cmake_minimum_required(VERSION 3.16)
project(singz-core LANGUAGES C CXX)

set(CMAKE_C_STANDARD 99)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  # Optimized like the shipping builds. Release is -O3 on clang/gcc and /O2 on
  # MSVC — the parity gates hold bit-identical at both, so the exact level is
  # not load-bearing; unoptimized is just too slow for the corpus runs.
  set(CMAKE_BUILD_TYPE Release)
endif()

# The sources carry UTF-8 punctuation in comments; without /utf-8 MSVC reads
# them in the machine's ANSI codepage and warns (or worse, in CJK codepages,
# mis-lexes). No-op everywhere else.
add_compile_options("$<$<C_COMPILER_ID:MSVC>:/utf-8>" "$<$<CXX_COMPILER_ID:MSVC>:/utf-8>")
# The core uses M_PI with bare <cmath>. Clang and gcc expose it by default,
# which is why every prior platform compiled; MSVC's UCRT hides it behind this
# define. No-op everywhere else.
add_compile_definitions(_USE_MATH_DEFINES)

set(FLAC_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../third_party/flac)
set(REPO ${CMAKE_CURRENT_SOURCE_DIR}/../../..)

# ---- vendored libFLAC (C, compiled apart — a C++ compile of C99 is the
# wrong language; same shape as the bash scripts and both phone builds) ------
file(GLOB FLAC_SOURCES CONFIGURE_DEPENDS ${FLAC_DIR}/src/*.c)
add_library(singz_flac STATIC ${FLAC_SOURCES})
# compat.h's _WIN32 branch maps flac_fopen and friends onto the UTF-8 wrappers
# in share/win_utf8_io — upstream's official Windows path, and the reason
# FLAC's own file opens survive non-ASCII song folders. The phones never take
# the branch and never compile the file (their globs stop at src/*.c).
if(WIN32)
  target_sources(singz_flac PRIVATE ${FLAC_DIR}/src/share/win_utf8_io/win_utf8_io.c)
endif()
target_compile_definitions(singz_flac PRIVATE HAVE_CONFIG_H)
# FLAC__NO_DLL: on MSVC, FLAC/export.h defaults FLAC_API to
# __declspec(dllimport) — format.c then DEFINES dllimport data and dies with
# C2491 (core-win discovery #2). The define says "static", which this build
# is; PUBLIC because every consumer that includes a FLAC header on Windows
# needs the same answer. export.h only consults it under MSC — a no-op for
# clang/gcc and both phones.
target_compile_definitions(singz_flac PUBLIC FLAC__NO_DLL)
target_include_directories(singz_flac PUBLIC
  ${FLAC_DIR} ${FLAC_DIR}/include ${FLAC_DIR}/src/include ${FLAC_DIR}/src)
# libm belongs on the library whose code calls it (lpc.c's log): a pure-C
# consumer like flac_roundtrip links singz_flac ALONE, and on Linux that
# missed -lm the first time this file met a linker that needs it spelled out.
if(UNIX)
  target_link_libraries(singz_flac PUBLIC m)
endif()

# ---- the core ---------------------------------------------------------------
add_library(singz_core STATIC
  analysis.cpp
  beats.cpp
  beat_this.cpp
  courts.cpp
  flac_io.cpp
  melody.cpp
  resample.cpp
  wav.cpp)
target_include_directories(singz_core PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
target_link_libraries(singz_core PUBLIC singz_flac)

# ---- the CLI ----------------------------------------------------------------
add_executable(singz-analyze tools/singz-analyze.cpp)
target_link_libraries(singz-analyze PRIVATE singz_core)

# ---- the host test suite (tests/native at the repo root) --------------------
# The wav suites and flac_roundtrip synthesize their own audio, so ctest needs
# no fixtures, no ffmpeg and no node — which is exactly what lets the Windows
# workflow run the REAL suite rather than a smoke.
option(SINGZ_CORE_TESTS "Build the host test suite" ON)
if(SINGZ_CORE_TESTS)
  enable_testing()
  add_executable(core_host_tests ${REPO}/tests/native/core_host_tests.cpp)
  target_link_libraries(core_host_tests PRIVATE singz_core)
  add_test(NAME core_host_tests COMMAND core_host_tests)

  add_executable(flac_roundtrip ${REPO}/tests/native/flac_roundtrip.c)
  target_link_libraries(flac_roundtrip PRIVATE singz_flac)
  # the roundtrip writes scratch files where it stands — point it at the
  # build tree, the same way run-core-host-tests.sh pointed it at $TMPDIR
  add_test(NAME flac_roundtrip COMMAND flac_roundtrip
           WORKING_DIRECTORY ${CMAKE_CURRENT_BINARY_DIR})
endif()

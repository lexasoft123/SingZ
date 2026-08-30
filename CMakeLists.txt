# Authoritative native superbuild. Host tools/tests configure this directory
# directly; Android adds it as a subdirectory and links the same component
# targets. iOS materializes these sources into its product pod until the
# planned XCFramework packaging cutover.
cmake_minimum_required(VERSION 3.16)

if(CMAKE_CURRENT_SOURCE_DIR STREQUAL CMAKE_SOURCE_DIR)
  project(singz-native LANGUAGES C CXX)
endif()

find_package(Threads REQUIRED)

if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/mobile/native/core" OR
   EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/mobile/native/third_party")
  message(FATAL_ERROR
    "Stale native ownership detected under mobile/native; reusable sources "
    "belong in zcore or third_party/native")
endif()

option(SINGZ_CORE_TESTS "Build the host test suite" ON)
option(SINGZ_BUILD_HOST_TOOLS "Build singz-analyze and native host tests" ON)
option(SINGZ_BUILD_ML "Build the ONNX-backed mobile analysis/split adapter" OFF)
option(SINGZ_BUILD_ELECTRON_CAPTURE "Build the stable Node-API capture addon" OFF)
set(SINGZ_NODE_INCLUDE_DIR "" CACHE PATH
    "Electron Node-API include directory (the directory containing node_api.h)")
set(SINGZ_NODE_LIBRARY "" CACHE FILEPATH
    "Electron node.lib for Windows addon builds")
option(SINGZ_ENABLE_ASIO "Build the optional Steinberg ASIO input provider" OFF)
set(SINGZ_ASIO_SDK_DIR "" CACHE PATH
    "Path to a separately licensed Steinberg ASIO SDK checkout")

if(SINGZ_ENABLE_ASIO)
  if(NOT WIN32)
    message(FATAL_ERROR "SINGZ_ENABLE_ASIO is available only for Windows builds")
  endif()
  if(NOT EXISTS "${SINGZ_ASIO_SDK_DIR}/common/asio.h")
    message(FATAL_ERROR
      "SINGZ_ENABLE_ASIO requires SINGZ_ASIO_SDK_DIR to point at a separately "
      "licensed Steinberg ASIO SDK (common/asio.h was not found). The SDK is "
      "intentionally not vendored in SingZ.")
  endif()
  message(FATAL_ERROR
    "The ASIO provider is intentionally gated pending SingZ's signed SDK "
    "agreement and the separate AsioAudioInputBackend implementation. Keep "
    "SINGZ_ENABLE_ASIO=OFF for shipping builds.")
endif()

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  # Optimized like the shipping builds. Release is -O3 on clang/gcc and /O2 on
  # MSVC — the parity gates hold bit-identical at both, so the exact level is
  # not load-bearing; unoptimized is just too slow for the corpus runs.
  set(CMAKE_BUILD_TYPE Release)
endif()

add_library(singz_native_build_options INTERFACE)
add_library(SingZ::native_build_options ALIAS singz_native_build_options)
# Keep these requirements target-scoped so an Android parent build and
# unrelated third-party targets do not inherit them.
target_compile_options(singz_native_build_options INTERFACE
  "$<$<C_COMPILER_ID:MSVC>:/utf-8>"
  "$<$<CXX_COMPILER_ID:MSVC>:/utf-8>")
target_compile_definitions(singz_native_build_options INTERFACE
  _USE_MATH_DEFINES)

set(SINGZ_REPO_ROOT "${CMAKE_CURRENT_SOURCE_DIR}")
add_subdirectory(third_party/native)
add_subdirectory(zcore)
add_subdirectory(zdsp)
get_property(SINGZ_ZCORE_RT_MANIFEST GLOBAL PROPERTY SINGZ_ZCORE_RT_MANIFEST)
get_property(SINGZ_IOS_AUDIO_HOST_RT_MANIFEST GLOBAL PROPERTY
  SINGZ_IOS_AUDIO_HOST_RT_MANIFEST)
get_property(SINGZ_ANDROID_AUDIO_HOST_RT_MANIFEST GLOBAL PROPERTY
  SINGZ_ANDROID_AUDIO_HOST_RT_MANIFEST)
get_property(SINGZ_ZDSP_RT_MANIFEST GLOBAL PROPERTY SINGZ_ZDSP_RT_MANIFEST)

# Phase 4A monitor callback leaf. The actual host thunk, silence containment,
# and terminal counters compile independently from the control-domain session
# owner and are scanned from the target's authoritative source list.
include("${CMAKE_CURRENT_SOURCE_DIR}/cmake/SingZRealtimeTarget.cmake")
add_library(singz_monitor_callback STATIC
  native/electron/audio_monitor_callback.cpp
  native/electron/audio_monitor_callback.h)
add_library(SingZ::monitor_callback ALIAS singz_monitor_callback)
target_compile_features(singz_monitor_callback PUBLIC cxx_std_20)
target_include_directories(singz_monitor_callback PUBLIC
  "${SINGZ_REPO_ROOT}/native/electron")
target_link_libraries(singz_monitor_callback PUBLIC
  SingZ::native_build_options
  SingZ::zdsp_host_adapter)
set_target_properties(singz_monitor_callback PROPERTIES
  POSITION_INDEPENDENT_CODE YES
  CXX_EXTENSIONS OFF
  CXX_VISIBILITY_PRESET hidden
  VISIBILITY_INLINES_HIDDEN YES)
singz_configure_realtime_target(singz_monitor_callback)

set(SINGZ_MONITOR_RT_MANIFEST
  "${CMAKE_CURRENT_BINARY_DIR}/monitor-realtime-sources.cmake")
get_target_property(_monitor_callback_source_dir singz_monitor_callback SOURCE_DIR)
get_target_property(_monitor_callback_sources singz_monitor_callback SOURCES)
file(WRITE "${SINGZ_MONITOR_RT_MANIFEST}"
  "set(SINGZ_ZDSP_RT_FILES\n")
foreach(_source IN LISTS _monitor_callback_sources)
  if(IS_ABSOLUTE "${_source}")
    set(_absolute_source "${_source}")
  else()
    get_filename_component(_absolute_source "${_source}" ABSOLUTE
      BASE_DIR "${_monitor_callback_source_dir}")
  endif()
  file(TO_CMAKE_PATH "${_absolute_source}" _absolute_source)
  file(APPEND "${SINGZ_MONITOR_RT_MANIFEST}"
    "  [==[${_absolute_source}]==]\n")
endforeach()
file(APPEND "${SINGZ_MONITOR_RT_MANIFEST}" ")\n")
add_custom_target(singz_check_monitor_realtime ALL
  COMMAND "${CMAKE_COMMAND}"
    "-DSINGZ_ZDSP_RT_MANIFEST=${SINGZ_MONITOR_RT_MANIFEST}"
    "-DSINGZ_ZDSP_RT_PROFILE=monitor"
    -P "${SINGZ_REPO_ROOT}/cmake/CheckZdspRealtime.cmake"
  VERBATIM
  COMMENT "Checking monitor callback source policy")
add_dependencies(singz_monitor_callback singz_check_monitor_realtime)

add_library(singz_native_audio_ownership STATIC
  native/electron/native_audio_ownership.cpp
  native/electron/native_audio_ownership.h)
target_compile_features(singz_native_audio_ownership PUBLIC cxx_std_20)
target_include_directories(singz_native_audio_ownership PUBLIC
  "${SINGZ_REPO_ROOT}")
target_link_libraries(singz_native_audio_ownership PUBLIC
  SingZ::native_build_options)
set_target_properties(singz_native_audio_ownership PROPERTIES
  POSITION_INDEPENDENT_CODE YES CXX_EXTENSIONS OFF)

if(SINGZ_BUILD_ELECTRON_CAPTURE)
  if(NOT EXISTS "${SINGZ_NODE_INCLUDE_DIR}/node_api.h")
    message(FATAL_ERROR
      "SINGZ_BUILD_ELECTRON_CAPTURE requires SINGZ_NODE_INCLUDE_DIR to contain node_api.h")
  endif()
  add_library(singz_capture MODULE
    native/electron/capture_addon.cpp
    native/electron/audio_monitor_session.cpp
    native/electron/audio_monitor_session.h
    native/electron/native_audio_ownership.h)
  target_compile_features(singz_capture PRIVATE cxx_std_20)
  target_include_directories(singz_capture PRIVATE "${SINGZ_NODE_INCLUDE_DIR}")
  # Build identity, compiled in and exported: the loader refuses an addon
  # whose Electron version differs from the process it runs in, and the
  # source stamp lets harnesses tell a foreign/stale binary from this one
  # (build-capture-addon.cjs passes both; bare cmake builds carry blanks and
  # are refused by the app's loader by design).
  set(SINGZ_CAPTURE_ELECTRON "" CACHE STRING "Electron version this addon targets")
  set(SINGZ_CAPTURE_SOURCE_STAMP "" CACHE STRING "Fingerprint of the addon's build inputs")
  target_compile_definitions(singz_capture PRIVATE
    NAPI_VERSION=8 NODE_GYP_MODULE_NAME=singz_capture
    SINGZ_CAPTURE_ELECTRON="${SINGZ_CAPTURE_ELECTRON}"
    SINGZ_CAPTURE_SOURCE_STAMP="${SINGZ_CAPTURE_SOURCE_STAMP}")
  target_link_libraries(singz_capture PRIVATE
    SingZ::native_build_options
    SingZ::zcore_device
    SingZ::zdsp_analysis
    SingZ::zdsp_host_adapter
    SingZ::monitor_callback
    singz_native_audio_ownership)
  set_target_properties(singz_capture PROPERTIES
    PREFIX ""
    SUFFIX ".node"
    OUTPUT_NAME "singz-capture"
    CXX_EXTENSIONS OFF
    CXX_VISIBILITY_PRESET hidden
    VISIBILITY_INLINES_HIDDEN YES)
  if(APPLE)
    target_link_options(singz_capture PRIVATE "-undefined" "dynamic_lookup")
  elseif(WIN32)
    target_sources(singz_capture PRIVATE
      native/electron/win_delay_load_hook.cc)
    target_compile_definitions(singz_capture PRIVATE
      WIN32_LEAN_AND_MEAN NOMINMAX _WIN32_WINNT=0x0A00
      HOST_BINARY=\"node.exe\")
    if(NOT EXISTS "${SINGZ_NODE_LIBRARY}")
      message(FATAL_ERROR
        "Windows Electron addon builds require SINGZ_NODE_LIBRARY=node.lib")
    endif()
    # Electron's node.lib imports N-API from node.exe even though the shipping
    # host binary is electron.exe. Match node-gyp's Windows addon contract:
    # delay-load that import and resolve it to the current process image.
    target_link_options(singz_capture PRIVATE "/DELAYLOAD:node.exe")
    target_link_libraries(singz_capture PRIVATE
      "${SINGZ_NODE_LIBRARY}"
      delayimp)
  endif()
endif()

if(NOT SINGZ_BUILD_HOST_TOOLS)
  return()
endif()

# ---- the CLI ----------------------------------------------------------------
# A vendored CLI carries the exact shared-core fingerprint that built it.
# Other host/test builds leave this empty and truthfully report an unknown
# source in `build-info`. Generate into the build tree so the fingerprint does
# not recursively include itself.
set(SINGZ_SOURCE_HASH "" CACHE STRING
    "Shared native source fingerprint; empty = unrecorded")
configure_file(
  zcore/src/base/build_stamp.cpp.in
  ${CMAKE_CURRENT_BINARY_DIR}/singz_build_stamp.cpp
  @ONLY)
add_executable(singz-analyze
  tools/native/singz-analyze.cpp
  ${CMAKE_CURRENT_BINARY_DIR}/singz_build_stamp.cpp)
target_compile_features(singz-analyze PRIVATE cxx_std_20)
add_dependencies(singz-analyze singz_check_zcore_boundaries)
target_link_libraries(singz-analyze PRIVATE
  SingZ::native_build_options
  SingZ::zcore_legacy
  SingZ::zdsp_analysis)

# Standalone, headless Phase 3A ownership boundary. This never starts product
# playback and emits silence for hardware runs.
add_executable(singz-audio-host tools/native/singz-audio-host.cpp)
target_compile_features(singz-audio-host PRIVATE cxx_std_20)
add_dependencies(singz-audio-host singz_check_zcore_boundaries)
target_link_libraries(singz-audio-host PRIVATE
  SingZ::native_build_options
  SingZ::zcore_device_fake)

# ---- the host test suite (tests/native at the repo root) --------------------
# The wav suites and flac_roundtrip synthesize their own audio, so ctest needs
# no fixtures, no ffmpeg and no node — which is exactly what lets the Windows
# workflow run the REAL suite rather than a smoke.
if(SINGZ_CORE_TESTS)
  target_compile_definitions(singz-analyze PRIVATE SINGZ_CORE_TESTS=1)
  enable_testing()
  add_test(NAME zcore_dependency_boundaries
    COMMAND "${CMAKE_COMMAND}"
      "-DSINGZ_ZCORE_ROOT=${SINGZ_REPO_ROOT}/zcore"
      -P "${SINGZ_REPO_ROOT}/cmake/CheckZcoreBoundaries.cmake")
  add_test(NAME zcore_realtime_source_policy
    COMMAND "${CMAKE_COMMAND}"
      "-DSINGZ_ZCORE_RT_MANIFEST=${SINGZ_ZCORE_RT_MANIFEST}"
      -P "${SINGZ_REPO_ROOT}/cmake/CheckZcoreRealtime.cmake")
  add_test(NAME zcore_realtime_policy_negative
    COMMAND "${CMAKE_COMMAND}"
      "-DSINGZ_ZCORE_RT_MANIFEST=${SINGZ_ZCORE_RT_MANIFEST}"
      "-DSINGZ_ZCORE_RT_CHECKER=${SINGZ_REPO_ROOT}/cmake/CheckZcoreRealtime.cmake"
      "-DSINGZ_ZCORE_RT_TEST_DIR=${CMAKE_CURRENT_BINARY_DIR}/zcore-rt-negative"
      -P "${SINGZ_REPO_ROOT}/cmake/TestZcoreRealtimePolicy.cmake")
  add_test(NAME ios_audio_host_realtime_source_policy
    COMMAND "${CMAKE_COMMAND}"
      "-DSINGZ_IOS_AUDIO_HOST_RT_MANIFEST=${SINGZ_IOS_AUDIO_HOST_RT_MANIFEST}"
      -P "${SINGZ_REPO_ROOT}/cmake/CheckIosAudioHostRealtime.cmake")
  add_test(NAME ios_audio_host_realtime_policy_negative
    COMMAND "${CMAKE_COMMAND}"
      "-DSINGZ_IOS_AUDIO_HOST_RT_MANIFEST=${SINGZ_IOS_AUDIO_HOST_RT_MANIFEST}"
      "-DSINGZ_IOS_AUDIO_HOST_RT_CHECKER=${SINGZ_REPO_ROOT}/cmake/CheckIosAudioHostRealtime.cmake"
      "-DSINGZ_IOS_AUDIO_HOST_RT_TEST_DIR=${CMAKE_CURRENT_BINARY_DIR}/ios-audio-host-rt-negative"
      "-DSINGZ_IOS_AUDIO_HOST_RT_CXX_COMPILER=${CMAKE_CXX_COMPILER}"
      "-DSINGZ_IOS_AUDIO_HOST_RT_CXX_COMPILER_ID=${CMAKE_CXX_COMPILER_ID}"
      -P "${SINGZ_REPO_ROOT}/cmake/TestIosAudioHostRealtimePolicy.cmake")
  add_test(NAME android_audio_host_realtime_source_policy
    COMMAND "${CMAKE_COMMAND}"
      "-DSINGZ_ANDROID_AUDIO_HOST_RT_MANIFEST=${SINGZ_ANDROID_AUDIO_HOST_RT_MANIFEST}"
      -P "${SINGZ_REPO_ROOT}/cmake/CheckAndroidAudioHostRealtime.cmake")
  # #import/raw-byte fixtures are compile-first proofs, so they only exist on
  # a host whose configured compiler can genuinely accept Clang preprocessing.
  if(CMAKE_CXX_COMPILER_ID MATCHES "Clang")
    set(_android_rt_hex_writer_source
      "${CMAKE_CURRENT_BINARY_DIR}/android-audio-host-rt-hex-writer.cpp")
    file(WRITE "${_android_rt_hex_writer_source}"
      "#include <cstdio>\nint nibble(char c){ if(c>='0'&&c<='9') return c-'0'; if(c>='a'&&c<='f') return c-'a'+10; if(c>='A'&&c<='F') return c-'A'+10; return -1; }\nint main(int argc,char** argv){ if(argc!=3) return 2; FILE* out=std::fopen(argv[1],\"wb\"); if(!out) return 3; const char* hex=argv[2]; int result=0; for(int i=0; hex[i]!=0; i+=2){ if(hex[i+1]==0){ result=4; break; } int high=nibble(hex[i]); int low=nibble(hex[i+1]); if(high<0||low<0||std::fputc((high<<4)|low,out)==EOF){ result=5; break; } } if(std::fclose(out)!=0 && result==0) result=6; return result; }\n")
    add_executable(android_audio_host_rt_hex_writer
      "${_android_rt_hex_writer_source}")
    target_compile_features(android_audio_host_rt_hex_writer PRIVATE cxx_std_20)
    add_test(NAME android_audio_host_realtime_policy_negative
      COMMAND "${CMAKE_COMMAND}"
        "-DSINGZ_ANDROID_AUDIO_HOST_RT_MANIFEST=${SINGZ_ANDROID_AUDIO_HOST_RT_MANIFEST}"
        "-DSINGZ_ANDROID_AUDIO_HOST_RT_CHECKER=${SINGZ_REPO_ROOT}/cmake/CheckAndroidAudioHostRealtime.cmake"
        "-DSINGZ_ANDROID_AUDIO_HOST_RT_TEST_DIR=${CMAKE_CURRENT_BINARY_DIR}/android-audio-host-rt-negative"
        "-DSINGZ_ANDROID_AUDIO_HOST_RT_CXX_COMPILER=${CMAKE_CXX_COMPILER}"
        "-DSINGZ_ANDROID_AUDIO_HOST_RT_CXX_COMPILER_ID=${CMAKE_CXX_COMPILER_ID}"
        "-DSINGZ_ANDROID_AUDIO_HOST_RT_HEX_WRITER=$<TARGET_FILE:android_audio_host_rt_hex_writer>"
        -P "${SINGZ_REPO_ROOT}/cmake/TestAndroidAudioHostRealtimePolicy.cmake")
  endif()
  add_test(NAME zdsp_realtime_source_policy
    COMMAND "${CMAKE_COMMAND}"
      "-DSINGZ_ZDSP_RT_MANIFEST=${SINGZ_ZDSP_RT_MANIFEST}"
      -P "${SINGZ_REPO_ROOT}/cmake/CheckZdspRealtime.cmake")
  add_test(NAME monitor_realtime_source_policy
    COMMAND "${CMAKE_COMMAND}"
      "-DSINGZ_ZDSP_RT_MANIFEST=${SINGZ_MONITOR_RT_MANIFEST}"
      "-DSINGZ_ZDSP_RT_PROFILE=monitor"
      -P "${SINGZ_REPO_ROOT}/cmake/CheckZdspRealtime.cmake")
  add_executable(core_host_tests ${SINGZ_REPO_ROOT}/tests/native/core_host_tests.cpp)
  add_dependencies(core_host_tests singz_check_zcore_boundaries)
  target_compile_features(core_host_tests PRIVATE cxx_std_20)
  target_compile_definitions(core_host_tests PRIVATE SINGZ_CORE_TESTS=1)
  target_include_directories(core_host_tests PRIVATE
    "${SINGZ_REPO_ROOT}/zcore/src/device")
  target_link_libraries(core_host_tests PRIVATE SingZ::zcore_legacy)
  add_test(NAME core_host_tests COMMAND core_host_tests)

  add_executable(audio_host_tests
    ${SINGZ_REPO_ROOT}/tests/native/audio_host_tests.cpp)
  target_compile_features(audio_host_tests PRIVATE cxx_std_20)
  target_include_directories(audio_host_tests PRIVATE "${SINGZ_REPO_ROOT}")
  target_link_libraries(audio_host_tests PRIVATE
    SingZ::zcore_device_fake Threads::Threads)
  add_test(NAME audio_host_tests COMMAND audio_host_tests)

  add_executable(audio_host_ios_policy_tests
    ${SINGZ_REPO_ROOT}/tests/native/audio_host_ios_policy_tests.cpp)
  target_compile_features(audio_host_ios_policy_tests PRIVATE cxx_std_20)
  target_include_directories(audio_host_ios_policy_tests PRIVATE
    "${SINGZ_REPO_ROOT}")
  target_link_libraries(audio_host_ios_policy_tests PRIVATE
    SingZ::zcore_device)
  add_test(NAME audio_host_ios_policy_tests COMMAND audio_host_ios_policy_tests)

  add_executable(audio_host_android_policy_tests
    ${SINGZ_REPO_ROOT}/tests/native/audio_host_android_policy_tests.cpp)
  target_compile_features(audio_host_android_policy_tests PRIVATE cxx_std_20)
  target_include_directories(audio_host_android_policy_tests PRIVATE
    "${SINGZ_REPO_ROOT}"
    "${SINGZ_REPO_ROOT}/zcore/platform/android")
  target_link_libraries(audio_host_android_policy_tests PRIVATE
    SingZ::zcore_device)
  if(TARGET android_audio_host_rt_hex_writer)
    add_dependencies(audio_host_android_policy_tests
      android_audio_host_rt_hex_writer)
  endif()
  add_test(NAME audio_host_android_policy_tests
    COMMAND audio_host_android_policy_tests)

  if(WIN32)
    add_executable(audio_host_windows_tests
      ${SINGZ_REPO_ROOT}/tests/native/audio_host_windows_tests.cpp)
    target_compile_features(audio_host_windows_tests PRIVATE cxx_std_20)
    target_include_directories(audio_host_windows_tests PRIVATE
      "${SINGZ_REPO_ROOT}")
    target_link_libraries(audio_host_windows_tests PRIVATE
      SingZ::zcore_device)
    add_test(NAME audio_host_windows_tests COMMAND audio_host_windows_tests)
  endif()

  add_executable(audio_host_graph_adapter_tests
    ${SINGZ_REPO_ROOT}/zdsp/tests/audio_host_graph_adapter_tests.cpp
    ${SINGZ_REPO_ROOT}/zdsp/tests/allocation_trap.cpp
    ${SINGZ_REPO_ROOT}/zdsp/tests/allocation_trap.h)
  target_compile_features(audio_host_graph_adapter_tests PRIVATE cxx_std_20)
  target_include_directories(audio_host_graph_adapter_tests PRIVATE
    "${SINGZ_REPO_ROOT}/zdsp/tests")
  if(CMAKE_CXX_COMPILER_ID STREQUAL "GNU")
    set_source_files_properties(
      "${SINGZ_REPO_ROOT}/zdsp/tests/allocation_trap.cpp" PROPERTIES
      COMPILE_OPTIONS "-Wno-mismatched-new-delete")
  endif()
  target_link_libraries(audio_host_graph_adapter_tests PRIVATE
    SingZ::zdsp_host_adapter)
  add_test(NAME audio_host_graph_adapter_tests COMMAND audio_host_graph_adapter_tests)

  add_executable(prepared_audio_tests
    ${SINGZ_REPO_ROOT}/tests/native/prepared_audio_tests.cpp
    ${SINGZ_REPO_ROOT}/zdsp/tests/allocation_trap.cpp
    ${SINGZ_REPO_ROOT}/zdsp/tests/allocation_trap.h)
  target_compile_features(prepared_audio_tests PRIVATE cxx_std_20)
  target_include_directories(prepared_audio_tests PRIVATE
    "${SINGZ_REPO_ROOT}/zdsp/tests")
  if(CMAKE_CXX_COMPILER_ID STREQUAL "GNU")
    set_source_files_properties(
      "${SINGZ_REPO_ROOT}/zdsp/tests/allocation_trap.cpp" PROPERTIES
      COMPILE_OPTIONS "-Wno-mismatched-new-delete")
  endif()
  target_link_libraries(prepared_audio_tests PRIVATE
    SingZ::zcore_media
    SingZ::zdsp_runtime)
  add_test(NAME prepared_audio_tests COMMAND prepared_audio_tests)

  add_executable(audio_monitor_session_tests
    ${SINGZ_REPO_ROOT}/native/electron/audio_monitor_session.cpp
    ${SINGZ_REPO_ROOT}/native/electron/audio_monitor_session.h
    ${SINGZ_REPO_ROOT}/zdsp/tests/audio_monitor_session_tests.cpp
    ${SINGZ_REPO_ROOT}/zdsp/tests/allocation_trap.cpp
    ${SINGZ_REPO_ROOT}/zdsp/tests/allocation_trap.h)
  target_compile_features(audio_monitor_session_tests PRIVATE cxx_std_20)
  target_include_directories(audio_monitor_session_tests PRIVATE
    "${SINGZ_REPO_ROOT}"
    "${SINGZ_REPO_ROOT}/zdsp/tests")
  if(CMAKE_CXX_COMPILER_ID STREQUAL "GNU")
    set_source_files_properties(
      "${SINGZ_REPO_ROOT}/zdsp/tests/allocation_trap.cpp" PROPERTIES
      COMPILE_OPTIONS "-Wno-mismatched-new-delete")
  endif()
  target_link_libraries(audio_monitor_session_tests PRIVATE
    SingZ::monitor_callback singz_native_audio_ownership Threads::Threads)
  add_test(NAME audio_monitor_session_tests COMMAND audio_monitor_session_tests)

  add_executable(native_audio_ownership_tests
    ${SINGZ_REPO_ROOT}/zdsp/tests/native_audio_ownership_tests.cpp)
  target_compile_features(native_audio_ownership_tests PRIVATE cxx_std_20)
  target_link_libraries(native_audio_ownership_tests PRIVATE
    singz_native_audio_ownership Threads::Threads)
  add_test(NAME native_audio_ownership_tests COMMAND native_audio_ownership_tests)

  add_test(NAME audio_host_fake_cli
    COMMAND singz-audio-host --fake --blocks 6 --maximum-frames 1024)
  set_tests_properties(audio_host_fake_cli PROPERTIES
    PASS_REGULAR_EXPRESSION
      "\"callbacks\":6.*\"xruns\":0.*\"deadlineMisses\":0.*\"invalidCallbacks\":0.*\"varying\":1.*\"maximumSeen\":1024.*\"cyclesCompleted\":1.*\"state\":\"stopped\"")
  add_test(NAME audio_host_fake_cli_rejects_faults
    COMMAND ${CMAKE_COMMAND}
      -DAUDIO_HOST_CLI=$<TARGET_FILE:singz-audio-host>
      -P ${SINGZ_REPO_ROOT}/tests/native/audio_host_cli_fault_test.cmake)

  add_executable(zdsp_contract_tests
    ${SINGZ_REPO_ROOT}/zdsp/tests/zdsp_contract_tests.cpp)
  target_compile_features(zdsp_contract_tests PRIVATE cxx_std_20)
  set_target_properties(zdsp_contract_tests PROPERTIES CXX_EXTENSIONS OFF)
  target_link_libraries(zdsp_contract_tests PRIVATE
    SingZ::zdsp_prototype SingZ::zdsp_control)
  add_test(NAME zdsp_contract_tests COMMAND zdsp_contract_tests)

  add_executable(zdsp_graph_tests
    ${SINGZ_REPO_ROOT}/zdsp/tests/zdsp_graph_tests.cpp)
  set(_zdsp_allocation_trap_source
    "${SINGZ_REPO_ROOT}/zdsp/tests/allocation_trap.cpp")
  target_sources(zdsp_graph_tests PRIVATE
    "${_zdsp_allocation_trap_source}"
    "${SINGZ_REPO_ROOT}/zdsp/tests/allocation_trap.h")
  target_include_directories(zdsp_graph_tests PRIVATE
    "${SINGZ_REPO_ROOT}/zdsp/tests")
  if(CMAKE_CXX_COMPILER_ID STREQUAL "GNU")
    # This test-only replacement allocation API intentionally pairs malloc/free.
    # Keep GCC's heuristic suppression local so real mismatches remain errors.
    set_source_files_properties("${_zdsp_allocation_trap_source}" PROPERTIES
      COMPILE_OPTIONS "-Wno-mismatched-new-delete")
  endif()
  target_compile_features(zdsp_graph_tests PRIVATE cxx_std_20)
  set_target_properties(zdsp_graph_tests PROPERTIES CXX_EXTENSIONS OFF)
  target_link_libraries(zdsp_graph_tests PRIVATE SingZ::zdsp_offline Threads::Threads)
  add_test(NAME zdsp_graph_tests COMMAND zdsp_graph_tests)

  add_executable(zdsp_analysis_tests
    ${SINGZ_REPO_ROOT}/zdsp/tests/zdsp_analysis_tests.cpp)
  target_compile_features(zdsp_analysis_tests PRIVATE cxx_std_20)
  set_target_properties(zdsp_analysis_tests PROPERTIES CXX_EXTENSIONS OFF)
  target_link_libraries(zdsp_analysis_tests PRIVATE
    SingZ::zdsp_analysis SingZ::zcore_legacy Threads::Threads)
  add_test(NAME zdsp_analysis_tests COMMAND zdsp_analysis_tests)
  if(APPLE)
    add_test(NAME zcore_apple_audio_host_smoke
      COMMAND bash
        "${SINGZ_REPO_ROOT}/zcore/build-apple-audio-host-smoke.sh"
        "${SINGZ_REPO_ROOT}"
        "${CMAKE_CURRENT_BINARY_DIR}/zcore-apple-audio-host-ctest")
    add_test(NAME zdsp_apple_component_smoke
      COMMAND bash
        "${SINGZ_REPO_ROOT}/zdsp/build-apple-component-smoke.sh"
        "${SINGZ_REPO_ROOT}"
        "${CMAKE_CURRENT_BINARY_DIR}/zdsp-apple-component-ctest")
  endif()

  add_executable(zdsp_fake_host_benchmark
    ${SINGZ_REPO_ROOT}/zdsp/benchmarks/fake_host_benchmark.cpp)
  target_compile_features(zdsp_fake_host_benchmark PRIVATE cxx_std_20)
  set_target_properties(zdsp_fake_host_benchmark PROPERTIES CXX_EXTENSIONS OFF)
  target_link_libraries(zdsp_fake_host_benchmark PRIVATE SingZ::zdsp_prototype)

  add_executable(zdsp_graph_benchmark
    ${SINGZ_REPO_ROOT}/zdsp/benchmarks/graph_benchmark.cpp)
  target_compile_features(zdsp_graph_benchmark PRIVATE cxx_std_20)
  set_target_properties(zdsp_graph_benchmark PROPERTIES CXX_EXTENSIONS OFF)
  target_link_libraries(zdsp_graph_benchmark PRIVATE SingZ::zdsp_offline)

  add_executable(flac_roundtrip ${SINGZ_REPO_ROOT}/tests/native/flac_roundtrip.c)
  add_dependencies(flac_roundtrip singz_check_zcore_boundaries)
  target_link_libraries(flac_roundtrip PRIVATE SingZ::native_flac)
  # the roundtrip writes scratch files where it stands — point it at the
  # build tree, the same way run-core-host-tests.sh pointed it at $TMPDIR
  add_test(NAME flac_roundtrip COMMAND flac_roundtrip
           WORKING_DIRECTORY ${CMAKE_CURRENT_BINARY_DIR})

  # Protocol smoke: discovery is one bounded versioned JSON object. The
  # hardware-independent parser rejection runs everywhere; runtime discovery
  # accepts an empty list on headless CI and is exercised on real machines.
  add_test(NAME live_input_parser_bounds
           COMMAND singz-analyze live-input --device-uid test --channel 0 --frames 64)
  set_tests_properties(live_input_parser_bounds PROPERTIES
    WILL_FAIL TRUE)
  # Provenance is a shipping command. Ordinary host-test builds intentionally
  # carry no source hash, so they must report a well-formed null rather than
  # inventing an identity.
  add_test(NAME build_info_schema COMMAND singz-analyze build-info)
  set_tests_properties(build_info_schema PROPERTIES
    PASS_REGULAR_EXPRESSION
      "\\{\"version\":1,\"sourceHash\":null,\"pitchDetectVersion\":[0-9]+,\"keyDetectVersion\":[0-9]+,\"beatDetectVersion\":[0-9]+\\}")
  add_test(NAME input_devices_schema
           COMMAND singz-analyze input-devices-fixture)
  set_tests_properties(input_devices_schema PROPERTIES
    PASS_REGULAR_EXPRESSION
      "\\{\"version\":1,\"devices\":\\[\\{\"uid\":\"fixture:stable-uid\",\"label\":\"Fixture interface\",\"isDefault\":true,\"sampleRate\":48000,\"channels\":24,\"channelLabels\":\\[\"Channel 1\".*\"Channel 24\"\\]\\}\\]\\}")
  add_test(NAME live_input_analysis_plan
           COMMAND singz-analyze live-input-analysis-plan-fixture)
  set_tests_properties(live_input_analysis_plan PROPERTIES
    PASS_REGULAR_EXPRESSION
      "\"deviceSampleRate\":192000,\"analysisSampleRate\":48000,\"frames\":2048,\"hop\":512,\"resamplerLatencyFrames\":48.*\"explicitShortRejected\":true")
  add_test(NAME live_input_analysis_throughput_budget
           COMMAND singz-analyze live-input-analysis-throughput-fixture)
  set_tests_properties(live_input_analysis_throughput_budget PROPERTIES
    TIMEOUT 15
    PASS_REGULAR_EXPRESSION
      "\"deviceSampleRate\":192000,\"analysisSampleRate\":48000,\"frames\":2048,\"hop\":512.*\"budgetFramesMax\":2048,\"budgetAnalysisRateMax\":48000")
  add_test(NAME live_input_ready_analysis_metadata
           COMMAND singz-analyze live-input-analysis-plan-fixture)
  set_tests_properties(live_input_ready_analysis_metadata PROPERTIES
    PASS_REGULAR_EXPRESSION
      "\"type\":\"ready\".*\"frames\":2048.*\"analysisFrames\":2048.*\"analysisHopFrames\":512.*\"minFrequencyHz\":70.*\"deviceSampleRate\":48000.*\"analysisSampleRate\":48000.*\"analysisWindowMs\":42.6666667.*\"analysisCadenceMs\":10.6666667")
  add_test(NAME live_input_latency_analysis_metadata
           COMMAND singz-analyze live-input-analysis-plan-fixture)
  set_tests_properties(live_input_latency_analysis_metadata PROPERTIES
    PASS_REGULAR_EXPRESSION
      "\"type\":\"latency\".*\"analysisFrames\":2048.*\"analysisHopFrames\":512.*\"minFrequencyHz\":70.*\"deviceSampleRate\":48000.*\"analysisSampleRate\":48000.*\"resamplerLatencyFrames\":0.*\"analysisWindowMs\":42.6666667.*\"analysisCadenceMs\":10.6666667")
  add_test(NAME live_input_overrun_event
           COMMAND singz-analyze live-input-discontinuity-fixture)
  set_tests_properties(live_input_overrun_event PROPERTIES
    PASS_REGULAR_EXPRESSION "\"type\":\"overrun\"")
  add_test(NAME live_input_discontinuity_event
           COMMAND singz-analyze live-input-discontinuity-fixture)
  set_tests_properties(live_input_discontinuity_event PROPERTIES
    PASS_REGULAR_EXPRESSION
      "\"type\":\"discontinuity\".*\"pendingReset\":true")
  add_test(NAME live_input_timestamp_provenance
           COMMAND singz-analyze live-input-timestamp-provenance-fixture)
  set_tests_properties(live_input_timestamp_provenance PROPERTIES
    PASS_REGULAR_EXPRESSION
      "\"type\":\"timestamp-provenance\".*\"estimateToHardwareReset\":true.*\"hardwareWindowHostTimeNs\":1041000000.*\"hardwareToEstimateReset\":true.*\"estimateWindowHostTimeNs\":1084666667.*\"sequenceDiscontinuities\":0.*\"hostDiscontinuities\":0")
  if(CMAKE_SYSTEM_NAME STREQUAL "Darwin" OR WIN32)
    add_test(NAME ndjson_writer_closed_pipe
             COMMAND singz-analyze ndjson-writer-closed-fixture)
    set_tests_properties(ndjson_writer_closed_pipe PROPERTIES TIMEOUT 3)
    add_test(NAME ndjson_writer_blocked_pipe
             COMMAND singz-analyze ndjson-writer-blocked-fixture)
    set_tests_properties(ndjson_writer_blocked_pipe PROPERTIES TIMEOUT 3)
  endif()
  if(CMAKE_SYSTEM_NAME STREQUAL "Darwin" OR WIN32)
    # Runtime protocol shape only: an empty device list is valid on CI. Real
    # hardware lane counts and capture are proven by platform hardware smokes.
    add_test(NAME input_devices_runtime_schema COMMAND singz-analyze input-devices)
    set_tests_properties(input_devices_runtime_schema PROPERTIES
      PASS_REGULAR_EXPRESSION "\\{\"version\":1,\"devices\":\\[")
  endif()
endif()

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
get_property(SINGZ_ZDSP_RT_MANIFEST GLOBAL PROPERTY SINGZ_ZDSP_RT_MANIFEST)

if(SINGZ_BUILD_ELECTRON_CAPTURE)
  if(NOT EXISTS "${SINGZ_NODE_INCLUDE_DIR}/node_api.h")
    message(FATAL_ERROR
      "SINGZ_BUILD_ELECTRON_CAPTURE requires SINGZ_NODE_INCLUDE_DIR to contain node_api.h")
  endif()
  add_library(singz_capture MODULE native/electron/capture_addon.cpp)
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
    SingZ::zdsp_analysis)
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
add_executable(singz-analyze tools/native/singz-analyze.cpp)
target_compile_features(singz-analyze PRIVATE cxx_std_20)
add_dependencies(singz-analyze singz_check_zcore_boundaries)
target_link_libraries(singz-analyze PRIVATE
  SingZ::native_build_options
  SingZ::zcore_legacy
  SingZ::zdsp_analysis)

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
  add_test(NAME zdsp_realtime_source_policy
    COMMAND "${CMAKE_COMMAND}"
      "-DSINGZ_ZDSP_RT_MANIFEST=${SINGZ_ZDSP_RT_MANIFEST}"
      -P "${SINGZ_REPO_ROOT}/cmake/CheckZdspRealtime.cmake")
  add_executable(core_host_tests ${SINGZ_REPO_ROOT}/tests/native/core_host_tests.cpp)
  add_dependencies(core_host_tests singz_check_zcore_boundaries)
  target_compile_features(core_host_tests PRIVATE cxx_std_20)
  target_compile_definitions(core_host_tests PRIVATE SINGZ_CORE_TESTS=1)
  target_include_directories(core_host_tests PRIVATE
    "${SINGZ_REPO_ROOT}/zcore/src/device")
  target_link_libraries(core_host_tests PRIVATE SingZ::zcore_legacy)
  add_test(NAME core_host_tests COMMAND core_host_tests)

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

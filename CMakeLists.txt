# Authoritative native superbuild. Host tools/tests configure this directory
# directly; Android adds it as a subdirectory and links the same component
# targets. iOS materializes these sources into its product pod until the
# planned XCFramework packaging cutover.
cmake_minimum_required(VERSION 3.16)

if(CMAKE_CURRENT_SOURCE_DIR STREQUAL CMAKE_SOURCE_DIR)
  project(singz-native LANGUAGES C CXX)
endif()

if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/mobile/native/core" OR
   EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/mobile/native/third_party")
  message(FATAL_ERROR
    "Stale native ownership detected under mobile/native; reusable sources "
    "belong in zcore or third_party/native")
endif()

option(SINGZ_CORE_TESTS "Build the host test suite" ON)
option(SINGZ_BUILD_HOST_TOOLS "Build singz-analyze and native host tests" ON)
option(SINGZ_BUILD_ML "Build the ONNX-backed mobile analysis/split adapter" OFF)
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

if(NOT SINGZ_BUILD_HOST_TOOLS)
  return()
endif()

# ---- the CLI ----------------------------------------------------------------
add_executable(singz-analyze tools/native/singz-analyze.cpp)
target_compile_features(singz-analyze PRIVATE cxx_std_20)
add_dependencies(singz-analyze singz_check_zcore_boundaries)
target_link_libraries(singz-analyze PRIVATE
  SingZ::native_build_options
  SingZ::zcore_legacy)

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
  add_executable(core_host_tests ${SINGZ_REPO_ROOT}/tests/native/core_host_tests.cpp)
  add_dependencies(core_host_tests singz_check_zcore_boundaries)
  target_compile_features(core_host_tests PRIVATE cxx_std_20)
  target_compile_definitions(core_host_tests PRIVATE SINGZ_CORE_TESTS=1)
  target_link_libraries(core_host_tests PRIVATE SingZ::zcore_legacy)
  add_test(NAME core_host_tests COMMAND core_host_tests)

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

cmake_minimum_required(VERSION 3.20)
project(capture_input_latency_tests LANGUAGES C CXX)
# Configure in a private scratch directory, passing SINGZ_NODE_INCLUDE_DIR to
# the installed Electron headers; build with --parallel 1 (capture producer
# limit), then ctest --output-on-failure. Also builds the unmodified production
# singz_capture target for its separate Electron smoke test.
get_filename_component(WP7_REPO_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../.." ABSOLUTE)
set(SINGZ_BUILD_ELECTRON_CAPTURE ON CACHE BOOL "" FORCE)
set(SINGZ_BUILD_HOST_TOOLS OFF CACHE BOOL "" FORCE)
set(SINGZ_CORE_TESTS OFF CACHE BOOL "" FORCE)
set(SINGZ_BOX_LOOPZ_ROUTING OFF CACHE BOOL "" FORCE)
add_subdirectory("${WP7_REPO_ROOT}" native)
# Test-only backend injection is never enabled by the production producer.
target_compile_definitions(zcore_device PRIVATE SINGZ_CORE_TESTS=1)
add_executable(audio_input_latency_tests "${WP7_REPO_ROOT}/third_party/zcore/tests/native/audio_input_latency_tests.cpp")
target_compile_definitions(audio_input_latency_tests PRIVATE SINGZ_CORE_TESTS=1)
target_include_directories(audio_input_latency_tests PRIVATE "${WP7_REPO_ROOT}/third_party/zcore")
target_link_libraries(audio_input_latency_tests PRIVATE SingZ::zcore_device)
get_target_property(capture_sources singz_capture SOURCES)
list(REMOVE_ITEM capture_sources native/electron/capture_addon.cpp)
list(TRANSFORM capture_sources PREPEND "${WP7_REPO_ROOT}/")
add_library(capture_latency_fake MODULE fake_addon.cpp ${capture_sources})
foreach(property IN ITEMS COMPILE_DEFINITIONS INCLUDE_DIRECTORIES LINK_LIBRARIES LINK_OPTIONS)
  get_target_property(value singz_capture ${property})
  if(value)
    set_property(TARGET capture_latency_fake PROPERTY ${property} "${value}")
  endif()
endforeach()
target_compile_features(capture_latency_fake PRIVATE cxx_std_20)
target_compile_definitions(capture_latency_fake PRIVATE SINGZ_CORE_TESTS=1)
target_include_directories(capture_latency_fake PRIVATE "${WP7_REPO_ROOT}")
target_link_libraries(capture_latency_fake PRIVATE SingZ::zcore_device_fake)
set_target_properties(capture_latency_fake PROPERTIES PREFIX "" SUFFIX ".node")
enable_testing()
add_test(NAME audio_input_latency_tests COMMAND audio_input_latency_tests)
find_program(WP7_NODE_EXECUTABLE node REQUIRED)
add_test(NAME capture_input_latency_stats
  COMMAND "${WP7_NODE_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/check.cjs"
    "$<TARGET_FILE:capture_latency_fake>")
set_tests_properties(capture_input_latency_stats PROPERTIES TIMEOUT 15)

add_test(NAME capture_take_ownership
  COMMAND "${WP7_NODE_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/ownership.cjs"
    "$<TARGET_FILE:capture_latency_fake>")
# Compile the old release-on-disarm policy into the real addon, without
# weakening any test assertions or accepting unrelated failures/crashes.
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
  "${WP7_REPO_ROOT}/native/electron/capture_addon.cpp")
file(READ "${WP7_REPO_ROOT}/native/electron/capture_addon.cpp" _capture_source)
string(REPLACE "if (releasedGeneration != 0 && (force || !owner.takePresent))"
  "if (releasedGeneration != 0)" _capture_negative "${_capture_source}")
if(_capture_negative STREQUAL _capture_source)
  message(FATAL_ERROR "Capture ownership negative control did not mutate its release guard")
endif()
set(_capture_negative_path "${CMAKE_CURRENT_BINARY_DIR}/capture-addon-early-release.cpp")
file(WRITE "${_capture_negative_path}" "${_capture_negative}")
add_library(capture_ownership_negative MODULE fake_addon.cpp ${capture_sources})
foreach(property IN ITEMS COMPILE_DEFINITIONS INCLUDE_DIRECTORIES LINK_LIBRARIES LINK_OPTIONS)
  get_target_property(value singz_capture ${property})
  if(value)
    set_property(TARGET capture_ownership_negative PROPERTY ${property} "${value}")
  endif()
endforeach()
target_compile_features(capture_ownership_negative PRIVATE cxx_std_20)
target_compile_definitions(capture_ownership_negative PRIVATE SINGZ_CORE_TESTS=1
  SINGZ_CAPTURE_ADDON_SOURCE="${_capture_negative_path}")
target_include_directories(capture_ownership_negative PRIVATE "${WP7_REPO_ROOT}" "${WP7_REPO_ROOT}/native/electron")
target_link_libraries(capture_ownership_negative PRIVATE SingZ::zcore_device_fake)
set_target_properties(capture_ownership_negative PROPERTIES PREFIX "" SUFFIX ".node")
add_dependencies(capture_latency_fake capture_ownership_negative)
find_package(Python3 REQUIRED COMPONENTS Interpreter)
add_test(NAME capture_take_ownership_negative
  COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/expect_ownership_failure.py"
    "${WP7_NODE_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/ownership.cjs"
    "$<TARGET_FILE:capture_ownership_negative>")
set_tests_properties(capture_take_ownership capture_take_ownership_negative PROPERTIES TIMEOUT 30)
# An instrumented addon needs its runtime loaded before the uninstrumented
# Node executable. Keep Python outside that runtime for the negative wrapper.
if(APPLE AND CMAKE_CXX_FLAGS MATCHES "-fsanitize=(address|thread)")
  set(_fixture_sanitizer "${CMAKE_MATCH_1}")
  if(_fixture_sanitizer STREQUAL "address")
    set(_fixture_sanitizer asan)
  else()
    set(_fixture_sanitizer tsan)
  endif()
  execute_process(COMMAND "${CMAKE_CXX_COMPILER}" --print-resource-dir
    OUTPUT_VARIABLE _fixture_clang_resources OUTPUT_STRIP_TRAILING_WHITESPACE
    COMMAND_ERROR_IS_FATAL ANY)
  set(_fixture_runtime "${_fixture_clang_resources}/lib/darwin/libclang_rt.${_fixture_sanitizer}_osx_dynamic.dylib")
  if(NOT EXISTS "${_fixture_runtime}")
    message(FATAL_ERROR "Node fixture sanitizer runtime missing: ${_fixture_runtime}")
  endif()
  set_tests_properties(capture_input_latency_stats capture_take_ownership PROPERTIES
    ENVIRONMENT "DYLD_INSERT_LIBRARIES=${_fixture_runtime}")
  set_tests_properties(capture_take_ownership_negative PROPERTIES
    ENVIRONMENT "SINGZ_TEST_NODE_SANITIZER_RUNTIME=${_fixture_runtime}")
endif()

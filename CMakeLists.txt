# Authoritative native superbuild. Host tools/tests configure this directory
# directly; Android adds it as a subdirectory and links the same component
# targets. iOS materializes these sources into its product pod until the
# planned XCFramework packaging cutover.
cmake_minimum_required(VERSION 3.16)

if(CMAKE_CURRENT_SOURCE_DIR STREQUAL CMAKE_SOURCE_DIR)
  project(singz-native LANGUAGES C CXX)
  include("${CMAKE_CURRENT_SOURCE_DIR}/cmake/SingZCompilerCache.cmake")
  singz_enable_compiler_cache("${CMAKE_CURRENT_SOURCE_DIR}")
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
option(SINGZ_BOX_LOOPZ_ROUTING "Build the independent Box LoopZ routing host" OFF)
option(SINGZ_ENABLE_FFMPEG_CODECS
  "Enable descriptor-only extended codecs through dynamic FFmpeg libraries" OFF)
set(SINGZ_FFMPEG_INCLUDE_DIR "" CACHE PATH
  "Pinned FFmpeg headers matching the separately replaceable shared runtime")
foreach(_singz_ffmpeg_component IN ITEMS AVCODEC AVFORMAT AVUTIL SWRESAMPLE)
  set(SINGZ_FFMPEG_${_singz_ffmpeg_component}_LIBRARY "" CACHE FILEPATH
    "Dynamic FFmpeg ${_singz_ffmpeg_component} link library")
  if(WIN32)
    set(SINGZ_FFMPEG_${_singz_ffmpeg_component}_RUNTIME "" CACHE FILEPATH
      "Dynamic FFmpeg ${_singz_ffmpeg_component} DLL")
  endif()
endforeach()
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
    "agreement and a separately licensed AsioDriverApi implementation. Keep "
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
set(ZCORE_ROOT "${SINGZ_REPO_ROOT}/third_party/zcore")
if(NOT EXISTS "${ZCORE_ROOT}/CMakeLists.txt")
  message(FATAL_ERROR
    "zCore submodule sources are missing. Initialize them with: git submodule update --init -- third_party/zcore")
endif()
# Product builds compile the verified canonical sources even when a previous
# local build cache contains temporary zCore overlay paths.
set(ZCORE_GRAPH_RUNNER_SOURCE "${ZCORE_ROOT}/zdsp/src/runtime/graph_runner.cpp"
  CACHE FILEPATH "Canonical pinned zCore graph runner" FORCE)
set(ZCORE_BUILTIN_NODES_SOURCE "${ZCORE_ROOT}/zdsp/src/runtime/builtin_nodes.cpp"
  CACHE FILEPATH "Canonical pinned zCore built-in processors" FORCE)
set(ZCORE_BUILD_MEDIA ON CACHE BOOL "Build zCore media components" FORCE)
set(ZCORE_BUILD_ANALYSIS ON CACHE BOOL "Build zCore analysis components" FORCE)
set(ZCORE_BUILD_TESTS OFF CACHE BOOL "Build zCore tests from SingZ" FORCE)
set(ZCORE_BUILD_BENCHMARKS OFF CACHE BOOL "Build zCore benchmarks from SingZ" FORCE)
find_package(Python3 REQUIRED COMPONENTS Interpreter)
execute_process(
  COMMAND "${Python3_EXECUTABLE}"
    "${SINGZ_REPO_ROOT}/scripts/verify-zcore-submodule.py"
    --root "${SINGZ_REPO_ROOT}"
    --path third_party/zcore
  RESULT_VARIABLE _zcore_verify_status
  OUTPUT_VARIABLE _zcore_verify_stdout
  ERROR_VARIABLE _zcore_verify_stderr)
if(NOT _zcore_verify_status EQUAL 0)
  message(FATAL_ERROR
    "Pinned zCore verification failed:\n${_zcore_verify_stdout}${_zcore_verify_stderr}")
endif()
include(cmake/SingZFfmpegTarget.cmake)
add_subdirectory(third_party/zcore)
add_custom_target(singz_verify_zcore ALL
  COMMAND "${Python3_EXECUTABLE}"
    "${SINGZ_REPO_ROOT}/scripts/verify-zcore-submodule.py"
    --root "${SINGZ_REPO_ROOT}" --path third_party/zcore
  VERBATIM COMMENT "Verifying pinned zCore source snapshot")
get_property(_zcore_targets DIRECTORY "${ZCORE_ROOT}" PROPERTY BUILDSYSTEM_TARGETS)
foreach(_target IN LISTS _zcore_targets)
  get_target_property(_kind "${_target}" TYPE)
  if(NOT _kind STREQUAL "INTERFACE_LIBRARY")
    add_dependencies("${_target}" singz_verify_zcore)
  endif()
endforeach()

if(SINGZ_BOX_LOOPZ_ROUTING)
  if(CMAKE_VERSION VERSION_LESS 3.24)
    message(FATAL_ERROR "Box LoopZ routing requires CMake 3.24 or newer")
  endif()
  execute_process(
    COMMAND "${Python3_EXECUTABLE}"
      "${SINGZ_REPO_ROOT}/scripts/verify-zcore-submodule.py"
      --root "${SINGZ_REPO_ROOT}" --path third_party/loopz
    RESULT_VARIABLE _loopz_verify_status
    OUTPUT_VARIABLE _loopz_verify_stdout ERROR_VARIABLE _loopz_verify_stderr)
  if(NOT _loopz_verify_status EQUAL 0)
    message(FATAL_ERROR "Pinned LoopZ verification failed:\n${_loopz_verify_stdout}${_loopz_verify_stderr}")
  endif()
  set(LOOPZ_SHARED_ZCORE_ROOT "${ZCORE_ROOT}" CACHE PATH "Shared verified zCore" FORCE)
  set(LOOPZ_BUILD_MACOS_BACKEND OFF CACHE BOOL "" FORCE)
  set(LOOPZ_BUILD_ENGINE OFF CACHE BOOL "" FORCE)
  set(LOOPZ_BUILD_RUNTIME_LIBRARY ON CACHE BOOL "" FORCE)
  set(LOOPZ_BUILD_CONTROL_LIBRARY ON CACHE BOOL "" FORCE)
  set(LOOPZ_BUILD_LINUX_DESKTOP OFF CACHE BOOL "" FORCE)
  set(LOOPZ_BUILD_TESTS OFF CACHE BOOL "" FORCE)
  add_subdirectory(third_party/loopz)
  # The control serializer also enters Electron's shared Node-API module.
  set_target_properties(loopz_document_json PROPERTIES POSITION_INDEPENDENT_CODE YES)
  add_custom_target(singz_verify_loopz ALL
    COMMAND "${Python3_EXECUTABLE}"
      "${SINGZ_REPO_ROOT}/scripts/verify-zcore-submodule.py"
      --root "${SINGZ_REPO_ROOT}" --path third_party/loopz
    VERBATIM COMMENT "Verifying pinned LoopZ source snapshot")
  add_library(singz_box_routing OBJECT
    native/playback/loopz_source_backend.cpp
    native/playback/box_routing_owner.cpp
    native/playback/box_input_capture.cpp)
  target_compile_features(singz_box_routing PUBLIC cxx_std_20)
  target_compile_definitions(singz_box_routing PUBLIC SINGZ_BOX_LOOPZ_ROUTING=1)
  target_link_libraries(singz_box_routing PUBLIC LoopZ::Control SingZ::zcore_device)
  set_target_properties(singz_box_routing PROPERTIES POSITION_INDEPENDENT_CODE YES)
  add_dependencies(singz_box_routing singz_verify_loopz)
endif()

add_subdirectory(third_party/native)
include(cmake/SingZAppNative.cmake)
get_property(SINGZ_ZCORE_RT_MANIFEST GLOBAL PROPERTY SINGZ_ZCORE_RT_MANIFEST)
get_property(SINGZ_IOS_AUDIO_HOST_RT_MANIFEST GLOBAL PROPERTY
  SINGZ_IOS_AUDIO_HOST_RT_MANIFEST)
get_property(SINGZ_ANDROID_AUDIO_HOST_RT_MANIFEST GLOBAL PROPERTY
  SINGZ_ANDROID_AUDIO_HOST_RT_MANIFEST)
get_property(SINGZ_ZDSP_RT_MANIFEST GLOBAL PROPERTY SINGZ_ZDSP_RT_MANIFEST)

# Keep the NDK-only compile-first negative policy proof available as a named
# consumer target even when the app disables SingZ host tools and tests.
if(ANDROID)
  string(REGEX REPLACE "^android-" "" _android_fixture_api "${ANDROID_PLATFORM}")
  if(ANDROID_ABI STREQUAL "arm64-v8a")
    set(_android_fixture_target "aarch64-none-linux-android${_android_fixture_api}")
  elseif(ANDROID_ABI STREQUAL "armeabi-v7a")
    set(_android_fixture_target
      "armv7-none-linux-androideabi${_android_fixture_api}")
  elseif(ANDROID_ABI STREQUAL "x86_64")
    set(_android_fixture_target "x86_64-none-linux-android${_android_fixture_api}")
  elseif(ANDROID_ABI STREQUAL "x86")
    set(_android_fixture_target "i686-none-linux-android${_android_fixture_api}")
  else()
    message(FATAL_ERROR
      "Android AudioHost RT negative proof has no target for ${ANDROID_ABI}")
  endif()
  add_custom_target(singz_check_android_audio_host_realtime_negative
    COMMAND "${CMAKE_COMMAND}"
      "-DSINGZ_ANDROID_AUDIO_HOST_RT_MANIFEST=${SINGZ_ANDROID_AUDIO_HOST_RT_MANIFEST}"
      "-DSINGZ_ANDROID_AUDIO_HOST_RT_CHECKER=${ZCORE_ROOT}/cmake/CheckAndroidAudioHostRealtime.cmake"
      "-DSINGZ_ANDROID_AUDIO_HOST_RT_TEST_DIR=${CMAKE_CURRENT_BINARY_DIR}/android-audio-host-rt-negative"
      "-DSINGZ_ANDROID_AUDIO_HOST_RT_CXX_COMPILER=${CMAKE_CXX_COMPILER}"
      "-DSINGZ_ANDROID_AUDIO_HOST_RT_CXX_COMPILER_ID=${CMAKE_CXX_COMPILER_ID}"
      "-DSINGZ_ANDROID_AUDIO_HOST_RT_CXX_TARGET=${_android_fixture_target}"
      "-DSINGZ_ANDROID_AUDIO_HOST_RT_CXX_SYSROOT=${CMAKE_SYSROOT}"
      "-DSINGZ_ANDROID_AUDIO_HOST_RT_OBJCOPY=${CMAKE_OBJCOPY}"
      -P "${ZCORE_ROOT}/cmake/TestAndroidAudioHostRealtimePolicy.cmake"
    VERBATIM
    COMMENT "Checking Android AudioHost RT negative fixtures with NDK Clang")
endif()

# Phase iOS-B1's reusable frame-zero playback composition. The strict callback
# leaf remains separate from file decode, graph construction, host ownership
# and product bridges. Neither target is linked into a product automatically.
include("${ZCORE_ROOT}/cmake/SingZRealtimeTarget.cmake")
add_library(singz_microphone_mix STATIC
  native/playback/microphone_mix.cpp native/playback/microphone_mix.h)
target_compile_features(singz_microphone_mix PUBLIC cxx_std_20)
target_include_directories(singz_microphone_mix PUBLIC native/playback)
target_link_libraries(singz_microphone_mix PUBLIC zCore::routing SingZ::zcore_device)
set_target_properties(singz_microphone_mix PROPERTIES POSITION_INDEPENDENT_CODE YES)

add_library(singz_native_playback_callback STATIC EXCLUDE_FROM_ALL
  native/playback/native_playback_callback.cpp
  native/playback/native_playback_callback.h
  native/playback/presentation_history.cpp
  native/playback/presentation_history.h)
add_library(SingZ::native_playback_callback ALIAS
  singz_native_playback_callback)
target_compile_features(singz_native_playback_callback PUBLIC cxx_std_20)
target_include_directories(singz_native_playback_callback PUBLIC
  "${SINGZ_REPO_ROOT}/native/playback")
target_link_libraries(singz_native_playback_callback PUBLIC
  SingZ::native_build_options
  SingZ::zdsp_host_adapter)
set_target_properties(singz_native_playback_callback PROPERTIES
  POSITION_INDEPENDENT_CODE YES CXX_EXTENSIONS OFF
  CXX_VISIBILITY_PRESET hidden VISIBILITY_INLINES_HIDDEN YES)
singz_configure_realtime_target(singz_native_playback_callback)

set(SINGZ_PLAYBACK_RT_MANIFEST
  "${CMAKE_CURRENT_BINARY_DIR}/playback-realtime-sources.cmake")
set(_playback_rt_files)
foreach(_target IN ITEMS
    singz_native_playback_callback zdsp_host_adapter zdsp_runtime)
  get_target_property(_playback_rt_source_dir "${_target}" SOURCE_DIR)
  get_target_property(_playback_rt_target_sources "${_target}" SOURCES)
  foreach(_source IN LISTS _playback_rt_target_sources)
    if(IS_ABSOLUTE "${_source}")
      set(_absolute_source "${_source}")
    else()
      get_filename_component(_absolute_source "${_source}" ABSOLUTE
        BASE_DIR "${_playback_rt_source_dir}")
    endif()
    file(TO_CMAKE_PATH "${_absolute_source}" _absolute_source)
    list(APPEND _playback_rt_files "${_absolute_source}")
  endforeach()
endforeach()
list(APPEND _playback_rt_files
  "${ZCORE_ROOT}/zcore/include/zcore/device/audio_host_render.h")
list(REMOVE_DUPLICATES _playback_rt_files)
file(WRITE "${SINGZ_PLAYBACK_RT_MANIFEST}"
  "set(SINGZ_ZDSP_RT_FILES\n")
foreach(_source IN LISTS _playback_rt_files)
  file(APPEND "${SINGZ_PLAYBACK_RT_MANIFEST}"
    "  [==[${_source}]==]\n")
endforeach()
file(APPEND "${SINGZ_PLAYBACK_RT_MANIFEST}" ")\n")
add_custom_target(singz_check_playback_realtime
  COMMAND "${CMAKE_COMMAND}"
    "-DSINGZ_ZDSP_RT_MANIFEST=${SINGZ_PLAYBACK_RT_MANIFEST}"
    "-DSINGZ_ZDSP_RT_PROFILE=playback"
    -P "${ZCORE_ROOT}/cmake/CheckZdspRealtime.cmake"
  VERBATIM
  COMMENT "Checking native playback callback source policy")
add_dependencies(singz_native_playback_callback
  singz_check_playback_realtime)

# The render body lives in the header so the lifecycle owner can remain in one
# source file. Extract the complete marked leaf into the policy/strict compile
# target; changes to that header force regeneration, including policy fixtures.
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS native/playback/voice_monitor.h native/playback/voice_monitor.cpp native/playback/shared_audio_service.cpp
  third_party/zcore/zcore/platform/macos/audio_device_macos_buffer.h
  third_party/zcore/zcore/platform/macos/audio_host_macos_helpers.h)
file(READ "${SINGZ_REPO_ROOT}/native/playback/voice_monitor.h" _voice_monitor_header)
string(REGEX MATCH "// SINGZ_VOICE_MONITOR_RT_BEGIN[^@]*// SINGZ_VOICE_MONITOR_RT_END" _voice_monitor_rt "${_voice_monitor_header}")
if(NOT _voice_monitor_rt)
  message(FATAL_ERROR "Voice monitor realtime leaf markers are missing")
endif()
set(_voice_rt_source "${CMAKE_CURRENT_BINARY_DIR}/voice-monitor-render.cpp")
file(WRITE "${_voice_rt_source}" "#include <algorithm>\n#include <atomic>\n#include <bit>\n#include <cmath>\n#include <zcore/device/audio_host_render.h>\nnamespace singz {\n${_voice_monitor_rt}\n}\n")
set(SINGZ_VOICE_MONITOR_RT_MANIFEST "${CMAKE_CURRENT_BINARY_DIR}/voice-monitor-realtime.cmake")
file(WRITE "${SINGZ_VOICE_MONITOR_RT_MANIFEST}" "set(SINGZ_ZDSP_RT_FILES [==[${_voice_rt_source}]==] [==[${ZCORE_ROOT}/zcore/include/zcore/device/audio_host_render.h]==] [==[${SINGZ_REPO_ROOT}/native/playback/output_callback_diagnostics.h]==])\n")
add_library(singz_voice_monitor_render OBJECT "${_voice_rt_source}")
target_compile_features(singz_voice_monitor_render PRIVATE cxx_std_20)
target_link_libraries(singz_voice_monitor_render PRIVATE SingZ::zcore_device)
singz_configure_realtime_target(singz_voice_monitor_render)
# Compile the additional callback telemetry leaf under the same strict rules.
file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/output-callback-diagnostics-rt.cpp"
  "#include \"${SINGZ_REPO_ROOT}/native/playback/output_callback_diagnostics.h\"\nvoid checkOutputCallback(singz::OutputCallbackDiagnostics& d, const singz::AudioHostRenderBlock& b) noexcept { d.observe(b); }\n")
add_library(singz_output_callback_diagnostics_render OBJECT "${CMAKE_CURRENT_BINARY_DIR}/output-callback-diagnostics-rt.cpp")
target_compile_features(singz_output_callback_diagnostics_render PRIVATE cxx_std_20)
target_link_libraries(singz_output_callback_diagnostics_render PRIVATE SingZ::zcore_device)
singz_configure_realtime_target(singz_output_callback_diagnostics_render)
add_dependencies(singz_voice_monitor_render singz_output_callback_diagnostics_render)

# The complete service master leaf and the final callback ordering are checked
# independently of the control-domain service (which owns device locks).
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS native/playback/shared_audio_service.h)
file(READ "${SINGZ_REPO_ROOT}/native/playback/shared_audio_service.h" _service_header)
string(REGEX MATCH "// SINGZ_SERVICE_MASTER_RT_BEGIN[^@]*// SINGZ_SERVICE_MASTER_RT_END" _service_master_rt "${_service_header}")
if(NOT _service_master_rt)
  message(FATAL_ERROR "Service master realtime leaf markers are missing")
endif()
set(_master_rt_source "${CMAKE_CURRENT_BINARY_DIR}/service-master-render.cpp")
file(WRITE "${_master_rt_source}" "#include <algorithm>\n#include <atomic>\n#include <cmath>\n#include <zcore/device/audio_host_render.h>\nnamespace singz {\n${_service_master_rt}\n}\n")
file(READ "${SINGZ_REPO_ROOT}/native/playback/shared_audio_service.cpp" _master_service_text)
string(REGEX MATCH "static bool render[^@]*AudioHostResult openLocked" _service_callback "${_master_service_text}")
if(NOT _service_callback)
  message(FATAL_ERROR "Service mix callback RT extraction needs updating")
endif()
file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/service-mix-callback-rt.txt" "${_service_callback}")
set(SINGZ_SERVICE_MASTER_RT_MANIFEST "${CMAKE_CURRENT_BINARY_DIR}/service-master-realtime.cmake")
file(WRITE "${SINGZ_SERVICE_MASTER_RT_MANIFEST}" "set(SINGZ_ZDSP_RT_FILES [==[${_master_rt_source}]==] [==[${CMAKE_CURRENT_BINARY_DIR}/service-mix-callback-rt.txt]==])\n")
add_library(singz_service_master_render OBJECT "${_master_rt_source}")
target_compile_features(singz_service_master_render PRIVATE cxx_std_20)
target_link_libraries(singz_service_master_render PRIVATE SingZ::zcore_device)
singz_configure_realtime_target(singz_service_master_render)
add_custom_target(singz_check_service_master_realtime ALL
  COMMAND "${CMAKE_COMMAND}" "-DSINGZ_ZDSP_RT_MANIFEST=${SINGZ_SERVICE_MASTER_RT_MANIFEST}"
    -DSINGZ_ZDSP_RT_PROFILE=monitor -P "${ZCORE_ROOT}/cmake/CheckZdspRealtime.cmake"
  VERBATIM)
add_dependencies(singz_native_playback_callback singz_check_service_master_realtime singz_service_master_render)
add_custom_target(singz_check_voice_monitor_realtime ALL
  COMMAND "${CMAKE_COMMAND}" "-DSINGZ_ZDSP_RT_MANIFEST=${SINGZ_VOICE_MONITOR_RT_MANIFEST}"
    -DSINGZ_ZDSP_RT_PROFILE=monitor -P "${ZCORE_ROOT}/cmake/CheckZdspRealtime.cmake"
  VERBATIM)
add_library(singz_voice_monitor STATIC native/playback/voice_monitor.cpp native/playback/voice_monitor.h)
target_compile_features(singz_voice_monitor PUBLIC cxx_std_20)
target_include_directories(singz_voice_monitor PUBLIC "${SINGZ_REPO_ROOT}")
target_link_libraries(singz_voice_monitor PUBLIC SingZ::zcore_device Threads::Threads)
set_target_properties(singz_voice_monitor PROPERTIES POSITION_INDEPENDENT_CODE YES)
add_dependencies(singz_voice_monitor singz_check_voice_monitor_realtime singz_voice_monitor_render)

# WP1 capture/history publication: owning control code and a separately strict
# compiled/scanned callback leaf. The marker extraction tracks both inputs.
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
  native/playback/voice_monitor_source.h native/playback/voice_monitor_source.cpp)
file(READ "${SINGZ_REPO_ROOT}/native/playback/voice_monitor_source.h" _monitor_source_header)
file(READ "${SINGZ_REPO_ROOT}/native/playback/voice_monitor_source.cpp" _monitor_source_cpp)
foreach(_part IN ITEMS header cpp)
  string(REGEX MATCH "// SINGZ_MONITOR_SOURCE_RT_BEGIN[^@]*// SINGZ_MONITOR_SOURCE_RT_END"
    _monitor_source_rt_${_part} "${_monitor_source_${_part}}")
  if(NOT _monitor_source_rt_${_part})
    message(FATAL_ERROR "Monitor source RT ${_part} markers missing")
  endif()
  string(REGEX REPLACE "//[^\n]*" "" _monitor_source_rt_${_part} "${_monitor_source_rt_${_part}}")
endforeach()
set(_monitor_source_leaf "${CMAKE_CURRENT_BINARY_DIR}/voice-monitor-source-rt.cpp")
set(_monitor_source_api "${CMAKE_CURRENT_BINARY_DIR}/voice-monitor-source-rt-api.h")
file(WRITE "${_monitor_source_leaf}"
  "#include <algorithm>\n#include <cmath>\n#include \"${SINGZ_REPO_ROOT}/native/playback/voice_monitor_source.h\"\nnamespace singz {\n${_monitor_source_rt_cpp}\n}\n")
file(WRITE "${_monitor_source_api}" "${_monitor_source_rt_header}")
set(_monitor_source_manifest "${CMAKE_CURRENT_BINARY_DIR}/voice-monitor-source-realtime.cmake")
file(WRITE "${_monitor_source_manifest}"
  "set(SINGZ_ZDSP_RT_FILES [==[${_monitor_source_leaf}]==] [==[${_monitor_source_api}]==])\n")
add_library(singz_voice_monitor_source_rt OBJECT "${_monitor_source_leaf}")
target_compile_features(singz_voice_monitor_source_rt PRIVATE cxx_std_20)
target_link_libraries(singz_voice_monitor_source_rt PRIVATE zCore::routing SingZ::zcore_device)
singz_configure_realtime_target(singz_voice_monitor_source_rt)
add_custom_target(singz_check_voice_monitor_source_realtime
  COMMAND "${CMAKE_COMMAND}" "-DSINGZ_ZDSP_RT_MANIFEST=${_monitor_source_manifest}"
    -DSINGZ_ZDSP_RT_PROFILE=monitor -P "${ZCORE_ROOT}/cmake/CheckZdspRealtime.cmake" VERBATIM)
add_library(singz_voice_monitor_source STATIC native/playback/voice_monitor_source.cpp)
target_compile_features(singz_voice_monitor_source PUBLIC cxx_std_20)
target_include_directories(singz_voice_monitor_source PUBLIC "${SINGZ_REPO_ROOT}")
target_link_libraries(singz_voice_monitor_source PUBLIC zCore::routing SingZ::zcore_device Threads::Threads)
set_target_properties(singz_voice_monitor_source PROPERTIES POSITION_INDEPENDENT_CODE YES)
add_dependencies(singz_voice_monitor_source singz_check_voice_monitor_source_realtime singz_voice_monitor_source_rt)

# Common history monitor: strict callback compilation plus transitive source policy.
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS native/playback/voice_monitor_client.h native/playback/shared_audio_service.cpp)
file(READ "${SINGZ_REPO_ROOT}/native/playback/voice_monitor_client.h" _monitor_client_header)
string(REGEX MATCH "// SINGZ_MONITOR_CLIENT_RT_BEGIN[^@]*// SINGZ_MONITOR_CLIENT_RT_END" _monitor_client_rt "${_monitor_client_header}")
if(NOT _monitor_client_rt)
  message(FATAL_ERROR "Common monitor RT markers are missing")
endif()
set(_monitor_client_leaf "${CMAKE_CURRENT_BINARY_DIR}/voice-monitor-client-rt.cpp")
file(WRITE "${_monitor_client_leaf}" "#include \"${SINGZ_REPO_ROOT}/native/playback/voice_monitor_client.h\"\n")
set(_monitor_client_scan "${CMAKE_CURRENT_BINARY_DIR}/voice-monitor-client-rt.txt")
file(WRITE "${_monitor_client_scan}" "${_monitor_client_rt}")
set(_monitor_client_manifest "${CMAKE_CURRENT_BINARY_DIR}/voice-monitor-client-realtime.cmake")
file(WRITE "${_monitor_client_manifest}" "set(SINGZ_ZDSP_RT_FILES [==[${_monitor_client_scan}]==])\n")
add_library(singz_voice_monitor_client_rt OBJECT "${_monitor_client_leaf}")
target_compile_features(singz_voice_monitor_client_rt PRIVATE cxx_std_20)
target_link_libraries(singz_voice_monitor_client_rt PRIVATE singz_voice_monitor_source)
singz_configure_realtime_target(singz_voice_monitor_client_rt)
add_custom_target(singz_check_voice_monitor_client_realtime
  COMMAND "${CMAKE_COMMAND}" "-DSINGZ_ZDSP_RT_MANIFEST=${_monitor_client_manifest}"
    -DSINGZ_ZDSP_RT_PROFILE=monitor -P "${ZCORE_ROOT}/cmake/CheckZdspRealtime.cmake" VERBATIM)
add_library(singz_voice_monitor_client STATIC native/playback/voice_monitor_client.cpp)
target_compile_features(singz_voice_monitor_client PUBLIC cxx_std_20)
target_link_libraries(singz_voice_monitor_client PUBLIC singz_voice_monitor_source)
set_target_properties(singz_voice_monitor_client PROPERTIES POSITION_INDEPENDENT_CODE YES)
add_dependencies(singz_voice_monitor_client singz_voice_monitor_client_rt singz_check_voice_monitor_client_realtime)

add_library(singz_native_playback_session STATIC EXCLUDE_FROM_ALL
  native/playback/record_placement.cpp
  native/playback/record_placement.h
  native/playback/shared_audio_service.cpp
  native/playback/shared_audio_service.h
  native/playback/training_pcm_mixer.h
  native/playback/training_pcm_mixer.cpp
  native/playback/native_playback_graph_document.cpp
  native/playback/native_playback_graph_document.h
  native/playback/playback_cue_plan.cpp
  native/playback/playback_cue_plan.h
  native/playback/native_playback_session.cpp
  native/playback/native_playback_session.h
  native/playback/streaming_lane_feeder.cpp
  native/playback/streaming_lane_feeder.h
  native/playback/lane_measure.cpp
  native/playback/lane_measure.h)
add_library(SingZ::native_playback_session ALIAS
  singz_native_playback_session)
target_compile_features(singz_native_playback_session PUBLIC cxx_std_20)
target_include_directories(singz_native_playback_session PUBLIC
  "${SINGZ_REPO_ROOT}/native/playback")
target_link_libraries(singz_native_playback_session PUBLIC
  SingZ::native_build_options
  SingZ::native_playback_callback
  SingZ::signalsmith_time_pitch
  SingZ::zcore_media
  SingZ::zcore_device
  SingZ::zdsp_host_adapter)
set_target_properties(singz_native_playback_session PROPERTIES
  POSITION_INDEPENDENT_CODE YES CXX_EXTENSIONS OFF
  CXX_VISIBILITY_PRESET hidden VISIBILITY_INLINES_HIDDEN YES)

if(SINGZ_BOX_LOOPZ_ROUTING)
  target_link_libraries(singz_native_playback_session PUBLIC singz_box_routing)
endif()

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
    native/electron/voice_monitor_bridge.cpp
    native/electron/voice_monitor_bridge.h
    native/playback/take_conform.cpp
    native/electron/take_writer.cpp
    native/electron/take_writer.h
    native/electron/audio_export_bridge.cpp
    native/electron/audio_export_bridge.h
    native/electron/playback_addon_bridge.cpp
    native/electron/playback_addon_bridge.h
    native/electron/microphone_mix_bridge.cpp
    native/electron/training_audio_session.cpp
    native/electron/training_audio_session.h
    native/electron/native_audio_ownership.h)
  target_compile_features(singz_capture PRIVATE cxx_std_20)
  target_include_directories(singz_capture PRIVATE
    "${SINGZ_REPO_ROOT}/third_party/native/signalsmith"
    "${SINGZ_NODE_INCLUDE_DIR}"
    # Platform provider headers live under zcore/platform and intentionally
    # remain a private source-tree include for app bindings.
    "${ZCORE_ROOT}")
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
  # zcore_device and zdsp_host_adapter are omitted here: both already reach
  # this target PUBLIC through native_playback_session, and Apple's linker warns on the repeated
  # archive when they are also listed directly.
  target_link_libraries(singz_capture PRIVATE
    SingZ::native_build_options
    SingZ::zdsp_analysis
    SingZ::zcore_audio_export
    singz_microphone_mix
    singz_voice_monitor_source
    singz_voice_monitor
    singz_voice_monitor_client
    SingZ::native_playback_session
    singz_native_audio_ownership)
  if(SINGZ_BOX_LOOPZ_ROUTING)
    target_sources(singz_capture PRIVATE native/electron/box_routing_bridge.cpp)
  endif()
  set_target_properties(singz_capture PROPERTIES
    PREFIX ""
    SUFFIX ".node"
    OUTPUT_NAME "singz-capture"
    CXX_EXTENSIONS OFF
    CXX_VISIBILITY_PRESET hidden
    VISIBILITY_INLINES_HIDDEN YES)
  if(APPLE)
    target_link_libraries(singz_capture PRIVATE "-framework AVFoundation" "-lobjc")
    target_link_options(singz_capture PRIVATE "-undefined" "dynamic_lookup")
    if(SINGZ_ENABLE_FFMPEG_CODECS)
      # The verified capture snapshot owns its replaceable LGPL runtime under
      # ffmpeg/. The addon is integrity-staged with that directory intact, so
      # both development and packaged loads resolve the same relative bytes.
      set_property(TARGET singz_capture APPEND PROPERTY
        BUILD_RPATH "@loader_path/ffmpeg")
    endif()
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

# Standalone ADR 0017 measurement spike; never linked into the product.
option(SINGZ_MONITOR_SPIKE "Build the isolated monitor measurement harness" OFF)
if(SINGZ_MONITOR_SPIKE AND NOT ANDROID AND NOT IOS)
  enable_testing()
  add_subdirectory(tools/monitor-spike)
endif()


if(SINGZ_CORE_TESTS)
  enable_testing()
  add_executable(voice_monitor_source_tests tests/native/voice_monitor_source_tests.cpp
    native/electron/take_writer.cpp "${ZCORE_ROOT}/zdsp/tests/allocation_trap.cpp")
  target_compile_features(voice_monitor_source_tests PRIVATE cxx_std_20)
  target_include_directories(voice_monitor_source_tests PRIVATE "${ZCORE_ROOT}/zdsp/tests")
  target_link_libraries(voice_monitor_source_tests PRIVATE singz_voice_monitor_source)
  add_test(NAME voice_monitor_source_tests COMMAND voice_monitor_source_tests)
  add_test(NAME voice_monitor_source_realtime_source_policy
    COMMAND "${CMAKE_COMMAND}" "-DSINGZ_ZDSP_RT_MANIFEST=${_monitor_source_manifest}"
      -DSINGZ_ZDSP_RT_PROFILE=monitor -P "${ZCORE_ROOT}/cmake/CheckZdspRealtime.cmake")
  file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/voice-monitor-source-blocking.cpp"
    "${_monitor_source_rt_cpp}\nvoid blockingTap() { sleep(1); }\n")
  file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/voice-monitor-source-blocking.cmake"
    "set(SINGZ_ZDSP_RT_FILES [==[${CMAKE_CURRENT_BINARY_DIR}/voice-monitor-source-blocking.cpp]==])\n")
  add_test(NAME voice_monitor_source_negative_blocking
    COMMAND "${CMAKE_COMMAND}" "-DSINGZ_ZDSP_RT_MANIFEST=${CMAKE_CURRENT_BINARY_DIR}/voice-monitor-source-blocking.cmake"
      -DSINGZ_ZDSP_RT_PROFILE=monitor -P "${ZCORE_ROOT}/cmake/CheckZdspRealtime.cmake")
  set_tests_properties(voice_monitor_source_negative_blocking PROPERTIES WILL_FAIL TRUE)
  foreach(_mutation IN ITEMS floor delivery)
    if(_mutation STREQUAL "floor")
      set(_old "static_cast<double>(inputFloor)")
      set(_new "0.0 * static_cast<double>(inputFloor) /* deliberately omit the input-period floor */")
      set(_expected "missing==0")
    else()
      set(_old "const bool delivered = tap.delivery.pushWithPosition")
      set(_new "if (tap.monitor && input && frames) const_cast<float*>(input)[0] = -.75f;\n  const bool delivered = tap.delivery.pushWithPosition")
      set(_expected "off.bytes==on.bytes")
    endif()
    string(REPLACE "${_old}" "${_new}" _mutated "${_monitor_source_cpp}")
    if(_mutated STREQUAL _monitor_source_cpp)
      message(FATAL_ERROR "Monitor source ${_mutation} mutation did not hit")
    endif()
    set(_mutant_file "${CMAKE_CURRENT_BINARY_DIR}/voice-monitor-source-negative-${_mutation}.cpp")
    file(WRITE "${_mutant_file}" "${_mutated}")
    add_executable(voice_monitor_source_negative_${_mutation} tests/native/voice_monitor_source_tests.cpp
      "${_mutant_file}" native/electron/take_writer.cpp "${ZCORE_ROOT}/zdsp/tests/allocation_trap.cpp")
    target_compile_features(voice_monitor_source_negative_${_mutation} PRIVATE cxx_std_20)
    target_include_directories(voice_monitor_source_negative_${_mutation} PRIVATE
      "${SINGZ_REPO_ROOT}" "${SINGZ_REPO_ROOT}/native/playback" "${ZCORE_ROOT}/zdsp/tests")
    target_link_libraries(voice_monitor_source_negative_${_mutation} PRIVATE zCore::routing SingZ::zcore_device Threads::Threads)
    add_dependencies(voice_monitor_source_tests voice_monitor_source_negative_${_mutation})
    add_test(NAME voice_monitor_source_negative_${_mutation}
      COMMAND "${Python3_EXECUTABLE}" "${SINGZ_REPO_ROOT}/tools/monitor-spike/expect_failure.py"
        "$<TARGET_FILE:voice_monitor_source_negative_${_mutation}>" "${_mutation}" "${_expected}")
  endforeach()
  set_tests_properties(voice_monitor_source_tests voice_monitor_source_negative_floor
    voice_monitor_source_negative_delivery PROPERTIES TIMEOUT 120)
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
      "-DSINGZ_ZCORE_ROOT=${ZCORE_ROOT}/zcore"
      -P "${ZCORE_ROOT}/cmake/CheckZcoreBoundaries.cmake")
  add_test(NAME zcore_realtime_source_policy
    COMMAND "${CMAKE_COMMAND}"
      "-DSINGZ_ZCORE_RT_MANIFEST=${SINGZ_ZCORE_RT_MANIFEST}"
      -P "${ZCORE_ROOT}/cmake/CheckZcoreRealtime.cmake")
  add_test(NAME zcore_realtime_policy_negative
    COMMAND "${CMAKE_COMMAND}"
      "-DSINGZ_ZCORE_RT_MANIFEST=${SINGZ_ZCORE_RT_MANIFEST}"
      "-DSINGZ_ZCORE_RT_CHECKER=${ZCORE_ROOT}/cmake/CheckZcoreRealtime.cmake"
      "-DSINGZ_ZCORE_RT_TEST_DIR=${CMAKE_CURRENT_BINARY_DIR}/zcore-rt-negative"
      -P "${ZCORE_ROOT}/cmake/TestZcoreRealtimePolicy.cmake")
  add_test(NAME ios_audio_host_realtime_source_policy
    COMMAND "${CMAKE_COMMAND}"
      "-DSINGZ_IOS_AUDIO_HOST_RT_MANIFEST=${SINGZ_IOS_AUDIO_HOST_RT_MANIFEST}"
      -P "${ZCORE_ROOT}/cmake/CheckIosAudioHostRealtime.cmake")
  add_test(NAME ios_audio_host_realtime_policy_negative
    COMMAND "${CMAKE_COMMAND}"
      "-DSINGZ_IOS_AUDIO_HOST_RT_MANIFEST=${SINGZ_IOS_AUDIO_HOST_RT_MANIFEST}"
      "-DSINGZ_IOS_AUDIO_HOST_RT_CHECKER=${ZCORE_ROOT}/cmake/CheckIosAudioHostRealtime.cmake"
      "-DSINGZ_IOS_AUDIO_HOST_RT_TEST_DIR=${CMAKE_CURRENT_BINARY_DIR}/ios-audio-host-rt-negative"
      "-DSINGZ_IOS_AUDIO_HOST_RT_CXX_COMPILER=${CMAKE_CXX_COMPILER}"
      "-DSINGZ_IOS_AUDIO_HOST_RT_CXX_COMPILER_ID=${CMAKE_CXX_COMPILER_ID}"
      -P "${ZCORE_ROOT}/cmake/TestIosAudioHostRealtimePolicy.cmake")
  add_test(NAME android_audio_host_realtime_source_policy
    COMMAND "${CMAKE_COMMAND}"
      "-DSINGZ_ANDROID_AUDIO_HOST_RT_MANIFEST=${SINGZ_ANDROID_AUDIO_HOST_RT_MANIFEST}"
      -P "${ZCORE_ROOT}/cmake/CheckAndroidAudioHostRealtime.cmake")
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
        "-DSINGZ_ANDROID_AUDIO_HOST_RT_CHECKER=${ZCORE_ROOT}/cmake/CheckAndroidAudioHostRealtime.cmake"
        "-DSINGZ_ANDROID_AUDIO_HOST_RT_TEST_DIR=${CMAKE_CURRENT_BINARY_DIR}/android-audio-host-rt-negative"
        "-DSINGZ_ANDROID_AUDIO_HOST_RT_CXX_COMPILER=${CMAKE_CXX_COMPILER}"
        "-DSINGZ_ANDROID_AUDIO_HOST_RT_CXX_COMPILER_ID=${CMAKE_CXX_COMPILER_ID}"
        "-DSINGZ_ANDROID_AUDIO_HOST_RT_HEX_WRITER=$<TARGET_FILE:android_audio_host_rt_hex_writer>"
        -P "${ZCORE_ROOT}/cmake/TestAndroidAudioHostRealtimePolicy.cmake")
  endif()
  add_test(NAME zdsp_realtime_source_policy
    COMMAND "${CMAKE_COMMAND}"
      "-DSINGZ_ZDSP_RT_MANIFEST=${SINGZ_ZDSP_RT_MANIFEST}"
      -P "${ZCORE_ROOT}/cmake/CheckZdspRealtime.cmake")
  add_test(NAME playback_realtime_source_policy
    COMMAND "${CMAKE_COMMAND}"
      "-DSINGZ_ZDSP_RT_MANIFEST=${SINGZ_PLAYBACK_RT_MANIFEST}"
      "-DSINGZ_ZDSP_RT_PROFILE=playback"
      -P "${ZCORE_ROOT}/cmake/CheckZdspRealtime.cmake")
  add_test(NAME playback_realtime_policy_negative
    COMMAND "${CMAKE_COMMAND}"
      "-DSINGZ_PLAYBACK_RT_MANIFEST=${SINGZ_PLAYBACK_RT_MANIFEST}"
      "-DSINGZ_PLAYBACK_RT_CHECKER=${ZCORE_ROOT}/cmake/CheckZdspRealtime.cmake"
      "-DSINGZ_PLAYBACK_RT_TEST_DIR=${CMAKE_CURRENT_BINARY_DIR}/playback-rt-negative"
      -P "${ZCORE_ROOT}/cmake/TestPlaybackRealtimePolicy.cmake")
  add_executable(core_host_tests ${SINGZ_REPO_ROOT}/tests/native/core_host_tests.cpp)
  add_dependencies(core_host_tests singz_check_zcore_boundaries)
  target_compile_features(core_host_tests PRIVATE cxx_std_20)
  target_compile_definitions(core_host_tests PRIVATE SINGZ_CORE_TESTS=1)
  target_include_directories(core_host_tests PRIVATE
    "${ZCORE_ROOT}/zcore/src/device")
  target_link_libraries(core_host_tests PRIVATE SingZ::zcore_legacy)
  add_test(NAME core_host_tests COMMAND core_host_tests)

  add_executable(audio_input_latency_tests
    "${ZCORE_ROOT}/tests/native/audio_input_latency_tests.cpp")
  target_compile_definitions(audio_input_latency_tests PRIVATE SINGZ_CORE_TESTS=1)
  target_include_directories(audio_input_latency_tests PRIVATE "${ZCORE_ROOT}")
  target_link_libraries(audio_input_latency_tests PRIVATE SingZ::zcore_device)
  add_test(NAME audio_input_latency_tests COMMAND audio_input_latency_tests)

  add_executable(audio_host_tests
    ${SINGZ_REPO_ROOT}/tests/native/audio_host_tests.cpp)
  target_compile_features(audio_host_tests PRIVATE cxx_std_20)
  target_include_directories(audio_host_tests PRIVATE
    "${SINGZ_REPO_ROOT}" "${ZCORE_ROOT}")
  target_link_libraries(audio_host_tests PRIVATE
    SingZ::zcore_device_fake Threads::Threads)
  add_test(NAME audio_host_tests COMMAND audio_host_tests)

  if(CMAKE_SYSTEM_NAME STREQUAL "Linux" AND NOT ANDROID)
    add_executable(audio_host_linux_tests "${ZCORE_ROOT}/tests/native/audio_host_linux_tests.cpp")
    target_compile_features(audio_host_linux_tests PRIVATE cxx_std_20)
    target_compile_definitions(audio_host_linux_tests PRIVATE SINGZ_CORE_TESTS=1)
    target_include_directories(audio_host_linux_tests PRIVATE "${ZCORE_ROOT}")
    target_link_libraries(audio_host_linux_tests PRIVATE SingZ::zcore_device Threads::Threads)
    add_test(NAME audio_host_linux_tests COMMAND audio_host_linux_tests)
    set_tests_properties(audio_host_linux_tests PROPERTIES TIMEOUT 30)
  endif()

  add_executable(audio_host_ios_policy_tests
    ${SINGZ_REPO_ROOT}/tests/native/audio_host_ios_policy_tests.cpp)
  target_compile_features(audio_host_ios_policy_tests PRIVATE cxx_std_20)
  target_include_directories(audio_host_ios_policy_tests PRIVATE
    "${SINGZ_REPO_ROOT}" "${ZCORE_ROOT}")
  target_link_libraries(audio_host_ios_policy_tests PRIVATE
    SingZ::zcore_device)
  add_test(NAME audio_host_ios_policy_tests COMMAND audio_host_ios_policy_tests)

  add_executable(audio_host_android_policy_tests
    ${SINGZ_REPO_ROOT}/tests/native/audio_host_android_policy_tests.cpp)
  target_compile_features(audio_host_android_policy_tests PRIVATE cxx_std_20)
  target_include_directories(audio_host_android_policy_tests PRIVATE
    "${SINGZ_REPO_ROOT}"
    "${ZCORE_ROOT}"
    "${ZCORE_ROOT}/zcore/platform/android")
  target_link_libraries(audio_host_android_policy_tests PRIVATE
    SingZ::zcore_device)
  if(TARGET android_audio_host_rt_hex_writer)
    add_dependencies(audio_host_android_policy_tests
      android_audio_host_rt_hex_writer)
  endif()
  add_test(NAME audio_host_android_policy_tests
    COMMAND audio_host_android_policy_tests)

  add_executable(audio_input_uid_tests
    ${SINGZ_REPO_ROOT}/tests/native/audio_input_uid_tests.cpp)
  target_compile_features(audio_input_uid_tests PRIVATE cxx_std_20)
  target_include_directories(audio_input_uid_tests PRIVATE
    "${SINGZ_REPO_ROOT}" "${ZCORE_ROOT}")
  add_test(NAME audio_input_uid_tests COMMAND audio_input_uid_tests)

  if(WIN32)
    add_executable(audio_host_windows_tests
      ${SINGZ_REPO_ROOT}/tests/native/audio_host_windows_tests.cpp)
    target_compile_features(audio_host_windows_tests PRIVATE cxx_std_20)
    target_include_directories(audio_host_windows_tests PRIVATE
      "${SINGZ_REPO_ROOT}" "${ZCORE_ROOT}")
    target_link_libraries(audio_host_windows_tests PRIVATE
      SingZ::zcore_device)
    add_test(NAME audio_host_windows_tests COMMAND audio_host_windows_tests)

    add_executable(audio_host_asio_tests
      ${SINGZ_REPO_ROOT}/tests/native/audio_host_asio_tests.cpp)
    target_compile_features(audio_host_asio_tests PRIVATE cxx_std_20)
    target_include_directories(audio_host_asio_tests PRIVATE
      "${SINGZ_REPO_ROOT}" "${ZCORE_ROOT}")
    target_link_libraries(audio_host_asio_tests PRIVATE
      SingZ::zcore_device)
    add_test(NAME audio_host_asio_tests COMMAND audio_host_asio_tests)
  endif()

  add_executable(audio_host_graph_adapter_tests
    ${ZCORE_ROOT}/zdsp/tests/audio_host_graph_adapter_tests.cpp
    ${ZCORE_ROOT}/zdsp/tests/allocation_trap.cpp
    ${ZCORE_ROOT}/zdsp/tests/allocation_trap.h)
  target_compile_features(audio_host_graph_adapter_tests PRIVATE cxx_std_20)
  target_include_directories(audio_host_graph_adapter_tests PRIVATE
    "${ZCORE_ROOT}/zdsp/tests")
  if(CMAKE_CXX_COMPILER_ID STREQUAL "GNU")
    set_source_files_properties(
      "${ZCORE_ROOT}/zdsp/tests/allocation_trap.cpp" PROPERTIES
      COMPILE_OPTIONS "-Wno-mismatched-new-delete")
  endif()
  target_link_libraries(audio_host_graph_adapter_tests PRIVATE
    SingZ::zdsp_host_adapter)
  add_test(NAME audio_host_graph_adapter_tests COMMAND audio_host_graph_adapter_tests)

  add_executable(prepared_audio_tests
    ${SINGZ_REPO_ROOT}/tests/native/prepared_audio_tests.cpp
    ${ZCORE_ROOT}/zdsp/tests/allocation_trap.cpp
    ${ZCORE_ROOT}/zdsp/tests/allocation_trap.h)
  target_compile_features(prepared_audio_tests PRIVATE cxx_std_20)
  target_include_directories(prepared_audio_tests PRIVATE
    "${ZCORE_ROOT}/zdsp/tests")
  if(CMAKE_CXX_COMPILER_ID STREQUAL "GNU")
    set_source_files_properties(
      "${ZCORE_ROOT}/zdsp/tests/allocation_trap.cpp" PROPERTIES
      COMPILE_OPTIONS "-Wno-mismatched-new-delete")
  endif()
  target_link_libraries(prepared_audio_tests PRIVATE
    SingZ::zcore_media
    SingZ::zdsp_runtime)
  add_test(NAME prepared_audio_tests COMMAND prepared_audio_tests)

  # The feeder is control-domain and links the playback session target, which
  # is where it lives; the node comes with zdsp_runtime through it.
  add_executable(streaming_lane_feeder_tests
    ${SINGZ_REPO_ROOT}/tests/native/streaming_lane_feeder_tests.cpp)
  target_compile_features(streaming_lane_feeder_tests PRIVATE cxx_std_20)
  set_target_properties(streaming_lane_feeder_tests PROPERTIES CXX_EXTENSIONS OFF)
  target_link_libraries(streaming_lane_feeder_tests PRIVATE
    SingZ::native_playback_session SingZ::native_flac Threads::Threads)
  add_test(NAME streaming_lane_feeder_tests COMMAND streaming_lane_feeder_tests)

  # The desktop open's lane measure against the full decode: the same three
  # statistics the renderer used to take off Chromium's AudioBuffer, taken off
  # the file through the streaming source instead.
  add_executable(lane_measure_tests
    ${SINGZ_REPO_ROOT}/tests/native/lane_measure_tests.cpp)
  target_compile_features(lane_measure_tests PRIVATE cxx_std_20)
  set_target_properties(lane_measure_tests PROPERTIES CXX_EXTENSIONS OFF)
  target_compile_definitions(lane_measure_tests PRIVATE
    SINGZ_MP3_FIXTURE_DIR="${SINGZ_REPO_ROOT}/tests/fixtures/mp3/data")
  target_link_libraries(lane_measure_tests PRIVATE
    SingZ::native_playback_session SingZ::zcore_media SingZ::native_flac Threads::Threads)
  add_test(NAME lane_measure_tests COMMAND lane_measure_tests)

  add_executable(flac_streaming_source_tests
    ${SINGZ_REPO_ROOT}/tests/native/flac_streaming_source_tests.cpp)
  target_compile_features(flac_streaming_source_tests PRIVATE cxx_std_20)
  # native_flac too: the suite encodes its own fixtures, including shapes the
  # app's encoder cannot make (mono, and a stream that declares no length).
  target_link_libraries(flac_streaming_source_tests PRIVATE SingZ::zcore_media SingZ::native_flac Threads::Threads)
  add_test(NAME flac_streaming_source_tests COMMAND flac_streaming_source_tests)

  # The WAV half of streaming: the float lead/backing lanes every split has
  # carried since 0.23.0, compared bit for bit against prepareDecodedAudio.
  add_executable(audio_export_tests ${SINGZ_REPO_ROOT}/tests/native/audio_export_tests.cpp)
  target_compile_features(audio_export_tests PRIVATE cxx_std_20)
  target_link_libraries(audio_export_tests PRIVATE SingZ::zcore_audio_export)
  add_test(NAME audio_export_tests COMMAND audio_export_tests)

  add_executable(wav_streaming_source_tests
    ${SINGZ_REPO_ROOT}/tests/native/wav_streaming_source_tests.cpp)
  target_compile_features(wav_streaming_source_tests PRIVATE cxx_std_20)
  set_target_properties(wav_streaming_source_tests PROPERTIES CXX_EXTENSIONS OFF)
  target_link_libraries(wav_streaming_source_tests PRIVATE SingZ::zcore_media)
  add_test(NAME wav_streaming_source_tests COMMAND wav_streaming_source_tests)

  # Native MP3: the whole-file decode against committed FFmpeg references, and
  # the streaming source against that decode bit for bit at every seek.
  add_executable(mp3_decoder_tests
    ${SINGZ_REPO_ROOT}/tests/native/mp3_decoder_tests.cpp)
  target_compile_features(mp3_decoder_tests PRIVATE cxx_std_20)
  set_target_properties(mp3_decoder_tests PROPERTIES CXX_EXTENSIONS OFF)
  target_compile_definitions(mp3_decoder_tests PRIVATE
    SINGZ_MP3_FIXTURE_DIR="${SINGZ_REPO_ROOT}/tests/fixtures/mp3/data"
    SINGZ_CODEC_FIXTURE_DIR="${SINGZ_REPO_ROOT}/tests/fixtures/codecs/data")
  target_link_libraries(mp3_decoder_tests PRIVATE SingZ::zcore_media)
  add_test(NAME mp3_decoder_tests COMMAND mp3_decoder_tests)

  add_executable(flac_streaming_benchmark
    ${SINGZ_REPO_ROOT}/tests/native/flac_streaming_benchmark.cpp)
  target_compile_features(flac_streaming_benchmark PRIVATE cxx_std_20)
  target_link_libraries(flac_streaming_benchmark PRIVATE SingZ::zcore_media)

  add_executable(codec_provisioning_tests
    ${SINGZ_REPO_ROOT}/tests/native/codec_provisioning_tests.cpp)
  target_compile_features(codec_provisioning_tests PRIVATE cxx_std_20)
  target_link_libraries(codec_provisioning_tests PRIVATE SingZ::zcore_media)
  add_test(NAME codec_provisioning_tests COMMAND codec_provisioning_tests)

  add_executable(native_audio_ownership_tests
    ${SINGZ_REPO_ROOT}/zdsp/tests/native_audio_ownership_tests.cpp)
  target_compile_features(native_audio_ownership_tests PRIVATE cxx_std_20)
  target_link_libraries(native_audio_ownership_tests PRIVATE
    singz_native_audio_ownership Threads::Threads)
  add_test(NAME native_audio_ownership_tests COMMAND native_audio_ownership_tests)

  add_executable(microphone_mix_tests
    tests/native/microphone_mix_tests.cpp native/playback/shared_audio_service.cpp)
  target_compile_features(microphone_mix_tests PRIVATE cxx_std_20)
  target_include_directories(microphone_mix_tests PRIVATE "${SINGZ_REPO_ROOT}")
  target_link_libraries(microphone_mix_tests PRIVATE singz_microphone_mix Threads::Threads)
  add_test(NAME microphone_mix_tests COMMAND microphone_mix_tests)

  add_executable(voice_monitor_tests tests/native/voice_monitor_tests.cpp native/playback/shared_audio_service.cpp)
  target_compile_features(voice_monitor_tests PRIVATE cxx_std_20)
  target_link_libraries(voice_monitor_tests PRIVATE singz_voice_monitor Threads::Threads)
  add_test(NAME voice_monitor_tests COMMAND voice_monitor_tests)
  # Compile each deliberate fault into the real leaf/lifecycle, then run the
  # identical behavior suite. Expected failure proves the checks are sensitive.
  file(READ "${SINGZ_REPO_ROOT}/native/playback/voice_monitor.cpp" _voice_monitor_control)
  foreach(_mutant IN ITEMS ramp clamp limiter finite timestamp xrun mono route buffer steps generation lost song gain latency fade
      song_optin suitability latency_suitability provider_error sanitized denormal denormal_output route_fade route_reason environments guard_box guard_mix guard_owner inventory settle all_outputs output_map input_channel input_range stale_song_period native_route_state current_native_route monitor_writer monitor_ceiling monitor_capacity retained_reopen idle_monitor_hold idle_song_hold idle_adopt_period browser_route idle_begin idle_late_registration output_choice_identity output_choice_usable output_choice_outputs independent_monitor_output other_song_buffer pinned_monitor_pair)
    if((_mutant STREQUAL "song_optin" OR _mutant STREQUAL "stale_song_period" OR _mutant STREQUAL "steps" OR _mutant STREQUAL "retained_reopen") AND NOT APPLE)
      continue() # This opt-in policy is macOS-only.
    endif()
    set(_header "${_voice_monitor_header}")
    set(_control "${_voice_monitor_control}")
    set(_service_source "${SINGZ_REPO_ROOT}/native/playback/shared_audio_service.cpp")
    file(READ "${_service_source}" _service_original)
    set(_service "${_service_original}")
    if(_mutant STREQUAL "ramp")
      string(REPLACE "kVoiceMonitorRampFrames = 128" "kVoiceMonitorRampFrames = 1" _header "${_header}")
    elseif(_mutant STREQUAL "clamp")
      string(REPLACE "0.8912509381337456f" "1.0f" _header "${_header}")
    elseif(_mutant STREQUAL "limiter")
      string(REPLACE "return std::clamp(scaled, -double(kVoiceMonitorCeiling), double(kVoiceMonitorCeiling));" "return scaled;" _header "${_header}")
    elseif(_mutant STREQUAL "finite")
      string(REPLACE "valid && std::isfinite(block.input[0][frame])" "valid" _header "${_header}")
    elseif(_mutant STREQUAL "timestamp")
      string(REPLACE "block.inputTimestampHardware &&" "true &&" _header "${_header}")
    elseif(_mutant STREQUAL "xrun")
      string(REPLACE "AudioHostDiscontinuityXRun |" "0u |" _header "${_header}")
    elseif(_mutant STREQUAL "mono")
      string(REPLACE "selected ? voice : 0.0f" "selected && channel == 0 ? voice : 0.0f" _header "${_header}")
    elseif(_mutant STREQUAL "route")
      string(REPLACE "switch (input->transport)" "switch (input->label == \"AirPods\" ? AudioHostTransport::Bluetooth : input->transport)" _control "${_control}")
    elseif(_mutant STREQUAL "buffer")
      string(REPLACE "if (!chooseMonitorBufferFrames(" "if (false && !chooseMonitorBufferFrames(" _control "${_control}")
    elseif(_mutant STREQUAL "steps")
      string(REPLACE "frames*=2" "frames=512" _service "${_service}")
    elseif(_mutant STREQUAL "gain")
      string(REPLACE "std::clamp(gain,kVoiceMonitorGainMinDb,kVoiceMonitorGainMaxDb)" "gain" _control "${_control}")
    elseif(_mutant STREQUAL "latency")
      string(REPLACE "uint64_t(result.bufferFrames)*2" "uint64_t(result.bufferFrames)" _control "${_control}")
    elseif(_mutant STREQUAL "fade")
      string(REPLACE "if (running && ramp)" "if (false && running && ramp)" _control "${_control}")
    elseif(_mutant STREQUAL "song_optin")
      file(READ "${_service_source}" _service)
      string(REPLACE "config.allowSharedDeviceBufferChange = true;" "config.allowSharedDeviceBufferChange = config.requestedBufferFrames == 0;" _service "${_service}")
      set(_service_source "${CMAKE_CURRENT_BINARY_DIR}/voice-monitor-negative-${_mutant}/shared_audio_service.cpp")
    elseif(_mutant STREQUAL "stale_song_period")
      file(READ "${_service_source}" _service)
      string(REPLACE "currentBufferConfig.requestedBufferFrames = 0;" "currentBufferConfig.requestedBufferFrames = config.requestedBufferFrames;" _service "${_service}")
      set(_service_source "${CMAKE_CURRENT_BINARY_DIR}/voice-monitor-negative-${_mutant}/shared_audio_service.cpp")
    elseif(_mutant STREQUAL "suitability")
      string(REPLACE "if (input->monitoringSuitability==AudioHostMonitoringSuitability::Unsupported)" "if (false)" _control "${_control}")
    elseif(_mutant STREQUAL "latency_suitability")
      string(REPLACE "if (input->monitoringSuitability==AudioHostMonitoringSuitability::HighLatency)" "if (false)" _control "${_control}")
    elseif(_mutant STREQUAL "provider_error")
      string(REPLACE "periodTooLarge ? \"route-latency\" : \"error\"" "\"route-latency\"" _control "${_control}")
    elseif(_mutant STREQUAL "sanitized")
      string(REPLACE "result.error=periodTooLarge ? \"Monitor buffer exceeds the supported limit\" : \"Native voice monitor could not start\"" "result.error=opened.message" _control "${_control}")
    elseif(_mutant STREQUAL "denormal")
      string(REPLACE "return (std::bit_cast<uint32_t>(sample) & 0x7f800000u) == 0 ? 0.0f : sample;" "return sample;" _header "${_header}")
    elseif(_mutant STREQUAL "denormal_output")
      string(REPLACE "std::abs(scaled) < 0x1p-126" "false" _header "${_header}")
    elseif(_mutant STREQUAL "route_fade")
      string(REPLACE "void VoiceMonitorHost::routeChanged() {\n  impl_->stop(true);" "void VoiceMonitorHost::routeChanged() {\n  impl_->stop(false);" _control "${_control}")
    elseif(_mutant STREQUAL "route_reason")
      string(REPLACE "impl_->lost=true;" "impl_->lost=false;" _control "${_control}")
    elseif(_mutant STREQUAL "environments")
      string(REPLACE "references_ != 0 && --references_ == 0" "references_ != 0 && (--references_, true)" _header "${_header}")
    elseif(_mutant STREQUAL "guard_box")
      string(REPLACE "!boxOwnsCapture && !micMixActive && ownerSupported" "!micMixActive && ownerSupported" _header "${_header}")
    elseif(_mutant STREQUAL "guard_mix")
      string(REPLACE "!boxOwnsCapture && !micMixActive && ownerSupported" "!boxOwnsCapture && ownerSupported" _header "${_header}")
    elseif(_mutant STREQUAL "guard_owner")
      string(REPLACE "!boxOwnsCapture && !micMixActive && ownerSupported" "!boxOwnsCapture && !micMixActive" _header "${_header}")
    elseif(_mutant STREQUAL "inventory")
      string(REPLACE "  const auto route=classifyVoiceMonitorRoute(inventory" "  (void)self.host.enumerate();\n  const auto route=classifyVoiceMonitorRoute(inventory" _control "${_control}")
    elseif(_mutant STREQUAL "settle")
      string(REPLACE "kVoiceMonitorSettleWaitMs = 25" "kVoiceMonitorSettleWaitMs = 250" _header "${_header}")
    elseif(_mutant STREQUAL "all_outputs")
      string(REPLACE "selected ? voice : 0.0f" "voice" _header "${_header}")
    elseif(_mutant STREQUAL "output_map")
      string(REPLACE "config.outputChannels=physicalOutputs;" "config.outputChannels={0,1};" _control "${_control}")
    elseif(_mutant STREQUAL "input_channel")
      string(REPLACE "config.inputChannels={channel};" "config.inputChannels={0};" _control "${_control}")
    elseif(_mutant STREQUAL "input_range")
      string(REPLACE "if (channel>=input->inputChannels)" "if (false)" _control "${_control}")
    elseif(_mutant STREQUAL "monitor_writer")
      string(REPLACE "config.requestedBufferFrames=frames;" "config.requestedBufferFrames=target;" _control "${_control}")
    elseif(_mutant STREQUAL "monitor_capacity")
      string(REPLACE "config.maximumFrames=kAudioHostMaxFrames;" "config.maximumFrames=maximum;" _control "${_control}")
    elseif(_mutant STREQUAL "monitor_ceiling")
      string(REPLACE "config.maximumAcceptableBufferFrames=maximum;" "config.maximumAcceptableBufferFrames=0;" _control "${_control}")
    elseif(_mutant STREQUAL "retained_reopen")
      string(REPLACE "if (monitorBufferHeld && samePhysical" "if (false && monitorBufferHeld && samePhysical" _service "${_service}")
    elseif(_mutant STREQUAL "output_choice_identity")
      string(REPLACE "if (device.uid==output)" "if (device.label==output)" _control "${_control}")
    elseif(_mutant STREQUAL "output_choice_usable")
      string(REPLACE "device.label,eligibility.available,eligibility.reason" "device.label,true,eligibility.reason" _control "${_control}")
    elseif(_mutant STREQUAL "output_choice_outputs")
      string(REPLACE "if (!device.outputChannels) continue;" "if (false) continue;" _control "${_control}")
    elseif(_mutant STREQUAL "independent_monitor_output")
      string(REPLACE "impl_->songOutputCurrent && !independent" "impl_->songOutputCurrent" _service "${_service}")
    elseif(_mutant STREQUAL "pinned_monitor_pair")
      string(REPLACE "if (independent) {" "if (false) {" _service "${_service}")
    elseif(_mutant STREQUAL "other_song_buffer")
      string(REPLACE "songService->activeOutputUid()==uid &&" "" _control "${_control}")
    elseif(_mutant STREQUAL "idle_late_registration")
      string(REPLACE "    if (songService) self.outputUse=songService->retainVoiceMonitorOutput(config);" "" _control "${_control}")
      string(REPLACE "        self.requested=target; self.latency=latencyOf(status,target);" "        self.requested=target; self.latency=latencyOf(status,target);\n        if (songService) self.outputUse=songService->retainVoiceMonitorOutput(config);" _control "${_control}")
    elseif(_mutant STREQUAL "idle_begin")
      string(REPLACE "  if (!songOpen) frames=" "  if (!songOpen) return result;\n  if (!songOpen) frames=" _control "${_control}")
    elseif(_mutant STREQUAL "idle_monitor_hold")
      string(REPLACE "config.holdSharedDeviceBuffer=true;" "config.holdSharedDeviceBuffer=false;" _control "${_control}")
    elseif(_mutant STREQUAL "idle_song_hold")
      string(REPLACE "config_.holdSharedDeviceBuffer = provider_ == \"coreaudio\";" "config_.holdSharedDeviceBuffer = false;" _service "${_service}")
    elseif(_mutant STREQUAL "idle_adopt_period")
      string(REPLACE "actualConfig.requestedBufferFrames = 0;" "actualConfig.requestedBufferFrames = config.requestedBufferFrames;" _service "${_service}")
    elseif(_mutant STREQUAL "browser_route")
      string(REPLACE "return !playing || browserUid.empty() || browserUid==monitorUid;" "return true;" _header "${_header}")
    elseif(_mutant STREQUAL "current_native_route")
      string(REPLACE "currentSongOutput && provider" "provider" _header "${_header}")
    elseif(_mutant STREQUAL "native_route_state")
      string(REPLACE "provider==\"coreaudio\" && !config.outputDeviceUid.empty()"
        "provider==\"coreaudio\" && !config.outputDeviceUid.empty() && (status.state==AudioHostState::Open || status.state==AudioHostState::Running || status.state==AudioHostState::Suspended)"
        _header "${_header}")
    elseif(_mutant STREQUAL "generation")
      string(REPLACE "generation!=impl_->generation" "false" _control "${_control}")
    elseif(_mutant STREQUAL "lost")
      string(REPLACE "self.lost=status.state==AudioHostState::DeviceLost || status.terminalReason==AudioHostTerminalReason::DeviceLost" "self.lost=false" _control "${_control}")
    elseif(_mutant STREQUAL "song")
      string(REPLACE "  self.stop(true); self.generation=generation;" "  sharedAudioService().shutdown(); self.stop(true); self.generation=generation;" _control "${_control}")
      string(PREPEND _control "#include \"native/playback/shared_audio_service.h\"\n")
    endif()
    # A stale mutant (its target text edited away) would be byte-identical and silently pass.
    if(_header STREQUAL _voice_monitor_header AND _control STREQUAL _voice_monitor_control AND _service STREQUAL _service_original)
      message(FATAL_ERROR "voice_monitor negative control '${_mutant}' no longer changes any source; update its REPLACE text")
    endif()
    set(_dir "${CMAKE_CURRENT_BINARY_DIR}/voice-monitor-negative-${_mutant}")
    file(MAKE_DIRECTORY "${_dir}")
    if(NOT _service STREQUAL _service_original)
      set(_service_source "${_dir}/shared_audio_service.cpp")
      file(WRITE "${_service_source}" "${_service}")
    endif()
    file(WRITE "${_dir}/voice_monitor.h" "${_header}")
    file(WRITE "${_dir}/voice_monitor.cpp" "${_control}")
    add_executable(voice_monitor_negative_${_mutant}
      tests/native/voice_monitor_tests.cpp "${_dir}/voice_monitor.cpp" "${_service_source}")
    target_compile_features(voice_monitor_negative_${_mutant} PRIVATE cxx_std_20)
    target_compile_definitions(voice_monitor_negative_${_mutant} PRIVATE VOICE_MONITOR_HEADER="${_dir}/voice_monitor.h")
    target_include_directories(voice_monitor_negative_${_mutant} PRIVATE "${SINGZ_REPO_ROOT}" "${SINGZ_REPO_ROOT}/native/playback")
    target_link_libraries(voice_monitor_negative_${_mutant} PRIVATE SingZ::zcore_device Threads::Threads)
    add_dependencies(voice_monitor_tests voice_monitor_negative_${_mutant})
    add_test(NAME voice_monitor_negative_${_mutant} COMMAND voice_monitor_negative_${_mutant})
    set_tests_properties(voice_monitor_negative_${_mutant} PROPERTIES WILL_FAIL TRUE)
  endforeach()
  if(APPLE)
    add_executable(voice_monitor_negative_restore_on_stop tests/native/voice_monitor_tests.cpp native/playback/shared_audio_service.cpp)
    target_compile_features(voice_monitor_negative_restore_on_stop PRIVATE cxx_std_20)
    target_compile_definitions(voice_monitor_negative_restore_on_stop PRIVATE VOICE_MONITOR_RESTORE_ON_STOP=1)
    target_link_libraries(voice_monitor_negative_restore_on_stop PRIVATE singz_voice_monitor Threads::Threads)
    add_dependencies(voice_monitor_tests voice_monitor_negative_restore_on_stop)
    add_test(NAME voice_monitor_negative_restore_on_stop COMMAND voice_monitor_negative_restore_on_stop)
    set_tests_properties(voice_monitor_negative_restore_on_stop PROPERTIES WILL_FAIL TRUE)
  endif()
  # Compile regressions against deliberately broken copies of the REAL zCore
  # seams; do not edit the pinned submodule. Same parent behavior suite must fail.
  foreach(_seam IN ITEMS restore_capacity restore_external redundant_notification)
    if(NOT APPLE)
      continue() # Shared CoreAudio parent sequences are macOS-only.
    endif()
    set(_dir "${CMAKE_CURRENT_BINARY_DIR}/voice-monitor-negative-${_seam}")
    file(MAKE_DIRECTORY "${_dir}")
    if(_seam STREQUAL "redundant_notification")
      file(READ "${ZCORE_ROOT}/zcore/platform/macos/audio_host_macos_helpers.h" _original)
      string(REPLACE "return !readable || !same ? kMacAudioHostFormatChanged : 0u;"
        "(void)readable; (void)same; return kMacAudioHostFormatChanged;" _fault "${_original}")
      set(_definition VOICE_MONITOR_MAC_HELPERS_HEADER)
    else()
      file(READ "${ZCORE_ROOT}/zcore/platform/macos/audio_device_macos_buffer.h" _original)
      if(_seam STREQUAL "restore_capacity")
        # Old behavior: wait for even a capacity-only song lease to close.
        string(REPLACE "if (owner.second.changed || owner.second.hold) return AudioBufferWarningNone;"
          "{ (void)owner; return AudioBufferWarningNone; }" _fault "${_original}")
      else()
        # Ignore the external-value guard: even a CAS failure must not be
        # misreported as restoration or lose the new baseline for re-arm.
        string(REPLACE "} else if (current != entry.lastWritten) {"
          "} else if (false) {" _fault "${_original}")
      endif()
      set(_definition VOICE_MONITOR_BUFFER_HEADER)
    endif()
    if(_fault STREQUAL _original)
      message(FATAL_ERROR "Voice monitor zCore seam negative control ${_seam} needs updating")
    endif()
    file(WRITE "${_dir}/seam.h" "${_fault}")
    add_executable(voice_monitor_negative_${_seam}
      tests/native/voice_monitor_tests.cpp native/playback/shared_audio_service.cpp)
    target_compile_features(voice_monitor_negative_${_seam} PRIVATE cxx_std_20)
    target_compile_definitions(voice_monitor_negative_${_seam} PRIVATE ${_definition}="${_dir}/seam.h")
    target_link_libraries(voice_monitor_negative_${_seam} PRIVATE singz_voice_monitor Threads::Threads)
    add_dependencies(voice_monitor_tests voice_monitor_negative_${_seam})
    add_test(NAME voice_monitor_negative_${_seam} COMMAND voice_monitor_negative_${_seam})
    set_tests_properties(voice_monitor_negative_${_seam} PROPERTIES WILL_FAIL TRUE)
  endforeach()
  add_test(NAME voice_monitor_realtime_source_policy
    COMMAND "${CMAKE_COMMAND}" "-DSINGZ_ZDSP_RT_MANIFEST=${SINGZ_VOICE_MONITOR_RT_MANIFEST}"
      -DSINGZ_ZDSP_RT_PROFILE=monitor -P "${ZCORE_ROOT}/cmake/CheckZdspRealtime.cmake")
  file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/voice-monitor-rt-negative.cpp"
    "#include <algorithm>\n#include <atomic>\n#include <bit>\n#include <cmath>\n#include <mutex>\n#include <zcore/device/audio_host_render.h>\nnamespace singz {\n${_voice_monitor_rt}\nstd::mutex forbidden;\n}\n")
  add_library(voice_monitor_rt_negative_fixture OBJECT EXCLUDE_FROM_ALL "${CMAKE_CURRENT_BINARY_DIR}/voice-monitor-rt-negative.cpp")
  target_compile_features(voice_monitor_rt_negative_fixture PRIVATE cxx_std_20)
  target_link_libraries(voice_monitor_rt_negative_fixture PRIVATE SingZ::zcore_device)
  add_dependencies(voice_monitor_tests voice_monitor_rt_negative_fixture)
  file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/voice-monitor-rt-negative.cmake"
    "set(SINGZ_ZDSP_RT_FILES [==[${CMAKE_CURRENT_BINARY_DIR}/voice-monitor-rt-negative.cpp]==])\n")
  add_test(NAME voice_monitor_realtime_policy_negative
    COMMAND "${CMAKE_COMMAND}" "-DSINGZ_ZDSP_RT_MANIFEST=${CMAKE_CURRENT_BINARY_DIR}/voice-monitor-rt-negative.cmake"
      -DSINGZ_ZDSP_RT_PROFILE=monitor -P "${ZCORE_ROOT}/cmake/CheckZdspRealtime.cmake")
  set_tests_properties(voice_monitor_realtime_policy_negative PROPERTIES WILL_FAIL TRUE)

  add_executable(voice_monitor_client_tests tests/native/voice_monitor_client_tests.cpp native/playback/shared_audio_service.cpp
    "${ZCORE_ROOT}/zdsp/tests/allocation_trap.cpp")
  target_compile_features(voice_monitor_client_tests PRIVATE cxx_std_20)
  target_include_directories(voice_monitor_client_tests PRIVATE "${ZCORE_ROOT}/zdsp/tests")
  target_link_libraries(voice_monitor_client_tests PRIVATE singz_voice_monitor_client)
  add_test(NAME voice_monitor_client_tests COMMAND voice_monitor_client_tests)
  add_test(NAME voice_monitor_client_realtime_source_policy COMMAND "${CMAKE_COMMAND}"
    "-DSINGZ_ZDSP_RT_MANIFEST=${_monitor_client_manifest}" -DSINGZ_ZDSP_RT_PROFILE=monitor
    -P "${ZCORE_ROOT}/cmake/CheckZdspRealtime.cmake")

  file(READ "${SINGZ_REPO_ROOT}/native/playback/shared_audio_service.cpp" _client_service)
  string(REPLACE "    self.master.process(block);\n" "" _client_after_master "${_client_service}")
  if(_client_after_master STREQUAL _client_service)
    message(FATAL_ERROR "Common monitor after-master mutant did not remove the final master")
  endif()
  set(_client_before_monitor "${_client_after_master}")
  string(REPLACE "      AudioInputCallbackScope scope(self.monitor.gate);"
    "      self.master.process(block);\n      AudioInputCallbackScope scope(self.monitor.gate);"
    _client_after_master "${_client_after_master}")
  if(_client_after_master STREQUAL _client_before_monitor)
    message(FATAL_ERROR "Common monitor after-master mutant did not insert a master before voice")
  endif()
  file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/monitor-after-master.cpp" "${_client_after_master}")
  add_executable(voice_monitor_client_negative_after_master tests/native/voice_monitor_client_tests.cpp
    "${CMAKE_CURRENT_BINARY_DIR}/monitor-after-master.cpp" "${ZCORE_ROOT}/zdsp/tests/allocation_trap.cpp")
  target_compile_features(voice_monitor_client_negative_after_master PRIVATE cxx_std_20)
  target_include_directories(voice_monitor_client_negative_after_master PRIVATE
    "${ZCORE_ROOT}/zdsp/tests" "${SINGZ_REPO_ROOT}/native/playback")
  target_link_libraries(voice_monitor_client_negative_after_master PRIVATE singz_voice_monitor_client)
  add_dependencies(voice_monitor_client_tests voice_monitor_client_negative_after_master)
  add_test(NAME voice_monitor_client_negative_after_master COMMAND voice_monitor_client_negative_after_master)
  set_tests_properties(voice_monitor_client_negative_after_master PROPERTIES WILL_FAIL TRUE)
  string(REPLACE "    if (training.render || microphone.render) return;\n" ""
    _client_early_handback "${_client_service}")
  if(_client_early_handback STREQUAL _client_service)
    message(FATAL_ERROR "Common monitor cue-handback mutant no longer changes source")
  endif()
  file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/monitor-early-handback.cpp" "${_client_early_handback}")
  add_executable(voice_monitor_client_negative_cue_handback tests/native/voice_monitor_client_tests.cpp
    "${CMAKE_CURRENT_BINARY_DIR}/monitor-early-handback.cpp" "${ZCORE_ROOT}/zdsp/tests/allocation_trap.cpp")
  target_compile_features(voice_monitor_client_negative_cue_handback PRIVATE cxx_std_20)
  target_include_directories(voice_monitor_client_negative_cue_handback PRIVATE
    "${ZCORE_ROOT}/zdsp/tests" "${SINGZ_REPO_ROOT}/native/playback")
  target_link_libraries(voice_monitor_client_negative_cue_handback PRIVATE singz_voice_monitor_client)
  add_dependencies(voice_monitor_client_tests voice_monitor_client_negative_cue_handback)
  add_test(NAME voice_monitor_client_negative_cue_handback COMMAND voice_monitor_client_negative_cue_handback)
  set_tests_properties(voice_monitor_client_negative_cue_handback PROPERTIES WILL_FAIL TRUE)
  file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/monitor-client-forbidden.txt" "${_monitor_client_rt}\nstd::mutex forbidden;\n")
  file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/monitor-client-forbidden.cmake"
    "set(SINGZ_ZDSP_RT_FILES [==[${CMAKE_CURRENT_BINARY_DIR}/monitor-client-forbidden.txt]==])\n")
  add_test(NAME voice_monitor_client_negative_rt COMMAND "${CMAKE_COMMAND}"
    "-DSINGZ_ZDSP_RT_MANIFEST=${CMAKE_CURRENT_BINARY_DIR}/monitor-client-forbidden.cmake"
    -DSINGZ_ZDSP_RT_PROFILE=monitor -P "${ZCORE_ROOT}/cmake/CheckZdspRealtime.cmake")
  set_tests_properties(voice_monitor_client_negative_rt PROPERTIES WILL_FAIL TRUE)

  add_executable(voice_monitor_client_clock_tests tests/native/voice_monitor_client_clock_tests.cpp)
  target_compile_features(voice_monitor_client_clock_tests PRIVATE cxx_std_20)
  target_link_libraries(voice_monitor_client_clock_tests PRIVATE singz_voice_monitor_client)
  add_test(NAME voice_monitor_client_clock_tests COMMAND voice_monitor_client_clock_tests)
  add_test(NAME voice_monitor_client_negative_clock COMMAND voice_monitor_client_clock_tests negative)
  set_tests_properties(voice_monitor_client_negative_clock PROPERTIES WILL_FAIL TRUE)
  set_tests_properties(voice_monitor_client_clock_tests PROPERTIES TIMEOUT 240)
  # Four ten-minute clock cases run in optimized Release. Instrumented builds
  # exercise the same clock/callback paths for ten virtual seconds per case.
  if(CMAKE_CXX_FLAGS MATCHES "-fsanitize")
    set_tests_properties(voice_monitor_client_clock_tests voice_monitor_client_negative_clock
      PROPERTIES ENVIRONMENT "SINGZ_MONITOR_CLOCK_SECONDS=10")
  endif()

  add_executable(shared_audio_service_tests
    native/playback/shared_audio_service.cpp
    tests/native/shared_audio_service_tests.cpp)
  target_compile_features(shared_audio_service_tests PRIVATE cxx_std_20)
  target_include_directories(shared_audio_service_tests PRIVATE "${SINGZ_REPO_ROOT}")
  target_link_libraries(shared_audio_service_tests PRIVATE SingZ::zcore_device Threads::Threads)
  add_test(NAME shared_audio_service_tests COMMAND shared_audio_service_tests)

  foreach(_master_variant IN ITEMS tests negative_bypass negative_limiter negative_latency)
    set(_master_source "${SINGZ_REPO_ROOT}/native/playback/shared_audio_service.cpp")
    if(NOT _master_variant STREQUAL "tests")
      set(_master_mutant "${_master_service_text}")
      if(_master_variant STREQUAL "negative_bypass")
        string(REPLACE "    {\n      AudioInputCallbackScope scope(self.microphone.gate);"
          "    self.master.process(block);\n    {\n      AudioInputCallbackScope scope(self.microphone.gate);" _master_mutant "${_master_mutant}")
        string(REPLACE "    self.master.process(block);\n    self.frames.fetch_add" "    self.frames.fetch_add" _master_mutant "${_master_mutant}")
      elseif(_master_variant STREQUAL "negative_limiter")
        # Compile a mutated copy of the complete actual leaf, not a fake DSP.
        string(REPLACE "std::clamp(\n            scaled, -double(kServiceMasterCeiling), double(kServiceMasterCeiling))" "scaled" _master_header "${_service_header}")
        if(_master_header STREQUAL _service_header)
          message(FATAL_ERROR "Service master limiter negative control needs updating")
        endif()
        file(MAKE_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/service-master-negative-limiter")
        file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/service-master-negative-limiter/shared_audio_service.h" "${_master_header}")
      else()
        string(REPLACE "    auto result = service_.status();" "    auto result = service_.status();\n    result.latency.outputDeviceFrames += 128;" _master_mutant "${_master_mutant}")
      endif()
      if(NOT _master_variant STREQUAL "negative_limiter" AND _master_mutant STREQUAL _master_service_text)
        message(FATAL_ERROR "Service master ${_master_variant} negative control needs updating")
      endif()
      set(_master_dir "${CMAKE_CURRENT_BINARY_DIR}/service-master-${_master_variant}")
      file(MAKE_DIRECTORY "${_master_dir}")
      set(_master_source "${_master_dir}/shared_audio_service.cpp")
      file(WRITE "${_master_source}" "${_master_mutant}")
      if(_master_variant STREQUAL "negative_limiter")
        file(COPY "${CMAKE_CURRENT_BINARY_DIR}/service-master-negative-limiter/shared_audio_service.h" DESTINATION "${_master_dir}")
      endif()
    endif()
    add_executable(service_master_${_master_variant} "${_master_source}" tests/native/service_master_stage_tests.cpp "${ZCORE_ROOT}/zdsp/tests/allocation_trap.cpp")
    target_compile_features(service_master_${_master_variant} PRIVATE cxx_std_20)
    target_include_directories(service_master_${_master_variant} PRIVATE "${SINGZ_REPO_ROOT}" "${SINGZ_REPO_ROOT}/native/playback" "${ZCORE_ROOT}/zdsp/tests")
    target_link_libraries(service_master_${_master_variant} PRIVATE SingZ::zcore_device Threads::Threads)
    add_test(NAME service_master_${_master_variant} COMMAND service_master_${_master_variant})
    if(NOT _master_variant STREQUAL "tests")
      set_tests_properties(service_master_${_master_variant} PROPERTIES WILL_FAIL TRUE)
      add_dependencies(service_master_tests service_master_${_master_variant})
    endif()
  endforeach()
  add_test(NAME service_master_realtime_source_policy COMMAND "${CMAKE_COMMAND}" "-DSINGZ_ZDSP_RT_MANIFEST=${SINGZ_SERVICE_MASTER_RT_MANIFEST}" -DSINGZ_ZDSP_RT_PROFILE=monitor -P "${ZCORE_ROOT}/cmake/CheckZdspRealtime.cmake")
  file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/service-master-rt-negative.cpp" "#include <algorithm>\n#include <atomic>\n#include <cmath>\n#include <mutex>\n#include <zcore/device/audio_host_render.h>\nnamespace singz {\n${_service_master_rt}\nstd::mutex forbidden;\n}\n")
  add_library(service_master_rt_negative_fixture OBJECT EXCLUDE_FROM_ALL "${CMAKE_CURRENT_BINARY_DIR}/service-master-rt-negative.cpp")
  target_compile_features(service_master_rt_negative_fixture PRIVATE cxx_std_20)
  target_link_libraries(service_master_rt_negative_fixture PRIVATE SingZ::zcore_device)
  add_dependencies(service_master_tests service_master_rt_negative_fixture)
  file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/service-master-rt-negative.cmake" "set(SINGZ_ZDSP_RT_FILES [==[${CMAKE_CURRENT_BINARY_DIR}/service-master-rt-negative.cpp]==])\n")
  add_test(NAME service_master_realtime_policy_negative COMMAND "${CMAKE_COMMAND}" "-DSINGZ_ZDSP_RT_MANIFEST=${CMAKE_CURRENT_BINARY_DIR}/service-master-rt-negative.cmake" -DSINGZ_ZDSP_RT_PROFILE=monitor -P "${ZCORE_ROOT}/cmake/CheckZdspRealtime.cmake")
  set_tests_properties(service_master_realtime_policy_negative PROPERTIES WILL_FAIL TRUE)

  add_executable(native_playback_session_tests
    ${SINGZ_REPO_ROOT}/tests/native/native_playback_session_tests.cpp
    ${ZCORE_ROOT}/zdsp/tests/allocation_trap.cpp
    ${ZCORE_ROOT}/zdsp/tests/allocation_trap.h)
  target_compile_features(native_playback_session_tests PRIVATE cxx_std_20)
  target_include_directories(native_playback_session_tests PRIVATE
    "${SINGZ_REPO_ROOT}"
    "${ZCORE_ROOT}/zdsp/tests")
  if(CMAKE_CXX_COMPILER_ID STREQUAL "GNU")
    set_source_files_properties(
      "${ZCORE_ROOT}/zdsp/tests/allocation_trap.cpp" PROPERTIES
      COMPILE_OPTIONS "-Wno-mismatched-new-delete")
  endif()
  target_link_libraries(native_playback_session_tests PRIVATE
    SingZ::native_playback_session)
  add_test(NAME native_playback_session_tests
    COMMAND native_playback_session_tests)
  set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS native/playback/native_playback_session.cpp)
  file(READ "${SINGZ_REPO_ROOT}/native/playback/native_playback_session.cpp" _reanchor_source)
  string(REPLACE "// No graph means no per-generation clipping window.\n    result.outputClippedBlocks = 0;"
    "result.outputClippedBlocks = static_cast<uint32_t>(std::min<uint64_t>(meter.clippedBlocks, UINT32_MAX));"
    _idle_clip_mutant "${_reanchor_source}")
  string(REPLACE "return {true, 0, meter.peak, 0, meter.rms};"
    "return {true, 0, meter.peak, static_cast<uint32_t>(std::min<uint64_t>(meter.clippedBlocks, UINT32_MAX)), meter.rms};"
    _idle_clip_mutant "${_idle_clip_mutant}")
  if(_idle_clip_mutant STREQUAL _reanchor_source)
    message(FATAL_ERROR "Service idle clip counter negative control needs updating")
  endif()
  file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/native-playback-idle-clips.cpp" "${_idle_clip_mutant}")
  add_executable(service_master_negative_idle_clips tests/native/native_playback_session_tests.cpp
    "${CMAKE_CURRENT_BINARY_DIR}/native-playback-idle-clips.cpp" "${ZCORE_ROOT}/zdsp/tests/allocation_trap.cpp")
  target_compile_features(service_master_negative_idle_clips PRIVATE cxx_std_20)
  target_include_directories(service_master_negative_idle_clips PRIVATE
    "${SINGZ_REPO_ROOT}" "${SINGZ_REPO_ROOT}/native/playback" "${ZCORE_ROOT}/zdsp/tests")
  target_link_libraries(service_master_negative_idle_clips PRIVATE SingZ::native_playback_session)
  add_dependencies(native_playback_session_tests service_master_negative_idle_clips)
  add_test(NAME service_master_idle_clips COMMAND "${CMAKE_COMMAND}" -E env
    SINGZ_SERVICE_MASTER_IDLE_REGRESSION_ONLY=1 $<TARGET_FILE:native_playback_session_tests>)
  add_test(NAME service_master_negative_idle_clips COMMAND "${Python3_EXECUTABLE}" -c
    "import os,subprocess,sys; p=subprocess.run([r'$<TARGET_FILE:service_master_negative_idle_clips>'],env=dict(os.environ,SINGZ_SERVICE_MASTER_IDLE_REGRESSION_ONLY='1'),capture_output=True,text=True); print(p.stdout+p.stderr); sys.exit(1 if p.returncode != 0 and 'song clip window ended' in p.stderr else 0)")
  set_tests_properties(service_master_negative_idle_clips PROPERTIES WILL_FAIL TRUE)
  string(REPLACE "if (rendering->serviceOwnsMasterGain) {" "if (false && rendering->serviceOwnsMasterGain) {"
    _master_meter_mutant "${_reanchor_source}")
  string(REPLACE "if (graph != nullptr && graph->serviceOwnsMasterGain)"
    "if (false && graph != nullptr && graph->serviceOwnsMasterGain)"
    _master_meter_mutant "${_master_meter_mutant}")
  if(_master_meter_mutant STREQUAL _reanchor_source)
    message(FATAL_ERROR "Service master meter negative control needs updating")
  endif()
  file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/native-playback-graph-meter.cpp" "${_master_meter_mutant}")
  add_executable(service_master_negative_graph_meter tests/native/native_playback_session_tests.cpp
    "${CMAKE_CURRENT_BINARY_DIR}/native-playback-graph-meter.cpp" "${ZCORE_ROOT}/zdsp/tests/allocation_trap.cpp")
  target_compile_features(service_master_negative_graph_meter PRIVATE cxx_std_20)
  target_include_directories(service_master_negative_graph_meter PRIVATE
    "${SINGZ_REPO_ROOT}" "${SINGZ_REPO_ROOT}/native/playback" "${ZCORE_ROOT}/zdsp/tests")
  target_link_libraries(service_master_negative_graph_meter PRIVATE SingZ::native_playback_session)
  add_dependencies(native_playback_session_tests service_master_negative_graph_meter)
  add_test(NAME service_master_meter COMMAND "${CMAKE_COMMAND}" -E env
    SINGZ_SERVICE_MASTER_METER_REGRESSION_ONLY=1 $<TARGET_FILE:native_playback_session_tests>)
  add_test(NAME service_master_negative_graph_meter COMMAND "${Python3_EXECUTABLE}" -c
    "import os,subprocess,sys; p=subprocess.run([r'$<TARGET_FILE:service_master_negative_graph_meter>'],env=dict(os.environ,SINGZ_SERVICE_MASTER_METER_REGRESSION_ONLY='1'),capture_output=True,text=True); print(p.stdout+p.stderr); sys.exit(1 if p.returncode != 0 and 'service output meter peak' in p.stderr else 0)")
  set_tests_properties(service_master_negative_graph_meter PROPERTIES WILL_FAIL TRUE)
  string(REPLACE "return serviceOwnsMasterGain;"
    "return false; // negative: retain the pre-master graph ceiling"
    _master_preclip_mutant "${_reanchor_source}")
  if(_master_preclip_mutant STREQUAL _reanchor_source)
    message(FATAL_ERROR "Service master preclip negative control needs updating")
  endif()
  file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/native-playback-master-preclip.cpp" "${_master_preclip_mutant}")
  add_executable(service_master_negative_preclip
    tests/native/native_playback_session_tests.cpp
    "${CMAKE_CURRENT_BINARY_DIR}/native-playback-master-preclip.cpp"
    "${ZCORE_ROOT}/zdsp/tests/allocation_trap.cpp")
  target_compile_features(service_master_negative_preclip PRIVATE cxx_std_20)
  target_include_directories(service_master_negative_preclip PRIVATE
    "${SINGZ_REPO_ROOT}" "${SINGZ_REPO_ROOT}/native/playback" "${ZCORE_ROOT}/zdsp/tests")
  target_link_libraries(service_master_negative_preclip PRIVATE SingZ::native_playback_session)
  add_dependencies(native_playback_session_tests service_master_negative_preclip)
  add_test(NAME service_master_hot_song COMMAND "${CMAKE_COMMAND}" -E env
    SINGZ_SERVICE_MASTER_HOT_REGRESSION_ONLY=1 $<TARGET_FILE:native_playback_session_tests>)
  add_test(NAME service_master_negative_preclip COMMAND "${Python3_EXECUTABLE}" -c
    "import os,subprocess,sys; p=subprocess.run([r'$<TARGET_FILE:service_master_negative_preclip>'],env=dict(os.environ,SINGZ_SERVICE_MASTER_HOT_REGRESSION_ONLY='1'),capture_output=True,text=True); print(p.stdout+p.stderr); sys.exit(1 if p.returncode != 0 and 'hot master attenuation' in p.stderr else 0)")
  set_tests_properties(service_master_negative_preclip PROPERTIES WILL_FAIL TRUE)
  string(REPLACE "if (command.reanchorPlan.valid() &&\n            (callbackProjectFrame"
    "if (false && command.reanchorPlan.valid() &&\n            (callbackProjectFrame" _stale_reanchor "${_reanchor_source}")
  if(_stale_reanchor STREQUAL _reanchor_source)
    message(FATAL_ERROR "Stale reanchor negative control needs updating")
  endif()
  file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/native-playback-stale-reanchor.cpp" "${_stale_reanchor}")
  add_executable(native_playback_stale_reanchor_negative
    tests/native/native_playback_session_tests.cpp "${CMAKE_CURRENT_BINARY_DIR}/native-playback-stale-reanchor.cpp"
    "${ZCORE_ROOT}/zdsp/tests/allocation_trap.cpp")
  target_compile_features(native_playback_stale_reanchor_negative PRIVATE cxx_std_20)
  target_include_directories(native_playback_stale_reanchor_negative PRIVATE "${SINGZ_REPO_ROOT}" "${ZCORE_ROOT}/zdsp/tests")
  target_link_libraries(native_playback_stale_reanchor_negative PRIVATE SingZ::native_playback_session)
  add_dependencies(native_playback_session_tests native_playback_stale_reanchor_negative)
  # CHECK aborts intentionally in this suite; a wrapper converts that expected
  # signal failure to a regular code1 so CTest WILL_FAIL tests the assertion.
  add_test(NAME native_playback_stale_reanchor_negative
    COMMAND "${Python3_EXECUTABLE}" -c
      "import os,subprocess,sys; p=subprocess.run([r'$<TARGET_FILE:native_playback_stale_reanchor_negative>'],env=dict(os.environ,SINGZ_REANCHOR_REGRESSION_ONLY='1'),capture_output=True,text=True); print(p.stdout+p.stderr); sys.exit(1 if p.returncode != 0 and 'after.renderedProjectFrame==1584' in p.stderr else 0)")
  set_tests_properties(native_playback_stale_reanchor_negative PROPERTIES WILL_FAIL TRUE)
  if(APPLE)
    string(REPLACE "config.maximumFrames=std::max(config.maximumFrames,sharedAudioService().retainedPlaybackCapacity(retainedRoute));"
      "/* negative control: keep the smaller graph capacity */" _capacity_mutant "${_reanchor_source}")
    if(_capacity_mutant STREQUAL _reanchor_source)
      message(FATAL_ERROR "Held capacity negative control needs updating")
    endif()
    file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/native-playback-held-capacity.cpp" "${_capacity_mutant}")
    add_executable(native_playback_held_capacity_negative tests/native/native_playback_session_tests.cpp
      "${CMAKE_CURRENT_BINARY_DIR}/native-playback-held-capacity.cpp" "${ZCORE_ROOT}/zdsp/tests/allocation_trap.cpp")
    target_compile_features(native_playback_held_capacity_negative PRIVATE cxx_std_20)
    target_include_directories(native_playback_held_capacity_negative PRIVATE "${SINGZ_REPO_ROOT}" "${ZCORE_ROOT}/zdsp/tests")
    target_link_libraries(native_playback_held_capacity_negative PRIVATE SingZ::native_playback_session)
    add_dependencies(native_playback_session_tests native_playback_held_capacity_negative)
    add_test(NAME native_playback_held_capacity_negative COMMAND "${Python3_EXECUTABLE}" -c
      "import os,subprocess,sys; p=subprocess.run([r'$<TARGET_FILE:native_playback_held_capacity_negative>'],env=dict(os.environ,SINGZ_HELD_CAPACITY_REGRESSION_ONLY='1'),capture_output=True,text=True); print(p.stdout+p.stderr); sys.exit(1 if p.returncode != 0 and 'prepared.ok && prepared.format.maximumFrames==4096' in p.stderr else 0)")
    set_tests_properties(native_playback_held_capacity_negative PROPERTIES WILL_FAIL TRUE)
  endif()
  add_test(NAME native_playback_mono_lane_parity COMMAND "${CMAKE_COMMAND}" -E env
    SINGZ_MONO_PARITY_REGRESSION_ONLY=1 $<TARGET_FILE:native_playback_session_tests>)
  string(REPLACE "if (inputChannels == 1)\n                coefficient = 1.0F;"
    "if (inputChannels == 1)\n                coefficient = 0.5F;" _mono_mutant "${_reanchor_source}")
  if(_mono_mutant STREQUAL _reanchor_source)
    message(FATAL_ERROR "Mono matrix negative control needs updating")
  endif()
  file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/native-playback-mono-matrix.cpp" "${_mono_mutant}")
  add_executable(native_playback_mono_matrix_negative tests/native/native_playback_session_tests.cpp
    "${CMAKE_CURRENT_BINARY_DIR}/native-playback-mono-matrix.cpp" "${ZCORE_ROOT}/zdsp/tests/allocation_trap.cpp")
  target_compile_features(native_playback_mono_matrix_negative PRIVATE cxx_std_20)
  target_include_directories(native_playback_mono_matrix_negative PRIVATE "${SINGZ_REPO_ROOT}" "${ZCORE_ROOT}/zdsp/tests")
  target_link_libraries(native_playback_mono_matrix_negative PRIVATE SingZ::native_playback_session)
  add_dependencies(native_playback_session_tests native_playback_mono_matrix_negative)
  add_test(NAME native_playback_mono_matrix_negative COMMAND "${Python3_EXECUTABLE}" -c
    "import os,subprocess,sys; p=subprocess.run([r'$<TARGET_FILE:native_playback_mono_matrix_negative>'],env=dict(os.environ,SINGZ_MONO_PARITY_REGRESSION_ONLY='1'),capture_output=True,text=True); print(p.stdout+p.stderr); sys.exit(1 if p.returncode != 0 and 'pcm16(1.0F)*0.25F' in p.stderr else 0)")
  set_tests_properties(native_playback_mono_matrix_negative PROPERTIES WILL_FAIL TRUE)
  add_test(NAME native_playback_stale_retirement_failure_tests
    COMMAND "${CMAKE_COMMAND}" -E env
      SINGZ_NATIVE_PLAYBACK_STALE_RETIREMENT_FAILURE=1
      $<TARGET_FILE:native_playback_session_tests>)
  add_test(NAME native_playback_provider_dispose_failure_tests
    COMMAND "${CMAKE_COMMAND}" -E env
      SINGZ_NATIVE_PLAYBACK_PROVIDER_DISPOSE_FAILURE=1
      $<TARGET_FILE:native_playback_session_tests>)
  # Its own process too: it consumes the process-global quarantine, and then
  # keeps rendering through it after the session is gone.
  add_test(NAME native_playback_quarantined_swap_tests
    COMMAND "${CMAKE_COMMAND}" -E env
      SINGZ_NATIVE_PLAYBACK_QUARANTINED_SWAP=1
      $<TARGET_FILE:native_playback_session_tests>)

  add_executable(playback_presentation_history_tests
    tests/native/playback_presentation_history_tests.cpp
    ${ZCORE_ROOT}/zdsp/tests/allocation_trap.cpp)
  target_compile_features(playback_presentation_history_tests PRIVATE cxx_std_20)
  target_include_directories(playback_presentation_history_tests PRIVATE
    "${SINGZ_REPO_ROOT}" "${ZCORE_ROOT}/zdsp/tests")
  target_link_libraries(playback_presentation_history_tests PRIVATE
    SingZ::native_playback_session Threads::Threads)
  add_test(NAME playback_presentation_history_tests COMMAND playback_presentation_history_tests)

  add_executable(record_placement_tests tests/native/record_placement_tests.cpp)
  target_compile_features(record_placement_tests PRIVATE cxx_std_20)
  target_include_directories(record_placement_tests PRIVATE "${SINGZ_REPO_ROOT}")
  target_link_libraries(record_placement_tests PRIVATE SingZ::native_playback_session)
  add_test(NAME record_placement_tests COMMAND record_placement_tests)

  add_executable(playback_cue_plan_tests
    ${SINGZ_REPO_ROOT}/tests/native/playback_cue_plan_tests.cpp)
  target_compile_features(playback_cue_plan_tests PRIVATE cxx_std_20)
  target_include_directories(playback_cue_plan_tests PRIVATE
    "${SINGZ_REPO_ROOT}")
  target_compile_definitions(playback_cue_plan_tests PRIVATE
    SINGZ_PLAYBACK_CUE_FIXTURE_PATH="${SINGZ_REPO_ROOT}/tests/shared/playback-cue-cases.json")
  target_link_libraries(playback_cue_plan_tests PRIVATE
    SingZ::native_playback_session)
  add_test(NAME playback_cue_plan_tests COMMAND playback_cue_plan_tests)

  # The core's half of the TypeScript/C++ playback contract. It reads the same
  # two shared files jest and vitest read, so a value restated on both sides of
  # the boundary is compared rather than copied.
  add_executable(native_playback_contract_tests
    ${SINGZ_REPO_ROOT}/tests/native/native_playback_contract_tests.cpp)
  target_compile_features(native_playback_contract_tests PRIVATE cxx_std_20)
  target_include_directories(native_playback_contract_tests PRIVATE
    "${SINGZ_REPO_ROOT}")
  # The enum-size pins are exhaustive switches with no default. Without this
  # an appended enumerator is a warning nobody reads, and the test's own count
  # keeps matching because the enumerator it names has not moved.
  if(NOT MSVC)
    target_compile_options(native_playback_contract_tests PRIVATE -Werror=switch)
  endif()
  target_compile_definitions(native_playback_contract_tests PRIVATE
    SINGZ_NATIVE_PLAYBACK_MANIFEST_PATH="${SINGZ_REPO_ROOT}/tests/shared/native-playback-bridge-manifest.json"
    SINGZ_NATIVE_PLAYBACK_AGREEMENT_PATH="${SINGZ_REPO_ROOT}/tests/shared/native-playback-agreement-cases.json")
  target_link_libraries(native_playback_contract_tests PRIVATE
    SingZ::native_playback_session)
  add_test(NAME native_playback_contract_tests
    COMMAND native_playback_contract_tests)

  add_executable(signalsmith_time_pitch_tests
    tests/native/signalsmith_time_pitch_tests.cpp
    "${ZCORE_ROOT}/zdsp/tests/allocation_trap.cpp")
  target_compile_features(signalsmith_time_pitch_tests PRIVATE cxx_std_20)
  target_include_directories(signalsmith_time_pitch_tests PRIVATE
    "${SINGZ_REPO_ROOT}" "${ZCORE_ROOT}")
  target_link_libraries(signalsmith_time_pitch_tests PRIVATE
    SingZ::signalsmith_time_pitch)
  add_test(NAME signalsmith_time_pitch_tests
    COMMAND signalsmith_time_pitch_tests)

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
    ${ZCORE_ROOT}/zdsp/tests/zdsp_contract_tests.cpp)
  target_compile_features(zdsp_contract_tests PRIVATE cxx_std_20)
  set_target_properties(zdsp_contract_tests PROPERTIES CXX_EXTENSIONS OFF)
  target_link_libraries(zdsp_contract_tests PRIVATE
    SingZ::zdsp_prototype SingZ::zdsp_control)
  add_test(NAME zdsp_contract_tests COMMAND zdsp_contract_tests)

  # The streaming source is compared against the decoded source it replaces,
  # so it links the runtime rather than the offline renderer: no graph, no WAV,
  # just the two processors driven through the same transport.
  add_executable(streaming_window_source_tests
    ${ZCORE_ROOT}/zdsp/tests/streaming_window_source_tests.cpp)
  target_compile_features(streaming_window_source_tests PRIVATE cxx_std_20)
  set_target_properties(streaming_window_source_tests PROPERTIES
    CXX_EXTENSIONS OFF)
  target_link_libraries(streaming_window_source_tests
    PRIVATE SingZ::zdsp_runtime)
  add_test(NAME streaming_window_source_tests
    COMMAND streaming_window_source_tests)

  add_executable(zdsp_graph_tests
    ${ZCORE_ROOT}/zdsp/tests/zdsp_graph_tests.cpp)
  set(_zdsp_allocation_trap_source
    "${ZCORE_ROOT}/zdsp/tests/allocation_trap.cpp")
  target_sources(zdsp_graph_tests PRIVATE
    "${_zdsp_allocation_trap_source}"
    "${ZCORE_ROOT}/zdsp/tests/allocation_trap.h")
  target_include_directories(zdsp_graph_tests PRIVATE
    "${ZCORE_ROOT}/zdsp/tests")
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
    ${ZCORE_ROOT}/zdsp/tests/zdsp_analysis_tests.cpp)
  target_compile_features(zdsp_analysis_tests PRIVATE cxx_std_20)
  set_target_properties(zdsp_analysis_tests PROPERTIES CXX_EXTENSIONS OFF)
  target_link_libraries(zdsp_analysis_tests PRIVATE
    SingZ::zdsp_analysis SingZ::zcore_legacy Threads::Threads)
  add_test(NAME zdsp_analysis_tests COMMAND zdsp_analysis_tests)
  if(APPLE)
    add_test(NAME zcore_apple_audio_host_smoke
      COMMAND bash
        "${ZCORE_ROOT}/zcore/build-apple-audio-host-smoke.sh"
        "${ZCORE_ROOT}"
        "${CMAKE_CURRENT_BINARY_DIR}/zcore-apple-audio-host-ctest")
    add_test(NAME zdsp_apple_component_smoke
      COMMAND bash
        "${ZCORE_ROOT}/zdsp/build-apple-component-smoke.sh"
        "${ZCORE_ROOT}"
        "${CMAKE_CURRENT_BINARY_DIR}/zdsp-apple-component-ctest")
  endif()

  add_executable(zdsp_fake_host_benchmark
    ${ZCORE_ROOT}/zdsp/benchmarks/fake_host_benchmark.cpp)
  target_compile_features(zdsp_fake_host_benchmark PRIVATE cxx_std_20)
  set_target_properties(zdsp_fake_host_benchmark PROPERTIES CXX_EXTENSIONS OFF)
  target_link_libraries(zdsp_fake_host_benchmark PRIVATE SingZ::zdsp_prototype)

  add_executable(zdsp_graph_benchmark
    ${ZCORE_ROOT}/zdsp/benchmarks/graph_benchmark.cpp)
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

if(SINGZ_CORE_TESTS AND SINGZ_BUILD_HOST_TOOLS)
  add_executable(singz-crepe-tests tests/native/crepe-tiny.cpp)
  target_compile_features(singz-crepe-tests PRIVATE cxx_std_20)
  target_link_libraries(singz-crepe-tests PRIVATE SingZ::zdsp_analysis)
  add_test(NAME crepe_tiny_parity COMMAND singz-crepe-tests
    "${CMAKE_CURRENT_SOURCE_DIR}/assets/pitch/crepe-tiny.bin"
    "${CMAKE_CURRENT_SOURCE_DIR}/tests/fixtures/pitch/crepe-tiny-parity.f32"
    "${CMAKE_CURRENT_BINARY_DIR}/crepe-recording-test.wav")
endif()

add_library(singz_take_conform STATIC native/playback/take_conform.cpp)
target_compile_features(singz_take_conform PUBLIC cxx_std_20)
set_target_properties(singz_take_conform PROPERTIES POSITION_INDEPENDENT_CODE YES)
target_include_directories(singz_take_conform PRIVATE "${SINGZ_REPO_ROOT}/third_party/native/signalsmith")
if(SINGZ_CORE_TESTS)
  add_library(take_conform_v2_reference STATIC tests/native/fixtures/take-conform-v2/take_conform.cpp)
  target_compile_features(take_conform_v2_reference PRIVATE cxx_std_20)
  target_include_directories(take_conform_v2_reference PRIVATE "${SINGZ_REPO_ROOT}/third_party/native/signalsmith")
  target_link_libraries(take_conform_v2_reference PRIVATE SingZ::zcore_resample)
  foreach(_conform_variant IN ITEMS tests negative_ratio negative_placement negative_latency negative_drift)
    set(_conform_target take_conform_${_conform_variant})
    add_executable(${_conform_target} tests/native/take_conform_tests.cpp native/playback/take_conform.cpp)
    target_compile_features(${_conform_target} PRIVATE cxx_std_20)
    target_link_libraries(${_conform_target} PRIVATE take_conform_v2_reference SingZ::zcore_resample Threads::Threads)
    target_include_directories(${_conform_target} PRIVATE "${SINGZ_REPO_ROOT}" "${SINGZ_REPO_ROOT}/third_party/native/signalsmith")
    target_compile_options(${_conform_target} PRIVATE "$<$<CXX_COMPILER_ID:MSVC>:/UNDEBUG>" "$<$<NOT:$<CXX_COMPILER_ID:MSVC>>:-UNDEBUG>")
    if(NOT _conform_variant STREQUAL "tests")
      string(TOUPPER "${_conform_variant}" _conform_define)
      target_compile_definitions(${_conform_target} PRIVATE SINGZ_CONFORM_${_conform_define})
    endif()
    if(_conform_variant STREQUAL "tests")
      add_test(NAME ${_conform_target} COMMAND ${_conform_target})
    else()
      if(_conform_variant STREQUAL "negative_ratio")
        set(_conform_assertion "Half-tempo anchor mapping exceeds 1 ms")
      elseif(_conform_variant STREQUAL "negative_placement")
        set(_conform_assertion "Placement length")
      elseif(_conform_variant STREQUAL "negative_latency")
        set(_conform_assertion "Measured DSP latency alignment exceeds 1 ms")
      elseif(_conform_variant STREQUAL "negative_drift")
        set(_conform_assertion "Jittered tempo-one take must never enter Signalsmith")
      endif()
      string(REPLACE "negative_" "regression-" _conform_regression "${_conform_variant}")
      # An arbitrary failure (including a golden mismatch, crash or launch
      # error) cannot make a mutation control pass: require its own assertion.
      add_test(NAME ${_conform_target} COMMAND "${Python3_EXECUTABLE}" -c
        "import subprocess,sys; p=subprocess.run([r'$<TARGET_FILE:${_conform_target}>','${_conform_regression}'],capture_output=True,text=True); print(p.stdout+p.stderr); sys.exit(0 if p.returncode == 1 and p.stderr.strip() == '${_conform_assertion}' else 1)")
    endif()
    set_tests_properties(${_conform_target} PROPERTIES TIMEOUT 300)
  endforeach()
  add_test(NAME take_conform_stream_failures COMMAND take_conform_tests stream-failures)
  set_tests_properties(take_conform_stream_failures PROPERTIES TIMEOUT 180)
  if(CMAKE_BUILD_TYPE STREQUAL "Release")
    add_test(NAME take_conform_streaming_long COMMAND take_conform_tests stream 7200)
    set_tests_properties(take_conform_streaming_long PROPERTIES TIMEOUT 300)
    add_test(NAME take_conform_streaming_high_rate COMMAND take_conform_tests stream 30 192000 192000)
    add_test(NAME take_conform_streaming_conversion COMMAND take_conform_tests stream 30 11025 192000)
    add_test(NAME take_conform_negative_resident COMMAND take_conform_tests resident-negative)
    set_tests_properties(take_conform_negative_resident PROPERTIES WILL_FAIL TRUE TIMEOUT 120)
  endif()
endif()

if(SINGZ_CORE_TESTS)
  add_executable(training_pcm_mixer_tests native/playback/training_pcm_mixer_tests.cpp
    native/playback/training_pcm_mixer.cpp)
  target_compile_features(training_pcm_mixer_tests PRIVATE cxx_std_20)
  target_compile_options(training_pcm_mixer_tests PRIVATE
    "$<$<CXX_COMPILER_ID:MSVC>:/UNDEBUG>" "$<$<NOT:$<CXX_COMPILER_ID:MSVC>>:-UNDEBUG>")
  target_link_libraries(training_pcm_mixer_tests PRIVATE SingZ::zcore_device Threads::Threads)
  add_test(NAME training_pcm_mixer_tests COMMAND training_pcm_mixer_tests)
  add_executable(take_playback_tests tests/native/take_playback_tests.cpp
    native/playback/training_pcm_mixer.cpp native/playback/presentation_history.cpp
    ${ZCORE_ROOT}/zdsp/tests/allocation_trap.cpp)
  target_compile_features(take_playback_tests PRIVATE cxx_std_20)
  target_compile_options(take_playback_tests PRIVATE
    "$<$<CXX_COMPILER_ID:MSVC>:/UNDEBUG>" "$<$<NOT:$<CXX_COMPILER_ID:MSVC>>:-UNDEBUG>")
  target_include_directories(take_playback_tests PRIVATE "${SINGZ_REPO_ROOT}" "${ZCORE_ROOT}/zdsp/tests")
  target_link_libraries(take_playback_tests PRIVATE SingZ::zcore_device Threads::Threads)
  add_test(NAME take_playback_tests COMMAND take_playback_tests)
endif()

if(BUILD_TESTING AND SINGZ_BOX_LOOPZ_ROUTING)
  add_executable(loopz_source_backend_tests
    tests/native/loopz_source_backend_tests.cpp
    native/playback/loopz_source_backend.cpp)
  target_compile_features(loopz_source_backend_tests PRIVATE cxx_std_20)
  target_include_directories(loopz_source_backend_tests PRIVATE "${SINGZ_REPO_ROOT}")
  target_link_libraries(loopz_source_backend_tests PRIVATE LoopZ::Runtime Threads::Threads)
  add_test(NAME loopz_source_backend_tests COMMAND loopz_source_backend_tests)

  add_executable(box_routing_owner_tests
    tests/native/box_routing_owner_tests.cpp
    native/playback/box_routing_owner.cpp
    native/playback/box_input_capture.cpp
    native/playback/loopz_source_backend.cpp
    native/playback/shared_audio_service.cpp)
  target_compile_features(box_routing_owner_tests PRIVATE cxx_std_20)
  target_compile_definitions(box_routing_owner_tests PRIVATE SINGZ_BOX_LOOPZ_ROUTING=1)
  target_include_directories(box_routing_owner_tests PRIVATE "${SINGZ_REPO_ROOT}")
  target_link_libraries(box_routing_owner_tests PRIVATE LoopZ::Control Threads::Threads)
  add_test(NAME box_routing_owner_tests COMMAND box_routing_owner_tests)
  add_executable(box_input_capture_tests
    tests/native/box_input_capture_tests.cpp
    native/playback/box_routing_owner.cpp
    native/playback/box_input_capture.cpp
    native/playback/loopz_source_backend.cpp
    native/playback/shared_audio_service.cpp)
  target_compile_features(box_input_capture_tests PRIVATE cxx_std_20)
  target_compile_definitions(box_input_capture_tests PRIVATE SINGZ_BOX_LOOPZ_ROUTING=1)
  target_include_directories(box_input_capture_tests PRIVATE "${SINGZ_REPO_ROOT}")
  target_link_libraries(box_input_capture_tests PRIVATE LoopZ::Control Threads::Threads SingZ::zdsp_analysis)
  add_test(NAME box_input_capture_tests COMMAND box_input_capture_tests)
  set_tests_properties(loopz_source_backend_tests box_routing_owner_tests box_input_capture_tests PROPERTIES TIMEOUT 20)
endif()

if(SINGZ_CORE_TESTS AND SINGZ_BUILD_HOST_TOOLS)
  add_executable(take_writer_tests
    native/electron/take_writer.cpp tests/native/take_writer_tests.cpp
    "${ZCORE_ROOT}/zdsp/tests/allocation_trap.cpp")
  target_compile_features(take_writer_tests PRIVATE cxx_std_20)
  target_include_directories(take_writer_tests PRIVATE "${SINGZ_REPO_ROOT}" "${ZCORE_ROOT}/zdsp/tests" "${ZCORE_ROOT}/zcore/include")
  target_link_libraries(take_writer_tests PRIVATE Threads::Threads)
  target_compile_definitions(take_writer_tests PRIVATE
    SINGZ_TAKE_WRITER_SOURCE="${SINGZ_REPO_ROOT}/native/electron/take_writer.cpp")
  add_test(NAME take_writer_tests COMMAND take_writer_tests)
  add_test(NAME take_writer_realtime_source_policy COMMAND take_writer_tests gap-rt)
  set_tests_properties(take_writer_tests take_writer_realtime_source_policy PROPERTIES TIMEOUT 120)
  # Compile faults into the real writer and run the identical behavior assertions.
  # Keep generated controls in each build tree, never in the production sources.
  set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
    "${SINGZ_REPO_ROOT}/native/electron/take_writer.cpp")
  file(READ "${SINGZ_REPO_ROOT}/native/electron/take_writer.cpp" _take_writer_original)
  add_custom_target(take_writer_gap_checks DEPENDS take_writer_tests)
  foreach(_mutant IN ITEMS concatenate jitter unknown unknown_count backward regression_count single_cap total_cap recovery rt cumulative estimate_previous threshold rounding mac_silence)
    set(_control "${_take_writer_original}")
    set(_case "gap")
    if(_mutant STREQUAL "concatenate")
      string(REPLACE "padding = static_cast<uint64_t>(frames);" "padding = 0;" _control "${_control}")
    elseif(_mutant STREQUAL "jitter")
      string(REPLACE "std::max(2.0e6L, durationNs * .5L)" "0.0L" _control "${_control}")
      set(_case "gap-jitter")
    elseif(_mutant STREQUAL "cumulative")
      string(REPLACE "const long double excessNs = static_cast<long double>(current.sampleHostTimeNs - previous.sampleHostTimeNs) - durationNs;"
        "static thread_local uint64_t anchorHostNs = 0, writtenFrames = 0;\n  if (previous.sequence == 0) { anchorHostNs = previous.sampleHostTimeNs; writtenFrames = previousFrames; }\n  const long double excessNs = static_cast<long double>(current.sampleHostTimeNs - anchorHostNs) - writtenFrames * 1.0e9L / currentRate;"
        _control "${_control}")
      string(REPLACE "  return gapFrames;" "  writtenFrames += previousFrames + static_cast<uint64_t>(gapFrames);\n  return gapFrames;" _control "${_control}")
      set(_case "gap-drift")
    elseif(_mutant STREQUAL "estimate_previous")
      string(REPLACE "return q == AudioInputTimestampQuality::Hardware;" "return q == AudioInputTimestampQuality::Hardware || q == AudioInputTimestampQuality::CallbackEstimate;" _control "${_control}")
      string(REPLACE "previous.timestampQuality != AudioInputTimestampQuality::Hardware" "previous.timestampQuality == AudioInputTimestampQuality::Unknown" _control "${_control}")
      string(REPLACE "current.timestampQuality != AudioInputTimestampQuality::Hardware" "current.timestampQuality == AudioInputTimestampQuality::Unknown" _control "${_control}")
      set(_case "gap-estimated")
    elseif(_mutant STREQUAL "threshold")
      string(REPLACE "excessNs > thresholdNs ?" "excessNs >= thresholdNs ?" _control "${_control}")
      set(_case "gap-thresholds")
    elseif(_mutant STREQUAL "rounding")
      string(REPLACE "std::round(excessNs * currentRate / 1.0e9L)" "std::ceil(excessNs * currentRate / 1.0e9L)" _control "${_control}")
      set(_case "gap-thresholds")
    elseif(_mutant STREQUAL "mac_silence")
      string(REPLACE "if ((result_.frames + padding + s.frames)" "if (havePrevious && s.frames > previous.frames) padding += s.frames;\n        if ((result_.frames + padding + s.frames)" _control "${_control}")
      set(_case "gap-mac-silence")
    elseif(_mutant STREQUAL "unknown")
      string(REPLACE "return q == AudioInputTimestampQuality::Hardware" "return true || q == AudioInputTimestampQuality::Hardware" _control "${_control}")
      string(REPLACE "previous.timestampQuality != AudioInputTimestampQuality::Hardware" "false" _control "${_control}")
      string(REPLACE "current.timestampQuality != AudioInputTimestampQuality::Hardware" "false" _control "${_control}")
      set(_case "gap-unknown")
    elseif(_mutant STREQUAL "unknown_count")
      string(REPLACE "++result_.gapUntrustedTimestampBlocks;" "/* lost unknown count */" _control "${_control}")
      set(_case "gap-unknown")
    elseif(_mutant STREQUAL "backward")
      string(REPLACE "++result_.gapRegressions;" "read_.store(r + 1, std::memory_order_release); continue;" _control "${_control}")
      set(_case "gap-backward")
    elseif(_mutant STREQUAL "regression_count")
      string(REPLACE "++result_.gapRegressions;" "/* lost regression count */" _control "${_control}")
      set(_case "gap-backward")
    elseif(_mutant STREQUAL "single_cap")
      string(REPLACE "frames > perGapCap ||" "frames > perGapCap * 1000 ||" _control "${_control}")
      set(_case "gap-caps")
    elseif(_mutant STREQUAL "total_cap")
      string(REPLACE "frames > perTakeCap - result_.gapPaddedFrames" "frames > perTakeCap * 1000 - result_.gapPaddedFrames" _control "${_control}")
      set(_case "gap-caps")
    elseif(_mutant STREQUAL "recovery")
      string(REPLACE "result.frames = bytes / 2;" "result.frames = get32(h.data() + 40) / 2;" _control "${_control}")
    elseif(_mutant STREQUAL "rt")
      string(REPLACE "if (!b.mono || !b.frames) return false;" "if (!b.mono || !b.frames) return false; gapPaddedFrames_.fetch_add(0);" _control "${_control}")
      set(_case "gap-rt")
    endif()
    if(_control STREQUAL _take_writer_original)
      message(FATAL_ERROR "Take writer negative control ${_mutant} did not mutate the source")
    endif()
    set(_source "${CMAKE_CURRENT_BINARY_DIR}/take-writer-negative-${_mutant}.cpp")
    file(WRITE "${_source}" "${_control}")
    add_executable(take_writer_negative_${_mutant}
      "${_source}" tests/native/take_writer_tests.cpp "${ZCORE_ROOT}/zdsp/tests/allocation_trap.cpp")
    target_compile_features(take_writer_negative_${_mutant} PRIVATE cxx_std_20)
    target_include_directories(take_writer_negative_${_mutant} PRIVATE
      "${SINGZ_REPO_ROOT}" "${SINGZ_REPO_ROOT}/native/electron" "${ZCORE_ROOT}/zdsp/tests" "${ZCORE_ROOT}/zcore/include")
    target_compile_definitions(take_writer_negative_${_mutant} PRIVATE SINGZ_TAKE_WRITER_SOURCE="${_source}")
    target_link_libraries(take_writer_negative_${_mutant} PRIVATE Threads::Threads)
    add_dependencies(take_writer_gap_checks take_writer_negative_${_mutant})
    add_test(NAME take_writer_negative_${_mutant} COMMAND take_writer_negative_${_mutant} "${_case}")
    set_tests_properties(take_writer_negative_${_mutant} PROPERTIES WILL_FAIL TRUE TIMEOUT 120)
    if(_mutant STREQUAL "cumulative")
      add_test(NAME take_writer_negative_cumulative_gap COMMAND take_writer_negative_${_mutant} gap-drift-gap)
      set_tests_properties(take_writer_negative_cumulative_gap PROPERTIES WILL_FAIL TRUE TIMEOUT 120)
    endif()
    if(_mutant STREQUAL "concatenate")
      add_test(NAME take_writer_negative_concatenate_long COMMAND take_writer_negative_${_mutant} gap-long)
      set_tests_properties(take_writer_negative_concatenate_long PROPERTIES WILL_FAIL TRUE TIMEOUT 120)
    endif()
  endforeach()
endif()

if(TARGET voice_monitor_tests AND TARGET voice_monitor_source_tests)
  add_dependencies(voice_monitor_tests voice_monitor_source_tests)
endif()

# Canonical monitor preset target builds every common-client test it selects.
if(TARGET voice_monitor_tests AND TARGET voice_monitor_client_tests AND TARGET voice_monitor_client_clock_tests)
  add_dependencies(voice_monitor_tests voice_monitor_client_tests voice_monitor_client_clock_tests)
endif()

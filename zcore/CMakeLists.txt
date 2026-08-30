find_package(Threads REQUIRED)
include("${CMAKE_CURRENT_LIST_DIR}/../cmake/SingZRealtimeTarget.cmake")

set(ZCORE_INCLUDE_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/include")

function(singz_zcore_target target)
  target_compile_features(${target} PUBLIC cxx_std_20)
  target_include_directories(${target} PUBLIC "${ZCORE_INCLUDE_ROOT}")
  set_target_properties(${target} PROPERTIES POSITION_INDEPENDENT_CODE YES)
endfunction()

add_library(zcore_base INTERFACE)
add_library(SingZ::zcore_base ALIAS zcore_base)
target_compile_features(zcore_base INTERFACE cxx_std_20)
target_include_directories(zcore_base INTERFACE "${ZCORE_INCLUDE_ROOT}")
target_link_libraries(zcore_base INTERFACE SingZ::native_build_options)

# The reusable off-RT rate converter has media-preparation and legacy analysis
# consumers. Compile it once so their filter/latency behavior cannot drift.
add_library(zcore_resample STATIC src/legacy/resample.cpp)
add_library(SingZ::zcore_resample ALIAS zcore_resample)
singz_zcore_target(zcore_resample)
target_link_libraries(zcore_resample PUBLIC SingZ::zcore_base)

# Narrow ordinary-delivery-thread compatibility implementation shared by the
# legacy facade and zdsp_analysis. It remains above the callback leaf and has
# no zdsp dependency.
add_library(zcore_live_analysis_compat STATIC
  src/legacy/live_input_analysis.cpp)
add_library(SingZ::zcore_live_analysis_compat ALIAS zcore_live_analysis_compat)
singz_zcore_target(zcore_live_analysis_compat)
target_link_libraries(zcore_live_analysis_compat PUBLIC
  SingZ::zcore_base
  SingZ::zcore_resample)

add_library(zcore_audio STATIC
  src/audio/audio_input_transport.cpp)
add_library(SingZ::zcore_audio ALIAS zcore_audio)
singz_zcore_target(zcore_audio)
target_link_libraries(zcore_audio
  PUBLIC SingZ::zcore_base
  PRIVATE Threads::Threads)

# The strict callback execution leaf is deliberately separate from device
# inventory, lifecycle, worker threads and OS provider ownership. Its source
# list is the single authority for both compilation policy and RT scanning.
add_library(zcore_device_callback STATIC
  src/audio/audio_input_convert.cpp
  src/audio/audio_input_timestamp.cpp
  src/audio/audio_input_transport_callback.cpp
  src/device/audio_input_callback.cpp
  src/device/audio_input_callback_gate.cpp
  src/device/audio_host_callback.cpp
  src/device/audio_host_fifo_hot.cpp)
add_library(SingZ::zcore_device_callback ALIAS zcore_device_callback)
singz_zcore_target(zcore_device_callback)
target_link_libraries(zcore_device_callback PUBLIC SingZ::zcore_base)
target_sources(zcore_device_callback PRIVATE
  include/zcore/audio/audio_input_convert.h
  include/zcore/audio/audio_input_producer.h
  include/zcore/audio/audio_input_timestamp.h
  include/zcore/device/audio_input_callback_gate.h
  include/zcore/device/audio_host_callback.h
  include/zcore/device/audio_host_render.h
  src/audio/audio_input_transport_internal.h
  src/device/audio_input_callback.h)
set_target_properties(zcore_device_callback PROPERTIES
  CXX_VISIBILITY_PRESET hidden
  VISIBILITY_INLINES_HIDDEN YES)
singz_configure_realtime_target(zcore_device_callback)
# Preserve zcore_audio as the complete transport component for existing CMake
# consumers: the CMake target links the callback target transitively, while the
# strict leaf itself never inherits Threads or owner facilities.
target_link_libraries(zcore_audio PUBLIC SingZ::zcore_device_callback)

set(_zcore_rt_manifest
  "${CMAKE_CURRENT_BINARY_DIR}/zcore-realtime-sources.cmake")
get_target_property(_zcore_callback_source_dir zcore_device_callback SOURCE_DIR)
get_target_property(_zcore_callback_sources zcore_device_callback SOURCES)
set(_zcore_rt_files)
foreach(_source IN LISTS _zcore_callback_sources)
  if(IS_ABSOLUTE "${_source}")
    set(_absolute_source "${_source}")
  else()
    get_filename_component(_absolute_source "${_source}" ABSOLUTE
      BASE_DIR "${_zcore_callback_source_dir}")
  endif()
  file(TO_CMAKE_PATH "${_absolute_source}" _absolute_source)
  list(APPEND _zcore_rt_files "${_absolute_source}")
endforeach()
list(REMOVE_DUPLICATES _zcore_rt_files)
file(WRITE "${_zcore_rt_manifest}" "set(SINGZ_ZCORE_RT_FILES\n")
foreach(_source IN LISTS _zcore_rt_files)
  file(APPEND "${_zcore_rt_manifest}" "  [==[${_source}]==]\n")
endforeach()
file(APPEND "${_zcore_rt_manifest}" ")\n")
set_property(GLOBAL PROPERTY SINGZ_ZCORE_RT_MANIFEST "${_zcore_rt_manifest}")

add_custom_target(singz_check_zcore_realtime ALL
  COMMAND "${CMAKE_COMMAND}"
    "-DSINGZ_ZCORE_RT_MANIFEST=${_zcore_rt_manifest}"
    -P "${CMAKE_CURRENT_SOURCE_DIR}/../cmake/CheckZcoreRealtime.cmake"
  VERBATIM
  COMMENT "Checking zcore callback source policy")
add_dependencies(zcore_device_callback singz_check_zcore_realtime)

set(SINGZ_IOS_AUDIO_HOST_RT_SOURCES
  "${CMAKE_CURRENT_SOURCE_DIR}/platform/ios/audio_host_ios_callback.cpp"
  "${CMAKE_CURRENT_SOURCE_DIR}/platform/ios/audio_host_ios_callback.h")
set(_ios_audio_host_rt_manifest
  "${CMAKE_CURRENT_BINARY_DIR}/ios-audio-host-realtime-sources.cmake")
file(WRITE "${_ios_audio_host_rt_manifest}"
  "set(SINGZ_IOS_AUDIO_HOST_RT_FILES\n")
foreach(_source IN LISTS SINGZ_IOS_AUDIO_HOST_RT_SOURCES)
  file(APPEND "${_ios_audio_host_rt_manifest}"
    "  [==[${_source}]==]\n")
endforeach()
file(APPEND "${_ios_audio_host_rt_manifest}" ")\n")
file(APPEND "${_ios_audio_host_rt_manifest}"
  "set(SINGZ_IOS_AUDIO_HOST_RT_PROJECT_INCLUDE_ROOTS\n"
  "  [==[${CMAKE_CURRENT_SOURCE_DIR}/include]==]\n"
  ")\n")
set_property(GLOBAL PROPERTY SINGZ_IOS_AUDIO_HOST_RT_MANIFEST
  "${_ios_audio_host_rt_manifest}")
add_custom_target(singz_check_ios_audio_host_realtime ALL
  COMMAND "${CMAKE_COMMAND}"
    "-DSINGZ_IOS_AUDIO_HOST_RT_MANIFEST=${_ios_audio_host_rt_manifest}"
    -P "${CMAKE_CURRENT_SOURCE_DIR}/../cmake/CheckIosAudioHostRealtime.cmake"
  VERBATIM
  COMMENT "Checking iOS AudioHost callback source policy")

set(SINGZ_ANDROID_AUDIO_HOST_RT_SOURCES
  "${CMAKE_CURRENT_SOURCE_DIR}/platform/android/audio_host_android_callback.cpp"
  "${CMAKE_CURRENT_SOURCE_DIR}/platform/android/audio_host_android_callback_policy.cpp"
  "${CMAKE_CURRENT_SOURCE_DIR}/platform/android/audio_host_android_callback.h")
set(_android_audio_host_rt_manifest
  "${CMAKE_CURRENT_BINARY_DIR}/android-audio-host-realtime-sources.cmake")
file(WRITE "${_android_audio_host_rt_manifest}"
  "set(SINGZ_ANDROID_AUDIO_HOST_RT_FILES\n")
foreach(_source IN LISTS SINGZ_ANDROID_AUDIO_HOST_RT_SOURCES)
  file(APPEND "${_android_audio_host_rt_manifest}"
    "  [==[${_source}]==]\n")
endforeach()
file(APPEND "${_android_audio_host_rt_manifest}" ")\n")
file(APPEND "${_android_audio_host_rt_manifest}"
  "set(SINGZ_ANDROID_AUDIO_HOST_RT_PROJECT_INCLUDE_ROOTS\n"
  "  [==[${CMAKE_CURRENT_SOURCE_DIR}/include]==]\n"
  "  [==[${CMAKE_CURRENT_SOURCE_DIR}/platform/android]==]\n"
  ")\n")
set_property(GLOBAL PROPERTY SINGZ_ANDROID_AUDIO_HOST_RT_MANIFEST
  "${_android_audio_host_rt_manifest}")
add_custom_target(singz_check_android_audio_host_realtime ALL
  COMMAND "${CMAKE_COMMAND}"
    "-DSINGZ_ANDROID_AUDIO_HOST_RT_MANIFEST=${_android_audio_host_rt_manifest}"
    -P "${CMAKE_CURRENT_SOURCE_DIR}/../cmake/CheckAndroidAudioHostRealtime.cmake"
  VERBATIM
  COMMENT "Checking Android AudioHost callback source policy")
if(ANDROID)
  string(REGEX REPLACE "^android-" "" _android_api "${ANDROID_PLATFORM}")
  if(ANDROID_ABI STREQUAL "arm64-v8a")
    set(_android_fixture_target "aarch64-none-linux-android${_android_api}")
  elseif(ANDROID_ABI STREQUAL "armeabi-v7a")
    set(_android_fixture_target
      "armv7-none-linux-androideabi${_android_api}")
  elseif(ANDROID_ABI STREQUAL "x86_64")
    set(_android_fixture_target "x86_64-none-linux-android${_android_api}")
  elseif(ANDROID_ABI STREQUAL "x86")
    set(_android_fixture_target "i686-none-linux-android${_android_api}")
  else()
    message(FATAL_ERROR
      "Android AudioHost RT negative proof has no target for ${ANDROID_ABI}")
  endif()
  add_custom_target(singz_check_android_audio_host_realtime_negative
    COMMAND "${CMAKE_COMMAND}"
      "-DSINGZ_ANDROID_AUDIO_HOST_RT_MANIFEST=${_android_audio_host_rt_manifest}"
      "-DSINGZ_ANDROID_AUDIO_HOST_RT_CHECKER=${CMAKE_CURRENT_SOURCE_DIR}/../cmake/CheckAndroidAudioHostRealtime.cmake"
      "-DSINGZ_ANDROID_AUDIO_HOST_RT_TEST_DIR=${CMAKE_CURRENT_BINARY_DIR}/android-audio-host-rt-negative"
      "-DSINGZ_ANDROID_AUDIO_HOST_RT_CXX_COMPILER=${CMAKE_CXX_COMPILER}"
      "-DSINGZ_ANDROID_AUDIO_HOST_RT_CXX_COMPILER_ID=${CMAKE_CXX_COMPILER_ID}"
      "-DSINGZ_ANDROID_AUDIO_HOST_RT_CXX_TARGET=${_android_fixture_target}"
      "-DSINGZ_ANDROID_AUDIO_HOST_RT_CXX_SYSROOT=${CMAKE_SYSROOT}"
      "-DSINGZ_ANDROID_AUDIO_HOST_RT_OBJCOPY=${CMAKE_OBJCOPY}"
      -P "${CMAKE_CURRENT_SOURCE_DIR}/../cmake/TestAndroidAudioHostRealtimePolicy.cmake"
    VERBATIM
    COMMENT "Checking Android AudioHost RT negative fixtures with NDK Clang")
endif()

set(ZCORE_DEVICE_SOURCES
  src/device/audio_input.cpp
  src/device/audio_input_wake.cpp
  src/device/audio_host.cpp
  src/device/audio_host_fifo.cpp
  src/device/audio_host_unsupported.cpp
  platform/android/audio_input_android_policy.cpp
  platform/android/audio_host_android_policy.cpp
  platform/ios/audio_host_ios_helpers.cpp)
if(ANDROID)
  list(APPEND ZCORE_DEVICE_SOURCES
    ${SINGZ_ANDROID_AUDIO_HOST_RT_SOURCES}
    platform/android/audio_host_android.cpp
    platform/android/audio_host_android_registry.cpp
    platform/android/audio_input_android.cpp
    platform/android/audio_input_android_registry.cpp
    platform/android/audio_input_wake_android.cpp)
elseif(APPLE)
  # Portable callback policy stays available to host-native conformance tests.
  list(APPEND ZCORE_DEVICE_SOURCES
    platform/android/audio_host_android_callback_policy.cpp)
  if(CMAKE_SYSTEM_NAME STREQUAL "iOS")
    list(APPEND ZCORE_DEVICE_SOURCES
      ${SINGZ_IOS_AUDIO_HOST_RT_SOURCES}
      platform/ios/audio_host_ios.mm
      platform/ios/audio_input_ios.mm
      platform/ios/audio_input_ios_session.cpp
      platform/ios/audio_input_ios_session.mm
      platform/ios/audio_input_wake_ios.cpp)
  else()
    list(APPEND ZCORE_DEVICE_SOURCES
      platform/macos/audio_host_macos.cpp
      platform/ios/audio_input_ios_session.cpp
      platform/macos/audio_input_macos.cpp
      platform/macos/audio_input_wake_macos.cpp)
  endif()
elseif(WIN32)
  list(APPEND ZCORE_DEVICE_SOURCES
    platform/android/audio_host_android_callback_policy.cpp
    platform/windows/audio_host_windows.cpp
    platform/windows/audio_host_windows_helpers.cpp
    platform/windows/audio_input_windows_helpers.cpp
    platform/ios/audio_input_ios_session.cpp
    platform/windows/audio_input_windows.cpp
    platform/windows/audio_input_wake_windows.cpp)
else()
  list(APPEND ZCORE_DEVICE_SOURCES
    platform/android/audio_host_android_callback_policy.cpp
    platform/ios/audio_input_ios_session.cpp
    platform/unsupported/audio_host_unsupported.cpp)
endif()

add_library(zcore_device STATIC ${ZCORE_DEVICE_SOURCES})
add_library(SingZ::zcore_device ALIAS zcore_device)
singz_zcore_target(zcore_device)
target_include_directories(zcore_device PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}/platform/android")
add_dependencies(zcore_device
  singz_check_android_audio_host_realtime
  singz_check_ios_audio_host_realtime)
target_link_libraries(zcore_device PUBLIC
  SingZ::zcore_audio
  Threads::Threads)
if(SINGZ_CORE_TESTS)
  target_compile_definitions(zcore_device PRIVATE SINGZ_CORE_TESTS=1)
endif()
if(WIN32)
  target_compile_definitions(zcore_device PRIVATE
    WIN32_LEAN_AND_MEAN NOMINMAX _WIN32_WINNT=0x0A00)
  target_link_libraries(zcore_device PUBLIC avrt ole32 uuid)
elseif(ANDROID)
  # The capture provider uses Oboe's conversion and device-quirk layer. Its
  # prefab target carries the raw AAudio dependency transitively.
  find_package(oboe REQUIRED CONFIG)
  target_link_libraries(zcore_device PUBLIC oboe::oboe android dl log)
  set_property(SOURCE ${SINGZ_ANDROID_AUDIO_HOST_RT_SOURCES}
    APPEND PROPERTY COMPILE_OPTIONS -fno-exceptions -fno-rtti)
  set_property(SOURCE
    platform/android/audio_host_android_callback.cpp
    platform/android/audio_host_android_callback_policy.cpp
    APPEND PROPERTY COMPILE_DEFINITIONS SINGZ_ANDROID_AUDIO_HOST_RT_COMPILE=1)
elseif(APPLE)
  target_link_libraries(zcore_device PUBLIC
    "-framework AudioToolbox"
    "-framework CoreAudio"
    "-framework CoreFoundation")
  if(CMAKE_SYSTEM_NAME STREQUAL "iOS")
    target_link_libraries(zcore_device PUBLIC "-framework AVFoundation")
    set_source_files_properties(
      platform/ios/audio_host_ios.mm
      platform/ios/audio_input_ios.mm
      platform/ios/audio_input_ios_session.mm
      PROPERTIES COMPILE_OPTIONS "-fobjc-arc")
    set_source_files_properties(platform/ios/audio_host_ios_callback.cpp
      APPEND PROPERTY COMPILE_OPTIONS "-fno-exceptions;-fno-rtti")
  else()
    set_source_files_properties(
      platform/macos/audio_input_macos.cpp
      platform/macos/audio_host_macos.cpp
      PROPERTIES COMPILE_OPTIONS "-fblocks")
  endif()
endif()

# Deterministic standalone/test provider. Keep threads and synthetic sample
# generation out of shipping device archives and mobile product links.
add_library(zcore_device_fake STATIC EXCLUDE_FROM_ALL
  test_support/audio_host_fake.cpp)
add_library(SingZ::zcore_device_fake ALIAS zcore_device_fake)
singz_zcore_target(zcore_device_fake)
target_link_libraries(zcore_device_fake PUBLIC
  SingZ::zcore_device
  Threads::Threads)
target_sources(zcore_device_fake PRIVATE
  include/zcore/device/audio_host_fake.h)

if(APPLE)
  add_custom_target(zcore_apple_audio_host_smoke
    COMMAND bash
      "${CMAKE_CURRENT_SOURCE_DIR}/build-apple-audio-host-smoke.sh"
      "${CMAKE_CURRENT_SOURCE_DIR}/.."
      "${CMAKE_CURRENT_BINARY_DIR}/apple-audio-host-smoke"
    VERBATIM
    COMMENT "Building isolated zcore AudioHost iOS device/simulator contracts")
endif()

get_target_property(_zcore_callback_links zcore_device_callback LINK_LIBRARIES)
if(_zcore_callback_links MATCHES
   "Threads|avrt|ole32|uuid|aaudio|oboe|android|dl|log|framework|zdsp")
  message(FATAL_ERROR
    "zcore_device_callback acquired provider/control/platform ownership: "
    "${_zcore_callback_links}")
endif()
get_target_property(_zcore_device_links zcore_device LINK_LIBRARIES)
if(NOT _zcore_device_links MATCHES
   "zcore_audio|SingZ::zcore_audio")
  message(FATAL_ERROR
    "zcore_device must compose zcore_audio and its strict callback leaf")
endif()
get_target_property(_zcore_audio_links zcore_audio LINK_LIBRARIES)
if(NOT _zcore_audio_links MATCHES
   "zcore_device_callback|SingZ::zcore_device_callback")
  message(FATAL_ERROR
    "zcore_audio must preserve its API by composing zcore_device_callback")
endif()

add_library(zcore_media STATIC
  src/media/decoded_audio.cpp
  src/media/flac_io.cpp
  src/media/wav.cpp)
add_library(SingZ::zcore_media ALIAS zcore_media)
singz_zcore_target(zcore_media)
target_link_libraries(zcore_media
  PUBLIC SingZ::zcore_base
  PRIVATE
    SingZ::zcore_resample
    SingZ::native_flac)
if(ANDROID)
  target_compile_definitions(zcore_media PRIVATE _FILE_OFFSET_BITS=64)
endif()

# Remaining legacy facade during Phase 2. Shared live YIN and rate-conversion
# implementations compile only in their narrow targets above. This target
# deliberately excludes ONNX Runtime.
add_library(zcore_legacy STATIC
  src/legacy/audio_input_analysis_adapter.cpp
  src/legacy/analysis.cpp
  src/legacy/beat_this.cpp
  src/legacy/beats.cpp
  src/legacy/courts.cpp
  src/legacy/melody.cpp)
add_library(SingZ::zcore_legacy ALIAS zcore_legacy)
singz_zcore_target(zcore_legacy)
target_link_libraries(zcore_legacy PUBLIC
  SingZ::zcore_live_analysis_compat
  SingZ::zcore_audio
  SingZ::zcore_device
  SingZ::zcore_media)
if(SINGZ_CORE_TESTS)
  target_compile_definitions(zcore_legacy PRIVATE SINGZ_CORE_TESTS=1)
endif()

if(SINGZ_BUILD_ML)
  if(NOT TARGET onnxruntime)
    message(FATAL_ERROR "SINGZ_BUILD_ML requires an onnxruntime target")
  endif()
  add_library(zcore_ml STATIC
    src/legacy/beat_this_ort.cpp
    src/legacy/ort_env.cpp
    src/legacy/split_engine.cpp)
  add_library(SingZ::zcore_ml ALIAS zcore_ml)
  singz_zcore_target(zcore_ml)
  target_link_libraries(zcore_ml PRIVATE
    SingZ::zcore_legacy
    SingZ::zcore_media
    onnxruntime)
  if(ANDROID)
    target_compile_options(zcore_ml PRIVATE -fexceptions -frtti)
    target_compile_definitions(zcore_ml PRIVATE _FILE_OFFSET_BITS=64)
  endif()
endif()

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

add_library(zcore_audio STATIC
  src/audio/audio_input_convert.cpp
  src/audio/audio_input_transport.cpp
  src/audio/audio_input_timestamp.cpp)
add_library(SingZ::zcore_audio ALIAS zcore_audio)
singz_zcore_target(zcore_audio)
target_link_libraries(zcore_audio
  PUBLIC SingZ::zcore_base
  PRIVATE Threads::Threads)
singz_configure_realtime_target(zcore_audio)

set(ZCORE_DEVICE_SOURCES
  src/device/audio_input.cpp
  src/device/audio_input_wake.cpp
  platform/android/audio_input_android_policy.cpp)
if(ANDROID)
  list(APPEND ZCORE_DEVICE_SOURCES
    platform/android/audio_input_android.cpp
    platform/android/audio_input_android_registry.cpp
    platform/android/audio_input_wake_android.cpp)
elseif(APPLE)
  if(CMAKE_SYSTEM_NAME STREQUAL "iOS")
    list(APPEND ZCORE_DEVICE_SOURCES
      platform/ios/audio_input_ios.mm
      platform/ios/audio_input_ios_session.cpp
      platform/ios/audio_input_ios_session.mm
      platform/ios/audio_input_wake_ios.cpp)
  else()
    list(APPEND ZCORE_DEVICE_SOURCES
      platform/ios/audio_input_ios_session.cpp
      platform/macos/audio_input_macos.cpp
      platform/macos/audio_input_wake_macos.cpp)
  endif()
elseif(WIN32)
  list(APPEND ZCORE_DEVICE_SOURCES
    platform/ios/audio_input_ios_session.cpp
    platform/windows/audio_input_windows.cpp
    platform/windows/audio_input_wake_windows.cpp)
else()
  list(APPEND ZCORE_DEVICE_SOURCES platform/ios/audio_input_ios_session.cpp)
endif()

add_library(zcore_device STATIC ${ZCORE_DEVICE_SOURCES})
add_library(SingZ::zcore_device ALIAS zcore_device)
singz_zcore_target(zcore_device)
target_link_libraries(zcore_device PUBLIC SingZ::zcore_audio Threads::Threads)
if(SINGZ_CORE_TESTS)
  target_compile_definitions(zcore_device PRIVATE SINGZ_CORE_TESTS=1)
endif()
if(WIN32)
  target_compile_definitions(zcore_device PRIVATE
    WIN32_LEAN_AND_MEAN NOMINMAX _WIN32_WINNT=0x0A00)
  target_link_libraries(zcore_device PUBLIC avrt ole32 uuid)
elseif(ANDROID)
  target_link_libraries(zcore_device PUBLIC aaudio android dl log)
elseif(APPLE)
  target_link_libraries(zcore_device PUBLIC
    "-framework AudioToolbox"
    "-framework CoreAudio"
    "-framework CoreFoundation")
  if(CMAKE_SYSTEM_NAME STREQUAL "iOS")
    target_link_libraries(zcore_device PUBLIC "-framework AVFoundation")
  else()
    set_source_files_properties(platform/macos/audio_input_macos.cpp
      PROPERTIES COMPILE_OPTIONS "-fblocks")
  endif()
endif()

add_library(zcore_media STATIC
  src/media/flac_io.cpp
  src/media/wav.cpp)
add_library(SingZ::zcore_media ALIAS zcore_media)
singz_zcore_target(zcore_media)
target_link_libraries(zcore_media
  PUBLIC SingZ::zcore_base
  PRIVATE SingZ::native_flac)
if(ANDROID)
  target_compile_definitions(zcore_media PRIVATE _FILE_OFFSET_BITS=64)
endif()

# Temporary home for the proven analysis implementation while Phase 0B
# freezes the new graph contracts. It deliberately excludes ONNX Runtime.
add_library(zcore_legacy STATIC
  src/legacy/audio_input_analysis_adapter.cpp
  src/legacy/analysis.cpp
  src/legacy/beat_this.cpp
  src/legacy/beats.cpp
  src/legacy/courts.cpp
  src/legacy/live_input_analysis.cpp
  src/legacy/melody.cpp
  src/legacy/resample.cpp)
add_library(SingZ::zcore_legacy ALIAS zcore_legacy)
singz_zcore_target(zcore_legacy)
target_link_libraries(zcore_legacy PUBLIC
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

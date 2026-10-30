cmake_minimum_required(VERSION 3.20)
project(AudioZ VERSION 1.0.0 LANGUAGES C CXX)

option(AUDIOZ_BUILD_MEDIA "Build file and streaming media support" OFF)
option(AUDIOZ_BUILD_ANALYSIS "Build delivery-thread analysis adapters" OFF)
option(AUDIOZ_BUILD_TESTS "Build reusable AudioZ tests" OFF)
option(AUDIOZ_BUILD_BENCHMARKS "Build AudioZ benchmarks" OFF)
find_package(Threads REQUIRED)

if(NOT TARGET SingZ::native_build_options)
  add_library(audioz_build_options INTERFACE)
  add_library(SingZ::native_build_options ALIAS audioz_build_options)
  add_library(AudioZ::build_options ALIAS audioz_build_options)
  target_compile_options(audioz_build_options INTERFACE
    "$<$<C_COMPILER_ID:MSVC>:/utf-8>" "$<$<CXX_COMPILER_ID:MSVC>:/utf-8>")
  target_compile_definitions(audioz_build_options INTERFACE _USE_MATH_DEFINES)
endif()
include(cmake/SingZRealtimeTarget.cmake)

add_library(zcore_base INTERFACE)
add_library(SingZ::zcore_base ALIAS zcore_base)
add_library(AudioZ::base ALIAS zcore_base)
target_compile_features(zcore_base INTERFACE cxx_std_20)
target_include_directories(zcore_base INTERFACE zcore/include)
target_link_libraries(zcore_base INTERFACE SingZ::native_build_options)

add_library(zcore_resample STATIC zcore/src/legacy/resample.cpp)
add_library(SingZ::zcore_resample ALIAS zcore_resample)
add_library(AudioZ::resample ALIAS zcore_resample)
target_compile_features(zcore_resample PUBLIC cxx_std_20)
set_target_properties(zcore_resample PROPERTIES POSITION_INDEPENDENT_CODE YES)
target_include_directories(zcore_resample PUBLIC zcore/include)
target_link_libraries(zcore_resample PUBLIC SingZ::zcore_base)

add_library(zcore_live_analysis_compat STATIC zcore/src/legacy/live_input_analysis.cpp)
add_library(SingZ::zcore_live_analysis_compat ALIAS zcore_live_analysis_compat)
add_library(AudioZ::live_analysis_compat ALIAS zcore_live_analysis_compat)
target_compile_features(zcore_live_analysis_compat PUBLIC cxx_std_20)
set_target_properties(zcore_live_analysis_compat PROPERTIES POSITION_INDEPENDENT_CODE YES)
target_include_directories(zcore_live_analysis_compat PUBLIC zcore/include)
target_link_libraries(zcore_live_analysis_compat PUBLIC SingZ::zcore_base SingZ::zcore_resample)

add_library(zcore_audio STATIC zcore/src/audio/audio_input_transport.cpp)
add_library(SingZ::zcore_audio ALIAS zcore_audio)
add_library(AudioZ::audio ALIAS zcore_audio)
target_compile_features(zcore_audio PUBLIC cxx_std_20)
set_target_properties(zcore_audio PROPERTIES POSITION_INDEPENDENT_CODE YES)
target_include_directories(zcore_audio PUBLIC zcore/include)
target_link_libraries(zcore_audio PUBLIC SingZ::zcore_base PRIVATE Threads::Threads)

add_library(zcore_device_callback STATIC
  zcore/src/audio/audio_input_convert.cpp zcore/src/audio/audio_input_timestamp.cpp
  zcore/src/audio/audio_input_transport_callback.cpp zcore/src/device/audio_input_callback.cpp
  zcore/src/device/audio_input_callback_gate.cpp zcore/src/device/audio_host_callback.cpp
  zcore/src/device/audio_host_fifo_hot.cpp)
add_library(SingZ::zcore_device_callback ALIAS zcore_device_callback)
target_compile_features(zcore_device_callback PUBLIC cxx_std_20)
set_target_properties(zcore_device_callback PROPERTIES POSITION_INDEPENDENT_CODE YES)
target_include_directories(zcore_device_callback PUBLIC zcore/include)
target_link_libraries(zcore_device_callback PUBLIC SingZ::zcore_base)
target_sources(zcore_device_callback PRIVATE
  zcore/include/zcore/audio/audio_input_convert.h
  zcore/include/zcore/audio/audio_input_producer.h
  zcore/include/zcore/audio/audio_input_timestamp.h
  zcore/include/zcore/device/audio_input_callback_gate.h
  zcore/include/zcore/device/audio_host_callback.h
  zcore/include/zcore/device/audio_host_render.h
  zcore/src/audio/audio_input_transport_internal.h
  zcore/src/device/audio_input_callback.h)
target_compile_options(zcore_device_callback PRIVATE $<$<NOT:$<CXX_COMPILER_ID:MSVC>>:-fno-exceptions;-fno-rtti>)
set_target_properties(zcore_device_callback PROPERTIES CXX_VISIBILITY_PRESET hidden VISIBILITY_INLINES_HIDDEN YES)
singz_configure_realtime_target(zcore_device_callback)
target_link_libraries(zcore_audio PUBLIC SingZ::zcore_device_callback)

set(AUDIOZ_DEVICE_SOURCES
  zcore/src/device/audio_input.cpp zcore/src/device/audio_input_wake.cpp
  zcore/src/device/audio_host.cpp zcore/src/device/audio_host_fifo.cpp
  zcore/src/device/audio_host_unsupported.cpp
  zcore/platform/android/audio_input_android_policy.cpp
  zcore/platform/android/audio_host_android_policy.cpp
  zcore/platform/ios/audio_host_ios_helpers.cpp)
if(ANDROID)
  list(APPEND AUDIOZ_DEVICE_SOURCES zcore/platform/android/audio_host_android_callback.cpp
    zcore/platform/android/audio_host_android_callback_policy.cpp
    zcore/platform/android/audio_host_android.cpp zcore/platform/android/audio_host_android_registry.cpp
    zcore/platform/android/audio_input_android.cpp zcore/platform/android/audio_input_android_registry.cpp
    zcore/platform/android/audio_input_wake_android.cpp)
elseif(APPLE)
  list(APPEND AUDIOZ_DEVICE_SOURCES zcore/platform/android/audio_host_android_callback_policy.cpp)
  if(CMAKE_SYSTEM_NAME STREQUAL "iOS")
    list(APPEND AUDIOZ_DEVICE_SOURCES zcore/platform/ios/audio_host_ios_callback.cpp
      zcore/platform/ios/audio_host_ios_helpers.cpp zcore/platform/ios/audio_host_ios.mm
      zcore/platform/ios/audio_input_ios.mm zcore/platform/ios/audio_input_ios_session.cpp
      zcore/platform/ios/audio_input_ios_session.mm zcore/platform/ios/audio_input_wake_ios.cpp)
    set_source_files_properties(zcore/platform/ios/audio_host_ios.mm zcore/platform/ios/audio_input_ios.mm
      zcore/platform/ios/audio_input_ios_session.mm PROPERTIES COMPILE_OPTIONS "-fobjc-arc")
    set_property(SOURCE zcore/platform/ios/audio_host_ios_callback.cpp APPEND PROPERTY
      COMPILE_OPTIONS "-fno-exceptions;-fno-rtti")
  else()
    list(APPEND AUDIOZ_DEVICE_SOURCES zcore/platform/macos/audio_host_macos.cpp
      zcore/platform/ios/audio_input_ios_session.cpp zcore/platform/macos/audio_input_macos.cpp
      zcore/platform/macos/audio_input_wake_macos.cpp)
    set_source_files_properties(zcore/platform/macos/audio_input_macos.cpp
      zcore/platform/macos/audio_host_macos.cpp PROPERTIES COMPILE_OPTIONS "-fblocks")
  endif()
elseif(WIN32)
  list(APPEND AUDIOZ_DEVICE_SOURCES zcore/platform/android/audio_host_android_callback_policy.cpp
    zcore/platform/windows/audio_host_windows.cpp zcore/platform/windows/audio_host_windows_helpers.cpp
    zcore/platform/windows/audio_host_windows_provider.cpp zcore/platform/windows/audio_host_asio.cpp
    zcore/platform/windows/audio_input_windows_helpers.cpp zcore/platform/ios/audio_input_ios_session.cpp
    zcore/platform/windows/audio_input_windows.cpp zcore/platform/windows/audio_input_wake_windows.cpp)
elseif(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  list(APPEND AUDIOZ_DEVICE_SOURCES
    zcore/platform/android/audio_host_android_callback_policy.cpp
    zcore/platform/ios/audio_input_ios_session.cpp
    zcore/platform/linux/alsa_pcm.cpp zcore/platform/linux/alsa_capture.cpp
    zcore/platform/linux/audio_host_linux.cpp zcore/platform/linux/audio_input_linux.cpp
    zcore/platform/linux/audio_input_wake_linux.cpp)
else()
  list(APPEND AUDIOZ_DEVICE_SOURCES zcore/platform/android/audio_host_android_callback_policy.cpp
    zcore/platform/ios/audio_input_ios_session.cpp zcore/platform/unsupported/audio_host_unsupported.cpp)
endif()
add_library(zcore_device STATIC ${AUDIOZ_DEVICE_SOURCES})
add_library(SingZ::zcore_device ALIAS zcore_device)
add_library(AudioZ::device ALIAS zcore_device)
target_compile_features(zcore_device PUBLIC cxx_std_20)
set_target_properties(zcore_device PROPERTIES POSITION_INDEPENDENT_CODE YES)
target_include_directories(zcore_device PUBLIC zcore/include PRIVATE zcore/platform/android)
target_link_libraries(zcore_device PUBLIC SingZ::zcore_audio Threads::Threads)
if(AUDIOZ_BUILD_TESTS OR (DEFINED SINGZ_CORE_TESTS AND SINGZ_CORE_TESTS))
  target_compile_definitions(zcore_device PRIVATE SINGZ_CORE_TESTS=1)
endif()
if(WIN32)
  target_compile_definitions(zcore_device PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX _WIN32_WINNT=0x0A00)
  target_link_libraries(zcore_device PUBLIC avrt ole32 uuid)
elseif(ANDROID)
  find_package(oboe REQUIRED CONFIG)
  target_link_libraries(zcore_device PUBLIC oboe::oboe android dl log)
  set_property(SOURCE zcore/platform/android/audio_host_android_callback.cpp
    zcore/platform/android/audio_host_android_callback_policy.cpp APPEND PROPERTY
    COMPILE_OPTIONS "-fno-exceptions;-fno-rtti")
  set_property(SOURCE zcore/platform/android/audio_host_android_callback.cpp
    zcore/platform/android/audio_host_android_callback_policy.cpp APPEND PROPERTY
    COMPILE_DEFINITIONS SINGZ_ANDROID_AUDIO_HOST_RT_COMPILE=1)
elseif(APPLE)
  target_link_libraries(zcore_device PUBLIC "-framework AudioToolbox" "-framework CoreAudio" "-framework CoreFoundation")
  if(CMAKE_SYSTEM_NAME STREQUAL "iOS")
    target_link_libraries(zcore_device PUBLIC "-framework AVFoundation")
  endif()
elseif(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  find_package(ALSA REQUIRED)
  find_package(PkgConfig REQUIRED)
  pkg_check_modules(UDEV REQUIRED IMPORTED_TARGET libudev)
  target_compile_definitions(zcore_device PRIVATE SINGZ_HAS_ALSA=1)
  target_link_libraries(zcore_device PUBLIC ALSA::ALSA PkgConfig::UDEV)
endif()

add_library(zdsp_api INTERFACE)
add_library(SingZ::zdsp_api ALIAS zdsp_api)
add_library(AudioZ::dsp_api ALIAS zdsp_api)
target_compile_features(zdsp_api INTERFACE cxx_std_20)
target_include_directories(zdsp_api INTERFACE zdsp/include)
target_link_libraries(zdsp_api INTERFACE SingZ::zcore_base)
set(AUDIOZ_GRAPH_RUNNER_SOURCE "${CMAKE_CURRENT_SOURCE_DIR}/zdsp/src/runtime/graph_runner.cpp" CACHE FILEPATH
  "Optional validated graph-runner source overlay")
set(AUDIOZ_BUILTIN_NODES_SOURCE "${CMAKE_CURRENT_SOURCE_DIR}/zdsp/src/runtime/builtin_nodes.cpp" CACHE FILEPATH
  "Optional validated built-in processor source overlay")
foreach(_overlay IN ITEMS AUDIOZ_GRAPH_RUNNER_SOURCE AUDIOZ_BUILTIN_NODES_SOURCE)
  if(NOT EXISTS "${${_overlay}}")
    message(FATAL_ERROR "${_overlay} does not exist: ${${_overlay}}")
  endif()
endforeach()
add_library(zdsp_runtime STATIC zdsp/src/api/contracts.cpp zdsp/src/runtime/realtime_arena.cpp
  "${AUDIOZ_BUILTIN_NODES_SOURCE}" zdsp/src/runtime/decoded_buffer_source.cpp
  zdsp/src/runtime/streaming_window_source.cpp zdsp/src/runtime/scheduled_cue_source.cpp
  zdsp/src/runtime/scheduled_gain.cpp zdsp/src/runtime/graph_compiler.cpp "${AUDIOZ_GRAPH_RUNNER_SOURCE}")
add_library(SingZ::zdsp_runtime ALIAS zdsp_runtime)
add_library(AudioZ::runtime ALIAS zdsp_runtime)
target_compile_features(zdsp_runtime PUBLIC cxx_std_20)
set_target_properties(zdsp_runtime PROPERTIES POSITION_INDEPENDENT_CODE YES)
target_include_directories(zdsp_runtime PUBLIC zdsp/include PRIVATE zdsp/src/runtime)
target_link_libraries(zdsp_runtime PUBLIC SingZ::zdsp_api)
target_sources(zdsp_runtime PRIVATE
  zdsp/include/zdsp/types.h zdsp/include/zdsp/events.h zdsp/include/zdsp/clock.h
  zdsp/include/zdsp/audio_bus.h zdsp/include/zdsp/process_context.h zdsp/include/zdsp/processor.h
  zdsp/include/zdsp/latency.h zdsp/include/zdsp/realtime_arena.h zdsp/include/zdsp/queues.h
  zdsp/include/zdsp/builtin_nodes.h zdsp/include/zdsp/decoded_buffer_source.h
  zdsp/include/zdsp/streaming_window_source.h zdsp/include/zdsp/scheduled_cue_source.h
  zdsp/include/zdsp/scheduled_gain.h zdsp/include/zdsp/graph.h zdsp/include/zdsp/graph_runner.h
  zdsp/src/runtime/graph_internal.h)
target_compile_options(zdsp_runtime PRIVATE $<$<NOT:$<CXX_COMPILER_ID:MSVC>>:-fno-exceptions;-fno-rtti>)
set_target_properties(zdsp_runtime PROPERTIES CXX_EXTENSIONS OFF POSITION_INDEPENDENT_CODE YES CXX_VISIBILITY_PRESET hidden VISIBILITY_INLINES_HIDDEN YES)
singz_configure_realtime_target(zdsp_runtime)
add_library(zdsp_host_adapter STATIC zdsp/src/runtime/audio_host_graph_adapter.cpp)
add_library(SingZ::zdsp_host_adapter ALIAS zdsp_host_adapter)
target_compile_features(zdsp_host_adapter PUBLIC cxx_std_20)
target_include_directories(zdsp_host_adapter PUBLIC zdsp/include)
target_link_libraries(zdsp_host_adapter PUBLIC SingZ::zdsp_runtime SingZ::zcore_device)
target_sources(zdsp_host_adapter PRIVATE zdsp/include/zdsp/audio_host_graph_adapter.h)
set_target_properties(zdsp_host_adapter PROPERTIES CXX_EXTENSIONS OFF POSITION_INDEPENDENT_CODE YES CXX_VISIBILITY_PRESET hidden VISIBILITY_INLINES_HIDDEN YES)
singz_configure_realtime_target(zdsp_host_adapter)

add_library(zdsp_offline STATIC EXCLUDE_FROM_ALL zdsp/src/offline/offline_renderer.cpp)
add_library(SingZ::zdsp_offline ALIAS zdsp_offline)
target_compile_features(zdsp_offline PUBLIC cxx_std_20)
target_include_directories(zdsp_offline PUBLIC zdsp/include)
target_link_libraries(zdsp_offline PUBLIC SingZ::zdsp_runtime)
set_target_properties(zdsp_offline PROPERTIES CXX_EXTENSIONS OFF POSITION_INDEPENDENT_CODE YES CXX_VISIBILITY_PRESET hidden VISIBILITY_INLINES_HIDDEN YES)
singz_configure_realtime_target(zdsp_offline)
add_library(zdsp_prototype STATIC EXCLUDE_FROM_ALL zdsp/src/prototype/gain_meter.cpp)
add_library(SingZ::zdsp_prototype ALIAS zdsp_prototype)
target_compile_features(zdsp_prototype PUBLIC cxx_std_20)
target_include_directories(zdsp_prototype PUBLIC zdsp/include)
target_link_libraries(zdsp_prototype PUBLIC SingZ::zdsp_runtime)
target_sources(zdsp_prototype PRIVATE zdsp/include/zdsp/prototype_gain_meter.h)
set_target_properties(zdsp_prototype PROPERTIES CXX_EXTENSIONS OFF POSITION_INDEPENDENT_CODE YES CXX_VISIBILITY_PRESET hidden VISIBILITY_INLINES_HIDDEN YES)
singz_configure_realtime_target(zdsp_prototype)
add_library(zdsp_control STATIC EXCLUDE_FROM_ALL zdsp/src/control/graph_fixture.cpp)
add_library(SingZ::zdsp_control ALIAS zdsp_control)
target_compile_features(zdsp_control PUBLIC cxx_std_20)
target_include_directories(zdsp_control PUBLIC zdsp/include)
target_link_libraries(zdsp_control PUBLIC SingZ::zdsp_api)

option(SINGZ_ENABLE_FFMPEG_CODECS "Enable pinned dynamic FFmpeg codecs" OFF)
if(AUDIOZ_BUILD_MEDIA)
  add_subdirectory(third_party/native)
  add_library(zcore_media STATIC zcore/src/media/owned_file_descriptor.cpp zcore/src/media/decoded_audio.cpp
    zcore/src/media/ffmpeg_decoder.cpp zcore/src/media/flac_io.cpp zcore/src/media/flac_streaming_source.cpp
    zcore/src/media/media_format.cpp zcore/src/media/media_io.cpp zcore/src/media/mp3_streaming_source.cpp
    zcore/src/media/streaming_audio_source.cpp zcore/src/media/wav.cpp zcore/src/media/wav_streaming_source.cpp)
  add_library(SingZ::zcore_media ALIAS zcore_media)
  target_compile_features(zcore_media PUBLIC cxx_std_20)
  target_include_directories(zcore_media PUBLIC zcore/include)
  target_include_directories(zcore_media SYSTEM PRIVATE third_party/native/dr_mp3)
  target_link_libraries(zcore_media PUBLIC SingZ::zcore_base PRIVATE SingZ::zcore_resample SingZ::native_flac)
  set_target_properties(zcore_media PROPERTIES POSITION_INDEPENDENT_CODE YES)
  if(ANDROID)
    target_compile_definitions(zcore_media PRIVATE _FILE_OFFSET_BITS=64)
  endif()
  if(SINGZ_ENABLE_FFMPEG_CODECS)
    if(NOT TARGET SingZ::ffmpeg_dynamic)
      message(FATAL_ERROR "FFmpeg enabled without consumer-provided validated dynamic target")
    endif()
    target_compile_definitions(zcore_media PRIVATE SINGZ_ZCORE_FFMPEG=1)
    target_link_libraries(zcore_media PRIVATE SingZ::ffmpeg_dynamic)
  endif()
endif()
if(AUDIOZ_BUILD_ANALYSIS)
  add_library(zdsp_analysis STATIC zdsp/src/analysis/pitch_analysis_module.cpp zdsp/src/analysis/crepe_tiny.cpp
    zdsp/src/analysis/capture_adapter.cpp zdsp/src/analysis/live_input_analyzer.cpp)
  add_library(SingZ::zdsp_analysis ALIAS zdsp_analysis)
  target_compile_features(zdsp_analysis PUBLIC cxx_std_20)
  target_include_directories(zdsp_analysis PUBLIC zdsp/include)
  target_link_libraries(zdsp_analysis PUBLIC SingZ::zdsp_api SingZ::zcore_audio SingZ::zcore_live_analysis_compat SingZ::zdsp_runtime)
  set_target_properties(zdsp_analysis PROPERTIES CXX_EXTENSIONS OFF POSITION_INDEPENDENT_CODE YES CXX_VISIBILITY_PRESET hidden VISIBILITY_INLINES_HIDDEN YES)
  if(APPLE)
    target_link_libraries(zdsp_analysis PRIVATE "-framework Accelerate")
  endif()
endif()
if(AUDIOZ_BUILD_TESTS)
  enable_testing()
  foreach(_test IN ITEMS zdsp_contract_tests streaming_window_source_tests zdsp_graph_tests)
    add_executable(${_test} zdsp/tests/${_test}.cpp)
    target_compile_features(${_test} PRIVATE cxx_std_20)
    target_link_libraries(${_test} PRIVATE Threads::Threads)
    add_test(NAME ${_test} COMMAND ${_test})
  endforeach()
  target_link_libraries(zdsp_contract_tests PRIVATE SingZ::zdsp_runtime SingZ::zdsp_control SingZ::zdsp_prototype)
  target_link_libraries(streaming_window_source_tests PRIVATE SingZ::zdsp_runtime)
  target_sources(zdsp_graph_tests PRIVATE zdsp/tests/allocation_trap.cpp)
  target_include_directories(zdsp_graph_tests PRIVATE zdsp/tests)
  target_link_libraries(zdsp_graph_tests PRIVATE SingZ::zdsp_offline SingZ::zdsp_prototype Threads::Threads)
  foreach(_test IN ITEMS zdsp_contract_tests streaming_window_source_tests zdsp_graph_tests)
    if(MSVC)
      target_compile_options(${_test} PRIVATE /UNDEBUG)
    else()
      target_compile_options(${_test} PRIVATE -UNDEBUG)
    endif()
  endforeach()
  foreach(_test IN ITEMS singz_containment_tests singz_planar_tests)
    add_executable(${_test} zdsp/tests/${_test}.cpp)
    target_compile_features(${_test} PRIVATE cxx_std_20)
    target_include_directories(${_test} PRIVATE zdsp/include zdsp/src/runtime)
    target_link_libraries(${_test} PRIVATE SingZ::zdsp_runtime)
    if(MSVC)
      target_compile_options(${_test} PRIVATE /UNDEBUG)
    else()
      target_compile_options(${_test} PRIVATE -UNDEBUG)
    endif()
    add_test(NAME ${_test} COMMAND ${_test})
  endforeach()
  find_package(Python3 REQUIRED COMPONENTS Interpreter)
  add_test(NAME audioz_importer_tests
    COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/scripts/test-import-audioz.py")
  if(AUDIOZ_BUILD_ANALYSIS)
    add_executable(zdsp_analysis_tests zdsp/tests/zdsp_analysis_tests.cpp)
    target_compile_features(zdsp_analysis_tests PRIVATE cxx_std_20)
    target_link_libraries(zdsp_analysis_tests PRIVATE SingZ::zdsp_analysis)
    add_test(NAME zdsp_analysis_tests COMMAND zdsp_analysis_tests)
  endif()
endif()
if(AUDIOZ_BUILD_BENCHMARKS)
  add_executable(zdsp_graph_benchmark zdsp/benchmarks/graph_benchmark.cpp)
  target_compile_features(zdsp_graph_benchmark PRIVATE cxx_std_20)
  target_link_libraries(zdsp_graph_benchmark PRIVATE SingZ::zdsp_offline)
  add_executable(zdsp_fake_host_benchmark zdsp/benchmarks/fake_host_benchmark.cpp)
  target_compile_features(zdsp_fake_host_benchmark PRIVATE cxx_std_20)
  target_link_libraries(zdsp_fake_host_benchmark PRIVATE SingZ::zdsp_prototype)
  add_executable(zdsp_builtin_benchmark zdsp/benchmarks/singz_builtin_benchmark.cpp)
  target_compile_features(zdsp_builtin_benchmark PRIVATE cxx_std_20)
  target_include_directories(zdsp_builtin_benchmark PRIVATE zdsp/include zdsp/src/runtime)
  target_link_libraries(zdsp_builtin_benchmark PRIVATE SingZ::zdsp_runtime)
endif()

# Preserve the manifest interfaces consumed by existing SingZ build checks.
function(audioz_write_source_manifest target property global_property output_name)
  set(_targets ${target})
  set(_all_sources)
  foreach(_target IN LISTS _targets)
    get_target_property(_dir ${_target} SOURCE_DIR)
    get_target_property(_sources ${_target} SOURCES)
    foreach(_source IN LISTS _sources)
      if(IS_ABSOLUTE "${_source}")
        set(_absolute "${_source}")
      else()
        get_filename_component(_absolute "${_source}" ABSOLUTE BASE_DIR "${_dir}")
      endif()
      file(TO_CMAKE_PATH "${_absolute}" _absolute)
      list(APPEND _all_sources "${_absolute}")
    endforeach()
  endforeach()
  list(REMOVE_DUPLICATES _all_sources)
  set(_manifest "${CMAKE_CURRENT_BINARY_DIR}/${output_name}")
  file(WRITE "${_manifest}" "set(${property}\n")
  foreach(_absolute IN LISTS _all_sources)
    file(APPEND "${_manifest}" "  [==[${_absolute}]==]\n")
  endforeach()
  file(APPEND "${_manifest}" ")\n")
  set_property(GLOBAL PROPERTY ${global_property} "${_manifest}")
endfunction()
audioz_write_source_manifest(zcore_device_callback SINGZ_ZCORE_RT_FILES SINGZ_ZCORE_RT_MANIFEST zcore-realtime-sources.cmake)
audioz_write_source_manifest("zdsp_runtime;zdsp_host_adapter;zdsp_prototype" SINGZ_ZDSP_RT_FILES SINGZ_ZDSP_RT_MANIFEST zdsp-realtime-sources.cmake)
set(_ios_manifest "${CMAKE_CURRENT_BINARY_DIR}/ios-audio-host-realtime-sources.cmake")
file(WRITE "${_ios_manifest}" "set(SINGZ_IOS_AUDIO_HOST_RT_FILES\n")
foreach(_f IN ITEMS zcore/platform/ios/audio_host_ios_callback.cpp zcore/platform/ios/audio_host_ios_callback.h zcore/platform/ios/audio_host_ios_session_signals.h)
  file(APPEND "${_ios_manifest}" "  [==[${CMAKE_CURRENT_SOURCE_DIR}/${_f}]==]\n")
endforeach()
file(APPEND "${_ios_manifest}" ")\n")
file(APPEND "${_ios_manifest}" "set(SINGZ_IOS_AUDIO_HOST_RT_PROJECT_INCLUDE_ROOTS\n  [==[${CMAKE_CURRENT_SOURCE_DIR}/zcore/include]==]\n)\n")
set_property(GLOBAL PROPERTY SINGZ_IOS_AUDIO_HOST_RT_MANIFEST "${_ios_manifest}")
set(_android_manifest "${CMAKE_CURRENT_BINARY_DIR}/android-audio-host-realtime-sources.cmake")
file(WRITE "${_android_manifest}" "set(SINGZ_ANDROID_AUDIO_HOST_RT_FILES\n")
foreach(_f IN ITEMS zcore/platform/android/audio_host_android_callback.cpp zcore/platform/android/audio_host_android_callback_policy.cpp zcore/platform/android/audio_host_android_callback.h)
  file(APPEND "${_android_manifest}" "  [==[${CMAKE_CURRENT_SOURCE_DIR}/${_f}]==]\n")
endforeach()
file(APPEND "${_android_manifest}" ")\n")
file(APPEND "${_android_manifest}" "set(SINGZ_ANDROID_AUDIO_HOST_RT_PROJECT_INCLUDE_ROOTS\n  [==[${CMAKE_CURRENT_SOURCE_DIR}/zcore/include]==]\n  [==[${CMAKE_CURRENT_SOURCE_DIR}/zcore/platform/android]==]\n)\n")
set_property(GLOBAL PROPERTY SINGZ_ANDROID_AUDIO_HOST_RT_MANIFEST "${_android_manifest}")

add_custom_target(singz_check_zcore_realtime ALL
  COMMAND "${CMAKE_COMMAND}" "-DSINGZ_ZCORE_RT_MANIFEST=${CMAKE_CURRENT_BINARY_DIR}/zcore-realtime-sources.cmake"
    -P "${CMAKE_CURRENT_SOURCE_DIR}/cmake/CheckZcoreRealtime.cmake"
  VERBATIM COMMENT "Checking AudioZ callback source policy")
add_custom_target(singz_check_zdsp_realtime ALL
  COMMAND "${CMAKE_COMMAND}" "-DSINGZ_ZDSP_RT_MANIFEST=${CMAKE_CURRENT_BINARY_DIR}/zdsp-realtime-sources.cmake"
    -P "${CMAKE_CURRENT_SOURCE_DIR}/cmake/CheckZdspRealtime.cmake"
  VERBATIM COMMENT "Checking AudioZ graph callback source policy")
add_custom_target(singz_check_zcore_boundaries ALL
  COMMAND "${CMAKE_COMMAND}" "-DSINGZ_ZCORE_ROOT=${CMAKE_CURRENT_SOURCE_DIR}/zcore"
    -P "${CMAKE_CURRENT_SOURCE_DIR}/cmake/CheckZcoreBoundaries.cmake"
  VERBATIM COMMENT "Checking AudioZ dependency direction")
add_custom_target(singz_check_ios_audio_host_realtime ALL
  COMMAND "${CMAKE_COMMAND}" "-DSINGZ_IOS_AUDIO_HOST_RT_MANIFEST=${_ios_manifest}"
    -P "${CMAKE_CURRENT_SOURCE_DIR}/cmake/CheckIosAudioHostRealtime.cmake"
  VERBATIM COMMENT "Checking iOS AudioHost callback policy")
add_custom_target(singz_check_android_audio_host_realtime ALL
  COMMAND "${CMAKE_COMMAND}" "-DSINGZ_ANDROID_AUDIO_HOST_RT_MANIFEST=${_android_manifest}"
    -P "${CMAKE_CURRENT_SOURCE_DIR}/cmake/CheckAndroidAudioHostRealtime.cmake"
  VERBATIM COMMENT "Checking Android AudioHost callback policy")
if(APPLE)
  add_custom_target(zcore_apple_audio_host_smoke
    COMMAND bash "${CMAKE_CURRENT_SOURCE_DIR}/zcore/build-apple-audio-host-smoke.sh"
      "${CMAKE_CURRENT_SOURCE_DIR}" "${CMAKE_CURRENT_BINARY_DIR}/apple-audio-host-smoke"
    VERBATIM COMMENT "Building isolated AudioZ AudioHost device/simulator contracts")
  add_custom_target(zdsp_apple_component_smoke
    COMMAND bash "${CMAKE_CURRENT_SOURCE_DIR}/zdsp/build-apple-component-smoke.sh"
      "${CMAKE_CURRENT_SOURCE_DIR}" "${CMAKE_CURRENT_BINARY_DIR}/apple-component-smoke"
    VERBATIM COMMENT "Building isolated AudioZ DSP device/simulator components")
endif()
add_dependencies(zcore_device_callback singz_check_zcore_realtime singz_check_zcore_boundaries)
add_dependencies(zcore_device singz_check_zcore_boundaries singz_check_ios_audio_host_realtime singz_check_android_audio_host_realtime)
add_dependencies(zdsp_runtime singz_check_zdsp_realtime singz_check_zcore_boundaries)
add_dependencies(zdsp_host_adapter singz_check_zdsp_realtime singz_check_zcore_boundaries)
# Every concrete package artifact carries the dependency-direction guard.
get_property(_audioz_targets DIRECTORY PROPERTY BUILDSYSTEM_TARGETS)
get_property(_audioz_subdirectories DIRECTORY PROPERTY SUBDIRECTORIES)
foreach(_directory IN LISTS _audioz_subdirectories)
  get_property(_nested_targets DIRECTORY "${_directory}" PROPERTY BUILDSYSTEM_TARGETS)
  list(APPEND _audioz_targets ${_nested_targets})
endforeach()
list(REMOVE_DUPLICATES _audioz_targets)
foreach(_target IN LISTS _audioz_targets)
  if(_target MATCHES "^singz_check_")
    continue()
  endif()
  get_target_property(_type "${_target}" TYPE)
  if(NOT _type STREQUAL "INTERFACE_LIBRARY")
    add_dependencies("${_target}" singz_check_zcore_boundaries)
  endif()
endforeach()

if(AUDIOZ_BUILD_TESTS AND CMAKE_SYSTEM_NAME STREQUAL "Linux" AND NOT ANDROID)
  add_executable(audio_host_linux_tests tests/native/audio_host_linux_tests.cpp)
  target_compile_features(audio_host_linux_tests PRIVATE cxx_std_20)
  target_compile_definitions(audio_host_linux_tests PRIVATE SINGZ_CORE_TESTS=1)
  target_include_directories(audio_host_linux_tests PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}")
  target_link_libraries(audio_host_linux_tests PRIVATE SingZ::zcore_device Threads::Threads)
  add_dependencies(audio_host_linux_tests singz_check_zcore_boundaries)
  add_test(NAME audio_host_linux_tests COMMAND audio_host_linux_tests)
  set_tests_properties(audio_host_linux_tests PROPERTIES TIMEOUT 30)
endif()

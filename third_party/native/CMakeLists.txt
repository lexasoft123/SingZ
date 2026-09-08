add_library(singz_native_flac STATIC
  flac/src/bitmath.c
  flac/src/bitreader.c
  flac/src/bitwriter.c
  flac/src/cpu.c
  flac/src/crc.c
  flac/src/fixed.c
  flac/src/float.c
  flac/src/format.c
  flac/src/lpc.c
  flac/src/md5.c
  flac/src/memory.c
  flac/src/metadata_iterators.c
  flac/src/metadata_object.c
  flac/src/stream_decoder.c
  flac/src/stream_encoder.c
  flac/src/stream_encoder_framing.c
  flac/src/window.c)
add_library(SingZ::native_flac ALIAS singz_native_flac)
set_target_properties(singz_native_flac PROPERTIES
  C_STANDARD 99
  C_STANDARD_REQUIRED YES
  POSITION_INDEPENDENT_CODE YES)
if(WIN32)
  target_sources(singz_native_flac PRIVATE
    flac/src/share/win_utf8_io/win_utf8_io.c)
endif()
target_compile_definitions(singz_native_flac
  PRIVATE HAVE_CONFIG_H
  PUBLIC FLAC__NO_DLL)
if(ANDROID)
  target_compile_definitions(singz_native_flac PRIVATE _FILE_OFFSET_BITS=64)
endif()
target_include_directories(singz_native_flac PUBLIC
  "${CMAKE_CURRENT_SOURCE_DIR}/flac"
  "${CMAKE_CURRENT_SOURCE_DIR}/flac/include"
  "${CMAKE_CURRENT_SOURCE_DIR}/flac/src/include"
  "${CMAKE_CURRENT_SOURCE_DIR}/flac/src")
if(UNIX)
  target_link_libraries(singz_native_flac PUBLIC m)
endif()
target_link_libraries(singz_native_flac PRIVATE SingZ::native_build_options)

# Pinned Signalsmith Stretch is isolated from zdsp_runtime's strict source
# policy: the upstream headers use std::vector/random internally, while our
# small wrapper prepares and warms every capacity off RT and is allocation-
# trapped at its process/reset boundary. zdsp_runtime never includes the
# third-party headers or weakens its own scanner.
add_library(singz_signalsmith_time_pitch STATIC
  "${SINGZ_REPO_ROOT}/native/playback/signalsmith_time_pitch.cpp"
  "${SINGZ_REPO_ROOT}/native/playback/signalsmith_time_pitch.h")
add_library(SingZ::signalsmith_time_pitch ALIAS singz_signalsmith_time_pitch)
target_compile_features(singz_signalsmith_time_pitch PUBLIC cxx_std_20)
# SYSTEM for the vendored tree: it is upstream's code, and the strict preset
# compiles with -Wall -Wextra -Wpedantic -Werror. gcc then fails the build on
# signalsmith's own style — stray semicolons in stft.h, a memcpy of
# std::complex in fft.h — which is neither ours to fix nor ours to carry as a
# patch. SYSTEM silences the vendored headers and NOT our wrapper, which keeps
# every strict warning it had.
target_include_directories(singz_signalsmith_time_pitch
  PUBLIC "${SINGZ_REPO_ROOT}/native/playback")
target_include_directories(singz_signalsmith_time_pitch SYSTEM
  PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/signalsmith")
target_link_libraries(singz_signalsmith_time_pitch
  PUBLIC SingZ::zdsp_runtime
  PRIVATE SingZ::native_build_options)
set_target_properties(singz_signalsmith_time_pitch PROPERTIES
  CXX_EXTENSIONS OFF
  POSITION_INDEPENDENT_CODE YES
  CXX_VISIBILITY_PRESET hidden
  VISIBILITY_INLINES_HIDDEN YES)

# Extended media codecs are an optional, dynamically linked control-domain
# dependency. Shipping builds must provide an exact pinned runtime; silently
# finding a developer machine's FFmpeg would make capability reporting lie and
# can accidentally introduce GPL-enabled binaries. Static archives are
# rejected because the product policy is LGPL replacement through shared libs.
if(SINGZ_ENABLE_FFMPEG_CODECS)
  if(NOT EXISTS "${SINGZ_FFMPEG_INCLUDE_DIR}/libavformat/avformat.h")
    message(FATAL_ERROR
      "SINGZ_ENABLE_FFMPEG_CODECS requires pinned FFmpeg headers")
  endif()
  add_library(singz_ffmpeg_dynamic INTERFACE)
  add_library(SingZ::ffmpeg_dynamic ALIAS singz_ffmpeg_dynamic)
  target_include_directories(singz_ffmpeg_dynamic INTERFACE
    "${SINGZ_FFMPEG_INCLUDE_DIR}")
  foreach(_component IN ITEMS avcodec avformat avutil swresample)
    string(TOUPPER "${_component}" _upper)
    set(_link "${SINGZ_FFMPEG_${_upper}_LIBRARY}")
    if(NOT EXISTS "${_link}" OR _link MATCHES "\\.a$")
      message(FATAL_ERROR
        "FFmpeg ${_component} must be a dynamic/import library, not '${_link}'")
    endif()
    add_library(singz_ffmpeg_${_component} SHARED IMPORTED GLOBAL)
    if(WIN32)
      set(_runtime "${SINGZ_FFMPEG_${_upper}_RUNTIME}")
      if(NOT EXISTS "${_runtime}" OR NOT _runtime MATCHES "\\.dll$")
        message(FATAL_ERROR
          "FFmpeg ${_component} requires a separately replaceable DLL")
      endif()
      set_target_properties(singz_ffmpeg_${_component} PROPERTIES
        IMPORTED_IMPLIB "${_link}" IMPORTED_LOCATION "${_runtime}")
    else()
      set_target_properties(singz_ffmpeg_${_component} PROPERTIES
        IMPORTED_LOCATION "${_link}")
    endif()
    target_link_libraries(singz_ffmpeg_dynamic INTERFACE
      singz_ffmpeg_${_component})
  endforeach()
endif()

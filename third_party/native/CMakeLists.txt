# Portable LAME encoder; called only by ordinary export workers.
add_library(singz_native_lame STATIC EXCLUDE_FROM_ALL
  lame/libmp3lame/VbrTag.c
  lame/libmp3lame/bitstream.c
  lame/libmp3lame/encoder.c
  lame/libmp3lame/fft.c
  lame/libmp3lame/gain_analysis.c
  lame/libmp3lame/id3tag.c
  lame/libmp3lame/lame.c
  lame/libmp3lame/newmdct.c
  lame/libmp3lame/presets.c
  lame/libmp3lame/psymodel.c
  lame/libmp3lame/quantize.c
  lame/libmp3lame/quantize_pvt.c
  lame/libmp3lame/reservoir.c
  lame/libmp3lame/set_get.c
  lame/libmp3lame/tables.c
  lame/libmp3lame/takehiro.c
  lame/libmp3lame/util.c
  lame/libmp3lame/vbrquantize.c
  lame/libmp3lame/version.c
  lame/libmp3lame/mpglib_interface.c)
add_library(SingZ::native_lame ALIAS singz_native_lame)
target_link_libraries(singz_native_lame PRIVATE SingZ::native_build_options)
target_compile_definitions(singz_native_lame PRIVATE HAVE_CONFIG_H=1)
set_target_properties(singz_native_lame PROPERTIES C_STANDARD 99 POSITION_INDEPENDENT_CODE YES)
target_include_directories(singz_native_lame SYSTEM PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/lame/include"
  PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/lame")
if(UNIX)
  target_link_libraries(singz_native_lame PUBLIC m)
endif()

# libFLAC is supplied by the pinned AudioZ source package.

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

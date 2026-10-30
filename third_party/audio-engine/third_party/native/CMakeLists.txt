add_library(singz_native_flac STATIC
  flac/src/bitmath.c flac/src/bitreader.c flac/src/bitwriter.c flac/src/cpu.c
  flac/src/crc.c flac/src/fixed.c flac/src/float.c flac/src/format.c flac/src/lpc.c
  flac/src/md5.c flac/src/memory.c flac/src/metadata_iterators.c
  flac/src/metadata_object.c flac/src/stream_decoder.c flac/src/stream_encoder.c
  flac/src/stream_encoder_framing.c flac/src/window.c)
add_library(SingZ::native_flac ALIAS singz_native_flac)
if(WIN32)
  target_sources(singz_native_flac PRIVATE flac/src/share/win_utf8_io/win_utf8_io.c)
endif()
if(ANDROID)
  target_compile_definitions(singz_native_flac PRIVATE _FILE_OFFSET_BITS=64)
endif()
target_compile_definitions(singz_native_flac PRIVATE HAVE_CONFIG_H PUBLIC FLAC__NO_DLL)
target_include_directories(singz_native_flac PUBLIC flac flac/include flac/src/include flac/src)
target_link_libraries(singz_native_flac PRIVATE SingZ::native_build_options)
set_target_properties(singz_native_flac PROPERTIES C_STANDARD 99 C_STANDARD_REQUIRED YES POSITION_INDEPENDENT_CODE YES)
if(UNIX)
  target_link_libraries(singz_native_flac PUBLIC m)
endif()

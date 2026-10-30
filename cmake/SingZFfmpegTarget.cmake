# Extended media codecs are an optional dynamically linked dependency. Define
# the consumer-owned target before zCore configures its media component.
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

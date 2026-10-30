if(NOT DEFINED SINGZ_SHARED_BINARY OR
   NOT EXISTS "${SINGZ_SHARED_BINARY}" OR
   NOT DEFINED SINGZ_READELF OR
   NOT EXISTS "${SINGZ_READELF}")
  message(FATAL_ERROR "FFmpeg dynamic scan requires a built binary and readelf")
endif()

execute_process(
  COMMAND "${SINGZ_READELF}" -d "${SINGZ_SHARED_BINARY}"
  RESULT_VARIABLE _status
  OUTPUT_VARIABLE _dynamic
  ERROR_VARIABLE _error)
if(NOT _status EQUAL 0)
  message(FATAL_ERROR "Could not inspect FFmpeg dependencies: ${_error}")
endif()
foreach(_library IN ITEMS avcodec avformat avutil swresample)
  if(NOT _dynamic MATCHES "Shared library: \\[lib${_library}\\.so\\]")
    message(FATAL_ERROR
      "${SINGZ_SHARED_BINARY} has no dynamic dependency on lib${_library}.so")
  endif()
endforeach()
if(_dynamic MATCHES "RNAudioAPI")
  message(FATAL_ERROR
    "zcore codec provisioning must link libav* directly, not RNAudioAPI decode")
endif()
message(STATUS "FFmpeg codec dependencies are dynamic libav* imports")

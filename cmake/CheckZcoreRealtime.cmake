if(NOT DEFINED SINGZ_ZCORE_RT_MANIFEST OR
   NOT EXISTS "${SINGZ_ZCORE_RT_MANIFEST}")
  message(FATAL_ERROR "SINGZ_ZCORE_RT_MANIFEST is required")
endif()

include("${SINGZ_ZCORE_RT_MANIFEST}")
set(_rt_sources ${SINGZ_ZCORE_RT_FILES})
set(_forbidden
  "mutex|recursive_mutex|timed_mutex|shared_mutex|condition_variable|lock_guard|unique_lock|scoped_lock|shared_ptr|weak_ptr|unique_ptr|make_unique|std::function|std::vector|std::string|std::map|std::unordered_map|std::set|std::unordered_set|std::deque|std::list|filesystem|fstream|iostream|printf|fprintf|puts|syslog|os_log|NSLog|__android_log|socket|send|recv|poll|select|sleep|usleep|nanosleep|throw|catch")
set(_forbidden_call
  "malloc|calloc|realloc|aligned_alloc|free|fopen|fread|fwrite")

foreach(_source IN LISTS _rt_sources)
  if(NOT EXISTS "${_source}")
    message(FATAL_ERROR "zcore RT manifest entry does not exist: ${_source}")
  endif()
  if(_source MATCHES "/platform/" OR
     _source MATCHES "/src/device/audio_input\\.cpp$" OR
     _source MATCHES "/src/audio/audio_input_transport\\.cpp$")
    message(FATAL_ERROR
      "zcore provider/control source leaked into callback target: ${_source}")
  endif()
  file(READ "${_source}" _contents)
  if(_contents MATCHES "(^|[^A-Za-z0-9_])(${_forbidden})([^A-Za-z0-9_]|$)")
    message(FATAL_ERROR
      "Forbidden zcore callback facility in ${_source}: ${CMAKE_MATCH_2}")
  endif()
  if(_contents MATCHES
     "(^|[^A-Za-z0-9_])(${_forbidden_call})[ \t\r\n]*\\(")
    message(FATAL_ERROR
      "Forbidden zcore callback call in ${_source}: ${CMAKE_MATCH_2}")
  endif()
  if(_contents MATCHES
     "#[ \t]*include[ \t]*[<\"](unistd|fcntl|sys/socket)\\.h[>\"]")
    message(FATAL_ERROR
      "Forbidden zcore callback system-I/O header in ${_source}")
  endif()
  if(_contents MATCHES
     "#[ \t]*include[ \t]*[<\"]zcore/audio/audio_input_transport\\.h[>\"]")
    message(FATAL_ERROR
      "Owner-only audio_input_transport.h included by callback target: ${_source}")
  endif()
  if(_contents MATCHES "(^|[^A-Za-z0-9_])(new|delete)[ \t\r\n(]" OR
     _contents MATCHES "(^|[^A-Za-z0-9_])(new|delete)\\[")
    message(FATAL_ERROR "Dynamic allocation token in zcore callback source: ${_source}")
  endif()
endforeach()

set(_required
  "/src/audio/audio_input_convert.cpp"
  "/src/audio/audio_input_timestamp.cpp"
  "/src/audio/audio_input_transport_callback.cpp"
  "/src/audio/audio_input_transport_internal.h"
  "/src/device/audio_input_callback.cpp"
  "/src/device/audio_input_callback_gate.cpp"
  "/src/device/audio_input_callback.h"
  "/src/device/audio_host_fifo_hot.cpp"
  "/include/zcore/audio/audio_input_convert.h"
  "/include/zcore/audio/audio_input_producer.h"
  "/include/zcore/audio/audio_input_timestamp.h"
  "/include/zcore/device/audio_input_callback_gate.h")
foreach(_suffix IN LISTS _required)
  set(_found FALSE)
  foreach(_source IN LISTS _rt_sources)
    if(_source MATCHES "${_suffix}$")
      set(_found TRUE)
      break()
    endif()
  endforeach()
  if(NOT _found)
    message(FATAL_ERROR
      "zcore callback target is missing required source membership: ${_suffix}")
  endif()
endforeach()

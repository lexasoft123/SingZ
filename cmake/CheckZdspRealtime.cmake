if(NOT DEFINED SINGZ_ZDSP_RT_MANIFEST OR
   NOT EXISTS "${SINGZ_ZDSP_RT_MANIFEST}")
  message(FATAL_ERROR "SINGZ_ZDSP_RT_MANIFEST is required")
endif()

include("${SINGZ_ZDSP_RT_MANIFEST}")
set(_rt_sources ${SINGZ_ZDSP_RT_FILES})
set(_forbidden
  "mutex|recursive_mutex|timed_mutex|shared_mutex|condition_variable|lock_guard|unique_lock|scoped_lock|shared_ptr|weak_ptr|unique_ptr|make_unique|std::function|std::vector|std::string|std::map|std::unordered_map|std::set|std::unordered_set|std::deque|std::list|filesystem|fstream|iostream|printf|fprintf|puts|syslog|os_log|NSLog|__android_log|malloc|calloc|realloc|aligned_alloc|free|fopen|fread|fwrite|open|read|write|socket|send|recv|poll|select|sleep|usleep|nanosleep|throw|catch")
foreach(_source IN LISTS _rt_sources)
  if(NOT EXISTS "${_source}")
    message(FATAL_ERROR "RT manifest entry does not exist: ${_source}")
  endif()
  file(READ "${_source}" _contents)
  if(_contents MATCHES "(^|[^A-Za-z0-9_])(${_forbidden})([^A-Za-z0-9_]|$)")
    message(FATAL_ERROR "Forbidden RT facility in ${_source}: ${CMAKE_MATCH_2}")
  endif()
  if(_contents MATCHES "(^|[^A-Za-z0-9_])(new|delete)[ \t\r\n(]" OR
     _contents MATCHES "(^|[^A-Za-z0-9_])(new|delete)\\[")
    message(FATAL_ERROR "Dynamic allocation token in ${_source}")
  endif()
endforeach()

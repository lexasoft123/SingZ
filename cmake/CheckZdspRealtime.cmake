if(NOT DEFINED SINGZ_ZDSP_RT_MANIFEST OR
   NOT EXISTS "${SINGZ_ZDSP_RT_MANIFEST}")
  message(FATAL_ERROR "SINGZ_ZDSP_RT_MANIFEST is required")
endif()

include("${SINGZ_ZDSP_RT_MANIFEST}")
set(_rt_sources ${SINGZ_ZDSP_RT_FILES})
set(_forbidden
  "mutex|recursive_mutex|timed_mutex|shared_mutex|condition_variable|lock_guard|unique_lock|scoped_lock|shared_ptr|weak_ptr|unique_ptr|make_unique|std::function|std::vector|std::string|std::map|std::unordered_map|std::set|std::unordered_set|std::deque|std::list|filesystem|fstream|iostream|printf|fprintf|puts|syslog|os_log|NSLog|__android_log|malloc|calloc|realloc|aligned_alloc|fopen|fread|fwrite|open|read|write|socket|send|recv|poll|select|sleep|usleep|nanosleep|throw|catch")
foreach(_source IN LISTS _rt_sources)
  if(NOT EXISTS "${_source}")
    message(FATAL_ERROR "RT manifest entry does not exist: ${_source}")
  endif()
  file(READ "${_source}" _contents)
  if(_contents MATCHES "(^|[^A-Za-z0-9_])(${_forbidden})([^A-Za-z0-9_]|$)")
    message(FATAL_ERROR "Forbidden RT facility in ${_source}: ${CMAKE_MATCH_2}")
  endif()
  # `is_always_lock_free` is a required atomic property, not a call to the C
  # allocator. Match the allocator spelling only when it is invoked.
  if(_contents MATCHES "(^|[^A-Za-z0-9_])free[ \t\r\n]*\\(")
    message(FATAL_ERROR "Forbidden RT facility in ${_source}: free")
  endif()
  if(_contents MATCHES "(^|[^A-Za-z0-9_])(new|delete)[ \t\r\n(]" OR
     _contents MATCHES "(^|[^A-Za-z0-9_])(new|delete)\\[")
    message(FATAL_ERROR "Dynamic allocation token in ${_source}")
  endif()
  if(_source MATCHES "/src/runtime/audio_host_graph_adapter\\.cpp$" AND
     _contents MATCHES
     "for[ \t\r\n]*\\([ \t\r\n]*;[ \t\r\n]*;[ \t\r\n]*\\)")
    message(FATAL_ERROR "Unbounded loop in ${_source}")
  endif()
  if(DEFINED SINGZ_ZDSP_RT_PROFILE AND
     SINGZ_ZDSP_RT_PROFILE STREQUAL "playback" AND
     (_source MATCHES "/native/playback/native_playback_callback\\.(cpp|h)$" OR
      _source MATCHES "/audio_host_render\\.h$") AND
     (_contents MATCHES
        "while[ \t\r\n]*\\(" OR
      _contents MATCHES
        "for[ \t\r\n]*\\([ \t\r\n]*;[ \t\r\n]*;[ \t\r\n]*\\)"))
    message(FATAL_ERROR
      "Unbounded loop in playback callback source: ${_source}")
  endif()
endforeach()

if(NOT DEFINED SINGZ_ZDSP_RT_PROFILE OR
   SINGZ_ZDSP_RT_PROFILE STREQUAL "full")
  foreach(_suffix IN ITEMS
      "/src/runtime/audio_host_graph_adapter.cpp"
      "/include/zdsp/audio_host_graph_adapter.h")
    set(_found FALSE)
    foreach(_source IN LISTS _rt_sources)
      if(_source MATCHES "${_suffix}$")
        set(_found TRUE)
        break()
      endif()
    endforeach()
    if(NOT _found)
      message(FATAL_ERROR
        "zdsp RT target is missing required source membership: ${_suffix}")
    endif()
  endforeach()
elseif(SINGZ_ZDSP_RT_PROFILE STREQUAL "playback")
  foreach(_suffix IN ITEMS
      "/native/playback/native_playback_callback.cpp"
      "/native/playback/native_playback_callback.h"
      "/src/runtime/audio_host_graph_adapter.cpp"
      "/src/runtime/graph_runner.cpp"
      "/include/zcore/device/audio_host_render.h")
    set(_found FALSE)
    foreach(_source IN LISTS _rt_sources)
      if(_source MATCHES "${_suffix}$")
        set(_found TRUE)
        break()
      endif()
    endforeach()
    if(NOT _found)
      message(FATAL_ERROR
        "playback RT target is missing required source membership: ${_suffix}")
    endif()
  endforeach()
elseif(NOT SINGZ_ZDSP_RT_PROFILE STREQUAL "monitor")
  message(FATAL_ERROR "Unknown zdsp RT profile: ${SINGZ_ZDSP_RT_PROFILE}")
endif()

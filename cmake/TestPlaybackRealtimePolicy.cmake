if(NOT DEFINED SINGZ_PLAYBACK_RT_MANIFEST OR
   NOT EXISTS "${SINGZ_PLAYBACK_RT_MANIFEST}" OR
   NOT DEFINED SINGZ_PLAYBACK_RT_CHECKER OR
   NOT EXISTS "${SINGZ_PLAYBACK_RT_CHECKER}" OR
   NOT DEFINED SINGZ_PLAYBACK_RT_TEST_DIR)
  message(FATAL_ERROR "playback RT negative-policy inputs are required")
endif()

file(MAKE_DIRECTORY "${SINGZ_PLAYBACK_RT_TEST_DIR}")
include("${SINGZ_PLAYBACK_RT_MANIFEST}")
set(_valid_files ${SINGZ_ZDSP_RT_FILES})

function(_write_manifest path)
  file(WRITE "${path}" "set(SINGZ_ZDSP_RT_FILES\n")
  foreach(_source IN LISTS ARGN)
    file(APPEND "${path}" "  [==[${_source}]==]\n")
  endforeach()
  file(APPEND "${path}" ")\n")
endfunction()

# The policy input is generated from target SOURCES; prove the checker also
# refuses an incomplete generated manifest rather than accepting source drift.
set(_omitted_files)
foreach(_source IN LISTS _valid_files)
  if(NOT _source MATCHES "/native_playback_callback\.h$")
    list(APPEND _omitted_files "${_source}")
  endif()
endforeach()
set(_omitted_manifest
  "${SINGZ_PLAYBACK_RT_TEST_DIR}/omitted-callback-header.cmake")
_write_manifest("${_omitted_manifest}" ${_omitted_files})
execute_process(COMMAND "${CMAKE_COMMAND}"
  "-DSINGZ_ZDSP_RT_MANIFEST=${_omitted_manifest}"
  "-DSINGZ_ZDSP_RT_PROFILE=playback"
  -P "${SINGZ_PLAYBACK_RT_CHECKER}"
  RESULT_VARIABLE _omitted_result OUTPUT_VARIABLE _omitted_out
  ERROR_VARIABLE _omitted_err)
if(_omitted_result EQUAL 0 OR
   NOT "${_omitted_out}${_omitted_err}" MATCHES
       "missing required source membership.*native_playback_callback\.h")
  message(FATAL_ERROR
    "playback RT checker accepted omitted target membership:\n"
    "${_omitted_out}${_omitted_err}")
endif()

# Callback compare/exchange retries and the transitive AudioHost contract must
# remain statically bounded. Prove a loop hidden in the callback header is
# rejected, not merely a bad translation unit beside the authoritative set.
set(_unbounded_source
  "${SINGZ_PLAYBACK_RT_TEST_DIR}/audio_host_render.h")
file(WRITE "${_unbounded_source}"
  "inline void unbounded_terminal_latch() { while (true) {} }\n")
set(_unbounded_manifest
  "${SINGZ_PLAYBACK_RT_TEST_DIR}/unbounded-loop.cmake")
_write_manifest("${_unbounded_manifest}" ${_valid_files} "${_unbounded_source}")
execute_process(COMMAND "${CMAKE_COMMAND}"
  "-DSINGZ_ZDSP_RT_MANIFEST=${_unbounded_manifest}"
  "-DSINGZ_ZDSP_RT_PROFILE=playback"
  -P "${SINGZ_PLAYBACK_RT_CHECKER}"
  RESULT_VARIABLE _unbounded_result OUTPUT_VARIABLE _unbounded_out
  ERROR_VARIABLE _unbounded_err)
if(_unbounded_result EQUAL 0 OR
   NOT "${_unbounded_out}${_unbounded_err}" MATCHES
       "Unbounded loop in playback callback source")
  message(FATAL_ERROR
    "playback RT checker accepted an unbounded callback loop:\n"
    "${_unbounded_out}${_unbounded_err}")
endif()

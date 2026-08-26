if(NOT DEFINED SINGZ_ZCORE_RT_MANIFEST OR
   NOT EXISTS "${SINGZ_ZCORE_RT_MANIFEST}" OR
   NOT DEFINED SINGZ_ZCORE_RT_CHECKER OR
   NOT EXISTS "${SINGZ_ZCORE_RT_CHECKER}" OR
   NOT DEFINED SINGZ_ZCORE_RT_TEST_DIR)
  message(FATAL_ERROR "zcore RT negative-policy test inputs are required")
endif()

file(MAKE_DIRECTORY "${SINGZ_ZCORE_RT_TEST_DIR}")
include("${SINGZ_ZCORE_RT_MANIFEST}")
set(_valid_files ${SINGZ_ZCORE_RT_FILES})

function(_write_manifest path)
  file(WRITE "${path}" "set(SINGZ_ZCORE_RT_FILES\n")
  foreach(_source IN LISTS ARGN)
    file(APPEND "${path}" "  [==[${_source}]==]\n")
  endforeach()
  file(APPEND "${path}" ")\n")
endfunction()

# A required callback header disappearing from target_sources must fail even
# when every remaining source is clean.
set(_omitted_files)
foreach(_source IN LISTS _valid_files)
  if(NOT _source MATCHES "/audio_input_producer\\.h$")
    list(APPEND _omitted_files "${_source}")
  endif()
endforeach()
set(_omitted_path "${SINGZ_ZCORE_RT_TEST_DIR}/omitted-required.cmake")
_write_manifest("${_omitted_path}" ${_omitted_files})
execute_process(
  COMMAND "${CMAKE_COMMAND}"
    "-DSINGZ_ZCORE_RT_MANIFEST=${_omitted_path}"
    -P "${SINGZ_ZCORE_RT_CHECKER}"
  RESULT_VARIABLE _omitted_result
  OUTPUT_VARIABLE _omitted_out
  ERROR_VARIABLE _omitted_err)
if(_omitted_result EQUAL 0 OR
   NOT "${_omitted_out}${_omitted_err}" MATCHES
       "missing required source membership.*audio_input_producer\\.h")
  message(FATAL_ERROR
    "zcore RT scanner did not reject an omitted required header:\n"
    "${_omitted_out}${_omitted_err}")
endif()

# A forbidden facility added to otherwise-valid target membership must fail.
set(_forbidden_header "${SINGZ_ZCORE_RT_TEST_DIR}/forbidden_callback.h")
file(WRITE "${_forbidden_header}" "#include <mutex>\nstd::mutex forbidden_mutex;\n")
set(_forbidden_files ${_valid_files} "${_forbidden_header}")
set(_forbidden_path "${SINGZ_ZCORE_RT_TEST_DIR}/forbidden-facility.cmake")
_write_manifest("${_forbidden_path}" ${_forbidden_files})
execute_process(
  COMMAND "${CMAKE_COMMAND}"
    "-DSINGZ_ZCORE_RT_MANIFEST=${_forbidden_path}"
    -P "${SINGZ_ZCORE_RT_CHECKER}"
  RESULT_VARIABLE _forbidden_result
  OUTPUT_VARIABLE _forbidden_out
  ERROR_VARIABLE _forbidden_err)
if(_forbidden_result EQUAL 0 OR
   NOT "${_forbidden_out}${_forbidden_err}" MATCHES
       "Forbidden zcore callback facility.*mutex")
  message(FATAL_ERROR
    "zcore RT scanner did not reject a forbidden facility:\n"
    "${_forbidden_out}${_forbidden_err}")
endif()

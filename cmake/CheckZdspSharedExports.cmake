if(NOT DEFINED SINGZ_SHARED_BINARY OR
   NOT EXISTS "${SINGZ_SHARED_BINARY}" OR
   NOT DEFINED SINGZ_NM OR
   NOT EXISTS "${SINGZ_NM}")
  message(FATAL_ERROR "SINGZ_SHARED_BINARY and SINGZ_NM are required")
endif()

execute_process(
  COMMAND "${SINGZ_NM}" -D -C "${SINGZ_SHARED_BINARY}"
  RESULT_VARIABLE _nm_result
  OUTPUT_VARIABLE _dynamic_symbols
  ERROR_VARIABLE _nm_error)
if(NOT _nm_result EQUAL 0)
  message(FATAL_ERROR "dynamic export scan failed: ${_nm_error}")
endif()

if(_dynamic_symbols MATCHES "zdsp::|singz_zdsp_contract_link_smoke")
  message(FATAL_ERROR
    "libsingzcore exports an internal zdsp C++/compile-smoke symbol")
endif()
if(NOT _dynamic_symbols MATCHES
   "Java_com_singzplayer_split_SingzCore_")
  message(FATAL_ERROR
    "libsingzcore export scan found no explicit JNI product entry point")
endif()

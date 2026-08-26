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

# Callback internals are same-toolchain implementation details, never part of
# the Android product ABI. Keep this gate next to the zdsp export check so the
# final shared object (not merely its component targets) is authoritative.
if(_dynamic_symbols MATCHES
   "singz::(AudioInputCallbackEndpoint|AudioInputCallbackGate|AudioInputCallbackScope|AudioInputRingProducer|AudioInputRing::push|AudioInputTimestamp|convertAudioInputChannel|resolveAudioInputTimestamp|audioInputCallbackEntryFallback)")
  message(FATAL_ERROR
    "libsingzcore exports an internal zcore callback symbol")
endif()

string(REGEX MATCHALL
  "Java_com_singzplayer_split_SingzCore_[A-Za-z0-9_]+"
  _jni_exports "${_dynamic_symbols}")
list(LENGTH _jni_exports _jni_export_count)
if(NOT _jni_export_count EQUAL 16)
  message(FATAL_ERROR
    "libsingzcore must preserve exactly 16 JNI product exports; found "
    "${_jni_export_count}")
endif()

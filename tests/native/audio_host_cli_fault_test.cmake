execute_process(
  COMMAND "${AUDIO_HOST_CLI}" --fake --fake-faults --blocks 6
          --maximum-frames 1024 --cycles 2
  RESULT_VARIABLE result
  OUTPUT_VARIABLE output
  ERROR_VARIABLE error)

if(NOT result EQUAL 4)
  message(FATAL_ERROR
          "strict fake-fault run returned ${result}, expected 4\n${output}${error}")
endif()

if(NOT output MATCHES
   "\"callbacks\":6.*\"xruns\":1.*\"deadlineMisses\":1.*\"cyclesCompleted\":1")
  message(FATAL_ERROR "strict cycles did not stop at the first failed cycle\n${output}${error}")
endif()

function(assert_channel_list_rejected label)
  execute_process(
    COMMAND "${AUDIO_HOST_CLI}" --fake ${ARGN}
    RESULT_VARIABLE invalid_result
    OUTPUT_VARIABLE invalid_output
    ERROR_VARIABLE invalid_error)
  if(NOT invalid_result EQUAL 1)
    message(FATAL_ERROR
      "${label}: channel list returned ${invalid_result}, expected 1\n"
      "${invalid_output}${invalid_error}")
  endif()
endfunction()

assert_channel_list_rejected(missing-value --input-channels)
assert_channel_list_rejected(duplicate
  --input-channels 0 --input-channels 1)
assert_channel_list_rejected(leading-space --input-channels " 0")
assert_channel_list_rejected(negative --input-channels -1)
assert_channel_list_rejected(overflow --input-channels 4294967296)
assert_channel_list_rejected(trailing-comma --input-channels "0,")

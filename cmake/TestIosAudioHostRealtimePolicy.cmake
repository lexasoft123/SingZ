if(NOT DEFINED SINGZ_IOS_AUDIO_HOST_RT_MANIFEST OR
   NOT EXISTS "${SINGZ_IOS_AUDIO_HOST_RT_MANIFEST}" OR
   NOT DEFINED SINGZ_IOS_AUDIO_HOST_RT_CHECKER OR
   NOT EXISTS "${SINGZ_IOS_AUDIO_HOST_RT_CHECKER}" OR
   NOT DEFINED SINGZ_IOS_AUDIO_HOST_RT_TEST_DIR)
  message(FATAL_ERROR "iOS AudioHost RT negative-policy inputs are required")
endif()

file(MAKE_DIRECTORY "${SINGZ_IOS_AUDIO_HOST_RT_TEST_DIR}")
include("${SINGZ_IOS_AUDIO_HOST_RT_MANIFEST}")
set(_valid_files ${SINGZ_IOS_AUDIO_HOST_RT_FILES})
set(_valid_include_roots ${SINGZ_IOS_AUDIO_HOST_RT_PROJECT_INCLUDE_ROOTS})

function(_write_manifest path)
  file(WRITE "${path}" "set(SINGZ_IOS_AUDIO_HOST_RT_FILES\n")
  foreach(_source IN LISTS ARGN)
    file(APPEND "${path}" "  [==[${_source}]==]\n")
  endforeach()
  file(APPEND "${path}" ")\n")
  file(APPEND "${path}"
    "set(SINGZ_IOS_AUDIO_HOST_RT_PROJECT_INCLUDE_ROOTS\n")
  foreach(_root IN LISTS _valid_include_roots)
    file(APPEND "${path}" "  [==[${_root}]==]\n")
  endforeach()
  file(APPEND "${path}" ")\n")
endfunction()

set(_omitted_files)
foreach(_source IN LISTS _valid_files)
  if(NOT _source MATCHES "/audio_host_ios_callback\\.h$")
    list(APPEND _omitted_files "${_source}")
  endif()
endforeach()
set(_omitted_manifest "${SINGZ_IOS_AUDIO_HOST_RT_TEST_DIR}/omitted.cmake")
_write_manifest("${_omitted_manifest}" ${_omitted_files})
execute_process(COMMAND "${CMAKE_COMMAND}"
  "-DSINGZ_IOS_AUDIO_HOST_RT_MANIFEST=${_omitted_manifest}"
  -P "${SINGZ_IOS_AUDIO_HOST_RT_CHECKER}"
  RESULT_VARIABLE _omitted_result OUTPUT_VARIABLE _omitted_out
  ERROR_VARIABLE _omitted_err)
if(_omitted_result EQUAL 0 OR
   NOT "${_omitted_out}${_omitted_err}" MATCHES
       "missing required source membership.*audio_host_ios_callback\\.h")
  message(FATAL_ERROR
    "iOS RT checker accepted omitted leaf membership:\n${_omitted_out}${_omitted_err}")
endif()

set(_forbidden_helper
  "${SINGZ_IOS_AUDIO_HOST_RT_TEST_DIR}/forbidden_callback_helper.cpp")
file(WRITE "${_forbidden_helper}"
  "#include <mutex>\nstd::mutex callback_mutex;\n")
set(_helper_manifest "${SINGZ_IOS_AUDIO_HOST_RT_TEST_DIR}/helper.cmake")
_write_manifest("${_helper_manifest}" ${_valid_files} "${_forbidden_helper}")
execute_process(COMMAND "${CMAKE_COMMAND}"
  "-DSINGZ_IOS_AUDIO_HOST_RT_MANIFEST=${_helper_manifest}"
  -P "${SINGZ_IOS_AUDIO_HOST_RT_CHECKER}"
  RESULT_VARIABLE _helper_result OUTPUT_VARIABLE _helper_out
  ERROR_VARIABLE _helper_err)
if(_helper_result EQUAL 0 OR
   NOT "${_helper_out}${_helper_err}" MATCHES
       "Forbidden iOS AudioHost callback facility.*mutex")
  message(FATAL_ERROR
    "iOS RT checker accepted a forbidden helper:\n${_helper_out}${_helper_err}")
endif()

set(_include_dir
  "${SINGZ_IOS_AUDIO_HOST_RT_TEST_DIR}/include-closure/platform/ios")
file(MAKE_DIRECTORY "${_include_dir}")
set(_include_cpp "${_include_dir}/audio_host_ios_callback.cpp")
set(_include_h "${_include_dir}/audio_host_ios_callback.h")
set(_hidden_h "${_include_dir}/hidden_malloc.h")
file(WRITE "${_include_cpp}"
  "#include \"audio_host_ios_callback.h\"\n#include \"hidden_malloc.h\"\nvoid callback() { mach_absolute_time(); AudioUnitRender(); invokeAudioHostCallback(); AudioInputCallbackScope scope(gate); hiddenMalloc(); }\n")
file(WRITE "${_include_h}" "#pragma once\n")
file(WRITE "${_hidden_h}"
  "inline void hiddenMalloc() { (void)malloc(1); }\n")
set(_include_manifest "${SINGZ_IOS_AUDIO_HOST_RT_TEST_DIR}/include.cmake")
_write_manifest("${_include_manifest}" "${_include_cpp}" "${_include_h}")
execute_process(COMMAND "${CMAKE_COMMAND}"
  "-DSINGZ_IOS_AUDIO_HOST_RT_MANIFEST=${_include_manifest}"
  -P "${SINGZ_IOS_AUDIO_HOST_RT_CHECKER}"
  RESULT_VARIABLE _include_result OUTPUT_VARIABLE _include_out
  ERROR_VARIABLE _include_err)
if(_include_result EQUAL 0 OR
   NOT "${_include_out}${_include_err}" MATCHES
       "Forbidden iOS AudioHost callback call.*hidden_malloc.h.*malloc")
  message(FATAL_ERROR
    "iOS RT checker accepted an unlisted included malloc helper:\n${_include_out}${_include_err}")
endif()

set(_angle_dir
  "${SINGZ_IOS_AUDIO_HOST_RT_TEST_DIR}/angle-closure/platform/ios")
set(_angle_root
  "${SINGZ_IOS_AUDIO_HOST_RT_TEST_DIR}/angle-closure/include")
file(MAKE_DIRECTORY "${_angle_dir}" "${_angle_root}")
set(_angle_cpp "${_angle_dir}/audio_host_ios_callback.cpp")
set(_angle_h "${_angle_dir}/audio_host_ios_callback.h")
set(_angle_hidden "${_angle_root}/hidden_helper.h")
file(WRITE "${_angle_cpp}"
  "#include \"audio_host_ios_callback.h\"\n#include <hidden_helper.h>\nvoid callback() { mach_absolute_time(); AudioUnitRender(); invokeAudioHostCallback(); AudioInputCallbackScope scope(gate); hiddenMalloc(); }\n")
file(WRITE "${_angle_h}" "#pragma once\n")
file(WRITE "${_angle_hidden}"
  "inline void hiddenMalloc() { (void)std::malloc(1); }\n")
set(_saved_include_roots ${_valid_include_roots})
set(_valid_include_roots "${_angle_root}")
set(_angle_manifest "${SINGZ_IOS_AUDIO_HOST_RT_TEST_DIR}/angle.cmake")
_write_manifest("${_angle_manifest}" "${_angle_cpp}" "${_angle_h}")
set(_valid_include_roots ${_saved_include_roots})
execute_process(COMMAND "${CMAKE_COMMAND}"
  "-DSINGZ_IOS_AUDIO_HOST_RT_MANIFEST=${_angle_manifest}"
  -P "${SINGZ_IOS_AUDIO_HOST_RT_CHECKER}"
  RESULT_VARIABLE _angle_result OUTPUT_VARIABLE _angle_out
  ERROR_VARIABLE _angle_err)
if(_angle_result EQUAL 0 OR
   NOT "${_angle_out}${_angle_err}" MATCHES
       "Forbidden iOS AudioHost callback call.*hidden_helper.h.*malloc")
  message(FATAL_ERROR
    "iOS RT checker accepted an angle-included malloc helper:\n${_angle_out}${_angle_err}")
endif()

set(_macro_dir
  "${SINGZ_IOS_AUDIO_HOST_RT_TEST_DIR}/macro-include/platform/ios")
set(_macro_root
  "${SINGZ_IOS_AUDIO_HOST_RT_TEST_DIR}/macro-include/include")
file(MAKE_DIRECTORY "${_macro_dir}" "${_macro_root}")
set(_macro_cpp "${_macro_dir}/audio_host_ios_callback.cpp")
set(_macro_h "${_macro_dir}/audio_host_ios_callback.h")
set(_macro_hidden "${_macro_root}/hidden_helper.h")
file(WRITE "${_macro_cpp}"
  "#include \"audio_host_ios_callback.h\"\n#define HIDDEN_HEADER <hidden_helper.h>\n#include HIDDEN_HEADER\nvoid callback() { mach_absolute_time(); AudioUnitRender(); invokeAudioHostCallback(); AudioInputCallbackScope scope(gate); hiddenMalloc(); }\n")
file(WRITE "${_macro_h}" "#pragma once\n")
file(WRITE "${_macro_hidden}"
  "inline void hiddenMalloc() { (void)std::malloc(1); }\n")
set(_saved_include_roots ${_valid_include_roots})
set(_valid_include_roots "${_macro_root}")
set(_macro_manifest "${SINGZ_IOS_AUDIO_HOST_RT_TEST_DIR}/macro.cmake")
_write_manifest("${_macro_manifest}" "${_macro_cpp}" "${_macro_h}")
set(_valid_include_roots ${_saved_include_roots})
execute_process(COMMAND "${CMAKE_COMMAND}"
  "-DSINGZ_IOS_AUDIO_HOST_RT_MANIFEST=${_macro_manifest}"
  -P "${SINGZ_IOS_AUDIO_HOST_RT_CHECKER}"
  RESULT_VARIABLE _macro_result OUTPUT_VARIABLE _macro_out
  ERROR_VARIABLE _macro_err)
if(_macro_result EQUAL 0 OR
   NOT "${_macro_out}${_macro_err}" MATCHES
       "include directive is not an approved literal.*HIDDEN_HEADER")
  message(FATAL_ERROR
    "iOS RT checker accepted a macro-expanded include:\n${_macro_out}${_macro_err}")
endif()

set(_continued_dir
  "${SINGZ_IOS_AUDIO_HOST_RT_TEST_DIR}/continued-include/platform/ios")
set(_continued_root
  "${SINGZ_IOS_AUDIO_HOST_RT_TEST_DIR}/continued-include/include")
file(MAKE_DIRECTORY "${_continued_dir}" "${_continued_root}")
set(_continued_cpp "${_continued_dir}/audio_host_ios_callback.cpp")
set(_continued_h "${_continued_dir}/audio_host_ios_callback.h")
file(WRITE "${_continued_cpp}"
  "#include \"audio_host_ios_callback.h\"\n#include \\\n<hidden_helper.h>\nvoid callback() { mach_absolute_time(); AudioUnitRender(); invokeAudioHostCallback(); AudioInputCallbackScope scope(gate); }\n")
file(WRITE "${_continued_h}" "#pragma once\n")
set(_saved_include_roots ${_valid_include_roots})
set(_valid_include_roots "${_continued_root}")
set(_continued_manifest
  "${SINGZ_IOS_AUDIO_HOST_RT_TEST_DIR}/continued.cmake")
_write_manifest("${_continued_manifest}" "${_continued_cpp}" "${_continued_h}")
set(_valid_include_roots ${_saved_include_roots})
execute_process(COMMAND "${CMAKE_COMMAND}"
  "-DSINGZ_IOS_AUDIO_HOST_RT_MANIFEST=${_continued_manifest}"
  -P "${SINGZ_IOS_AUDIO_HOST_RT_CHECKER}"
  RESULT_VARIABLE _continued_result OUTPUT_VARIABLE _continued_out
  ERROR_VARIABLE _continued_err)
if(_continued_result EQUAL 0 OR
   NOT "${_continued_out}${_continued_err}" MATCHES
       "Continued source lines are forbidden")
  message(FATAL_ERROR
    "iOS RT checker accepted a continued include directive:\n${_continued_out}${_continued_err}")
endif()

set(_digraph_dir
  "${SINGZ_IOS_AUDIO_HOST_RT_TEST_DIR}/digraph-include/platform/ios")
set(_digraph_root
  "${SINGZ_IOS_AUDIO_HOST_RT_TEST_DIR}/digraph-include/include")
file(MAKE_DIRECTORY "${_digraph_dir}" "${_digraph_root}")
set(_digraph_cpp "${_digraph_dir}/audio_host_ios_callback.cpp")
set(_digraph_h "${_digraph_dir}/audio_host_ios_callback.h")
set(_digraph_hidden "${_digraph_root}/hidden_helper.h")
file(WRITE "${_digraph_cpp}"
  "#include \"audio_host_ios_callback.h\"\n%:include <hidden_helper.h>\nvoid callback() { mach_absolute_time(); AudioUnitRender(); invokeAudioHostCallback(); AudioInputCallbackScope scope(gate); hiddenMalloc(); }\n")
file(WRITE "${_digraph_h}"
  "inline void mach_absolute_time() {}\ninline void AudioUnitRender() {}\ninline void invokeAudioHostCallback() {}\nstruct Gate {};\ninline Gate gate;\nstruct AudioInputCallbackScope { explicit AudioInputCallbackScope(Gate&) {} };\n")
file(WRITE "${_digraph_hidden}"
  "#include <cstdlib>\ninline void hiddenMalloc() { (void)std::malloc(1); }\n")
if(SINGZ_IOS_AUDIO_HOST_RT_CXX_COMPILER_ID STREQUAL "AppleClang")
  execute_process(COMMAND "${SINGZ_IOS_AUDIO_HOST_RT_CXX_COMPILER}"
    -std=c++20 -fsyntax-only "-I${_digraph_root}" "${_digraph_cpp}"
    RESULT_VARIABLE _digraph_compile_result
    OUTPUT_VARIABLE _digraph_compile_out ERROR_VARIABLE _digraph_compile_err)
  if(NOT _digraph_compile_result EQUAL 0)
    message(FATAL_ERROR
      "Apple Clang did not accept the %: include fixture:\n${_digraph_compile_out}${_digraph_compile_err}")
  endif()
endif()
set(_saved_include_roots ${_valid_include_roots})
set(_valid_include_roots "${_digraph_root}")
set(_digraph_manifest
  "${SINGZ_IOS_AUDIO_HOST_RT_TEST_DIR}/digraph.cmake")
_write_manifest("${_digraph_manifest}" "${_digraph_cpp}" "${_digraph_h}")
set(_valid_include_roots ${_saved_include_roots})
execute_process(COMMAND "${CMAKE_COMMAND}"
  "-DSINGZ_IOS_AUDIO_HOST_RT_MANIFEST=${_digraph_manifest}"
  -P "${SINGZ_IOS_AUDIO_HOST_RT_CHECKER}"
  RESULT_VARIABLE _digraph_result OUTPUT_VARIABLE _digraph_out
  ERROR_VARIABLE _digraph_err)
if(_digraph_result EQUAL 0 OR
   NOT "${_digraph_out}${_digraph_err}" MATCHES
       "alternative preprocessing token %:")
  message(FATAL_ERROR
    "iOS RT checker accepted a %: include directive:\n${_digraph_out}${_digraph_err}")
endif()

set(_cr_dir
  "${SINGZ_IOS_AUDIO_HOST_RT_TEST_DIR}/cr-continued-include/platform/ios")
set(_cr_root
  "${SINGZ_IOS_AUDIO_HOST_RT_TEST_DIR}/cr-continued-include/include")
file(MAKE_DIRECTORY "${_cr_dir}" "${_cr_root}")
set(_cr_cpp "${_cr_dir}/audio_host_ios_callback.cpp")
set(_cr_h "${_cr_dir}/audio_host_ios_callback.h")
set(_cr_hidden "${_cr_root}/hidden_helper.h")
string(ASCII 92 _fixture_backslash)
string(ASCII 13 _fixture_carriage_return)
file(WRITE "${_cr_cpp}"
  "#include \"audio_host_ios_callback.h\"\n#inc${_fixture_backslash}${_fixture_carriage_return}lude <hidden_helper.h>\nvoid callback() { mach_absolute_time(); AudioUnitRender(); invokeAudioHostCallback(); AudioInputCallbackScope scope(gate); hiddenMalloc(); }\n")
file(WRITE "${_cr_h}"
  "inline void mach_absolute_time() {}\ninline void AudioUnitRender() {}\ninline void invokeAudioHostCallback() {}\nstruct Gate {};\ninline Gate gate;\nstruct AudioInputCallbackScope { explicit AudioInputCallbackScope(Gate&) {} };\n")
file(WRITE "${_cr_hidden}"
  "#include <cstdlib>\ninline void hiddenMalloc() { (void)std::malloc(1); }\n")
if(SINGZ_IOS_AUDIO_HOST_RT_CXX_COMPILER_ID STREQUAL "AppleClang")
  execute_process(COMMAND "${SINGZ_IOS_AUDIO_HOST_RT_CXX_COMPILER}"
    -std=c++20 -Wall -Wextra -Wpedantic -Werror -fsyntax-only
    "-I${_cr_root}" "${_cr_cpp}"
    RESULT_VARIABLE _cr_compile_result
    OUTPUT_VARIABLE _cr_compile_out ERROR_VARIABLE _cr_compile_err)
  if(NOT _cr_compile_result EQUAL 0)
    message(FATAL_ERROR
      "Apple Clang did not accept the CR-only continued include fixture:\n${_cr_compile_out}${_cr_compile_err}")
  endif()
endif()
set(_saved_include_roots ${_valid_include_roots})
set(_valid_include_roots "${_cr_root}")
set(_cr_manifest "${SINGZ_IOS_AUDIO_HOST_RT_TEST_DIR}/cr-continued.cmake")
_write_manifest("${_cr_manifest}" "${_cr_cpp}" "${_cr_h}")
set(_valid_include_roots ${_saved_include_roots})
execute_process(COMMAND "${CMAKE_COMMAND}"
  "-DSINGZ_IOS_AUDIO_HOST_RT_MANIFEST=${_cr_manifest}"
  -P "${SINGZ_IOS_AUDIO_HOST_RT_CHECKER}"
  RESULT_VARIABLE _cr_result OUTPUT_VARIABLE _cr_out
  ERROR_VARIABLE _cr_err)
if(_cr_result EQUAL 0 OR
   NOT "${_cr_out}${_cr_err}" MATCHES
       "Continued source lines are forbidden")
  message(FATAL_ERROR
    "iOS RT checker accepted a CR-only continued include:\n${_cr_out}${_cr_err}")
endif()

set(_import_dir
  "${SINGZ_IOS_AUDIO_HOST_RT_TEST_DIR}/import-header/platform/ios")
set(_import_root
  "${SINGZ_IOS_AUDIO_HOST_RT_TEST_DIR}/import-header/include")
file(MAKE_DIRECTORY "${_import_dir}" "${_import_root}")
set(_import_cpp "${_import_dir}/audio_host_ios_callback.cpp")
set(_import_h "${_import_dir}/audio_host_ios_callback.h")
set(_import_hidden "${_import_root}/hidden_helper.h")
file(WRITE "${_import_cpp}"
  "#include \"audio_host_ios_callback.h\"\n#pragma clang diagnostic push\n#pragma clang diagnostic ignored \"-Wimport-preprocessor-directive-pedantic\"\n#import <hidden_helper.h>\n#pragma clang diagnostic pop\nvoid callback() { mach_absolute_time(); AudioUnitRender(); invokeAudioHostCallback(); AudioInputCallbackScope scope(gate); hiddenMalloc(); }\n")
file(WRITE "${_import_h}"
  "inline void mach_absolute_time() {}\ninline void AudioUnitRender() {}\ninline void invokeAudioHostCallback() {}\nstruct Gate {};\ninline Gate gate;\nstruct AudioInputCallbackScope { explicit AudioInputCallbackScope(Gate&) {} };\n")
file(WRITE "${_import_hidden}"
  "#include <cstdlib>\ninline void hiddenMalloc() { (void)std::malloc(1); }\n")
if(SINGZ_IOS_AUDIO_HOST_RT_CXX_COMPILER_ID STREQUAL "AppleClang")
  execute_process(COMMAND "${SINGZ_IOS_AUDIO_HOST_RT_CXX_COMPILER}"
    -std=c++20 -Wall -Wextra -Wpedantic -Werror -fsyntax-only
    "-I${_import_root}" "${_import_cpp}"
    RESULT_VARIABLE _import_compile_result
    OUTPUT_VARIABLE _import_compile_out ERROR_VARIABLE _import_compile_err)
  if(NOT _import_compile_result EQUAL 0)
    message(FATAL_ERROR
      "Apple Clang did not accept the locally suppressed #import fixture:\n${_import_compile_out}${_import_compile_err}")
  endif()
endif()
set(_saved_include_roots ${_valid_include_roots})
set(_valid_include_roots "${_import_root}")
set(_import_manifest "${SINGZ_IOS_AUDIO_HOST_RT_TEST_DIR}/import.cmake")
_write_manifest("${_import_manifest}" "${_import_cpp}" "${_import_h}")
set(_valid_include_roots ${_saved_include_roots})
execute_process(COMMAND "${CMAKE_COMMAND}"
  "-DSINGZ_IOS_AUDIO_HOST_RT_MANIFEST=${_import_manifest}"
  -P "${SINGZ_IOS_AUDIO_HOST_RT_CHECKER}"
  RESULT_VARIABLE _import_result OUTPUT_VARIABLE _import_out
  ERROR_VARIABLE _import_err)
if(_import_result EQUAL 0 OR
   NOT "${_import_out}${_import_err}" MATCHES
       "Preprocessor import directives are forbidden")
  message(FATAL_ERROR
    "iOS RT checker accepted an Apple #import directive:\n${_import_out}${_import_err}")
endif()

set(_comment_include_dir
  "${SINGZ_IOS_AUDIO_HOST_RT_TEST_DIR}/comment-include/platform/ios")
set(_comment_include_root
  "${SINGZ_IOS_AUDIO_HOST_RT_TEST_DIR}/comment-include/include")
file(MAKE_DIRECTORY "${_comment_include_dir}" "${_comment_include_root}")
set(_comment_include_cpp
  "${_comment_include_dir}/audio_host_ios_callback.cpp")
set(_comment_include_h
  "${_comment_include_dir}/audio_host_ios_callback.h")
set(_comment_include_hidden
  "${_comment_include_root}/hidden_helper.h")
file(WRITE "${_comment_include_cpp}"
  "#include \"audio_host_ios_callback.h\"\n#/**/include <hidden_helper.h>\nvoid callback() { mach_absolute_time(); AudioUnitRender(); invokeAudioHostCallback(); AudioInputCallbackScope scope(gate); hiddenMalloc(); }\n")
file(WRITE "${_comment_include_h}"
  "inline void mach_absolute_time() {}\ninline void AudioUnitRender() {}\ninline void invokeAudioHostCallback() {}\nstruct Gate {};\ninline Gate gate;\nstruct AudioInputCallbackScope { explicit AudioInputCallbackScope(Gate&) {} };\n")
file(WRITE "${_comment_include_hidden}"
  "#include <cstdlib>\ninline void hiddenMalloc() { (void)std::malloc(1); }\n")
if(SINGZ_IOS_AUDIO_HOST_RT_CXX_COMPILER_ID STREQUAL "AppleClang")
  execute_process(COMMAND "${SINGZ_IOS_AUDIO_HOST_RT_CXX_COMPILER}"
    -std=c++20 -Wall -Wextra -Wpedantic -Werror -fsyntax-only
    "-I${_comment_include_root}" "${_comment_include_cpp}"
    RESULT_VARIABLE _comment_include_compile_result
    OUTPUT_VARIABLE _comment_include_compile_out
    ERROR_VARIABLE _comment_include_compile_err)
  if(NOT _comment_include_compile_result EQUAL 0)
    message(FATAL_ERROR
      "Apple Clang did not accept the comment-obscured include fixture:\n${_comment_include_compile_out}${_comment_include_compile_err}")
  endif()
endif()
set(_saved_include_roots ${_valid_include_roots})
set(_valid_include_roots "${_comment_include_root}")
set(_comment_include_manifest
  "${SINGZ_IOS_AUDIO_HOST_RT_TEST_DIR}/comment-include.cmake")
_write_manifest("${_comment_include_manifest}"
  "${_comment_include_cpp}" "${_comment_include_h}")
set(_valid_include_roots ${_saved_include_roots})
execute_process(COMMAND "${CMAKE_COMMAND}"
  "-DSINGZ_IOS_AUDIO_HOST_RT_MANIFEST=${_comment_include_manifest}"
  -P "${SINGZ_IOS_AUDIO_HOST_RT_CHECKER}"
  RESULT_VARIABLE _comment_include_result
  OUTPUT_VARIABLE _comment_include_out ERROR_VARIABLE _comment_include_err)
if(_comment_include_result EQUAL 0 OR
   NOT "${_comment_include_out}${_comment_include_err}" MATCHES
       "Comments may not obscure.*#/.\\*/include")
  message(FATAL_ERROR
    "iOS RT checker accepted a comment-obscured include directive:\n${_comment_include_out}${_comment_include_err}")
endif()

set(_comment_dir
  "${SINGZ_IOS_AUDIO_HOST_RT_TEST_DIR}/comment-only/platform/ios")
file(MAKE_DIRECTORY "${_comment_dir}")
set(_comment_cpp "${_comment_dir}/audio_host_ios_callback.cpp")
set(_comment_h "${_comment_dir}/audio_host_ios_callback.h")
file(WRITE "${_comment_cpp}"
  "// mach_absolute_time(); AudioUnitRender(); invokeAudioHostCallback(); AudioInputCallbackScope();\n")
file(WRITE "${_comment_h}" "#pragma once\n")
set(_comment_manifest "${SINGZ_IOS_AUDIO_HOST_RT_TEST_DIR}/comment.cmake")
_write_manifest("${_comment_manifest}" "${_comment_cpp}" "${_comment_h}")
execute_process(COMMAND "${CMAKE_COMMAND}"
  "-DSINGZ_IOS_AUDIO_HOST_RT_MANIFEST=${_comment_manifest}"
  -P "${SINGZ_IOS_AUDIO_HOST_RT_CHECKER}"
  RESULT_VARIABLE _comment_result OUTPUT_VARIABLE _comment_out
  ERROR_VARIABLE _comment_err)
if(_comment_result EQUAL 0 OR
   NOT "${_comment_out}${_comment_err}" MATCHES
       "missing required operation.*mach_absolute_time")
  message(FATAL_ERROR
    "iOS RT checker accepted comment-only evidence:\n${_comment_out}${_comment_err}")
endif()

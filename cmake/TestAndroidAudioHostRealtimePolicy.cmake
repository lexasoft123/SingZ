if(NOT DEFINED SINGZ_ANDROID_AUDIO_HOST_RT_MANIFEST OR
   NOT DEFINED SINGZ_ANDROID_AUDIO_HOST_RT_CHECKER OR
   NOT DEFINED SINGZ_ANDROID_AUDIO_HOST_RT_TEST_DIR)
  message(FATAL_ERROR "Android AudioHost RT negative-policy inputs are required")
endif()
if(NOT DEFINED SINGZ_ANDROID_AUDIO_HOST_RT_CXX_COMPILER OR
   NOT EXISTS "${SINGZ_ANDROID_AUDIO_HOST_RT_CXX_COMPILER}")
  message(FATAL_ERROR
    "Android AudioHost RT compile-first proof requires a configured C++ compiler")
endif()
if(NOT DEFINED SINGZ_ANDROID_AUDIO_HOST_RT_CXX_COMPILER_ID OR
   NOT SINGZ_ANDROID_AUDIO_HOST_RT_CXX_COMPILER_ID MATCHES "Clang")
  message(FATAL_ERROR
    "Android AudioHost RT compile-first proof requires Clang")
endif()
include("${SINGZ_ANDROID_AUDIO_HOST_RT_MANIFEST}")
file(MAKE_DIRECTORY "${SINGZ_ANDROID_AUDIO_HOST_RT_TEST_DIR}")
set(_valid ${SINGZ_ANDROID_AUDIO_HOST_RT_FILES})
set(_roots ${SINGZ_ANDROID_AUDIO_HOST_RT_PROJECT_INCLUDE_ROOTS})
set(_android_rt_compile_command
  "${SINGZ_ANDROID_AUDIO_HOST_RT_CXX_COMPILER}")
if(DEFINED SINGZ_ANDROID_AUDIO_HOST_RT_CXX_TARGET AND
   NOT SINGZ_ANDROID_AUDIO_HOST_RT_CXX_TARGET STREQUAL "")
  list(APPEND _android_rt_compile_command
    "--target=${SINGZ_ANDROID_AUDIO_HOST_RT_CXX_TARGET}")
endif()
if(DEFINED SINGZ_ANDROID_AUDIO_HOST_RT_CXX_SYSROOT AND
   NOT SINGZ_ANDROID_AUDIO_HOST_RT_CXX_SYSROOT STREQUAL "")
  list(APPEND _android_rt_compile_command
    "--sysroot=${SINGZ_ANDROID_AUDIO_HOST_RT_CXX_SYSROOT}")
endif()

function(write_manifest path)
  file(WRITE "${path}" "set(SINGZ_ANDROID_AUDIO_HOST_RT_FILES\n")
  foreach(_file IN LISTS ARGN)
    file(APPEND "${path}" "  [==[${_file}]==]\n")
  endforeach()
  file(APPEND "${path}" ")\nset(SINGZ_ANDROID_AUDIO_HOST_RT_PROJECT_INCLUDE_ROOTS\n")
  foreach(_root IN LISTS _roots)
    file(APPEND "${path}" "  [==[${_root}]==]\n")
  endforeach()
  file(APPEND "${path}" ")\n")
endfunction()

function(write_callback_manifest path cpp header)
  get_filename_component(_callback_dir "${cpp}" DIRECTORY)
  set(_callback_policy
    "${_callback_dir}/audio_host_android_callback_policy.cpp")
  if(NOT EXISTS "${_callback_policy}")
    file(WRITE "${_callback_policy}" "// Deliberately empty fixture policy.\n")
  endif()
  write_manifest("${path}" "${cpp}" "${header}" "${_callback_policy}")
endfunction()

set(_fixture "${SINGZ_ANDROID_AUDIO_HOST_RT_TEST_DIR}/forbidden.cpp")
file(WRITE "${_fixture}" "#include <mutex>\nstd::mutex callbackMutex;\n")
set(_manifest "${SINGZ_ANDROID_AUDIO_HOST_RT_TEST_DIR}/forbidden.cmake")
write_manifest("${_manifest}" ${_valid} "${_fixture}")
execute_process(COMMAND "${CMAKE_COMMAND}"
  "-DSINGZ_ANDROID_AUDIO_HOST_RT_MANIFEST=${_manifest}"
  -P "${SINGZ_ANDROID_AUDIO_HOST_RT_CHECKER}"
  RESULT_VARIABLE _result OUTPUT_VARIABLE _out ERROR_VARIABLE _err)
if(_result EQUAL 0 OR NOT "${_out}${_err}" MATCHES "Forbidden.*mutex")
  message(FATAL_ERROR "Android RT checker accepted mutex fixture:\n${_out}${_err}")
endif()

set(_dir "${SINGZ_ANDROID_AUDIO_HOST_RT_TEST_DIR}/closure/platform/android")
file(MAKE_DIRECTORY "${_dir}")
set(_cpp "${_dir}/audio_host_android_callback.cpp")
set(_header "${_dir}/audio_host_android_callback.h")
set(_hidden "${_dir}/hidden.h")
file(WRITE "${_cpp}"
  "#include \"audio_host_android_callback.h\"\n#include \"hidden.h\"\nvoid callback(){ input.read(); invokeAudioHostCallback(); AudioInputCallbackOwnerScope scope(gate); clock_gettime(0, 0); }\n")
file(WRITE "${_header}" "#pragma once\n")
file(WRITE "${_hidden}" "inline void hidden(){ (void)malloc(1); }\n")
set(_manifest "${SINGZ_ANDROID_AUDIO_HOST_RT_TEST_DIR}/closure.cmake")
write_callback_manifest("${_manifest}" "${_cpp}" "${_header}")
execute_process(COMMAND "${CMAKE_COMMAND}"
  "-DSINGZ_ANDROID_AUDIO_HOST_RT_MANIFEST=${_manifest}"
  -P "${SINGZ_ANDROID_AUDIO_HOST_RT_CHECKER}"
  RESULT_VARIABLE _result OUTPUT_VARIABLE _out ERROR_VARIABLE _err)
if(_result EQUAL 0 OR NOT "${_out}${_err}" MATCHES "Forbidden.*malloc")
  message(FATAL_ERROR "Android RT checker accepted hidden malloc:\n${_out}${_err}")
endif()

# The real callback reaches timestamp/deadline helpers defined in a separate
# project translation unit. Compile the same out-of-line shape first, then
# prove the manifest scans that helper body rather than stopping at the
# callback declaration/call site.
set(_out_of_line_dir
  "${SINGZ_ANDROID_AUDIO_HOST_RT_TEST_DIR}/out-of-line/platform/android")
file(MAKE_DIRECTORY "${_out_of_line_dir}")
set(_out_of_line_cpp
  "${_out_of_line_dir}/audio_host_android_callback.cpp")
set(_out_of_line_h
  "${_out_of_line_dir}/audio_host_android_callback.h")
set(_out_of_line_policy_cpp
  "${_out_of_line_dir}/audio_host_android_callback_policy.cpp")
set(_out_of_line_policy_h
  "${_out_of_line_dir}/audio_host_android_callback_policy.h")
file(WRITE "${_out_of_line_cpp}"
  "#include \"audio_host_android_callback.h\"\n#include \"audio_host_android_callback_policy.h\"\nvoid callback(){ input.read(); invokeAudioHostCallback(); AudioInputCallbackOwnerScope scope(gate); clock_gettime(0, 0); outOfLineHelper(); }\n")
file(WRITE "${_out_of_line_h}"
  "struct Input { void read() {} }; inline Input input;\ninline void invokeAudioHostCallback() {}\nstruct Gate {}; inline Gate gate;\nstruct AudioInputCallbackOwnerScope { explicit AudioInputCallbackOwnerScope(Gate&) {} };\ninline void clock_gettime(int, int) {}\n")
file(WRITE "${_out_of_line_policy_h}" "void outOfLineHelper();\n")
file(WRITE "${_out_of_line_policy_cpp}"
  "#include \"audio_host_android_callback_policy.h\"\n#include <cstdlib>\n#include <mutex>\nvoid outOfLineHelper(){ static std::mutex mutex; std::lock_guard<std::mutex> lock(mutex); (void)std::malloc(1); }\n")
execute_process(COMMAND ${_android_rt_compile_command}
  -std=c++20 -Wall -Wextra -Wpedantic -Werror -fsyntax-only
  "${_out_of_line_cpp}" "${_out_of_line_policy_cpp}"
  RESULT_VARIABLE _out_of_line_compile_result
  OUTPUT_VARIABLE _out_of_line_compile_out
  ERROR_VARIABLE _out_of_line_compile_err)
if(NOT _out_of_line_compile_result EQUAL 0)
  message(FATAL_ERROR
    "Android Clang did not accept out-of-line callback-helper fixture:\n${_out_of_line_compile_out}${_out_of_line_compile_err}")
endif()
set(_out_of_line_manifest
  "${SINGZ_ANDROID_AUDIO_HOST_RT_TEST_DIR}/out-of-line.cmake")
write_manifest("${_out_of_line_manifest}" "${_out_of_line_cpp}"
  "${_out_of_line_h}" "${_out_of_line_policy_cpp}"
  "${_out_of_line_policy_h}")
execute_process(COMMAND "${CMAKE_COMMAND}"
  "-DSINGZ_ANDROID_AUDIO_HOST_RT_MANIFEST=${_out_of_line_manifest}"
  -P "${SINGZ_ANDROID_AUDIO_HOST_RT_CHECKER}"
  RESULT_VARIABLE _out_of_line_result OUTPUT_VARIABLE _out_of_line_out
  ERROR_VARIABLE _out_of_line_err)
if(_out_of_line_result EQUAL 0 OR
   NOT "${_out_of_line_out}${_out_of_line_err}" MATCHES
       "Forbidden.*audio_host_android_callback_policy.cpp.*mutex")
  message(FATAL_ERROR
    "Android RT checker accepted forbidden out-of-line callback helper:\n${_out_of_line_out}${_out_of_line_err}")
endif()

# Clang/NDK accepts #import as a real once-only include. Compile the fixture
# first so this cannot become a vacuous textual test, then prove the checker
# rejects the unscanned helper closure containing both allocation and locking.
set(_import_dir
  "${SINGZ_ANDROID_AUDIO_HOST_RT_TEST_DIR}/import-header/platform/android")
set(_import_root
  "${SINGZ_ANDROID_AUDIO_HOST_RT_TEST_DIR}/import-header/include")
file(MAKE_DIRECTORY "${_import_dir}" "${_import_root}")
set(_import_cpp "${_import_dir}/audio_host_android_callback.cpp")
set(_import_h "${_import_dir}/audio_host_android_callback.h")
set(_import_hidden "${_import_root}/hidden_helper.h")
file(WRITE "${_import_cpp}"
  "#include \"audio_host_android_callback.h\"\n#pragma clang diagnostic push\n#pragma clang diagnostic ignored \"-Wimport-preprocessor-directive-pedantic\"\n#import <hidden_helper.h>\n#pragma clang diagnostic pop\nvoid callback(){ input.read(); invokeAudioHostCallback(); AudioInputCallbackOwnerScope scope(gate); clock_gettime(0, 0); hiddenAllocateAndLock(); }\n")
file(WRITE "${_import_h}"
  "struct Input { void read() {} }; inline Input input;\ninline void invokeAudioHostCallback() {}\nstruct Gate {}; inline Gate gate;\nstruct AudioInputCallbackOwnerScope { explicit AudioInputCallbackOwnerScope(Gate&) {} };\ninline void clock_gettime(int, int) {}\n")
file(WRITE "${_import_hidden}"
  "#include <cstdlib>\n#include <mutex>\ninline void hiddenAllocateAndLock(){ static std::mutex mutex; std::lock_guard<std::mutex> lock(mutex); (void)std::malloc(1); }\n")
execute_process(COMMAND ${_android_rt_compile_command}
  -std=c++20 -Wall -Wextra -Wpedantic -Werror -fsyntax-only
  "-I${_import_root}" "${_import_cpp}"
  RESULT_VARIABLE _import_compile_result
  OUTPUT_VARIABLE _import_compile_out ERROR_VARIABLE _import_compile_err)
if(NOT _import_compile_result EQUAL 0)
  message(FATAL_ERROR
    "Android Clang did not accept the locally suppressed #import fixture:\n${_import_compile_out}${_import_compile_err}")
endif()
set(_saved_roots ${_roots})
set(_roots "${_import_root}")
set(_import_manifest
  "${SINGZ_ANDROID_AUDIO_HOST_RT_TEST_DIR}/import.cmake")
write_callback_manifest("${_import_manifest}" "${_import_cpp}" "${_import_h}")
set(_roots ${_saved_roots})
execute_process(COMMAND "${CMAKE_COMMAND}"
  "-DSINGZ_ANDROID_AUDIO_HOST_RT_MANIFEST=${_import_manifest}"
  -P "${SINGZ_ANDROID_AUDIO_HOST_RT_CHECKER}"
  RESULT_VARIABLE _import_result OUTPUT_VARIABLE _import_out
  ERROR_VARIABLE _import_err)
if(_import_result EQUAL 0 OR
   NOT "${_import_out}${_import_err}" MATCHES
       "Preprocessor import directives are forbidden")
  message(FATAL_ERROR
    "Android RT checker accepted a Clang #import directive:\n${_import_out}${_import_err}")
endif()

# VT and FF are preprocessing whitespace to Clang. Generate the exact bytes at
# test time (never store raw control bytes in repository sources), compile each
# #<control>import translation unit first, then require the checker's explicit
# fail-closed control-byte diagnostic before imported allocation/locking can be
# omitted from its closure.
function(test_control_import fixture_name control_byte expected_error)
  set(_control_dir
    "${SINGZ_ANDROID_AUDIO_HOST_RT_TEST_DIR}/${fixture_name}/platform/android")
  set(_control_root
    "${SINGZ_ANDROID_AUDIO_HOST_RT_TEST_DIR}/${fixture_name}/include")
  file(MAKE_DIRECTORY "${_control_dir}" "${_control_root}")
  set(_control_cpp "${_control_dir}/audio_host_android_callback.cpp")
  set(_control_h "${_control_dir}/audio_host_android_callback.h")
  set(_control_hidden "${_control_root}/hidden_helper.h")
  file(WRITE "${_control_cpp}"
    "#include \"audio_host_android_callback.h\"\n#pragma clang diagnostic push\n#pragma clang diagnostic ignored \"-Wimport-preprocessor-directive-pedantic\"\n#${control_byte}import <hidden_helper.h>\n#pragma clang diagnostic pop\nvoid callback(){ input.read(); invokeAudioHostCallback(); AudioInputCallbackOwnerScope scope(gate); clock_gettime(0, 0); hiddenAllocateAndLock(); }\n")
  file(WRITE "${_control_h}"
    "struct Input { void read() {} }; inline Input input;\ninline void invokeAudioHostCallback() {}\nstruct Gate {}; inline Gate gate;\nstruct AudioInputCallbackOwnerScope { explicit AudioInputCallbackOwnerScope(Gate&) {} };\ninline void clock_gettime(int, int) {}\n")
  file(WRITE "${_control_hidden}"
    "#include <cstdlib>\n#include <mutex>\ninline void hiddenAllocateAndLock(){ static std::mutex mutex; std::lock_guard<std::mutex> lock(mutex); (void)std::malloc(1); }\n")
  execute_process(COMMAND ${_android_rt_compile_command}
    -std=c++20 -Wall -Wextra -Wpedantic -Werror -fsyntax-only
    "-I${_control_root}" "${_control_cpp}"
    RESULT_VARIABLE _control_compile_result
    OUTPUT_VARIABLE _control_compile_out ERROR_VARIABLE _control_compile_err)
  if(NOT _control_compile_result EQUAL 0)
    message(FATAL_ERROR
      "Android Clang did not accept ${fixture_name} #import fixture:\n${_control_compile_out}${_control_compile_err}")
  endif()
  set(_saved_control_roots ${_roots})
  set(_roots "${_control_root}")
  set(_control_manifest
    "${SINGZ_ANDROID_AUDIO_HOST_RT_TEST_DIR}/${fixture_name}.cmake")
  write_callback_manifest("${_control_manifest}" "${_control_cpp}" "${_control_h}")
  set(_roots ${_saved_control_roots})
  execute_process(COMMAND "${CMAKE_COMMAND}"
    "-DSINGZ_ANDROID_AUDIO_HOST_RT_MANIFEST=${_control_manifest}"
    -P "${SINGZ_ANDROID_AUDIO_HOST_RT_CHECKER}"
    RESULT_VARIABLE _control_result OUTPUT_VARIABLE _control_out
    ERROR_VARIABLE _control_err)
  if(_control_result EQUAL 0 OR
     NOT "${_control_out}${_control_err}" MATCHES "${expected_error}")
    message(FATAL_ERROR
      "Android RT checker accepted ${fixture_name} #import fixture:\n${_control_out}${_control_err}")
  endif()
endfunction()

string(ASCII 11 _test_vertical_tab)
string(ASCII 12 _test_form_feed)
test_control_import("vertical-tab-import" "${_test_vertical_tab}"
  "Vertical-tab control byte 0x0B is forbidden")
test_control_import("form-feed-import" "${_test_form_feed}"
  "Form-feed control byte 0x0C is forbidden")

# CMake strings cannot contain NUL. Host tests receive a tiny writer built by
# the configured host CMake toolchain. Android cross builds instead assemble
# the bytes into an ELF section and extract it with the configured NDK
# llvm-objcopy; no target executable is ever run. Both paths are shell-free and
# require no interpreter or raw repository byte.
function(write_hex_fixture path hex_bytes)
  file(REMOVE "${path}")
  if(DEFINED SINGZ_ANDROID_AUDIO_HOST_RT_HEX_WRITER AND
     EXISTS "${SINGZ_ANDROID_AUDIO_HOST_RT_HEX_WRITER}")
    execute_process(COMMAND "${SINGZ_ANDROID_AUDIO_HOST_RT_HEX_WRITER}"
      "${path}" "${hex_bytes}"
      RESULT_VARIABLE _hex_write_result OUTPUT_VARIABLE _hex_write_out
      ERROR_VARIABLE _hex_write_err)
  elseif(DEFINED SINGZ_ANDROID_AUDIO_HOST_RT_OBJCOPY AND
         EXISTS "${SINGZ_ANDROID_AUDIO_HOST_RT_OBJCOPY}")
    string(MD5 _hex_fixture_id "${path}")
    set(_hex_assembly
      "${SINGZ_ANDROID_AUDIO_HOST_RT_TEST_DIR}/${_hex_fixture_id}.s")
    set(_hex_object
      "${SINGZ_ANDROID_AUDIO_HOST_RT_TEST_DIR}/${_hex_fixture_id}.o")
    set(_hex_assembly_text
      ".section .rodata.singz_fixture,\"a\",%progbits\n")
    string(LENGTH "${hex_bytes}" _hex_bytes_length)
    set(_hex_offset 0)
    while(_hex_offset LESS _hex_bytes_length)
      string(SUBSTRING "${hex_bytes}" ${_hex_offset} 2 _hex_byte)
      string(APPEND _hex_assembly_text ".byte 0x${_hex_byte}\n")
      math(EXPR _hex_offset "${_hex_offset} + 2")
    endwhile()
    file(WRITE "${_hex_assembly}" "${_hex_assembly_text}")
    execute_process(COMMAND ${_android_rt_compile_command}
      -c "${_hex_assembly}" -o "${_hex_object}"
      RESULT_VARIABLE _hex_assemble_result
      OUTPUT_VARIABLE _hex_assemble_out ERROR_VARIABLE _hex_assemble_err)
    if(NOT _hex_assemble_result EQUAL 0)
      message(FATAL_ERROR
        "Configured Android Clang could not assemble raw-byte fixture:\n${_hex_assemble_out}${_hex_assemble_err}")
    endif()
    execute_process(COMMAND "${SINGZ_ANDROID_AUDIO_HOST_RT_OBJCOPY}"
      "--dump-section=.rodata.singz_fixture=${path}" "${_hex_object}"
      RESULT_VARIABLE _hex_write_result OUTPUT_VARIABLE _hex_write_out
      ERROR_VARIABLE _hex_write_err)
  else()
    message(FATAL_ERROR
      "Android RT raw-byte fixtures require a configured host hex writer or llvm-objcopy")
  endif()
  if(NOT _hex_write_result EQUAL 0)
    message(FATAL_ERROR
      "Could not materialize Android RT raw-byte fixture ${path}:\n${_hex_write_out}${_hex_write_err}")
  endif()
  file(READ "${path}" _written_hex HEX)
  if(NOT "${_written_hex}" STREQUAL "${hex_bytes}")
    message(FATAL_ERROR
      "Android RT raw-byte fixture did not preserve its exact hex payload: ${path}")
  endif()
endfunction()

function(test_raw_byte_import fixture_name injected_hex clang_warning
         expected_error)
  set(_raw_dir
    "${SINGZ_ANDROID_AUDIO_HOST_RT_TEST_DIR}/${fixture_name}/platform/android")
  set(_raw_root
    "${SINGZ_ANDROID_AUDIO_HOST_RT_TEST_DIR}/${fixture_name}/include")
  file(MAKE_DIRECTORY "${_raw_dir}" "${_raw_root}")
  set(_raw_cpp "${_raw_dir}/audio_host_android_callback.cpp")
  set(_raw_h "${_raw_dir}/audio_host_android_callback.h")
  set(_raw_hidden "${_raw_root}/hidden_helper.h")
  set(_raw_prefix
    "#include \"audio_host_android_callback.h\"\n#pragma clang diagnostic push\n#pragma clang diagnostic ignored \"-Wimport-preprocessor-directive-pedantic\"\n#pragma clang diagnostic ignored \"${clang_warning}\"\n#")
  set(_raw_suffix
    "import <hidden_helper.h>\n#pragma clang diagnostic pop\nvoid callback(){ input.read(); invokeAudioHostCallback(); AudioInputCallbackOwnerScope scope(gate); clock_gettime(0, 0); hiddenAllocateAndLock(); }\n")
  string(HEX "${_raw_prefix}" _raw_prefix_hex)
  string(HEX "${_raw_suffix}" _raw_suffix_hex)
  write_hex_fixture("${_raw_cpp}"
    "${_raw_prefix_hex}${injected_hex}${_raw_suffix_hex}")
  file(WRITE "${_raw_h}"
    "struct Input { void read() {} }; inline Input input;\ninline void invokeAudioHostCallback() {}\nstruct Gate {}; inline Gate gate;\nstruct AudioInputCallbackOwnerScope { explicit AudioInputCallbackOwnerScope(Gate&) {} };\ninline void clock_gettime(int, int) {}\n")
  file(WRITE "${_raw_hidden}"
    "#include <cstdlib>\n#include <mutex>\ninline void hiddenAllocateAndLock(){ static std::mutex mutex; std::lock_guard<std::mutex> lock(mutex); (void)std::malloc(1); }\n")
  execute_process(COMMAND ${_android_rt_compile_command}
    -std=c++20 -Wall -Wextra -Wpedantic -Werror -fsyntax-only
    "-I${_raw_root}" "${_raw_cpp}"
    RESULT_VARIABLE _raw_compile_result
    OUTPUT_VARIABLE _raw_compile_out ERROR_VARIABLE _raw_compile_err)
  if(NOT _raw_compile_result EQUAL 0)
    message(FATAL_ERROR
      "Android Clang did not accept ${fixture_name} #import fixture:\n${_raw_compile_out}${_raw_compile_err}")
  endif()
  set(_saved_raw_roots ${_roots})
  set(_roots "${_raw_root}")
  set(_raw_manifest
    "${SINGZ_ANDROID_AUDIO_HOST_RT_TEST_DIR}/${fixture_name}.cmake")
  write_callback_manifest("${_raw_manifest}" "${_raw_cpp}" "${_raw_h}")
  set(_roots ${_saved_raw_roots})
  execute_process(COMMAND "${CMAKE_COMMAND}"
    "-DSINGZ_ANDROID_AUDIO_HOST_RT_MANIFEST=${_raw_manifest}"
    -P "${SINGZ_ANDROID_AUDIO_HOST_RT_CHECKER}"
    RESULT_VARIABLE _raw_result OUTPUT_VARIABLE _raw_out
    ERROR_VARIABLE _raw_err)
  if(_raw_result EQUAL 0 OR
     NOT "${_raw_out}${_raw_err}" MATCHES "${expected_error}")
    message(FATAL_ERROR
      "Android RT checker accepted ${fixture_name} #import fixture:\n${_raw_out}${_raw_err}")
  endif()
endfunction()

test_raw_byte_import("nbsp-import" "c2a0" "-Wunicode-whitespace"
  "Raw byte 0xC2 is forbidden")
test_raw_byte_import("nul-import" "00" "-Wnull-character"
  "Raw byte 0x00 is forbidden")

# A direct-call-only scanner misses function pointers and aliases. Compile the
# exact address-taking bypass first, then require the stripped closure scan to
# reject malloc as a whole identifier token even though allocator is the only
# name called by the function body.
set(_address_alias
  "${SINGZ_ANDROID_AUDIO_HOST_RT_TEST_DIR}/address-alias.cpp")
file(WRITE "${_address_alias}"
  "#include <cstdlib>\nauto allocator = &std::malloc;\nvoid* callbackAllocate(){ return allocator(1); }\n")
execute_process(COMMAND ${_android_rt_compile_command}
  -std=c++20 -Wall -Wextra -Wpedantic -Werror -fsyntax-only
  "${_address_alias}"
  RESULT_VARIABLE _address_alias_compile_result
  OUTPUT_VARIABLE _address_alias_compile_out
  ERROR_VARIABLE _address_alias_compile_err)
if(NOT _address_alias_compile_result EQUAL 0)
  message(FATAL_ERROR
    "Android Clang did not accept address-aliased allocation fixture:\n${_address_alias_compile_out}${_address_alias_compile_err}")
endif()
set(_manifest
  "${SINGZ_ANDROID_AUDIO_HOST_RT_TEST_DIR}/address-alias.cmake")
write_manifest("${_manifest}" ${_valid} "${_address_alias}")
execute_process(COMMAND "${CMAKE_COMMAND}"
  "-DSINGZ_ANDROID_AUDIO_HOST_RT_MANIFEST=${_manifest}"
  -P "${SINGZ_ANDROID_AUDIO_HOST_RT_CHECKER}"
  RESULT_VARIABLE _address_alias_result OUTPUT_VARIABLE _address_alias_out
  ERROR_VARIABLE _address_alias_err)
if(_address_alias_result EQUAL 0 OR
   NOT "${_address_alias_out}${_address_alias_err}" MATCHES
       "Forbidden Android AudioHost callback identifier.*malloc")
  message(FATAL_ERROR
    "Android RT checker accepted address-aliased allocation:\n${_address_alias_out}${_address_alias_err}")
endif()

# libdl can resolve a forbidden call from a string that literal stripping
# intentionally removes. Avoid platform header differences by declaring the
# POSIX entry point directly, compile the exact function-pointer path first,
# then require rejection of dlsym itself as a whole forbidden identifier.
set(_dynamic_loader
  "${SINGZ_ANDROID_AUDIO_HOST_RT_TEST_DIR}/dynamic-loader.cpp")
file(WRITE "${_dynamic_loader}"
  "extern \"C\" void* dlsym(void*, const char*);\nusing Allocate = void* (*)(unsigned long);\nvoid* callbackAllocate(){ auto allocator = reinterpret_cast<Allocate>(dlsym(nullptr, \"malloc\")); return allocator(1); }\n")
execute_process(COMMAND ${_android_rt_compile_command}
  -std=c++20 -Wall -Wextra -Wpedantic -Werror -fsyntax-only
  "${_dynamic_loader}"
  RESULT_VARIABLE _dynamic_loader_compile_result
  OUTPUT_VARIABLE _dynamic_loader_compile_out
  ERROR_VARIABLE _dynamic_loader_compile_err)
if(NOT _dynamic_loader_compile_result EQUAL 0)
  message(FATAL_ERROR
    "Android Clang did not accept dynamic-loader allocation fixture:\n${_dynamic_loader_compile_out}${_dynamic_loader_compile_err}")
endif()
set(_manifest
  "${SINGZ_ANDROID_AUDIO_HOST_RT_TEST_DIR}/dynamic-loader.cmake")
write_manifest("${_manifest}" ${_valid} "${_dynamic_loader}")
execute_process(COMMAND "${CMAKE_COMMAND}"
  "-DSINGZ_ANDROID_AUDIO_HOST_RT_MANIFEST=${_manifest}"
  -P "${SINGZ_ANDROID_AUDIO_HOST_RT_CHECKER}"
  RESULT_VARIABLE _dynamic_loader_result OUTPUT_VARIABLE _dynamic_loader_out
  ERROR_VARIABLE _dynamic_loader_err)
if(_dynamic_loader_result EQUAL 0 OR
   NOT "${_dynamic_loader_out}${_dynamic_loader_err}" MATCHES
       "Forbidden Android AudioHost callback identifier.*dlsym")
  message(FATAL_ERROR
    "Android RT checker accepted dynamic-loader allocation:\n${_dynamic_loader_out}${_dynamic_loader_err}")
endif()

# A production-looking visibility definition must be accepted only as the
# complete exact line. Appending executable replacement tokens and expanding
# the macro is valid C++, but must not let a valid prefix erase the suffix.
set(_visibility_suffix
  "${SINGZ_ANDROID_AUDIO_HOST_RT_TEST_DIR}/visibility-suffix.cpp")
file(WRITE "${_visibility_suffix}"
  "#define SINGZ_ZCORE_CALLBACK_LOCAL __attribute__((visibility(\"hidden\"))) void* callbackAllocate(){ return __builtin_malloc(1); }\nSINGZ_ZCORE_CALLBACK_LOCAL\n")
execute_process(COMMAND ${_android_rt_compile_command}
  -std=c++20 -Wall -Wextra -Wpedantic -Werror -fsyntax-only
  "${_visibility_suffix}"
  RESULT_VARIABLE _visibility_suffix_compile_result
  OUTPUT_VARIABLE _visibility_suffix_compile_out
  ERROR_VARIABLE _visibility_suffix_compile_err)
if(NOT _visibility_suffix_compile_result EQUAL 0)
  message(FATAL_ERROR
    "Android Clang did not accept visibility-suffix allocation fixture:\n${_visibility_suffix_compile_out}${_visibility_suffix_compile_err}")
endif()
set(_manifest
  "${SINGZ_ANDROID_AUDIO_HOST_RT_TEST_DIR}/visibility-suffix.cmake")
write_manifest("${_manifest}" ${_valid} "${_visibility_suffix}")
execute_process(COMMAND "${CMAKE_COMMAND}"
  "-DSINGZ_ANDROID_AUDIO_HOST_RT_MANIFEST=${_manifest}"
  -P "${SINGZ_ANDROID_AUDIO_HOST_RT_CHECKER}"
  RESULT_VARIABLE _visibility_suffix_result
  OUTPUT_VARIABLE _visibility_suffix_out ERROR_VARIABLE _visibility_suffix_err)
if(_visibility_suffix_result EQUAL 0 OR
   NOT "${_visibility_suffix_out}${_visibility_suffix_err}" MATCHES
       "Project macro definitions are forbidden.*SINGZ_ZCORE_CALLBACK_LOCAL")
  message(FATAL_ERROR
    "Android RT checker accepted visibility-suffix allocation:\n${_visibility_suffix_out}${_visibility_suffix_err}")
endif()

# An identity forwarder can defer expansion of a system token-paste helper.
# Compile the exact SAFE schedule, then prove the scanner rejects every
# non-production project definition before forwarding can hide allocation.
set(_identity_forwarder
  "${SINGZ_ANDROID_AUDIO_HOST_RT_TEST_DIR}/identity-forwarder.cpp")
file(WRITE "${_identity_forwarder}"
  "#include <array>\n#define SAFE(x) x\nvoid* callbackAllocate(){ return SAFE(_LIBCPP_CONCAT)(__builtin_, malloc)(1); }\n")
execute_process(COMMAND ${_android_rt_compile_command}
  -std=c++20 -Wall -Wextra -Wpedantic -Werror -fsyntax-only
  "${_identity_forwarder}"
  RESULT_VARIABLE _identity_forwarder_compile_result
  OUTPUT_VARIABLE _identity_forwarder_compile_out
  ERROR_VARIABLE _identity_forwarder_compile_err)
if(NOT _identity_forwarder_compile_result EQUAL 0)
  message(FATAL_ERROR
    "Android Clang did not accept identity-forwarded allocation fixture:\n${_identity_forwarder_compile_out}${_identity_forwarder_compile_err}")
endif()
set(_manifest
  "${SINGZ_ANDROID_AUDIO_HOST_RT_TEST_DIR}/identity-forwarder.cmake")
write_manifest("${_manifest}" ${_valid} "${_identity_forwarder}")
execute_process(COMMAND "${CMAKE_COMMAND}"
  "-DSINGZ_ANDROID_AUDIO_HOST_RT_MANIFEST=${_manifest}"
  -P "${SINGZ_ANDROID_AUDIO_HOST_RT_CHECKER}"
  RESULT_VARIABLE _identity_forwarder_result
  OUTPUT_VARIABLE _identity_forwarder_out
  ERROR_VARIABLE _identity_forwarder_err)
if(_identity_forwarder_result EQUAL 0 OR
   NOT "${_identity_forwarder_out}${_identity_forwarder_err}" MATCHES
       "Project macro definitions are forbidden.*SAFE")
  message(FATAL_ERROR
    "Android RT checker accepted identity-forwarded allocation:\n${_identity_forwarder_out}${_identity_forwarder_err}")
endif()

# A block comment is preprocessing whitespace, so it may appear before a
# directive-leading #. Compile an allowed-looking visibility definition with
# an injected allocating suffix and expansion, then require rejection before
# comment removal can turn it into an apparently ordinary directive.
set(_comment_directive
  "${SINGZ_ANDROID_AUDIO_HOST_RT_TEST_DIR}/comment-directive.cpp")
file(WRITE "${_comment_directive}"
  "/* obscured */ #define SINGZ_ZCORE_CALLBACK_LOCAL __attribute__((visibility(\"hidden\"))) void* callbackAllocate(){ return __builtin_malloc(1); }\nSINGZ_ZCORE_CALLBACK_LOCAL\n")
execute_process(COMMAND ${_android_rt_compile_command}
  -std=c++20 -Wall -Wextra -Wpedantic -Werror -fsyntax-only
  "${_comment_directive}"
  RESULT_VARIABLE _comment_directive_compile_result
  OUTPUT_VARIABLE _comment_directive_compile_out
  ERROR_VARIABLE _comment_directive_compile_err)
if(NOT _comment_directive_compile_result EQUAL 0)
  message(FATAL_ERROR
    "Android Clang did not accept comment-obscured directive fixture:\n${_comment_directive_compile_out}${_comment_directive_compile_err}")
endif()
set(_manifest
  "${SINGZ_ANDROID_AUDIO_HOST_RT_TEST_DIR}/comment-directive.cmake")
write_manifest("${_manifest}" ${_valid} "${_comment_directive}")
execute_process(COMMAND "${CMAKE_COMMAND}"
  "-DSINGZ_ANDROID_AUDIO_HOST_RT_MANIFEST=${_manifest}"
  -P "${SINGZ_ANDROID_AUDIO_HOST_RT_CHECKER}"
  RESULT_VARIABLE _comment_directive_result
  OUTPUT_VARIABLE _comment_directive_out
  ERROR_VARIABLE _comment_directive_err)
if(_comment_directive_result EQUAL 0 OR
   NOT "${_comment_directive_out}${_comment_directive_err}" MATCHES
       "Comments may not precede Android AudioHost RT preprocessing directives")
  message(FATAL_ERROR
    "Android RT checker accepted comment-obscured directive:\n${_comment_directive_out}${_comment_directive_err}")
endif()

# GNU asm labels can redirect an innocent source identifier to malloc without
# spelling the forbidden identifier outside a string. Compile the exact alias
# first, then reject the executable asm token as an unmodelled escape hatch.
set(_asm_alias "${SINGZ_ANDROID_AUDIO_HOST_RT_TEST_DIR}/asm-alias.cpp")
file(WRITE "${_asm_alias}"
  "extern \"C\" void* safeAllocate(unsigned long) asm(\"malloc\");\nvoid* callbackAllocate(){ return safeAllocate(1); }\n")
execute_process(COMMAND ${_android_rt_compile_command}
  -std=c++20 -Wall -Wextra -Wpedantic -Werror -fsyntax-only "${_asm_alias}"
  RESULT_VARIABLE _asm_alias_compile_result
  OUTPUT_VARIABLE _asm_alias_compile_out ERROR_VARIABLE _asm_alias_compile_err)
if(NOT _asm_alias_compile_result EQUAL 0)
  message(FATAL_ERROR
    "Android Clang did not accept GNU asm allocation alias fixture:\n${_asm_alias_compile_out}${_asm_alias_compile_err}")
endif()
set(_manifest "${SINGZ_ANDROID_AUDIO_HOST_RT_TEST_DIR}/asm-alias.cmake")
write_manifest("${_manifest}" ${_valid} "${_asm_alias}")
execute_process(COMMAND "${CMAKE_COMMAND}"
  "-DSINGZ_ANDROID_AUDIO_HOST_RT_MANIFEST=${_manifest}"
  -P "${SINGZ_ANDROID_AUDIO_HOST_RT_CHECKER}"
  RESULT_VARIABLE _asm_alias_result OUTPUT_VARIABLE _asm_alias_out
  ERROR_VARIABLE _asm_alias_err)
if(_asm_alias_result EQUAL 0 OR
   NOT "${_asm_alias_out}${_asm_alias_err}" MATCHES
       "GNU asm token is forbidden")
  message(FATAL_ERROR
    "Android RT checker accepted GNU asm allocation alias:\n${_asm_alias_out}${_asm_alias_err}")
endif()

# Token pasting can manufacture a forbidden function name only after macro
# expansion. Compile this translation unit first to prove that Clang accepts
# and resolves m##alloc, then require the lexical closure checker to reject
# the operator before it can hide allocation from the callback policy.
set(_paste "${SINGZ_ANDROID_AUDIO_HOST_RT_TEST_DIR}/token-paste.cpp")
file(WRITE "${_paste}"
  "#include <cstdlib>\n#define ALLOC std::m##alloc\nvoid* callbackAllocate(){ return ALLOC(1); }\n")
execute_process(COMMAND ${_android_rt_compile_command}
  -std=c++20 -Wall -Wextra -Wpedantic -Werror -fsyntax-only "${_paste}"
  RESULT_VARIABLE _paste_compile_result
  OUTPUT_VARIABLE _paste_compile_out ERROR_VARIABLE _paste_compile_err)
if(NOT _paste_compile_result EQUAL 0)
  message(FATAL_ERROR
    "Android Clang did not accept token-pasted allocation fixture:\n${_paste_compile_out}${_paste_compile_err}")
endif()
set(_manifest "${SINGZ_ANDROID_AUDIO_HOST_RT_TEST_DIR}/token-paste.cmake")
write_manifest("${_manifest}" ${_valid} "${_paste}")
execute_process(COMMAND "${CMAKE_COMMAND}"
  "-DSINGZ_ANDROID_AUDIO_HOST_RT_MANIFEST=${_manifest}"
  -P "${SINGZ_ANDROID_AUDIO_HOST_RT_CHECKER}"
  RESULT_VARIABLE _paste_result OUTPUT_VARIABLE _paste_out
  ERROR_VARIABLE _paste_err)
if(_paste_result EQUAL 0 OR NOT "${_paste_out}${_paste_err}" MATCHES
    "Token-pasting operator ## is forbidden")
  message(FATAL_ERROR
    "Android RT checker accepted token-pasted allocation:\n${_paste_out}${_paste_err}")
endif()

# libc++ exposes _LIBCPP_CONCAT through an otherwise allowed standard header.
# Its replacement list contains the token paste outside the project closure,
# so the callback source has no literal ## for the scanner to see. Compile the
# exact bypass first, then require fail-closed rejection of the reserved macro
# invocation itself.
set(_system_paste
  "${SINGZ_ANDROID_AUDIO_HOST_RT_TEST_DIR}/system-token-paste.cpp")
file(WRITE "${_system_paste}"
  "#include <array>\nvoid* callbackAllocate(){ return _LIBCPP_CONCAT(__builtin_, malloc)(1); }\n")
execute_process(COMMAND ${_android_rt_compile_command}
  -std=c++20 -Wall -Wextra -Wpedantic -Werror -fsyntax-only
  "${_system_paste}"
  RESULT_VARIABLE _system_paste_compile_result
  OUTPUT_VARIABLE _system_paste_compile_out
  ERROR_VARIABLE _system_paste_compile_err)
if(NOT _system_paste_compile_result EQUAL 0)
  message(FATAL_ERROR
    "Android Clang did not accept libc++ token-pasted allocation fixture:\n${_system_paste_compile_out}${_system_paste_compile_err}")
endif()
set(_manifest
  "${SINGZ_ANDROID_AUDIO_HOST_RT_TEST_DIR}/system-token-paste.cmake")
write_manifest("${_manifest}" ${_valid} "${_system_paste}")
execute_process(COMMAND "${CMAKE_COMMAND}"
  "-DSINGZ_ANDROID_AUDIO_HOST_RT_MANIFEST=${_manifest}"
  -P "${SINGZ_ANDROID_AUDIO_HOST_RT_CHECKER}"
  RESULT_VARIABLE _system_paste_result OUTPUT_VARIABLE _system_paste_out
  ERROR_VARIABLE _system_paste_err)
if(_system_paste_result EQUAL 0 OR
   NOT "${_system_paste_out}${_system_paste_err}" MATCHES
       "Implementation-reserved identifier is forbidden.*_LIBCPP_CONCAT")
  message(FATAL_ERROR
    "Android RT checker accepted libc++ token-pasted allocation:\n${_system_paste_out}${_system_paste_err}")
endif()

set(_macro "${SINGZ_ANDROID_AUDIO_HOST_RT_TEST_DIR}/macro.cpp")
file(WRITE "${_macro}"
  "#define HIDDEN <hidden.h>\n#include HIDDEN\nvoid callback(){ input.read(); invokeAudioHostCallback(); AudioInputCallbackOwnerScope scope(gate); clock_gettime(0, 0); }\n")
set(_manifest "${SINGZ_ANDROID_AUDIO_HOST_RT_TEST_DIR}/macro.cmake")
write_manifest("${_manifest}" ${_valid} "${_macro}")
execute_process(COMMAND "${CMAKE_COMMAND}"
  "-DSINGZ_ANDROID_AUDIO_HOST_RT_MANIFEST=${_manifest}"
  -P "${SINGZ_ANDROID_AUDIO_HOST_RT_CHECKER}"
  RESULT_VARIABLE _result OUTPUT_VARIABLE _out ERROR_VARIABLE _err)
if(_result EQUAL 0 OR NOT "${_out}${_err}" MATCHES "not an approved literal")
  message(FATAL_ERROR "Android RT checker accepted macro include:\n${_out}${_err}")
endif()

set(_manifest "${SINGZ_ANDROID_AUDIO_HOST_RT_TEST_DIR}/missing-member.cmake")
list(GET _valid 0 _only_callback_source)
write_manifest("${_manifest}" "${_only_callback_source}")
execute_process(COMMAND "${CMAKE_COMMAND}"
  "-DSINGZ_ANDROID_AUDIO_HOST_RT_MANIFEST=${_manifest}"
  -P "${SINGZ_ANDROID_AUDIO_HOST_RT_CHECKER}"
  RESULT_VARIABLE _result OUTPUT_VARIABLE _out ERROR_VARIABLE _err)
if(_result EQUAL 0 OR NOT "${_out}${_err}" MATCHES "missing required source membership")
  message(FATAL_ERROR "Android RT checker accepted omitted callback membership:\n${_out}${_err}")
endif()

set(_fixture "${SINGZ_ANDROID_AUDIO_HOST_RT_TEST_DIR}/continued.cpp")
file(WRITE "${_fixture}"
  "#include \\\n+<atomic>\n")
set(_manifest "${SINGZ_ANDROID_AUDIO_HOST_RT_TEST_DIR}/continued.cmake")
write_manifest("${_manifest}" ${_valid} "${_fixture}")
execute_process(COMMAND "${CMAKE_COMMAND}"
  "-DSINGZ_ANDROID_AUDIO_HOST_RT_MANIFEST=${_manifest}"
  -P "${SINGZ_ANDROID_AUDIO_HOST_RT_CHECKER}"
  RESULT_VARIABLE _result OUTPUT_VARIABLE _out ERROR_VARIABLE _err)
if(_result EQUAL 0 OR NOT "${_out}${_err}" MATCHES "Continued source lines")
  message(FATAL_ERROR "Android RT checker accepted continued include:\n${_out}${_err}")
endif()

set(_fixture "${SINGZ_ANDROID_AUDIO_HOST_RT_TEST_DIR}/alternative.cpp")
file(WRITE "${_fixture}" "%:include <atomic>\n")
set(_manifest "${SINGZ_ANDROID_AUDIO_HOST_RT_TEST_DIR}/alternative.cmake")
write_manifest("${_manifest}" ${_valid} "${_fixture}")
execute_process(COMMAND "${CMAKE_COMMAND}"
  "-DSINGZ_ANDROID_AUDIO_HOST_RT_MANIFEST=${_manifest}"
  -P "${SINGZ_ANDROID_AUDIO_HOST_RT_CHECKER}"
  RESULT_VARIABLE _result OUTPUT_VARIABLE _out ERROR_VARIABLE _err)
if(_result EQUAL 0 OR NOT "${_out}${_err}" MATCHES "Alternative preprocessing token")
  message(FATAL_ERROR "Android RT checker accepted alternative # token:\n${_out}${_err}")
endif()

set(_dir "${SINGZ_ANDROID_AUDIO_HOST_RT_TEST_DIR}/comment-only/platform/android")
file(MAKE_DIRECTORY "${_dir}")
set(_cpp "${_dir}/audio_host_android_callback.cpp")
set(_header "${_dir}/audio_host_android_callback.h")
file(WRITE "${_cpp}"
  "// input.read(); invokeAudioHostCallback(); AudioInputCallbackScope fake;\n")
file(WRITE "${_header}" "#pragma once\n")
set(_manifest "${SINGZ_ANDROID_AUDIO_HOST_RT_TEST_DIR}/comment-only.cmake")
write_callback_manifest("${_manifest}" "${_cpp}" "${_header}")
execute_process(COMMAND "${CMAKE_COMMAND}"
  "-DSINGZ_ANDROID_AUDIO_HOST_RT_MANIFEST=${_manifest}"
  -P "${SINGZ_ANDROID_AUDIO_HOST_RT_CHECKER}"
  RESULT_VARIABLE _result OUTPUT_VARIABLE _out ERROR_VARIABLE _err)
if(_result EQUAL 0 OR NOT "${_out}${_err}" MATCHES "missing required operation")
  message(FATAL_ERROR "Android RT checker accepted comment-only operations:\n${_out}${_err}")
endif()

set(_dir "${SINGZ_ANDROID_AUDIO_HOST_RT_TEST_DIR}/string-only/platform/android")
file(MAKE_DIRECTORY "${_dir}")
set(_cpp "${_dir}/audio_host_android_callback.cpp")
set(_header "${_dir}/audio_host_android_callback.h")
file(WRITE "${_cpp}"
  "const char* impostor = \"input.read(); invokeAudioHostCallback(); AudioInputCallbackOwnerScope fake; clock_gettime(0, 0);\";\n")
file(WRITE "${_header}" "#pragma once\n")
set(_manifest "${SINGZ_ANDROID_AUDIO_HOST_RT_TEST_DIR}/string-only.cmake")
write_callback_manifest("${_manifest}" "${_cpp}" "${_header}")
execute_process(COMMAND "${CMAKE_COMMAND}"
  "-DSINGZ_ANDROID_AUDIO_HOST_RT_MANIFEST=${_manifest}"
  -P "${SINGZ_ANDROID_AUDIO_HOST_RT_CHECKER}"
  RESULT_VARIABLE _result OUTPUT_VARIABLE _out ERROR_VARIABLE _err)
if(_result EQUAL 0 OR NOT "${_out}${_err}" MATCHES "missing required operation")
  message(FATAL_ERROR "Android RT checker accepted string-only operations:\n${_out}${_err}")
endif()

set(_dir "${SINGZ_ANDROID_AUDIO_HOST_RT_TEST_DIR}/literal-slashes/platform/android")
file(MAKE_DIRECTORY "${_dir}")
set(_cpp "${_dir}/audio_host_android_callback.cpp")
set(_header "${_dir}/audio_host_android_callback.h")
file(WRITE "${_cpp}"
  "const char* harmless = \"//\"; void callback(){ (void)malloc(1); input.read(); invokeAudioHostCallback(); AudioInputCallbackOwnerScope scope(gate); clock_gettime(0, 0); }\n")
file(WRITE "${_header}" "#pragma once\n")
set(_manifest "${SINGZ_ANDROID_AUDIO_HOST_RT_TEST_DIR}/literal-slashes.cmake")
write_callback_manifest("${_manifest}" "${_cpp}" "${_header}")
execute_process(COMMAND "${CMAKE_COMMAND}"
  "-DSINGZ_ANDROID_AUDIO_HOST_RT_MANIFEST=${_manifest}"
  -P "${SINGZ_ANDROID_AUDIO_HOST_RT_CHECKER}"
  RESULT_VARIABLE _result OUTPUT_VARIABLE _out ERROR_VARIABLE _err)
if(_result EQUAL 0 OR NOT "${_out}${_err}" MATCHES "Forbidden.*malloc")
  message(FATAL_ERROR "Android RT checker let string slashes hide malloc:\n${_out}${_err}")
endif()

set(_dir "${SINGZ_ANDROID_AUDIO_HOST_RT_TEST_DIR}/literal-required/platform/android")
file(MAKE_DIRECTORY "${_dir}")
set(_cpp "${_dir}/audio_host_android_callback.cpp")
set(_header "${_dir}/audio_host_android_callback.h")
file(WRITE "${_cpp}"
  "const char* harmless = \"//\"; void callback(){ input.read(); invokeAudioHostCallback(); AudioInputCallbackOwnerScope scope(gate); clock_gettime(0, 0); }\n")
file(WRITE "${_header}" "#pragma once\n")
set(_manifest "${SINGZ_ANDROID_AUDIO_HOST_RT_TEST_DIR}/literal-required.cmake")
write_callback_manifest("${_manifest}" "${_cpp}" "${_header}")
execute_process(COMMAND "${CMAKE_COMMAND}"
  "-DSINGZ_ANDROID_AUDIO_HOST_RT_MANIFEST=${_manifest}"
  -P "${SINGZ_ANDROID_AUDIO_HOST_RT_CHECKER}"
  RESULT_VARIABLE _result OUTPUT_VARIABLE _out ERROR_VARIABLE _err)
if(NOT _result EQUAL 0)
  message(FATAL_ERROR "Android RT checker lost required operations after string slashes:\n${_out}${_err}")
endif()

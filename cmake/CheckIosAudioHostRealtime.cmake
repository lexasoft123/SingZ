if(NOT DEFINED SINGZ_IOS_AUDIO_HOST_RT_MANIFEST OR
   NOT EXISTS "${SINGZ_IOS_AUDIO_HOST_RT_MANIFEST}")
  message(FATAL_ERROR "SINGZ_IOS_AUDIO_HOST_RT_MANIFEST is required")
endif()

include("${SINGZ_IOS_AUDIO_HOST_RT_MANIFEST}")
set(_rt_sources ${SINGZ_IOS_AUDIO_HOST_RT_FILES})
set(_pending_sources ${_rt_sources})
set(_scanned_sources)
set(_project_include_roots ${SINGZ_IOS_AUDIO_HOST_RT_PROJECT_INCLUDE_ROOTS})
if(NOT _project_include_roots)
  message(FATAL_ERROR
    "SINGZ_IOS_AUDIO_HOST_RT_PROJECT_INCLUDE_ROOTS is required")
endif()
foreach(_root IN LISTS _project_include_roots)
  if(NOT IS_ABSOLUTE "${_root}" OR NOT IS_DIRECTORY "${_root}")
    message(FATAL_ERROR
      "iOS AudioHost RT project include root is invalid: ${_root}")
  endif()
endforeach()
set(_permitted_system_includes
  "TargetConditionals.h"
  "AudioToolbox/AudioToolbox.h"
  "mach/mach_time.h"
  "array"
  "atomic"
  "cstddef"
  "cstdint")
set(_forbidden
  "mutex|recursive_mutex|timed_mutex|shared_mutex|condition_variable|lock_guard|unique_lock|scoped_lock|shared_ptr|weak_ptr|unique_ptr|make_unique|std::function|std::vector|std::string|std::map|std::unordered_map|std::set|std::unordered_set|std::deque|std::list|filesystem|fstream|iostream|printf|fprintf|puts|syslog|os_log|NSLog|AVAudioSession|NSString|NSNotification|dispatch_|sleep|usleep|nanosleep|throw|catch")
set(_forbidden_call
  "malloc|calloc|realloc|aligned_alloc|free|fopen|fread|fwrite")
string(ASCII 92 _backslash)
string(ASCII 10 _line_feed)
string(ASCII 13 _carriage_return)
set(_line_continuation "${_backslash}${_line_feed}")
set(_crlf_continuation
  "${_backslash}${_carriage_return}${_line_feed}")
set(_cr_continuation "${_backslash}${_carriage_return}")

while(_pending_sources)
  list(GET _pending_sources 0 _source)
  list(REMOVE_AT _pending_sources 0)
  list(FIND _scanned_sources "${_source}" _already_scanned)
  if(NOT _already_scanned EQUAL -1)
    continue()
  endif()
  if(NOT EXISTS "${_source}")
    message(FATAL_ERROR
      "iOS AudioHost RT source/include does not exist: ${_source}")
  endif()
  list(APPEND _scanned_sources "${_source}")
  file(READ "${_source}" _contents)
  if(_contents MATCHES "%:")
    message(FATAL_ERROR
      "C/C++ alternative preprocessing token %: is forbidden in iOS AudioHost RT closure: ${_source}")
  endif()
  string(FIND "${_contents}" "${_line_continuation}" _continued_lf)
  string(FIND "${_contents}" "${_crlf_continuation}" _continued_crlf)
  string(FIND "${_contents}" "${_cr_continuation}" _continued_cr)
  if(NOT _continued_lf EQUAL -1 OR NOT _continued_crlf EQUAL -1 OR
     NOT _continued_cr EQUAL -1)
    message(FATAL_ERROR
      "Continued source lines are forbidden in iOS AudioHost RT closure: ${_source}")
  endif()
  string(REGEX MATCHALL "#[^\r\n]*" _preprocessor_lines "${_contents}")
  foreach(_directive IN LISTS _preprocessor_lines)
    string(STRIP "${_directive}" _directive)
    if(_directive MATCHES "^#[ \t]*/\\*")
      message(FATAL_ERROR
        "Comments may not obscure iOS AudioHost RT preprocessing directives in ${_source}: ${_directive}")
    endif()
    if(_directive MATCHES "^#[ \t]*import([^A-Za-z0-9_]|$)")
      message(FATAL_ERROR
        "Preprocessor import directives are forbidden in iOS AudioHost RT closure ${_source}: ${_directive}")
    endif()
  endforeach()
  # Never let the preprocessor resolve an include shape the policy checker did
  # not itself resolve. This rejects macro-expanded includes, comment-spliced
  # directive names, __has_include probes and any other nonliteral form.
  string(REGEX MATCHALL
    "#[^\r\n]*include[^\r\n]*" _all_include_directives "${_contents}")
  foreach(_directive IN LISTS _all_include_directives)
    string(STRIP "${_directive}" _directive)
    if(NOT _directive MATCHES
       "^#[ \t]*include[ \t]*(\"[^\"]+\"|<[^>]+>)[ \t]*$")
      message(FATAL_ERROR
        "iOS AudioHost RT include directive is not an approved literal in ${_source}: ${_directive}")
    endif()
  endforeach()
  if(_contents MATCHES
     "(^|[^A-Za-z0-9_])(${_forbidden})([^A-Za-z0-9_]|$)")
    message(FATAL_ERROR
      "Forbidden iOS AudioHost callback facility in ${_source}: ${CMAKE_MATCH_2}")
  endif()
  if(_contents MATCHES
     "(^|[^A-Za-z0-9_])(${_forbidden_call})[ \t\r\n]*\\(")
    message(FATAL_ERROR
      "Forbidden iOS AudioHost callback call in ${_source}: ${CMAKE_MATCH_2}")
  endif()
  if(_contents MATCHES "(^|[^A-Za-z0-9_])(new|delete)[ \t\r\n(]" OR
     _contents MATCHES "(^|[^A-Za-z0-9_])(new|delete)\\[")
    message(FATAL_ERROR
      "Dynamic allocation token in iOS AudioHost callback source: ${_source}")
  endif()
  if(_contents MATCHES
     "for[ \t\r\n]*\\([ \t\r\n]*;[ \t\r\n]*;[ \t\r\n]*\\)")
    message(FATAL_ERROR
      "Unbounded loop in iOS AudioHost callback source: ${_source}")
  endif()

  # Every project include is part of this callback leaf: it can hide allocation
  # or a blocking helper just as easily as another listed translation unit.
  string(REGEX MATCHALL
    "#[ \t]*include[ \t]*\"[^\"]+\"" _quoted_includes "${_contents}")
  get_filename_component(_source_dir "${_source}" DIRECTORY)
  foreach(_include IN LISTS _quoted_includes)
    string(REGEX REPLACE ".*\"([^\"]+)\".*" "\\1" _relative "${_include}")
    get_filename_component(_included
      "${_source_dir}/${_relative}" ABSOLUTE)
    if(NOT EXISTS "${_included}")
      message(FATAL_ERROR
        "iOS AudioHost RT quoted include does not exist: ${_included}")
    endif()
    list(APPEND _pending_sources "${_included}")
  endforeach()

  string(REGEX MATCHALL
    "#[ \t]*include[ \t]*<[^>]+>" _angle_includes "${_contents}")
  foreach(_include IN LISTS _angle_includes)
    string(REGEX REPLACE ".*<([^>]+)>.*" "\\1" _relative "${_include}")
    if(IS_ABSOLUTE "${_relative}" OR
       _relative MATCHES "(^|/)\\.\\.(/|$)")
      message(FATAL_ERROR
        "iOS AudioHost RT angle include escapes approved roots: ${_relative}")
    endif()
    set(_project_include "")
    foreach(_root IN LISTS _project_include_roots)
      get_filename_component(_candidate "${_root}/${_relative}" ABSOLUTE)
      if(EXISTS "${_candidate}")
        set(_project_include "${_candidate}")
        break()
      endif()
    endforeach()
    if(_project_include)
      list(APPEND _pending_sources "${_project_include}")
    else()
      list(FIND _permitted_system_includes "${_relative}" _permitted_index)
      if(_permitted_index EQUAL -1)
        message(FATAL_ERROR
          "iOS AudioHost RT angle include is not an approved project or system header: ${_relative}")
      endif()
    endif()
  endforeach()
endwhile()

set(_required
  "/platform/ios/audio_host_ios_callback.cpp"
  "/platform/ios/audio_host_ios_callback.h")
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
      "iOS AudioHost callback target is missing required source membership: ${_suffix}")
  endif()
endforeach()

set(_implementation "")
foreach(_source IN LISTS _rt_sources)
  if(_source MATCHES "/platform/ios/audio_host_ios_callback\\.cpp$")
    file(READ "${_source}" _implementation)
    break()
  endif()
endforeach()
# Comments cannot satisfy executable-operation evidence.
string(REGEX REPLACE "//[^\r\n]*" "" _implementation "${_implementation}")
string(REGEX REPLACE "/\\*([^*]|\\*+[^*/])*\\*+/" "" _implementation
  "${_implementation}")
foreach(_required_call IN ITEMS
    "mach_absolute_time"
    "AudioUnitRender"
    "invokeAudioHostCallback")
  if(NOT _implementation MATCHES
     "(^|[^A-Za-z0-9_])${_required_call}[ \t\r\n]*\\(")
    message(FATAL_ERROR
      "iOS AudioHost callback is missing required operation: ${_required_call}")
  endif()
endforeach()
if(NOT _implementation MATCHES
   "(^|[^A-Za-z0-9_])AudioInputCallbackScope[ \t\r\n]+[A-Za-z_][A-Za-z0-9_]*[ \t\r\n]*\\(")
  message(FATAL_ERROR
    "iOS AudioHost callback is missing required operation: AudioInputCallbackScope")
endif()

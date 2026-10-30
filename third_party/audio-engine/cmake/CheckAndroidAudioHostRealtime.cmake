if(NOT DEFINED SINGZ_ANDROID_AUDIO_HOST_RT_MANIFEST OR
   NOT EXISTS "${SINGZ_ANDROID_AUDIO_HOST_RT_MANIFEST}")
  message(FATAL_ERROR "SINGZ_ANDROID_AUDIO_HOST_RT_MANIFEST is required")
endif()

include("${SINGZ_ANDROID_AUDIO_HOST_RT_MANIFEST}")
set(_roots ${SINGZ_ANDROID_AUDIO_HOST_RT_PROJECT_INCLUDE_ROOTS})
set(_pending ${SINGZ_ANDROID_AUDIO_HOST_RT_FILES})
set(_scanned)
set(_system_includes "oboe/Oboe.h" "array" "atomic" "cstddef" "cstdint" "time.h")
set(_forbidden
  "mutex|condition_variable|lock_guard|unique_lock|scoped_lock|shared_ptr|weak_ptr|unique_ptr|make_shared|make_unique|std::function|std::vector|std::string|std::map|std::unordered_map|std::set|std::deque|std::list|filesystem|fstream|iostream|printf|fprintf|puts|__android_log|JNIEnv|jobject|jclass|jmethodID|AttachCurrentThread|CallVoidMethod|sleep|usleep|nanosleep|getTimestamp|calculateLatencyMillis|requestStart|requestStop|stop|close|throw|catch")
set(_forbidden_call
  "malloc|calloc|realloc|aligned_alloc|free|fopen|fread|fwrite|dlsym|dlopen|dlclose|dlerror")
string(ASCII 92 _slash)
string(ASCII 10 _lf)
string(ASCII 13 _cr)

if(NOT _roots)
  message(FATAL_ERROR "Android AudioHost RT project include roots are required")
endif()
while(_pending)
  list(POP_FRONT _pending _source)
  list(FIND _scanned "${_source}" _seen)
  if(NOT _seen EQUAL -1)
    continue()
  endif()
  if(NOT EXISTS "${_source}")
    message(FATAL_ERROR "Android AudioHost RT source/include is missing: ${_source}")
  endif()
  list(APPEND _scanned "${_source}")
  # Establish the source alphabet before any textual parsing. C/C++ tools may
  # ignore NULs, treat other controls or Unicode as preprocessing whitespace,
  # or normalize them differently from CMake's regex engine. RT closure files
  # therefore admit only HT, LF, CR and printable 7-bit ASCII.
  file(READ "${_source}" _raw_hex HEX)
  set(_raw_disallowed "${_raw_hex}")
  string(REGEX REPLACE "(09|0a|0d|[2-6][0-9a-f]|7[0-9a-e])" ""
    _raw_disallowed "${_raw_disallowed}")
  if(NOT _raw_disallowed STREQUAL "")
    # The normal all-ASCII path is one regex pass. Only malformed input pays
    # for byte-by-byte location and the precise diagnostic.
    string(LENGTH "${_raw_hex}" _raw_hex_length)
    set(_raw_offset 0)
    while(_raw_offset LESS _raw_hex_length)
      string(SUBSTRING "${_raw_hex}" ${_raw_offset} 2 _raw_byte)
      if(NOT _raw_byte MATCHES "^(09|0a|0d|[2-6][0-9a-f]|7[0-9a-e])$")
        string(TOUPPER "${_raw_byte}" _raw_byte_upper)
        if(_raw_byte STREQUAL "0b")
          message(FATAL_ERROR
            "Vertical-tab control byte 0x${_raw_byte_upper} is forbidden in Android AudioHost RT closure: ${_source}")
        elseif(_raw_byte STREQUAL "0c")
          message(FATAL_ERROR
            "Form-feed control byte 0x${_raw_byte_upper} is forbidden in Android AudioHost RT closure: ${_source}")
        else()
          message(FATAL_ERROR
            "Raw byte 0x${_raw_byte_upper} is forbidden in Android AudioHost RT closure: ${_source}")
        endif()
      endif()
      math(EXPR _raw_offset "${_raw_offset} + 2")
    endwhile()
  endif()
  file(READ "${_source}" _text)
  if(_text MATCHES "%:")
    message(FATAL_ERROR "Alternative preprocessing token %: is forbidden in ${_source}")
  endif()
  string(FIND "${_text}" "${_slash}${_lf}" _continued_lf)
  string(FIND "${_text}" "${_slash}${_cr}${_lf}" _continued_crlf)
  string(FIND "${_text}" "${_slash}${_cr}" _continued_cr)
  if(NOT _continued_lf EQUAL -1 OR NOT _continued_crlf EQUAL -1 OR
     NOT _continued_cr EQUAL -1)
    message(FATAL_ERROR "Continued source lines are forbidden in ${_source}")
  endif()
  if(_text MATCHES "R\"")
    message(FATAL_ERROR
      "Raw string literals are forbidden in Android AudioHost RT closure: ${_source}")
  endif()
  # Detect comment-obscured preprocessing before deleting comments. Strip
  # ordinary literals first so comment markers inside strings cannot create a
  # false directive. A block comment before # is preprocessing whitespace;
  # likewise, a comment after # may splice the directive spelling. Both are
  # outside the scanner's admitted grammar and fail closed.
  set(_directive_probe "${_text}")
  string(REGEX REPLACE "\"([^\"\\\\]|\\\\.)*\"" "\"\""
    _directive_probe "${_directive_probe}")
  string(REGEX REPLACE "'([^'\\\\]|\\\\.)*'" "''"
    _directive_probe "${_directive_probe}")
  if(_directive_probe MATCHES
     "/\\*([^*]|\\*+[^*/])*\\*+/[ \t\r\n]*#")
    message(FATAL_ERROR
      "Comments may not precede Android AudioHost RT preprocessing directives in ${_source}")
  endif()
  if(_directive_probe MATCHES "#[^\r\n]*(/\\*|//)")
    message(FATAL_ERROR
      "Comments may not obscure Android AudioHost RT preprocessing directives in ${_source}")
  endif()
  # Clang accepts #import in C++ as a once-only include. The scanner does not
  # model that separate closure mechanism, so every spelling is rejected
  # fail-closed before ordinary include discovery. Comment-spliced directive
  # names are likewise forbidden rather than left to preprocessing.
  string(REGEX MATCHALL "#[^\r\n]*" _preprocessor_lines "${_text}")
  foreach(_directive IN LISTS _preprocessor_lines)
    string(STRIP "${_directive}" _directive)
    if(_directive MATCHES "^#[ \t]*/\\*")
      message(FATAL_ERROR
        "Comments may not obscure Android AudioHost RT preprocessing directives in ${_source}: ${_directive}")
    endif()
    if(_directive MATCHES "^#[ \t]*import([^A-Za-z0-9_]|$)")
      message(FATAL_ERROR
        "Preprocessor import directives are forbidden in Android AudioHost RT closure ${_source}: ${_directive}")
    endif()
  endforeach()
  string(REGEX MATCHALL "#[^\r\n]*include[^\r\n]*" _directives "${_text}")
  foreach(_directive IN LISTS _directives)
    string(STRIP "${_directive}" _directive)
    if(NOT _directive MATCHES
       "^#[ \t]*include[ \t]*(\"[^\"]+\"|<[^>]+>)[ \t]*$")
      message(FATAL_ERROR
        "Android AudioHost RT include directive is not an approved literal in ${_source}: ${_directive}")
    endif()
  endforeach()
  # Literal text must not satisfy required-operation checks or trip facility
  # checks. Literals must be stripped before comments: otherwise a harmless
  # string containing "//" can hide executable code later on the same line.
  # C++ raw literals were rejected before preprocessing admission because
  # their custom delimiters make a regex lexer unsound.
  set(_code "${_text}")
  string(REGEX REPLACE "\"([^\"\\\\]|\\\\.)*\"" "\"\"" _code "${_code}")
  string(REGEX REPLACE "'([^'\\\\]|\\\\.)*'" "''" _code "${_code}")
  string(REGEX REPLACE "//[^\r\n]*" "" _code "${_code}")
  string(REGEX REPLACE "/\\*([^*]|\\*+[^*/])*\\*+/" "" _code "${_code}")
  # The scanner deliberately does not expand macros. Token pasting can hide a
  # forbidden facility from every lexical token check (for example m##alloc),
  # so reject the operator itself after comments and literals are removed.
  if(_code MATCHES "##")
    message(FATAL_ERROR
      "Token-pasting operator ## is forbidden in Android AudioHost RT closure: ${_source}")
  endif()
  # Macro expansion is outside this lexical scanner's proof. Permit only the
  # two exact production visibility-wrapper definitions; neither can inject
  # executable code. Every other project #define fails closed. Match and
  # validate complete physical lines so a valid prefix cannot erase a suffix.
  string(REGEX MATCHALL "(^|[\r\n])[ \t]*#[ \t]*define[^\r\n]*"
    _project_defines "${_text}")
  foreach(_project_define IN LISTS _project_defines)
    string(STRIP "${_project_define}" _project_define)
    if(_project_define MATCHES
       "^#[ \t]*define[ \t]+SINGZ_ZCORE_CALLBACK_LOCAL[ \t]+__attribute__[ \t]*\\([ \t]*\\([ \t]*visibility[ \t]*\\([ \t]*\"hidden\"[ \t]*\\)[ \t]*\\)[ \t]*\\)[ \t]*$" OR
       _project_define MATCHES
       "^#[ \t]*define[ \t]+SINGZ_ZCORE_CALLBACK_LOCAL[ \t]*$")
      continue()
    endif()
    message(FATAL_ERROR
      "Project macro definitions are forbidden in Android AudioHost RT closure ${_source}: ${_project_define}")
  endforeach()
  # Allowed standard-library headers can export implementation macros which
  # paste tokens internally. Their invocations are just as opaque to this
  # lexical policy as a local ## expression. Ignore directive bodies (where
  # platform attributes are legitimately defined), then reject reserved
  # macro-like calls and conventional paste-helper families in executable
  # closure code.
  set(_macro_code "${_code}")
  string(REGEX REPLACE "(^|[\r\n])[ \t]*#[^\r\n]*" "\\1"
    _macro_code "${_macro_code}")
  if(_macro_code MATCHES
     "(^|[^A-Za-z0-9_])(__[A-Za-z0-9_]*|_[A-Z][A-Za-z0-9_]*)([^A-Za-z0-9_]|$)")
    message(FATAL_ERROR
      "Implementation-reserved identifier is forbidden in Android AudioHost RT closure ${_source}: ${CMAKE_MATCH_2}")
  endif()
  if(_macro_code MATCHES "(^|[^A-Za-z0-9_])asm([^A-Za-z0-9_]|$)")
    message(FATAL_ERROR
      "GNU asm token is forbidden in Android AudioHost RT closure: ${_source}")
  endif()
  # Check conventional composition-helper names across directive bodies too,
  # so a project macro cannot merely alias a system paste helper and invoke it
  # under an innocuous name. The production closure defines no such helper.
  if(_macro_code MATCHES
     "(^|[^A-Za-z0-9_])([A-Za-z0-9_]*(CONCAT|PASTE|GLUE|JOIN|XCAT|CAT)[A-Za-z0-9_]*)[ \t\r\n]*\\(")
    message(FATAL_ERROR
      "Token-composition macro-like invocation is forbidden in Android AudioHost RT closure ${_source}: ${CMAKE_MATCH_2}")
  endif()
  if(_code MATCHES "(^|[^A-Za-z0-9_])(${_forbidden})([^A-Za-z0-9_]|$)")
    message(FATAL_ERROR
      "Forbidden Android AudioHost callback facility in ${_source}: ${CMAKE_MATCH_2}")
  endif()
  # Reject forbidden function identifiers as whole tokens, not merely direct
  # call expressions. Taking an address or assigning an alias is enough to
  # move an allocation/file operation behind an otherwise harmless name.
  if(_code MATCHES
     "(^|[^A-Za-z0-9_])(${_forbidden_call})([^A-Za-z0-9_]|$)")
    message(FATAL_ERROR
      "Forbidden Android AudioHost callback identifier in ${_source}: ${CMAKE_MATCH_2}")
  endif()
  if(_code MATCHES "(^|[^A-Za-z0-9_])(new|delete)[ \t\r\n(]" OR
     _code MATCHES "(^|[^A-Za-z0-9_])(new|delete)\\[")
    message(FATAL_ERROR "Dynamic allocation token in Android AudioHost callback: ${_source}")
  endif()
  if(_code MATCHES "while[ \t\r\n]*\\([ \t\r\n]*true[ \t\r\n]*\\)" OR
     _code MATCHES "for[ \t\r\n]*\\([ \t\r\n]*;[ \t\r\n]*;[ \t\r\n]*\\)")
    message(FATAL_ERROR "Unbounded loop in Android AudioHost callback: ${_source}")
  endif()

  get_filename_component(_dir "${_source}" DIRECTORY)
  string(REGEX MATCHALL "#[ \t]*include[ \t]*\"[^\"]+\"" _quoted "${_text}")
  foreach(_include IN LISTS _quoted)
    string(REGEX REPLACE ".*\"([^\"]+)\".*" "\\1" _relative "${_include}")
    get_filename_component(_included "${_dir}/${_relative}" ABSOLUTE)
    list(APPEND _pending "${_included}")
  endforeach()
  string(REGEX MATCHALL "#[ \t]*include[ \t]*<[^>]+>" _angles "${_text}")
  foreach(_include IN LISTS _angles)
    string(REGEX REPLACE ".*<([^>]+)>.*" "\\1" _relative "${_include}")
    set(_project "")
    foreach(_root IN LISTS _roots)
      get_filename_component(_candidate "${_root}/${_relative}" ABSOLUTE)
      if(EXISTS "${_candidate}")
        set(_project "${_candidate}")
        break()
      endif()
    endforeach()
    if(_project)
      list(APPEND _pending "${_project}")
    else()
      list(FIND _system_includes "${_relative}" _allowed)
      if(_allowed EQUAL -1)
        message(FATAL_ERROR
          "Android AudioHost RT angle include is not approved: ${_relative}")
      endif()
    endif()
  endforeach()
endwhile()

foreach(_suffix IN ITEMS
    "/platform/android/audio_host_android_callback.cpp"
    "/platform/android/audio_host_android_callback_policy.cpp"
    "/platform/android/audio_host_android_callback.h")
  set(_found FALSE)
  foreach(_source IN LISTS SINGZ_ANDROID_AUDIO_HOST_RT_FILES)
    if(_source MATCHES "${_suffix}$")
      set(_found TRUE)
    endif()
  endforeach()
  if(NOT _found)
    message(FATAL_ERROR
      "Android AudioHost callback target is missing required source membership: ${_suffix}")
  endif()
endforeach()

set(_implementation "")
foreach(_source IN LISTS SINGZ_ANDROID_AUDIO_HOST_RT_FILES)
  if(_source MATCHES "/audio_host_android_callback\\.cpp$")
    file(READ "${_source}" _implementation)
  endif()
endforeach()
if(_implementation MATCHES "R\"")
  message(FATAL_ERROR "Raw string literals are forbidden in Android AudioHost implementation")
endif()
string(REGEX REPLACE "\"([^\"\\\\]|\\\\.)*\"" "\"\"" _implementation
  "${_implementation}")
string(REGEX REPLACE "'([^'\\\\]|\\\\.)*'" "''" _implementation
  "${_implementation}")
string(REGEX REPLACE "//[^\r\n]*" "" _implementation "${_implementation}")
string(REGEX REPLACE "/\\*([^*]|\\*+[^*/])*\\*+/" "" _implementation
  "${_implementation}")
foreach(_required IN ITEMS "read" "invokeAudioHostCallback"
    "AudioInputCallbackOwnerScope" "clock_gettime")
  if(NOT _implementation MATCHES
     "(^|[^A-Za-z0-9_])${_required}[ \t\r\n(<]")
    message(FATAL_ERROR
      "Android AudioHost callback is missing required operation: ${_required}")
  endif()
endforeach()

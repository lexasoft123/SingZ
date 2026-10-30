if(NOT DEFINED SINGZ_ZCORE_ROOT OR NOT IS_DIRECTORY "${SINGZ_ZCORE_ROOT}")
  message(FATAL_ERROR "SINGZ_ZCORE_ROOT must name the zcore source directory")
endif()

# This script executes on every build, so newly added source files are checked
# without relying on a configure-time glob or CONFIGURE_DEPENDS support.
file(GLOB_RECURSE _zcore_sources
  "${SINGZ_ZCORE_ROOT}/*.h"
  "${SINGZ_ZCORE_ROOT}/*.hpp"
  "${SINGZ_ZCORE_ROOT}/*.cpp"
  "${SINGZ_ZCORE_ROOT}/*.mm")
foreach(_file IN LISTS _zcore_sources)
  file(READ "${_file}" _contents)
  if(_contents MATCHES "#[ \t]*include[ \t]*[<\"]zdsp[/\"]")
    message(FATAL_ERROR "${_file} violates the zcore -> zdsp include ban")
  endif()
endforeach()

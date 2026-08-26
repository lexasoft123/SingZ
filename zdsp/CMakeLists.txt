add_library(zdsp_api INTERFACE)
add_library(SingZ::zdsp_api ALIAS zdsp_api)
target_compile_features(zdsp_api INTERFACE cxx_std_20)
target_include_directories(zdsp_api INTERFACE
  "${CMAKE_CURRENT_SOURCE_DIR}/include")
target_link_libraries(zdsp_api INTERFACE
  SingZ::zcore_base
  SingZ::zcore_audio)

# A concrete target now gives consumers a stable link contract. The graph
# runner arrives in Phase 1; this Phase 0A target contains no algorithms.
add_library(zdsp_runtime INTERFACE)
add_library(SingZ::zdsp_runtime ALIAS zdsp_runtime)
target_link_libraries(zdsp_runtime INTERFACE SingZ::zdsp_api)

# Dependency direction guard: inspect both direct/private and propagated link
# interfaces. Source includes are checked by an always-run build target below.
get_property(_zcore_targets DIRECTORY "${CMAKE_CURRENT_LIST_DIR}/../zcore"
  PROPERTY BUILDSYSTEM_TARGETS)
foreach(_target IN LISTS _zcore_targets)
  get_target_property(_direct_links "${_target}" LINK_LIBRARIES)
  get_target_property(_interface_links "${_target}" INTERFACE_LINK_LIBRARIES)
  set(_links "${_direct_links};${_interface_links}")
  if(_links MATCHES "(^|;)zdsp(_|;|$)|SingZ::zdsp")
    message(FATAL_ERROR "${_target} violates the zcore -> zdsp dependency ban")
  endif()
endforeach()

add_custom_target(singz_check_zcore_boundaries ALL
  COMMAND "${CMAKE_COMMAND}"
    "-DSINGZ_ZCORE_ROOT=${CMAKE_CURRENT_LIST_DIR}/../zcore"
    -P "${CMAKE_CURRENT_LIST_DIR}/../cmake/CheckZcoreBoundaries.cmake"
  VERBATIM
  COMMENT "Checking zcore dependency direction")

# ALL targets are not dependencies of named builds. Attach the guard to every
# concrete component so `--target zcore_audio`, product CLI builds, and native
# package builds cannot bypass a boundary check after a source edit/addition.
foreach(_target IN LISTS _zcore_targets)
  get_target_property(_type "${_target}" TYPE)
  if(NOT _type STREQUAL "INTERFACE_LIBRARY")
    add_dependencies("${_target}" singz_check_zcore_boundaries)
  endif()
endforeach()
get_property(_zdsp_targets DIRECTORY "${CMAKE_CURRENT_LIST_DIR}"
  PROPERTY BUILDSYSTEM_TARGETS)
foreach(_target IN LISTS _zdsp_targets)
  if(_target STREQUAL "singz_check_zcore_boundaries")
    continue()
  endif()
  get_target_property(_type "${_target}" TYPE)
  if(NOT _type STREQUAL "INTERFACE_LIBRARY")
    add_dependencies("${_target}" singz_check_zcore_boundaries)
  endif()
endforeach()

add_library(zdsp_api INTERFACE)
add_library(SingZ::zdsp_api ALIAS zdsp_api)
target_compile_features(zdsp_api INTERFACE cxx_std_20)
target_include_directories(zdsp_api INTERFACE
  "${CMAKE_CURRENT_SOURCE_DIR}/include")
target_link_libraries(zdsp_api INTERFACE SingZ::zcore_base)

# Phase 0B freezes the same-toolchain static interface. The production runtime
# currently contains contract validation only; the graph compiler/runner
# arrives in Phase 1.
add_library(zdsp_runtime STATIC
  src/api/contracts.cpp)
add_library(SingZ::zdsp_runtime ALIAS zdsp_runtime)
target_compile_features(zdsp_runtime PUBLIC cxx_std_20)
target_include_directories(zdsp_runtime PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/include")
target_link_libraries(zdsp_runtime PUBLIC SingZ::zdsp_api)
target_sources(zdsp_runtime PRIVATE
  include/zdsp/types.h
  include/zdsp/events.h
  include/zdsp/clock.h
  include/zdsp/audio_bus.h
  include/zdsp/process_context.h
  include/zdsp/processor.h
  include/zdsp/latency.h)
set_target_properties(zdsp_runtime PROPERTIES
  POSITION_INDEPENDENT_CODE YES
  CXX_VISIBILITY_PRESET hidden
  VISIBILITY_INLINES_HIDDEN YES)
singz_configure_realtime_target(zdsp_runtime)

# Deterministic test support. This target must never be linked into products.
add_library(zdsp_prototype STATIC EXCLUDE_FROM_ALL src/prototype/gain_meter.cpp)
add_library(SingZ::zdsp_prototype ALIAS zdsp_prototype)
target_compile_features(zdsp_prototype PUBLIC cxx_std_20)
target_include_directories(zdsp_prototype PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/include")
target_link_libraries(zdsp_prototype PUBLIC SingZ::zdsp_runtime)
target_sources(zdsp_prototype PRIVATE include/zdsp/prototype_gain_meter.h)
set_target_properties(zdsp_prototype PROPERTIES
  POSITION_INDEPENDENT_CODE YES
  CXX_VISIBILITY_PRESET hidden
  VISIBILITY_INLINES_HIDDEN YES)
singz_configure_realtime_target(zdsp_prototype)

# Generate the policy input from the actual callback-reachable targets.
# Headers are target sources above, so there is no second source manifest to
# drift and every newly added target source is scanned automatically.
set(_zdsp_rt_manifest "${CMAKE_CURRENT_BINARY_DIR}/zdsp-realtime-sources.cmake")
set(_zdsp_rt_files)
foreach(_target IN ITEMS zdsp_runtime zdsp_prototype)
  get_target_property(_target_source_dir "${_target}" SOURCE_DIR)
  get_target_property(_target_sources "${_target}" SOURCES)
  foreach(_source IN LISTS _target_sources)
    if(IS_ABSOLUTE "${_source}")
      set(_absolute_source "${_source}")
    else()
      get_filename_component(_absolute_source "${_source}" ABSOLUTE
        BASE_DIR "${_target_source_dir}")
    endif()
    file(TO_CMAKE_PATH "${_absolute_source}" _absolute_source)
    list(APPEND _zdsp_rt_files "${_absolute_source}")
  endforeach()
endforeach()
list(REMOVE_DUPLICATES _zdsp_rt_files)
file(WRITE "${_zdsp_rt_manifest}" "set(SINGZ_ZDSP_RT_FILES\n")
foreach(_source IN LISTS _zdsp_rt_files)
  file(APPEND "${_zdsp_rt_manifest}" "  [==[${_source}]==]\n")
endforeach()
file(APPEND "${_zdsp_rt_manifest}" ")\n")
set_property(GLOBAL PROPERTY SINGZ_ZDSP_RT_MANIFEST "${_zdsp_rt_manifest}")

add_custom_target(singz_check_zdsp_realtime ALL
  COMMAND "${CMAKE_COMMAND}"
    "-DSINGZ_ZDSP_RT_MANIFEST=${_zdsp_rt_manifest}"
    -P "${CMAKE_CURRENT_SOURCE_DIR}/../cmake/CheckZdspRealtime.cmake"
  VERBATIM
  COMMENT "Checking zdsp real-time source policy")
add_dependencies(zdsp_runtime singz_check_zdsp_realtime)
add_dependencies(zdsp_prototype singz_check_zdsp_realtime)

# Persistence is control-domain code and a separate target even though the
# fixture codec itself is allocation-free. Product JSON, FLAC, ORT and plug-in
# SDKs never enter the RT target's transitive closure.
add_library(zdsp_control STATIC EXCLUDE_FROM_ALL src/control/graph_fixture.cpp)
add_library(SingZ::zdsp_control ALIAS zdsp_control)
target_compile_features(zdsp_control PUBLIC cxx_std_20)
target_include_directories(zdsp_control PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/include")
target_link_libraries(zdsp_control PUBLIC SingZ::zdsp_api)
set_target_properties(zdsp_control PROPERTIES
  POSITION_INDEPENDENT_CODE YES
  CXX_VISIBILITY_PRESET hidden
  VISIBILITY_INLINES_HIDDEN YES)

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

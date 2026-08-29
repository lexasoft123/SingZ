add_library(zdsp_api INTERFACE)
add_library(SingZ::zdsp_api ALIAS zdsp_api)
target_compile_features(zdsp_api INTERFACE cxx_std_20)
target_include_directories(zdsp_api INTERFACE
  "${CMAKE_CURRENT_SOURCE_DIR}/include")
target_link_libraries(zdsp_api INTERFACE SingZ::zcore_base)

# Delivery/analysis-domain capture adapters. This is the explicit higher layer
# that may link both packages; zcore_audio retains no zdsp dependency. It is
# intentionally separate from the callback-reachable runtime target.
add_library(zdsp_analysis STATIC
  src/analysis/capture_adapter.cpp
  src/analysis/live_input_analyzer.cpp)
add_library(SingZ::zdsp_analysis ALIAS zdsp_analysis)
target_compile_features(zdsp_analysis PUBLIC cxx_std_20)
target_include_directories(zdsp_analysis PUBLIC
  "${CMAKE_CURRENT_SOURCE_DIR}/include")
target_link_libraries(zdsp_analysis PUBLIC
  SingZ::zdsp_api
  SingZ::zcore_audio
  SingZ::zcore_live_analysis_compat)
target_sources(zdsp_analysis PRIVATE
  include/zdsp/analysis/capture_adapter.h
  include/zdsp/analysis/live_input_analysis.h)
set_target_properties(zdsp_analysis PROPERTIES
  CXX_EXTENSIONS OFF
  POSITION_INDEPENDENT_CODE YES
  CXX_VISIBILITY_PRESET hidden
  VISIBILITY_INLINES_HIDDEN YES)

# The runtime is the allocation-free serial graph kernel. Compilation and
# preparation use the same fixed-capacity implementation off RT; render entry
# never acquires product, platform, codec, ML or plug-in dependencies.
add_library(zdsp_runtime STATIC
  src/api/contracts.cpp
  src/runtime/realtime_arena.cpp
  src/runtime/builtin_nodes.cpp
  src/runtime/decoded_buffer_source.cpp
  src/runtime/graph_compiler.cpp
  src/runtime/graph_runner.cpp)
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
  include/zdsp/latency.h
  include/zdsp/realtime_arena.h
  include/zdsp/queues.h
  include/zdsp/builtin_nodes.h
  include/zdsp/decoded_buffer_source.h
  include/zdsp/graph.h
  include/zdsp/graph_runner.h
  src/runtime/graph_internal.h)
set_target_properties(zdsp_runtime PROPERTIES
  CXX_EXTENSIONS OFF
  POSITION_INDEPENDENT_CODE YES
  CXX_VISIBILITY_PRESET hidden
  VISIBILITY_INLINES_HIDDEN YES)
singz_configure_realtime_target(zdsp_runtime)

# Standalone Phase 3A bridge. This is deliberately above both packages:
# AudioHost remains a graph-agnostic zcore contract, while this callback-safe
# adapter maps host metadata and planar buses into the zdsp runtime.
add_library(zdsp_host_adapter STATIC
  src/runtime/audio_host_graph_adapter.cpp)
add_library(SingZ::zdsp_host_adapter ALIAS zdsp_host_adapter)
target_compile_features(zdsp_host_adapter PUBLIC cxx_std_20)
target_include_directories(zdsp_host_adapter PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/include")
target_link_libraries(zdsp_host_adapter PUBLIC
  SingZ::zdsp_runtime
  SingZ::zcore_device)
target_sources(zdsp_host_adapter PRIVATE
  include/zdsp/audio_host_graph_adapter.h)
set_target_properties(zdsp_host_adapter PROPERTIES
  CXX_EXTENSIONS OFF
  POSITION_INDEPENDENT_CODE YES
  CXX_VISIBILITY_PRESET hidden
  VISIBILITY_INLINES_HIDDEN YES)
singz_configure_realtime_target(zdsp_host_adapter)

# Offline rendering shares the compiled graph and processor implementations,
# but WAV serialization is deliberately outside the callback-reachable leaf.
add_library(zdsp_offline STATIC EXCLUDE_FROM_ALL
  src/offline/offline_renderer.cpp)
add_library(SingZ::zdsp_offline ALIAS zdsp_offline)
target_compile_features(zdsp_offline PUBLIC cxx_std_20)
target_include_directories(zdsp_offline PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/include")
target_link_libraries(zdsp_offline PUBLIC SingZ::zdsp_runtime)
set_target_properties(zdsp_offline PROPERTIES
  CXX_EXTENSIONS OFF
  POSITION_INDEPENDENT_CODE YES
  CXX_VISIBILITY_PRESET hidden
  VISIBILITY_INLINES_HIDDEN YES)
singz_configure_realtime_target(zdsp_offline)

# Inert Apple packaging evidence. This produces isolated static component
# archives for device and simulator without linking an RN pod, starting an
# audio session or taking product playback ownership.
if(APPLE)
  add_custom_target(zdsp_apple_component_smoke
    COMMAND bash
      "${CMAKE_CURRENT_SOURCE_DIR}/build-apple-component-smoke.sh"
      "${CMAKE_CURRENT_SOURCE_DIR}/.."
      "${CMAKE_CURRENT_BINARY_DIR}/apple-component-smoke"
    VERBATIM
    COMMENT "Building isolated zdsp Apple device/simulator components")
endif()

# Deterministic test support. This target must never be linked into products.
add_library(zdsp_prototype STATIC EXCLUDE_FROM_ALL src/prototype/gain_meter.cpp)
add_library(SingZ::zdsp_prototype ALIAS zdsp_prototype)
target_compile_features(zdsp_prototype PUBLIC cxx_std_20)
target_include_directories(zdsp_prototype PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/include")
target_link_libraries(zdsp_prototype PUBLIC SingZ::zdsp_runtime)
target_sources(zdsp_prototype PRIVATE include/zdsp/prototype_gain_meter.h)
set_target_properties(zdsp_prototype PROPERTIES
  CXX_EXTENSIONS OFF
  POSITION_INDEPENDENT_CODE YES
  CXX_VISIBILITY_PRESET hidden
  VISIBILITY_INLINES_HIDDEN YES)
singz_configure_realtime_target(zdsp_prototype)

# Generate the policy input from the actual callback-reachable targets.
# Headers are target sources above, so there is no second source manifest to
# drift and every newly added target source is scanned automatically.
set(_zdsp_rt_manifest "${CMAKE_CURRENT_BINARY_DIR}/zdsp-realtime-sources.cmake")
set(_zdsp_rt_files)
foreach(_target IN ITEMS zdsp_runtime zdsp_host_adapter zdsp_prototype)
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
add_dependencies(zdsp_host_adapter singz_check_zdsp_realtime)
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
  CXX_EXTENSIONS OFF
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

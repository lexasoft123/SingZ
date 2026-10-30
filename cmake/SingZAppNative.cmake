# SingZ product-facing targets layered over zCore's reusable components.
# Detector/ML behavior and product encoding stay owned by this application.

function(singz_app_target target)
  target_compile_features(${target} PUBLIC cxx_std_20)
  target_include_directories(${target} PUBLIC
    "${SINGZ_REPO_ROOT}/zcore/include"
    "${ZCORE_ROOT}/zcore/include")
  set_target_properties(${target} PROPERTIES POSITION_INDEPENDENT_CODE YES)
endfunction()

# Deterministic host-only provider used by SingZ's app test suite.
add_library(zcore_device_fake STATIC EXCLUDE_FROM_ALL
  "${SINGZ_REPO_ROOT}/zcore/test_support/audio_host_fake.cpp")
add_library(SingZ::zcore_device_fake ALIAS zcore_device_fake)
singz_app_target(zcore_device_fake)
target_sources(zcore_device_fake PRIVATE
  "${ZCORE_ROOT}/zcore/include/zcore/device/audio_host_fake.h")
target_link_libraries(zcore_device_fake PUBLIC
  SingZ::zcore_device SingZ::native_build_options Threads::Threads)

add_library(zcore_legacy STATIC
  zcore/src/legacy/audio_input_analysis_adapter.cpp
  zcore/src/legacy/analysis.cpp
  zcore/src/legacy/beat_this.cpp
  zcore/src/legacy/beats.cpp
  zcore/src/legacy/courts.cpp
  zcore/src/legacy/melody.cpp)
add_library(SingZ::zcore_legacy ALIAS zcore_legacy)
singz_app_target(zcore_legacy)
target_link_libraries(zcore_legacy PUBLIC
  SingZ::zcore_live_analysis_compat
  SingZ::zcore_audio
  SingZ::zcore_device
  SingZ::zcore_media)
if(SINGZ_CORE_TESTS)
  target_compile_definitions(zcore_legacy PRIVATE SINGZ_CORE_TESTS=1)
endif()

if(SINGZ_BUILD_ML)
  if(NOT TARGET onnxruntime)
    message(FATAL_ERROR "SINGZ_BUILD_ML requires an onnxruntime target")
  endif()
  add_library(zcore_ml STATIC
    zcore/src/legacy/beat_this_ort.cpp
    zcore/src/legacy/ort_env.cpp
    zcore/src/legacy/split_engine.cpp)
  add_library(SingZ::zcore_ml ALIAS zcore_ml)
  singz_app_target(zcore_ml)
  target_link_libraries(zcore_ml PRIVATE
    SingZ::zcore_legacy SingZ::zcore_media onnxruntime)
  if(ANDROID)
    target_compile_options(zcore_ml PRIVATE -fexceptions -frtti)
    target_compile_definitions(zcore_ml PRIVATE _FILE_OFFSET_BITS=64)
  endif()
endif()

add_library(zcore_audio_export STATIC EXCLUDE_FROM_ALL
  "${ZCORE_ROOT}/zcore/src/media/audio_export.cpp")
add_library(SingZ::zcore_audio_export ALIAS zcore_audio_export)
singz_app_target(zcore_audio_export)
target_link_libraries(zcore_audio_export PUBLIC SingZ::zcore_media
  PRIVATE SingZ::native_flac SingZ::native_lame)

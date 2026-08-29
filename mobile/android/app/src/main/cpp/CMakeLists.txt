# The app's native build. Two libraries come out of here:
#
#  - libappmodules.so — React Native's own new-arch autolinking glue. Setting
#    externalNativeBuild REPLACES the RN gradle plugin's default CMake, and
#    without this include the library silently vanishes from the APK and the
#    app dies at boot with "PlatformConstants could not be found" (every
#    TurboModule registration lives there). The include recreates it; the RN
#    plugin passes REACT_ANDROID_DIR.
#
#  - libsingzcore.so — a JNI-only product binding over the top-level zcore
#    component targets shared by Android, iOS and desktop. ONNX Runtime comes
#    from the Maven AAR, which is legacy-layout
#    (headers/ + jni/<abi>/libonnxruntime.so, no prefab): app/build.gradle's
#    extractOrtSdk unzips it into build/ort-sdk and passes ORT_SDK_DIR here.
#    The APK's copy of libonnxruntime.so is packaged by the ordinary
#    implementation dependency — this import is for compiling/linking only.
cmake_minimum_required(VERSION 3.22)
project(appmodules)

include(${REACT_ANDROID_DIR}/cmake-utils/ReactNative-application.cmake)

set(SINGZ_NATIVE_ROOT ${CMAKE_CURRENT_SOURCE_DIR}/../../../../../..)
set(ORT_SDK_DIR "" CACHE PATH "Extracted onnxruntime-android AAR (headers/ + jni/<abi>/)")

if(NOT EXISTS ${ORT_SDK_DIR}/headers/onnxruntime_cxx_api.h)
    message(FATAL_ERROR "ORT_SDK_DIR (${ORT_SDK_DIR}) has no ORT headers — the extractOrtSdk gradle task should have run first")
endif()

# Oboe comes in as a prefab package (com.google.oboe:oboe in app/build.gradle).
# The Android capture backend builds on it rather than on raw AAudio, for its
# QuirksManager device database and its format/channel conversion.
find_package(oboe REQUIRED CONFIG)

add_library(onnxruntime SHARED IMPORTED)
set_target_properties(onnxruntime PROPERTIES
    IMPORTED_LOCATION ${ORT_SDK_DIR}/jni/${ANDROID_ABI}/libonnxruntime.so
    INTERFACE_INCLUDE_DIRECTORIES ${ORT_SDK_DIR}/headers)

# Configure the one authoritative native target graph. Only zcore_ml receives
# exceptions/RTTI for ORT; device/audio callback targets retain the stricter
# default profile.
set(SINGZ_BUILD_HOST_TOOLS OFF CACHE BOOL "" FORCE)
set(SINGZ_CORE_TESTS OFF CACHE BOOL "" FORCE)
set(SINGZ_BUILD_ML ON CACHE BOOL "" FORCE)
add_subdirectory(${SINGZ_NATIVE_ROOT} ${CMAKE_CURRENT_BINARY_DIR}/singz-native)

# This file is deliberately outside src/main/cpp because React Native globs
# that directory into appmodules. The shipped library name remains unchanged.
add_library(singzcore SHARED
    ${SINGZ_NATIVE_ROOT}/mobile/native/bindings/android/singz_core_jni.cpp
    ${SINGZ_NATIVE_ROOT}/mobile/native/bindings/android/zdsp_compile_smoke.cpp)
add_dependencies(singzcore singz_check_zcore_boundaries)
target_compile_features(singzcore PRIVATE cxx_std_20)
set_target_properties(singzcore PROPERTIES
    CXX_VISIBILITY_PRESET hidden
    VISIBILITY_INLINES_HIDDEN YES)
# 32-bit ABIs (armeabi-v7a, x86) have 32-bit long — a >2 GB mix would
# overflow plain fseek/ftell; the engine uses fseeko/ftello throughout.
target_compile_definitions(singzcore PRIVATE _FILE_OFFSET_BITS=64)
target_link_libraries(singzcore PRIVATE
    SingZ::zdsp_runtime
    SingZ::zdsp_analysis
    SingZ::zcore_ml
    SingZ::zcore_device
    SingZ::zcore_media
    onnxruntime
    android
    dl
    log)

# JNIEXPORT functions remain default-visible. Internal same-toolchain zdsp and
# zcore callback symbols must never become an accidental shared-library ABI.
add_custom_command(TARGET singzcore POST_BUILD
    COMMAND ${CMAKE_COMMAND}
        "-DSINGZ_SHARED_BINARY=$<TARGET_FILE:singzcore>"
        "-DSINGZ_NM=${CMAKE_NM}"
        -P "${SINGZ_NATIVE_ROOT}/cmake/CheckZdspSharedExports.cmake"
    VERBATIM
    COMMENT "Checking libsingzcore internal export surface")

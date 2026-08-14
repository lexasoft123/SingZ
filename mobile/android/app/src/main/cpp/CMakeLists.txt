# The app's native build. Two libraries come out of here:
#
#  - libappmodules.so — React Native's own new-arch autolinking glue. Setting
#    externalNativeBuild REPLACES the RN gradle plugin's default CMake, and
#    without this include the library silently vanishes from the APK and the
#    app dies at boot with "PlatformConstants could not be found" (every
#    TurboModule registration lives there). The include recreates it; the RN
#    plugin passes REACT_ANDROID_DIR.
#
#  - libsingzcore.so — the shared C++ engine core (mobile/native/core, one
#    source tree for Android and iOS; docs/PHONE-STANDALONE.md) plus its JNI
#    shim. ONNX Runtime comes from the Maven AAR, which is legacy-layout
#    (headers/ + jni/<abi>/libonnxruntime.so, no prefab): app/build.gradle's
#    extractOrtSdk unzips it into build/ort-sdk and passes ORT_SDK_DIR here.
#    The APK's copy of libonnxruntime.so is packaged by the ordinary
#    implementation dependency — this import is for compiling/linking only.
cmake_minimum_required(VERSION 3.22)
project(appmodules)

include(${REACT_ANDROID_DIR}/cmake-utils/ReactNative-application.cmake)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(CORE_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../../../../../native/core)
set(ORT_SDK_DIR "" CACHE PATH "Extracted onnxruntime-android AAR (headers/ + jni/<abi>/)")

if(NOT EXISTS ${ORT_SDK_DIR}/headers/onnxruntime_cxx_api.h)
    message(FATAL_ERROR "ORT_SDK_DIR (${ORT_SDK_DIR}) has no ORT headers — the extractOrtSdk gradle task should have run first")
endif()

add_library(onnxruntime SHARED IMPORTED)
set_target_properties(onnxruntime PROPERTIES
    IMPORTED_LOCATION ${ORT_SDK_DIR}/jni/${ANDROID_ABI}/libonnxruntime.so)

# The JNI shim lives under native/core/android — NOT in this directory,
# whose *.cpp files ReactNative-application.cmake globs into appmodules.
add_library(singzcore SHARED
    ${CORE_DIR}/android/singz_core_jni.cpp
    ${CORE_DIR}/ort_env.cpp
    ${CORE_DIR}/resample.cpp
    ${CORE_DIR}/split_engine.cpp
    ${CORE_DIR}/wav.cpp)

# ORT's C++ API reports errors as exceptions; the NDK toolchain does not turn
# them on by itself.
target_compile_options(singzcore PRIVATE -fexceptions -frtti)
# 32-bit ABIs (armeabi-v7a, x86) have 32-bit long — a >2 GB mix would
# overflow plain fseek/ftell; the engine uses fseeko/ftello throughout.
target_compile_definitions(singzcore PRIVATE _FILE_OFFSET_BITS=64)
target_include_directories(singzcore PRIVATE ${CORE_DIR} ${ORT_SDK_DIR}/headers)
target_link_libraries(singzcore onnxruntime log)

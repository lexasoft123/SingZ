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

get_filename_component(SINGZ_NATIVE_ROOT
    "${CMAKE_CURRENT_SOURCE_DIR}/../../../../../.." REALPATH)

# mobile/scripts/android-cmake-init.cmake installs the combined compile/link
# process ceiling before every Android project(), including every native RN
# dependency. Keep a defensive eight-edge fallback for direct standalone
# configuration, where the all-project policy was not injected.
if(NOT CMAKE_JOB_POOL_COMPILE OR NOT CMAKE_JOB_POOL_LINK)
    set_property(GLOBAL PROPERTY JOB_POOLS singz_android_native_pool=8)
    set(CMAKE_JOB_POOL_COMPILE singz_android_native_pool)
    set(CMAKE_JOB_POOL_LINK singz_android_native_pool)
endif()

include(${REACT_ANDROID_DIR}/cmake-utils/ReactNative-application.cmake)

# The debug variant is the one every phone measurement is taken on (release
# APKs have no inspector and no run-as), and AGP's Debug configuration hands
# the compiler -g and no -O at all, so the core it measured was clang's -O0:
# a Stretch prime that costs 5 ms optimized cost hundreds there, and every
# CPU column of the native-vs-legacy comparison was the unoptimized engine
# against Hermes. The app's own native code is therefore optimized in every
# variant; asserts stay in (no NDEBUG), so a debug number is still a shade
# pessimistic against a release APK, never flattering. Pass
# -PsingzNativeUnoptimized=1 to gradle to get -O0 back for stepping through
# the core in a debugger. libappmodules above is React Native's and is left
# exactly as its own CMake builds it.
if(CMAKE_BUILD_TYPE STREQUAL "Debug" AND NOT SINGZ_NATIVE_UNOPTIMIZED)
    add_compile_options(-O2)
endif()

set(ORT_SDK_DIR "" CACHE PATH "Extracted onnxruntime-android AAR (headers/ + jni/<abi>/)")

if(NOT EXISTS ${ORT_SDK_DIR}/headers/onnxruntime_cxx_api.h)
    message(FATAL_ERROR "ORT_SDK_DIR (${ORT_SDK_DIR}) has no ORT headers — the extractOrtSdk gradle task should have run first")
endif()

# Oboe comes in as a prefab package (com.google.oboe:oboe in app/build.gradle).
# The Android capture backend builds on it rather than on raw AAudio, for its
# QuirksManager device database and its format/channel conversion.
find_package(oboe REQUIRED CONFIG)

# Reuse RNAudioAPI's one final dynamic-runtime ownership. The Gradle preBuild
# selector atomically promotes verified SingZ product-pack bytes into these
# paths when available; its verifier binds every selected byte to the product
# manifest. zcore talks to libav* directly through descriptor-only custom
# AVIO and never calls RNAudioAPI's decoder facade.
set(SINGZ_AUDIO_API_NATIVE_DIR
    ${SINGZ_NATIVE_ROOT}/mobile/node_modules/react-native-audio-api)
set(SINGZ_AUDIO_API_FFMPEG_INCLUDE
    ${SINGZ_AUDIO_API_NATIVE_DIR}/common/cpp/audioapi/external/include_ffmpeg)
set(SINGZ_AUDIO_API_FFMPEG_LIB_DIR
    ${SINGZ_AUDIO_API_NATIVE_DIR}/android/src/main/jniLibs/${ANDROID_ABI})
# Only a product selection the Gradle preBuild selector actually made turns
# the extended codecs on. A release-proven receipt means every shipping ABI
# carries target fixture evidence; the proof harness stages a
# configuration-only pack under its own flag. Every other build compiles the
# base WAV/FLAC decoder and reports that capability, so RNAudioAPI's
# compatibility libav* is never claimed as the full matrix.
set(SINGZ_AUDIO_API_FFMPEG_SELECTION
    ${SINGZ_AUDIO_API_NATIVE_DIR}/common/cpp/audioapi/external/singz-ffmpeg-selection.json)
set(SINGZ_FFMPEG_SELECTED OFF)
if(EXISTS ${SINGZ_AUDIO_API_FFMPEG_SELECTION})
    file(READ ${SINGZ_AUDIO_API_FFMPEG_SELECTION} SINGZ_FFMPEG_SELECTION_JSON)
    string(JSON SINGZ_FFMPEG_SELECTION_MODE
        ERROR_VARIABLE SINGZ_FFMPEG_SELECTION_ERROR
        GET "${SINGZ_FFMPEG_SELECTION_JSON}" mode)
    if(SINGZ_FFMPEG_SELECTION_ERROR)
        message(FATAL_ERROR
            "Malformed FFmpeg product selection receipt: ${SINGZ_FFMPEG_SELECTION_ERROR}")
    endif()
    string(FIND "${SINGZ_FFMPEG_SELECTION_JSON}"
        "\"target\": \"android-${ANDROID_ABI}\"" SINGZ_FFMPEG_ABI_SELECTED)
    if(SINGZ_FFMPEG_ABI_SELECTED EQUAL -1)
        message(FATAL_ERROR
            "FFmpeg product selection receipt does not cover ${ANDROID_ABI}; rerun the selector for this ABI set")
    endif()
    if(SINGZ_FFMPEG_SELECTION_MODE STREQUAL "release-proven")
        set(SINGZ_FFMPEG_SELECTED ON)
    elseif(SINGZ_FFMPEG_SELECTION_MODE STREQUAL "target-proof-staging")
        if(NOT SINGZ_CODEC_TARGET_PROOF)
            message(FATAL_ERROR
                "Codec target-proof staging is selected outside the proof build; rerun the selector")
        endif()
        set(SINGZ_FFMPEG_SELECTED ON)
    else()
        message(FATAL_ERROR
            "Unknown FFmpeg product selection mode: ${SINGZ_FFMPEG_SELECTION_MODE}")
    endif()
endif()
if(SINGZ_CODEC_TARGET_PROOF AND NOT SINGZ_FFMPEG_SELECTED)
    message(FATAL_ERROR "The codec target proof requires a staged product selection")
endif()
set(SINGZ_ENABLE_FFMPEG_CODECS ${SINGZ_FFMPEG_SELECTED} CACHE BOOL "" FORCE)
set(SINGZ_FFMPEG_INCLUDE_DIR ${SINGZ_AUDIO_API_FFMPEG_INCLUDE}
    CACHE PATH "" FORCE)
foreach(component IN ITEMS AVCODEC AVFORMAT AVUTIL SWRESAMPLE)
    string(TOLOWER ${component} lower_component)
    set(SINGZ_FFMPEG_${component}_LIBRARY
        ${SINGZ_AUDIO_API_FFMPEG_LIB_DIR}/lib${lower_component}.so
        CACHE FILEPATH "" FORCE)
endforeach()

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
    ${SINGZ_NATIVE_ROOT}/mobile/native/bindings/android/native_playback_jni.cpp
    ${SINGZ_NATIVE_ROOT}/mobile/native/bindings/android/zdsp_compile_smoke.cpp)
option(SINGZ_CODEC_TARGET_PROOF
    "Compile the debug/instrumentation-only packaged codec fixture proof" OFF)
if(SINGZ_CODEC_TARGET_PROOF)
    file(SHA256
        ${SINGZ_NATIVE_ROOT}/tests/fixtures/codecs/target/target_codec_proof.cpp
        SINGZ_CODEC_PROOF_CPP_SHA256)
    file(SHA256
        ${SINGZ_NATIVE_ROOT}/tests/fixtures/codecs/target/target_codec_proof.h
        SINGZ_CODEC_PROOF_HEADER_SHA256)
    file(SHA256
        ${SINGZ_NATIVE_ROOT}/tests/fixtures/codecs/generate.sh
        SINGZ_CODEC_PROOF_GENERATOR_SHA256)
    file(SHA256
        ${SINGZ_NATIVE_ROOT}/tests/fixtures/codecs/target-contract.json
        SINGZ_CODEC_PROOF_CONTRACT_SHA256)
    string(SHA256 SINGZ_CODEC_PROOF_SOURCE_STAMP
        "${SINGZ_CODEC_PROOF_CPP_SHA256}:${SINGZ_CODEC_PROOF_HEADER_SHA256}:${SINGZ_CODEC_PROOF_GENERATOR_SHA256}:${SINGZ_CODEC_PROOF_CONTRACT_SHA256}")
    file(SHA256
        ${SINGZ_NATIVE_ROOT}/mobile/native/bindings/android/codec_target_proof_jni.cpp
        SINGZ_CODEC_PROOF_ANDROID_JNI_SHA256)
    file(SHA256
        ${SINGZ_NATIVE_ROOT}/mobile/android/app/src/androidTest/java/com/singzplayer/CodecTargetProofInstrumentedTest.kt
        SINGZ_CODEC_PROOF_ANDROID_INSTRUMENTATION_SHA256)
    file(SHA256
        ${SINGZ_NATIVE_ROOT}/mobile/scripts/pull-codec-target-proof-android.mjs
        SINGZ_CODEC_PROOF_ANDROID_PULL_DRIVER_SHA256)
    string(SHA256 SINGZ_CODEC_PROOF_PLATFORM_STAMP
        "instrumentation:${SINGZ_CODEC_PROOF_ANDROID_INSTRUMENTATION_SHA256}:jni:${SINGZ_CODEC_PROOF_ANDROID_JNI_SHA256}:pullDriver:${SINGZ_CODEC_PROOF_ANDROID_PULL_DRIVER_SHA256}")
    string(SHA256 SINGZ_CODEC_PROOF_BUILD_STAMP
        "${SINGZ_CODEC_PROOF_SOURCE_STAMP}:${SINGZ_CODEC_PROOF_PLATFORM_STAMP}")
    target_sources(singzcore PRIVATE
        ${SINGZ_NATIVE_ROOT}/mobile/native/bindings/android/codec_target_proof_jni.cpp
        ${SINGZ_NATIVE_ROOT}/tests/fixtures/codecs/target/target_codec_proof.cpp)
    target_compile_definitions(singzcore PRIVATE
        SINGZ_CODEC_TARGET_PROOF=1
        SINGZ_CODEC_TARGET_PROOF_SOURCE_STAMP="${SINGZ_CODEC_PROOF_SOURCE_STAMP}"
        SINGZ_CODEC_TARGET_PROOF_PLATFORM_STAMP="${SINGZ_CODEC_PROOF_PLATFORM_STAMP}"
        SINGZ_CODEC_TARGET_PROOF_BUILD_STAMP="${SINGZ_CODEC_PROOF_BUILD_STAMP}")
endif()
add_dependencies(singzcore singz_check_zcore_boundaries)
target_compile_features(singzcore PRIVATE cxx_std_20)
target_include_directories(singzcore PRIVATE "${SINGZ_NATIVE_ROOT}")
set_target_properties(singzcore PROPERTIES
    CXX_VISIBILITY_PRESET hidden
    VISIBILITY_INLINES_HIDDEN YES)
# 32-bit ABIs (armeabi-v7a, x86) have 32-bit long — a >2 GB mix would
# overflow plain fseek/ftell; the engine uses fseeko/ftello throughout.
target_compile_definitions(singzcore PRIVATE _FILE_OFFSET_BITS=64)
target_link_libraries(singzcore PRIVATE
    SingZ::native_playback_session
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
if(SINGZ_ENABLE_FFMPEG_CODECS)
    add_custom_command(TARGET singzcore POST_BUILD
        COMMAND ${CMAKE_COMMAND}
            "-DSINGZ_SHARED_BINARY=$<TARGET_FILE:singzcore>"
            "-DSINGZ_READELF=${CMAKE_READELF}"
            -P "${SINGZ_NATIVE_ROOT}/cmake/CheckFfmpegDynamic.cmake"
        VERBATIM
        COMMENT "Checking libsingzcore dynamic LGPL FFmpeg imports")
endif()

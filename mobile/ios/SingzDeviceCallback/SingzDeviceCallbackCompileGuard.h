#pragma once

#if !defined(SINGZ_REALTIME_LEAF) || SINGZ_REALTIME_LEAF != 1
#error "SingzDeviceCallback requires SINGZ_REALTIME_LEAF=1"
#endif

#if !defined(SINGZ_IOS_AUDIO_HOST_RT_COMPILE) || \
    SINGZ_IOS_AUDIO_HOST_RT_COMPILE != 1
#error "SingzDeviceCallback requires its iOS callback compile boundary"
#endif

#ifdef __cplusplus
#if __cplusplus < 202002L
#error "SingzDeviceCallback requires C++20"
#endif

#if __has_feature(cxx_exceptions)
#error "SingzDeviceCallback must compile with exceptions disabled"
#endif

#if __has_feature(cxx_rtti)
#error "SingzDeviceCallback must compile with RTTI disabled"
#endif
#endif

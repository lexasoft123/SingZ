Pod::Spec.new do |s|
  s.name         = 'SingzDeviceCallback'
  s.version      = '0.1.0'
  s.summary      = 'SingZ strict iOS device callback execution closure'
  s.homepage     = 'https://github.com/lexasoft123/SingZ'
  s.license      = { :type => 'MIT' }
  s.author       = 'SingZ'
  s.platforms    = { :ios => '15.1' }
  s.source       = { :path => '.' }

  # zcore/ is an exact generated COPY of the authoritative CMake
  # zcore_device_callback membership, the iOS RemoteIO callback pair and two
  # explicit transitive headers. The sync-time exact CMake comparison is what
  # makes this recursive glob closed rather than a second drifting manifest.
  s.source_files = 'SingzDeviceCallbackCompileGuard.h',
                   'zcore/**/*.{h,cpp}'
  s.header_mappings_dir = '.'

  # The prefix guard is included in every translation unit and makes these
  # settings compile assertions, not comments. Archive gates additionally
  # reject exception/RTTI runtime symbols and non-hidden C++ definitions.
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++20',
    'GCC_PREPROCESSOR_DEFINITIONS' => '$(inherited) SINGZ_REALTIME_LEAF=1 SINGZ_IOS_AUDIO_HOST_RT_COMPILE=1',
    'OTHER_CPLUSPLUSFLAGS' => '$(inherited) -include "$(PODS_TARGET_SRCROOT)/SingzDeviceCallbackCompileGuard.h" -fno-exceptions -fno-rtti -fvisibility=hidden -fvisibility-inlines-hidden',
    'HEADER_SEARCH_PATHS' => '"$(PODS_TARGET_SRCROOT)/zcore/include" "$(PODS_TARGET_SRCROOT)/zcore/src/audio" "$(PODS_TARGET_SRCROOT)/zcore/src/device" "$(PODS_TARGET_SRCROOT)/zcore/platform/ios"'
  }
  s.frameworks = 'AudioToolbox'
end

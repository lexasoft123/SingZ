Pod::Spec.new do |s|
  s.name         = 'SingzPlaybackSession'
  s.version      = '0.1.0'
  s.summary      = 'SingZ dormant native WAV/FLAC playback composition'
  s.homepage     = 'https://github.com/lexasoft123/SingZ'
  s.license      = { :type => 'MIT' }
  s.author       = 'SingZ'
  s.platforms    = { :ios => '15.1' }
  s.source       = { :path => '.' }

  # Exact generated copy of CMake's singz_native_playback_session target plus
  # its one callback declaration. The callback definition remains owned by
  # SingzDspRuntime, so the final app has one definition of every symbol.
  s.source_files = 'native/playback/*.{h,cpp}'
  s.public_header_files = 'native/playback/native_playback_session.h'
  s.header_mappings_dir = 'native/playback'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++20',
    'HEADER_SEARCH_PATHS' => '"$(PODS_TARGET_SRCROOT)/native/playback" "$(PODS_ROOT)/../SingzCore/core/include" "$(PODS_ROOT)/../SingzDspRuntime/zdsp/include" "$(PODS_ROOT)/../SingzDspRuntime/zcore/include"'
  }
  s.dependency 'SingzCore'
  s.dependency 'SingzDspRuntime'
end

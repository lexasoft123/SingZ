Pod::Spec.new do |s|
  s.name         = 'SingzDspRuntime'
  s.version      = '0.1.0'
  s.summary      = 'SingZ callback-safe native DSP graph runtime'
  s.homepage     = 'https://github.com/lexasoft123/SingZ'
  s.license      = { :type => 'MIT' }
  s.author       = 'SingZ'
  s.platforms    = { :ios => '15.1' }
  s.source       = { :path => '.' }

  # zdsp/ is an exact generated COPY of the authoritative top-level package,
  # materialized by mobile/scripts/sync-singz-dsp-runtime.js. Keep this list
  # equal to CMake's zdsp_runtime + zdsp_host_adapter sources. The legacy
  # SingzCore compatibility pod no longer compiles these runtime sources, so
  # every symbol retains exactly one product owner.
  # The generated trees contain only source-manifest entries, so recursive
  # consumption cannot discover a new source behind the checker's back.
  s.source_files = 'SingzDspRuntimeCapability.{h,cpp}',
                   'zdsp/**/*.{h,cpp}',
                   'zcore/**/*.h'
  s.public_header_files = 'SingzDspRuntimeCapability.h'
  s.header_mappings_dir = '.'

  # This target is the CocoaPods equivalent of CMake's strict callback-safe
  # leaves. Settings are private to this pod; SingzCore, React Native, codecs,
  # ORT and the app do not inherit them.
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++20',
    'GCC_PREPROCESSOR_DEFINITIONS' => '$(inherited) SINGZ_REALTIME_LEAF=1',
    'OTHER_CPLUSPLUSFLAGS' => '$(inherited) -fno-exceptions -fno-rtti -fvisibility=hidden -fvisibility-inlines-hidden',
    'HEADER_SEARCH_PATHS' => '"$(PODS_TARGET_SRCROOT)/zdsp/include" "$(PODS_TARGET_SRCROOT)/zcore/include"'
  }
end

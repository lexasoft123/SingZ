Pod::Spec.new do |s|
  s.name         = 'SingzCore'
  s.version      = '0.1.0'
  s.summary      = 'SingZ shared C++ engine core: on-device stem split + beat inference'
  s.homepage     = 'https://github.com/lexasoft123/SingZ'
  s.license      = { :type => 'MIT' }
  s.author       = 'SingZ'
  s.platforms    = { :ios => '15.1' }
  s.source       = { :path => '.' }
  # One source tree with Android (mobile/native/core); the glob is evaluated
  # at pod install, so re-run it after files land there (podspec version bump
  # re-globs — the FolderAccess/audio-api patch-3 lesson).
  s.source_files = '*.{h,mm}', '../../native/core/*.{h,cpp}'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17',
    'HEADER_SEARCH_PATHS' => '"$(PODS_TARGET_SRCROOT)/../../native/core"'
  }
  s.dependency 'React-Core'
  # Same 1.23.x minor the desktop packs and the Android AAR pin (trunk's
  # closest pod to their 1.23.2 is 1.23.0 — a patch-level skew the Phase-2
  # stem-correlation fixture guards; a plain '~> 1.23' would silently
  # resolve 1.28).
  s.dependency 'onnxruntime-c', '~> 1.23.0'
end

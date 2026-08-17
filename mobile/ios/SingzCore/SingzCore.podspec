Pod::Spec.new do |s|
  s.name         = 'SingzCore'
  s.version      = '0.2.6'
  s.summary      = 'SingZ shared C++ engine core: on-device stem split + beat inference'
  s.homepage     = 'https://github.com/lexasoft123/SingZ'
  s.license      = { :type => 'MIT' }
  s.author       = 'SingZ'
  s.platforms    = { :ios => '15.1' }
  s.source       = { :path => '.' }
  # One source tree with Android: core/ is a COPY of mobile/native/core
  # materialized by mobile/scripts/sync-singzcore.js (postinstall; gitignored).
  # CocoaPods silently drops source_files globs that reach above the podspec
  # dir AND skips directory symlinks (both measured: libSingzCore.a shipped
  # without ort_env.o and the app link died on singz::ortProbeJson) — copying
  # is the only shape that works, the audio-api patch-3 lesson. After editing
  # native/core: rerun the sync, bump this version, pod install (re-glob).
  s.source_files = '*.{h,mm}', 'core/*.{h,cpp}'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17',
    # onnxruntime-c ships its headers flat under Pods/onnxruntime-c/Headers
    # (not inside the xcframework), and dependents don't inherit a search
    # path for them.
    'HEADER_SEARCH_PATHS' => '"$(PODS_TARGET_SRCROOT)/core" "$(PODS_ROOT)/onnxruntime-c/Headers"'
  }
  s.frameworks   = 'AVFoundation', 'BackgroundTasks', 'UIKit'
  s.dependency 'React-Core'
  # Same 1.23.x minor the desktop packs and the Android AAR pin (trunk's
  # closest pod to their 1.23.2 is 1.23.0 — a patch-level skew the Phase-2
  # stem-correlation fixture guards; a plain '~> 1.23' would silently
  # resolve 1.28).
  s.dependency 'onnxruntime-c', '~> 1.23.0'
end

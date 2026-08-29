Pod::Spec.new do |s|
  s.name         = 'SingzCore'
  s.version      = '0.3.11'
  s.summary      = 'SingZ shared C++ core: audio input, stem split, and beat inference'
  s.homepage     = 'https://github.com/lexasoft123/SingZ'
  s.license      = { :type => 'MIT' }
  s.author       = 'SingZ'
  s.platforms    = { :ios => '15.1' }
  s.source       = { :path => '.' }
  # One source tree with Android: core/ is a generated COPY of top-level zcore
  # materialized by mobile/scripts/sync-singzcore.js (postinstall; gitignored).
  # CocoaPods silently drops source_files globs that reach above the podspec
  # dir AND skips directory symlinks (both measured: libSingzCore.a shipped
  # without ort_env.o and the app link died on singz::ortProbeJson) — copying
  # is the only shape that works, the audio-api patch-3 lesson. After editing
  # zcore: rerun the sync, bump this version, pod install (re-glob).
  # flac/ is the vendored libFLAC (third_party/native/flac), synced by the
  # same script. Only flac/src/*.c COMPILES — the deduplication/ fragments
  # are #included by lpc.c/bitreader.c and must stay out of source_files or
  # they compile standalone and fail; they ride in preserve_paths with the
  # headers instead. This broad pod remains a Phase 0A packaging compatibility
  # exception: it still combines device, media, analysis and ORT under one
  # target. Before native graph rendering, component pods or a CMake-built
  # XCFramework must isolate callback-safe targets and their compile flags.
  s.source_files = '*.{h,mm}', 'core/include/**/*.{h,hpp}',
                   'core/src/**/*.{cpp,mm}',
                   'core/platform/ios/**/*.{cpp,mm}',
                   'dsp/include/zdsp/{types,events,clock,audio_bus,process_context,processor,latency}.h',
                   'dsp/include/zdsp/analysis/live_input_analysis.h',
                   'dsp/include/zdsp/analysis/capture_adapter.h',
                   'dsp/include/zdsp/decoded_buffer_source.h',
                   'dsp/src/api/contracts.cpp',
                   'dsp/src/analysis/live_input_analyzer.cpp',
                   'dsp/src/analysis/capture_adapter.cpp',
                   'dsp/src/runtime/decoded_buffer_source.cpp',
                   'flac/src/*.c'
  s.preserve_paths = 'flac/**/*'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++20',
    # HAVE_CONFIG_H is load-bearing for the flac sources: without it their
    # config.h is silently not read, HAVE_FSEEKO goes undefined, and the
    # build fails inside an SDK header complaining about fseek (the vendor
    # README documents the trap). Harmless for the .mm/.cpp sources, which
    # never test it.
    'GCC_PREPROCESSOR_DEFINITIONS' => '$(inherited) HAVE_CONFIG_H=1',
    # onnxruntime-c ships its headers flat under Pods/onnxruntime-c/Headers
    # (not inside the xcframework), and dependents don't inherit a search
    # path for them. The flac paths serve <FLAC/…>, <config.h> and the
    # private/ tree, in that order.
    'HEADER_SEARCH_PATHS' => '"$(PODS_TARGET_SRCROOT)/core/include" "$(PODS_TARGET_SRCROOT)/dsp/include" "$(PODS_ROOT)/onnxruntime-c/Headers" "$(PODS_TARGET_SRCROOT)/flac/include" "$(PODS_TARGET_SRCROOT)/flac" "$(PODS_TARGET_SRCROOT)/flac/src/include" "$(PODS_TARGET_SRCROOT)/flac/src"'
  }
  s.frameworks   = 'AudioToolbox', 'AVFoundation', 'BackgroundTasks', 'UIKit'
  s.dependency 'React-Core'
  # Same 1.23.x minor the desktop packs and the Android AAR pin (trunk's
  # closest pod to their 1.23.2 is 1.23.0 — a patch-level skew the Phase-2
  # stem-correlation fixture guards; a plain '~> 1.23' would silently
  # resolve 1.28).
  s.dependency 'onnxruntime-c', '~> 1.23.0'
end

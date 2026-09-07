require 'json'

Pod::Spec.new do |s|
  s.name         = 'SingzCore'
  s.version      = '0.3.16'
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
  # target. The callback-safe graph runtime has moved to SingzDspRuntime and
  # the portable/iOS render callback definitions to SingzDeviceCallback. Do
  # not widen this compatibility source list back over either strict closure.
  s.source_files = '*.{h,mm}', 'core/include/**/*.{h,hpp}',
                   'core/src/**/*.{cpp,mm}',
                   'core/platform/ios/**/*.{cpp,mm}',
                   'dsp/include/zdsp/{types,events,clock,audio_bus,process_context,processor,latency}.h',
                   'dsp/include/zdsp/analysis/live_input_analysis.h',
                   'dsp/include/zdsp/analysis/capture_adapter.h',
                   'dsp/src/analysis/live_input_analyzer.cpp',
                   'dsp/src/analysis/capture_adapter.cpp',
                   'flac/src/*.c'
  s.preserve_paths = 'flac/**/*'
  s.resource_bundles = {
    'SingzCoreFfmpegNotices' => 'compliance/*'
  }
  # zcore's extended codecs compile only behind a product selection the
  # Podfile's selector actually made: a release-proven receipt, or the proof
  # harness's staged one under its own flag. Every other install compiles the
  # base WAV/FLAC decoder and reports that capability, so RNAudioAPI's own
  # compatibility libav* is never claimed as the full matrix.
  codec_target_proof = ENV['SINGZ_CODEC_TARGET_PROOF'] == '1'
  ffmpeg_definitions = ''
  selection_receipt = File.join(__dir__, 'compliance', 'singz-ffmpeg-selection.json')
  if File.exist?(selection_receipt)
    selection = JSON.parse(File.read(selection_receipt))
    case selection['mode']
    when 'release-proven'
      ffmpeg_definitions = ' SINGZ_ZCORE_FFMPEG=1'
    when 'target-proof-staging'
      unless codec_target_proof
        raise 'Codec target-proof staging is selected outside the proof harness; rerun pod install'
      end
      ffmpeg_definitions = ' SINGZ_ZCORE_FFMPEG=1'
    else
      raise "Unknown FFmpeg product selection mode: #{selection['mode'].inspect}"
    end
    if selection['mode'] == 'target-proof-staging'
      # The proof harness must package the real staged runtime to execute it,
      # but that configuration-only runtime is never release eligible. This
      # build phase persists in Pods after the proof-mode pod install, so a
      # later Release build cannot reuse that sandbox by accident.
      s.script_phase = {
        :name => 'Reject codec target-proof staging in Release',
        :execution_position => :before_compile,
        :script => <<-SCRIPT
case "$CONFIGURATION" in
  *Release*)
    echo "error: Codec target-proof staging cannot be packaged in a Release IPA." >&2
    exit 1
    ;;
esac
SCRIPT
      }
    end
  elsif codec_target_proof
    raise 'The codec target proof requires a staged product selection receipt'
  end
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++20',
    # HAVE_CONFIG_H is load-bearing for the flac sources: without it their
    # config.h is silently not read, HAVE_FSEEKO goes undefined, and the
    # build fails inside an SDK header complaining about fseek (the vendor
    # README documents the trap). Harmless for the .mm/.cpp sources, which
    # never test it.
    'GCC_PREPROCESSOR_DEFINITIONS' => "$(inherited) HAVE_CONFIG_H=1#{ffmpeg_definitions}",
    # onnxruntime-c ships its headers flat under Pods/onnxruntime-c/Headers
    # (not inside the xcframework), and dependents don't inherit a search
    # path for them. The flac paths serve <FLAC/…>, <config.h> and the
    # private/ tree, in that order.
    'HEADER_SEARCH_PATHS' => '"$(PODS_TARGET_SRCROOT)/core/include" "$(PODS_TARGET_SRCROOT)/dsp/include" "$(PODS_ROOT)/onnxruntime-c/Headers" "$(PODS_TARGET_SRCROOT)/flac/include" "$(PODS_TARGET_SRCROOT)/flac" "$(PODS_TARGET_SRCROOT)/flac/src/include" "$(PODS_TARGET_SRCROOT)/flac/src" "$(PODS_ROOT)/../../node_modules/react-native-audio-api/common/cpp/audioapi/external/include_ffmpeg"'
  }
  s.frameworks   = 'AudioToolbox', 'AVFoundation', 'BackgroundTasks', 'UIKit'
  s.dependency 'React-Core'
  s.dependency 'SingzDeviceCallback'
  # Same 1.23.x minor the desktop packs and the Android AAR pin (trunk's
  # closest pod to their 1.23.2 is 1.23.0 — a patch-level skew the Phase-2
  # stem-correlation fixture guards; a plain '~> 1.23' would silently
  # resolve 1.28).
  s.dependency 'onnxruntime-c', '~> 1.23.0'
end

codec_target_proof = ENV['SINGZ_CODEC_TARGET_PROOF'] == '1'
if codec_target_proof
  require 'json'
  proof_materialization = JSON.parse(
    File.read(File.join(__dir__, 'CodecTargetProof', 'materialization.json'))
  )
  proof_source_stamp = proof_materialization.fetch('sourceStamp')
  proof_platform_stamp = proof_materialization.fetch('platformSourceStamp')
  proof_build_stamp = proof_materialization.fetch('buildStamp')
  unless [proof_source_stamp, proof_platform_stamp, proof_build_stamp].all? do |stamp|
    stamp.match?(/\A[0-9a-f]{64}\z/)
  end
    raise 'Malformed codec target proof source stamp; rerun prepare-codec-target-proof.mjs'
  end
end

Pod::Spec.new do |s|
  s.name         = 'FolderAccess'
  s.version      = '1.0.5'
  s.summary      = 'SingZ project-folder access: document picker, bookmarks, iCloud downloads'
  s.homepage     = 'https://github.com/lexasoft123/SingZ'
  s.license      = { :type => 'MIT' }
  s.author       = 'SingZ'
  s.platforms    = { :ios => '15.1' }
  s.source       = { :path => '.' }
  # Keep Swift production members explicit. CocoaPods snapshots this list in
  # Pods.xcodeproj, so adding a helper without updating/installing the pod can
  # pass its standalone test while the actual iPhone target cannot see it.
  production_sources = ['AudioRouteInfo.swift',
                   'CacheCurrency.swift',
                   'DurablePreferenceWrite.swift',
                   'FolderAccess.swift',
                   '*.{m,mm}']
  proof_sources = codec_target_proof \
    ? ['CodecTargetProof/target_codec_proof.cpp'] \
    : []
  s.source_files = production_sources + proof_sources
  s.exclude_files = 'Tests/**/*'
  if codec_target_proof
    s.resource_bundles = {
      'SingzCodecTargetFixtures' => 'CodecTargetProof/fixtures/*'
    }
  end
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    # FolderAccess owns the React Native bridge but reusable behavior remains
    # in SingzCore. CocoaPods flattens dependency public headers, so retain the
    # authoritative nested include roots for their internal includes.
    # SingzPlaybackSession's public session header includes the graph
    # document, which includes <zdsp/graph.h> from the strict runtime pod;
    # CocoaPods flattens only the pod's own public headers, so the bridge
    # needs the runtime's include roots exactly as that pod declares them.
    'HEADER_SEARCH_PATHS' => '"$(PODS_ROOT)/../SingzCore/core/include" "$(PODS_ROOT)/../SingzCore/dsp/include" "$(PODS_ROOT)/../SingzDspRuntime/zdsp/include" "$(PODS_ROOT)/../SingzDspRuntime/zcore/include" "$(PODS_ROOT)/../../node_modules/react-native-audio-api/common/cpp/audioapi/external/include_ffmpeg"',
    'GCC_PREPROCESSOR_DEFINITIONS' => codec_target_proof \
      ? "$(inherited) SINGZ_CODEC_TARGET_PROOF=1 SINGZ_ZCORE_FFMPEG=1 SINGZ_CODEC_TARGET_PROOF_SOURCE_STAMP=\\\"#{proof_source_stamp}\\\" SINGZ_CODEC_TARGET_PROOF_PLATFORM_STAMP=\\\"#{proof_platform_stamp}\\\" SINGZ_CODEC_TARGET_PROOF_BUILD_STAMP=\\\"#{proof_build_stamp}\\\"" \
      : '$(inherited)'
  }
  s.dependency 'React-Core'
  s.dependency 'SingzCore'
  s.dependency 'SingzDspRuntime'
  s.dependency 'SingzPlaybackSession'
end

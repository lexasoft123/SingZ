Pod::Spec.new do |s|
 s.name='SingzTorrent'
 s.version='1.0.0'
 s.summary='SingZ C++ torrent downloads and authenticated RuTracker browser'
 s.homepage='https://github.com/lexasoft123/SingZ'
 s.license={:type=>'MIT'}
 s.author='SingZ'
 s.source={:path=>'.'}
 s.platforms={:ios=>'15.1'}
 s.source_files='TorrentModule.mm','rutracker_scripts.h'
 s.vendored_frameworks='SingzTorrentCore.xcframework'
 s.resource_bundles={'SingzTorrentNotices'=>'notices/*'}
 s.frameworks='WebKit','UIKit','Security','SystemConfiguration'
 s.libraries='c++','z'
 s.pod_target_xcconfig={'CLANG_CXX_LANGUAGE_STANDARD'=>'c++17',
  'HEADER_SEARCH_PATHS'=>'$(inherited) "$(PODS_XCFRAMEWORKS_BUILD_DIR)/SingzTorrent/Headers"'}
 s.dependency 'React-Core'
end

Pod::Spec.new do |s|
  s.name         = 'FolderAccess'
  s.version      = '1.0.3'
  s.summary      = 'SingZ project-folder access: document picker, bookmarks, iCloud downloads'
  s.homepage     = 'https://github.com/lexasoft123/SingZ'
  s.license      = { :type => 'MIT' }
  s.author       = 'SingZ'
  s.platforms    = { :ios => '15.1' }
  s.source       = { :path => '.' }
  s.source_files = '*.{swift,m,mm}'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    # FolderAccess owns the React Native bridge but reusable behavior remains
    # in SingzCore. CocoaPods flattens dependency public headers, so retain the
    # authoritative nested include roots for their internal includes.
    'HEADER_SEARCH_PATHS' => '"$(PODS_ROOT)/../SingzCore/core/include" "$(PODS_ROOT)/../SingzCore/dsp/include"'
  }
  s.dependency 'React-Core'
  s.dependency 'SingzCore'
end

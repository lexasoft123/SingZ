Pod::Spec.new do |s|
  s.name         = 'FolderAccess'
  s.version      = '1.0.2'
  s.summary      = 'SingZ project-folder access: document picker, bookmarks, iCloud downloads'
  s.homepage     = 'https://github.com/lexasoft123/SingZ'
  s.license      = { :type => 'MIT' }
  s.author       = 'SingZ'
  s.platforms    = { :ios => '15.1' }
  s.source       = { :path => '.' }
  s.source_files = '*.{swift,m,mm}'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.dependency 'React-Core'
  s.dependency 'SingzCore'
end

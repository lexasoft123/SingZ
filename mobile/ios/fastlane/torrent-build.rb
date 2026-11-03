require 'open3'
module SingzTorrentBuild
  def self.configuration(type)
    { 'appstore' => 'Release', 'adhoc' => 'AdHoc' }.fetch(type)
  end

  def self.verify!(repo, ipa, type)
    enabled = type == 'adhoc' ? '1' : '0'
    output, error, status = Open3.capture3('node',
      File.join(repo, 'mobile/scripts/verify-torrent-build.cjs'), ipa, enabled)
    raise "iOS optional-feature proof failed: #{output}#{error}" unless status.success?
    puts output
  end
end

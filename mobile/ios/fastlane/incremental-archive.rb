require 'digest'
require 'json'
require 'open3'
require 'fileutils'

module SingzIncrementalArchive
  def self.cache_root
    ENV['SINGZ_IOS_NATIVE_CACHE'] || File.join(Dir.home, 'Library/Caches/SingZ/ios-native-archives')
  end

  def self.cached_archive(inputs)
    File.join(cache_root, inputs, 'SingZ.xcarchive')
  end

  def self.publish(archive, inputs)
    target = cached_archive(inputs)
    return if valid?(target, inputs)
    FileUtils.mkdir_p(File.dirname(target))
    stage = target + ".#{Process.pid}.tmp"
    FileUtils.rm_rf(stage)
    FileUtils.cp_r(archive, stage)
    save(stage, inputs)
    begin
      File.rename(stage, target)
    rescue Errno::EEXIST, Errno::ENOTEMPTY
      unless valid?(target, inputs)
        rejected = target + ".invalid-#{Process.pid}"
        File.rename(target, rejected)
        begin
          File.rename(stage, target)
        ensure
          FileUtils.rm_rf(rejected)
        end
      end
    ensure
      FileUtils.rm_rf(stage)
    end
  end

  def self.fingerprint(repo)
    output, error, status = Open3.capture3('node', File.join(repo, 'mobile/scripts/ios-native-inputs.cjs'))
    raise error unless status.success? && output.strip.match?(/\A[0-9a-f]{64}\z/)
    output.strip
  end

  def self.app(archive)
    File.join(archive, 'Products/Applications/SingZPlayer.app')
  end

  def self.receipt(archive)
    File.join(archive, '.singz-native-inputs.json')
  end

  def self.valid?(archive, fingerprint)
    data = JSON.parse(File.read(receipt(archive)))
    binary = File.join(app(archive), 'SingZPlayer')
    data.is_a?(Hash) && data['format'] == 1 && data['inputs'] == fingerprint &&
      data['binary'] == Digest::SHA256.file(binary).hexdigest &&
      File.file?(File.join(app(archive), 'Info.plist')) &&
      File.file?(File.join(archive, 'Info.plist')) &&
      Open3.capture3('/usr/bin/codesign', '--verify', '--deep', '--strict', app(archive)).last.success?
  rescue SystemCallError, JSON::ParserError
    false
  end

  def self.save(archive, fingerprint)
    File.write(receipt(archive), JSON.generate({ format: 1, inputs: fingerprint,
      binary: Digest::SHA256.file(File.join(app(archive), 'SingZPlayer')).hexdigest }))
  end

  def self.refresh(repo, archive, number, identity)
    raise ArgumentError, 'invalid build number' unless number.to_s.match?(/\A[1-9]\d*\z/)
    FileUtils.mkdir_p(File.join(repo, 'build-ios'))
    ios = File.join(repo, 'mobile/ios')
    application = app(archive)
    # Metro owns this directory; regenerate it so removed JS assets do not linger.
    FileUtils.rm_rf(File.join(application, 'assets'))
    env = {
      'CONFIGURATION' => 'Release', 'PLATFORM_NAME' => 'iphoneos',
      'PROJECT_DIR' => ios, 'PROJECT_ROOT' => File.join(repo, 'mobile'),
      'PODS_ROOT' => File.join(ios, 'Pods'),
      'CONFIGURATION_BUILD_DIR' => File.dirname(application),
      'UNLOCALIZED_RESOURCES_FOLDER_PATH' => File.basename(application),
      'NODE_BINARY' => ENV.fetch('NODE_BINARY', 'node'), 'USE_HERMES' => 'true',
      'SKIP_BUNDLING' => nil, 'SOURCEMAP_FILE' => nil,
      'CLI_PATH' => File.join(repo, 'mobile/scripts/bundle-ios-incremental.cjs')
    }
    output, error, status = Open3.capture3(env, '/bin/bash',
      File.join(repo, 'mobile/node_modules/react-native/scripts/xcode/with-environment.sh'),
      File.join(repo, 'mobile/node_modules/react-native/scripts/react-native-xcode.sh'))
    File.write(File.join(repo, 'build-ios/ios-js-bundle.log'), output + error)
    raise "JS bundling failed: #{error.lines.last(8).join}" unless status.success?
    FileUtils.rm_f(File.join(File.dirname(application), 'main.jsbundle'))
    [
      [File.join(application, 'Info.plist'), 'CFBundleVersion'],
      [File.join(archive, 'Info.plist'), 'ApplicationProperties:CFBundleVersion']
    ].each do |file, key|
      _out, err, result = Open3.capture3('/usr/libexec/PlistBuddy', '-c', "Set :#{key} #{number}", file)
      raise err unless result.success?
    end
    # Updating resources invalidates the cached signature. Export signs again
    # with the current match profile; give it a valid archive to start from.
    _out, err, result = Open3.capture3('/usr/bin/codesign', '--force', '--sign',
      identity, '--preserve-metadata=identifier,entitlements,flags,runtime', application)
    raise err unless result.success?
  end
end

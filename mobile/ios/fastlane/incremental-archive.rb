require 'digest'
require 'json'
require 'open3'
require 'fileutils'
require 'find'
require 'securerandom'

module SingzIncrementalArchive
  def self.cache_root
    ENV['SINGZ_IOS_NATIVE_CACHE'] || File.join(Dir.home, 'Library/Caches/SingZ/ios-native-archives')
  end

  def self.check_inputs!(inputs)
    raise ArgumentError, 'invalid native archive fingerprint' unless inputs.to_s.match?(/\A[0-9a-f]{64}\z/)
  end

  def self.cached_archive(inputs)
    check_inputs!(inputs)
    File.join(cache_root, inputs, 'SingZ.xcarchive')
  end

  def self.open_lock(path, &block)
    # Never follow a planted metadata symlink outside the cache.
    flags = File::RDWR | File::CREAT
    flags |= File::NOFOLLOW if defined?(File::NOFOLLOW)
    File.open(path, flags, 0600, &block)
  end

  def self.with_cache_lock
    FileUtils.mkdir_p(cache_root)
    open_lock(File.join(cache_root, '.cache.lock')) do |file|
      file.flock(File::LOCK_EX)
      yield
    end
  end

  def self.entry_directory(inputs)
    check_inputs!(inputs)
    directory = File.join(cache_root, inputs)
    raise ArgumentError, 'native archive entry must not be a symlink' if File.symlink?(directory)
    directory
  end

  def self.touch_entry(directory)
    flags = File::WRONLY | File::CREAT | File::TRUNC
    flags |= File::NOFOLLOW if defined?(File::NOFOLLOW)
    File.open(File.join(directory, '.last-used'), flags, 0600) {}
  end

  # Shared reader leases survive separate worktrees/processes. The global lock
  # closes the race between opening a lease and a pruner deleting its directory.
  def self.with_cached_archive(inputs)
    lease = nil
    directory = nil
    with_cache_lock do
      directory = entry_directory(inputs)
      if File.directory?(directory)
        lease = open_lock(File.join(directory, '.lease'))
        lease.flock(File::LOCK_SH)
      end
    end
    return false unless lease
    begin
      archive = cached_archive(inputs)
      return false if File.symlink?(archive)
      return false unless valid?(archive, inputs)
      touch_entry(directory)
      yield archive
      true
    ensure
      lease.close
    end
  rescue Errno::ENOENT, Errno::ELOOP
    false
  end

  def self.resolved_path(path)
    existing = File.expand_path(path)
    suffix = []
    until File.exist?(existing) || File.symlink?(existing)
      suffix.unshift(File.basename(existing))
      existing = File.dirname(existing)
    end
    File.join(File.realpath(existing), *suffix)
  end

  def self.copy_cached(inputs, destination)
    destination = resolved_path(destination)
    root = resolved_path(cache_root)
    raise ArgumentError, 'archive destination must be outside the shared cache' if destination == root || destination.start_with?(root + File::SEPARATOR)
    with_cached_archive(inputs) do |archive|
      FileUtils.rm_rf(destination)
      FileUtils.mkdir_p(File.dirname(destination))
      FileUtils.cp_r(archive, destination)
    end
  end

  def self.publish(archive, inputs)
    target = cached_archive(inputs)
    published = false
    with_cache_lock do
      directory = entry_directory(inputs)
      FileUtils.mkdir_p(directory)
      open_lock(File.join(directory, '.lease')) do |lease|
        lease.flock(File::LOCK_EX)
        unless valid?(target, inputs)
          stage = target + ".#{Process.pid}-#{SecureRandom.hex(6)}.tmp"
          begin
            FileUtils.cp_r(archive, stage)
            save(stage, inputs)
            if File.exist?(target) || File.symlink?(target)
              # The entry and its lease remain stable while replacing only the
              # invalid archive. Readers cannot observe this writer's stage.
              FileUtils.rm_rf(target)
            end
            File.rename(stage, target)
            touch_entry(directory)
            published = true
          ensure
            FileUtils.rm_rf(stage)
          end
        end
      end
    end
    prune(preserve: [inputs]) if published
  end

  def self.positive_setting(name, fallback)
    value = ENV.fetch(name, fallback.to_s)
    raise ArgumentError, "#{name} must be a positive integer" unless value.match?(/\A[1-9]\d*\z/)
    value.to_i
  end

  def self.prune(preserve: [], now: Time.now)
    max_entries = positive_setting('SINGZ_IOS_NATIVE_CACHE_MAX_ENTRIES', 8)
    max_bytes = positive_setting('SINGZ_IOS_NATIVE_CACHE_MAX_BYTES', 4 * 1024**3)
    max_age = positive_setting('SINGZ_IOS_NATIVE_CACHE_MAX_AGE_DAYS', 30) * 86400
    pinned = ENV.fetch('SINGZ_IOS_NATIVE_CACHE_PINNED', '').split(',').reject(&:empty?)
    protected_keys = (preserve + pinned).map { |key| check_inputs!(key); key }
    removed = []
    with_cache_lock do
      entries = Dir.children(cache_root).filter_map do |key|
        next unless key.match?(/\A[0-9a-f]{64}\z/)
        directory = File.join(cache_root, key)
        next if File.symlink?(directory) || !File.directory?(directory)
        archive = File.join(directory, 'SingZ.xcarchive')
        next if File.symlink?(archive) || !File.directory?(archive)
        metadata = JSON.parse(File.read(receipt(archive))) rescue nil
        next unless metadata.is_a?(Hash) && metadata['format'] == 1 && metadata['inputs'] == key
        size = 0
        Find.find(directory) do |path|
          stat = File.lstat(path)
          size += stat.size if stat.file?
        end
        accessed = File.join(directory, '.last-used')
        # Metadata is optional for archives produced before pruning existed.
        used_at = File.mtime(!File.symlink?(accessed) && File.file?(accessed) ? accessed : receipt(archive))
        { key: key, directory: directory, bytes: size, used_at: used_at }
      end.sort_by { |entry| entry[:used_at] }
      count = entries.length
      bytes = entries.sum { |entry| entry[:bytes] }
      entries.each do |entry|
        next if protected_keys.include?(entry[:key])
        next unless now - entry[:used_at] > max_age || count > max_entries || bytes > max_bytes
        begin
          open_lock(File.join(entry[:directory], '.lease')) do |lease|
            next unless lease.flock(File::LOCK_EX | File::LOCK_NB)
            FileUtils.rm_rf(entry[:directory])
            removed << entry[:key]
            count -= 1
            bytes -= entry[:bytes]
          end
        rescue Errno::ELOOP, Errno::ENOENT
          # An unknown/symlink lease is not ours to follow or delete.
          next
        end
      end
    end
    removed
  end

  # React Native installs Debug prebuilt frameworks initially. Its ordinary
  # Xcode phases select Release during archive; perform those exact installed
  # phases first so the fingerprint describes the bytes archive will consume.
  def self.release_dependency_phases(repo, project: nil)
    unless project
      require 'xcodeproj'
      project_path = File.join(repo, 'mobile/ios/Pods/Pods.xcodeproj')
      raise "Pods project is missing; run pod install before archiving: #{project_path}" unless File.file?(File.join(project_path, 'project.pbxproj'))
      project = Xcodeproj::Project.open(project_path)
    end
    selectors = {
      'React-Core-prebuilt' => 'replace-rncore-version.js',
      'ReactNativeDependencies' => 'replace_dependencies_version.js',
      'hermes-engine' => 'replace_hermes_version.js'
    }
    project.targets.flat_map do |target|
      selector = selectors[target.name]
      next [] unless selector
      target.shell_script_build_phases.filter_map do |phase|
        script = phase.shell_script.to_s
        next unless script.include?(selector)
        { target: target.name, name: phase.display_name, shell: phase.shell_path || '/bin/sh', script: script }
      end
    end
  end

  def self.prepare_release_dependencies(repo)
    phases = release_dependency_phases(repo)
    pods = File.join(repo, 'mobile/ios/Pods')
    log = File.join(repo, 'build-ios/native-dependency-preparation.log')
    FileUtils.mkdir_p(File.dirname(log))
    env = {
      'REACT_NATIVE_PATH' => File.join(repo, 'mobile/node_modules/react-native'),
      'PODS_ROOT' => pods, 'PROJECT_DIR' => pods, 'CONFIGURATION' => 'Release',
      'GCC_PREPROCESSOR_DEFINITIONS' => '', 'NODE_BINARY' => ENV.fetch('NODE_BINARY', 'node')
    }
    File.open(log, 'w') do |output|
      phases.each do |phase|
        output.puts "=== #{phase.fetch(:target)}: #{phase.fetch(:name)} ==="
        begin
          stdout, stderr, status = Open3.capture3(env, phase.fetch(:shell), '-c', phase.fetch(:script), chdir: pods)
          output.write(stdout)
          output.write(stderr)
          raise "Release dependency preparation failed for #{phase.fetch(:target)} (exit #{status.exitstatus}); see #{log}" unless status.success?
        rescue SystemCallError => error
          output.puts(error.message)
          raise "Release dependency preparation failed for #{phase.fetch(:target)}: #{error.message}; see #{log}"
        end
      end
      output.puts('No prebuilt dependency selectors; using source-built dependencies') if phases.empty?
    end
    phases.length
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
    keychain = ENV['SINGZ_SIGNING_KEYCHAIN_PATH']
    if !ENV['GITHUB_ACTIONS'] && keychain.to_s.empty?
      raise ArgumentError, 'Run through scripts/with-apple-secrets.sh; dedicated signing keychain is required'
    end
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
    signing = ['/usr/bin/codesign', '--force', '--sign', identity]
    signing += ['--keychain', keychain] unless ENV['GITHUB_ACTIONS']
    _out, err, result = Open3.capture3(*signing,
      '--preserve-metadata=identifier,entitlements,flags,runtime', application)
    raise err unless result.success?
  end
end

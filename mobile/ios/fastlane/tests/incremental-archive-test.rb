require 'minitest/autorun'
require 'tmpdir'
require 'timeout'
require_relative '../incremental-archive'

class IncrementalArchiveTest < Minitest::Test
  CACHE = SingzIncrementalArchive
  SETTINGS = %w[SINGZ_IOS_NATIVE_CACHE SINGZ_IOS_NATIVE_CACHE_MAX_ENTRIES SINGZ_IOS_NATIVE_CACHE_MAX_BYTES SINGZ_IOS_NATIVE_CACHE_MAX_AGE_DAYS SINGZ_IOS_NATIVE_CACHE_PINNED SINGZ_SIGNING_KEYCHAIN_PATH GITHUB_ACTIONS].freeze

  def setup
    @temporary = Dir.mktmpdir('singz-ios-cache-test-')
    @previous = SETTINGS.to_h { |name| [name, ENV[name]] }
    SETTINGS.each { |name| ENV.delete(name) }
    ENV['SINGZ_IOS_NATIVE_CACHE'] = File.join(@temporary, 'cache')
    @now = Time.now
  end

  def teardown
    @previous.each { |name, value| value ? ENV[name] = value : ENV.delete(name) }
    FileUtils.rm_rf(@temporary)
  end

  def replace_method(object, name, replacement)
    original = object.method(name)
    object.define_singleton_method(name, replacement)
    yield
  ensure
    object.define_singleton_method(name, original)
  end

  def fake_codesign
    success = Struct.new(:success?).new(true)
    replace_method(Open3, :capture3, ->(*_args) { ['', '', success] }) { yield }
  end

  def make_archive(key, age: 0, bytes: 32)
    archive = CACHE.cached_archive(key)
    application = CACHE.app(archive)
    FileUtils.mkdir_p(application)
    File.write(File.join(application, 'SingZPlayer'), 'x' * bytes)
    File.write(File.join(application, 'Info.plist'), 'application metadata')
    File.write(File.join(archive, 'Info.plist'), 'archive metadata')
    CACHE.save(archive, key)
    File.utime(@now - age * 86400, @now - age * 86400, CACHE.receipt(archive))
    archive
  end

  def test_pruning_removes_old_recognized_entries_only_and_preserves_pins
    old = 'a' * 64
    current = 'b' * 64
    pinned = 'c' * 64
    recent = 'd' * 64
    [old, current, pinned].each { |key| make_archive(key, age: 40) }
    make_archive(recent)
    ENV['SINGZ_IOS_NATIVE_CACHE_PINNED'] = pinned
    unknown = File.join(CACHE.cache_root, 'developer-notes')
    FileUtils.mkdir_p(unknown)
    unknown_hash = File.join(CACHE.cache_root, 'e' * 64)
    FileUtils.mkdir_p(unknown_hash) # no recognizable receipt: not ours to prune
    outside = File.join(@temporary, 'external')
    FileUtils.mkdir_p(outside)
    File.write(File.join(outside, 'keep'), 'outside data')
    linked = File.join(CACHE.cache_root, 'f' * 64)
    File.symlink(outside, linked)
    assert_equal [old], CACHE.prune(preserve: [current], now: @now)
    [current, pinned, recent].each { |key| assert File.directory?(CACHE.cached_archive(key)) }
    assert File.directory?(unknown)
    assert File.directory?(unknown_hash)
    assert File.symlink?(linked)
    assert_equal 'outside data', File.read(File.join(outside, 'keep'))
  end

  def test_entry_cap_evicts_oldest_and_byte_cap_is_independent
    first, second, current = %w[a b c].map { |char| char * 64 }
    make_archive(first, age: 3, bytes: 1000)
    make_archive(second, age: 2, bytes: 1000)
    make_archive(current, age: 1, bytes: 1000)
    ENV['SINGZ_IOS_NATIVE_CACHE_MAX_ENTRIES'] = '2'
    assert_equal [first], CACHE.prune(preserve: [current], now: @now)
    ENV['SINGZ_IOS_NATIVE_CACHE_MAX_ENTRIES'] = '8'
    ENV['SINGZ_IOS_NATIVE_CACHE_MAX_BYTES'] = '1800'
    assert_equal [second], CACHE.prune(preserve: [current], now: @now)
    assert File.directory?(CACHE.cached_archive(current))
  end

  def test_copy_holds_a_reader_lease_against_pruning_and_refresh_is_local
    active, removable = %w[a b].map { |char| char * 64 }
    archive = make_archive(active, age: 40)
    make_archive(removable, age: 40)
    destination = File.join(@temporary, 'checkout/build-ios/local.xcarchive')
    entered = Queue.new
    resume = Queue.new
    real_copy = FileUtils.method(:cp_r)
    fake_codesign do
      replace_method(FileUtils, :cp_r, ->(from, to, **options) {
        entered << true
        resume.pop
        real_copy.call(from, to, **options)
      }) do
        copy = Thread.new { CACHE.copy_cached(active, destination) }
        begin
          Timeout.timeout(5) { entered.pop }
          # Fresh access alone must not save this entry from the count cap.
          ENV['SINGZ_IOS_NATIVE_CACHE_MAX_ENTRIES'] = '1'
          ENV['SINGZ_IOS_NATIVE_CACHE_MAX_BYTES'] = '1'
          assert_equal [removable], CACHE.prune(now: @now)
          assert File.directory?(archive), 'active copy must retain its source'
        ensure
          resume << true
          copy.join
        end
        assert copy.value
      end
      File.write(File.join(CACHE.app(destination), 'SingZPlayer'), 'refreshed local binary')
      assert_equal 'x' * 32, File.read(File.join(CACHE.app(archive), 'SingZPlayer'))
      assert CACHE.valid?(archive, active)
    end
  end

  def test_copy_revalidates_receipt_and_refuses_shared_destination
    key = 'a' * 64
    archive = make_archive(key)
    destination = File.join(@temporary, 'checkout/archive')
    fake_codesign do
      assert_raises(ArgumentError) { CACHE.copy_cached(key, CACHE.cached_archive('b' * 64)) }
      alias_root = File.join(@temporary, 'alias-cache')
      File.symlink(CACHE.cache_root, alias_root)
      assert_raises(ArgumentError) { CACHE.copy_cached(key, File.join(alias_root, key, 'SingZ.xcarchive')) }
      File.write(File.join(CACHE.app(archive), 'SingZPlayer'), 'modified')
      refute CACHE.copy_cached(key, destination)
      refute File.exist?(destination)
    end
    assert_raises(ArgumentError) { CACHE.cached_archive('../outside') }
  end

  def test_publish_preserves_current_and_prunes_after_success_only
    prior = 'a' * 64
    make_archive(prior, age: 40)
    current = 'b' * 64
    source = File.join(@temporary, 'fresh.xcarchive')
    FileUtils.mkdir_p(CACHE.app(source))
    File.write(File.join(CACHE.app(source), 'SingZPlayer'), 'new binary')
    File.write(File.join(CACHE.app(source), 'Info.plist'), 'app')
    File.write(File.join(source, 'Info.plist'), 'archive')
    fake_codesign do
      CACHE.publish(source, current)
      assert CACHE.valid?(CACHE.cached_archive(current), current)
      refute File.exist?(CACHE.cached_archive(prior))
      assert_equal 'new binary', File.read(File.join(CACHE.app(source), 'SingZPlayer'))
    end
  end

  def test_pruning_rejects_invalid_configuration_before_removing_entries
    key = 'a' * 64
    make_archive(key, age: 40)
    %w[0 -1 wrong].each do |value|
      ENV['SINGZ_IOS_NATIVE_CACHE_MAX_ENTRIES'] = value
      assert_raises(ArgumentError) { CACHE.prune(now: @now) }
      assert File.directory?(CACHE.cached_archive(key))
    end
  end
  def test_refresh_pins_local_signing_to_the_dedicated_keychain
    archive = make_archive('a' * 64)
    calls = []
    success = Struct.new(:success?).new(true)
    ENV['SINGZ_SIGNING_KEYCHAIN_PATH'] = File.join(@temporary, 'singz-ios-signing.keychain-db')
    replace_method(Open3, :capture3, ->(*args) { calls << args; ['', '', success] }) do
      CACHE.refresh(@temporary, archive, '120', 'Apple Distribution')
    end
    signing = calls.find { |args| args.first == '/usr/bin/codesign' }
    assert_equal ENV['SINGZ_SIGNING_KEYCHAIN_PATH'], signing[signing.index('--keychain') + 1]
    ENV.delete('SINGZ_SIGNING_KEYCHAIN_PATH')
    calls.clear
    replace_method(Open3, :capture3, ->(*args) { calls << args; ['', '', success] }) do
      assert_raises(ArgumentError) { CACHE.refresh(@temporary, archive, '121', 'Apple Distribution') }
    end
    assert_empty calls, 'missing local signing configuration must fail before bundling or signing'
    ENV['GITHUB_ACTIONS'] = 'true'
    replace_method(Open3, :capture3, ->(*args) { calls << args; ['', '', success] }) do
      CACHE.refresh(@temporary, archive, '122', 'Apple Distribution')
    end
    refute_includes calls.find { |args| args.first == '/usr/bin/codesign' }, '--keychain'
  end

  def test_release_dependency_plan_uses_installed_target_phases_only
    phase = Struct.new(:display_name, :shell_path, :shell_script)
    target = Struct.new(:name, :shell_script_build_phases)
    project = Struct.new(:targets).new([
      target.new('React-Core-prebuilt', [
        phase.new('select core', '/bin/sh', 'node "$REACT_NATIVE_PATH/scripts/replace-rncore-version.js" -r installed-core-version'),
        phase.new('copy framework', '/bin/sh', 'copy framework')
      ]),
      target.new('ReactNativeDependencies', [
        phase.new('select dependencies', '/bin/sh', 'node replace_dependencies_version.js -r installed-deps-version')
      ]),
      target.new('hermes-engine', [
        phase.new('select hermes', '/bin/sh', 'node replace_hermes_version.js -r installed-hermes-version')
      ]),
      target.new('unrelated', [phase.new('unrelated selector', '/bin/sh', 'node replace-rncore-version.js')]),
      target.new('React-Core', [])
    ])
    plan = CACHE.release_dependency_phases(@temporary, project: project)
    assert_equal ['React-Core-prebuilt', 'ReactNativeDependencies', 'hermes-engine'], plan.map { |row| row[:target] }
    assert_equal ['select core', 'select dependencies', 'select hermes'], plan.map { |row| row[:name] }
    assert_includes plan.first[:script], 'installed-core-version'
  end

  def test_preparing_release_stabilizes_fresh_debug_and_existing_release_inputs
    pods = File.join(@temporary, 'mobile/ios/Pods')
    FileUtils.mkdir_p(pods)
    artifact = File.join(pods, 'prebuilt-framework')
    # An installed selector chooses its framework based on Xcode's defines.
    # The helper must explicitly supply Release inputs and the Pods cwd.
    script = <<~SH
      test "$(pwd -P)" = "$(cd "$PODS_ROOT" && pwd -P)" || exit 7
      test "$PROJECT_DIR" = "$PODS_ROOT" || exit 8
      test "$CONFIGURATION" = Release || exit 9
      test -n "$REACT_NATIVE_PATH" || exit 10
      test -n "$NODE_BINARY" || exit 11
      if echo "$GCC_PREPROCESSOR_DEFINITIONS" | grep -q 'DEBUG=1'; then
        printf Debug > prebuilt-framework
      else
        printf Release > prebuilt-framework
      fi
      echo selected framework
    SH
    plan = [{ target: 'installed-selector', name: 'select framework', shell: '/bin/sh', script: script }]
    before = ENV['GCC_PREPROCESSOR_DEFINITIONS']
    ENV['GCC_PREPROCESSOR_DEFINITIONS'] = 'DEBUG=1'
    replace_method(CACHE, :release_dependency_phases, ->(_repo) { plan }) do
      File.write(artifact, 'Debug')
      assert_equal 1, CACHE.prepare_release_dependencies(@temporary)
      first = Digest::SHA256.file(artifact).hexdigest
      assert_equal 'Release', File.read(artifact)
      assert_equal 1, CACHE.prepare_release_dependencies(@temporary)
      assert_equal first, Digest::SHA256.file(artifact).hexdigest
      assert_includes File.read(File.join(@temporary, 'build-ios/native-dependency-preparation.log')), 'selected framework'
    end
  ensure
    before ? ENV['GCC_PREPROCESSOR_DEFINITIONS'] = before : ENV.delete('GCC_PREPROCESSOR_DEFINITIONS')
  end

  def test_release_preparation_forwards_failure_and_records_diagnostics
    FileUtils.mkdir_p(File.join(@temporary, 'mobile/ios/Pods'))
    plan = [{ target: 'failing-prebuilt', name: 'select', shell: '/bin/sh', script: 'echo selector failed >&2; exit 23' }]
    replace_method(CACHE, :release_dependency_phases, ->(_repo) { plan }) do
      error = assert_raises(RuntimeError) { CACHE.prepare_release_dependencies(@temporary) }
      assert_match(/failing-prebuilt.*exit 23/, error.message)
      assert_includes File.read(File.join(@temporary, 'build-ios/native-dependency-preparation.log')), 'selector failed'
    end
    replace_method(CACHE, :release_dependency_phases, ->(_repo) { [] }) do
      assert_equal 0, CACHE.prepare_release_dependencies(@temporary)
      assert_includes File.read(File.join(@temporary, 'build-ios/native-dependency-preparation.log')), 'source-built'
    end
  end

end

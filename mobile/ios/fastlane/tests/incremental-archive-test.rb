require 'minitest/autorun'
require 'tmpdir'
require 'timeout'
require_relative '../incremental-archive'

class IncrementalArchiveTest < Minitest::Test
  CACHE = SingzIncrementalArchive
  SETTINGS = %w[SINGZ_IOS_NATIVE_CACHE SINGZ_IOS_NATIVE_CACHE_MAX_ENTRIES SINGZ_IOS_NATIVE_CACHE_MAX_BYTES SINGZ_IOS_NATIVE_CACHE_MAX_AGE_DAYS SINGZ_IOS_NATIVE_CACHE_PINNED].freeze

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
end

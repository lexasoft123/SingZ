require 'minitest/autorun'
require 'tmpdir'
require_relative '../app-build-number'

class AppBuildNumberTest < Minitest::Test
  def setup
    @dir = Dir.mktmpdir('singz-build-number-')
    @project = File.join(@dir, 'project.pbxproj')
    @original = "CURRENT_PROJECT_VERSION = 86;\nCURRENT_PROJECT_VERSION = 86;\n"
    File.write(@project, @original)
  end

  def teardown
    FileUtils.remove_entry(@dir)
  end

  def test_stamps_only_the_app_and_restores_after_success
    other_project = File.join(@dir, 'Pods.pbxproj')
    File.write(other_project, @original)
    SingzAppBuildNumber.with_number(@project, 95) do
      assert_equal 2, File.read(@project).scan('CURRENT_PROJECT_VERSION = 95;').length
      assert_equal @original, File.read(other_project)
    end
    assert_equal @original, File.read(@project)
  end

  def test_restores_after_archive_failure
    assert_raises(RuntimeError) { SingzAppBuildNumber.with_number(@project, 95) { raise 'archive failed' } }
    assert_equal @original, File.read(@project)
  end

  def test_rejects_invalid_numbers_and_missing_setting
    ['', '0', '-1', '95; other-setting'].each do |number|
      assert_raises(ArgumentError) { SingzAppBuildNumber.with_number(@project, number) {} }
    end
    File.write(@project, 'no version setting')
    assert_raises(ArgumentError) { SingzAppBuildNumber.with_number(@project, 95) {} }
  end

  def test_preserves_concurrent_edits
    _out, err = capture_io do
      SingzAppBuildNumber.with_number(@project, 95) { File.open(@project, 'a') { |f| f.write('// editor change') } }
    end
    assert_match(/preserving those edits/, err)
    assert_includes File.read(@project), '// editor change'
  end
end

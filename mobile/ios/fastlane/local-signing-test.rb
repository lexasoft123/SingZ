require "minitest/autorun"
require "tmpdir"
require_relative "local-signing"

class LocalSigningTest < Minitest::Test
  def test_dedicated_keychain_preserves_search_order_and_keeps_password_out_of_xcode_args
    Dir.mktmpdir do |dir|
      keychain = File.join(dir, "signing keychain-db")
      password_file = File.join(dir, "password")
      File.write(keychain, "")
      File.write(password_file, "fixture-only-password", perm: 0600)
      previous = ENV.to_h
      ENV["SINGZ_SIGNING_KEYCHAIN_PATH"] = keychain
      ENV["SINGZ_SIGNING_KEYCHAIN_PASSWORD_FILE"] = password_file
      calls = []
      executor = ->(*args) {
        calls << args
        args == ["list-keychains", "-d", "user"] ?
          ["/first.keychain", keychain, "/last.keychain"].map(&:shellescape).join(" ") : ""
      }
      SingzLocalSigning.stub(:security, executor) do
        password = SingzLocalSigning.prepare
        SingzLocalSigning.authorize(password)
        assert_equal "fixture-only-password", password
        assert_includes calls, ["list-keychains", "-d", "user", "-s", keychain, "/first.keychain", "/last.keychain"]
        refute calls.any? { |args| args.first == "default-keychain" }
        refute_includes SingzLocalSigning.xcarg, password
        flag = Shellwords.split(SingzLocalSigning.xcarg).first.split("=", 2).last
        assert_equal ["--keychain", keychain], Shellwords.split(flag)
        assert_includes calls, ["set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", password, keychain]
        refute ENV.values.include?(password)
      end
    ensure
      ENV.replace(previous) if previous
    end
  end
end

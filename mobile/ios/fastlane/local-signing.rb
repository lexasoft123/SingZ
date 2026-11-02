require "open3"
require "shellwords"

# Local signing has its own keychain. Never change the default keychain or
# forward its password into xcodebuild's environment.
module SingzLocalSigning
  def self.security(*args)
    output, _error, result = Open3.capture3("/usr/bin/security", *args)
    raise "Dedicated iOS signing keychain operation failed: #{args.first}" unless result.success?
    output
  end

  def self.path
    ENV.fetch("SINGZ_SIGNING_KEYCHAIN_PATH")
  end

  def self.prepare
    password = File.binread(ENV.fetch("SINGZ_SIGNING_KEYCHAIN_PASSWORD_FILE"))
    raise "Dedicated signing keychain password is empty" if password.empty?
    security("create-keychain", "-p", password, path) unless File.exist?(path)
    security("unlock-keychain", "-p", password, path)
    security("set-keychain-settings", "-lut", "21600", path)
    current = Shellwords.split(security("list-keychains", "-d", "user"))
    security("list-keychains", "-d", "user", "-s", path, *current.reject { |entry| entry == path })
    password
  end

  def self.authorize(password)
    security("set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", password, path)
  end

  def self.xcarg
    "OTHER_CODE_SIGN_FLAGS=#{Shellwords.escape("--keychain #{Shellwords.escape(path)}") }"
  end
end

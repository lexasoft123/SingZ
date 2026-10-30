require "spaceship"
Spaceship::ConnectAPI.token = Spaceship::ConnectAPI::Token.create(
  key_id: ENV["APP_STORE_CONNECT_API_KEY_ID"],
  issuer_id: ENV["APP_STORE_CONNECT_API_ISSUER_ID"],
  filepath: ENV["SINGZ_ASC_KEY_PATH"]
)
DIR = ARGV[0]
DISPLAY_TYPE = ARGV[1] || "APP_IPHONE_67"
abort "unsupported screenshot display type: #{DISPLAY_TYPE}" unless %w[APP_IPHONE_67 APP_IPAD_PRO_3GEN_129].include?(DISPLAY_TYPE)
abort "usage: push-ios-screenshots.rb DIRECTORY [DISPLAY_TYPE]" unless DIR
flat_files = Dir[File.join(DIR, "*.png")].sort
localized = flat_files.empty?

app = Spaceship::ConnectAPI::App.find("io.s-dev.singz")
v = app.get_edit_app_store_version
abort "no editable App Store version" unless v
editable_states = %w[PREPARE_FOR_SUBMISSION INVALID_BINARY REJECTED METADATA_REJECTED DEVELOPER_REJECTED]
abort "screenshots are locked while version #{v.version_string} is #{v.app_store_state}" unless editable_states.include?(v.app_store_state)
localizations = v.get_app_store_version_localizations
# Preflight every locale before changing any screenshot set. A localized root
# has one folder per App Store locale; a flat directory preserves the old mode.
files_by_locale = localizations.to_h do |l|
  files = localized ? Dir[File.join(DIR, l.locale, "*.png")].sort : flat_files
  abort "no screenshots for #{l.locale} in #{DIR}" if files.empty?
  abort "too many screenshots for #{l.locale}" if files.length > 10
  [l.locale, files]
end
localizations.each do |l|
  files = files_by_locale.fetch(l.locale)
  # Each device family is independent. Replacing iPhone screenshots must not
  # remove the iPad set required to submit a universal app.
  l.get_app_screenshot_sets.select { |s| s.screenshot_display_type == DISPLAY_TYPE }.each(&:delete!)
  set = l.create_app_screenshot_set(attributes: { screenshotDisplayType: DISPLAY_TYPE })
  files.each_with_index do |f, i|
    set.upload_screenshot(path: f, wait_for_processing: true)
    puts "  #{l.locale}  #{i + 1}. #{File.basename(f)}"
  end
end
puts "done: #{localizations.size} locales, #{DISPLAY_TYPE}, in filename order"

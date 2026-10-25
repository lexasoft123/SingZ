require "spaceship"
Spaceship::ConnectAPI.token = Spaceship::ConnectAPI::Token.create(
  key_id: ENV["APP_STORE_CONNECT_API_KEY_ID"],
  issuer_id: ENV["APP_STORE_CONNECT_API_ISSUER_ID"],
  filepath: ENV["SINGZ_ASC_KEY_PATH"]
)
DIR = ARGV[0]
DISPLAY_TYPE = ARGV[1] || "APP_IPHONE_67"
abort "unsupported screenshot display type: #{DISPLAY_TYPE}" unless %w[APP_IPHONE_67 APP_IPAD_PRO_3GEN_129].include?(DISPLAY_TYPE)
files = Dir[File.join(DIR, "*.png")].sort
abort "no screenshots in #{DIR}" if files.empty?

app = Spaceship::ConnectAPI::App.find("io.s-dev.singz")
v = app.get_edit_app_store_version
v.get_app_store_version_localizations.each do |l|
  # Each device family is independent. Replacing iPhone screenshots must not
  # remove the iPad set required to submit a universal app.
  l.get_app_screenshot_sets.select { |s| s.screenshot_display_type == DISPLAY_TYPE }.each(&:delete!)
  set = l.create_app_screenshot_set(attributes: { screenshotDisplayType: DISPLAY_TYPE })
  files.each_with_index do |f, i|
    set.upload_screenshot(path: f, wait_for_processing: true)
    puts "  #{l.locale}  #{i + 1}. #{File.basename(f)}"
  end
end
puts "done: #{files.size} per locale, in filename order"

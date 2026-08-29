require "spaceship"
Spaceship::ConnectAPI.token = Spaceship::ConnectAPI::Token.create(
  key_id: ENV["APP_STORE_CONNECT_API_KEY_ID"],
  issuer_id: ENV["APP_STORE_CONNECT_API_ISSUER_ID"],
  filepath: ENV["SINGZ_ASC_KEY_PATH"]
)
DIR = ARGV[0]
files = Dir[File.join(DIR, "*.png")].sort
abort "no screenshots in #{DIR}" if files.empty?

app = Spaceship::ConnectAPI::App.find("io.s-dev.singz")
v = app.get_edit_app_store_version
v.get_app_store_version_localizations.each do |l|
  l.get_app_screenshot_sets.each(&:delete!)          # start from empty, always
  set = l.create_app_screenshot_set(attributes: { screenshotDisplayType: "APP_IPHONE_67" })
  files.each_with_index do |f, i|
    set.upload_screenshot(path: f, wait_for_processing: true)
    puts "  #{l.locale}  #{i + 1}. #{File.basename(f)}"
  end
end
puts "done: #{files.size} per locale, in filename order"

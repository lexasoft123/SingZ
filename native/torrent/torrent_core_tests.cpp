#include "torrent_engine.h"
#include <filesystem>
#include <fstream>
#include <iostream>
#include <libtorrent/create_torrent.hpp>
#include <libtorrent/session.hpp>
#include <libtorrent/torrent_info.hpp>
#include <libtorrent/torrent_status.hpp>
#include <stdexcept>
#include <thread>
namespace fs = std::filesystem;
namespace lt = libtorrent;
extern "C" void singz_torrent_test_connect(const char *, int);
extern "C" int singz_torrent_test_unselected_bytes(const char *, int);
void require(bool condition, const char *why) {
  if (!condition)
    throw std::runtime_error(why);
}
std::string call(fs::path const &root, const char *op, int index = -1,
                 std::vector<char> const &data = {}) {
  auto path = root.string();
  char *result = singz_torrent_call(
      path.c_str(), op, "12345", index,
      reinterpret_cast<unsigned char const *>(data.data()), data.size());
  require(result != nullptr, "null core result");
  std::string text = result;
  singz_torrent_free(result);
  if (text.find("\"ok\":true") == std::string::npos)
    std::cerr << text << '\n';
  return text;
}
int main() {
  auto root =
      fs::temp_directory_path() /
      ("singz-torrent-test-" +
       std::to_string(
           std::chrono::steady_clock::now().time_since_epoch().count()));
  fs::create_directories(root / "seed" / "album");
  try {
    // Corrupt or incomplete persisted records must return errors, never crash
    // inside libtorrent's unchecked typed bdecode accessors.
    int malformed = 0;
    for (auto const &record : {"d6:formati2ee", "li2ee",
                              "d6:formati2e7:pendingli1ee5:readylee",
                              "d6:activei1e6:formati2e7:pendingle5:readylee"}) {
      auto broken = root / ("broken-" + std::to_string(malformed++));
      fs::create_directories(broken);
      std::ofstream(broken / "queue.bencode") << record;
      require(call(broken, "status").find("\"ok\":false") != std::string::npos,
              "malformed queue was accepted");
      singz_torrent_shutdown(broken.string().c_str());
    }
    auto brokenLegacy = root / "broken-legacy";
    fs::create_directories(brokenLegacy);
    std::ofstream(brokenLegacy / "job.bencode") << "li1ee";
    require(call(brokenLegacy, "status").find("\"ok\":false") != std::string::npos,
            "malformed legacy job was accepted");
    singz_torrent_shutdown(brokenLegacy.string().c_str());
    constexpr int size = 512 * 1024;
    std::string first(size, 'A'), second(size, 'B');
    {
      std::ofstream out(root / "seed" / "album" / "first.flac",
                        std::ios::binary);
      out.write(first.data(), first.size());
    }
    {
      std::ofstream out(root / "seed" / "album" / "second.flac",
                        std::ios::binary);
      out.write(second.data(), second.size());
    }
    lt::file_storage files;
    files.add_file("album/first.flac", size);
    files.add_file("album/second.flac", size);
    lt::create_torrent maker(files, 16 * 1024, lt::create_torrent::v1_only);
    lt::set_piece_hashes(maker, (root / "seed").string());
    auto bytes = maker.generate_buf();
    auto info = std::make_shared<lt::torrent_info>(
        lt::span<char const>(bytes.data(), bytes.size()), lt::from_span);
    lt::settings_pack settings;
    settings.set_str(lt::settings_pack::listen_interfaces, "127.0.0.1:0");
    settings.set_bool(lt::settings_pack::enable_dht, false);
    settings.set_bool(lt::settings_pack::enable_lsd, false);
    settings.set_bool(lt::settings_pack::enable_upnp, false);
    settings.set_bool(lt::settings_pack::enable_natpmp, false);
    settings.set_bool(lt::settings_pack::enable_incoming_utp, false);
    lt::session seed(settings);
    lt::add_torrent_params params;
    params.ti = info;
    params.save_path = (root / "seed").string();
    params.flags |= lt::torrent_flags::seed_mode;
    auto seeder = seed.add_torrent(params);
    auto owned = root / "download";
    auto inspected = call(owned, "inspect", -1, bytes);
    require(inspected.find("first.flac") != std::string::npos,
            "missing first song");
    require(inspected.find("second.flac") != std::string::npos,
            "missing second song");
    require(!fs::exists(owned / "partial"),
            "inspecting metadata downloaded payload");
    auto rejected = call(owned, "start", 9999);
    require(rejected.find("\"ok\":false") != std::string::npos,
            "invalid file index accepted");
    require(call(owned, "status").find("\"data\":null") != std::string::npos,
            "invalid start created a job");
    require(call(owned, "start", 0).find("downloading") != std::string::npos,
            "download did not start");
    require(call(owned, "pause").find("\"state\":\"paused\"") !=
                std::string::npos,
            "pause failed");
    singz_torrent_shutdown(owned.string().c_str());
    require(call(owned, "status").find("\"state\":\"paused\"") !=
                std::string::npos,
            "restart did not recover paused job");
    require(call(owned, "resume").find("downloading") != std::string::npos,
            "resume failed");
    int port = seed.listen_port();
    require(port > 0, "local seeder did not listen");
    singz_torrent_test_connect(owned.string().c_str(), port);
    bool complete = false;
    auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(40);
    std::string last;
    while (std::chrono::steady_clock::now() < deadline) {
      last = call(owned, "status");
      if (last.find("\"state\":\"complete\"") != std::string::npos) {
        complete = true;
        break;
      }
      if (last.find("\"state\":\"error\"") != std::string::npos)
        break;
      std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
    if (!complete)
      std::cerr << last << '\n';
    require(complete, "local torrent did not finish");
    require(singz_torrent_test_unselected_bytes(owned.string().c_str(), 0) == 0,
            "unselected song downloaded");
    auto exported = owned / "imports" / "12345-0" / "first.flac";
    std::ifstream file(exported, std::ios::binary);
    std::string actual((std::istreambuf_iterator<char>(file)), {});
    require(actual == first, "exported bytes differ from selected song");
    auto consumed = call(owned, "consume");
    require(consumed.find("first.flac") != std::string::npos, "handoff failed");
    require(fs::exists(exported), "handoff deleted import source too early");
    require(call(owned, "queue").find("first.flac") != std::string::npos,
            "opening Add song lost the recoverable download");
    singz_torrent_shutdown(owned.string().c_str());
    require(call(owned, "queue").find("first.flac") != std::string::npos,
            "restart lost a downloaded but unadded song");
    require(call(owned, "consume").find("first.flac") != std::string::npos,
            "recovered song could not reopen Add song");
    require(call(owned, "remove", 0).find("\"data\":null") != std::string::npos,
            "explicit removal kept the downloaded song");
    require(call(owned, "start", 1).find("downloading") != std::string::npos,
            "second job did not start");
    require(call(owned, "cancel").find("\"data\":null") != std::string::npos,
            "cancel failed");
    require(!fs::exists(owned / "partial" / "12345"),
            "cancel kept partial payload");
    require(call(owned, "inspect", -1, {'x', 'x'}).find("\"ok\":false") !=
                std::string::npos,
            "invalid metadata accepted");
    singz_torrent_shutdown(owned.string().c_str());
    auto queued = root / "queue";
    require(call(queued, "inspect", -1, bytes).find("first.flac") !=
                std::string::npos,
            "queue metadata inspection failed");
    call(queued, "start", 0);
    call(queued, "pause");
    call(queued, "start", 1);
    require(call(queued, "queue").find("second.flac") != std::string::npos,
            "second song was not queued");
    singz_torrent_shutdown(queued.string().c_str());
    require(call(queued, "queue").find("second.flac") != std::string::npos,
            "restart lost pending song");
    call(queued, "resume");
    singz_torrent_test_connect(queued.string().c_str(), port);
    auto completedNamed = [&](std::string const &name) {
      auto q = call(queued, "queue");
      auto a = q.find("\"name\":\"" + name + "\"");
      if (a == std::string::npos)
        return false;
      return q.substr(a, q.find('}', a) - a).find("\"state\":\"complete\"") !=
             std::string::npos;
    };
    deadline = std::chrono::steady_clock::now() + std::chrono::seconds(40);
    while (!completedNamed("first.flac") &&
           std::chrono::steady_clock::now() < deadline)
      std::this_thread::sleep_for(std::chrono::milliseconds(100));
    require(completedNamed("first.flac"), "first queued song did not complete");
    require(call(queued, "status").find("second.flac") != std::string::npos,
            "queue did not advance automatically");
    require(call(queued, "consume", 0).find("first.flac") != std::string::npos,
            "ready song could not open while another downloads");
    require(call(queued, "consume", 0).find("first.flac") != std::string::npos,
            "opening Add song retired the download");
    singz_torrent_shutdown(queued.string().c_str());
    require(completedNamed("first.flac"), "restart lost completed queue item");
    call(queued, "resume");
    singz_torrent_test_connect(queued.string().c_str(), port);
    deadline = std::chrono::steady_clock::now() + std::chrono::seconds(40);
    while (!completedNamed("second.flac") &&
           std::chrono::steady_clock::now() < deadline)
      std::this_thread::sleep_for(std::chrono::milliseconds(100));
    require(completedNamed("second.flac"),
            "second queued song did not complete");
    call(queued, "remove", 0);
    require(call(queued, "queue").find("first.flac") == std::string::npos,
            "explicitly removed song remained in queue");
    require(completedNamed("second.flac"),
            "removing one song lost another completed song");
    call(queued, "remove", 1);
    singz_torrent_shutdown(queued.string().c_str());
    auto legacy = root / "legacy";
    fs::create_directories(legacy / "metadata");
    fs::create_directories(legacy / "imports/12345-0");
    {
      std::ofstream out(legacy / "metadata/12345.torrent", std::ios::binary);
      out.write(bytes.data(), bytes.size());
    }
    {
      std::ofstream out(legacy / "imports/12345-0/first.flac",
                        std::ios::binary);
      out.write(first.data(), first.size());
    }
    require(call(legacy, "queue").find("first.flac") != std::string::npos,
            "legacy unadded original was not recovered");
    call(legacy, "remove", 0);
    singz_torrent_shutdown(legacy.string().c_str());
    require(call(legacy, "queue").find("first.flac") == std::string::npos,
            "deleted legacy download resurrected");
    singz_torrent_shutdown(legacy.string().c_str());
    fs::remove_all(root);
    std::cout << "PASS: metadata-only inspection, file validation, local TCP "
                 "transfer, pause, restart/resume, selected-file verification, "
                 "unselected-file exclusion, handoff and cancellation\n";
    return 0;
  } catch (std::exception const &error) {
    singz_torrent_shutdown((root / "download").string().c_str());
    std::cerr << error.what() << '\n';
    fs::remove_all(root);
    return 1;
  }
}

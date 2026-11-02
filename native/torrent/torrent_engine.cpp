#include "torrent_engine.h"
#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <libtorrent/alert_types.hpp>
#include <libtorrent/bdecode.hpp>
#include <libtorrent/bencode.hpp>
#include <libtorrent/read_resume_data.hpp>
#include <libtorrent/session.hpp>
#include <libtorrent/torrent_info.hpp>
#include <libtorrent/torrent_status.hpp>
#include <libtorrent/write_resume_data.hpp>
#include <map>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>
#if defined(_WIN32)
#include <windows.h>
#else
#include <fcntl.h>
#include <unistd.h>
#endif

namespace {
namespace lt = libtorrent;
namespace fs = std::filesystem;
using Clock = std::chrono::steady_clock;
std::string utf8(fs::path const &p) {
  auto s = p.u8string();
  return {s.begin(), s.end()};
}
std::string quote(std::string const &value) {
  std::string out = "\"";
  constexpr char hex[] = "0123456789abcdef";
  for (unsigned char c : value) {
    if (c == '"' || c == '\\') {
      out += '\\';
      out += char(c);
    } else if (c < 32) {
      out += "\\u00";
      out += hex[c >> 4];
      out += hex[c & 15];
    } else
      out += char(c);
  }
  return out + '"';
}
bool releaseOK(std::string const &s) {
  return !s.empty() && s.size() <= 12 && s[0] != '0' &&
         std::all_of(s.begin(), s.end(),
                     [](unsigned char c) { return c >= '0' && c <= '9'; });
}
bool safeName(std::string const &s) {
  if (s.empty() || s == "." || s == ".." || s.size() > 240)
    return false;
  for (unsigned char c : s)
    if (c < 32 || c == 127 ||
        std::string("<>:\"/\\\\|?*").find(char(c)) != std::string::npos)
      return false;
  if (s.back() == ' ' || s.back() == '.')
    return false;
  auto stem = s.substr(0, s.find('.'));
  std::transform(stem.begin(), stem.end(), stem.begin(),
                 [](unsigned char c) { return char(std::toupper(c)); });
  if (stem == "CON" || stem == "PRN" || stem == "AUX" || stem == "NUL")
    return false;
  if (stem.size() == 4 &&
      (stem.substr(0, 3) == "COM" || stem.substr(0, 3) == "LPT") &&
      stem[3] >= '1' && stem[3] <= '9')
    return false;
  return true;
}
bool audio(std::string const &name) {
  auto extension = utf8(fs::u8path(name).extension());
  std::transform(extension.begin(), extension.end(), extension.begin(),
                 [](unsigned char c) { return char(std::tolower(c)); });
  return extension == ".mp3" || extension == ".flac" || extension == ".wav" ||
         extension == ".m4a" || extension == ".aac" || extension == ".ogg" ||
         extension == ".oga" || extension == ".opus" || extension == ".aif" ||
         extension == ".aiff";
}
std::vector<char> read(fs::path const &p, std::size_t max = 16 * 1024 * 1024) {
  std::ifstream file(p, std::ios::binary);
  if (!file)
    throw std::runtime_error("Cannot read saved torrent data");
  auto size = fs::file_size(p);
  if (size > max)
    throw std::runtime_error("Saved torrent data is too large");
  std::vector<char> bytes(static_cast<std::size_t>(size));
  if (!bytes.empty() && !file.read(bytes.data(), std::streamsize(bytes.size())))
    throw std::runtime_error("Saved torrent data is incomplete");
  return bytes;
}

void syncFile(fs::path const &path) {
#if defined(_WIN32)
  HANDLE file =
      CreateFileW(path.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr,
                  OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE)
    throw std::runtime_error("Cannot open the downloaded song");
  BOOL flushed = FlushFileBuffers(file);
  CloseHandle(file);
  if (!flushed)
    throw std::runtime_error("Cannot flush the downloaded song");
#else
  int file = ::open(path.c_str(), O_RDONLY);
  if (file < 0)
    throw std::runtime_error("Cannot open the downloaded song");
  int flushed = ::fsync(file);
  ::close(file);
  if (flushed != 0)
    throw std::runtime_error("Cannot flush the downloaded song");
#endif
}

void atomicWrite(fs::path const &name, std::vector<char> const &bytes) {
  fs::create_directories(name.parent_path());
  auto temporary = name;
  temporary += ".part";
  {
    std::ofstream out(temporary, std::ios::binary | std::ios::trunc);
    if (!out || (!bytes.empty() &&
                 !out.write(bytes.data(), std::streamsize(bytes.size()))))
      throw std::runtime_error(
          "Cannot save the torrent download. Check free space");
    out.flush();
    if (!out)
      throw std::runtime_error("Cannot flush torrent download state");
  }
#if defined(_WIN32)
  if (!MoveFileExW(temporary.c_str(), name.c_str(),
                   MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
    throw std::runtime_error("Cannot replace torrent download state");
#else
  int fd = ::open(temporary.c_str(), O_RDONLY);
  if (fd < 0)
    throw std::runtime_error("Cannot open torrent download state");
  int result = ::fsync(fd);
  ::close(fd);
  if (result != 0)
    throw std::runtime_error("Cannot flush torrent download state");
  fs::rename(temporary, name);
#endif
}
std::shared_ptr<lt::torrent_info> metadata(std::vector<char> const &bytes) {
  if (bytes.empty() || bytes.size() > 16 * 1024 * 1024)
    throw std::runtime_error("Invalid torrent file size");
  lt::error_code ec;
  auto info = std::make_shared<lt::torrent_info>(
      lt::span<char const>(bytes.data(), bytes.size()), ec, lt::from_span);
  if (ec || info->num_files() == 0 || info->num_files() > 25000)
    throw std::runtime_error("Invalid or excessively large torrent file");
  auto const &files = info->files();
  for (auto i : files.file_range()) {
    if (files.file_flags(i) & lt::file_storage::flag_symlink)
      throw std::runtime_error("Torrent links are not supported");
    // Names displayed/exported to the app stay single, portable components.
    if (!safeName(std::string(files.file_name(i))))
      throw std::runtime_error(
          "This torrent contains an unsupported file name");
  }
  return info;
}
struct Job {
  std::string release, name, state = "paused", error;
  int index = -1;
  std::int64_t size = 0, done = 0, speed = 0;
};
class Engine {
public:
  explicit Engine(fs::path root) : root_(std::move(root)) {
    if (!root_.is_absolute())
      throw std::runtime_error(
          "Torrent storage must be a private absolute path");
    fs::create_directories(root_);
    fs::permissions(root_, fs::perms::owner_all, fs::perm_options::replace);
    restore();
    worker_ = std::thread([this] { monitor(); });
  }
  ~Engine() {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      stopping_ = true;
    }
    if (worker_.joinable())
      worker_.join();
    std::lock_guard<std::mutex> lock(mutex_);
    if (job_ && job_->state != "complete") {
      job_->state = "paused";
      job_->speed = 0;
      try {
        persist();
      } catch (...) {
      }
    }
    handle_ = {};
    session_.reset();
  }
  std::string call(std::string const &op, std::string const &release, int index,
                   std::vector<char> const &bytes) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (op == "inspect")
      return inspect(release, bytes);
    if (op == "start") {
      if (job_)
        throw std::runtime_error("Finish or cancel the current download first");
      if (!releaseOK(release))
        throw std::runtime_error("Invalid RuTracker release");
      auto data = read(metaPath(release));
      auto info = metadata(data);
      if (index < 0 || index >= info->num_files())
        throw std::runtime_error("Choose one supported audio file");
      auto i = lt::file_index_t(index);
      auto const &files = info->files();
      auto name = std::string(files.file_name(i));
      auto size = files.file_size(i);
      if (!audio(name) || size <= 0 || files.pad_file_at(i))
        throw std::runtime_error("Choose one supported audio file");
      if (size > std::int64_t(5) * 1024 * 1024 * 1024)
        throw std::runtime_error(
            "This song is larger than 5 GB. Choose a smaller release");
      job_ = std::make_unique<Job>();
      job_->release = release;
      job_->index = index;
      job_->name = name;
      job_->size = size;
      persist();
      activate(info);
    } else if (op == "pause") {
      if (job_ && job_->state != "complete" && job_->state != "verifying") {
        job_->state = "paused";
        job_->speed = 0;
        persist();
        if (handle_.is_valid()) {
          handle_.pause();
          handle_.save_resume_data(lt::torrent_handle::flush_disk_cache);
        }
      }
    } else if (op == "resume") {
      if (!job_)
        throw std::runtime_error("There is no paused download");
      if (job_->state != "complete" && job_->state != "verifying") {
        if (handle_.is_valid()) {
          job_->state = "downloading";
          job_->error.clear();
          handle_.clear_error();
          handle_.resume();
          persist();
        } else
          activate(metadata(read(metaPath(job_->release))));
      }
    } else if (op == "cancel") {
      if (job_) {
        auto releaseId = job_->release;
        auto exported = exportPath();
        handle_ = {};
        session_.reset(); // Drain libtorrent disk/network jobs first.
        fs::remove(root_ / "job.bencode");
        job_.reset();
        fs::remove_all(root_ / "partial" / releaseId);
        fs::remove_all(exported.parent_path());
        fs::remove(root_ / "resume.bencode");
      }
    } else if (op == "consume") {
      if (!job_ || job_->state != "complete")
        throw std::runtime_error(
            "The selected song has not finished downloading");
      auto out = exportPath();
      if (!fs::is_regular_file(out) ||
          fs::file_size(out) != std::uintmax_t(job_->size))
        throw std::runtime_error(
            "The downloaded song is missing or incomplete");
      auto result = "{\"path\":" + quote(utf8(out)) +
                    ",\"name\":" + quote(job_->name) +
                    ",\"size\":" + std::to_string(job_->size) + "}";
      auto releaseId = job_->release;
      fs::remove(root_ / "job.bencode");
      job_.reset();
      handle_ = {};
      session_.reset();
      fs::remove_all(root_ / "partial" / releaseId);
      fs::remove(root_ / "resume.bencode");
      return result; // Existing importer now owns this separate, durable
                     // source.
    } else if (op != "status")
      throw std::runtime_error("Unknown torrent operation");
    return status();
  }

#ifdef SINGZ_TORRENT_TESTS
  void connectTestPeer(int port) {
    std::lock_guard<std::mutex> lock(mutex_);
    handle_.connect_peer(lt::tcp::endpoint(lt::make_address("127.0.0.1"),
                                           static_cast<unsigned short>(port)));
  }
  std::vector<std::int64_t> testProgress() {
    std::lock_guard<std::mutex> lock(mutex_);
    return handle_.file_progress(lt::torrent_handle::piece_granularity);
  }
#endif
private:
  fs::path root_;
  std::mutex mutex_;
  bool stopping_ = false;
  std::thread worker_;
  std::unique_ptr<Job> job_;
  std::unique_ptr<lt::session> session_;
  lt::torrent_handle handle_;
  Clock::time_point lastSave_ = Clock::now();
  fs::path metaPath(std::string const &id) const {
    return root_ / "metadata" / (id + ".torrent");
  }
  fs::path exportPath() const {
    return root_ / "imports" /
           (job_->release + "-" + std::to_string(job_->index)) /
           fs::u8path(job_->name);
  }
  fs::path payloadPath() const {
    return root_ / "partial" / job_->release /
           (std::to_string(job_->index) + ".payload");
  }
  void persist() {
    if (!job_)
      return;
    lt::entry e;
    e["release"] = job_->release;
    e["name"] = job_->name;
    e["index"] = job_->index;
    e["size"] = job_->size;
    e["state"] = job_->state;
    e["done"] = job_->done;
    std::vector<char> bytes;
    lt::bencode(std::back_inserter(bytes), e);
    atomicWrite(root_ / "job.bencode", bytes);
  }
  void restore() {
    if (!fs::exists(root_ / "job.bencode"))
      return;
    try {
      auto data = read(root_ / "job.bencode", 65536);
      lt::bdecode_node e;
      lt::error_code ec;
      lt::bdecode(data.data(), data.data() + data.size(), e, ec);
      if (ec)
        return;
      auto j = std::make_unique<Job>();
      j->release = std::string(e.dict_find_string_value("release"));
      j->name = std::string(e.dict_find_string_value("name"));
      j->index = int(e.dict_find_int_value("index", -1));
      j->size = e.dict_find_int_value("size");
      j->done = std::max<std::int64_t>(
          0, std::min(j->size, e.dict_find_int_value("done")));
      if (!releaseOK(j->release) || !safeName(j->name) || !audio(j->name) ||
          j->index < 0 || j->size <= 0)
        return;
      j->state = std::string(e.dict_find_string_value("state"));
      job_ = std::move(j);
      auto info = metadata(read(metaPath(job_->release)));
      auto i = lt::file_index_t(job_->index);
      if (job_->index >= info->num_files() ||
          std::string(info->files().file_name(i)) != job_->name ||
          info->files().file_size(i) != job_->size) {
        job_.reset();
        return;
      }
      if (job_->state == "complete" && fs::is_regular_file(exportPath()) &&
          fs::file_size(exportPath()) == std::uintmax_t(job_->size))
        job_->done = job_->size;
      else
        job_->state = "paused";
    } catch (...) {
      job_.reset();
    }
  }
  std::string inspect(std::string const &id, std::vector<char> const &bytes) {
    if (!releaseOK(id))
      throw std::runtime_error("Invalid RuTracker release");
    auto info = metadata(bytes);
    if (job_ && job_->release == id)
      throw std::runtime_error(
          "Finish or cancel this release's current download first");
    std::string result = "{\"name\":" + quote(info->name()) +
                         ",\"total\":" + std::to_string(info->total_size()) +
                         ",\"files\":[";
    bool first = true;
    auto const &files = info->files();
    for (auto i : files.file_range()) {
      auto name = std::string(files.file_name(i));
      if (files.pad_file_at(i) || !audio(name) || files.file_size(i) <= 0)
        continue;
      if (!first)
        result += ',';
      first = false;
      result += "{\"index\":" + std::to_string(int(i)) +
                ",\"name\":" + quote(name) +
                ",\"path\":" + quote(files.file_path(i)) +
                ",\"size\":" + std::to_string(files.file_size(i)) + "}";
    }
    if (first)
      throw std::runtime_error("This release has no supported audio files");
    result += "]}";
    atomicWrite(metaPath(id), bytes);
    return result;
  }
  void activate(std::shared_ptr<lt::torrent_info> const &info) {
    lt::settings_pack settings;
    settings.set_str(lt::settings_pack::user_agent, "SingZ/1.0");
    settings.set_str(lt::settings_pack::listen_interfaces, "0.0.0.0:0,[::]:0");
    settings.set_bool(lt::settings_pack::enable_dht, false);
    settings.set_bool(lt::settings_pack::enable_lsd, false);
    settings.set_bool(lt::settings_pack::enable_upnp, false);
    settings.set_bool(lt::settings_pack::enable_natpmp, false);
    settings.set_bool(lt::settings_pack::validate_https_trackers, true);
    settings.set_int(lt::settings_pack::connections_limit, 40);
    settings.set_int(
        lt::settings_pack::alert_mask,
        int(static_cast<std::uint32_t>(lt::alert_category::error |
                                       lt::alert_category::storage |
                                       lt::alert_category::status)));
    if (!session_)
      session_ = std::make_unique<lt::session>(settings);
    lt::add_torrent_params params;
    if (fs::exists(root_ / "resume.bencode")) {
      auto data = read(root_ / "resume.bencode");
      lt::error_code ec;
      params = lt::read_resume_data(
          lt::span<char const>(data.data(), data.size()), ec);
      if (ec || params.info_hashes != info->info_hashes())
        params = {};
    }
    params.ti = info;
    params.save_path = utf8(root_ / "partial" / job_->release);
    params.flags &= ~lt::torrent_flags::auto_managed;
    params.flags &= ~lt::torrent_flags::paused;
    params.file_priorities.assign(info->num_files(), lt::dont_download);
    params.file_priorities[std::size_t(job_->index)] = lt::default_priority;
    // Flatten EVERY payload filename, avoiding path traversal, collisions
    // between folders and symlink-sensitive destinations from untrusted data.
    params.renamed_files.clear();
    for (auto i : info->files().file_range())
      params.renamed_files[i] = std::to_string(int(i)) + ".payload";
    lt::error_code ec;
    handle_ = session_->add_torrent(params, ec);
    if (ec)
      throw std::runtime_error("Cannot start the selected torrent");
    job_->state = "downloading";
    job_->error.clear();
    job_->speed = 0;
    persist();
    lastSave_ = Clock::now();
  }
  std::string status() const {
    if (!job_)
      return "null";
    auto const &j = *job_;
    std::string result =
        "{\"release\":" + quote(j.release) +
        ",\"index\":" + std::to_string(j.index) + ",\"name\":" + quote(j.name) +
        ",\"size\":" + std::to_string(j.size) +
        ",\"done\":" + std::to_string(j.done) +
        ",\"speed\":" + std::to_string(j.speed) +
        ",\"state\":" + quote(j.state) + ",\"error\":" + quote(j.error);
    if (j.state == "complete")
      result += ",\"path\":" + quote(utf8(exportPath()));
    return result + "}";
  }
  void finish() {
    auto source = payloadPath(), destination = exportPath();
    if (!fs::is_regular_file(source) ||
        fs::file_size(source) != std::uintmax_t(job_->size))
      throw std::runtime_error("Downloaded song size differs from the torrent");
    fs::create_directories(destination.parent_path());
    auto temporary = destination;
    temporary += ".part";
    fs::copy_file(source, temporary, fs::copy_options::overwrite_existing);
    syncFile(temporary);
    fs::rename(temporary, destination);
    job_->state = "complete";
    job_->done = job_->size;
    job_->speed = 0;
    persist();
  }
  void monitor() {
    for (;;) {
      std::this_thread::sleep_for(std::chrono::milliseconds(250));
      std::lock_guard<std::mutex> lock(mutex_);
      if (stopping_)
        return;
      if (!job_ || !session_ || !handle_.is_valid())
        continue;
      try {
        std::vector<lt::alert *> alerts;
        session_->pop_alerts(&alerts);
        for (auto *alert : alerts) {
          auto *torrentAlert = dynamic_cast<lt::torrent_alert *>(alert);
          if (torrentAlert && torrentAlert->handle != handle_)
            continue;
          if (auto *saved = lt::alert_cast<lt::save_resume_data_alert>(alert)) {
            atomicWrite(root_ / "resume.bencode",
                        lt::write_resume_data_buf(saved->params));
          } else if (lt::alert_cast<lt::torrent_paused_alert>(alert) &&
                     job_->state == "verifying") {
            finish();
          } else if (lt::alert_cast<lt::file_error_alert>(alert)) {
            job_->state = "error";
            job_->speed = 0;
            job_->error = "Cannot write the song. Check free space and resume";
            handle_.pause();
            persist();
          }
        }
        if (job_->state != "downloading")
          continue;
        auto s = handle_.status();
        std::vector<std::int64_t> progress;
        handle_.file_progress(progress, lt::torrent_handle::piece_granularity);
        if (std::size_t(job_->index) < progress.size())
          job_->done = std::min(job_->size, progress[std::size_t(job_->index)]);
        job_->speed = s.download_payload_rate;
        if (s.errc) {
          job_->state = "error";
          job_->error = "Torrent download failed. Check your connection or "
                        "free space, then resume";
          persist();
          continue;
        }
        if (s.is_finished && job_->done >= job_->size) {
          job_->state = "verifying";
          job_->speed = 0;
          handle_.pause();
          handle_.save_resume_data(lt::torrent_handle::flush_disk_cache);
          persist();
        } else if (Clock::now() - lastSave_ > std::chrono::seconds(10)) {
          handle_.save_resume_data();
          lastSave_ = Clock::now();
        }
      } catch (...) {
        job_->state = "error";
        job_->speed = 0;
        job_->error = "Cannot finish the download. Check free space and resume";
        try {
          persist();
        } catch (...) {
        }
      }
    }
  }
};
std::mutex enginesMutex;
std::map<std::string, std::shared_ptr<Engine>> engines;
std::map<std::string, std::shared_ptr<std::mutex>> rootGates;
std::shared_ptr<std::mutex> rootGate(std::string const &root) {
  std::lock_guard<std::mutex> lock(enginesMutex);
  auto &gate = rootGates[root];
  if (!gate)
    gate = std::make_shared<std::mutex>();
  return gate;
}
char *owned(std::string const &s) {
  auto *p = static_cast<char *>(std::malloc(s.size() + 1));
  if (p)
    std::memcpy(p, s.c_str(), s.size() + 1);
  return p;
}
} // namespace
extern "C" char *singz_torrent_call(const char *root, const char *op,
                                    const char *release, int index,
                                    const unsigned char *metadataBytes,
                                    size_t size) {
  try {
    if (!root || !op || !release || size > 16 * 1024 * 1024 ||
        (!metadataBytes && size))
      throw std::runtime_error("Invalid torrent command");
    auto gate = rootGate(root);
    std::lock_guard<std::mutex> rootLock(*gate);
    if (std::string(op) == "capabilities")
      return owned("{\"ok\":true,\"data\":{\"library\":\"libtorrent "
                   "2.1.2\",\"sourceStamp\":" +
                   quote(SINGZ_TORRENT_SOURCE_STAMP) + "}}");
    std::shared_ptr<Engine> e;
    {
      std::lock_guard<std::mutex> lock(enginesMutex);
      auto &entry = engines[root];
      if (!entry)
        entry = std::make_shared<Engine>(fs::u8path(root));
      e = entry;
    }
    std::vector<char> bytes;
    if (size)
      bytes.assign(metadataBytes, metadataBytes + size);
    return owned("{\"ok\":true,\"data\":" + e->call(op, release, index, bytes) +
                 "}");
  } catch (std::exception const &error) {
    return owned("{\"ok\":false,\"error\":" + quote(error.what()) + "}");
  } catch (...) {
    return owned("{\"ok\":false,\"error\":\"Torrent operation failed\"}");
  }
}
extern "C" void singz_torrent_free(char *result) { std::free(result); }
extern "C" void singz_torrent_shutdown(const char *root) {
  auto gate = rootGate(root ? root : "");
  std::lock_guard<std::mutex> rootLock(*gate);
  std::shared_ptr<Engine> e;
  {
    std::lock_guard<std::mutex> lock(enginesMutex);
    auto found = engines.find(root ? root : "");
    if (found != engines.end()) {
      e = std::move(found->second);
      engines.erase(found);
    }
  }
}

#ifdef SINGZ_TORRENT_TESTS
extern "C" void singz_torrent_test_connect(const char *root, int port) {
  std::lock_guard<std::mutex> lock(enginesMutex);
  engines.at(root)->connectTestPeer(port);
}
extern "C" int singz_torrent_test_unselected_bytes(const char *root,
                                                   int selected) {
  std::lock_guard<std::mutex> lock(enginesMutex);
  auto progress = engines.at(root)->testProgress();
  std::int64_t bytes = 0;
  for (std::size_t i = 0; i < progress.size(); ++i)
    if (int(i) != selected)
      bytes += progress[i];
  return int(bytes);
}
#endif

extern "C" const char *singz_torrent_source_stamp(void) {
  return SINGZ_TORRENT_SOURCE_STAMP;
}

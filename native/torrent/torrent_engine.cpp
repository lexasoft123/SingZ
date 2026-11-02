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
#include <optional>
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
      if ((job_ && job_->release == release && job_->index == index) ||
          std::any_of(pending_.begin(), pending_.end(),
                      [&](auto const &j) {
                        return j.release == release && j.index == index;
                      }) ||
          std::any_of(ready_.begin(), ready_.end(), [&](auto const &j) {
            return j.release == release && j.index == index;
          }))
        return status();
      if (pending_.size() + ready_.size() + (job_ ? 1 : 0) >= 200)
        throw std::runtime_error(
            "The download list is full. Remove finished downloads first");
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
      Job next;
      next.release = release;
      next.index = index;
      next.name = name;
      next.size = size;
      next.state = "queued";
      pending_.push_back(next);
      try {
        persist();
      } catch (...) {
        pending_.pop_back();
        throw;
      }
      if (!job_ && !queuePaused_)
        activateNext();
    } else if (op == "pause") {
      queuePaused_ = true;
      persist();
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
      queuePaused_ = false;
      if (!job_ && !pending_.empty())
        activateNext();
      if (!job_) {
        persist();
        return status();
      }
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
    } else if (op == "cancel" || op == "remove") {
      std::string targetRelease = release;
      int targetIndex = index;
      if (targetRelease.empty() || (op == "cancel" && targetIndex < 0)) {
        if (job_) {
          targetRelease = job_->release;
          targetIndex = job_->index;
        } else if (!pending_.empty()) {
          targetRelease = pending_.front().release;
          targetIndex = pending_.front().index;
        } else if (!ready_.empty()) {
          targetRelease = ready_.front().release;
          targetIndex = ready_.front().index;
        } else
          return status();
      }
      if (!releaseOK(targetRelease) || targetIndex < 0 || targetIndex >= 25000)
        throw std::runtime_error("Invalid download selection");
      bool active =
          job_ && job_->release == targetRelease && job_->index == targetIndex;
      auto pending = pending_, ready = ready_;
      auto old = job_ ? std::make_unique<Job>(*job_) : nullptr;
      if (active)
        job_.reset();
      auto same = [&](auto const &j) {
        return j.release == targetRelease && j.index == targetIndex;
      };
      pending_.erase(std::remove_if(pending_.begin(), pending_.end(), same),
                     pending_.end());
      ready_.erase(std::remove_if(ready_.begin(), ready_.end(), same),
                   ready_.end());
      try {
        persist();
      } catch (...) {
        pending_ = std::move(pending);
        ready_ = std::move(ready);
        job_ = std::move(old);
        throw;
      }
      if (active) {
        handle_ = {};
        session_.reset();
        fs::remove_all(root_ / "partial" / targetRelease);
        fs::remove(root_ / "resume.bencode");
      }
      fs::remove_all(root_ / "imports" /
                     (targetRelease + "-" + std::to_string(targetIndex)));
      if (!job_ && !queuePaused_)
        activateNext();
    } else if (op == "consume") {
      auto found =
          std::find_if(ready_.begin(), ready_.end(), [&](auto const &j) {
            return (release.empty() || j.release == release) &&
                   (index < 0 || j.index == index);
          });
      if (found == ready_.end() || found->state != "complete")
        throw std::runtime_error(
            "The selected song has not finished downloading");
      auto out = exportPath(*found);
      if (!fs::is_regular_file(out) ||
          fs::file_size(out) != std::uintmax_t(found->size))
        throw std::runtime_error(
            "The downloaded song is missing or incomplete");
      // Opening Add song is not an acknowledgement. Keep this original until
      // the user explicitly removes it; hosts give their importer a COPY.
      return "{\"path\":" + quote(utf8(out)) +
             ",\"name\":" + quote(found->name) +
             ",\"size\":" + std::to_string(found->size) +
             ",\"release\":" + quote(found->release) +
             ",\"index\":" + std::to_string(found->index) + "}";
    } else if (op == "queue") {
      return queueStatus();
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
    if (!handle_.is_valid())
      return testLastProgress_;
    return handle_.file_progress(lt::torrent_handle::piece_granularity);
  }
#endif
private:
  fs::path root_;
  std::mutex mutex_;
  bool stopping_ = false;
  std::thread worker_;
  std::unique_ptr<Job> job_;
  std::vector<Job> pending_, ready_;
  bool queuePaused_ = false;
  std::unique_ptr<lt::session> session_;
  lt::torrent_handle handle_;
#ifdef SINGZ_TORRENT_TESTS
  std::vector<std::int64_t> testLastProgress_;
#endif
  Clock::time_point lastSave_ = Clock::now();
  fs::path metaPath(std::string const &id) const {
    return root_ / "metadata" / (id + ".torrent");
  }
  fs::path exportPath(Job const &j) const {
    return root_ / "imports" / (j.release + "-" + std::to_string(j.index)) /
           fs::u8path(j.name);
  }
  fs::path exportPath() const { return exportPath(*job_); }
  fs::path payloadPath() const {
    return root_ / "partial" / job_->release /
           (std::to_string(job_->index) + ".payload");
  }
  static lt::entry encode(Job const &j) {
    lt::entry e;
    e["release"] = j.release;
    e["name"] = j.name;
    e["index"] = j.index;
    e["size"] = j.size;
    e["state"] = j.state;
    e["done"] = j.done;
    e["error"] = j.error;
    return e;
  }
  static Job decode(lt::bdecode_node const &e) {
    if (e.type() != lt::bdecode_node::dict_t)
      throw std::runtime_error("Invalid saved download record");
    Job j;
    j.release = std::string(e.dict_find_string_value("release"));
    j.name = std::string(e.dict_find_string_value("name"));
    auto index = e.dict_find_int_value("index", -1);
    if (index < 0 || index >= 25000)
      throw std::runtime_error("Invalid saved download index");
    j.index = int(index);
    j.size = e.dict_find_int_value("size");
    j.done = std::clamp<std::int64_t>(e.dict_find_int_value("done"), 0,
                                      std::max<std::int64_t>(0, j.size));
    j.state = std::string(e.dict_find_string_value("state"));
    j.error = std::string(e.dict_find_string_value("error"));
    if (!releaseOK(j.release) || !safeName(j.name) || !audio(j.name) ||
        j.index < 0 || j.index >= 25000 || j.size <= 0 ||
        j.size > std::int64_t(5) * 1024 * 1024 * 1024)
      throw std::runtime_error("Invalid saved download");
    return j;
  }
  void persist() {
    lt::entry e;
    e["format"] = 2;
    e["paused"] = queuePaused_ ? 1 : 0;
    if (job_)
      e["active"] = encode(*job_);
    e["pending"] = lt::entry(lt::entry::list_type{});
    e["ready"] = lt::entry(lt::entry::list_type{});
    for (auto const &j : pending_)
      e["pending"].list().push_back(encode(j));
    for (auto const &j : ready_)
      e["ready"].list().push_back(encode(j));
    std::vector<char> bytes;
    lt::bencode(std::back_inserter(bytes), e);
    atomicWrite(root_ / "queue.bencode", bytes);
    // The v1 file is only read for migration. Leaving it would resurrect a
    // removed download if the queue were ever migrated again.
    fs::remove(root_ / "job.bencode");
  }
  void activateNext() {
    if (job_ || pending_.empty() || queuePaused_)
      return;
    auto next = pending_.front();
    auto info = metadata(read(metaPath(next.release)));
    if (next.index >= info->num_files() ||
        std::string(info->files().file_name(lt::file_index_t(next.index))) !=
            next.name ||
        info->files().file_size(lt::file_index_t(next.index)) != next.size)
      throw std::runtime_error("Queued torrent metadata has changed");
    job_ = std::make_unique<Job>(next);
    pending_.erase(pending_.begin());
    persist();
    activate(info);
  }
  void archiveComplete() {
    if (!job_ || job_->state != "complete")
      return;
    auto completed = *job_;
#ifdef SINGZ_TORRENT_TESTS
    if (handle_.is_valid())
      testLastProgress_ =
          handle_.file_progress(lt::torrent_handle::piece_granularity);
#endif
    ready_.push_back(completed);
    job_.reset();
    try {
      persist();
    } catch (...) {
      ready_.pop_back();
      job_ = std::make_unique<Job>(completed);
      throw;
    }
    handle_ = {};
    session_.reset();
    fs::remove(root_ / "resume.bencode");
    fs::remove_all(root_ / "partial" / completed.release);
    if (!queuePaused_)
      activateNext();
  }
  void recoverLegacyExports() {
    auto directory = root_ / "imports";
    if (!fs::is_directory(directory))
      return;
    for (auto const &item : fs::directory_iterator(directory)) {
      try {
        if (!item.is_directory() || item.is_symlink())
          continue;
        auto key = utf8(item.path().filename());
        auto split = key.rfind('-');
        if (split == std::string::npos)
          continue;
        auto release = key.substr(0, split), number = key.substr(split + 1);
        if (!releaseOK(release) || number.empty() ||
            !std::all_of(number.begin(), number.end(),
                         [](unsigned char c) { return c >= '0' && c <= '9'; }))
          continue;
        auto selected = std::stol(number);
        if (selected < 0 || selected >= 25000)
          continue;
        bool known =
            (job_ && job_->release == release && job_->index == selected) ||
            std::any_of(ready_.begin(), ready_.end(), [&](auto const &j) {
              return j.release == release && j.index == selected;
            });
        if (known || ready_.size() + pending_.size() + (job_ ? 1 : 0) >= 200)
          continue;
        auto info = metadata(read(metaPath(release)));
        if (selected >= info->num_files())
          continue;
        auto index = lt::file_index_t(int(selected));
        Job j;
        j.release = release;
        j.index = int(selected);
        j.name = std::string(info->files().file_name(index));
        j.size = info->files().file_size(index);
        auto path = exportPath(j);
        if (!audio(j.name) || j.size <= 0 || fs::is_symlink(path) ||
            !fs::is_regular_file(path) ||
            fs::file_size(path) != std::uintmax_t(j.size))
          continue;
        j.state = "complete";
        j.done = j.size;
        ready_.push_back(j);
      } catch (...) { /* A malformed orphan must not hide other downloads. */
      }
    }
  }
  void restore() {
    auto file = root_ / "queue.bencode";
    bool migrate = !fs::exists(file);
    if (fs::exists(file)) {
      auto data = read(file, 1024 * 1024);
      lt::bdecode_node e;
      lt::error_code ec;
      lt::bdecode(data.data(), data.data() + data.size(), e, ec);
      if (ec || e.type() != lt::bdecode_node::dict_t ||
          e.dict_find_int_value("format") != 2)
        throw std::runtime_error("Cannot read the saved download queue");
      auto pending = e.dict_find_list("pending"),
           ready = e.dict_find_list("ready");
      if (!pending || !ready)
        throw std::runtime_error("Saved download queue lists are missing");
      if (pending.list_size() + ready.list_size() +
              (e.dict_find("active") ? 1 : 0) > 200)
        throw std::runtime_error("Saved download queue is too large");
      for (int i = 0; i < pending.list_size(); ++i) {
        auto j = decode(pending.list_at(i));
        j.state = "queued";
        pending_.push_back(j);
      }
      for (int i = 0; i < ready.list_size(); ++i) {
        auto j = decode(ready.list_at(i));
        if (!fs::is_regular_file(exportPath(j)) ||
            fs::file_size(exportPath(j)) != std::uintmax_t(j.size)) {
          j.state = "error";
          j.error = "The downloaded file is missing or incomplete";
        }
        ready_.push_back(j);
      }
      auto active = e.dict_find("active");
      if (active)
        job_ = std::make_unique<Job>(decode(active));
    } else if (fs::exists(root_ / "job.bencode")) {
      auto data = read(root_ / "job.bencode", 65536);
      lt::bdecode_node e;
      lt::error_code ec;
      lt::bdecode(data.data(), data.data() + data.size(), e, ec);
      if (ec || e.type() != lt::bdecode_node::dict_t)
        throw std::runtime_error("Cannot read the saved download");
      job_ = std::make_unique<Job>(decode(e));
    }
    queuePaused_ = bool(job_) || !pending_.empty();
    if (job_) {
      if (job_->state == "complete" && fs::is_regular_file(exportPath()) &&
          fs::file_size(exportPath()) == std::uintmax_t(job_->size)) {
        job_->done = job_->size;
        ready_.push_back(*job_);
        job_.reset();
      } else {
        job_->state = "paused";
        job_->speed = 0;
      }
    }
    if (migrate) {
      recoverLegacyExports();
      persist();
    }
  }
  std::string inspect(std::string const &id, std::vector<char> const &bytes) {
    if (!releaseOK(id))
      throw std::runtime_error("Invalid RuTracker release");
    auto info = metadata(bytes);
    bool queued = (job_ && job_->release == id) ||
                  std::any_of(pending_.begin(), pending_.end(),
                              [&](auto const &j) { return j.release == id; });
    if (queued &&
        metadata(read(metaPath(id)))->info_hashes() != info->info_hashes())
      throw std::runtime_error(
          "This release changed while its songs were queued");
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
    if (!job_ || job_->index < 0 || job_->index >= info->num_files() ||
        std::string(info->files().file_name(lt::file_index_t(job_->index))) !=
            job_->name ||
        info->files().file_size(lt::file_index_t(job_->index)) != job_->size)
      throw std::runtime_error(
          "Saved download does not match its torrent metadata");
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
  std::string jobStatus(Job const &stored) const {
    Job j = stored;
    if (j.state == "complete") {
      std::error_code ec;
      auto path = exportPath(j);
      if (fs::is_symlink(path, ec) || !fs::is_regular_file(path, ec) ||
          fs::file_size(path, ec) != std::uintmax_t(j.size) || ec) {
        j.state = "error";
        j.error = "The downloaded file is missing or incomplete";
      }
    }
    std::string result =
        "{\"release\":" + quote(j.release) +
        ",\"index\":" + std::to_string(j.index) + ",\"name\":" + quote(j.name) +
        ",\"size\":" + std::to_string(j.size) +
        ",\"done\":" + std::to_string(j.done) +
        ",\"speed\":" + std::to_string(j.speed) +
        ",\"state\":" + quote(j.state) + ",\"error\":" + quote(j.error);
    if (j.state == "complete")
      result += ",\"path\":" + quote(utf8(exportPath(j)));
    return result + "}";
  }
  std::string status() const {
    if (job_)
      return jobStatus(*job_);
    if (!pending_.empty())
      return jobStatus(pending_.front());
    if (!ready_.empty())
      return jobStatus(ready_.front());
    return "null";
  }
  std::string queueStatus() const {
    std::string result =
        "{\"paused\":" + std::string(queuePaused_ ? "true" : "false") +
        ",\"downloads\":[";
    bool first = true;
    auto add = [&](Job const &j) {
      if (!first)
        result += ',';
      first = false;
      result += jobStatus(j);
    };
    if (job_)
      add(*job_);
    for (auto const &j : pending_)
      add(j);
    for (auto const &j : ready_)
      add(j);
    return result + "]}";
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
      try {
        if (!job_) {
          activateNext();
          continue;
        }
        if (job_->state == "complete") {
          archiveComplete();
          continue;
        }
        if (!session_ || !handle_.is_valid())
          continue;
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
            queuePaused_ = true;
            job_->state = "error";
            job_->speed = 0;
            job_->error = "Cannot write the song. Check free space and resume";
            handle_.pause();
            persist();
          }
        }
        if (job_->state == "complete") {
          archiveComplete();
          continue;
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
          queuePaused_ = true;
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
        if (!job_) {
          queuePaused_ = true;
          try {
            persist();
          } catch (...) {
          };
          continue;
        }
        queuePaused_ = true;
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

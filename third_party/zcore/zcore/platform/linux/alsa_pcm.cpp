#include "alsa_pcm.h"

#include <libudev.h>
#include <sys/eventfd.h>
#include <time.h>
#include <unistd.h>

#include <algorithm>
#include <bit>
#include <cmath>
#include <cerrno>
#include <cstring>
#include <map>
#include <mutex>

namespace singz::detail {
static_assert(std::endian::native == std::endian::little,
              "The ALSA PCM converters currently support little-endian Linux");
uint64_t alsaMonotonicNs() noexcept {
  timespec time{};
  clock_gettime(CLOCK_MONOTONIC, &time);
  return uint64_t(time.tv_sec) * 1000000000ull + uint64_t(time.tv_nsec);
}
uint64_t alsaClockId(const std::string& uid) noexcept {
  uint64_t hash = 14695981039346656037ull;
  for (unsigned char c : uid) hash = (hash ^ c) * 1099511628211ull;
  return hash ? hash : 1;
}
namespace {
bool pcmError(int result, std::string& error) {
  if (result >= 0) return false;
  error = snd_strerror(result);
  return true;
}
uint32_t sampleWidth(snd_pcm_format_t format) noexcept {
  return uint32_t(snd_pcm_format_physical_width(format)) / 8;
}
std::mutex inventoryMutex;
// Keep last proven capability facts when an active exclusive stream makes a
// transient discovery open return EBUSY. Removed endpoints still disappear
// because every enumeration begins with the ALSA control-device list.
std::map<std::string, AudioHostDeviceInfo> capabilities;
void probe(const std::string& pcm, bool input, AudioHostDeviceInfo& info) {
  snd_pcm_t* handle = nullptr;
  if (snd_pcm_open(&handle, pcm.c_str(), input ? SND_PCM_STREAM_CAPTURE :
      SND_PCM_STREAM_PLAYBACK, SND_PCM_NONBLOCK) < 0) return;
  snd_pcm_hw_params_t* params = nullptr;
  snd_pcm_hw_params_alloca(&params);
  if (snd_pcm_hw_params_any(handle, params) >= 0) {
    unsigned channels = 0;
    if (snd_pcm_hw_params_get_channels_max(params, &channels) >= 0) {
      channels = std::min(channels, kAudioHostMaxChannels);
      if (input) info.inputChannels = channels;
      else info.outputChannels = channels;
    }
    if (snd_pcm_hw_params_test_rate(handle, params, 48000, 0) == 0)
      info.nominalSampleRate = 48000;
    else {
      unsigned rate = 0;
      int direction = 0;
      if (snd_pcm_hw_params_get_rate_min(params, &rate, &direction) == 0)
        info.nominalSampleRate = rate;
    }
    snd_pcm_uframes_t minimum = 0, maximum = 0;
    int direction = 0;
    if (snd_pcm_hw_params_get_period_size_min(params, &minimum, &direction) == 0 &&
        snd_pcm_hw_params_get_period_size_max(params, &maximum, &direction) == 0) {
      minimum = std::max<snd_pcm_uframes_t>(1, minimum);
      maximum = std::min<snd_pcm_uframes_t>(kAudioHostMaxFrames, maximum);
      if (minimum <= maximum) {
        info.bufferFrames = {uint32_t(minimum), uint32_t(maximum),
            uint32_t(std::clamp<snd_pcm_uframes_t>(256, minimum, maximum)), 0};
      }
    }
  }
  snd_pcm_close(handle);
}
}

std::vector<AlsaEndpoint> alsaEndpoints() {
  std::lock_guard<std::mutex> lock(inventoryMutex);
  std::vector<AlsaEndpoint> result;
  udev* context = udev_new();
  int card = -1;
  while (snd_card_next(&card) >= 0 && card >= 0) {
    snd_ctl_t* control = nullptr;
    const std::string cardName = "hw:" + std::to_string(card);
    if (snd_ctl_open(&control, cardName.c_str(), SND_CTL_NONBLOCK) < 0) continue;
    snd_ctl_card_info_t* cardInfo = nullptr;
    snd_ctl_card_info_alloca(&cardInfo);
    if (snd_ctl_card_info(control, cardInfo) < 0) {
      snd_ctl_close(control);
      continue;
    }
    std::string identity = "id:" + std::string(snd_ctl_card_info_get_id(cardInfo));
    AudioHostTransport transport = AudioHostTransport::Unknown;
    udev_device* device = context ? udev_device_new_from_subsystem_sysname(
        context, "sound", ("card" + std::to_string(card)).c_str()) : nullptr;
    if (device) {
      const char* serial = udev_device_get_property_value(device, "ID_SERIAL");
      const char* shortSerial = udev_device_get_property_value(device, "ID_SERIAL_SHORT");
      const char* path = udev_device_get_property_value(device, "ID_PATH");
      auto* usb = udev_device_get_parent_with_subsystem_devtype(device, "usb", "usb_device");
      if (serial && *serial && shortSerial && *shortSerial)
        identity = "serial:" + std::string(serial);
      else if (path && *path) identity = "path:" + std::string(path);
      else if (usb) identity = "sysfs:" + std::string(udev_device_get_syspath(usb));
      // USB interfaces without a serial must be pinned to their physical port.
      if (usb) transport = AudioHostTransport::Usb;
      else if (udev_device_get_parent_with_subsystem_devtype(device, "pci", nullptr))
        transport = AudioHostTransport::Pci;
      udev_device_unref(device);
    }
    const std::string driver = snd_ctl_card_info_get_driver(cardInfo);
    if (driver == "Loopback") transport = AudioHostTransport::Virtual;
    int pcmDevice = -1;
    while (snd_ctl_pcm_next_device(control, &pcmDevice) >= 0 && pcmDevice >= 0) {
      AlsaEndpoint row;
      row.info.uid = "alsa:" + identity + ":pcm:" + std::to_string(pcmDevice);
      row.pcm = "hw:" + std::to_string(card) + "," + std::to_string(pcmDevice) + ",0";
      const auto cached = capabilities.find(row.info.uid);
      if (cached != capabilities.end()) row.info = cached->second;
      row.info.label = std::string(snd_ctl_card_info_get_name(cardInfo)) +
          " / PCM " + std::to_string(pcmDevice);
      row.info.transport = transport;
      row.info.accessMode = AudioHostAccessMode::Exclusive;
      snd_pcm_info_t* pcmInfo = nullptr;
      snd_pcm_info_alloca(&pcmInfo);
      snd_pcm_info_set_device(pcmInfo, unsigned(pcmDevice));
      snd_pcm_info_set_subdevice(pcmInfo, 0);
      snd_pcm_info_set_stream(pcmInfo, SND_PCM_STREAM_CAPTURE);
      const bool input = snd_ctl_pcm_info(control, pcmInfo) >= 0;
      snd_pcm_info_set_stream(pcmInfo, SND_PCM_STREAM_PLAYBACK);
      const bool output = snd_ctl_pcm_info(control, pcmInfo) >= 0;
      if (input) probe(row.pcm, true, row.info);
      else row.info.inputChannels = 0;
      if (output) probe(row.pcm, false, row.info);
      else row.info.outputChannels = 0;
      row.info.direction = input && output ? AudioHostEndpointDirection::Duplex :
          input ? AudioHostEndpointDirection::Input : AudioHostEndpointDirection::Output;
      // A direct wired/loopback duplex PCM permits the bounded monitor path.
      // This is a provider routing capability, not measured acoustic latency.
      row.info.monitoringSuitability = input && output &&
          row.info.bufferFrames.preferredFrames != 0 &&
          (transport == AudioHostTransport::Usb ||
           transport == AudioHostTransport::Pci ||
           transport == AudioHostTransport::Virtual)
          ? AudioHostMonitoringSuitability::LowLatency
          : AudioHostMonitoringSuitability::Unknown;
      if (input || output) {
        capabilities[row.info.uid] = row.info;
        result.push_back(std::move(row));
      }
    }
    snd_ctl_close(control);
  }
  if (context) udev_unref(context);
  // Ambiguous stable identities are unusable. Never silently select a sibling
  // interface with an identical serial/card identity after reconnect.
  std::map<std::string, uint32_t> counts;
  for (const auto& row : result) ++counts[row.info.uid];
  std::erase_if(capabilities, [&](const auto& row) { return !counts.contains(row.first); });
  std::erase_if(result, [&](const auto& row) { return counts[row.info.uid] != 1; });
  alsaUniqueDefaults(result);
  return result;
}

void alsaUniqueDefaults(std::vector<AlsaEndpoint>& endpoints) noexcept {
  size_t inputs = 0, outputs = 0;
  for (const auto& row : endpoints) {
    if (row.info.inputChannels) ++inputs;
    if (row.info.outputChannels) ++outputs;
  }
  for (auto& row : endpoints) {
    row.info.defaultInput = inputs == 1 && row.info.inputChannels != 0;
    row.info.defaultOutput = outputs == 1 && row.info.outputChannels != 0;
  }
}

AlsaPcm::~AlsaPcm() { close(); }
uint32_t AlsaPcm::sampleBytes() const noexcept { return sampleWidth(sampleFormat); }
void AlsaPcm::close() noexcept {
  if (handle) snd_pcm_close(handle);
  handle = nullptr;
  if (wakeFd >= 0) ::close(wakeFd);
  wakeFd = -1;
  descriptors.clear();
}
bool AlsaPcm::open(const std::string& name, bool capture, uint32_t needed,
                   uint32_t requestedRate, uint32_t requestedPeriod,
                   uint32_t maximumFrames, std::string& error) {
  close();
  if (!needed || needed > kAudioHostMaxChannels || !requestedRate ||
      !requestedPeriod || requestedPeriod > maximumFrames ||
      maximumFrames > kAudioHostMaxFrames) {
    error = "Invalid ALSA stream dimensions";
    return false;
  }
  if (pcmError(snd_pcm_open(&handle, name.c_str(), capture ?
      SND_PCM_STREAM_CAPTURE : SND_PCM_STREAM_PLAYBACK,
      SND_PCM_NONBLOCK | SND_PCM_NO_AUTO_RESAMPLE | SND_PCM_NO_AUTO_CHANNELS |
      SND_PCM_NO_AUTO_FORMAT), error)) return false;
  snd_pcm_hw_params_t* params = nullptr;
  snd_pcm_hw_params_alloca(&params);
  auto fail = [&](int code) {
    if (!pcmError(code, error)) return false;
    close(); return true;
  };
  if (fail(snd_pcm_hw_params_any(handle, params)) ||
      fail(snd_pcm_hw_params_set_access(handle, params, SND_PCM_ACCESS_RW_INTERLEAVED)))
    return false;
  channels = std::max(2u, needed);
  // Intersect rate and channel requirements before selecting a format. A
  // format advertised by hw_params_any may be unavailable at this rate/map.
  if (fail(snd_pcm_hw_params_set_rate(handle, params, requestedRate, 0)) ||
      fail(snd_pcm_hw_params_set_channels_near(handle, params, &channels)))
    return false;
  sampleFormat = SND_PCM_FORMAT_UNKNOWN;
  for (auto format : {SND_PCM_FORMAT_FLOAT_LE, SND_PCM_FORMAT_S32_LE,
       SND_PCM_FORMAT_S24_3LE, SND_PCM_FORMAT_S24_LE, SND_PCM_FORMAT_S16_LE}) {
    if (snd_pcm_hw_params_test_format(handle, params, format) == 0) {
      sampleFormat = format; break;
    }
  }
  if (sampleFormat == SND_PCM_FORMAT_UNKNOWN) {
    error = "ALSA endpoint exposes no supported PCM format"; close(); return false;
  }
  snd_pcm_uframes_t frames = requestedPeriod;
  int direction = 0;
  if (fail(snd_pcm_hw_params_set_format(handle, params, sampleFormat)) ||
      fail(snd_pcm_hw_params_set_period_size_near(handle, params, &frames, &direction)))
    return false;
  if (channels < needed || channels > kAudioHostMaxChannels ||
      !frames || frames > maximumFrames) {
    error = "Negotiated ALSA channel/period limits are incompatible";
    close(); return false;
  }
  period = uint32_t(frames);
  frames = snd_pcm_uframes_t(period) * 4;
  if (fail(snd_pcm_hw_params_set_buffer_size_near(handle, params, &frames)) ||
      fail(snd_pcm_hw_params(handle, params))) return false;
  snd_pcm_uframes_t actualPeriod = 0;
  unsigned actualRate = 0;
  if (fail(snd_pcm_hw_params_get_period_size(params, &actualPeriod, &direction)) ||
      fail(snd_pcm_hw_params_get_buffer_size(params, &frames)) ||
      fail(snd_pcm_hw_params_get_rate(params, &actualRate, &direction)) ||
      fail(snd_pcm_hw_params_get_channels(params, &channels))) return false;
  if (!actualPeriod || actualPeriod > maximumFrames || actualRate != requestedRate ||
      channels < needed || channels > kAudioHostMaxChannels) {
    error = "Committed ALSA format does not match the bounded request";
    close(); return false;
  }
  period = uint32_t(actualPeriod);
  if (frames < period * 2 || frames > uint64_t(period) * 16) {
    error = "ALSA ring buffer is outside the bounded operating range";
    close(); return false;
  }
  rate = requestedRate;
  buffer = uint32_t(frames);
  snd_pcm_sw_params_t* software = nullptr;
  snd_pcm_sw_params_alloca(&software);
  snd_pcm_uframes_t boundary = 0;
  if (fail(snd_pcm_sw_params_current(handle, software)) ||
      fail(snd_pcm_sw_params_get_boundary(software, &boundary)) ||
      fail(snd_pcm_sw_params_set_start_threshold(handle, software, boundary)) ||
      fail(snd_pcm_sw_params_set_avail_min(handle, software, period)) ||
      fail(snd_pcm_sw_params(handle, software))) return false;
  const int count = snd_pcm_poll_descriptors_count(handle);
  if (count <= 0 || count > 64) {
    error = "ALSA returned an invalid polling descriptor count";
    close(); return false;
  }
  descriptors.resize(size_t(count) + 1);
  const int described = snd_pcm_poll_descriptors(handle, descriptors.data(), unsigned(count));
  if (described != count) {
    error = described < 0 ? snd_strerror(described) : "Incomplete ALSA poll descriptor set";
    close(); return false;
  }
  wakeFd = eventfd(0, EFD_NONBLOCK | EFD_CLOEXEC);
  if (wakeFd < 0) { error = std::strerror(errno); close(); return false; }
  descriptors.back() = {wakeFd, POLLIN, 0};
  return true;
}
void AlsaPcm::wake() noexcept {
  const uint64_t value = 1;
  if (wakeFd < 0) return;
  ssize_t written;
  do { written = ::write(wakeFd, &value, sizeof(value)); }
  while (written < 0 && errno == EINTR);
  // EAGAIN means the eventfd already contains a pending wake.
}
void AlsaPcm::clearWake() noexcept {
  uint64_t value = 0;
  if (wakeFd >= 0) while (::read(wakeFd, &value, sizeof(value)) > 0) {}
}
int AlsaPcm::wait() noexcept {
  const int result = ::poll(descriptors.data(), descriptors.size(), 100);
  if (result < 0) return errno == EINTR ? 0 : -errno;
  if (!result || (descriptors.back().revents & POLLIN)) return 0;
  unsigned short events = 0;
  const int decoded = snd_pcm_poll_descriptors_revents(handle, descriptors.data(),
      unsigned(descriptors.size() - 1), &events);
  if (decoded < 0) return decoded;
  if (events & (POLLNVAL | POLLHUP)) return -ENODEV;
  return events ? 1 : 0;
}

uint32_t alsaDecode(const unsigned char* source, float* target, uint32_t count,
                snd_pcm_format_t format) noexcept {
  const uint32_t bytes = sampleWidth(format);
  uint32_t invalid = 0;
  for (uint32_t i = 0; i < count; ++i, source += bytes) {
    float value = 0;
    if (format == SND_PCM_FORMAT_FLOAT_LE) std::memcpy(&value, source, 4);
    else {
      uint32_t bits = source[0] | uint32_t(source[1]) << 8;
      if (bytes >= 3) bits |= uint32_t(source[2]) << 16;
      if (bytes == 4) bits |= uint32_t(source[3]) << 24;
      if (format == SND_PCM_FORMAT_S16_LE)
        value = float(int16_t(bits)) / 32768.0f;
      else if (format == SND_PCM_FORMAT_S32_LE)
        value = float(int32_t(bits)) / 2147483648.0f;
      else {
        bits &= 0x00ffffffu; // S24_LE's fourth byte is padding, not sample data.
        if (bits & 0x800000u) bits |= 0xff000000u;
        value = float(int32_t(bits)) / 8388608.0f;
      }
    }
    if (!std::isfinite(value)) { value = 0; ++invalid; }
    target[i] = value;
  }
  return invalid;
}
uint32_t alsaEncode(const float* source, unsigned char* target, uint32_t count,
                snd_pcm_format_t format) noexcept {
  const uint32_t bytes = sampleWidth(format);
  uint32_t invalid = 0;
  for (uint32_t i = 0; i < count; ++i, target += bytes) {
    if (!std::isfinite(source[i])) ++invalid;
    const float value = std::isfinite(source[i]) ? std::clamp(source[i], -1.0f, 1.0f) : 0;
    if (format == SND_PCM_FORMAT_FLOAT_LE) std::memcpy(target, &value, 4);
    else {
      const int bits = format == SND_PCM_FORMAT_S16_LE ? 16 :
          format == SND_PCM_FORMAT_S32_LE ? 32 : 24;
      const double scale = std::ldexp(1.0, bits - 1);
      const int32_t sample = int32_t(std::clamp(double(value) * scale, -scale, scale - 1));
      const uint32_t encoded = uint32_t(sample);
      for (uint32_t byte = 0; byte < bytes; ++byte)
        target[byte] = static_cast<unsigned char>(encoded >> (byte * 8));
    }
  }
  return invalid;
}
}  // namespace singz::detail

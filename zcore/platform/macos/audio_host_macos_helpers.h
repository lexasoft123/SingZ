#pragma once

#include <cmath>
#include <cstdint>
#include <limits>

#include <zcore/device/audio_host.h>

namespace singz::detail {

constexpr uint32_t audioHostFourCc(char a, char b, char c, char d) noexcept {
  return (static_cast<uint32_t>(static_cast<uint8_t>(a)) << 24u) |
         (static_cast<uint32_t>(static_cast<uint8_t>(b)) << 16u) |
         (static_cast<uint32_t>(static_cast<uint8_t>(c)) << 8u) |
         static_cast<uint32_t>(static_cast<uint8_t>(d));
}

struct MacAudioHostTransportCapability {
  AudioHostTransport transport{AudioHostTransport::Unknown};
  AudioHostMonitoringSuitability monitoringSuitability{
      AudioHostMonitoringSuitability::Unknown};
};

inline MacAudioHostTransportCapability classifyMacAudioHostTransport(
    uint32_t value) noexcept {
  switch (value) {
    case audioHostFourCc('b', 'l', 't', 'n'):
      return {AudioHostTransport::BuiltIn,
              AudioHostMonitoringSuitability::LowLatency};
    case audioHostFourCc('p', 'c', 'i', ' '):
      return {AudioHostTransport::Pci,
              AudioHostMonitoringSuitability::LowLatency};
    case audioHostFourCc('u', 's', 'b', ' '):
      return {AudioHostTransport::Usb,
              AudioHostMonitoringSuitability::LowLatency};
    case audioHostFourCc('1', '3', '9', '4'):
      return {AudioHostTransport::FireWire,
              AudioHostMonitoringSuitability::LowLatency};
    case audioHostFourCc('t', 'h', 'u', 'n'):
      return {AudioHostTransport::Thunderbolt,
              AudioHostMonitoringSuitability::LowLatency};
    case audioHostFourCc('c', 'c', 'w', 'd'):
      return {AudioHostTransport::ContinuityWired,
              AudioHostMonitoringSuitability::LowLatency};
    case audioHostFourCc('h', 'd', 'm', 'i'):
      return {AudioHostTransport::Hdmi,
              AudioHostMonitoringSuitability::LowLatency};
    case audioHostFourCc('d', 'p', 'r', 't'):
      return {AudioHostTransport::DisplayPort,
              AudioHostMonitoringSuitability::LowLatency};
    case audioHostFourCc('b', 'l', 'u', 'e'):
      return {AudioHostTransport::Bluetooth,
              AudioHostMonitoringSuitability::HighLatency};
    case audioHostFourCc('b', 'l', 'e', 'a'):
      return {AudioHostTransport::BluetoothLowEnergy,
              AudioHostMonitoringSuitability::HighLatency};
    case audioHostFourCc('a', 'i', 'r', 'p'):
      return {AudioHostTransport::AirPlay,
              AudioHostMonitoringSuitability::HighLatency};
    case audioHostFourCc('c', 'c', 'w', 'l'):
    case audioHostFourCc('c', 'c', 'a', 'p'):
      return {AudioHostTransport::ContinuityWireless,
              AudioHostMonitoringSuitability::HighLatency};
    case audioHostFourCc('g', 'r', 'u', 'p'):
    case audioHostFourCc('f', 'g', 'r', 'p'):
      return {AudioHostTransport::Aggregate,
              AudioHostMonitoringSuitability::Unknown};
    case audioHostFourCc('v', 'i', 'r', 't'):
      return {AudioHostTransport::Virtual,
              AudioHostMonitoringSuitability::Unknown};
    case audioHostFourCc('e', 'a', 'v', 'b'):
      return {AudioHostTransport::Avb,
              AudioHostMonitoringSuitability::Unknown};
    default:
      return {};
  }
}

inline uint32_t saturatedAudioHostLatency(uint32_t deviceFrames,
                                          uint32_t safetyFrames) noexcept {
  const uint64_t total = static_cast<uint64_t>(deviceFrames) + safetyFrames;
  return total > std::numeric_limits<uint32_t>::max()
             ? std::numeric_limits<uint32_t>::max()
             : static_cast<uint32_t>(total);
}

inline bool checkedAudioHostFrameCount(double value, uint32_t* result) noexcept {
  if (result == nullptr || !std::isfinite(value) || value < 0.0 ||
      value > static_cast<double>(std::numeric_limits<uint32_t>::max()) ||
      std::floor(value) != value) {
    return false;
  }
  *result = static_cast<uint32_t>(value);
  return true;
}

inline bool checkedAudioHostBufferRange(double minimum, double maximum,
                                        uint32_t* minimumFrames,
                                        uint32_t* maximumFrames) noexcept {
  if (minimumFrames == nullptr || maximumFrames == nullptr) return false;
  uint32_t checkedMinimum = 0;
  uint32_t checkedMaximum = 0;
  if (!checkedAudioHostFrameCount(minimum, &checkedMinimum) ||
      !checkedAudioHostFrameCount(maximum, &checkedMaximum) ||
      checkedMinimum > checkedMaximum) {
    return false;
  }
  *minimumFrames = checkedMinimum;
  *maximumFrames = checkedMaximum;
  return true;
}

}  // namespace singz::detail

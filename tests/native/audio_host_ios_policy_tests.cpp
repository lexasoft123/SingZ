#include <zcore/device/audio_host.h>

#include <cstdio>
#include <cstdlib>
#include <string>

#include "zcore/platform/ios/audio_host_ios_helpers.h"

#define CHECK(expression)                                                      \
  do {                                                                         \
    if (!(expression)) {                                                       \
      std::fprintf(stderr, "CHECK failed at %s:%d: %s\n", __FILE__, __LINE__, \
                   #expression);                                               \
      std::abort();                                                            \
    }                                                                          \
  } while (false)

namespace {

using singz::detail::IosAudioHostPortKind;
using singz::detail::IosAudioHostPreparedRoute;
using singz::detail::IosAudioHostSessionSnapshot;

IosAudioHostSessionSnapshot outputSession() {
  IosAudioHostSessionSnapshot snapshot;
  snapshot.routeGeneration = 11;
  snapshot.category = "AVAudioSessionCategoryPlayback";
  snapshot.mode = "AVAudioSessionModeDefault";
  snapshot.outputActive = true;
  snapshot.outputUid = "ios-output:speaker";
  snapshot.outputChannels = 2;
  snapshot.outputKind = IosAudioHostPortKind::BuiltIn;
  snapshot.sampleRate = 48000.0;
  snapshot.ioBufferDurationSeconds = 128.0 / 48000.0;
  snapshot.outputLatencySeconds = 53.25 / 48000.0;
  return snapshot;
}

singz::AudioHostConfig outputConfig() {
  singz::AudioHostConfig config;
  config.outputDeviceUid = "ios-output:speaker";
  config.outputChannels = {0, 1};
  config.requestedSampleRate = 48000.0;
  config.requestedBufferFrames = 128;
  config.maximumFrames = 1024;
  return config;
}

void testOutputOnlyFacts() {
  const auto snapshot = outputSession();
  const auto config = outputConfig();
  IosAudioHostPreparedRoute route;
  std::string error;
  CHECK(singz::detail::prepareIosAudioHostRoute(config, snapshot, &route,
                                                error));
  CHECK(error.empty());
  CHECK(route.format.sampleRate == 48000.0);
  CHECK(route.format.nominalBufferFrames == 128);
  CHECK(route.format.maximumFrames == 1024);
  CHECK(route.format.inputChannels == 0);
  CHECK(route.format.outputChannels == 2);
  CHECK(route.format.float32Planar);
  CHECK(route.format.outputClockMaster);
  CHECK(route.latency.inputDeviceFrames == 0);
  CHECK(route.latency.outputDeviceFrames == 53);
  CHECK(route.latency.bufferFrames == 128);
  CHECK(route.latency.externalRouteFrames == 0);
  CHECK(route.outputChannelMap.size() == 2);
  CHECK(route.outputChannelMap[0] == 0);
  CHECK(route.outputChannelMap[1] == 1);
  CHECK(route.transport == singz::AudioHostTransport::BuiltIn);
  CHECK(route.monitoringSuitability ==
        singz::AudioHostMonitoringSuitability::LowLatency);
}

void testProviderMaximumFrames() {
  CHECK(singz::detail::validIosAudioHostMaximumFrames(128, 128, 1024));
  CHECK(singz::detail::validIosAudioHostMaximumFrames(1024, 128, 1024));
  CHECK(!singz::detail::validIosAudioHostMaximumFrames(127, 128, 1024));
  CHECK(!singz::detail::validIosAudioHostMaximumFrames(1025, 128, 1024));
  CHECK(!singz::detail::validIosAudioHostMaximumFrames(0, 128, 1024));
  CHECK(!singz::detail::validIosAudioHostMaximumFrames(128, 0, 1024));
}

void testSparseOutputMapAndExternalLatency() {
  auto snapshot = outputSession();
  snapshot.outputChannels = 8;
  snapshot.outputKind = IosAudioHostPortKind::BluetoothA2dp;
  snapshot.outputLatencySeconds = 0.137;
  auto config = outputConfig();
  config.outputChannels = {6, 7};
  IosAudioHostPreparedRoute route;
  std::string error;
  CHECK(singz::detail::prepareIosAudioHostRoute(config, snapshot, &route,
                                                error));
  CHECK(route.outputChannelMap.size() == 8);
  for (uint32_t index = 0; index < 6; ++index) {
    CHECK(route.outputChannelMap[index] == -1);
  }
  CHECK(route.outputChannelMap[6] == 0);
  CHECK(route.outputChannelMap[7] == 1);
  CHECK(route.latency.outputDeviceFrames == 0);
  CHECK(route.latency.externalRouteFrames == 6576);
  CHECK(route.monitoringSuitability ==
        singz::AudioHostMonitoringSuitability::HighLatency);
}

void testPreparedDuplex() {
  auto snapshot = outputSession();
  snapshot.category = "AVAudioSessionCategoryPlayAndRecord";
  snapshot.mode = "AVAudioSessionModeMeasurement";
  snapshot.inputActive = true;
  snapshot.recordCapable = true;
  snapshot.inputUid = "ios:usb-mic";
  snapshot.inputChannels = 8;
  snapshot.inputKind = IosAudioHostPortKind::Usb;
  snapshot.inputLeaseActive = true;
  snapshot.inputLeaseToken = 91;
  snapshot.inputRouteGeneration = 22;
  snapshot.inputLeaseRouteGeneration = 22;
  snapshot.inputLeaseUid = "ios:usb-mic";
  snapshot.inputLeaseMinimumChannels = 8;
  snapshot.inputLatencySeconds = 23.2 / 48000.0;
  auto config = outputConfig();
  config.inputDeviceUid = "ios:usb-mic";
  config.inputChannels = {2, 5};
  IosAudioHostPreparedRoute route;
  std::string error;
  CHECK(singz::detail::prepareIosAudioHostRoute(config, snapshot, &route,
                                                error));
  CHECK(route.format.inputChannels == 2);
  CHECK(route.inputChannelMap.size() == 2);
  CHECK(route.inputChannelMap[0] == 2);
  CHECK(route.inputChannelMap[1] == 5);
  CHECK(route.latency.inputDeviceFrames == 23);

  snapshot.inputLeaseRouteGeneration++;
  CHECK(!singz::detail::prepareIosAudioHostRoute(config, snapshot, &route,
                                                 error));
  CHECK(error.find("prepared session lease") != std::string::npos);
}

void testFailClosedPolicy() {
  IosAudioHostPreparedRoute route;
  std::string error;
  singz::AudioHostError errorCode = singz::AudioHostError::None;
  auto snapshot = outputSession();
  auto config = outputConfig();

  config.outputDeviceUid = "ios-output:missing";
  CHECK(!singz::detail::prepareIosAudioHostRoute(
      config, snapshot, &route, error, &errorCode));
  CHECK(errorCode == singz::AudioHostError::DeviceNotFound);
  config = outputConfig();

  config.outputChannels = {1, 1};
  CHECK(!singz::detail::prepareIosAudioHostRoute(config, snapshot, &route,
                                                 error));
  config = outputConfig();
  config.requestedSampleRate = 44100.0;
  CHECK(!singz::detail::prepareIosAudioHostRoute(config, snapshot, &route,
                                                 error));
  config = outputConfig();
  config.requestedBufferFrames = 256;
  CHECK(!singz::detail::prepareIosAudioHostRoute(config, snapshot, &route,
                                                 error));
  config = outputConfig();
  config.maximumFrames = 64;
  CHECK(!singz::detail::prepareIosAudioHostRoute(config, snapshot, &route,
                                                 error));
  config = outputConfig();
  config.exclusive = true;
  CHECK(!singz::detail::prepareIosAudioHostRoute(config, snapshot, &route,
                                                 error));
  config = outputConfig();
  config.inputDeviceUid = "ios:mic";
  CHECK(!singz::detail::prepareIosAudioHostRoute(config, snapshot, &route,
                                                 error));

  snapshot = outputSession();
  snapshot.category = "AVAudioSessionCategoryPlayAndRecord";
  snapshot.inputActive = true;
  snapshot.recordCapable = true;
  snapshot.inputUid = "ios:usb-mic";
  snapshot.inputChannels = 2;
  snapshot.inputLeaseActive = true;
  snapshot.inputLeaseToken = 1;
  snapshot.inputRouteGeneration = 3;
  snapshot.inputLeaseRouteGeneration = 3;
  snapshot.inputLeaseUid = "ios:usb-mic";
  snapshot.inputLeaseMinimumChannels = 2;
  config = outputConfig();
  config.inputDeviceUid = "ios:other-mic";
  config.inputChannels = {0};
  CHECK(!singz::detail::prepareIosAudioHostRoute(
      config, snapshot, &route, error, &errorCode));
  CHECK(errorCode == singz::AudioHostError::DeviceNotFound);

  config.inputDeviceUid = "ios:usb-mic";
  snapshot.inputLeaseUid = "ios:stale-mic";
  CHECK(!singz::detail::prepareIosAudioHostRoute(
      config, snapshot, &route, error, &errorCode));
  CHECK(errorCode == singz::AudioHostError::InvalidConfiguration);
}

void testSessionIdentity() {
  const auto before = outputSession();
  auto after = before;
  CHECK(singz::detail::sameIosAudioHostSession(before, after));
  after.routeGeneration++;
  CHECK(!singz::detail::sameIosAudioHostSession(before, after));
  after = before;
  after.sampleRate = 44100.0;
  CHECK(!singz::detail::sameIosAudioHostSession(before, after));
  after = before;
  after.outputUid = "ios-output:headphones";
  CHECK(!singz::detail::sameIosAudioHostSession(before, after));
  after = before;
  after.categoryOptions = 1;
  CHECK(!singz::detail::sameIosAudioHostSession(before, after));
}

void testTransportDoesNotGuess() {
  CHECK(singz::detail::iosAudioHostTransport(
            IosAudioHostPortKind::Wired) ==
        singz::AudioHostTransport::Unknown);
  CHECK(singz::detail::iosAudioHostMonitoringSuitability(
            IosAudioHostPortKind::Wired) ==
        singz::AudioHostMonitoringSuitability::LowLatency);
  CHECK(singz::detail::iosAudioHostTransport(
            IosAudioHostPortKind::CarAudio) ==
        singz::AudioHostTransport::Vehicle);
}

}  // namespace

int main() {
  testOutputOnlyFacts();
  testProviderMaximumFrames();
  testSparseOutputMapAndExternalLatency();
  testPreparedDuplex();
  testFailClosedPolicy();
  testSessionIdentity();
  testTransportDoesNotGuess();
  std::puts("audio_host_ios_policy_tests passed");
  return 0;
}

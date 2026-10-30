#include "zdsp/prototype_gain_meter.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#if defined(__APPLE__)
#include <sys/types.h>
#include <sys/sysctl.h>
#endif

namespace {

#define SINGZ_STRINGIZE_DETAIL(value) #value
#define SINGZ_STRINGIZE(value) SINGZ_STRINGIZE_DETAIL(value)

std::string cpuDescription() {
#if defined(__APPLE__)
  char value[256]{};
  size_t size = sizeof(value);
  if (sysctlbyname("machdep.cpu.brand_string", value, &size, nullptr, 0) == 0 && value[0] != '\0') return value;
  size = sizeof(value);
  if (sysctlbyname("hw.model", value, &size, nullptr, 0) == 0 && value[0] != '\0') return value;
#endif
  return "unavailable";
}

const char* compilerDescription() {
#if defined(__clang__)
  return __clang_version__;
#elif defined(_MSC_VER)
  return "MSVC " SINGZ_STRINGIZE(_MSC_VER);
#elif defined(__GNUC__)
  return __VERSION__;
#else
  return "unavailable";
#endif
}

void printJsonString(const std::string& value) {
  std::putchar('"');
  for (const char character : value) {
    if (character == '"' || character == '\\') std::putchar('\\');
    if (static_cast<unsigned char>(character) >= 0x20) std::putchar(character);
  }
  std::putchar('"');
}

}  // namespace

int main() {
  using namespace zdsp;
  alignas(PrototypeGainMeterState) uint8_t storage[sizeof(PrototypeGainMeterState)]{};
  PreparedStorage prepared{storage, sizeof(storage), alignof(PrototypeGainMeterState)};
  const ProcessorHandle processor = makePrototypeGainMeter({{1}, .75f}, prepared);
  const AudioBusDescriptor stereo{2, SampleFormat::Float32Planar, AudioChannelLayout::Stereo, nullptr};
  const PrepareSpec spec{kProcessorInterfaceVersion, kPrepareSpecV1RequiredSize, {48000.0}, {256},
                         1, 1, &stereo, &stereo};
  PrototypeFakeHost host{};
  if (!succeeded(preparePrototypeFakeHost(&host, processor, spec))) return 2;
  float inputSamples[2][256]{}; float outputSamples[2][256]{};
  uint32_t random = 0x243f6a88u;
  for (auto& channel : inputSamples) {
    for (float& sample : channel) {
      random = random * 1664525u + 1013904223u;
      sample = static_cast<float>(static_cast<int32_t>(random >> 8)) / 8388608.0f;
    }
  }
  const float* inputChannels[]{inputSamples[0], inputSamples[1]};
  float* outputChannels[]{outputSamples[0], outputSamples[1]};
  constexpr uint32_t batches = 2000;
  constexpr uint32_t callsPerBatch = 256;
  constexpr uint32_t warmupCalls = 10000;
  const double deadlineNs = 64.0 / 48000.0 * 1.0e9;
  struct Result { double p50; double p95; double p99; double maximum; uint32_t deadlineMisses; };
  double checksum = 0.0;
  const auto measure = [&](auto&& callback, double callbackDeadlineNs) {
    for (uint32_t warmup = 0; warmup < warmupCalls; ++warmup) checksum += callback(warmup);
    std::vector<double> ns; ns.reserve(batches);
    uint32_t deadlineMisses = 0;
    for (uint32_t batch = 0; batch < batches; ++batch) {
      const auto begin = std::chrono::steady_clock::now();
      for (uint32_t call = 0; call < callsPerBatch; ++call) checksum += callback(call);
      const auto end = std::chrono::steady_clock::now();
      const double batchNs = std::chrono::duration<double, std::nano>(end - begin).count();
      ns.push_back(batchNs / callsPerBatch);
      if (callbackDeadlineNs > 0.0 && batchNs > callbackDeadlineNs * callsPerBatch) ++deadlineMisses;
    }
    std::sort(ns.begin(), ns.end());
    const auto percentile = [&](double p) { return ns[static_cast<size_t>(p * (batches - 1))]; };
    return Result{percentile(.50), percentile(.95), percentile(.99), ns.back(), deadlineMisses};
  };

  ConstAudioBusView emptyInput{nullptr, 2, {0}, {256}, nullptr};
  MutableAudioBusView emptyOutput{nullptr, 2, {0}, {256}};
  const Result harness = measure([](uint32_t call) { return static_cast<double>(call & 1u) * 1.0e-30; }, 0.0);
  const Result runner = measure([&](uint32_t) {
    if (!succeeded(processPrototypeBlock(&host, emptyInput, emptyOutput, nullptr, 0,
                                         {DiscontinuityReason::None, 0}))) std::abort();
    return static_cast<double>(prototypeMeter(host.processor).endFrame.value & 1u) * 1.0e-30;
  }, deadlineNs);
  ConstAudioBusView input{inputChannels, 2, {64}, {256}, nullptr};
  MutableAudioBusView output{outputChannels, 2, {64}, {256}};
  const ParameterEvent automation[]{{{1}, kPrototypeGainParameter, {0}, .3f, ParameterCurve::Linear, {16}},
                                    {{1}, kPrototypeGainParameter, {32}, .8f, ParameterCurve::Linear, {16}}};
  const Result graph = measure([&](uint32_t call) {
    if (!succeeded(processPrototypeBlock(&host, input, output, automation, 2,
                                         {DiscontinuityReason::None, 0}))) std::abort();
    const PrototypeMeterResult meter = prototypeMeter(host.processor);
    return outputSamples[0][call & 63u] + outputSamples[1][(call * 7u) & 63u] + meter.peak + meter.rms;
  }, deadlineNs);

  std::vector<double> clockPairs; clockPairs.reserve(batches);
  for (uint32_t sample = 0; sample < batches; ++sample) {
    const auto begin = std::chrono::steady_clock::now();
    const auto end = std::chrono::steady_clock::now();
    clockPairs.push_back(std::chrono::duration<double, std::nano>(end - begin).count());
  }
  std::sort(clockPairs.begin(), clockPairs.end());
  const double clockP50 = clockPairs[batches / 2];
  const double clockP99 = clockPairs[static_cast<size_t>(.99 * (batches - 1))];

  if (!std::isfinite(checksum) || checksum == 0.0 || !succeeded(destroyPrototypeFakeHost(&host))) return 3;
  const std::string cpu = cpuDescription();
  std::printf("{\"prototypeKernelOnly\":true,\"rateHz\":48000,\"frames\":64,\"channels\":2,"
              "\"batches\":%u,\"callsPerBatch\":%u,\"clockPairP50Ns\":%.1f,\"clockPairP99Ns\":%.1f,"
              "\"emptyHarnessP50Ns\":%.1f,\"emptyHarnessP99Ns\":%.1f,"
              "\"runnerP50Ns\":%.1f,\"runnerP95Ns\":%.1f,"
              "\"runnerP99Ns\":%.1f,\"runnerMaxNs\":%.1f,"
              "\"graphP50Ns\":%.1f,\"graphP95Ns\":%.1f,\"graphP99Ns\":%.1f,"
              "\"graphMaxNs\":%.1f,\"runnerDeadlineMissBatches\":%u,\"graphDeadlineMissBatches\":%u,"
              "\"graphP99DeadlinePercent\":%.6f,\"checksum\":%.9g,\"compiler\":",
              batches, callsPerBatch, clockP50, clockP99, harness.p50, harness.p99,
              runner.p50, runner.p95, runner.p99, runner.maximum,
              graph.p50, graph.p95, graph.p99, graph.maximum,
              runner.deadlineMisses, graph.deadlineMisses, graph.p99 * 100.0 / deadlineNs, checksum);
  printJsonString(compilerDescription());
#if defined(NDEBUG)
  std::printf(",\"build\":\"Release/NDEBUG\"");
#else
  std::printf(",\"build\":\"non-Release\"");
#endif
#if defined(_MSC_VER)
  std::printf(",\"runtimeRtFlags\":\"/EHs-c- /GR-\",\"cpu\":");
#else
  std::printf(",\"runtimeRtFlags\":\"-fno-exceptions -fno-rtti\",\"cpu\":");
#endif
  printJsonString(cpu);
  std::printf("}\n");
  return 0;
}

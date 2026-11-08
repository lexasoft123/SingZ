#include "training_phrase_renderer.h"
#include "training_pcm_mixer.h"
#include <algorithm>
#include <array>
#include <cmath>
#include <filesystem>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <string>
#include <fcntl.h>
#if defined(_WIN32)
#include <io.h>
#else
#include <unistd.h>
#endif
using namespace singz;
namespace {
void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}
struct Samples {
  std::filesystem::path directory;
  std::array<std::array<std::shared_ptr<const DecodedAudio>, 5>, 3> cache;
  unsigned calls = 0;
  static std::shared_ptr<const DecodedAudio> lookup(void* context, TrainingInstrument instrument, unsigned index) {
    auto& self = *static_cast<Samples*>(context);
    ++self.calls;
    auto& sample = self.cache[static_cast<unsigned>(instrument)][index];
    if (sample) return sample;
    const std::array<const char*, 3> names{"piano", "electric", "guitar"};
    const auto path = self.directory / (std::string(names[static_cast<unsigned>(instrument)]) + "-C" + std::to_string(index + 2) + ".mp3");
#if defined(_WIN32)
    const int descriptor = _wopen(path.c_str(), _O_RDONLY | _O_BINARY);
#else
    const int descriptor = ::open(path.c_str(), O_RDONLY);
#endif
    require(descriptor >= 0, "Cannot open bundled training MP3");
    DecodedAudioPrepareOptions options;
    options.sourceFormat = DecodedAudioSourceFormat::Mp3;
    options.maximumChannels = 2;
    options.maximumEncodedBytes = 1024 * 1024;
    options.maximumFrames = 192000 * 30;
    options.maximumDecodedBytes = 16 * 1024 * 1024;
    options.maximumWorkingBytes = 32 * 1024 * 1024;
    auto decoded = prepareDecodedAudio(OwnedFileDescriptor(descriptor), options);
    require(decoded.ok(), "Bundled training MP3 must decode natively");
    return sample = std::move(decoded.audio);
  }
};
double energy(const std::vector<float>& plane, size_t first, size_t last) {
  double sum = 0;
  for (size_t i = first; i < last; ++i) sum += plane[i] * plane[i];
  return sum / (last - first);
}
void validPcm(const TrainingPhraseResult& result) {
  require(result.ok(), "Phrase render failed");
  require(result.planes.size() == 2, "Expected stereo PCM");
  const auto frames = static_cast<size_t>(std::ceil(result.duration * 48000));
  for (const auto& plane : result.planes) {
    require(plane.size() == frames, "PCM duration mismatch");
    require(std::all_of(plane.begin(), plane.end(), [](float value) { return std::isfinite(value); }), "Nonfinite PCM");
    require(energy(plane, 0, plane.size()) > .000001, "Unexpected silent instrument");
  }
}
}
int main(int argc, char** argv) {
  try {
    require(argc == 2, "Expected sample directory");
    Samples samples{std::filesystem::u8path(argv[1]), {}};
    const std::vector<TrainingCue> single{{TrainingPurpose::Question, false, {60}}};
    for (unsigned instrument = 0; instrument < 3; ++instrument) {
      // Decode and render every bundled root, preserving source stereo.
      for (int midi : {36, 48, 60, 72, 84}) {
        validPcm(renderTrainingPhrase(static_cast<TrainingInstrument>(instrument),
            {{TrainingPurpose::Question, false, {midi}}}, {}, Samples::lookup, &samples));
      }
    }
    const auto piano = renderTrainingPhrase(TrainingInstrument::Piano, single, {}, Samples::lookup, &samples);
    validPcm(piano);
    require(piano.planes[0][0] == 0, "Sample attack must begin at zero");
    require(piano.planes[0] != piano.planes[1], "Stereo sample was collapsed");
    // A duplicate unison chord must keep the single-note level, not double it.
    const auto unison = renderTrainingPhrase(TrainingInstrument::Piano,
        {{TrainingPurpose::Question, true, {60, 60}}}, {}, Samples::lookup, &samples);
    require(piano.planes == unison.planes, "Chord concurrency normalization changed gain");
    // Source timing: sequential 0/.65, context gap .35, question gap .45.
    const std::vector<TrainingCue> phrase{
        {TrainingPurpose::Context, false, {60, 64}},
        {TrainingPurpose::Question, true, {60, 64, 67}},
        {TrainingPurpose::Answer, false, {67}}};
    const auto sequence = renderTrainingPhrase(TrainingInstrument::Piano, phrase, {}, Samples::lookup, &samples);
    validPcm(sequence);
    require(sequence.notes.size() == 6, "Lost cue notes");
    const std::array<double, 6> starts{0, .65, 1.55, 1.55, 1.55, 2.55};
    for (size_t i = 0; i < starts.size(); ++i) require(std::abs(sequence.notes[i].start - starts[i]) < 1e-10, "Cue purpose gap or articulation mismatch");
    require(std::abs(sequence.duration - 3.1) < 1e-10, "Unexpected trailing purpose gap");
    require(energy(sequence.planes[0], 58000, 74000) == 0, "Context gap contains sound");
    require(energy(sequence.planes[0], 102000, 122000) == 0, "Question gap contains sound");
    TrainingPhraseTiming quiet;
    quiet.peakGain = .5;
    const auto half = renderTrainingPhrase(TrainingInstrument::Piano, single, quiet, Samples::lookup, &samples);
    require(half.ok(), "Quiet render failed");
    for (size_t i = 0; i < piano.planes[0].size(); ++i)
      require(half.planes[0][i] == piano.planes[0][i] * .5f, "Gain altered the instrument envelope");
    const auto organ = renderTrainingPhrase(TrainingInstrument::Organ, single);
    validPcm(organ);
    require(organ.planes[0] == organ.planes[1], "Organ must be centered");
    require(energy(organ.planes[0], 0, 480) < energy(organ.planes[0], 10000, 10480) * .1, "Organ attack lost");
    require(energy(organ.planes[0], 25920, 26400) < energy(organ.planes[0], 10000, 10480) * .02, "Organ release lost");
    // The produced PCM feeds the existing native callback mixer unchanged.
    // A future cue stays silent, starts on the callback clock, then advances
    // by frames despite callback wall-clock jitter. Cancellation retires it.
    TrainingPcmMixer mixer;
    require(mixer.schedule(piano.planes, 7, 48000, 1000000000, .25f), "Native mixer refused rendered phrase");
    std::array<float, 256> left{}, right{};
    float* outputs[]{left.data(), right.data()};
    AudioHostRenderBlock block;
    block.output = outputs; block.outputChannels = 2; block.frames = 256;
    block.sampleRate = 48000; block.callbackHostTimeNs = 900000000;
    require(mixer.render(block) && energy(std::vector<float>(left.begin(), left.end()), 0, left.size()) == 0, "Future cue sounded early");
    block.callbackHostTimeNs = 1000000000;
    mixer.render(block);
    for (size_t frame = 0; frame < left.size(); ++frame)
      require(left[frame] == piano.planes[0][frame] * .25f && right[frame] == piano.planes[1][frame] * .25f, "Native cue PCM/stereo/gain mismatch");
    left.fill(0); right.fill(0); block.callbackHostTimeNs += 50000000;
    mixer.render(block);
    for (size_t frame = 0; frame < left.size(); ++frame)
      require(left[frame] == piano.planes[0][frame + 256] * .25f, "Callback jitter skipped native phrase samples");
    mixer.cancel(7); left.fill(0); right.fill(0); mixer.render(block);
    left.fill(0); right.fill(0); mixer.render(block);
    require(std::all_of(left.begin(), left.end(), [](float value) { return value == 0; }), "Cancelled native phrase remained audible");
    // Mid-render cancellation publishes neither PCM nor a stale timeline.
    unsigned polls = 0;
    DecodeCancellation cancel{&polls, [](void* value) noexcept { return ++*static_cast<unsigned*>(value) > 20; }};
    for (auto instrument : {TrainingInstrument::Piano, TrainingInstrument::Organ}) {
      polls = 0;
      auto cancelled = renderTrainingPhrase(instrument, phrase, {}, Samples::lookup, &samples, cancel);
      require(cancelled.status == TrainingRenderStatus::Cancelled && cancelled.planes.empty() && cancelled.notes.empty(), "Cancelled render exposed partial output");
    }
    require(renderTrainingPhrase(TrainingInstrument::Piano, single).status == TrainingRenderStatus::MissingSample, "Missing sample silently substituted");
    auto invalid = [](TrainingInstrument instrument, const std::vector<TrainingCue>& cues, TrainingPhraseTiming timing = {}) {
      auto result = renderTrainingPhrase(instrument, cues, timing);
      require(result.status == TrainingRenderStatus::InvalidArgument && result.planes.empty(), "Invalid input allocated or rendered");
    };
    invalid(TrainingInstrument::Organ, {});
    invalid(static_cast<TrainingInstrument>(4), single);
    invalid(TrainingInstrument::Organ, {{TrainingPurpose::Answer, false, {-1}}});
    invalid(TrainingInstrument::Organ, {{TrainingPurpose::Answer, false, {128}}});
    invalid(TrainingInstrument::Organ, {{TrainingPurpose::Answer, false, {}}});
    invalid(TrainingInstrument::Organ, {{static_cast<TrainingPurpose>(3), false, {60}}});
    invalid(TrainingInstrument::Organ, std::vector<TrainingCue>(129, single[0]));
    invalid(TrainingInstrument::Organ, {{TrainingPurpose::Question, true, std::vector<int>(33, 60)}});
    invalid(TrainingInstrument::Organ, std::vector<TrainingCue>(128, {TrainingPurpose::Question, false, {60, 64, 67}}));
    for (double value : {-1., std::numeric_limits<double>::infinity(), std::numeric_limits<double>::quiet_NaN()}) {
      auto timing = TrainingPhraseTiming{}; timing.noteDuration = value; invalid(TrainingInstrument::Organ, single, timing);
      timing = {}; timing.contextGap = value; invalid(TrainingInstrument::Organ, single, timing);
      timing = {}; timing.peakGain = value; invalid(TrainingInstrument::Organ, single, timing);
    }
    std::cout << "Native training renderer: 15 MP3 roots, timing/gaps, stereo, chord gain, envelopes, cancellation and bounds passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}

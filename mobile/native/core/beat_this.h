#pragma once
#include <cstdint>
#include <functional>
#include <string>
#include <vector>

// Beat This! — the ML beat/downbeat grid, ported from scripts/beat_runner_onnx.py
// (itself a numpy port of beat_this.inference). Same frozen contract as the
// desktop packs: 22.05 kHz mono float in, beat/downbeat times plus per-frame
// probabilities out, 50 fps.
//
// The two ONNX calls are INJECTED rather than owned here, for one reason that
// is worth stating: everything a port can get wrong lives in the framing, the
// chunk arithmetic and the peak picking, and none of that needs a model to
// test. With the inference behind a std::function the whole of that logic runs
// on a host with no ONNX Runtime at all, against logits dumped from the python
// runner — which is what eval/mlgrid-parity.mjs does. The ORT-backed
// implementation lives in beat_this_ort.cpp so this translation unit links
// without it.
namespace singz {

// Frozen by the model graph and the desktop protocol alike.
constexpr int kBeatThisSr = 22050;
constexpr int kBeatThisFps = 50;
constexpr int kBeatThisNFft = 1024;
constexpr int kBeatThisHop = 441;
constexpr int kBeatThisChunk = 1500;  // 30 s at 50 fps; fixed in the graph
constexpr int kBeatThisBorder = 6;    // frames dropped either side of a chunk

struct MlGrid {
  std::vector<double> beats;         // seconds
  std::vector<double> downbeats;     // seconds, each snapped to a beat
  std::vector<double> beatProb;      // per frame
  std::vector<double> downbeatProb;  // per frame
  int fps = kBeatThisFps;
  bool ok = false;
  std::string error;  // set when !ok
};

// The two graph calls. Both are shaped exactly as the python runner feeds them
// so a mis-marshalled tensor shows up here rather than three layers down.
struct BeatThisModels {
  // frames: nFrames * 1024 f32, row-major -> logmel: nFrames * 128 f32
  std::function<std::vector<float>(const std::vector<float>& frames, int nFrames)> logmel;
  // spect: 1500 * 128 f32 (one chunk, zero-padded) -> two 1500-long logit rows
  std::function<bool(const std::vector<float>& spect, std::vector<float>& beatLogits,
                     std::vector<float>& downLogits)>
      model;
};

// 0..1, called as chunks complete. The desktop runner reports 0.30..0.95 over
// this stretch; callers map it into whatever their own job spans.
using BeatThisProgress = std::function<void(double)>;

// --- the pure pieces, exposed because the fixtures test them directly ---

/** Chunk starts, `split_piece` with avoid_short_end. May begin negative. */
std::vector<int> splitStarts(int nFrames);

/** torchaudio-equivalent framing: right-pad to N_FFT if shorter, reflect-pad
 *  N_FFT/2 each side, then 1024-wide windows every 441. Returns the frames
 *  flat, row-major, and writes the count. */
std::vector<float> frameSignal(const std::vector<float>& signal, int& nFrames);

/** beat_this.model.postprocessor.deduplicate_peaks, width 1. Returns FRAME
 *  positions, which are fractional once a run has been averaged. */
std::vector<double> deduplicatePeaks(const std::vector<int>& peaks, int width);

/** 7-wide max filter over logits, keep strict maxima above zero, dedupe
 *  adjacent, convert to seconds. */
std::vector<double> peakTimes(const std::vector<float>& logits);

/** Beat times, then downbeats snapped to the nearest beat and uniqued. */
void postprocess(const std::vector<float>& beatLogits, const std::vector<float>& downLogits,
                 std::vector<double>& beats, std::vector<double>& downbeats);

/** numpy's `1 / (1 + exp(-clip(x, -80, 80)))`, computed in float32 because that
 *  is the dtype the runner's array carries and therefore what its JSON rounds. */
double sigmoidProb(float logit);

/** split_predict_aggregate with overlap_mode=keep_first. Chunks run in REVERSE
 *  so earlier ones overwrite later ones, which is what keep_first means. */
bool runChunks(const std::vector<float>& spect, int nFrames, const BeatThisModels& models,
               std::vector<float>& beatLogits, std::vector<float>& downLogits,
               const BeatThisProgress& progress);

/** The whole runner: framing -> mel -> chunks -> postprocess. */
MlGrid beatThis(const std::vector<float>& signal22k, const BeatThisModels& models,
                const BeatThisProgress& progress);

/** The model's input built from stem FILES — the desktop's fetchMlGrid
 *  contract, natively: every stem read as mono float32 (readWavMono), summed
 *  sample-wise with shorter stems running out into silence (the desktop's
 *  OfflineAudioContext renders to the longest buffer), then brought to
 *  22 050 Hz by the split engine's own Resampler (1/2 polyphase windowed
 *  sinc, CI-gated at 110 dB in-band SNR). The sum is raw — WebAudio floats
 *  never clip and neither does the runner's input.
 *
 *  Each stem's rate is CHECKED to be 44 100 Hz, never resampled from
 *  arbitrary rates: the phone's stems are the split engine's own output, so
 *  any other rate is a wiring bug upstream, and quietly "fixing" it here
 *  would hand the model time-stretched audio and a confident wrong grid.
 *
 *  NOT bit-parity with the desktop, and not claimed: Chromium resamples each
 *  source with its own sinc kernel before the sum, so the two mixes agree to
 *  filter quality, not to the bit. Grid-level agreement is what the corpus
 *  eval measures; what IS exact is this function against itself across
 *  platforms, which the device suites compare value by value. */
std::vector<float> sumStemsTo22k(const std::vector<std::string>& stemPaths, std::string& error);

/** sumStemsTo22k -> beatThis: the from-stems runner both phone bindings call.
 *  On a sum failure the grid comes back !ok with the reason. */
MlGrid beatThisFromStems(const std::vector<std::string>& stemPaths, const BeatThisModels& models,
                         const BeatThisProgress& progress);

/** The grid with every value rounded exactly where the python runner rounds —
 *  the JSON contract's NUMBERS, without the text. mlGridJson serializes this,
 *  and a binding that can hand its platform doubles directly should use this
 *  instead of parsing the string back.
 *
 *  iOS must: mlGridJson writes `%.17g`, and Foundation's JSON number parser is
 *  not correctly rounded on 17-significant-digit input — it reads
 *  "0.053999999999999999" as 0.054000000000000006 where strtod (and Kotlin,
 *  and JS) read 0.054. Measured, not assumed: 49 of 2041 probabilities came
 *  back one ULP off that way, which is invisible in a grid comparison and
 *  loud in a value comparison. Short forms parse fine, which is why a casual
 *  check of "0.013" says the parser is healthy. */
MlGrid mlGridRounded(const MlGrid& grid);

/** The grid as the desktop's one JSON line: the same fields, rounded where the
 *  python runner rounds, so a phone-produced `ml` aux and a pack-produced one
 *  carry the same NUMBERS. Not the same bytes — this writes `%.17g` and no
 *  spaces where json.dumps writes a shortest repr and one space after each
 *  colon, so `8` here is `8.0` there. Every value parses equal, which is what
 *  the consumers do and what the parity gate compares. */
std::string mlGridJson(const MlGrid& grid);

// --- the ORT-backed models (beat_this_ort.cpp; needs onnxruntime) ---

/** Sessions for the two graphs, loaded from a directory holding logmel.onnx
 *  and beat_this.onnx. Returns models with null callables on failure, and the
 *  reason in `error`. */
BeatThisModels loadBeatThisModels(const std::string& modelsDir, std::string& error);

}  // namespace singz

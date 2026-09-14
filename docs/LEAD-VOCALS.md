# Lead and backing vocal separation

The optional **Lead and backing vocals** model applies UVR MDX Karaoke 2 to an
already separated vocal stem. Its trained primary output is **Instrumental**:
on a vocal-only input this becomes the backing/harmony lane. Lead vocals are
`input − backing`, preserving sample alignment and the original mixture level.
It estimates musical roles, not singer identities; unison singing, doubled leads
and tightly overlapping harmonies can still cross between lanes.

The model is 52,786,726 bytes, SHA-256
`bf32e15105a09c0f7dddd2b67346146334d6f3ecb399ed7638eba2ab07cbf5f4`.
The official UVR parameter table, keyed by its tail-MD5
`1d64a6d2c30f709b8c9b4ce1366d96ee`, supplies FFT 5120, hop 1024, 2048 frequency
bins, 256 time frames and output compensation 1.065. The runner uses periodic
Hann STFT, real/imaginary stereo channels, 25% chunk overlap and a Hann overlap
sum. It zeros the first three frequency bins, matching UVR's implementation.

- [Official weight release](https://github.com/TRvlvr/model_repo/releases/tag/all_public_uvr_models)
- [Official model parameter table](https://github.com/TRvlvr/application_data/blob/main/mdx_model_data/model_data.json)
- [Official inference implementation](https://github.com/Anjok07/ultimatevocalremovergui/blob/master/separate.py)
- [Official STFT convention](https://github.com/Anjok07/ultimatevocalremovergui/blob/master/lib_v5/tfc_tdf_v3.py)
- [UVR model licensing statement](https://github.com/Anjok07/ultimatevocalremovergui#license)
- [Full copyright and MIT text](https://github.com/Anjok07/ultimatevocalremovergui/blob/master/gui_data/constants.py)

Karaoke 2 was selected for its directly downloadable ONNX weights, explicit
lead/backing workflow, small size and reuse of local runtimes. This is a
practical choice, not a claim that it beats every larger separation model.

On Apple Silicon, model download also installs a SHA-256-pinned official
ONNX Runtime 1.28.0 wheel (19,141,362 bytes; Python 3.12, macOS 14+) beside the
model. The installed splitter pack is left untouched. Its `sphn` decoder reads
FLAC/WAV input; Windows/Intel packs already have ONNX Runtime and soundfile.
A fixed batch dimension (`batch_size=1`) allows CoreML's static MLProgram path;
CPU remains the fallback. The CPU path can take longer than the song itself.

The **Separate backing vocals** transport action runs only on request, exposes
progress/cancel, replaces the session's vocal lane with lead audio and adds a
normal custom backing lane. It cancels and invalidates analyses of the old
combined vocal. Melody is then tracked from the lead. Song changes disown late
results. The cache keys on source bytes, model hash and runner source hash;
completed files are hashed before reuse. A failed/cancelled run publishes no
complete cache entry.

The new audio stays in the application cache until explicit Save. Analysis
auto-save is suspended while the replacement is pending. Save replaces the
canonical vocal in place, removes its old preferred FLAC, stores the backing
lane under `stems/custom-…`, refreshes project hashes and drops an obsolete
combined-vocal melody. Absolute pending paths never enter project.json.
IEEE-float WAV preserves residual samples above 1 without clipping; those
projects use the existing v1/mixed WAV+FLAC reader rather than quantizing the
new vocal through the existing 16-bit FLAC encoder.

The saved `leadVocalSeparated` setting persists across Save and reopening.
It keeps **Re-split** unavailable: restoring combined vocals alongside the saved
backing lane would play the backing twice. There is no reset or recombine
workflow yet. Generated backing lanes display directly under the main vocals,
and remain there after renaming their labels or reopening the project.

Numerical checks live in `scripts/vocal_split_runner_test.py`; project-save
regressions in `tests/unit/vocal-project-save.test.ts`. A full 366.916-second
Turn The Page test through the untouched installed pack plus the optional
runtime produced stereo output with identical length and a maximum
`lead + backing − input` error of `2.98e-8`. This verifies time/level integrity,
not the semantic accuracy of every separated harmony.

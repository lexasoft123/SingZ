# Lead and backing vocal separation

Every split produces seven lanes: the six htdemucs stems, with the vocal stem
itself split into lead and backing. It is not an optional second pass and
there is no way to ask for six. A monophonic detector handed two simultaneous
voices locks onto subharmonics: across the 44-input corpus
(`eval/pitch-regression-gate.md` describes it; its result files are private),
running pitch v4 on the separated lead instead of the combined vocal stem took
octave errors from 12,651 to 6,993 and agreement within 50 cents from 83.62%
to 88.47%. Holding the reference fixed and comparing only frames both runs
emit — the strict form — it is 88.07% to 89.33%. Nine tenths of those errors
were octave-*below*, which is exactly what a harmony a third or a fifth under
the lead does to the apparent period. On Pink Floyd's "Time" it is 618 octave
errors to 85.

The **Lead and backing vocals** model applies UVR MDX Karaoke 2 to that
already separated vocal stem. Its trained primary output is **Instrumental**:
on a vocal-only input this becomes the backing/harmony lane. Lead vocals are
`input − backing`, preserving sample alignment and the original mixture level.
It estimates musical roles, not singer identities; unison singing, doubled leads
and tightly overlapping harmonies can still cross between lanes.

The model is 52,786,726 bytes, SHA-256
`bf32e15105a09c0f7dddd2b67346146334d6f3ecb399ed7638eba2ab07cbf5f4`. It ships
**inside the splitter pack** (`python/models/uvr/`) rather than as a separate
download, because a split cannot finish without it — both pack builders fetch
it against that sha, run the shipped runner on a synthesized two-voice clip
offline, and assert that lead + backing reconstructs the input. `pack.json`
records format 5 (Apple Silicon) / 9 (ONNX), which `PACK_FORMAT_REQUIRED` in
`src/main/models.ts` refuses to go below; older packs are re-downloaded.
`tests/unit/vocal-model-in-pack.test.ts` holds those three files in step.
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

The Apple Silicon pack pins `onnxruntime==1.28.0` alongside torch so the ONNX
graph has a runtime; the ONNX packs already carry one. This replaced a
side-loaded wheel installed beside the model, which needed macOS 14 and a
matching pack and could disagree with either. The torch pack's `sphn` decoder
reads FLAC/WAV input; the ONNX packs use soundfile.
A fixed batch dimension (`batch_size=1`) allows CoreML's static MLProgram path;
CPU remains the fallback. The CPU path can take longer than the song itself.

The second stage runs as part of every split, with one progress bar over both
(`1/2`, `2/2`). **Separate backing vocals** survives in the Split menu for
projects split by an older build, which are the only ones that can still have
a combined vocal lane; the Split button turns amber and says so, because there
is no other route for them. Either way the stage exposes progress/cancel, replaces the session's vocal lane with lead audio and adds a
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

Those two lanes cost more on disk — about 40 MB per minute of song for the
pair — but they must not cost more in memory. Native playback streams a song
only if EVERY lane can be streamed, and until the core had a WAV streaming
source (`zcore/src/media/wav_streaming_source.cpp`) one float lane sent the
whole song back to a full decode: 115 MB held against 20 MB on a phone for a
40-second song, and a desktop open that decoded both vocal lanes in the
renderer (2.9 s against 0.5 s for a five-minute song). The WAV source shares
its header walk and sample conversion with `prepareDecodedAudio`, and
`tests/native/wav_streaming_source_tests.cpp` holds the two to the same floats
bit for bit.

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

The [version-4 pitch gate](../eval/pitch-regression-gate.md) rechecks separation
with the final offline detector on all 44 vocal inputs. Separation improves
aggregate independent-model agreement, which is why it runs on every split; the
lead-retention listening flags remain. Live microphone and offline song tracking have different
evidence requirements and do not share the experimental offline octave prior.

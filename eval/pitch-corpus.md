# Reproducible pitch corpus evaluation

`pitch-corpus.py` inventories a library and Downloads without modifying either.
All decoded audio and model outputs live under `--output`; output paths inside
either source tree are rejected. The manifest records every project audio file,
not just the vocal stem selected for analysis. Downloads roles are inferred from
filenames and remain explicitly provisional.

Use a Python environment containing NumPy, SciPy, torchcrepe, soundfile and
onnxruntime; ffmpeg and ffprobe must be on PATH. `pitch-plot.py` additionally needs
Matplotlib. The CREPE API and decoding/silence guidance come from the
[primary implementation](https://github.com/maxrmorrison/torchcrepe).

```sh
python eval/pitch-corpus.py manifest --output /tmp/pitch-eval
python eval/pitch-corpus.py native --bin /path/baseline/singz-analyze --label baseline
python eval/pitch-corpus.py native --bin /path/updated/singz-analyze --label updated
python eval/pitch-corpus.py reference --device mps
python eval/pitch-corpus.py separate --threads 2
python eval/pitch-corpus.py prepare --scope downloads --device mps
python eval/pitch-corpus.py pipeline --scope downloads --device mps
python eval/pitch-corpus.py pipeline --scope library --await-separation --device mps
python eval/pitch-corpus.py report
python eval/pitch-plot.py
```

Pass the same `--output` to every invocation when overriding its default. CLI
options also override library/Downloads roots, model/runner paths, native
executables and the installed Demucs pack. Metal/CoreML require access to the
local GPU. `PYTHONPATH` can select the exact shipping ONNX Runtime package without
replacing the evaluation environment's Torch dependencies.

The pipeline waits for `prepare` results, reuses existing baseline/reference and
separation results, then runs the updated detector and independent CREPE on the
lead output. Instrumental backing tracks receive native baseline/updated smoke
tests only; they are not a vocal accuracy reference. Run `report` after jobs
finish; a snapshot explicitly distinguishes completed rows from pending work.

Each native result records the executable hash, detector version and decoded
PCM hash. Reference results retain their input PCM hash and complete inference
configuration. Lead and original-vocal references occupy different directories.
Separation provenance includes source/model/runner hashes, ONNX Runtime version
and requested providers. Cache entries with incompatible provenance are rerun.
Jobs write per-file artifacts atomically and retain failures in summary files.
Do not run overlapping workers against the same IDs/output kind; use disjoint
`--shards`/`--shard` partitions when needed. A source mix is resolved to its
SHA-1-matched cached vocal stem or separated locally with htdemucs_6s.

These are full-duration tests, not excerpt tests. Native analysis uses 44.1 kHz
mono input and its usual forward windows. CREPE uses the full model, 20 ms hop,
Viterbi decoding, 50–1600 Hz range, 30-second chunks with one second of context,
median-filtered periodicity, a 0.21 threshold and a −60 dB silence gate. Comparison
aligns frame centers and reports shared voiced counts; the version comparison
uses the exact frames voiced by both native versions and CREPE.

Model agreement is not ground-truth accuracy. Both methods may follow backing
harmony or choose an incorrect octave. Synthetic signals with known fundamental
frequency test algorithm correctness separately. Claiming improved singer accuracy
requires listening or annotated pitch references, especially where models differ.

For unusually long recordings, use `pitch-long-recording.py --wait-for-regular`
after starting the ordinary pipeline. It waits for the regular inputs, then runs
180.32-second cores with7.36 seconds of context on both sides, retaining per-chunk
results for resume. It streams final vocal/lead/backing WAVs and stitches both
pitch grids without loading the recording into one large tensor. The report
explicitly distinguishes this protocol from whole-recording Viterbi decoding.
Creating `master-recording-excluded.json` in the output directory stops this
specific recording before its next chunk if the user excludes it.

Use an exact `--exclude-id` when deferring one manifest entry; a substring can
also match another song's mastering suffix. To refresh the selected detector on
already available lead outputs, use `native --input-kind lead --available-only`
with its final binary and `--label updated-lead`. The report records all executable
hashes and warns when an in-progress label contains multiple versions.

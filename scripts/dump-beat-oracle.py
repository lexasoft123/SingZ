#!/usr/bin/env python3
"""Record what scripts/beat_runner_onnx.py feeds and gets from its two graphs,
so eval/mlgrid-parity.mjs can gate the C++ port without an ONNX Runtime.

The runner is IMPORTED, never re-implemented, and its sessions are WRAPPED, so
every tensor recorded is one it actually passed to ORT. A script that
recomputed the framing itself would agree with its own misunderstanding and
prove nothing — which is the failure the whole parity apparatus exists to
catch, arriving through the oracle instead of the port.

  # the postprocessor expectation the harness always checks (no models needed
  # beyond an onnxruntime import — this path runs no graph at all)
  dump-beat-oracle.py --postproc <beat.f32> <down.f32> > eval/beats/ml-postproc-expected.json

  # a full replay recording for the framing + chunk stages
  dump-beat-oracle.py --replay <in.f32> <models-dir> <out-dir>

Needs numpy and onnxruntime. The splitter packs carry both:
  .engines-src/onnx-pack-<platform>/python/bin/python3.12
"""
import importlib.util
import json
import shutil
import sys
from pathlib import Path

import numpy as np

RUNNER = Path(__file__).resolve().parent / "beat_runner_onnx.py"
spec = importlib.util.spec_from_file_location("btr", RUNNER)
btr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(btr)


def rounded(beats, downbeats, beat_logits, down_logits):
    return {
        "beats": [round(float(b), 3) for b in beats],
        "downbeats": [round(float(d), 3) for d in downbeats],
        "beat_prob": [round(float(p), 3) for p in btr.sigmoid(beat_logits)],
        "downbeat_prob": [round(float(p), 3) for p in btr.sigmoid(down_logits)],
        "fps": btr.FPS,
    }


def main() -> int:
    if len(sys.argv) >= 2 and sys.argv[1] == "--postproc":
        b = np.fromfile(sys.argv[2], dtype=np.float32)
        d = np.fromfile(sys.argv[3], dtype=np.float32)
        beats, downbeats = btr.postprocess(b, d)
        json.dump(rounded(beats, downbeats, b, d), sys.stdout)
        sys.stdout.write("\n")
        return 0

    if len(sys.argv) < 5 or sys.argv[1] != "--replay":
        sys.stderr.write(__doc__)
        return 2

    import onnxruntime as ort

    in_f32, models_dir, out_dir = sys.argv[2], Path(sys.argv[3]), Path(sys.argv[4])
    out_dir.mkdir(parents=True, exist_ok=True)

    class Spy:
        """Records every run() in call order — inputs as well as outputs, so a
        mis-sliced chunk is caught at the boundary rather than as a logits
        mismatch three steps later."""

        def __init__(self, sess):
            self.sess = sess
            self.calls = []

        def run(self, out_names, feed):
            res = self.sess.run(out_names, feed)
            self.calls.append((feed, res))
            return res

    opts = ort.SessionOptions()
    opts.log_severity_level = 3
    providers = ["CPUExecutionProvider"]
    mel = Spy(ort.InferenceSession(str(models_dir / "logmel.onnx"), opts, providers=providers))
    model = Spy(ort.InferenceSession(str(models_dir / "beat_this.onnx"), opts, providers=providers))

    signal = np.fromfile(in_f32, dtype=np.float32)
    if signal.size == 0:
        sys.stderr.write(f"empty or unreadable f32 input: {in_f32}\n")
        return 2
    spect = btr.compute_logmel(signal, mel)
    beat_logits, down_logits = btr.run_model(spect, model)
    beats, downbeats = btr.postprocess(beat_logits, down_logits)

    shutil.copyfile(in_f32, out_dir / "in.f32")
    (frames_feed,) = [c[0]["frames"] for c in mel.calls]
    frames_feed.astype(np.float32).tofile(out_dir / "frames.f32")
    spect.astype(np.float32).tofile(out_dir / "spect.f32")
    # Per-chunk logits in CALL order, which is reversed starts (keep_first).
    np.stack([c[1][0][0] for c in model.calls]).astype(np.float32).tofile(out_dir / "chunk_beat.f32")
    np.stack([c[1][1][0] for c in model.calls]).astype(np.float32).tofile(out_dir / "chunk_down.f32")
    beat_logits.astype(np.float32).tofile(out_dir / "beat_logits.f32")
    down_logits.astype(np.float32).tofile(out_dir / "down_logits.f32")

    meta = {
        "samples": int(signal.size),
        "n_frames": int(spect.shape[0]),
        "n_mel": int(spect.shape[1]),
        "starts": [int(s) for s in btr.split_starts(spect.shape[0])],
        "chunks": len(model.calls),
        "json": rounded(beats, downbeats, beat_logits, down_logits),
    }
    (out_dir / "meta.json").write_text(json.dumps(meta))
    sys.stderr.write(
        f"recorded {meta['n_frames']} frames, {meta['chunks']} chunks, starts {meta['starts']}, "
        f"{len(beats)} beats, {len(downbeats)} downbeats\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())

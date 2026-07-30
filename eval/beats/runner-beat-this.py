#!/usr/bin/env python3
"""Batch Beat This! runner for the SingZ eval harness.

Usage: python runner-beat-this.py --jobs jobs.json [--checkpoint final0]
       [--device mps|cpu]

jobs.json: [{"id": str, "f32": path, "sr": int}, ...] — f32 is raw float32le
mono PCM at sr. One JSON line per job on stdout:
  {"id", "beats": [...s], "downbeats": [...s],
   "beat_prob": [...], "downbeat_prob": [...], "fps": 50,
   "infer_s", "audio_s"}
beat_prob/downbeat_prob are the model's framewise head probabilities at fps
(sigmoid of the logits, 3 decimals) — the app's phase arbiter samples them as
one cue among the stem votes. Progress lines go to stderr. The model is
loaded once for the whole batch.

Needs a python with beat_this installed (pip install
git+https://github.com/CPJKU/beat_this — MIT, pulls torch/torchaudio/soxr);
point $BEAT_THIS_PY at it for run-beat-this.mjs. Checkpoints download to
$TORCH_HOME/hub/checkpoints on first use (final0 77 MB, small0 8 MB).
This file is also the reference for the production pack runner (phase 2).
"""
import argparse
import json
import sys
import time

import numpy as np


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--jobs", required=True)
    ap.add_argument("--checkpoint", default="final0")
    ap.add_argument("--device", default="cpu")
    args = ap.parse_args()

    with open(args.jobs) as f:
        jobs = json.load(f)

    t0 = time.time()
    import torch
    from beat_this.inference import Audio2Frames
    from beat_this.model.postprocessor import Postprocessor

    a2f = Audio2Frames(checkpoint_path=args.checkpoint, device=args.device)
    postp = Postprocessor(type="minimal")
    print(f"model {args.checkpoint} on {args.device} loaded in {time.time()-t0:.1f}s",
          file=sys.stderr, flush=True)

    for job in jobs:
        signal = np.fromfile(job["f32"], dtype=np.float32)
        t1 = time.time()
        beat_logits, downbeat_logits = a2f(signal, job["sr"])
        beats, downbeats = postp(beat_logits, downbeat_logits)
        beat_prob = torch.sigmoid(beat_logits).cpu().numpy()
        downbeat_prob = torch.sigmoid(downbeat_logits).cpu().numpy()
        dt = time.time() - t1
        print(json.dumps({
            "id": job["id"],
            "beats": [round(float(b), 3) for b in beats],
            "downbeats": [round(float(d), 3) for d in downbeats],
            "beat_prob": [round(float(p), 3) for p in beat_prob],
            "downbeat_prob": [round(float(p), 3) for p in downbeat_prob],
            "fps": 50,
            "infer_s": round(dt, 2),
            "audio_s": round(len(signal) / job["sr"], 1),
        }), flush=True)
        print(f"done {job['id']} ({dt:.1f}s)", file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()

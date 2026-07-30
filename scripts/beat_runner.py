#!/usr/bin/env python3
"""Beat This! beat/downbeat runner — torch flavor (Apple Silicon splitter pack).

Ships as python/beat_runner.py inside the torch/MPS pack. Frozen protocol:

  <pack-python> python/beat_runner.py --f32 <path> --sr <int> [--device auto|mps|cpu]

Input: raw float32le mono PCM at --sr (the app feeds 22050; other rates are
soxr-resampled by beat_this). Output: exactly ONE JSON line on stdout:

  {"beats":[s...], "downbeats":[s...], "beat_prob":[...], "downbeat_prob":[...], "fps":50}

beat_prob/downbeat_prob = sigmoid of the framewise head logits at 50 fps
(3 decimals); beats/downbeats = the minimal postprocessor's peak times
(3 decimals), downbeats snapped onto beats (upstream behavior). Errors exit
nonzero with a message on stderr; progress lines go to stderr only.

Weights load from models/beat_this/final0.ckpt RELATIVE TO THIS FILE — never
the network (the app spawns with HF_HUB_OFFLINE=1, which must not matter).
--models overrides the weights dir (build-time smoke/parity only).
"""
import argparse
import json
import sys
import time
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--f32", required=True)
    ap.add_argument("--sr", type=int, required=True)
    ap.add_argument("--device", default="auto", choices=["auto", "mps", "cpu"])
    ap.add_argument("--models", default=None,
                    help="weights dir override (build-time smoke/parity only)")
    args = ap.parse_args()

    if args.sr <= 0:
        print(f"invalid --sr {args.sr}", file=sys.stderr)
        return 2
    models_dir = (Path(args.models) if args.models
                  else Path(__file__).resolve().parent / "models" / "beat_this")
    ckpt = models_dir / "final0.ckpt"
    if not ckpt.is_file():
        print(f"missing model weights: {ckpt}", file=sys.stderr)
        return 2

    import numpy as np
    signal = np.fromfile(args.f32, dtype=np.float32)
    if signal.size == 0:
        print(f"empty or unreadable f32 input: {args.f32}", file=sys.stderr)
        return 2

    t0 = time.time()
    import torch
    from beat_this.inference import Audio2Frames
    from beat_this.model.postprocessor import Postprocessor

    device = args.device
    if device == "auto":
        device = "mps" if torch.backends.mps.is_available() else "cpu"
    print(f"loading Beat This (final0) on {device}", file=sys.stderr, flush=True)

    try:
        a2f = Audio2Frames(checkpoint_path=str(ckpt), device=device)
        beat_logits, downbeat_logits = a2f(signal, args.sr)
    except Exception as err:  # MPS can lack ops on old macOS — CPU always works
        if device == "cpu":
            raise
        print(f"{device} inference failed ({err}); retrying on cpu",
              file=sys.stderr, flush=True)
        device = "cpu"
        a2f = Audio2Frames(checkpoint_path=str(ckpt), device=device)
        beat_logits, downbeat_logits = a2f(signal, args.sr)

    postp = Postprocessor(type="minimal")
    beats, downbeats = postp(beat_logits, downbeat_logits)
    beat_prob = torch.sigmoid(beat_logits.float()).cpu().numpy()
    downbeat_prob = torch.sigmoid(downbeat_logits.float()).cpu().numpy()
    print(f"analyzed {signal.size / args.sr:.1f}s of audio in "
          f"{time.time() - t0:.1f}s ({device})", file=sys.stderr, flush=True)

    print(json.dumps({
        "beats": [round(float(b), 3) for b in beats],
        "downbeats": [round(float(d), 3) for d in downbeats],
        "beat_prob": [round(float(p), 3) for p in beat_prob],
        "downbeat_prob": [round(float(p), 3) for p in downbeat_prob],
        "fps": 50,
    }), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())

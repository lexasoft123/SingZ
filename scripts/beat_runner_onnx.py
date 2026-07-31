#!/usr/bin/env python3
"""Beat This! beat/downbeat runner — ONNX flavor (Windows / Intel-Mac packs).

Ships as python/beat_runner.py inside the demucs-onnx splitter packs. Same
frozen protocol as the torch flavor:

  <pack-python> python/beat_runner.py --f32 <path> --sr <int> [--device auto|mps|cpu]

but numpy + onnxruntime ONLY (no torch), CPU execution provider ONLY on every
platform (--device is accepted and ignored; ~6 s/song — the DirectML
fragility class stays quarantined to demucs). This flavor asserts --sr 22050
(the app always feeds that; the torch flavor owns resampling).

Output: exactly ONE JSON line on stdout:

  {"beats":[s...], "downbeats":[s...], "beat_prob":[...], "downbeat_prob":[...], "fps":50}

Models load RELATIVE TO THIS FILE from models/beat_this/: logmel.onnx (the
mel front-end: windowed frames -> log-mel, exported at build time) and
beat_this.onnx (the 20M-param model, fixed 1500-frame input). Chunking is a
faithful numpy port of beat_this.inference.split_predict_aggregate
(30 s chunks, 6-frame borders, keep_first overlap) and of the minimal
Postprocessor (7-wide max-filter peaks on logits > 0, adjacent-peak dedupe,
downbeat -> nearest-beat snap, unique). Never touches the network.
"""
import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

SR = 22050
FPS = 50
N_FFT = 1024
HOP = 441
CHUNK = 1500   # 30 s at 50 fps (model input length, fixed in the graph)
BORDER = 6     # frames discarded on either side of every chunk prediction


def compute_logmel(signal: np.ndarray, sess) -> np.ndarray:
    """torchaudio-equivalent framing (center=True, reflect pad), mel in ONNX."""
    if signal.size < N_FFT:
        signal = np.pad(signal, (0, N_FFT - signal.size))
    padded = np.pad(signal, N_FFT // 2, mode="reflect")
    frames = np.lib.stride_tricks.sliding_window_view(padded, N_FFT)[::HOP]
    frames = np.ascontiguousarray(frames, dtype=np.float32)
    (logmel,) = sess.run(None, {"frames": frames})
    return logmel  # (T, 128) float32


def split_starts(n_frames: int) -> np.ndarray:
    """Chunk starts as in beat_this.inference.split_piece (avoid_short_end)."""
    starts = np.arange(-BORDER, n_frames - BORDER, CHUNK - 2 * BORDER)
    if n_frames > CHUNK - 2 * BORDER:
        starts[-1] = n_frames - (CHUNK - BORDER)
    return starts


def run_model(spect: np.ndarray, sess) -> tuple[np.ndarray, np.ndarray]:
    """split_predict_aggregate with overlap_mode=keep_first, in numpy."""
    n_frames = spect.shape[0]
    starts = split_starts(n_frames)
    beat = np.full(n_frames, -1000.0, dtype=np.float32)
    down = np.full(n_frames, -1000.0, dtype=np.float32)
    # keep_first: write in reverse order so earlier chunks overwrite later ones
    done = 0
    for start in starts[::-1].tolist():
        chunk = spect[max(start, 0):min(start + CHUNK, n_frames)]
        left = max(0, -start)
        right = max(0, min(BORDER, start + CHUNK - n_frames))
        chunk = np.pad(chunk, ((left, right), (0, 0)))
        n = chunk.shape[0]  # what the torch flavor would feed the model
        if n < CHUNK:       # short piece: the graph is fixed at 1500 frames —
            chunk = np.pad(chunk, ((0, CHUNK - n), (0, 0)))  # pad, then drop
        b_log, d_log = sess.run(None, {"spect": chunk[None]})
        b_seg = b_log[0][:n][BORDER:-BORDER]  # drop padded logits + borders
        d_seg = d_log[0][:n][BORDER:-BORDER]
        lo = start + BORDER
        hi = min(start + CHUNK - BORDER, n_frames)
        beat[lo:hi] = b_seg[:hi - lo]
        down[lo:hi] = d_seg[:hi - lo]
        done += 1
        print(f"PROG {0.30 + 0.65 * done / len(starts):.3f}", file=sys.stderr, flush=True)
    return beat, down


def deduplicate_peaks(peaks, width=1) -> np.ndarray:
    """Verbatim port of beat_this.model.postprocessor.deduplicate_peaks."""
    result = []
    peaks = map(int, peaks)
    try:
        p = next(peaks)
    except StopIteration:
        return np.array(result)
    c = 1
    for p2 in peaks:
        if p2 - p <= width:
            c += 1
            p += (p2 - p) / c  # update mean
        else:
            result.append(p)
            p = p2
            c = 1
    result.append(p)
    return np.array(result)


def peak_times(logits: np.ndarray) -> np.ndarray:
    """Minimal postprocessor peak picking: 7-wide max filter, logits > 0."""
    padded = np.pad(logits, 3, constant_values=-np.inf)
    maxf = np.lib.stride_tricks.sliding_window_view(padded, 7).max(-1)
    frames = np.nonzero((logits == maxf) & (logits > 0))[0]
    return deduplicate_peaks(frames, width=1) / FPS


def postprocess(beat_logits, downbeat_logits) -> tuple[np.ndarray, np.ndarray]:
    beat_time = peak_times(beat_logits)
    downbeat_time = peak_times(downbeat_logits)
    if len(beat_time) > 0:  # move each downbeat to the nearest beat (upstream)
        for i, d_time in enumerate(downbeat_time):
            beat_idx = np.argmin(np.abs(beat_time - d_time))
            downbeat_time[i] = beat_time[beat_idx]
    downbeat_time = np.unique(downbeat_time)
    return beat_time, downbeat_time


def sigmoid(x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-np.clip(x, -80.0, 80.0)))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--f32", required=True)
    ap.add_argument("--sr", type=int, required=True)
    ap.add_argument("--device", default="auto", choices=["auto", "mps", "cpu"],
                    help="accepted for protocol parity; this flavor is CPU-only")
    ap.add_argument("--models", default=None,
                    help="models dir override (build-time smoke/parity only)")
    args = ap.parse_args()

    if args.sr != SR:
        print(f"the ONNX beat runner expects {SR} Hz input, got {args.sr}",
              file=sys.stderr)
        return 2
    models_dir = (Path(args.models) if args.models
                  else Path(__file__).resolve().parent / "models" / "beat_this")
    logmel_path = models_dir / "logmel.onnx"
    model_path = models_dir / "beat_this.onnx"
    for p in (logmel_path, model_path):
        if not p.is_file():
            print(f"missing model: {p}", file=sys.stderr)
            return 2

    signal = np.fromfile(args.f32, dtype=np.float32)
    if signal.size == 0:
        print(f"empty or unreadable f32 input: {args.f32}", file=sys.stderr)
        return 2

    t0 = time.time()
    import onnxruntime as ort
    opts = ort.SessionOptions()
    opts.log_severity_level = 3  # errors only; stderr is for our progress
    providers = ["CPUExecutionProvider"]  # CPU ONLY — never DirectML/CoreML here
    mel_sess = ort.InferenceSession(str(logmel_path), opts, providers=providers)
    model_sess = ort.InferenceSession(str(model_path), opts, providers=providers)
    print("PROG 0.15", file=sys.stderr, flush=True)
    print("running Beat This (ONNX, cpu)", file=sys.stderr, flush=True)

    spect = compute_logmel(signal, mel_sess)
    print("PROG 0.28", file=sys.stderr, flush=True)
    beat_logits, downbeat_logits = run_model(spect, model_sess)
    beats, downbeats = postprocess(beat_logits, downbeat_logits)
    beat_prob = sigmoid(beat_logits)
    downbeat_prob = sigmoid(downbeat_logits)
    print(f"analyzed {signal.size / SR:.1f}s of audio in {time.time() - t0:.1f}s",
          file=sys.stderr, flush=True)

    print(json.dumps({
        "beats": [round(float(b), 3) for b in beats],
        "downbeats": [round(float(d), 3) for d in downbeats],
        "beat_prob": [round(float(p), 3) for p in beat_prob],
        "downbeat_prob": [round(float(p), 3) for p in downbeat_prob],
        "fps": FPS,
    }), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Synthesize the deterministic beat fixture the pack builds smoke against.

Writes raw float32le mono PCM: a 120 bpm 4/4 drum-machine pattern — kick on
every beat (accented + cymbal wash on the downbeat, so downbeats are
inferable), snare on 2 and 4, closed hats on the eighths. Unambiguous tempo
and meter for Beat This! without needing real music at build time. numpy
only, fixed seed. Used by build-gpu-pack.sh (beat smoke) and
build-onnx-pack.sh (torch-vs-ONNX parity gate).
"""
import argparse

import numpy as np


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--sr", type=int, default=22050)
    ap.add_argument("--secs", type=float, default=60.0)
    args = ap.parse_args()

    sr = args.sr
    n = int(sr * args.secs)
    rng = np.random.default_rng(20260730)
    y = np.zeros(n + sr, dtype=np.float64)  # slack for the last hit's tail

    def add(t: float, sig: np.ndarray) -> None:
        i = int(round(t * sr))
        y[i:i + len(sig)] += sig

    def kick(amp: float) -> np.ndarray:
        t = np.arange(int(0.10 * sr)) / sr
        freq = 120.0 * np.exp(-t * 18) + 45.0  # pitch drop, like a real kick
        phase = 2 * np.pi * np.cumsum(freq) / sr
        return amp * np.sin(phase) * np.exp(-t * 22)

    def snare(amp: float) -> np.ndarray:
        t = np.arange(int(0.08 * sr)) / sr
        noise = rng.standard_normal(len(t))
        tone = np.sin(2 * np.pi * 190 * t)
        return amp * (0.7 * noise + 0.5 * tone) * np.exp(-t * 35)

    def hat(amp: float) -> np.ndarray:
        t = np.arange(int(0.02 * sr)) / sr
        return amp * rng.standard_normal(len(t)) * np.exp(-t * 300)

    def crash(amp: float) -> np.ndarray:
        # short: a long wash rings into beat 2 and reads as a second downbeat
        t = np.arange(int(0.35 * sr)) / sr
        return amp * rng.standard_normal(len(t)) * np.exp(-t * 14)

    def bass(freq: float, amp: float) -> np.ndarray:
        # held for the bar; the per-bar chord change is the strongest
        # downbeat cue there is
        t = np.arange(int(1.9 * sr)) / sr
        env = np.minimum(t / 0.01, 1.0) * np.exp(-t * 1.2)
        return amp * env * (np.sin(2 * np.pi * freq * t)
                            + 0.35 * np.sin(2 * np.pi * 2 * freq * t))

    beat = 0.5  # 120 bpm
    for b in range(int(args.secs / beat)):
        t = b * beat
        bar_pos = b % 4
        add(t, kick(1.0 if bar_pos == 0 else 0.72))
        if bar_pos == 0:
            add(t, crash(0.22))
            add(t, bass(82.41 if (b // 4) % 2 == 0 else 110.0, 0.28))
        if bar_pos in (1, 3):
            add(t, snare(0.55))
        add(t, hat(0.22))
        add(t + beat / 2, hat(0.16))

    y = y[:n]
    peak = np.max(np.abs(y))
    y = (0.9 * y / (peak if peak > 0 else 1.0)).astype(np.float32)
    y.tofile(args.out)
    print(f"wrote {args.out}: {args.secs:.0f}s @ {sr} Hz, 120 bpm, "
          "downbeat every 4 beats")


if __name__ == "__main__":
    main()

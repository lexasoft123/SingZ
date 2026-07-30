#!/usr/bin/env python3
"""Assert a beat_runner JSON output describes the 120 bpm fixture.

Usage: beat_runner_check.py <runner-output.json>

Gate for the pack builds' beat smoke: the runner's one JSON line must parse,
report 115-125 beats over the 60 s fixture, a median beat interval of
0.5 +/- 0.02 s, and downbeats spaced 4 beats apart (first/last bar may be
clipped by the model's borders — edge slop allowed). Stdlib only.
"""
import json
import statistics
import sys


def main() -> int:
    with open(sys.argv[1]) as f:
        lines = [ln for ln in f.read().splitlines() if ln.strip()]
    if len(lines) != 1:
        print(f"expected exactly one JSON line, got {len(lines)}", file=sys.stderr)
        return 1
    out = json.loads(lines[0])

    beats = out["beats"]
    downs = out["downbeats"]
    assert out["fps"] == 50, f"fps {out['fps']} != 50"
    assert len(out["beat_prob"]) == len(out["downbeat_prob"]) > 0, \
        "framewise probs missing or mismatched"
    assert all(b2 > b1 for b1, b2 in zip(beats, beats[1:])), "beats not ascending"

    nb = len(beats)
    assert 115 <= nb <= 125, f"expected 115-125 beats on the fixture, got {nb}"
    med = statistics.median(b2 - b1 for b1, b2 in zip(beats, beats[1:]))
    assert abs(med - 0.5) <= 0.02, f"median beat interval {med:.3f}s, want 0.5±0.02"

    assert len(downs) >= 10, f"only {len(downs)} downbeats found"
    nearest = [min(range(nb), key=lambda i: abs(beats[i] - d)) for d in downs]
    gaps = [j - i for i, j in zip(nearest, nearest[1:])]
    assert gaps and statistics.median(gaps) == 4, f"downbeat gaps median != 4: {gaps}"
    off = sum(1 for g in gaps if g != 4)
    assert off <= 2, f"downbeat spacing not 4 beats apart: {gaps}"

    print(f"beat check OK: {nb} beats (median interval {med:.3f}s), "
          f"{len(downs)} downbeats every 4 beats")
    return 0


if __name__ == "__main__":
    sys.exit(main())

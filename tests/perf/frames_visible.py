#!/usr/bin/env python3
"""Visible live presented-frame runs for the native macOS app (C-07, D-02 5.3).

Launches the `ui-tests` binary with a VISIBLE, muted window, drives it through the
control directory (`SINGZ_GPUI_FRAMES_VISIBLE`), and reports presented fps, frame
time and dropped frames from the present observer in the C-06 frame slots.

  python3 tests/perf/frames_visible.py --binary target/debug/singz-gpui-player \
      --scenario static --seconds 60 --out /tmp/frames-static.json

Scenarios and what they must show (D-02 section 9, C-07 mac leg):
  static     a continuously animating empty window: panel rate within 1%, 0 dropped
  stall      negative control: a 25 ms sleep every 60th frame: >= 1 dropped per second
  idle       nothing animating (paused): 0 presented samples
  notify100  negative control: a repeating 100 ms notify: about 10 samples per second

The window must be on screen, unoccluded and key; the Mac on mains power with Low
Power Mode off. Unfit environments are rejected, not averaged. A 120 Hz panel run is
deferred until such a panel exists; this gate runs at the panel rate it finds (60 Hz).
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
from typing import Any

spec = importlib.util.spec_from_file_location("perf_harness", Path(__file__).with_name("perf_harness.py"))
perf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(perf)

SCENARIOS = {"static": "static", "stall": "stall", "idle": "off", "notify100": "notify100", "launch": "off"}
# Scenarios whose verdict needs presented timing; the rest count presents (callbacks) only.
TIMED = ("static", "stall")
SOURCE_PRESENTED = "presentedTime"


def p99_limit_ms(hz: float) -> float:
    """p99 present-to-present gap bound: the panel period plus 0.2% (16.7 ms at 60 Hz)."""
    return 1002.0 / hz


def evaluate(scenario: str, seconds: float, hz: float, frames: dict[str, Any]) -> list[str]:
    """Failures of the scenario's pass condition; empty means it passed. Bounds are fixed."""
    failures = []
    samples = frames.get("presentedSamples")
    if scenario == "launch":
        return failures  # diagnostic capture of launch activity, not a gate
    if scenario == "idle":
        if samples != 0:
            failures.append(f"idle window presented {samples} frames, expected 0")
        return failures
    if scenario == "notify100":
        expected = 10 * seconds
        if not isinstance(samples, int) or abs(samples - expected) > 0.1 * expected:
            failures.append(f"100 ms notify presented {samples} frames, expected about {expected:.0f}")
        return failures
    if frames.get("fps") is None:
        return [f"no frame rate measured: {frames.get('reason')}"]
    if scenario == "static":
        if abs(frames["fps"] - hz) / hz > 0.01:
            failures.append(f"fps {frames['fps']:.3f} is not within 1% of the {hz} Hz panel")
        if frames["dropped"] != 0:
            failures.append(f"{frames['dropped']} dropped frames, expected 0")
        p99 = frames["frameTimeMs"]["p99"]
        if p99 > p99_limit_ms(hz):
            failures.append(f"frame time p99 {p99:.2f} ms exceeds {p99_limit_ms(hz):.2f} ms")
    elif scenario == "stall":
        stalls = frames.get("stallsInjected")
        if not isinstance(stalls, int) or stalls <= 0:
            failures.append("no stalls were injected, so the control proves nothing")
        elif frames["dropped"] < stalls:
            failures.append(f"{frames['dropped']} dropped for {stalls} injected 25 ms stalls, expected at least one per stall")
    return failures


def gate(scenario: str, failures: list[str], frames: dict[str, Any], busy: bool) -> str:
    """pass | fail | inconclusive | unvalidated | diagnostic.

    Timing scenarios are only gated on real presentedTime. When the display never fills it,
    the figures come from the handler callback clock and are diagnostic, never a pass."""
    if scenario == "launch":
        return "diagnostic"
    if scenario in TIMED and frames.get("timeSource") != SOURCE_PRESENTED:
        return "unvalidated"
    if not failures:
        return "pass"
    return "inconclusive" if busy else "fail"


class Rejected(ValueError):
    """The run was disturbed (busy machine, window lost): rejected, not averaged; may be retried."""


def environment_now() -> dict[str, Any]:
    """Display/power/thermal state; system_profiler can fail transiently on a loaded machine."""
    for attempt in range(3):
        environment = perf.mac_frame_environment()
        if environment["displays"]:
            return environment
        time.sleep(2)
    return environment


def wait_for_quiet(args: argparse.Namespace) -> dict[str, Any]:
    """Wait up to --wait-quiet seconds for a quiet machine, then run anyway, recording the load.

    Load never decides pass or fail: a passing run counts whatever the load, and a failing run
    made under a busy machine is inconclusive (retried), see run()."""
    deadline = time.monotonic() + args.wait_quiet
    while True:
        environment = environment_now()
        perf.reject_unfit_environment(environment)
        try:
            perf.reject_busy_machine(environment["loadAvg1"], environment["cpuCount"], args.max_load_per_core)
            environment["startedQuiet"] = True
            return environment
        except ValueError:
            if time.monotonic() >= deadline:
                environment["startedQuiet"] = False
                return environment
            time.sleep(10)


def run(args: argparse.Namespace) -> dict[str, Any]:
    environment = wait_for_quiet(args)
    hz = args.hz or environment["displays"][0]["refreshHz"]
    control = Path(tempfile.mkdtemp(prefix="singz-frames-"))
    config = Path(tempfile.mkdtemp(prefix="singz-frames-config-"))
    env = {k: v for k, v in os.environ.items() if not k.startswith("SINGZ_")}
    env.update(SINGZ_MUTE="1", SINGZ_NO_SYNC="1", SINGZ_GPUI_CONFIG_DIR=str(config),
               SINGZ_GPUI_FRAMES_VISIBLE=str(control))
    proc = subprocess.Popen([args.binary], env=env, start_new_session=True)
    details: dict[str, Any] = {}
    try:
        details["launch"] = perf.request_action(control, "launch", 60)
        # Launch-time activity (catalog scan, entrance animations) keeps the window presenting for
        # roughly 13 s after launch (measured); the idle gate starts well after that.
        mode = SCENARIOS[args.scenario]
        details["animate"] = perf.request_action(control, "animate", 30, {"mode": mode})
        settle = 0 if args.scenario == "launch" else args.settle
        started = time.monotonic()
        time.sleep(settle)
        perf.request_action(control, "frames", 30, {"op": "start", "poll": not args.no_window_poll})
        t0 = time.monotonic()
        if args.scenario == "launch":
            # Early capture from the moment the window is up; probe the app's state meanwhile.
            probes = []
            while time.monotonic() - t0 < args.seconds:
                probes.append({"atS": round(time.monotonic() - t0, 1), **perf.request_action(control, "probe", 30)["detail"]})
                time.sleep(2)
            details["probes"] = probes
        else:
            time.sleep(args.seconds)
        stop = perf.request_action(control, "frames", 60, {"op": "stop"})
        details["frames"] = stop
        raw = control / "frames.json"  # per-sample presented times, kept for audit
        if raw.is_file():
            shutil.copy(raw, args.out.with_suffix(".presented.json"))
        perf.request_action(control, "animate", 30, {"mode": "off"})
        perf.request_action(control, "quit", 30)
        proc.wait(timeout=60)
    finally:
        if proc.poll() is None:
            proc.terminate()
            try: proc.wait(timeout=10)
            except subprocess.TimeoutExpired: proc.kill()
    frames = perf.frame_slots(stop.get("detail"))
    end = environment_now()
    environment["loadAvg1End"] = end["loadAvg1"]
    perf.reject_unfit_environment(end)
    if frames.get("hidden") or frames.get("windowLostTicks"):
        raise Rejected(f"window was hidden or lost key status for {frames.get('windowLostTicks')} of "
                       f"{frames.get('windowTicks')} sampled ticks: visible runs need an unoccluded, key window")
    failures = evaluate(args.scenario, args.seconds, hz, frames)
    busy = max(environment["loadAvg1"], end["loadAvg1"]) > args.max_load_per_core * end["cpuCount"]
    environment["busy"] = busy
    # The bounds are not touched: a failure on a machine other work was saturating may say
    # nothing about the app, so such a run is retried; the last one is still recorded.
    verdict = gate(args.scenario, failures, frames, busy)
    inconclusive = verdict == "inconclusive"
    return {"schema": "singz.perf.frames-live.v1", "scenario": args.scenario, "seconds": args.seconds,
            "panelHz": hz, "environment": environment, "frames": frames,
            "deferred": {"120Hz": "deferred until a 120 Hz panel exists; not failed"},
            "failures": failures, "gate": verdict, "passed": verdict == "pass", "inconclusive": inconclusive,
            "coverage": ("starts %gs after launch; the first %gs are not covered by this gate (see the launch scenario)" % (settle, settle)
                         if args.scenario != "launch" else "starts at launch; diagnostic only"),
            "receipts": details}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", required=True, help="ui-tests build of singz-gpui-player")
    parser.add_argument("--scenario", choices=sorted(SCENARIOS), required=True)
    parser.add_argument("--seconds", type=float, default=60)
    parser.add_argument("--settle", type=float, default=25, help="seconds between starting the scenario and recording")
    parser.add_argument("--no-window-poll", action="store_true", help="diagnostic: do not sample window visibility while recording")
    parser.add_argument("--hz", type=float, help="override the panel rate (default: the display's current mode)")
    parser.add_argument("--max-load-per-core", type=float, default=0.5,
                        help="reject a run whose 1-minute load average exceeds this per core, at start or end")
    parser.add_argument("--wait-quiet", type=float, default=0, help="seconds to wait for the machine to go quiet before launching")
    parser.add_argument("--attempts", type=int, default=1, help="retries of a run rejected as disturbed (never of a failed gate)")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)
    if not Path(args.binary).is_file():
        parser.error("binary not found")
    result = None
    for attempt in range(1, args.attempts + 1):
        try:
            result = run(args)
            result["attempt"] = attempt
            if not result["inconclusive"] or attempt == args.attempts:
                break
            print(f"attempt {attempt}: inconclusive (failed on a busy machine): {'; '.join(result['failures'])}", file=sys.stderr)
        except Rejected as error:
            print(f"attempt {attempt}: {error}", file=sys.stderr)
            if attempt == args.attempts:
                parser.error(str(error))
        except (OSError, ValueError, TimeoutError, subprocess.SubprocessError) as error:
            parser.error(str(error))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=2) + "\n")
    f = result["frames"]
    print(f"{args.scenario}: fps={f['fps']} samples={f.get('presentedSamples')} dropped={f['dropped']} "
          f"panel={result['panelHz']}Hz -> {result['gate'].upper()} {'; '.join(result['failures'])} src={f.get('timeSource')} stalls={f.get('stallsInjected')} p99={(f.get('frameTimeMs') or {}).get('p99')} "
          f"load={result['environment']['loadAvg1']:.1f}/{result['environment']['loadAvg1End']:.1f} perSecond={f.get('perSecond', [])[:12]}")
    return {"pass": 0, "diagnostic": 0, "inconclusive": 2, "unvalidated": 3}.get(result["gate"], 1)


if __name__ == "__main__":
    sys.exit(main())

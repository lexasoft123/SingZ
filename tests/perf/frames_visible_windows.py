#!/usr/bin/env python3
"""Visible presented-frame runs for the native app on Windows (C-07 Windows leg, Q-02).

The macOS observer behind `frames_visible.py` does not exist on Windows; the frames come from
PresentMon through `experiments/gpui-player/tests/windows_gpu_sampler.ps1` (capture mode), which
also gives the GPU and DWM share (N8). This driver launches the `ui-tests` binary with a visible,
muted window, puts it in the same scenario `frames_visible.py` uses (`static`: a continuously
animating empty window; `idle`: nothing animating), records `--seconds` of it with the sampler,
and applies the same pass conditions. Run it in the logged-in desktop session (a one-off
`schtasks /it` task), with the display awake, on mains power, with nothing over the window.

  python tests/perf/frames_visible_windows.py --binary singz-gpui-player.exe --scenario static \
      --seconds 60 --hz 60 --out frames-static-1.json

The output is the `frames_visible.py` document with the sampler's JSON under `sampler`, so
`baseline_aggregate.py --frames` reads it like a Mac run. `--hz` is the panel rate the drop
accounting is judged against (the sampler cannot read it back from PresentMon).
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from typing import Any

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("frames_visible", HERE / "frames_visible.py")
visible = importlib.util.module_from_spec(spec)
spec.loader.exec_module(visible)
perf = visible.perf
SAMPLER = HERE.parents[1] / "experiments/gpui-player/tests/windows_gpu_sampler.ps1"
SCENARIOS = {"static": "static", "idle": "off", "playing": "off"}  # `playing` is Electron only: the native visible scenario cannot open or play a song


def frames_from_sampler(document: dict[str, Any]) -> dict[str, Any]:
    """The sampler's frames block in the shape `frames_visible.evaluate` judges."""
    if document.get("schema") != "singz.perf.windows-frames.v1":
        raise ValueError("unsupported frames document schema")
    frames = dict(document.get("frames") or {})
    frames["timeSource"] = visible.SOURCE_PRESENTED  # PresentMon presented time: CPUStartTime + DisplayLatency, or TimeInMs + MsUntilDisplayed (2.3.1)
    frames["hidden"] = bool(document.get("hidden"))
    return frames


def judge(scenario: str, seconds: float, hz: float, document: dict[str, Any]) -> dict[str, Any]:
    frames = frames_from_sampler(document)
    if scenario == "playing":  # reference playback: figures only, no pass condition is defined for it
        return {"frames": frames, "failures": [], "gate": "diagnostic", "passed": False}
    failures = visible.evaluate(scenario, seconds, hz, frames)
    verdict = visible.gate(scenario, failures, frames, busy=False)
    return {"frames": frames, "failures": failures, "gate": verdict, "passed": verdict == "pass"}


def launch(args: argparse.Namespace, control: Path, config: Path) -> tuple[subprocess.Popen, int | None, dict[str, Any]]:
    """Start the app visible and muted; return (process, pid of the process tree root, receipts)."""
    env = {k: v for k, v in os.environ.items() if not k.startswith("SINGZ_")}
    receipts: dict[str, Any] = {}
    if args.app == "native":
        env.update(SINGZ_MUTE="1", SINGZ_NO_SYNC="1", SINGZ_GPUI_CONFIG_DIR=str(config), SINGZ_GPUI_FRAMES_VISIBLE=str(control))
        proc = subprocess.Popen([args.binary], env=env)
        receipts["launch"] = perf.request_action(control, "launch", 60)
        receipts["animate"] = perf.request_action(control, "animate", 30, {"mode": SCENARIOS[args.scenario]})
        return proc, proc.pid, receipts
    reference = json.loads(Path(args.reference_json).read_text())
    env.update(SINGZ_PERF_CONTROL_DIR=str(control), SINGZ_PERF_VISIBLE="1", SINGZ_USERDATA_DIR=reference["prefs"],
               SINGZ_PERF_SONGS=json.dumps(reference["names"]), SINGZ_PERF_STEP_TIMEOUT="120", SINGZ_PERF_REQUIRE_NATIVE="1")
    proc = subprocess.Popen(["node", str(Path(args.electron_root) / "tests/perf/electron_driver.cjs")], env=env, cwd=args.electron_root)
    receipts["launch"] = perf.request_action(control, "launch", 180)
    receipts["open"] = perf.request_action(control, "open", 180)
    if args.scenario == "playing":
        receipts["play"] = perf.request_action(control, "play", 180)
    return proc, receipts["launch"]["detail"]["pid"], receipts


def run(args: argparse.Namespace) -> dict[str, Any]:
    control = Path(tempfile.mkdtemp(prefix="singz-frames-"))
    config = Path(tempfile.mkdtemp(prefix="singz-frames-config-"))
    capture = control / "sampler.json"
    if args.presentmon:
        os.environ["SINGZ_PRESENTMON"] = args.presentmon
    proc = None
    try:
        proc, root, receipts = launch(args, control, config)
        time.sleep(args.settle)
        name = "singz-gpui-player" if args.app == "native" else "electron"
        command = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(SAMPLER),
                   "-ProcessName", name, "-RootPid", str(root), "-Seconds", str(args.seconds),
                   "-ExpectedHz", str(args.hz), "-CaptureOut", str(capture)]
        if args.scenario == "idle":
            command.append("-NoDemand")
        done = subprocess.run(command, capture_output=True, text=True, timeout=args.seconds + 120)
        if done.returncode != 0 or not capture.is_file():
            raise RuntimeError(f"sampler failed ({done.returncode}): {(done.stderr or done.stdout).strip()[-600:]}")
        document = json.loads(capture.read_text(encoding="utf-8-sig"))
        if args.app == "native":
            perf.request_action(control, "animate", 30, {"mode": "off"})
        perf.request_action(control, "quit", 60)
        proc.wait(timeout=60)
    finally:
        if proc is not None and proc.poll() is None:
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], check=False, capture_output=True)
    result = judge(args.scenario, args.seconds, args.hz, document)
    return {"schema": "singz.perf.frames-live.v1", "platform": "windows", "app": args.app, "scenario": args.scenario, "seconds": args.seconds,
            "panelHz": args.hz, **result, "inconclusive": False,
            "deferred": {"120Hz": "deferred until a 120 Hz panel exists; not failed"},
            "coverage": f"starts {args.settle:g}s after launch; the first {args.settle:g}s are not covered by this gate",
            "sampler": document, "receipts": receipts}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--app", choices=("native", "electron"), default="native")
    parser.add_argument("--binary", help="native: ui-tests build of singz-gpui-player.exe")
    parser.add_argument("--electron-root", help="electron: built tree of the release tag with tests/perf/electron_driver.cjs")
    parser.add_argument("--reference-json", type=Path, help="electron: staged reference library (stage_reference_copy.py output)")
    parser.add_argument("--scenario", choices=sorted(SCENARIOS), required=True)
    parser.add_argument("--seconds", type=float, default=60)
    parser.add_argument("--settle", type=float, default=25, help="seconds between starting the scenario and recording")
    parser.add_argument("--hz", type=float, default=60, help="the panel rate the run is judged against")
    parser.add_argument("--presentmon", help="path to PresentMon.exe (default: PATH or SINGZ_PRESENTMON)")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)
    if os.name != "nt":
        parser.error("this driver is for Windows; use frames_visible.py on macOS")
    if args.app == "native" and not (args.binary and Path(args.binary).is_file()):
        parser.error("--binary must name the native player")
    if args.app == "electron" and not (args.electron_root and args.reference_json):
        parser.error("--electron-root and --reference-json are required for electron")
    if args.app == "native" and args.scenario == "playing":
        parser.error("the native visible scenario cannot play a song")
    try:
        result = run(args)
    except (OSError, ValueError, RuntimeError, TimeoutError, subprocess.SubprocessError) as error:
        parser.error(str(error))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=2) + "\n")
    f = result["frames"]
    print(f"{args.scenario}: fps={f.get('fps')} samples={f.get('presentedSamples')} dropped={f.get('dropped')} "
          f"p99={(f.get('frameTimeMs') or {}).get('p99')} -> {result['gate'].upper()} {'; '.join(result['failures'])}")
    return {"pass": 0, "diagnostic": 0, "unvalidated": 3}.get(result["gate"], 1)


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""C-35 perf smoke gate: the plan's section 3.3 smoke checks on a release ui-tests build.

    python3 tests/perf/smoke_gate.py --binary experiments/gpui-player/target/release/singz-gpui-player \
        --out-dir out/perf-smoke

Three legs, each a hidden, muted launch of the same binary:
  probe     idle redraw demand (library, paused player, modal) and, during steady playback,
            allocations in lane/playhead paint, main-thread rasterizations and waveform cache misses;
  harness   the C-06 `smoke` scenario: completion, song open, startup, starvedBlocks, CPU, footprint;
  offscreen the offscreen render+readback benchmark: throughput and prepare+draw p95 (per-frame cost).

smoke_thresholds.json holds the limits (from Q-02, with the stated margin). Gated metrics fail the job
and print their delta; info metrics are printed with their Q-02 reference and never fail it. A metric
that could not be measured fails: nothing passes by being absent.

Negative control: `--inject-frame-sleep-ms N` (or SINGZ_PERF_INJECT_FRAME_SLEEP_MS=N) makes the
ui-tests build sleep N ms on every offscreen frame; the gate must then be red.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import math
import os
from pathlib import Path
import platform
import shlex
import subprocess
import sys
import tempfile
import time
from typing import Any

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
GPUI = ROOT / "experiments" / "gpui-player"
THRESHOLDS = HERE / "smoke_thresholds.json"
INJECT_ENV = "SINGZ_PERF_INJECT_FRAME_SLEEP_MS"


def _load(name: str, path: Path) -> Any:
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


perf = _load("perf_harness", HERE / "perf_harness.py")
aggregate = _load("baseline_aggregate", HERE / "baseline_aggregate.py")


def _finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def evaluate(measured: dict[str, Any], spec: dict[str, Any]) -> list[dict[str, Any]]:
    """One row per gated and info metric. Gated rows get ok/FAIL; info rows get `info`."""
    rows = []
    for name, gate in spec["gates"].items():
        value = measured.get(name)
        row = {"name": name, "kind": "gate", "label": gate["label"], "unit": gate["unit"], "op": gate["op"],
               "limit": gate["limit"], "q02": gate.get("q02"), "value": value if _finite(value) else None}
        if not _finite(value):
            row.update(status="FAIL", delta=None, note="measurement unavailable")
        else:
            # delta > 0 is always the wrong side of the limit.
            delta = value - gate["limit"] if gate["op"] == "<=" else gate["limit"] - value
            row.update(status="FAIL" if delta > 0 else "ok", delta=delta, note="")
        rows.append(row)
    for name, item in spec["info"].items():
        value = measured.get(name)
        rows.append({"name": name, "kind": "info", "label": item["label"], "unit": item["unit"], "op": None,
                     "limit": None, "q02": item.get("q02"), "value": value if _finite(value) else None,
                     "status": "info", "delta": None, "note": item["why"]})
    return rows


def format_rows(rows: list[dict[str, Any]]) -> str:
    def number(value: Any) -> str:
        if value is None:
            return "-"
        return f"{value:.4g}" if isinstance(value, float) else str(value)

    lines = [f"{'metric':<42} {'measured':>12} {'limit':>12} {'delta':>12} {'Q-02':>12}  status"]
    for row in rows:
        limit = "-" if row["limit"] is None else f"{row['op']} {number(row['limit'])}"
        lines.append(f"{row['name']:<42} {number(row['value']):>12} {limit:>12} {number(row['delta']):>12} {number(row['q02']):>12}  {row['status']}"
                     + (f"  ({row['note']})" if row["note"] and row["kind"] == "gate" else ""))
    failed = [row for row in rows if row["status"] == "FAIL"]
    for row in failed:
        if row["delta"] is None:
            lines.append(f"REGRESSION {row['name']}: {row['label']} not measured")
        else:
            lines.append(f"REGRESSION {row['name']}: {row['label']}: {number(row['value'])} {row['unit']}, "
                         f"limit {row['op']} {number(row['limit'])}, {number(row['delta'])} {row['unit']} past the limit")
    return "\n".join(lines)


def probe_metrics(windows: dict[str, Any]) -> dict[str, Any]:
    """Reduce the probe's receipts to metrics. Any missing receipt leaves its metric unmeasured."""
    def demanded(key: str) -> Any:
        value = windows.get(key, {}).get("demandedFrames")
        return value if _finite(value) else None

    def delta(key: str) -> Any:
        before, after = windows.get("before", {}), windows.get("after", {})
        a, b = before.get(key), after.get(key)
        return b - a if _finite(a) and _finite(b) else None

    playback = windows.get("steady", {}).get("demandedFrames")
    return {"idleLibraryDemandedFrames": demanded("idleLibrary"), "pausedPlayerDemandedFrames": demanded("pausedPlayer"),
            "modalOpenDemandedFrames": demanded("modalOpen"),
            # Playback must actually have demanded frames, or "0 allocations" proves nothing.
            "steadyPlaybackPaintAllocations": delta("lanePlayheadPaintAllocations") if _finite(playback) and playback > 100 else None,
            "steadyPlaybackMainThreadRasterizations": delta("mainThreadRasterizations"),
            "steadyPlaybackWaveformCacheMisses": delta("waveformCacheMisses")}


def harness_metrics(report: dict[str, Any]) -> dict[str, Any]:
    metrics = report["metrics"]
    starved = aggregate.starved({"metrics": metrics})
    return {"hiddenScenarioComplete": 1 if report.get("complete") is True else 0, "songOpenMs": metrics["songOpenMs"],
            "startupMs": metrics["startupMs"], "starvedBlocksTotal": starved["total"],
            "idleCpuPercent": aggregate.mean_cpu(report, "pause"), "playingCpuPercent": aggregate.mean_cpu(report, "play"),
            "steadyFootprintBytes": metrics["footprintBytes"], "packageSizeBytes": metrics["packageSizeBytes"]}


def offscreen_metrics(report: dict[str, Any]) -> dict[str, Any]:
    renderer = report.get("renderer", {})
    # The offscreen script judges more than throughput: hidden execution, a painted
    # moving glow, enough frames and samples, valid readbacks. Its throughput verdict
    # is gated separately below, so only the other (structural) failures count here.
    failures = report.get("failures")
    structural = (None if not isinstance(failures, list) else
                  len([f for f in failures if not str(f).startswith("offscreen throughput ")]))
    return {"offscreenFramesPerSecond": renderer.get("offscreenFramesPerSecond"),
            "offscreenPrepareDrawP95Ms": (renderer.get("prepareAndDrawWallMs") or {}).get("p95"),
            "offscreenStructuralFailures": structural}


def stage_library(directory: Path) -> dict[str, Any]:
    """The Q-02 reference library: 300 s and 720 s, six stems, lyrics and a stored pitch line."""
    result = subprocess.run(["node", str(HERE / "make_reference.cjs"), str(directory)], check=True, capture_output=True, text=True)
    return json.loads(result.stdout)


def app_environment(reference: dict[str, Any], scratch: Path, helpers: Path) -> dict[str, str]:
    environment = {key: value for key, value in os.environ.items() if not key.startswith("SINGZ_GPUI_")}
    config = scratch / "config"
    config.mkdir(exist_ok=True)
    environment.update(SINGZ_MUTE="1", SINGZ_NO_SYNC="1", SINGZ_E2E_HIDDEN="1", SINGZ_GPUI_BACKGROUND="1",
                       SINGZ_GPUI_TEST_NO_CAPTURE="1", SINGZ_GPUI_CONFIG_DIR=str(config),
                       SINGZ_GPUI_PROJECTS_ROOT=reference["library"], SINGZ_GPUI_TEST_PROJECT=reference["projects"][0],
                       SINGZ_GPUI_PERF_SECOND_PROJECT=reference["projects"][1],
                       SINGZ_GPUI_AUDIO_HELPER=str(helpers / "singz-gpui-audio"),
                       SINGZ_GPUI_ANALYZER=str(helpers / "singz-analyze"),
                       SINGZ_GPUI_INPUT_HELPER=str(helpers / "singz-gpui-input"),
                       SINGZ_PERF_STEP_TIMEOUT="60", SINGZ_PERF_BURST_SECONDS="3",
                       SINGZ_PERF_CYCLES="4", SINGZ_PERF_CYCLE_DELAY="0.2")
    return environment


def run_probe(binary: Path, reference: dict[str, Any], scratch: Path, helpers: Path, out_dir: Path, window: float) -> dict[str, Any]:
    control = scratch / "probe-control"
    control.mkdir()
    (scratch / "probe").mkdir()
    environment = app_environment(reference, scratch / "probe", helpers)
    environment["SINGZ_GPUI_PERF_SCENARIO"] = str(control)
    windows: dict[str, Any] = {}
    with (out_dir / "probe-app.log").open("w") as log:
        child = subprocess.Popen([str(binary)], env=environment, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            def act(name: str, **arguments: Any) -> dict[str, Any]:
                if child.poll() is not None:
                    raise RuntimeError(f"app exited before {name}; see probe-app.log")
                return perf.request_action(control, name, 120, arguments)["detail"]

            act("launch")
            windows["idleLibrary"] = act("idle-window", settleSeconds=2, seconds=window)
            act("open")
            windows["pausedPlayer"] = act("idle-window", settleSeconds=3, seconds=window)
            act("open-modal")
            windows["modalOpen"] = act("idle-window", settleSeconds=2, seconds=window)
            act("close-modal")
            act("play")
            act("steady-playback", settleSeconds=1, seconds=1)  # warm-up: scene and queue capacities
            windows["before"] = act("render-metrics")
            windows["steady"] = act("steady-playback", seconds=2, minFrames=120)
            windows["after"] = act("render-metrics")
            act("quit")
            child.wait(timeout=30)
        finally:
            if child.poll() is None:
                try:
                    os.killpg(child.pid, 9)
                except ProcessLookupError:
                    pass
    (out_dir / "probe.json").write_text(json.dumps(windows, indent=2) + "\n")
    return probe_metrics(windows)


def run_harness(binary: Path, reference: dict[str, Any], scratch: Path, helpers: Path, out_dir: Path, commit: str) -> dict[str, Any]:
    (scratch / "harness").mkdir()
    reference_file = scratch / "reference.json"
    reference_file.write_text(json.dumps(reference))
    environment = app_environment(reference, scratch / "harness", helpers)
    report_path = out_dir / "harness.json"
    command = [sys.executable, str(HERE / "perf_harness.py"), "--app", "native", "--command", shlex.quote(str(binary)),
               "--control-dir", str(scratch / "harness-control"), "--run-kind", "smoke", "--reference-json", str(reference_file),
               "--out", str(report_path), "--profile", "release+ui-tests", "--display", "hidden",
               "--machine", platform.platform(), "--commit", commit, "--package", str(binary), "--package-profile", "release",
               "--play", "10", "--burst", "3", "--pause", "8", "--cycles", "4", "--cycle-duration", "0.2", "--deadline", "120"]
    subprocess.run(command, check=True, env=environment, timeout=900)
    return harness_metrics(json.loads(report_path.read_text()))


def run_offscreen(binary: Path, out_dir: Path, minimum_fps: float) -> dict[str, Any]:
    out = out_dir / "offscreen.json"
    # Its own exit status reflects its own (throughput) gate; the report is judged here either way.
    subprocess.run([sys.executable, str(GPUI / "tests" / "interface-offscreen-perf.py"), "--skip-build", "--binary", str(binary),
                    "--seconds", "6", "--min-offscreen-fps", str(minimum_fps), "--out", str(out)], check=False, timeout=300,
                   stdout=subprocess.DEVNULL)
    return offscreen_metrics(json.loads(out.read_text()))


def commit_id() -> str:
    if os.environ.get("GITHUB_SHA"):
        return os.environ["GITHUB_SHA"]
    return subprocess.run(["git", "-C", str(ROOT), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip() or "unknown"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--binary", type=Path, required=True, help="release build of singz-gpui-player with --features ui-tests")
    parser.add_argument("--helpers", type=Path, help="directory with singz-gpui-audio, singz-analyze, singz-gpui-input (default: next to the binary)")
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--idle-seconds", type=float, default=5, help="length of each idle-redraw window")
    parser.add_argument("--inject-frame-sleep-ms", type=int, help=f"negative control: sets {INJECT_ENV}")
    args = parser.parse_args(argv)
    if platform.system() != "Darwin":
        parser.error("the smoke gate needs the macOS ui-tests build (hidden window, present observer)")
    if args.inject_frame_sleep_ms is not None:
        os.environ[INJECT_ENV] = str(args.inject_frame_sleep_ms)
    injected = os.environ.get(INJECT_ENV) or None
    if injected == "0":
        injected = None  # "0" is how the workflow input says off
    binary = args.binary.resolve()
    helpers = (args.helpers or binary.parent).resolve()
    args.out_dir.mkdir(parents=True, exist_ok=True)
    out_dir = args.out_dir.resolve()
    spec = json.loads(THRESHOLDS.read_text())
    if injected:
        print(f"NEGATIVE CONTROL: {INJECT_ENV}={injected}: this run is expected to fail", flush=True)
    measured: dict[str, Any] = {}
    errors: list[str] = []
    with tempfile.TemporaryDirectory(prefix="singz-perf-smoke-") as temporary:
        scratch = Path(temporary)
        reference: dict[str, Any] = {}
        try:
            reference = stage_library(scratch / "reference")
        except (subprocess.SubprocessError, ValueError, OSError) as error:
            errors.append(f"reference library: {error}")
        legs = {"probe": lambda: run_probe(binary, reference, scratch, helpers, out_dir, args.idle_seconds),
                "harness": lambda: run_harness(binary, reference, scratch, helpers, out_dir, commit_id()),
                "offscreen": lambda: run_offscreen(binary, out_dir, spec["gates"]["offscreenFramesPerSecond"]["limit"])}
        for leg, run_leg in legs.items():
            started = time.monotonic()
            try:
                if leg != "offscreen" and not reference:
                    raise RuntimeError("no reference library")
                measured.update(run_leg())
            except Exception as error:  # a failed leg leaves its metrics unmeasured, which fails them
                errors.append(f"{leg}: {type(error).__name__}: {error}")
            print(f"leg {leg}: {time.monotonic() - started:.0f} s", flush=True)
    rows = evaluate(measured, spec)
    print(format_rows(rows))
    for error in errors:
        print(f"ERROR {error}")
    failed = [row["name"] for row in rows if row["status"] == "FAIL"]
    summary = {"schema": "singz.perf.smoke.v1", "injectedFrameSleepMs": injected, "commit": commit_id(),
               "machine": platform.platform(), "measured": measured, "rows": rows, "errors": errors, "failed": failed,
               "passed": not failed and not errors}
    (out_dir / "smoke-gate.json").write_text(json.dumps(summary, indent=2) + "\n")
    print("PERF SMOKE " + ("PASSED" if summary["passed"] else f"FAILED: {', '.join(failed) or 'errors above'}"))
    return 0 if summary["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())

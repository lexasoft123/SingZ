#!/usr/bin/env python3
"""Hidden GPU render/readback throughput gate; explicitly not live display FPS."""
import argparse
import ctypes
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("interface_perf", Path(__file__).with_name("interface-perf.py"))
RESOURCE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RESOURCE)


def foreground_pid():
    """Read AppKit state without creating, activating or raising a window."""
    try:
        ctypes.CDLL("/System/Library/Frameworks/AppKit.framework/AppKit")
        objc = ctypes.CDLL("/usr/lib/libobjc.A.dylib")
        objc.objc_getClass.argtypes = [ctypes.c_char_p]
        objc.objc_getClass.restype = ctypes.c_void_p
        objc.sel_registerName.argtypes = [ctypes.c_char_p]
        objc.sel_registerName.restype = ctypes.c_void_p
        send = ctypes.CFUNCTYPE(ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p)(("objc_msgSend", objc))
        workspace = send(objc.objc_getClass(b"NSWorkspace"), objc.sel_registerName(b"sharedWorkspace"))
        application = send(workspace, objc.sel_registerName(b"frontmostApplication"))
        integer = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p)(("objc_msgSend", objc))
        return {"available": True, "pid": integer(application, objc.sel_registerName(b"processIdentifier"))}
    except (OSError, AttributeError) as error:
        return {"available": False, "reason": str(error)}


MAX_RSS_GROWTH_BYTES = 128 * 2**20


def rss_bytes(pid):
    value = subprocess.run(["ps", "-o", "rss=", "-p", str(pid)], check=True,
                           capture_output=True, text=True, timeout=2).stdout.strip()
    return int(value) * 1024


def evaluate(telemetry, resources, minimum_fps, maximum_cpu=None):
    failures = []
    if telemetry.get("kind") != "offscreenThroughput" or telemetry.get("liveFPS", "missing") is not None:
        failures.append("telemetry must distinguish offscreen throughput from unmeasured live FPS")
    if telemetry.get("hidden") is not True:
        failures.append("renderer did not confirm hidden execution")
    pixels = telemetry.get("imagePixels", [])
    if len(pixels) != 2 or not all(isinstance(value, int) and value > 0 for value in pixels):
        failures.append("completed readback image dimensions are missing/invalid")
    fps = telemetry.get("offscreenFramesPerSecond")
    if not isinstance(fps, (int, float)) or not math.isfinite(fps) or fps <= 0:
        failures.append("missing/invalid offscreen throughput")
    elif fps < minimum_fps:
        failures.append(f"offscreen throughput {fps:.2f} below {minimum_fps:g} completed images/s")
    if telemetry.get("frames", 0) < 3 or telemetry.get("measurementSeconds", 0) < 6:
        failures.append("insufficient measured frames or measurement duration")
    for key in ("frameIntervalMs", "prepareAndDrawWallMs", "gpuRenderReadbackWallMs"):
        summary = telemetry.get(key)
        if not isinstance(summary, dict) or not all(isinstance(summary.get(k), (int, float)) and
                math.isfinite(summary[k]) and summary[k] > 0 for k in ("mean", "p95", "p99", "max")):
            failures.append(f"missing/invalid {key}")
    if telemetry.get("movingGlowDrawsLowerBound", 0) <= 0 or telemetry.get("movingGlowCovered") is not True:
        failures.append("advancing glyph glow was not painted during measurement")
    if len(resources) < 3:
        failures.append("fewer than three measured process resource samples")
    if len(resources) >= 2:
        # Steady offscreen rendering must not accumulate memory per frame. A retained frame arena
        # grew about 500 MiB in six seconds; a correct run grows about 10 MiB.
        growth = resources[-1]["process_rss_bytes"] - resources[0]["process_rss_bytes"]
        if growth > MAX_RSS_GROWTH_BYTES:
            failures.append(f"process RSS grew {growth / 2**20:.0f} MiB during measurement, "
                            f"limit {MAX_RSS_GROWTH_BYTES / 2**20:.0f} MiB")
    for row in resources:
        if not math.isfinite(row["process_cpu_percent"]) or row["process_cpu_percent"] < 0:
            failures.append("invalid process CPU sample")
        if row["process_rss_bytes"] <= 0:
            failures.append("invalid RSS sample")
    if maximum_cpu is not None and resources:
        cpu = RESOURCE.summarize([row["process_cpu_percent"] for row in resources])["p95"]
        if cpu > maximum_cpu:
            failures.append(f"process CPU p95 {cpu:.1f}% above {maximum_cpu:g}%")
    return failures


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-build", action="store_true")
    parser.add_argument("--binary", type=Path, default=ROOT / "target/debug/singz-gpui-player")
    parser.add_argument("--warmup", type=float, default=2.)
    parser.add_argument("--seconds", type=float, default=8.)
    parser.add_argument("--min-offscreen-fps", type=float, default=50.)
    parser.add_argument("--max-cpu-percent", type=float)
    parser.add_argument("--out", type=Path, default=Path("/tmp/singz-gpui-offscreen-perf.json"))
    args = parser.parse_args()
    if platform.system() != "Darwin":
        parser.error("macOS resource counters are required; unavailable counters are never zero-filled")
    if not math.isfinite(args.warmup) or args.warmup < 0 or not math.isfinite(args.seconds) or args.seconds < 6:
        parser.error("use nonnegative warmup and at least six measured seconds")
    if not math.isfinite(args.min_offscreen_fps) or args.min_offscreen_fps <= 0:
        parser.error("throughput threshold must be positive")
    if args.max_cpu_percent is not None and (not math.isfinite(args.max_cpu_percent) or args.max_cpu_percent <= 0):
        parser.error("CPU threshold must be finite and positive")
    environment = {**os.environ}
    cargo = shutil.which("cargo") or "/tmp/singz-cargo/bin/cargo"
    if cargo.startswith("/tmp/singz-cargo/"):
        environment.update(CARGO_HOME="/tmp/singz-cargo", RUSTUP_HOME="/tmp/singz-rustup")
    if not args.skip_build:
        subprocess.run([cargo, "build", "--offline", "--locked", "--features", "ui-tests",
                        "--manifest-path", str(ROOT / "Cargo.toml"), "-j", "4"], check=True, env=environment)
    binary = args.binary.resolve()
    args.out = args.out.resolve()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    renderer_path = args.out.with_name(args.out.stem + "-renderer.json")
    stderr_path = args.out.with_suffix(".stderr.log")
    renderer_path.unlink(missing_ok=True)
    environment.update(SINGZ_GPUI_BACKGROUND="1", SINGZ_MUTE="1", SINGZ_NO_SYNC="1",
                       SINGZ_GPUI_OFFSCREEN_BENCHMARK=str(renderer_path),
                       SINGZ_GPUI_OFFSCREEN_WARMUP=str(args.warmup), SINGZ_GPUI_OFFSCREEN_SECONDS=str(args.seconds))
    # Inherited alternate test modes must not launch alongside this adapter.
    for name in ("SINGZ_GPUI_PROFILE", "SINGZ_GPUI_REVIEW_CAPTURE", "SINGZ_GPUI_UI_SMOKE", "SINGZ_GPUI_CAPTURE_FILE"):
        environment.pop(name, None)
    before_foreground = foreground_pid()
    child = subprocess.Popen([str(binary)], cwd=ROOT, env=environment,
                             stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    started = time.monotonic()
    measurement_started = threading.Event()
    lines, effects = [], []

    def read_stderr():
        for line in child.stderr:
            lines.append(line)
            if line.startswith("OFFSCREEN_MEASUREMENT_START"):
                measurement_started.set()
            if line.startswith("EFFECT_JSON "):
                try:
                    effects.append(json.loads(line[len("EFFECT_JSON "):]))
                except ValueError:
                    pass

    reader = threading.Thread(target=read_stderr, daemon=True)
    reader.start()
    failures, resources, telemetry = [], [], {}
    deadline = started + args.warmup + args.seconds + 45
    try:
        while not measurement_started.wait(.1):
            if child.poll() is not None:
                raise RuntimeError(f"player exited before measurement: {child.returncode}")
            if time.monotonic() > deadline:
                raise TimeoutError("offscreen benchmark did not begin")
        previous_cpu, _ = RESOURCE.process_usage(child.pid)
        previous_time = time.monotonic()
        while child.poll() is None:
            if time.monotonic() > deadline:
                raise TimeoutError("offscreen benchmark exceeded its bounded timeout")
            time.sleep(.5)
            if child.poll() is not None:
                break
            try:
                cpu, footprint = RESOURCE.process_usage(child.pid)
                rss = rss_bytes(child.pid)
            except (OSError, ValueError, subprocess.SubprocessError):
                # The same exit race can make a sampler raise; give the exit time to be reaped.
                try:
                    child.wait(timeout=2)
                    break
                except subprocess.TimeoutExpired:
                    pass
                raise
            if rss <= 0 or footprint <= 0:
                # An exiting process reads as zero memory before it can be reaped. Drop that
                # sample only if the process really exits; a live process at zero stays a failure.
                try:
                    child.wait(timeout=2)
                    break
                except subprocess.TimeoutExpired:
                    pass
            now = time.monotonic()
            foreground = foreground_pid()
            if foreground.get("pid") == child.pid:
                failures.append("benchmark window became foreground")
            resources.append({"elapsed_s": now - started,
                              "process_cpu_percent": (cpu - previous_cpu) / ((now - previous_time) * 1e9) * 100,
                              "process_rss_bytes": rss, "process_footprint_bytes": footprint,
                              "gpu_system": RESOURCE.gpu_usage(), "foreground": foreground})
            previous_cpu, previous_time = cpu, now
        if child.returncode != 0:
            failures.append(f"player exited with status {child.returncode}")
        if renderer_path.exists():
            telemetry = json.loads(renderer_path.read_text())
        else:
            failures.append("renderer telemetry file is missing")
    except Exception as error:
        failures.append(str(error))
    finally:
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=5)
        reader.join(timeout=2)
        child.stderr.close()
        stderr_path.write_text("".join(lines))
    failures += evaluate(telemetry, resources, args.min_offscreen_fps, args.max_cpu_percent)
    after_foreground = foreground_pid()
    gpu_samples = [device["percent"] for row in resources if row["gpu_system"]["available"]
                   for device in row["gpu_system"]["devices"]]
    report = {"schema": 1, "kind": "offscreenThroughput", "liveFPS": None,
              "platform": platform.platform(), "machine": platform.machine(), "pid": child.pid,
              "binary": str(binary), "binarySHA256": hashlib.sha256(binary.read_bytes()).hexdigest(),
              "buildSkipped": args.skip_build,
              "fixturePeaksSHA256": hashlib.sha256((ROOT / "assets/review-peaks.bin").read_bytes()).hexdigest(),
              "thresholds": {"minimumOffscreenFramesPerSecond": args.min_offscreen_fps,
                             "maximumProcessCpuPercent": args.max_cpu_percent},
              "renderer": telemetry, "resources": resources, "effectWindows": effects,
              "foregroundBefore": before_foreground, "foregroundAfter": after_foreground,
              "definitions": {"cpu": "process user+system time; 100% is one logical core",
                              "gpu": "IOAccelerator device-wide utilization includes all applications; not process GPU time",
                              "liveFPS": "unmeasured; hidden macOS windows suspend display callbacks"},
              "summary": {"process_cpu_percent": RESOURCE.summarize([r["process_cpu_percent"] for r in resources]),
                          "process_rss_bytes": RESOURCE.summarize([r["process_rss_bytes"] for r in resources]),
                          "process_footprint_bytes": RESOURCE.summarize([r["process_footprint_bytes"] for r in resources]),
                          "gpu_system_percent": RESOURCE.summarize(gpu_samples),
                          "gpu_utilization_available": bool(gpu_samples)},
              "rendererReport": str(renderer_path), "stderrLog": str(stderr_path),
              "passed": not failures, "failures": failures}
    args.out.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"passed": report["passed"], "liveFPS": None,
                      "offscreenFramesPerSecond": telemetry.get("offscreenFramesPerSecond"),
                      "summary": report["summary"], "failures": failures, "report": str(args.out)}, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())

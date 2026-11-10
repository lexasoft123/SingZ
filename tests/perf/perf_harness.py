#!/usr/bin/env python3
"""Small, platform-neutral C-06 scenario runner.

The app-specific driver is deliberately a hook: Electron's Playwright driver
and the native GPUI driver can use the same phases and samplers without either
app growing performance-test-only UI code.
"""
from __future__ import annotations

import argparse
import errno
import functools
import importlib.util
import json
import math
import os
from pathlib import Path
import shlex
import signal
import subprocess
import sys
import threading
import time
from typing import Any

SCHEMA = "singz.perf.v1"
PHASES = ("launch", "open", "play", "burst", "pause", "cycles", "quit")


def evaluate_budget(metrics: dict[str, Any], maximums: dict[str, float]) -> list[str]:
    """Compare measured, finite scalar metrics with explicit maximum budgets."""
    failures = []
    for name, limit in maximums.items():
        if isinstance(limit, bool) or not isinstance(limit, (int, float)) or not math.isfinite(limit):
            raise ValueError(f"invalid budget for {name}")
        value = metrics.get(name)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            failures.append(f"{name}: measurement unavailable")
        elif value > limit:
            failures.append(f"{name}: {value} exceeds {limit} by {value - limit}")
    return failures


def primary_sample(samples: list[dict[str, Any]]) -> dict[str, Any]:
    return next((sample for sample in reversed(samples) if sample.get("phase") == "play"), samples[-1])


def lane_counter(value: Any) -> int | None:
    if isinstance(value, bool): return None
    if isinstance(value, int) and value >= 0: return value
    if isinstance(value, str) and value.isascii() and value.isdecimal(): return int(value)
    return None


def _required(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"run metadata missing {name}")
    return value.strip()


def validate_report(report: dict[str, Any]) -> None:
    if report.get("schema") != SCHEMA:
        raise ValueError(f"unsupported schema: {report.get('schema')!r}")
    if report.get("complete") is not True:
        raise ValueError("complete scenario report is required")
    metadata = report.get("run")
    if not isinstance(metadata, dict):
        raise ValueError("run metadata is required")
    for key in ("app", "buildProfile", "displayMode", "machine", "commit"):
        _required(metadata.get(key), key)
    if metadata["app"] not in ("electron", "native"):
        raise ValueError("run.app must be electron or native")
    phases = report.get("phases")
    if not isinstance(phases, list) or any(not isinstance(p, dict) for p in phases) or [p.get("name") for p in phases] != list(PHASES):
        raise ValueError("phases must contain the complete ordered scenario")
    for phase in phases:
        duration = phase.get("durationS")
        if isinstance(duration, bool) or not isinstance(duration, (int, float)) or not math.isfinite(duration) or duration < 0:
            raise ValueError(f"invalid duration for {phase.get('name')}")
        deadline = phase.get("deadlineS")
        if isinstance(deadline, bool) or not isinstance(deadline, (int, float)) or not math.isfinite(deadline) or deadline <= 0:
            raise ValueError(f"invalid deadline for {phase.get('name')}")
        if phase["deadlineS"] < phase["durationS"]:
            raise ValueError(f"deadline shorter than duration for {phase.get('name')}")
    metrics = report.get("metrics")
    if not isinstance(metrics, dict):
        raise ValueError("metrics are required")
    for key in ("processTreeCpu", "footprintBytes", "startupMs", "songOpenMs", "starvedBlocks", "packageSizeBytes"):
        if key not in metrics:
            raise ValueError(f"metrics missing {key}")
    cpu = metrics["processTreeCpu"]
    if not isinstance(cpu, dict) or isinstance(cpu.get("cpuPercent"), bool) or not isinstance(cpu.get("cpuPercent"), (int, float)) or not math.isfinite(cpu["cpuPercent"]) or cpu["cpuPercent"] < 0:
        raise ValueError("processTreeCpu must be measured")
    for key in ("footprintBytes", "startupMs", "songOpenMs"):
        value = metrics[key]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
            raise ValueError(f"{key} must be measured")
    if isinstance(metrics["packageSizeBytes"], bool) or not isinstance(metrics["packageSizeBytes"], int) or metrics["packageSizeBytes"] <= 0:
        raise ValueError("packageSizeBytes must be measured")
    if not isinstance(metrics["starvedBlocks"], dict) or not isinstance(metrics["starvedBlocks"].get("lanes"), dict):
        raise ValueError("starvedBlocks.lanes is required")
    frames = metrics.get("frames")
    if not isinstance(frames, dict) or any(k not in frames or frames[k] is not None for k in ("fps", "frameTimeMs", "dropped")):
        raise ValueError("C-07 frame metrics must be present and null")


def _tree(root: int) -> list[int]:
    rows = subprocess.check_output(["ps", "-axo", "pid=,ppid="], text=True, timeout=5).splitlines()
    children: dict[int, list[int]] = {}
    for row in rows:
        pid, ppid = (int(x) for x in row.split())
        children.setdefault(ppid, []).append(pid)
    found = [root]
    for pid in found:
        found.extend(children.get(pid, []))
    return found


@functools.lru_cache(maxsize=1)
def _mac_sampler_module() -> Any:
    path = Path(__file__).resolve().parents[2] / "experiments/gpui-player/tests/interface-perf.py"
    spec = importlib.util.spec_from_file_location("interface_perf", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("macOS footprint sampler unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _mac_usage(pid: int) -> tuple[float, int]:
    return _mac_sampler_module().process_usage(pid)


class MacSampler:
    def __init__(self) -> None:
        self.previous: dict[int, float] = {}
        self.previous_at: float | None = None
        self.root: int | None = None
        self.lock = threading.Lock()

    def sample(self, root: int) -> dict[str, Any]:
        with self.lock:
            if self.root != root:
                self.previous, self.previous_at, self.root = {}, None, root
            current: dict[int, float] = {}
            footprint = 0
            for pid in _tree(root):
                try:
                    cpu, memory = _mac_usage(pid)
                except OSError as error:
                    if error.errno == errno.ESRCH: continue
                    raise
                current[pid] = cpu
                footprint += memory
            if root not in current:
                raise RuntimeError("root process could not be sampled")
            now = time.monotonic()
            paired = current.keys() & self.previous.keys()
            percent = None
            if self.previous_at is not None and now > self.previous_at and paired:
                delta = sum(max(0, current[pid] - self.previous[pid]) for pid in paired)
                percent = 100 * delta / ((now - self.previous_at) * 1_000_000_000)
            self.previous, self.previous_at = current, now
            return {"cpuPercent": percent, "footprintBytes": footprint, "pids": list(current), "pairedProcesses": len(paired)}


def sample_tree(root: int) -> dict[str, Any]:
    if os.name == "nt":
        sampler = Path(__file__).resolve().parents[1] / "shared" / "win-process-sample.ps1"
        if sampler.is_file():
            output = subprocess.check_output(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
                                              "-File", str(sampler), "-RootPid", str(root), "-WindowSec", "5"], text=True, timeout=20)
            value = json.loads(output.strip().splitlines()[-1])
            ids_output = subprocess.check_output(["powershell", "-NoProfile", "-Command",
                "@(Get-Process -Name dwm -ErrorAction Stop | ForEach-Object { $_.Id }) | ConvertTo-Json -Compress"], text=True, timeout=15)
            ids = json.loads(ids_output.strip())
            if isinstance(ids, int): ids = [ids]
            if not isinstance(ids, list) or not ids:
                raise RuntimeError("DWM process is unavailable")
            dwm_cpu = dwm_memory = 0.0
            for pid in ids:
                dwm_output = subprocess.check_output(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
                    "-File", str(sampler), "-RootPid", str(pid), "-WindowSec", "5"], text=True, timeout=20)
                dwm = json.loads(dwm_output.strip().splitlines()[-1])
                dwm_cpu += dwm["cpuPct"]
                dwm_memory += dwm["memMb"]
            return {"cpuPercent": value["cpuPct"], "footprintBytes": int(value["memMb"] * 1024 * 1024),
                    "processCount": value.get("procs"), "dwm": {"cpuPercent": dwm_cpu,
                        "footprintBytes": int(dwm_memory * 1024 * 1024), "processCount": len(ids)}}
    pids = _tree(root)
    cpu = memory = 0.0
    alive = []
    for pid in pids:
        try:
            row = subprocess.check_output(["ps", "-p", str(pid), "-o", "%cpu=,rss="], text=True, timeout=5).split()
            cpu_value = float(row[0])
            memory_value = _mac_usage(pid)[1] if sys.platform == "darwin" else float(row[1]) * 1024
            cpu += cpu_value
            memory += memory_value
            alive.append(pid)
        except OSError as error:
            if error.errno != errno.ESRCH:
                raise
            continue
        except subprocess.CalledProcessError:
            continue
    if root not in alive:
        raise RuntimeError("root process could not be sampled")
    return {"cpuPercent": cpu, "footprintBytes": int(memory), "pids": alive}


def _command(command: str, phase: str, pid: int, timeout: float) -> dict[str, Any]:
    env = {**os.environ, "SINGZ_PERF_ACTION": phase, "SINGZ_PERF_PID": str(pid)}
    result = subprocess.run(shlex.split(command), env=env, check=True, timeout=timeout,
                            capture_output=True, text=True)
    try:
        receipt = json.loads(result.stdout)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{phase} action did not provide a completion receipt") from error
    if not isinstance(receipt, dict) or receipt.get("action") != phase or receipt.get("completed") is not True:
        raise ValueError(f"{phase} action provided an invalid completion receipt")
    return receipt


def request_action(directory: Path, phase: str, timeout: float) -> dict[str, Any]:
    request, receipt = directory / "request.json", directory / "receipt.json"
    if request.exists() or receipt.exists():
        raise FileExistsError("stale request or receipt in scenario control directory")
    temp = directory / "request.tmp"
    temp.write_text(json.dumps({"action": phase}))
    temp.replace(request)
    deadline = time.monotonic() + timeout
    while not receipt.exists():
        if time.monotonic() >= deadline:
            raise TimeoutError(f"{phase} action timed out")
        time.sleep(.025)
    value = json.loads(receipt.read_text())
    receipt.unlink()
    if not isinstance(value, dict) or value.get("action") != phase or value.get("completed") is not True:
        raise ValueError(f"{phase} action failed: {value}")
    return value


def run(args: argparse.Namespace) -> dict[str, Any]:
    control_dir = getattr(args, "control_dir", None)
    if not args.action_command and not control_dir:
        raise ValueError("an action driver is required to execute the scenario")
    metadata = {"app": args.app, "buildProfile": args.profile, "displayMode": args.display,
                "machine": args.machine, "commit": args.commit}
    for key, value in metadata.items():
        _required(value, key)
    if args.display != "hidden":
        raise ValueError("display must be hidden: this driver forces hidden windows")
    if control_dir:
        required_env = ("SINGZ_USERDATA_DIR", "SINGZ_PERF_SONGS") if args.app == "electron" else (
            "SINGZ_GPUI_CONFIG_DIR", "SINGZ_GPUI_PROJECTS_ROOT", "SINGZ_GPUI_TEST_PROJECT", "SINGZ_GPUI_PERF_SECOND_PROJECT", "SINGZ_GPUI_AUDIO_HELPER")
        for name in required_env:
            _required(os.environ.get(name), name)
        if args.app == "electron":
            try:
                songs = json.loads(os.environ["SINGZ_PERF_SONGS"])
            except (TypeError, ValueError) as error:
                raise ValueError("two distinct songs are required") from error
            if not isinstance(songs, list) or len(songs) != 2 or any(not isinstance(name, str) or not name.strip() for name in songs) or songs[0] == songs[1]:
                raise ValueError("two distinct songs are required")
        elif Path(os.environ["SINGZ_GPUI_TEST_PROJECT"]).resolve() == Path(os.environ["SINGZ_GPUI_PERF_SECOND_PROJECT"]).resolve():
            raise ValueError("two distinct songs are required")
    package = Path(args.package).resolve() if args.package else None
    if not package or not package.is_file() or package.stat().st_size == 0:
        raise ValueError("package must name an existing installer or archive")
    for name in ("play", "burst", "pause", "cycle_duration"):
        value = getattr(args, name)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
            raise ValueError(f"invalid duration: {name}")
    if isinstance(args.cycles, bool) or not isinstance(args.cycles, int) or args.cycles < 0:
        raise ValueError("invalid cycles duration/count")
    if isinstance(args.deadline, bool) or not isinstance(args.deadline, (int, float)) or not math.isfinite(args.deadline) or args.deadline <= 0:
        raise ValueError("invalid step deadline")
    if getattr(args, "run_kind", None):
        metadata["kind"] = args.run_kind
    if getattr(args, "package_profile", None):
        metadata["packageBuildProfile"] = args.package_profile
    if getattr(args, "run_kind", None) == "smoke":
        metadata["owner"] = {"contact": "coordinator (C-06 harness smoke)",
                             "reservation": "none: harness smoke on the developer Mac, not a baseline"}
    reference_file = getattr(args, "reference_json", None)
    if control_dir and not reference_file:
        raise ValueError("reference song metadata is required")
    if reference_file:
        reference = json.loads(reference_file.read_text())
        _required(reference.get("reference"), "reference")
        if isinstance(reference.get("stemCount"), bool) or not isinstance(reference.get("stemCount"), int) or reference["stemCount"] <= 0 or isinstance(reference.get("durationS"), bool) or not isinstance(reference.get("durationS"), (int, float)) or not math.isfinite(reference["durationS"]) or reference["durationS"] <= 0:
            raise ValueError("reference song stem count and duration are required")
        metadata["reference"] = {key: reference[key] for key in ("reference", "stemCount", "durationS", "lyricsPresent", "storedPitchLine") if key in reference}
    durations = {"launch": 0, "open": 0, "play": args.play, "burst": args.burst,
                 "pause": args.pause, "cycles": args.cycles * args.cycle_duration, "quit": 0}
    deadlines = {name: args.deadline + durations[name] for name in PHASES}
    phases = [{"name": name, "durationS": durations[name], "deadlineS": deadlines[name]} for name in PHASES]
    started = time.monotonic()
    allowed_gpui = {"SINGZ_GPUI_CONFIG_DIR", "SINGZ_GPUI_PROJECTS_ROOT", "SINGZ_GPUI_TEST_PROJECT",
                    "SINGZ_GPUI_PERF_SECOND_PROJECT", "SINGZ_GPUI_AUDIO_HELPER", "SINGZ_GPUI_ANALYZER", "SINGZ_GPUI_INPUT_HELPER"}
    env = {key: value for key, value in os.environ.items() if not key.startswith("SINGZ_GPUI_") or key in allowed_gpui}
    env.update({"SINGZ_MUTE": "1", "SINGZ_NO_SYNC": "1", "SINGZ_E2E_HIDDEN": "1", "SINGZ_GPUI_BACKGROUND": "1", "SINGZ_GPUI_TEST_NO_CAPTURE": "1",
           "SINGZ_PERF_BURST_SECONDS": str(args.burst), "SINGZ_PERF_CYCLES": str(args.cycles), "SINGZ_PERF_CYCLE_DELAY": str(args.cycle_duration), "SINGZ_PERF_STEP_TIMEOUT": str(args.deadline)}
    )
    if control_dir:
        control_dir.mkdir(parents=True, exist_ok=True)
        env.update(SINGZ_PERF_CONTROL_DIR=str(control_dir.resolve()), SINGZ_GPUI_PERF_SCENARIO=str(control_dir.resolve()))
    proc = subprocess.Popen(shlex.split(args.command), env=env, start_new_session=os.name != "nt")
    samples = []
    sample_root = [proc.pid]
    active_phase = ["launch"]
    details: dict[str, Any] = {}
    sample_errors: list[Exception] = []
    stop_sampling = threading.Event()
    sampler = None
    mac_sampler = MacSampler() if control_dir and sys.platform == "darwin" else None
    measure = mac_sampler.sample if mac_sampler else sample_tree
    launch_finished = None
    open_ms = None
    try:
        samples.append(measure(proc.pid))
        if control_dir:
            def sample_loop() -> None:
                while not stop_sampling.wait(1):
                    try:
                        sample = measure(sample_root[0])
                        sample.update(phase=active_phase[0], elapsedS=time.monotonic() - started)
                        samples.append(sample)
                    except Exception as error:
                        sample_errors.append(error)
                        return
            sampler = threading.Thread(target=sample_loop, daemon=True)
            details["launch"] = request_action(control_dir, "launch", deadlines["launch"])
            launch_finished = time.monotonic()
            if args.app == "electron":
                app_pid = details["launch"].get("detail", {}).get("pid")
                if not isinstance(app_pid, int) or app_pid <= 0:
                    raise ValueError("Electron launch receipt must identify its app process")
                sample_root[0] = app_pid
                samples.clear()
                sample = measure(app_pid)
                sample.update(phase="launch", elapsedS=time.monotonic() - started)
                samples.append(sample)
            sampler.start()
        elif args.action_command:
            details["launch"] = _command(args.action_command, "launch", proc.pid, deadlines["launch"])
        if time.monotonic() - started > deadlines["launch"]:
            raise TimeoutError(f"step launch exceeded {deadlines['launch']}s deadline")
        if proc.poll() is not None:
            raise RuntimeError("app exited before becoming interactive")
        startup_ms = ((launch_finished if launch_finished is not None else time.monotonic()) - started) * 1000
        if control_dir and args.app == "electron":
            measured_startup = details["launch"].get("detail", {}).get("startupMs")
            if not isinstance(measured_startup, (int, float)) or measured_startup < 0:
                raise ValueError("Electron launch receipt must contain startupMs")
            startup_ms = measured_startup
        phases[0]["durationS"] = startup_ms / 1000
        for index, phase in enumerate(PHASES[1:-1], 1):
            active_phase[0] = phase
            if proc.poll() is not None:
                raise RuntimeError(f"app exited before {phase}")
            begin = time.monotonic()
            if control_dir:
                details[phase] = request_action(control_dir, phase, deadlines[phase])
            elif args.action_command:
                details[phase] = _command(args.action_command, phase, proc.pid, deadlines[phase])
            if phase == "open": open_ms = (time.monotonic() - begin) * 1000
            if durations[phase] and (not control_dir or phase not in ("burst", "cycles")): time.sleep(durations[phase])
            if proc.poll() is not None:
                raise RuntimeError(f"app exited during {phase}")
            elapsed = time.monotonic() - begin
            phases[index]["durationS"] = elapsed
            if elapsed > deadlines[phase]:
                raise TimeoutError(f"step {phase} exceeded {deadlines[phase]}s deadline")
            if sample_errors:
                raise RuntimeError(f"process sampling failed: {sample_errors[0]}")
            sample = measure(sample_root[0])
            if control_dir:
                sample.update(phase=phase, elapsedS=time.monotonic() - started)
            samples.append(sample)
    finally:
        failing = sys.exc_info()[0] is not None
        stop_sampling.set()
        if sampler is not None and sampler.ident is not None:
            sampler.join(timeout=30 if os.name == "nt" else 5)
            if sampler.is_alive():
                sample_errors.append(TimeoutError("process sampler did not stop"))
        try:
            if proc.poll() is None and not failing:
                if control_dir:
                    quit_started = time.monotonic()
                    details["quit"] = request_action(control_dir, "quit", deadlines["quit"])
                    remaining = max(0, deadlines["quit"] - (time.monotonic() - quit_started))
                    try: proc.wait(timeout=remaining)
                    except subprocess.TimeoutExpired as error: raise TimeoutError("quit did not finish before its deadline") from error
                    phases[-1]["durationS"] = time.monotonic() - quit_started
                elif args.action_command:
                    details["quit"] = _command(args.action_command, "quit", proc.pid, deadlines["quit"])
        except Exception:
            if not failing:
                raise
        finally:
            if proc.poll() is None or (failing and os.name != "nt"):
                if os.name == "nt":
                    subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], check=False, timeout=10,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                else:
                    try: os.killpg(proc.pid, signal.SIGTERM)
                    except ProcessLookupError: pass
                try: proc.wait(timeout=deadlines["quit"])
                except subprocess.TimeoutExpired:
                    if os.name != "nt":
                        try: os.killpg(proc.pid, signal.SIGKILL)
                        except ProcessLookupError: pass
                    else: proc.kill()
                    proc.wait()
    if sample_errors:
        raise RuntimeError(f"process sampling failed: {sample_errors[0]}")
    burst_receipt = details.get("burst")
    burst_details = burst_receipt.get("detail", {}) if isinstance(burst_receipt, dict) else {}
    raw_lanes = burst_details.get("observedLanes", burst_details.get("lanes"))
    lanes = {str(lane.get("id")): lane_counter(lane.get("starvedBlocks")) for lane in raw_lanes if isinstance(lane, dict) and lane.get("id") is not None} if isinstance(raw_lanes, list) else {}
    steady = primary_sample(samples)
    report = {"schema": SCHEMA, "run": metadata, "phases": phases,
              "metrics": {"processTreeCpu": steady, "footprintBytes": steady["footprintBytes"],
                          "startupMs": startup_ms, "songOpenMs": open_ms,
                          "starvedBlocks": {"lanes": lanes, "reason": None if lanes and all(value is not None for value in lanes.values()) else "driver or playback helper did not expose lane starvation counters"},
                          "packageSizeBytes": package.stat().st_size if package and package.is_file() else None,
                          "frames": {"fps": None, "frameTimeMs": None, "dropped": None}},
              "packageArtifact": package.name if package else None,
              "sampling": {"cpu": ("sum of per-process CPU counter deltas for processes present in both snapshots; short-lived processes between snapshots are excluded" if control_dir and sys.platform == "darwin" or os.name == "nt" else "sum of per-process ps CPU percentages") + "; 100 percent is one core",
                           "memory": "macOS physical footprint, Windows working set, or resident set on other platforms",
                           "intervalSeconds": 1 if os.name != "nt" else None,
                           "windowsWindowSeconds": 5 if os.name == "nt" else None},
              "samples": samples, "actionReceipts": details, "complete": True}
    validate_report(report)
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--app", choices=("electron", "native"), required=True)
    parser.add_argument("--command", required=True)
    parser.add_argument("--action-command")
    parser.add_argument("--control-dir", type=Path)
    parser.add_argument("--run-kind", choices=("smoke", "benchmark"), default="benchmark")
    parser.add_argument("--reference-json", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--profile", required=True); parser.add_argument("--display", required=True)
    parser.add_argument("--machine", required=True); parser.add_argument("--commit", required=True)
    parser.add_argument("--package")
    parser.add_argument("--package-profile")
    parser.add_argument("--play", type=float, default=180); parser.add_argument("--burst", type=float, default=5)
    parser.add_argument("--pause", type=float, default=60); parser.add_argument("--cycles", type=int, default=20)
    parser.add_argument("--cycle-duration", type=float, default=0.5); parser.add_argument("--deadline", type=float, default=120)
    args = parser.parse_args(argv)
    try:
        report = run(args)
        args.out.parent.mkdir(parents=True, exist_ok=True); args.out.write_text(json.dumps(report, indent=2) + "\n")
    except (OSError, ValueError, RuntimeError, TimeoutError, subprocess.SubprocessError) as error:
        parser.error(str(error))
    return 0


if __name__ == "__main__":
    sys.exit(main())

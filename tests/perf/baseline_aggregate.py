#!/usr/bin/env python3
"""Turn three C-06 `baseline` runs per app into the Q-01 / Q-02 baseline files (G0).

  python3 tests/perf/baseline_aggregate.py --app electron --runs e1.json e2.json e3.json \
      --shipped-package SingZ-0.26.7-mac-arm64.dmg --out-json Q-01-electron-baseline.json --out-md Q-01-electron-baseline.md
  python3 tests/perf/baseline_aggregate.py --app native --runs n1.json n2.json n3.json \
      --frames static-1.json static-2.json static-3.json idle-1.json idle-2.json idle-3.json \
      --shipped-package SingZ.dmg --electron-baseline Q-01-electron-baseline.json --out-json ... --out-md ...

Three runs per cell, median and worst (plan 3.2). Nothing is invented: a figure that no run
produced stays null with a reason, and a budget that cannot be judged says `unvalidated` or
`deferred`, never pass.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import statistics
import subprocess
import sys
from typing import Any

spec = importlib.util.spec_from_file_location("perf_harness", Path(__file__).with_name("perf_harness.py"))
perf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(perf)

SCHEMA = "singz.perf.baseline.v1"
RUNS = 3
IDLE_CPU_BUDGET_PERCENT = 1.0  # N6
N11_BURST_SECONDS = 60  # N11: playback under full-rate pan, zoom and resize for 60 s
# N10 noise rule (ours, not the plan's): the fitted rise across the cycles phase must stay within
# twice the residual spread of the samples or 1% of the steady footprint, whichever is larger.
GROWTH_NOISE_SIGMAS = 2.0
GROWTH_MIN_FRACTION = 0.01
BUDGETS = {
    "N1": ("Frame rate", "panel refresh (60 Hz interim; 120 Hz deferred) presented FPS, reference playback"),
    "N2": ("Frame time", "p99 <= one refresh period, reference playback"),
    "N3": ("Dropped frames", "0 dropped presented frames over 3 minutes of playback"),
    "N4": ("Input latency", "pan and zoom reach the screen within one frame"),
    "N5": ("Idle redraw", "no presented frames when nothing changes"),
    "N6": ("Idle CPU", "app + helpers < 1% of one core, paused and idle, 60 s"),
    "N7": ("Playing CPU", "app + helpers <= Electron all-process total (target half)"),
    "N8": ("GPU, Windows", "app GPU and DWM share each <= Electron"),
    "N9": ("Memory", "steady footprint <= Electron all-process total, 3 minutes in"),
    "N10": ("Memory growth", "no growth across 20 open/close cycles"),
    "N11": ("Audio", "starvedBlocks = 0 on every lane under pan/zoom/resize"),
    "N12": ("Startup", "cold launch to interactive <= Electron"),
    "N13": ("Song open", "reference song open <= Electron"),
    "N14": ("Package size", "installer <= Electron"),
}


def summary(values: list[float | None], unit: str) -> dict[str, Any]:
    """Per-run values with median and worst (the largest: every figure here is lower-is-better)."""
    if len(values) != RUNS or any(v is None or isinstance(v, bool) or not math.isfinite(v) for v in values):
        return {"unit": unit, "runs": values, "median": None, "worst": None}
    return {"unit": unit, "runs": values, "median": statistics.median(values), "worst": max(values)}


def phase_values(run: dict[str, Any], phase: str, key: str) -> list[float]:
    return [s[key] for s in run["samples"] if s.get("phase") == phase and isinstance(s.get(key), (int, float)) and not isinstance(s.get(key), bool)]


def mean_cpu(run: dict[str, Any], phase: str) -> float | None:
    values = phase_values(run, phase, "cpuPercent")
    return statistics.fmean(values) if values else None


def growth(run: dict[str, Any]) -> dict[str, Any]:
    """Memory growth over the cycles phase: least-squares rise of the footprint, against its own noise."""
    points = [(s["elapsedS"], s["footprintBytes"]) for s in run["samples"]
              if s.get("phase") == "cycles" and isinstance(s.get("elapsedS"), (int, float)) and isinstance(s.get("footprintBytes"), (int, float))]
    if len(points) < 4:
        return {"growthBytes": None, "noiseBytes": None, "growing": None, "samples": len(points), "reason": "fewer than 4 samples in the cycles phase"}
    xs, ys = [p[0] for p in points], [p[1] for p in points]
    mx, my = statistics.fmean(xs), statistics.fmean(ys)
    sxx = sum((x - mx) ** 2 for x in xs)
    slope = sum((x - mx) * (y - my) for x, y in points) / sxx if sxx else 0.0
    residual = statistics.pstdev([y - (my + slope * (x - mx)) for x, y in points])
    rise = slope * (xs[-1] - xs[0])
    noise = max(GROWTH_NOISE_SIGMAS * residual, GROWTH_MIN_FRACTION * run["metrics"]["footprintBytes"])
    return {"growthBytes": rise, "noiseBytes": noise, "growing": rise > noise, "samples": len(points), "reason": None}


def starved(run: dict[str, Any]) -> dict[str, Any]:
    lanes = run["metrics"]["starvedBlocks"]["lanes"]
    known = bool(lanes) and all(v is not None for v in lanes.values())
    return {"lanes": lanes, "total": sum(lanes.values()) if known else None, "reason": None if known else run["metrics"]["starvedBlocks"].get("reason")}


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def load_runs(paths: list[Path], app: str) -> list[dict[str, Any]]:
    if len(paths) != RUNS:
        raise ValueError(f"three runs per cell are required, got {len(paths)}")
    runs = [json.loads(p.read_text()) for p in paths]
    for run in runs:
        perf.validate_report(run)
        meta = run["run"]
        if meta.get("kind") != "baseline":
            raise ValueError("only runs of kind baseline can be aggregated (smoke and benchmark runs are not evidence)")
        if meta["app"] != app:
            raise ValueError(f"run is for {meta['app']}, expected {app}")
        if meta["displayMode"] != "hidden":
            raise ValueError("hidden runs are aggregated here; presented frames come from --frames")
    for key in ("commit", "machine", "buildProfile", "packageBuildProfile"):
        if len({r["run"].get(key) for r in runs}) != 1:
            raise ValueError(f"runs disagree on {key}")
    return runs


def windows_share(sampler: dict[str, Any]) -> dict[str, Any]:
    """App and DWM GPU/CPU share from a windows_gpu_sampler.ps1 capture (N8): GPU engine utilisation
    summed over the process tree's engines and over adapters, mean per 500 ms tick."""
    def adapters(block: Any) -> float | None:
        rows = (block or {}).get("perAdapter", (block or {}).get("gpuPerAdapter")) or []
        return round(sum(r["meanPercent"] for r in rows), 2) if rows else None
    gpu, dwm, process = sampler.get("gpu") or {}, sampler.get("dwm") or {}, sampler.get("process") or {}
    return {"appGpuPercent": adapters(gpu), "dwmGpuPercent": adapters({"gpuPerAdapter": dwm.get("gpuPerAdapter")}),
            "dwmCpuPercent": dwm.get("cpuPercent"), "appCpuPercent": process.get("cpuPercent"), "gpuError": gpu.get("error")}


def frames_cells(paths: list[Path]) -> dict[str, Any]:
    """Visible presented-frame runs from frames_visible.py, three per scenario."""
    by_scenario: dict[str, list[dict[str, Any]]] = {}
    for path in paths:
        doc = json.loads(path.read_text())
        if doc.get("schema") != "singz.perf.frames-live.v1":
            raise ValueError(f"{path.name}: not a frames_visible.py result")
        by_scenario.setdefault(doc["scenario"], []).append(doc)
    cells = {}
    for scenario, docs in by_scenario.items():
        if len(docs) != RUNS:
            raise ValueError(f"three visible runs per scenario are required, {scenario} has {len(docs)}")
        runs = []
        for doc in docs:
            f = doc["frames"]
            environment = doc.get("environment") or {}
            run = {"fps": f.get("fps"), "p99Ms": (f.get("frameTimeMs") or {}).get("p99"), "dropped": f.get("dropped"),
                   "presentedSamples": f.get("presentedSamples"), "timeSource": f.get("timeSource"), "gate": doc["gate"],
                   "panelHz": doc["panelHz"], "seconds": doc["seconds"], "failures": doc["failures"],
                   "displays": environment.get("displays"), "startedQuiet": environment.get("startedQuiet")}
            if doc.get("sampler"):
                run.update(windows_share(doc["sampler"]))
            runs.append(run)
        cells[scenario] = {"runs": runs, "gates": [r["gate"] for r in runs]}
    return cells


def aggregate(app: str, run_paths: list[Path], shipped_package: Path | None, frame_paths: list[Path], notes: list[str],
              identity: dict[str, Any] | None = None, tag: str | None = None, platform: str = "mac") -> dict[str, Any]:
    runs = load_runs(run_paths, app)
    meta = runs[0]["run"]
    closed = [r["actionReceipts"].get("cycles", {}).get("detail", {}).get("closed") for r in runs]
    growths = [growth(r) for r in runs]
    cells = {
        "idleCpuPercent": summary([mean_cpu(r, "pause") for r in runs], "percent of one core"),
        "playingCpuPercent": summary([mean_cpu(r, "play") for r in runs], "percent of one core"),
        "steadyFootprintBytes": summary([r["metrics"]["footprintBytes"] for r in runs], "bytes"),
        "memoryGrowth": {"unit": "bytes", "runs": growths, "closeExposed": all(c is not None for c in closed),
                         "closeReceipts": closed, "noiseRule": f"rise must stay within max({GROWTH_NOISE_SIGMAS} x residual stdev, {GROWTH_MIN_FRACTION:.0%} of steady footprint)"},
        "startupMs": summary([r["metrics"]["startupMs"] for r in runs], "ms"),
        "songOpenMs": summary([r["metrics"]["songOpenMs"] for r in runs], "ms"),
        "starvedBlocks": [{**starved(r), "burstS": next(p["durationS"] for p in r["phases"] if p["name"] == "burst")} for r in runs],
        "frames": frames_cells(frame_paths) if frame_paths else {},
    }
    package = None
    if shipped_package is not None:
        if not shipped_package.is_file() or shipped_package.stat().st_size <= 0:
            raise ValueError("shipped package must be an existing file")
        package = {"name": shipped_package.name, "bytes": shipped_package.stat().st_size, "sha256": sha256(shipped_package)}
    deferred = {"120Hz": "deferred until a 120 Hz panel exists; not failed"}
    if platform == "mac":
        deferred["windows"] = "Windows legs are a separate task (see the summary)"
    return {"schema": SCHEMA, "platform": platform, "app": app, "kind": "baseline", "tag": tag, "commit": meta["commit"], "machine": meta["machine"],
            "machineIdentity": identity, "buildProfile": meta["buildProfile"], "packageBuildProfile": meta["packageBuildProfile"],
            "reference": meta.get("reference"), "runs": len(runs), "cells": cells,
            "harnessPackage": {"name": runs[0].get("packageArtifact"), "bytes": [r["metrics"]["packageSizeBytes"] for r in runs]},
            "shippedPackage": package, "caveats": notes,
            "deferred": deferred}


def _scalar(doc: dict[str, Any], key: str) -> float | None:
    return doc["cells"][key]["median"]


def _verdict(native: float | None, ceiling: float | None) -> str:
    if native is None or ceiling is None:
        return "unvalidated"
    return "pass" if native <= ceiling else "fail"


def n8_row(nc: dict[str, Any], ec: dict[str, Any]) -> tuple[str, Any, Any, str]:
    """N8 from the Windows sampler: app GPU share and DWM share, native against Electron, in the
    reference-playback scenario (`playing`). Other scenarios are shown but never judged."""
    def medians(cell: dict[str, Any] | None) -> dict[str, Any] | None:
        if not cell:
            return None
        out = {}
        for key in ("appGpuPercent", "dwmGpuPercent", "dwmCpuPercent", "appCpuPercent"):
            values = [r.get(key) for r in cell["runs"]]
            out[key] = None if any(v is None for v in values) else statistics.median(values)
        return out
    shown_n = {name: medians(cell) for name, cell in nc["frames"].items() if medians(cell) and medians(cell)["appGpuPercent"] is not None}
    shown_e = {name: medians(cell) for name, cell in ec["frames"].items() if medians(cell) and medians(cell)["appGpuPercent"] is not None}
    native, electron = shown_n.get("playing"), shown_e.get("playing")
    if native and electron and native["dwmGpuPercent"] is not None and electron["dwmGpuPercent"] is not None:
        ok = native["appGpuPercent"] <= electron["appGpuPercent"] and native["dwmGpuPercent"] <= electron["dwmGpuPercent"]
        return ("pass" if ok else "fail"), native, electron, "Median GPU engine share of the app process tree and of DWM during visible reference playback (PresentMon capture window)."
    return ("unvalidated", shown_n or None, shown_e or None,
            "GPU and DWM share are measured in a visible window, but reference playback was not captured for both apps (the native visible scenario cannot open or play a song), "
            "so the shares shown are for the scenarios each app has and are diagnostic, not judged.")


def gaps(native: dict[str, Any], electron: dict[str, Any]) -> list[dict[str, Any]]:
    """Native against Electron for each budget N1-N14: pass, fail, unvalidated or deferred."""
    windows = native.get("platform") == "windows"
    nc, ec = native["cells"], electron["cells"]
    rows: list[dict[str, Any]] = []

    def row(n: str, status: str, nat: Any, ele: Any, note: str) -> None:
        rows.append({"id": n, "area": BUDGETS[n][0], "budget": BUDGETS[n][1], "status": status, "native": nat, "electron": ele, "note": note})

    static = nc["frames"].get("static")
    shown = None if not static else [{k: r[k] for k in ("fps", "p99Ms", "dropped", "timeSource", "gate")} for r in static["runs"]]
    for n in ("N1", "N2", "N3"):
        row(n, "unvalidated", shown, None,
            ("Reference-playback frames are not captured: the native visible scenario is an empty animating window (figures shown from PresentMon presented times, an empty-window "
             "diagnostic, not a pass), because it cannot open or play a song. Electron's presented frames are in its own file. The 120 Hz probe is deferred (no panel).") if windows else
            "Reference-playback frames are not captured: the visible scenarios are an empty animating window (figures shown, diagnostic) and this Mac's presentedTime is 0, "
            "so timing is handler-callback-based. Electron has no macOS presented-frame capture. Re-run at 60 Hz on a display that fills presentedTime; the 120 Hz probe is deferred (no panel).")
    row("N4", "unvalidated", None, None, "No input-latency measurement exists in the harness.")
    idle = nc["frames"].get("idle")
    if idle:
        counts = [r["presentedSamples"] for r in idle["runs"]]
        row("N5", "pass" if all(c == 0 for c in counts) else "fail", counts, None,
            "Presented samples while idle, window on its launch screen 25 s after launch (presence count, clock-independent). A paused song and an open modal are not covered. Electron not measured.")
    else:
        row("N5", "unvalidated", None, None, "No visible idle runs supplied.")
    idle_cpu = nc["idleCpuPercent"]["median"]
    row("N6", "unvalidated" if idle_cpu is None else ("pass" if idle_cpu < IDLE_CPU_BUDGET_PERCENT else "fail"), nc["idleCpuPercent"], ec["idleCpuPercent"],
        "Mean CPU over the 60 s pause phase, whole process tree; the song is paused, not unloaded.")
    row("N7", _verdict(_scalar(native, "playingCpuPercent"), _scalar(electron, "playingCpuPercent")), nc["playingCpuPercent"], ec["playingCpuPercent"],
        "Mean CPU over the 3-minute play phase, medians compared; target (half of Electron) not applied here.")
    if windows:
        status, nat, ele, why = n8_row(nc, ec)
        row("N8", status, nat, ele, why)
    else:
        row("N8", "deferred", None, None, "Windows only: GPU and DWM share need the field laptop (PresentMon).")
    row("N9", _verdict(_scalar(native, "steadyFootprintBytes"), _scalar(electron, "steadyFootprintBytes")), nc["steadyFootprintBytes"], ec["steadyFootprintBytes"],
        "Physical footprint of the process tree at the end of the 3-minute play phase.")
    g = [r["growing"] for r in nc["memoryGrowth"]["runs"]]
    row("N10", "unvalidated", {"growing": g, "growthBytes": [r["growthBytes"] for r in nc["memoryGrowth"]["runs"]]},
        {"growing": [r["growing"] for r in ec["memoryGrowth"]["runs"]], "growthBytes": [r["growthBytes"] for r in ec["memoryGrowth"]["runs"]]},
        "Cycles alternate two songs, but neither app can close a project, so these are open/open cycles (closed = null in the receipts); the figures are measured, the budget is not judged."
        if not nc["memoryGrowth"]["closeExposed"] else "Slope against the noise rule in the JSON.")
    lanes_known = all(s["total"] is not None for s in nc["starvedBlocks"])
    full_burst = all(s["burstS"] >= N11_BURST_SECONDS for s in nc["starvedBlocks"])
    if not lanes_known:
        status, why = "unvalidated", "The helper did not expose starvedBlocks (null with a reason)."
    elif not full_burst:
        status, why = "unvalidated", f"Counters read 0 where measured, but the burst ran {[round(s['burstS'], 1) for s in nc['starvedBlocks']]} s, not the {N11_BURST_SECONDS} s of the budget; re-run with --burst {N11_BURST_SECONDS}."
    else:
        status, why = ("pass" if all(s["total"] == 0 for s in nc["starvedBlocks"]) else "fail"), f"{N11_BURST_SECONDS} s burst."
    row("N11", status, [s["total"] for s in nc["starvedBlocks"]], None, why)
    row("N12", _verdict(_scalar(native, "startupMs"), _scalar(electron, "startupMs")), nc["startupMs"], ec["startupMs"],
        "Native: process spawn to interactive receipt. Electron: driver launch to library ready and welcome dismissed. Definitions are close, not identical.")
    row("N13", _verdict(_scalar(native, "songOpenMs"), _scalar(electron, "songOpenMs")), nc["songOpenMs"], ec["songOpenMs"], "First open of the 5-minute reference song, hidden.")
    npkg, epkg = native.get("shippedPackage"), electron.get("shippedPackage")
    row("N14", _verdict(npkg and npkg["bytes"], epkg and epkg["bytes"]), npkg, epkg,
        "Shipped installer sizes. Native is the NSIS installer built here, unsigned; Electron is the published release asset." if windows else
        "Shipped dmg sizes. Native is ad hoc signed and built locally; Electron is the published release asset.")
    return rows


def _fmt(value: Any, unit: str = "") -> str:
    if value is None:
        return "n/a"
    if unit == "bytes":
        return f"{value / 1048576:.1f} MiB"
    return f"{value:.2f}" + (" ms" if unit == "ms" else "")


def cell_line(label: str, cell: dict[str, Any]) -> str:
    runs = ", ".join(_fmt(v, cell["unit"]) for v in cell["runs"])
    return f"| {label} | {_fmt(cell['median'], cell['unit'])} | {_fmt(cell['worst'], cell['unit'])} | {runs} |"


WINDOWS_STEPS = """## Windows legs (separate task: the field laptop or the Dell)

1. Reserve the machine (`singz-dev` handbook: hosts, testing); mains power, display awake, nothing over the window.
2. Build Electron `v0.26.7` (`npm ci && npm run build`) and the native release `ui-tests` build with helpers against the codec pack; take the real v0.26.7 `SingZ-0.26.7-win-x64.exe` and the native installer for N14.
3. `node tests/perf/make_reference.cjs <fresh-dir>` per run; run `perf_harness.py --run-kind baseline` three times per app (hidden: CPU, memory, growth, startup, open), exactly as the Mac legs, then `baseline_aggregate.py`.
4. Visible runs: `experiments/gpui-player/tests/windows_gpu_sampler.ps1` (PresentMon 2.3.1+) for the process tree, three per app, merged with `--frames-json`; this also gives N8 (GPU and DWM share).
5. Write `Q-01-electron-baseline-windows.json` and `Q-02-native-baseline-windows.json` beside the Mac files; the Windows Electron figures are the reference for the Windows native gaps.
"""


def markdown(doc: dict[str, Any], rows: list[dict[str, Any]] | None) -> str:
    c = doc["cells"]
    title = "Q-01 Electron baseline" if doc["app"] == "electron" else "Q-02 native release baseline"
    ident = doc.get("machineIdentity") or {}
    windows = doc.get("platform") == "windows"
    out = [f"# {title} ({'Windows' if windows else 'Mac'})", "",
           f"- App: {doc['app']} {doc.get('tag') or ''} at commit `{doc['commit']}`, build `{doc['buildProfile']}` (package profile `{doc['packageBuildProfile']}`).",
           f"- Machine: {doc['machine']}" + (f" ({', '.join(f'{k}: {v}' for k, v in ident.items())})" if ident else "") + ".",
           f"- {doc['runs']} hidden runs per cell, plus visible runs where listed; reference: {json.dumps(doc.get('reference'))}.", "",
           "| Cell | Median | Worst | Runs |", "|---|---|---|---|",
           cell_line("Idle CPU (N6), % of one core", c["idleCpuPercent"]), cell_line("Playing CPU (N7), % of one core", c["playingCpuPercent"]),
           cell_line("Steady footprint (N9)", c["steadyFootprintBytes"]), cell_line("Startup (N12)", c["startupMs"]), cell_line("Song open (N13)", c["songOpenMs"]), ""]
    growths = c["memoryGrowth"]["runs"]
    out += [f"Memory growth over the cycles phase (N10): " + ", ".join(_fmt(g["growthBytes"], "bytes") + (" (growing)" if g["growing"] else " (within noise)") if g["growthBytes"] is not None else "n/a" for g in growths)
            + f". Rule: {c['memoryGrowth']['noiseRule']}. Close exposed by the app: {c['memoryGrowth']['closeExposed']}.", ""]
    if c["frames"]:
        out += [("Visible presented-frame runs (PresentMon, `frames_visible_windows.py`):" if windows else "Visible presented-frame runs (diagnostic, `frames_visible.py`):"), ""]
        for scenario, cell in c["frames"].items():
            out.append(f"- {scenario}: " + "; ".join(f"fps {_fmt(r['fps'])}, p99 {_fmt(r['p99Ms'])} ms, dropped {r['dropped']}, samples {r['presentedSamples']}, {r['gate']} ({r['timeSource']})"
                                                     + (f", app GPU {_fmt(r.get('appGpuPercent'))} %, DWM GPU {_fmt(r.get('dwmGpuPercent'))} %" if r.get('appGpuPercent') is not None else "") for r in cell["runs"]))
        out.append("")
    else:
        out += ["Presented frames: not measured for this app on this machine.", ""]
    for key, label in (("shippedPackage", "Shipped package (N14)"),):
        p = doc.get(key)
        out.append(f"{label}: " + (f"`{p['name']}`, {p['bytes']:,} bytes ({p['bytes'] / 1048576:.1f} MiB), sha256 `{p['sha256']}`" if p else "n/a"))
    out += ["", "## Caveats", ""] + [f"- {n}" for n in doc["caveats"]] + [f"- {k}: {v}" for k, v in doc["deferred"].items()]
    if rows:
        out += ["", "## Gap to each budget, native against Electron", "", "| # | Area | Status | Native | Electron | Note |", "|---|---|---|---|---|---|"]
        for r in rows:
            def show(v: Any) -> str:
                if isinstance(v, dict) and "median" in v: return f"{_fmt(v['median'], v['unit'])} (worst {_fmt(v['worst'], v['unit'])})"
                if isinstance(v, dict) and "bytes" in v: return f"{v['bytes'] / 1048576:.1f} MiB"
                if isinstance(v, list) and v and isinstance(v[0], dict) and "fps" in v[0]:
                    return "; ".join(f"{_fmt(x['fps'])} fps, p99 {_fmt(x['p99Ms'])} ms, {x['dropped']} dropped" for x in v)
                if isinstance(v, dict) and "growthBytes" in v:
                    return ", ".join(_fmt(g, "bytes") + (" (growing)" if grew else "") for g, grew in zip(v["growthBytes"], v["growing"]))
                return "n/a" if v is None else json.dumps(v)
            out.append(f"| {r['id']} | {r['area']} | **{r['status']}** | {show(r['native'])} | {show(r['electron'])} | {r['note']} |")
    if not windows:
        out += ["", WINDOWS_STEPS]
    return "\n".join(out)


def mac_identity() -> dict[str, Any]:
    def sysctl(name: str) -> str:
        return subprocess.run(["sysctl", "-n", name], capture_output=True, text=True, timeout=10).stdout.strip()
    version = subprocess.run(["sw_vers", "-productVersion"], capture_output=True, text=True, timeout=10).stdout.strip()
    build = subprocess.run(["sw_vers", "-buildVersion"], capture_output=True, text=True, timeout=10).stdout.strip()
    return {"model": sysctl("hw.model"), "chip": sysctl("machdep.cpu.brand_string"), "cores": sysctl("hw.ncpu"),
            "memoryBytes": sysctl("hw.memsize"), "macOS": f"{version} ({build})"}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--app", choices=("electron", "native"), required=True)
    parser.add_argument("--runs", nargs=RUNS, type=Path, required=True)
    parser.add_argument("--frames", nargs="*", type=Path, default=[])
    parser.add_argument("--shipped-package", type=Path)
    parser.add_argument("--electron-baseline", type=Path, help="Q-01 JSON; with --app native, adds the gap to each budget")
    parser.add_argument("--note", action="append", default=[], help="caveat to record (repeatable)")
    parser.add_argument("--tag")
    parser.add_argument("--collect-identity", action="store_true", help="record this Mac's model, chip, memory and OS")
    parser.add_argument("--platform", choices=("mac", "windows"), default="mac")
    parser.add_argument("--identity-json", type=Path, help="machine identity recorded as-is (for a machine this script is not running on)")
    parser.add_argument("--out-json", type=Path, required=True)
    parser.add_argument("--out-md", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        identity = json.loads(args.identity_json.read_text(encoding="utf-8-sig")) if args.identity_json else (mac_identity() if args.collect_identity else None)
        doc = aggregate(args.app, args.runs, args.shipped_package, args.frames, args.note, identity, args.tag, args.platform)
        rows = None
        if args.app == "native":
            if not args.electron_baseline:
                raise ValueError("--electron-baseline is required to state the gap for native")
            electron = json.loads(args.electron_baseline.read_text())
            if electron.get("schema") != SCHEMA or electron.get("app") != "electron":
                raise ValueError("--electron-baseline must be a Q-01 baseline file")
            rows = gaps(doc, electron)
            doc["gaps"] = rows
            doc["electronBaseline"] = {"tag": electron.get("tag"), "commit": electron["commit"], "machine": electron["machine"]}
            if electron.get("platform", "mac") != doc["platform"]:
                raise ValueError("native and Electron baselines are for different platforms")
            if electron["machine"] != doc["machine"]:
                raise ValueError("native and Electron baselines were measured on different machines")
        args.out_json.parent.mkdir(parents=True, exist_ok=True)
        args.out_json.write_text(json.dumps(doc, indent=2) + "\n")
        args.out_md.write_text(markdown(doc, rows) + "\n")
    except (OSError, ValueError, KeyError) as error:
        parser.error(str(error))
    return 0


if __name__ == "__main__":
    sys.exit(main())

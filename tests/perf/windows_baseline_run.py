#!/usr/bin/env python3
"""One hidden baseline run (Q-01 / Q-02 Windows leg) of either app, from a fresh reference copy.

Run it in the logged-in desktop session (a one-off `schtasks /it` task): Windows audio endpoints and
Electron windows do not exist in session zero. It stages a fresh copy of the reference library
(`stage_reference_copy.py`: the library is generated once, where ffmpeg exists, by `make_reference.cjs`),
sets the environment the C-06 runner wants for that app, and runs `perf_harness.py --run-kind baseline`.

  python tests/perf/windows_baseline_run.py --app native --run 1 --work C:/wq --template C:/wq/reference \
      --runtime-dir C:/wq/native --package C:/wq/singz-native-setup.exe --package-profile release \
      --profile release+ui-tests --commit 492fb67d --machine "<description>" --out C:/wq/runs/native-1.json
  python tests/perf/windows_baseline_run.py --app electron --run 1 ... --electron-root C:/wq/electron \
      --package SingZ-0.26.7-win-x64.exe --package-profile release-nsis --profile electron-build-out

`--runtime-dir` holds the release `ui-tests` player and its three helpers; `--electron-root` is a
built tree of the release tag (with `tests/perf/electron_driver.cjs` from this tree copied in).
Paths are passed to the runner with forward slashes: it splits `--command` the POSIX way.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

HERE = Path(__file__).resolve().parent


def load(name: str) -> object:
    spec = importlib.util.spec_from_file_location(name, HERE / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def slash(path: Path) -> str:
    return str(path.resolve()).replace("\\", "/")


def environment(args: argparse.Namespace, reference: dict, fresh: Path) -> tuple[dict[str, str], str]:
    env = dict(os.environ)
    if args.app == "electron":
        env.update(SINGZ_USERDATA_DIR=reference["prefs"], SINGZ_PERF_SONGS=json.dumps(reference["names"]))
        driver = Path(args.electron_root) / "tests/perf/electron_driver.cjs"
        return env, f"node {slash(driver)}"
    runtime = Path(args.runtime_dir)
    config = fresh / "native-config"
    config.mkdir(parents=True)
    env.update(SINGZ_GPUI_CONFIG_DIR=str(config), SINGZ_GPUI_PROJECTS_ROOT=reference["library"],
               SINGZ_GPUI_TEST_PROJECT=reference["projects"][0], SINGZ_GPUI_PERF_SECOND_PROJECT=reference["projects"][1],
               SINGZ_GPUI_AUDIO_HELPER=str(runtime / "singz-gpui-audio.exe"), SINGZ_GPUI_ANALYZER=str(runtime / "singz-analyze.exe"),
               SINGZ_GPUI_INPUT_HELPER=str(runtime / "singz-gpui-input.exe"))
    return env, slash(runtime / "singz-gpui-player.exe")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--app", choices=("electron", "native"), required=True)
    parser.add_argument("--run", type=int, required=True)
    parser.add_argument("--work", type=Path, required=True, help="scratch root: fresh fixtures and control directories go under it")
    parser.add_argument("--template", type=Path, required=True, help="reference library template (library/ + reference.json)")
    parser.add_argument("--runtime-dir", help="native: directory with the ui-tests player and helpers")
    parser.add_argument("--electron-root", help="electron: built tree of the release tag")
    parser.add_argument("--package", required=True)
    parser.add_argument("--package-profile", required=True)
    parser.add_argument("--profile", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--machine", required=True)
    parser.add_argument("--burst", type=float, default=60, help="N11 is judged only after a 60 s burst")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)
    if args.app == "native" and not args.runtime_dir or args.app == "electron" and not args.electron_root:
        parser.error("--runtime-dir (native) or --electron-root (electron) is required")
    fresh = args.work / "fixtures" / f"{args.app}-{args.run}"
    reference = load("stage_reference_copy").stage(args.template, fresh)
    (fresh / "reference.json").write_text(json.dumps(reference))
    env, command = environment(args, reference, fresh)
    harness = [sys.executable, str(HERE / "perf_harness.py"), "--app", args.app, "--command", command,
               "--control-dir", str(args.work / "control" / f"{args.app}-{args.run}"), "--run-kind", "baseline",
               "--reference-json", str(fresh / "reference.json"), "--out", str(args.out), "--profile", args.profile,
               "--display", "hidden", "--machine", args.machine, "--commit", args.commit, "--package", args.package,
               "--package-profile", args.package_profile, "--burst", str(args.burst)]
    args.out.parent.mkdir(parents=True, exist_ok=True)
    if args.app == "electron":
        env["SINGZ_PERF_REQUIRE_NATIVE"] = "1"  # the app resolves its capture addon relative to its working directory, and reads its git index (git on PATH)
    return subprocess.run(harness, env=env, cwd=args.electron_root if args.app == "electron" else None).returncode


if __name__ == "__main__":
    sys.exit(main())

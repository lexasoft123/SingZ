#!/usr/bin/env python3
"""Stage a fresh per-run copy of a `make_reference.cjs` library on a machine without ffmpeg.

The reference library is deterministic, so it is generated once (`node tests/perf/make_reference.cjs
<template-dir>` on a machine with ffmpeg, then copied over) and every run gets its own fresh copy:

  python tests/perf/stage_reference_copy.py <template-dir> <fresh-dir>

It prints the same JSON as make_reference.cjs, with this copy's absolute paths. The template's
settings.json (which carries the generating machine's library path) is rewritten for the copy.
"""
from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path


def stage(template: Path, dest: Path) -> dict:
    if dest.exists():
        raise SystemExit("supply a fresh fixture directory")
    description = json.loads((template / "reference.json").read_text(encoding="utf-8"))
    shutil.copytree(template / "library", dest / "library")
    (dest / "prefs").mkdir(parents=True)
    library = (dest / "library").resolve()
    (dest / "prefs" / "settings.json").write_text(json.dumps({"projectsRoot": str(library)}), encoding="utf-8")
    names = description["names"]
    description.update(projects=[str(library / name) for name in names], library=str(library), prefs=str((dest / "prefs").resolve()))
    return description


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    print(json.dumps(stage(Path(argv[1]), Path(argv[2]))))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

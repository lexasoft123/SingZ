#!/usr/bin/env python3
"""Regression checks for immutable, safe zCore source imports."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

PACKAGE = Path(__file__).resolve().parents[1]
IMPORTER = PACKAGE / "scripts/import-zcore.py"
VERIFIER = PACKAGE / "scripts/verify-zcore.py"

def run(*args, ok=True):
    result = subprocess.run(args, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if (result.returncode == 0) != ok:
        raise AssertionError(f"unexpected exit {result.returncode}: {' '.join(map(str,args))}\n{result.stdout}")
    return result

def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args], text=True).strip()

def main():
    with tempfile.TemporaryDirectory(prefix="zcore-import-test-") as temp_name:
        temp = Path(temp_name); repo = temp / "upstream"; repo.mkdir()
        (repo / "src").mkdir(); (repo / "scripts").mkdir()
        (repo / "src/engine.cpp").write_text("immutable engine source\n")
        tool = repo / "scripts/run.sh"; tool.write_text("#!/bin/sh\nexit 0\n"); tool.chmod(0o755)
        manifest = {"schemaVersion": 1, "package": "zCore", "paths": ["src/engine.cpp"]}
        (repo / "zcore-source-manifest.json").write_text(json.dumps(manifest) + "\n")
        git(repo, "init", "-q"); git(repo, "add", "-A"); git(repo, "-c", "user.name=zCore test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture")
        revision = git(repo, "rev-parse", "HEAD")
        # A dirty source worktree must not affect the exported committed snapshot.
        (repo / "src/engine.cpp").write_text("mutable, uncommitted change\n")
        dest = temp / "consumer/audio-engine"; lock = temp / "consumer/audio-engine.lock.json"
        args = (sys.executable, str(IMPORTER), "--source", str(repo), "--revision", revision,
                "--destination", str(dest), "--lock", str(lock), "--repository-url", "test://zcore")
        run(*args)
        assert (dest / "src/engine.cpp").read_text() == "immutable engine source\n"
        assert (dest / "scripts/run.sh").stat().st_mode & 0o111
        record = json.loads(lock.read_text())
        assert record["revision"] == revision and record["repository"] == "test://zcore"
        assert hashlib.sha256((dest / "zcore-source-manifest.json").read_bytes()).hexdigest() == record["manifestSha256"]
        run(sys.executable, str(VERIFIER), "--root", str(dest), "--lock", str(lock))
        # Changed contents and added files both fail closed.
        (dest / "src/engine.cpp").write_text("tampered\n")
        run(sys.executable, str(VERIFIER), "--root", str(dest), "--lock", str(lock), ok=False)
        (dest / "src/engine.cpp").write_text("immutable engine source\n")
        (dest / "unlocked.txt").write_text("extra\n")
        run(sys.executable, str(VERIFIER), "--root", str(dest), "--lock", str(lock), ok=False)
        (dest / "unlocked.txt").unlink()
        # Invalid revision and overlapping paths are rejected before writing.
        run(sys.executable, str(IMPORTER), "--source", str(repo), "--revision", revision[:12],
            "--destination", str(temp / "short"), "--lock", str(temp / "short.lock"), ok=False)
        run(sys.executable, str(IMPORTER), "--source", str(repo), "--revision", revision,
            "--destination", str(repo / "nested"), "--lock", str(temp / "overlap.lock"), ok=False)
        run(sys.executable, str(IMPORTER), "--source", str(repo), "--revision", revision,
            "--destination", str(temp / "nested"), "--lock", str(temp / "nested/inside.lock"), ok=False)
    print("zCore importer snapshot, tamper, extra-file, revision, path and mode checks passed")

if __name__ == "__main__":
    main()

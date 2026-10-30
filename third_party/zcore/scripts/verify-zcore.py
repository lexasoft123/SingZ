#!/usr/bin/env python3
"""Verify every file in an zCore snapshot against its SHA-256 lock."""
import argparse, hashlib, json
from pathlib import Path, PurePosixPath

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True, type=Path)
    ap.add_argument("--lock", required=True, type=Path)
    a = ap.parse_args(); root = a.root.resolve()
    lock = json.loads(a.lock.read_text())
    manifest = json.loads((root / "zcore-source-manifest.json").read_text())
    bad=[]
    if hashlib.sha256((root / "zcore-source-manifest.json").read_bytes()).hexdigest() != lock.get("manifestSha256"):
        bad.append("manifest hash mismatch")
    if not set(manifest["paths"]).issubset(set(lock["files"])):
        bad.append("source manifest contains paths absent from the snapshot lock")
    for rel, expected in lock["files"].items():
        p=PurePosixPath(rel)
        if p.is_absolute() or ".." in p.parts: bad.append(f"unsafe locked path: {rel}"); continue
        f=root.joinpath(*p.parts)
        if f.is_symlink(): bad.append(f"symlink is not allowed: {rel}"); continue
        if not f.is_file(): bad.append(f"missing: {rel}"); continue
        got=hashlib.sha256(f.read_bytes()).hexdigest()
        if got != expected: bad.append(f"hash mismatch: {rel}")
    actual=set()
    for f in root.rglob("*"):
        if f.is_symlink(): bad.append(f"symlink is not allowed: {f.relative_to(root)}")
        elif f.is_file(): actual.add(f.relative_to(root).as_posix())
    extras=actual-set(lock["files"])
    if extras: bad.append("unlocked files: " + ", ".join(sorted(extras)))
    if bad:
        print("zCore verification failed:\n"+"\n".join(bad)); raise SystemExit(1)
    print(f"zCore verified: {len(lock['files'])} files at {lock['revision']}")

if __name__ == "__main__": main()

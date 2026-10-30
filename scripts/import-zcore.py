#!/usr/bin/env python3
"""Export a manifest-pinned zCore snapshot from a local Git repository."""
import argparse, hashlib, json, os, shutil, subprocess, tempfile
from pathlib import Path, PurePosixPath

PACKAGE = Path(__file__).resolve().parents[1]

def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args], text=True).strip()

def safe_path(raw):
    p = PurePosixPath(raw)
    if p.is_absolute() or not p.parts or any(x in ("", ".", "..") for x in p.parts):
        raise ValueError(f"unsafe manifest path: {raw!r}")
    return p

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True, type=Path)
    ap.add_argument("--revision", required=True)
    ap.add_argument("--destination", required=True, type=Path)
    ap.add_argument("--lock", required=True, type=Path)
    ap.add_argument("--repository-url", help="Stable repository identity recorded in the lock")
    a = ap.parse_args()
    root = a.source.resolve(); dest = a.destination.resolve(); lock = a.lock.resolve()
    if root == dest or root in dest.parents or dest in root.parents:
        raise SystemExit("source and destination trees must not overlap")
    if dest == lock or dest in lock.parents:
        raise SystemExit("lock file must be outside the exported destination")
    rev = git(root, "rev-parse", "--verify", f"{a.revision}^{{commit}}")
    if len(a.revision) < 40 or rev.lower() != a.revision.lower():
        raise SystemExit("--revision must be the exact full commit SHA")
    tree = subprocess.check_output(["git", "-C", str(root), "ls-tree", "-rz", "--full-tree", rev])
    files = {}; modes = {}
    for item in tree.split(b"\0"):
        if not item: continue
        meta, raw_path = item.split(b"\t", 1)
        mode, kind, _oid = meta.decode().split()
        p = safe_path(raw_path.decode("utf-8")).as_posix()
        if kind != "blob" or mode not in ("100644", "100755"):
            raise SystemExit(f"unsupported non-regular package entry: {p}")
        files[p] = subprocess.check_output(["git", "-C", str(root), "cat-file", "blob", _oid])
        modes[p] = mode
    manifest_bytes = files.get("zcore-source-manifest.json")
    if manifest_bytes is None: raise SystemExit("revision has no zcore-source-manifest.json")
    manifest = json.loads(manifest_bytes)
    missing = set(manifest["paths"]) - set(files)
    if missing: raise SystemExit(f"manifest paths missing from revision: {sorted(missing)}")
    parent = dest.parent; parent.mkdir(parents=True, exist_ok=True)
    temp = Path(tempfile.mkdtemp(prefix=f".{dest.name}.tmp-", dir=parent))
    try:
        for rel, blob in files.items():
            target = temp / rel; target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(blob)
            if modes[rel] == "100755": target.chmod(0o755)
        repo_id = a.repository_url or (git(root, "config", "--get", "remote.origin.url") if subprocess.run(["git", "-C", str(root), "config", "--get", "remote.origin.url"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0 else "zCore")
        record = {"schemaVersion": 1, "repository": repo_id, "revision": rev,
                  "manifestSha256": hashlib.sha256(manifest_bytes).hexdigest(),
                  "files": {p: hashlib.sha256(b).hexdigest() for p,b in sorted(files.items())}}
        old = dest.with_name(f".{dest.name}.old-{os.getpid()}")
        if old.exists(): shutil.rmtree(old)
        if dest.exists(): os.replace(dest, old)
        try:
            os.replace(temp, dest)
            lock.parent.mkdir(parents=True, exist_ok=True)
            locktmp = lock.with_name(f".{lock.name}.tmp-{os.getpid()}")
            locktmp.write_text(json.dumps(record, indent=2)+"\n"); os.replace(locktmp, lock)
        except Exception:
            if dest.exists(): shutil.rmtree(dest)
            if old.exists(): os.replace(old, dest)
            raise
        if old.exists(): shutil.rmtree(old)
    except Exception:
        shutil.rmtree(temp, ignore_errors=True); raise
    print(f"Exported {len(files)} files from {rev} to {dest}")

if __name__ == "__main__": main()

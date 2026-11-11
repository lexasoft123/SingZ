#!/usr/bin/env python3
"""Materialize the patched GPUI crates that experiments/gpui-player builds against.

The repository stores only the local patches (experiments/gpui-player/vendor-patches/*.patch)
and vendor.lock (archive + patch SHA256). This script downloads each published crate,
verifies its SHA256, unpacks it, applies the patch and writes the tree to --out
(default experiments/gpui-player/vendor), where Cargo.toml's `path = "vendor/..."`
dependencies expect it. Re-running is a no-op while archive and patch are unchanged.

  scripts/gpui-vendor.py            materialize / refresh
  scripts/gpui-vendor.py --check    exit 1 if any tree is missing, stale or hand-edited
                                    (no network; the stamp carries a content hash of the tree)
  scripts/gpui-vendor.py --update-patch gpui-pre
                                    regenerate vendor-patches/gpui-pre.patch from the
                                    edited tree in --out (and refresh vendor.lock)

A tree edited since it was materialized is never overwritten without --force: keep the
edits with --update-patch, which regenerates the patch and re-stamps the tree.

Archives are looked up in --cache, then ~/.cargo/registry/cache, then downloaded.
"""
from __future__ import annotations
import argparse, hashlib, os, io, re, json, shutil, subprocess, sys, tarfile, tempfile, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLAYER = ROOT / "experiments" / "gpui-player"
PATCHES = PLAYER / "vendor-patches"
STAMP = ".singz-vendor-stamp"
EXCLUDE_DIFF = {"Cargo.lock", ".cargo-ok", STAMP, ".DS_Store"}


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def load_lock():
    return json.loads((PATCHES / "vendor.lock").read_text())


def tree_hash(tree: Path) -> str:
    """Content hash of a materialized crate, ignoring files Cargo/this script own."""
    h = hashlib.sha256()
    for p in sorted(tree.rglob("*"), key=lambda q: q.relative_to(tree).as_posix()):
        rel = p.relative_to(tree)
        if p.is_file() and rel.name not in EXCLUDE_DIFF:
            h.update(rel.as_posix().encode() + b"\0" + sha256(p.read_bytes()).encode() + b"\n")
    return h.hexdigest()


def stamp_of(c, tree: Path | None = None) -> str:
    base = f"{c['archive_sha256']}:{c['patch_sha256']}"
    return base + (f":{tree_hash(tree)}" if tree else "") + "\n"


def stamp_state(c, target: Path) -> str:
    """'fresh', 'missing', 'stale' (lock moved on) or 'edited' (tree differs from its stamp)."""
    s = target / STAMP
    if not s.is_file():
        return "missing"
    if s.read_text() != stamp_of(c, target):
        return "stale" if not s.read_text().startswith(stamp_of(c).strip() + ":") else "edited"
    return "fresh"


def find_archive(c, lock, cache: Path | None) -> bytes:
    fname = f"{c['name']}-{c['version']}.crate"
    candidates = []
    if cache:
        candidates.append(cache / fname)
    candidates += sorted((Path.home() / ".cargo/registry/cache").glob(f"*/{fname}"))
    for p in candidates:
        if p.is_file():
            data = p.read_bytes()
            if sha256(data) == c["archive_sha256"]:
                return data
    url = f"{lock['registry']}/{c['name']}/{fname}"
    with urllib.request.urlopen(url, timeout=120) as r:
        data = r.read()
    if sha256(data) != c["archive_sha256"]:
        sys.exit(f"{fname}: SHA256 mismatch (expected {c['archive_sha256']}); refusing to use it")
    if cache:
        cache.mkdir(parents=True, exist_ok=True)
        (cache / fname).write_bytes(data)
    return data


def extract(data: bytes, dest: Path, prefix: str):
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tf:
        for m in tf.getmembers():
            if not (m.isfile() or m.isdir()) or not m.name.startswith(prefix + "/"):
                sys.exit(f"unexpected archive member {m.name!r}")
            rel = Path(m.name).relative_to(prefix)
            if rel.is_absolute() or ".." in rel.parts:
                sys.exit(f"unsafe archive member {m.name!r}")
        tf.extractall(dest, filter="data") if hasattr(tarfile, "data_filter") else tf.extractall(dest)
    for junk in ("Cargo.lock", ".cargo-ok"):
        (dest / prefix / junk).unlink(missing_ok=True)


def materialize(c, lock, out: Path, cache, force: bool):
    target = out / c["name"]
    patch = PATCHES / c["patch"]
    if sha256(patch.read_bytes()) != c["patch_sha256"]:
        sys.exit(f"{patch.name} does not match vendor.lock; run --update-patch {c['name']}")
    state = stamp_state(c, target)
    if state == "fresh" and not force:
        print(f"{c['name']}: up to date")
        return
    if state == "edited" and not force:
        sys.exit(f"{c['name']}: tree was edited after materializing; run --update-patch {c['name']} "
                 f"to keep the edits, or --force to discard them")
    data = find_archive(c, lock, cache)
    prefix = f"{c['name']}-{c['version']}"
    with tempfile.TemporaryDirectory(dir=out.parent) as tmp:
        tmp = Path(tmp)
        extract(data, tmp, prefix)
        tree = tmp / prefix
        # Inside a surrounding repository `git apply` silently SKIPS paths (exit 0), so hide
        # the repo from it and refuse any skipped hunk.
        env = {**os.environ, "GIT_CEILING_DIRECTORIES": str(tmp.parent)}
        r = subprocess.run(["git", "apply", "--verbose", "--whitespace=nowarn", str(patch)], cwd=tree,
                           env=env, capture_output=True, text=True)
        if r.returncode != 0 or "Skipped patch" in r.stdout + r.stderr:
            sys.exit(f"{patch.name}: git apply failed or skipped files:\n{r.stdout}{r.stderr}")
        (tree / STAMP).write_bytes(stamp_of(c, tree).encode())
        out.mkdir(parents=True, exist_ok=True)
        if target.exists():
            shutil.rmtree(target)
        shutil.move(str(tree), str(target))
    print(f"{c['name']}: materialized {c['version']}")


def check(lock, out: Path) -> int:
    bad = 0
    for c in lock["crates"]:
        state = stamp_state(c, out / c["name"])
        if state != "fresh":
            hint = "run --update-patch" if state == "edited" else "run scripts/gpui-vendor.py"
            print(f"{c['name']}: {state} ({hint})")
            bad = 1
    return bad


def update_patch(name, lock, out: Path, cache):
    c = next((x for x in lock["crates"] if x["name"] == name), None)
    if not c:
        sys.exit(f"unknown crate {name}")
    data = find_archive(c, lock, cache)
    prefix = f"{c['name']}-{c['version']}"
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        extract(data, tmp, prefix)
        shutil.move(str(tmp / prefix), str(tmp / "a"))
        shutil.copytree(out / name, tmp / "b", ignore=shutil.ignore_patterns(*EXCLUDE_DIFF))
        r = subprocess.run(["git", "diff", "--no-index", "--no-color", "-a", "a", "b"], cwd=tmp,
                           capture_output=True)
        if r.returncode not in (0, 1):
            sys.exit(r.stderr.decode(errors="replace"))
        # Bytes end to end: text mode would turn CRLF into LF on read and back into
        # CRLF on write on Windows, pinning a patch that git apply refuses elsewhere.
        text = r.stdout
        # git prefixes the --no-index roots too (a/a/x, b/b/x, and a/b/x for new files); strip them.
        text = re.sub(rb"^diff --git a/[ab]/(\S+) b/b/(\S+)$", rb"diff --git a/\1 b/\2", text, flags=re.M)
        text = re.sub(rb"^--- a/a/", b"--- a/", text, flags=re.M)
        text = re.sub(rb"^\+\+\+ b/b/", b"+++ b/", text, flags=re.M)
    patch = PATCHES / c["patch"]
    patch.write_bytes(text)
    c["patch_sha256"] = sha256(patch.read_bytes())
    (PATCHES / "vendor.lock").write_bytes((json.dumps(lock, indent=2) + "\n").encode())
    (out / name / STAMP).write_bytes(stamp_of(c, out / name).encode())
    lines = text.count(b"\n")
    print(f"{name}: wrote {patch.name} ({lines} lines)")


def main():
    global PATCHES
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, default=PLAYER / "vendor")
    ap.add_argument("--cache", type=Path, default=None, help="extra directory of .crate archives")
    ap.add_argument("--patches", type=Path, default=PATCHES, help="directory with vendor.lock and *.patch")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--update-patch", metavar="CRATE")
    a = ap.parse_args()
    PATCHES = a.patches.resolve()
    lock = load_lock()
    out = a.out.resolve()
    if a.check:
        sys.exit(check(lock, out))
    if a.update_patch:
        return update_patch(a.update_patch, lock, out, a.cache)
    out.mkdir(parents=True, exist_ok=True)
    for c in lock["crates"]:
        materialize(c, lock, out, a.cache, a.force)


if __name__ == "__main__":
    main()

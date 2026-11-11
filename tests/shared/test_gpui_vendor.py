"""Regression tests for scripts/gpui-vendor.py, using a tiny fake crate built in a temp dir.

Run: /opt/homebrew/bin/python3.13 -m unittest tests.shared.test_gpui_vendor
Set SINGZ_GPUI_VENDOR_SCRIPT to point the suite at another copy of the script
(used to prove each test fails against a deliberately broken script).
"""
from __future__ import annotations
import hashlib
import io
import json
import os
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(os.environ.get("SINGZ_GPUI_VENDOR_SCRIPT") or Path(__file__).resolve().parents[2] / "scripts" / "gpui-vendor.py")
PATCH = (
    "diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n"
    "@@ -1 +1 @@\n-pub fn a() {}\n+pub fn b() {}\n"
)


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def crate_archive(extra_members=()):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        for name, data in (("fake-1.0.0/Cargo.toml", b'[package]\nname = "fake"\n'),
                           ("fake-1.0.0/src/lib.rs", b"pub fn a() {}\n"), *extra_members):
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))
    return buf.getvalue()


class VendorScriptTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name)
        self.patches = self.tmp / "patches"
        self.registry = self.tmp / "registry"
        self.out = self.tmp / "out"
        (self.registry / "fake").mkdir(parents=True)
        self.patches.mkdir()
        self.write_fixture(crate_archive(), PATCH)

    def write_fixture(self, archive: bytes, patch: str, patch_sha: str | None = None):
        (self.registry / "fake" / "fake-1.0.0.crate").write_bytes(archive)
        (self.patches / "fake.patch").write_bytes(patch.encode())
        self.archive_sha = sha(archive)
        lock = {"schema": 1, "registry": self.registry.as_uri(), "crates": [{
            "name": "fake", "version": "1.0.0", "archive_sha256": self.archive_sha,
            "patch": "fake.patch", "patch_sha256": patch_sha or sha(patch.encode())}]}
        (self.patches / "vendor.lock").write_text(json.dumps(lock))

    def run_script(self, *args):
        return subprocess.run([sys.executable, str(SCRIPT), "--patches", str(self.patches), "--out", str(self.out), *args],
                              capture_output=True, text=True)

    def lib(self) -> Path:
        return self.out / "fake" / "src" / "lib.rs"

    def test_materializes_patched_tree(self):
        r = self.run_script()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.lib().read_text(), "pub fn b() {}\n")

    def test_patch_applies_when_out_is_inside_a_git_repo(self):
        # `git apply` skips every path (exit 0) when run inside a surrounding repository.
        repo = self.tmp / "repo"
        (repo / "player").mkdir(parents=True)
        subprocess.run(["git", "init", "-q", str(repo)], check=True)
        self.out = repo / "player" / "vendor"
        r = self.run_script()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.lib().read_text(), "pub fn b() {}\n")

    def test_patch_sha_mismatch_is_refused(self):
        self.write_fixture(crate_archive(), PATCH, patch_sha="0" * 64)
        r = self.run_script()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("does not match vendor.lock", r.stderr)
        self.assertFalse(self.lib().exists())

    def test_tampered_archive_is_refused(self):
        self.write_fixture(crate_archive(), PATCH)
        (self.registry / "fake" / "fake-1.0.0.crate").write_bytes(crate_archive([("fake-1.0.0/extra.rs", b"evil")]))
        r = self.run_script()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("SHA256 mismatch", r.stderr)
        self.assertFalse((self.out / "fake").exists())

    def test_member_escaping_prefix_is_refused(self):
        for name in ("fake-1.0.0/../escaped.txt", "other-1.0.0/x.txt", "/abs.txt"):
            with self.subTest(member=name):
                self.write_fixture(crate_archive([(name, b"x")]), PATCH)
                r = self.run_script()
                self.assertNotEqual(r.returncode, 0)
                self.assertRegex(r.stderr, "unsafe archive member|unexpected archive member")
                self.assertFalse((self.out / "fake").exists())
                self.assertFalse((self.tmp / "escaped.txt").exists())

    def test_second_run_does_nothing(self):
        self.assertEqual(self.run_script().returncode, 0)
        before = self.lib().stat().st_mtime_ns
        (self.registry / "fake" / "fake-1.0.0.crate").unlink()  # a second run must not need the network
        r = self.run_script()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("up to date", r.stdout)
        self.assertEqual(self.lib().stat().st_mtime_ns, before)

    def test_check_exit_codes(self):
        self.assertEqual(self.run_script("--check").returncode, 1, "missing tree")
        self.assertEqual(self.run_script().returncode, 0)
        self.assertEqual(self.run_script("--check").returncode, 0, "fresh tree")
        # lock moved on (new patch) -> stale
        newer = PATCH.replace("fn b", "fn c")
        self.write_fixture(crate_archive(), newer)
        self.assertEqual(self.run_script("--check").returncode, 1, "stale tree")

    def test_edited_tree_is_caught_and_not_overwritten(self):
        self.assertEqual(self.run_script().returncode, 0)
        self.lib().write_text("pub fn hacked() {}\n")
        self.assertEqual(self.run_script("--check").returncode, 1)
        r = self.run_script()
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(self.lib().read_text(), "pub fn hacked() {}\n")
        self.assertEqual(self.run_script("--force").returncode, 0)
        self.assertEqual(self.lib().read_text(), "pub fn b() {}\n")

    def test_update_patch_round_trips(self):
        self.assertEqual(self.run_script().returncode, 0)
        self.lib().write_text("pub fn edited() {}\n")
        r = self.run_script("--update-patch", "fake")
        self.assertEqual(r.returncode, 0, r.stderr)
        patch = (self.patches / "fake.patch").read_bytes()
        lock = json.loads((self.patches / "vendor.lock").read_text())
        self.assertEqual(lock["crates"][0]["patch_sha256"], sha(patch))
        self.assertEqual(self.run_script("--check").returncode, 0)
        # fresh materialization from the regenerated patch reproduces the edit ...
        self.out = self.tmp / "out2"
        self.assertEqual(self.run_script().returncode, 0)
        self.assertEqual(self.lib().read_text(), "pub fn edited() {}\n")
        # ... and regenerating from that tree gives the identical patch.
        self.assertEqual(self.run_script("--update-patch", "fake").returncode, 0)
        self.assertEqual((self.patches / "fake.patch").read_bytes(), patch)


if __name__ == "__main__":
    unittest.main()

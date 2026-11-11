"""Detached updater signatures are reproducible by OpenSSL and reject tampering."""
import subprocess
import tempfile
import unittest
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[2]
SIGNER = ROOT / "scripts/sign-gpui-update.py"
OPENSSL = "/opt/homebrew/bin/openssl" if Path("/opt/homebrew/bin/openssl").is_file() else shutil.which("openssl")

class UpdateSignatureTests(unittest.TestCase):
    def test_signer_emits_verifiable_detached_signature(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            key, manifest, signature, public = (root / name for name in ("private.pem", "manifest.json", "manifest.sig", "public.pem"))
            subprocess.run([OPENSSL, "genpkey", "-algorithm", "ED25519", "-out", str(key)], check=True, capture_output=True)
            subprocess.run([OPENSSL, "pkey", "-in", str(key), "-pubout", "-out", str(public)], check=True, capture_output=True)
            manifest.write_bytes(b'{"schema":1,"version":"1.2.3"}')
            subprocess.run(["python3", str(SIGNER), str(manifest), "--key", str(key), "--output", str(signature)], check=True, capture_output=True)
            subprocess.run([OPENSSL, "pkeyutl", "-verify", "-rawin", "-pubin", "-inkey", str(public), "-in", str(manifest), "-sigfile", str(signature)], check=True, capture_output=True)
            manifest.write_bytes(manifest.read_bytes() + b" ")
            self.assertNotEqual(subprocess.run([OPENSSL, "pkeyutl", "-verify", "-rawin", "-pubin", "-inkey", str(public), "-in", str(manifest), "-sigfile", str(signature)], capture_output=True).returncode, 0)

class UpdatePackageTests(unittest.TestCase):
    """The packager output verifies; a modified archive or manifest does not."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)
        self.key, self.public = self.root / "private.pem", self.root / "public.pem"
        subprocess.run([OPENSSL, "genpkey", "-algorithm", "ED25519", "-out", str(self.key)], check=True, capture_output=True)
        subprocess.run([OPENSSL, "pkey", "-in", str(self.key), "-pubout", "-out", str(self.public)], check=True, capture_output=True)
        payload = self.root / "SingZ.app"
        (payload / "Contents").mkdir(parents=True)
        (payload / "Contents/Info.plist").write_text("plist")
        self.out = self.root / "feed"

    def build(self, version="0.27.0-beta.1"):
        subprocess.run(["python3", str(SIGNER), "--payload", str(self.root / "SingZ.app"), "--version", version,
                        "--target", "macos-arm64", "--out-dir", str(self.out), "--key", str(self.key)],
                       check=True, capture_output=True)
        return self.out / "singz-native-macos-arm64.update.json"

    def verify(self, manifest):
        return subprocess.run([OPENSSL, "pkeyutl", "-verify", "-rawin", "-pubin", "-inkey", str(self.public), "-in", str(manifest),
                               "-sigfile", str(manifest) + ".sig"], capture_output=True).returncode == 0

    def test_manifest_describes_the_archive_and_verifies(self):
        import hashlib, json
        manifest = self.build()
        document = json.loads(manifest.read_text())
        archive = self.out / document["archive"]["name"]
        self.assertTrue(self.verify(manifest))
        self.assertEqual(document["channel"], "beta")  # derived from the prerelease version
        self.assertEqual(document["archive"]["sha256"], hashlib.sha256(archive.read_bytes()).hexdigest())
        self.assertEqual(document["archive"]["bytes"], archive.stat().st_size)
        self.assertEqual(self.build("0.27.0") and json.loads(manifest.read_text())["channel"], "stable")

    def test_modified_archive_or_manifest_no_longer_matches(self):
        import hashlib, json
        manifest = self.build()
        document = json.loads(manifest.read_text())
        archive = self.out / document["archive"]["name"]
        archive.write_bytes(archive.read_bytes() + b"x")
        self.assertNotEqual(hashlib.sha256(archive.read_bytes()).hexdigest(), document["archive"]["sha256"])
        manifest.write_bytes(manifest.read_bytes().replace(b"0.27.0", b"9.9.9"))
        self.assertFalse(self.verify(manifest))

    def test_public_key_hex_is_the_raw_32_byte_key(self):
        out = subprocess.run(["python3", str(SIGNER), "--public-key-hex", str(self.key)], check=True, capture_output=True, text=True).stdout.strip()
        self.assertRegex(out, r"^[0-9a-f]{64}$")


if __name__ == "__main__":
    unittest.main()

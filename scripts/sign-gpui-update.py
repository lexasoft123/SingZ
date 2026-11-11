#!/usr/bin/env python3
"""Build and sign the native update feed assets described in D-04 section 4.1.

  sign-gpui-update.py MANIFEST --key KEY            sign an existing manifest
  sign-gpui-update.py --payload DIR --version V --target T --out-dir D --key KEY
                                                    zip the payload, write the
                                                    manifest, sign the manifest
  sign-gpui-update.py --public-key-hex KEY          print the raw 32-byte public
                                                    key (hex) to bake or to give
                                                    a test build

The private key is read from a file named by --key or SINGZ_UPDATE_PRIVATE_KEY
(a path, never the key itself); it is never printed or written elsewhere.
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

TARGETS = ("macos-arm64", "macos-x64", "windows-x64")
VERSION = re.compile(r"^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$")


def openssl() -> str:
    homebrew = Path("/opt/homebrew/bin/openssl")
    return str(homebrew) if homebrew.is_file() else "openssl"


def public_key_hex(key: Path) -> str:
    der = subprocess.run([openssl(), "pkey", "-in", str(key), "-pubout", "-outform", "DER"],
                         check=True, capture_output=True).stdout
    return der[-32:].hex()


def sign(manifest: Path, key: Path, out: Path) -> None:
    with tempfile.TemporaryDirectory(prefix="singz-sign-update-") as directory:
        signature = Path(directory) / "manifest.sig"
        subprocess.run([openssl(), "pkeyutl", "-sign", "-rawin", "-inkey", str(key), "-in", str(manifest),
                        "-out", str(signature)], check=True)
        out.write_bytes(signature.read_bytes())


def verify_extracted_signature(payload: Path, archive: Path) -> None:
    """A signed bundle must still verify once unzipped without extended
    attributes, exactly as the app's own extractor writes it (a non-Mach-O
    file in Contents/MacOS keeps its signature in xattrs and would not)."""
    codesign = ["codesign", "--verify", "--deep", "--strict"]
    if subprocess.run([*codesign, str(payload)], capture_output=True).returncode != 0:
        return  # not a signed bundle (fixtures); nothing to preserve
    with tempfile.TemporaryDirectory(prefix="singz-verify-update-") as directory:
        subprocess.run(["/usr/bin/ditto", "-x", "-k", "--norsrc", "--noextattr", str(archive), directory], check=True)
        extracted = Path(directory) / payload.name
        result = subprocess.run([*codesign, str(extracted)], capture_output=True, text=True)
        if result.returncode != 0:
            archive.unlink(missing_ok=True)
            raise SystemExit(f"the update archive does not keep the bundle signature: {result.stderr.strip()[-400:]}")


def make_zip(payload: Path, archive: Path) -> None:
    """Zip with the payload folder as the single root, as the app expects."""
    if sys.platform == "darwin":
        # No AppleDouble (`__MACOSX/`), xattrs, quarantine or ACLs: the app's
        # strict reader accepts exactly one payload root, and the signature
        # lives in the bundle itself.
        subprocess.run(["/usr/bin/ditto", "-c", "-k", "--norsrc", "--noextattr", "--noqtn", "--noacl", "--keepParent",
                        str(payload), str(archive)], check=True)
        verify_extracted_signature(payload, archive)
        return
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(payload.rglob("*")):
            name = f"{payload.name}/{path.relative_to(payload).as_posix()}"
            if path.is_dir():
                zf.writestr(zipfile.ZipInfo(name + "/"), b"")
            else:
                info = zipfile.ZipInfo.from_file(path, name)
                info.compress_type = zipfile.ZIP_DEFLATED
                zf.writestr(info, path.read_bytes())


def build(args, key: Path) -> None:
    payload = args.payload.resolve()
    if not payload.is_dir():
        raise SystemExit(f"payload must be a directory: {payload}")
    if not VERSION.match(args.version):
        raise SystemExit("version must be semver, e.g. 0.27.0 or 0.27.0-beta.1")
    channel = args.channel or ("beta" if "-" in args.version else "stable")
    args.out_dir.mkdir(parents=True, exist_ok=True)
    stem = f"singz-native-{args.target}"
    archive = args.out_dir / f"{stem}.zip"
    manifest = args.out_dir / f"{stem}.update.json"
    for existing in (archive, manifest, Path(str(manifest) + ".sig")):
        existing.unlink(missing_ok=True)
    make_zip(payload, archive)
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    document = {
        "schema": 1,
        "version": args.version,
        "channel": channel,
        "target": args.target,
        "archive": {"name": archive.name, "bytes": archive.stat().st_size, "sha256": digest},
        "rollbackFloor": args.rollback_floor,
    }
    if args.min_os:
        document["minOs"] = args.min_os
    if args.notes_url:
        document["notesUrl"] = args.notes_url
    manifest.write_text(json.dumps(document, separators=(",", ":")), encoding="utf-8")
    sign(manifest, key, Path(str(manifest) + ".sig"))
    print(manifest)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("manifest", type=Path, nargs="?")
    parser.add_argument("--key", type=Path, help="Ed25519 PEM private key file")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--public-key-hex", type=Path, metavar="KEY")
    parser.add_argument("--payload", type=Path, help="app payload folder (the .app, or the Windows install folder)")
    parser.add_argument("--version")
    parser.add_argument("--target", choices=TARGETS)
    parser.add_argument("--channel", choices=("stable", "beta"))
    parser.add_argument("--out-dir", type=Path)
    parser.add_argument("--rollback-floor", default="0.26.0")
    parser.add_argument("--min-os")
    parser.add_argument("--notes-url")
    args = parser.parse_args()
    if args.public_key_hex:
        print(public_key_hex(args.public_key_hex))
        return 0
    key = args.key or (Path(os.environ["SINGZ_UPDATE_PRIVATE_KEY"]) if os.environ.get("SINGZ_UPDATE_PRIVATE_KEY") else None)
    if key is None:
        parser.error("provide --key or SINGZ_UPDATE_PRIVATE_KEY (a key file path; key contents are never accepted on the command line)")
    if not key.is_file():
        parser.error("private key must be a readable file")
    if args.payload:
        if not (args.version and args.target and args.out_dir):
            parser.error("--payload needs --version, --target and --out-dir")
        build(args, key)
        return 0
    if not args.manifest or not args.manifest.is_file():
        parser.error("provide a manifest file, or --payload")
    sign(args.manifest, key, args.output or args.manifest.with_suffix(args.manifest.suffix + ".sig"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

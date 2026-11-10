#!/usr/bin/env python3
"""Prepare only SingZ's local signing keychain; secrets never enter build logs."""
import os
from pathlib import Path
import shlex
import subprocess
import sys


def security(*args):
    result = subprocess.run(["security", *args], capture_output=True, text=True)
    if result.returncode:
        # Do not print a command containing a password or dump keychain contents.
        raise SystemExit(f"Signing keychain operation {args[0]} failed (exit {result.returncode}).")
    return result.stdout


def main():
    password_file = os.environ.get("SINGZ_SIGNING_KEYCHAIN_PASSWORD_FILE")
    if not password_file:
        raise SystemExit("Run through scripts/with-apple-secrets.sh; SOPS must contain singz_keychain_password.")
    password = Path(password_file).read_text()
    if not password:
        raise SystemExit("SOPS signing-keychain password is empty.")
    keychain = Path(os.environ["SINGZ_SIGNING_KEYCHAIN_PATH"])
    if keychain.name != "singz-ios-signing.keychain-db":
        raise SystemExit("Refusing to prepare a keychain other than singz-ios-signing.keychain-db.")
    if not keychain.exists():
        security("create-keychain", "-p", password, str(keychain))
    security("unlock-keychain", "-p", password, str(keychain))
    security("set-keychain-settings", "-lut", "21600", str(keychain))
    existing = shlex.split(security("list-keychains", "-d", "user"))
    # The same identity may remain in login from an older import. Search the
    # dedicated copy first, retaining every other keychain and their order.
    ordered = [str(keychain), *(item for item in existing if item != str(keychain))]
    if ordered != existing:
        security("list-keychains", "-d", "user", "-s", *ordered)
    if "--authorize" in sys.argv[1:]:
        security("set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", password, str(keychain))
    print("Dedicated SingZ signing keychain ready; default keychain unchanged.")


if __name__ == "__main__":
    main()

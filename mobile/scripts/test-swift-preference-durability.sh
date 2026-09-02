#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
out="$(mktemp -d)/preference-durability"
xcrun swiftc -O \
  "$here/ios/FolderAccess/DurablePreferenceWrite.swift" \
  "$here/ios/FolderAccess/Tests/preference_durability.swift" \
  -o "$out"
"$out"

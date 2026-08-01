#!/usr/bin/env bash
# The Swift side of the shared cache-currency table
# (tests/shared/currency-cases.json), which TypeScript and Kotlin also run.
# CacheCurrency imports only Foundation, so this needs no simulator and no Pods.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
out="$(mktemp -d)/currency"
xcrun swiftc -O \
  "$here/ios/FolderAccess/CacheCurrency.swift" \
  "$here/ios/FolderAccess/Tests/main.swift" \
  -o "$out"
"$out"

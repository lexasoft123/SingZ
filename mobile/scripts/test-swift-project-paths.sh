#!/usr/bin/env bash
# The Swift side of the shared project name/path table
# (tests/shared/project-name-cases.json), which TypeScript and Kotlin also run.
# ProjectPaths imports only Foundation, so this needs no simulator and no Pods.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
out="$(mktemp -d)/project-paths"
xcrun swiftc -O \
  "$here/ios/FolderAccess/ProjectPaths.swift" \
  "$here/ios/FolderAccess/Tests/project_paths.swift" \
  -o "$out"
"$out"

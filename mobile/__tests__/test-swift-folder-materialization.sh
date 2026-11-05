#!/usr/bin/env bash
# Foundation/CryptoKit only: no simulator, Pods, or application build.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
task_dir="$(mktemp -d)"
trap 'rm -rf "$task_dir"' EXIT
cp "$here/ios/FolderAccess/Tests/folder_materialization.swift" "$task_dir/main.swift"
xcrun swiftc -O \
  "$here/ios/FolderAccess/FolderMaterialization.swift" \
  "$task_dir/main.swift" \
  -o "$task_dir/folder-materialization"
"$task_dir/folder-materialization"

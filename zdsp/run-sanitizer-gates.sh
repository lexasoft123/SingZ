#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo_root"

case "$(uname -s)" in
  Linux|Darwin) ;;
  *)
    echo "zdsp sanitizer gates: unsupported host; no sanitizer claim made" >&2
    exit 0
    ;;
esac

for gate in zdsp-release-strict zdsp-asan-ubsan zdsp-tsan; do
  cmake --preset "$gate"
  cmake --build --preset "$gate"
  ctest --preset "$gate"
done

echo "zdsp sanitizer gates: strict Release + ASan/UBSan + TSan passed"

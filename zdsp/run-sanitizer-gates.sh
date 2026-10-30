#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
if [ -z "${SINGZ_NATIVE_BUILD_LOCK_HELD:-}" ]; then
  exec node "$repo_root/scripts/with-native-build-lock.mjs" \
    --owner sanitizer-gates -- bash "$repo_root/zdsp/run-sanitizer-gates.sh" "$@"
fi
node "$repo_root/scripts/assert-native-build-lock.cjs"
cd "$repo_root"

case "$(uname -s)" in
  Linux|Darwin) ;;
  *)
    echo "zdsp sanitizer gates: unsupported host; no sanitizer claim made" >&2
    exit 0
    ;;
esac

# Keep building after the first failure, so ONE run reports every
# warning-as-error instead of one per CI round. The strict preset compiles
# with -Wall -Wextra -Wpedantic -Werror and gcc's diagnostics differ from
# clang's, so a Mac cannot pre-empt them: getting this branch green cost a
# fifteen-minute round per error, each revealing the next. The build still
# fails — keep-going changes what you learn, not whether it passed.
#
# The flag is NOT spelled the same by both generators: Ninja wants `-k 0`
# ("no limit"), GNU make wants a bare `-k` and reads a following `0` as a
# TARGET — `make: *** No rule to make target '0'`, which is a green gate
# turning red for a reason that has nothing to do with the code. Ask CMake
# which generator the preset resolved to rather than guessing.
for gate in zdsp-release-strict zdsp-asan-ubsan zdsp-tsan; do
  cmake --preset "$gate"
  # From the cache the preset just wrote — `cmake -L` hides INTERNAL entries,
  # so it answers with nothing and every host silently takes the make branch.
  generator=$(sed -n 's/^CMAKE_GENERATOR:INTERNAL=//p' \
    "build/native/$gate/CMakeCache.txt")
  case "$generator" in
    Ninja*) keep_going=(-k 0) ;;
    *) keep_going=(-k) ;;
  esac
  cmake --build --preset "$gate" --parallel 4 -- "${keep_going[@]}"
  ctest --preset "$gate"
  if [[ $(uname -s) == Linux ]]; then
    # This target does not exist on Darwin. Keep its deterministic ALSA null
    # tests in every Linux gate; snd-aloop remains an explicit host-only run.
    cmake --build "build/native/$gate" --target audio_host_linux_tests --parallel 4 -- "${keep_going[@]}"
    ctest --test-dir "build/native/$gate" -R '^audio_host_linux_tests$' --output-on-failure
  fi
done

echo "zdsp sanitizer gates: strict Release + ASan/UBSan + TSan passed"

#!/usr/bin/env bash
# Run inside the development container. Keep suites serial: some existing
# native fixtures use fixed temporary filenames.
set -euo pipefail

source_root=${SINGZ_SOURCE_ROOT:-/src}
build_root=${SINGZ_BUILD_ROOT:-/work/native-clang21-release}
mkdir -p "$build_root"

{
  uname -a
  cmake --version
  "${CC:-clang-21}" --version
  node --version
  npm --version
  cat /usr/local/share/singz-development-packages.txt
} > "$build_root/environment.txt"

cmake -S "$source_root" -B "$build_root" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_COMPILER="${CC:-clang-21}" \
  -DCMAKE_CXX_COMPILER="${CXX:-clang++-21}" \
  -DCMAKE_C_COMPILER_LAUNCHER=ccache \
  -DCMAKE_CXX_COMPILER_LAUNCHER=ccache \
  -DSINGZ_BUILD_HOST_TOOLS=ON \
  -DSINGZ_CORE_TESTS=ON \
  -DBUILD_TESTING=ON 2>&1 | tee "$build_root/configure.log"

cmake --build "$build_root" --parallel "${SINGZ_BUILD_JOBS:-4}" \
  2>&1 | tee "$build_root/build.log"

ctest --test-dir "$build_root" --parallel 1 --output-on-failure \
  --no-tests=error --timeout 180 \
  --output-junit "$build_root/native-tests.xml" \
  2>&1 | tee "$build_root/ctest.log"

# AudioZ

AudioZ is the shared C++20 audio runtime extracted from SingZ. The extracted engine source baseline is SingZ revision `ac620fb0`. Two runtime
translation units have a separately reviewed optimization layer, documented by
`optimizationProvenance` in the source manifest: graph sample containment and
idle gain traversal. Finite classification preserves exact finite bit patterns;
Limiter traversal remains unchanged so pre-limit telemetry keeps its current
meaning. Other extracted engine source bytes match the baseline.
The package has no root license grant beyond the upstream terms retained beside
third-party code. Its public CMake
targets retain the `SingZ::` names used by existing consumers and also expose
the core package aliases under `AudioZ::` where appropriate.

The default build includes reusable audio transport, device providers, the
real-time graph runtime, host adapter and the legacy live-analysis compatibility
implementation. File media and delivery-thread analysis are opt-in:

```sh
cmake -S . -B build \
  -DAUDIOZ_BUILD_MEDIA=ON \
  -DAUDIOZ_BUILD_ANALYSIS=ON \
  -DAUDIOZ_BUILD_TESTS=ON
cmake --build build
ctest --test-dir build --output-on-failure
```

`AUDIOZ_BUILD_MEDIA`, `AUDIOZ_BUILD_ANALYSIS`, `AUDIOZ_BUILD_TESTS`, and
`AUDIOZ_BUILD_BENCHMARKS` default to `OFF`. Runtime and device components are
always available. A consumer can define `SingZ::native_build_options` before
adding AudioZ; standalone builds create that interface target themselves.

Every package import is generated from an exact full Git commit with
`scripts/import-audioz.py`; `scripts/verify-audioz.py` checks the snapshot lock,
including the complete tracked package tree, manifest, build files and scripts.
`audioz-source-manifest.json` enumerates extracted component source ownership.
The lower-level `zcore/README.md` and `zdsp/README.md` retain technical design
history from SingZ; their platform packaging and phase-status notes describe
that application and are not AudioZ build instructions.

`zdsp/run-sanitizer-gates.sh` stays with SingZ because it invokes application
presets and product-only tests. AudioZ exposes the reusable graph, containment,
planar and analysis tests directly through CTest.

The FLAC and dr_mp3 source inputs retain their upstream notices in
`third_party/native/flac` and `third_party/native/dr_mp3`. The optional
Signalsmith wrapper, ML adapters, product session composition and product tests
remain in their consuming applications.

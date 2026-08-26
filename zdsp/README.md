# zdsp ownership

`zdsp` is the future real-time processing graph. Phase 0A establishes its
public include namespace and stable CMake targets without taking ownership of
app playback or changing any DSP algorithm:

- `SingZ::zdsp_api` exposes graph/processor contracts and may depend only on
  narrow public `zcore` targets;
- `SingZ::zdsp_runtime` is currently an empty link contract. The prepared
  immutable runner, arena and snapshot retirement arrive in later phases.

Product UI, Electron/React Native marshalling, platform framework types and
codec/ML/plugin dependencies do not belong in `zdsp_api` or its callback path.

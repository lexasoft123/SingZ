# Native DSP architecture decisions

These accepted Phase 0B decisions freeze the first native contracts while app
playback remains on Web Audio and `react-native-audio-api`:

1. [Processor interface and lifecycle](0001-processor-interface-and-lifecycle.md)
2. [Graph snapshot publication and retirement](0002-graph-snapshot-publication-and-retirement.md)
3. [Clock domains and discontinuities](0003-clock-domains-and-discontinuities.md)
4. [Route latency provenance and addition](0004-route-latency-snapshot.md)
5. [Source provisioning](0005-source-provisioning.md)
6. [Plug-in execution modes](0006-plugin-execution-modes.md)
7. [Graph persistence and versioning](0007-graph-persistence-and-versioning.md)
8. [Legacy/native session handoff](0008-legacy-native-session-handoff.md)

Any incompatible interface or persistence change supersedes the relevant ADR rather
than silently changing version 1.

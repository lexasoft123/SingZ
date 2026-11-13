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
   (dual-path parts superseded on desktop and Box by 0015)

Later decisions:

- [0015: Native-only song playback on desktop and Box](0015-native-only-desktop-playback.md).
  Desktop and Box no longer play songs through Web Audio; the opening sentence
  above still describes iOS and Android (`react-native-audio-api`).
- [0016: The recorded take is a playback lane](0016-take-as-playback-lane.md)
  (proposed). The take is conformed offline to the song timeline and played as
  an ordinary lane; the separate listen-back path is removed.
- [0017: Live monitoring through the common mixer and output](0017-monitoring-through-the-common-mixer.md)
  (proposed). The live voice is a source of the one shared output callback;
  the second monitor host and the monitor-output picker are removed.

Any incompatible interface or persistence change supersedes the relevant ADR rather
than silently changing version 1.

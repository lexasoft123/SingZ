fastlane documentation
----

# Installation

Make sure you have the latest version of the Xcode command line tools installed:

```sh
xcode-select --install
```

For _fastlane_ installation instructions, see [Installing _fastlane_](https://docs.fastlane.tools/#installing-fastlane)

# Available Actions

## Android

### android validate

```sh
[bundle exec] fastlane android validate
```

Check the service account, the bundle and the track without shipping anything

### android internal

```sh
[bundle exec] fastlane android internal
```

Upload to the internal track

### android closed

```sh
[bundle exec] fastlane android closed
```

Upload to the closed testing track (PLAY_CLOSED_TRACK, default 'Testing')

### android production

```sh
[bundle exec] fastlane android production
```

Upload to production as a staged rollout (PLAY_ROLLOUT, default 10%)

### android preview

```sh
[bundle exec] fastlane android preview
```

Show exactly what the metadata lane would push — stages files, no network

### android metadata

```sh
[bundle exec] fastlane android metadata
```

Push store listing text and graphics only — no binary

----

This README.md is auto-generated and will be re-generated every time [_fastlane_](https://fastlane.tools) is run.

More information about _fastlane_ can be found on [fastlane.tools](https://fastlane.tools).

The documentation of _fastlane_ can be found on [docs.fastlane.tools](https://docs.fastlane.tools).

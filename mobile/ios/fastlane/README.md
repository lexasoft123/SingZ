fastlane documentation
----

# Installation

Make sure you have the latest version of the Xcode command line tools installed:

```sh
xcode-select --install
```

For _fastlane_ installation instructions, see [Installing _fastlane_](https://docs.fastlane.tools/#installing-fastlane)

# Available Actions

## iOS

### ios certs

```sh
[bundle exec] fastlane ios certs
```

Create/renew the signing certificate and profile in the certs repo (LOCAL ONLY — never CI)

### ios add_device

```sh
[bundle exec] fastlane ios add_device
```

Register a device for ad-hoc builds: fastlane ios add_device udid:<UDID> name:<name>

### ios adhoc

```sh
[bundle exec] fastlane ios adhoc
```

Build an ad-hoc IPA for the sis-motors.ru install page (no upload)

### ios validate

```sh
[bundle exec] fastlane ios validate
```

Check the API key and signing setup without building or uploading anything

### ios beta_info

```sh
[bundle exec] fastlane ios beta_info
```

Push TestFlight Test Information (beta description, feedback email, review contact)

### ios beta_external

```sh
[bundle exec] fastlane ios beta_external
```

Distribute an already-uploaded build to EXTERNAL TestFlight testers (Beta App Review)

### ios beta

```sh
[bundle exec] fastlane ios beta
```

Build, then upload to TestFlight

### ios release

```sh
[bundle exec] fastlane ios release
```

Build, then submit to the App Store for review — GOES LIVE BY ITSELF on approval

### ios metadata

```sh
[bundle exec] fastlane ios metadata
```

Push store listing TEXT only — screenshots go via scripts/push-ios-screenshots.rb

----

This README.md is auto-generated and will be re-generated every time [_fastlane_](https://fastlane.tools) is run.

More information about _fastlane_ can be found on [fastlane.tools](https://fastlane.tools).

The documentation of _fastlane_ can be found on [docs.fastlane.tools](https://docs.fastlane.tools).

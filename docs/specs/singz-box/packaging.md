# SingZ Box packaging

SingZ Box has a separate Debian identity from SingZ Desktop:

- Application ID: `com.lexasoft.singz.box`
- Product and installation directory: `SingZ Box` and `/opt/SingZ Box`
- Executable and Debian package: `singz-box`
- Desktop entry: `singz-box.desktop`
- Packaged metadata: `name: singz-box` and `singzProduct: box`

The dedicated executable reads the packaged product metadata and starts Box without a `--box` command-line argument. Desktop development and `npm run dist` keep their existing identity and behavior.

## Build

Run the packaging command on a native Linux builder after the normal worktree and engine provisioning described in [development setup](../../DEVELOPMENT.md):

```bash
npm run dist:box
npm run dist:box -- --x64
npm run dist:box -- --arm64
```

Use only the architecture supported by the builder and its provisioned native inputs. The command uses `scripts/dist.cjs`; do not invoke electron-builder directly. The wrapper prepares and verifies the requested engines and capture-addon snapshots, builds both renderer surfaces, runs the applicable host smoke check, and verifies the snapshots again immediately before packaging.

Container builders need an init/reaper, for example Podman's `--init`, or a
subreaper around the build command. A container running only `sleep infinity`
as PID 1 can retain orphaned `esbuild` zombies. Their process group remains
visible, so the native build guard correctly fails cleanup and retains its lock
even when a Debian artifact was produced. Preserve the lock owner and process
evidence; prove the owner and descendants stopped before clearing a stale lock.
Then retry the normal wrapper with a working reaper, without bypassing the guard.

The internal `--box` selector is consumed by the wrapper. It is not an application launch argument and is never forwarded to electron-builder. After the normal target and safety validation, the wrapper adds the fixed `electron-builder.box.yml` configuration itself. Caller-supplied config, project, prepackaged-input, and unsupported architecture forms are rejected before the build phases.

Artifacts are isolated from Desktop output:

```text
dist/box/SingZ-Box-<version>-linux-<arch>.deb
```

The configuration extends `electron-builder.yml`, retaining its native resources, file exclusions, Debian dependencies, packaging hooks, and signing behavior. Box overrides identity, launcher metadata, artifact naming, its own config exclusion, and `dist/box` output. The supported `publish: null` setting explicitly disables the inherited Desktop GitHub publishing/update feed, so the Box package has no inherited Desktop update feed. The wrapper still adds `--publish never` when no explicit publish option is present, so an ordinary packaging run does not publish a release.

## Product data

Box state is separated from Desktop by product. Preferences, OAuth state, and sessions are stored under `appData/SingZ Box`. Model and accelerator caches are stored under `appData/SingZ Box/models` and `appData/SingZ Box/gpu-splitter`, respectively. Projects are stored under `Documents/SingZ Box`. Desktop preferences, sessions, caches, and project directories remain unchanged.

## Inspect an artifact

Run from the repository root and choose the architecture you built:

```bash
version=$(node -p 'require("./package.json").version')
artifact="dist/box/SingZ-Box-${version}-linux-arm64.deb"
dpkg-deb -f "$artifact" Package Version Architecture
dpkg-deb -c "$artifact"
```

The package name must be `singz-box`. Its payload must include `/opt/SingZ Box/singz-box`, `/usr/share/applications/singz-box.desktop`, and product-specific icons under `/usr/share/icons/hicolor/*/apps/singz-box.*`. It must not replace Desktop's `/opt/SingZ` contents, `singz.desktop`, or `singz` icons.

On an installed test system, separately verify the binary link and check that it resolves to the Box installation rather than Desktop:

```bash
readlink -f /usr/bin/singz-box
```

The result must be `/opt/SingZ Box/singz-box`. Also confirm that `/usr/bin/singz` and the Desktop icons have not been replaced. Launch `singz-box` normally; no profile flag is required.

## Packaging checks

The tooling checks parse the real configurations with the installed electron-builder parser, validate the schema, generate the Linux desktop entry, and exercise the dist-wrapper request parser without producing app or native build output:

```bash
node --test tests/tooling/box-package*.test.cjs
```

The main build maps its `index` entry to `src/main/bootstrap.ts`. Consequently the packaged entry remains `out/main/index.js`; the bootstrap selects the profile and dynamically imports the application index as a chunk in that same directory. Renderer staging remains isolated from this main-process output.

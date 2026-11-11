# GPUI vendor patches

Replaces the ~330k-line committed `vendor/` tree with ~3k lines of patches. Each patch is
relative to the *published* crate (crates.io archive, SHA256 pinned in `vendor.lock`).
The patches include the per-crate notes (`FRACTIONAL_LAYOUT.md`, `GRAIN_EXTENSION.md`,
`OFFSCREEN_CAPTURE.md`, `BACKGROUND_RESIZE.md`, `APP_FRAME.md`).

    scripts/gpui-vendor.py                         # materialize into vendor/ (idempotent)
    scripts/gpui-vendor.py --check                 # no network; exit 1 if stale
    scripts/gpui-vendor.py --update-patch gpui-pre # after editing vendor/gpui-pre

Verified at generation time: materializing from the published archives reproduces the previous
committed `vendor/` byte for byte, excluding the per-crate `Cargo.lock` files (ignored by Cargo for
path dependencies) and `.cargo-ok`. `--update-patch` round-trips to an identical patch.

Notes for integration:
- `gpui-pre-apple/vendor/gpui` (5 files) is shipped in the published `gpui-pre-apple` archive, so
  it needs no special handling. It is unmodified.
- `gpui-pre-linux` also patches `Cargo.toml`.
- `experiments/gpui-player/vendor/` is gitignored and no longer committed. `Cargo.toml`
  still points at `vendor/<crate>` by path.
- Every build path materializes it first: `scripts/worktree-setup.sh` (both modes) and
  `scripts/build-gpui-native.py` (so `build-gpui-audio.sh/.ps1`) run the script;
  `scripts/package-gpui-desktop.py` and `package-gpui-macos.py` only run `--check` and
  refuse a stale tree. Running `cargo` by hand in a fresh checkout needs one
  `scripts/gpui-vendor.py` first.
- Each materialized crate carries `.singz-vendor-stamp` (archive sha, patch sha and a content
  hash of the tree). `--check` reports `missing`, `stale` (lock moved) or `edited` (tree
  differs from its stamp). A plain run never overwrites an edited tree; use `--update-patch`
  to keep the edits or `--force` to discard them.
- Workflow to change a crate: edit `vendor/<crate>`, build/test, run
  `scripts/gpui-vendor.py --update-patch <crate>`, commit the patch and `vendor.lock`.
  `vendor-patches/.gitattributes` keeps the patches byte-exact (CRLF would break both the
  pinned sha and `git apply` on Windows).
- Archives come from `--cache`, `~/.cargo/registry/cache` (sha-checked), then crates.io; a
  cold machine needs the network once. `--patches DIR` / `--out DIR` retarget the lock and
  output (used by `tests/shared/test_gpui_vendor.py`).
- Licensing: see `NOTICE` (all six crates are Apache-2.0, modified by these patches).
- Python 3.9+ stdlib only; needs `git` on PATH.

# Linux scene capture bridge

Pinned published `gpui-pre-linux` 0.3.11, crate SHA-256:
`79cac5cbd3485c1e3db8eafd5dc69019188f5cb0a39846946af772efa386f624`.

The published backend inherits the default `render_to_image not implemented`
error. Under `test-support`, X11 and Wayland windows now delegate scene capture
to their existing WGPU renderer. The feature also enables WGPU test support
and the image return type. Normal drawing and text shaping are unchanged. The prototype enables this feature only for Linux UI-test builds.

The corresponding pinned `gpui-pre-wgpu` 0.3.11 archive SHA-256 is:
`211cf352de1a0b0c9bea3f105df5572ce1d2c899389b924a888e5af36b50f93d`.
Its test-only capture method uses the real window's device, atlas, target
format and scene pipelines. It renders into a temporary attachment and shares
the existing bounded, padded-row readback with the headless renderer. It never
maps, shows, activates or presents the window. The helper handles both BGRA
target formats and retains mapping timeouts, size checks and GPU-error checks.

The existing headless readback regression tests use WGPU's Naga re-export
because the published snapshot omits the direct Naga test dependency.

VM 403 verification uses a task-owned Podman container and a private Xvfb
display with Mesa software Vulkan. This verifies the renderer path, not a
hardware GPU or Linux presentation performance. X11 is exercised at runtime;
the Wayland bridge compiles but requires separate runtime qualification.

Opaque X11 client chrome also honors the requested decorations without GTK
transparent-shadow frame extents. Transparent windows retain the published
compositor/extension fallback. This prevents duplicate native and UIKit
titlebars in Openbox while preserving transparent-surface fallback.

X11 also retains `WindowParams::show`: its creation-time `map_window` hook
does nothing for an initially hidden window. Such windows skip swapchain
presentation and render only into the test capture attachment. The published
implementation mapped every window regardless of `show`, letting the window
manager activate a hidden fixture. Shown windows keep the original map/draw
behavior. The capture runner records mapped-window samples as well as focus.

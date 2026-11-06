# Non-activating resize

Pinned published gpui-pre-windows 0.3.11, Cargo checksum
`5141a3db59bab761a16ab19529fe4117a86e91922e8fc00af6dfc4829cb1744d`.

`WindowsWindow::resize` retains position/z-order and
pass `SWP_NOACTIVATE` to SetWindowPos. Resizing a hidden review window must not
activate it or change the user's foreground window. Visible callers can still
request activation explicitly through the separate activation API. Renderer,
font selection and normal painting remain the published implementation.

For transparent titlebars, `events.rs` also gives the entire frame to the
client in `WM_NCCALCSIZE`. Maximized windows retain the invisible resize
insets outside the monitor work area. `WM_NCHITTEST` explicitly covers all
four edges and four corners because the native non-client border is gone.
The host draws the shared UIKit window controls in its header. Opaque/native
titlebars keep the original non-client path.

# App-owned Linux frame

Pinned `gpui-component` 0.9.0, published archive SHA-256:
`45bbfdba0efa392190f2fd446ec311325302eb047d5ce45dc1bcf189cb18f5eb`.

The optional application global `WindowFrameStyle` overrides the generic
client-frame shadow and border sizes. Without it, the published defaults and
explicit `WindowBorder` builder settings remain unchanged. The SingZ prototype
sets both sizes to zero on Linux, because its own header and resize grips own
the frame and its layouts use the complete client viewport.

This avoids the generic 20px Linux shadow padding shifting the application's
controls and dialogs. No component theme, text rasterization or other control
behavior changes. The native Linux backend still removes server decorations;
this setting controls only the component root's extra client frame.

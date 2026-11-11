# R-10 — Accessibility inventory

Evidence is code at the dispatched commit (`f7607311`). The shipped native app is broader than the isolated control probe; probe results are not whole-app certification [experiments/gpui-player/src/ui_accessibility.rs:1; experiments/gpui-player/tests/test_native_accessibility.py:2,14-20].

## Platform adapters

| Platform | Vendored implementation and observable scope |
|---|---|
| macOS AX | GPUI’s platform interface defines adapter initialization/tree-update hooks but its generic defaults are no-ops [experiments/gpui-player/vendor/gpui-pre/src/platform.rs:1440-1447]. GPUI builds and dispatches AccessKit tree updates/actions [experiments/gpui-player/vendor/gpui-pre/src/window.rs:1751-1754; experiments/gpui-player/vendor/gpui-pre/src/_accessibility.rs:203-221]. The isolated test activates the actual platform adapter via `NSView.accessibilityChildren` and reads native AX role/title/value/min/max/enabled properties [experiments/gpui-player/src/ui_accessibility.rs:68-98,212-220]. The matching macOS adapter implementation is not in `gpui-pre-apple/src` *(inferred from search; no adapter source identified there)*. |
| Windows UIA | Windows creates `accesskit_windows::Adapter` for HWND, receives `WM_GETOBJECT` and delegates UIA provider retrieval [experiments/gpui-player/vendor/gpui-pre-windows/src/window.rs:1084-1102; experiments/gpui-player/vendor/gpui-pre-windows/src/events.rs:851-865]. Tree updates are applied while active and resulting UIA property-change events raised [experiments/gpui-player/vendor/gpui-pre-windows/src/window.rs:1104-1117]; action requests route through AccessKit callback [experiments/gpui-player/vendor/gpui-pre-windows/src/window.rs:1130-1145]. Window bounds tracking is handled automatically by UIA [experiments/gpui-player/vendor/gpui-pre-windows/src/window.rs:1120-1122]. No Windows native UIA run or Windows route coverage was found *(inferred from the supplied test and review inputs)*. |

## Native controls, focus and keyboard

| Route/control | GPUI/UIKit semantics and actions | Focus/keyboard evidence |
|---|---|---|
| Common controls (probe) | Button, switch, checkbox, tab, link, combo selector/options and three sliders are assigned accessible roles/labels/state; probe checks actual AX press, toggle, value range/set/increment, option selection, disabled refusal and modal blocking [experiments/gpui-player/src/ui_accessibility.rs:137-177,246-265,317-339]. UIKit declares button label, switch toggled state, tab selected state, combo label/value, checkbox toggled state, option selected state and link label [../singz-ui/gpui/src/controls.rs:53-62,118-125,190-201,218-229,315-323,399-407,442-451]. |
| Settings / Training / song output sliders | Probe labels Monitoring gain, Training cue volume and Song output gain, tests values and bounds, and sends mixed keyboard/AX increments [experiments/gpui-player/src/ui_accessibility.rs:160-175,250-253,270-314]. Review says settings and training share pointer/keyboard/AX state; output handles keyboard in UIKit [experiments/gpui-player/NATIVE_CONTROLS_GUIDE_REVIEW.md:11-15]. Output explicitly uses focus handle and tab index 0 [experiments/gpui-player/src/ui_accessibility.rs:168-171]. |
| Library | Native app renders Library route [experiments/gpui-player/src/main.rs:5706-5709]; shared UIKit provides a search input [../singz-ui/gpui/src/controls.rs:423-440]. Focus order across Library controls was not enumerated *(inferred)*. |
| Player | Native app renders Player route [experiments/gpui-player/src/main.rs:5706-5716]; track actions are given focus handles and tab indices in production source [experiments/gpui-player/src/main.rs:5057-5084]. Root captures and handles keyboard input [experiments/gpui-player/src/main.rs:5791-5800]. Exact tab sequence and complete shortcut coverage per Player subview are not established by R-10 evidence *(inferred)*. |
| Settings and modal routes | Settings is a mounted screen with root keyboard handling [experiments/gpui-player/src/main.rs:5791-5800,5848-5850]. Probe modal test confirms background action refusal [experiments/gpui-player/tests/test_native_accessibility.py:18-20,33-46]. No complete production focus trap/order inventory found *(inferred)*. |

The test asserts native AX mixed keyboard/action delivery on Settings, Training and output sliders, and separately labels same-frame framework dispatch as non-native OS delivery [experiments/gpui-player/tests/test_native_accessibility.py:21-31]. It does not establish complete keyboard coverage or focus order for app routes. Selector expanded state is specifically unqualified by the test [experiments/gpui-player/tests/test_native_accessibility.py:32]; the review says the pinned macOS adapter does not bridge expanded state explicitly [experiments/gpui-player/NATIVE_CONTROLS_GUIDE_REVIEW.md:15-16].

## Electron comparison by route

| Route | Electron accessibility / keyboard behavior evidenced |
|---|---|
| Library | Renderer uses semantic buttons and labeled search inputs in library screens; e.g. Drive project search is a labeled native HTML search input and project rows are buttons [src/renderer/src/components/DriveProjects.tsx:28-34]. No route-wide focus sequence was measured. |
| Player | Track rename is a labeled input; mute/solo buttons expose `aria-pressed`; volume is an HTML range input [src/renderer/src/components/TrackLane.tsx:70-145]. The song-output route uses a dialog, labeled HTML range slider with value text and arrow-key handling [src/renderer/src/components/SongOutput.tsx:76-96]. Shared keyboard policy classifies dialogs, text entry, sliders and pressed controls [src/renderer/src/keyboard.ts:1-22]. |
| App navigation / dialogs | Main renderer exposes a labeled navigation landmark and buttons with current-page / pressed state [src/renderer/src/App.tsx:3894-3925]. The shared keyboard code identifies dialog scope [src/renderer/src/keyboard.ts:1-3]. The exact Electron route tab order was not statically enumerated *(inferred)*. |

## Limits of evidence

The maintained native AX driver is macOS-only and validates an isolated UIKit host, two window sizes and screenshots; it explicitly labels live FPS unmeasured and whole-app accessibility unqualified [experiments/gpui-player/tests/test_native_accessibility.py:13-20,33-46]. The review lists whole-app roles, all locales, live announcements, native expanded-state bridging, and Windows/Linux workflows as open [experiments/gpui-player/NATIVE_CONTROLS_GUIDE_REVIEW.md:65-66].

## Five-line summary

- GPUI uses AccessKit to build programmatic accessibility trees and route assistive actions; Windows UIA adapter code is directly present in the vendored Windows platform layer.
- The macOS test proves native AX controls/actions in an isolated host, while the matching adapter source is not present under the vendored Apple crate.
- Shared UIKit controls declare roles, labels and state for buttons, switches, checkboxes, tabs, links, selectors/options and sliders.
- Current tests cover native AX interactions and limited mixed keyboard behavior, but do not establish production route focus order or complete keyboard coverage.
- Electron routes use semantic HTML controls and ARIA with browser keyboard semantics; route-wide focus sequences were not measured.

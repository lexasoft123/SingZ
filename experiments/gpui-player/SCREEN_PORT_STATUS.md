# Desktop screen port inventory

The production route inventory is `src/renderer/src/App.tsx`, including lazy dialog routes.
This is a screen prototype: backend availability and full visual parity remain separate.
Common native controls live in sibling `singz-ui/gpui`.

| Production surface | Native state | Next work |
| --- | --- | --- |
| Songs/catalog (`DropScreen`) | Interactive fixture port | Finish strict visual/control matrix |
| Player, mixer, transport, pitch and lyrics | Interactive silent fixture port; approved native lyric layers restored | Finish typography/control matrix; backend integration later |
| Audio settings (`SettingsModal`) | Local draft modal port | Device routing/backend later; remaining visual states |
| Log (`LogPanel`) | Initial native modal port implemented | Empty/rows screenshots differ; session selector, text selection and dismissal checked; save/persistent data backend later |
| Vocal training (`VocalTraining`, `VocalTrainingRoute`) | Missing | Main next screen; exercise catalog, setup and running/result states |
| Engine/model setup (`SetupModal`) | Missing | Download inventory, progress, cancel, errors |
| First-run setup (`SetupWizard`) | Missing | Welcome/engine/device/consent flow |
| Lyrics editor (`LyricsEditor`) | Missing | Timed rows, waveform/word editing, help and replacement sheets |
| Projects/storage (`ProjectPicker`) | Missing | Library root, project management, cloud/Drive states |
| Library import (`LibraryImport`) | Missing | Preview, collision handling, progress and cancel |
| Quick start (`QuickStart`) | Missing | Welcome and tour content |
| Release highlights (`WhatsNew`) | Missing | Actual version content and modal behavior |
| Language menu, help, title editing, confirmations | Partial/missing | Inventory each header and contextual route/state |
| Metronome and line continuation controls | Placeholder notices | Port source settings popovers and configuration states |

Checkpoint commits: SingZ `a5054e4e`, shared UIKit `3075c57`. They establish a reviewed
prototype baseline, not a completed interface or production integration milestone.

Do not remove the approved native highlight to make an Electron screenshot diff smaller.
Follow `LYRICS_HIGHLIGHT_STANDARD.md` and the interface-port-review skill. Capture all checks
hidden and muted; missing captures and unmeasured live FPS remain explicitly unresolved.

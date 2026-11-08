# Native source-track export — verified core checkpoint

The native ruler export arrow now opens shared UIKit controls for Separate stems
or Karaoke, MP3/WAV/FLAC, track selection, destination folder, status and Cancel.
Defaults and English copy follow production `StemExport.tsx`. Export uses original
source audio without current mixer gain/mute/solo, tempo, transpose or loop settings.
No Node is involved. Common controls and fonts remain in sibling UIKit.

Karaoke includes drums, bass, guitar, piano, instruments and generated backing-vocal
IDs; it excludes main vocals, full mixes and arbitrary custom tracks. The Rust
worker captures ordered typed sources before folder selection. It sequentially
invokes an offline native helper using existing zcore encoders/mixer; this command
constructs no audio host. Ordinary pinned files and before/after identity/stamps
protect sources. Exact built-in WAV paths may fall back to compacted FLAC when
missing. Source names retain production filename sanitization and numbering.

Private staging and exclusive atomic publication preserve existing destinations.
Earlier completed files survive a later error or cancellation. Cancellation reaches
the native encoder cooperatively, has bounded process cleanup and is checked again
at the final publication decision. Host modal/session/job fences reject delayed
chooser and terminal receipts; busy Cancel closes only after its actual worker
receipt. Export does not write project metadata or mark sync dirty.

Verification on macOS:

- 527 Rust tests pass, zero failed, two ignored, including twenty export domain/worker
  tests. Final publication-boundary cancellation has a dedicated regression.
- Actual native WAV/FLAC/MP3, uniform mix/peak limiting, Unicode, source counts,
  exclusive staging, corrupt/missing/linked sources, built-in compaction fallback,
  prequeued and in-flight cancellation pass. Offline output is independently decoded.
- Final hidden UI v4 passes at 1280×800 and 1060×640 logical pixels, 2× scale, with
  twenty captures. It exercises the actual ruler/button/checkbox/segment controls,
  all sixteen original MP3s, two selected WAVs and karaoke FLAC at each size,
  sixteen-row keyboard traversal/scroll, empty selection, folder cancellation,
  collisions, busy controls, Cancel cleanup and reopen receipt fencing.
- Python independently decodes all thirty-eight outputs and checks their spectral
  content, source duration and hashes. Karaoke contains the six intended fixture
  frequencies and excludes vocals/arbitrary customs. Source metadata, lyrics and
  audio bytes stay unchanged; only an exact zero-byte coordination lock is admitted.
- Final normal and UI-feature builds pass. The prior empty-project three-launch UI
  workflow and real native Release/lease/training ownership tests pass again.
  All 84 immutable previous native frames are exact (18 screens, 17 training,
  49 lyrics); eight comparator self-tests pass and diff checks are clean.

Review fixed overlapping long labels through explicit shared text-column wrapping
and fixed card/scroll composition. The disabled-button test initially measured a
scrolling card probe; the corrected probe tracks fixed chrome. A subsequent Cancel
assertion ran before GPUI delivered queued Close; the test now separates event
updates and requires the actual Finished receipt if completion already arrived.
These test fixes retain disabled-control and close-after-worker requirements.

Final UI capture collected 23 main-process CPU samples: median 75.89%, peak 100.16%
of one core during rapid scripted rendering, scrolling and twenty screenshots.
This is not idle CPU or a live playback benchmark. Helper CPU is excluded, GPU
counters are system-wide, and hidden live FPS remains unmeasured. Foreground
application identity was unchanged. The existing user preview was untouched; no
commit or staging was performed.

Evidence and exact source/font/binary identities are archived in
[gpui-stem-export-20261107](/Users/maxplanck/.codex/visualizations/2026/11/05/01a1add5-9a90-73c3-bec3-c18bfb04e619/gpui-stem-export-20261107/REVIEW.md).
New export captures are candidates: matched production visual/temporal references,
actual native folder chooser presentation, continuous playback under export,
long-song/permission/device/platform cases, locale/accessibility and live cadence
remain unqualified. Account/Drive sync, general song recording, remaining controls
and the rest of the full desktop port remain open. The overall goal is active.

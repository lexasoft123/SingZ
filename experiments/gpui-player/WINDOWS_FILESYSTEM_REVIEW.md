# Windows native filesystem qualification — 2026-11-08

The full isolated Dell Rust suite now passes **718 tests, zero failures, two
ignored**. The same current shared source passes **770 Mac tests, zero failures,
two ignored**. Earlier Windows runs are retained: 671/41, 708/9 and 717/1
passed/failed. No cases were skipped to make Windows green.

Windows denied saved-directory rename/import/delete while the writer lease kept
an open child handle. `project_publish::lock` now uses `Lease::movable`: Unix
retains its flock; Windows coordinates current native writers through a named
kernel mutex keyed by the lock file's volume/file identity, which survives a
folder rename. The mutex's owning thread closes the child handle before admitting
the operation. Its Rust guard can transfer to another worker and synchronously
releases ownership on Drop. Contention remains WouldBlock; process exit releases
the kernel owner. This defines the current native Windows writer protocol; it
is not a concurrent-write compatibility claim for older prototype binaries.

Ordinary Windows leases reserve an exclusive byte beyond supported application
file content. This mirrors Unix advisory ownership: cooperating writers remain
excluded while independent content validation and external-edit checks can read
and inspect the data. An exact-range unlock is explicit. Four portable regressions
plus their subprocess entry cover validation reads, contention after directory
rename, independent projects, cross-process exclusion and owner-exit recovery.
The existing Save, snapshot, import, delete and recording conflict suites remain
in the full run.

A direct Dell probe separated the failures. Any open child blocks a directory
move, including a handle-based POSIX rename. Whole-file locking rejects reads
through a fresh handle (error33); a reserved byte permits those reads. Under three
concurrent readers, 256 ordinary atomic replacements and 256 handle-based POSIX
replacements had no reader/writer errors; the old REPLACE_EXISTING|WRITE_THROUGH
method failed 232 writes with error5. File replacement now flushes the completed
staging file through its writable handle, then uses ordinary atomic replacement.
There is no unlink-before-replace step or retry that can overwrite a changed
publication after an earlier refusal. The completed microphone take also opens
writable for its required Windows flush.

The remaining test fixes preserve their intended assertions. Drive-plan fixtures
use a platform-native absolute root. Invalid-parent-path fixtures construct the
literal input without Windows PathBuf::join normalizing it first. The drift case
now asserts that its replacement bytes actually differ in length, rather than
relying on two tiny writes getting different filesystem timestamp ticks. Windows
invalid lock directories get the same typed validation as other platforms. Two
recovery fixtures own a prepared media copy outside the swappable project on
Windows; a separate Windows regression proves an actual source descriptor blocks
the swap until released. Both identity rechecks and resource-release assertions
still run.

Mac UI and normal builds pass; the normal binary is restored at
`d4590354c4f889868b44040c4b1aa86b41ec7d24adf21ff1bd3ea49c8f1c4eb5`.
The rebuilt Windows UI app is
`bd3fa144dc2f1d5df213b399dc883ea68f7b8aeb3666e05dcbc6a12a1db91f2f`;
the unchanged native helper is
`36fc045d9404d9ddd9463f547b9cc6dd619b53092da762aecb34d8b8ba46ab76`.
A fresh all-pass runtime12 covers graph open/analysis/playback/Save/restart,
Drive account/upload/Save-follow-up/cancel/restart and streaming adoption/native
catalog/playback/mixer/lyrics/Save/offline reopen. It passes 52 PNGs across six
app processes in one host with foreground HWND unchanged and all frame/resize
guards enabled. Viewport/scale/hidden metadata and independent filesystem checks
pass. UI/helper CPU and RSS plus per-app GPU-engine counters are archived; live
FPS remains unmeasured. The earlier d934 captures are not attributed to this app.

All 86 shared/dist font hashes and 28 shared UIKit source hashes remain exact.
No Node/Electron, real account, user library, global input or user preview update
belongs to this workflow. Production parity, live display FPS, physical devices,
models/services and the remaining desktop scenarios remain open.

One intervening Mac run had two previously known engine-probe startup timeouts
(768 passed/2 failed/2 ignored). The focused ten-case probe suite and latest full
suite pass, but the intermittent timeout is **not fixed or closed**. Failed logs
are retained alongside the later results. Windows/Linux full-platform completion
and the overall desktop goal are not established by these filesystem checks.

The artifact archive is `gpui-windows-fs-20261108` in this chat's visualization
directory. It includes the original 1869-file Windows source bundle
(SHA256 aff8ea0ff35c82a6828fe27dc5de97f57f8d8effd37d5ec414791647cc933e09),
current source overlays, all suite logs, probe sources/observations, current
receipts, PNGs and resource samples. To reconstruct, unpack the original bundle
and apply the source overlay to its SingZ directory; shared UIKit/fonts have no
subsequent changes. Full candidate images were inspected, including the compact
offline player and synced picker. Narrow Open-label clipping and raw verbatim
path labels remain visible UI review items; these functional candidates do not
establish production pixel parity.

# Completed recording publication recovery — 2026-11-08

A completed native WAV that cannot be published now remains an attached,
identity-checked recovery take. Save training WAV can promote it into the ordinary
retained root and export it; a failed export preserves the same recovery and a
successful retry clears the stale error. Normal export validation remains intact.
The full desktop goal remains active.

## Defect and implementation

Previously failed host publication emitted only an Error containing a staged
path. Helper publication could similarly leave a completed `.writing-<take-id>`
WAV. Neither became an exportable Take, and the exporter correctly rejected
arbitrary files outside its direct retained root.

`recording_recovery.rs` introduces an opaque recovery identity. `OwnedStage`
captures root/stage directory handles and identities when the private stage is
created, so replacing that directory before first recovery cannot re-authorize
it. Capture inspects only that take's exact direct filename and exact helper
`.writing-id/filename`. It requires one unique strict native mono PCM16 WAV,
bounded to 8–192 kHz and 30 seconds, with stable file identity, stamps and SHA-256.
An ordinary invalid collision sentinel may coexist with the valid helper WAV;
links, changed identities, ambiguous completed candidates and invalid data are
refused.

The microphone worker also proves native writer completion. `FinishProof`
distinguishes a validated successful finish, a matching terminal native error,
an unacknowledged transaction whose exact child exited, and an invalid receipt.
A successful finish with forged path/format/duration metadata cannot enable
recovery; generic timeout/write failure while the child still lives cannot do so.
Unknown nonempty private stages are preserved on failure without promising a
usable WAV.

Normal publication now holds a `SourcePin` before trusting the native format
receipt: its reserved original File, directory identities, size/mtime and complete
bytes/SHA fence sync, hard-link success and fallback recovery. A substituted valid
WAV or same-inode PCM edit with restored mtime cannot become Finished or be freshly
re-authorized by fallback. Normal Unix publication syncs its root before removing
the staged link; sync failure retains that original link and emits a warning.
Unknown directory-enumeration failures retain the stage instead of enabling Drop
unlink. A real isolated mode-0300 directory reproduced read EACCES with successful
unlink; deterministic Rust checks verify real WAV retention on that error.

Recovery remains a typed capability through the same generation/take/context
receipt guard. The UI exposes the existing Save control with actionable retained-
audio copy; raw native failure detail stays in diagnostics. No new export bypass
accepts arbitrary staged paths. `export_recovery` validates identity/content again,
copies into an exclusively created private root file, syncs it, and publishes a
new valid retained filename without replacing another file. Clones share a pinned
publication identity, assigned immediately after the visible hard link before any
fallible post-commit operation. A reserved original temporary File prevents inode
reuse from authorizing a replacement. Retry resumes exactly that same destination,
even after an injected post-link error or temporary open failure; changed files
refuse reuse without allocating a second promotion. Identity, size/mtime and full
content remain mandatory; ctime alone is excluded from these link proofs because
creating/removing the temporary hard-link alias legitimately changes it. Export then
runs the ordinary flat-root WAV, lease, cancellation, overwrite and source-change
checks, including verifying the promoted identity at opened-source admission.
Destinations inside recording evidence or aliasing its source are rejected.

The original recovery WAV is preserved. Promotion/export failures keep the same
Take available for another Save. Success feedback is context/take-bound and clears
old export errors; normal successful recording copy remains unchanged. Common
controls stay in shared UIKit, and the approved native lyrics paint is untouched.
A source-only audit found no further concrete issue in the reviewed path; root
added the original-directory and finish-proof fences during integration. Separate
workers owned storage and connected UI tests; root owned integration/build/capture.

## Verification scope

Normal suites pass 808 tests, zero failures, two ignored per platform. New storage
checks cover direct and helper stages, ambiguity, invalid data, links/aliases,
root/stage/source substitution, cancellation, late destination collision, cached
publication replacement, repeated export and root/destination protection. Domain
checks cover finish proof and context-bound export feedback.

Two independent connected cases use real native off-target 330 Hz PCM/CREPE and
actual Record/Stop controls. A controlled unrelated sentinel blocks either host
flat publication or native helper promotion into its host stage. The completed
native WAV must become a recovery-backed Take with unchanged session, input PID
and capture generation. Actual Save first targets an existing unrelated sentinel;
it must preserve that file and the recovery audio while retaining one promoted
flat-root WAV. Actual Save to a new destination then succeeds; another Save must
produce identical bytes and reuse the same promoted identity. The original
recovery and publication sentinel remain unchanged, and the exercise stays in
Respond without awarding a result.

The Save destination uses the existing hidden-test chooser seam and the actual
export worker. It does not qualify OS dialog presentation, disk-full, permission
failure or physical hardware. Each case has six captures at both content sizes,
with source/binary/fixture/state hashes and fresh nonoverlap geometry. Existing
healthy recording/export/navigation, abrupt active-recording failure/retry and
vocal completion input failure are rechecked against the new code.

## Final connected evidence

Final source/binary/fixture validation passes for 44 source files and unchanged
shared UIKit controls/training. Each platform ran five independent hidden apps:

| Case | Mac images | Linux images |
| --- | ---: | ---: |
| Completed host publication recovery | 6 | 6 |
| Completed helper publication recovery | 6 | 6 |
| Healthy recording/export/navigation | 12 | 12 |
| Abrupt active-recording failure and Continue | 7 | 7 |
| Vocal Completing input failure | 5 | 5 |
| Total | 36 | 36 |

Final v3: all 72 PNGs/10 apps have independently checked identities, dimensions and available
state metadata. Foreground stays unchanged throughout every observed final run;
Linux windows remain unmapped with frameless Motif hints. Fresh geometry reports
no recorder/guidance/dock overlap. The 1060-wide recovery and successful-export
frames on both platforms, plus the narrow Mac failed-export frame, were inspected:
status copy stays clear of the visible Save action and training controls.

Host/helper publication cases retain input PID 17949/18061 on Mac and 106/223 on
Linux, all capture generation 1, throughout recoverable failure and both exports.
The active-recording regression replaces input PID 18385→18437 on Mac and 473→481
on Linux, generation 1→3. Completing-input recovery replaces 18520→18642 and
596→604, also generation 1→3. Each result is checked against externally observed
owned process identities, rather than trusting only the test's result flags.

Independent standard WAV decoding validates four originals and all 16 copies:
mono PCM16 at 16 kHz, 0.384–0.416 seconds, 329.3–330.8 Hz, RMS 5652–5654.
Each original, promoted retained file and two exports is byte-identical. Both
unrelated collision sentinels and blocked export destinations remain unchanged.
Repeated Save retains the same promoted inode/stamp; the original completed
private WAV remains in its stage.

Independent retirement checks cover 27 final Mac owners (57 including v1/v2 runs) and 25 Linux native/display owners. Both exact task containers are stopped;
foreign PID 1268/startTicks 4023 retains its prepared PCM0p stream, and other
containers are unchanged. Source/cache and the user's preview bundle are retained.
No files are staged or committed.

Evidence directory:
`gpui-recording-publication-20261108` under this chat's visualization root.
Receipts include `independent-final-validation.json`, `independent-wav-validation.json`,
`final-capture-manifest.json`, `mac-process-retirement.json` and
`recording-publication-v3-container-cleanup.json`. Linux archive SHA-256:
`bba190cab22f95dc030c091b855b373f4123012cc8776aac0bcf7108434e2636`.
The completed combined archive is recorded separately in
`completed-archive-receipt.json`, avoiding a self-referential hash.

## Intermediate evidence

VM403's initial transfer/start SSH connections timed out before remote execution;
a bounded reachability check later succeeded. The first Mac run showed correct
recovery/promotion and refused to overwrite the chosen export sentinel. Its test
still asserted the destination was absent from an older missing-parent fixture.
V2 removes that stale assertion and requires byte-exact sentinel preservation;
no application guard or timeout was weakened. Intermediate files remain immutable
and are excluded from final capture counts. No builds/native-heavy tests run
during final captures.

## Kimi findings and final follow-up

The explicitly authorized Kimi K3.1 fast read-only review finished with exit 0.
Independent local source audit confirmed three defects absent from the v2 runtime
matrix: directory enumeration errors could enable staged-WAV deletion, normal
publication/fallback did not carry original file proof, and post-link promotion
errors could forget the committed destination. V3 fixes all three and adds ten
deterministic tests, including same-inode edited PCM with restored mtime,
postcommit error/open failure/cancellation, byte-identical foreign-file refusal
and source replacement. A fresh source audit found no remaining concrete issue
in that reviewed path. Both final 808-test suites and the 72-image/10-app connected
rerun use frozen v3 sources; all 16 WAV copies are independently decoded/hashed.

V2 receipts/captures remain preserved under their versioned paths and
`verification-v2`; they are excluded from final counts. Native app source changes
are limited to `microphone.rs` and `recording_recovery.rs` between v2 and v3.
The suggested persistent navigation recovery store is not adopted: clearing the
attached take on navigation matches production policy. Package assembly work is
separate from this checkpoint and has no claimed completed runtime verification.

## Remaining requirements

This recovers completed WAVs for the currently attached take, not unfinished RAM
audio lost on abrupt helper death. Automatic recovery discovery after process
restart, graceful hardware-error finalization, real disk-full/permissions,
physical microphone/hotplug, OS choosers, song-backed recording fault combinations,
all training task/states, services/models/live Google, latest Windows, hardware
GPU/Wayland, full visual/temporal/locale/accessibility and packaging remain open.
New candidate captures have no matched production reference and establish no
pixel-perfect parity. Live FPS and per-app GPU cost remain unmeasured; available
process CPU/footprint samples are retained. Native-only recovery copy localization
remains open. The prior intermittent escaped-child cancellation assertion is not
considered fixed by this passing suite.

# SingZ Box merge readiness

Status: implementation and local qualification complete, 9 November 2026. Current-revision PR checks remain the merge gate.

Prepare the separate Box application and its published dependencies for review and merge while preserving normal Desktop behavior. Application source and shared logic remain in SingZ; appliance startup remains in singz-box. Main-branch merges require a separate decision.

## Checklist

- [x] Consolidate the open Box PR and LoopZ integration history without losing the pending CEC fixes or unrelated work.
- [x] Publish the reusable LoopZ SDK/input subscription dependency as a reviewable PR and verify its pinned revision and CI.
- [x] Review and publish portable persistent audio-host/UI startup with private IPC readiness and invocation-owned cleanup.
- [x] Add installed Desktop/Box package qualification on Linux x64 and ARM64: normal launch, separate profiles, remote navigation, screenshots, native host, CEC and retained recovery.
- [x] Verify same-generation restoration of a retained song, lyrics and controls, with safe Stop recovery for invalid identity or state.
- [x] Complete local integration checks and prepare the application changes and dependencies for final review.

Merge requires independent approval of the exact staged tree and successful current-revision PR checks. The PR status is authoritative; this checklist does not substitute for those gates.

## Ownership and checks

The coordinator owns integration, explicit staging, Git and final acceptance. Bounded implementation workers own packaging, persistent startup, service/native attachment, TV recovery and main-process read-only restoration. Independent reviewers approve each exact staged tree before commit. Workers preserve other sessions' edits and use separate scratch paths.

Recovery acceptance includes same epoch/generation, advancing frames, current mix controls, no lifecycle replay, changed/deleted project rejection, asynchronous stale-result guards, no filesystem writes, and a real Linux window-close/restart test. Ordinary Desktop bundle limits and behavior remain applicable.

## Evidence

- Application PR: [SingZ #145](https://github.com/lexasoft123/SingZ/pull/145).
- CEC follow-up `c3c78aac`: independently reviewed; four tooling gates and 18 unit tests passed, including deliberate negative controls.
- Consolidation `69581d61`: independent comparison of all 19 earlier PR paths found no missing behavior; merge source tree unchanged.
- Packaging CI `5f2e1145`: independently reviewed; 18 focused checks passed. Both architectures built and coinstalled the packages, passed native-host/normal-launch/profile/remote assertions, then exposed a hidden-window screenshot failure.
- Visibility correction `80f89f77`: independently reviewed; 16 focused checks passed, including old-hidden and current-window visibility negative controls. Hosted x64/ARM64 requalification is running.
- Dependency: [LoopZ #3](https://github.com/lexasoft123/LoopZ/pull/3), pinned revision `960502c96b6f45816ac14482c1fecf0f89df42e3`. Portable core, Desktop checks and Linux Engine/interface PR workflows passed, including native x64/ARM64 and SDK checks.
- Startup `f9c6f87`: [singz-box #2](https://github.com/lexasoft123/singz-box/pull/2), independently reviewed. Six offline tests, intended legacy negative controls, shell/Python syntax and documentation links passed.
- Recovery service: coordinator independently passed 27 host/project/prepare tests. Separate source review confirmed native-first preparation, bounded background association and exact host identity guards.
- Main recovery: coordinator and independent reviewer passed 41 reader/IPC tests; canonical filesystem checks and cache-removal protection received independent review.
- Native/UI recovery: independent reviews passed 51 attachment/controller tests and 83 strict-commandability tests. Never-started outputs use the explicit Stop fallback; a paused transport is eligible only on an already-running native host.
- Integrated local verification: all four TypeScript configurations passed; 204 application suites passed with 2,761 tests and two skips. Desktop and Box builds passed; ordinary Desktop entry is 1,428,329 bytes against the existing 1,430,000-byte limit.
- Isolated Debian qualification: fresh Clang 21 addon, immutable artifact validation and actual Electron ABI/load smoke passed. The existing real headless native-host driver passed with no physical device opened. Real UI close/restart restored the same native generation, verified graph, lyrics and saved controls. The final real close/restart flow passed with observed RPC traffic and zero protected playback/routing mutations, same generation, current lyrics/graph/gain, post-restore controls and explicit changed-lyrics Stop. The sandbox-enabled CEC fixture also passed. Hosted final-revision CI remains a merge requirement.

## Qualification boundaries

Physical sound testing is deferred to the next listening session. This work does not play audio or change the live board or receiver configuration. FLOW 8 MON output gain/routing remain hardware qualification items. New startup cleanup has not been deployed to the board.

Real Wi-Fi provisioning and signed OS update/rollback services remain appliance follow-up work; unsupported capabilities must remain visibly unavailable. These PRs do not claim a complete appliance release.

Unrelated splitter producer/documentation changes and build scratch outputs remain untouched and excluded from staging. Diagnose CI using its committed revision rather than unrelated local changes.

# R-09 — Drive requests per clean sync

Counts below mean HTTP requests to Drive, excluding OAuth/token refresh and any recovery/adoption/retirement work. Electron's request counts assume an existing SingZ folder, no pagination, no published folders, no orphans, and a single changed project file whose metadata makes the catalog change. *(inferred)*

## Electron

`ensureFolder('SingZ')` does one listing when the folder already exists; sync then lists SingZ, project children, and stems children. Parent listings are chunked by at most 50 ids and skipped for empty id lists [src/main/gdrive.ts:333-341, src/main/gdrive.ts:796-798, src/main/gdrive.ts:833-850]. A file upload is a resumable-session request plus a content PUT [src/main/gdrive.ts:354-380]. Changed file metadata changes the catalog row and can cause one two-request catalog upload [src/main/gdrive.ts:1094-1108].

| Projects | Clean Drive requests | One file changed | curl/process spawns |
|---:|---:|---:|---:|
| 1 | 4 | 8 | 0 (sync uses the main-process API client; inferred) |
| 10 | 4 | 8 | 0 (sync uses the main-process API client; inferred) |
| 50 | 4 | 8 | 0 (sync uses the main-process API client; inferred) |

The 8 changed-case requests are the four baseline listings, two requests for the changed file, and two for the changed catalog. *(inferred from the call sites above)* The batched listing count does not grow from 1 to 50 projects because the two child listings each fit in one 50-parent query [src/main/gdrive.ts:305-323, src/main/gdrive.ts:833-850].

## Native GPUI

The straightforward reconciliation listing path is one SingZ folder lookup, one SingZ children listing, then `children_of(project ids)` and `children_of(stems ids)`, each chunked at 50 parent ids [experiments/gpui-player/src/drive_sync.rs:95-97, experiments/gpui-player/src/drive_sync.rs:196-216, experiments/gpui-player/src/drive_remote.rs:221-247, experiments/gpui-player/src/drive_remote.rs:249-292]. That portion is 4 requests for 1 or 10 projects and 6 for 50 projects (the project-child list needs two chunks); the stems list adds a chunk only if it has more than 50 existing stems folders. *(inferred)*

| Projects | Clean total | One-file-changed total | curl spawns |
|---:|---:|---:|---:|
| 1 | Not determinable from inspected code | Not determinable from inspected code | One per HTTP request |
| 10 | Not determinable from inspected code | Not determinable from inspected code | One per HTTP request |
| 50 | Not determinable from inspected code | Not determinable from inspected code | One per HTTP request |

The totals are not just the listing subtotal: the native sync additionally binds/checks account and retirement state, resumes publications, processes empty transactions, validates/records publication receipts, and may make project-level admission/verification calls [experiments/gpui-player/src/drive_sync.rs:102-128, experiments/gpui-player/src/drive_sync.rs:153-168, experiments/gpui-player/src/drive_sync.rs:291-320, experiments/gpui-player/src/drive_sync.rs:410-417]. The supplied `experiments/gpui-player/tests/drive_fixture.py` path was not present, so no fixture request counter was available to derive exact scenario totals. *(inferred)*

Each native HTTP call starts a `curl`/`curl.exe` child [experiments/gpui-player/src/drive_http.rs:294-335]; therefore native curl spawn count equals its HTTP-request count. The desktop also starts one long-lived `singz-drive` worker thread [experiments/gpui-player/src/drive_service.rs:78-83], which is not a process spawn. No per-request native count can be asserted without the fake-Drive fixture/counter or accounting every transaction branch.

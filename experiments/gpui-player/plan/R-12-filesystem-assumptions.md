# R-12: POSIX-like filesystem assumptions

Scope: code at base commit `f7607311`; exFAT/SMB behavior is reported only where the code or Windows qualification explicitly establishes it. Other filesystem behavior is *(inferred)* from the operation used; no exFAT disk-image or SMB execution was available in this read-only task.

## Filesystem operations and portability

| Reliance | Code behavior and evidence | exFAT / SMB |
|---|---|---|
| Atomic replacement rename | Unix `replace` calls `fs::rename`; Windows flushes the staging file then calls `fs::rename`, expecting same-volume replacement (`src/project_store.rs:224-235`). Metadata save publishes an existing member through this replacement path (`src/project_store.rs:734-740`). Split publish/recovery moves members with `fs::rename` (`src/project_publish.rs:212-218`, `src/project_publish.rs:281-292`). | Windows qualification reports 256 ordinary atomic replacements without reader/writer errors on its tested Windows setup (`WINDOWS_FILESYSTEM_REVIEW.md:27-35`). exFAT and SMB not tested; atomicity/durability across these mounts is *(inferred)*, not established. |
| Atomic no-replace via hard link | New project metadata uses `fs::hard_link` to make absent-file publication race-safe (`src/project_store.rs:734-739`). Drive local-operation records also publish by hard link (`src/drive_local_ops.rs:201-215`). | Hard-link support/semantics on exFAT and SMB are not established by this tree; success or refusal is *(inferred)* to depend on filesystem/server support. |
| File locks | Non-Windows `Lease::acquire` uses Rust `File::try_lock` and unlocks on Drop (`src/file_lease.rs:14-24`, `src/file_lease.rs:39-44`). Windows uses the Windows lease implementation (`src/file_lease.rs:5-12`, `src/file_lease.rs:21-24`); publish creates `.singz-native-write.lock` (`src/project_publish.rs:69-75`). The Windows implementation uses byte-range locks and named mutex logic (`src/file_lease_windows.rs:1-15`, `src/file_lease_windows.rs:89-166`). | SMB lock propagation/cooperation and exFAT lock behavior are not tested or specified by these sources *(inferred)*. Windows qualification specifically covers local Windows contention and cross-process behavior, not SMB (`WINDOWS_FILESYSTEM_REVIEW.md:8-25`). |
| Stable directory identity | Unix identity is device + inode + optional creation time (`src/directory_identity.rs:74-84`); Windows is volume serial + file index + optional creation time (`src/directory_identity.rs:86-120`). Persistent retirement requires creation time (`src/directory_identity.rs:33-42`). Unsupported platforms refuse stable identity (`src/directory_identity.rs:122-124`). | exFAT/SMB identity stability and uniqueness are not verified; because persistence relies on volume/file IDs and birth time, compatibility is *(inferred)* to vary by driver/server. |
| Source change check by mtime | `source_jobs::copy` requires same length and equal `modified()` values before/after copy (`src/source_jobs.rs:423-452`). `project_store` also compares before/after metadata for source copying (`src/project_store.rs:290-363`). | Timestamp granularity concerns are documented in a Windows test fixture: the test was changed to vary byte lengths instead of depending on tiny writes receiving different timestamp ticks (`WINDOWS_FILESYSTEM_REVIEW.md:38-42`). On exFAT/SMB coarse or cached timestamps may miss same-length edits *(inferred)*. |
| Case handling | Custom lane IDs and filenames are normalized/lowercased during validation (`src/project_store.rs:253-260`, `src/project_store.rs:420-441`). No filesystem-level case-sensitivity probe appears in the reviewed flows. | Case sensitivity/collision behavior on exFAT/SMB is not established *(inferred)*; lowercase logical checks do not prove the mounted filesystem's behavior. |
| Directory rename with open child handles | Rename holds a movable lease; Windows closes the child handle before admitting the operation (`src/file_lease.rs:26-36`; `WINDOWS_FILESYSTEM_REVIEW.md:8-15`). | Windows probe found any open child blocks directory move, including handle-based POSIX rename (`WINDOWS_FILESYSTEM_REVIEW.md:27-33`). SMB/exFAT not tested. |

## User names used as paths without a Windows reserved-name check

| Entry/path construction | Evidence | Finding |
|---|---|---|
| Project rename | User name is trimmed, transformed by `safe_name`, then joined to the parent (`src/project_rename.rs:73-80`). `safe_name` replaces path punctuation and strips known audio extensions (`src/source_jobs.rs:1527-1542`). | No Windows reserved-name check is visible in this transformation. *(inferred)* Device names such as `CON` survive this character filtering. |
| Project member save | `commit` accepts only fixed literals `project.json` or `lyrics.json` before `dir.join(name)` (`src/project_store.rs:698-707`). | Not user-supplied path component; constrained allowlist. |
| Library import dialog | Dialog receives `dir` and `root` as `PathBuf` values from its host; it does not itself derive a path from a typed name (`src/library_import.rs:20-23`, `src/library_import.rs:58-66`). | No supplied-name path construction visible in this module. |
| Source-work outputs | Cache root is fixed `source-work`; copied child names originate from directory entries, joined into destination (`src/source_jobs.rs:394-395`, `src/source_jobs.rs:454-484`). | Names are not user-entered at this site; no explicit Windows reserved-name check before join is shown. |
| Drive operation files | Paths use validated operation IDs plus fixed suffixes (`src/drive_local_ops.rs:201-223`). | Generated identifiers, not user-supplied names. |

## `source-work` bounds and cleanup

| Bound | Evidence |
|---|---|
| Location and naming | Cache is `audio_devices::directory()/source-work`; job tokens combine process ID, current time and an atomic counter (`src/source_jobs.rs:394-404`). |
| Per-file / aggregate project-copy limits | Each copied file is capped at 2 GiB (`src/source_jobs.rs:423-428`); recursive project copy is capped at 4096 entries and 8 GiB total (`src/source_jobs.rs:454-484`). |
| Cleanup | `Pending::drop` removes its directory recursively, except preserved split staging directories identified by `.native-split-*` plus `.singz-native-split.json` (`src/source_jobs.rs:406-421`). |
| Cache-wide bound/pruning | No cache-wide size/count cap or age-based prune is established by the inspected `source-work` code. *(inferred)* Entries left by process termination may persist; normal Drop cleanup does not run after abrupt termination. |

## Not determined

No exFAT disk image, SMB share, or filesystem-specific qualification was available in the reviewed code/docs, so those behaviors beyond the explicit local Windows probe remain unverified. The report does not infer a broader reserved-name policy from uninspected UI validation outside the listed modules.

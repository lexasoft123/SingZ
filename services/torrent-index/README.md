# Torrent filename index

Node 24+ and built-in SQLite FTS5; no additional language/runtime or npm service dependencies. The importer uses the existing C++ metadata parser via the built NAPI addon. Audio payloads are never downloaded by this service.

The index is implemented and locally tested. **No RuTracker-wide corpus has been imported, and the production endpoint is not deployed.** The mobile and desktop filename tab stays hidden until that service exists and `TORRENT_FILENAME_SEARCH_ENABLED` is enabled in `src/shared/torrent.ts`. Release-title search remains available.

## Import verified metadata

Obtain an authorized metadata snapshot with exact RuTracker topic IDs, titles, seeder counts, and local `.torrent` files. A title/topic dump alone cannot prove a filename match. Never infer topic IDs from hashes. Snapshot seeders are not live peer counts.

Create a JSONL manifest, one record per topic:

```json
{"id":"12345","title":"Album title","seeders":17,"metadataFile":"12345.torrent"}
```

The IDs in this manifest define the expected catalog. Every import resets membership and marks coverage complete only after all manifest members are imported. If interrupted, coverage stays partial; rerun the import to finish a new snapshot. For public deployment import into a new database, verify coverage, then swap the service to it, so users see a coherent snapshot.

```sh
npm run torrent:addon
node services/torrent-index/import.mjs /private/data/files.sqlite /private/data/manifest.jsonl /private/data/metadata "$PWD/vendor/torrent/darwin-arm64/singz-torrent.node" 'Source name and snapshot date'
SINGZ_TORRENT_INDEX_DB=/private/data/files.sqlite PORT=8792 npm run torrent:index:serve
npm run torrent:index:test
```

Keep original metadata private: it may contain tracker passkeys. Only topic ID, title, seeder snapshot, audio file index/name/path/size, and import timestamps are indexed. Cookies, passwords, announcement URLs, infohashes and original metadata are not served or copied into SQLite. The temporary native metadata store is deleted after import.

## HTTP

The service binds to loopback. Publish behind HTTPS at `/singz/torrent-index` by stripping that prefix when proxying. Add request limits at the reverse proxy. The app currently expects `https://sis-motors.ru/singz/torrent-index`.

- `GET /v1/status`: catalog source, update time, indexed torrent/file counts, expected torrent count, completeness.
- `GET /v1/search?query=Sonne&offset=0`: up to 50 releases sorted only by seeders descending; up to five matching file previews per release and a total match count. Uses Unicode normalization and all search words against audio basenames. At least one word must have three characters; short companion words still filter (`du hast`).
- Empty catalog: 503 with a clear error, never a misleading empty successful search. Unknown scope or partial imports are disclosed in coverage. Counts describe the declared snapshot; even complete snapshot coverage is not a claim that the live site has no newer torrents.

For Linux hosting, build the addon on Linux against the same SDK architecture; a macOS addon cannot run on the server. Node 18 on the current web host lacks `node:sqlite`; deployment needs an app-owned Node 24+ process and a configured HTTPS reverse proxy. No deployment has been performed by these scripts.

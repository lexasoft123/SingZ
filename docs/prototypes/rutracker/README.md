# RuTracker interface prototype

Interactive design exploration for desktop, iOS and Android. Open `index.html` in a browser. The editable source is `prototype.fragment.html`; `index.html` is its standalone preview.

All releases, seeder counts, account state and download progress are sample data. There are no tracker requests, real authentication, torrent engine, filesystem downloads or song imports. The standalone preview may load its shared presentation helpers from a CDN. Do not enter real credentials.

## Agreed behavior

- Search RuTracker for an artist/song; sort releases by **seeders descending**. Do not show or sort by leechers or combined peer counts.
- Select a release first, then select one audio file from its contents.
- Show the selected song's size separately from the full release size.
- Download that song, then hand it to the existing Add song flow.
- Target desktop, iOS and Android; the phone layouts use sequential screens and desktop uses a release list beside the file picker.

## Exploring the prototype

The preview starts in a demo session with results for «Кино Группа крови». Select a release and a song, start the simulated download, pause/resume or cancel it, then continue to song details and add the demo song to the demo library. The account button opens the sign-in preview. Search and file filtering work on the sample dataset. The zero-seeder release demonstrates waiting and choosing another release.

The platform picker switches between Desktop, iOS and Android. Each platform keeps its own selections. No credentials are persisted.

## Next step

Review the interface before planning the implementation. Decisions still to resolve include the torrent engine and its native packaging, RuTracker session handling, background execution, durable partial downloads, and albums distributed as a single audio image plus a cue sheet.

## Workspace

Branch: `codex/rutracker-downloads`. Worktree: `/Users/maxplanck/Dev/my/SingZ/.Codex/worktrees/rutracker-downloads`. The main checkout's existing changes are outside this prototype.

Bootstrap was attempted with `scripts/worktree-setup.sh`; mobile postinstall failed in the existing sample generator when `afconvert` rejected FLAC (`ExtAudioFileSetProperty ('cfmt') failed ('fmt?')`). This browser-only prototype does not depend on that step. Native apps have not been rebuilt or verified for this work.

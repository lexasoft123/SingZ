# Portable custom-track paths

Project metadata stores custom audio as `stems/<filename>` with forward slashes
on every platform. Filesystem paths used inside desktop memory remain native
absolute paths; this does not rename source audio or lane IDs.

Older Windows saves used the operating system's path join and wrote
`stems\custom-backing-vocals.wav`. The phone rejected the entry and macOS looked
for a literal backslash filename, silently losing the backing lane. This was a
generic custom-track persistence bug exposed by backing-vocal separation.

Both project readers now accept that older Windows spelling and convert it to
the canonical relative form. Only one filename beneath `stems/` is accepted:
absolute paths, traversal, nested folders, NULs and Windows stream names remain
invalid. Desktop Save updates a reopened project’s metadata to forward slashes
while keeping the audio file, ID, label, mixer key and hash identity intact.
Mobile analysis writers can retain the older spelling in project.json; mobile
readers use the normalized path when opening the audio.

Regression checks cover desktop reopen/resave, mobile lane loading and the real
desktop sync → fake Drive → real phone loader path using the Windows metadata
spelling. Actual audio decoding and platform playback remain device checks.

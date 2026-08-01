/**
 * The desktop suite's handle on the shared fake Drive (tests/shared/fake-drive.ts).
 * Kept as its own module because the name is what the sync tests — and the
 * emulator streaming recipe in CLAUDE.md — reach for.
 */
export { startFakeDrive as startMockDrive, type FakeDriveServer as MockDrive } from '../shared/fake-drive-http'
export { newStore, putFile, resetHits, treeOf, FOLDER, type FakeFile } from '../shared/fake-drive'

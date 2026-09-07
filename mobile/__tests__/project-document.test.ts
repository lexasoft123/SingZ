import {
  mutateProjectDocument,
  type ProjectDocumentApi,
} from '../src/project-document';
import {
  MobileMetronomePersistence,
  type MetronomePersistenceApi,
} from '../src/playback/metronome-persistence';
import type { ProjectDoc } from '../src/model';

function base(): ProjectDoc {
  return {
    version: 2,
    name: 'Same song',
    songFile: 'song.flac',
    savedAt: 'before',
    settings: {
      transpose: 0,
      tracks: { vocals: { muted: false, solo: false, volume: 1 } },
      futureSetting: { keep: ['exact'] },
    },
    graphHash: {
      format: 9,
      md5: '0123456789abcdef0123456789abcdef',
      size: 123,
      mtimeMs: 456,
    },
    futureTop: { preserve: true },
  } as ProjectDoc;
}

test('competing project writers serialize read→merge→write so neither field is lost', async () => {
  let text = JSON.stringify(base());
  let reads = 0;
  let firstRead!: () => void;
  let releaseFirst!: () => void;
  const firstHasRead = new Promise<void>(resolve => (firstRead = resolve));
  const firstMayWrite = new Promise<void>(resolve => (releaseFirst = resolve));
  let writes = 0;
  const api: ProjectDocumentApi = {
    readText: async () => {
      reads++;
      if (reads === 1) firstRead();
      return text;
    },
    writeText: async (_project, _file, next) => {
      writes++;
      if (writes === 1) await firstMayWrite;
      text = next;
      return true;
    },
  };

  // Metronome has read the old document but is deliberately held before its
  // write. Analysis arrives in exactly the destructive race's old window.
  const persistenceApi: MetronomePersistenceApi = {
    readProjectText: api.readText,
    writeProjectText: api.writeText,
    getPreference: async () => null,
    setPreference: async () => undefined,
    delay: async () => undefined,
  };
  const metronome = new MobileMetronomePersistence(persistenceApi);
  metronome.save(
    { source: 'phone', dir: 'Same song' },
    { click: true, countInBars: 1, volume: 0.5, accent: true },
  );
  await firstHasRead;
  const analysis = mutateProjectDocument(
    'Same song',
    doc => ({
      ...doc,
      savedAt: 'analysis',
      settings: {
        ...doc.settings,
        key: { pc: 7, minor: false, detVersion: 4 },
        tracks: { vocals: { muted: true, solo: false, volume: 0.25 } },
      },
    }),
    api,
  );

  // The second writer is queued before its read, not merely before its write.
  await Promise.resolve();
  expect(reads).toBe(1);
  releaseFirst();
  await Promise.all([metronome.flush(), analysis]);

  const final = JSON.parse(text) as ProjectDoc;
  expect(reads).toBe(2);
  expect(final.settings.metronome).toEqual({
    click: true,
    countInBars: 1,
    volume: 0.5,
    accent: true,
  });
  expect(final.settings.key).toEqual({ pc: 7, minor: false, detVersion: 4 });
  expect(final.settings.tracks.vocals).toEqual({
    muted: true,
    solo: false,
    volume: 0.25,
  });
  expect(final.savedAt).toBe('analysis');
  expect(final.graphHash).toEqual(base().graphHash);
  expect((final as unknown as Record<string, unknown>).futureTop).toEqual({
    preserve: true,
  });
  expect(
    (final.settings as unknown as Record<string, unknown>).futureSetting,
  ).toEqual({ keep: ['exact'] });
});

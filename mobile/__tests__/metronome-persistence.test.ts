import {
  DRIVE_METRONOME_OVERRIDES_KEY,
  MAX_METRONOME_OVERRIDE_BYTES,
  MAX_METRONOME_OVERRIDE_ENTRIES,
  METRONOME_PHONE_JOURNAL_KEY,
  MobileMetronomePersistence,
  type MetronomePersistenceApi,
} from '../src/playback/metronome-persistence';
import type { MetronomeConfig, ProjectDoc } from '../src/model';
import { metronomeRefForEntry } from '../src/projects';

const off: MetronomeConfig = {
  click: false,
  countInBars: 0,
  volume: 0.7,
  accent: true,
};
const on: MetronomeConfig = {
  click: true,
  countInBars: 2,
  volume: 0.4,
  accent: false,
};

function project(metronome: unknown = off): ProjectDoc {
  return {
    version: 2,
    name: 'Song',
    songFile: 'song.flac',
    savedAt: '2026-08-01T00:00:00.000Z',
    settings: {
      transpose: 3,
      tempo: 0.9,
      tracks: { vocals: { muted: false, solo: false, volume: 0.63 } },
      beat: {
        beats: [0, 0.5, 1],
        bpm: 120,
        beatsPerBar: 4,
        downbeat: 0,
        source: 'manual',
      },
      metronome: metronome as MetronomeConfig,
    },
    stemHashes: {
      'vocals.flac': { md5: 'a', size: 123, mtimeMs: 456 },
    },
  };
}

function memoryApi(doc = project()): {
  readonly api: MetronomePersistenceApi;
  readonly preferences: Map<string, string>;
  readonly writes: string[];
  setDoc(next: ProjectDoc): void;
  getDoc(): ProjectDoc;
} {
  let current = JSON.stringify(doc);
  const preferences = new Map<string, string>();
  const writes: string[] = [];
  return {
    preferences,
    writes,
    setDoc(next) {
      current = JSON.stringify(next);
    },
    getDoc() {
      return JSON.parse(current) as ProjectDoc;
    },
    api: {
      readProjectText: jest.fn(async () => current),
      writeProjectText: jest.fn(async (_project, _file, text) => {
        writes.push(text);
        current = text;
        return true;
      }),
      getPreference: jest.fn(async key => preferences.get(key) ?? null),
      setPreference: jest.fn(async (key, value) => {
        preferences.set(key, value);
      }),
      delay: async () => undefined,
    },
  };
}

describe('mobile metronome persistence', () => {
  test('local reopen reads the current doc and saves by merging only metronome', async () => {
    const memory = memoryApi(
      project({ click: true, countInBars: 99, volume: -1 }),
    );
    const store = new MobileMetronomePersistence(memory.api);

    const resolved = await store.resolve(
      { source: 'phone', dir: 'Song' },
      project(off),
    );
    expect(resolved.settings.metronome).toEqual({
      click: true,
      countInBars: 2,
      volume: 0,
      accent: true,
    });

    // Analysis/mixer landed after the screen opened but before this toggle.
    const concurrent = project(off);
    concurrent.settings.key = { pc: 9, minor: true, detVersion: 4 };
    concurrent.settings.tracks.vocals = {
      muted: true,
      solo: false,
      volume: 0.21,
    };
    concurrent.savedAt = '2026-08-30T12:00:00.000Z';
    memory.setDoc(concurrent);

    store.save({ source: 'phone', dir: 'Song' }, on);
    await store.flush();

    const written = memory.getDoc();
    expect(written.settings.metronome).toEqual(on);
    expect(written.settings.key).toEqual(concurrent.settings.key);
    expect(written.settings.tracks).toEqual(concurrent.settings.tracks);
    expect(written.settings.beat).toEqual(concurrent.settings.beat);
    expect(written.savedAt).toBe(concurrent.savedAt);
    expect(written.stemHashes).toEqual(concurrent.stemHashes);

    const reopened = await new MobileMetronomePersistence(memory.api).resolve(
      { source: 'phone', dir: 'Song' },
      project(off),
    );
    expect(reopened.settings.metronome).toEqual(on);
    expect(reopened.settings.key).toEqual(concurrent.settings.key);
  });

  test('rapid local toggles serialize and coalesce to the newest strict snapshot', async () => {
    const memory = memoryApi();
    const store = new MobileMetronomePersistence(memory.api);
    const ref = { source: 'phone' as const, dir: 'Song' };

    store.save(ref, { ...off, click: true });
    store.save(ref, { ...off, countInBars: 1 });
    store.save(ref, on);
    await store.flush();

    expect(memory.writes).toHaveLength(1);
    expect(memory.getDoc().settings.metronome).toEqual(on);
  });

  test('an exported or picked load without explicit identity cannot write a same-named phone project', async () => {
    for (const source of ['folder', undefined] as const) {
      const memory = memoryApi(project(off));
      const store = new MobileMetronomePersistence(memory.api);
      const ref = metronomeRefForEntry({ dir: 'Song', source });

      expect(ref).toMatchObject({ source: 'readonly', dir: 'Song' });
      await expect(store.save(ref, on)).rejects.toThrow(/read-only/);
      await expect(store.flush()).rejects.toThrow(/read-only/);
      expect(memory.writes).toHaveLength(0);
      expect(memory.getDoc().settings.metronome).toEqual(off);
      await expect(store.resolve(ref, project(off))).resolves.toMatchObject({
        settings: { metronome: off },
      });
    }
  });

  test('Drive override survives a new store and is isolated by account plus directory', async () => {
    const memory = memoryApi(project(off));
    memory.preferences.set('singz.gdrive.email', 'Singer@Example.com ');
    const ref = { source: 'gdrive' as const, dir: 'Father and Son' };

    const first = new MobileMetronomePersistence(memory.api);
    first.save(ref, on);
    await first.flush();

    const reopened = await new MobileMetronomePersistence(memory.api).resolve(
      ref,
      project(off),
    );
    expect(reopened.settings.metronome).toEqual(on);
    expect(reopened.settings.tracks).toEqual(project(off).settings.tracks);

    memory.preferences.set('singz.gdrive.email', 'other@example.com');
    const otherAccount = await new MobileMetronomePersistence(
      memory.api,
    ).resolve(ref, project(off));
    expect(otherAccount.settings.metronome).toEqual(off);
  });

  test('picked-folder override is root-scoped and never touches a same-named phone project', async () => {
    const memory = memoryApi(project(off));
    const picked = {
      source: 'picked' as const,
      root: 'content://tree/cloud-a',
      dir: 'Song',
    };

    const store = new MobileMetronomePersistence(memory.api);
    store.save(picked, on);
    await store.flush();

    expect(memory.writes).toHaveLength(0);
    expect(memory.getDoc().settings.metronome).toEqual(off);
    await expect(
      new MobileMetronomePersistence(memory.api).resolve(picked, project(off)),
    ).resolves.toMatchObject({
      settings: { metronome: on },
    });
    await expect(
      new MobileMetronomePersistence(memory.api).resolve(
        { source: 'picked', root: 'content://tree/cloud-b', dir: 'Song' },
        project(off),
      ),
    ).resolves.toMatchObject({ settings: { metronome: off } });
    await expect(
      new MobileMetronomePersistence(memory.api).resolve(
        { source: 'phone', dir: 'Song' },
        project(off),
      ),
    ).resolves.toMatchObject({ settings: { metronome: off } });
  });

  test('the 513th override is deterministically pruned to a strict 512-entry document', async () => {
    const memory = memoryApi();
    memory.preferences.set('singz.gdrive.email', 'singer@example.com');
    const entries: Record<string, MetronomeConfig> = {};
    for (let i = 0; i < MAX_METRONOME_OVERRIDE_ENTRIES; i++) {
      entries[`key-${String(i).padStart(3, '0')}`] = off;
    }
    memory.preferences.set(
      DRIVE_METRONOME_OVERRIDES_KEY,
      JSON.stringify({ formatVersion: 1, entries }),
    );

    const store = new MobileMetronomePersistence(memory.api);
    store.save({ source: 'gdrive', dir: 'song-512' }, on);
    await store.flush();

    const saved = JSON.parse(
      memory.preferences.get(DRIVE_METRONOME_OVERRIDES_KEY)!,
    ) as {
      entries: Record<string, MetronomeConfig>;
    };
    expect(Object.keys(saved.entries)).toHaveLength(
      MAX_METRONOME_OVERRIDE_ENTRIES,
    );
    expect(saved.entries['key-000']).toBeUndefined();
    expect(
      saved.entries[
        JSON.stringify(['gdrive', 'singer@example.com', 'song-512'])
      ],
    ).toEqual(on);
    await expect(
      new MobileMetronomePersistence(memory.api).resolve(
        { source: 'gdrive', dir: 'song-512' },
        project(off),
      ),
    ).resolves.toMatchObject({ settings: { metronome: on } });
  });

  test('size pruning always writes a document the strict reader accepts', async () => {
    const memory = memoryApi();
    memory.preferences.set('singz.gdrive.email', 'singer@example.com');
    const entries: Record<string, MetronomeConfig> = {};
    let index = 0;
    while (true) {
      const key = `${String(index).padStart(3, '0')}-${'x'.repeat(420)}`;
      const candidate = JSON.stringify({
        formatVersion: 1,
        entries: { ...entries, [key]: off },
      });
      if (
        Buffer.byteLength(candidate, 'utf8') >=
        MAX_METRONOME_OVERRIDE_BYTES - 300
      )
        break;
      entries[key] = off;
      index++;
    }
    const before = JSON.stringify({ formatVersion: 1, entries });
    expect(Buffer.byteLength(before, 'utf8')).toBeLessThanOrEqual(
      MAX_METRONOME_OVERRIDE_BYTES,
    );
    memory.preferences.set(DRIVE_METRONOME_OVERRIDES_KEY, before);

    const ref = { source: 'gdrive' as const, dir: `new-${'z'.repeat(3900)}` };
    const store = new MobileMetronomePersistence(memory.api);
    store.save(ref, on);
    await store.flush();

    const raw = memory.preferences.get(DRIVE_METRONOME_OVERRIDES_KEY)!;
    expect(Buffer.byteLength(raw, 'utf8')).toBeLessThanOrEqual(
      MAX_METRONOME_OVERRIDE_BYTES,
    );
    expect(
      Object.keys((JSON.parse(raw) as { entries: object }).entries).length,
    ).toBeLessThan(Object.keys(entries).length + 1);
    await expect(
      new MobileMetronomePersistence(memory.api).resolve(ref, project(off)),
    ).resolves.toMatchObject({
      settings: { metronome: on },
    });
  });

  test('a failed in-flight value cannot strand the newer desired value', async () => {
    let current = JSON.stringify(project(off));
    let writes = 0;
    let startFirst!: () => void;
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>(resolve => (startFirst = resolve));
    const firstReleased = new Promise<void>(
      resolve => (releaseFirst = resolve),
    );
    const api: MetronomePersistenceApi = {
      readProjectText: async () => current,
      writeProjectText: async (_project, _file, text) => {
        writes++;
        if (writes === 1) {
          startFirst();
          await firstReleased;
          throw new Error('temporary disk failure');
        }
        current = text;
        return true;
      },
      getPreference: async () => null,
      setPreference: async () => undefined,
      delay: async () => undefined,
    };
    const store = new MobileMetronomePersistence(api);
    const ref = { source: 'phone' as const, dir: 'Song' };

    store.save(ref, { ...off, click: true });
    await firstStarted;
    store.save(ref, on);
    releaseFirst();
    await store.flush();

    expect(writes).toBe(2);
    expect((JSON.parse(current) as ProjectDoc).settings.metronome).toEqual(on);
  });

  test('immediate reopen observes the newest value while its phone write is blocked', async () => {
    let current = JSON.stringify(project(off));
    let startWrite!: () => void;
    let releaseWrite!: () => void;
    const writeStarted = new Promise<void>(resolve => (startWrite = resolve));
    const writeReleased = new Promise<void>(
      resolve => (releaseWrite = resolve),
    );
    const api: MetronomePersistenceApi = {
      readProjectText: async () => current,
      writeProjectText: async (_project, _file, text) => {
        startWrite();
        await writeReleased;
        current = text;
        return true;
      },
      getPreference: async () => null,
      setPreference: async () => undefined,
    };
    const store = new MobileMetronomePersistence(api);
    const ref = { source: 'phone' as const, dir: 'Song' };

    store.save(ref, on);
    await writeStarted;

    await expect(store.resolve(ref, project(off))).resolves.toMatchObject({
      settings: { metronome: on },
    });
    expect((JSON.parse(current) as ProjectDoc).settings.metronome).toEqual(off);

    releaseWrite();
    await store.flush();
    expect((JSON.parse(current) as ProjectDoc).settings.metronome).toEqual(on);
  });

  test('an accepted save survives immediate unmount while project.json is blocked', async () => {
    let current = JSON.stringify(project(off));
    const preferences = new Map<string, string>();
    let startWrite!: () => void;
    let releaseWrite!: () => void;
    const writeStarted = new Promise<void>(resolve => (startWrite = resolve));
    const writeReleased = new Promise<void>(
      resolve => (releaseWrite = resolve),
    );
    const api: MetronomePersistenceApi = {
      readProjectText: async () => current,
      writeProjectText: async (_project, _file, text) => {
        startWrite();
        await writeReleased;
        current = text;
        return true;
      },
      getPreference: async key => preferences.get(key) ?? null,
      setPreference: async (key, value) => {
        preferences.set(key, value);
      },
    };
    const ref = { source: 'phone' as const, dir: 'Song' };
    const mountedStore = new MobileMetronomePersistence(api);

    // The UI may now show `on`: save resolves only after the native preference
    // bridge has synchronously flushed this journal value.
    await mountedStore.save(ref, on);
    await writeStarted;
    expect(
      Object.keys(
        (
          JSON.parse(preferences.get(METRONOME_PHONE_JOURNAL_KEY)!) as {
            entries: object;
          }
        ).entries,
      ),
    ).toContain(JSON.stringify(['phone', 'Song']));

    // React unmounts here and cannot await anything. A fresh process/store
    // still recovers the accepted value without waiting for project.json.
    const coldStore = new MobileMetronomePersistence(api);
    await expect(coldStore.resolve(ref, project(off))).resolves.toMatchObject({
      settings: { metronome: on },
    });
    expect((JSON.parse(current) as ProjectDoc).settings.metronome).toEqual(off);

    releaseWrite();
    await Promise.all([mountedStore.flush(), coldStore.flush()]);
  });

  test('cold resolver reconciles a durable journal into project.json and clears it', async () => {
    const memory = memoryApi(project(off));
    const identity = JSON.stringify(['phone', 'Song']);
    memory.preferences.set(
      METRONOME_PHONE_JOURNAL_KEY,
      JSON.stringify({
        formatVersion: 1,
        entries: {
          [identity]: { revision: 'cold-1', config: on },
        },
      }),
    );
    const ref = { source: 'phone' as const, dir: 'Song' };
    const coldStore = new MobileMetronomePersistence(memory.api);

    await expect(coldStore.resolve(ref, project(off))).resolves.toMatchObject({
      settings: { metronome: on },
    });
    await coldStore.flush();

    expect(memory.getDoc().settings.metronome).toEqual(on);
    expect(
      JSON.parse(memory.preferences.get(METRONOME_PHONE_JOURNAL_KEY)!),
    ).toEqual({ formatVersion: 1, entries: {} });
  });

  test('a phone edit is not accepted when its native journal cannot be flushed', async () => {
    const memory = memoryApi(project(off));
    const api: MetronomePersistenceApi = {
      ...memory.api,
      setPreference: async key => {
        if (key === METRONOME_PHONE_JOURNAL_KEY)
          throw new Error('preferences unavailable');
      },
      delay: async () => undefined,
    };
    const store = new MobileMetronomePersistence(api);
    let visible = off;

    await expect(
      store
        .save({ source: 'phone', dir: 'Song' }, on)
        .then(() => (visible = on)),
    ).rejects.toThrow(/not saved after 3 attempts/);
    expect(visible).toEqual(off);
    expect(memory.writes).toHaveLength(0);
    await expect(store.flush()).rejects.toThrow(/not saved after 3 attempts/);
  });

  test('flush rejects truthfully after bounded retries and a later save recovers', async () => {
    let current = JSON.stringify(project(off));
    let failing = true;
    let writes = 0;
    const delays: number[] = [];
    const api: MetronomePersistenceApi = {
      readProjectText: async () => current,
      writeProjectText: async (_project, _file, text) => {
        writes++;
        if (failing) throw new Error('disk unavailable');
        current = text;
        return true;
      },
      getPreference: async () => null,
      setPreference: async () => undefined,
      delay: async ms => {
        delays.push(ms);
      },
    };
    const store = new MobileMetronomePersistence(api);
    const ref = { source: 'phone' as const, dir: 'Song' };

    store.save(ref, on);
    await expect(store.flush()).rejects.toThrow(/not saved after 3 attempts/);
    expect(writes).toBe(3);
    expect(delays).toHaveLength(2);

    failing = false;
    store.save(ref, on);
    await expect(store.flush()).resolves.toBeUndefined();
    expect((JSON.parse(current) as ProjectDoc).settings.metronome).toEqual(on);
  });

  test('a later save to another project cannot hide an exhausted failure', async () => {
    const docs = new Map([
      ['Broken', JSON.stringify(project(off))],
      ['Healthy', JSON.stringify(project(off))],
    ]);
    let broken = true;
    const api: MetronomePersistenceApi = {
      readProjectText: async dir => docs.get(dir)!,
      writeProjectText: async (dir, _file, text) => {
        if (dir === 'Broken' && broken) throw new Error('disk unavailable');
        docs.set(dir, text);
        return true;
      },
      getPreference: async () => null,
      setPreference: async () => undefined,
      delay: async () => undefined,
    };
    const store = new MobileMetronomePersistence(api);

    store.save({ source: 'phone', dir: 'Broken' }, on);
    await expect(store.flush()).rejects.toThrow(/not saved/);

    store.save({ source: 'phone', dir: 'Healthy' }, on);
    await expect(store.flush()).rejects.toThrow(/not saved/);
    expect(
      (JSON.parse(docs.get('Healthy')!) as ProjectDoc).settings.metronome,
    ).toEqual(on);

    broken = false;
    store.save({ source: 'phone', dir: 'Broken' }, on);
    await expect(store.flush()).resolves.toBeUndefined();
  });

  test.each([
    'not-json',
    JSON.stringify({ formatVersion: 2, entries: {} }),
    JSON.stringify({ formatVersion: 1, entries: { song: { click: 'yes' } } }),
  ])(
    'malformed or future Drive override fails closed without being rewritten: %s',
    async raw => {
      const memory = memoryApi(
        project({ click: true, countInBars: -4, volume: 5, accent: 0 }),
      );
      memory.preferences.set('singz.gdrive.email', 'singer@example.com');
      memory.preferences.set(DRIVE_METRONOME_OVERRIDES_KEY, raw);

      const store = new MobileMetronomePersistence(memory.api);
      const resolved = await store.resolve(
        { source: 'gdrive', dir: 'Song' },
        memory.getDoc(),
      );

      expect(resolved.settings.metronome).toEqual({
        click: true,
        countInBars: 0,
        volume: 1,
        accent: true,
      });
      expect(memory.preferences.get(DRIVE_METRONOME_OVERRIDES_KEY)).toBe(raw);
      await expect(
        store.save({ source: 'gdrive', dir: 'Song' }, on),
      ).rejects.toThrow(/not saved after 3 attempts/);
      expect(memory.api.setPreference).not.toHaveBeenCalled();
      expect(memory.preferences.get(DRIVE_METRONOME_OVERRIDES_KEY)).toBe(raw);
    },
  );

  test.each([
    'not-json',
    JSON.stringify({ formatVersion: 2, entries: {} }),
    JSON.stringify({
      formatVersion: 1,
      entries: {
        [JSON.stringify(['phone', 'Song'])]: {
          revision: 'future-1',
          config: { click: 'yes' },
        },
      },
    }),
  ])(
    'malformed or future phone journal rejects edits without overwriting it: %s',
    async raw => {
      const memory = memoryApi(project(off));
      memory.preferences.set(METRONOME_PHONE_JOURNAL_KEY, raw);
      const store = new MobileMetronomePersistence(memory.api);
      const ref = { source: 'phone' as const, dir: 'Song' };

      await expect(store.resolve(ref, project(off))).resolves.toMatchObject({
        settings: { metronome: off },
      });
      await expect(store.save(ref, on)).rejects.toThrow(
        /not saved after 3 attempts/,
      );

      expect(memory.api.setPreference).not.toHaveBeenCalled();
      expect(memory.writes).toHaveLength(0);
      expect(memory.preferences.get(METRONOME_PHONE_JOURNAL_KEY)).toBe(raw);
    },
  );
});

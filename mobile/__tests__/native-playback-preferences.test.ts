import {
  IOS_NATIVE_PLAYBACK_PREFERENCE_KEY,
  IosNativePlaybackPreferenceStore,
  type PlaybackPreferenceApi,
} from '../src/playback/preferences';

function memoryPreference(initial: string | null = null): {
  readonly api: PlaybackPreferenceApi;
  readonly get: jest.Mock;
  readonly set: jest.Mock;
} {
  let value = initial;
  const get = jest.fn(async () => value);
  const set = jest.fn(async (_key: string, next: string) => {
    value = next;
  });
  return { api: { get, set }, get, set };
}

describe('experimental iOS native playback preference', () => {
  it('is conservative and disabled until explicitly enabled', async () => {
    const memory = memoryPreference();
    const store = new IosNativePlaybackPreferenceStore(memory.api);

    await expect(store.load()).resolves.toEqual({
      formatVersion: 1,
      enabled: false,
    });
    expect(memory.get).toHaveBeenCalledWith(
      IOS_NATIVE_PLAYBACK_PREFERENCE_KEY,
    );
  });

  it('round-trips only its separate strict format-1 document', async () => {
    const memory = memoryPreference();
    const store = new IosNativePlaybackPreferenceStore(memory.api);

    await expect(store.save(true)).resolves.toEqual({
      formatVersion: 1,
      enabled: true,
    });
    expect(memory.set).toHaveBeenCalledWith(
      IOS_NATIVE_PLAYBACK_PREFERENCE_KEY,
      JSON.stringify({ formatVersion: 1, enabled: true }),
    );
    await expect(store.load()).resolves.toEqual({
      formatVersion: 1,
      enabled: true,
    });
  });

  it.each([
    '{"formatVersion":1,"enabled":true,"unknown":1}',
    '{"formatVersion":2,"enabled":true}',
    '{"formatVersion":1,"enabled":"yes"}',
    'not-json',
  ])('fails closed for malformed or future documents: %s', async raw => {
    const store = new IosNativePlaybackPreferenceStore(
      memoryPreference(raw).api,
    );
    await expect(store.load()).resolves.toEqual({
      formatVersion: 1,
      enabled: false,
    });
  });
});

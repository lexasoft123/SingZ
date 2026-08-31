import { getStoredText, setStoredText } from '../latency';

export const IOS_NATIVE_PLAYBACK_PREFERENCE_KEY =
  'singz.playback.ios-native-experimental';

export interface PlaybackPreferenceApi {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export interface IosNativePlaybackPreference {
  readonly formatVersion: 1;
  readonly enabled: boolean;
}

const nativeApi: PlaybackPreferenceApi = {
  get: getStoredText,
  set: setStoredText,
};

/** Separate from the strict app-audio format-1 document. Training persistence
 * rewrites that document as exactly two fields, so putting an experimental
 * backend gate there would let an unrelated reference-volume save erase it. */
export class IosNativePlaybackPreferenceStore {
  constructor(private readonly api: PlaybackPreferenceApi = nativeApi) {}

  async load(): Promise<IosNativePlaybackPreference> {
    const raw = await this.api.get(IOS_NATIVE_PLAYBACK_PREFERENCE_KEY);
    if (raw === null) return defaults();
    try {
      return restore(raw);
    } catch {
      return defaults();
    }
  }

  async save(enabled: boolean): Promise<IosNativePlaybackPreference> {
    const preference: IosNativePlaybackPreference = {
      formatVersion: 1,
      enabled,
    };
    await this.api.set(
      IOS_NATIVE_PLAYBACK_PREFERENCE_KEY,
      JSON.stringify(preference),
    );
    return preference;
  }
}

function defaults(): IosNativePlaybackPreference {
  return { formatVersion: 1, enabled: false };
}

function restore(text: string): IosNativePlaybackPreference {
  if (text.length > 256)
    throw new RangeError('Playback preference is invalid.');
  const raw = JSON.parse(text) as unknown;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new RangeError('Playback preference is invalid.');
  const value = raw as Record<string, unknown>;
  if (
    Object.keys(value).length !== 2 ||
    value.formatVersion !== 1 ||
    typeof value.enabled !== 'boolean'
  )
    throw new RangeError('Unsupported playback preference document.');
  return { formatVersion: 1, enabled: value.enabled };
}

export const iosNativePlaybackPreference =
  new IosNativePlaybackPreferenceStore();

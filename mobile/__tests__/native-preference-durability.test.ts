import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..');
const read = (relative: string): string =>
  readFileSync(join(root, relative), 'utf8');

describe('native preference durability bridge', () => {
  test('iOS rejects when the synchronous UserDefaults flush returns false', () => {
    const bridge = read('ios/FolderAccess/AudioRouteInfo.swift');
    const boundary = read('ios/FolderAccess/DurablePreferenceWrite.swift');
    const podspec = read('ios/FolderAccess/FolderAccess.podspec');

    expect(bridge).toContain(
      'DurablePreferenceWrite.requireFlushed(UserDefaults.standard.synchronize())',
    );
    expect(bridge).toContain(
      'reject("preference_write", error.localizedDescription, error)',
    );
    expect(boundary).toContain(
      'if !flushed { throw DurablePreferenceWriteError.flushFailed }',
    );
    expect(podspec).toContain("'DurablePreferenceWrite.swift'");
    expect(podspec).toContain("s.exclude_files = 'Tests/**/*'");
  });

  test('Android rejects when the synchronous SharedPreferences commit returns false', () => {
    const bridge = read(
      'android/app/src/main/java/com/singzplayer/AudioRouteInfoModule.kt',
    );
    const boundary = read(
      'android/app/src/main/java/com/singzplayer/DurablePreferenceWrite.kt',
    );

    expect(bridge).toMatch(
      /DurablePreferenceWrite\.requireCommitted\([\s\S]{0,160}\.commit\(\)/,
    );
    expect(bridge).toContain(
      'promise.reject("preference_write", e.message ?: "Cannot durably save preference")',
    );
    expect(boundary).toContain(
      'check(committed) { "The preference could not be committed to durable storage." }',
    );
  });

  test('the player accepts a persisted metronome value only after save resolves', () => {
    const player = read('src/ui/PlayerScreen.tsx');
    const start = player.indexOf('const changeMet = useCallback');
    const end = player.indexOf('const [countInSt', start);
    const changeHandler = player.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(changeHandler).toMatch(
      /\.save\(ref, next\)[\s\S]{0,100}\.then\(\(\) => \{[\s\S]{0,160}acceptedMetRef\.current = next[\s\S]{0,100}setMet\(next\)/,
    );
    expect(changeHandler).toMatch(
      /\.catch\(error => \{[\s\S]{0,220}desiredMetRef\.current = acceptedMetRef\.current[\s\S]{0,220}Metronome setting was not saved/,
    );
  });
});

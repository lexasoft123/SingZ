import fs from 'node:fs';
import path from 'node:path';
import bridgeManifest from '../../tests/shared/native-playback-bridge-manifest.json';
import {
  androidBridgeMethods,
  iosBridgeMethods,
} from '../../tests/shared/native-playback-bridge-sources';

// One rule, stated once: the phone playback surface has the same method names
// with the same arity on both platforms.
//
// It is here as its own file because the consequence of breaking it is
// invisible. Pass three arguments to a two-argument RCT_EXPORT_METHOD and the
// bridge declines to dispatch: the promise is neither resolved nor rejected,
// so there is no work, no error and no red box — just an app sitting on its
// main screen looking healthy. That is how `mlGrid` shipped, taking three
// arguments on Android and two on iOS, and it read from outside as "nothing
// happens" at 1.3% CPU with flat memory.
//
// The two packaging suites each compare their own platform against the shared
// manifest. This file compares the two platforms directly, so the rule cannot
// be satisfied by a manifest that drifted along with one of them.

const mobileRoot = path.join(__dirname, '..');
const repositoryRoot = path.join(mobileRoot, '..');
const readMobile = (relative: string): string =>
  fs.readFileSync(path.join(mobileRoot, relative), 'utf8');

describe('native playback bridge arity', () => {
  const bridge = readMobile('ios/FolderAccess/NativeAudioRuntimeBridge.mm');
  const module = readMobile(
    'android/app/src/main/java/com/singzplayer/NativeAudioRuntimeModule.kt',
  );

  // Arity is counted from the selector on one side and the parameter list on
  // the other, in both cases excluding what carries the promise: iOS spells it
  // `resolver:`/`rejecter:`, Kotlin as a trailing `promise: Promise`. What is
  // left is exactly what JavaScript passes.
  const ios = iosBridgeMethods(bridge);
  const android = androidBridgeMethods(module);

  it('exports the same methods with the same arity on both platforms', () => {
    const shared = ios.filter(
      method => !bridgeManifest.methods.iosOnly.some(only => only.name === method.name),
    );
    expect(shared).toEqual(android);
  });

  it('agrees with the manifest, which the two packaging suites also answer to', () => {
    expect(android).toEqual(bridgeManifest.methods.phone);
    // A deliberate literal, and the one assertion here that has to be edited
    // by hand. Everything else compares two extractions, so a method dropped
    // from both bridges AND the manifest in one change would pass all of them;
    // this is what notices the surface shrinking.
    expect(bridgeManifest.methods.phone).toHaveLength(14);
  });

  // A method present on one platform only is allowed, but it has to be
  // declared as such. codecTargetProof is the only one, and it sits behind a
  // compile flag; Android's equivalent lives on SingzCore rather than on this
  // module.
  it('declares every platform-specific method instead of letting it widen the surface', () => {
    const androidNames = new Set(android.map(method => method.name));
    const iosOnly = ios.filter(method => !androidNames.has(method.name));
    expect(iosOnly).toEqual(bridgeManifest.methods.iosOnly);
    expect(bridge).toMatch(
      /#if defined\(SINGZ_CODEC_TARGET_PROOF\)[\s\S]*codecTargetProof[\s\S]*#endif/,
    );
  });

  // The facade is the third party to this agreement: it is what actually calls
  // the methods, so a name it knows that neither bridge exports is a call into
  // nothing.
  it('calls only methods both bridges export', () => {
    const facade = readMobile('src/playback/native.ts');
    const names = new Set(android.map(method => method.name));
    const referenced = [...facade.matchAll(/\bnative\.([a-zA-Z][A-Za-z0-9]*)\s*\(/g)].map(
      match => match[1],
    );
    expect(referenced.length).toBeGreaterThan(0);
    for (const name of new Set(referenced)) expect(names).toContain(name);
  });
});

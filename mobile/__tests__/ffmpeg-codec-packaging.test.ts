import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const mobileRoot = path.join(__dirname, '..');
const repoRoot = path.join(mobileRoot, '..');
const readMobile = (relative: string): string =>
  fs.readFileSync(path.join(mobileRoot, relative), 'utf8');
const readRepo = (relative: string): string =>
  fs.readFileSync(path.join(repoRoot, relative), 'utf8');

const policyModule = pathToFileURL(
  path.join(mobileRoot, 'scripts/ffmpeg-codec-selection-policy.mjs'),
).href;
const policyDriver = `
  import * as policy from ${JSON.stringify(policyModule)};
  try {
    const operation = process.env.SINGZ_POLICY_OPERATION;
    const input = JSON.parse(process.env.SINGZ_POLICY_INPUT || '{}');
    const value = policy[operation](input);
    process.stdout.write(JSON.stringify({ ok: true, value }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: String(error?.message || error) }));
  }
`;

const runPolicy = (operation: string, input: unknown): {
  ok: boolean;
  value?: unknown;
  error?: string;
} => {
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', policyDriver], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      SINGZ_POLICY_OPERATION: operation,
      SINGZ_POLICY_INPUT: JSON.stringify(input),
    },
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout);
};

const productProfile = JSON.parse(readRepo('third_party/ffmpeg-codec/profile.json'));
const symlinkTest = process.platform === 'win32' ? test.skip : test;

const createSelectionFixture = (mode?: 'target-proof-staging' | 'release-proven') => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'singz-mobile-codec-policy-'));
  const dependency = path.join(root, 'mobile/node_modules/react-native-audio-api');
  const receiptPath = path.join(
    dependency,
    'common/cpp/audioapi/external/singz-ffmpeg-selection.json',
  );
  const vendorRoot = path.join(root, 'vendor/ffmpeg-codec');
  const pack = path.join(vendorRoot, 'ios-xcframeworks');
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  fs.mkdirSync(pack, { recursive: true });
  if (mode) {
    fs.writeFileSync(receiptPath, `${JSON.stringify({
      format: 1,
      mode,
      profile: productProfile.profile,
      source: productProfile.source,
      selections: [{
        target: 'ios-xcframeworks',
        pack: 'vendor/ffmpeg-codec/ios-xcframeworks',
      }],
    })}\n`);
  }
  return { root, dependency, vendorRoot, pack };
};

const selectorScript = path.join(mobileRoot, 'scripts/select-ffmpeg-codec-runtime.mjs');

/** A checkout-shaped fixture the selector can be pointed at: the real product
 * profile, a configuration-only Android pack and a fake RNAudioAPI whose
 * compatibility runtime bytes are markers we can prove untouched. */
const createSelectorFixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'singz-codec-selector-'));
  fs.mkdirSync(path.join(root, 'third_party/ffmpeg-codec'), { recursive: true });
  fs.copyFileSync(
    path.join(repoRoot, 'third_party/ffmpeg-codec/profile.json'),
    path.join(root, 'third_party/ffmpeg-codec/profile.json'),
  );
  const dependency = path.join(root, 'mobile/node_modules/react-native-audio-api');
  const jniLibs = path.join(dependency, 'android/src/main/jniLibs/arm64-v8a');
  fs.mkdirSync(jniLibs, { recursive: true });
  fs.mkdirSync(path.join(dependency, 'common/cpp/audioapi/external'), { recursive: true });
  for (const component of ['avcodec', 'avformat', 'avutil', 'swresample']) {
    fs.writeFileSync(path.join(jniLibs, `lib${component}.so`), `compat-${component}`);
  }
  const pack = path.join(root, 'vendor/ffmpeg-codec/android-arm64-v8a');
  fs.mkdirSync(pack, { recursive: true });
  fs.writeFileSync(path.join(pack, 'manifest.json'), `${JSON.stringify({
    format: 1,
    profile: productProfile.profile,
    target: 'android-arm64-v8a',
    source: productProfile.source,
    capabilityMask: productProfile.capabilityMask,
    files: [],
    runtimeLibraries: {},
  })}\n`);
  return {
    root,
    dependency,
    jniLibs,
    receipt: path.join(dependency, 'common/cpp/audioapi/external/singz-ffmpeg-selection.json'),
  };
};

const runSelector = (fixture: { root: string }, args: string[], env: NodeJS.ProcessEnv = {}) => {
  const { SINGZ_FFMPEG_CODECS: _unset, ...inherited } = process.env;
  return spawnSync(process.execPath, [selectorScript, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...inherited, SINGZ_CODEC_SELECTION_ROOT: fixture.root, ...env },
  });
};

describe('FFmpeg codec runtime opt-in', () => {
  test('auto mode leaves a configuration-only pack unselected and the compatibility bytes intact', () => {
    const fixture = createSelectorFixture();
    try {
      const result = runSelector(fixture, ['--require-android-set', 'arm64-v8a']);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('configuration-only pack without target fixture evidence');
      expect(result.stdout).toContain('native decode stays on base WAV/FLAC');
      expect(fs.existsSync(fixture.receipt)).toBe(false);
      expect(fs.readFileSync(path.join(fixture.jniLibs, 'libavcodec.so'), 'utf8')).toBe('compat-avcodec');
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('required mode fails closed on the same pack', () => {
    const fixture = createSelectorFixture();
    try {
      const result = runSelector(fixture, ['--require-android-set', 'arm64-v8a'], {
        SINGZ_FFMPEG_CODECS: 'required',
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('no full fixture decode evidence');
      expect(fs.existsSync(fixture.receipt)).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('off mode never selects and a missing required pack is only an error when required', () => {
    const fixture = createSelectorFixture();
    try {
      const off = runSelector(fixture, ['--require-android-set', 'arm64-v8a'], {
        SINGZ_FFMPEG_CODECS: 'off',
      });
      expect(off.status).toBe(0);
      expect(off.stdout).toContain('SINGZ_FFMPEG_CODECS=off');
      const missingAuto = runSelector(fixture, ['--require-android-set', 'x86_64']);
      expect(missingAuto.status).toBe(0);
      expect(missingAuto.stdout).toContain('no product pack at vendor/ffmpeg-codec/android-x86_64');
      const missingRequired = runSelector(fixture, ['--require-android-set', 'x86_64'], {
        SINGZ_FFMPEG_CODECS: 'required',
      });
      expect(missingRequired.status).not.toBe(0);
      expect(missingRequired.stderr).toContain('Required product Android FFmpeg pack is missing');
      const bogus = runSelector(fixture, [], { SINGZ_FFMPEG_CODECS: 'maybe' });
      expect(bogus.status).not.toBe(0);
      expect(bogus.stderr).toContain('SINGZ_FFMPEG_CODECS must be auto, required or off');
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('deselecting restores the preserved compatibility runtime and drops the receipt', () => {
    const fixture = createSelectorFixture();
    try {
      // Model an earlier selection: the receipt exists, the runtime bytes were
      // replaced, and the originals were preserved beside them.
      const preserved = path.join(fixture.dependency, '.singz-compatibility-runtime');
      const unit = 'android/src/main/jniLibs/arm64-v8a/libavcodec.so';
      fs.mkdirSync(path.dirname(path.join(preserved, unit)), { recursive: true });
      fs.writeFileSync(path.join(preserved, unit), 'compat-avcodec');
      fs.writeFileSync(path.join(preserved, 'units.json'), `${JSON.stringify([unit])}\n`);
      fs.writeFileSync(path.join(fixture.jniLibs, 'libavcodec.so'), 'product-avcodec');
      fs.writeFileSync(fixture.receipt, `${JSON.stringify({
        format: 1, mode: 'release-proven', profile: productProfile.profile,
        source: productProfile.source, selections: [{ target: 'android-arm64-v8a' }],
      })}\n`);

      const result = runSelector(fixture, ['--require-android-set', 'arm64-v8a']);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('restored the react-native-audio-api compatibility runtime');
      expect(fs.existsSync(fixture.receipt)).toBe(false);
      expect(fs.existsSync(preserved)).toBe(false);
      expect(fs.readFileSync(path.join(fixture.jniLibs, 'libavcodec.so'), 'utf8')).toBe('compat-avcodec');

      // Without a preserved copy the selector must not guess: it names the
      // recovery instead of silently leaving replaced bytes behind a missing
      // receipt.
      fs.writeFileSync(fixture.receipt, '{"format":1,"mode":"release-proven"}\n');
      const stranded = runSelector(fixture, ['--require-android-set', 'arm64-v8a']);
      expect(stranded.status).not.toBe(0);
      expect(stranded.stderr).toContain('no preserved compatibility copy exists');
      expect(fs.existsSync(fixture.receipt)).toBe(true);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('full-matrix evidence is required from every slice a pack ships', () => {
    expect(runPolicy('packHasFullMatrixEvidence', {
      target: 'android-arm64-v8a', fixtureEvidence: { fullMatrix: true },
    })).toMatchObject({ ok: true, value: true });
    expect(runPolicy('packHasFullMatrixEvidence', {
      target: 'android-arm64-v8a', fixtureEvidence: { fullMatrix: false },
    })).toMatchObject({ ok: true, value: false });
    expect(runPolicy('packHasFullMatrixEvidence', { target: 'android-arm64-v8a' }))
      .toMatchObject({ ok: true, value: false });
    const slices = (evidence: boolean[]) => Object.fromEntries(
      ['ios-arm64', 'ios-simulator-arm64', 'ios-simulator-x64']
        .map((name, index) => [name, { fullMatrixFixtureEvidence: evidence[index] }]),
    );
    expect(runPolicy('packHasFullMatrixEvidence', {
      target: 'ios-xcframeworks', slices: slices([true, true, true]),
    })).toMatchObject({ ok: true, value: true });
    expect(runPolicy('packHasFullMatrixEvidence', {
      target: 'ios-xcframeworks', slices: slices([true, true, false]),
    })).toMatchObject({ ok: true, value: false });
    expect(runPolicy('codecRuntimeMode', {})).toMatchObject({ ok: true, value: 'auto' });
  });
});

describe('FFmpeg codec product packaging', () => {
  test('ships replaceable dynamic runtimes with pinned provenance', () => {
    const verifier = readMobile('scripts/verify-ffmpeg-codec-runtime.mjs');
    const sums = readRepo('third_party/FFMPEG-SHA256SUMS');
    const notice = readRepo('third_party/NOTICE-FFMPEG.md');
    expect(sums.match(/^[0-9a-f]{64}  /gm)).toHaveLength(28);
    expect(verifier).toContain('FFMPEG-SHA256SUMS');
    expect(verifier).toContain('LIBAVCODEC_VERSION_MAJOR');
    expect(notice).toContain('Corresponding source and replacement instructions');
    expect(notice).toContain('rn-audio-libs/tree/v3.1.0');
    expect(notice).toContain('replace');
  });

  test('accepts compatibility mode only when the isolated dependency has no receipt', () => {
    const fixture = createSelectionFixture();
    try {
      expect(runPolicy('readProductSelectionReceipt', {
        dependency: fixture.dependency,
        profile: productProfile,
        proofStaging: false,
      })).toMatchObject({ ok: true, value: { receipt: null } });
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('accepts an isolated proof-staging receipt and rejects it in release mode', () => {
    const fixture = createSelectionFixture('target-proof-staging');
    try {
      expect(runPolicy('readProductSelectionReceipt', {
        dependency: fixture.dependency,
        profile: productProfile,
        proofStaging: true,
      })).toMatchObject({ ok: true, value: { receipt: { mode: 'target-proof-staging' } } });
      expect(runPolicy('readProductSelectionReceipt', {
        dependency: fixture.dependency,
        profile: productProfile,
        proofStaging: false,
      })).toMatchObject({ ok: false, error: expect.stringMatching(/expected release-proven/) });
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('accepts an isolated release receipt and rejects it in proof-staging mode', () => {
    const fixture = createSelectionFixture('release-proven');
    try {
      expect(runPolicy('readProductSelectionReceipt', {
        dependency: fixture.dependency,
        profile: productProfile,
        proofStaging: false,
      })).toMatchObject({ ok: true, value: { receipt: { mode: 'release-proven' } } });
      expect(runPolicy('readProductSelectionReceipt', {
        dependency: fixture.dependency,
        profile: productProfile,
        proofStaging: true,
      })).toMatchObject({ ok: false, error: expect.stringMatching(/expected target-proof-staging/) });
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  symlinkTest('accepts a real selected pack root and rejects a symlink root escape', () => {
    const fixture = createSelectionFixture('target-proof-staging');
    try {
      expect(runPolicy('resolveProductPackRoot', {
        repo: fixture.root,
        vendorRoot: fixture.vendorRoot,
        selection: { pack: 'vendor/ffmpeg-codec/ios-xcframeworks' },
      })).toEqual({ ok: true, value: fixture.pack });

      fs.rmSync(fixture.pack, { recursive: true, force: true });
      const escaped = path.join(fixture.root, 'outside-pack');
      fs.mkdirSync(escaped);
      fs.symlinkSync(escaped, fixture.pack, 'dir');
      expect(runPolicy('resolveProductPackRoot', {
        repo: fixture.root,
        vendorRoot: fixture.vendorRoot,
        selection: { pack: 'vendor/ffmpeg-codec/ios-xcframeworks' },
      })).toMatchObject({
        ok: false,
        error: expect.stringMatching(/not a real directory/),
      });
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  symlinkTest('rejects a real pack reached through a symlinked ancestor escape', () => {
    const fixture = createSelectionFixture('target-proof-staging');
    try {
      const escapedParent = path.join(fixture.root, 'escaped-parent');
      const escapedPack = path.join(escapedParent, 'ios-xcframeworks');
      fs.mkdirSync(escapedPack, { recursive: true });
      const linkedParent = path.join(fixture.vendorRoot, 'linked-parent');
      fs.symlinkSync(escapedParent, linkedParent, 'dir');
      expect(runPolicy('resolveProductPackRoot', {
        repo: fixture.root,
        vendorRoot: fixture.vendorRoot,
        selection: {
          pack: 'vendor/ffmpeg-codec/linked-parent/ios-xcframeworks',
        },
      })).toMatchObject({
        ok: false,
        error: expect.stringMatching(/escapes the physical product pack root/),
      });
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('defines one pinned complete product profile and immutable pack gates', () => {
    const profile = JSON.parse(readRepo('third_party/ffmpeg-codec/profile.json'));
    const builder = readRepo('scripts/build-ffmpeg-codec-runtime.sh');
    const finalizer = readRepo('scripts/finalize-ffmpeg-codec-runtime.mjs');
    const verifier = readRepo('scripts/verify-ffmpeg-codec-pack.mjs');
    const selector = readMobile('scripts/select-ffmpeg-codec-runtime.mjs');
    expect(profile.source).toMatchObject({
      version: '8.0.1',
      license: 'LGPL-2.1-or-later',
    });
    expect(profile.capabilityMask).toBe('0x000001ff');
    expect(profile.requiredDemuxers).toEqual(['aac', 'aiff', 'mov', 'mp3', 'ogg']);
    expect(profile.requiredDecoders).toEqual(expect.arrayContaining([
      'aac', 'alac', 'flac', 'mp3', 'opus', 'vorbis', 'pcm_s16be', 'pcm_s16le',
    ]));
    expect(builder).toContain('SINGZ_NATIVE_JOBS:-8');
    expect(builder).toContain('--disable-static');
    expect(builder).toContain('--enable-shared');
    expect(finalizer).toContain('fixtureEvidence');
    expect(verifier).toContain('--require-full');
    expect(verifier).toContain('full fixture decode evidence');
    expect(selector).toContain('singz-ffmpeg-selection.json');
    expect(selector).toContain('verify-ffmpeg-ios-xcframeworks.mjs');
    expect(selector).toContain('verify-ffmpeg-codec-pack.mjs');
  });

  test('selects real iOS dynamic frameworks without changing the static Pods graph', () => {
    const composer = readRepo('scripts/compose-ffmpeg-ios-xcframeworks.mjs');
    const verifier = readMobile('scripts/verify-ffmpeg-codec-runtime.mjs');
    const podfile = readMobile('ios/Podfile');
    const audioApiPodspec = readMobile('node_modules/react-native-audio-api/RNAudioAPI.podspec');
    expect(composer).toContain('format: ffmpegFrameworkPackagingFormat');
    expect(composer).toContain('ffmpegFrameworkHeaderContents(component)');
    expect(composer).not.toContain('cpSync(join(headers, name)');
    expect(composer).toContain("'-framework', deviceFramework");
    expect(composer).not.toContain("'-library'");
    expect(verifier).toContain('validateFfmpegFrameworkBytes');
    expect(verifier).toContain('assertExactSelectionTree');
    expect(readMobile('scripts/select-ffmpeg-codec-runtime.mjs'))
      .toContain('assertExactSelectionTree');
    expect(podfile).not.toContain('use_frameworks! :linkage => :dynamic');
    expect(audioApiPodspec).toContain('external_dir_relative}/include_ffmpeg');
  });

  test('puts the notice, license and checksums in both mobile packages', () => {
    const gradle = readMobile('android/app/build.gradle');
    const podspec = readMobile('ios/SingzCore/SingzCore.podspec');
    const sync = readMobile('scripts/sync-singzcore.js');
    for (const name of [
      'NOTICE-FFMPEG.md',
      'COPYING.LGPLv2.1-FFMPEG',
      'FFMPEG-SHA256SUMS',
    ]) {
      expect(gradle).toContain(name);
      expect(sync).toContain(name);
    }
    expect(gradle).toContain('third_party/ffmpeg');
    expect(podspec).toContain("'SingzCoreFfmpegNotices' => 'compliance/*'");
  });

  test('puts the verified desktop codec runtime beside the native addon', () => {
    const builder = readRepo('electron-builder.yml');
    const capture = readRepo('scripts/build-capture-addon.cjs');
    expect(builder.match(/to: open-source-notices\/ffmpeg$/gm)).toHaveLength(2);
    expect(builder.match(/to: open-source-notices\/ffmpeg\/product-profile$/gm)).toHaveLength(2);
    expect(builder).not.toContain('from: vendor/ffmpeg-codec');
    expect(builder).toContain("'ffmpeg/**/*'");
    expect(builder).toContain("'*.dll'");
    expect(capture).toContain("'--require-full'");
    expect(capture).toContain('codecRuntime');
  });
});

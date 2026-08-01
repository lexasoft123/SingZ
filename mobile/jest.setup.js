/**
 * react-native-audio-api throws at import time when its native module is
 * missing, which is always true under jest. Everything audio is verified by
 * driving a real simulator (mobile/tests/*.cjs); here it only has to not
 * explode while the JS around it is under test.
 */
jest.mock('react-native-audio-api', () => ({
  AudioManager: {
    setAudioSessionOptions: jest.fn(),
    setAudioSessionActivity: jest.fn(() => Promise.resolve()),
    setLockScreenInfo: jest.fn(),
    resetLockScreenInfo: jest.fn(),
    enableRemoteCommand: jest.fn(),
    observeAudioInterruptions: jest.fn(),
  },
  AudioContext: jest.fn(() => ({
    createGain: jest.fn(),
    createBufferSource: jest.fn(),
    destination: {},
    close: jest.fn(() => Promise.resolve()),
  })),
  AudioBuffer: jest.fn(),
  GainNode: jest.fn(),
  decodeAudioData: jest.fn(() => Promise.resolve({ length: 0, numberOfChannels: 2 })),
}));

/**
 * App.tsx builds a MultitrackEngine at module scope, and the engine reaches
 * straight through to the native audio graph (worklets, the stretch host).
 * Nothing about that survives jest, and none of it is what a render test is
 * asking about.
 */
jest.mock('./src/engine', () => ({
  MultitrackEngine: jest.fn(() => ({
    duration: 0,
    position: 0,
    playing: false,
    load: jest.fn(() => Promise.resolve()),
    unload: jest.fn(() => Promise.resolve()),
    seek: jest.fn(),
    stop: jest.fn(),
    setRegion: jest.fn(),
  })),
}));

/** The FolderAccess/AudioRouteInfo pods, likewise absent under jest. */
/**
 * Reanimated reaches for its worklets native module at import time, which no
 * jest process has — and its own mock drags the same module in. Stub just the
 * hooks the karaoke sweep uses.
 * How the sweep actually moves is a simulator question (mobile/tests/).
 */
jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: { View },
    useSharedValue: (v) => ({ value: v }),
    useAnimatedStyle: (fn) => fn(),
    useFrameCallback: () => ({ setActive: () => {} }),
  };
});

const { NativeModules } = require('react-native');
NativeModules.FolderAccess ??= {
  getRoot: () => Promise.resolve({ kind: 'documents', path: '/', name: 'On My iPhone' }),
  listProjects: () => Promise.resolve([]),
  cacheUsage: () => Promise.resolve([]),
};
NativeModules.AudioRouteInfo ??= {
  getOutput: () =>
    Promise.resolve({
      outputLatency: 0,
      ioBufferDuration: 0.02,
      portType: 'Speaker',
      portName: 'Speaker',
      portUid: 'test',
    }),
  getPref: () => Promise.resolve(null),
  setPref: () => Promise.resolve(),
  getTextPref: () => Promise.resolve(null),
  setTextPref: () => Promise.resolve(),
};

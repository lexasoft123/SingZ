module.exports = {
  preset: '@react-native/jest-preset',
  setupFiles: ['<rootDir>/jest.setup.js'],
  // the bundled sample's stems and the background art are Metro assets
  moduleNameMapper: {
    '\\.(flac|wav|mp3|png|jpg|jpeg|gif|webp|ttf|otf)$': '<rootDir>/jest.asset.js',
    // @singz/ui publishes import-only conditional exports. Metro consumes
    // those directly, but Jest 29 resolves this CommonJS test graph through
    // the `require` condition and therefore cannot see the package subpaths.
    // Point tests at the same published artifacts Metro bundles.
    '^@singz/ui/stems$': '<rootDir>/node_modules/@singz/ui/dist/tokens/stems.js',
    '^@singz/ui/tokens$': '<rootDir>/node_modules/@singz/ui/dist/tokens/tokens.js',
    '^@singz/ui/native$': '<rootDir>/node_modules/@singz/ui/dist/native/index.js',
    // Test helpers shared with the desktop suite live outside this root
    // (tests/shared/), and babel's transpiled output requires @babel/runtime
    // from *there* — where there is no node_modules. Point it back here.
    '^@babel/runtime/(.*)$': '<rootDir>/node_modules/@babel/runtime/$1',
  },
  // Our RN dependencies ship untranspiled ESM in lib/module; the preset's
  // pattern only exempts react-native itself, so jest chokes on the first
  // `export *` it meets.
  transformIgnorePatterns: [
    'node_modules/(?!(?:@react-native|react-native|react-native-audio-api' +
      '|@react-navigation' +
      '|@singz/ui' +
      '|react-native-reanimated|react-native-worklets|react-native-gesture-handler' +
      '|react-native-safe-area-context|react-native-screens)/)',
  ],
};

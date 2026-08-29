module.exports = {
  preset: '@react-native/jest-preset',
  setupFiles: ['<rootDir>/jest.setup.js'],
  // the bundled sample's stems and the background art are Metro assets
  moduleNameMapper: {
    '\\.(flac|wav|mp3|png|jpg|jpeg|gif|webp|ttf|otf)$': '<rootDir>/jest.asset.js',
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
      '|@react-navigation|@singz/ui' +
      '|react-native-reanimated|react-native-worklets|react-native-gesture-handler' +
      '|react-native-safe-area-context|react-native-screens)/)',
  ],
  // @singz/ui ships ESM-only subpath exports and jest resolves as CommonJS;
  // jest.resolver.js explains why that needs a resolver rather than a
  // condition or a path mapper. The transformIgnorePatterns entry above is the
  // other half — once found, the ESM still has to be transformed.
  resolver: '<rootDir>/jest.resolver.js',
};

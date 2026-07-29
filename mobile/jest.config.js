module.exports = {
  preset: '@react-native/jest-preset',
  setupFiles: ['<rootDir>/jest.setup.js'],
  // the bundled sample's stems and the background art are Metro assets
  moduleNameMapper: {
    '\\.(flac|wav|mp3|png|jpg|jpeg|gif|webp)$': '<rootDir>/jest.asset.js',
  },
  // Our RN dependencies ship untranspiled ESM in lib/module; the preset's
  // pattern only exempts react-native itself, so jest chokes on the first
  // `export *` it meets.
  transformIgnorePatterns: [
    'node_modules/(?!(?:@react-native|react-native|react-native-audio-api' +
      '|react-native-reanimated|react-native-worklets|react-native-gesture-handler' +
      '|react-native-safe-area-context)/)',
  ],
};

const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
const { resolve } = require('node:path');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const defaults = getDefaultConfig(__dirname);

/** FLAC stems from desktop-prepared projects ship as bundled assets. */
const config = {
  // The portable metadata parser is shared directly with desktop. Expose only
  // this dependency-free source directory, not the repo's second React install.
  watchFolders: [resolve(__dirname, '../src/shared')],
  resolver: {
    assetExts: [...defaults.resolver.assetExts, 'flac'],
  },
};

module.exports = mergeConfig(defaults, config);

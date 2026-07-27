const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const defaults = getDefaultConfig(__dirname);

/** FLAC stems from desktop-prepared projects ship as bundled assets. */
const config = {
  resolver: {
    assetExts: [...defaults.resolver.assetExts, 'flac'],
  },
};

module.exports = mergeConfig(defaults, config);

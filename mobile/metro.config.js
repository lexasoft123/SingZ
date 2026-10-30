const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
const { resolve } = require('node:path');
const { FileStore } = require('metro-cache');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const defaults = getDefaultConfig(__dirname);

/** FLAC stems from desktop-prepared projects ship as bundled assets. */
const config = {
  ...(process.env.SINGZ_METRO_CACHE_DIR ? {
    cacheStores: [new FileStore({ root: resolve(process.env.SINGZ_METRO_CACHE_DIR) })],
  } : {}),
  // Portable policies and metadata are shared directly with desktop. Expose only
  // this dependency-free source directory, not the repo's second React install.
  watchFolders: [resolve(__dirname, '../src/shared')],
  resolver: {
    // Shared TS may use Babel helpers; resolve those from the phone's runtime.
    nodeModulesPaths: [resolve(__dirname, 'node_modules')],
    assetExts: [...defaults.resolver.assetExts, 'flac'],
  },
  transformer: {
    // Metro hashes this dependency name into every transform key. RN's
    // absolute default prevents cache hits in an otherwise identical worktree.
    asyncRequireModulePath: 'metro-runtime/src/modules/asyncRequire',
  },
};

module.exports = mergeConfig(defaults, config);

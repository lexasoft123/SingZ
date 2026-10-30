const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const os = require('node:os')
const { test } = require('node:test')

const mobile = path.resolve(__dirname, '../..')
const configFile = process.env.SINGZ_TEST_METRO_CONFIG || path.join(mobile, 'metro.config.js')
let reactNativeConfig, transformCacheKey, worker
if (fs.existsSync(path.join(mobile, 'node_modules/metro/package.json'))) {
  reactNativeConfig = require('@react-native/metro-config')
  transformCacheKey = require(path.join(mobile, 'node_modules/metro/src/DeltaBundler/getTransformCacheKey.js')).default
  worker = require('metro-transform-worker')
}
const available = { skip: !worker ? 'Install mobile dependencies to exercise Metro cache keys and dynamic imports' : false }

function configForRoot(root, env = {}) {
  // Preserve actual installed Metro defaults, with the absolute dependency
  // path RN would generate for each checkout. Evaluate the real app config.
  const defaults = reactNativeConfig.getDefaultConfig(root)
  defaults.transformer.asyncRequireModulePath = path.join(root, 'node_modules/metro-runtime/src/modules/asyncRequire.js')
  const context = {
    __dirname: root,
    module: { exports: {} },
    process: { env },
    require: name => name === '@react-native/metro-config'
      ? { getDefaultConfig: () => defaults, mergeConfig: reactNativeConfig.mergeConfig }
      : require(name),
  }
  vm.runInNewContext(fs.readFileSync(configFile, 'utf8'), context, { filename: configFile })
  return context.module.exports
}
function key(config) {
  const { getTransformOptions, transformVariants, unstable_workerThreads, ...transformerConfig } = config.transformer
  return transformCacheKey({
    projectRoot: config.projectRoot,
    cacheVersion: config.cacheVersion,
    transformerConfig: { transformerPath: config.transformerPath, transformerConfig },
  })
}

test('CI Metro storage survives a fresh checkout without changing transform identity', available, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'singz-ci-metro-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const env = { SINGZ_METRO_CACHE_DIR: path.join(directory, 'persisted-store') }
  const first = configForRoot(path.join(directory, 'checkout-a'), env)
  const second = configForRoot(path.join(directory, 'checkout-b'), env)
  const cacheKey = Buffer.from('0123456789abcdef', 'hex'), value = { code: 'transformed output' }
  await first.cacheStores[0].set(cacheKey, value)
  assert.deepEqual(await second.cacheStores[0].get(cacheKey), value)
  assert.equal(key(first), key(second))
  assert.equal(key(first), key(configForRoot(path.join(directory, 'checkout-a'))), 'storage location is not a transform input')
})

test('identical Metro transforms keep the same actual global key across checkout roots', available, () => {
  const first = configForRoot(path.join(mobile, 'first-checkout'))
  const second = configForRoot(path.join(mobile, 'second-checkout'))
  assert.equal(key(first), key(second))
  second.transformer.inlineRequires = !second.transformer.inlineRequires
  assert.notEqual(key(first), key(second), 'real transform policy changes must still invalidate the cache')
})

for (const platform of ['android', 'ios']) test(`portable async runtime still transforms and resolves ${platform} dynamic imports through Metro`, available, async () => {
  const config = configForRoot(mobile)
  const runtime = config.transformer.asyncRequireModulePath
  const transformed = await worker.transform(config.transformer, mobile, 'cache-control.js',
    Buffer.from('export const load = () => import("./cache-target");'), {
      dev: false, minify: true, inlinePlatform: true, inlineRequires: true,
      platform, type: 'module', unstable_transformProfile: 'default',
    })
  assert.ok(transformed.dependencies.some(dependency => dependency.name === runtime))
  assert.ok(transformed.dependencies.some(dependency => dependency.name === './cache-target'))
  assert.equal(require.resolve(runtime, { paths: [mobile] }),
    path.join(mobile, 'node_modules/metro-runtime/src/modules/asyncRequire.js'))
  assert.ok(!path.isAbsolute(runtime), 'cached dependency requests must resolve in the consuming checkout')
})

import { app } from 'electron'
import { mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  PRODUCT_IDENTITIES,
  productIdentityFromPackage,
  type ProductIdentity
} from '../shared/product-identity'
import { requestedRendererSurface } from './launch-surface'
import { configureBoxAudioHostProfile } from './box-audio/profile'

function packagedProductIdentity(): ProductIdentity {
  try {
    const metadata: unknown = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8'))
    return productIdentityFromPackage(metadata)
  } catch {
    return 'desktop'
  }
}

function configureProductIdentity(argv: readonly string[], env: NodeJS.ProcessEnv): ProductIdentity {
  const product = requestedRendererSurface(argv, env, packagedProductIdentity())
  const identity = PRODUCT_IDENTITIES[product]
  if (product === 'box') {
    env.SINGZ_SURFACE = 'box'
    app.setName(identity.name)
    if (process.platform === 'linux') app.setDesktopName(identity.desktopName)
    if (process.platform === 'win32') app.setAppUserModelId(identity.appId)

    const userData = env.SINGZ_USERDATA_DIR
      ? resolve(env.SINGZ_USERDATA_DIR)
      : join(app.getPath('appData'), identity.profileDir)
    mkdirSync(userData, { recursive: true, mode: 0o700 })
    app.setPath('userData', userData)
    app.setPath('sessionData', userData)
  } else if (env.SINGZ_USERDATA_DIR) {
    app.setPath('userData', resolve(env.SINGZ_USERDATA_DIR))
  }
  return product
}

export async function bootstrap(): Promise<void> {
  if (process.argv.includes('--box-audio-host')) {
    const authority = configureBoxAudioHostProfile(app, process.env)
    if (!authority) {
      app.exit(0)
      return
    }
    // Electron emits ready after the initial ESM evaluation completes. Awaiting
    // the host here would deadlock that evaluation on its own whenReady call.
    void app.whenReady().then(async () => {
      const { runBoxAudioHost } = await import('./box-audio/entry')
      await runBoxAudioHost(authority)
    }).catch(error => {
      console.error('Box audio host startup failed:', error)
      app.exit(1)
    })
    return
  }
  configureProductIdentity(process.argv, process.env)
  await import('./index')
}

await bootstrap()

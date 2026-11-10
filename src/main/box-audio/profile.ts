import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { App } from 'electron'

type HostIdentityApp = Pick<App, 'setName' | 'getPath' | 'setPath' | 'requestSingleInstanceLock' | 'hasSingleInstanceLock'>
declare const hostAuthorityBrand: unique symbol
export type BoxAudioHostAuthority = { readonly [hostAuthorityBrand]: true }
const authorities = new WeakMap<object, { app: HostIdentityApp; profile: string }>()
/** Lock the isolated service profile before importing or initializing audio. */
export function configureBoxAudioHostProfile(app: HostIdentityApp, env: NodeJS.ProcessEnv): BoxAudioHostAuthority | null {
  env.SINGZ_SURFACE = 'box'
  app.setName('SingZ Box Audio')
  const serviceData = env.SINGZ_BOX_AUDIO_DATA_DIR
    ? resolve(env.SINGZ_BOX_AUDIO_DATA_DIR)
    : join(app.getPath('appData'), 'SingZ Box Audio')
  mkdirSync(serviceData, { recursive: true, mode: 0o700 })
  app.setPath('userData', serviceData)
  app.setPath('sessionData', serviceData)
  env.SINGZ_MODELS_DIR ??= join(serviceData, 'models')
  env.SINGZ_PACK_DIR ??= join(serviceData, 'gpu-splitter')
  // Electron scopes its process singleton to userData. Different socket paths
  // cannot create two hardware owners for this same routing-state profile.
  if (!app.requestSingleInstanceLock()) return null
  const authority = Object.freeze({}) as BoxAudioHostAuthority
  authorities.set(authority, { app, profile: serviceData })
  return authority
}

/** The capability is process-local and cannot be serialized, forged or enabled
 * by environment variables. Recheck the actual process role and profile lock at
 * each native load, including loads after asynchronous app readiness. */
export function withBoxAudioHostAuthority<T>(authority: unknown, load: () => T): T {
  const record = authority && typeof authority === 'object' ? authorities.get(authority) : undefined
  if (process.type !== 'browser' || !process.argv.includes('--box-audio-host') || !record ||
      !record.app.hasSingleInstanceLock() || record.app.getPath('userData') !== record.profile ||
      record.app.getPath('sessionData') !== record.profile)
    throw new Error('Native Box audio requires the isolated headless host profile authority')
  return load()
}

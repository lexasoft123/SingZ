import * as Electron from 'electron'

/** Namespace import is safe in a utility process; main-only exports are read
 * only on the main-process branch. */
export const audioApp: Pick<Electron.App, 'isPackaged'> = process.env.SINGZ_AUDIO_PROCESS === '1' && Boolean(process.parentPort)
  ? { isPackaged: process.env.SINGZ_AUDIO_PACKAGED === '1' }
  : Electron.app

export const audioResourcesPath = process.parentPort && process.env.SINGZ_AUDIO_PROCESS === '1'
  ? process.env.SINGZ_AUDIO_RESOURCES_PATH || process.resourcesPath
  : process.resourcesPath

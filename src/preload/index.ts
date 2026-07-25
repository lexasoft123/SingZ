import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { SeparationProgress, SingzApi } from '../shared/types'

const api: SingzApi = {
  pathForFile: (file) => webUtils.getPathForFile(file),

  readAudio: (path) => ipcRenderer.invoke('media:read', path),

  registerSource: (path) => ipcRenderer.invoke('source:register', path),

  checkEngine: (force) => ipcRenderer.invoke('engine:check', force),

  separate: (path) => ipcRenderer.invoke('separation:start', path),

  cancelSeparation: () => ipcRenderer.invoke('separation:cancel'),

  revealInFolder: (path) => ipcRenderer.invoke('stems:reveal', path),

  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  onSeparationProgress: (cb) => {
    const listener = (_e: IpcRendererEvent, p: SeparationProgress): void => cb(p)
    ipcRenderer.on('separation:progress', listener)
    return () => {
      ipcRenderer.removeListener('separation:progress', listener)
    }
  }
}

contextBridge.exposeInMainWorld('singz', api)

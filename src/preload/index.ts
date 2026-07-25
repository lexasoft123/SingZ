import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type {
  LogEntry,
  LyricsProgress,
  ModelsProgress,
  SeparationProgress,
  SingzApi
} from '../shared/types'

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
  },

  getLyrics: (songPath, durationSec, allowDownload, prefer) =>
    ipcRenderer.invoke('lyrics:get', songPath, durationSec, Boolean(allowDownload), prefer ?? 'auto'),

  searchLyrics: (query, durationSec) => ipcRenderer.invoke('lyrics:search', query, durationSec),

  applyLyrics: (songPath, id, durationSec) =>
    ipcRenderer.invoke('lyrics:apply', songPath, id, durationSec),

  cancelLyrics: () => ipcRenderer.invoke('lyrics:cancel'),

  onLyricsProgress: (cb) => {
    const listener = (_e: IpcRendererEvent, p: LyricsProgress): void => cb(p)
    ipcRenderer.on('lyrics:progress', listener)
    return () => {
      ipcRenderer.removeListener('lyrics:progress', listener)
    }
  },

  askMicAccess: () => ipcRenderer.invoke('mic:ask'),

  modelsStatus: () => ipcRenderer.invoke('models:status'),

  downloadModels: (ids) => ipcRenderer.invoke('models:download', ids),

  cancelModels: () => ipcRenderer.invoke('models:cancel'),

  onModelsProgress: (cb) => {
    const listener = (_e: IpcRendererEvent, p: ModelsProgress): void => cb(p)
    ipcRenderer.on('models:progress', listener)
    return () => {
      ipcRenderer.removeListener('models:progress', listener)
    }
  },

  provideSplitInput: (songPath, ch0, ch1) =>
    ipcRenderer.invoke('separation:provide-input', songPath, ch0, ch1),

  getLog: () => ipcRenderer.invoke('log:all'),

  saveLog: (path) => ipcRenderer.invoke('log:save', path),

  onLogLine: (cb) => {
    const listener = (_e: IpcRendererEvent, entry: LogEntry): void => cb(entry)
    ipcRenderer.on('log:line', listener)
    return () => {
      ipcRenderer.removeListener('log:line', listener)
    }
  },

  saveProject: (songPath, name, settings) =>
    ipcRenderer.invoke('project:save', songPath, name, settings)
}

contextBridge.exposeInMainWorld('singz', api)

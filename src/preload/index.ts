import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type {
  LogEntry,
  LyricsProgress,
  ModelsProgress,
  SeparationProgress,
  SingzApi,
  SyncStatus
} from '../shared/types'

const api: SingzApi = {
  pathForFile: (file) => webUtils.getPathForFile(file),

  getSplitterMode: () => ipcRenderer.invoke('splitter:mode'),
  setSplitterMode: (mode) => ipcRenderer.invoke('splitter:set-mode', mode),

  updateStateNow: () => ipcRenderer.invoke('update:state'),
  installUpdate: () => ipcRenderer.send('update:install'),
  onUpdateState: (cb) => {
    const listener = (_e: IpcRendererEvent, s: import('../shared/types').UpdateState): void => cb(s)
    ipcRenderer.on('update:state', listener)
    return () => {
      ipcRenderer.removeListener('update:state', listener)
    }
  },

  winMinimize: () => ipcRenderer.send('win:minimize'),
  winMaximizeToggle: () => ipcRenderer.send('win:maximize-toggle'),
  winClose: () => ipcRenderer.send('win:close'),
  winIsMaximized: () => ipcRenderer.invoke('win:is-maximized'),
  onWinMaximized: (cb) => {
    const listener = (_e: IpcRendererEvent, v: boolean): void => cb(v)
    ipcRenderer.on('win:maximized', listener)
    return () => {
      ipcRenderer.removeListener('win:maximized', listener)
    }
  },

  readAudio: (path) => ipcRenderer.invoke('media:read', path),

  registerSource: (path) => ipcRenderer.invoke('source:register', path),

  registerTrack: (path) => ipcRenderer.invoke('track:register', path),

  checkEngine: (force) => ipcRenderer.invoke('engine:check', force),

  separate: (path) => ipcRenderer.invoke('separation:start', path),

  cancelSeparation: () => ipcRenderer.invoke('separation:cancel'),

  beatsMlAvailable: () => ipcRenderer.invoke('beats:mlAvailable'),
  melodyNativeAvailable: () => ipcRenderer.invoke('melody:available'),
  trackMelodyNative: (path) => ipcRenderer.invoke('melody:track', path),
  cancelAnalyzeNative: () => ipcRenderer.invoke('melody:cancel'),
  detectKeyNative: (inst, bass) => ipcRenderer.invoke('key:detect', inst, bass),
  detectBeatsNative: (input) => ipcRenderer.invoke('beats:detect', input),
  onMelodyNativeProgress: (cb) => {
    const listener = (_e: IpcRendererEvent, p: number): void => cb(p)
    ipcRenderer.on('melody:progress', listener)
    return () => {
      ipcRenderer.removeListener('melody:progress', listener)
    }
  },

  beatsMlDetect: (pcm, sr) => ipcRenderer.invoke('beats:mlDetect', pcm, sr),

  revealInFolder: (path) => ipcRenderer.invoke('stems:reveal', path),

  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  onSeparationProgress: (cb) => {
    const listener = (_e: IpcRendererEvent, p: SeparationProgress): void => cb(p)
    ipcRenderer.on('separation:progress', listener)
    return () => {
      ipcRenderer.removeListener('separation:progress', listener)
    }
  },

  onBeatsProgress: (cb) => {
    const listener = (_e: IpcRendererEvent, p: number): void => cb(p)
    ipcRenderer.on('beats:progress', listener)
    return () => {
      ipcRenderer.removeListener('beats:progress', listener)
    }
  },

  getLyrics: (songPath, durationSec, allowDownload, prefer) =>
    ipcRenderer.invoke('lyrics:get', songPath, durationSec, Boolean(allowDownload), prefer ?? 'auto'),

  alignCaps: () => ipcRenderer.invoke('lyrics:align-caps'),

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

  appVersion: () => ipcRenderer.invoke('app:version'),

  saveProject: (songPath, name, settings) =>
    ipcRenderer.invoke('project:save', songPath, name, settings),

  listProjects: () => ipcRenderer.invoke('projects:list'),

  renameProject: (songPath, newName) => ipcRenderer.invoke('project:rename', songPath, newName),

  deleteProject: (dir) => ipcRenderer.invoke('project:delete', dir),

  importProject: (songPath, mode) => ipcRenderer.invoke('project:import', songPath, mode),

  upgradeProject: (dir) => ipcRenderer.invoke('project:upgrade', dir),
  getStorage: () => ipcRenderer.invoke('projects:storage'),
  setProjectsRoot: (path) => ipcRenderer.invoke('projects:set-root', path),
  chooseProjectsRoot: () => ipcRenderer.invoke('projects:choose-root'),

  gdriveStatus: () => ipcRenderer.invoke('gdrive:status'),
  gdriveSignIn: () => ipcRenderer.invoke('gdrive:signin'),
  gdriveSignOut: () => ipcRenderer.invoke('gdrive:signout'),
  gdriveSync: () => ipcRenderer.invoke('gdrive:sync'),
  onGdriveState: (cb) => {
    const listener = (_e: IpcRendererEvent, s: SyncStatus): void => cb(s)
    ipcRenderer.on('gdrive:state', listener)
    return () => ipcRenderer.removeListener('gdrive:state', listener)
  },
  onGdriveProgress: (cb) => {
    const listener = (_e: IpcRendererEvent, p: { msg: string; frac: number }): void => cb(p)
    ipcRenderer.on('gdrive:progress', listener)
    return () => ipcRenderer.removeListener('gdrive:progress', listener)
  }
}

contextBridge.exposeInMainWorld('singz', api)

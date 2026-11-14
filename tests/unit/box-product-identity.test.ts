import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { modelsDir, packDir } from '../../src/main/models'
import {
  getStorage,
  listCloudRoots,
  migrateProjects,
  projectsRoot,
  setProjectsRoot
} from '../../src/main/projects'
import { readSettings, writeSettings } from '../../src/main/settings'
import { requestedRendererSurface } from '../../src/main/launch-surface'
import {
  PRODUCT_IDENTITIES,
  productIdentityFromPackage,
  productProfileDir
} from '../../src/shared/product-identity'

const electron = vi.hoisted(() => {
  const state = {
    root: '',
    name: 'Electron-chosen',
    paths: new Map<string, string>(),
    events: [] as string[],
    importSurface: undefined as string | undefined,
    importProfileReady: false
  }
  const app = {
    getAppPath: () => state.root,
    getPath: (name: string) => state.paths.get(name) ?? join(state.root, name),
    getVersion: () => '0.0.0-test',
    getName: () => state.name,
    setName: (name: string) => {
      state.name = name
      state.events.push(`name:${name}`)
    },
    setPath: (name: string, path: string) => {
      state.paths.set(name, path)
      state.events.push(`path:${name}:${path}`)
    },
    setDesktopName: (name: string) => state.events.push(`desktop:${name}`),
    setAppUserModelId: (id: string) => state.events.push(`appId:${id}`)
  }
  return { state, app }
})

vi.mock('electron', () => ({
  app: electron.app,
  net: { fetch: vi.fn() },
  dialog: {},
  shell: {},
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: class {
    static getAllWindows(): unknown[] {
      return []
    }
  }
}))

const originalArgv = process.argv
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const envNames = [
  'SINGZ_SURFACE',
  'SINGZ_USERDATA_DIR',
  'SINGZ_MODELS_DIR',
  'SINGZ_PACK_DIR',
  'OneDrive'
] as const
const originalEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]))

function path(name: string): string {
  return electron.app.getPath(name)
}

function writePackage(metadata: unknown): void {
  writeFileSync(join(electron.state.root, 'package.json'), JSON.stringify(metadata))
}

async function loadBootstrap(): Promise<void> {
  vi.resetModules()
  // resetModules does not re-run a cached vi.mock factory. Re-register it so
  // every launch observes the paths at the moment main is first imported.
  vi.doMock('../../src/main/index', async () => {
    const { existsSync } = await import('node:fs')
    electron.state.importSurface = process.env.SINGZ_SURFACE
    const userData = electron.state.paths.get('userData')
    electron.state.importProfileReady = Boolean(userData && existsSync(userData))
    electron.state.events.push(
      `import:${electron.state.name}:${userData ?? 'unset'}:${electron.state.paths.get('sessionData') ?? 'unset'}`
    )
    return {}
  })
  await import('../../src/main/bootstrap')
}

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  const root = mkdtempSync(join(tmpdir(), 'singz-box-identity-'))
  electron.state.root = root
  electron.state.name = 'Electron-chosen'
  electron.state.paths.clear()
  electron.state.events.length = 0
  electron.state.importSurface = undefined
  electron.state.importProfileReady = false
  for (const name of ['appData', 'documents', 'music', 'home', 'userData']) {
    const dir = join(root, name)
    electron.state.paths.set(name, dir)
    mkdirSync(dir, { recursive: true })
  }
  process.argv = ['electron', '.']
  for (const name of envNames) delete process.env[name]
})

afterEach(() => {
  process.argv = originalArgv
  Object.defineProperty(process, 'platform', originalPlatform)
  for (const name of envNames) {
    const value = originalEnv[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  rmSync(electron.state.root, { recursive: true, force: true })
})

describe('product identity and launch selection', () => {
  it('pins Box metadata and validates missing or unknown products as Desktop', () => {
    expect(PRODUCT_IDENTITIES.box).toEqual({
      appId: 'com.lexasoft.singz.box',
      name: 'SingZ Box',
      profileDir: 'SingZ Box',
      executable: 'singz-box',
      desktopName: 'singz-box.desktop'
    })
    expect(productIdentityFromPackage({ singzProduct: 'box' })).toBe('box')
    for (const metadata of [null, [], 'box', {}, { singzProduct: 'desktop' }, { singzProduct: 'future' }]) {
      expect(productIdentityFromPackage(metadata)).toBe('desktop')
    }
    expect(productProfileDir(undefined)).toBe('SingZ')
    expect(productProfileDir('box')).toBe('SingZ Box')
  })

  it('negative control: packaged Box wins without --box and cannot be forced to Desktop', () => {
    expect(requestedRendererSurface(['electron', '.'], {}, 'box')).toBe('box')
    expect(requestedRendererSurface(['electron', '.'], { SINGZ_SURFACE: 'desktop' }, 'box')).toBe('box')
    expect(requestedRendererSurface(['electron', '.'], {}, 'desktop')).toBe('desktop')
  })
})

describe('early bootstrap identity and profile setup', () => {
  it('auto-selects packaged Box and finishes its private profile before the main import', async () => {
    writePackage({ singzProduct: 'box' })
    process.env.SINGZ_SURFACE = 'desktop'
    const desktopSettings = join(path('userData'), 'settings.json')
    writeFileSync(desktopSettings, JSON.stringify({ gdrive: { access: 'desktop-only' } }))
    writeFileSync(join(path('userData'), 'history.json'), 'desktop history')

    await loadBootstrap()

    const profile = join(path('appData'), 'SingZ Box')
    expect(process.env.SINGZ_SURFACE).toBe('box')
    expect(electron.state.importSurface).toBe('box')
    expect(electron.app.getName()).toBe('SingZ Box')
    expect(path('userData')).toBe(profile)
    expect(path('sessionData')).toBe(profile)
    expect(existsSync(profile)).toBe(true)
    expect(electron.state.importProfileReady).toBe(true)
    expect(electron.state.events).toEqual([
      'name:SingZ Box',
      `path:userData:${profile}`,
      `path:sessionData:${profile}`,
      `import:SingZ Box:${profile}:${profile}`
    ])
    expect(readSettings()).toEqual({})
    expect(existsSync(join(profile, 'history.json'))).toBe(false)
    expect(JSON.parse(readFileSync(desktopSettings, 'utf8'))).toEqual({ gdrive: { access: 'desktop-only' } })
  })

  it.each(['darwin', 'linux', 'win32'])('sets the Desktop profile before main imports on %s', async platform => {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true })
    writePackage({ singzProduct: 'desktop' })
    const userData = join(path('appData'), 'SingZ')

    await loadBootstrap()

    expect(electron.app.getName()).toBe('Electron-chosen')
    expect(path('userData')).toBe(userData)
    expect(process.env.SINGZ_SURFACE).toBeUndefined()
    expect(path('sessionData')).toBe(userData)
    expect(electron.state.importProfileReady).toBe(true)
    expect(electron.state.events).toEqual([
      `path:userData:${userData}`,
      `path:sessionData:${userData}`,
      `import:Electron-chosen:${userData}:${userData}`
    ])
    expect(modelsDir()).toBe(join(userData, 'models'))
    expect(packDir()).toBe(join(userData, 'gpu-splitter'))
  })

  it('keeps --box as a development selector and honors the explicit test profile override', async () => {
    writePackage({ singzProduct: 'desktop' })
    process.argv = ['electron', '.', '--box']
    const override = join(electron.state.root, 'explicit test profile')
    process.env.SINGZ_USERDATA_DIR = override

    await loadBootstrap()

    expect(path('userData')).toBe(override)
    expect(path('sessionData')).toBe(override)
    expect(existsSync(override)).toBe(true)
    expect(existsSync(join(path('appData'), 'SingZ Box'))).toBe(false)
  })

  it('makes legacy settings and recordings available at the canonical path before main imports', async () => {
    writePackage({ singzProduct: 'desktop' })
    const legacy = join(path('appData'), 'singz')
    mkdirSync(join(legacy, 'voice-takes'), { recursive: true })
    writeFileSync(join(legacy, 'settings.json'), JSON.stringify({ language: 'ru' }))
    writeFileSync(join(legacy, 'voice-takes', 'take.wav'), 'private recording')

    await loadBootstrap()

    const canonical = join(path('appData'), 'SingZ')
    expect(path('userData')).toBe(canonical)
    expect(path('sessionData')).toBe(canonical)
    expect(electron.state.importProfileReady).toBe(true)
    expect(readSettings()).toEqual({ language: 'ru' })
    expect(readFileSync(join(canonical, 'voice-takes', 'take.wav'), 'utf8')).toBe('private recording')
  })

  it('preserves the explicit Desktop test profile override', async () => {
    writePackage({ singzProduct: 'desktop' })
    const override = join(electron.state.root, 'desktop test profile')
    process.env.SINGZ_USERDATA_DIR = override
    const legacy = join(path('appData'), 'singz')
    mkdirSync(legacy)
    writeFileSync(join(legacy, 'settings.json'), 'legacy settings')

    await loadBootstrap()

    expect(path('userData')).toBe(override)
    expect(electron.app.getName()).toBe('Electron-chosen')
    expect(path('sessionData')).toBe(override)
    expect(electron.state.importProfileReady).toBe(true)
    expect(readFileSync(join(legacy, 'settings.json'), 'utf8')).toBe('legacy settings')
    expect(existsSync(join(override, 'settings.json'))).toBe(false)
    expect(process.env.SINGZ_SURFACE).toBeUndefined()
  })

  it('sets platform launch identity only where the OS uses it', async () => {
    writePackage({ singzProduct: 'box' })
    for (const platform of ['linux', 'win32']) {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true })
      electron.state.events.length = 0
      await loadBootstrap()
      const expected = platform === 'linux'
        ? 'desktop:singz-box.desktop'
        : 'appId:com.lexasoft.singz.box'
      expect(electron.state.events).toContain(expected)
    }
  })
})

describe('product-local mutable paths', () => {
  it('isolates Box models and packs, preserves Desktop, and keeps explicit overrides', () => {
    process.env.SINGZ_SURFACE = 'box'
    expect(modelsDir()).toBe(join(path('appData'), 'SingZ Box', 'models'))
    expect(packDir()).toBe(join(path('appData'), 'SingZ Box', 'gpu-splitter'))
    expect(modelsDir()).not.toBe(join(path('appData'), 'SingZ', 'models'))
    expect(packDir()).not.toBe(join(path('appData'), 'SingZ', 'gpu-splitter'))

    delete process.env.SINGZ_SURFACE
    expect(modelsDir()).toBe(join(path('appData'), 'SingZ', 'models'))
    expect(packDir()).toBe(join(path('appData'), 'SingZ', 'gpu-splitter'))

    process.env.SINGZ_SURFACE = 'box'
    process.env.SINGZ_MODELS_DIR = join(electron.state.root, 'shared models')
    process.env.SINGZ_PACK_DIR = join(electron.state.root, 'shared pack')
    expect(modelsDir()).toBe(process.env.SINGZ_MODELS_DIR)
    expect(packDir()).toBe(process.env.SINGZ_PACK_DIR)
  })

  it('uses product-local project and cloud defaults while allowing an explicit shared library', async () => {
    process.env.SINGZ_SURFACE = 'box'
    const cloud = join(electron.state.root, 'cloud')
    process.env.OneDrive = cloud
    mkdirSync(cloud)
    const boxRoot = join(path('documents'), 'SingZ Box')
    expect(projectsRoot()).toBe(boxRoot)
    expect(projectsRoot()).not.toBe(join(path('documents'), 'SingZ'))
    expect(getStorage()).toMatchObject({ root: boxRoot, isDefault: true })
    expect(listCloudRoots()).toContainEqual({ label: 'OneDrive', path: join(cloud, 'SingZ Box') })

    const shared = join(electron.state.root, 'intentionally shared library')
    mkdirSync(shared)
    writeSettings({ projectsRoot: shared })
    expect(projectsRoot()).toBe(shared)
    expect(getStorage().isDefault).toBe(false)
    expect(await setProjectsRoot(null)).toMatchObject({ ok: true, root: boxRoot })
    expect(readSettings().projectsRoot).toBeUndefined()

    delete process.env.SINGZ_SURFACE
    expect(projectsRoot()).toBe(join(path('documents'), 'SingZ'))
    expect(getStorage().isDefault).toBe(true)
  })

  it('negative control: Box never migrates Desktop Music/SingZ', async () => {
    process.env.SINGZ_SURFACE = 'box'
    const desktopLegacy = join(path('music'), 'SingZ')
    const desktopProject = join(desktopLegacy, 'Desktop song', 'project.json')
    mkdirSync(join(desktopLegacy, 'Desktop song'), { recursive: true })
    writeFileSync(desktopProject, '{}')

    await migrateProjects()

    expect(readFileSync(desktopProject, 'utf8')).toBe('{}')
    expect(existsSync(join(path('documents'), 'SingZ Box', 'Desktop song'))).toBe(false)
  })

  it('migrates only Box own legacy folder when one exists', async () => {
    process.env.SINGZ_SURFACE = 'box'
    const legacy = join(path('music'), 'SingZ Box')
    mkdirSync(join(legacy, 'Box song'), { recursive: true })
    writeFileSync(join(legacy, 'Box song', 'project.json'), '{}')

    await migrateProjects()

    expect(existsSync(join(path('documents'), 'SingZ Box', 'Box song', 'project.json'))).toBe(true)
    expect(existsSync(legacy)).toBe(false)
  })
})

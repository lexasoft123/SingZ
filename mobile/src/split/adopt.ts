import { NativeModules } from 'react-native'
import { log } from '../log'
import type { ProjectDoc } from '../model'

/**
 * Adoption of a finished split: the six stems move out of the service's job
 * dir into the project, stemHashes learns them, the custom-original lane
 * (the pre-split listening copy) leaves settings AND disk, and — the
 * desktop's own writer rule — project.json is written LAST, naming only
 * files that are already in place. Every step tolerates a crashed earlier
 * attempt: a stem already moved counts as moved, a lane file already gone
 * counts as gone, and re-running the whole thing converges.
 */

export const SPLIT_STEMS = ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano'] as const

export interface AdoptDeps {
  readText(project: string, file: string): Promise<string>
  writeText(project: string, file: string, text: string): Promise<boolean>
  moveIntoProject(project: string, relPath: string, srcPath: string): Promise<boolean>
  statFile(
    project: string,
    relPath: string
  ): Promise<{ md5: string; size: number; mtimeMs: number }>
  deleteFile(project: string, relPath: string): Promise<boolean>
  clearJob(): Promise<void>
}

interface FolderNative {
  readText(project: string, file: string): Promise<string>
  writeText(project: string, file: string, text: string): Promise<boolean>
  moveIntoProject(project: string, relPath: string, srcPath: string): Promise<boolean>
  statFile(
    project: string,
    relPath: string
  ): Promise<{ md5: string; size: number; mtimeMs: number }>
  deleteFile(project: string, relPath: string): Promise<boolean>
}

const realDeps = (): AdoptDeps => {
  const f = NativeModules.FolderAccess as FolderNative
  const s = NativeModules.SingzSplit as { clearJob(): Promise<boolean> }
  return {
    readText: (p, file) => f.readText(p, file),
    writeText: (p, file, text) => f.writeText(p, file, text),
    moveIntoProject: (p, rel, src) => f.moveIntoProject(p, rel, src),
    statFile: (p, rel) => f.statFile(p, rel),
    deleteFile: (p, rel) => f.deleteFile(p, rel),
    clearJob: async () => {
      await s.clearJob()
    }
  }
}

/** Move stems in, refresh the doc, drop the original lane, clear the job. */
export async function adoptSplit(
  project: string,
  jobDir: string,
  deps: AdoptDeps = realDeps()
): Promise<{ lanes: string[] }> {
  const doc = JSON.parse(await deps.readText(project, 'project.json')) as ProjectDoc

  for (const stem of SPLIT_STEMS) {
    const rel = `stems/${stem}.wav`
    try {
      await deps.moveIntoProject(project, rel, `${jobDir}/${stem}.wav`)
    } catch (err) {
      // A crashed earlier adoption may have moved this one already — the
      // stat below is the judge; only a stem missing on BOTH sides fails.
      try {
        await deps.statFile(project, rel)
      } catch {
        throw new Error(`The split is missing its ${stem} lane (${String(err)})`)
      }
    }
  }

  const stemHashes: NonNullable<ProjectDoc['stemHashes']> = { ...(doc.stemHashes ?? {}) }
  for (const stem of SPLIT_STEMS) {
    stemHashes[`${stem}.wav`] = await deps.statFile(project, `stems/${stem}.wav`)
  }

  // The pre-split listening copy goes away: out of settings, out of the
  // hashes, and (after the doc stops naming it) off the disk. The file name
  // is derived from songFile too, not only from settings — a crash between
  // last run's doc write and its delete leaves settings already empty, and
  // the orphan would otherwise live forever.
  const custom = Array.isArray(doc.settings?.custom) ? doc.settings.custom : []
  const original = custom.find((t) => t?.id === 'custom-original')
  const keptCustom = custom.filter((t) => t?.id !== 'custom-original')
  const ext = /\.[^./\\]+$/.exec(doc.songFile)?.[0] ?? ''
  const laneFile = original?.file ?? `stems/custom-original${ext}`
  delete stemHashes[laneFile.replace(/^stems\//, '')]

  const next: ProjectDoc = {
    ...doc,
    savedAt: new Date().toISOString(),
    settings: {
      ...doc.settings,
      custom: keptCustom.length > 0 ? keptCustom : undefined
    },
    stemHashes
  }
  await deps.writeText(project, 'project.json', JSON.stringify(next, null, 2))

  if (laneFile) {
    await deps.deleteFile(project, laneFile) // missing is success, by contract
  }
  await deps.clearJob()
  log('split', `adopted into ${project}: six stems, original lane retired`)
  return { lanes: [...SPLIT_STEMS] }
}

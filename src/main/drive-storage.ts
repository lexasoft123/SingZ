import { canonicalFilePath } from './file-path'
import { app } from 'electron'
import { join, sep } from 'node:path'

/** Durable reader collection, deliberately outside the upload library. */
export const driveProjectsRoot = (): string => join(app.getPath('userData'), 'drive-projects')
export const isDriveProject = (dir: string): boolean => canonicalFilePath(dir).startsWith(canonicalFilePath(driveProjectsRoot()) + sep)

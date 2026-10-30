import { app } from 'electron'
import { join, resolve, sep } from 'node:path'

/** Durable reader collection, deliberately outside the upload library. */
export const driveProjectsRoot = (): string => join(app.getPath('userData'), 'drive-projects')
export const isDriveProject = (dir: string): boolean => resolve(dir).startsWith(driveProjectsRoot() + sep)

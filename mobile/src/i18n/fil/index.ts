import { app } from './app'
import { library } from './library'
import { player } from './player'
import { training } from './training'

export const fil: Record<string, string> = { ...app, ...library, ...player, ...training }

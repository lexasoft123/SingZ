import { app } from './app'
import { library } from './library'
import { player } from './player'
import { training } from './training'

export const vi: Record<string, string> = { ...app, ...library, ...player, ...training }

import { app } from './app'
import { library } from './library'
import { player } from './player'
import { training } from './training'

export const zhTW: Record<string, string> = { ...app, ...library, ...player, ...training }

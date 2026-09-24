import { app } from './app'
import { player } from './player'
import { library } from './library'
import { training } from './training'

export const zhCN: Record<string, string> = { ...app, ...player, ...library, ...training }

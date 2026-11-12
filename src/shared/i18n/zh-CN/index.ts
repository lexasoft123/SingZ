import { common } from './common'
import { app } from './app'
import { settings } from './settings'
import { training } from './training'
import { lyrics } from './lyrics'
import { player } from './player'
import { library } from './library'
import { main } from './main'
import { voice } from './voice'

export const zhCN: Record<string, string> = {
  ...common,
  ...app,
  ...settings,
  ...training,
  ...lyrics,
  ...player,
  ...library,
  ...main,
  ...voice
}

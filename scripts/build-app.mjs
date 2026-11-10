import { cp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'electron-vite'

const root = process.cwd()
const staging = resolve(root, 'out/box-stage')

try {
  process.env.SINGZ_RENDERER_TARGET = 'desktop'
  await build()
  process.env.SINGZ_RENDERER_TARGET = 'box'
  await build()
  await cp(resolve(staging, 'box'), resolve(root, 'out/renderer/box'), { recursive: true })
} finally {
  delete process.env.SINGZ_RENDERER_TARGET
  await rm(staging, { recursive: true, force: true })
}

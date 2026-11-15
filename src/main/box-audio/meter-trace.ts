import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface AlsaCaptureTiming {
  card: string; id: string; pcm: string; subdevice: string
  rate: number; channels: number; periodFrames: number; bufferFrames: number
  periodMs: number; bufferMs: number
}
/** Actual negotiated kernel parameters, not the requested 256-frame default.
 * Only called by the opt-in trace; includes every active capture endpoint so a
 * shared lease or another card is never mislabeled as the selected microphone. */
export async function readAlsaCaptureTiming(root = '/proc/asound'): Promise<AlsaCaptureTiming[]> {
  const result: AlsaCaptureTiming[] = []
  let reads = 0
  try {
    for (const card of (await readdir(root)).filter(name => /^card\d+$/.test(name)).slice(0, 32)) {
      const dir = join(root, card)
      const id = (await readFile(join(dir, 'id'), 'utf8').catch(() => '')).trim().slice(0, 128)
      for (const pcm of (await readdir(dir)).filter(name => /^pcm\d+c$/.test(name)).slice(0, 16)) {
        for (const subdevice of (await readdir(join(dir, pcm))).filter(name => /^sub\d+$/.test(name)).slice(0, 16)) {
          if (++reads > 64) return result
          const text = await readFile(join(dir, pcm, subdevice, 'hw_params'), 'utf8').catch(() => '')
          const number = (key: string): number => Number(text.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'))?.[1] ?? 0)
          const rate = number('rate'), channels = number('channels'), periodFrames = number('period_size'), bufferFrames = number('buffer_size')
          if (rate > 0 && channels > 0 && periodFrames > 0 && bufferFrames >= periodFrames)
            result.push({ card, id, pcm, subdevice, rate, channels, periodFrames, bufferFrames, periodMs: periodFrames / rate * 1000, bufferMs: bufferFrames / rate * 1000 })
        }
      }
    }
  } catch { /* Non-Linux, inaccessible procfs or a hot-unplug: explicitly empty. */ }
  return result
}

import { app, screen } from 'electron'
import { existsSync } from 'node:fs'
import os from 'node:os'
import { log } from './log'
import { trtrtxFlagPath } from './models'

const VENDORS: Record<number, string> = {
  0x10de: 'NVIDIA',
  0x8086: 'Intel',
  0x1002: 'AMD',
  0x106b: 'Apple',
  0x1414: 'Microsoft Basic Render'
}

/**
 * One-time hardware summary for the diagnostic log — enough to reason about a
 * field machine (GPU model + driver, RAM, display scale) from a pasted log
 * instead of screenshots of dxdiag.
 */
export function logHardwareInfo(): void {
  const cpus = os.cpus()
  const gb = (n: number): string => `${Math.round(n / (1 << 30))} GB`
  log(
    'hw',
    `${process.platform} ${os.release()} ${process.arch} · ${cpus[0]?.model.trim() ?? 'unknown cpu'} · ${cpus.length} threads · ${gb(os.totalmem())} RAM`
  )
  const displays = screen
    .getAllDisplays()
    .map((d) => `${d.size.width}x${d.size.height} @${d.scaleFactor}x`)
    .join(' · ')
  log('hw', `displays: ${displays}`)
  log(
    'hw',
    `app ${app.isPackaged ? app.getVersion() : 'dev'} · electron ${process.versions.electron} · chrome ${process.versions.chrome}`
  )
  if (process.platform === 'win32' && existsSync(trtrtxFlagPath())) {
    log('hw', 'GPU engine: disabled marker present — splits run on CPU')
  }
  app
    .getGPUInfo('complete')
    .then((info) => {
      const g = info as {
        gpuDevice?: Array<{
          vendorId?: number
          deviceId?: number
          driverVersion?: string
          active?: boolean
        }>
      }
      const devices = g.gpuDevice ?? []
      if (devices.length === 0) log('hw', 'gpu: none reported')
      for (const d of devices) {
        const vendor = VENDORS[d.vendorId ?? 0] ?? `vendor 0x${(d.vendorId ?? 0).toString(16)}`
        log(
          'hw',
          `gpu: ${vendor} device 0x${(d.deviceId ?? 0).toString(16)}` +
            (d.driverVersion ? ` · driver ${d.driverVersion}` : '') +
            (d.active ? ' · active' : '')
        )
      }
    })
    .catch(() => log('hw', 'gpu: info unavailable'))
}

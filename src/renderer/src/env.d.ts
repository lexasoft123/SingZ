/// <reference types="vite/client" />

declare module '*.css'

// Audio Output Devices API (Chromium 110+) — not in lib.dom yet
interface AudioContext {
  readonly sinkId: string
  setSinkId(sinkId: string): Promise<void>
}

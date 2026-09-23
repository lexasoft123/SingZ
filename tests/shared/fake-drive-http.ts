import { createServer, type Server } from 'node:http'
import { newStore, serveRequest, type FakeDriveStore } from './fake-drive'

/**
 * The fake Drive over real HTTP — for the desktop suite (which reaches Drive
 * through node's fetch) and for the Android emulator, which needs a real socket
 * at 10.0.2.2. Binds 0.0.0.0 for that reason.
 */

export interface FakeDriveServer {
  server: Server
  port: number
  store: FakeDriveStore
  /** Convenience: the same map the store holds. */
  files: FakeDriveStore['files']
  hits: string[]
  /** While true every request is dropped at the socket, as when the signal
   *  goes: the client sees a network error, never a response. */
  offline: boolean
  /** Asked before each request is served; true takes the fake offline from
   *  that request on — a cut placed exactly, which no timer can do. */
  cutWhen?: (method: string, url: string, body: Buffer) => boolean
  close(): Promise<void>
}

export function startFakeDrive(port = 0, store: FakeDriveStore = newStore()): Promise<FakeDriveServer> {
  let api: FakeDriveServer | null = null
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      if (api && !api.offline && api.cutWhen?.(req.method ?? 'GET', req.url ?? '/', body)) api.offline = true
      if (api?.offline) {
        req.socket.destroy()
        return
      }
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers[k.toLowerCase()] = v
      }
      // An upload session points back at the address THIS client used: the
      // emulator reaches the Mac as 10.0.2.2, and a session URL naming
      // 127.0.0.1 would send its PUT to the emulator itself.
      if (headers.host) store.baseUrl = `http://${headers.host}`
      const out = serveRequest(store, req.method ?? 'GET', req.url ?? '/', body, headers)
      res.writeHead(out.status, out.headers)
      res.end(out.body)
    })
  })

  return new Promise((resolve) => {
    server.listen(port, '0.0.0.0', () => {
      const actual = (server.address() as { port: number }).port
      store.baseUrl = `http://127.0.0.1:${actual}`
      api = {
        server,
        port: actual,
        store,
        files: store.files,
        hits: store.hits,
        offline: false,
        close: () => new Promise((r) => server.close(() => r()))
      }
      resolve(api)
    })
  })
}

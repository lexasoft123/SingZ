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
  close(): Promise<void>
}

export function startFakeDrive(port = 0, store: FakeDriveStore = newStore()): Promise<FakeDriveServer> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers[k.toLowerCase()] = v
      }
      const out = serveRequest(store, req.method ?? 'GET', req.url ?? '/', Buffer.concat(chunks), headers)
      res.writeHead(out.status, out.headers)
      res.end(out.body)
    })
  })

  return new Promise((resolve) => {
    server.listen(port, '0.0.0.0', () => {
      const actual = (server.address() as { port: number }).port
      store.baseUrl = `http://127.0.0.1:${actual}`
      resolve({
        server,
        port: actual,
        store,
        files: store.files,
        hits: store.hits,
        close: () => new Promise((r) => server.close(() => r()))
      })
    })
  })
}

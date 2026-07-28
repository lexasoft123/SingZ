import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'

/**
 * Minimal Google Drive v3 mock covering exactly what SingZ uses: token
 * refresh, files.list with the app's two query shapes, folder create,
 * resumable upload, and alt=media download. One instance serves both the
 * desktop sync test and the phone-streaming E2E — the same store proves the
 * full desktop -> Drive -> phone cycle without Google.
 */

interface MockFile {
  id: string
  name: string
  mimeType: string
  parents: string[]
  bytes?: Buffer
}

export interface MockDrive {
  server: Server
  port: number
  files: Map<string, MockFile>
  close(): Promise<void>
}

export function startMockDrive(port = 0): Promise<MockDrive> {
  const files = new Map<string, MockFile>()
  let nextId = 1
  const newId = (): string => `mock${nextId++}`
  const sessions = new Map<string, { id: string }>()

  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const url = new URL(req.url ?? '/', 'http://mock')
      const json = (code: number, data: unknown): void => {
        res.writeHead(code, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(data))
      }

      if (url.pathname === '/oauth2/v4/token') {
        return json(200, { access_token: 'mock-access', refresh_token: 'mock-refresh', expires_in: 3600 })
      }

      if (url.pathname === '/drive/v3/files' && req.method === 'GET') {
        const q = url.searchParams.get('q') ?? ''
        let list = [...files.values()]
        const nameMatch = /name='([^']+)'/.exec(q)
        const parentMatch = /'([^']+)' in parents/.exec(q)
        if (nameMatch) list = list.filter((f) => f.name === nameMatch[1])
        if (parentMatch) list = list.filter((f) => f.parents.includes(parentMatch[1]))
        if (/mimeType='application\/vnd\.google-apps\.folder'/.test(q)) {
          list = list.filter((f) => f.mimeType === 'application/vnd.google-apps.folder')
        }
        return json(200, {
          files: list.map((f) => ({
            id: f.id,
            name: f.name,
            mimeType: f.mimeType,
            size: f.bytes ? String(f.bytes.length) : undefined,
            md5Checksum: f.bytes ? createHash('md5').update(f.bytes).digest('hex') : undefined
          }))
        })
      }

      const mediaMatch = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname)
      if (mediaMatch && req.method === 'GET' && url.searchParams.get('alt') === 'media') {
        const f = files.get(mediaMatch[1])
        if (!f || !f.bytes) return json(404, { error: 'not found' })
        res.writeHead(200, { 'Content-Type': f.mimeType, 'Content-Length': f.bytes.length })
        return res.end(f.bytes)
      }

      if (url.pathname === '/drive/v3/files' && req.method === 'POST') {
        const meta = JSON.parse(body.toString() || '{}')
        const f: MockFile = {
          id: newId(),
          name: meta.name,
          mimeType: meta.mimeType ?? 'application/octet-stream',
          parents: meta.parents ?? []
        }
        files.set(f.id, f)
        return json(200, { id: f.id })
      }

      const uploadNew = url.pathname === '/upload/drive/v3/files' && req.method === 'POST'
      const uploadPatch = /^\/upload\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname)
      if ((uploadNew || (uploadPatch && req.method === 'PATCH')) && url.searchParams.get('uploadType') === 'resumable') {
        let id: string
        if (uploadNew) {
          const meta = JSON.parse(body.toString() || '{}')
          id = newId()
          files.set(id, {
            id,
            name: meta.name,
            mimeType: 'application/octet-stream',
            parents: meta.parents ?? []
          })
        } else {
          id = (uploadPatch as RegExpExecArray)[1]
          if (!files.has(id)) return json(404, { error: 'not found' })
        }
        const sess = newId()
        sessions.set(sess, { id })
        res.writeHead(200, {
          Location: `http://127.0.0.1:${(server.address() as { port: number }).port}/upload-session/${sess}`
        })
        return res.end()
      }

      const sessMatch = /^\/upload-session\/([^/]+)$/.exec(url.pathname)
      if (sessMatch && req.method === 'PUT') {
        const sess = sessions.get(sessMatch[1])
        if (!sess) return json(404, { error: 'no session' })
        const f = files.get(sess.id)
        if (!f) return json(404, { error: 'no file' })
        f.bytes = body
        f.mimeType = req.headers['content-type'] ?? f.mimeType
        return json(200, { id: f.id })
      }

      json(404, { error: `unhandled ${req.method} ${url.pathname}` })
    })
  })

  return new Promise((resolve) => {
    server.listen(port, '0.0.0.0', () => {
      const actual = (server.address() as { port: number }).port
      resolve({
        server,
        port: actual,
        files,
        close: () => new Promise((r) => server.close(() => r()))
      })
    })
  })
}

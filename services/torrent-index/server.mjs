import { createServer } from 'node:http'
import { FilenameIndex } from './index.mjs'
import { pathToFileURL } from 'node:url'

export function createIndexServer(index) {
  return createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    response.setHeader('Access-Control-Allow-Origin', '*')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Cache-Control', 'no-store')
    const send = (status, data) => {
      response.writeHead(status)
      response.end(JSON.stringify(data))
    }
    if (request.method !== 'GET') return send(405, { ok: false, error: 'Read-only service' })
    try {
      const url = new URL(request.url, 'http://localhost')
      if (url.pathname === '/v1/status') return send(200, { ok: true, data: index.coverage() })
      if (url.pathname !== '/v1/search') return send(404, { ok: false, error: 'Not found' })
      const offset = url.searchParams.get('offset') ?? '0'
      if (!/^\d{1,6}$/.test(offset)) return send(400, { ok: false, error: 'Invalid search offset' })
      const data = index.search(url.searchParams.get('query'), Number(offset))
      if (!data.coverage.indexedTorrents)
        return send(503, {
          ok: false,
          error: 'The filename catalog has not been populated yet',
          coverage: data.coverage
        })
      send(200, { ok: true, data })
    } catch (error) {
      const inputError = [
        'Invalid filename search',
        'Use at least one search word with 3 or more characters'
      ].includes(error.message)
      send(inputError ? 400 : 500, {
        ok: false,
        error: inputError ? error.message : 'Filename search is temporarily unavailable'
      })
    }
  })
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const index = new FilenameIndex(process.env.SINGZ_TORRENT_INDEX_DB ?? 'torrent-files.sqlite')
  const server = createIndexServer(index)
  server.requestTimeout = 15000
  server.headersTimeout = 10000
  server.listen(Number(process.env.PORT ?? 8792), '127.0.0.1', () =>
    console.log('Filename index listening on loopback')
  )
  const stop = () =>
    server.close(() => {
      index.close()
      process.exit(0)
    })
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

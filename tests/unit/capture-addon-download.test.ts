import { createServer, get as httpGet, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspect } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const builder = require('../../scripts/build-capture-addon.cjs') as {
  download: (url: string, destination: string, options?: Record<string, unknown>) => Promise<void>
  downloadHeaderFile: (url: string, destination: string, options?: Record<string, unknown>) => Promise<void>
  extractHeaders: (archivePath: string, cwd: string) => void
}

/**
 * The addon build fetches Electron's headers (and node.lib on Windows) once
 * per checkout. https.get sets no timeout of any kind, so a connection that
 * stalled after connecting never errored: a fresh checkout's build sat for
 * over eighty minutes at zero CPU holding the native build lock, printing
 * nothing. These drive the real download against a local server that
 * misbehaves the ways a network does. The timeouts are shortened through the
 * options; everything else is the path the build runs.
 */
describe('the addon build’s header download', () => {
  let server: Server
  let base = ''
  let dir = ''
  let handler: (req: IncomingMessage, res: ServerResponse) => void = () => {}
  let requests = 0
  const body = Buffer.from('x'.repeat(4000))
  const quick = {
    get: httpGet,
    responseTimeoutMs: 300,
    idleTimeoutMs: 300,
    attempts: 1,
    backoffMs: 10,
    log: () => {}
  }
  const destination = (): string => join(dir, 'node-headers.tar.gz')
  const left = (): string[] => readdirSync(dir)

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'singz-headers-'))
    requests = 0
    server = createServer((req, res) => {
      requests++
      handler(req, res)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  })

  afterEach(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  })

  it('gives up on a server that accepts and never answers, naming the URL and the wait', async () => {
    handler = () => {} // the connection is accepted; nothing ever comes back
    const t0 = Date.now()
    const url = `${base}/headers.tar.gz`
    await expect(builder.download(url, destination(), quick)).rejects.toThrow(
      `Download stalled: no response from ${url} for 0.3 s`
    )
    expect(Date.now() - t0).toBeLessThan(3000)
    expect(left()).toEqual([])
  })

  it('gives up on half a body and then silence, and removes the partial', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-length': String(body.length) })
      res.write(body.subarray(0, 2000)) // and then nothing, with the socket held open
    }
    await expect(builder.download(`${base}/headers.tar.gz`, destination(), quick)).rejects.toThrow(
      /Download stalled: no data from .* for 0\.3 s \(.* 2000 bytes received\)/
    )
    expect(left()).toEqual([])
  })

  it('refuses half a body and a dropped connection — never installed, nothing left', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-length': String(body.length) })
      res.write(body.subarray(0, 2000), () => res.socket?.destroy())
    }
    await expect(builder.download(`${base}/headers.tar.gz`, destination(), quick)).rejects.toThrow(
      /interrupted|ended early|aborted|socket hang up/i
    )
    expect(left()).toEqual([])
  })

  it('installs a whole body byte for byte, with no partial left over', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-length': String(body.length) })
      res.end(body)
    }
    await builder.download(`${base}/headers.tar.gz`, destination(), quick)
    expect(readFileSync(destination()).equals(body)).toBe(true)
    expect(left()).toEqual(['node-headers.tar.gz'])
  })

  it('follows a relative redirect', async () => {
    handler = (req, res) => {
      if (req.url === '/moved') {
        res.writeHead(302, { location: '/here/headers.tar.gz' })
        res.end()
        return
      }
      res.writeHead(200, { 'content-length': String(body.length) })
      res.end(body)
    }
    await builder.download(`${base}/moved`, destination(), quick)
    expect(readFileSync(destination()).equals(body)).toBe(true)
  })

  it('tries a stall again after backing off, and the second attempt lands', async () => {
    handler = (_req, res) => {
      if (requests === 1) return // the first attempt stalls
      res.writeHead(200, { 'content-length': String(body.length) })
      res.end(body)
    }
    const said: string[] = []
    await builder.download(`${base}/headers.tar.gz`, destination(), {
      ...quick,
      attempts: 3,
      log: (line: string) => said.push(line)
    })
    expect(requests).toBe(2)
    expect(said).toHaveLength(1)
    expect(said[0]).toMatch(/Download stalled: no response .* trying again in 0\.01 s \(attempt 2 of 3\)/)
    expect(readFileSync(destination()).equals(body)).toBe(true)
    expect(left()).toEqual(['node-headers.tar.gz'])
  })

  it('says how many attempts it made when every one of them stalls', async () => {
    handler = () => {}
    await expect(
      builder.download(`${base}/headers.tar.gz`, destination(), { ...quick, attempts: 2 })
    ).rejects.toThrow(/Download stalled: no response .*\(gave up after 2 attempts\)/)
    expect(requests).toBe(2)
    expect(left()).toEqual([])
  })

  it('does not retry a 404 — a wrong version fails the same way every time', async () => {
    handler = (_req, res) => {
      res.writeHead(404)
      res.end()
    }
    await expect(
      builder.download(`${base}/headers.tar.gz`, destination(), { ...quick, attempts: 3 })
    ).rejects.toThrow(`Download failed (404): ${base}/headers.tar.gz`)
    expect(requests).toBe(1)
    expect(left()).toEqual([])
  })

  /**
   * What the build prints is the error's STACK, and node renders a system
   * error's stack (ECONNREFUSED, ENOTFOUND — the offline case) the moment it
   * creates it, so text appended to `.message` afterwards never reaches the
   * terminal. Checked through util.inspect, which prints what the build
   * prints; `.message` alone passed with the hint missing from the output.
   */
  it('tells an offline build how many attempts it made and what to copy instead', async () => {
    const refused = 'http://127.0.0.1:1/headers.tar.gz' // nothing listens on port 1
    const printed = await builder
      .downloadHeaderFile(refused, destination(), { ...quick, attempts: 2 })
      .then(() => 'resolved', (error: unknown) => inspect(error))
    expect(printed).toContain('ECONNREFUSED')
    expect(printed).toContain('(gave up after 2 attempts)')
    expect(printed).toMatch(/copying that folder into this checkout skips the download/)
    expect(left()).toEqual([])
  })

  it('forgets a tarball that will not extract, and what it had extracted, so the next build downloads it again', () => {
    // the download is skipped whenever the archive exists, and extraction
    // whenever node_api.h does — a damaged archive or a half-extracted tree
    // left in place would fail the same way on every build after it
    writeFileSync(destination(), 'not a gzip stream')
    mkdirSync(join(dir, 'node_headers', 'include', 'node'), { recursive: true })
    writeFileSync(join(dir, 'node_headers', 'include', 'node', 'node_api.h'), '// half an extraction')
    let printed = ''
    try {
      builder.extractHeaders(destination(), dir)
    } catch (error) {
      printed = inspect(error)
    }
    expect(printed).toMatch(/removed it and what it had extracted, so the next build downloads it again/)
    expect(existsSync(destination())).toBe(false)
    expect(existsSync(join(dir, 'node_headers'))).toBe(false)
  })
})

import { createHash } from 'node:crypto'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { downloadDriveFile, type DownloadProgress } from '../../src/main/drive-download'

const bytes = Buffer.from('the complete audio file')
const md5 = (b: Buffer): string => createHash('md5').update(b).digest('hex')
let root: string
let server: Server
let url: string
let hits: number
let respond: (res: ServerResponse) => void
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'singz-download-'))
  hits = 0
  respond = (res) => { res.end(bytes) }
  server = createServer((_req, res) => { hits++; respond(res) })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/file`
})
afterEach(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(root, { recursive: true, force: true })
})
const file = { id: 'one', name: 'vocals.flac', size: String(bytes.length), md5Checksum: md5(bytes) }
const token = async (): Promise<string> => 'token'
const out = (): string => join(root, file.name)
const download = (options: Partial<Parameters<typeof downloadDriveFile>[2]> = {}) =>
  downloadDriveFile(file, out(), { url, token, retryMs: 0, ...options })

describe('desktop Drive file recovery against real HTTP streams', () => {
  it('reuses a verified file before asking for a token, including offline', async () => {
    await writeFile(out(), bytes)
    const authorize = vi.fn(async () => { throw new Error('offline') })
    expect(await download({ token: authorize })).toEqual({ md5: md5(bytes), size: bytes.length })
    expect(authorize).not.toHaveBeenCalled()
    expect(hits).toBe(0)
  })
  it('rejects a same-size obsolete saved revision and replaces it after verification', async () => {
    await writeFile(out(), Buffer.alloc(bytes.length, 42))
    await download()
    expect(await readFile(out())).toEqual(bytes)
    expect(hits).toBe(1)
  })
  it('reports bytes, rate and verification while retrying only a transient request', async () => {
    const progress: DownloadProgress[] = []
    respond = (res) => { if (hits === 1) { res.writeHead(503); res.end() } else res.end(bytes) }
    await download({ onProgress: (p) => progress.push(p) })
    expect(hits).toBe(2)
    expect(progress.some((p) => p.phase === 'retrying' && p.attempt === 2)).toBe(true)
    expect(progress.some((p) => p.phase === 'downloading' && p.bytes === bytes.length && p.bytesPerSecond > 0)).toBe(true)
    expect(progress.at(-1)?.phase).toBe('verifying')
  })
  it.each([403, 404])('does not retry permanent HTTP %s failures', async (status) => {
    respond = (res) => { res.writeHead(status); res.end() }
    await expect(download()).rejects.toThrow(`Drive API ${status}`)
    expect(hits).toBe(1)
    expect(await readdir(root)).toEqual([])
  })
  it('renews authorization after a 401', async () => {
    const authorize = vi.fn(async (_renew: boolean, _signal: AbortSignal) => 'token')
    respond = (res) => { if (hits === 1) { res.writeHead(401); res.end() } else res.end(bytes) }
    await download({ token: authorize })
    expect(authorize.mock.calls.map((args) => args[0])).toEqual([false, true])
  })
  it('bounds repeated corruption and preserves the previous file', async () => {
    const previous = Buffer.from('a different earlier revision')
    await writeFile(out(), previous)
    respond = (res) => { res.end(Buffer.alloc(bytes.length, 13)) }
    await expect(download()).rejects.toThrow(/integrity/)
    expect(hits).toBe(3)
    expect(await readFile(out())).toEqual(previous)
    expect(await readdir(root)).toEqual([file.name])
  })
  it('rejects a short response even when no checksum was provided', async () => {
    respond = (res) => { res.end(bytes.subarray(0, 3)) }
    await expect(downloadDriveFile({ ...file, md5Checksum: undefined }, out(), { url, token, retryMs: 0 })).rejects.toThrow(/integrity/)
    expect(hits).toBe(3)
    expect(await readdir(root)).toEqual([])
  })
  it('bounds stalls during the response body and deletes every partial', async () => {
    respond = (res) => { res.writeHead(200); res.write('one byte then silence') }
    await expect(download({ stallMs: 40 })).rejects.toThrow(/timeout/)
    expect(hits).toBe(3)
    expect(await readdir(root)).toEqual([])
  })
  it('cancels a stalled download without retries or partial files', async () => {
    const abort = new AbortController()
    respond = (res) => { res.writeHead(200); res.write('partial'); setImmediate(() => abort.abort(new Error('Sync cancelled'))) }
    await expect(download({ signal: abort.signal })).rejects.toThrow('Sync cancelled')
    expect(hits).toBe(1)
    expect(await readdir(root)).toEqual([])
  })
  it('cancels a retry wait immediately', async () => {
    const abort = new AbortController()
    respond = (res) => { res.writeHead(503); res.end() }
    await expect(download({ signal: abort.signal, retryMs: 10_000, onProgress: (p) => {
      if (p.phase === 'retrying') abort.abort(new Error('cancelled during wait'))
    } })).rejects.toThrow()
    expect(hits).toBe(1)
    expect(await readdir(root)).toEqual([])
  })
})

import { newStore, serveRequest, type FakeDriveStore } from './fake-drive'

/**
 * The fake Drive as a globalThis.fetch — for the mobile suite, which has no
 * server to talk to and used to carry its own hand-rolled Drive with its own
 * query parser. Same store, same rules as the desktop's HTTP adapter.
 */

export interface InstalledFakeDrive {
  store: FakeDriveStore
  /** Requests seen since the last reset — the "a quiet refresh is N" assertion. */
  hits: string[]
  restore(): void
  /** Make the network fail the way a phone's does, RN's message included. */
  setOffline(offline: boolean): void
}

export function installFakeDrive(store: FakeDriveStore = newStore()): InstalledFakeDrive {
  const previous = globalThis.fetch
  let offline = false

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (offline) throw new TypeError('Network request failed')
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = init?.method ?? 'GET'
    const body =
      init?.body === undefined
        ? Buffer.alloc(0)
        : Buffer.from(typeof init.body === 'string' ? init.body : (init.body as ArrayBuffer as never))
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v
    }
    const out = serveRequest(store, method, url, body, headers)
    // utf8, like a real fetch: latin1 mangles the first non-ASCII project name
    const text = Buffer.isBuffer(out.body) ? out.body.toString('utf8') : out.body
    // HTTP header names are case-insensitive, and "Location" vs "location" is
    // exactly the kind of difference a fake gets wrong and a real server does not
    const lower = new Map(Object.entries(out.headers).map(([k, v]) => [k.toLowerCase(), v]))
    return {
      ok: out.status >= 200 && out.status < 300,
      status: out.status,
      headers: { get: (k: string) => lower.get(k.toLowerCase()) ?? null },
      json: async () => JSON.parse(text) as unknown,
      text: async () => text,
      arrayBuffer: async () => {
        const b = Buffer.isBuffer(out.body) ? out.body : Buffer.from(out.body)
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
      }
    } as unknown as Response
  }) as typeof fetch

  return {
    store,
    hits: store.hits,
    restore: () => {
      globalThis.fetch = previous
    },
    setOffline: (v: boolean) => {
      offline = v
    }
  }
}

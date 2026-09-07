/*
 * Metro/CDP plumbing shared by the two platform layers of player-session.
 *
 * Nothing here is new — it is the same four things every driver in
 * mobile/tests/ re-derives, collected so the iOS and Android halves of this
 * suite cannot drift apart:
 *
 *  1. a `/json` fetch WITH A TIMEOUT (http.get has none of its own, and a
 *     Metro busy building a cold bundle accepts the connection and then
 *     stalls — the driver hangs with nothing printed);
 *  2. picking the target with a caller-supplied predicate, never "the first
 *     one with a webSocketDebuggerUrl" — Metro lists EVERY attached app in
 *     connection order, so with a simulator and an emulator both up the
 *     unfiltered find() takes whichever answered first. iOS matches the exact
 *     `deviceName` simctl reports; Android CANNOT, because Metro decorates it
 *     ("sdk_gphone64_arm64 - 16 - API 36" for a device whose
 *     `ro.product.model` is "sdk_gphone64_arm64"), so it matches the appId and
 *     a deviceName PREFIX instead;
 *  3. probing each candidate with `1+1` before trusting it, because a stale
 *     entry for a terminated app is still listed and still accepts a socket;
 *  4. `val()` — the `__p<n>` promise-parking evaluator from
 *     native-playback-ios.cjs. RN's Promise is a polyfill that the
 *     inspector's `awaitPromise` does not unwrap, so an awaited expression
 *     comes back as an opaque object forever. Park the outcome on a global
 *     and poll it.
 *
 * `begin()`/`end()` split that last one in half so the HOST can do work
 * (a `top` sample, an adb call) while an in-app measurement window is still
 * open — which is the only way to sample CPU *during* a graph rebuild.
 */
const http = require('http')
const WebSocket = require('ws')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const getJson = (u) =>
  new Promise((res, rej) => {
    http
      .get(u, (r) => {
        let d = ''
        r.on('data', (c) => (d += c))
        r.on('end', () => {
          try {
            res(JSON.parse(d))
          } catch (e) {
            rej(e)
          }
        })
      })
      .on('error', rej)
      .setTimeout(5000, function () {
        this.destroy(new Error('metro /json timed out'))
      })
  })

/** A candidate that answers `1+1` is a live app; anything else is a corpse. */
function probe(target, port) {
  return new Promise((res) => {
    const sock = new WebSocket(target.webSocketDebuggerUrl, { origin: `http://localhost:${port}` })
    const give = (v) => {
      clearTimeout(timer)
      if (!v) sock.close()
      res(v)
    }
    const timer = setTimeout(() => give(null), 5000)
    sock.on('error', () => give(null))
    sock.on('open', () => {
      sock.on('message', (m) => {
        let g = null
        try {
          g = JSON.parse(m.toString())
        } catch {
          return
        }
        if (!g || g.id !== 1) return
        give(g.result?.result?.value === 2 ? sock : null)
      })
      sock.send(
        JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: '1+1', returnByValue: true } })
      )
    })
  })
}

/**
 * Connect to the one app running on `deviceName`. Returns an evaluator, or
 * throws after `tries` seconds — never silently drives someone else's app.
 */
async function connect({ port, match, label, tries = 90 }) {
  let ws = null
  let picked = null
  for (let i = 0; i < tries && !ws; i++) {
    let cands = []
    try {
      const list = await getJson(`http://localhost:${port}/json`)
      cands = list.filter((t) => t.webSocketDebuggerUrl && match(t))
    } catch {}
    for (const c of cands) {
      ws = await probe(c, port)
      if (ws) {
        picked = c
        break
      }
    }
    if (!ws) await sleep(1000)
  }
  if (!ws) throw new Error(`no live debugger target matching ${label} on Metro ${port}`)

  let id = 1
  const pend = new Map()
  ws.on('message', (m) => {
    let g = null
    try {
      g = JSON.parse(m.toString())
    } catch {
      return
    }
    if (pend.has(g.id)) {
      pend.get(g.id)(g)
      pend.delete(g.id)
    }
  })

  const raw = (expression, timeoutMs = 20000) =>
    new Promise((res, rej) => {
      const i = ++id
      ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }))
      pend.set(i, res)
      setTimeout(() => {
        if (pend.has(i)) {
          pend.delete(i)
          rej(new Error('eval timeout: ' + expression.slice(0, 90)))
        }
      }, timeoutMs)
    })

  /** Fire and forget — used where the reply must NOT be waited on (an Android
   *  song load, during which this socket has to stay silent). */
  const ev = async (expression) => {
    const g = await raw(`void (function () { try { ${expression} } catch (e) { globalThis.__psErr = String(e && e.message) } })()`)
    return g.result?.result?.value
  }

  let slot = 0
  /* `firstReplyMs` bounds the EVALUATE itself, not just the poll that waits
     for the parked promise. They are different waits and only the second used
     to be adjustable: a caller asking for a short deadline still blocked for
     the hardcoded 25 s on the first reply, which is the wait that actually
     matters when the JS thread is frozen (a suspended iPhone). */
  const begin = async (expression, timeoutMs = 30000, firstReplyMs = 25000) => {
    const n = ++slot
    const p = 'globalThis.__p' + n
    const wrapped =
      '(() => { const __v = (' + expression + '); ' +
      "if (__v && typeof __v.then === 'function') { " + p + ' = { done: false }; ' +
      '__v.then(v => { ' + p + ' = { done: true, v }; }, ' +
      'err => { ' + p + ' = { done: true, err: String(err && (err.stack || err.message) || err) }; }); ' +
      "return '__PENDING__'; } return __v; })()"
    const g = await raw(wrapped, firstReplyMs)
    if (g.result?.exceptionDetails) {
      const d = g.result.exceptionDetails
      throw new Error('eval threw: ' + (d.exception?.description || d.text) + ' :: ' + expression.slice(0, 120))
    }
    const v = g.result?.result?.value
    if (v !== '__PENDING__') return { settled: true, value: v }
    return { settled: false, n, deadline: Date.now() + timeoutMs, expression }
  }

  const end = async (token) => {
    if (token.settled) return token.value
    while (Date.now() < token.deadline) {
      const g = await raw(
        `(() => { const p = globalThis.__p${token.n}; if (!p || !p.done) return '__PENDING__'; ` +
          `delete globalThis.__p${token.n}; return JSON.stringify(p); })()`,
        25000
      )
      const rv = g.result?.result?.value
      if (rv !== '__PENDING__') {
        const p = JSON.parse(rv)
        if (p.err !== undefined) throw new Error('promise rejected: ' + p.err)
        return p.v
      }
      await sleep(30)
    }
    throw new Error('promise never settled: ' + token.expression.slice(0, 120))
  }

  const val = async (expression, timeoutMs = 30000, firstReplyMs = 25000) =>
    end(await begin(expression, timeoutMs, firstReplyMs))

  return {
    target: picked,
    ev,
    val,
    begin,
    end,
    /** Whether the socket is still usable. A physical iPhone that iOS put to
     *  sleep comes back with a CLOSED one, and every evaluate after that
     *  throws rather than answering. */
    alive: () => ws.readyState === WebSocket.OPEN,
    close: () => {
      try {
        ws.close()
      } catch {}
    }
  }
}

module.exports = { sleep, getJson, connect }

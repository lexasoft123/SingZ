#!/usr/bin/env node
/**
 * Execute the opt-in codec proof inside the installed iOS app and save the
 * target-generated evidence. This driver never decodes audio in JavaScript;
 * it only starts the ordinary-thread native proof and polls completion.
 *
 * DEVICE_NAME="Max's iPhone" METRO_PORT=8081 \
 *   node mobile/tests/codec-target-ios.cjs build/codec-proof/ios-arm64.raw.json
 *
 * For a simulator, SIM_UDID may be used instead of DEVICE_NAME. The exact
 * device-name filter is mandatory because Metro lists iOS and Android apps in
 * connection order and an unfiltered target makes target evidence vacuous.
 */
// Every E2E driver runs under a deadline: a hang prints where it was and
// exits, instead of sitting there until somebody notices (tests/shared/watchdog.cjs).
require('../../tests/shared/watchdog.cjs').arm('codec-target-ios')

const { execFileSync } = require('node:child_process')
const { mkdirSync, writeFileSync } = require('node:fs')
const { dirname, resolve } = require('node:path')

const port = Number(process.env.METRO_PORT || 8081)
const output = process.argv[2]
const die = (message) => { console.error(message); process.exit(1) }
if (!output) die('usage: node mobile/tests/codec-target-ios.cjs <evidence-output.json>')

let deviceName = process.env.DEVICE_NAME || ''
if (!deviceName && process.env.SIM_UDID) {
  deviceName = execFileSync('xcrun', ['simctl', 'list', 'devices'], { encoding: 'utf8' })
    .split('\n')
    .find((line) => line.includes(process.env.SIM_UDID))
    ?.trim().split(' (')[0] || ''
}
if (!deviceName) die('set exact DEVICE_NAME or SIM_UDID; unfiltered Metro targets are forbidden')

;(async () => {
  const list = await (await fetch(`http://localhost:${port}/json/list`)).json()
  const target = list
    .filter((candidate) => candidate.deviceName === deviceName && candidate.webSocketDebuggerUrl)
    .pop()
  if (!target) die(`no exact Metro target ${JSON.stringify(deviceName)} on port ${port}`)

  const WebSocket = require('ws')
  const socket = new WebSocket(target.webSocketDebuggerUrl, {
    headers: { Origin: 'http://localhost' }
  })
  const pending = new Map()
  let sequence = 0
  socket.on('message', (message) => {
    const response = JSON.parse(message.toString())
    const complete = pending.get(response.id)
    if (complete) {
      pending.delete(response.id)
      complete(response)
    }
  })
  await new Promise((resolveOpen, rejectOpen) => {
    socket.once('open', resolveOpen)
    socket.once('error', rejectOpen)
  })
  const evaluate = async (expression, timeoutMs = 5000) => {
    const id = ++sequence
    const response = await new Promise((resolveResponse, rejectResponse) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        rejectResponse(new Error(`CDP evaluation timed out after ${timeoutMs} ms`))
      }, timeoutMs)
      pending.set(id, (value) => {
        clearTimeout(timer)
        resolveResponse(value)
      })
      socket.send(JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true }
      }))
    })
    if (response.result?.exceptionDetails)
      throw new Error(response.result.exceptionDetails.text || 'CDP evaluation failed')
    return response.result?.result?.value
  }

  if (await evaluate('1+1') !== 2) die('selected Metro target does not answer')
  const present = await evaluate("globalThis.__test.nativeApi('NativeAudioRuntime','codecTargetProof')")
  if (present !== 'function')
    die('codecTargetProof is absent: prepare with SINGZ_CODEC_TARGET_PROOF=1, rebuild, reinstall')
  if (await evaluate('globalThis.__test.codecTargetProof()') !== true)
    die('codec target proof did not start')

  const deadline = Date.now() + 120000
  while (Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
    if (await evaluate('globalThis.__test.codecTargetProofDone === true')) break
  }
  if (await evaluate('globalThis.__test.codecTargetProofDone === true') !== true)
    die('codec target proof did not settle in 120 seconds')
  const evidenceText = await evaluate('globalThis.__test.codecTargetProofResult')
  let evidence
  try { evidence = JSON.parse(evidenceText) } catch {
    die(`codec target proof returned non-JSON evidence: ${String(evidenceText).slice(0, 500)}`)
  }
  if (evidence.result !== 'full dynamic matrix ok' ||
      evidence.executionMode !== 'actual-packaged-runtime') {
    die(`codec target proof failed: ${JSON.stringify(evidence)}`)
  }

  const destination = resolve(output)
  mkdirSync(dirname(destination), { recursive: true })
  writeFileSync(destination, `${JSON.stringify(evidence, null, 2)}\n`)
  socket.close()
  console.log(`iOS target codec evidence: ${destination}`)
})().catch((error) => die(error.stack || error.message))

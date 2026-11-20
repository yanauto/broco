import { lstatSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import { platform } from './platform/index.mjs'
import { home, legacyCcBroHome, samePath, socketFor, socketPath } from './paths.mjs'

export const shutdownEffect = 'Shutdown stops running and queued work across all projects on this runner. Unfinished turns will not resume automatically.'
export const RUNNER_PROTOCOL = 15

export function legacySocketsFor(socket = socketPath) {
  if (process.platform === 'win32' || typeof socket !== 'string') return []
  const match = /\/s-([0-9a-f]{24})\.sock$/.exec(socket)
  if (!match) return []
  const uid = process.getuid()
  return [
    '/tmp/cc-bro-' + uid + '/s-' + match[1] + '.sock',
    '/tmp/cc-bro-' + uid + '-' + match[1] + '.sock'
  ]
}

export function legacySocketFor(socket = socketPath) {
  return legacySocketsFor(socket)[1] ?? null
}

function isVerifiedSocket(path) {
  if (process.platform === 'win32' || typeof path !== 'string') return false
  const st = lstatSync(path, { throwIfNoEntry: false })
  return Boolean(st && !st.isSymbolicLink() && st.isSocket() && st.uid === process.getuid())
}

function verifiedLegacySockets(socket = socketPath) {
  return legacySocketsFor(socket).filter(isVerifiedSocket)
}

export function call(path, data, socket = socketPath, options = {}) {
  const opts = typeof options === 'number' ? { timeoutMs: options } : (options ?? {})
  const { timeoutMs = 0, signal } = opts
  return new Promise((resolve, reject) => {
    let settled = false
    const done = (fn, val) => {
      if (settled) return
      settled = true
      fn(val)
    }
    const req = request({ socketPath: socket, path, agent: false, method: data ? 'POST' : 'GET' }, res => {
      const chunks = []
      res.once('error', err => done(reject, err))
      res.once('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf8')
          const value = JSON.parse(body)
          if (res.statusCode !== 200) throw new Error(value.error)
          done(resolve, value)
        } catch (err) { done(reject, err) }
      })
      res.on('data', part => { chunks.push(Buffer.isBuffer(part) ? part : Buffer.from(part)) })
    })
    if (timeoutMs > 0) {
      req.setTimeout(timeoutMs, () => {
        const err = new Error('Runner request timed out')
        err.code = 'ETIMEDOUT'
        req.destroy(err)
      })
    }
    if (signal) {
      if (signal.aborted) {
        req.destroy(signal.reason ?? new Error('Aborted'))
        return
      }
      signal.addEventListener('abort', () => req.destroy(signal.reason ?? new Error('Aborted')), { once: true })
    }
    req.once('error', err => done(reject, err))
    req.end(data ? JSON.stringify(data) : undefined)
  })
}

export async function probeReady(socket = socketPath) {
  try {
    const runner = await call('/ready', undefined, socket, { timeoutMs: 2500 })
    const compatible = runner.protocol === RUNNER_PROTOCOL
    return { online: true, runner, compatible, incompatible: !compatible, legacySocket: false }
  } catch (err) {
    if (!['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE'].includes(err.code)) throw err
  }
  for (const legacy of verifiedLegacySockets(socket)) {
    try {
      const runner = await call('/ready', undefined, legacy, { timeoutMs: 2500 })
      const compatible = runner.protocol === RUNNER_PROTOCOL
      return { online: true, runner, compatible, incompatible: !compatible, legacySocket: true }
    } catch (err) {
      if (!['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE'].includes(err.code)) throw err
    }
  }
  return { online: false, runner: null, compatible: true, incompatible: false, legacySocket: false }
}

function assertCompatible(runner) {
  if (runner.protocol !== RUNNER_PROTOCOL) {
    throw new Error('An incompatible broco runner is active. ' + shutdownEffect +
      ' To let that work finish, wait before shutting down. To stop the runner and retry your command, first run:\nbroco shutdown')
  }
  return runner
}

async function handshake(socket = socketPath) {
  try {
    return assertCompatible(await call('/ready', undefined, socket, { timeoutMs: 2500 }))
  } catch (err) {
    if (!['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(err.code)) throw err
    for (const legacy of verifiedLegacySockets(socket)) {
      let legacyRunner = null
      try {
        legacyRunner = await call('/ready', undefined, legacy, { timeoutMs: 2500 })
      } catch (legacyErr) {
        if (!['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE'].includes(legacyErr.code)) throw legacyErr
      }
      if (legacyRunner) return assertCompatible(legacyRunner)
    }
    throw err
  }
}

async function waitSocketDown(sock, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await call('/ready', undefined, sock, { timeoutMs: 300 })
    } catch (err) {
      if (['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(err.code)) return
    }
    await sleep(50)
  }
}

async function stopLegacySocket(sock) {
  let responded = false
  try {
    const reply = await call('/shutdown', { callerPid: process.pid }, sock)
    if (reply?.status !== 'offline') throw new Error('Runner did not confirm shutdown')
    responded = true
  } catch (err) {
    if (!['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(err.code)) throw err
    if (['ECONNRESET', 'EPIPE'].includes(err.code)) responded = true
  }
  if (responded) await waitSocketDown(sock)
  if (!sock.startsWith('\\\\.\\pipe\\')) rmSync(sock, { force: true })
}

function legacyHomeToStop() {
  const explicitLegacy = Boolean(process.env.CC_BRO_HOME)
  const usingDefaultHome = !process.env.BROCO_HOME
  if (!explicitLegacy && !usingDefaultHome) return null
  const legacyDir = legacyCcBroHome()
  return samePath(legacyDir, home) ? null : legacyDir
}

export async function shutdown() {
  let stoppedCurrent = false
  try {
    const reply = await call('/shutdown', { callerPid: process.pid }, socketPath)
    if (reply?.status !== 'offline') throw new Error('Runner did not confirm shutdown')
    stoppedCurrent = true
  } catch (err) {
    if (!['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(err.code)) throw err
    if (['ECONNRESET', 'EPIPE'].includes(err.code)) stoppedCurrent = true
  }
  if (stoppedCurrent && process.platform === 'win32') {
    await waitSocketDown(socketPath, 3000)
  }
  if (!stoppedCurrent) {
    for (const legacy of verifiedLegacySockets(socketPath)) {
      await stopLegacySocket(legacy)
    }
  }
  const legacyDir = legacyHomeToStop()
  if (legacyDir) {
    const legacyBaseSock = socketFor(legacyDir)
    const candidates = [
      ...(isVerifiedSocket(legacyBaseSock) ? [legacyBaseSock] : []),
      ...verifiedLegacySockets(legacyBaseSock)
    ]
    for (const sock of candidates) {
      await stopLegacySocket(sock)
    }
    await platform.removeLegacyService?.(legacyDir)
  }
  await platform.removeService()
}

export async function ready() {
  try { return await handshake() }
  catch (err) { if (!['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE'].includes(err.code)) throw err }
  await platform.startService()
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    await sleep(70)
    try { return await handshake() }
    catch (err) { if (!['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE'].includes(err.code)) throw err }
  }
  throw new Error('Runner did not become ready in ' + home)
}

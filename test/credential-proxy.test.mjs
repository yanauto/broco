import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { call } from '../lib/client.mjs'
import { CredentialProxies, proxyConfig } from '../lib/credential-proxy.mjs'
import { credentialValue } from '../lib/credential-source.mjs'
import { parseCommand } from '../lib/cli-args.mjs'
import { repo, socketFor } from '../lib/paths.mjs'
import { until } from './harness.mjs'

const exec = promisify(execFile)
const secret = 'fixture-' + randomUUID()

async function upstream(t, handler) {
  const server = createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  return 'http://127.0.0.1:' + server.address().port
}

function manager(t) {
  const logs = []
  const proxies = new CredentialProxies(entry => logs.push(entry))
  t.after(() => proxies.closeAll())
  return { proxies, logs }
}

function input(origin, overrides = {}) {
  return { upstream: origin, paths: ['/v1/chat', '/v1/models', '/attestation'], header: 'Authorization', value: secret, valuePrefix: 'Bearer ', maxRequests: 150, ttl: 60, ...overrides }
}

function raw(url, path, headers = {}, options = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, { path, headers, agent: false, method: options.method }, res => {
      let body = ''
      res.setEncoding('utf8').on('data', p => { body += p })
      res.once('end', () => resolve({ status: res.statusCode, body, headers: res.headers }))
      res.once('error', reject)
    })
    req.once('error', reject)
    req.end(options.body)
  })
}

test('credential proxy injects once, strips client headers and preserves body/query with safe logs', async t => {
  const seen = []
  const origin = await upstream(t, async (req, res) => {
    let body = ''
    for await (const part of req) body += part
    seen.push({ headers: req.headers, raw: req.rawHeaders, url: req.url, body })
    if (req.headers.authorization) res.setHeader('Authorization', req.headers.authorization)
    res.end('ok')
  })
  const { proxies, logs } = manager(t)
  const receipt = await proxies.open(input(origin))
  assert.equal(new URL(receipt.url).hostname, '127.0.0.1')
  const result = await raw(receipt.url, '/v1/chat/completions?token=' + secret,
    { Authorization: 'client-secret', 'Content-Type': 'application/json', Connection: 'authorization, x-drop', 'X-Drop': 'no' },
    { method: 'POST', body: '{"stream":true}' })
  assert.equal(result.body, 'ok')
  assert.equal(result.headers.authorization, undefined)
  assert.equal(seen[0].headers.authorization, 'Bearer ' + secret)
  assert.equal(seen[0].raw.filter(h => h.toLowerCase() === 'authorization').length, 1)
  assert.equal(seen[0].headers['x-drop'], undefined)
  assert.equal(seen[0].headers.host, new URL(origin).host)
  assert.equal(seen[0].body, '{"stream":true}')
  assert.equal(seen[0].url, '/v1/chat/completions?token=' + secret)
  assert.equal((await raw(receipt.url, '/v1/chat/' + secret)).status, 200)
  assert.equal(JSON.stringify({ receipt, list: proxies.list(), logs }).includes(secret), false)
  assert.deepEqual(Object.keys(logs[0]).sort(), ['durationMs', 'method', 'path', 'requests', 'status'])
  assert.equal(logs[0].path, '/v1/chat/completions')
  assert.equal(logs[1].path, '/v1/chat/[redacted]')
  assert.equal((await raw(receipt.url, '/v1/models', ['Host', new URL(receipt.url).host, 'Authorization', 'client-one', 'authorization', 'client-two'])).status, 200)
  assert.equal(seen[2].headers.authorization, 'Bearer ' + secret)
  assert.equal(seen[2].raw.filter(h => h.toLowerCase() === 'authorization').length, 1)
  const custom = await proxies.open(input(origin, { header: 'X-API-Key', valuePrefix: '' }))
  assert.equal((await raw(custom.url, '/v1/models', { 'x-api-key': 'client-key' })).status, 200)
  assert.equal(seen[3].headers['x-api-key'], secret)
})

test('credential proxy rejects path escapes and enforces a concurrent request budget', async t => {
  let hits = 0
  const origin = await upstream(t, (req, res) => { hits++; res.end('ok') })
  const { proxies } = manager(t)
  const receipt = await proxies.open(input(origin, { maxRequests: 2 }))
  for (const path of ['/private', '/v1/chatter', '//elsewhere/v1/chat', '/v1/chat/../private', '/v1/chat/%2e%2e/private', '/v1/chat%2fprivate', '/v1/chat/%252e%252e/private', '/v1/chat/\\private', 'http://elsewhere/v1/chat']) {
    assert.equal((await raw(receipt.url, path)).status, 403, path)
  }
  assert.equal(hits, 0)
  const results = await Promise.all(Array.from({ length: 6 }, () => raw(receipt.url, '/v1/models')))
  assert.equal(results.filter(r => r.status === 200).length, 2)
  assert.equal(results.filter(r => r.status === 429 && /limit/.test(r.body)).length, 4)
  assert.equal(hits, 2)
  assert.equal(proxies.list()[0].requests, 2)
})

test('credential proxy refuses all upstream redirects without contacting the destination', async t => {
  let leaked = 0
  const target = await upstream(t, (req, res) => { leaked++; res.end('unexpected') })
  const origin = await upstream(t, (req, res) => { res.writeHead(307, { location: target + '/?key=' + secret }); res.end(secret) })
  const { proxies, logs } = manager(t)
  const receipt = await proxies.open(input(origin))
  const response = await fetch(receipt.url + '/v1/models')
  assert.equal(response.status, 502)
  assert.equal(response.headers.get('location'), null)
  assert.match(await response.text(), /redirects are not allowed/)
  assert.equal(leaked, 0)
  assert.equal(JSON.stringify(logs).includes(secret), false)
})

test('credential proxy streams SSE before upstream finishes and cancels on manager close', async t => {
  let finish
  let upstreamClosed = false
  const origin = await upstream(t, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream')
    res.write('data: first\n\n')
    finish = () => res.end('data: last\n\n')
    res.once('close', () => { upstreamClosed = true })
  })
  const { proxies } = manager(t)
  const receipt = await proxies.open(input(origin))
  const response = await fetch(receipt.url + '/v1/chat')
  const reader = response.body.getReader()
  const first = await reader.read()
  assert.equal(new TextDecoder().decode(first.value), 'data: first\n\n')
  assert.equal(upstreamClosed, false)
  finish()
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: last\n\n')
  assert.equal((await reader.read()).done, true)
  upstreamClosed = false
  const stream = await fetch(receipt.url + '/v1/chat')
  const activeReader = stream.body.getReader()
  await activeReader.read()
  await proxies.close(receipt.id)
  await assert.rejects(activeReader.read())
  await until(() => upstreamClosed)
  await assert.rejects(raw(receipt.url, '/v1/models'), { code: 'ECONNREFUSED' })
  assert.deepEqual(proxies.list(), [])
})

test('expiry rejects late requests and closes the listener and in-flight streams', async t => {
  const origin = await upstream(t, (req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: open\n\n') })
  const { proxies } = manager(t)
  const receipt = await proxies.open(input(origin, { ttl: 1 }))
  const stream = await fetch(receipt.url + '/v1/chat')
  const reader = stream.body.getReader()
  await reader.read()
  const ended = assert.rejects(reader.read())
  await until(() => proxies.list().length === 0)
  await ended
  await assert.rejects(raw(receipt.url, '/v1/models'), { code: 'ECONNREFUSED' })
  await assert.rejects(proxies.close(receipt.id), /Unknown or expired/)
  const late = await proxies.open(input(origin))
  proxies.entries.get(late.id).receipt.expiresAt = Date.now() - 1
  const rejected = await raw(late.url, '/v1/models')
  assert.equal(rejected.status, 410)
  assert.match(rejected.body, /expired/)
})

test('configuration and credential source errors withhold secret output', async () => {
  const base = input('http://127.0.0.1:1')
  for (const changes of [{ maxRequests: 0 }, { ttl: 0 }, { ttl: 2147484 }, { paths: [] }, { paths: ['/a/../b'] }, { header: 'Host' }, { header: 'Connection' }, { upstream: 'https://user:password@example.com' }, { upstream: 'https://example.com/base' }]) {
    assert.throws(() => proxyConfig({ ...base, ...changes }))
  }
  assert.equal(parseCommand(['proxy-open', '--path', '/a', '--path', '/b']).opt.path.length, 2)
  process.env.BROCO_TEST_CREDENTIAL = secret
  assert.equal(await credentialValue({ 'value-env': 'BROCO_TEST_CREDENTIAL' }), secret)
  assert.equal(process.env.BROCO_TEST_CREDENTIAL, undefined)
  await assert.rejects(credentialValue({}), /exactly one/)
  await assert.rejects(credentialValue({ 'value-env': 'MISSING_TEST_CREDENTIAL' }), /empty/)
  process.env.BROCO_TEST_COMMAND_CREDENTIAL = secret
  const cmdOk = '"' + process.execPath + '" -e "process.stdout.write(process.env.BROCO_TEST_COMMAND_CREDENTIAL + \'\\n\')"'
  const cmdFail = '"' + process.execPath + '" -e "process.stderr.write(process.env.BROCO_TEST_COMMAND_CREDENTIAL); process.exit(1)"'
  const cmdMultiline = '"' + process.execPath + '" -e "process.stdout.write(process.env.BROCO_TEST_COMMAND_CREDENTIAL + \'\\nextra\')"'
  try {
    assert.equal(await credentialValue({ 'value-command': cmdOk }), secret)
    await assert.rejects(credentialValue({ 'value-command': cmdFail }), error => !error.message.includes(secret) && /withheld/.test(error.message))
    await assert.rejects(credentialValue({ 'value-command': cmdMultiline }), error => !error.message.includes(secret) && /invalid header/.test(error.message))
  } finally { delete process.env.BROCO_TEST_COMMAND_CREDENTIAL }
})

test('CLI receipts and runner files/logs exclude credentials; shutdown and crash leave no proxy', { timeout: 30000 }, async t => {
  const sandbox = join(repo, '.sandbox')
  mkdirSync(sandbox, { recursive: true })
  const base = mkdtempSync(join(sandbox, 'proxy-'))
  const data = join(base, 'data')
  const socket = socketFor(data)
  const env = { ...process.env, BROCO_HOME: data, BROCO_PORT: '0', BROCO_TZ: 'UTC' }
  let runner
  let output = ''
  const start = async () => {
    runner = spawn(process.execPath, [join(repo, 'lib/runner.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    runner.stdout.on('data', p => { output += p })
    runner.stderr.on('data', p => { output += p })
    await until(async () => (await call('/ready', undefined, socket).catch(() => null))?.pid === runner.pid)
  }
  t.after(async () => {
    if (runner?.exitCode === null && runner?.signalCode === null) {
      const closed = once(runner, 'close')
      runner.kill('SIGKILL')
      await closed
    }
    rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  })
  const cli = async (...args) => {
    const result = await exec(process.execPath, [join(repo, 'bin/broco'), ...args], { cwd: base, env: { ...env, BROCO_TEST_CREDENTIAL: secret }, timeout: 10000 })
    output += result.stderr
    assert.equal(result.stdout.includes(secret), false)
    return JSON.parse(result.stdout)
  }
  const origin = await upstream(t, (req, res) => { assert.equal(req.headers.authorization, 'Bearer ' + secret); res.end('ok') })
  const args = ['proxy-open', '--upstream', origin, '--path', '/v1/models', '--header', 'Authorization', '--value-prefix', 'Bearer ', '--max-requests', '150', '--ttl', '60', '--json']
  await start()
  const receipt = await cli(...args, '--value-env', 'BROCO_TEST_CREDENTIAL')
  assert.equal((await raw(receipt.url, '/v1/models')).status, 200)
  assert.equal((await cli('proxy-list', '--json'))[0].requests, 1)
  assert.equal((await cli('proxy-close', receipt.id, '--json')).status, 'closed')
  await assert.rejects(raw(receipt.url, '/v1/models'))
  const valueCmd = '"' + process.execPath + '" -e "process.stdout.write(process.env.BROCO_TEST_CREDENTIAL)"'
  const commandReceipt = await cli(...args, '--value-command', valueCmd)
  assert.equal((await raw(commandReceipt.url, '/v1/models')).status, 200)
  if (process.platform !== 'win32') {
    const ps = await exec('/bin/ps', ['-p', String(runner.pid), '-o', 'command='])
    assert.equal(ps.stdout.includes(secret), false)
  }
  for (const file of readdirSync(data, { recursive: true, withFileTypes: true })) {
    if (file.isFile()) assert.equal(readFileSync(join(file.parentPath, file.name)).includes(Buffer.from(secret)), false, file.name)
  }
  assert.equal(output.includes(secret), false)
  const stopped = once(runner, 'close')
  await call('/shutdown', {}, socket)
  await stopped
  await assert.rejects(raw(commandReceipt.url, '/v1/models'))
  await start()
  assert.deepEqual(await cli('proxy-list', '--json'), [])
  const crashed = await cli(...args, '--value-env', 'BROCO_TEST_CREDENTIAL')
  const killed = once(runner, 'close')
  runner.kill('SIGKILL')
  await killed
  await assert.rejects(raw(crashed.url, '/v1/models'))
  await start()
  assert.deepEqual(await cli('proxy-list', '--json'), [])
})

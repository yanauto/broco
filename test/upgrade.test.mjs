import assert from 'node:assert/strict'
import { once } from 'node:events'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { call, legacySocketFor, legacySocketsFor } from '../lib/client.mjs'
import { socketFor } from '../lib/paths.mjs'
import { harness } from './harness.mjs'

for (const [release, protocol] of [['0.1.0', 4], ['M2', 6], ['0.2.0', 7], ['0.3.0', 8], ['0.3.1', 9], ['pre-integration task/directory branches', 10], ['task/directory integration', 11], ['0.3.1 credential-proxy', 12], ['0.4.0', 13], ['0.4.1', 14]]) {
  test('upgrade from ' + release + ': guard normal commands, allow graceful shutdown, then start the new runner', async t => {
    const h = harness(t)
    const socket = socketFor(h.data)
    const requests = []
    let canStop = false
    const server = createServer(async (req, res) => {
      requests.push([req.method, req.url])
      if (req.url === '/ready') return res.end(JSON.stringify({ protocol, pid: process.pid }))
      if (req.url === '/shutdown' && canStop) {
        server.close()
        return res.end(JSON.stringify({ status: 'offline' }))
      }
      res.writeHead(400)
      res.end(JSON.stringify({ error: 'Worker cleanup failed' }))
    })
    server.listen(socket)
    await once(server, 'listening')
    try {
      for (const args of [['init', '--allow', 'codex'], ['say', 'job', 'text', '--cwd', h.cwd], ['ls']]) {
        await assert.rejects(h.cli(...args), err => {
          assert.match(err.stderr, /running and queued work/)
          assert.match(err.stderr.trim(), /\nbroco shutdown$/)
          return true
        })
      }
      assert.deepEqual(requests, Array(3).fill(['GET', '/ready']))
      await assert.rejects(h.cli('shutdown'), /Worker cleanup failed/)
      canStop = true
      assert.equal(await h.cli('shutdown'), 'Runner stopped')
      assert.deepEqual(requests.slice(3), Array(2).fill(['POST', '/shutdown']))
      await h.cli('shutdown')
      assert.equal(existsSync(join(h.data, 'runner.plist')), false)
      await h.cli('init', '--allow', 'codex')
      assert.equal((await call('/ready', undefined, socket)).protocol, 15)
      assert.deepEqual(await h.json('ls'), [])
    } finally {
      if (server.listening) await new Promise(resolve => server.close(resolve))
    }
  })
}

test('upgrade from 0.4.0 legacy /tmp/cc-bro-<uid>-<key>.sock guards active work, reports status, and shuts down cleanly', async t => {
  const h = harness(t)
  const newSocket = socketFor(h.data)
  const legacySocket = legacySocketFor(newSocket)
  assert.ok(legacySocket)
  rmSync(legacySocket, { force: true })
  const requests = []
  const server = createServer((req, res) => {
    requests.push([req.method, req.url])
    if (req.url === '/ready') return res.end(JSON.stringify({ protocol: 13, pid: process.pid }))
    if (req.url === '/shutdown') {
      server.close()
      return res.end(JSON.stringify({ status: 'offline' }))
    }
    res.writeHead(400)
    res.end(JSON.stringify({ error: 'unexpected' }))
  })
  server.listen(legacySocket)
  await once(server, 'listening')
  try {
    await assert.rejects(h.cli('ls'), err => {
      assert.match(err.stderr, /incompatible broco runner is active/)
      return true
    })
    assert.equal(existsSync(newSocket), false)

    const statusJson = await h.json('status')
    assert.equal(statusJson.runner.online, true)
    assert.equal(statusJson.runner.compatible, false)
    assert.equal(statusJson.runner.incompatible, true)
    assert.equal(statusJson.runner.protocol, 13)
    assert.equal(statusJson.runner.legacySocket, true)
    assert.match(await h.cli('status'), /incompatible protocol 13/)

    assert.equal(await h.cli('shutdown'), 'Runner stopped')
    assert.ok(requests.some(([m, u]) => m === 'POST' && u === '/shutdown'))
    assert.equal(existsSync(legacySocket), false)

    await h.cli('init', '--allow', 'codex')
    assert.equal((await call('/ready', undefined, newSocket)).protocol, 15)
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve))
    rmSync(legacySocket, { force: true })
  }
})

test('upgrade from 0.4.1 legacy /tmp/cc-bro-<uid>/s-<key>.sock shuts down cleanly', async t => {
  const h = harness(t)
  const newSocket = socketFor(h.data)
  const legacyDirSocket = legacySocketsFor(newSocket)[0]
  assert.ok(legacyDirSocket)
  mkdirSync(dirname(legacyDirSocket), { recursive: true, mode: 0o700 })
  rmSync(legacyDirSocket, { force: true })
  const requests = []
  const server = createServer((req, res) => {
    requests.push([req.method, req.url])
    if (req.url === '/ready') return res.end(JSON.stringify({ protocol: 14, pid: process.pid }))
    if (req.url === '/shutdown') {
      server.close()
      return res.end(JSON.stringify({ status: 'offline' }))
    }
    res.writeHead(400)
    res.end(JSON.stringify({ error: 'unexpected' }))
  })
  server.listen(legacyDirSocket)
  await once(server, 'listening')
  try {
    const statusJson = await h.json('status')
    assert.equal(statusJson.runner.online, true)
    assert.equal(statusJson.runner.incompatible, true)
    assert.equal(statusJson.runner.protocol, 14)
    assert.equal(statusJson.runner.legacySocket, true)
    assert.equal(await h.cli('shutdown'), 'Runner stopped')
    assert.ok(requests.some(([m, u]) => m === 'POST' && u === '/shutdown'))
    assert.equal(existsSync(legacyDirSocket), false)
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve))
    rmSync(legacyDirSocket, { force: true })
  }
})

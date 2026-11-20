import { createReadStream, existsSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'
import { batchDetail, listBatches } from './map.mjs'
import { checkout, home, repo } from './paths.mjs'

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webp': 'image/webp'
}

function defaultDist() {
  const devDist = join(repo, 'ui', 'dist')
  const bundled = join(repo, 'bundle', 'board')
  if (checkout) return existsSync(devDist) ? devDist : (existsSync(bundled) ? bundled : devDist)
  return bundled
}

function fail(status, code, message) {
  throw Object.assign(new Error(message), { status, code })
}

function decode(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    fail(400, 'INVALID_PATH', 'Invalid URL encoding')
  }
}

function projectOf(projects, id) {
  try {
    return projects.get(id)
  } catch (err) {
    if (/^Unknown project\b/i.test(err?.message || '')) fail(404, 'PROJECT_NOT_FOUND', err.message)
    throw err
  }
}

function json(res, value, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(value))
}

async function body(req) {
  const chunks = []
  let bytes = 0
  for await (const part of req) {
    const buf = Buffer.isBuffer(part) ? part : Buffer.from(part)
    bytes += buf.length
    if (bytes > 256 * 1024) fail(413, 'BODY_TOO_LARGE', 'Settings exceed 256 KiB')
    chunks.push(buf)
  }
  const text = chunks.length ? Buffer.concat(chunks, bytes).toString('utf8') : ''
  try {
    return JSON.parse(text || '{}')
  } catch {
    fail(400, 'INVALID_JSON', 'Invalid JSON body')
  }
}

export class Web {
  constructor(projects, { dist = defaultDist(), port = Number(process.env.BROCO_PORT ?? 4517) } = {}) {
    this.projects = projects
    this.dist = dist
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid BROCO_PORT')
    this.port = port
    this.boundPort = null
    this.streams = new Set()
    this.server = createServer((req, res) => {
      this.route(req, res).catch(err => {
        if (res.headersSent) return res.destroy()
        const missingProject = !err.status && /^Unknown project\b/i.test(err?.message || '')
        const status = missingProject ? 404 : (err.status || 400)
        const code = missingProject ? 'PROJECT_NOT_FOUND' : (err.code || 'REQUEST_FAILED')
        json(res, { error: { code, message: err.message } }, status)
      })
    })
  }

  hasSubscribers() {
    return this.streams.size > 0
  }

  start() {
    this.starting ??= this.listen().catch(err => { this.starting = null; throw err })
    return this.starting
  }

  async listen() {
    for (let port = this.port; port <= 65535; port++) {
      try {
        await new Promise((ok, bad) => {
          const error = err => { this.server.off('listening', listening); bad(err) }
          const listening = () => { this.server.off('error', error); ok() }
          this.server.once('error', error).once('listening', listening).listen(port, '127.0.0.1')
        })
        this.boundPort = this.server.address().port
        this.origin = 'http://127.0.0.1:' + this.boundPort
        return this.origin
      } catch (err) { if (err.code !== 'EADDRINUSE') throw err }
    }
    throw new Error('No available loopback port')
  }

  validHost(host) {
    if (!host || this.boundPort === null) return false
    return host === '127.0.0.1:' + this.boundPort || host === 'localhost:' + this.boundPort
  }

  validOrigin(origin) {
    if (!origin || this.boundPort === null) return false
    return origin === 'http://127.0.0.1:' + this.boundPort || origin === 'http://localhost:' + this.boundPort
  }

  publish(event) {
    if (!this.streams.size) return
    const frame = 'data: ' + JSON.stringify(event) + '\n\n'
    for (const res of this.streams) {
      if (res.destroyed || res.writableEnded) {
        this.streams.delete(res)
        continue
      }
      if (res.writableLength > 1024 * 1024) {
        this.streams.delete(res)
        res.destroy()
      } else {
        res.write(frame)
      }
    }
  }

  stream(res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    res.write('data: ' + JSON.stringify({ type: 'hello', projects: this.projects.list() }) + '\n\n')
    this.streams.add(res)
    const heartbeat = setInterval(() => {
      if (!res.destroyed && !res.writableEnded) res.write(': keepalive\n\n')
    }, 15000)
    heartbeat.unref?.()
    res.on('close', () => { clearInterval(heartbeat); this.streams.delete(res) })
  }

  async route(req, res) {
    if (!this.validHost(req.headers.host)) fail(403, 'INVALID_HOST', 'Use the local broco address')
    const method = req.method
    if (['POST', 'DELETE'].includes(method) && !this.validOrigin(req.headers.origin)) {
      fail(403, 'INVALID_ORIGIN', 'This action must come from this broco page')
    }
    const url = new URL(req.url, this.origin)
    const path = url.pathname
    if (!path.startsWith('/api/')) {
      if (!['HEAD', 'GET'].includes(method)) fail(405, 'METHOD_NOT_ALLOWED', 'Unsupported method')
      return this.static(req, res, path)
    }
    const [, , group, rawId, rawResource, rawTicket, ...extra] = path.split('/')
    if (extra.length) fail(404, 'NOT_FOUND', 'Unknown endpoint')
    if (path === '/api/stream' && method === 'GET') return this.stream(res)
    if (path === '/api/projects' && method === 'GET') return json(res, this.projects.list())
    const roster = this.projects.roster
    const scope = rawId ? decode(rawId) : ''
    const resource = rawResource ? decode(rawResource) : ''
    if (group === 'settings' && scope && !resource) {
      if (scope !== 'global') projectOf(this.projects, scope)
      if (method === 'GET') return json(res, roster.config(scope))
      if (method === 'POST') return json(res, roster.save(scope, await body(req), 'user'))
    }
    if (group === 'roster' && scope && !resource && method === 'GET') {
      if (scope !== 'global') projectOf(this.projects, scope)
      return json(res, await roster.list(scope, true, { refresh: url.searchParams.get('refresh') === '1' }))
    }
    if (group === 'audit' && scope && !resource && method === 'GET') {
      if (scope !== 'global' && scope !== 'all') projectOf(this.projects, scope)
      return json(res, roster.auditList(scope, Number(url.searchParams.get('limit') || 30)))
    }
    if (group === 'audit' && scope && resource === 'undo' && !rawTicket && method === 'POST') {
      if (scope !== 'global' && scope !== 'all') projectOf(this.projects, scope)
      const input = await body(req)
      return json(res, roster.undoAudit(input.id ?? input.auditId ?? null, { scope, actor: input.actor || 'user' }))
    }
    if (group === 'templates' && scope && resource === 'test' && !rawTicket && method === 'POST') {
      if (scope !== 'global') projectOf(this.projects, scope)
      const input = await body(req)
      return json(res, await roster.trial(scope, input.template, input.model, input.effort))
    }
    if (group === 'notes' && scope && resource && !rawTicket && method === 'POST') {
      const input = await body(req)
      if (typeof input.accept !== 'boolean') fail(400, 'INVALID_INPUT', 'Expected accept: true or false')
      return json(res, roster.resolveProposal(scope, resource, input.accept))
    }
    if (group === 'cli' && scope && resource && !rawTicket && method === 'POST') {
      const input = await body(req)
      const cwd = input.projectId ? projectOf(this.projects, input.projectId).repoPath : home
      return json(res, await roster.terminal(scope, resource, cwd, input.projectId ?? 'global'))
    }
    if (group === 'projects' && scope) {
      const p = projectOf(this.projects, scope)
      if (resource === 'tickets' && method === 'GET') {
        if (!rawTicket) return json(res, p.crew.store.ticketRows())
        const ticket = p.crew.store.detail(decode(rawTicket))
        if (!ticket) fail(404, 'TICKET_NOT_FOUND', 'Ticket not found')
        return json(res, ticket)
      }
      if (resource === 'batches' && method === 'GET') {
        if (!rawTicket) return json(res, listBatches(p.crew.store))
        const batch = batchDetail(p.crew.store, decode(rawTicket))
        if (!batch) fail(404, 'BATCH_NOT_FOUND', 'Batch not found')
        return json(res, batch)
      }
    }
    fail(404, 'NOT_FOUND', 'Unknown endpoint')
  }

  async static(req, res, path) {
    let root
    try { root = await realpath(this.dist) }
    catch (err) {
      if (err.code !== 'ENOENT') throw err
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' })
      return res.end('broco is running. Build ui/dist to open the board.')
    }
    const decoded = decode(path)
    let file = resolve(root, '.' + decoded)
    if (file !== root && !file.startsWith(root + sep)) fail(404, 'NOT_FOUND', 'File not found')
    const isSpaEntry = file === root || !extname(file)
    if (isSpaEntry) file = join(root, 'index.html')
    try { file = await realpath(file) } catch { fail(404, 'NOT_FOUND', 'File not found') }
    const info = await stat(file)
    if (!file.startsWith(root + sep) || !info.isFile()) fail(404, 'NOT_FOUND', 'File not found')
    const ext = extname(file).toLowerCase()
    const cacheControl = !isSpaEntry && ext !== '.html' && decoded.startsWith('/assets/')
      ? 'public, max-age=31536000, immutable'
      : 'no-cache'
    res.writeHead(200, {
      'Content-Type': mime[ext] || 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': cacheControl,
      'X-Content-Type-Options': 'nosniff'
    })
    if (req.method === 'HEAD') return res.end()
    createReadStream(file).on('error', () => res.destroy()).pipe(res)
  }

  async close() {
    this.starting = null
    this.boundPort = null
    for (const stream of this.streams) stream.end()
    this.streams.clear()
    if (this.server.listening) await new Promise(ok => this.server.close(ok))
  }
}

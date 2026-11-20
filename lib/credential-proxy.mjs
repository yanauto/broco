import { randomUUID } from 'node:crypto'
import { createServer, request as httpRequest, validateHeaderName, validateHeaderValue } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { performance } from 'node:perf_hooks'

const hopHeaders = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])
const forbiddenHeaders = new Set([...hopHeaders, 'host', 'content-length', 'expect'])

function pathOf(target) {
  if (typeof target !== 'string' || !target.startsWith('/') || target.startsWith('//') || target.includes('#')) return null
  const path = target.split('?')[0]
  try {
    const decoded = decodeURIComponent(path)
    const segments = decoded.slice(1).split('/')
    if (segments.at(-1) === '') segments.pop()
    if (/[\\%\x00-\x20\x7f]/.test(decoded) || /%2f/i.test(path) || segments.some(p => !p || p === '.' || p === '..')) return null
    return decoded
  } catch { return null }
}

export function proxyConfig(input) {
  let upstream
  try { upstream = new URL(input.upstream) } catch { throw new Error('Expected an HTTP(S) upstream origin') }
  if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password || upstream.pathname !== '/' || upstream.search || upstream.hash) throw new Error('Upstream must be an HTTP(S) origin without credentials, path, query or fragment')
  if (!Array.isArray(input.paths) || !input.paths.length || input.paths.some(p => p === '/' || pathOf(p) !== p || p.includes('?'))) throw new Error('Provide canonical absolute path prefixes with --path (repeatable)')
  let header
  try { validateHeaderName(input.header); header = input.header.toLowerCase() } catch { throw new Error('Expected a valid injection header name') }
  if (forbiddenHeaders.has(header)) throw new Error('Cannot inject a routing or hop-by-hop header')
  const maxRequests = Number(input.maxRequests)
  const ttl = Number(input.ttl)
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1) throw new Error('--max-requests must be a positive integer')
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 2147483) throw new Error('--ttl must be an integer from 1 to 2147483 seconds')
  return { upstream, paths: [...input.paths], header, maxRequests, ttl }
}

function headersWithoutHop(headers, injected) {
  const blocked = new Set([...hopHeaders, injected, ...(headers.connection || '').toLowerCase().split(',').map(h => h.trim())])
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !blocked.has(name)))
}

function fail(res, status, error) {
  if (res.headersSent) return res.destroy()
  res.writeHead(status, { 'content-type': 'application/json', connection: 'close' })
  res.end(JSON.stringify({ error }))
}

export class CredentialProxies {
  constructor(log = entry => console.log(JSON.stringify(entry))) {
    this.entries = new Map()
    this.log = log
    this.closed = false
  }

  list() { return [...this.entries.values()].map(entry => ({ ...entry.receipt })) }

  async open(input) {
    if (this.closed) throw new Error('Credential proxies are shutting down')
    const config = proxyConfig(input)
    let secret = input.value
    try {
      if (typeof secret !== 'string' || !secret) throw new Error()
      validateHeaderValue(config.header, (input.valuePrefix || '') + secret)
    } catch { throw new Error('Invalid credential value (output withheld)') }
    const receipt = { id: randomUUID(), url: null, expiresAt: Date.now() + config.ttl * 1000, maxRequests: config.maxRequests, requests: 0 }
    let injected = (input.valuePrefix || '') + secret
    const active = new Map()
    const sockets = new Set()
    let closed = false
    const server = createServer((req, res) => {
      const started = performance.now()
      const path = pathOf(req.url)
      const safe = value => secret ? value.split(secret).join('[redacted]').split(encodeURIComponent(secret)).join('[redacted]') : value
      const logPath = safe(path || '[invalid path]')
      const logMethod = safe(req.method)
      let logged = false
      const log = () => {
        if (logged) return
        logged = true
        this.log({ method: logMethod, path: logPath, status: res.statusCode, durationMs: Math.round(performance.now() - started), requests: receipt.requests })
      }
      res.once('finish', log)
      res.once('close', log)
      if (closed || Date.now() >= receipt.expiresAt) return fail(res, 410, 'Credential proxy expired or closed')
      if (!path || !config.paths.some(prefix => path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : prefix + '/'))) return fail(res, 403, 'Path is not allowed')
      if (receipt.requests >= receipt.maxRequests) return fail(res, 429, 'Credential proxy request limit reached')
      receipt.requests++
      const headers = headersWithoutHop(req.headers, config.header)
      delete headers.expect
      headers.host = config.upstream.host
      headers[config.header] = injected
      const queryIndex = req.url.indexOf('?')
      const upstreamPath = encodeURI(path) + (queryIndex >= 0 ? req.url.slice(queryIndex) : '')
      const request = config.upstream.protocol === 'https:' ? httpsRequest : httpRequest
      const upstream = request(config.upstream, { method: req.method, path: upstreamPath, headers, agent: false, timeout: 60000 }, response => {
        if (response.statusCode >= 300 && response.statusCode < 400) {
          fail(res, 502, 'Upstream redirects are not allowed')
          response.destroy()
          return
        }
        const responseHeaders = headersWithoutHop(response.headers, config.header)
        for (const [key, value] of Object.entries(responseHeaders)) {
          if (JSON.stringify(value).includes(secret)) delete responseHeaders[key]
        }
        res.writeHead(response.statusCode, responseHeaders)
        res.flushHeaders()
        response.once('error', () => fail(res, 502, 'Upstream response failed'))
        response.pipe(res)
      })
      active.set(upstream, res)
      upstream.once('timeout', () => { fail(res, 504, 'Upstream request timed out'); upstream.destroy() })
      upstream.once('error', () => fail(res, 502, 'Upstream request failed'))
      upstream.once('close', () => active.delete(upstream))
      req.once('error', () => upstream.destroy())
      res.once('close', () => upstream.destroy())
      req.pipe(upstream)
    })
    server.on('connection', socket => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
    })
    server.on('connect', (req, socket) => socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n'))
    server.on('upgrade', (req, socket) => socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n'))
    await new Promise((resolve, reject) => {
      server.once('error', () => reject(new Error('Could not listen on credential proxy loopback port')))
      server.listen(0, '127.0.0.1', resolve)
    })
    receipt.url = 'http://127.0.0.1:' + server.address().port
    let timer
    const close = async () => {
      if (closed) return
      closed = true
      clearTimeout(timer)
      this.entries.delete(receipt.id)
      const done = new Promise(resolve => server.close(resolve))
      for (const [upstream, res] of active) {
        fail(res, 410, 'Credential proxy expired or closed')
        upstream.destroy()
      }
      for (const socket of sockets) socket.destroy()
      await done
      secret = ''
      injected = ''
    }
    if (this.closed) {
      await close()
      throw new Error('Credential proxies are shutting down')
    }
    this.entries.set(receipt.id, { receipt, close })
    timer = setTimeout(close, Math.max(1, receipt.expiresAt - Date.now()))
    timer.unref?.()
    return { ...receipt }
  }

  async close(id) {
    const entry = this.entries.get(id)
    if (!entry) throw new Error('Unknown or expired credential proxy')
    await entry.close()
    return { id: entry.receipt.id, status: 'closed' }
  }

  async closeAll() {
    this.closed = true
    await Promise.all([...this.entries.values()].map(entry => entry.close()))
  }
}

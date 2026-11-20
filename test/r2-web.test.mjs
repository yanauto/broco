import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Web } from '../lib/web.mjs'
import { home, repo } from '../lib/paths.mjs'
import { harness } from './harness.mjs'

function sendChunked(url, { method = 'POST', headers = {}, bodyBuffer, chunkSize = 1 }) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const req = httpRequest({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method,
      headers
    }, res => {
      const parts = []
      res.on('data', d => parts.push(d))
      res.on('end', () => {
        const raw = Buffer.concat(parts).toString('utf8')
        let data = null
        try { data = JSON.parse(raw) } catch {}
        resolve({ status: res.statusCode, headers: res.headers, raw, data })
      })
    })
    req.on('error', reject)
    if (bodyBuffer) {
      for (let i = 0; i < bodyBuffer.length; i += chunkSize) {
        req.write(bodyBuffer.subarray(i, i + chunkSize))
      }
    }
    req.end()
  })
}

test('Web lifecycle, hasSubscribers, SSE frames, close+restart, static Cache-Control, Host/Origin and cli cwd fallback', async t => {
  const distDir = mkdtempSync(join(tmpdir(), 'broco-web-dist-'))
  mkdirSync(join(distDir, 'assets'), { recursive: true })
  mkdirSync(join(distDir, 'fonts'), { recursive: true })
  writeFileSync(join(distDir, 'index.html'), '<!doctype html><title>broco</title>')
  writeFileSync(join(distDir, 'favicon.ico'), Buffer.from([0, 0, 1, 0, 1, 0]))
  writeFileSync(join(distDir, 'broco-board-icon-128.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  writeFileSync(join(distDir, 'fonts', 'instrument-sans-latin.woff2'), Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00, 0x01]))
  writeFileSync(join(distDir, 'assets', 'index-abc123.js'), 'console.log(1)')
  writeFileSync(join(distDir, 'assets', 'index-abc123.css'), 'body{}')

  const terminalCalls = []
  let savedPayload = null
  const mockProjects = {
    list: () => [{ id: 'p1', name: 'demo' }],
    get(id) {
      if (id === 'p1') return { id: 'p1', repoPath: '/tmp/demo-repo' }
      throw new Error('Unknown project ID; check BROCO_HOME and run broco init')
    },
    roster: {
      config: scope => ({ scope, revision: 1, allow: ['codex'], worker: 'codex', rules: savedPayload?.rules ?? [] }),
      save: (scope, body) => { savedPayload = body; return { scope, revision: 2, rules: body.rules } },
      list: async scope => ({ projectId: scope, workers: [] }),
      auditList: () => [],
      terminal: async (id, action, cwd, scope) => {
        terminalCalls.push({ id, action, cwd, scope })
        return { status: 'opened', id, action, cwd, scope }
      }
    }
  }

  const web = new Web(mockProjects, { dist: distDir, port: 0 })
  t.after(async () => {
    await web.close()
    rmSync(distDir, { recursive: true, force: true })
  })

  assert.equal(web.hasSubscribers(), false)
  const origin = await web.start()
  const port = new URL(origin).port

  const rootRes = await fetch(origin + '/')
  assert.equal(rootRes.status, 200)
  assert.equal(rootRes.headers.get('cache-control'), 'no-cache')
  assert.equal(rootRes.headers.get('x-content-type-options'), 'nosniff')

  const spaRes = await fetch(origin + '/board-view')
  assert.equal(spaRes.status, 200)
  assert.equal(spaRes.headers.get('cache-control'), 'no-cache')

  const assetRes = await fetch(origin + '/assets/index-abc123.js')
  assert.equal(assetRes.status, 200)
  assert.equal(assetRes.headers.get('cache-control'), 'public, max-age=31536000, immutable')

  const icoRes = await fetch(origin + '/favicon.ico')
  assert.equal(icoRes.status, 200)
  assert.equal(icoRes.headers.get('content-type'), 'image/x-icon')
  assert.equal(icoRes.headers.get('content-length'), '6')
  assert.equal(icoRes.headers.get('x-content-type-options'), 'nosniff')

  const pngRes = await fetch(origin + '/broco-board-icon-128.png')
  assert.equal(pngRes.status, 200)
  assert.equal(pngRes.headers.get('content-type'), 'image/png')
  assert.equal(pngRes.headers.get('content-length'), '4')

  const pngHead = await fetch(origin + '/broco-board-icon-128.png', { method: 'HEAD' })
  assert.equal(pngHead.status, 200)
  assert.equal(pngHead.headers.get('content-type'), 'image/png')
  assert.equal(pngHead.headers.get('content-length'), '4')

  const woff2Res = await fetch(origin + '/fonts/instrument-sans-latin.woff2')
  assert.equal(woff2Res.status, 200)
  assert.equal(woff2Res.headers.get('content-type'), 'font/woff2')
  assert.equal(woff2Res.headers.get('content-length'), '6')
  assert.equal((await woff2Res.arrayBuffer()).byteLength, 6)

  const localhostOrigin = `http://localhost:${port}`
  const localGet = await fetch(localhostOrigin + '/api/projects')
  assert.equal(localGet.status, 200)
  assert.deepEqual(await localGet.json(), [{ id: 'p1', name: 'demo' }])

  const badHost = await sendChunked(origin + '/api/projects', {
    method: 'GET',
    headers: { host: 'evil.example:' + port }
  })
  assert.equal(badHost.status, 403)
  assert.equal(badHost.data.error.code, 'INVALID_HOST')

  const badOrigin = await fetch(origin + '/api/settings/global', {
    method: 'POST',
    headers: { Origin: 'http://localhost:9999', 'Content-Type': 'application/json' },
    body: '{}'
  })
  assert.equal(badOrigin.status, 403)
  assert.equal((await badOrigin.json()).error.code, 'INVALID_ORIGIN')

  const localhostPost = await fetch(localhostOrigin + '/api/cli/codex/upgrade', {
    method: 'POST',
    headers: { Origin: localhostOrigin, 'Content-Type': 'application/json' },
    body: '{}'
  })
  assert.equal(localhostPost.status, 200)
  assert.deepEqual(terminalCalls[0], { id: 'codex', action: 'upgrade', cwd: home, scope: 'global' })

  const utf8Rule = '严禁写注释 · 保持 UTF-8 多字节完整性 🚀 テスト'
  const payloadBuf = Buffer.from(JSON.stringify({ revision: 1, rules: [utf8Rule] }), 'utf8')
  const chunkedRes = await sendChunked(origin + '/api/settings/global', {
    method: 'POST',
    headers: {
      host: '127.0.0.1:' + port,
      origin,
      'content-type': 'application/json'
    },
    bodyBuffer: payloadBuf,
    chunkSize: 1
  })
  assert.equal(chunkedRes.status, 200)
  assert.deepEqual(chunkedRes.data.rules, [utf8Rule])
  assert.equal(chunkedRes.data.rules[0].includes('\uFFFD'), false)

  const invalidJson = await fetch(origin + '/api/settings/global', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: '{broken-json'
  })
  assert.equal(invalidJson.status, 400)
  assert.equal((await invalidJson.json()).error.code, 'INVALID_JSON')

  const tooLarge = await fetch(origin + '/api/settings/global', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ pad: 'x'.repeat(270 * 1024) })
  })
  assert.equal(tooLarge.status, 413)
  assert.equal((await tooLarge.json()).error.code, 'BODY_TOO_LARGE')

  const badEncoding = await fetch(origin + '/api/projects/%E0%A4%A/tickets')
  assert.equal(badEncoding.status, 400)
  assert.equal((await badEncoding.json()).error.code, 'INVALID_PATH')

  for (const unknownPath of ['/api/settings/missing', '/api/roster/missing', '/api/audit/missing']) {
    const r = await fetch(origin + unknownPath)
    assert.equal(r.status, 404, unknownPath)
    assert.equal((await r.json()).error.code, 'PROJECT_NOT_FOUND')
  }

  const sseController = new AbortController()
  const sseRes = await fetch(origin + '/api/stream', { signal: sseController.signal })
  assert.equal(sseRes.status, 200)
  assert.equal(web.hasSubscribers(), true)
  const reader = sseRes.body.getReader()
  const decoder = new TextDecoder()
  const firstChunk = decoder.decode((await reader.read()).value)
  assert.match(firstChunk, /"type":"hello"/)

  web.publish({ type: 'tickets', projectId: 'p1', tickets: [{ id: 'a' }, { id: 'b' }] })
  const secondChunk = decoder.decode((await reader.read()).value)
  assert.match(secondChunk, /"type":"tickets"/)

  sseController.abort()
  await new Promise(r => setTimeout(r, 40))
  assert.equal(web.hasSubscribers(), false)

  await web.close()
  const restartedOrigin = await web.start()
  const checkRestart = await fetch(restartedOrigin + '/api/projects')
  assert.equal(checkRestart.status, 200)
})

test('Web exposes GET /api/projects/:id/batches and /batches/:prefix and 404s missing resources', async t => {
  const h = harness(t)
  const p = await h.json('init', '--allow', 'codex')
  await h.json('map', 'audit', '--brief', 'Inspect {input}', '--inputs', 'alpha,beta')
  const url = await h.cli('ui', '--no-open')

  const batchesRes = await fetch(`${url}/api/projects/${p.id}/batches`)
  assert.equal(batchesRes.status, 200)
  const batches = await batchesRes.json()
  assert.equal(batches.length, 1)
  assert.equal(batches[0].prefix, 'audit')
  assert.equal(batches[0].count, 2)
  assert.equal(batches[0].shards.length, 2)

  const detailRes = await fetch(`${url}/api/projects/${p.id}/batches/audit`)
  assert.equal(detailRes.status, 200)
  const detail = await detailRes.json()
  assert.equal(detail.isBatch, true)
  assert.equal(detail.prefix, 'audit')
  assert.deepEqual(detail.shards.map(s => s.input), ['alpha', 'beta'])

  const missingBatch = await fetch(`${url}/api/projects/${p.id}/batches/unknown`)
  assert.equal(missingBatch.status, 404)
  assert.equal((await missingBatch.json()).error.code, 'BATCH_NOT_FOUND')

  const missingTicket = await fetch(`${url}/api/projects/${p.id}/tickets/unknown`)
  assert.equal(missingTicket.status, 404)
  assert.equal((await missingTicket.json()).error.code, 'TICKET_NOT_FOUND')

  const missingProject = await fetch(`${url}/api/projects/unknown-proj/batches`)
  assert.equal(missingProject.status, 404)
  assert.equal((await missingProject.json()).error.code, 'PROJECT_NOT_FOUND')
})

test('Packaged broco board serves HTML, favicon.ico, and PNG brand icons with expected MIME types', async t => {
  const uiHtml = readFileSync(join(repo, 'ui', 'index.html'), 'utf8')
  assert.match(uiHtml, /<title>broco<\/title>/)
  assert.match(uiHtml, /favicon\.ico/)
  for (const name of ['favicon.ico', 'broco-board-icon-128.png', 'broco-favicon-32.png', 'broco-favicon-64.png', 'broco-foreman-256.png', join('fonts', 'instrument-sans-latin.woff2'), join('fonts', 'jetbrains-mono-latin.woff2')]) {
    assert.equal(existsSync(join(repo, 'ui', 'public', name)), true, `missing ui/public/${name}`)
  }

  const bundleDir = join(repo, 'bundle', 'board')
  if (!existsSync(join(bundleDir, 'index.html'))) return

  const mockProjects = {
    list: () => [],
    get() { throw new Error('Unknown project') },
    roster: {}
  }
  const web = new Web(mockProjects, { dist: bundleDir, port: 0 })
  t.after(() => web.close())
  const origin = await web.start()

  const htmlRes = await fetch(origin + '/')
  assert.equal(htmlRes.status, 200)
  assert.equal(htmlRes.headers.get('content-type'), 'text/html; charset=utf-8')
  const html = await htmlRes.text()
  assert.match(html, /<title>broco<\/title>/)

  const iconChecks = [
    ['/favicon.ico', 'image/x-icon'],
    ['/broco-board-icon-128.png', 'image/png'],
    ['/broco-favicon-32.png', 'image/png'],
    ['/broco-favicon-64.png', 'image/png'],
    ['/broco-foreman-256.png', 'image/png'],
    ['/fonts/instrument-sans-latin.woff2', 'font/woff2'],
    ['/fonts/jetbrains-mono-latin.woff2', 'font/woff2']
  ]
  for (const [assetPath, expectedMime] of iconChecks) {
    const res = await fetch(origin + assetPath)
    assert.equal(res.status, 200, assetPath)
    assert.equal(res.headers.get('content-type'), expectedMime, assetPath)
    const bytes = new Uint8Array(await res.arrayBuffer())
    assert.ok(bytes.byteLength > 0, assetPath)
  }
})

test('Frontend format.js and i18n.svelte.js use dynamic local timezone, freeze liveElapsed on flagged tickets, and keep EN/ZH parity', async () => {
  globalThis.$state ??= v => v
  globalThis.navigator ??= { language: 'en-US' }
  const i18n = await import('../ui/src/lib/i18n.svelte.js')
  const fmt = await import('../ui/src/lib/format.js')

  const src = readFileSync(new URL('../ui/src/lib/i18n.svelte.js', import.meta.url), 'utf8')
  const enBlock = /en:\s*\{([\s\S]*?)\n  \},\n  zh:/.exec(src)?.[1] ?? ''
  const zhBlock = /zh:\s*\{([\s\S]*?)\n  \}\n\}/.exec(src)?.[1] ?? ''
  const extractKeys = text => [...text.matchAll(/(?:^|[,\n])\s*([a-zA-Z0-9_]+)\s*:/g)].map(m => m[1]).sort()
  assert.deepEqual(extractKeys(enBlock), extractKeys(zhBlock))
  assert.equal(enBlock.includes('UTC+8'), false)
  assert.equal(zhBlock.includes('UTC+8'), false)
  assert.equal(enBlock.includes('cc-bro'), false)
  assert.equal(zhBlock.includes('cc-bro'), false)

  i18n.setLang('en')
  const sampleIso = '2026-11-17T16:00:05.000Z'
  const expectedLocal = new Intl.DateTimeFormat('sv-SE', {
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(new Date(sampleIso))
  assert.equal(fmt.localTime(sampleIso, { seconds: true }), expectedLocal)
  assert.equal(fmt.localTime(sampleIso, { seconds: true, timeZone: 'Asia/Shanghai' }), '2026-11-18 00:00:05')
  assert.equal(fmt.localTime(sampleIso, { seconds: true, timeZone: 'America/Los_Angeles', suffix: true }), '2026-11-17 08:00:05 UTC-8')
  assert.equal(fmt.localTime(sampleIso, { seconds: true, timeZone: 'UTC', suffix: true }), '2026-11-17 16:00:05 UTC')
  assert.equal(fmt.clock(sampleIso, 'Asia/Shanghai'), '00:00:05')
  assert.equal(fmt.pickLocalTime('2026-11-18 09:00:00', '2026-11-18 08:00:00', sampleIso), '2026-11-18 09:00:00')
  assert.equal(fmt.pickLocalTime(null, '2026-11-18 08:00:00', sampleIso), '2026-11-18 08:00:00')
  assert.equal(fmt.pickLocalTime(null, null, sampleIso, { seconds: true, timeZone: 'UTC' }), '2026-11-17 16:00:05')
  assert.equal(fmt.windowName(null), 'window')
  assert.equal(fmt.windowName(300), '5h')
  assert.equal(fmt.windowName(10080), 'week')
  assert.equal(fmt.formatSpent({ spent: [{ minutes: 300, percent: 2.5 }, { minutes: 10080, percent: 0 }] }), '5h +2.5%')
  assert.match(i18n.t('offline'), /broco/)
  assert.match(i18n.t('handoffHint'), /^broco say /)

  i18n.setLang('zh')
  assert.equal(fmt.windowName(null), '窗口')
  assert.equal(fmt.windowName(10080), '周')
  assert.equal(i18n.translateActivity('Writing reply'), '正在整理回复')
  assert.equal(i18n.loginStatusLabel(true, 'signed-out'), '未登录')
  assert.equal(i18n.loginStatusLabel(false, 'ready'), '未安装')

  const startedAt = '2026-11-18T00:00:00.000Z'
  const now = Date.parse('2026-11-18T02:00:00.000Z')
  assert.equal(fmt.isLiveWorking({ status: 'working', flag: null, startedAt }), true)
  assert.equal(fmt.liveElapsed({ status: 'working', flag: null, startedAt, elapsedMs: 5000 }, now), 2 * 3600 * 1000)
  assert.equal(fmt.isLiveWorking({ status: 'working', flag: 'error', startedAt }), false)
  assert.equal(fmt.liveElapsed({ status: 'working', flag: 'error', startedAt, elapsedMs: 12000 }, now), 12000)
  assert.equal(fmt.isLiveWorking({ status: 'working', flag: 'stopped', startedAt }), false)
  assert.equal(fmt.liveElapsed({ status: 'working', flag: 'stopped', startedAt, elapsedMs: 8000 }, now), 8000)

  assert.equal(fmt.timelineCategory('bro.error'), 'error')
  assert.equal(fmt.timelineCategory('bro.accepted'), 'done')
  assert.equal(fmt.timelineCategory('item/completed'), 'tool')
  assert.equal(fmt.compactInput('/Users/demo/project/lib/web.mjs'), 'lib/web.mjs')

  assert.equal(fmt.compactModel('pi:deepseek', 'deepseek-flash'), 'deepseek/flash')
  assert.equal(fmt.compactModel('pi:zai-coding-cn', 'glm-5.3'), 'zai/glm-5.3')
  assert.equal(fmt.compactModel('claude', 'claude-sonnet-4-6'), 'claude/sonnet-4-6')
  assert.equal(fmt.compactModel('custom:my-cli', 'my-cli-v2'), 'my-cli/v2')
  assert.equal(fmt.compactModel('agy', 'agy'), 'agy')
  assert.equal(fmt.compactBranch('cc-bro/fix-login-a1b2c3d4'), 'fix-login')
  assert.equal(fmt.compactBranch('broco/w4-board-9f8e7d6c'), 'w4-board')
  assert.equal(fmt.compactBranch('feat/main'), 'feat/main')

  const segOk = fmt.meterSegments(42, 10)
  assert.equal(segOk.filled, 4)
  assert.equal(segOk.tone, 'ok')
  assert.equal(segOk.cells.length, 10)
  assert.equal(fmt.meterSegments(72, 10).tone, 'warn')
  assert.equal(fmt.meterSegments(88, 10).tone, 'err')
  assert.equal(fmt.meterSegments(null, 10).tone, 'muted')

  const md = await import('../ui/src/lib/markdown.js')
  const rendered = md.renderMarkdown('**Done** `<script>x</script>`\n\n- item 1\n- item 2\n\n```js\nconst a = 1 < 2\n```')
  assert.match(rendered, /<strong>Done<\/strong>/)
  assert.match(rendered, /&lt;script&gt;x&lt;\/script&gt;/)
  assert.equal(rendered.includes('<script>'), false)
  assert.match(rendered, /<ul class="md-list"><li>item 1<\/li><li>item 2<\/li><\/ul>/)
  assert.match(rendered, /<pre class="md-pre"><code>const a = 1 &lt; 2<\/code><\/pre>/)
})


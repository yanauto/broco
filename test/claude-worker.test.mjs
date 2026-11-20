import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { promisify } from 'node:util'
import { Crew, workerVendor } from '../lib/crew.mjs'
import { clearDetectCache, detectCli } from '../lib/detect.mjs'
import { loadCatalog, matchModel, modelCapabilities } from '../lib/model-catalog.mjs'
import { repo } from '../lib/paths.mjs'
import { classify } from '../lib/problems.mjs'
import { quotaText } from '../lib/quota.mjs'
import { Roster } from '../lib/roster.mjs'
import { rosterOutput, rosterText } from '../lib/roster-output.mjs'
import { Slots } from '../lib/slots.mjs'
import { Store } from '../lib/store.mjs'
import { harness, writeFakeCli } from './harness.mjs'

const exec = promisify(execFile)

function makeTemp(t, prefix = 'broco-claude-') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return dir
}

async function runInChild(env, code, argObj = {}) {
  const sandbox = join(repo, '.sandbox')
  mkdirSync(sandbox, { recursive: true })
  const home = realpathSync(mkdtempSync(join(sandbox, 'claude-home-')))
  try {
    const { stdout } = await exec(
      process.execPath,
      ['--input-type=module', '-e', code, JSON.stringify(argObj)],
      {
        cwd: repo,
        env: { ...process.env, BROCO_HOME: join(home, 'data'), ...env },
        timeout: 25000
      }
    )
    return JSON.parse(stdout.trim().split('\n').at(-1))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

test('claude streamTurn handles stdin prompts, two-turn resume, tools, usage/cache, attachments, redaction, and API errors', async t => {
  const dir = makeTemp(t)
  const bin = join(dir, 'bin')
  const work = join(dir, 'work')
  const attachDir = join(dir, 'files')
  mkdirSync(bin)
  mkdirSync(work)
  mkdirSync(attachDir)

  writeFakeCli(bin, 'claude', [
    "import { execFileSync } from 'node:child_process'",
    "import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'",
    "import { join } from 'node:path'",
    'const args = process.argv.slice(2)',
    'const emit = o => console.log(JSON.stringify(o))',
    "const val = f => args.includes(f) ? args[args.indexOf(f) + 1] : null",
    "if (!args.includes('-p') || val('--output-format') !== 'stream-json' || !args.includes('--verbose')) {",
    "  console.error('missing required stream-json flags')",
    '  process.exit(2)',
    '}',
    "let stdin = ''",
    "process.stdin.setEncoding('utf8')",
    'for await (const c of process.stdin) stdin += c',
    "let psCmd = ''",
    "try { psCmd = execFileSync('ps', ['-o', 'command=', '-p', String(process.pid)], { encoding: 'utf8' }).trim() } catch {}",
    "const addDirs = args.flatMap((a, i) => a === '--add-dir' ? [args[i + 1]] : [])",
    'const envCheck = {',
    '  BROCO_IN_WORKER: process.env.BROCO_IN_WORKER ?? null,',
    '  CLAUDECODE: process.env.CLAUDECODE ?? null,',
    '  CLAUDE_CODE_ENTRYPOINT: process.env.CLAUDE_CODE_ENTRYPOINT ?? null,',
    '  CLAUDE_CODE_SSE_PORT: process.env.CLAUDE_CODE_SSE_PORT ?? null,',
    '  CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID ?? null,',
    '  CODEX_THREAD_ID: process.env.CODEX_THREAD_ID ?? null',
    '}',
    "appendFileSync(join(process.cwd(), 'claude-calls.jsonl'), JSON.stringify({ args, stdin, psCmd, addDirs, envCheck }) + '\\n')",
    "const sid = val('--resume') || 'claude-sess-1'",
    "emit({ type: 'system', subtype: 'hook_started', session_id: sid, hook_name: 'SessionStart:startup' })",
    "emit({ type: 'system', subtype: 'init', session_id: sid, model: val('--model') || 'claude-opus-5-5', permissionMode: val('--permission-mode') })",
    "if (stdin.includes('TRIGGER_RATE_LIMIT')) {",
    "  emit({ type: 'assistant', session_id: sid, is_api_error_message: true, api_error_status: 429, api_error_type: 'rate_limit_error', message: { role: 'assistant', content: [{ type: 'text', text: 'Claude AI usage limit reached|1795000000' }] } })",
    "  emit({ type: 'result', subtype: 'success', is_error: true, session_id: sid, api_error_status: 429, api_error_type: 'rate_limit_error', result: 'Claude AI usage limit reached|1795000000', usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 } })",
    '  process.exit(1)',
    '}',
    "if (stdin.includes('TRIGGER_SUBSCRIPTION_403')) {",
    "  emit({ type: 'assistant', session_id: sid, is_api_error_message: true, api_error_status: 403, api_error_code: 'oauth_not_allowed_for_organization', api_error_type: 'permission_error', message: { role: 'assistant', content: [{ type: 'text', text: \"Claude Code can't use your Claude subscription, usually because a payment is past due\" }] } })",
    "  emit({ type: 'result', subtype: 'success', is_error: true, session_id: sid, api_error_status: 403, api_error_code: 'oauth_not_allowed_for_organization', api_error_type: 'permission_error', result: \"Claude Code can't use your Claude subscription, usually because a payment is past due\" })",
    '  process.exit(1)',
    '}',
    "if (!val('--resume')) {",
    "  writeFileSync(join(process.cwd(), 'memo.txt'), stdin)",
    "  emit({ type: 'assistant', session_id: sid, message: { id: 'm1', role: 'assistant', content: [{ type: 'thinking', thinking: 'planning' }, { type: 'tool_use', id: 'tu-1', name: 'Read', input: { file_path: '/tmp/spec.pdf' } }, { type: 'tool_use', id: 'tu-2', name: 'Bash', input: { command: 'npm test' } }], usage: { input_tokens: 150, cache_creation_input_tokens: 50, cache_read_input_tokens: 400, output_tokens: 30 } } })",
    "  emit({ type: 'user', session_id: sid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-1', is_error: false, content: 'read 42 lines' }, { type: 'tool_result', tool_use_id: 'tu-2', is_error: false, content: [{ type: 'text', text: 'all green\\n12 passed' }] }] } })",
    "  emit({ type: 'assistant', session_id: sid, message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'done with secret-token-9988' }], usage: { input_tokens: 200, cache_creation_input_tokens: 100, cache_read_input_tokens: 700, output_tokens: 40 } } })",
    "  emit({ type: 'result', subtype: 'success', is_error: false, session_id: sid, result: 'done with secret-token-9988', usage: { input_tokens: 350, cache_creation_input_tokens: 150, cache_read_input_tokens: 1100, output_tokens: 70 } })",
    '} else {',
    "  const saved = readFileSync(join(process.cwd(), 'memo.txt'), 'utf8')",
    "  const answer = 'recalled:' + (saved.includes('SECRET_BRIEF_7741') ? 'yes' : 'no')",
    "  emit({ type: 'assistant', session_id: sid, message: { id: 'm3', role: 'assistant', content: [{ type: 'text', text: answer }] } })",
    "  emit({ type: 'result', subtype: 'success', is_error: false, session_id: sid, result: '', usage: { input_tokens: 60, cache_creation_input_tokens: 15, cache_read_input_tokens: 225, output_tokens: 12 } })",
    '}'
  ])

  const attachments = [
    { path: join(attachDir, 'diagram.png'), kind: 'image', name: 'diagram.png' },
    { path: join(attachDir, 'spec.pdf'), kind: 'pdf', name: 'spec.pdf' }
  ]
  for (const a of attachments) writeFileSync(a.path, 'bytes')

  const childCode = [
    "import { streamTurn } from './lib/stream-workers.mjs'",
    'const cfg = JSON.parse(process.argv[1])',
    'const events1 = [], events2 = []',
    'let session = null',
    'const reply1 = await streamTurn({',
    "  provider: 'claude', model: 'sonnet', thinking: 'high',",
    '  cwd: cfg.work, marker: cfg.marker, text: cfg.prompt1, attachments: cfg.attachments,',
    '  signal: new AbortController().signal, owner() {}, ready() {},',
    '  bind: id => { session = id },',
    '  event: (kind, payload, detail) => events1.push({ kind, payload, detail })',
    '})',
    'const reply2 = await streamTurn({',
    "  provider: 'claude', model: 'claude', thinking: null, session, review: true,",
    "  cwd: cfg.work, marker: cfg.marker, text: 'Recall what I sent',",
    '  signal: new AbortController().signal, owner() {}, ready() {},',
    '  bind: id => { session = id },',
    '  event: (kind, payload, detail) => events2.push({ kind, payload, detail })',
    '})',
    'let audioErr = null',
    'try {',
    '  await streamTurn({',
    "    provider: 'claude', model: 'sonnet', cwd: cfg.work, marker: cfg.marker, text: 'listen',",
    "    attachments: [{ path: cfg.audio, kind: 'audio', name: 'clip.mp3' }],",
    '    signal: new AbortController().signal, owner() {}, ready() {}, bind() {}, event() {}',
    '  })',
    '} catch (err) { audioErr = err.message }',
    'let rateErr = null',
    'try {',
    '  await streamTurn({',
    "    provider: 'claude', model: 'opus', session, cwd: cfg.work, marker: cfg.marker, text: 'TRIGGER_RATE_LIMIT',",
    '    signal: new AbortController().signal, owner() {}, ready() {}, bind() {}, event() {}',
    '  })',
    '} catch (err) { rateErr = { message: err.message, problem: err.problem ?? null } }',
    'let authErr = null',
    'try {',
    '  await streamTurn({',
    "    provider: 'claude', model: 'opus', session, cwd: cfg.work, marker: cfg.marker, text: 'TRIGGER_SUBSCRIPTION_403',",
    '    signal: new AbortController().signal, owner() {}, ready() {}, bind() {}, event() {}',
    '  })',
    '} catch (err) { authErr = { message: err.message, problem: err.problem ?? null } }',
    'console.log(JSON.stringify({ reply1, reply2, session, events1, events2, audioErr, rateErr, authErr }))'
  ].join('\n')

  const audioPath = join(attachDir, 'clip.mp3')
  writeFileSync(audioPath, 'mp3')

  const out = await runInChild(
    {
      PATH: bin + delimiter + process.env.PATH,
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_SSE_PORT: '12345',
      CLAUDE_CODE_SESSION_ID: 'host-session',
      CODEX_THREAD_ID: 'host-codex',
      TEST_API_TOKEN: 'secret-token-9988'
    },
    childCode,
    { work, marker: join(dir, 'marker'), prompt1: 'SECRET_BRIEF_7741\nInspect attachments.', attachments, audio: audioPath }
  )

  assert.equal(out.session, 'claude-sess-1')
  assert.equal(out.reply1, 'done with [redacted]')
  assert.equal(out.reply2, 'recalled:yes')
  assert.match(out.audioErr, /image and pdf/)

  const calls = readFileSync(join(work, 'claude-calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(calls.length, 4)

  assert.equal(calls[0].args.some(a => a.includes('SECRET_BRIEF_7741')), false)
  assert.equal(calls[0].psCmd.includes('SECRET_BRIEF_7741'), false)
  assert.equal(calls[0].args[calls[0].args.indexOf('--model') + 1], 'sonnet')
  assert.equal(calls[0].args[calls[0].args.indexOf('--effort') + 1], 'high')
  assert.equal(calls[0].args[calls[0].args.indexOf('--permission-mode') + 1], 'bypassPermissions')
  assert.deepEqual(calls[0].addDirs, [attachDir])
  assert.match(calls[0].stdin, /^Attached files \(inspect directly with Read\):\n- \[image\] diagram\.png: .*\n- \[pdf\] spec\.pdf: .*\n\nSECRET_BRIEF_7741/)
  assert.deepEqual(calls[0].envCheck, {
    BROCO_IN_WORKER: '1',
    CLAUDECODE: null,
    CLAUDE_CODE_ENTRYPOINT: null,
    CLAUDE_CODE_SSE_PORT: null,
    CLAUDE_CODE_SESSION_ID: null,
    CODEX_THREAD_ID: null
  })

  assert.equal(calls[1].args[calls[1].args.indexOf('--resume') + 1], 'claude-sess-1')
  assert.equal(calls[1].args.includes('--model'), false)
  assert.equal(calls[1].args.includes('--effort'), false)
  assert.equal(calls[1].args[calls[1].args.indexOf('--permission-mode') + 1], 'plan')
  assert.equal(calls[1].args.some(a => a.includes('Recall what I sent')), false)

  assert.ok(out.events1.some(e => e.kind === 'tool.started' && e.detail === 'Thinking'))
  assert.ok(out.events1.some(e => e.kind === 'tool.started' && e.payload.tool === 'Read' && e.detail === 'Read: /tmp/spec.pdf'))
  assert.ok(out.events1.some(e => e.kind === 'tool.completed' && e.payload.tool === 'Bash' && e.payload.outputPreview === '12 passed'))
  assert.ok(out.events1.some(e => e.kind === 'tool.started' && e.detail === 'Writing reply'))
  const usage1 = out.events1.filter(e => e.kind === 'usage')
  assert.deepEqual(usage1.at(-1).payload, { cachedInputTokens: 700, inputTokens: 1000, cacheCreationInputTokens: 100 })
  const usage2 = out.events2.filter(e => e.kind === 'usage')
  assert.deepEqual(usage2.at(-1).payload, { cachedInputTokens: 225, inputTokens: 300, cacheCreationInputTokens: 15 })

  assert.match(out.rateErr.message, /429.*rate_limit_error.*usage limit reached\|1795000000/)
  assert.equal(out.rateErr.problem.class, 'quota')
  assert.equal(out.rateErr.problem.retryable, true)
  assert.equal(out.rateErr.problem.resetsAt, new Date(1795000000 * 1000).toISOString())

  assert.match(out.authErr.message, /403.*oauth_not_allowed_for_organization/)
  assert.equal(out.authErr.problem.class, 'auth')
  assert.equal(out.authErr.problem.retryable, false)
})

test('problems.mjs classifies Claude 5h cap, rate_limit_error, overloaded, auth, context, and policy without false positives', () => {
  const cases = [
    ["You've hit your limit · resets 3pm (UTC)", 'quota', true],
    ['5-hour limit reached for your plan', 'quota', true],
    ['Weekly limit reached; try again later', 'quota', true],
    ['HTTP 429 rate_limit_error: This request would exceed your organization rate limit', 'quota', true],
    ['Claude AI usage limit reached|1795000000', 'quota', true],
    ['HTTP 529 overloaded_error: Anthropic API is temporarily overloaded', 'network', true],
    ["HTTP 403 permission_error oauth_not_allowed_for_organization: Claude Code can't use your Claude subscription", 'auth', false],
    ['Not logged in · Please run /login', 'auth', false],
    ['Please run claude auth login to continue', 'auth', false],
    ['OAuth token has expired', 'auth', false],
    ['request_too_large: prompt is too long (250000 tokens)', 'context', false],
    ['This conversation is too long. Please start a new session.', 'context', false],
    ['Output blocked by content filtering policy', 'policy', false],
    ['billing address is invalid; disk quota exceeded; at handler (app.js:429:12); assert.equal(res.code, 401)', 'worker', false]
  ]
  for (const [msg, expectedClass, expectedRetryable] of cases) {
    const p = classify(msg)
    assert.equal(p.class, expectedClass, 'Misclassified: ' + msg)
    assert.equal(p.retryable, expectedRetryable, 'Wrong retryable for: ' + msg)
  }
})

test('detectCli probes claude read-only without leaking PII/secrets, declares capabilities, and tracks observed cooldown', async t => {
  const dir = makeTemp(t)
  const bin = join(dir, 'bin')
  const cfgDir = join(dir, 'claude-cfg')
  mkdirSync(bin)
  mkdirSync(cfgDir)

  writeFileSync(join(cfgDir, 'settings.json'), JSON.stringify({
    model: 'opus',
    effortLevel: 'high',
    env: { ANTHROPIC_API_KEY: 'sk-ant-never-read-this-value' }
  }))

  const modeFile = join(dir, 'auth-mode.txt')
  writeFileSync(modeFile, 'ready')

  writeFakeCli(bin, 'claude', [
    "import { readFileSync } from 'node:fs'",
    'const args = process.argv.slice(2)',
    "if (args.includes('--version')) { console.log('2.1.325 (Claude Code)'); process.exit(0) }",
    "if (args[0] === 'auth' && args[1] === 'status') {",
    `  const mode = readFileSync(${JSON.stringify(modeFile)}, 'utf8').trim()`,
    "  if (mode === 'signed-out') {",
    "    console.log(JSON.stringify({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' }))",
    '    process.exit(1)',
    '  }',
    "  if (mode === 'expired') {",
    "    console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', loginExpiresAt: '2020-01-01T00:00:00.000Z', email: 'private@example.test', orgId: 'org-secret' }))",
    '    process.exit(0)',
    '  }',
    "  console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', loginExpiresAt: '2099-01-01T00:00:00.000Z', email: 'private@example.test', orgId: 'org-secret', planTier: 'pro' }))",
    '  process.exit(0)',
    '}',
    'process.exit(1)'
  ])

  const prevPath = process.env.PATH
  const prevCfg = process.env.CLAUDE_CONFIG_DIR
  t.after(() => {
    process.env.PATH = prevPath
    if (prevCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = prevCfg
    clearDetectCache()
  })
  clearDetectCache()
  process.env.PATH = bin + delimiter + prevPath
  process.env.CLAUDE_CONFIG_DIR = cfgDir

  const readyInfo = await detectCli('claude', dir, { refresh: true })
  assert.equal(readyInfo.installed, true)
  assert.equal(readyInfo.version, '2.1.325 (Claude Code)')
  assert.equal(readyInfo.loginStatus, 'ready')
  assert.equal(readyInfo.defaultModel, 'opus')
  assert.equal(readyInfo.defaultEffort, 'high')
  assert.deepEqual(readyInfo.efforts, ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.deepEqual(readyInfo.models.map(m => m.id), ['opus', 'sonnet', 'haiku', 'fable'])
  assert.equal(readyInfo.quota, undefined)
  const serialized = JSON.stringify(readyInfo)
  assert.equal(serialized.includes('private@example.test'), false)
  assert.equal(serialized.includes('org-secret'), false)
  assert.equal(serialized.includes('sk-ant-never-read-this-value'), false)

  const catalog = loadCatalog('/nonexistent/overrides')
  const opusCaps = modelCapabilities('claude', readyInfo.models[0], matchModel('opus', catalog))
  assert.deepEqual(opusCaps.input, { text: true, image: true, audio: false, video: false, pdf: true })

  writeFileSync(modeFile, 'signed-out')
  const signedOut = await detectCli('claude', dir, { refresh: true })
  assert.equal(signedOut.loginStatus, 'signed-out')

  writeFileSync(modeFile, 'expired')
  const expired = await detectCli('claude', dir, { refresh: true })
  assert.equal(expired.loginStatus, 'expired')

  writeFileSync(modeFile, 'ready')
  const db = new DatabaseSync(':memory:')
  const store = new Store(false, join(dir, 'tickets.sqlite'))
  try {
    db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,repoPath TEXT,created INTEGER,allow TEXT,worker TEXT,concurrency INTEGER)')
    const proj = { id: 'p1', name: 'demo', repoPath: dir, allow: ['claude'], worker: 'claude', concurrency: null }
    db.prepare('INSERT INTO projects VALUES (?,?,?,?,?,?,?)').run(proj.id, proj.name, proj.repoPath, Date.now(), JSON.stringify(proj.allow), proj.worker, null)
    const roster = new Roster({ db, entries: new Map([[proj.id, proj]]), crews: () => [{ store }], publish() {}, get: () => proj })

    const beforeErr = rosterOutput(await roster.list(proj.id, false, { refresh: true }))
    assert.match(rosterText(beforeErr), /quota=unreported \(CLI does not report usage\)/)

    const c1 = store.create('cap-hit', dir, 'opus', 'Cap', null, 'claude')
    store.accept(c1, 'work')
    store.finish(c1.id, 1, 'error', "You've hit your limit · resets 3pm (UTC)")

    const afterErr = rosterOutput(await roster.list(proj.id, false, { refresh: true }))
    const claudeRow = afterErr.workers.find(w => w.id === 'claude')
    assert.equal(claudeRow.quota?.source, 'observed')
    assert.match(quotaText(claudeRow.quota), /observed: quota .* 先别派/)

    const c2 = store.create('recovered', dir, 'opus', 'OK', null, 'claude')
    store.accept(c2, 'work')
    store.finish(c2.id, 1, 'done', 'Waiting', store.assistant(c2.id, 1, 'ok'))

    const afterRecover = rosterOutput(await roster.list(proj.id, false, { refresh: true }))
    assert.equal(afterRecover.workers.find(w => w.id === 'claude').quota, null)
  } finally {
    db.close()
    store.db.close()
  }
})

test('all worker adapters inject BROCO_IN_WORKER=1 and strip host session env vars', async t => {
  const dir = makeTemp(t)
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const envLog = join(dir, 'worker-env.jsonl')

  const recordSnippet = [
    "import { appendFileSync } from 'node:fs'",
    `const log = ${JSON.stringify(envLog)}`,
    'const record = tag => appendFileSync(log, JSON.stringify({',
    '  tag,',
    '  BROCO_IN_WORKER: process.env.BROCO_IN_WORKER ?? null,',
    '  CLAUDECODE: process.env.CLAUDECODE ?? null,',
    '  CLAUDE_CODE_ENTRYPOINT: process.env.CLAUDE_CODE_ENTRYPOINT ?? null,',
    '  CLAUDE_CODE_SSE_PORT: process.env.CLAUDE_CODE_SSE_PORT ?? null,',
    '  CODEX_THREAD_ID: process.env.CODEX_THREAD_ID ?? null',
    "}) + '\\n')"
  ].join('\n')

  writeFakeCli(bin, 'claude', [
    recordSnippet,
    "record('claude')",
    "for await (const _ of process.stdin) {}",
    "console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-claude' }))",
    "console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 's-claude', result: 'ok' }))"
  ])

  writeFakeCli(bin, 'agy', [
    recordSnippet,
    'const args = process.argv.slice(2)',
    "if (args.includes('/usage')) { console.log(JSON.stringify({ status: 'SUCCESS', command: { data: { groups: [] } } })); process.exit(0) }",
    "record('agy')",
    "for await (const _ of process.stdin) {}",
    "console.log(JSON.stringify({ event: 'init', conversation_id: 's-agy' }))",
    "console.log(JSON.stringify({ event: 'result', result: { conversation_id: 's-agy', status: 'SUCCESS', response: 'ok' } }))"
  ])

  writeFakeCli(bin, 'cursor-agent', [
    recordSnippet,
    "record('cursor-agent')",
    "console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-cursor' }))",
    "console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 's-cursor', result: 'ok' }))"
  ])

  writeFakeCli(bin, 'custom-probe', [
    recordSnippet,
    "record('custom')",
    "console.log(JSON.stringify({ id: 's-custom', reply: 'ok' }))"
  ])

  writeFakeCli(bin, 'codex', [
    "import { createInterface } from 'node:readline'",
    recordSnippet,
    'const args = process.argv.slice(2)',
    "if (args[0] === 'app-server') {",
    "  record('codex-app-server')",
    '  for await (const line of createInterface({ input: process.stdin })) {',
    '    const r = JSON.parse(line)',
    '    if (!r.id) continue',
    "    if (r.method === 'initialize') console.log(JSON.stringify({ id: r.id, result: {} }))",
    "    else if (r.method === 'thread/start') console.log(JSON.stringify({ id: r.id, result: { thread: { id: 't-app' } } }))",
    "    else if (r.method === 'account/rateLimits/read' || r.method === 'thread/name/set') console.log(JSON.stringify({ id: r.id, result: {} }))",
    "    else if (r.method === 'turn/start') {",
    "      console.log(JSON.stringify({ id: r.id, result: { turn: { id: 'turn-1' } } }))",
    "      console.log(JSON.stringify({ method: 'item/completed', params: { threadId: 't-app', item: { type: 'agentMessage', text: 'ok' } } }))",
    "      console.log(JSON.stringify({ method: 'turn/completed', params: { threadId: 't-app', turn: { id: 'turn-1', status: 'completed' } } }))",
    '    }',
    '  }',
    '  process.exit(0)',
    '}',
    "record('codex-exec')",
    "for await (const _ of process.stdin) {}",
    "console.log(JSON.stringify({ type: 'thread.started', thread_id: 't-exec' }))",
    "console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }))",
    "console.log(JSON.stringify({ type: 'turn.completed', usage: { cached_input_tokens: 0, input_tokens: 5 } }))"
  ])

  writeFakeCli(bin, 'pi', [
    "import { createInterface } from 'node:readline'",
    recordSnippet,
    'const args = process.argv.slice(2)',
    "if (args[0] === 'auth' && args[1] === 'check') {",
    "  console.log(JSON.stringify(args.includes('--credentials') ? { status: 'ready', authType: 'api_key', credentials: 'dummy-pi-key' } : { status: 'ready', authType: 'api_key' }))",
    '  process.exit(0)',
    '}',
    "if (args[0] === 'auth' && args[1] === 'print-api-key') {",
    "  console.log('dummy-pi-key')",
    '  process.exit(0)',
    '}',
    "record('pi')",
    'for await (const line of createInterface({ input: process.stdin })) {',
    '  const r = JSON.parse(line)',
    "  if (r.type === 'get_state') console.log(JSON.stringify({ type: 'response', id: r.id, command: r.type, success: true, data: { sessionId: 'pi-s1', model: { provider: 'deepseek', id: 'a' } } }))",
    '}'
  ])

  const childCode = [
    "import { nativeTurn } from './lib/native.mjs'",
    "import { Pi } from './lib/pi.mjs'",
    "import { streamTurn } from './lib/stream-workers.mjs'",
    'const cfg = JSON.parse(process.argv[1])',
    'const base = { cwd: cfg.dir, marker: cfg.marker, name: "probe", text: "hi", signal: new AbortController().signal, owner() {}, ready() {}, bind() {}, event() {} }',
    "await streamTurn({ ...base, provider: 'claude', model: 'claude' })",
    "await streamTurn({ ...base, provider: 'agy', model: 'agy' })",
    "await streamTurn({ ...base, provider: 'cursor-agent', model: 'cursor-agent' })",
    "await streamTurn({ ...base, provider: 'custom:probe', model: 'custom:probe', template: { command: 'custom-probe', newArgs: ['{prompt}'], resumeArgs: ['{session}', '{prompt}'], format: 'json', reply: { path: 'reply' }, session: { path: 'id' } } })",
    "await nativeTurn({ ...base, provider: 'codex', model: 'codex' })",
    "await nativeTurn({ ...base, provider: 'codex', model: 'codex', transport: 'exec' })",
    "const pi = await Pi.launch({ id: 'pi-s1', provider: 'pi:deepseek', model: 'deepseek/a', cwd: cfg.dir }, () => {}, () => {}, cfg.sessions, cfg.marker)",
    "await pi.command('get_state')",
    'pi.expectedExit = true',
    'pi.child.kill()',
    'await pi.closed',
    'console.log(JSON.stringify({ ok: true }))'
  ].join('\n')

  await runInChild(
    {
      PATH: bin + delimiter + process.env.PATH,
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_SSE_PORT: '9999',
      CODEX_THREAD_ID: 'codex-host'
    },
    childCode,
    { dir, marker: join(dir, 'marker'), sessions: join(dir, 'pi-sessions') }
  )

  const rows = readFileSync(envLog, 'utf8').trim().split('\n').map(JSON.parse)
  assert.deepEqual(rows.map(r => r.tag), ['claude', 'agy', 'cursor-agent', 'custom', 'codex-app-server', 'codex-exec', 'pi'])
  for (const row of rows) {
    assert.equal(row.BROCO_IN_WORKER, '1', 'Missing BROCO_IN_WORKER=1 for ' + row.tag)
    assert.equal(row.CLAUDECODE, null, 'CLAUDECODE leaked to ' + row.tag)
    assert.equal(row.CLAUDE_CODE_ENTRYPOINT, null, 'CLAUDE_CODE_ENTRYPOINT leaked to ' + row.tag)
    assert.equal(row.CLAUDE_CODE_SSE_PORT, null, 'CLAUDE_CODE_SSE_PORT leaked to ' + row.tag)
    assert.equal(row.CODEX_THREAD_ID, null, 'CODEX_THREAD_ID leaked to ' + row.tag)
  }
})

test('crew.review auto-selects cross-vendor reviewer preferring plentiful/ready/non-avoid workers and refuses same-vendor', async t => {
  const catalog = loadCatalog('/nonexistent/overrides')
  assert.equal(workerVendor('codex', 'gpt-6.1-sol', catalog), 'openai')
  assert.equal(workerVendor('pi:openai-codex', null, catalog), 'openai')
  assert.equal(workerVendor('claude', 'opus', catalog), 'anthropic')
  assert.equal(workerVendor('pi:anthropic', null, catalog), 'anthropic')
  assert.equal(workerVendor('agy', 'gemini-4-argon-medium', catalog), 'google')
  assert.equal(workerVendor('agy', 'claude-sonnet-4-6', catalog), 'anthropic')
  assert.equal(workerVendor('pi:deepseek', null, catalog), 'deepseek')

  const dir = makeTemp(t)
  const store = new Store(false, join(dir, 'tickets.sqlite'))
  try {
    const settings = {
      id: 'rev',
      repoPath: dir,
      allow: ['codex', 'pi:openai-codex', 'claude', 'agy', 'pi:deepseek'],
      worker: 'codex',
      entries: {},
      rules: []
    }
    const crew = new Crew(store, new Slots(2), () => settings)
    const dispatched = []
    crew.say = async (input, review) => {
      dispatched.push({ input, review })
      return { name: input.name, worker: input.worker, turn: 1 }
    }

    const writer = store.create('feat-x', dir, 'gpt-6.1-sol', 'Feature X', 'medium', 'codex')
    store.accept(writer, 'implement feature x')
    store.finish(writer.id, 1, 'done', 'Done', store.assistant(writer.id, 1, 'implemented'))

    let detectMap = {}
    crew.detectWorker = async id => detectMap[id] ?? { installed: false, loginStatus: 'not-installed', models: [] }

    detectMap = {
      claude: { installed: true, capability: 'full', loginStatus: 'ready', models: [{ id: 'opus' }], defaultModel: 'opus' },
      agy: {
        installed: true, capability: 'full', loginStatus: 'ready', models: [{ id: 'gemini-4-argon-medium' }], defaultModel: 'gemini-4-argon-medium',
        quota: { source: 'native', windows: [{ minutes: 300, usedPercent: 10 }], reached: false, avoid: false, plentiful: true }
      },
      'pi:deepseek': { installed: true, capability: 'full', loginStatus: 'ready', models: [{ id: 'deepseek/deepseek-v4.1-flash' }], defaultModel: 'deepseek/deepseek-v4.1-flash' }
    }
    const rPlentiful = await crew.review({ name: 'feat-x' })
    assert.equal(rPlentiful.worker, 'agy')

    detectMap.agy.quota = { source: 'native', windows: [{ minutes: 300, usedPercent: 95 }], reached: false, avoid: true, plentiful: false }
    const rAvoidFallback = await crew.review({ name: 'feat-x', by: '' })
    assert.equal(rAvoidFallback.worker, 'claude')

    const capConv = store.create('claude-cap', dir, 'opus', 'Cap', null, 'claude')
    store.accept(capConv, 'work')
    store.finish(capConv.id, 1, 'error', "You've hit your limit · resets 3pm (UTC)")

    const rAfterObserved = await crew.review({ name: 'feat-x', by: null })
    assert.equal(rAfterObserved.worker, 'pi:deepseek')

    await assert.rejects(crew.review({ name: 'feat-x', by: 'codex' }), /different worker/)
    await assert.rejects(crew.review({ name: 'feat-x', by: 'pi:openai-codex' }), /different worker.*openai/)
    const rExplicit = await crew.review({ name: 'feat-x', by: 'claude' })
    assert.equal(rExplicit.worker, 'claude')

    const agyClaude = store.create('agy-c', dir, 'claude-sonnet-4-6', 'Agy running Claude', null, 'agy')
    store.accept(agyClaude, 'write')
    store.finish(agyClaude.id, 1, 'done', 'Done', store.assistant(agyClaude.id, 1, 'done'))
    settings.allow = ['agy', 'claude', 'codex']
    detectMap = {
      claude: { installed: true, capability: 'full', loginStatus: 'ready', models: [{ id: 'opus' }], defaultModel: 'opus' },
      codex: { installed: true, capability: 'full', loginStatus: 'ready', models: [{ id: 'gpt-6.1-sol' }], defaultModel: 'gpt-6.1-sol' }
    }
    const rModelVendor = await crew.review({ name: 'agy-c' })
    assert.equal(rModelVendor.worker, 'codex')

    settings.allow = ['codex', 'pi:openai-codex']
    await assert.rejects(crew.review({ name: 'feat-x' }), /No cross-vendor reviewer.*allowed: codex, pi:openai-codex.*--by/)

    settings.allow = ['codex', 'claude', 'agy']
    detectMap = {
      claude: { installed: true, capability: 'full', loginStatus: 'signed-out', models: [{ id: 'opus' }] },
      agy: { installed: false, capability: 'full', loginStatus: 'not-installed', models: [] }
    }
    await assert.rejects(crew.review({ name: 'feat-x' }), /No ready cross-vendor reviewer.*claude: signed-out.*agy: not-installed.*--by/)
  } finally {
    store.db.close()
  }
})

test('CLI review without --by automatically picks a ready cross-vendor worker including claude', async t => {
  const h = harness(t)
  await h.json('init', '--allow', 'codex,claude', '--default-worker', 'codex')
  await h.json('say', 'task-a', 'implement hello')
  const rev = await h.json('review', 'task-a')
  assert.equal(rev.worker, 'claude')
  const shown = await h.json('show', rev.name)
  assert.equal(shown.parent, 'task-a')
  assert.equal(shown.provider, 'claude')
  assert.equal(shown.cacheRatio, 80 / 200)
})

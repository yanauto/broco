import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { claudeAttachments, describeAttachments, formatAttachmentPrompt } from '../lib/attachments.mjs'
import { repo } from '../lib/paths.mjs'
import { classify } from '../lib/problems.mjs'
import { Store } from '../lib/store.mjs'
import { agyModel, claudeResetEpoch } from '../lib/stream-workers.mjs'
import { presets, validateTemplate } from '../lib/templates.mjs'
import { createTree } from '../lib/worktree.mjs'

const exec = promisify(execFile)

function makeTemp(t, prefix = 'cc-bro-adapters-') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

async function runInChild(env, code, argObj = {}) {
  const sandbox = join(repo, '.sandbox')
  mkdirSync(sandbox, { recursive: true })
  const home = realpathSync(mkdtempSync(join(sandbox, 'adapter-home-')))
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

test('agyModel resolves effort variants, family base IDs, 3p effort flags, and default agy', () => {
  const catalog = [
    'gemini-4-argon-low',
    'gemini-4-argon-medium',
    'gemini-4-argon-high',
    'gemini-pro-orchestrator',
    'gemini-pro-orchestrator-argon',
    'claude-sonnet-4-6'
  ]
  assert.deepEqual(agyModel('agy', null, catalog), { model: null, effortFlag: null })
  assert.deepEqual(agyModel('agy', 'high', catalog), { model: null, effortFlag: 'high' })
  assert.deepEqual(agyModel('gemini-4-argon-medium', 'high', catalog), { model: 'gemini-4-argon-high', effortFlag: null })
  assert.deepEqual(agyModel('gemini-4-argon', 'high', catalog), { model: 'gemini-4-argon-high', effortFlag: null })
  assert.deepEqual(agyModel('gemini-4-argon', null, catalog), { model: 'gemini-4-argon-medium', effortFlag: null })
  assert.deepEqual(agyModel('gemini-4-argon', null, ['gemini-4-argon-low', 'gemini-4-argon-high']), { model: 'gemini-4-argon-low', effortFlag: null })
  assert.deepEqual(agyModel('gemini-pro-orchestrator', null, catalog), { model: 'gemini-pro-orchestrator', effortFlag: null })
  assert.deepEqual(agyModel('claude-sonnet-4-6', 'high', catalog), { model: 'claude-sonnet-4-6', effortFlag: 'high' })
  assert.deepEqual(agyModel('gemini-4-argon-medium', 'high', []), { model: 'gemini-4-argon-high', effortFlag: null })
  assert.deepEqual(agyModel('gemini-4-argon', 'low', []), { model: 'gemini-4-argon-low', effortFlag: null })
})

test('built-in custom presets validate cleanly and attachments accept extended audio/video types', t => {
  for (const preset of Object.values(presets)) {
    assert.ok(validateTemplate(preset))
  }
  const dir = makeTemp(t)
  const specs = [
    ['pic.png', 'image', 'image/png'],
    ['clip.ogg', 'audio', 'audio/ogg'],
    ['lossless.flac', 'audio', 'audio/flac'],
    ['voice.aac', 'audio', 'audio/aac'],
    ['movie.mkv', 'video', 'video/x-matroska'],
    ['doc.pdf', 'pdf', 'application/pdf']
  ]
  const paths = specs.map(([name]) => {
    const p = join(dir, name)
    writeFileSync(p, 'fixture-bytes')
    return p
  })
  const described = describeAttachments(paths)
  assert.deepEqual(
    described.map(d => [d.name, d.kind, d.mimeType]),
    specs
  )
  const claudeOk = claudeAttachments(described.filter(d => d.kind === 'image' || d.kind === 'pdf'))
  assert.equal(claudeOk.length, 2)
  assert.match(formatAttachmentPrompt('Check these', claudeOk, 'Read'), /^Attached files \(inspect directly with Read\):\n- \[image\] pic\.png: .*\n- \[pdf\] doc\.pdf: .*\n\nCheck these/)
  assert.throws(() => claudeAttachments(described), /image and pdf/)
  assert.equal(claudeResetEpoch('Claude AI usage limit reached|1795000000'), 1795000000)
  assert.equal(claudeResetEpoch('Limit reached, resets at 2026-11-20T08:00:00Z'), Math.floor(Date.parse('2026-11-20T08:00:00Z') / 1000))
  assert.equal(claudeResetEpoch('no timestamp'), null)
})

test('agy streamTurn hides prompt from argv/ps, resolves models, deduplicates active chunks, extracts tool_info, delivers multimodal --attach, and tracks quota', async t => {
  const dir = makeTemp(t)
  const bin = join(dir, 'bin')
  const work = join(dir, 'work')
  const attachA = join(dir, 'attach-a')
  const attachB = join(dir, 'attach-b')
  mkdirSync(bin)
  mkdirSync(work)
  mkdirSync(attachA)
  mkdirSync(attachB)

  const fakeAgy = join(bin, 'agy')
  writeFileSync(fakeAgy, [
    '#!/usr/bin/env node',
    "import { execFileSync } from 'node:child_process'",
    "import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'",
    "import { join } from 'node:path'",
    'const args = process.argv.slice(2)',
    'const emit = o => console.log(JSON.stringify(o))',
    "const val = f => args.includes(f) ? args[args.indexOf(f) + 1] : null",
    "if (args[0] === 'models') {",
    "  console.log(['Fetching available models...', 'gemini-4-argon-low\\tArgon Low', 'gemini-4-argon-medium\\tArgon Medium', 'gemini-4-argon-high\\tArgon High', 'claude-sonnet-4-6\\tClaude Sonnet 4.6'].join('\\n'))",
    '  process.exit(0)',
    '}',
    "if (args.includes('/usage')) {",
    "  const n = existsSync('usage-count') ? Number(readFileSync('usage-count', 'utf8')) + 1 : 1",
    "  writeFileSync('usage-count', String(n))",
    "  if (n === 1) console.log('Reading account usage...')",
    '  emit({',
    "    status: 'SUCCESS',",
    '    command: {',
    "      name: 'usage',",
    '      data: {',
    '        groups: [',
    "          { name: 'Gemini Models', buckets: [",
    "            { id: 'gemini-5h', window: '5h', remaining_fraction: n >= 2 ? 0.77 : 0.80, reset_time: '2026-11-18T06:00:00Z' },",
    "            { id: 'gemini-weekly', window: 'weekly', remaining_fraction: n >= 2 ? 0.89 : 0.90, reset_time: '2026-11-24T06:00:00Z' }",
    '          ] },',
    "          { name: 'Claude and GPT models', buckets: [",
    "            { id: '3p-5h', window: '5h', remaining_fraction: n >= 4 ? 0.90 : 0.95, reset_time: '2026-11-18T08:00:00Z' }",
    '          ] }',
    '        ]',
    '      }',
    '    }',
    '  })',
    '  process.exit(0)',
    '}',
    "if (args.some(a => a === '-p' || a === '--print' || a.startsWith('--print='))) {",
    "  console.error('unexpected print flag')",
    '  process.exit(2)',
    '}',
    "let stdin = ''",
    "process.stdin.setEncoding('utf8')",
    'for await (const c of process.stdin) stdin += c',
    "let psCmd = ''",
    "try { psCmd = execFileSync('ps', ['-o', 'command=', '-p', String(process.pid)], { encoding: 'utf8' }).trim() } catch {}",
    "const addDirs = args.flatMap((a, i) => a === '--add-dir' ? [args[i + 1]] : [])",
    "appendFileSync(join(process.cwd(), 'invocations.jsonl'), JSON.stringify({ args, stdin, psCmd, addDirs }) + '\\n')",
    "const cid = val('--conversation') || 'conv-fixed-1'",
    "emit({ event: 'init', conversation_id: cid, init: { model: val('--model') } })",
    "if (stdin.includes('TRIGGER_QUOTA_ERROR')) {",
    "  emit({ event: 'result', result: { conversation_id: cid, status: 'ERROR', response: '', error: 'RESOURCE_EXHAUSTED: quota exceeded for model', usage: { input_tokens: 50, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 25, total_tokens: 50 } } })",
    '  process.exit(1)',
    '}',
    "emit({ event: 'step_update', step_update: { conversation_id: cid, step_index: 0, state: 'DONE', step_type: 'user_input' } })",
    'for (let i = 0; i < 10; i++) {',
    "  emit({ event: 'step_update', step_update: { conversation_id: cid, step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'chunk-' + i } })",
    '}',
    "emit({ event: 'step_update', step_update: { conversation_id: cid, step_index: 1, state: 'DONE', step_type: 'agent_response', duration_seconds: 0.4 } })",
    "emit({ event: 'step_update', step_update: { conversation_id: cid, step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'read_file', tool_info: { name: 'read_file', parameters: { Path: '/tmp/probe.txt' } } } })",
    "emit({ event: 'step_update', step_update: { conversation_id: cid, step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'read_file', duration_seconds: 0.05, tool_info: { name: 'read_file', parameters: { Path: '/tmp/probe.txt' }, output: '1 lines, 20 bytes' } } })",
    "emit({ event: 'step_update', step_update: { conversation_id: cid, step_index: 3, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'uv run   scripts/02_filter.py' } } } })",
    "emit({ event: 'step_update', step_update: { conversation_id: cid, step_index: 3, state: 'DONE', step_type: 'tool', tool_name: 'run_command', duration_seconds: 0.09, tool_info: { name: 'run_command', parameters: { CommandLine: 'uv run   scripts/02_filter.py' }, output: 'Created At: 2026-11-18T01:14:13+08:00\\nCompleted At: 2026-11-18T01:14:13+08:00\\nCommand exited with code 0.\\n\\nCommand output:\\nprobe-ok\\r\\n' } } })",
    'for (let i = 0; i < 6; i++) {',
    "  emit({ event: 'step_update', step_update: { conversation_id: cid, step_index: 4, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'tail-' + i } })",
    '}',
    "emit({ event: 'step_update', step_update: { conversation_id: cid, step_index: 4, state: 'DONE', step_type: 'agent_response', duration_seconds: 0.3 } })",
    "emit({ event: 'result', result: { conversation_id: cid, status: 'SUCCESS', response: 'final-answer', usage: { input_tokens: 120, output_tokens: 20, thinking_tokens: 0, cache_read_tokens: 300, total_tokens: 140 } } })"
  ].join('\n'))
  chmodSync(fakeAgy, 0o755)

  const attachments = [
    { path: join(attachA, 'chart.png'), kind: 'image', name: 'chart.png' },
    { path: join(attachA, 'memo.ogg'), kind: 'audio', name: 'memo.ogg' },
    { path: join(attachB, 'demo.mp4'), kind: 'video', name: 'demo.mp4' },
    { path: join(attachB, 'paper.pdf'), kind: 'pdf', name: 'paper.pdf' }
  ]
  for (const a of attachments) writeFileSync(a.path, 'data')

  const childCode = [
    "import { streamTurn } from './lib/stream-workers.mjs'",
    'const cfg = JSON.parse(process.argv[1])',
    'const events1 = [], events2 = [], eventsErr = []',
    'let session = null',
    'const reply1 = await streamTurn({',
    "  provider: 'agy', model: 'gemini-4-argon-medium', thinking: 'high',",
    '  cwd: cfg.work, marker: cfg.marker, text: cfg.secretPrompt, attachments: cfg.attachments,',
    '  signal: new AbortController().signal, owner() {}, ready() {},',
    '  bind: id => { session = id },',
    '  event: (kind, payload, detail) => events1.push({ kind, payload, detail })',
    '})',
    'const reply2 = await streamTurn({',
    "  provider: 'agy', model: 'claude-sonnet-4-6', thinking: 'high', session,",
    "  cwd: cfg.work, marker: cfg.marker, text: 'Second turn secret prompt',",
    '  signal: new AbortController().signal, owner() {}, ready() {},',
    '  bind: id => { session = id },',
    '  event: (kind, payload, detail) => events2.push({ kind, payload, detail })',
    '})',
    'let errInfo = null',
    'try {',
    '  await streamTurn({',
    "    provider: 'agy', model: 'gemini-4-argon', thinking: null, session,",
    "    cwd: cfg.work, marker: cfg.marker, text: 'TRIGGER_QUOTA_ERROR',",
    '    signal: new AbortController().signal, owner() {}, ready() {}, bind() {},',
    '    event: (kind, payload, detail) => eventsErr.push({ kind, payload, detail })',
    '  })',
    '} catch (err) { errInfo = { message: err.message, problem: err.problem ?? null } }',
    'console.log(JSON.stringify({ reply1, reply2, session, events1, events2, eventsErr, errInfo }))'
  ].join('\n')

  const secretPrompt = 'TOP_SECRET_PROMPT_88421\nInspect all attached files.'
  const out = await runInChild(
    { PATH: bin + ':' + process.env.PATH },
    childCode,
    { work, marker: join(dir, 'marker'), secretPrompt, attachments }
  )

  assert.equal(out.reply1, 'final-answer')
  assert.equal(out.reply2, 'final-answer')
  assert.equal(out.session, 'conv-fixed-1')

  const calls = readFileSync(join(work, 'invocations.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(calls.length, 3)

  assert.equal(calls[0].args.some(a => a.includes('TOP_SECRET_PROMPT_88421')), false)
  assert.equal(calls[0].psCmd.includes('TOP_SECRET_PROMPT_88421'), false)
  assert.ok(calls[0].args.includes('gemini-4-argon-high'))
  assert.equal(calls[0].args.includes('--effort'), false)
  assert.deepEqual(calls[0].addDirs, [attachA, attachB])
  assert.match(calls[0].stdin, /^Attached files \(inspect directly with read_file\):\n- \[image\] chart\.png: .*\n- \[audio\] memo\.ogg: .*\n- \[video\] demo\.mp4: .*\n- \[pdf\] paper\.pdf: .*\n\nTOP_SECRET_PROMPT_88421/)

  assert.ok(calls[1].args.includes('--conversation'))
  assert.equal(calls[1].args[calls[1].args.indexOf('--conversation') + 1], 'conv-fixed-1')
  assert.equal(calls[1].args[calls[1].args.indexOf('--model') + 1], 'claude-sonnet-4-6')
  assert.equal(calls[1].args[calls[1].args.indexOf('--effort') + 1], 'high')
  assert.equal(calls[1].args.some(a => a.includes('Second turn secret')), false)

  assert.equal(calls[2].args[calls[2].args.indexOf('--model') + 1], 'gemini-4-argon-medium')
  assert.equal(calls[2].args.includes('--effort'), false)

  const writingEvents = out.events1.filter(e => e.detail === 'Writing reply')
  assert.equal(writingEvents.length, 2)
  assert.deepEqual(writingEvents.map(e => e.payload.step), [1, 4])

  const runStart = out.events1.find(e => e.kind === 'tool.started' && e.payload.tool === 'run_command')
  assert.equal(runStart.detail, 'run_command: uv run scripts/02_filter.py')
  assert.equal(runStart.payload.target, 'uv run scripts/02_filter.py')

  const runDone = out.events1.find(e => e.kind === 'tool.completed' && e.payload.tool === 'run_command')
  assert.equal(runDone.detail, 'run_command done (0.1s): probe-ok')
  assert.equal(runDone.payload.outputPreview, 'probe-ok')

  const usageEvent = out.events1.find(e => e.kind === 'usage')
  assert.deepEqual(usageEvent.payload, { cachedInputTokens: 300, inputTokens: 420 })

  const quotaEvents1 = out.events1.filter(e => e.kind === 'quota')
  assert.equal(quotaEvents1.length, 2)
  const store = new Store(false, join(dir, 'quota.sqlite'))
  try {
    const c = store.create('q', work, 'gemini-4-argon-high', 'q', null, 'agy')
    store.accept(c, 'go')
    for (const q of quotaEvents1) store.event(c.id, 1, 'quota', q.payload, '')
    assert.deepEqual(store.quota(c.id, 1).spent, [
      { minutes: 300, percent: 3 },
      { minutes: 10080, percent: 1 }
    ])
  } finally {
    store.db.close()
  }

  const quotaEvents2 = out.events2.filter(e => e.kind === 'quota')
  assert.equal(quotaEvents2.length, 2)
  assert.equal(quotaEvents2[0].payload.windows[0].usedPercent, 5)
  assert.equal(quotaEvents2[1].payload.windows[0].usedPercent, 10)

  assert.match(out.errInfo.message, /RESOURCE_EXHAUSTED: quota exceeded/)
  assert.equal(classify(out.errInfo.message).class, 'quota')
  assert.equal(out.errInfo.problem.class, 'quota')
  assert.equal(out.errInfo.problem.resetsAt, '2026-11-18T06:00:00.000Z')
})

test('codex worktree turns grant writable access to main repo commonGitDir in app-server and exec modes, never in review mode', async t => {
  const dir = makeTemp(t)
  const bin = join(dir, 'bin')
  const mainRepo = join(dir, 'repo')
  const stateDir = join(dir, 'state')
  mkdirSync(bin)
  mkdirSync(mainRepo)
  mkdirSync(stateDir)

  execFileSync('git', ['init', '-q'], { cwd: mainRepo })
  writeFileSync(join(mainRepo, 'README.md'), 'seed\n')
  execFileSync('git', ['add', 'README.md'], { cwd: mainRepo })
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-qm', 'init'], { cwd: mainRepo })

  const tree = createTree(mainRepo, stateDir, 'wt-commit')
  const expectedCommonGit = realpathSync(join(mainRepo, '.git'))

  const fakeCodex = join(bin, 'codex')
  writeFileSync(fakeCodex, [
    '#!/usr/bin/env node',
    "import { appendFileSync } from 'node:fs'",
    "import { createInterface } from 'node:readline'",
    'const args = process.argv.slice(2)',
    'const logFile = process.env.FAKE_CODEX_LOG',
    'const send = o => console.log(JSON.stringify(o))',
    "if (args[0] === 'app-server') {",
    '  const rl = createInterface({ input: process.stdin })',
    '  for await (const line of rl) {',
    '    const r = JSON.parse(line)',
    '    if (!r.id) continue',
    "    if (r.method === 'initialize') send({ id: r.id, result: {} })",
    "    else if (r.method === 'thread/start') {",
    "      appendFileSync(logFile, JSON.stringify({ mode: 'app-server', params: r.params }) + '\\n')",
    "      send({ id: r.id, result: { thread: { id: 't-1' } } })",
    '    }',
    "    else if (r.method === 'account/rateLimits/read' || r.method === 'thread/name/set') send({ id: r.id, result: {} })",
    "    else if (r.method === 'turn/start') {",
    "      send({ id: r.id, result: { turn: { id: 'turn-1' } } })",
    "      send({ method: 'item/completed', params: { threadId: 't-1', item: { type: 'agentMessage', text: 'committed' } } })",
    "      send({ method: 'turn/completed', params: { threadId: 't-1', turn: { id: 'turn-1', status: 'completed' } } })",
    '    }',
    '  }',
    '  process.exit(0)',
    '}',
    "if (args[0] === 'exec') {",
    "  appendFileSync(logFile, JSON.stringify({ mode: 'exec', args }) + '\\n')",
    "  for await (const _ of process.stdin) {}",
    "  send({ type: 'thread.started', thread_id: 't-exec' })",
    "  send({ type: 'item.completed', item: { type: 'agent_message', text: 'exec-committed' } })",
    "  send({ type: 'turn.completed', usage: { cached_input_tokens: 0, input_tokens: 10 } })",
    '  process.exit(0)',
    '}',
    'process.exit(2)'
  ].join('\n'))
  chmodSync(fakeCodex, 0o755)

  const logFile = join(dir, 'codex-calls.jsonl')
  const code = [
    "import { nativeTurn } from './lib/native.mjs'",
    'const cfg = JSON.parse(process.argv[1])',
    'const base = { provider: "codex", model: "gpt-6-astra", name: "wt", cwd: cfg.cwd, worktree: cfg.cwd, marker: cfg.marker, text: "commit work", signal: new AbortController().signal, owner() {}, ready() {}, bind() {}, event() {} }',
    'await nativeTurn(base)',
    'await nativeTurn({ ...base, transport: "exec" })',
    'await nativeTurn({ ...base, review: true })',
    'console.log(JSON.stringify({ ok: true }))'
  ].join('\n')

  await runInChild(
    { PATH: bin + ':' + process.env.PATH, FAKE_CODEX_LOG: logFile },
    code,
    { cwd: tree.cwd, marker: join(dir, 'codex-marker') }
  )

  const logged = readFileSync(logFile, 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(logged.length, 3)

  assert.equal(logged[0].mode, 'app-server')
  assert.equal(logged[0].params.sandbox, 'workspace-write')
  assert.deepEqual(logged[0].params.writableRoots, [expectedCommonGit])
  assert.deepEqual(logged[0].params.config, { sandbox_workspace_write: { writable_roots: [expectedCommonGit] } })

  assert.equal(logged[1].mode, 'exec')
  assert.ok(logged[1].args.includes('--add-dir'))
  assert.equal(logged[1].args[logged[1].args.indexOf('--add-dir') + 1], expectedCommonGit)
  assert.ok(logged[1].args.includes('sandbox_workspace_write.writable_roots=' + JSON.stringify([expectedCommonGit])))

  assert.equal(logged[2].mode, 'app-server')
  assert.equal(logged[2].params.sandbox, 'read-only')
  assert.equal(logged[2].params.writableRoots, undefined)
  assert.equal(logged[2].params.config, undefined)
})

test('site/deploy.sh remote verification block logs unified diff and HTTP status before rollback', async t => {
  const dir = makeTemp(t)
  const deployText = readFileSync(join(repo, 'site/deploy.sh'), 'utf8')
  const remoteScript = deployText.split("<<'REMOTE'\n")[1].split('\nREMOTE')[0]
  assert.match(remoteScript, /diff -u/)
  assert.match(remoteScript, /http_code/)

  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const fakeCurl = join(bin, 'curl')
  writeFileSync(fakeCurl, [
    '#!/usr/bin/env node',
    "import { writeFileSync } from 'node:fs'",
    'const args = process.argv.slice(2)',
    "const out = args[args.indexOf('-o') + 1]",
    'const url = args.at(-1)',
    "if (url.includes('/healthz') || url.includes('/docs/')) {",
    "  writeFileSync(out, 'upstream gateway failed\\n')",
    "  process.stdout.write(process.env.MOCK_HEALTH_STATUS || '200')",
    '  process.exit(0)',
    '}',
    "writeFileSync(out, process.env.MOCK_LIVE_HTML || '<h1>expected</h1>\\n')",
    "process.stdout.write(process.env.MOCK_INDEX_STATUS || '200')"
  ].join('\n'))
  chmodSync(fakeCurl, 0o755)

  const probeSnippet = remoteScript.slice(remoteScript.indexOf('index_rc=0'))
  const harnessSh = join(dir, 'run-probe.sh')
  const backup = join(dir, 'backup')
  const release = join(dir, 'release')
  mkdirSync(backup)
  mkdirSync(release)
  writeFileSync(join(release, 'index.html'), '<h1>expected</h1>\n')
  writeFileSync(harnessSh, [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'domain=broco.example.com',
    `backup=${JSON.stringify(backup)}`,
    `release=${JSON.stringify(release)}`,
    'rolled_back=0',
    'trap \'rc=$?; if (( rc )); then echo "ROLLED_BACK" >&2; fi; exit $rc\' EXIT',
    probeSnippet
  ].join('\n'))
  chmodSync(harnessSh, 0o755)

  await assert.rejects(
    exec(harnessSh, [], { env: { ...process.env, PATH: bin + ':' + process.env.PATH, MOCK_LIVE_HTML: '<h1>stale</h1>\n' } }),
    err => /Deployed index\.html diff/.test(err.stderr) && /-<h1>expected<\/h1>/.test(err.stderr) && /\+<h1>stale<\/h1>/.test(err.stderr) && /ROLLED_BACK/.test(err.stderr)
  )

  await assert.rejects(
    exec(harnessSh, [], { env: { ...process.env, PATH: bin + ':' + process.env.PATH, BROCO_HEALTH_PROBE_URL: 'https://broco.example.com/healthz', MOCK_HEALTH_STATUS: '502' } }),
    err => /Health probe failed .* http=502/.test(err.stderr) && /upstream gateway failed/.test(err.stderr) && /ROLLED_BACK/.test(err.stderr)
  )

  const ok = await exec(harnessSh, [], { env: { ...process.env, PATH: bin + ':' + process.env.PATH } })
  assert.match(ok.stdout, /Verified/)
})

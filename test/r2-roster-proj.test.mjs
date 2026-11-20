import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { sanitizeSetupPath } from '../lib/setup.mjs'
import { modelVariables } from '../lib/model-env.mjs'
import { directoryOption, expandHome } from '../lib/directories.mjs'
import { workerPolicy } from '../lib/worker-policy.mjs'
import { claudeMdBlock } from '../lib/claude-md.mjs'
import { agyQuota, codexQuota, quotaText } from '../lib/quota.mjs'
import { clearDetectCache, detectCacheSize, detectCli, discoverPi } from '../lib/detect.mjs'
import { loadCatalog, resolveAgyModel, visiblePicks } from '../lib/model-catalog.mjs'
import { Roster } from '../lib/roster.mjs'
import { rosterOutput, rosterText } from '../lib/roster-output.mjs'
import { Store } from '../lib/store.mjs'
import { packageBoard } from '../scripts/package-board.mjs'
import { validateModelCatalog } from '../scripts/sync-model-catalog.mjs'
import { prependPath, writeFakeCli } from './harness.mjs'

const worktreeRoot = realpathSync.native(fileURLToPath(new URL('../', import.meta.url)))

test('sanitizeSetupPath, setupInfo, and setup strip ephemeral/shim dirs while preserving isolated fixtures', () => {
  const realDir = realpathSync.native(mkdtempSync(join(homedir(), '.cc-bro-test-path-')))
  const tempRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-bro-setup-')))
  try {
    const fixtureDir = join(worktreeRoot, 'test', 'fixtures')
    if (process.platform === 'win32') {
      const rawWin = [
        'C:\\Users\\demo\\AppData\\Local\\Temp\\ephemeral-bin',
        'C:\\Windows\\Temp\\ephemeral-bin-2',
        'C:\\Users\\demo\\project\\node_modules\\.bin',
        'C:\\Users\\demo\\AppData\\Local\\npm-cache\\_npx\\abcd\\node_modules\\.bin',
        'C:\\Users\\demo\\cc-bro\\.sandbox\\profile-1\\bin',
        fixtureDir,
        realDir,
        realDir.toLowerCase(),
        'C:\\nonexistent\\cc-bro-path-xyz',
        'C:\\Program Files\\nodejs'
      ].join(';')
      const prodClean = sanitizeSetupPath(rawWin, { nodeDir: 'C:\\Program Files\\nodejs', isIsolated: false })
      assert.deepEqual(prodClean.split(';'), ['C:\\Program Files\\nodejs', realDir])
      const isolatedClean = sanitizeSetupPath(rawWin, { nodeDir: 'C:\\Program Files\\nodejs', isIsolated: true })
      assert.deepEqual(isolatedClean.split(';'), ['C:\\Program Files\\nodejs', fixtureDir, realDir])
    } else {
      const raw = [
        '/tmp/ephemeral-bin',
        '/private/tmp/ephemeral-bin-2',
        '/var/folders/ab/cd/T/temp-bin',
        '/private/var/folders/ab/cd/T/temp-bin',
        '/Users/demo/project/node_modules/.bin',
        '/Users/demo/.npm/_npx/abcd/node_modules/.bin',
        '/Users/demo/cc-bro/.sandbox/profile-1/bin',
        fixtureDir,
        realDir,
        realDir,
        '/nonexistent/cc-bro-path-xyz',
        '/usr/bin'
      ].join(':')

      const prodClean = sanitizeSetupPath(raw, { nodeDir: '/usr/bin', isIsolated: false })
      assert.deepEqual(prodClean.split(':'), ['/usr/bin', realDir])

      const isolatedClean = sanitizeSetupPath(raw, { nodeDir: '/usr/bin', isIsolated: true })
      assert.deepEqual(isolatedClean.split(':'), ['/usr/bin', fixtureDir, realDir])
    }

    const cfgDir = join(tempRoot, 'claude-cfg')
    const dataDir = join(tempRoot, 'broco-home')
    const badTemp = process.platform === 'win32' ? 'C:\\Users\\demo\\AppData\\Local\\Temp\\bad' : '/tmp/bad'
    const baseBins = process.platform === 'win32' ? [process.env.SystemRoot ? join(process.env.SystemRoot, 'System32') : 'C:\\Windows\\System32'] : ['/usr/bin', '/bin']
    const setupEnv = {
      ...process.env,
      BROCO_HOST_HOME: tempRoot,
      CLAUDE_CONFIG_DIR: cfgDir,
      BROCO_HOME: dataDir
    }
    for (const k of Object.keys(setupEnv)) {
      if (k !== 'PATH' && k.toLowerCase() === 'path') delete setupEnv[k]
    }
    setupEnv.PATH = [badTemp, join(worktreeRoot, 'node_modules', '.bin'), fixtureDir, ...baseBins].join(delimiter)
    const out = JSON.parse(execFileSync(process.execPath, [
      '--input-type=module',
      '-e',
      'import { setup, setupInfo } from "./lib/setup.mjs"; const info = setupInfo(); const s = setup(); console.log(JSON.stringify({ info, s }))'
    ], {
      cwd: worktreeRoot,
      env: setupEnv,
      encoding: 'utf8'
    }).trim())

    assert.equal(out.s, out.info.launcher)
    assert.equal(existsSync(out.info.launcher), true)
    assert.equal(existsSync(out.info.skillPath), true)
    const launcherText = readFileSync(out.info.launcher, 'utf8')
    const pathLine = launcherText.split(/\r?\n/).find(l => l.startsWith('export PATH=') || l.startsWith('set "PATH='))
    assert.ok(pathLine)
    assert.doesNotMatch(pathLine, /\/tmp\/bad|Temp\\bad|node_modules[\\/]\.bin|test[\\/]fixtures/i)
    assert.match(readFileSync(out.info.skillPath, 'utf8'), /broco/)
  } finally {
    rmSync(realDir, { recursive: true, force: true })
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('install-local.sh unsets npm_config_prefix hazards and strips node_modules/.bin before setup', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'cc-bro-install-sh-'))
  try {
    const fakeRepo = join(root, 'repo')
    const fakeBin = join(root, 'bin')
    const globalPrefix = join(root, 'global')
    const logFile = join(root, 'invocations.jsonl')
    mkdirSync(join(fakeRepo, 'scripts'), { recursive: true })
    mkdirSync(join(fakeRepo, 'ui/node_modules/.bin'), { recursive: true })
    mkdirSync(join(globalPrefix, 'bin'), { recursive: true })
    mkdirSync(fakeBin, { recursive: true })

    writeFileSync(join(fakeRepo, 'scripts/install-local.sh'), readFileSync(join(worktreeRoot, 'scripts/install-local.sh')))
    chmodSync(join(fakeRepo, 'scripts/install-local.sh'), 0o755)
    writeFileSync(join(fakeRepo, 'ui/node_modules/.bin/vite'), '#!/bin/sh\nexit 0\n')
    chmodSync(join(fakeRepo, 'ui/node_modules/.bin/vite'), 0o755)

    const fakeNpm = [
      '#!/usr/bin/env node',
      "import { appendFileSync, writeFileSync } from 'node:fs'",
      "import { delimiter, join } from 'node:path'",
      `const log = ${JSON.stringify(logFile)}, globalPrefix = ${JSON.stringify(globalPrefix)}`,
      'const args = process.argv.slice(2)',
      'appendFileSync(log, JSON.stringify({ tool: "npm", args, npm_config_prefix: process.env.npm_config_prefix ?? null, NPM_CONFIG_PREFIX: process.env.NPM_CONFIG_PREFIX ?? null, PREFIX: process.env.PREFIX ?? null, npm_config_local_prefix: process.env.npm_config_local_prefix ?? null }) + "\\n")',
      'if (args[0] === "pack") {',
      '  const dest = args[args.indexOf("--pack-destination") + 1]',
      '  writeFileSync(join(dest, "broco-1.0.0.tgz"), "stub")',
      '} else if (args[0] === "prefix" && args[1] === "-g") {',
      '  console.log(globalPrefix)',
      '}'
    ].join('\n')
    writeFileSync(join(fakeBin, 'npm'), fakeNpm)
    chmodSync(join(fakeBin, 'npm'), 0o755)

    const fakeBroco = [
      '#!/usr/bin/env node',
      "import { appendFileSync } from 'node:fs'",
      `appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ tool: 'broco', args: process.argv.slice(2), PATH: process.env.PATH, npm_config_prefix: process.env.npm_config_prefix ?? null }) + '\\n')`
    ].join('\n')
    writeFileSync(join(globalPrefix, 'bin/broco'), fakeBroco)
    chmodSync(join(globalPrefix, 'bin/broco'), 0o755)

    execFileSync('/bin/sh', [join(fakeRepo, 'scripts/install-local.sh')], {
      cwd: root,
      env: {
        ...process.env,
        npm_config_prefix: fakeRepo,
        NPM_CONFIG_PREFIX: fakeRepo,
        PREFIX: fakeRepo,
        npm_config_local_prefix: fakeRepo,
        PATH: [
          join(fakeRepo, 'node_modules/.bin'),
          '/Users/demo/.npm/_npx/999/node_modules/.bin',
          fakeBin,
          process.env.PATH
        ].join(':')
      }
    })

    const calls = readFileSync(logFile, 'utf8').trim().split('\n').map(JSON.parse)
    assert.ok(calls.length >= 4)
    for (const entry of calls) {
      assert.equal(entry.npm_config_prefix, null)
    }
    const setupCall = calls.find(c => c.tool === 'broco')
    assert.deepEqual(setupCall.args, ['setup'])
    assert.doesNotMatch(setupCall.PATH, /node_modules\/\.bin|\.npm\/_npx/)
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('packageBoard rebuilds ui automatically when dist is missing or older than ui/src', () => {
  const root = mkdtempSync(join(tmpdir(), 'cc-bro-pkg-board-'))
  try {
    mkdirSync(join(root, 'ui/src'), { recursive: true })
    writeFileSync(join(root, 'ui/index.html'), '<!doctype html>')
    writeFileSync(join(root, 'ui/src/App.svelte'), '<h1>v1</h1>')
    let builds = 0
    const build = cwd => {
      builds += 1
      mkdirSync(join(cwd, 'ui/dist'), { recursive: true })
      writeFileSync(join(cwd, 'ui/dist/index.html'), readFileSync(join(cwd, 'ui/src/App.svelte'), 'utf8'))
    }

    packageBoard({ root, build })
    assert.equal(builds, 1)
    assert.equal(readFileSync(join(root, 'bundle/board/index.html'), 'utf8'), '<h1>v1</h1>')

    packageBoard({ root, build })
    assert.equal(builds, 1)

    writeFileSync(join(root, 'ui/src/App.svelte'), '<h1>v2</h1>')
    const future = new Date(Date.now() + 5000)
    utimesSync(join(root, 'ui/src/App.svelte'), future, future)
    packageBoard({ root, build })
    assert.equal(builds, 2)
    assert.equal(readFileSync(join(root, 'bundle/board/index.html'), 'utf8'), '<h1>v2</h1>')
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('modelVariables, expandHome, workerPolicy, and claudeMdBlock enforce agent-first hygiene', () => {
  const filtered = modelVariables({
    GIT_DIR: '/tmp/.git',
    GIT_WORK_TREE: '/tmp/wt',
    GIT_INDEX_FILE: '/tmp/idx',
    GIT_OBJECT_DIRECTORY: '/tmp/obj',
    GIT_COMMON_DIR: '/tmp/common',
    npm_config_prefix: '/tmp/prefix',
    NPM_CONFIG_PREFIX: '/tmp/prefix2',
    CLAUDECODE: '1',
    BROCO_HOME: '/tmp/broco',
    BROCO_TZ: 'UTC',
    BROCO_IN_WORKER: '1',
    CUSTOM_ENDPOINT: 'https://example.test'
  })
  assert.deepEqual(filtered, { CUSTOM_ENDPOINT: 'https://example.test' })

  assert.equal(expandHome('~'), homedir())
  assert.equal(expandHome('~/sub/file.md'), join(homedir(), 'sub/file.md'))
  assert.equal(expandHome('relative/file.md'), 'relative/file.md')
  const homeSub = realpathSync.native(mkdtempSync(join(homedir(), '.cc-bro-tilde-')))
  try {
    const rel = homeSub.slice(realpathSync.native(homedir()).length + 1)
    assert.equal(directoryOption('~/' + rel, '--cwd'), homeSub)
  } finally {
    rmSync(homeSub, { recursive: true, force: true })
  }

  assert.deepEqual(workerPolicy('codex, agy, ,codex,', 'agy'), { allow: ['codex', 'agy'], worker: 'agy' })
  assert.throws(() => workerPolicy(' , , ', undefined), /Choose allowed workers/)

  const md = claudeMdBlock()
  assert.match(md, /broco map <prefix> --brief <text-or-file> --inputs <item>\.\.\./)
  assert.doesNotMatch(md, /broco map <prefix> "<brief>"/)
  assert.match(md, /--file <path\|->/)
  assert.match(md, /broco status/)
  assert.match(md, /broco ls --active/)
  assert.match(md, /broco diff <name>/)
  assert.match(md, /broco clean/)
  assert.match(md, /broco retry <name-or-prefix>/)
})

test('quota exposes avoid boolean, disambiguates duplicate-duration buckets, and warns on tight secondary groups', () => {
  const codexOk = codexQuota({ primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1794666185 } })
  assert.equal(codexOk.avoid, false)
  const codexTight = codexQuota({ primary: { usedPercent: 92, windowDurationMins: 300, resetsAt: 1794666185 } })
  assert.equal(codexTight.avoid, true)

  const secondaryExhausted = agyQuota({
    status: 'SUCCESS',
    command: {
      data: {
        groups: [
          {
            name: 'Gemini Models',
            buckets: [
              { id: 'gem-5h', name: 'Gemini Pro 5h', window: '5h', remaining_fraction: 0.9, reset_time: '2026-11-17T21:06:25Z' }
            ]
          },
          {
            name: 'Claude and GPT models',
            buckets: [
              { id: '3p-5h', name: 'Claude 5h', window: '5h', remaining_fraction: 0.05, reset_time: '2026-11-17T21:57:37Z' }
            ]
          }
        ]
      }
    }
  })
  assert.equal(secondaryExhausted.avoid, false)
  assert.equal(secondaryExhausted.plentiful, false)
  assert.equal(secondaryExhausted.tightGroups.length, 1)
  assert.equal(secondaryExhausted.tightGroups[0].name, 'Claude and GPT models')
  assert.equal(secondaryExhausted.windows[0].id, 'gem-5h')
  const secText = quotaText(secondaryExhausted)
  assert.match(secText, /Claude and GPT models: 5h 95% used.*先别派该组 \/ avoid group/)
  assert.doesNotMatch(secText, /额度宽裕/)

  const dupPrimary = agyQuota({
    groups: [{
      name: 'Gemini Models',
      buckets: [
        { id: 'pro-5h', name: 'Pro', window: '5h', remaining_fraction: 0.8, reset_time: '2026-11-17T21:06:25Z' },
        { id: 'flash-5h', name: 'Flash', window: '5h', remaining_fraction: 0.95, reset_time: '2026-11-17T21:06:25Z' }
      ]
    }]
  })
  assert.equal(dupPrimary.windows[0].id, 'pro-5h')
  assert.equal(dupPrimary.windows[0].name, 'Pro')
  assert.match(quotaText(dupPrimary), /Pro 5h 20% used.*Flash 5h 5% used/)
})

test('detectCli shares 45s cache across fixture-free directories for agy/pi, prunes expired entries, and sends 1.0.0 to codex', async t => {
  const root = mkdtempSync(join(tmpdir(), 'cc-bro-detect-r2-'))
  const bin = join(root, 'bin')
  const projA = join(root, 'proj-a')
  const projB = join(root, 'proj-b')
  mkdirSync(bin); mkdirSync(projA); mkdirSync(projB)
  const callsLog = join(root, 'calls.jsonl')

  writeFakeCli(bin, 'agy', [
    "import { appendFileSync } from 'node:fs'",
    `appendFileSync(${JSON.stringify(callsLog)}, JSON.stringify({ cli: 'agy', args: process.argv.slice(2) }) + '\\n')`,
    'const args = process.argv.slice(2)',
    "if (args.includes('--version')) console.log('agy 1.6.0')",
    "else if (args.includes('models')) console.log('gemini-4-argon-medium\\tGemini 4 Argon')",
    "else console.log(JSON.stringify({ status: 'SUCCESS', command: { data: {} } }))"
  ])

  writeFakeCli(bin, 'pi', [
    "import { appendFileSync } from 'node:fs'",
    `appendFileSync(${JSON.stringify(callsLog)}, JSON.stringify({ cli: 'pi', args: process.argv.slice(2) }) + '\\n')`,
    "console.log('deepseek  deepseek-v4.1-flash  1M  384K  yes  yes')"
  ])

  writeFakeCli(bin, 'codex', [
    "import { appendFileSync } from 'node:fs'",
    "import { createInterface } from 'node:readline'",
    `const log = ${JSON.stringify(callsLog)}`,
    'const args = process.argv.slice(2)',
    "if (args.includes('--version')) { console.log('codex 1.0.0'); process.exit(0) }",
    'for await (const line of createInterface({ input: process.stdin })) {',
    '  const msg = JSON.parse(line)',
    '  if (msg.method === "initialize") {',
    '    appendFileSync(log, JSON.stringify({ cli: "codex-init", version: msg.params.clientInfo.version }) + "\\n")',
    '    process.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + "\\n")',
    '  } else if (msg.method === "model/list") {',
    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { data: [{ model: "gpt-6.1-sol", displayName: "Sol", inputModalities: ["text"] }], nextCursor: null } }) + "\\n")',
    '  } else if (msg.method === "config/read") {',
    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { config: { model: "gpt-6.1-sol" } } }) + "\\n")',
    '  } else if (msg.method === "account/read") {',
    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { account: null, requiresOpenaiAuth: false } }) + "\\n")',
    '    process.exit(0)',
    '  }',
    '}'
  ])

  const prevPath = process.env.PATH
  t.after(() => {
    process.env.PATH = prevPath
    clearDetectCache()
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })

  clearDetectCache()
  process.env.PATH = bin + delimiter + prevPath
  await detectCli('agy', projA, { ttlMs: 2000 })
  await detectCli('agy', projB, { ttlMs: 2000 })
  await discoverPi(projA, { ttlMs: 2000 })
  await discoverPi(projB, { ttlMs: 2000 })

  const logs1 = readFileSync(callsLog, 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(logs1.filter(e => e.cli === 'agy').length, 5)
  assert.equal(logs1.filter(e => e.cli === 'pi').length, 1)
  assert.equal(detectCacheSize(), 2)

  await detectCli('codex', projA, { now: Date.now() + 5000, ttlMs: 5000 })
  assert.equal(detectCacheSize(), 1)
  const logs2 = readFileSync(callsLog, 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(logs2.find(e => e.cli === 'codex-init').version, '1.0.0')
})

test('packaged model-catalog.json validates cleanly, populates all 8 picks for agy-only workspaces, and resolveAgyModel supports off/ultra', () => {
  const raw = JSON.parse(readFileSync(join(worktreeRoot, 'lib/model-catalog.json'), 'utf8'))
  validateModelCatalog(raw)

  assert.throws(() => validateModelCatalog({
    ...raw,
    picks: { ...raw.picks, daily_coding: { first: ['nonexistent-model-xyz'], backup: [] } }
  }), /unknown model ID: nonexistent-model-xyz/)
  assert.throws(() => validateModelCatalog({ ...raw, as_of: '2026-02-30' }), /Invalid catalog as_of/)

  const catalog = loadCatalog('/nonexistent/cc-bro-r2')
  const agyOnlyWorkers = [{
    id: 'agy',
    allowed: true,
    models: [
      'gemini-4-argon',
      'gemini-4-hydrogen',
      'gemini-4-carbon',
      'gemini-3.8-flash',
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      'gpt-oss-120b'
    ].map(id => ({ id, catalog: catalog.models.find(m => m.id === id) }))
  }]
  const picks = visiblePicks(catalog, agyOnlyWorkers)
  for (const key of Object.keys(raw.picks)) {
    assert.ok(picks[key].first.length + picks[key].backup.length > 0, 'Expected visible agy pick for ' + key)
  }
  assert.ok(picks.daily_coding.first.includes('gemini-4-carbon'))
  assert.ok(picks.review_find_bugs.first.includes('gemini-4-hydrogen'))
  assert.ok(picks.docs_simple_writing.first.includes('gemini-3.8-flash'))

  assert.deepEqual(resolveAgyModel('gemini-4-argon-ultra', 'low'), { model: 'gemini-4-argon-low', passEffortFlag: false })
  assert.deepEqual(resolveAgyModel('gemini-3.8-flash-off', 'high'), { model: 'gemini-3.8-flash-high', passEffortFlag: false })
})

test('Roster surfaces native+observed quota failures, warns on filtered allowed bros, validates defaults, and cleans trial dirs', async t => {
  const root = mkdtempSync(join(tmpdir(), 'cc-bro-roster-r2-'))
  const bin = join(root, 'bin')
  mkdirSync(bin)

  writeFakeCli(bin, 'trial-ok', [
    "import { readFileSync, writeFileSync } from 'node:fs'",
    "import { join } from 'node:path'",
    'const args = process.argv.slice(2)',
    'const state = join(process.cwd(), "memo.txt")',
    'if (args[0] === "--new") {',
    '  const code = /[0-9a-f-]{36}/.exec(args[1])?.[0] ?? ""',
    '  writeFileSync(state, code)',
    '  console.log(JSON.stringify({ id: "sess-1", reply: "ACK" }))',
    '} else {',
    '  console.log(JSON.stringify({ id: args[1], reply: readFileSync(state, "utf8") }))',
    '}'
  ])

  writeFakeCli(bin, 'codex', [
    "import { createInterface } from 'node:readline'",
    'const args = process.argv.slice(2)',
    "if (args.includes('--version')) { console.log('codex 1.0'); process.exit(0) }",
    'for await (const line of createInterface({ input: process.stdin })) {',
    '  const msg = JSON.parse(line)',
    '  if (msg.method === "initialize") process.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + "\\n")',
    '  else if (msg.method === "model/list") process.stdout.write(JSON.stringify({ id: msg.id, result: { data: [], nextCursor: null } }) + "\\n")',
    '  else if (msg.method === "config/read") process.stdout.write(JSON.stringify({ id: msg.id, result: { config: {} } }) + "\\n")',
    '  else if (msg.method === "account/read") { process.stdout.write(JSON.stringify({ id: msg.id, result: { account: null, requiresOpenaiAuth: true } }) + "\\n"); process.exit(0) }',
    '}'
  ])

  const prevPath = process.env.PATH
  let db
  let store
  t.after(() => {
    process.env.PATH = prevPath
    clearDetectCache()
    store?.db.close()
    db?.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })
  clearDetectCache()
  process.env.PATH = bin + delimiter + prevPath

  db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,repoPath TEXT,created INTEGER,allow TEXT,worker TEXT,concurrency INTEGER)')
  const project = { id: 'p-1', name: 'demo', repoPath: root, allow: ['codex'], worker: 'codex', concurrency: null }
  db.prepare('INSERT INTO projects VALUES (?,?,?,?,?,?,?)').run(project.id, project.name, project.repoPath, Date.now(), JSON.stringify(project.allow), project.worker, null)

  store = new Store(false, join(root, 'tickets.sqlite'))
  const conv = store.create('agy-429', root, 'gemini-4-argon-high', 'Rate test', 'high', 'agy')
  store.accept(conv, 'test prompt')
  store.finish(conv.id, 1, 'error', '429 rate limit exceeded on RPM bucket', null, { class: 'quota', message: '429 rate limit exceeded on RPM bucket' })

  const projects = {
    db,
    entries: new Map([[project.id, project]]),
    crews: () => [{ store }],
    publish() {},
    get(id) {
      if (id !== project.id) throw new Error('Unknown project')
      return project
    }
  }
  const roster = new Roster(projects)

  const sampleRows = [{
    id: 'agy',
    allowed: true,
    quota: { source: 'native', windows: [{ minutes: 300, usedPercent: 10, resetsAt: null }], reached: false, avoid: false, plentiful: true }
  }]
  roster.observe(sampleRows)
  assert.equal(sampleRows[0].recentProblem?.class, 'quota')
  assert.match(sampleRows[0].recentProblem?.message ?? '', /429 rate limit/)

  const listed = await roster.list(project.id, false, { refresh: true })
  assert.equal(listed.workers.some(w => w.id === 'codex'), false)
  assert.ok(listed.warnings?.some(w => /Allowed bro codex is signed-out; run: codex login/.test(w)))
  const compact = rosterOutput(listed)
  assert.match(rosterText(compact), /Notice: Allowed bro codex is signed-out; run: codex login/)
  assert.throws(() => rosterOutput(listed, { worker: 'codex' }), /not in the detected roster.*codex login/)

  roster.setHiddenModels(project.id, 'codex', { hide: ['gpt-6.1-sol'] })
  assert.throws(() => roster.setDefaults(project.id, 'codex', { model: 'gpt-6.1-sol-high' }), /Model is hidden/)
  assert.throws(() => roster.setDefaults(project.id, 'codex', { effort: 'bad effort!' }), /Invalid effort/)

  const out = JSON.parse(execFileSync(process.execPath, [
    '--input-type=module',
    '-e',
    `
      import { readdirSync, existsSync } from 'node:fs'
      import { delimiter, join } from 'node:path'
      import { DatabaseSync } from 'node:sqlite'
      import { Roster } from './lib/roster.mjs'
      import { home } from './lib/paths.mjs'
      const db = new DatabaseSync(':memory:')
      const r = new Roster({ db, crews: () => [], get() { return { id: 'p' } } })
      const tpl = {
        command: 'trial-ok',
        newArgs: ['--new', '{prompt}'],
        resumeArgs: ['--resume', '{session}', '{prompt}'],
        modelArgs: [],
        effortArgs: [],
        format: 'json',
        reply: { path: 'reply' },
        session: { path: 'id' }
      }
      const res = await r.trial('global', tpl)
      const dir = join(home, 'template-tests')
      const remaining = existsSync(dir) ? readdirSync(dir).filter(n => n.startsWith('trial-')) : []
      db.close()
      console.log(JSON.stringify({ status: res.status, remaining }))
    `
  ], {
    cwd: worktreeRoot,
    env: prependPath({ ...process.env, BROCO_HOME: join(root, 'broco-home') }, bin),
    encoding: 'utf8'
  }).trim())
  assert.equal(out.status, 'passed')
  assert.deepEqual(out.remaining, [])
})

test('Projects coalesces SSE events, tracks runningCount + web_port + statusSnapshot, releases idle workers on uninit, and protects undo', () => {
  const root = mkdtempSync(join(tmpdir(), 'cc-bro-projects-r2-'))
  try {
    const out = JSON.parse(execFileSync(process.execPath, [
      '--input-type=module',
      '-e',
      `
        import assert from 'node:assert/strict'
        import { mkdirSync } from 'node:fs'
        import { delimiter, join } from 'node:path'
        import { Projects } from './lib/projects.mjs'
        import { Slots } from './lib/slots.mjs'

        const base = process.env.TEST_PROJ_BASE
        const repoA = join(base, 'repo-a')
        const repoB = join(base, 'repo-b')
        const outside = join(base, 'outside')
        mkdirSync(repoA); mkdirSync(repoB); mkdirSync(outside)

        let listenersActive = false
        const published = []
        const ticketHooks = []
        const mgr = new Projects(new Slots(3), ev => published.push(ev), () => listenersActive)
        mgr.onTicketChange = (pid, cids) => ticketHooks.push([pid, cids.length])

        const walMode = mgr.db.prepare('PRAGMA journal_mode').get().journal_mode
        assert.equal(walMode.toLowerCase(), 'wal')

        assert.equal(mgr.readWebPort(), null)
        mgr.saveWebPort(43123)
        assert.equal(mgr.readWebPort(), 43123)

        const regA = mgr.register(repoA, 'codex', 'codex')
        const regB = mgr.register(repoB, 'agy', 'agy')
        published.length = 0

        const pA = mgr.get(regA.id)
        const c1 = pA.crew.store.create('t1', repoA, 'gpt-6.1-sol', 'Task 1', 'medium', 'codex')
        pA.crew.store.accept(c1, 'work 1')
        pA.crew.store.working(c1)
        await new Promise(r => queueMicrotask(r))
        assert.equal(ticketHooks.length, 1)
        assert.equal(published.length, 0)

        assert.equal(mgr.summary(regA.id).runningCount, 1)
        pA.crew.store.finish(c1.id, 1, 'error', 'boom')
        await new Promise(r => queueMicrotask(r))
        const sumAfterErr = mgr.summary(regA.id)
        assert.equal(sumAfterErr.counts.working, 1)
        assert.equal(sumAfterErr.runningCount, 0)

        listenersActive = true
        published.length = 0
        const cSmall = pA.crew.store.create('tsmall', repoA, 'gpt-6.1-sol', 'Small', 'medium', 'codex')
        pA.crew.store.accept(cSmall, 'small work')
        await new Promise(r => queueMicrotask(r))
        assert.equal(published.filter(e => e.type === 'ticket').length, 1)
        assert.equal(published.filter(e => e.type === 'tickets').length, 0)
        assert.equal(published.filter(e => e.type === 'project').length, 1)

        published.length = 0
        for (let i = 2; i <= 7; i++) {
          const ci = pA.crew.store.create('t' + i, repoA, 'gpt-6.1-sol', 'Task ' + i, 'medium', 'codex')
          pA.crew.store.accept(ci, 'work ' + i)
        }
        await new Promise(r => queueMicrotask(r))
        assert.equal(published.filter(e => e.type === 'tickets').length, 1)
        assert.equal(published.filter(e => e.type === 'ticket').length, 0)
        assert.equal(published.filter(e => e.type === 'project').length, 1)

        const snapOutside = mgr.statusSnapshot({ cwd: outside })
        assert.equal(snapOutside.project, null)
        assert.equal(snapOutside.projects.length, 2)
        assert.equal(snapOutside.runnerState.webPort, 43123)

        const snapA = mgr.statusSnapshot({ cwd: repoA, all: true })
        assert.equal(snapA.project.id, regA.id)
        assert.equal(snapA.project.errorCount, 1)
        assert.equal(snapA.projects.length, 2)

        const gAudit = mgr.roster.setConcurrency('global', 4, 'agent')
        const bAudit = mgr.roster.setConcurrency(regB.id, 6, 'agent')

        for (let i = 0; i < 260; i++) {
          mgr.roster.audit.record({ scope: 'global', scopeName: 'Global', actor: 'agent', action: 'note', summary: 'n' + i, before: {}, after: {} })
        }
        assert.equal(mgr.roster.auditList('global', 250).length, 250)

        let releasedIdle = false
        const pB = mgr.get(regB.id)
        pB.crew.workers.set('fake-cid', { fake: true })
        pB.crew.releaseAll = async () => {
          releasedIdle = true
          pB.crew.workers.clear()
        }
        const uninitPromise = mgr.uninit(repoB)
        assert.equal(typeof uninitPromise.then, 'function')
        const uninitB = await uninitPromise
        assert.equal(uninitB.unregistered, true)
        assert.equal(releasedIdle, true)

        assert.throws(() => mgr.roster.undoAudit(bAudit.auditId), /already reverted|no longer registered/)
        const latestUndo = mgr.roster.audit.latestUndoable(null)
        assert.notEqual(latestUndo?.scope, regB.id)

        assert.throws(() => mgr.uninit(repoA), /Stop running or queued/)
        for (const row of pA.crew.store.stmt("SELECT id, turn FROM conversations WHERE status='queued'").all()) {
          pA.crew.store.finish(row.id, row.turn, 'stopped', 'Stopped')
        }
        const syncUninitA = mgr.uninit(repoA)
        assert.equal(syncUninitA.unregistered, true)
        mgr.db.close()
        console.log(JSON.stringify({ ok: true, gAuditId: gAudit.auditId }))
      `
    ], {
      cwd: worktreeRoot,
      env: { ...process.env, BROCO_HOME: join(root, 'data'), TEST_PROJ_BASE: root },
      encoding: 'utf8'
    }).trim())
    assert.equal(out.ok, true)
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

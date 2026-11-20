import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import test from 'node:test'
import { agyQuota, codexQuota, quotaText, tight, windowLabel } from '../lib/quota.mjs'
import { clearDetectCache, detectCli, discoverPi, readAgyQuota } from '../lib/detect.mjs'
import { Store } from '../lib/store.mjs'
import { writeFakeCli } from './harness.mjs'

const sampleUsage = {
  status: 'SUCCESS',
  command: {
    name: 'usage',
    data: {
      groups: [
        {
          name: 'Gemini Models',
          buckets: [
            { id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0.986119, reset_time: '2026-11-24T16:06:25Z' },
            { id: 'gemini-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 0.954479, reset_time: '2026-11-17T21:06:25Z' }
          ]
        },
        {
          name: 'Claude and GPT models',
          buckets: [
            { id: '3p-weekly', window: 'weekly', remaining_fraction: 1, reset_time: '2026-11-24T16:57:37Z' },
            { id: '3p-5h', window: '5h', remaining_fraction: 1, reset_time: '2026-11-17T21:57:37Z' }
          ]
        }
      ]
    }
  }
}

test('agyQuota normalizes Gemini and 3P buckets, marks plentiful budgets, and integrates with Store.quota', () => {
  const q = agyQuota(sampleUsage)
  assert.equal(q.source, 'native')
  assert.equal(q.reached, false)
  assert.equal(q.plentiful, true)
  assert.equal(tight(q), false)
  assert.deepEqual(q.windows, [
    { minutes: 300, usedPercent: 4.6, resetsAt: '2026-11-17T21:06:25Z' },
    { minutes: 10080, usedPercent: 1.4, resetsAt: '2026-11-24T16:06:25Z' }
  ])
  assert.equal(q.groups.length, 2)
  assert.equal(q.groups[0].name, 'Gemini Models')
  assert.equal(q.groups[1].name, 'Claude and GPT models')
  assert.deepEqual(q.groups[1].windows.map(w => [w.id, w.minutes, w.usedPercent]), [
    ['3p-5h', 300, 0],
    ['3p-weekly', 10080, 0]
  ])
  assert.equal(windowLabel(300), '5h')
  assert.equal(windowLabel(10080), 'week')
  const prevTz = process.env.BROCO_TZ
  try {
    process.env.BROCO_TZ = 'Asia/Shanghai'
    const text = quotaText(q)
    assert.match(text, /^quota=5h 4\.6% used \(resets 11-18 05:06\) · week 1\.4% used \(resets 11-25 00:06\) · 额度宽裕，可调高并发 \/ plenty of quota$/)
    process.env.BROCO_TZ = 'UTC'
    assert.match(quotaText(q), /^quota=5h 4\.6% used \(resets 11-17 21:06\) · week 1\.4% used \(resets 11-24 16:06\)/)
  } finally {
    if (prevTz === undefined) delete process.env.BROCO_TZ
    else process.env.BROCO_TZ = prevTz
  }

  const dir = mkdtempSync(join(tmpdir(), 'cc-bro-agy-store-'))
  const store = new Store(false, join(dir, 'tickets.sqlite'))
  try {
    const afterUsage = structuredClone(sampleUsage)
    afterUsage.command.data.groups[0].buckets[0].remaining_fraction = 0.966119
    afterUsage.command.data.groups[0].buckets[1].remaining_fraction = 0.904479
    const after = agyQuota(afterUsage)
    const c = store.create('agy-job', dir, 'gemini-4-argon-high', 'Agy quota turn', 'high', 'agy')
    store.accept(c, 'run')
    store.event(c.id, 1, 'quota', q, '')
    store.event(c.id, 1, 'quota', after, '')
    const spent = store.quota(c.id, 1).spent
    assert.equal(spent.length, 2)
    assert.equal(spent[0].minutes, 300)
    assert.equal(Math.round(spent[0].percent * 10) / 10, 5)
    assert.equal(spent[1].minutes, 10080)
    assert.equal(Math.round(spent[1].percent * 10) / 10, 2)
  } finally {
    store.db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('agyQuota and codexQuota clamp bounds, gate plentiful on !avoid, and format unreported fallback', () => {
  const clamped = agyQuota({
    groups: [{
      name: 'Other Group',
      buckets: [
        { id: 'over', window: '5h', remaining_fraction: 1.2, reset_time: '2026-11-17T21:06:25Z' },
        { id: 'under', window: 'weekly', remaining_fraction: -0.1, reset_time: '2026-11-24T16:06:25Z' }
      ]
    }]
  })
  assert.deepEqual(clamped.windows.map(w => w.usedPercent), [0, 100])
  assert.equal(clamped.reached, true)
  assert.equal(clamped.plentiful, false)
  assert.ok(tight(clamped))
  assert.match(quotaText(clamped), /先别派 \/ avoid$/)

  const codexAmple = codexQuota({ planType: 'pro', primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1794666185 }, secondary: { usedPercent: 25, windowDurationMins: 10080, resetsAt: 1795000000 } })
  assert.equal(codexAmple.plentiful, true)
  assert.match(quotaText(codexAmple), /额度宽裕，可调高并发 \/ plenty of quota$/)

  const codexBlocked = codexQuota({ planType: 'pro', primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1794666185 } }, false)
  assert.equal(codexBlocked.reached, true)
  assert.equal(codexBlocked.plentiful, false)
  assert.match(quotaText(codexBlocked), /先别派 \/ avoid$/)

  assert.equal(agyQuota(null), null)
  assert.equal(agyQuota({ status: 'ERROR', command: { data: sampleUsage.command.data } }), null)
  assert.equal(agyQuota({ groups: [] }), null)
  assert.equal(quotaText(null), 'quota=unknown')
  assert.equal(quotaText(null, { unreported: true }), 'quota=unreported (CLI does not report usage)')
})

test('detectCli runs agy probes in parallel, caches by env key, supports refresh/clear, and readAgyQuota reads live usage', async t => {
  const root = mkdtempSync(join(tmpdir(), 'cc-bro-agy-detect-'))
  const binA = join(root, 'bin-a')
  const binB = join(root, 'bin-b')
  const work = join(root, 'work')
  mkdirSync(binA); mkdirSync(binB); mkdirSync(work)
  const logA = join(root, 'calls-a.log')
  const stateFile = join(root, 'fraction.txt')
  writeFileSync(stateFile, '0.92')

  const scriptA = [
    '#!/usr/bin/env node',
    "import { appendFileSync, readFileSync } from 'node:fs'",
    "import { setTimeout as sleep } from 'node:timers/promises'",
    `const log = ${JSON.stringify(logA)}, state = ${JSON.stringify(stateFile)}`,
    'const args = process.argv.slice(2)',
    "appendFileSync(log, JSON.stringify({ phase: 'start', args }) + '\\n')",
    'await sleep(250)',
    "appendFileSync(log, JSON.stringify({ phase: 'end', args }) + '\\n')",
    "if (args.includes('--version')) { console.log('agy 1.5.10'); process.exit(0) }",
    "if (args.includes('models')) { console.log('gemini-4-argon-medium\\tGemini 4 Argon (Medium)\\ngemini-4-argon-high\\tGemini 4 Argon (High)'); process.exit(0) }",
    "if (args.includes('/effort')) { console.log(JSON.stringify({ status: 'SUCCESS', command: { data: { current: 'medium', available: ['low', 'medium', 'high'] } } })); process.exit(0) }",
    "if (args.includes('/model')) { console.log(JSON.stringify({ status: 'SUCCESS', command: { data: { id: 'gemini-4-argon-medium' } } })); process.exit(0) }",
    "if (args.includes('/usage')) {",
    '  const rem = Number(readFileSync(state, "utf8").trim())',
    "  console.log(JSON.stringify({ status: 'SUCCESS', command: { name: 'usage', data: { groups: [{ name: 'Gemini Models', buckets: [{ id: 'gemini-5h', window: '5h', remaining_fraction: rem, reset_time: '2026-11-17T21:06:25Z' }, { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.95, reset_time: '2026-11-24T16:06:25Z' }] }] } } }))",
    '  process.exit(0)',
    '}',
    'process.exit(2)'
  ].join('\n')
  writeFakeCli(binA, 'agy', scriptA)

  const scriptB = [
    'const args = process.argv.slice(2)',
    "if (args.includes('--version')) { console.log('agy 2.0.0-swapped'); process.exit(0) }",
    "if (args.includes('models')) { console.log('claude-sonnet-4-6\\tClaude Sonnet 4.6'); process.exit(0) }",
    "if (args.includes('/effort')) { console.log(JSON.stringify({ status: 'SUCCESS', command: { data: { current: 'high', available: ['low', 'high'] } } })); process.exit(0) }",
    "if (args.includes('/model')) { console.log(JSON.stringify({ status: 'SUCCESS', command: { data: { id: 'claude-sonnet-4-6' } } })); process.exit(0) }",
    "if (args.includes('/usage')) { console.log(JSON.stringify({ status: 'SUCCESS', command: { name: 'usage', data: { groups: [{ name: 'Gemini Models', buckets: [{ id: 'g-5h', window: '5h', remaining_fraction: 0.5, reset_time: '2026-11-17T21:06:25Z' }] }] } } })); process.exit(0) }",
    'process.exit(2)'
  ]
  writeFakeCli(binB, 'agy', scriptB)

  const originalPath = process.env.PATH
  t.after(() => {
    process.env.PATH = originalPath
    clearDetectCache()
    rmSync(root, { recursive: true, force: true })
  })

  clearDetectCache()
  process.env.PATH = binA + delimiter + originalPath
  const first = await detectCli('agy', work)
  assert.equal(first.version, 'agy 1.5.10')
  assert.equal(first.defaultModel, 'gemini-4-argon-medium')
  assert.equal(first.defaultEffort, 'medium')
  assert.equal(first.quota.windows[0].usedPercent, 8)
  assert.equal(first.quota.plentiful, true)
  const firstEvents = readFileSync(logA, 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(firstEvents.filter(e => e.phase === 'start').length, 5)
  assert.ok(firstEvents.findIndex(e => e.phase === 'end') >= 4, 'expected concurrent execution, got order: ' + firstEvents.map(e => e.phase).join(','))

  first.warnings.push('caller mutation')
  const cached = await detectCli('agy', work)
  assert.deepEqual(cached.warnings, [])
  assert.equal(readFileSync(logA, 'utf8').trim().split('\n').filter(l => JSON.parse(l).phase === 'start').length, 5)

  writeFileSync(stateFile, '0.80')
  const liveQuota = await readAgyQuota(work)
  assert.equal(liveQuota.windows[0].usedPercent, 20)
  assert.equal((await detectCli('agy', work)).quota.windows[0].usedPercent, 8)

  const refreshed = await detectCli('agy', work, { refresh: true })
  assert.equal(refreshed.quota.windows[0].usedPercent, 20)

  process.env.PATH = binB + delimiter + originalPath
  const swapped = await detectCli('agy', work)
  assert.equal(swapped.version, 'agy 2.0.0-swapped')
  assert.equal(swapped.defaultModel, 'claude-sonnet-4-6')
  assert.equal(swapped.quota.windows[0].usedPercent, 50)
  assert.equal(swapped.quota.plentiful, false)

  clearDetectCache()
  process.env.PATH = binA + delimiter + originalPath
  assert.equal((await detectCli('agy', work)).version, 'agy 1.5.10')
})

test('detectCli populates pi reasoning model efforts from get_available_thinking_levels with fallback', async t => {
  const root = mkdtempSync(join(tmpdir(), 'cc-bro-pi-efforts-'))
  const bin = join(root, 'bin')
  const work = join(root, 'work')
  mkdirSync(bin); mkdirSync(work)
  const noLevelsFlag = join(root, 'no-levels')

  const fakePi = [
    "import { existsSync } from 'node:fs'",
    "import { createInterface } from 'node:readline'",
    `const noLevels = ${JSON.stringify(noLevelsFlag)}`,
    'const args = process.argv.slice(2)',
    "if (args.includes('--version')) { console.log('1.5.0'); process.exit(0) }",
    "if (args.includes('--list-models')) { console.log('zai-coding-cn  glm-5.3  1M  128K  yes  no'); process.exit(0) }",
    "if (args[0] === 'auth') { console.log(JSON.stringify({ status: 'ready', authType: 'api_key' })); process.exit(0) }",
    "if (args.includes('--no-session')) {",
    '  for await (const line of createInterface({ input: process.stdin })) {',
    '    const req = JSON.parse(line)',
    "    if (req.type === 'get_state') process.stdout.write(JSON.stringify({ id: req.id, type: 'response', success: true, data: { model: { provider: 'zai-coding-cn', id: 'glm-5.3' }, thinkingLevel: 'medium' } }) + '\\n')",
    "    else if (req.type === 'get_available_models') process.stdout.write(JSON.stringify({ id: req.id, type: 'response', success: true, data: { models: [{ provider: 'zai-coding-cn', id: 'glm-5.3', name: 'GLM 5.3', reasoning: true, input: ['text'], contextWindow: 1048576, maxTokens: 128000 }, { provider: 'zai-coding-cn', id: 'plain', name: 'Plain', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 16384 }] } }) + '\\n')",
    "    else if (req.type === 'get_available_thinking_levels') {",
    '      const levels = existsSync(noLevels) ? [] : ["low", "medium", "high", "xhigh"]',
    "      process.stdout.write(JSON.stringify({ id: req.id, type: 'response', success: true, data: { levels } }) + '\\n')",
    '    }',
    '  }',
    '}'
  ]
  writeFakeCli(bin, 'pi', fakePi)

  const originalPath = process.env.PATH
  t.after(() => {
    process.env.PATH = originalPath
    clearDetectCache()
    rmSync(root, { recursive: true, force: true })
  })

  clearDetectCache()
  process.env.PATH = bin + delimiter + originalPath
  assert.deepEqual(await discoverPi(work), ['pi:zai-coding-cn'])
  const detected = await detectCli('pi:zai-coding-cn', work)
  assert.deepEqual(detected.models[0].efforts, ['low', 'medium', 'high', 'xhigh'])
  assert.deepEqual(detected.models[1].efforts, ['off'])

  writeFileSync(noLevelsFlag, '1')
  const fallback = await detectCli('pi:zai-coding-cn', work, { refresh: true })
  assert.deepEqual(fallback.models[0].efforts, ['low', 'medium', 'high'])
})

import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { harness } from './harness.mjs'
import { hiddenModel, loadCatalog, matchModel, modelCapabilities, resolveAgyModel, staleDefaultWarning } from '../lib/model-catalog.mjs'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jzwoAAAAASUVORK5CYII=', 'base64')
async function web(h) {
  const url = await h.cli('ui', '--no-open')
  return async (path, data) => {
    const response = await fetch(url + '/api/' + path, { method: data ? 'POST' : 'GET', headers: { Origin: url, 'Content-Type': 'application/json' }, body: data ? JSON.stringify(data) : undefined })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error.message)
    return result
  }
}

test('catalog matches exact IDs and aliases with suffixes, merges overrides and exposes age', t => {
  const h = harness(t), path = join(h.data, 'models.json')
  mkdirSync(h.data, { recursive: true })
  writeFileSync(path, JSON.stringify({ as_of: '2000-01-01', models: [{ id: 'gpt-6.1-sol', grade: 'Local', summary: { en: 'Local summary' } }, { id: 'local-one', modalities: { input: ['text'] } }] }))
  const catalog = loadCatalog(path)
  const sol = matchModel('openai-codex/gpt-6.1-sol-high-fast', catalog)
  assert.equal(sol.grade, 'Local'); assert.equal(sol.summary.en, 'Local summary'); assert.ok(sol.summary.zh); assert.equal(sol.stale, true)
  assert.equal(matchModel('gemini-3.7-flash-thinking', catalog).id, 'gemini-3.8-flash')
  assert.equal(matchModel('gpt-6.1-sol-surprise', catalog), null)
  assert.equal(matchModel('local-one', catalog).id, 'local-one')
  writeFileSync(path, JSON.stringify({as_of:'2026-99-99',models:[{id:'gpt-6.1-sol'}]}))
  assert.equal(matchModel('gpt-6.1-sol',loadCatalog(path)).stale,true)
  writeFileSync(path, '{broken')
  assert.equal(loadCatalog(path).warnings.length, 1)
  assert.ok(hiddenModel('grok-4.7[effort=high]', ['grok-4.7-low']))

  const builtin = loadCatalog('/nonexistent/cc-bro-model-overrides')
  assert.equal(builtin.as_of, '2026-11-18')
  assert.equal(builtin.modalities_as_of, '2026-11-18')
  assert.equal(matchModel('gemini-4-carbon-medium', builtin)?.id, 'gemini-4-carbon')
  assert.equal(matchModel('gemini-4-hydrogen-xhigh', builtin)?.id, 'gemini-4-hydrogen')
  assert.equal(matchModel('gemini-pro-orchestrator', builtin)?.id, 'gemini-pro-orchestrator')
  assert.equal(matchModel('gemini-pro-orchestrator-argon', builtin)?.id, 'gemini-pro-orchestrator')
  assert.equal(matchModel('claude-sonnet-4-6', builtin)?.id, 'claude-sonnet-4-6')
  assert.equal(matchModel('claude-opus-4-6-thinking', builtin)?.id, 'claude-opus-4-6')
  assert.equal(matchModel('opus', builtin)?.id, 'claude-opus-5')
  assert.equal(matchModel('sonnet', builtin)?.id, 'claude-sonnet-5')
  assert.equal(matchModel('haiku', builtin)?.id, 'claude-haiku-5-5')
  assert.equal(matchModel('fable', builtin)?.id, 'claude-fable-5')
  assert.equal(matchModel('gpt-oss-120b-medium', builtin)?.id, 'gpt-oss-120b')
  assert.equal(matchModel('zai-coding-cn/glm-4.6v', builtin)?.tier, 'previous generation')
})

test('capabilities intersect CLI transport and model metadata, CLI limits win over API limits, text is never unknown', () => {
  const catalog = loadCatalog('/nonexistent/cc-bro-model-overrides')
  const model = matchModel('gpt-6.1-sol', catalog)
  const caps = modelCapabilities('pi:openai-codex', { input: ['text','image'], contextWindow: 272000, maxTokens: 10000 }, model)
  assert.equal(caps.context_tokens, 272000); assert.equal(caps.max_output_tokens, 10000); assert.equal(caps.sources.context_tokens, 'cli')
  assert.equal(caps.input.image, true); assert.equal(caps.input.audio, false)
  const video = { modalities: { input: ['text','image','video'], context_tokens: 1000000 } }
  assert.equal(modelCapabilities('agy', {}, video).input.video, true)
  assert.equal(modelCapabilities('agy', {}, video).input.image, true)
  assert.equal(modelCapabilities('agy', {}, video).input.pdf, false)
  assert.equal(modelCapabilities('codex', {}, video).input.video, false)
  assert.deepEqual(modelCapabilities('agy', {}, matchModel('gemini-4-argon', catalog)).input, { text: true, image: true, audio: true, video: true, pdf: true })
  assert.deepEqual(modelCapabilities('claude', {}, matchModel('opus', catalog)).input, { text: true, image: true, audio: false, video: false, pdf: true })
  assert.equal(modelCapabilities('claude', {}, null).input.audio, false)
  assert.equal(modelCapabilities('claude', {}, null).input.pdf, 'unknown')
  assert.equal(modelCapabilities('codex', {}, null).input.image, 'unknown')
  assert.equal(modelCapabilities('codex', {}, null).input.text, true)
  assert.equal(modelCapabilities('cursor-agent', { id: 'unlisted' }, null).input.text, true)
  assert.equal(modelCapabilities('agy', { input: ['image'] }, null).input.text, false)
  assert.equal(modelCapabilities('pi:x', { input: ['text'] }, model).input.image, false)
  assert.equal(modelCapabilities('codex', {}, model).sources.context_tokens, 'catalog-api-limit')
})

test('resolveAgyModel and staleDefaultWarning normalize effort variants and detect stale or unlisted defaults', () => {
  const listed = ['gemini-4-argon-low', 'gemini-4-argon-medium', 'gemini-4-argon-high', 'gemini-pro-orchestrator', 'claude-sonnet-4-6']
  assert.deepEqual(resolveAgyModel('gemini-4-argon', 'high', listed), { model: 'gemini-4-argon-high', passEffortFlag: false })
  assert.deepEqual(resolveAgyModel('gemini-4-argon-medium', 'high', listed), { model: 'gemini-4-argon-high', passEffortFlag: false })
  assert.deepEqual(resolveAgyModel('gemini-4-argon', 'high'), { model: 'gemini-4-argon-high', passEffortFlag: false })
  assert.deepEqual(resolveAgyModel('gemini-4-argon-medium', 'high'), { model: 'gemini-4-argon-high', passEffortFlag: false })
  assert.deepEqual(resolveAgyModel('gemini-4-argon', null, listed), { model: 'gemini-4-argon-medium', passEffortFlag: false })
  assert.deepEqual(resolveAgyModel('gemini-4-argon', null), { model: 'gemini-4-argon-medium', passEffortFlag: false })
  assert.deepEqual(resolveAgyModel('claude-sonnet-4-6', 'high', listed), { model: 'claude-sonnet-4-6', passEffortFlag: true })
  assert.deepEqual(resolveAgyModel('claude-sonnet-4-6', null, listed), { model: 'claude-sonnet-4-6', passEffortFlag: false })
  assert.deepEqual(resolveAgyModel('gemini-pro-orchestrator', 'high', listed), { model: 'gemini-pro-orchestrator', passEffortFlag: true })
  assert.deepEqual(resolveAgyModel('agy', 'high', listed), { model: 'agy', passEffortFlag: true })
  assert.deepEqual(resolveAgyModel('agy', null, listed), { model: 'agy', passEffortFlag: false })

  const catalog = loadCatalog('/nonexistent/cc-bro-model-overrides')
  assert.match(staleDefaultWarning('pi:zai-coding-cn', 'zai-coding-cn/glm-4.6v', [{ id: 'zai-coding-cn/glm-5.3' }], catalog), /glm-4\.6v.*older or superseded/)
  assert.match(staleDefaultWarning('pi:zai-coding-cn', 'zai-coding-cn/legacy-glm-custom', [{ id: 'zai-coding-cn/glm-5.3' }, { id: 'zai-coding-cn/glm-5.3-flash' }], catalog), /legacy-glm-custom.*glm-5\.3/)
  assert.equal(staleDefaultWarning('pi:zai-coding-cn', 'zai-coding-cn/glm-5.3', [{ id: 'zai-coding-cn/glm-5.3' }], catalog), null)
  assert.equal(staleDefaultWarning('codex', 'fixture-model', [{ id: 'fixture-model' }], catalog), null)
})

test('roster auto-discovers signed-in models and providers without granting project access', async t => {
  const h = harness(t)
  await h.cli('init', '--allow', 'codex')
  let r = await h.json('roster')
  assert.ok(r.workers.some(w => w.id === 'agy' && !w.allowed))
  writeFileSync(join(h.cwd, 'codex-signed-out'), '')
  assert.equal((await h.json('roster')).workers.some(w => w.id === 'codex'), false)
  rmSync(join(h.cwd, 'codex-signed-out'))
  writeFileSync(join(h.cwd, 'fixture-models.json'), JSON.stringify([{ model: 'gpt-6.1-sol-high', inputModalities: ['text','image'] }, { model: 'undocumented-new-model' }]))
  writeFileSync(join(h.cwd, 'fixture-pi-models.json'), JSON.stringify([{ provider: 'new-login', id: 'new-model', input: ['text'], contextWindow: 500000, maxTokens: 4096 }]))
  r = await h.json('roster')
  const codex = r.workers.find(w => w.id === 'codex')
  assert.equal(codex.models.length, 2); assert.equal(codex.models[0].catalog.id, 'gpt-6.1-sol'); assert.equal(codex.models[1].catalog, undefined)
  assert.equal(codex.models[1].capabilities.input.text, true)
  assert.deepEqual(r.workers.find(w => w.id === 'pi:new-login'), { id: 'pi:new-login', allowed: false })
  await assert.rejects(h.cli('say', 'denied', 'hello', '--worker', 'pi:new-login'), /not allowed/)
})

test('hidden model families leave roster and picks; project overrides, defaults and queued revocation are enforced', async t => {
  const h = harness(t, false, { BROCO_CONCURRENCY: '1' }), p = await h.json('init', '--allow', 'codex'), api = await web(h)
  writeFileSync(join(h.cwd, 'fixture-models.json'), JSON.stringify([{ model:'gpt-6.1-sol', inputModalities:['text','image'] }]))
  let global = await api('settings/global')
  global.entries = { codex: { model:'gpt-6.1-sol', effort:'high', hiddenModels:['gpt-6.1-sol-low'] } }
  await api('settings/global', global)
  let r = await h.json('roster')
  assert.ok(!JSON.stringify(r).includes('gpt-6.1-sol'))
  await assert.rejects(h.cli('say','blocked','hello'), /hidden/)
  await assert.rejects(h.cli('say','blocked','hello','--model','gpt-6.1-sol-high-fast'), /hidden/)
  let project = await api('settings/' + p.id)
  project.entries.codex = { hiddenModels: [] }
  await api('settings/' + p.id, project)
  r = await h.json('roster')
  assert.equal(r.workers[0].defaultModel,'gpt-6.1-sol'); assert.equal(r.workers[0].defaultEffort,'high')
  const first = await h.json('say','active','hold','--bg')
  assert.equal(first.model,'gpt-6.1-sol'); assert.equal(first.effort,'high')
  await h.cli('say','waiting','later','--bg')
  project = await api('settings/' + p.id); delete project.entries.codex.hiddenModels; await api('settings/' + p.id,project)
  await h.cli('stop','active')
  await assert.rejects(h.cli('wait','waiting','1'),/hidden/)
})

test('image attachments reach Codex and pi, persist for queued turns, unsupported media is refused', async t => {
  const h = harness(t), p = await h.json('init','--allow','codex,pi:deepseek,agy','--default-worker','codex'), api = await web(h)
  const file = join(h.cwd,'pixels.png'); writeFileSync(file,png)
  await h.cli('say','image','describe','--attach',file)
  const params = JSON.parse(readFileSync(join(h.cwd,'selections'),'utf8').trim())
  assert.equal(params.input[1].type,'localImage'); assert.deepEqual(readFileSync(params.input[1].path),png)
  await h.cli('say','pi-image','describe','--worker','pi:deepseek','--attach',file)
  const image = JSON.parse(readFileSync(join(h.cwd,'fixture-images'),'utf8').trim())[0]
  assert.equal(image.mimeType,'image/png'); assert.equal(image.data,png.toString('base64'))
  await h.cli('say','queue-image','hold','--bg')
  const receipt = await h.json('say','queue-image','describe followup','--attach',file,'--bg')
  assert.equal(receipt.outcome,'queued')
  rmSync(file)
  await h.cli('say','queue-image','finish','--bg')
  await h.cli('wait','queue-image','2')
  const records = readFileSync(join(h.cwd,'selections'),'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(records.at(-1).input[1].type,'localImage'); assert.deepEqual(readFileSync(records.at(-1).input[1].path),png)
  writeFileSync(file,png)
  await assert.rejects(h.cli('say','agy-image','describe','--worker','agy','--attach',file), /cannot accept/)
  const cfg = await api('settings/'+p.id); cfg.entries['pi:deepseek']={model:'deepseek/fixture-default',effort:'high'}; await api('settings/'+p.id,cfg)
  const defaults = await h.json('say','pi-default','worker-config','--worker','pi:deepseek')
  assert.equal(defaults.model,'deepseek/fixture-default'); assert.equal(defaults.effort,'high'); assert.equal(defaults.reply,'fixture-default high')
})

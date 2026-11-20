import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { modelEnvironment } from './model-env.mjs'
import { home, isolated } from './paths.mjs'
import { mask, parseRedactedJson, redactStderr, secretsFrom } from './pi-secrets.mjs'

const runtimePath = () => isolated ? [join(home, 'tools', 'bin'), process.env.PATH].filter(Boolean).join(delimiter) : process.env.PATH

export const HOST_SESSION_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_PARENT_SESSION_ID',
  'CLAUDE_CODE_AGENT_ID',
  'CODEX_THREAD_ID',
  'CODEX_INTERNAL_ORIGINATOR_OVERRIDE',
  'AI_AGENT',
  'PI_CODING_AGENT',
  'PI_SESSION_ID',
  'PI_SESSION_FILE',
  'PI_PROVIDER',
  'PI_MODEL',
  'PI_REASONING_LEVEL'
]

const pathValue = (obj, path) => path.split('.').reduce((v, key) => v?.[key], obj)
const clean = (s, what) => { if (typeof s !== 'string' || !s || s.length > 12000 || s.includes('\0')) throw new Error('Invalid ' + what); return s }
const array = (a, what) => { if (!Array.isArray(a) || a.length > 100) throw new Error('Expected argument array: ' + what); return a.map(v => clean(v, what)) }
const placeholders = new Set(['prompt', 'session', 'model', 'effort', 'cwd'])

export function validateTemplate(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Expected a CLI template')
  const t = { command: clean(raw.command, 'command'), newArgs: array(raw.newArgs, 'newArgs'), resumeArgs: array(raw.resumeArgs, 'resumeArgs'),
    modelArgs: array(raw.modelArgs ?? [], 'modelArgs'), effortArgs: array(raw.effortArgs ?? [], 'effortArgs'), stdin: raw.stdin ?? '', format: raw.format ?? 'jsonl', reply: raw.reply, session: raw.session }
  if (raw.versionArgs) t.versionArgs = array(raw.versionArgs, 'versionArgs')
  if (raw.actions) {
    t.actions = {}
    for (const key of ['install', 'upgrade', 'login']) if (raw.actions[key]) {
      t.actions[key] = array(raw.actions[key], 'actions.' + key)
      if (!t.actions[key].length) throw new Error('Action needs an executable')
    }
  }
  if (/[\r\n{}]/.test(t.command) || (!t.command.includes('/') && /\s/.test(t.command))) throw new Error('Command is one executable path, not a shell expression')
  if (!['json', 'jsonl', 'text'].includes(t.format)) throw new Error('Expected json, jsonl or text output')
  if (typeof t.stdin !== 'string') throw new Error('Expected stdin text')
  for (const s of [...t.newArgs, ...t.resumeArgs, ...t.modelArgs, ...t.effortArgs, t.stdin]) {
    for (const m of s.matchAll(/\{([^{}]+)\}/g)) if (!placeholders.has(m[1])) throw new Error('Unknown placeholder: ' + m[0])
  }
  if (!t.resumeArgs.some(s => s.includes('{session}'))) throw new Error('resumeArgs must contain {session}')
  if (![...t.newArgs, t.stdin].some(s => s.includes('{prompt}')) || ![...t.resumeArgs, t.stdin].some(s => s.includes('{prompt}'))) throw new Error('Both commands must receive {prompt}')
  for (const field of ['reply', 'session']) {
    const s = t[field]
    if (!s || typeof s !== 'object') throw new Error('Missing ' + field + ' extractor')
    if (t.format === 'text') {
      clean(s.regex, field + '.regex')
      if (s.regex.length > 500) throw new Error('Extractor regex is too long')
      new RegExp(s.regex, 'm')
      t[field] = { regex: s.regex }
    } else {
      clean(s.path, field + '.path')
      if (!/^[\w.-]+$/.test(s.path)) throw new Error('Use a dotted JSON path')
      const when = s.when ?? {}
      if (typeof when !== 'object' || Array.isArray(when) || Object.keys(when).length > 10) throw new Error('Invalid extractor condition')
      if (Object.values(when).some(v => !['string', 'boolean', 'number'].includes(typeof v))) throw new Error('Extractor conditions must be scalar')
      t[field] = { path: s.path, when }
    }
  }
  return t
}

export function templateArgs(t, ctx) {
  const vars = { prompt: ctx.text, session: ctx.session ?? '', model: ctx.model === ctx.provider ? '' : ctx.model, effort: ctx.thinking ?? '', cwd: ctx.cwd }
  const render = s => s.replace(/\{(prompt|session|model|effort|cwd)\}/g, (_, key) => vars[key])
  const args = [...(ctx.session ? t.resumeArgs : t.newArgs), ...(vars.model ? t.modelArgs : []), ...(vars.effort ? t.effortArgs : [])].map(render)
  return { args, input: render(t.stdin) }
}

export function extract(record, selector, compiledRegex = null) {
  if (selector.regex) return (compiledRegex ?? new RegExp(selector.regex, 'm')).exec(record)?.[1]
  if (!Object.entries(selector.when).every(([k, v]) => pathValue(record, k) === v)) return undefined
  return pathValue(record, selector.path)
}

export async function commandTurn(ctx, command, args, input, receive, format = 'jsonl') {
  mkdirSync(dirname(ctx.marker), { recursive: true })
  const fd = openSync(ctx.marker, 'a', 0o600)
  let child, failure, killer, size = 0, buffer = '', stderr = ''
  const env = { ...modelEnvironment(), PATH: runtimePath(), BROCO_IN_WORKER: '1' }
  for (const key of HOST_SESSION_VARS) delete env[key]
  const rawSecrets = secretsFrom([], env)
  try { child = spawn(command, args, { cwd: ctx.cwd, env, stdio: ['pipe', 'pipe', 'pipe', fd], signal: ctx.signal }) }
  finally { closeSync(fd) }
  ctx.owner(child.pid ?? null)
  ctx.ready(null)
  const force = () => {
    if (!killer) {
      killer = setTimeout(() => child.kill('SIGKILL'), 1500)
      killer.unref?.()
    }
  }
  ctx.signal.addEventListener('abort', force, { once: true })
  if (ctx.signal.aborted) force()
  child.on('error', () => { failure = new Error('CLI could not run or was stopped: ' + command) })
  child.stdin.on('error', () => {})
  child.stderr.on('data', part => { stderr = (stderr + part.toString('utf8')).slice(-4096) })
  const consume = line => {
    if (!line.trim() || failure) return
    let record
    try { record = format === 'text' ? mask(line, rawSecrets) : parseRedactedJson(line, rawSecrets) }
    catch { failure = new Error('CLI output did not match its expected protocol'); child.kill(); force(); return }
    try { receive(record) }
    catch (err) { failure = err; child.kill(); force() }
  }
  child.stdout.on('data', data => {
    size += data.length
    if (size > 16 * 1024 * 1024) { failure = new Error('CLI output exceeded 16 MiB'); child.kill(); force() }
    if (format !== 'jsonl') buffer += data.toString()
  })
  const lines = format === 'jsonl' ? createInterface({ input: child.stdout, crlfDelay: Infinity }) : null
  lines?.on('line', consume)
  const drained = lines ? new Promise(ok => lines.once('close', ok)) : Promise.resolve()
  let drainTimer
  const exited = new Promise(ok => child.once('exit', code => {
    drainTimer = setTimeout(() => {
      lines?.close()
      child.stdout?.destroy()
      child.stderr?.destroy()
      ok(code)
    }, 1500)
    drainTimer.unref?.()
  }))
  const closed = new Promise(ok => child.once('close', ok))
  child.stdin.end(input)
  const code = await Promise.race([
    Promise.all([closed, drained]).then(([c]) => c),
    exited
  ])
  clearTimeout(drainTimer)
  lines?.close()
  clearTimeout(killer)
  ctx.signal.removeEventListener('abort', force)
  if (format !== 'jsonl' && !failure) consume(buffer)
  if (failure) throw failure
  if (code !== 0) {
    const detail = redactStderr(stderr, env, rawSecrets)
    throw new Error(command + ' exited with status ' + code + (detail ? ': ' + detail : ''))
  }
}

export async function templateTurn(ctx) {
  const t = validateTemplate(ctx.template)
  const { args, input } = templateArgs(t, ctx)
  const sessionRegex = t.session.regex ? new RegExp(t.session.regex, 'm') : null
  const replyRegex = t.reply.regex ? new RegExp(t.reply.regex, 'm') : null
  let reply, session
  ctx.event('cli.start', {}, 'Custom CLI running; detailed steps and cache are unavailable')
  await commandTurn(ctx, t.command, args, input, record => {
    const id = extract(record, t.session, sessionRegex), text = extract(record, t.reply, replyRegex)
    if (typeof id === 'string' && id) { session = id; ctx.bind(id, 'template') }
    if (typeof text === 'string' && text) reply = text
  }, t.format)
  if (!session || !reply) throw new Error('Template did not extract a session ID and final reply')
  return reply
}

export const presets = {
  'custom:codex-json': { command: 'codex', newArgs: ['exec', '--json', '-'], resumeArgs: ['exec', 'resume', '--json', '{session}', '-'], modelArgs: ['--model', '{model}'], effortArgs: ['-c', 'model_reasoning_effort="{effort}"'], stdin: '{prompt}', format: 'jsonl', reply: { path: 'item.text', when: { type: 'item.completed', 'item.type': 'agent_message' } }, session: { path: 'thread_id', when: { type: 'thread.started' } } },
  'custom:gemini': { command: 'gemini', newArgs: ['--output-format', 'stream-json', '-p', '{prompt}'], resumeArgs: ['--output-format', 'stream-json', '--resume', '{session}', '-p', '{prompt}'], modelArgs: ['--model', '{model}'], format: 'jsonl', reply: { path: 'content', when: { type: 'message', role: 'assistant' } }, session: { path: 'session_id', when: { type: 'init' } } },
  'custom:opencode': { command: 'opencode', newArgs: ['run', '--format', 'json', '{prompt}'], resumeArgs: ['run', '--format', 'json', '--session', '{session}', '{prompt}'], modelArgs: ['--model', '{model}'], effortArgs: ['--variant', '{effort}'], format: 'jsonl', reply: { path: 'part.text', when: { type: 'text' } }, session: { path: 'sessionID', when: { type: 'text' } } }
}

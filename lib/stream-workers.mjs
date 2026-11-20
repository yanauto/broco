import { execFile } from 'node:child_process'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import { attachmentDirs, claudeAttachments, formatAttachmentPrompt } from './attachments.mjs'
import { inspectCommand } from './cli-process.mjs'
import { modelEnvironment } from './model-env.mjs'
import { home, isolated } from './paths.mjs'
import { classify } from './problems.mjs'
import { HOST_SESSION_VARS, commandTurn, templateTurn } from './templates.mjs'

const exec = promisify(execFile)
const runtimePath = () => isolated ? [join(home, 'tools', 'bin'), process.env.PATH].filter(Boolean).join(delimiter) : process.env.PATH
const effortSuffix = /-(?:off|none|minimal|low|medium|high|extra-high|xhigh|max|ultra)$/
const commandHeader = /^(?:Created At:|Completed At:|Command exited with code\b|Command output:\s*$)/

let agyUsageCache = null

export function clearAgyUsageCache() {
  agyUsageCache = null
}

export function cursorModel(model, effort, catalog = []) {
  if (!effort) return model
  if (model === 'cursor-agent') throw new Error('Choose an explicit Cursor model when selecting effort')
  const match = /^([^\[\]]+)(?:\[([^\[\]]*)\])?$/.exec(model)
  if (!match) throw new Error('Invalid Cursor model override')
  if (!match[2]) {
    const fast = model.endsWith('-fast') ? '-fast' : ''
    const base = model.replace(/-fast$/, '').replace(/-(?:none|minimal|low|medium|high|xhigh|extra-high|max)$/, '')
    const variant = base + '-' + effort + fast
    if (catalog.includes(variant)) return variant
  }
  const options = (match[2]?.split(',') ?? []).filter(s => s && !s.startsWith('effort='))
  return match[1] + '[' + [...options, 'effort=' + effort].join(',') + ']'
}

export function agyModel(model, effort, catalog = []) {
  if (!model || model === 'agy') return { model: null, effortFlag: effort || null }
  const base = model.replace(effortSuffix, '')
  const isGeminiFamily = /^gemini-/i.test(base) && !/^gemini-pro-orchestrator\b/i.test(base)
  if (effort) {
    const variant = base + '-' + effort
    if ((!catalog.length && (model !== base || isGeminiFamily)) || catalog.includes(variant)) {
      return { model: variant, effortFlag: null }
    }
    if (catalog.includes(model)) return { model, effortFlag: effort }
    if (model !== base || isGeminiFamily || catalog.some(id => id.startsWith(base + '-'))) {
      return { model: variant, effortFlag: null }
    }
    return { model, effortFlag: effort }
  }
  if (catalog.length && !catalog.includes(model)) {
    const picked = catalog.find(id => id === model + '-medium') ?? catalog.find(id => id.startsWith(model + '-')) ?? model
    return { model: picked, effortFlag: null }
  }
  return { model, effortFlag: null }
}

function windowMinutes(window) {
  if (window === '5h') return 300
  if (window === 'weekly') return 10080
  const hours = /^(\d+)h$/i.exec(window ?? '')
  if (hours) return Number(hours[1]) * 60
  const days = /^(\d+)d$/i.exec(window ?? '')
  if (days) return Number(days[1]) * 1440
  const mins = /^(\d+)m$/i.exec(window ?? '')
  if (mins) return Number(mins[1])
  return null
}

function parseAgyUsage(raw, model = null) {
  const rawGroups = raw?.command?.data?.groups ?? raw?.groups
  if (!Array.isArray(rawGroups) || !rawGroups.length) return null
  const groups = rawGroups.map(g => ({
    name: g?.name ?? '',
    windows: (g?.buckets ?? []).filter(b => b && Number.isFinite(b.remaining_fraction)).map(b => {
      const usedPercent = Math.min(100, Math.max(0, Math.round((1 - b.remaining_fraction) * 1000) / 10))
      const parsedReset = typeof b.reset_time === 'string' ? Date.parse(b.reset_time) : NaN
      return {
        id: b.id ?? null,
        minutes: windowMinutes(b.window),
        usedPercent,
        resetsAt: Number.isFinite(parsedReset) ? new Date(parsedReset).toISOString() : null
      }
    })
  })).filter(g => g.windows.length)
  if (!groups.length) return null
  const want3p = typeof model === 'string' && /^(?:claude|gpt)-/i.test(model)
  const picked = (want3p ? groups.find(g => /claude|gpt|3p/i.test(g.name)) : groups.find(g => /gemini/i.test(g.name))) ?? groups[0]
  const windows = picked.windows.map(({ minutes, usedPercent, resetsAt }) => ({ minutes, usedPercent, resetsAt }))
  const reached = windows.some(w => w.usedPercent >= 100)
  const avoid = reached || windows.some(w => w.usedPercent >= 90)
  const plentiful = !avoid && windows.length > 0 && windows.every(w => w.usedPercent <= 25)
  return { source: 'native', windows, groups, reached, avoid, plentiful, at: new Date().toISOString() }
}

function parseJsonOutput(text) {
  if (!text) return null
  try { return JSON.parse(text) } catch {}
  for (const line of text.trim().split('\n').reverse()) {
    if (line.trim().startsWith('{')) {
      try { return JSON.parse(line) } catch {}
    }
  }
  return null
}

async function fetchAgyUsageRaw(cwd, signal) {
  if (signal?.aborted) return null
  try {
    const env = { ...modelEnvironment(), PATH: runtimePath(), NO_COLOR: '1', BROCO_IN_WORKER: '1' }
    for (const key of HOST_SESSION_VARS) delete env[key]
    const { stdout } = await exec('agy', ['-p', '/usage', '--output-format', 'json'], { cwd, env, timeout: 15000, maxBuffer: 1024 * 1024, signal })
    return parseJsonOutput(stdout)
  } catch { return null }
}

async function readAgyUsage(cwd, model, signal, { fresh = false } = {}) {
  if (signal?.aborted) return null
  const key = runtimePath() + '\0' + cwd
  if (fresh) {
    agyUsageCache = null
    const raw = await fetchAgyUsageRaw(cwd, signal)
    return raw ? parseAgyUsage(raw, model) : null
  }
  const now = Date.now()
  if (!agyUsageCache || agyUsageCache.key !== key || now >= agyUsageCache.expiresAt) {
    const promise = fetchAgyUsageRaw(cwd, undefined)
    agyUsageCache = { key, expiresAt: now + 3000, promise }
  }
  const raw = await agyUsageCache.promise
  if (signal?.aborted) return null
  return raw ? parseAgyUsage(raw, model) : null
}

function toolTarget(params) {
  if (!params || typeof params !== 'object') return ''
  const raw = params.CommandLine ?? params.command ?? params.Path ?? params.file_path ?? params.path ?? params.notebook_path ?? params.TargetFile ?? params.target_file ?? params.DirectoryPath ?? params.SearchPath ?? params.SearchDirectory ?? params.Url ?? params.url ?? params.Query ?? params.query ?? params.Pattern ?? params.pattern ?? params.glob ?? params.description ?? ''
  return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, 120) : ''
}

function sanitizeClaudeText(text) {
  return String(text ?? '')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\bsk-ant-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .trim()
}

function claudeToolResultPreview(content) {
  let text = ''
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) {
    text = content
      .filter(b => b && typeof b === 'object' && typeof b.text === 'string')
      .map(b => b.text)
      .join('\n')
  }
  if (!text) return ''
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  return (lines.at(-1) ?? '').replace(/\s+/g, ' ').slice(0, 120)
}

function claudeErrorDetail(e) {
  const meta = [
    Number.isSafeInteger(e?.api_error_status) ? 'HTTP ' + e.api_error_status : null,
    typeof e?.api_error_type === 'string' && e.api_error_type ? e.api_error_type : null,
    typeof e?.api_error_code === 'string' && e.api_error_code ? e.api_error_code : null
  ].filter(Boolean).join(' ')
  let body = ''
  if (typeof e?.result === 'string' && e.result.trim()) body = e.result.trim()
  else if (Array.isArray(e?.errors) && e.errors.length) {
    body = e.errors.map(x => typeof x === 'string' ? x.trim() : JSON.stringify(x)).filter(Boolean).join('; ')
  } else if (Array.isArray(e?.message?.content)) {
    body = e.message.content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text.trim()).filter(Boolean).join('\n')
  } else if (typeof e?.error === 'string' && e.error.trim()) {
    body = e.error.trim()
  }
  const parts = []
  if (meta && (!body || !body.includes(meta))) parts.push(meta)
  if (body) parts.push(body)
  return sanitizeClaudeText(parts.join(': '))
}

export function claudeResetEpoch(message = '') {
  const text = String(message ?? '')
  const pipeEpoch = /\|\s*(\d{10})\b/.exec(text)
  if (pipeEpoch) {
    const sec = Number(pipeEpoch[1])
    if (Number.isSafeInteger(sec) && sec > 1700000000) return sec
  }
  const iso = /resets?\s+(?:at\s+)?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))/i.exec(text)
  if (iso) {
    const ms = Date.parse(iso[1])
    if (Number.isFinite(ms)) return Math.floor(ms / 1000)
  }
  return null
}

function emitClaudeUsage(ctx, u) {
  if (!u || typeof u !== 'object') return false
  const input = Number.isSafeInteger(u.input_tokens) && u.input_tokens >= 0 ? u.input_tokens : null
  const cacheRead = Number.isSafeInteger(u.cache_read_input_tokens) && u.cache_read_input_tokens >= 0 ? u.cache_read_input_tokens : null
  const cacheCreate = Number.isSafeInteger(u.cache_creation_input_tokens) && u.cache_creation_input_tokens >= 0 ? u.cache_creation_input_tokens : 0
  if (input === null) return false
  const cached = cacheRead ?? 0
  const total = input + cached + cacheCreate
  if (total === 0 && cacheRead === null) return false
  ctx.event('usage', {
    cachedInputTokens: cached,
    inputTokens: total,
    cacheCreationInputTokens: cacheCreate
  }, 'Claude reported cache usage')
  return true
}

function toolOutputPreview(info) {
  if (!info || typeof info !== 'object') return ''
  if (typeof info.error?.message === 'string' && info.error.message.trim()) {
    return info.error.message.replace(/\s+/g, ' ').trim().slice(0, 120)
  }
  if (typeof info.output !== 'string' || !info.output) return ''
  const lines = info.output
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !commandHeader.test(l))
  const last = lines.at(-1) ?? ''
  return last.replace(/\s+/g, ' ').slice(0, 120)
}

export function resetEpoch(quota, message = '') {
  const valid = [...(quota?.windows ?? [])].filter(w => w.resetsAt)
  const exhausted = valid.filter(w => w.usedPercent >= 99).sort((a, b) => b.usedPercent - a.usedPercent)[0]
  const explicitExhaustion = /(?<!disk )quota (?:exceeded|exhausted|reached)/i.test(String(message ?? ''))
  const fallbackShort = explicitExhaustion
    ? valid.filter(w => (w.minutes ?? Infinity) <= 300 && w.usedPercent > 0).sort((a, b) => b.usedPercent - a.usedPercent)[0]
    : null
  const chosen = exhausted ?? fallbackShort
  if (!chosen) return null
  const ms = Date.parse(chosen.resetsAt)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}

export async function streamTurn(ctx) {
  if (ctx.provider.startsWith('custom:')) return templateTurn(ctx)
  const agy = ctx.provider === 'agy'
  const claude = ctx.provider === 'claude'
  if (claude && ctx.attachments?.length) claudeAttachments(ctx.attachments)
  if (!agy && !claude && ctx.attachments?.length) throw new Error('cursor-agent does not support media attachments')
  let reply, completed = false, failure, resultError = '', sawUsage = false, lastQuota = null
  let chosen = ctx.model
  let resolved = { model: ctx.model === 'agy' ? null : ctx.model, effortFlag: ctx.thinking || null }
  if (agy) {
    let ids = []
    const fastGemini = Boolean(ctx.model && /^gemini-(?!pro-orchestrator(?:$|-))/i.test(ctx.model) && (ctx.thinking || effortSuffix.test(ctx.model)))
    if (ctx.model && ctx.model !== 'agy' && !fastGemini && (ctx.thinking || !effortSuffix.test(ctx.model))) {
      const listed = await inspectCommand('agy', ['models'], ctx.cwd, ctx.signal)
      ids = listed.text.split('\n').filter(l => /^\S+\t/.test(l)).map(l => l.split('\t')[0])
    }
    resolved = agyModel(ctx.model, ctx.thinking, ids)
  } else if (!claude && ctx.thinking) {
    const listed = await inspectCommand('cursor-agent', ['--list-models'], ctx.cwd, ctx.signal)
    const ids = listed.text.split('\n').map(l => /^(\S+) - /.exec(l.trim())?.[1]).filter(Boolean)
    chosen = cursorModel(ctx.model, ctx.thinking, ids)
  }
  const args = agy
    ? ['--input-format', 'text', '--output-format', 'stream-json']
    : claude
      ? ['-p', '--output-format', 'stream-json', '--verbose']
      : ['--print', '--output-format', 'stream-json']
  if (ctx.session) args.push(agy ? '--conversation' : '--resume', ctx.session)
  if (agy) {
    if (resolved.model) args.push('--model', resolved.model)
    if (resolved.effortFlag) args.push('--effort', resolved.effortFlag)
    args.push('--mode', ctx.review ? 'plan' : 'accept-edits', '--disable-slash-commands')
    for (const dir of attachmentDirs(ctx.attachments)) args.push('--add-dir', dir)
  } else if (claude) {
    if (ctx.model && ctx.model !== 'claude') args.push('--model', ctx.model)
    if (ctx.thinking) args.push('--effort', ctx.thinking)
    args.push('--permission-mode', ctx.review ? 'plan' : 'bypassPermissions')
    for (const dir of attachmentDirs(ctx.attachments)) args.push('--add-dir', dir)
  } else {
    if (ctx.model !== ctx.provider) args.push('--model', chosen)
    args.push('--trust', ...(ctx.review ? ['--mode', 'plan'] : ['--force']), '--', ctx.text)
  }
  const promptInput = agy
    ? formatAttachmentPrompt(ctx.text, ctx.attachments, 'read_file')
    : claude
      ? formatAttachmentPrompt(ctx.text, ctx.attachments, 'Read')
      : ''
  let beforeRecorded = false
  const recordBefore = before => {
    if (before && !beforeRecorded) {
      beforeRecorded = true
      if (!lastQuota) lastQuota = before
      ctx.event('quota', before, '')
    }
  }
  const beforePromise = agy ? readAgyUsage(ctx.cwd, resolved.model, ctx.signal).then(recordBefore, () => {}) : null
  const seenActiveResponse = new Set()
  const claudeTools = new Map()
  const seenClaudeSteps = new Set()
  let claudeBound = null, lastAssistantText = '', lastApiError = ''
  let turnError = null
  try {
    await commandTurn(ctx, ctx.provider, args, promptInput, e => {
      if (agy) {
        if (e.event === 'init') ctx.bind(e.conversation_id, 'stream-json')
        if (e.step_update) {
          const s = e.step_update
          if (s.step_type === 'agent_response') {
            if (s.state === 'ACTIVE') {
              if (!seenActiveResponse.has(s.step_index)) {
                seenActiveResponse.add(s.step_index)
                ctx.event('tool.started', { step: s.step_index, type: 'agent_response' }, 'Writing reply')
              }
            } else if (s.state === 'DONE') {
              ctx.event('tool.completed', { step: s.step_index, type: 'agent_response', durationSeconds: s.duration_seconds ?? null }, '')
            }
          } else if (s.step_type === 'tool') {
            const name = s.tool_name || s.tool_info?.name || 'tool'
            const target = toolTarget(s.tool_info?.parameters)
            const done = s.state === 'DONE' || s.state === 'ERROR'
            const failed = s.state === 'ERROR' || !!s.tool_info?.error
            const outputPreview = done ? toolOutputPreview(s.tool_info) : ''
            const dur = done && typeof s.duration_seconds === 'number' && Number.isFinite(s.duration_seconds) ? ' (' + s.duration_seconds.toFixed(1) + 's)' : ''
            const tail = outputPreview || target
            const summary = done
              ? name + (failed ? ' error' : ' done') + dur + (tail ? ': ' + tail : '')
              : name + (target ? ': ' + target : '')
            ctx.event(done ? 'tool.completed' : 'tool.started', {
              step: s.step_index,
              type: 'tool',
              tool: name,
              target,
              outputPreview,
              durationSeconds: s.duration_seconds ?? null
            }, summary)
          } else if (s.step_type && s.step_type !== 'user_input' && s.step_type !== 'system_message') {
            ctx.event(s.state === 'DONE' ? 'tool.completed' : 'tool.started', { step: s.step_index, type: s.step_type }, [s.step_type, s.state].filter(Boolean).join(' '))
          }
          const u = s.usage
          if (s.state === 'DONE' && Number.isSafeInteger(u?.cache_read_tokens) && Number.isSafeInteger(u.input_tokens)) {
            sawUsage = true
            ctx.event('usage', { cachedInputTokens: u.cache_read_tokens, inputTokens: u.input_tokens + u.cache_read_tokens }, 'agy reported cache usage')
          }
        }
        if (e.event === 'result') {
          if (e.result?.conversation_id) ctx.bind(e.result.conversation_id, 'stream-json')
          completed = true
          reply = e.result?.response
          const u = e.result?.usage
          if (!sawUsage && Number.isSafeInteger(u?.cache_read_tokens) && Number.isSafeInteger(u.input_tokens)) {
            sawUsage = true
            ctx.event('usage', { cachedInputTokens: u.cache_read_tokens, inputTokens: u.input_tokens + u.cache_read_tokens }, 'agy reported cache usage')
          }
          if (e.result?.status !== 'SUCCESS') {
            resultError = typeof e.result?.error === 'string' ? e.result.error.trim() : ''
            failure = resultError ? 'agy turn failed: ' + resultError : 'agy turn did not succeed'
          }
        }
      } else if (claude) {
        if (typeof e.session_id === 'string' && e.session_id && e.session_id !== claudeBound) {
          ctx.bind(e.session_id, 'stream-json')
          claudeBound = e.session_id
        }
        if (e.type === 'assistant') {
          if (e.is_api_error_message) {
            const detail = claudeErrorDetail(e)
            if (detail) lastApiError = detail
          } else {
            const blocks = Array.isArray(e.message?.content) ? e.message.content : []
            const msgId = e.message?.id || e.uuid || 'msg'
            const textParts = []
            for (const block of blocks) {
              if (!block || typeof block !== 'object') continue
              if (block.type === 'tool_use') {
                const name = block.name || 'tool'
                const target = toolTarget(block.input)
                if (block.id) claudeTools.set(block.id, { name, target })
                ctx.event('tool.started', { id: block.id ?? null, type: 'tool', tool: name, target }, name + (target ? ': ' + target : ''))
              } else if (block.type === 'thinking') {
                const key = msgId + ':thinking'
                if (!seenClaudeSteps.has(key)) {
                  seenClaudeSteps.add(key)
                  ctx.event('tool.started', { type: 'thinking' }, 'Thinking')
                }
              } else if (block.type === 'text' && typeof block.text === 'string' && block.text) {
                textParts.push(block.text)
                const key = msgId + ':text'
                if (!seenClaudeSteps.has(key)) {
                  seenClaudeSteps.add(key)
                  ctx.event('tool.started', { type: 'agent_response' }, 'Writing reply')
                }
              }
            }
            if (textParts.length) lastAssistantText = textParts.join('')
            if (emitClaudeUsage(ctx, e.message?.usage)) sawUsage = true
          }
        } else if (e.type === 'user') {
          const blocks = Array.isArray(e.message?.content) ? e.message.content : []
          for (const block of blocks) {
            if (!block || block.type !== 'tool_result') continue
            const info = claudeTools.get(block.tool_use_id) ?? { name: 'tool', target: '' }
            const outputPreview = claudeToolResultPreview(block.content)
            const tail = outputPreview || info.target
            const summary = info.name + (block.is_error ? ' error' : ' done') + (tail ? ': ' + tail : '')
            ctx.event('tool.completed', {
              id: block.tool_use_id ?? null,
              type: 'tool',
              tool: info.name,
              target: info.target,
              outputPreview,
              isError: !!block.is_error
            }, summary)
          }
        } else if (e.type === 'result') {
          completed = true
          if (e.is_error || (e.subtype && e.subtype !== 'success')) {
            resultError = claudeErrorDetail(e) || lastApiError
            failure = resultError ? 'claude turn failed: ' + resultError : 'claude turn did not succeed'
          } else {
            reply = typeof e.result === 'string' && e.result ? e.result : lastAssistantText
            if (!sawUsage && emitClaudeUsage(ctx, e.usage)) sawUsage = true
          }
        }
      } else {
        if (e.session_id) ctx.bind(e.session_id, 'stream-json')
        if (e.type === 'tool_call') {
          const tool = e.tool_call?.name || Object.keys(e.tool_call ?? {}).find(k => k.endsWith('ToolCall')) || 'tool'
          ctx.event(e.subtype === 'completed' ? 'tool.completed' : 'tool.started', { tool }, 'Cursor ' + tool + ' ' + (e.subtype || 'running'))
        }
        if (e.type === 'result') {
          completed = true
          reply = e.result
          if (e.is_error || e.subtype !== 'success') failure = 'Cursor turn did not succeed'
          const u = e.usage
          if (Number.isSafeInteger(u?.cache_read_input_tokens) && Number.isSafeInteger(u.input_tokens)) ctx.event('usage', { cachedInputTokens: u.cache_read_input_tokens, inputTokens: u.input_tokens + u.cache_read_input_tokens + (u.cache_creation_input_tokens ?? 0) }, 'Cursor reported cache usage')
        }
      }
    })
  } catch (err) {
    const apiErr = resultError || lastApiError
    turnError = apiErr && !err.message.includes(apiErr) ? new Error(err.message + ': ' + apiErr) : err
  } finally {
    if (beforePromise) await beforePromise
    if (agy && !ctx.signal.aborted) {
      const after = await readAgyUsage(ctx.cwd, resolved.model, ctx.signal, { fresh: true })
      if (after) { lastQuota = after; ctx.event('quota', after, '') }
    }
  }
  const finalFailure = turnError?.message || (!completed || !reply || failure ? (failure || 'CLI returned no final result') : '')
  if (finalFailure) {
    const err = turnError ?? new Error(finalFailure)
    if (agy && lastQuota) {
      const prob = classify(err.message)
      if (prob.class === 'quota') err.problem = classify(err.message, { resetsAt: resetEpoch(lastQuota, err.message) })
    } else if (claude) {
      const prob = classify(err.message)
      err.problem = prob.class === 'quota' ? classify(err.message, { resetsAt: claudeResetEpoch(err.message) }) : prob
    }
    throw err
  }
  return reply
}

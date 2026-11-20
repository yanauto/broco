import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { inspectCommand, inspectRpc } from './cli-process.mjs'
import { home, isolated } from './paths.mjs'
import { agyQuota, codexQuota } from './quota.mjs'

const CACHE_TTL_MS = 45_000
const detectCache = new Map()
const inFlight = new Map()
const FIXTURE_FILES = ['codex-signed-out', 'claude-signed-out', 'fixture-signed-out', 'fixture-models.json', 'fixture-pi-models.json', 'quota-spent', 'exec-only']
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const CLAUDE_MODELS = [
  { id: 'opus', name: 'Claude Opus', efforts: CLAUDE_EFFORTS },
  { id: 'sonnet', name: 'Claude Sonnet', efforts: CLAUDE_EFFORTS },
  { id: 'haiku', name: 'Claude Haiku', efforts: ['low', 'medium', 'high'] },
  { id: 'fable', name: 'Claude Fable', efforts: CLAUDE_EFFORTS }
]

const value = v => typeof v === 'string' && v.length < 300 ? v : null
function settings(path) { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return {} } }

function parseJson(text) {
  if (!text) return null
  try { return JSON.parse(text) } catch {}
  for (const line of text.trim().split('\n').reverse()) {
    if (line.trim().startsWith('{')) {
      try { return JSON.parse(line) } catch {}
    }
  }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start !== -1 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)) } catch {}
  }
  return null
}

function resolveCli(name) {
  const dirs = [
    ...(isolated ? [join(home, 'tools', 'bin')] : []),
    ...(process.env.PATH ?? '').split(delimiter).filter(Boolean)
  ]
  for (const file of name.includes('/') ? [name] : dirs.map(d => join(d, name))) {
    try {
      accessSync(file, constants.X_OK)
      if (statSync(file).isFile()) return file
    } catch {}
  }
  return null
}

function stamp(file) {
  try {
    const s = statSync(file)
    return s.mtimeMs + ':' + s.size
  } catch {
    return ''
  }
}

export function pruneDetectCache(now = Date.now()) {
  for (const [key, entry] of detectCache) {
    if (entry.expiresAt <= now) detectCache.delete(key)
  }
}

export function detectCacheSize() {
  return detectCache.size
}

function cacheKey(id, cwd) {
  const piDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent')
  const cursorDir = process.env.CURSOR_CONFIG_DIR || join(homedir(), '.cursor')
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  const fixtureStamps = cwd ? FIXTURE_FILES.map(f => stamp(join(cwd, f))) : []
  const hasLocalFixtures = fixtureStamps.some(Boolean)
  const scopedCwd = id === 'codex' || hasLocalFixtures ? (cwd ?? '') : ''
  const files = [
    stamp(join(piDir, 'auth.json')),
    stamp(join(cursorDir, 'cli-config.json')),
    stamp(join(claudeDir, 'settings.json')),
    ...(hasLocalFixtures ? fixtureStamps : [])
  ].join('|')
  return [id, scopedCwd, process.env.PATH ?? '', process.env.PI_CODING_AGENT_DIR ?? '', process.env.CURSOR_CONFIG_DIR ?? '', process.env.CLAUDE_CONFIG_DIR ?? '', files].join('\0')
}

export function clearDetectCache() {
  detectCache.clear()
  inFlight.clear()
}

export const builtins = {
  codex: { cli: 'codex', capability: 'full', steering: 'inject', cache: true, login: 'codex login', install: 'npm install -g @openai/codex', upgrade: 'npm install -g @openai/codex@latest' },
  claude: { cli: 'claude', capability: 'full', steering: 'queue', cache: true, login: 'claude auth login', install: 'curl -fsSL https://claude.ai/install.sh | bash', upgrade: 'claude update' },
  pi: { cli: 'pi', capability: 'full', steering: 'inject', cache: true, login: 'pi', loginHint: 'Use /login, then choose the provider.', install: 'npm install -g @earendil-works/pi-coding-agent', upgrade: 'npm install -g @earendil-works/pi-coding-agent@latest' },
  agy: { cli: 'agy', capability: 'full', steering: 'queue', cache: true, login: 'agy', loginHint: 'Complete the CLI sign-in flow.', install: 'curl -fsSL https://antigravity.google/cli/install.sh | bash -s -- --skip-aliases --skip-path', upgrade: 'agy update' },
  'cursor-agent': { cli: 'cursor-agent', capability: 'full', steering: 'queue', cache: false, login: 'cursor-agent login', install: 'curl -fsSL https://cursor.com/install | bash', upgrade: 'cursor-agent update' }
}

export const cliActions = {
  ...builtins,
  gemini: { login: 'gemini', loginHint: 'Sign in inside Gemini CLI.', install: 'npm install -g @google/gemini-cli', upgrade: 'npm install -g @google/gemini-cli@latest' },
  opencode: { login: 'opencode auth login', install: 'curl -fsSL https://opencode.ai/install | bash', upgrade: 'curl -fsSL https://opencode.ai/install | bash' }
}

export async function readAgyQuota(cwd) {
  const bin = resolveCli('agy')
  if (!bin) return null
  const usage = await inspectCommand(bin, ['-p', '/usage', '--output-format', 'json'], cwd)
  if (!usage.ok) return null
  return agyQuota(parseJson(usage.text))
}

async function runDetectCli(id, cwd) {
  const cli = id.startsWith('pi:') ? 'pi' : id
  const bin = resolveCli(cli)
  const base = { ...builtins[cli], cli, installed: !!bin, version: null, loginStatus: 'unknown', models: [], defaultModel: null, defaultEffort: null, efforts: [], source: 'CLI inspection', warnings: [] }
  if (!bin) return { ...base, loginStatus: 'not-installed' }
  try {
    if (cli === 'agy') {
      const [version, models, effort, model, usage] = await Promise.all([
        inspectCommand(bin, ['--version'], cwd),
        inspectCommand(bin, ['models'], cwd),
        inspectCommand(bin, ['-p', '/effort', '--output-format', 'json'], cwd),
        inspectCommand(bin, ['-p', '/model', '--output-format', 'json'], cwd),
        inspectCommand(bin, ['-p', '/usage', '--output-format', 'json'], cwd)
      ])
      base.version = version.ok ? value(version.text.trim().split('\n')[0]) : null
      base.models = models.text.split('\n').filter(l => /^\S+\t/.test(l)).map(l => { const [mid, name] = l.split('\t'); return { id: mid, name, efforts: [] } })
      base.loginStatus = models.ok && base.models.length ? 'ready' : 'unknown'
      if (effort.ok) {
        const e = parseJson(effort.text)?.command?.data
        if (e) { base.defaultEffort = value(e.current); base.efforts = Array.isArray(e.available) ? e.available : [] }
      }
      if (model.ok) {
        const m = parseJson(model.text)?.command?.data
        if (m) base.defaultModel = value(m.id)
      }
      if (usage.ok) {
        const q = agyQuota(parseJson(usage.text))
        if (q) base.quota = q
      }
      base.source = 'agy models and read-only /model, /effort, /usage'
      return base
    }
    if (cli === 'claude') {
      const [version, auth] = await Promise.all([
        inspectCommand(bin, ['--version'], cwd),
        inspectCommand(bin, ['auth', 'status', '--json'], cwd)
      ])
      base.version = version.ok ? value(version.text.trim().split('\n')[0]) : null
      const authRaw = auth.text || auth.output || ''
      const authJson = parseJson(authRaw)
      if (authJson && typeof authJson.loggedIn === 'boolean') {
        if (!authJson.loggedIn) base.loginStatus = 'signed-out'
        else if (typeof authJson.loginExpiresAt === 'string' && Number.isFinite(Date.parse(authJson.loginExpiresAt)) && Date.parse(authJson.loginExpiresAt) <= Date.now()) base.loginStatus = 'expired'
        else base.loginStatus = 'ready'
      } else if (/not logged|not authenticated|logged out/i.test(authRaw)) {
        base.loginStatus = 'signed-out'
      } else if (auth.ok && /logged in|authenticated/i.test(auth.text)) {
        base.loginStatus = 'ready'
      }
      const s = settings(join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json'))
      const configuredModel = value(s.model)
      base.defaultModel = configuredModel && configuredModel !== 'default' ? configuredModel : null
      base.defaultEffort = value(s.effortLevel) ?? null
      base.efforts = [...CLAUDE_EFFORTS]
      base.models = CLAUDE_MODELS.map(m => ({ ...m, efforts: [...m.efforts], isDefault: m.id === base.defaultModel }))
      if (base.defaultModel && !base.models.some(m => m.id === base.defaultModel)) {
        base.models.unshift({ id: base.defaultModel, name: base.defaultModel, efforts: [...CLAUDE_EFFORTS], isDefault: true })
      }
      base.source = 'claude --version, claude auth status --json; public settings model'
      return base
    }
    const version = await inspectCommand(bin, ['--version'], cwd)
    base.version = version.ok ? value(version.text.trim().split('\n')[0]) : null
    if (cli === 'codex') {
      await inspectRpc(bin, ['app-server'], cwd, async (request, send) => {
        await request('initialize', { clientInfo: { name: 'broco-roster', version: '1.0.0' }, capabilities: {} })
        send({ method: 'initialized' })
        let cursor = null
        do {
          const page = await request('model/list', { limit: 100, cursor })
          base.models.push(...(page.data ?? []).filter(m => !m.hidden).map(m => ({ input: m.inputModalities, contextWindow: m.contextWindow, maxTokens: m.maxOutputTokens, id: m.model, name: m.displayName, efforts: (m.supportedReasoningEfforts ?? []).map(e => e.reasoningEffort), defaultEffort: m.defaultReasoningEffort, isDefault: m.isDefault })))
          cursor = page.nextCursor
        } while (cursor)
        const { config } = await request('config/read', { cwd, includeLayers: false })
        base.defaultModel = value(config?.model) ?? base.models.find(m => m.isDefault)?.id ?? null
        base.defaultEffort = value(config?.model_reasoning_effort) ?? base.models.find(m => m.id === base.defaultModel)?.defaultEffort ?? null
        const account = await request('account/read', { refreshToken: false })
        base.loginStatus = account.account ? 'ready' : account.requiresOpenaiAuth === false ? 'not-required' : 'signed-out'
        base.efforts = base.models.find(m => m.id === base.defaultModel)?.efforts ?? []
        const limits = account.account ? await request('account/rateLimits/read', {}).catch(() => null) : null
        base.quota = codexQuota(limits?.rateLimits, limits?.ordinaryUsageAllowed)
      })
    } else if (cli === 'pi') {
      const provider = id.slice(3)
      await inspectRpc(bin, ['--mode', 'rpc', '--models', provider + '/*', '--no-session', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve', '--offline'], cwd, async request => {
        const state = await request('get_state')
        const models = await request('get_available_models')
        const thinking = await request('get_available_thinking_levels').catch(() => null)
        const thinkingLevels = Array.isArray(thinking?.levels) ? thinking.levels : []
        base.models = (models.models ?? []).filter(m => m.provider === provider).map(m => ({
          input: m.input,
          contextWindow: m.contextWindow,
          maxTokens: m.maxTokens,
          id: provider + '/' + m.id,
          name: m.name,
          efforts: m.reasoning ? (thinkingLevels.length ? [...thinkingLevels] : ['low', 'medium', 'high']) : ['off']
        }))
        base.defaultModel = state.model?.provider === provider ? provider + '/' + state.model.id : null
        base.defaultEffort = value(state.thinkingLevel)
        base.efforts = thinkingLevels.length ? [...thinkingLevels] : base.models.find(m => m.id === base.defaultModel)?.efforts ?? []
      }, 'pi')
      const auth = await inspectCommand(bin, ['auth', 'check', '--no-refresh', '--json', '--provider', provider], cwd)
      if (auth.ok) { const a = JSON.parse(auth.text); base.loginStatus = ['ready', 'expired', 'missing', 'unavailable'].includes(a.status) ? a.status : 'unknown' }
      base.credentialFilePresent = existsSync(join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'), 'auth.json'))
    } else if (cli === 'cursor-agent') {
      const models = await inspectCommand(bin, ['--list-models'], cwd)
      base.models = models.text.split('\n').map(l => /^(\S+) - (.+)$/.exec(l.trim())).filter(Boolean).map(([, mid, name]) => ({ id: mid, name, efforts: [], isDefault: name.includes('(default)') }))
      base.defaultModel = base.models.find(m => m.isDefault)?.id ?? null
      const s = settings(join(process.env.CURSOR_CONFIG_DIR || join(homedir(), '.cursor'), 'cli-config.json'))
      base.defaultModel = value(s.model?.modelId) ?? value(s.model) ?? base.defaultModel
      base.defaultEffort = value(s.model?.effort) ?? /-(none|minimal|low|medium|high|xhigh|max)(?:-fast)?$/.exec(base.defaultModel ?? '')?.[1] ?? null
      base.efforts = [...new Set(base.models.flatMap(m => { const level = /-(none|minimal|low|medium|high|xhigh|max)(?:-fast)?$/.exec(m.id)?.[1]; return level ? [level] : [] }))]
      const auth = await inspectCommand(bin, ['status'], cwd)
      base.loginStatus = /not logged|not authenticated/i.test(auth.text) ? 'signed-out' : auth.ok && /logged in|authenticated/i.test(auth.text) ? 'ready' : 'unknown'
      base.source = 'cursor-agent models/status; public settings model'
      base.warnings.push('Cursor --effort selects an exact listed model variant when available; otherwise it uses a [effort=...] override, which the selected model must support.')
    }
  } catch { base.warnings.push('Some inspection commands are unavailable. Unknown values are not a sign-in failure.') }
  return base
}

export async function detectCli(id, cwd, { refresh = false, now = Date.now(), ttlMs = CACHE_TTL_MS } = {}) {
  pruneDetectCache(now)
  const key = cacheKey(id, cwd)
  if (!refresh) {
    const hit = detectCache.get(key)
    if (hit && hit.expiresAt > now) return structuredClone(hit.value)
    const pending = inFlight.get(key)
    if (pending) return structuredClone(await pending)
  }
  const promise = runDetectCli(id, cwd)
  inFlight.set(key, promise)
  try {
    const result = await promise
    detectCache.set(key, { expiresAt: Date.now() + ttlMs, value: structuredClone(result) })
    return structuredClone(result)
  } finally {
    if (inFlight.get(key) === promise) inFlight.delete(key)
  }
}

export async function discoverPi(cwd, { refresh = false, now = Date.now(), ttlMs = CACHE_TTL_MS } = {}) {
  pruneDetectCache(now)
  const key = cacheKey('__discover_pi__', cwd)
  if (!refresh) {
    const hit = detectCache.get(key)
    if (hit && hit.expiresAt > now) return [...hit.value]
    const pending = inFlight.get(key)
    if (pending) return [...await pending]
  }
  const promise = (async () => {
    const bin = resolveCli('pi')
    if (!bin) return []
    const listed = await inspectCommand(bin, ['--list-models', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve', '--offline'], cwd)
    return [...new Set(listed.text.split('\n').map(line => /^([a-z0-9][a-z0-9_.-]*)\s+\S+\s+[0-9.]+[KM]?\s+[0-9.]+[KM]?\s+(?:yes|no)\s+(?:yes|no)\s*$/.exec(line)?.[1]).filter(Boolean))].map(p => 'pi:' + p)
  })()
  inFlight.set(key, promise)
  try {
    const result = await promise
    detectCache.set(key, { expiresAt: Date.now() + ttlMs, value: [...result] })
    return [...result]
  } finally {
    if (inFlight.get(key) === promise) inFlight.delete(key)
  }
}

import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { home, isolated, toolsPath } from './paths.mjs'
import { platform } from './platform/index.mjs'
import { sdkRoot } from './pi-profile.mjs'
import { mask, parseRedactedJson, redactStderr, secretsFrom } from './pi-secrets.mjs'
import { modelEnvironment } from './model-env.mjs'
import { execCli, getEnvVar, normalizeEnv, runtimePath, spawnCli, writeMarkerPid } from './spawn-cli.mjs'
import { HOST_SESSION_VARS } from './templates.mjs'

const authKeyCache = new Map()

export function providerOf(model) {
  const match = /^([a-z0-9][a-z0-9_.-]*)\/([^\s\x00-\x1f\x7f]+)$/.exec(model)
  if (!match) throw new Error('Expected an exact --model provider/model-id')
  return match[1]
}

function writeAtomic(path, content) {
  const tmp = path + '.' + randomUUID()
  try {
    writeFileSync(tmp, content, { mode: 0o600 })
    renameSync(tmp, path)
  } finally {
    rmSync(tmp, { force: true })
  }
}

function writeConfig(path, data) {
  writeAtomic(path, JSON.stringify(data))
}

async function credentialCommand(access, args, env) {
  try {
    const [file, ...argv] = platform.piCommand(['auth', ...args], access)
    const { stdout } = await execCli(file, argv, {
      cwd: home, env: normalizeEnv(env), encoding: 'utf8', timeout: 20000
    })
    return stdout.trim()
  } catch {
    throw new Error('pi auth could not resolve an API key for ' + args[args.indexOf('--provider') + 1])
  }
}

export function loginEnvironment() {
  const env = { PATH: runtimePath(), PI_CODING_AGENT_SESSION_DIR: join(home, 'sessions') }
  if (isolated) {
    Object.assign(env, { HOME: join(home, 'home'), TMPDIR: join(home, 'tmp'), PI_CODING_AGENT_DIR: join(home, 'login'), PI_TELEMETRY: '0' })
    if (process.platform === 'win32') {
      Object.assign(env, { USERPROFILE: env.HOME, TEMP: env.TMPDIR, TMP: env.TMPDIR })
    }
    for (const dir of [env.HOME, env.TMPDIR, env.PI_CODING_AGENT_DIR]) mkdirSync(dir, { recursive: true })
  } else if (process.env.PI_CODING_AGENT_DIR) env.PI_CODING_AGENT_DIR = process.env.PI_CODING_AGENT_DIR
  mkdirSync(env.PI_CODING_AGENT_SESSION_DIR, { recursive: true })
  return env
}

async function resolveIsolatedApiKey(provider, login, agentDir) {
  const canary = process.env.BROCO_FIXTURE_CANARY || ''
  const cacheKey = home + '\0' + provider + '\0' + canary
  const now = Date.now()
  const cached = !canary ? authKeyCache.get(cacheKey) : null
  if (cached && now < cached.expiresAt) return cached.promise

  const promise = (async () => {
    mkdirSync(agentDir, { recursive: true })
    writeConfig(join(agentDir, 'auth.json'), { [provider]: { type: 'api_key', key: '$BROCO_API_KEY' } })
    writeConfig(join(agentDir, 'settings.json'), process.platform === 'win32' ? {} : { shellCommandPrefix: 'unset BROCO_API_KEY; exec 19<"$BROCO_MARKER"' })

    const check = ['check', '--no-refresh', '--json', '--provider', provider]
    const lookup = { ...modelEnvironment(), ...login, PI_OFFLINE: '1' }
    const status = await credentialCommand('isolated', check, lookup).then(JSON.parse).catch(() => null)
    if (status?.authType !== 'api_key') throw new Error('No API-key credential for ' + provider)
    const result = JSON.parse(await credentialCommand('isolated', [...check, '--credentials'], lookup))
    if (result.authType !== 'api_key' || !result.credentials) throw new Error('API-key lookup failed for ' + provider)
    const verifyEnv = { ...login, PI_OFFLINE: '1', PI_CODING_AGENT_DIR: agentDir, BROCO_API_KEY: result.credentials }
    const key = await credentialCommand('isolated', ['print-api-key', '--provider', provider], verifyEnv)
    if (!key || /[\r\n]/.test(key)) throw new Error('Invalid API-key export for ' + provider)
    return key
  })()

  if (!canary) {
    authKeyCache.set(cacheKey, { expiresAt: now + 5000, promise })
    promise.catch(() => {
      if (authKeyCache.get(cacheKey)?.promise === promise) authKeyCache.delete(cacheKey)
    })
  }
  return promise
}

async function workerEnvironment(provider, marker) {
  const login = loginEnvironment()
  const configured = login.PI_CODING_AGENT_DIR && ['auth.json', 'models.json'].some(name => existsSync(join(login.PI_CODING_AGENT_DIR, name)))
  if (!isolated || sdkRoot(toolsPath) || configured) {
    const env = modelEnvironment()
    for (const key of HOST_SESSION_VARS) delete env[key]
    if (process.platform === 'win32') {
      return normalizeEnv({ ...env, ...login, BROCO_MARKER: marker, BROCO_IN_WORKER: '1' })
    }
    const original = process.env.BASH_ENV || ''
    const credentialNames = Object.keys(env).filter(k => /^[A-Za-z_][A-Za-z0-9_]*(?:API_KEY|AUTH_KEY|PRIVATE_KEY|TOKEN|ACCESS_KEY|SECRET|PASSWORD|PASSWD)$/i.test(k))
    const unset = isolated && credentialNames.length ? 'unset ' + credentialNames.join(' ') + '\n' : ''
    const script = 'if [ -n "$BROCO_BASH_ENV" ]; then . "$BROCO_BASH_ENV"; fi\n' + unset + 'exec 19<"$BROCO_MARKER"\n'
    const digest = createHash('sha256').update(script).digest('hex').slice(0, 16)
    const prelude = join(home, 'bash-env.' + digest)
    if (!existsSync(prelude)) {
      mkdirSync(home, { recursive: true })
      writeAtomic(prelude, script)
    }
    return { ...env, ...login, BROCO_MARKER: marker, BROCO_IN_WORKER: '1', BASH_ENV: prelude, BROCO_BASH_ENV: original }
  }
  if (['openai-codex', 'github-copilot', 'google-antigravity', 'google-gemini-cli'].includes(provider)) {
    throw new Error('Sign in to this provider in the sandbox pi profile.')
  }
  const agentDir = join(home, 'agents', provider)
  const env = { ...login, PI_OFFLINE: '1', PI_CODING_AGENT_DIR: agentDir }
  const passthrough = ['LANG', 'LC_ALL', 'TZ', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS']
  if (process.platform === 'win32') {
    passthrough.push('USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP')
  }
  for (const name of passthrough) {
    const val = getEnvVar(process.env, name)
    if (val) env[name] = val
  }
  env.BROCO_API_KEY = await resolveIsolatedApiKey(provider, login, agentDir)
  env.BROCO_MARKER = marker
  env.BROCO_IN_WORKER = '1'
  return normalizeEnv(env)
}

export async function spawnPi(model, cwd, marker, args) {
  const provider = model.startsWith('pi:') ? model.slice(3) : providerOf(model)
  const env = await workerEnvironment(provider, marker)
  env.BROCO_IN_WORKER = '1'
  const sessionFlag = args.lastIndexOf('--session-dir')
  if (sessionFlag !== -1) {
    env.PI_CODING_AGENT_SESSION_DIR = args[sessionFlag + 1]
    mkdirSync(env.PI_CODING_AGENT_SESSION_DIR, { recursive: true })
  }
  mkdirSync(dirname(marker), { recursive: true })
  const [file, ...argv] = platform.piCommand(args, isolated ? 'isolated' : null)
  let child
  if (process.platform === 'win32') {
    child = spawnCli(file, argv, {
      cwd, env: normalizeEnv(env), detached: false, stdio: ['pipe', 'pipe', 'pipe']
    })
    writeMarkerPid(marker, child.pid)
  } else {
    const fd = openSync(marker, 'a+', 0o600)
    try {
      child = spawnCli(file, argv, {
        cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe', fd]
      })
    } finally { closeSync(fd) }
  }
  let stderr = ''
  child.stderr.on('data', part => { stderr = (stderr + part.toString('utf8')).slice(-4096) })
  const rawSecrets = secretsFrom([], env)
  const escapedSecrets = [...new Set(rawSecrets.flatMap(v => [JSON.stringify(v).slice(1, -1), v]).filter(v => v.length >= 4))].sort((a, b) => b.length - a.length)
  return {
    child,
    redact: line => mask(line, escapedSecrets),
    rawSecrets,
    getStderr: () => redactStderr(stderr, env, rawSecrets)
  }
}

export function onLine(stream, consume) {
  let buffer = ''
  stream.setEncoding('utf8')
  stream.on('data', chunk => {
    buffer += chunk
    let lf
    while ((lf = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, lf)
      buffer = buffer.slice(lf + 1)
      if (line.trim()) consume(line)
    }
  })
}

export class Pi {
  static async launch(c, onRecord, onExit, sessions, marker) {
    const provider = c.provider.slice(3)
    const selector = c.model === c.provider ? ['--models', provider + '/*'] : ['--provider', provider, '--model', c.model.slice(provider.length + 1)]
    const args = ['--mode', 'rpc', ...selector, '--session-dir', sessions, '--session-id', c.id, '--no-approve']
    if (c.thinking) args.push('--thinking', c.thinking)
    if (isolated) args.push('--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-themes', '--tools', 'read,bash,edit,write')
    const { child, redact, rawSecrets, getStderr } = await spawnPi(c.model, c.cwd, marker, args)
    return new Pi(child, redact, onRecord, onExit, rawSecrets, getStderr)
  }

  constructor(child, redact, onRecord, onExit, rawSecrets = [], getStderr = () => '') {
    this.child = child
    this.pending = new Map()
    this.turn = 0
    this.expectedExit = false
    this.closed = new Promise(resolve => {
      let problem
      const fail = err => {
        problem = err
        child.kill('SIGKILL')
      }
      child.on('error', () => fail(new Error('Could not launch sandboxed pi')))
      child.stdin.on('error', () => fail(new Error('Lost pi RPC stdin')))
      onLine(child.stdout, line => {
        if (problem) return
        try {
          const record = parseRedactedJson(redact(line), rawSecrets)
          if (typeof record.type !== 'string') throw new Error()
          onRecord(this, record)
          const ack = record.type === 'response' && this.pending.get(record.id)
          if (ack) {
            this.pending.delete(record.id)
            if (record.success) ack.resolve(record.data)
            else ack.reject(Object.assign(new Error(record.error || 'pi rejected ' + record.command), { declined: true }))
          }
        } catch { fail(new Error('Could not read or persist pi RPC record')) }
      })
      child.once('close', (code, signal) => {
        const detail = !problem && code !== 0 ? getStderr() : ''
        const err = problem || new Error('pi exited (' + (signal || code) + ')' + (detail ? ': ' + detail : ''))
        this.exited = true
        for (const ack of this.pending.values()) ack.reject(err)
        this.pending.clear()
        onExit(this, err)
        resolve()
      })
    })
  }

  command(type, args = {}, timeout = 25000) {
    if (this.exited) return Promise.reject(new Error('pi is offline'))
    const id = randomUUID()
    let timer
    const response = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      timer = setTimeout(() => {
        this.pending.delete(id)
        this.child.kill('SIGKILL')
        reject(new Error('Timed out waiting for pi ' + type))
      }, timeout)
      timer.unref?.()
      this.child.stdin.write(JSON.stringify({ id, type, ...args }) + '\n')
    })
    return response.finally(() => clearTimeout(timer))
  }
}

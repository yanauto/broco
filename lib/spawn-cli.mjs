import { execFile, execFileSync, spawn } from 'node:child_process'
import { accessSync, constants, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, posix, win32 } from 'node:path'
import { promisify } from 'node:util'
import { home, isolated } from './paths.mjs'

const execFileAsync = promisify(execFile)
const DEFAULT_PATHEXT = ['.com', '.exe', '.bat', '.cmd']
const VALUE_NODE_FLAGS = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '--conditions', '-C', '--env-file', '--env-file-if-exists'])
const CMD_SHIM_PREFIX = /^endlocal\s*&\s*goto\s+#_undefined_#\s*2>nul\s*\|\|\s*title\s+%comspec%\s*&\s*(?:set\s+pathext=[^&]+&\s*)?/i
const BOILERPLATE_PATTERNS = [
  /^@?echo\s+off$/i,
  /^(?:rem(?:\s|$)|::)/i,
  /^@?(?:setlocal|endlocal)(?:\s+(?:enable|disable)(?:extensions|delayedexpansion))*$/i,
  /^@?(?:goto\s+\S+|:\S+|call\s+:\S+|exit\s+\/b(?:\s+.*)?)$/i,
  /^@?if\s+exist\s+.*node\.exe.*\($/i,
  /^\)\s*else\s*\($/i,
  /^\)$/,
  /^@?set\s+"?(?:dp0|_prog|pathext)=/i,
  /^@?chcp\s+\d+(?:\s*>.*)?$/i
]

export function getEnvVar(env, name) {
  if (!env || typeof env !== 'object' || typeof name !== 'string') return undefined
  if (Object.hasOwn(env, name)) return env[name]
  const lower = name.toLowerCase()
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === lower) return env[key]
  }
  return undefined
}

export function normalizeEnv(env, platform = process.platform) {
  if (!env || typeof env !== 'object') return env
  if (platform !== 'win32') return { ...env }
  const out = {}
  const seen = new Map()
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue
    const lower = key.toLowerCase()
    const prev = seen.get(lower)
    if (prev !== undefined && prev !== key) delete out[prev]
    seen.set(lower, key)
    out[key] = value
  }
  return out
}

export function pathEntries(env = process.env, platform = process.platform) {
  const sep = platform === 'win32' ? ';' : ':'
  const raw = getEnvVar(env, 'PATH') ?? ''
  return String(raw)
    .split(sep)
    .map(part => {
      const trimmed = part.trim()
      if (platform === 'win32' && trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
        return trimmed.slice(1, -1)
      }
      return trimmed
    })
    .filter(Boolean)
}

export function runtimePath(env = process.env, { includeIsolated = isolated, platform = process.platform } = {}) {
  const sep = platform === 'win32' ? ';' : ':'
  const entries = [
    ...(includeIsolated ? [join(home, 'tools', 'bin')] : []),
    ...pathEntries(env, platform)
  ]
  return entries.join(sep)
}

export function pathextList(env = process.env, pathext) {
  const raw = pathext ?? getEnvVar(env, 'PATHEXT') ?? DEFAULT_PATHEXT.join(';')
  const seen = new Set()
  const out = []
  for (const item of String(raw).split(';')) {
    const trimmed = item.trim().toLowerCase()
    if (!trimmed) continue
    const ext = trimmed.startsWith('.') ? trimmed : '.' + trimmed
    if (!seen.has(ext)) {
      seen.add(ext)
      out.push(ext)
    }
  }
  return out.length ? out : [...DEFAULT_PATHEXT]
}

function isFilePosix(file) {
  try {
    accessSync(file, constants.X_OK)
    return statSync(file).isFile()
  } catch {
    return false
  }
}

function isFileWin(file) {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

export function resolveCli(name, { dirs, env = process.env, platform = process.platform, pathext } = {}) {
  if (typeof name !== 'string' || !name) return null
  const isPath = name.includes('/') || (platform === 'win32' && (name.includes('\\') || /^[a-zA-Z]:/.test(name)))
  const searchDirs = dirs ?? [
    ...(env === process.env && isolated ? [join(home, 'tools', 'bin')] : []),
    ...pathEntries(env, platform)
  ]
  if (platform !== 'win32') {
    const candidates = isPath ? [name] : searchDirs.map(d => join(d, name))
    for (const file of candidates) {
      if (isFilePosix(file)) return file
    }
    return null
  }
  const exts = pathextList(env, pathext)
  const hasExt = base => {
    const lower = base.toLowerCase()
    return exts.some(ext => lower.endsWith(ext))
  }
  const findWithExts = base => {
    if (hasExt(base) && isFileWin(base)) return base
    for (const ext of exts) {
      const lowerCandidate = base + ext
      if (isFileWin(lowerCandidate)) return lowerCandidate
      if (process.platform !== 'win32') {
        const upperCandidate = base + ext.toUpperCase()
        if (isFileWin(upperCandidate)) return upperCandidate
      }
    }
    return null
  }
  if (isPath) {
    const hit = findWithExts(name)
    if (hit) return hit
    if (/\.(?:exe|com|cmd|bat)$/i.test(name) && isFileWin(name)) return name
    return null
  }
  for (const dir of searchDirs) {
    const hit = findWithExts(join(dir, name))
    if (hit) return hit
  }
  return null
}

function tokenizeBatchLine(line) {
  const tokens = []
  let i = 0
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i])) i++
    if (i >= line.length) break
    if (line[i] === '"') {
      i++
      let value = ''
      while (i < line.length && line[i] !== '"') value += line[i++]
      if (i >= line.length) return null
      i++
      tokens.push({ value, quoted: true })
    } else {
      let value = ''
      while (i < line.length && !/\s/.test(line[i])) value += line[i++]
      tokens.push({ value, quoted: false })
    }
  }
  return tokens
}

function isNodeProg(token, hasNodeProg) {
  const cleaned = token.replace(/^@/, '')
  if (hasNodeProg && cleaned.toLowerCase() === '%_prog%') return true
  if (/^(?:.*[/\\])?node(?:\.exe)?$/i.test(cleaned)) return true
  if (/^%~?dp0%?[/\\]?node(?:\.exe)?$/i.test(cleaned)) return true
  return false
}

function expandDp0(raw, shimDir, pathMod) {
  const replaced = raw
    .replace(/%dp0%[\\/]?/gi, shimDir + pathMod.sep)
    .replace(/%~dp0[\\/]?/gi, shimDir + pathMod.sep)
  if (replaced.includes('%')) return null
  const normalized = pathMod === win32 ? replaced.replaceAll('/', '\\') : replaced.replaceAll('\\', '/')
  return pathMod.resolve(shimDir, normalized)
}

export function parseCmdNodeShim(content, shimPath) {
  if (typeof content !== 'string' || !content.trim() || typeof shimPath !== 'string' || !shimPath) return null
  const lines = content.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  let hasNodeProg = false
  const invocations = []
  for (const line of lines) {
    if (/^@?set\s+"?_prog=(?:.*[/\\]|%~?dp0%?[/\\]?)?node(?:\.exe)?"?$/i.test(line)) {
      hasNodeProg = true
      continue
    }
    if (BOILERPLATE_PATTERNS.some(re => re.test(line))) continue
    const stripped = line.replace(CMD_SHIM_PREFIX, '').replace(/^@/, '').trim()
    const tokens = tokenizeBatchLine(stripped)
    if (!tokens || tokens.length < 3) return null
    if (tokens.at(-1).value !== '%*' || tokens.at(-1).quoted) return null
    if (!isNodeProg(tokens[0].value, hasNodeProg)) return null
    const body = tokens.slice(1, -1)
    const nodeArgs = []
    let idx = 0
    while (idx < body.length && body[idx].value.startsWith('-')) {
      const flag = body[idx].value
      if (/[&|<>%]/.test(flag)) return null
      nodeArgs.push(flag)
      idx++
      if (VALUE_NODE_FLAGS.has(flag) && idx < body.length) {
        if (/[&|<>%]/.test(body[idx].value)) return null
        nodeArgs.push(body[idx].value)
        idx++
      }
    }
    if (idx >= body.length) return null
    const rawScript = body[idx].value
    if (!rawScript || /[&|<>]/.test(rawScript)) return null
    const prefixArgs = []
    for (let j = idx + 1; j < body.length; j++) {
      const arg = body[j]
      if (arg.value.includes('%') || (!arg.quoted && /[&|<>^]/.test(arg.value))) return null
      prefixArgs.push(arg.value)
    }
    invocations.push({ rawScript, nodeArgs, prefixArgs })
  }
  if (!invocations.length) return null
  const first = invocations[0]
  for (let i = 1; i < invocations.length; i++) {
    const cur = invocations[i]
    if (
      cur.rawScript !== first.rawScript ||
      JSON.stringify(cur.nodeArgs) !== JSON.stringify(first.nodeArgs) ||
      JSON.stringify(cur.prefixArgs) !== JSON.stringify(first.prefixArgs)
    ) {
      return null
    }
  }
  const pathMod = shimPath.includes('\\') || /^[a-zA-Z]:/.test(shimPath) ? win32 : posix
  const shimDir = pathMod.dirname(shimPath)
  const script = expandDp0(first.rawScript, shimDir, pathMod)
  if (!script) return null
  return { script, nodeArgs: first.nodeArgs, prefixArgs: first.prefixArgs }
}

function quoteCmdExe(exe) {
  return '"' + String(exe).replaceAll('"', '""').replaceAll('%', '"^%"') + '"'
}

function quoteCmdArg(arg) {
  const s = String(arg)
  if (!s) return '""'
  if (/^[A-Za-z0-9_./:=+-]+$/.test(s)) return s
  const escaped = s
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\+)$/, '$1$1')
  return '"' + escaped.replaceAll('%', '"^%"').replaceAll('!', '"^!"') + '"'
}

export function resolveCommand(file, args = [], { env = process.env, platform = process.platform, dirs, pathext, execPath = process.execPath, checkScriptExists = true } = {}) {
  const resolved = resolveCli(file, { dirs, env, platform, pathext }) ?? file
  const argList = Array.isArray(args) ? [...args] : []
  if (platform !== 'win32') {
    return { file: resolved, args: argList, shell: false, windowsVerbatimArguments: false }
  }
  if (/\.(?:cmd|bat)$/i.test(resolved)) {
    let shim = null
    try {
      const content = readFileSync(resolved, 'utf8')
      shim = parseCmdNodeShim(content, resolved)
    } catch {}
    if (shim && (!checkScriptExists || existsSync(shim.script))) {
      return {
        file: execPath,
        args: [...shim.nodeArgs, shim.script, ...shim.prefixArgs, ...argList],
        shell: false,
        windowsVerbatimArguments: false
      }
    }
    const comspec = getEnvVar(env, 'ComSpec') || 'cmd.exe'
    const cmdLine = '"' + [quoteCmdExe(resolved), ...argList.map(quoteCmdArg)].join(' ') + '"'
    return {
      file: comspec,
      args: ['/d', '/s', '/c', cmdLine],
      shell: false,
      windowsVerbatimArguments: true
    }
  }
  return { file: resolved, args: argList, shell: false, windowsVerbatimArguments: false }
}

export function spawnCli(file, args = [], options = {}) {
  const env = options.env ? normalizeEnv(options.env) : undefined
  const resolved = resolveCommand(file, args, { env: env ?? process.env })
  return spawn(resolved.file, resolved.args, {
    windowsHide: true,
    ...options,
    ...(env ? { env } : {}),
    ...(resolved.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {})
  })
}

export function execCli(file, args = [], options = {}) {
  const env = options.env ? normalizeEnv(options.env) : undefined
  const resolved = resolveCommand(file, args, { env: env ?? process.env })
  return execFileAsync(resolved.file, resolved.args, {
    windowsHide: true,
    ...options,
    ...(env ? { env } : {}),
    ...(resolved.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {})
  })
}

export function execCliSync(file, args = [], options = {}) {
  const env = options.env ? normalizeEnv(options.env) : undefined
  const resolved = resolveCommand(file, args, { env: env ?? process.env })
  return execFileSync(resolved.file, resolved.args, {
    windowsHide: true,
    ...options,
    ...(env ? { env } : {}),
    ...(resolved.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {})
  })
}

export function writeMarkerPid(marker, pid) {
  mkdirSync(dirname(marker), { recursive: true })
  const payload = Number.isSafeInteger(pid) && pid > 1
    ? JSON.stringify({ pid, created: Date.now() }) + '\n'
    : ''
  writeFileSync(marker, payload)
}

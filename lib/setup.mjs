import { randomUUID } from 'node:crypto'
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { call, probeReady } from './client.mjs'
import { detectCli, discoverPi } from './detect.mjs'
import { canonical, home, isolated, legacyCcBroHome, repo, socketFor } from './paths.mjs'
import { windowLabel } from './quota.mjs'
import { SettingsAudit } from './settings-audit.mjs'
import { supportedWorker } from './worker-policy.mjs'

const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
const EPHEMERAL_DIR = /^(?:\/private)?\/(?:tmp|var\/folders)(?:\/|$)/
const NPM_SHIM_DIR = /\/(?:node_modules\/\.bin|\.npm\/_npx)(?:\/|$)/
const TEST_SANDBOX_DIR = /\/(?:\.sandbox|test\/fixtures)(?:\/|$)/
const TRANSIENT_NAMES = new Set(['runner.lock', 'runner.lock-wal', 'runner.lock-shm', 'runner.pid', 'runner.plist'])

export const FIRST_RUN_PROMPT = 'Check my broco roster and ask a different model to review my latest commit.'

function isDir(path) {
  try {
    return existsSync(path) && statSync(path).isDirectory()
  } catch {
    return false
  }
}

function writeAtomic(file, content, mode) {
  const tmp = file + '.' + randomUUID()
  writeFileSync(tmp, content, { mode, flag: 'wx' })
  chmodSync(tmp, mode)
  renameSync(tmp, file)
}

export function sanitizeSetupPath(rawPath = process.env.PATH ?? '', { nodeDir = dirname(realpathSync(process.execPath)), isIsolated = isolated } = {}) {
  const allowedIsolatedDirs = new Set()
  if (isIsolated) {
    const fixturePath = join(repo, 'test', 'fixtures')
    allowedIsolatedDirs.add(fixturePath)
    if (existsSync(fixturePath)) allowedIsolatedDirs.add(realpathSync(fixturePath))
  }
  const entries = [nodeDir, ...String(rawPath).split(delimiter)]
  const seen = new Set()
  const kept = []
  for (const raw of entries) {
    const entry = raw.trim()
    if (!entry.startsWith('/') || seen.has(entry)) continue
    if (entry !== nodeDir && !allowedIsolatedDirs.has(entry)) {
      if (EPHEMERAL_DIR.test(entry) || NPM_SHIM_DIR.test(entry)) continue
      if (!isIsolated && TEST_SANDBOX_DIR.test(entry)) continue
      if (!existsSync(entry)) continue
    } else if (entry !== nodeDir && !existsSync(entry)) {
      continue
    }
    seen.add(entry)
    kept.push(entry)
  }
  return kept.join(':')
}

export function skillHostTargets({ homeDir, skillsHome, env = process.env } = {}) {
  const effectiveHome = resolve(homeDir ?? env.BROCO_HOST_HOME ?? homedir())
  const universalRoot = resolve(skillsHome ?? env.BROCO_SKILLS_HOME ?? join(effectiveHome, '.agents', 'skills'))
  const universalDir = join(universalRoot, 'broco')
  const claudeParent = env.CLAUDE_CONFIG_DIR ? resolve(env.CLAUDE_CONFIG_DIR) : join(effectiveHome, '.claude')
  const codexParent = env.CODEX_HOME ? resolve(env.CODEX_HOME) : join(effectiveHome, '.codex')
  const piParent = env.PI_CODING_AGENT_DIR ? resolve(env.PI_CODING_AGENT_DIR) : join(effectiveHome, '.pi', 'agent')
  const hostCandidates = [
    { id: 'claude', parent: claudeParent, dir: join(claudeParent, 'skills', 'broco'), explicit: Boolean(env.CLAUDE_CONFIG_DIR) },
    { id: 'codex', parent: codexParent, dir: join(codexParent, 'skills', 'broco'), explicit: Boolean(env.CODEX_HOME) },
    { id: 'gemini', parent: join(effectiveHome, '.gemini', 'config'), dir: join(effectiveHome, '.gemini', 'config', 'skills', 'broco'), explicit: false },
    { id: 'cursor', parent: join(effectiveHome, '.cursor'), dir: join(effectiveHome, '.cursor', 'skills', 'broco'), explicit: false },
    { id: 'opencode', parent: join(effectiveHome, '.config', 'opencode'), dir: join(effectiveHome, '.config', 'opencode', 'skills', 'broco'), explicit: false },
    { id: 'pi', parent: piParent, dir: join(piParent, 'skills', 'broco'), explicit: Boolean(env.PI_CODING_AGENT_DIR), symlink: true }
  ]
  return { effectiveHome, universalDir, hostCandidates }
}

export function setupInfo(opts = {}) {
  const env = opts.env ?? process.env
  const { universalDir, hostCandidates } = skillHostTargets({
    homeDir: opts.homeDir,
    skillsHome: opts.skillsHome,
    env
  })
  mkdirSync(universalDir, { recursive: true })
  const launcher = join(universalDir, 'broco')
  const skillPath = join(universalDir, 'SKILL.md')
  const node = realpathSync(process.execPath)
  const cli = realpathSync(join(repo, 'bin', 'broco'))
  const path = sanitizeSetupPath(env.PATH ?? '', { nodeDir: dirname(node), isIsolated: isolated })
  const script = [
    '#!/bin/sh',
    'export PATH=' + quote(path) + ':"$PATH"',
    'if [ -z "$BROCO_HOME" ]; then export BROCO_HOME=' + quote(home) + '; fi',
    'exec ' + quote(node) + ' ' + quote(cli) + ' "$@"',
    ''
  ].join('\n')
  const skillTemplate = readFileSync(join(repo, 'skills', 'broco', 'SKILL.md'), 'utf8')
  const skill = skillTemplate.replaceAll('{{launcher}}', () => quote(launcher))
  writeAtomic(launcher, script, 0o755)
  writeAtomic(skillPath, skill, 0o644)

  const universalCanonical = canonical(universalDir)
  const seenDirs = new Set([universalCanonical])
  const hosts = [{ id: 'agents', dir: universalDir, skillPath, launcher }]
  const skippedHosts = []

  for (const target of hostCandidates) {
    if (!target.explicit && !isDir(target.parent)) {
      skippedHosts.push(target.id)
      continue
    }
    const resolvedTarget = canonical(target.dir)
    if (target.symlink) {
      if (resolvedTarget === universalCanonical) {
        hosts.push({ id: target.id, dir: target.dir, skillPath: join(target.dir, 'SKILL.md'), launcher })
        continue
      }
      if (universalCanonical.startsWith(resolvedTarget + sep)) {
        skippedHosts.push(target.id)
        continue
      }
      mkdirSync(dirname(target.dir), { recursive: true })
      if (lstatSync(target.dir, { throwIfNoEntry: false })) {
        rmSync(target.dir, { recursive: true, force: true })
      }
      symlinkSync(universalDir, target.dir, 'dir')
      hosts.push({ id: target.id, dir: target.dir, skillPath: join(target.dir, 'SKILL.md'), launcher })
      continue
    }
    if (seenDirs.has(resolvedTarget)) {
      hosts.push({ id: target.id, dir: target.dir, skillPath: join(target.dir, 'SKILL.md'), launcher })
      continue
    }
    mkdirSync(target.dir, { recursive: true })
    const targetSkill = join(target.dir, 'SKILL.md')
    writeAtomic(targetSkill, skill, 0o644)
    seenDirs.add(resolvedTarget)
    hosts.push({ id: target.id, dir: target.dir, skillPath: targetSkill })
  }

  return {
    launcher,
    skillPath,
    universal: { dir: universalDir, launcher, skillPath },
    hosts,
    skippedHosts
  }
}

export function setup(opts) {
  return setupInfo(opts).launcher
}

export function formatQuotaBar(quota) {
  if (!quota) return 'quota: unreported'
  if (quota.source === 'observed') {
    return 'quota: observed ' + quota.class + ' (avoid)'
  }
  const wins = Array.isArray(quota.windows) ? quota.windows : []
  if (!wins.length) return 'quota: no windows'
  const parts = wins.map(w => {
    const used = Math.max(0, Math.min(100, Math.round(Number(w.usedPercent) || 0)))
    const left = 100 - used
    const filled = Math.round(left / 10)
    const bar = '[' + '█'.repeat(filled) + '░'.repeat(10 - filled) + ']'
    return windowLabel(w.minutes) + ' ' + bar + ' ' + left + '% left' + (used >= 90 ? ' (tight)' : '')
  })
  const tightExtra = Array.isArray(quota.tightGroups) && quota.tightGroups.length
    ? ' · tight: ' + quota.tightGroups.map(g => g.name).join(', ')
    : ''
  return parts.join('  ') + tightExtra
}

export async function probeSetupWorkers({ cwd = process.cwd() } = {}) {
  const builtins = ['codex', 'agy', 'cursor-agent', 'claude'].filter(supportedWorker)
  const discoveredPi = await discoverPi(cwd, { refresh: true }).catch(() => [])
  const ids = [...new Set([...builtins, ...discoveredPi.filter(supportedWorker)])]
  const rows = await Promise.all(ids.map(async id => {
    try {
      const detected = await detectCli(id, cwd, { refresh: true })
      const installed = Boolean(detected.installed)
      const loginStatus = detected.loginStatus || 'unknown'
      const loggedIn = Boolean(installed && ['ready', 'not-required'].includes(loginStatus))
      return {
        id,
        cli: detected.cli || id,
        installed,
        loginStatus,
        loggedIn,
        defaultModel: detected.defaultModel || detected.models?.[0]?.id || null,
        modelCount: detected.models?.length ?? 0,
        quota: detected.quota ?? null,
        quotaBar: formatQuotaBar(detected.quota ?? null),
        install: detected.install ?? null,
        login: detected.login ?? null
      }
    } catch {
      return {
        id,
        cli: id.startsWith('pi:') ? 'pi' : id,
        installed: false,
        loginStatus: 'unavailable',
        loggedIn: false,
        defaultModel: null,
        modelCount: 0,
        quota: null,
        quotaBar: 'quota: unreported',
        install: null,
        login: null
      }
    }
  }))
  return rows
}

export function formatSetupRoster(detected, currentAllow = [], defaultWorker = '') {
  if (!detected.length) return 'No supported worker CLIs detected.'
  const allowedSet = new Set(currentAllow)
  return detected.map(w => {
    const tag = allowedSet.has(w.id)
      ? (w.id === defaultWorker ? '[allowed*]' : '[allowed]')
      : w.loggedIn ? '[ready]' : w.installed ? '[' + w.loginStatus + ']' : '[missing]'
    const model = w.defaultModel ? 'model=' + w.defaultModel : (w.modelCount ? w.modelCount + ' models' : 'no models')
    const detail = w.loggedIn
      ? model + '  ' + w.quotaBar
      : w.installed
        ? (w.login ? 'login: ' + w.login : w.loginStatus)
        : (w.install ? 'install: ' + w.install : 'not installed')
    return '  ' + tag.padEnd(11) + ' ' + w.id.padEnd(16) + ' ' + detail
  }).join('\n')
}

export function readGlobalPolicy(brocoHome = home) {
  const regPath = join(brocoHome, 'registry-v2.sqlite')
  if (!existsSync(regPath)) return { configured: false, allow: [], defaultWorker: '', revision: 0 }
  const db = new DatabaseSync(regPath, { readOnly: true })
  try {
    const hasTable = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='roster_settings'").get())
    if (!hasTable) return { configured: false, allow: [], defaultWorker: '', revision: 0 }
    const row = db.prepare("SELECT revision, data FROM roster_settings WHERE scope='global'").get()
    if (!row) return { configured: false, allow: [], defaultWorker: '', revision: 0 }
    const data = JSON.parse(row.data || '{}')
    const allow = Array.isArray(data.allow) ? data.allow.filter(supportedWorker) : []
    const defaultWorker = allow.includes(data.worker) ? data.worker : (allow[0] ?? '')
    return { configured: allow.length > 0, allow, defaultWorker, revision: row.revision }
  } finally {
    db.close()
  }
}

export async function saveGlobalAllowlist(allowInput, { defaultWorker, brocoHome = home } = {}) {
  const rawList = Array.isArray(allowInput)
    ? allowInput
    : String(allowInput ?? '').split(',')
  const allow = [...new Set(rawList.map(s => String(s).trim()).filter(Boolean))]
  if (!allow.length) throw new Error('Specify at least one worker to allow globally')
  if (allow.some(id => !supportedWorker(id))) {
    throw new Error('Expected supported workers (claude, codex, agy, cursor-agent, pi:<provider>, or custom:<name>): ' + allow.filter(id => !supportedWorker(id)).join(', '))
  }
  const existing = readGlobalPolicy(brocoHome)
  let nextWorker = defaultWorker
  if (nextWorker !== undefined && nextWorker !== null && nextWorker !== '') {
    if (!allow.includes(nextWorker)) throw new Error('Default worker must be in the allowed list: ' + nextWorker)
  } else {
    nextWorker = allow.includes(existing.defaultWorker) ? existing.defaultWorker : allow[0]
  }
  const sock = socketFor(brocoHome)
  const probe = await probeReady(sock).catch(() => ({ online: false, compatible: false }))
  if (probe.online && probe.compatible) {
    const res = await call('/allow-set', { scope: 'global', allow, defaultWorker: nextWorker, actor: 'user' }, sock)
    return { allow: res.allow, defaultWorker: res.defaultWorker, auditId: res.auditId, via: 'runner' }
  }
  mkdirSync(brocoHome, { recursive: true })
  const db = new DatabaseSync(join(brocoHome, 'registry-v2.sqlite'))
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON')
    db.exec('CREATE TABLE IF NOT EXISTS roster_settings(scope TEXT PRIMARY KEY,revision INTEGER NOT NULL,data TEXT NOT NULL)')
    const audit = new SettingsAudit(db)
    const row = db.prepare("SELECT revision, data FROM roster_settings WHERE scope='global'").get()
    const oldRev = row ? row.revision : 0
    const oldData = row ? JSON.parse(row.data || '{}') : { entries: {}, rules: [] }
    const nextData = {
      ...oldData,
      entries: oldData.entries ?? {},
      rules: oldData.rules ?? [],
      allow,
      worker: nextWorker
    }
    const before = { kind: 'allow', allow: oldData.allow ?? [], worker: oldData.worker ?? '', inheritPolicy: false }
    const after = { kind: 'allow', allow, worker: nextWorker, inheritPolicy: false }
    const summary = 'Set allowlist=[' + allow.join(', ') + ']' + (nextWorker ? ', default=' + nextWorker : '')
    let auditRow
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('INSERT INTO roster_settings VALUES (?,?,?) ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision,data=excluded.data').run(
        'global', oldRev + 1, JSON.stringify(nextData)
      )
      auditRow = audit.record({ scope: 'global', scopeName: 'Global', actor: 'user', action: 'allow', summary, before, after })
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
    return { allow, defaultWorker: nextWorker, auditId: auditRow.id, via: 'sqlite' }
  } finally {
    db.close()
  }
}

export function resolveLegacyHome(env = process.env) {
  if (!env?.CC_BRO_HOME && env?.BROCO_HOST_HOME) {
    return legacyCcBroHome({ ...env, CC_BRO_HOME: join(env.BROCO_HOST_HOME, '.cc-bro') })
  }
  return legacyCcBroHome(env)
}

export function isBrocoHomeEmpty(brocoHome = home) {
  if (!existsSync(brocoHome)) return true
  if (existsSync(join(brocoHome, 'registry-v2.sqlite'))) return false
  const projectsDir = join(brocoHome, 'projects')
  if (existsSync(projectsDir) && isDir(projectsDir)) {
    if (readdirSync(projectsDir).length > 0) return false
  }
  return true
}

export function detectLegacyMigration({ brocoHome = home, env = process.env } = {}) {
  const legacyDir = resolveLegacyHome(env)
  const targetDir = canonical(resolve(brocoHome))
  if (legacyDir === targetDir || !existsSync(legacyDir) || !isDir(legacyDir)) {
    return { available: false, legacyDir, targetDir, legacyHasData: false, targetEmpty: isBrocoHomeEmpty(targetDir), command: 'broco setup --migrate-cc-bro' }
  }
  const hasRegistry = existsSync(join(legacyDir, 'registry-v2.sqlite'))
  const legacyProjects = join(legacyDir, 'projects')
  const hasProjects = isDir(legacyProjects) && readdirSync(legacyProjects).length > 0
  const legacyHasData = hasRegistry || hasProjects
  const targetEmpty = isBrocoHomeEmpty(targetDir)
  return {
    available: legacyHasData && targetEmpty,
    legacyDir,
    targetDir,
    legacyHasData,
    targetEmpty,
    command: 'broco setup --migrate-cc-bro'
  }
}

async function detectActiveRunner(dir) {
  const probe = await probeReady(socketFor(dir)).catch(() => ({ online: false, runner: null }))
  if (probe.online) return { running: true, pid: probe.runner?.pid ?? null }
  const pidPath = join(dir, 'runner.pid')
  if (existsSync(pidPath)) {
    const raw = readFileSync(pidPath, 'utf8').trim()
    const pid = Number(raw)
    if (Number.isSafeInteger(pid) && pid > 1) {
      try {
        process.kill(pid, 0)
        return { running: true, pid }
      } catch {}
    }
  }
  return { running: false, pid: null }
}

function shouldCopyMigrationPath(src) {
  const name = basename(src)
  if (TRANSIENT_NAMES.has(name) || name.endsWith('.sock') || name.endsWith('.service')) return false
  const st = lstatSync(src, { throwIfNoEntry: false })
  if (!st || st.isSocket() || st.isFIFO()) return false
  return true
}

export async function migrateLegacyCcBro({ brocoHome = home, env = process.env } = {}) {
  const status = detectLegacyMigration({ brocoHome, env })
  if (!status.legacyHasData) {
    throw new Error('No legacy ~/.cc-bro data found to migrate at ' + status.legacyDir)
  }
  if (!status.targetEmpty) {
    throw new Error('Target broco home already contains data (' + status.targetDir + '); refusing to overwrite existing data.')
  }
  const legacyRunner = await detectActiveRunner(status.legacyDir)
  if (legacyRunner.running) {
    throw new Error(
      'A legacy runner is currently active for ' + status.legacyDir +
      (legacyRunner.pid ? ' (pid ' + legacyRunner.pid + ')' : '') +
      '. Stop it first with broco shutdown (or cc-bro shutdown) before running broco setup --migrate-cc-bro.'
    )
  }
  const targetRunner = await detectActiveRunner(status.targetDir)
  if (targetRunner.running) {
    throw new Error(
      'A broco runner is currently active for ' + status.targetDir +
      (targetRunner.pid ? ' (pid ' + targetRunner.pid + ')' : '') +
      '. Run broco shutdown first before running broco setup --migrate-cc-bro.'
    )
  }
  mkdirSync(status.targetDir, { recursive: true })
  const copied = []
  for (const name of readdirSync(status.legacyDir)) {
    const src = join(status.legacyDir, name)
    if (!shouldCopyMigrationPath(src)) continue
    const dst = join(status.targetDir, name)
    cpSync(src, dst, { recursive: true, filter: shouldCopyMigrationPath })
    copied.push(name)
  }
  return {
    migrated: true,
    legacyDir: status.legacyDir,
    targetDir: status.targetDir,
    copied,
    preservedLegacy: true
  }
}

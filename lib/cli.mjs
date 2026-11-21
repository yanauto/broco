import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { openDatabase } from './sqlite.mjs'
import { chooseAllow, chooseDefault } from './worker-policy.mjs'
import { rosterOutput, rosterText } from './roster-output.mjs'
import { parseCommand } from './cli-args.mjs'
import { directoryOption, expandHome } from './directories.mjs'
import { modelVariables } from './model-env.mjs'
import {
  FIRST_RUN_PROMPT,
  detectLegacyMigration,
  formatSetupRoster,
  migrateLegacyCcBro,
  probeSetupWorkers,
  readGlobalPolicy,
  saveGlobalAllowlist,
  setupInfo
} from './setup.mjs'
import { call, probeReady, ready, shutdown, shutdownEffect } from './client.mjs'
import { platform } from './platform/index.mjs'
import { Store, formatQueuedActivity } from './store.mjs'
import { batchDetail, isBatch, listBatches } from './map.mjs'
import { hint } from './problems.mjs'
import { windowLabel } from './quota.mjs'
import { statsText } from './stats.mjs'
import { credentialValue } from './credential-source.mjs'
import { proxyConfig } from './credential-proxy.mjs'
import { formatDateTime, resolvedTimeZone } from './time.mjs'
import { home, repo } from './paths.mjs'

const CONFIG_COMMANDS = new Set(['defaults', 'note', 'set', 'allow', 'deny', 'rules', 'hide', 'unhide', 'audit', 'undo'])
const TICKET_STATUSES = new Set(['queued', 'working', 'review', 'done', 'active'])

let jsonPrinted = false
function printJson(value) {
  jsonPrinted = true
  console.log(JSON.stringify(value))
}

function versionInfo() {
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
  let commit = null
  if (existsSync(join(repo, '.git'))) {
    try {
      commit = execFileSync('git', ['-C', repo, 'rev-parse', '--short', 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000
      }).trim() || null
    } catch { commit = null }
  }
  return { version: pkg.version, commit }
}

function table(store) {
  const rows = store.list()
  function seconds(r) {
    return r.started ? Math.max(0, Math.floor(((r.finished ?? Date.now()) - r.started) / 1000)) : 0
  }
  return ['NAME\tMODEL\tDIRECTORY\tSTATUS\tTURN\tELAPSED\tACTIVITY', ...rows.map(r =>
    [r.name, r.model, r.cwd, r.status, r.turn, seconds(r) + 's', r.activity].join('\t'))].join('\n')
}

function problemLine(problem) {
  const text = hint(problem)
  return text ? 'Problem: ' + problem.class + ' · ' + text : null
}

function spentLine(quota) {
  if (!quota?.spent?.length) return null
  return 'Quota spent this turn: ' + quota.spent.map(s => windowLabel(s.minutes) + ' ' + s.percent + '%').join(' · ')
}

function convo(store, name) {
  const c = store.byName(name)
  if (!c) throw new Error('Unknown conversation: ' + name)
  return c
}

function formatBatchText(detail, { full = false } = {}) {
  const c = detail.counts
  const header = 'Batch ' + detail.prefix + ' · ' + detail.count + ' shards (' +
    ['queued=' + c.queued, 'working=' + c.working, 'review=' + c.review, 'done=' + c.done, 'error=' + c.error, 'stopped=' + c.stopped].join(', ') + ')' +
    (detail.shards.length !== detail.count ? ' [showing ' + detail.shards.length + ']' : '')
  const rows = detail.shards.map(s => {
    const body = full && s.reply ? s.reply.replace(/\s+/g, ' ').trim() : null
    const summary = body ?? s.replyPreview ?? (s.problem ? s.problem.class + ': ' + s.problem.message : s.activity)
    return [s.name, s.status, s.turn, s.input, summary].join('\t')
  })
  return [header, 'SHARD\tSTATUS\tTURN\tINPUT\tSUMMARY', ...rows].join('\n')
}

function formatStatusText(status) {
  const r = status.runner
  const runnerLine = r.online
    ? (r.incompatible
        ? 'Runner: online (pid ' + r.pid + ', incompatible protocol ' + r.protocol + '; run broco shutdown to upgrade)'
        : 'Runner: online (pid ' + r.pid + ', protocol ' + r.protocol + ', up ' + r.uptimeSec + 's' + (r.startedLocal ? ', since ' + r.startedLocal : '') + ')')
    : 'Runner: offline' + (r.lastStopReason ? ' · last stop: ' + r.lastStopReason : '')
  const lines = [
    runnerLine,
    r.webUrl ? 'Board: ' + r.webUrl : null,
    r.activeProxies ? 'Credential proxies: ' + r.activeProxies + ' active' : null
  ]
  const p = status.project
  if (p) {
    const c = p.counts ?? { queued: 0, working: 0, review: 0, done: 0 }
    lines.push(
      'Project: ' + p.name + ' (' + p.repoPath + ')' + (p.implicit ? ' [L0]' : '') + ' · bro=' + (p.worker || 'none') + ' · concurrency=' + p.concurrency,
      'Tickets: running=' + (p.runningCount ?? 0) + ', queued=' + c.queued + ', review=' + c.review + ', done=' + c.done +
        (p.errorCount ? ', error=' + p.errorCount : '') + (p.stoppedCount ? ', stopped=' + p.stoppedCount : '') +
        (p.activeNames?.length ? ' · active: ' + p.activeNames.join(', ') : ''),
      p.activeBatches?.length ? 'Active batches: ' + p.activeBatches.map(b => b.prefix + ' (' + (b.counts.done + b.counts.review) + '/' + b.count + ')').join(', ') : null,
      p.retainedWorktrees ? 'Worktrees: ' + p.retainedWorktrees + ' retained (' + p.cleanableWorktrees + ' cleanable with broco clean)' : null
    )
  } else {
    lines.push('Project: unregistered directory (' + status.totals.projects + ' registered projects; running=' + status.totals.running + ', queued=' + status.totals.queued + ', review=' + status.totals.review + ')')
  }
  if (status.projects?.length > 1 || (!p && status.projects?.length)) {
    lines.push(
      'PROJECTS\tCONCURRENCY\tRUNNING\tQUEUED\tREVIEW\tDONE\tATTENTION',
      ...status.projects.map(s => [s.name, s.concurrency, s.runningCount ?? 0, s.counts.queued, s.counts.review, s.counts.done, s.attention].join('\t'))
    )
  }
  return lines.filter(Boolean).join('\n')
}

function offlineStatus(targetCwd, probe, all) {
  const regPath = join(home, 'registry-v2.sqlite')
  if (!existsSync(regPath)) {
    return {
      runner: {
        online: probe.online,
        compatible: !probe.incompatible,
        ...(probe.incompatible ? { incompatible: true } : {}),
        ...(probe.legacySocket ? { legacySocket: true } : {}),
        pid: probe.runner?.pid ?? null,
        protocol: probe.runner?.protocol ?? null,
        startedAt: null,
        startedLocal: null,
        uptimeSec: 0,
        lastStopReason: null,
        webUrl: null,
        activeProxies: 0,
        proxies: []
      },
      project: null,
      projects: [],
      totals: { projects: 0, running: 0, queued: 0, review: 0, done: 0, attention: 0 }
    }
  }
  const db = openDatabase(regPath, { readOnly: true })
  try {
    const hasTable = name => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))
    const rs = hasTable('runner_state') ? (db.prepare('SELECT * FROM runner_state WHERE id=1').get() ?? null) : null
    const rawProjects = hasTable('projects') ? db.prepare('SELECT * FROM projects ORDER BY created').all() : []
    const settingsMap = new Map()
    if (hasTable('roster_settings')) {
      for (const row of db.prepare('SELECT scope, data FROM roster_settings').all()) {
        settingsMap.set(row.scope, JSON.parse(row.data))
      }
    }
    const globalCfg = settingsMap.get('global') ?? {}
    const envConc = Number.isSafeInteger(Number(process.env.BROCO_CONCURRENCY ?? 3)) && Number(process.env.BROCO_CONCURRENCY ?? 3) >= 1
      ? Number(process.env.BROCO_CONCURRENCY ?? 3)
      : 3

    const inspectProject = row => {
      const local = settingsMap.get(row.id) ?? {}
      const allow = local.inheritPolicy ? (globalCfg.allow ?? []) : JSON.parse(row.allow || '[]')
      const worker = local.inheritPolicy ? (globalCfg.worker ?? '') : (row.worker ?? '')
      const concurrency = local.concurrency ?? row.concurrency ?? globalCfg.concurrency ?? envConc
      const counts = { queued: 0, working: 0, review: 0, done: 0 }
      let attention = 0, runningCount = 0, errorCount = 0, stoppedCount = 0, updated = row.created
      let activeNames = [], queuedNames = [], batches = [], retainedWorktrees = 0, cleanableWorktrees = 0
      const tPath = join(home, 'projects', row.id, 'tickets.sqlite')
      if (existsSync(tPath)) {
        const store = new Store(true, tPath)
        try {
          for (const r of store.stmt('SELECT stage,flag,count(*) AS n,max(updated) AS updated FROM tickets GROUP BY stage,flag').all()) {
            counts[r.stage] += r.n
            if (r.stage === 'working' && !r.flag) runningCount += r.n
            if (r.flag === 'error') errorCount += r.n
            if (r.flag === 'stopped') stoppedCount += r.n
            if (r.flag || r.stage === 'review') attention += r.n
            updated = Math.max(updated, r.updated)
          }
          activeNames = store.stmt("SELECT name FROM conversations WHERE status='running' ORDER BY name").all().map(r => r.name)
          queuedNames = store.stmt("SELECT c.name FROM conversations c LEFT JOIN turns r ON r.cid=c.id AND r.turn=c.turn WHERE c.status='queued' ORDER BY r.started ASC, r.rowid ASC, c.rowid ASC").all().map(r => r.name)
          batches = listBatches(store).map(b => ({ prefix: b.prefix, title: b.title, count: b.count, counts: b.counts, finished: b.finished }))
          for (const wr of store.stmt('SELECT m.worktree, t.stage FROM collaboration m JOIN tickets t ON t.cid=m.cid WHERE m.worktree IS NOT NULL').all()) {
            if (existsSync(wr.worktree)) {
              retainedWorktrees += 1
              if (wr.stage === 'done') cleanableWorktrees += 1
            }
          }
        } finally { store.db.close() }
      }
      const summary = {
        id: row.id,
        name: row.name,
        repoPath: row.repoPath,
        implicit: Boolean(row.implicit),
        allow,
        worker,
        concurrency,
        counts,
        runningCount,
        attention,
        updatedAt: new Date(updated).toISOString()
      }
      const detailed = {
        ...summary,
        errorCount,
        stoppedCount,
        activeNames,
        queuedNames,
        batches,
        activeBatches: batches.filter(b => !b.finished),
        retainedWorktrees,
        cleanableWorktrees
      }
      return { summary, detailed }
    }

    const inspected = rawProjects.map(inspectProject)
    const byId = new Map(inspected.map(x => [x.summary.id, x]))
    let resolvedId = null
    if (targetCwd && existsSync(targetCwd)) {
      const real = realpathSync.native(targetCwd)
      for (let root = real; ; root = dirname(root)) {
        const marker = [join(root, '.broco', 'project-id'), join(root, '.cc-bro', 'project-id')]
          .find(p => lstatSync(p, { throwIfNoEntry: false })?.isFile())
        if (marker) {
          const candidate = readFileSync(marker, 'utf8').trim()
          if (byId.has(candidate)) { resolvedId = candidate; break }
        }
        if (dirname(root) === root) break
      }
      if (!resolvedId) {
        const norm = p => process.platform === 'win32' ? p.toLowerCase() : p
        const realNorm = norm(real)
        const prefixMatch = rawProjects
          .filter(p => realNorm === norm(p.repoPath) || realNorm.startsWith(norm(p.repoPath) + sep))
          .sort((a, b) => b.repoPath.length - a.repoPath.length)[0]
        if (prefixMatch) resolvedId = prefixMatch.id
      }
    }
    const summaries = inspected.map(x => x.summary)
    return {
      runner: {
        online: probe.online,
        compatible: !probe.incompatible,
        ...(probe.incompatible ? { incompatible: true } : {}),
        ...(probe.legacySocket ? { legacySocket: true } : {}),
        pid: probe.runner?.pid ?? null,
        protocol: probe.runner?.protocol ?? null,
        startedAt: rs?.started ? new Date(rs.started).toISOString() : null,
        startedLocal: rs?.started ? formatDateTime(rs.started) : null,
        uptimeSec: 0,
        lastStopReason: rs?.stop_reason ?? null,
        webUrl: null,
        activeProxies: 0,
        proxies: []
      },
      project: resolvedId ? byId.get(resolvedId).detailed : null,
      projects: all ? inspected.map(x => x.detailed) : summaries,
      totals: {
        projects: summaries.length,
        running: summaries.reduce((n, s) => n + s.runningCount, 0),
        queued: summaries.reduce((n, s) => n + s.counts.queued, 0),
        review: summaries.reduce((n, s) => n + s.counts.review, 0),
        done: summaries.reduce((n, s) => n + s.counts.done, 0),
        attention: summaries.reduce((n, s) => n + s.attention, 0)
      }
    }
  } finally {
    db.close()
  }
}

function readTextSource(pathOrDash, labelName) {
  if (pathOrDash === '-') return readFileSync(0, 'utf8')
  const file = resolve(expandHome(pathOrDash))
  if (!existsSync(file) || !statSync(file).isFile()) throw new Error(labelName + ' file not found: ' + pathOrDash)
  return readFileSync(file, 'utf8')
}

function readSayText(argument, opt) {
  if (opt.file !== undefined && opt['brief-file'] !== undefined) {
    throw new Error('Specify either --file or --brief-file, not both')
  }
  const fileOpt = opt.file ?? opt['brief-file']
  if (fileOpt !== undefined && argument !== undefined) {
    throw new Error('Specify either <message> or --file, not both')
  }
  if (fileOpt !== undefined) return readTextSource(fileOpt, 'Prompt')
  if (argument === '-') return readFileSync(0, 'utf8')
  if (argument !== undefined) return argument
  if (!process.stdin.isTTY) {
    try {
      const piped = readFileSync(0, 'utf8')
      if (piped.trim()) return piped
    } catch {}
  }
  throw new Error('Supply <message>, --file <path>, or pipe prompt text via stdin')
}

function collectMapInputs(opt, trailing) {
  const raw = []
  for (const item of opt.input ?? []) raw.push(item)
  if (opt['inputs-file'] !== undefined) {
    const content = readTextSource(opt['inputs-file'], 'Inputs')
    const trimmed = content.trim()
    if (trimmed.startsWith('[')) {
      const parsed = JSON.parse(trimmed)
      if (!Array.isArray(parsed)) throw new Error('Expected JSON array in --inputs-file')
      for (const item of parsed) raw.push(String(item))
    } else {
      for (const line of content.split(/\r?\n/).map(s => s.trim()).filter(Boolean)) raw.push(line)
    }
  }
  for (const group of opt.inputs ?? []) {
    const expandedGroup = expandHome(group)
    if (group.includes(',') && !existsSync(resolve(expandedGroup))) {
      for (const part of group.split(',').map(s => s.trim()).filter(Boolean)) raw.push(part)
    } else {
      raw.push(group)
    }
  }
  for (const item of trailing) raw.push(item)
  if (!raw.length) throw new Error('Expected at least one shard input (pass [inputs...], --inputs, --input, or --inputs-file)')
  return raw.map(item => {
    const abs = resolve(expandHome(item))
    return existsSync(abs) ? abs : item
  })
}

function readMapBrief(opt) {
  if (opt.brief !== undefined && opt['brief-file'] !== undefined) {
    throw new Error('Specify either --brief or --brief-file, not both')
  }
  if (opt['brief-file'] !== undefined) {
    return readTextSource(opt['brief-file'], 'Brief')
  }
  if (opt.brief !== undefined) {
    const trimmed = opt.brief.trim()
    const candidate = resolve(expandHome(trimmed))
    if (/^\S+\.(?:md|txt|prompt)$/i.test(trimmed)) {
      if (!existsSync(candidate) || !statSync(candidate).isFile()) {
        throw new Error('Brief file not found: ' + opt.brief)
      }
      return readFileSync(candidate, 'utf8')
    }
    return opt.brief
  }
  throw new Error('Supply --brief or --brief-file')
}

async function recoverIfDead(runner) {
  try { process.kill(runner.pid, 0); return runner }
  catch (err) {
    if (err.code !== 'ESRCH') throw err
    return ready()
  }
}

async function waitRemote(projectId, payload, runner) {
  for (;;) {
    try {
      const res = await call('/wait', { projectId, ...payload, timeoutMs: 25000 })
      if (res && res.waiting) {
        runner = await recoverIfDead(runner)
        continue
      }
      return res
    } catch (err) {
      if (['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT'].includes(err.code) || /Runner is shutting down/.test(err.message)) {
        runner = await recoverIfDead(runner)
        await sleep(60)
        continue
      }
      throw err
    }
  }
}

async function watch(store, runner) {
  const initial = store.transaction(() => ({
    cursor: store.stmt('SELECT coalesce(max(id),0) AS id FROM events').get().id,
    board: table(store)
  }))
  let cursor = initial.cursor
  console.log(initial.board)
  for (;;) {
    await sleep(140)
    const batch = store.stmt('SELECT e.id,c.name,e.turn,e.summary FROM events e JOIN conversations c ON e.cid=c.id WHERE e.id>? ORDER BY e.id LIMIT 512').all(cursor)
    if (!batch.length) {
      if (store.stmt("SELECT 1 FROM conversations WHERE status='running' LIMIT 1").get()) runner = await recoverIfDead(runner)
      continue
    }
    cursor = batch.at(-1).id
    const events = batch.filter(e => e.summary)
    if (!events.length) continue
    if (process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[H' + table(store) + '\n\n')
    for (const e of events) console.log(e.name + ' #' + e.turn + '  ' + e.summary)
  }
}

function auditSuffix(res) {
  return ' (audit #' + res.auditId + '; undo: broco undo ' + res.auditId + ')'
}

async function runSetup(opt) {
  let migration
  if (opt['migrate-cc-bro']) {
    migration = await migrateLegacyCcBro()
  } else {
    migration = detectLegacyMigration()
  }

  const install = setupInfo()
  const detected = await probeSetupWorkers({ cwd: process.cwd() })
  const existing = readGlobalPolicy()
  const loggedInIds = detected.filter(w => w.loggedIn).map(w => w.id)

  if (!opt.json) {
    console.log('Skills installed:')
    for (const h of install.hosts) {
      console.log('  - ' + h.id + ': ' + h.skillPath)
    }
    console.log('Launcher: ' + install.launcher)
    if (migration.migrated) {
      console.log('Migrated legacy data from ' + migration.legacyDir + ' -> ' + migration.targetDir + ' (original preserved)')
    }
    console.log('')
    console.log('Detected CLIs & live quota:')
    console.log(formatSetupRoster(detected, existing.allow, existing.defaultWorker))
  }

  let allowlist = {
    configured: existing.configured,
    changed: false,
    confirmedBy: null,
    allow: existing.allow,
    defaultWorker: existing.defaultWorker,
    recommended: loggedInIds,
    hint: null
  }

  if (opt.allow !== undefined) {
    const saved = await saveGlobalAllowlist(opt.allow, { defaultWorker: opt['default-worker'] })
    allowlist = {
      configured: true,
      changed: true,
      confirmedBy: 'flag',
      allow: saved.allow,
      defaultWorker: saved.defaultWorker,
      auditId: saved.auditId,
      recommended: loggedInIds,
      hint: null
    }
  } else if (opt.yes) {
    if (loggedInIds.length) {
      const saved = await saveGlobalAllowlist(loggedInIds, { defaultWorker: opt['default-worker'] })
      allowlist = {
        configured: true,
        changed: true,
        confirmedBy: 'yes',
        allow: saved.allow,
        defaultWorker: saved.defaultWorker,
        auditId: saved.auditId,
        recommended: loggedInIds,
        hint: null
      }
    } else {
      allowlist.hint = 'No logged-in worker CLIs detected. Sign in to a CLI and run broco allow <ids> --global.'
    }
  } else if (process.stdin.isTTY && !opt.json) {
    const recommended = existing.configured ? existing.allow : loggedInIds
    if (recommended.length) {
      const reader = createInterface({ input: process.stdin, output: process.stderr })
      let answer
      try {
        answer = (await reader.question('\nAllow global workers [' + recommended.join(',') + ']? Press Enter to confirm, enter comma-separated IDs, or type "skip": ')).trim()
      } finally {
        reader.close()
      }
      if (/^(?:skip|none|n|no)$/i.test(answer)) {
        if (!existing.configured) {
          allowlist.hint = 'Global allowlist not set. Run: broco allow ' + recommended.join(',') + ' --global'
        }
      } else {
        const chosen = answer ? answer : recommended
        const saved = await saveGlobalAllowlist(chosen, { defaultWorker: opt['default-worker'] })
        allowlist = {
          configured: true,
          changed: true,
          confirmedBy: 'prompt',
          allow: saved.allow,
          defaultWorker: saved.defaultWorker,
          auditId: saved.auditId,
          recommended: loggedInIds,
          hint: null
        }
      }
    } else if (!existing.configured) {
      allowlist.hint = 'No logged-in worker CLIs detected. Sign in to a CLI and run broco allow <ids> --global.'
    }
  } else if (!existing.configured) {
    const suggested = loggedInIds.length ? loggedInIds.join(',') : '<ids>'
    allowlist.hint = 'Global allowlist is not configured yet (never auto-enabled without confirmation). Run: broco allow ' + suggested + ' --global (or broco setup --allow ' + suggested + ' / broco setup --yes)'
  }

  const out = {
    ...install,
    detected,
    allowlist,
    migration,
    firstRunPrompt: FIRST_RUN_PROMPT
  }
  if (opt.json) return printJson(out)

  console.log('')
  if (allowlist.configured) {
    console.log('Global allowlist: ' + allowlist.allow.join(', ') + ' (default: ' + allowlist.defaultWorker + ')' + (allowlist.changed ? ' [saved]' : ' [unchanged]'))
  } else if (allowlist.hint) {
    console.log(allowlist.hint)
  }
  if (migration.available) {
    console.log('Legacy ~/.cc-bro data detected at ' + migration.legacyDir + '. Run `broco setup --migrate-cc-bro` to copy it safely without deleting ~/.cc-bro.')
  }
  console.log('')
  console.log('Try asking your coding agent:')
  console.log('  "' + FIRST_RUN_PROMPT + '"')
}

async function main() {
  const { cmd, opt, positionals, help } = parseCommand(process.argv.slice(2))
  if (help) return console.log(help)
  if (cmd === 'version') {
    const info = versionInfo()
    return opt.json ? printJson(info) : console.log(info.commit ? info.version + ' (' + info.commit + ')' : info.version)
  }
  if (cmd === 'setup') {
    return runSetup(opt)
  }
  if (['say', 'review', 'map', 'retry'].includes(cmd) && process.env.BROCO_IN_WORKER === '1' && !opt['allow-nested']) {
    throw new Error('Refusing nested broco ' + cmd + ' inside a worker session (BROCO_IN_WORKER=1). Return your result to the caller instead, or pass --allow-nested to override explicitly.')
  }
  if (opt.cwd !== undefined && opt.worktree) throw new Error('--cwd cannot be combined with --worktree')
  if (opt.global && opt.project !== undefined) throw new Error('--global cannot be combined with --project')
  if (cmd === 'audit' && opt.all && (opt.global || opt.project !== undefined)) {
    throw new Error('--all cannot be combined with --global or --project')
  }
  const projectPath = directoryOption(opt.project, '--project')
  const cwd = directoryOption(opt.cwd, '--cwd')
  const [name, argument] = positionals

  if (cmd === 'status') {
    const targetCwd = projectPath ?? process.cwd()
    const probe = await probeReady()
    const status = probe.online && !probe.incompatible
      ? await call('/status', { cwd: targetCwd, all: !!opt.all })
      : offlineStatus(targetCwd, probe, !!opt.all)
    return opt.json ? printJson(status) : console.log(formatStatusText(status))
  }

  if (cmd === 'set' && !['concurrency', 'default-worker'].includes(name)) {
    throw new Error('Unsupported setting key: ' + name + ' (expected concurrency or default-worker)')
  }
  if (cmd === 'note') {
    if (!opt.clear && argument === undefined) throw new Error('Supply note text or --clear')
    if (opt.clear && argument !== undefined) throw new Error('Cannot combine note text with --clear')
    if (!opt.clear && !argument.trim()) throw new Error('Note is empty; pass --clear to clear')
  }
  let sayText
  if (cmd === 'say') {
    sayText = readSayText(argument, opt)
  }
  let mapBrief, mapInputs
  if (cmd === 'map') {
    mapBrief = readMapBrief(opt)
    mapInputs = collectMapInputs(opt, positionals.slice(1))
  }
  if (cmd === 'shutdown') {
    if (!opt.json) console.error(shutdownEffect)
    await shutdown()
    return opt.json ? printJson({ status: 'offline' }) : console.log('Runner stopped')
  }
  let proxyInput
  if (cmd === 'proxy-open') {
    proxyInput = { upstream: opt.upstream, paths: opt.path, header: opt.header, valuePrefix: opt['value-prefix'], maxRequests: opt['max-requests'], ttl: opt.ttl }
    proxyConfig(proxyInput)
    proxyInput.value = await credentialValue(opt)
  }
  const runner = await ready()
  if (['proxy-open', 'proxy-list', 'proxy-close'].includes(cmd)) {
    if (!runner.credentialProxy) throw new Error('This runner does not support credential proxies. Run broco shutdown after finishing active work, then retry.')
    const reply = await call('/' + cmd, proxyInput || (cmd === 'proxy-close' ? { id: name } : {}))
    if (opt.json) return printJson(reply)
    if (cmd === 'proxy-close') return console.log(reply.id + ' closed')
    const rows = cmd === 'proxy-open' ? [reply] : reply
    return console.log(['ID\tURL\tREQUESTS\tEXPIRES (' + resolvedTimeZone() + ')', ...rows.map(r => [r.id, r.url,
      r.requests + '/' + r.maxRequests, formatDateTime(r.expiresAt)].join('\t'))].join('\n'))
  }
  if (cmd === 'init') {
    const skipAgentsMd = Boolean(opt['no-agents-md'] || opt['no-claude-md'])
    const input = {
      cwd: projectPath ?? process.cwd(),
      allow: opt.allow,
      worker: opt['default-worker'],
      concurrency: opt.concurrency,
      agentsMd: !skipAgentsMd,
      claudeMd: !skipAgentsMd,
      host: opt.host,
      managerMode: !!opt['manager-mode']
    }
    let p
    for (;;) {
      try { p = await call('/register', input); break } catch (err) {
        if (!process.stdin.isTTY || ![chooseAllow, chooseDefault].includes(err.message)) throw err
        const reader = createInterface({ input: process.stdin, output: process.stderr })
        try {
          if (err.message === chooseAllow) input.allow = await reader.question('Allowed workers (claude, codex, agy, cursor-agent, pi:<provider>, custom:<name>; comma-separated): ')
          else input.worker = await reader.question('Default worker from the allowed list: ')
        } finally { reader.close() }
      }
    }
    if (opt.json) return printJson(p)
    const doc = p.agentsMd ?? p.claudeMd
    const lines = [
      p.name + ': ' + p.allow.join(', ') + ' (default: ' + p.worker + ', concurrency: ' + p.concurrency + ')',
      doc ? (doc.file || 'AGENTS.md') + ': ' + doc.action + ' (' + doc.path + ')' : null
    ].filter(Boolean)
    return console.log(lines.join('\n'))
  }
  if (cmd === 'uninit') {
    const skipAgentsMd = Boolean(opt['no-agents-md'] || opt['no-claude-md'])
    const res = await call('/unregister', { cwd: projectPath ?? process.cwd(), agentsMd: !skipAgentsMd, claudeMd: !skipAgentsMd, host: opt.host })
    if (opt.json) return printJson(res)
    const doc = res.agentsMd ?? res.claudeMd
    const lines = [
      res.unregistered ? 'Unregistered project at ' + res.repoPath : 'No registered project at ' + res.repoPath,
      res.markerRemoved ? 'Removed .broco marker' : null,
      doc ? (doc.file || 'AGENTS.md') + ': ' + doc.action + ' (' + doc.path + ')' : null
    ].filter(Boolean)
    return console.log(lines.join('\n'))
  }
  if (cmd === 'ui') {
    const { url } = await call('/ui', {})
    if (!opt['no-open']) await platform.openBrowser(url)
    return opt.json ? printJson({ url }) : console.log(url)
  }
  if (CONFIG_COMMANDS.has(cmd)) {
    const readOnlyConfig = cmd === 'audit' || (cmd === 'rules' && !(opt.add?.length || opt.rm?.length || opt.clear || opt.override)) || cmd === 'undo'
    let scope
    if (cmd === 'audit' && opt.all) scope = 'all'
    else if (opt.global) scope = 'global'
    else if (cmd === 'undo' && name !== undefined && opt.project === undefined) scope = null
    else if (readOnlyConfig) {
      const ctx = await call('/context', { cwd: projectPath ?? process.cwd(), createImplicit: false, optional: true })
      scope = ctx.projectId ?? null
    } else scope = (await call('/context', { cwd: projectPath ?? process.cwd() })).projectId

    if (cmd === 'defaults') {
      const res = await call('/defaults-set', { scope, worker: name, model: opt.model, effort: opt.effort, clear: !!opt.clear })
      if (opt.json) return printJson(res)
      return console.log(res.summary + ' · effective model=' + (res.defaults.model || 'CLI default') + ', effort=' + (res.defaults.effort || 'CLI default') + auditSuffix(res))
    }
    if (cmd === 'note') {
      const res = await call('/note-set', { scope, worker: name, note: opt.clear ? '' : argument })
      return opt.json ? printJson(res) : console.log(res.summary + auditSuffix(res))
    }
    if (cmd === 'set') {
      if (name === 'concurrency') {
        const res = await call('/concurrency-set', { scope, concurrency: argument })
        return opt.json ? printJson(res) : console.log(res.summary + ' · effective concurrency=' + res.concurrency + auditSuffix(res))
      }
      const res = await call('/allow-set', { scope, defaultWorker: argument })
      return opt.json ? printJson(res) : console.log(res.summary + auditSuffix(res))
    }
    if (cmd === 'allow') {
      const workers = name.split(',').map(s => s.trim()).filter(Boolean)
      if (!workers.length) throw new Error('Specify at least one worker')
      const res = await call('/allow-set', { scope, add: workers, defaultWorker: opt['default-worker'] })
      return opt.json ? printJson(res) : console.log(res.summary + auditSuffix(res))
    }
    if (cmd === 'deny') {
      const workers = name.split(',').map(s => s.trim()).filter(Boolean)
      if (!workers.length) throw new Error('Specify at least one worker')
      const res = await call('/allow-set', { scope, remove: workers })
      return opt.json ? printJson(res) : console.log(res.summary + auditSuffix(res))
    }
    if (cmd === 'rules') {
      const mutating = Boolean(opt.add?.length || opt.rm?.length || opt.clear || opt.override)
      if (!mutating) {
        const res = await call('/rules-get', { scope: scope ?? 'global', worker: opt.worker ?? null })
        if (opt.json) return printJson(res)
        if (opt.worker) {
          return console.log(res.workerRules.length ? res.workerRules.map(r => 'Rule (' + opt.worker + '): ' + r).join('\n') : 'No active rules for ' + opt.worker)
        }
        const lines = [
          ...res.rules.map(r => 'Rule: ' + r),
          ...Object.entries(res.workerRules ?? {}).flatMap(([w, list]) => list.map(r => 'Rule (' + w + '): ' + r))
        ]
        return console.log(lines.length ? lines.join('\n') : 'No active rules')
      }
      const res = await call('/rules-set', {
        scope,
        add: opt.add ?? [],
        remove: opt.rm ?? [],
        clear: !!opt.clear,
        worker: opt.worker ?? null,
        ...(opt.override ? { rulesOverride: true } : opt.clear ? { rulesOverride: false } : {})
      })
      return opt.json ? printJson(res) : console.log(res.summary + auditSuffix(res))
    }
    if (cmd === 'hide' || cmd === 'unhide') {
      const models = argument.split(',').map(s => s.trim()).filter(Boolean)
      if (!models.length) throw new Error('Specify at least one model ID or family')
      const res = await call('/hidden-models-set', {
        scope,
        worker: name,
        ...(cmd === 'hide' ? { hide: models } : { unhide: models })
      })
      return opt.json ? printJson(res) : console.log(res.summary + auditSuffix(res))
    }
    if (cmd === 'audit') {
      let limit = 30
      if (opt.limit !== undefined) {
        if (!/^\d+$/.test(opt.limit) || Number(opt.limit) < 1 || Number(opt.limit) > 500) {
          throw new Error('Expected --limit between 1 and 500')
        }
        limit = Number(opt.limit)
      }
      const rows = scope === null ? [] : await call('/audit-list', { scope, limit })
      if (opt.json) return printJson(rows)
      return console.log([
        'ID\tTIME (' + resolvedTimeZone() + ')\tSCOPE\tACTOR\tACTION\tSTATUS\tSUMMARY',
        ...rows.map(r => ['#' + r.id, r.atLocal ?? r.atAsia, r.scopeName || r.scope, r.actor, r.action, r.revertedAt ? 'reverted' : 'active', r.summary].join('\t'))
      ].join('\n'))
    }
    if (cmd === 'undo') {
      let auditId = null
      if (name !== undefined) {
        if (!/^\d+$/.test(name) || Number(name) < 1) throw new Error('Expected a positive integer audit ID')
        auditId = Number(name)
      } else if (scope === null) {
        throw new Error('Nothing to undo for this directory')
      }
      const res = await call('/audit-undo', { id: auditId, scope, actor: 'agent' })
      return opt.json ? printJson(res) : console.log(res.summary + ' (audit #' + res.auditId + ')')
    }
  }

  if (cmd === 'stats') {
    if (opt.project !== undefined) {
      const ctx = await call('/context', { cwd: projectPath, createImplicit: false, optional: true })
      if (!ctx.projectId) return opt.json ? printJson([]) : console.log(statsText([]))
      const groups = await call('/stats', { projectId: ctx.projectId })
      return opt.json ? printJson(groups) : console.log(statsText(groups))
    }
    const groups = await call('/stats', {})
    return opt.json ? printJson(groups) : console.log(statsText(groups))
  }

  if (cmd === 'roster') {
    if (opt.global) {
      const roster = rosterOutput(await call('/roster', { global: true, refresh: !!opt.refresh }), { full: opt.full, worker: opt.worker })
      return opt.json ? printJson(roster) : console.log(rosterText(roster))
    }
    const ctx = await call('/context', { cwd: projectPath ?? process.cwd(), createImplicit: false, optional: true })
    if (!ctx.projectId) {
      if (!ctx.globalConfigured) {
        throw new Error('Project is not registered and no global worker allowlist is configured. Run broco setup, broco allow <workers> --global, or broco init in the project root (or pass --global to inspect detected CLIs).')
      }
      const roster = rosterOutput(await call('/roster', { global: true, refresh: !!opt.refresh }), { full: opt.full, worker: opt.worker })
      return opt.json ? printJson(roster) : console.log(rosterText(roster))
    }
    const roster = rosterOutput(await call('/roster', { projectId: ctx.projectId, refresh: !!opt.refresh }), { full: opt.full, worker: opt.worker })
    return opt.json ? printJson(roster) : console.log(rosterText(roster))
  }

  const needsCreate = cmd === 'say' || cmd === 'map'
  const context = await call('/context', {
    cwd: projectPath ?? process.cwd(),
    ...(needsCreate ? {} : { createImplicit: false, optional: true })
  })
  if (!context.projectId) {
    if (!context.globalConfigured) {
      throw new Error('Project is not registered and no global worker allowlist is configured. Run broco setup, broco allow <workers> --global, or broco init in the project root.')
    }
    if (cmd === 'ls') {
      return opt.json ? printJson([]) : console.log('TICKET\tTITLE\tSTATUS\tFLAG\tMODEL\tACTIVITY')
    }
    if (cmd === 'clean') {
      const empty = { cleaned: [], skipped: [], attachments: { removed: 0, freedBytes: 0, files: [] } }
      return opt.json ? printJson(empty) : console.log('Worktrees cleaned: 0, skipped: 0')
    }
    if (cmd === 'watch') {
      throw new Error('No tickets in this directory yet. Dispatch a ticket with broco say or broco map first.')
    }
    throw new Error('Unknown conversation: ' + name)
  }
  const { projectId, database, defaultCwd } = context

  if (cmd === 'diff') {
    const res = await call('/diff', { projectId, name, statOnly: !!opt.stat })
    if (opt.json) return printJson(res)
    return console.log((opt.stat ? res.stat : res.patch) || 'No changes')
  }

  if (cmd === 'clean') {
    const res = await call('/clean', {
      projectId,
      name: name ?? null,
      dryRun: !!opt['dry-run'],
      deleteBranch: !!opt['delete-branch'],
      force: !!opt.force
    })
    if (opt.json) return printJson(res)
    const header = (opt['dry-run'] ? '[dry-run] ' : '') + 'Worktrees cleaned: ' + res.cleaned.length + ', skipped: ' + res.skipped.length +
      (res.attachments?.removed ? ' · attachments removed: ' + res.attachments.removed : '')
    return console.log([
      header,
      ...res.cleaned.map(c => '  cleaned ' + c.name + ' (' + c.worktree + ')' + (c.branchDeleted ? ' [branch deleted]' : c.branchRetainedReason ? ' [' + c.branchRetainedReason + ']' : '')),
      ...res.skipped.map(s => '  skipped ' + s.name + ' (' + s.reason + ')')
    ].join('\n'))
  }

  if (cmd === 'ls' || cmd === 'show' || cmd === 'watch') {
    const store = new Store(true, database)
    try {
      if (cmd === 'ls') {
        let tickets = store.ticketRows()
        if (opt.active) tickets = tickets.filter(t => t.status !== 'done')
        if (opt.status !== undefined) {
          const requested = opt.status.split(',').map(s => s.trim()).filter(Boolean)
          if (!requested.length || requested.some(s => !TICKET_STATUSES.has(s))) {
            throw new Error('Expected --status from queued,working,review,done,active')
          }
          const allowed = new Set()
          for (const s of requested) {
            if (s === 'active') { allowed.add('queued'); allowed.add('working'); allowed.add('review') }
            else allowed.add(s)
          }
          tickets = tickets.filter(t => allowed.has(t.status))
        }
        if (opt.flag !== undefined) {
          const flags = new Set(opt.flag.split(',').map(s => s.trim()).filter(Boolean))
          tickets = tickets.filter(t => t.flag && flags.has(t.flag))
        }
        if (opt.batch !== undefined) {
          const prefix = opt.batch.trim()
          tickets = tickets.filter(t => t.batch?.prefix === prefix)
        }
        if (opt.limit !== undefined) {
          if (!/^\d+$/.test(opt.limit) || Number(opt.limit) < 1 || Number(opt.limit) > 1000) {
            throw new Error('Expected --limit between 1 and 1000')
          }
          tickets = tickets.slice(-Number(opt.limit))
        }
        return opt.json
          ? printJson(tickets)
          : console.log(['TICKET\tTITLE\tSTATUS\tFLAG\tMODEL\tACTIVITY', ...tickets.map(t =>
              [t.id, t.title, t.status, t.flag ? t.flag + (t.problem && t.flag === 'error' ? '/' + t.problem.class : '') : '-', t.model, t.activity].join('\t'))].join('\n'))
      }
      if (cmd === 'watch') return await watch(store, runner)
      if (cmd === 'show') {
        if (isBatch(store, name)) {
          const detail = batchDetail(store, name, { full: !!opt.full, status: opt.status ?? null })
          return opt.json ? printJson(detail) : console.log(formatBatchText(detail, { full: !!opt.full }))
        }
        const c = convo(store, name)
        if (opt.all) {
          const rows = store.history(c.id)
          const warning = store.contextWarning(c.id, c.turn)
          if (warning && !opt.json) console.error(warning.message)
          return opt.json ? printJson(rows) : console.log(rows.map(m =>
            '[' + m.turn + '] ' + m.kind + (m.number ? ' #' + m.number : '') + ': ' + m.content + (m.error ? ' [' + m.error + ']' : '')).join('\n'))
        }
        let targetTurn = c.turn
        if (opt.turn !== undefined) {
          targetTurn = Number(opt.turn)
          if (!Number.isSafeInteger(targetTurn) || targetTurn < 1) throw new Error('Expected a positive --turn number')
        }
        const result = store.result(c.id, targetTurn)
        const { lastReply, timeline, ...detailRest } = store.detail(name)
        const sessionWarning = c.turn >= 1 && !['running', 'queued'].includes(c.status) && !c.native_id
          ? 'No native session bound yet: use broco retry ' + name + ' (or resend the full prompt on say).'
          : null
        const out = {
          ...detailRest,
          ...(opt.compact ? { timelineCount: timeline.length } : { timeline }),
          name,
          provider: c.provider,
          session: c.native_id,
          transport: c.transport,
          ...(sessionWarning ? { sessionWarning } : {}),
          ...result
        }
        const stepInfo = c.status === 'running' && out.progress?.currentStep ? 'Current step: ' + out.progress.currentStep : null
        return opt.json ? printJson(out) : console.log([
          result.contextWarning?.message,
          sessionWarning,
          stepInfo,
          ...out.tasks.map(t => 'Task ' + t.task + ' · turns ' + t.startTurn + '–' + t.endTurn + ' · ' + t.title + ' · ' + (t.outcome ?? 'unrecorded') + (t.outcomeReason ? ': ' + t.outcomeReason : '')),
          problemLine(result.problem),
          result.reply ?? result.error ?? out.activity ?? c.activity,
          result.cachedInputTokens === null ? null : 'Cached input: ' + result.cachedInputTokens + ' tokens',
          spentLine(result.quota)
        ].filter(Boolean).join('\n'))
      }
    } finally { store.db.close() }
  }

  if (cmd === 'done') {
    const ticket = await call('/done', { name, projectId, result: opt.result, why: opt.why, task: opt.task === undefined ? undefined : Number(opt.task) })
    if (ticket.closed !== undefined) {
      return opt.json ? printJson(ticket) : console.log([
        'Batch ' + ticket.prefix + ': closed ' + ticket.closed.length + ', skipped ' + ticket.skipped.length,
        ...ticket.closed.map(s => '  ' + s.name + ' · ' + s.outcome + ' (task ' + s.task + ')'),
        ...ticket.skipped.map(s => '  ' + s.name + ' · skipped (' + s.reason + ')')
      ].join('\n'))
    }
    return opt.json ? printJson(ticket) : console.log([name + ' ' + (['fail', 'blocked'].includes(ticket.outcome) ? 'closed' : 'accepted') + ' · ' + ticket.outcome + (opt.result ? '' : ' (inferred; pass --result to record it explicitly)'), 'Task ' + ticket.task + ' · turns ' + ticket.startTurn + '–' + ticket.endTurn, ticket.cleanupHint].filter(Boolean).join('\n'))
  }

  if (cmd === 'stop') {
    const result = await call('/stop', { name, projectId })
    if (Array.isArray(result.stopped)) {
      return opt.json ? printJson(result) : console.log([
        'Batch ' + result.prefix + ': stopped ' + result.stopped.length + ', skipped ' + result.skipped.length,
        ...result.stopped.map(s => '  ' + s.name + ' stopped' + (s.forced ? ' (forced)' : ''))
      ].join('\n'))
    }
    return opt.json ? printJson(result) : console.log(name + ' stopped; processes verified' + (result.forced ? ' (forced)' : ''))
  }

  if (cmd === 'map') {
    const mapReceipt = await call('/map', {
      projectId,
      prefix: name,
      brief: mapBrief,
      inputs: mapInputs,
      worker: opt.worker,
      model: opt.model,
      effort: opt.effort,
      cwd,
      worktree: opt.worktree,
      title: opt.title,
      env: modelVariables(process.env)
    })
    const runningCount = mapReceipt.shards.filter(s => s.status === 'working').length
    const queuedCount = mapReceipt.shards.filter(s => s.status === 'queued').length
    const ack = mapReceipt.prefix + ' dispatched ' + mapReceipt.count + ' shards (' + runningCount + ' running, ' + queuedCount + ' queued)'
    if (opt.bg) {
      return opt.json ? printJson(mapReceipt) : console.log([
        ack,
        ...mapReceipt.shards.map(s => '  ' + s.name + '\t' + (s.queue ? formatQueuedActivity(s.queue) : s.status) + '\t' + s.worker + '/' + s.model + '\t' + s.input)
      ].join('\n'))
    }
    if (!opt.json) console.error(ack)
    const detail = await waitRemote(projectId, { name: mapReceipt.prefix }, runner)
    if (opt.json) printJson(detail)
    else console.log(formatBatchText(detail))
    if (detail.counts.error > 0 || detail.counts.stopped > 0) {
      throw new Error((detail.counts.error + detail.counts.stopped) + ' of ' + detail.count + ' shards failed or stopped in batch ' + detail.prefix)
    }
    return
  }

  let receipt
  if (cmd === 'say' || cmd === 'review' || cmd === 'retry') {
    if (cmd === 'review') {
      receipt = await call('/review', { name, by: opt.by || null, model: opt.model, effort: opt.effort, projectId, env: modelVariables(process.env) })
    } else if (cmd === 'retry') {
      receipt = await call('/retry', { name, model: opt.model, effort: opt.effort, worker: opt.worker, projectId, env: modelVariables(process.env) })
      if (receipt.isBatch) {
        const ack = 'Batch ' + receipt.prefix + ': retried ' + receipt.retried.length + ', skipped ' + receipt.skipped.length
        if (opt.bg || !receipt.retried.length) {
          return opt.json ? printJson(receipt) : console.log([
            ack,
            ...receipt.retried.map(s => '  ' + s.name + ' -> turn ' + s.turn + ' (' + s.worker + '/' + s.model + ')')
          ].join('\n'))
        }
        if (!opt.json) console.error(ack)
        const detail = await waitRemote(projectId, { name: receipt.prefix }, runner)
        if (opt.json) printJson(detail)
        else console.log(formatBatchText(detail))
        if (detail.counts.error > 0 || detail.counts.stopped > 0) {
          throw new Error((detail.counts.error + detail.counts.stopped) + ' of ' + detail.count + ' shards failed or stopped in batch ' + detail.prefix)
        }
        return
      }
    } else {
      receipt = await call('/say', {
        name,
        projectId,
        env: modelVariables(process.env),
        title: opt.title,
        from: opt.from,
        text: sayText,
        attachments: opt.attach?.map(p => resolve(expandHome(p))),
        model: opt.model,
        effort: opt.effort,
        worker: opt.worker,
        defaultCwd,
        cwd,
        worktree: opt.worktree,
        newTask: opt['new-task']
      })
    }
    const labels = { injected: '已注入 / injected', queued: '排到下一轮 / queued for next turn', rejected: '被拒 / rejected' }
    const statusLabel = labels[receipt.outcome] || (receipt.kind === 'queued' ? 'queued' : 'prompt accepted')
    const ack = [
      receipt.name + ' task ' + receipt.task + ' message #' + receipt.number + ', turn ' + receipt.turn + ' (' + statusLabel + ')' + (receipt.retriedTurn ? ' [retry of turn ' + receipt.retriedTurn + ']' : '') + (receipt.reason ? ': ' + receipt.reason : ''),
      receipt.worker + ' · ' + receipt.model + (receipt.effort ? ' · ' + receipt.effort : ''),
      receipt.queue ? formatQueuedActivity(receipt.queue) : null,
      receipt.note ? 'Note: ' + receipt.note : null,
      ...(receipt.reminders ?? []),
      receipt.sessionWarning && !receipt.reminders?.includes(receipt.sessionWarning) ? receipt.sessionWarning : null,
      receipt.contextWarning ? receipt.contextWarning.message : null
    ].filter(Boolean).join('\n')
    if (receipt.outcome === 'rejected') {
      process.exitCode = 1
      return opt.json ? printJson(receipt) : console.log(ack)
    }
    if (opt.bg) return opt.json ? printJson(receipt) : console.log(ack)
    if (!opt.json) console.error(ack)
  }

  let turnArg = null
  if (receipt?.turn !== undefined) {
    turnArg = receipt.turn
  } else if (argument !== undefined) {
    turnArg = Number(argument)
    if (!Number.isSafeInteger(turnArg) || turnArg < 1) throw new Error('Expected a positive turn number')
  }

  const waited = await waitRemote(projectId, {
    name: receipt?.name ?? name,
    ...(turnArg !== null ? { turn: turnArg } : {}),
    ...(receipt?.number ? { number: receipt.number } : {})
  }, runner)

  if (waited.isBatch) {
    if (opt.json) printJson(waited)
    else console.log(formatBatchText(waited))
    if (waited.counts.error > 0 || waited.counts.stopped > 0) {
      throw new Error((waited.counts.error + waited.counts.stopped) + ' of ' + waited.count + ' shards failed or stopped in batch ' + waited.prefix)
    }
    return
  }

  if (opt.json) printJson({ name, ...receipt, ...waited })
  else {
    if (waited.contextWarning) console.log(waited.contextWarning.message)
    if (waited.reply) console.log(waited.reply)
  }
  if (waited.status !== 'done') {
    throw new Error([problemLine(waited.problem), waited.error || waited.status].filter(Boolean).join('\n'))
  }
}

process.stdout.on('error', err => { if (err.code === 'EPIPE') process.exit(0); throw err })
const wantJsonError = process.argv.slice(2).includes('--json')
main().catch(err => {
  if (wantJsonError && !jsonPrinted) {
    console.log(JSON.stringify({ error: err.message }))
  }
  console.error(err.message)
  process.exitCode = 1
})

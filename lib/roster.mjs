import { createHash, randomUUID } from 'node:crypto'
import { accessSync, constants, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { cliActions, detectCli, discoverPi } from './detect.mjs'
import { executable, inspectCommand } from './cli-process.mjs'
import { hiddenModel, loadCatalog, matchModel, modelKey, modelCapabilities, staleDefaultWarning, visiblePicks } from './model-catalog.mjs'
import { home } from './paths.mjs'
import { tight } from './quota.mjs'
import { SettingsAudit } from './settings-audit.mjs'
import { supportedWorker } from './worker-policy.mjs'
import { presets, templateTurn, validateTemplate } from './templates.mjs'
import { summarize, ticketRecords } from './stats.mjs'
import { platform } from './platform/index.mjs'

const fingerprint = t => createHash('sha256').update(JSON.stringify(validateTemplate(t))).digest('hex')
const list = (v, labelName) => {
  if (!Array.isArray(v) || v.length > 100 || v.some(s => typeof s !== 'string' || s.length > 4000)) throw new Error('Invalid ' + labelName)
  return v
}
const label = v => {
  if (typeof v !== 'string' || v.length > 4000 || v.includes('\0')) throw new Error('Invalid text setting')
  return v
}
const envConcurrency = () => {
  const n = Number(process.env.BROCO_CONCURRENCY ?? 3)
  return Number.isSafeInteger(n) && n >= 1 ? n : 3
}
const parseConcurrency = v => {
  if (v === null || v === 'inherit' || v === 'default') return null
  const n = typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : v
  if (!Number.isSafeInteger(n) || n < 1 || n > 64) throw new Error('Concurrency must be an integer between 1 and 64 (or "inherit")')
  return n
}
const splitItems = (v, labelName) => {
  if (v === undefined || v === null) return []
  if (typeof v === 'string') return v.split(',').map(s => s.trim()).filter(Boolean)
  return list(v, labelName).map(s => s.trim()).filter(Boolean)
}
const stringItems = (v, labelName) => {
  if (v === undefined || v === null) return []
  if (typeof v === 'string') return v.trim() ? [label(v).trim()] : []
  return list(v, labelName).map(s => label(s).trim()).filter(Boolean)
}

function hasCli(name) {
  if (!name) return false
  if (executable(name)) return true
  for (const dir of (process.env.PATH || '').split(delimiter).filter(Boolean)) {
    const p = join(dir, name)
    try { accessSync(p, constants.X_OK); if (statSync(p).isFile()) return true } catch {}
  }
  return false
}

function stripRevision(raw) {
  const { revision, ...rest } = raw
  return structuredClone(rest)
}

function cleanEntry(entries, worker, hadEntry = false) {
  const cur = entries[worker]
  if (!cur) return
  for (const k of Object.keys(cur)) {
    if (cur[k] === undefined) delete cur[k]
  }
  if (!hadEntry && Object.keys(cur).length === 0) delete entries[worker]
}

export class Roster {
  constructor(projects) {
    this.projects = projects
    this.db = projects.db
    this.db.exec('CREATE TABLE IF NOT EXISTS roster_settings(scope TEXT PRIMARY KEY,revision INTEGER NOT NULL,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS note_proposals(id TEXT PRIMARY KEY,scope TEXT NOT NULL,worker TEXT NOT NULL,note TEXT NOT NULL,created INTEGER NOT NULL)')
    if (!this.db.prepare('PRAGMA table_info(note_proposals)').all().some(c => c.name === 'defaults')) {
      this.db.exec('ALTER TABLE note_proposals ADD COLUMN defaults TEXT')
    }
    const projectCols = this.db.prepare('PRAGMA table_info(projects)').all()
    if (projectCols.length && !projectCols.some(c => c.name === 'concurrency')) {
      this.db.exec('ALTER TABLE projects ADD COLUMN concurrency INTEGER')
    }
    this.audit = new SettingsAudit(this.db)
    this.verified = new Map()
  }

  scopeInfo(scope) {
    if (scope === 'global') return { scope: 'global', p: null, scopeName: 'Global' }
    const p = this.projects.get(scope)
    return { scope: p.id, p, scopeName: p.name || p.id }
  }

  read(scope) {
    const row = this.db.prepare('SELECT * FROM roster_settings WHERE scope=?').get(scope)
    return row ? { revision: row.revision, ...JSON.parse(row.data) } : { revision: 0, entries: {}, rules: [] }
  }

  effective(project) {
    const global = this.read('global'), local = this.read(project.id)
    const entries = structuredClone(global.entries ?? {})
    for (const [id, entry] of Object.entries(local.entries ?? {})) entries[id] = { ...entries[id], ...entry }
    const policy = local.inheritPolicy ? global : { allow: project.allow, worker: project.worker }
    const concurrency = local.concurrency ?? project.concurrency ?? global.concurrency ?? envConcurrency()
    return {
      allow: policy.allow ?? [],
      worker: policy.worker ?? '',
      concurrency,
      entries,
      rules: local.rulesOverride ? (local.rules ?? []) : [...(global.rules ?? []), ...(local.rules ?? [])]
    }
  }

  effectiveSummary(scope) {
    if (scope === 'global') {
      const g = this.read('global')
      return {
        scope: 'global',
        allow: g.allow ?? [],
        worker: g.worker ?? '',
        concurrency: g.concurrency ?? envConcurrency(),
        entries: g.entries ?? {},
        rules: g.rules ?? []
      }
    }
    const p = this.projects.get(scope)
    return { scope: p.id, ...this.effective(p) }
  }

  syncConcurrency(scope) {
    const slots = this.projects.slots
    if (!slots?.setLimit) return
    if (scope === 'global') {
      const g = this.read('global')
      slots.setLimit('global', g.concurrency ?? envConcurrency())
      for (const p of this.projects.entries?.values() ?? []) {
        slots.setLimit(p.id, this.effective(p).concurrency)
      }
    } else if (this.projects.entries?.has(scope)) {
      const p = this.projects.get(scope)
      slots.setLimit(scope, this.effective(p).concurrency)
    }
  }

  notifyScope(scope) {
    this.syncConcurrency(scope)
    if (!this.projects.hasListeners || this.projects.hasListeners()) {
      if (this.projects.summary && this.projects.entries) {
        for (const id of this.projects.entries.keys()) {
          this.projects.publish?.({ type: 'project', project: this.projects.summary(id) })
        }
      }
      this.projects.publish?.({ type: 'settings', scope })
    }
  }

  config(scope) {
    const p = scope === 'global' ? null : this.projects.get(scope)
    const raw = this.read(scope)
    const global = scope === 'global' ? raw : this.read('global')
    const effective = p ? this.effective(p) : {
      allow: raw.allow ?? [],
      worker: raw.worker ?? '',
      concurrency: raw.concurrency ?? envConcurrency(),
      entries: raw.entries ?? {},
      rules: raw.rules ?? []
    }
    return {
      scope,
      ...raw,
      concurrency: raw.concurrency ?? p?.concurrency ?? null,
      effectiveConcurrency: effective.concurrency,
      ...(p ? { allow: p.allow, worker: p.worker, effective, inherited: global } : { effective }),
      presets,
      proposals: this.db.prepare('SELECT id,worker,note,defaults FROM note_proposals WHERE scope=? ORDER BY created').all(scope).map(row =>
        row.defaults ? { id: row.id, worker: row.worker, defaults: JSON.parse(row.defaults) } : { id: row.id, worker: row.worker, note: row.note }
      ),
      audit: this.auditList(scope, 20)
    }
  }

  writeScopeSettings(scope, oldRevision, data) {
    this.db.prepare('INSERT INTO roster_settings VALUES (?,?,?) ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision,data=excluded.data').run(scope, oldRevision + 1, JSON.stringify(data))
  }

  save(scope, data, actor = 'user') {
    const { p, scopeName } = this.scopeInfo(scope)
    const old = this.read(scope)
    if (data.revision !== old.revision) throw new Error('Settings changed; reload before saving')
    const next = {
      entries: {},
      rules: list(data.rules ?? [], 'rules'),
      rulesOverride: !!data.rulesOverride,
      inheritPolicy: !!data.inheritPolicy
    }
    if (data.concurrency !== undefined) {
      const conc = parseConcurrency(data.concurrency)
      if (conc !== null) next.concurrency = conc
    } else if (old.concurrency !== undefined) {
      next.concurrency = old.concurrency
    }
    const inherited = this.read('global').entries ?? {}
    for (const [id, raw] of Object.entries(data.entries ?? {})) {
      if (!supportedWorker(id) || !raw || typeof raw !== 'object') throw new Error('Unknown worker ID: ' + id)
      const entry = {}
      for (const key of ['model', 'effort', 'note']) if (raw[key] !== undefined && raw[key] !== '') entry[key] = label(raw[key])
      if (raw.hiddenModels !== undefined) entry.hiddenModels = list(raw.hiddenModels, 'hidden models')
      if (raw.rules !== undefined) entry.rules = list(raw.rules, 'worker rules')
      if (raw.models !== undefined) entry.models = list(raw.models, 'custom models')
      if (raw.efforts !== undefined) entry.efforts = list(raw.efforts, 'custom efforts')
      if (id.startsWith('custom:') && raw.template) {
        entry.template = validateTemplate(raw.template)
        const hash = fingerprint(entry.template)
        const previous = old.entries?.[id]?.template ?? inherited[id]?.template
        if ((!previous || fingerprint(previous) !== hash) && !(this.verified.get(scope + ':' + hash) > Date.now())) {
          throw new Error('Test this exact template successfully before saving')
        }
      }
      next.entries[id] = entry
    }
    const allow = [...new Set(list(data.allow ?? p?.allow ?? old.allow ?? [], 'allowlist'))]
    const worker = data.worker ?? p?.worker ?? old.worker ?? ''
    if (allow.some(id => !supportedWorker(id))) throw new Error('Invalid worker allowlist')
    if (allow.some(id => id.startsWith('custom:') && !(next.entries[id]?.template ?? inherited[id]?.template))) {
      throw new Error('Allowed custom workers need a tested template')
    }
    if ((allow.length && !allow.includes(worker)) || (!allow.length && worker)) throw new Error('Default worker must be allowed')
    if (!p) Object.assign(next, { allow, worker })
    if (p && next.inheritPolicy && !this.read('global').allow?.length) throw new Error('Set a global allowlist before inheriting it')
    const nextProjConcurrency = data.concurrency !== undefined ? (next.concurrency ?? null) : (p?.concurrency ?? null)
    const before = {
      kind: 'snapshot',
      settingsData: stripRevision(old),
      project: p ? { allow: [...(p.allow ?? [])], worker: p.worker ?? '', concurrency: p.concurrency ?? null } : null
    }
    const after = {
      kind: 'snapshot',
      settingsData: structuredClone(next),
      project: p ? { allow: [...allow], worker, concurrency: nextProjConcurrency } : null
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.writeScopeSettings(scope, old.revision, next)
      if (p) this.db.prepare('UPDATE projects SET allow=?,worker=?,concurrency=? WHERE id=?').run(JSON.stringify(allow), worker, nextProjConcurrency, p.id)
      this.audit.record({ scope, scopeName, actor, action: 'save', summary: 'Saved settings for ' + scopeName, before, after })
      this.db.exec('COMMIT')
    } catch (err) { this.db.exec('ROLLBACK'); throw err }
    if (p) Object.assign(p, { allow, worker, concurrency: nextProjConcurrency })
    this.notifyScope(scope)
    return this.config(scope)
  }

  setDefaults(scope, worker, { model, effort, clear = false } = {}, actor = 'agent') {
    const { scopeName } = this.scopeInfo(scope)
    if (!supportedWorker(worker)) throw new Error('Unknown worker: ' + worker)
    if (!clear && model === undefined && effort === undefined) {
      throw new Error('Supply --model and/or --effort (or --clear)')
    }
    const old = this.read(scope)
    const data = stripRevision(old)
    data.entries ??= {}
    const hadEntry = Object.prototype.hasOwnProperty.call(data.entries, worker)
    const prevEntry = data.entries[worker] ? structuredClone(data.entries[worker]) : undefined
    const nextEntry = { ...(data.entries[worker] ?? {}) }
    if (clear) {
      delete nextEntry.model
      delete nextEntry.effort
    } else {
      if (model !== undefined) {
        if (model === null || model === 'inherit' || model === 'default') delete nextEntry.model
        else {
          const m = label(model).trim()
          if (!m) throw new Error('Default model is empty')
          const effectiveHidden = nextEntry.hiddenModels ?? (scope === 'global' ? [] : (this.read('global').entries?.[worker]?.hiddenModels ?? []))
          if (hiddenModel(m, effectiveHidden)) {
            throw new Error('Model is hidden for ' + worker + ': ' + m + ' (unhide it first with broco unhide ' + worker + ' ' + m + ')')
          }
          nextEntry.model = m
        }
      }
      if (effort !== undefined) {
        if (effort === null || effort === 'inherit' || effort === 'default') delete nextEntry.effort
        else {
          const e = label(effort).trim()
          if (!e) throw new Error('Default effort is empty')
          if (!/^[a-z0-9_-]{1,40}$/.test(e)) throw new Error('Invalid effort: ' + e)
          nextEntry.effort = e
        }
      }
    }
    data.entries[worker] = nextEntry
    cleanEntry(data.entries, worker, false)
    const updatedEntry = data.entries[worker]
    const before = { kind: 'entry-fields', worker, fields: { model: prevEntry?.model ?? null, effort: prevEntry?.effort ?? null }, hadEntry }
    const after = { kind: 'entry-fields', worker, fields: { model: updatedEntry?.model ?? null, effort: updatedEntry?.effort ?? null }, hadEntry: !!updatedEntry }
    const parts = [updatedEntry?.model && 'model=' + updatedEntry.model, updatedEntry?.effort && 'effort=' + updatedEntry.effort].filter(Boolean)
    const summary = clear || !parts.length
      ? 'Cleared default overrides for ' + worker
      : 'Set ' + worker + ' defaults (' + parts.join(', ') + ')'
    let auditRow
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.writeScopeSettings(scope, old.revision, data)
      auditRow = this.audit.record({ scope, scopeName, actor, action: 'defaults', summary, before, after })
      this.db.exec('COMMIT')
    } catch (err) { this.db.exec('ROLLBACK'); throw err }
    this.notifyScope(scope)
    const eff = this.effectiveSummary(scope)
    return {
      scope,
      worker,
      defaults: { model: eff.entries[worker]?.model ?? null, effort: eff.entries[worker]?.effort ?? null },
      override: { model: updatedEntry?.model ?? null, effort: updatedEntry?.effort ?? null },
      effective: eff,
      summary,
      auditId: auditRow.id
    }
  }

  setNote(scope, worker, note, actor = 'agent') {
    const { scopeName } = this.scopeInfo(scope)
    if (!supportedWorker(worker)) throw new Error('Unknown worker: ' + worker)
    if (note === undefined) throw new Error('Note is required')
    const trimmed = note === null ? '' : label(note).trim()
    const old = this.read(scope)
    const data = stripRevision(old)
    data.entries ??= {}
    const hadEntry = Object.prototype.hasOwnProperty.call(data.entries, worker)
    const prevEntry = data.entries[worker] ? structuredClone(data.entries[worker]) : undefined
    const nextEntry = { ...(data.entries[worker] ?? {}) }
    if (!trimmed) delete nextEntry.note
    else nextEntry.note = trimmed
    data.entries[worker] = nextEntry
    cleanEntry(data.entries, worker, false)
    const updatedEntry = data.entries[worker]
    const before = { kind: 'entry-fields', worker, fields: { note: prevEntry?.note ?? null }, hadEntry }
    const after = { kind: 'entry-fields', worker, fields: { note: updatedEntry?.note ?? null }, hadEntry: !!updatedEntry }
    const summary = trimmed
      ? 'Set note on ' + worker + ': ' + (trimmed.length > 72 ? trimmed.slice(0, 72) + '…' : trimmed)
      : 'Cleared note on ' + worker
    let auditRow
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.writeScopeSettings(scope, old.revision, data)
      auditRow = this.audit.record({ scope, scopeName, actor, action: 'note', summary, before, after })
      this.db.exec('COMMIT')
    } catch (err) { this.db.exec('ROLLBACK'); throw err }
    this.notifyScope(scope)
    const eff = this.effectiveSummary(scope)
    return {
      scope,
      worker,
      note: eff.entries[worker]?.note ?? '',
      overrideNote: updatedEntry?.note ?? null,
      effective: eff,
      summary,
      auditId: auditRow.id
    }
  }

  setAllow(scope, { allow, add = [], remove = [], defaultWorker, inheritPolicy } = {}, actor = 'agent') {
    const { p, scopeName } = this.scopeInfo(scope)
    const old = this.read(scope)
    const global = scope === 'global' ? old : this.read('global')
    const data = stripRevision(old)
    const currentAllow = p ? [...(p.allow ?? [])] : [...(old.allow ?? [])]
    const currentWorker = p ? (p.worker ?? '') : (old.worker ?? '')
    const toAdd = splitItems(add, 'allow add')
    const toRemove = splitItems(remove, 'allow remove')
    let nextAllow = allow !== undefined ? [...new Set(splitItems(allow, 'allowlist'))] : [...currentAllow]
    for (const w of toAdd) if (!nextAllow.includes(w)) nextAllow.push(w)
    if (toRemove.length) nextAllow = nextAllow.filter(w => !toRemove.includes(w))
    if (nextAllow.some(id => !supportedWorker(id))) throw new Error('Invalid worker allowlist')
    const effectiveEntries = p ? this.effective(p).entries : (data.entries ?? {})
    if (nextAllow.some(id => id.startsWith('custom:') && !effectiveEntries[id]?.template)) {
      throw new Error('Allowed custom workers need a tested template')
    }
    const explicitChange = allow !== undefined || toAdd.length > 0 || toRemove.length > 0 || defaultWorker !== undefined
    const nextInherit = p ? (inheritPolicy !== undefined ? !!inheritPolicy : (explicitChange ? false : !!old.inheritPolicy)) : false
    if (p && nextInherit && !(global.allow ?? []).length) throw new Error('Set a global allowlist before inheriting it')
    let nextWorker
    if (defaultWorker !== undefined) {
      nextWorker = defaultWorker || ''
      if ((nextAllow.length && !nextAllow.includes(nextWorker)) || (!nextAllow.length && nextWorker)) {
        throw new Error('Default worker must be allowed')
      }
    } else {
      nextWorker = nextAllow.includes(currentWorker) ? currentWorker : (nextAllow[0] ?? '')
    }
    if (p) data.inheritPolicy = nextInherit
    else Object.assign(data, { allow: nextAllow, worker: nextWorker })
    const before = { kind: 'allow', allow: currentAllow, worker: currentWorker, inheritPolicy: !!old.inheritPolicy }
    const after = { kind: 'allow', allow: nextAllow, worker: nextWorker, inheritPolicy: nextInherit }
    const summary = nextInherit
      ? 'Enabled global allowlist inheritance'
      : 'Set allowlist=[' + nextAllow.join(', ') + ']' + (nextWorker ? ', default=' + nextWorker : '')
    let auditRow
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.writeScopeSettings(scope, old.revision, data)
      if (p) this.db.prepare('UPDATE projects SET allow=?,worker=? WHERE id=?').run(JSON.stringify(nextAllow), nextWorker, p.id)
      auditRow = this.audit.record({ scope, scopeName, actor, action: 'allow', summary, before, after })
      this.db.exec('COMMIT')
    } catch (err) { this.db.exec('ROLLBACK'); throw err }
    if (p) Object.assign(p, { allow: nextAllow, worker: nextWorker })
    this.notifyScope(scope)
    const eff = this.effectiveSummary(scope)
    return {
      scope,
      allow: eff.allow,
      defaultWorker: eff.worker,
      inheritPolicy: nextInherit,
      effective: eff,
      summary,
      auditId: auditRow.id
    }
  }

  setConcurrency(scope, concurrency, actor = 'agent') {
    const { p, scopeName } = this.scopeInfo(scope)
    const val = parseConcurrency(concurrency)
    const old = this.read(scope)
    const data = stripRevision(old)
    const prevVal = old.concurrency ?? p?.concurrency ?? null
    if (val === null) delete data.concurrency
    else data.concurrency = val
    const before = { kind: 'concurrency', concurrency: prevVal }
    const after = { kind: 'concurrency', concurrency: val }
    let auditRow
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.writeScopeSettings(scope, old.revision, data)
      if (p) this.db.prepare('UPDATE projects SET concurrency=? WHERE id=?').run(val, p.id)
      if (p) p.concurrency = val
      const effAfter = p ? this.effective(p).concurrency : (val ?? envConcurrency())
      const summary = val === null
        ? 'Reset concurrency override (effective=' + effAfter + ')'
        : 'Set concurrency limit to ' + val
      auditRow = this.audit.record({ scope, scopeName, actor, action: 'concurrency', summary, before, after })
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      if (p) p.concurrency = prevVal
      throw err
    }
    this.notifyScope(scope)
    const eff = this.effectiveSummary(scope)
    return {
      scope,
      concurrency: eff.concurrency,
      override: val,
      effective: eff,
      summary: auditRow.summary,
      auditId: auditRow.id
    }
  }

  setRules(scope, { add = [], remove = [], clear = false, worker = null, rulesOverride } = {}, actor = 'agent') {
    const { scopeName } = this.scopeInfo(scope)
    const toAdd = stringItems(add, 'rules')
    const toRemove = stringItems(remove, 'rules')
    const old = this.read(scope)
    const data = stripRevision(old)
    let before, after, summary
    if (worker !== null && worker !== undefined) {
      if (!supportedWorker(worker)) throw new Error('Unknown worker: ' + worker)
      data.entries ??= {}
      const hadEntry = Object.prototype.hasOwnProperty.call(data.entries, worker)
      const prevEntry = data.entries[worker] ? structuredClone(data.entries[worker]) : undefined
      let nextRules = clear ? [] : [...(prevEntry?.rules ?? [])]
      for (const r of toAdd) if (!nextRules.includes(r)) nextRules.push(r)
      if (toRemove.length) nextRules = nextRules.filter(r => !toRemove.includes(r))
      list(nextRules, 'worker rules')
      const nextEntry = { ...(data.entries[worker] ?? {}) }
      if (clear && !nextRules.length && scope === 'global') delete nextEntry.rules
      else if (!nextRules.length && !clear && prevEntry?.rules === undefined) delete nextEntry.rules
      else nextEntry.rules = nextRules
      data.entries[worker] = nextEntry
      cleanEntry(data.entries, worker, false)
      const updatedEntry = data.entries[worker]
      before = { kind: 'entry-fields', worker, fields: { rules: prevEntry?.rules ?? null }, hadEntry }
      after = { kind: 'entry-fields', worker, fields: { rules: updatedEntry?.rules ?? null }, hadEntry: !!updatedEntry }
      summary = clear && !toAdd.length
        ? 'Cleared rules for ' + worker
        : 'Updated rules for ' + worker + ' (' + nextRules.length + ' active)'
    } else {
      let nextRules = clear ? [] : [...(old.rules ?? [])]
      for (const r of toAdd) if (!nextRules.includes(r)) nextRules.push(r)
      if (toRemove.length) nextRules = nextRules.filter(r => !toRemove.includes(r))
      list(nextRules, 'rules')
      const nextOverride = rulesOverride !== undefined ? !!rulesOverride : !!old.rulesOverride
      data.rules = nextRules
      data.rulesOverride = nextOverride
      before = { kind: 'rules', rules: [...(old.rules ?? [])], rulesOverride: !!old.rulesOverride }
      after = { kind: 'rules', rules: nextRules, rulesOverride: nextOverride }
      summary = clear && !toAdd.length
        ? 'Cleared rules for ' + scopeName
        : 'Updated rules for ' + scopeName + ' (' + nextRules.length + ' rule' + (nextRules.length === 1 ? '' : 's') + ')'
    }
    let auditRow
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.writeScopeSettings(scope, old.revision, data)
      auditRow = this.audit.record({ scope, scopeName, actor, action: 'rules', summary, before, after })
      this.db.exec('COMMIT')
    } catch (err) { this.db.exec('ROLLBACK'); throw err }
    this.notifyScope(scope)
    const eff = this.effectiveSummary(scope)
    return {
      scope,
      ...(worker ? { worker, workerRules: eff.entries[worker]?.rules ?? [] } : {}),
      rules: eff.rules,
      effective: eff,
      summary,
      auditId: auditRow.id
    }
  }

  setHiddenModels(scope, worker, { hide = [], unhide = [], clear = false } = {}, actor = 'agent') {
    const { scopeName } = this.scopeInfo(scope)
    if (!supportedWorker(worker)) throw new Error('Unknown worker: ' + worker)
    const toHide = splitItems(hide, 'hidden models')
    const toUnhide = splitItems(unhide, 'hidden models')
    const old = this.read(scope)
    const data = stripRevision(old)
    data.entries ??= {}
    const hadEntry = Object.prototype.hasOwnProperty.call(data.entries, worker)
    const prevEntry = data.entries[worker] ? structuredClone(data.entries[worker]) : undefined
    const inheritedHidden = scope === 'global' ? [] : (this.read('global').entries?.[worker]?.hiddenModels ?? [])
    let nextHidden = clear ? [] : [...(prevEntry?.hiddenModels ?? inheritedHidden)]
    for (const m of toHide) {
      const k = modelKey(m)
      if (!nextHidden.some(x => x === m || modelKey(x) === k)) nextHidden.push(k)
    }
    if (toUnhide.length) {
      const unhideKeys = new Set(toUnhide.map(modelKey))
      nextHidden = nextHidden.filter(x => !toUnhide.includes(x) && !unhideKeys.has(modelKey(x)))
    }
    list(nextHidden, 'hidden models')
    const nextEntry = { ...(data.entries[worker] ?? {}) }
    if (clear && scope === 'global' && !nextHidden.length) delete nextEntry.hiddenModels
    else nextEntry.hiddenModels = nextHidden
    data.entries[worker] = nextEntry
    cleanEntry(data.entries, worker, false)
    const updatedEntry = data.entries[worker]
    const before = { kind: 'entry-fields', worker, fields: { hiddenModels: prevEntry?.hiddenModels ?? null }, hadEntry }
    const after = { kind: 'entry-fields', worker, fields: { hiddenModels: updatedEntry?.hiddenModels ?? null }, hadEntry: !!updatedEntry }
    const summary = clear && !toHide.length
      ? 'Cleared hidden models on ' + worker
      : 'Updated hidden models on ' + worker + ' (' + nextHidden.length + ' hidden)'
    let auditRow
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.writeScopeSettings(scope, old.revision, data)
      auditRow = this.audit.record({ scope, scopeName, actor, action: 'hidden-models', summary, before, after })
      this.db.exec('COMMIT')
    } catch (err) { this.db.exec('ROLLBACK'); throw err }
    this.notifyScope(scope)
    const eff = this.effectiveSummary(scope)
    return {
      scope,
      worker,
      hiddenModels: eff.entries[worker]?.hiddenModels ?? [],
      effective: eff,
      summary,
      auditId: auditRow.id
    }
  }

  auditList(scope = null, limit = 30) {
    if (scope && scope !== 'all' && scope !== 'global') this.projects.get(scope)
    return this.audit.list(scope, limit)
  }

  undoAudit(auditId, opts = {}) {
    if (auditId && typeof auditId === 'object') {
      opts = auditId
      auditId = opts.id ?? opts.auditId ?? null
    }
    const { scope, actor = 'user' } = opts ?? {}
    let row
    if (auditId !== undefined && auditId !== null && auditId !== '') {
      row = this.audit.get(Number(auditId))
      if (!row) throw new Error('Unknown audit entry: ' + auditId)
      if (scope && scope !== 'all' && row.scope !== scope) {
        throw new Error('Audit entry #' + row.id + ' belongs to scope ' + row.scope)
      }
    } else {
      const targetScope = scope && scope !== 'all' ? scope : null
      if (targetScope && targetScope !== 'global') this.projects.get(targetScope)
      row = this.audit.latestUndoable(targetScope)
      if (!row) throw new Error('Nothing to undo' + (targetScope ? ' for ' + targetScope : ''))
    }
    if (row.revertedAt) throw new Error('Audit entry #' + row.id + ' was already reverted')
    if (row.scope !== 'global') {
      let registered = true
      try { this.projects.get(row.scope) } catch { registered = false }
      if (!registered) throw new Error('Cannot undo #' + row.id + ': project ' + (row.scopeName || row.scope) + ' is no longer registered')
    }
    const { p, scopeName } = this.scopeInfo(row.scope)
    const old = this.read(row.scope)
    const data = stripRevision(old)
    const patch = row.before
    let nextAllow = p ? [...(p.allow ?? [])] : [...(data.allow ?? [])]
    let nextWorker = p ? (p.worker ?? '') : (data.worker ?? '')
    let nextConc = p ? (p.concurrency ?? null) : (data.concurrency ?? null)
    let updateProjectCols = false

    if (patch.kind === 'entry-fields') {
      data.entries ??= {}
      const cur = { ...(data.entries[patch.worker] ?? {}) }
      for (const [k, v] of Object.entries(patch.fields ?? {})) {
        if (v === undefined || v === null) delete cur[k]
        else cur[k] = v
      }
      data.entries[patch.worker] = cur
      cleanEntry(data.entries, patch.worker, !!patch.hadEntry)
    } else if (patch.kind === 'rules') {
      data.rules = [...(patch.rules ?? [])]
      data.rulesOverride = !!patch.rulesOverride
    } else if (patch.kind === 'concurrency') {
      if (patch.concurrency === null || patch.concurrency === undefined) delete data.concurrency
      else data.concurrency = patch.concurrency
      nextConc = patch.concurrency ?? null
      updateProjectCols = true
    } else if (patch.kind === 'allow') {
      nextAllow = [...(patch.allow ?? [])]
      nextWorker = patch.worker ?? ''
      if (nextAllow.length && !nextAllow.includes(nextWorker)) nextWorker = nextAllow[0]
      if (!nextAllow.length) nextWorker = ''
      if (p) data.inheritPolicy = !!patch.inheritPolicy
      else Object.assign(data, { allow: nextAllow, worker: nextWorker })
      updateProjectCols = true
    } else if (patch.kind === 'snapshot') {
      for (const k of Object.keys(data)) delete data[k]
      Object.assign(data, structuredClone(patch.settingsData ?? { entries: {}, rules: [] }))
      if (p && patch.project) {
        nextAllow = [...(patch.project.allow ?? [])]
        nextWorker = patch.project.worker ?? ''
        nextConc = patch.project.concurrency ?? null
        updateProjectCols = true
      }
    }

    const now = Date.now()
    const summary = 'Reverted #' + row.id + ': ' + row.summary
    let undoRow
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.writeScopeSettings(row.scope, old.revision, data)
      if (p && updateProjectCols) {
        this.db.prepare('UPDATE projects SET allow=?,worker=?,concurrency=? WHERE id=?').run(JSON.stringify(nextAllow), nextWorker, nextConc, p.id)
      }
      this.audit.markReverted(row.id, now)
      undoRow = this.audit.record({
        scope: row.scope,
        scopeName,
        actor,
        action: 'undo',
        summary,
        before: row.after,
        after: row.before,
        at: now
      })
      this.db.exec('COMMIT')
    } catch (err) { this.db.exec('ROLLBACK'); throw err }
    if (p && updateProjectCols) Object.assign(p, { allow: nextAllow, worker: nextWorker, concurrency: nextConc })
    this.notifyScope(row.scope)
    return {
      undoneId: row.id,
      auditId: undoRow.id,
      scope: row.scope,
      summary,
      effective: this.effectiveSummary(row.scope),
      config: this.config(row.scope)
    }
  }

  async list(scope, all = false, { refresh = false } = {}) {
    const project = scope === 'global' ? null : this.projects.get(scope)
    const effective = project ? this.effective(project) : this.read('global')
    const allow = effective.allow ?? []
    const cwd = project?.repoPath ?? home
    const discovered = await discoverPi(cwd, { refresh })
    const ids = [...new Set([...allow, 'codex', 'claude', 'agy', 'cursor-agent', ...discovered, ...Object.keys(effective.entries ?? {}), ...(all ? ['pi:openai-codex', 'pi:deepseek', ...Object.keys(presets)] : [])])]
    const catalog = loadCatalog()
    const hiddenAllByWorker = new Map()
    const rows = await Promise.all(ids.map(async id => {
      const entry = effective.entries?.[id] ?? {}
      const custom = id.startsWith('custom:')
      const template = entry.template ?? presets[id]
      const cli = template?.command ?? ''
      const isAllowed = allow.includes(id)
      const inspectGlobalBuiltins = scope === 'global' && all && !allow.length && ['codex', 'claude', 'agy', 'cursor-agent'].includes(id)
      if (!isAllowed && !inspectGlobalBuiltins) {
        const cliName = custom ? cli : id.startsWith('pi:') ? 'pi' : id
        return {
          id,
          cli: cliName,
          allowed: false,
          installed: hasCli(cliName),
          capability: custom ? 'degraded' : 'full',
          loginStatus: 'unknown',
          models: [],
          efforts: [],
          defaultModel: null,
          defaultEffort: null,
          warnings: [],
          note: entry.note ?? '',
          rules: [...(effective.rules ?? []), ...(entry.rules ?? [])]
        }
      }
      const actions = { ...cliActions[cli], ...Object.fromEntries(Object.entries(template?.actions ?? {}).map(([k, v]) => [k, v.join(' ')])) }
      const detected = custom ? {
        ...actions,
        cli,
        installed: !!executable(cli),
        capability: 'degraded',
        steering: 'queue',
        cache: false,
        version: null,
        loginStatus: 'unknown',
        models: (entry.models ?? []).map(mId => ({ id: mId })),
        efforts: entry.efforts ?? [],
        defaultModel: null,
        defaultEffort: null,
        tested: !!entry.template,
        warnings: [entry.template ? 'Custom CLI: session and reply extraction verified; detailed steps, live steering and cache are unavailable.' : 'Preset only: test this CLI before saving and allowing it.']
      } : await detectCli(id, cwd, { refresh })
      if (custom && detected.installed && (template?.versionArgs || cliActions[cli])) {
        const version = await inspectCommand(cli, template.versionArgs ?? ['--version'], cwd)
        detected.version = version.ok ? version.text.trim().split('\n')[0].slice(0, 200) : null
      }
      const models = detected.models.map(m => {
        const matched = matchModel(m.id, catalog)
        const description = matched && (all || !hiddenModel(matched.id, entry.hiddenModels)) ? { ...matched, ...(matched.aliases ? { aliases: matched.aliases.filter(aliasId => all || !hiddenModel(aliasId, entry.hiddenModels)) } : {}) } : null
        return { ...m, ...(description ? { catalog: description } : {}), capabilities: modelCapabilities(id, m, description), hidden: hiddenModel(m.id, entry.hiddenModels) }
      }).filter(m => all || !m.hidden)
      if (detected.models.length > 0 && models.length === 0) hiddenAllByWorker.set(id, true)
      const visibleDefault = value => all || !value || !hiddenModel(value, entry.hiddenModels) ? value : null
      const defaultModel = visibleDefault(entry.model || detected.defaultModel)
      const staleWarning = staleDefaultWarning(id, defaultModel, detected.models, catalog)
      if (staleWarning) detected.warnings.push(staleWarning)
      return {
        id,
        ...detected,
        models,
        defaultBlocked: hiddenModel(entry.model || detected.defaultModel || '', entry.hiddenModels),
        allowed: isAllowed,
        defaultModel,
        defaultEffort: entry.effort || detected.defaultEffort,
        detectedModel: visibleDefault(detected.defaultModel),
        detectedEffort: detected.defaultEffort,
        note: entry.note ?? '',
        rules: [...(effective.rules ?? []), ...(entry.rules ?? [])]
      }
    }))
    this.observe(rows)
    const workers = all
      ? rows
      : rows.filter(w => w.allowed ? w.installed && (['ready', 'not-required'].includes(w.loginStatus) || w.tested) && w.models.length : w.installed)
    const warnings = []
    if (!all) {
      for (const w of rows) {
        if (!w.allowed || workers.includes(w)) continue
        if (!w.installed || w.loginStatus === 'not-installed') {
          warnings.push('Allowed bro ' + w.id + ' is not installed' + (w.install ? '; install: ' + w.install : '') + '.')
        } else if (['signed-out', 'expired', 'missing', 'unavailable'].includes(w.loginStatus)) {
          warnings.push('Allowed bro ' + w.id + ' is ' + w.loginStatus + (w.login ? '; run: ' + w.login : '') + '.')
        } else if (hiddenAllByWorker.get(w.id)) {
          warnings.push('Allowed bro ' + w.id + ' has no visible models (all detected models are hidden).')
        } else if (!w.models.length) {
          warnings.push('Allowed bro ' + w.id + ' reported no models' + (w.login ? '; check login: ' + w.login : '') + '.')
        }
      }
    }
    return {
      projectId: project?.id ?? null,
      defaultWorker: effective.worker ?? '',
      concurrency: effective.concurrency ?? envConcurrency(),
      rules: effective.rules ?? [],
      workers,
      ...(warnings.length ? { warnings } : {}),
      records: this.records().filter(r => r.role === 'write'),
      picks: visiblePicks(catalog, workers),
      effort_advice: catalog.effort_advice,
      catalog: {
        as_of: catalog.as_of,
        source: catalog.source,
        match_rule: catalog.match_rule,
        stale_after_days: catalog.stale_after_days,
        warnings: catalog.warnings
      }
    }
  }

  records() {
    return summarize((this.projects.crews?.() ?? []).filter(Boolean).flatMap(crew => ticketRecords(crew.store)))
  }

  observe(rows) {
    const native = rows.find(w => w.id === 'codex')?.quota
    const crews = (this.projects.crews?.() ?? []).filter(Boolean)
    for (const w of rows) {
      if (w.allowed === false) continue
      if (w.id === 'pi:openai-codex' && native) w.quota = { ...native, sharedWith: 'codex' }
      let latest = null, recovered = 0
      for (const crew of crews) {
        const row = crew.store.stmt("SELECT t.problem,t.finished FROM turns t JOIN conversations c ON c.id=t.cid WHERE c.provider=? AND json_extract(t.problem,'$.class') IN ('quota','region','auth') ORDER BY t.finished DESC LIMIT 1").get(w.id)
        if (row && (!latest || row.finished > latest.finished)) latest = row
        recovered = Math.max(recovered, crew.store.stmt("SELECT coalesce(max(t.finished),0) AS at FROM turns t JOIN conversations c ON c.id=t.cid WHERE c.provider=? AND t.status='done'").get(w.id).at)
      }
      if (!latest || recovered >= latest.finished) continue
      const problem = JSON.parse(latest.problem), at = new Date(latest.finished).toISOString()
      const fresh = problem.resetsAt ? Date.parse(problem.resetsAt) > Date.now() : Date.now() - latest.finished < 6 * 3600e3
      if (!fresh || !['quota', 'region', 'auth'].includes(problem.class)) continue
      if (problem.class === 'quota' && !w.quota) w.quota = { source: 'observed', class: 'quota', at, resetsAt: problem.resetsAt ?? null }
      else if (problem.class !== 'quota' || !tight(w.quota)) w.recentProblem = { class: problem.class, at, message: problem.message.slice(0, 200) }
    }
  }

  async trial(scope, raw, model, thinking) {
    if (scope !== 'global') this.projects.get(scope)
    const template = validateTemplate(raw)
    if (!executable(template.command)) throw new Error('CLI is not installed: ' + template.command)
    const base = join(home, 'template-tests')
    mkdirSync(base, { recursive: true })
    const cwd = mkdtempSync(join(base, 'trial-'))
    execFileSync('git', ['init', '-q'], { cwd, stdio: 'ignore' })
    const marker = join(cwd, 'owner'), controller = new AbortController()
    const nonce = randomUUID()
    let session, pid, known = []
    const timer = setTimeout(() => { known = platform.owned(marker, [], pid); controller.abort() }, 120000)
    const ctx = {
      cwd,
      marker,
      signal: controller.signal,
      template,
      provider: 'custom:trial',
      model: model || 'custom:trial',
      thinking,
      owner: id => { pid = id },
      ready() {},
      event() {},
      bind: id => { if (session && session !== id) throw new Error('CLI resumed a different session'); session = id }
    }
    try {
      const first = await templateTurn({ ...ctx, text: 'Do not use tools or read or change files. Remember the exact code ' + nonce + '. Reply only ACK.' })
      if (!first || !session) throw new Error('New session extraction failed')
      const reply = await templateTurn({ ...ctx, session, text: 'Without tools, repeat the exact code from my previous message. No other text.' })
      if (!reply.includes(nonce)) throw new Error('Resumed session did not remember the first turn')
      this.verified.set(scope + ':' + fingerprint(template), Date.now() + 15 * 60 * 1000)
      return { status: 'passed', session, capability: 'degraded', expiresInSeconds: 900 }
    } finally {
      clearTimeout(timer)
      const owned = platform.owned(marker, known, pid)
      await platform.reap(marker, owned)
      rmSync(cwd, { recursive: true, force: true })
    }
  }

  propose(scope, worker, note) {
    this.projects.get(scope)
    if (!supportedWorker(worker)) throw new Error('Unknown worker')
    label(note)
    if (!note.trim()) throw new Error('Note is empty')
    const id = randomUUID()
    this.db.prepare('INSERT INTO note_proposals (id,scope,worker,note,created) VALUES (?,?,?,?,?)').run(id, scope, worker, note, Date.now())
    return { id, status: 'pending-user-confirmation' }
  }

  proposeDefaults(scope, worker, input) {
    this.projects.get(scope)
    if (!supportedWorker(worker)) throw new Error('Unknown worker')
    const defaults = {}
    for (const key of ['model', 'effort']) if (input[key] !== undefined) {
      defaults[key] = label(input[key]).trim()
      if (!defaults[key]) throw new Error('Default ' + key + ' is empty')
    }
    if (!Object.keys(defaults).length) throw new Error('Supply --model and/or --effort')
    const id = randomUUID()
    this.db.prepare('INSERT INTO note_proposals (id,scope,worker,note,created,defaults) VALUES (?,?,?,?,?,?)').run(id, scope, worker, '', Date.now(), JSON.stringify(defaults))
    return { id, status: 'pending-user-confirmation' }
  }

  resolveProposal(scope, id, accept) {
    const proposal = this.db.prepare('SELECT * FROM note_proposals WHERE id=? AND scope=?').get(id, scope)
    if (!proposal) throw new Error('Unknown proposal')
    if (accept) {
      const data = this.config(scope)
      data.entries[proposal.worker] = { ...data.entries[proposal.worker], ...(proposal.defaults ? JSON.parse(proposal.defaults) : { note: proposal.note }) }
      this.save(scope, data, 'user')
    }
    this.db.prepare('DELETE FROM note_proposals WHERE id=?').run(id)
    return this.config(scope)
  }

  terminalCommand(id, action, scope) {
    if (!['login', 'install', 'upgrade'].includes(action)) throw new Error('Unknown CLI action')
    let command
    if (id.startsWith('custom:')) {
      const settings = scope === 'global' ? this.read('global') : this.effective(this.projects.get(scope))
      const template = settings.entries?.[id]?.template ?? presets[id]
      const args = template?.actions?.[action]
      const quote = s => "'" + s.replaceAll("'", "'\\''") + "'"
      command = args ? args.map(quote).join(' ') : cliActions[template?.command]?.[action]
    } else command = cliActions[id]?.[action]
    if (!command) throw new Error('No command configured for this CLI action')
    return command
  }

  async terminal(id, action, cwd, scope) {
    return platform.openTerminal(this.terminalCommand(id, action, scope), cwd)
  }
}

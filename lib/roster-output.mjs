import { modalities } from './model-catalog.mjs'
import { quotaText } from './quota.mjs'
import { minimumTickets } from './stats.mjs'
import { AGY_TOS_WARNING } from './worker-policy.mjs'

const levels = ['off','none','minimal','low','medium','high','extra-high','xhigh','max','ultra']
const older = model => ['previous generation','superseded','being retired'].includes(model.catalog?.tier)
const line = value => String(value ?? '').replace(/\s+/g, ' ').trim()
const sentence = value => line(value).match(/^.*?(?:[。！？]|[.!?](?=\s|$)|$)/u)?.[0] ?? ''

function variant(id) {
  const options = /\[([^\]]*)\]$/.exec(id)?.[1]?.split(',') ?? []
  const base = id.replace(/\[[^\]]*\]$/, '')
  const suffix = /(?:-(?:extra-high|off|none|minimal|low|medium|high|xhigh|max|ultra|fast|thinking))+$/.exec(base)?.[0] ?? ''
  const other = options.filter(o => !/^(?:effort|fast)=/.test(o))
  return { family: base.slice(0, base.length - suffix.length) + (other.length ? '[' + other.join(',') + ']' : ''),
    efforts: [...suffix.matchAll(/-(extra-high|off|none|minimal|low|medium|high|xhigh|max|ultra)(?=-|$)/g)].map(m => m[1]).concat(options.filter(o => o.startsWith('effort=')).map(o => o.slice(7))),
    fast: /(?:^|-)fast(?:-|$)/.test(suffix) || options.includes('fast=true') }
}

function record(records, worker, family) {
  const rows = (records ?? []).filter(r => r.worker === worker && variant(r.model).family === family)
  const tickets = rows.reduce((n, r) => n + r.tickets, 0)
  if (tickets < minimumTickets) return null
  const sum = key => rows.reduce((n, r) => n + (r[key] ?? 0), 0)
  const weighted = key => { const w = rows.filter(r => r[key] !== null); const n = w.reduce((a, r) => a + r.tickets, 0); return n ? Math.round(w.reduce((a, r) => a + r[key] * r.tickets, 0) / n * 10) / 10 : null }
  return { tickets, pass: sum('pass'), rework: sum('rework'), fail: sum('fail'), blocked: sum('blocked'), medianMinutes: weighted('medianMinutes'), weekQuotaPerTicket: weighted('weekQuotaPerTicket') }
}

function compactWorker(worker, records) {
  const groups = new Map()
  for (const model of worker.models.filter(m => !m.hidden)) {
    const family = variant(model.id).family
    if (!groups.has(family)) groups.set(family, [])
    groups.get(family).push(model)
  }
  const models = [], defaultFamily = variant(worker.defaultModel ?? '').family
  let olderModels = 0, defaultFolded = false
  for (const [family, group] of groups) {
    if (group.every(older)) { olderModels++; defaultFolded ||= family === defaultFamily; continue }
    const chosen = group.find(m => m.id === worker.defaultModel) ?? group.find(m => m.id === family) ?? (worker.id === 'agy' ? group.find(m => m.id === family + '-medium') : null) ?? group[0]
    const variants = group.map(m => variant(m.id))
    const efforts = [...new Set(group.flatMap(m => m.efforts ?? []).concat(variants.flatMap(v => v.efforts)))].sort((a,b) => (levels.indexOf(a) === -1 ? 99 : levels.indexOf(a)) - (levels.indexOf(b) === -1 ? 99 : levels.indexOf(b)) || a.localeCompare(b))
    const input = Object.fromEntries(modalities.map(type => {
      const values = group.map(m => m.capabilities?.input?.[type] ?? 'unknown')
      return [type, values.every(v => v === true) ? true : values.every(v => v === false) ? false : 'unknown']
    }))
    const catalog = chosen.catalog
    const yours = record(records, worker.id, family)
    const useFamilyId = worker.id === 'agy' && !group.some(m => m.id === family) && variants.filter(v => v.efforts.length > 0).length > 1
    models.push({
      id: useFamilyId ? family : chosen.id,
      ...(useFamilyId ? { defaultVariant: chosen.id } : {}),
      efforts,
      ...(yours ? { record: yours } : {}),
      ...(group.length > 1 ? { variantCount: group.length } : {}),
      ...(variants.some(v => v.fast) ? { fast: true } : {}),
      capabilities: { input },
      ...(catalog ? { catalog: { id: catalog.id, tier: catalog.tier, grade: catalog.grade, summary: sentence(catalog.summary?.en || catalog.summary?.zh), as_of: catalog.as_of, stale: group.some(m => m.catalog?.stale) } } : {})
    })
  }
  return { id: worker.id, allowed: Boolean(worker.allowed), cli: worker.cli, loginStatus: worker.loginStatus, capability: worker.capability, steering: worker.steering, cache: worker.cache,
    defaultModel: worker.defaultModel, defaultEffort: worker.defaultEffort, efforts: worker.efforts, ...(worker.defaultBlocked ? { defaultBlocked: true } : {}), ...(defaultFolded ? { defaultFolded: true } : {}),
    quota: worker.quota ?? null, ...(worker.recentProblem ? { recentProblem: worker.recentProblem } : {}),
    note: worker.note, rules: worker.rules, ...(worker.warnings?.length ? { warnings: worker.warnings } : {}), ...(worker.tosWarning ? { tosWarning: worker.tosWarning } : {}), models, ...(olderModels ? { olderModels } : {}) }
}

export function rosterOutput(roster, { full = false, worker } = {}) {
  const selected = roster.workers.filter(w => !worker || w.id === worker)
  if (worker && !selected.length) {
    const hint = (roster.warnings ?? []).find(msg => msg.startsWith('Allowed bro ' + worker + ' '))
    throw new Error('Worker is not in the detected roster: ' + worker + (hint ? ' (' + hint + ')' : ''))
  }
  const preview = roster.globalAllowConfigured === false
  const workers = selected.map(w => !w.allowed && !preview
    ? { id: w.id, allowed: false }
    : full
      ? { ...w, models: (w.models ?? []).filter(m => !m.hidden) }
      : compactWorker(w, roster.records))
  const visible = new Set(workers.flatMap(w => w.allowed ? (w.models ?? []).map(m => m.catalog?.id).filter(Boolean) : []))
  const picks = Object.fromEntries(Object.entries(roster.picks ?? {}).map(([key, p]) => [key, { ...p, first: p.first.filter(id => visible.has(id)), backup: p.backup.filter(id => visible.has(id)) }]))
  return {
    ...roster,
    concurrency: roster.concurrency ?? 3,
    mode: full ? 'full' : 'compact',
    workers,
    picks,
    ...(roster.warnings?.length ? { warnings: roster.warnings } : {}),
    ...(!full ? { catalog: { as_of: roster.catalog.as_of, stale_after_days: roster.catalog.stale_after_days, warnings: roster.catalog.warnings } } : {})
  }
}

function inputs(model) {
  const input = model.capabilities.input
  const yes = modalities.filter(k => input[k] === true), unknown = modalities.filter(k => input[k] === 'unknown')
  return (yes.join(',') || 'none confirmed') + (unknown.length ? '; unknown=' + unknown.join(',') : '')
}

export function rosterText(roster) {
  const full = roster.mode === 'full'
  const preview = roster.globalAllowConfigured === false
  const conc = Number.isSafeInteger(roster.concurrency) ? ' · concurrency=' + roster.concurrency : ''
  const output = ['Default bro: ' + (roster.defaultWorker || (preview ? 'none (unconfigured)' : '')) + conc + ' · ' + roster.mode, ...roster.rules.map(r => 'Rule: ' + line(r))]
  for (const w of roster.workers) {
    if (!w.allowed && !preview) { output.push(w.id + ' · NOT ALLOWED / 不允许'); continue }
    const defaultModel = w.defaultBlocked ? 'hidden; choose a visible default' : w.defaultModel || 'CLI default'
    output.push(w.id + (!w.allowed ? ' (not allowed)' : '') + ' · ' + w.cli + '/' + w.capability + ' · login=' + w.loginStatus + ' · default=' + defaultModel + '/' + (w.defaultEffort || 'CLI default') + (w.defaultFolded ? ' (older; --full)' : ''))
    output.push('  ' + quotaText(w.quota, { unreported: true }) + (w.quota?.sharedWith ? ' (shared with ' + w.quota.sharedWith + ')' : ''))
    if (w.recentProblem) output.push('  Recent failure: ' + w.recentProblem.class + ' at ' + w.recentProblem.at + ' · ' + line(w.recentProblem.message) + ' · 先别派 / avoid')
    if (w.efforts?.length) output.push('  Default-model efforts: ' + w.efforts.join(','))
    if (w.note) output.push('  Note: ' + line(w.note))
    for (const rule of w.rules ?? []) if (!roster.rules.includes(rule)) output.push('  Rule: ' + line(rule))
    for (const m of w.models) {
      const c = m.catalog, summary = full ? c?.summary?.en || c?.summary?.zh : c?.summary
      output.push('  ' + m.id + ' · input=' + inputs(m) + ' · ' + ([c?.tier, c?.grade].filter(Boolean).join('/') || 'unrated') + ' · effort=' + (m.efforts?.join(',') || 'unknown') + (m.fast ? ' · fast available' : '') +
        (m.variantCount ? ' · ' + m.variantCount + ' variants' : '') + (m.record ? ' · yours: ' + m.record.tickets + ' tickets, ' + m.record.pass + ' pass/' + m.record.rework + ' rework/' + m.record.fail + ' fail/' + (m.record.blocked ?? 0) + ' blocked, median ' + m.record.medianMinutes + 'm' + (m.record.weekQuotaPerTicket !== null ? ', ' + m.record.weekQuotaPerTicket + '% week quota each' : '') : '') + (summary ? ' · ' + line(summary) : '') + (c?.stale ? ' · STALE ' + c.as_of + '; refresh catalog' : ''))
      if (full) {
        const cap = m.capabilities
        output.push('    Context: ' + cap.context_tokens + ' (' + cap.sources.context_tokens + ') · Max output: ' + cap.max_output_tokens + (' (' + cap.sources.max_output_tokens + ')'))
      }
    }
    if (w.olderModels) output.push('  Older/superseded: ' + w.olderModels + ' model families folded; use --full')
    for (const warning of w.warnings ?? []) output.push((warning === AGY_TOS_WARNING ? '  Warning: ' : '  Notice: ') + line(warning))
  }
  for (const [key, pick] of Object.entries(roster.picks)) {
    if (!pick.first.length && !pick.backup.length) continue
    const body = pick.first.length
      ? pick.first.join(',') + (pick.backup.length ? ' / backup=' + pick.backup.join(',') : '')
      : pick.backup.join(',') + ' (backup; top pick not enabled)'
    output.push('Pick ' + key + ': ' + body + (pick.note ? ' · ' + line(pick.note) : ''))
  }
  if (roster.effort_advice) output.push('Effort advice: ' + line(roster.effort_advice))
  for (const warning of roster.warnings ?? []) output.push('Notice: ' + line(warning))
  for (const warning of roster.catalog.warnings ?? []) output.push('Notice: ' + line(warning))
  if (!full) output.push('Details: roster --full [--json]; one bro: roster --worker ID [--full] [--json]')
  return output.join('\n')
}

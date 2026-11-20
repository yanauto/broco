import { infra } from './problems.mjs'

const median = values => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function computeWeekSpent(quotaRows) {
  if (!quotaRows || !quotaRows.length) return null
  const first = quotaRows[0], last = quotaRows.at(-1)
  const w = (last.windows ?? []).find(win => win.minutes === 10080)
  if (!w) return null
  const before = (first.windows ?? []).find(b => b.minutes === 10080)
  if (!before || before.resetsAt !== w.resetsAt) return null
  const pct = Math.max(0, w.usedPercent - before.usedPercent)
  return Number.isFinite(pct) ? pct : null
}

export function ticketRecords(store) {
  const tickets = store.stmt("SELECT c.id,c.provider,t.model,t.thinking,t.start_turn,t.end_turn,t.outcome,(SELECT parent FROM collaboration WHERE cid=c.id) AS parent FROM tasks t JOIN conversations c ON c.id=t.cid WHERE t.outcome IS NOT NULL").all()
  if (!tickets.length) return []

  const cidsJson = JSON.stringify([...new Set(tickets.map(t => t.id))])
  const turnsByCid = new Map()
  for (const r of store.stmt('SELECT cid,turn,status,started,finished,problem FROM turns WHERE cid IN (SELECT value FROM json_each(?)) ORDER BY cid,turn').all(cidsJson)) {
    let arr = turnsByCid.get(r.cid)
    if (!arr) { arr = []; turnsByCid.set(r.cid, arr) }
    arr.push(r)
  }

  const quotaByKey = new Map()
  for (const e of store.stmt("SELECT cid,turn,raw FROM events WHERE kind='quota' AND cid IN (SELECT value FROM json_each(?)) ORDER BY id").all(cidsJson)) {
    const key = e.cid + ':' + e.turn
    let arr = quotaByKey.get(key)
    if (!arr) { arr = []; quotaByKey.set(key, arr) }
    arr.push(JSON.parse(e.raw))
  }

  return tickets.map(t => {
    const allTurns = turnsByCid.get(t.id) ?? []
    const turns = allTurns.filter(r => r.turn >= t.start_turn && r.turn <= t.end_turn)
    const week = turns.map(r => computeWeekSpent(quotaByKey.get(t.id + ':' + r.turn))).filter(Number.isFinite)
    const done = turns.filter(r => r.status === 'done').length
    const infraFailures = turns.filter(r => r.problem && infra.includes(JSON.parse(r.problem).class)).length
    const last = turns.at(-1)?.problem
    const outcome = t.outcome === 'fail' && last && infra.includes(JSON.parse(last).class) ? 'blocked' : t.outcome
    return {
      worker: t.provider,
      model: t.model,
      effort: t.thinking,
      role: t.parent ? 'review' : 'write',
      outcome,
      turns: done,
      minutes: turns.reduce((sum, r) => sum + (r.finished && r.started ? (r.finished - r.started) / 60000 : 0), 0),
      infraFailures,
      weekQuota: week.length ? week.reduce((a, b) => a + b, 0) : null
    }
  })
}

export function summarize(records) {
  const groups = new Map()
  for (const r of records) {
    const key = [r.worker, r.model, r.role].join('\0')
    if (!groups.has(key)) groups.set(key, { worker: r.worker, model: r.model, role: r.role, tickets: 0, pass: 0, rework: 0, fail: 0, blocked: 0, infraFailures: 0, minutes: [], quota: [], efforts: new Set() })
    const g = groups.get(key)
    g[r.outcome]++
    if (r.outcome === 'blocked') { g.infraFailures += r.infraFailures; continue }
    g.tickets++
    g.infraFailures += r.infraFailures
    g.minutes.push(r.minutes)
    if (r.weekQuota !== null) g.quota.push(r.weekQuota)
    if (r.effort) g.efforts.add(r.effort)
  }
  return [...groups.values()].map(({ minutes, quota, efforts, ...g }) => ({
    ...g,
    passRate: g.tickets ? g.pass / g.tickets : null,
    medianMinutes: minutes.length ? Math.round(median(minutes) * 10) / 10 : null,
    weekQuotaPerTicket: quota.length ? Math.round(quota.reduce((a, b) => a + b, 0) / quota.length * 10) / 10 : null,
    efforts: [...efforts]
  })).sort((a, b) => b.tickets - a.tickets)
}

export const minimumTickets = 3

export function statsText(groups) {
  if (!groups.length) return 'No accepted tickets with an outcome yet. Record one with: broco done <name> --result pass|rework|fail|blocked'
  return ['BRO\tMODEL\tROLE\tTICKETS\tPASS\tREWORK\tFAIL\tBLOCKED\tMEDIAN_MIN\tWEEK_QUOTA/TICKET\tINFRA_FAILURES', ...groups.map(g =>
    [g.worker, g.model, g.role, g.tickets, g.pass, g.rework, g.fail, g.blocked, g.medianMinutes ?? '-', g.weekQuotaPerTicket ?? '-', g.infraFailures].join('\t')),
  'BLOCKED = closed with --result blocked, or failed on its last turn because of quota, region, policy, network or auth; excluded from TICKETS and pass rates.'].join('\n')
}

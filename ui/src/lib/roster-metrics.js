import { compactProvider, isLiveWorking, windowName } from './format.js'

function peakWindow(windows) {
  if (!Array.isArray(windows) || !windows.length) return null
  let best = null
  for (const w of windows) {
    if (!Number.isFinite(w?.usedPercent)) continue
    if (!best || w.usedPercent > best.usedPercent) best = w
  }
  return best
}

export function workerQuotaInfo(worker) {
  const q = worker?.quota
  if (!q) {
    return { usedPercent: null, windowLabel: '', resetsAt: null, tight: false, observed: false, plentiful: false, tone: 'muted' }
  }
  if (q.source === 'observed') {
    return {
      usedPercent: 100,
      windowLabel: '',
      resetsAt: q.resetsAt ?? null,
      tight: true,
      observed: true,
      plentiful: false,
      tone: 'err'
    }
  }
  const allWindows = []
  if (Array.isArray(q.windows)) allWindows.push(...q.windows)
  if (Array.isArray(q.groups)) {
    for (const g of q.groups) {
      if (Array.isArray(g.windows)) allWindows.push(...g.windows)
    }
  }
  const peak = peakWindow(allWindows)
  const usedPercent = peak ? Math.round(peak.usedPercent) : null
  const tight = Boolean(q.avoid || q.reached || (usedPercent !== null && usedPercent >= 85))
  const plentiful = !tight && Boolean(q.plentiful)
  const tone = tight ? 'err' : (usedPercent !== null && usedPercent >= 60) ? 'warn' : (usedPercent !== null || plentiful) ? 'ok' : 'muted'
  return {
    usedPercent,
    windowLabel: peak ? windowName(peak.minutes, peak.window || peak.name || '') : '',
    resetsAt: peak?.resetsAt ?? q.resetsAt ?? null,
    tight,
    observed: false,
    plentiful,
    tone
  }
}

export function activeWorkerIds(ticketsByProject) {
  const active = new Set()
  for (const list of Object.values(ticketsByProject || {})) {
    for (const tk of list || []) {
      if (isLiveWorking(tk) && tk.provider) active.add(tk.provider)
    }
  }
  return active
}

export function buildCrewTelemetry(roster, ticketsByProject) {
  const raw = roster?.workers ?? []
  const allowed = raw.filter(w => w.allowed)
  const pool = allowed.length ? allowed : raw.filter(w => w.installed && ['claude', 'codex', 'agy', 'cursor-agent'].includes(w.id))
  const workingSet = activeWorkerIds(ticketsByProject)
  const defaultId = roster?.defaultWorker || ''

  return pool.map(w => {
    const info = workerQuotaInfo(w)
    const isWorking = workingSet.has(w.id)
    const isDefault = w.id === defaultId
    const isReady = Boolean(w.installed && (w.loginStatus === 'ready' || w.loginStatus === 'not-required'))
    let priority = 0
    if (info.tight || info.observed) priority = 3
    else if (isWorking) priority = 2
    else if (isDefault || info.plentiful || isReady) priority = 1
    return {
      id: w.id,
      shortName: compactProvider(w.id),
      worker: w,
      isWorking,
      isDefault,
      isReady,
      priority,
      ...info
    }
  }).sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority
    const au = a.usedPercent ?? -1
    const bu = b.usedPercent ?? -1
    if (bu !== au) return bu - au
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1
    return a.id.localeCompare(b.id)
  })
}

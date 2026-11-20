import { formatShortTime, resolvedTimeZone } from './time.mjs'

const iso = seconds => Number.isSafeInteger(seconds) ? new Date(seconds * 1000).toISOString() : null
const resetIso = value => typeof value === 'string' && value && Number.isFinite(Date.parse(value)) ? value : iso(value)

function windowMinutes(value) {
  if (Number.isSafeInteger(value) && value > 0) return value
  if (typeof value !== 'string') return null
  const clean = value.trim().toLowerCase()
  if (clean === 'weekly' || clean === 'week') return 10080
  if (clean === 'daily') return 1440
  const match = /^(\d+)([mhd])$/.exec(clean)
  if (!match) return null
  const amount = Number(match[1])
  return match[2] === 'h' ? amount * 60 : match[2] === 'd' ? amount * 1440 : amount
}

export function codexQuota(snapshot, allowed = null) {
  if (!snapshot || typeof snapshot !== 'object') return null
  const windows = [snapshot.primary, snapshot.secondary].filter(w => w && Number.isFinite(w.usedPercent)).map(w => ({
    minutes: Number.isSafeInteger(w.windowDurationMins) ? w.windowDurationMins : null, usedPercent: w.usedPercent, resetsAt: iso(w.resetsAt)
  }))
  const reached = !!snapshot.rateLimitReachedType || allowed === false || windows.some(w => w.usedPercent >= 100)
  const avoid = reached || windows.some(w => w.usedPercent >= 90)
  const plentiful = !avoid && windows.length > 0 && windows.every(w => w.usedPercent <= 25)
  return { source: 'native', plan: snapshot.planType ?? null, windows, reached, avoid: Boolean(avoid), plentiful, at: new Date().toISOString() }
}

export function agyQuota(usageData) {
  if (!usageData || typeof usageData !== 'object') return null
  if (usageData.status && usageData.status !== 'SUCCESS') return null
  const data = usageData.command?.data ?? usageData.data ?? usageData
  if (!data || typeof data !== 'object' || !Array.isArray(data.groups) || !data.groups.length) return null
  const groups = data.groups.filter(g => g && typeof g === 'object').map(group => {
    const buckets = (Array.isArray(group.buckets) ? group.buckets : [])
      .filter(b => b && Number.isFinite(b.remaining_fraction))
      .map(b => {
        const usedPercent = Math.min(100, Math.max(0, Math.round((1 - b.remaining_fraction) * 1000) / 10))
        return {
          ...(b.id ? { id: b.id } : {}),
          ...(b.name ? { name: b.name } : {}),
          ...(b.window ? { window: b.window } : {}),
          minutes: windowMinutes(b.window),
          usedPercent,
          remainingFraction: b.remaining_fraction,
          resetsAt: resetIso(b.reset_time)
        }
      })
      .sort((a, b) => (a.minutes ?? Number.MAX_SAFE_INTEGER) - (b.minutes ?? Number.MAX_SAFE_INTEGER))
    return { name: group.name ?? '', windows: buckets }
  }).filter(g => g.windows.length > 0)
  if (!groups.length) return null
  const primary = groups.find(g => g.name === 'Gemini Models') ?? groups.find(g => /gemini/i.test(g.name)) ?? groups[0]
  const duplicateMinutes = new Set(primary.windows.map(w => w.minutes)).size < primary.windows.length
  const windows = primary.windows.map(({ id, name, minutes, usedPercent, resetsAt }) => {
    const win = {
      ...(duplicateMinutes && id ? { id } : {}),
      ...(duplicateMinutes && name ? { name } : {}),
      minutes,
      usedPercent,
      resetsAt
    }
    if (!duplicateMinutes) {
      if (id) Object.defineProperty(win, 'id', { value: id, enumerable: false })
      if (name) Object.defineProperty(win, 'name', { value: name, enumerable: false })
    }
    return win
  })
  const tightGroups = groups
    .filter(g => g !== primary && g.windows.some(w => w.usedPercent >= 90))
    .map(g => ({
      name: g.name || 'Secondary models',
      reached: g.windows.some(w => w.usedPercent >= 100),
      windows: g.windows.filter(w => w.usedPercent >= 90).map(({ id, name, minutes, usedPercent, resetsAt }) => ({
        ...(id ? { id } : {}),
        ...(name ? { name } : {}),
        minutes,
        usedPercent,
        resetsAt
      }))
    }))
  const reached = windows.some(w => w.usedPercent >= 100)
  const avoid = reached || windows.some(w => w.usedPercent >= 90)
  const plentiful = !avoid && tightGroups.length === 0 && windows.length > 0 && windows.every(w => w.usedPercent <= 25)
  return {
    source: 'native',
    plan: null,
    windows,
    groups,
    reached,
    avoid: Boolean(avoid),
    plentiful,
    ...(tightGroups.length ? { tightGroups } : {}),
    at: new Date().toISOString()
  }
}

export function windowLabel(minutes) {
  if (minutes === 10080) return 'week'
  if (minutes && minutes % 1440 === 0) return minutes / 1440 + 'd'
  if (minutes && minutes % 60 === 0) return minutes / 60 + 'h'
  return minutes ? minutes + 'm' : 'window'
}

export const tight = quota => !!quota && Boolean(quota.avoid || quota.reached || quota.windows?.some(w => w.usedPercent >= 90))

function secondaryTightGroups(quota) {
  if (Array.isArray(quota?.tightGroups)) return quota.tightGroups
  if (!Array.isArray(quota?.groups) || quota.groups.length < 2) return []
  const primary = quota.groups.find(g => g.name === 'Gemini Models') ?? quota.groups.find(g => /gemini/i.test(g.name)) ?? quota.groups[0]
  return quota.groups
    .filter(g => g !== primary && Array.isArray(g.windows) && g.windows.some(w => w.usedPercent >= 90))
    .map(g => ({
      name: g.name || 'Secondary models',
      windows: g.windows.filter(w => w.usedPercent >= 90)
    }))
}

export function quotaText(quota, { unreported = false } = {}) {
  if (!quota) return unreported ? 'quota=unreported (CLI does not report usage)' : 'quota=unknown'
  if (quota.source === 'observed') return 'quota=observed: ' + quota.class + ' at ' + formatShortTime(quota.at) + (quota.resetsAt ? ', expected back ' + formatShortTime(quota.resetsAt) : '') + ' (' + resolvedTimeZone() + ') · 先别派 / avoid'
  const wins = Array.isArray(quota.windows) ? quota.windows : []
  const dup = new Set(wins.map(w => w.minutes)).size < wins.length
  const parts = wins.map(w => (dup && (w.name || w.id) ? (w.name || w.id) + ' ' : '') + windowLabel(w.minutes) + ' ' + w.usedPercent + '% used' + (w.resetsAt ? ' (resets ' + formatShortTime(w.resetsAt) + ')' : ''))
  const secondary = secondaryTightGroups(quota).map(g => {
    const detail = g.windows.map(w => windowLabel(w.minutes) + ' ' + w.usedPercent + '% used' + (w.resetsAt ? ' (resets ' + formatShortTime(w.resetsAt) + ')' : '')).join(' · ')
    return g.name + ': ' + detail + ' (先别派该组 / avoid group)'
  })
  const avoid = tight(quota)
  const ample = !avoid && secondary.length === 0 && (quota.plentiful ?? (wins.length > 0 && wins.every(w => w.usedPercent <= 25)))
  return 'quota=' + (parts.join(' · ') || 'no windows reported') + (secondary.length ? ' · ' + secondary.join(' · ') : '') + (avoid ? ' · 先别派 / avoid' : ample ? ' · 额度宽裕，可调高并发 / plenty of quota' : '')
}

import { t, lang } from './i18n.svelte.js'

function validTimeZone(candidate) {
  if (!candidate || typeof candidate !== 'string') return undefined
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate })
    return candidate
  } catch {
    return undefined
  }
}

function parseDate(value) {
  if (value === null || value === undefined || value === '') return null
  const d = typeof value === 'number' ? new Date(value) : new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

export function localTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

export function tzLabel(value = Date.now(), timeZone) {
  const d = parseDate(value) || new Date()
  const tz = validTimeZone(timeZone)
  try {
    const opts = { timeZoneName: 'shortOffset' }
    if (tz) opts.timeZone = tz
    const raw = new Intl.DateTimeFormat('en-US', opts)
      .formatToParts(d)
      .find(p => p.type === 'timeZoneName')?.value || ''
    if (!raw) return localTimeZone()
    if (raw === 'GMT' || raw === 'GMT+0' || raw === 'GMT-0') return 'UTC'
    return raw.replace(/^GMT/, 'UTC')
  } catch {
    return localTimeZone()
  }
}

export function localTime(value, { seconds = false, year = true, suffix = false, timeZone } = {}) {
  const d = parseDate(value)
  if (!d) return value ? String(value) : ''
  const tz = validTimeZone(timeZone)
  const opts = {
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }
  if (seconds) opts.second = '2-digit'
  if (tz) opts.timeZone = tz
  const raw = new Intl.DateTimeFormat('sv-SE', opts).format(d)
  const core = year ? raw : raw.slice(5)
  return suffix ? `${core} ${tzLabel(d, tz)}` : core
}

export function pickLocalTime(preferred, fallback, isoOrMs, opts) {
  if (preferred) return String(preferred)
  if (fallback) return String(fallback)
  return localTime(isoOrMs, opts)
}

export function duration(ms) {
  if (ms === null || ms === undefined || ms < 0) return '—'
  if (ms < 1000) return ms > 0 ? '<1s' : '0s'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  return `${h}h ${String(m % 60).padStart(2, '0')}m`
}

export function ago(iso, now = Date.now()) {
  const d = parseDate(iso)
  if (!d) return '—'
  const diff = Math.max(0, now - d.getTime())
  const s = Math.floor(diff / 1000)
  if (s < 45) return t('justNow')
  const units = [[86400, 'd', '天'], [3600, 'h', '小时'], [60, 'm', '分钟']]
  for (const [size, en, zh] of units) {
    if (s >= size) {
      const n = Math.floor(s / size)
      return lang.current === 'zh' ? `${n} ${zh}${t('ago')}` : `${n}${en} ${t('ago')}`
    }
  }
  return t('justNow')
}

export function shortAgo(iso, now = Date.now()) {
  const d = parseDate(iso)
  if (!d) return '—'
  const diff = Math.max(0, now - d.getTime())
  const s = Math.floor(diff / 1000)
  if (s < 45) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

export function clock(iso, timeZone) {
  const d = parseDate(iso)
  if (!d) return ''
  const tz = validTimeZone(timeZone)
  const opts = {
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }
  if (tz) opts.timeZone = tz
  return new Intl.DateTimeFormat('sv-SE', opts).format(d)
}

export function shortPath(p) {
  if (!p) return ''
  return p.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~').replace(/^[A-Z]:\\Users\\[^\\]+/i, '~')
}

export function compactInput(input) {
  if (!input) return ''
  const clean = String(input).trim()
  if (!clean.includes('/') && !clean.includes('\\')) return clean
  const parts = clean.split(/[/\\]/).filter(Boolean)
  return parts.length >= 2 ? parts.slice(-2).join('/') : (parts[0] || clean)
}

export function compactProvider(provider) {
  const raw = String(provider || '').trim()
  if (!raw) return ''
  const stripped = raw.replace(/^(?:pi|custom):/i, '')
  const shortened = stripped.replace(/-(?:coding(?:-cn)?|api|cn)$/i, '')
  return shortened || stripped
}

export function compactModel(provider, model) {
  const rawP = String(provider || '').trim()
  const rawM = String(model || '').trim()
  const pFull = rawP.replace(/^(?:pi|custom):/i, '')
  const pShort = compactProvider(rawP)
  const mLeaf = rawM.includes('/') ? rawM.split('/').pop() : rawM
  if (!pShort) return mLeaf
  if (!mLeaf || mLeaf.toLowerCase() === pShort.toLowerCase() || mLeaf.toLowerCase() === pFull.toLowerCase()) {
    return pShort
  }
  let mClean = mLeaf
  const roots = [pFull, pShort].filter(Boolean).sort((a, b) => b.length - a.length)
  for (const root of roots) {
    const prefix = root.toLowerCase() + '-'
    if (mClean.toLowerCase().startsWith(prefix) && mClean.length > prefix.length) {
      mClean = mClean.slice(prefix.length)
      break
    }
  }
  return `${pShort}/${mClean}`
}

export function compactBranch(branch) {
  if (!branch) return ''
  let clean = String(branch).trim()
  clean = clean.replace(/^refs\/heads\//, '')
  clean = clean.replace(/^(?:cc-bro|broco)\//, '')
  const strippedHash = clean.replace(/-[0-9a-f]{6,12}$/i, '')
  return strippedHash || clean
}

export function meterSegments(usedPercent, count = 10) {
  const n = Number.isInteger(count) && count > 0 ? count : 10
  if (usedPercent === null || usedPercent === undefined || !Number.isFinite(Number(usedPercent))) {
    return { filled: 0, tone: 'muted', percent: null, cells: Array.from({ length: n }, () => false) }
  }
  const pct = Math.max(0, Math.min(100, Number(usedPercent)))
  const filled = pct <= 0 ? 0 : Math.min(n, Math.max(1, Math.round((pct / 100) * n)))
  const tone = pct >= 85 ? 'err' : pct >= 60 ? 'warn' : 'ok'
  return {
    filled,
    tone,
    percent: Math.round(pct),
    cells: Array.from({ length: n }, (_, i) => i < filled)
  }
}

export function isLiveWorking(ticket) {
  return Boolean(ticket && ticket.status === 'working' && !ticket.flag)
}

export function liveElapsed(ticket, now) {
  if (isLiveWorking(ticket) && ticket.startedAt) {
    return Math.max(ticket.elapsedMs || 0, now - new Date(ticket.startedAt).getTime())
  }
  return ticket?.elapsedMs ?? 0
}

export function windowName(minutes, fallbackLabel = '') {
  if (minutes === 10080) return t('week')
  if (Number.isFinite(minutes) && minutes > 0) {
    if (minutes % 1440 === 0) return (minutes / 1440) + (lang.current === 'zh' ? '天' : 'd')
    if (minutes % 60 === 0) return (minutes / 60) + 'h'
    return minutes + 'm'
  }
  return fallbackLabel || t('quotaWindow')
}

export function formatSpent(quota) {
  const spent = quota?.spent
  if (!Array.isArray(spent) || !spent.length) return ''
  const active = spent.filter(s => Number.isFinite(s.percent) && s.percent > 0)
  const list = active.length ? active : spent.filter(s => Number.isFinite(s.percent))
  if (!list.length) return ''
  return list.map(s => `${windowName(s.minutes)} +${Math.round(s.percent * 10) / 10}%`).join(' · ')
}

export function timelineCategory(kind) {
  if (!kind) return 'info'
  if (kind === 'bro.error' || kind.endsWith('.error') || kind === 'error') return 'error'
  if (kind === 'bro.stopped' || kind === 'bro.stop' || kind === 'stopped') return 'stopped'
  if (kind === 'bro.done' || kind === 'bro.accepted') return 'done'
  if (kind === 'bro.say' || kind === 'bro.interjection') return 'prompt'
  if (kind.startsWith('tool') || kind.startsWith('item/') || kind.startsWith('item.')) return 'tool'
  return 'info'
}

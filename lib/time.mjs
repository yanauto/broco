function validTimeZone(candidate) {
  if (!candidate || typeof candidate !== 'string') return null
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate })
    return candidate
  } catch {
    return null
  }
}

export function resolvedTimeZone(timeZone) {
  return validTimeZone(timeZone)
    || validTimeZone(process.env.BROCO_TZ)
    || validTimeZone(process.env.TZ)
    || validTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone)
    || 'UTC'
}

export function formatDateTime(value = Date.now(), timeZone) {
  return new Date(value).toLocaleString('sv-SE', { timeZone: resolvedTimeZone(timeZone), hour12: false })
}

export function formatShortTime(value = Date.now(), timeZone) {
  return formatDateTime(value, timeZone).slice(5, 16)
}

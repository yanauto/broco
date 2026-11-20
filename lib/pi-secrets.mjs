export function secretsFrom(records, env) {
  const values = new Set(
    Object.entries(env ?? {})
      .filter(([name, value]) => /(?:API_KEY|AUTH_KEY|PRIVATE_KEY|SECRET|TOKEN|ACCESS_KEY|PASSWORD|PASSWD)$/i.test(name) && typeof value === 'string' && value)
      .map(([, v]) => v)
  )
  function visit(obj, inHeaders = false) {
    for (const [key, v] of Object.entries(obj ?? {})) {
      if (v && typeof v === 'object') visit(v, key === 'headers')
      if (typeof v !== 'string' || !v || (!inHeaders && !/^(key|apiKey|api-key|api_key|secret|secret_key|client_secret|password|access|refresh|id_token|access_token|refresh_token|authorization|proxy-authorization|x-api-key|cookie|set-cookie)$/i.test(key))) continue
      if (!v.startsWith('$')) values.add(v)
      for (const m of v.matchAll(/\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/g)) {
        const value = env?.[m[1] ?? m[2]]
        if (value) values.add(value)
      }
    }
  }
  for (const record of records ?? []) visit(record)
  return [...values].filter(v => v.length >= 4).sort((a, b) => b.length - a.length)
}

export function mask(text, secrets) {
  for (const secret of secrets) text = text.replaceAll(secret, '[redacted]')
  return text
}

export function redactKey(key) {
  return /^(authorization|proxy-authorization|x-api-key|api-key|api_key|apiKey|secret_key|client_secret|access_token|refresh_token|id_token|cookie|set-cookie)$/i.test(key)
}

export function parseRedactedJson(line, rawSecrets = []) {
  return JSON.parse(line, (key, value) => {
    if (redactKey(key)) return '[redacted]'
    if (typeof value === 'string' && value && rawSecrets.length) return mask(value, rawSecrets)
    return value
  })
}

export function redactStderr(stderr, env, extraSecrets = []) {
  if (!stderr) return ''
  const secrets = [...new Set([...secretsFrom([], env), ...extraSecrets].filter(v => typeof v === 'string' && v.length >= 4))].sort((a, b) => b.length - a.length)
  return mask(stderr, secrets)
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/(?:Bearer\s+|(?:api[_-]?key|auth[_-]?key|private[_-]?key|token|secret|password)\s*[=:]\s*)\S+/gi, '[redacted]')
    .replace(/\b[\w.+-]+@[\w.-]+\.[a-z]+\b/gi, '[account]')
    .trim()
    .slice(0, 1200)
}

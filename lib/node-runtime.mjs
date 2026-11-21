export const MIN_NODE_MAJOR = 22
export const MIN_NODE_MINOR = 13
export const MIN_NODE_PATCH = 0
export const MIN_NODE_VERSION = '22.13.0'

const SILENCED = Symbol.for('broco.sqliteWarningSilenced')

export function parseNodeVersion(version = process.versions.node) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version || '').trim())
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3])
  }
}

export function isSupportedNodeVersion(version = process.versions.node) {
  const parsed = parseNodeVersion(version)
  if (!parsed) return false
  if (parsed.major !== MIN_NODE_MAJOR) return parsed.major > MIN_NODE_MAJOR
  if (parsed.minor !== MIN_NODE_MINOR) return parsed.minor > MIN_NODE_MINOR
  return parsed.patch >= MIN_NODE_PATCH
}

export function unsupportedNodeMessage(version = process.versions.node) {
  const current = String(version || 'unknown').trim().replace(/^v/, '')
  return [
    'broco requires Node.js ' + MIN_NODE_VERSION + '+ (found v' + current + ').',
    'Install broco with a bundled Node runtime using the one-line installer:',
    '  macOS / Linux:       curl -fsSL https://broco.yanauto.me/install.sh | sh',
    '  Windows PowerShell:  irm https://broco.yanauto.me/install.ps1 | iex',
    'Or upgrade Node.js to ' + MIN_NODE_VERSION + '+ and retry.'
  ].join('\n')
}

export function assertSupportedNode(version = process.versions.node, argv = process.argv.slice(2)) {
  if (isSupportedNodeVersion(version)) return
  const msg = unsupportedNodeMessage(version)
  if (argv.includes('--json')) {
    process.stdout.write(JSON.stringify({ error: msg }) + '\n')
  }
  process.stderr.write(msg + '\n')
  process.exit(1)
}

export function isSqliteExperimentalWarning(warning, type) {
  const name = typeof type === 'string'
    ? type
    : (type && typeof type === 'object' && typeof type.type === 'string'
      ? type.type
      : (warning && typeof warning === 'object' ? warning.name : ''))
  const message = typeof warning === 'string'
    ? warning
    : (warning && typeof warning === 'object' && typeof warning.message === 'string' ? warning.message : '')
  return name === 'ExperimentalWarning' && /\bsqlite\b/i.test(message)
}

export function silenceSqliteExperimentalWarning(proc = process) {
  if (proc[SILENCED]) return
  const original = proc.emitWarning
  if (typeof original !== 'function') return
  proc.emitWarning = function emitWarning(warning, ...rest) {
    if (isSqliteExperimentalWarning(warning, rest[0])) return
    return original.call(this, warning, ...rest)
  }
  proc[SILENCED] = true
}

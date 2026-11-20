import { realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export function expandHome(value) {
  if (typeof value !== 'string') return value
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

export function directory(path, label = 'Working directory') {
  if (typeof path !== 'string' || !path.trim()) throw new Error(label + ' must not be empty')
  const expanded = expandHome(path)
  try {
    const cwd = realpathSync.native(expanded)
    if (!statSync(cwd).isDirectory()) throw new Error(label + ' must be a directory: ' + path)
    return cwd
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(label + ' does not exist: ' + path)
    if (err.code === 'ENOTDIR') throw new Error(label + ' must be a directory: ' + path)
    if (['EACCES', 'EPERM'].includes(err.code)) throw new Error(label + ' is not accessible: ' + path)
    throw err
  }
}

export function directoryOption(value, flag) {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (!trimmed) throw new Error(flag + ' must not be empty')
  return directory(resolve(expandHome(trimmed)), flag)
}

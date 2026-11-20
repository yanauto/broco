import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repo = fileURLToPath(new URL('../', import.meta.url))

export function canonical(path) {
  if (existsSync(path)) return realpathSync.native(path)
  const parent = dirname(path)
  if (parent === path) return path
  return join(canonical(parent), basename(path))
}

function normalizeComparePath(p) {
  if (typeof p !== 'string' || !p) return ''
  try { return canonical(resolve(p)).toLowerCase() }
  catch { return resolve(p).toLowerCase() }
}

function stripTrailingSep(p) {
  return dirname(p) === p ? p : p.endsWith(sep) ? p.slice(0, -1) : p
}

export function samePath(a, b) {
  if (process.platform !== 'win32') return a === b
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (stripTrailingSep(a.toLowerCase()) === stripTrailingSep(b.toLowerCase())) return true
  return stripTrailingSep(normalizeComparePath(a)) === stripTrailingSep(normalizeComparePath(b))
}

export function isWithinPath(child, root) {
  if (process.platform !== 'win32') {
    const prefix = root.endsWith(sep) ? root : root + sep
    return child === root || child.startsWith(prefix)
  }
  if (typeof child !== 'string' || typeof root !== 'string') return false
  const check = (c, r) => {
    const cl = stripTrailingSep(c.toLowerCase())
    const rl = stripTrailingSep(r.toLowerCase())
    const prefix = rl.endsWith(sep) ? rl : rl + sep
    return cl === rl || cl.startsWith(prefix)
  }
  if (check(child, root)) return true
  return check(normalizeComparePath(child), normalizeComparePath(root))
}

export const personalPi = canonical(join(homedir(), '.pi'))
export const checkout = existsSync(join(repo, '.git'))
export const home = canonical(resolve(process.env.BROCO_HOME || join(homedir(), '.broco')))
if (isWithinPath(home, personalPi) || isWithinPath(personalPi, home) || dirname(home) === home) {
  throw new Error('Choose a broco data directory separate from the personal pi profile.')
}

export function legacyCcBroHome(env = process.env) {
  return canonical(resolve(env?.CC_BRO_HOME || join(homedir(), '.cc-bro')))
}

const sandbox = canonical(join(repo, '.sandbox'))
export const isolated = isWithinPath(home, sandbox)
export const toolsPath = isolated ? [join(home, 'tools', 'bin'), process.env.PATH].filter(Boolean).join(delimiter) : (process.env.PATH ?? '')

function ensureSecureDir(dir, uid) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const st = lstatSync(dir)
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== uid) {
    throw new Error('Unsafe socket directory ownership: ' + dir)
  }
  if ((st.mode & 0o077) !== 0) {
    chmodSync(dir, 0o700)
    if ((lstatSync(dir).mode & 0o077) !== 0) {
      throw new Error('Unsafe socket directory permissions: ' + dir)
    }
  }
  return dir
}

export function socketFor(dir) {
  const resolved = canonical(resolve(dir))
  const keySource = process.platform === 'win32' ? resolved.toLowerCase() : resolved
  const key = createHash('sha256').update(keySource).digest('hex').slice(0, 24)
  if (process.platform === 'win32') return '\\\\.\\pipe\\broco-' + key
  const uid = process.getuid()
  const sockName = 's-' + key + '.sock'
  try {
    const runtimeDir = ensureSecureDir(join('/tmp', 'broco-sock-' + uid), uid)
    return join(runtimeDir, sockName)
  } catch (err) {
    const direct = join(resolved, sockName)
    if (Buffer.byteLength(direct) < 96) {
      ensureSecureDir(resolved, uid)
      return direct
    }
    throw err
  }
}

export const socketPath = socketFor(home)

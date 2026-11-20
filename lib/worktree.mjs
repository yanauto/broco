import { execFile, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync } from 'node:fs'
import { lstat as lstatAsync } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

function git(cwd, ...args) {
  return execFileSync('git', ['--no-optional-locks', '-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 })
}

async function gitAsync(cwd, ...args) {
  const { stdout } = await exec('git', ['--no-optional-locks', '-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  return stdout
}

export function createTree(cwd, directory, name) {
  const prefix = git(cwd, 'rev-parse', '--show-prefix').trimEnd()
  if (prefix) git(cwd, 'cat-file', '-e', 'HEAD:' + prefix.slice(0, -1))
  const id = randomUUID()
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/^-|-$/g, '') || 'ticket'
  const branch = 'broco/' + slug + '-' + id.slice(0, 8)
  mkdirSync(join(directory, 'worktrees'), { recursive: true })
  const worktree = join(directory, 'worktrees', id)
  git(cwd, 'worktree', 'add', '-q', '-b', branch, worktree, 'HEAD')
  return { branch, worktree, cwd: join(worktree, prefix) }
}

export function verifyTree(cwd, branch) {
  if (git(cwd, 'symbolic-ref', '--short', 'HEAD').trimEnd() !== branch) throw new Error('Ticket worktree is no longer on ' + branch)
}

function buildFileMap(trackedOut, stagedOut, untrackedOut) {
  const files = new Map()
  const tracked = trackedOut.split('\0')
  for (let i = 0; i + 1 < tracked.length; i += 2) files.set(tracked[i + 1], [tracked[i], null])
  const staged = stagedOut.split('\0')
  for (let i = 0; i + 1 < staged.length; i += 2) {
    const path = staged[i + 1], entry = staged[i]
    files.set(path, [files.get(path)?.[0] ?? entry.split(' ').at(-1), entry])
  }
  for (const p of untrackedOut.split('\0').filter(Boolean)) files.set(p, ['A', files.get(p)?.[1] ?? null])
  return files
}

function snapshot(cwd, base) {
  const diff = (...args) => git(cwd, 'diff', '--no-ext-diff', '--relative', '--no-renames', '-z', ...args, base, '--', '.')
  const files = buildFileMap(
    diff('--name-status'),
    diff('--cached', '--raw', '--no-abbrev'),
    git(cwd, 'ls-files', '--others', '--exclude-standard', '-z', '--', '.')
  )
  return Object.fromEntries([...files].map(([p, [status, index]]) => {
    const s = lstatSync(join(cwd, p), { bigint: true, throwIfNoEntry: false })
    return [p, [status, s ? String(s.ctimeNs) : null, index]]
  }))
}

async function snapshotAsync(cwd, base) {
  const diff = (...args) => gitAsync(cwd, 'diff', '--no-ext-diff', '--relative', '--no-renames', '-z', ...args, base, '--', '.')
  const [trackedOut, stagedOut, untrackedOut] = await Promise.all([
    diff('--name-status'),
    diff('--cached', '--raw', '--no-abbrev'),
    gitAsync(cwd, 'ls-files', '--others', '--exclude-standard', '-z', '--', '.')
  ])
  const files = buildFileMap(trackedOut, stagedOut, untrackedOut)
  const entries = await Promise.all([...files].map(async ([p, [status, index]]) => {
    let ctime = null
    try {
      const s = await lstatAsync(join(cwd, p), { bigint: true })
      ctime = String(s.ctimeNs)
    } catch {}
    return [p, [status, ctime, index]]
  }))
  return Object.fromEntries(entries)
}

export function baseline(cwd) {
  try {
    let head
    try { head = git(cwd, 'rev-parse', '--verify', 'HEAD').trimEnd() }
    catch { head = git(cwd, 'hash-object', '-t', 'tree', '--stdin').trimEnd() }
    const branch = git(cwd, 'branch', '--show-current').trimEnd() || null
    return { head, branch, files: snapshot(cwd, head) }
  } catch { return null }
}

export function changes(cwd, before) {
  if (!before) return null
  try {
    const now = snapshot(cwd, before.head)
    return [...new Set([...Object.keys(before.files), ...Object.keys(now)])].sort()
      .filter(p => JSON.stringify(Object.hasOwn(now, p) ? now[p] : null) !== JSON.stringify(Object.hasOwn(before.files, p) ? before.files[p] : null))
      .map(path => {
        if (Object.hasOwn(now, path)) return { path, status: now[path][0] }
        const exists = lstatSync(join(cwd, path), { throwIfNoEntry: false })
        return { path, status: !exists ? 'D' : before.files[path][0] === 'D' ? 'A' : 'M' }
      })
  } catch { return null }
}

export async function changesAsync(cwd, before) {
  if (!before) return null
  try {
    const now = await snapshotAsync(cwd, before.head)
    const keys = [...new Set([...Object.keys(before.files), ...Object.keys(now)])].sort()
      .filter(p => JSON.stringify(Object.hasOwn(now, p) ? now[p] : null) !== JSON.stringify(Object.hasOwn(before.files, p) ? before.files[p] : null))
    return Promise.all(keys.map(async path => {
      if (Object.hasOwn(now, path)) return { path, status: now[path][0] }
      let exists = false
      try { await lstatAsync(join(cwd, path)); exists = true } catch {}
      return { path, status: !exists ? 'D' : before.files[path][0] === 'D' ? 'A' : 'M' }
    }))
  } catch { return null }
}

function untrackedPatch(cwd, relPath) {
  try {
    return execFileSync('git', ['--no-optional-locks', '-C', cwd, 'diff', '--no-ext-diff', '--no-index', '--', '/dev/null', relPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 4 * 1024 * 1024
    })
  } catch (err) {
    if (err.status === 1 && typeof err.stdout === 'string') return err.stdout
    return ''
  }
}

export function diffWorktree(cwd, before, { statOnly = false } = {}) {
  const parsed = typeof before === 'string' ? JSON.parse(before) : before
  let ref = parsed
  if (!ref) {
    try {
      const head = git(cwd, 'rev-parse', '--verify', 'HEAD').trimEnd()
      ref = { head, files: {} }
    } catch {
      return { baseHead: null, changedFiles: [], stat: '', patch: statOnly ? null : '' }
    }
  }
  const changedFiles = changes(cwd, ref) ?? []
  if (!changedFiles.length) {
    return { baseHead: ref.head, changedFiles: [], stat: '', patch: statOnly ? null : '' }
  }
  const untrackedSet = new Set(git(cwd, 'ls-files', '--others', '--exclude-standard', '-z', '--', '.').split('\0').filter(Boolean))
  const trackedPaths = changedFiles.map(f => f.path).filter(p => !untrackedSet.has(p))
  const untrackedPaths = changedFiles.map(f => f.path).filter(p => untrackedSet.has(p))

  const statParts = []
  if (trackedPaths.length) {
    const trackedStat = git(cwd, 'diff', '--no-ext-diff', '--relative', '--stat', ref.head, '--', ...trackedPaths).trimEnd()
    if (trackedStat) statParts.push(trackedStat)
  }
  for (const p of untrackedPaths) statParts.push(' ' + p + ' | new untracked file')
  const stat = statParts.join('\n')

  if (statOnly) return { baseHead: ref.head, changedFiles, stat, patch: null }

  const patchParts = []
  if (trackedPaths.length) {
    const trackedPatch = git(cwd, 'diff', '--no-ext-diff', '--relative', ref.head, '--', ...trackedPaths)
    if (trackedPatch) patchParts.push(trackedPatch.trimEnd())
  }
  for (const p of untrackedPaths) {
    const uPatch = untrackedPatch(cwd, p)
    if (uPatch) patchParts.push(uPatch.trimEnd())
  }
  const combined = patchParts.join('\n')
  const maxChars = 2 * 1024 * 1024
  const patch = combined.length > maxChars ? combined.slice(0, maxChars) + '\n... [diff truncated at 2 MiB]' : combined
  return { baseHead: ref.head, changedFiles, stat, patch }
}

export function cleanWorktrees(store, repoPath, { target = null, dryRun = false, deleteBranch = false, force = false } = {}) {
  let targetNames = null
  if (target !== null && target !== undefined) {
    const trimmed = String(target).trim()
    if (!trimmed) throw new Error('Invalid clean target')
    if (store.hasTable?.('batches')) {
      const batchRow = store.stmt('SELECT shards FROM batches WHERE prefix=?').get(trimmed)
      if (batchRow) targetNames = new Set(JSON.parse(batchRow.shards).map(s => s.name))
    }
    if (!targetNames) {
      const single = store.stmt('SELECT c.name, m.worktree FROM conversations c LEFT JOIN collaboration m ON m.cid=c.id WHERE c.name=?').get(trimmed)
      if (!single || !single.worktree) throw new Error('No worktree found for: ' + trimmed)
      targetNames = new Set([trimmed])
    }
  }

  const rows = store.stmt(`
    SELECT c.id AS cid, c.name, c.status AS conversationStatus, t.stage AS ticketStatus,
           m.worktree, m.branch
    FROM collaboration m
    JOIN conversations c ON c.id = m.cid
    JOIN tickets t ON t.cid = c.id
    WHERE m.worktree IS NOT NULL AND m.parent IS NULL
    ORDER BY t.created ASC, c.name ASC
  `).all()

  const cleaned = []
  const skipped = []

  for (const row of rows) {
    if (targetNames && !targetNames.has(row.name)) continue
    const activeSharing = store.stmt("SELECT c.name FROM collaboration m JOIN conversations c ON c.id=m.cid WHERE m.worktree=? AND c.status IN ('queued','running') LIMIT 1").get(row.worktree)
    if (['queued', 'running'].includes(row.conversationStatus) || activeSharing) {
      skipped.push({ name: row.name, worktree: row.worktree, branch: row.branch, reason: 'Ticket has active or queued work' })
      continue
    }
    if (!targetNames && !force && row.ticketStatus !== 'done') {
      skipped.push({ name: row.name, worktree: row.worktree, branch: row.branch, reason: 'Ticket is not closed with done (pass --force or name explicitly)' })
      continue
    }
    const exists = existsSync(row.worktree)
    if (exists && !force) {
      try {
        const dirty = git(row.worktree, 'status', '--porcelain').trim()
        if (dirty) {
          skipped.push({ name: row.name, worktree: row.worktree, branch: row.branch, reason: 'Worktree has uncommitted changes (pass --force to remove)' })
          continue
        }
      } catch {
        skipped.push({ name: row.name, worktree: row.worktree, branch: row.branch, reason: 'Could not inspect worktree git status (pass --force to remove)' })
        continue
      }
    }
    if (dryRun) {
      cleaned.push({ name: row.name, worktree: row.worktree, branch: row.branch, branchDeleted: Boolean(deleteBranch && row.branch), dryRun: true })
      continue
    }
    if (exists) {
      try {
        git(repoPath, 'worktree', 'remove', ...(force ? ['--force'] : []), row.worktree)
      } catch (err) {
        skipped.push({ name: row.name, worktree: row.worktree, branch: row.branch, reason: err.message.trim() })
        continue
      }
    } else {
      try { git(repoPath, 'worktree', 'prune') } catch {}
    }
    let branchDeleted = false
    let branchRetainedReason = null
    if (deleteBranch && row.branch) {
      try {
        git(repoPath, 'branch', force ? '-D' : '-d', row.branch)
        branchDeleted = true
      } catch {
        branchRetainedReason = 'Branch is not merged (pass --force to delete)'
      }
    }
    store.transaction(() => {
      if (branchDeleted) store.stmt('UPDATE collaboration SET worktree=NULL,branch=NULL WHERE worktree=?').run(row.worktree)
      else store.stmt('UPDATE collaboration SET worktree=NULL WHERE worktree=?').run(row.worktree)
      store.changed(row.cid)
    })
    cleaned.push({
      name: row.name,
      worktree: row.worktree,
      branch: row.branch,
      branchDeleted,
      ...(branchRetainedReason ? { branchRetainedReason } : {}),
      dryRun: false
    })
  }

  return { cleaned, skipped }
}

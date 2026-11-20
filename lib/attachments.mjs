import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'

const types = {
  '.png': ['image', 'image/png'],
  '.jpg': ['image', 'image/jpeg'],
  '.jpeg': ['image', 'image/jpeg'],
  '.gif': ['image', 'image/gif'],
  '.webp': ['image', 'image/webp'],
  '.mp3': ['audio', 'audio/mpeg'],
  '.wav': ['audio', 'audio/wav'],
  '.m4a': ['audio', 'audio/mp4'],
  '.ogg': ['audio', 'audio/ogg'],
  '.flac': ['audio', 'audio/flac'],
  '.aac': ['audio', 'audio/aac'],
  '.mp4': ['video', 'video/mp4'],
  '.mov': ['video', 'video/quicktime'],
  '.webm': ['video', 'video/webm'],
  '.mkv': ['video', 'video/x-matroska'],
  '.pdf': ['pdf', 'application/pdf']
}

export function describeAttachments(paths = []) {
  if (!Array.isArray(paths) || paths.length > 8) throw new Error('Use at most 8 attachments')
  let total = 0
  return paths.map(path => {
    if (typeof path !== 'string') throw new Error('Expected an attachment path')
    const type = types[extname(path).toLowerCase()]
    if (!type) throw new Error('Unsupported attachment file type')
    const info = statSync(path)
    if (!info.isFile() || info.size > 20 * 1024 * 1024 || info.size === 0) throw new Error('Attachment must be a nonempty file up to 20 MiB')
    total += info.size
    if (total > 32 * 1024 * 1024) throw new Error('Attachments exceed 32 MiB')
    return { path, kind: type[0], mimeType: type[1], name: basename(path) }
  })
}

export function snapshotAttachments(files, directory) {
  if (!files?.length) return []
  const dir = join(directory, 'attachments')
  mkdirSync(dir, { recursive: true })
  return files.map(file => {
    const bytes = readFileSync(file.path)
    if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error('Attachment changed before dispatch')
    const path = join(dir, createHash('sha256').update(bytes).digest('hex') + extname(file.path).toLowerCase())
    if (!existsSync(path)) writeFileSync(path, bytes, { mode: 0o600 })
    return { ...file, path }
  })
}

export function piImages(files = []) {
  return files.map(file => {
    if (file.kind !== 'image') throw new Error('pi RPC only supports image attachments')
    return { type: 'image', mimeType: file.mimeType, data: readFileSync(file.path, 'base64') }
  })
}

export function attachmentDirs(files = []) {
  return [...new Set((files ?? []).map(f => dirname(f.path)))]
}

export function formatAttachmentPrompt(text, files = [], toolName = 'read_file') {
  if (!files?.length) return text
  return 'Attached files (inspect directly with ' + toolName + '):\n' +
    files.map(f => '- [' + (f.kind || 'file') + '] ' + (f.name || basename(f.path)) + ': ' + f.path).join('\n') +
    '\n\n' + text
}

export function claudeAttachments(files = []) {
  for (const file of files ?? []) {
    if (file.kind !== 'image' && file.kind !== 'pdf') throw new Error('claude only supports image and pdf attachments')
  }
  return files ?? []
}

export function gcAttachments(store, { dryRun = false } = {}) {
  const dir = join(store.directory, 'attachments')
  if (!existsSync(dir)) return { removed: 0, freedBytes: 0, files: [] }
  const referenced = new Set()
  for (const row of store.stmt('SELECT execution FROM turns WHERE execution IS NOT NULL').all()) {
    try {
      const parsed = JSON.parse(row.execution)
      for (const att of parsed?.attachments ?? []) {
        if (typeof att?.path === 'string') {
          referenced.add(att.path)
          referenced.add(basename(att.path))
        }
      }
    } catch {}
  }
  const files = []
  let freedBytes = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    const full = join(dir, entry.name)
    if (referenced.has(full) || referenced.has(entry.name)) continue
    const size = statSync(full, { throwIfNoEntry: false })?.size ?? 0
    if (!dryRun) rmSync(full, { force: true })
    freedBytes += size
    files.push(full)
  }
  return { removed: files.length, freedBytes, files }
}

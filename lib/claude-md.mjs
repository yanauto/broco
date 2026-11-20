import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

export const START_MARKER = '<!-- broco:start -->'
export const END_MARKER = '<!-- broco:end -->'
export const SUPPORTED_HOSTS = ['auto', 'agents', 'claude', 'codex', 'cursor', 'agy', 'opencode', 'pi']

function normalizeHost(host) {
  if (host === undefined || host === null || host === '') return 'auto'
  const clean = String(host).trim().toLowerCase()
  if (!SUPPORTED_HOSTS.includes(clean)) {
    throw new Error('Invalid --host value: ' + host + ' (expected ' + SUPPORTED_HOSTS.join(', ') + ')')
  }
  return clean
}

export function resolveAgentsDocPath(repoPath, { host } = {}) {
  const mode = normalizeHost(host)
  const agentsPath = join(repoPath, 'AGENTS.md')
  const claudePath = join(repoPath, 'CLAUDE.md')
  if (mode === 'claude') return claudePath
  if (mode !== 'auto') return agentsPath
  if (existsSync(agentsPath)) return agentsPath
  if (existsSync(claudePath)) return claudePath
  return agentsPath
}

export function agentsMdBlock({ managerMode = false } = {}) {
  if (managerMode) {
    return [
      START_MARKER,
      '## broco Manager Mode',
      '',
      'In this repository you operate as the **manager** coordinating worker agents through `broco` rather than doing heavy implementation yourself:',
      '',
      '- **Check status, roster & quota before dispatching**: Run `broco status --json` and `broco roster --json` (or `broco roster`) to see active work, allowed workers, available models, capabilities, and live quota.',
      '- **Delegate implementation, research & reviews**:',
      '  - Single task or follow-up: `broco say <name> "<prompt>"` or multi-line via file/stdin `broco say <name> --file <path|-> [--worker <id>] [--model <id>] [--effort <level>] [--worktree] [--bg] [--json]`',
      '  - Bulk / sharded tasks: `broco map <prefix> --brief <text-or-file> --inputs <item>... [--worker <id>] [--bg] [--json]`',
      '  - Cross-vendor review: `broco review <name> [--by <other-worker>] [--bg] [--json]`',
      '  - Inspect, retry & collect: `broco ls --active`, `broco show <name>`, `broco diff <name>`, `broco wait <name> [turn]`, `broco retry <name-or-prefix>`',
      '- **Adjust configuration directly**: Tune project settings via `broco` config commands (`broco set concurrency <n>`, `broco allow ...`, `broco defaults <worker> --model <id> --effort <level>`, `broco rules ...`, `broco note <worker> "<note>"`, `broco undo` to revert).',
      '- **Verify, close & clean worktrees**: Inspect `broco diff <name>` and run checks before closing with `broco done <name> --result pass|rework|fail|blocked [--why "<reason>"]`, then prune finished worktrees with `broco clean`.',
      END_MARKER
    ].join('\n')
  }
  return [
    START_MARKER,
    '## broco On-Demand Crew',
    '',
    'In this repository you can summon other logged-in coding CLIs through `broco` when it genuinely helps. Handle quick edits and same-vendor questions yourself; reach for `broco` when your quota is tight, you want an independent cross-vendor worktree review, you need a modality you lack (image/audio/video/PDF), or you have sharded `map` batch work:',
    '',
    '- **Check status, roster & quota**: Run `broco status --json` and `broco roster --json` (or `broco roster`) to see active work, allowed workers, available models, capabilities, and live quota.',
    '- **Summon a worker when needed**:',
    '  - Single task or follow-up: `broco say <name> "<prompt>"` or multi-line via file/stdin `broco say <name> --file <path|-> [--worker <id>] [--model <id>] [--effort <level>] [--worktree] [--bg] [--json]`',
    '  - Bulk / sharded tasks: `broco map <prefix> --brief <text-or-file> --inputs <item>... [--worker <id>] [--bg] [--json]`',
    '  - Cross-vendor review (omitting `--by` auto-picks another vendor): `broco review <name> [--by <other-worker>] [--bg] [--json]`',
    '  - Inspect, retry & collect: `broco ls --active`, `broco show <name>`, `broco diff <name>`, `broco wait <name> [turn]`, `broco retry <name-or-prefix>`',
    '- **Verify, close & clean**: Inspect `broco diff <name>`, record `broco done <name> --result pass|rework|fail|blocked [--why "<reason>"]`, and prune finished worktrees with `broco clean`.',
    END_MARKER
  ].join('\n')
}

export function claudeMdBlock(opts) {
  return agentsMdBlock(opts)
}

export function ensureAgentsMd(repoPath, opts = {}) {
  const managerMode = Boolean(opts?.managerMode)
  const path = resolveAgentsDocPath(repoPath, opts)
  const file = basename(path)
  const mode = managerMode ? 'manager' : 'on-demand'
  const block = agentsMdBlock({ managerMode })
  if (!existsSync(path)) {
    writeFileSync(path, block + '\n')
    return { path, file, mode, action: 'created' }
  }
  const existing = readFileSync(path, 'utf8')
  const start = existing.indexOf(START_MARKER)
  const end = start >= 0 ? existing.indexOf(END_MARKER, start + START_MARKER.length) : -1
  if (start === -1 || end === -1) {
    const prefix = !existing ? '' : existing.endsWith('\n\n') ? existing : existing.endsWith('\n') ? existing + '\n' : existing + '\n\n'
    writeFileSync(path, prefix + block + '\n')
    return { path, file, mode, action: 'appended' }
  }
  const afterPos = end + END_MARKER.length
  if (existing.slice(start, afterPos) === block) return { path, file, mode, action: 'unchanged' }
  writeFileSync(path, existing.slice(0, start) + block + existing.slice(afterPos))
  return { path, file, mode, action: 'updated' }
}

export function ensureClaudeMd(repoPath, opts) {
  return ensureAgentsMd(repoPath, opts)
}

function stripMarkerFile(path) {
  const file = basename(path)
  if (!existsSync(path)) return { path, file, action: 'absent', removed: false }
  const existing = readFileSync(path, 'utf8')
  const start = existing.indexOf(START_MARKER)
  const end = start >= 0 ? existing.indexOf(END_MARKER, start + START_MARKER.length) : -1
  if (start === -1 || end === -1) return { path, file, action: 'unchanged', removed: false }
  const before = existing.slice(0, start)
  const after = existing.slice(end + END_MARKER.length)
  if (!(before + after).trim()) {
    rmSync(path, { force: true })
    return { path, file, action: 'deleted', removed: true }
  }
  const cleaned = !before.trim()
    ? after.replace(/^\r?\n+/, '')
    : !after.trim()
      ? before.replace(/(?:\r?\n){2,}$/, '\n')
      : before.replace(/(?:\r?\n)+$/, '') + '\n\n' + after.replace(/^\r?\n+/, '')
  writeFileSync(path, cleaned)
  return { path, file, action: 'stripped', removed: true }
}

export function removeAgentsMd(repoPath, opts = {}) {
  const mode = normalizeHost(opts?.host)
  if (mode === 'claude') return stripMarkerFile(join(repoPath, 'CLAUDE.md'))
  if (mode !== 'auto') return stripMarkerFile(join(repoPath, 'AGENTS.md'))
  const candidates = [join(repoPath, 'AGENTS.md'), join(repoPath, 'CLAUDE.md')]
  const results = candidates.map(stripMarkerFile)
  const removed = results.filter(r => r.removed)
  if (removed.length === 1) return removed[0]
  if (removed.length > 1) return { ...removed[0], alsoRemoved: removed.slice(1) }
  return results.find(r => r.action === 'unchanged') ?? results[0]
}

export function removeClaudeMd(repoPath, opts) {
  return removeAgentsMd(repoPath, opts)
}

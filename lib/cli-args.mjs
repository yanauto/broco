import { parseArgs } from 'node:util'

const MULTI_FLAGS = new Set(['attach', 'path', 'add', 'rm', 'input', 'inputs'])

const flags = {
  "cwd": ["dir", "Worker working directory for a new session; conflicts with --worktree"],
  "project": ["path", "Project root or subdirectory (works with or without broco init); defaults to the current directory"],
  "upstream": ["origin", "HTTP(S) upstream origin; no credentials, path or query"],
  "path": ["prefix", "Allowed path prefix on segment boundaries; repeatable"],
  "header": ["name", "Header to replace with the credential"],
  "value-env": ["name", "Read the credential from this environment variable; exclusive with --value-command"],
  "value-command": ["command", "Read credential from command stdout (10s timeout); never put a secret literal in the command"],
  "value-prefix": ["text", "Non-secret header prefix, for example 'Bearer '"],
  "max-requests": ["count", "Maximum forwarded requests, including upstream failures"],
  "ttl": ["seconds", "Lifetime in seconds (1–2147483); closes active streams at expiry"],
  "allow": ["worker,worker", "Allowed workers, separated by commas"],
  "default-worker": ["worker", "Default worker for this scope"],
  "concurrency": ["count", "Maximum concurrent active turns for this scope (1–64 or inherit)"],
  "host": ["name", "Target instructions file host for init/uninit (auto|agents|claude|codex|cursor|agy|opencode|pi)"],
  "manager-mode": [null, "Write heavy manager-mode instructions instead of lightweight on-demand crew guidance"],
  "no-agents-md": [null, "Skip creating, updating, or stripping AGENTS.md / CLAUDE.md"],
  "no-claude-md": [null, "Alias for --no-agents-md"],
  "migrate-cc-bro": [null, "Safely copy legacy ~/.cc-bro settings and SQLite data into ~/.broco without deleting ~/.cc-bro"],
  "yes": [null, "Confirm detected logged-in workers for the global allowlist without prompting"],
  "allow-nested": [null, "Allow dispatching from inside a broco worker session (disables recursion guard)"],
  "clear": [null, "Clear existing overrides in this scope"],
  "global": [null, "Target global defaults instead of a project"],
  "add": ["text", "Rule text to add; repeatable"],
  "rm": ["text", "Rule text to remove; repeatable"],
  "override": [null, "Override global rules instead of appending to them"],
  "limit": ["count", "Maximum entries to show"],
  "refresh": [null, "Bypass detection cache and re-probe allowed CLIs"],
  "file": ["path", "Read prompt text from a UTF-8 file (or '-' for stdin)"],
  "brief": ["text", "Batch prompt text or path to a .md/.txt/.prompt file"],
  "brief-file": ["path", "Read prompt text from a UTF-8 file (or '-' for stdin)"],
  "inputs": ["list", "Shard inputs (comma-separated or shell-expanded paths); repeatable"],
  "input": ["item", "Single shard input; repeatable"],
  "inputs-file": ["path", "Read shard inputs (non-empty lines or JSON array) from a file or '-'"],
  "active": [null, "Exclude closed (done) tickets"],
  "status": ["list", "Filter by comma-separated status values"],
  "flag": ["flag", "Filter by flag (error|stopped)"],
  "batch": ["prefix", "Filter tickets belonging to a batch prefix"],
  "compact": [null, "Omit full event timeline from show output"],
  "turn": ["number", "Inspect a specific turn number"],
  "stat": [null, "Show diffstat summary without full patch"],
  "dry-run": [null, "Preview worktrees and attachments that would be cleaned"],
  "delete-branch": [null, "Also delete the ticket branch after removing its worktree"],
  "force": [null, "Force cleanup of dirty, unclosed, or unmerged worktrees"],
  "json": [null, "Print JSON output"],
  "no-open": [null, "Print the board URL without opening a browser"],
  "worker": ["id", "Worker ID"],
  "full": [null, "Show full model metadata, variants, or full shard replies"],
  "new-task": [null, "Start an independent task after recording the current outcome; otherwise continue or rework the current task"],
  "task": ["number", "Task number from show; defaults to the current task"],
  "result": ["pass|rework|fail|blocked", "Outcome to record; inferred when omitted"],
  "why": ["text", "Reason for the outcome"],
  "by": ["worker", "Worker to perform the review; omit to auto-pick another vendor"],
  "model": ["id", "Exact model ID (or compact family ID) from the roster"],
  "effort": ["level", "Model effort level"],
  "bg": [null, "Return the dispatch receipt without waiting"],
  "attach": ["file", "Attach a file; may be repeated"],
  "worktree": [null, "Start the first message in an independent worktree"],
  "title": ["title", "Ticket or batch title"],
  "from": ["name", "Start a new name with an inactive session's title and latest completed reply, followed by your message"],
  "all": [null, "Show full message history, all projects in status, or all scopes in audit"]
}

export const commands = {
  "version": {
    "description": "Print the broco version and git commit",
    "positionals": [],
    "options": ["json"]
  },
  "status": {
    "description": "Show runner health, active/queued work, concurrency, and active proxies without starting an offline runner",
    "positionals": [],
    "options": ["project", "all", "json"]
  },
  "proxy-open": {
    "description": "Open a loopback credential proxy; requires upstream, path, header, one value source, max-requests and ttl",
    "positionals": [],
    "options": ["upstream", "path", "header", "value-env", "value-command", "value-prefix", "max-requests", "ttl", "json"]
  },
  "proxy-list": {
    "description": "List active credential proxies on this runner without credentials or source commands",
    "positionals": [],
    "options": ["json"]
  },
  "proxy-close": {
    "description": "Close a credential proxy and abort its active requests",
    "positionals": [["id", "Proxy ID from proxy-open or proxy-list"]],
    "options": ["json"]
  },
  "setup": {
    "description": "Install skills across detected hosts, inspect roster & quota, confirm global allowlist, or migrate ~/.cc-bro",
    "positionals": [],
    "options": ["allow", "default-worker", "yes", "migrate-cc-bro", "json"]
  },
  "init": {
    "description": "Register this project (L1), configure project policy, and update AGENTS.md (or CLAUDE.md)",
    "positionals": [],
    "options": ["project", "allow", "default-worker", "concurrency", "host", "manager-mode", "no-agents-md", "no-claude-md", "json"]
  },
  "uninit": {
    "description": "Unregister this project and remove .broco and the broco AGENTS.md / CLAUDE.md section",
    "positionals": [],
    "options": ["project", "host", "no-agents-md", "no-claude-md", "json"]
  },
  "ui": {
    "description": "Open the local board",
    "positionals": [],
    "options": ["no-open", "json"]
  },
  "roster": {
    "description": "Show models and project or global permissions",
    "positionals": [],
    "options": ["project", "global", "worker", "full", "refresh", "json"]
  },
  "defaults": {
    "description": "Set worker default model and/or effort immediately",
    "positionals": [["worker", "Worker ID"]],
    "options": ["model", "effort", "clear", "global", "project", "json"]
  },
  "note": {
    "description": "Set or clear a worker note immediately",
    "positionals": [["worker", "Worker ID"], ["text", "Worker note; omit when passing --clear", "optional"]],
    "options": ["clear", "global", "project", "json"]
  },
  "set": {
    "description": "Set concurrency or default-worker immediately",
    "positionals": [["key", "Setting key (concurrency|default-worker)"], ["value", "Setting value"]],
    "options": ["global", "project", "json"]
  },
  "allow": {
    "description": "Allow one or more comma-separated workers immediately",
    "positionals": [["workers", "Comma-separated worker IDs"]],
    "options": ["default-worker", "global", "project", "json"]
  },
  "deny": {
    "description": "Disallow one or more comma-separated workers immediately",
    "positionals": [["workers", "Comma-separated worker IDs"]],
    "options": ["global", "project", "json"]
  },
  "rules": {
    "description": "Show or update project, global, or per-worker rules",
    "positionals": [],
    "options": ["add", "rm", "clear", "worker", "override", "global", "project", "json"]
  },
  "hide": {
    "description": "Hide comma-separated model IDs or families for a worker",
    "positionals": [["worker", "Worker ID"], ["models", "Comma-separated model IDs or families"]],
    "options": ["global", "project", "json"]
  },
  "unhide": {
    "description": "Unhide comma-separated model IDs or families for a worker",
    "positionals": [["worker", "Worker ID"], ["models", "Comma-separated model IDs or families"]],
    "options": ["global", "project", "json"]
  },
  "audit": {
    "description": "List recent settings audit entries",
    "positionals": [],
    "options": ["global", "all", "project", "limit", "json"]
  },
  "undo": {
    "description": "Revert a settings change by audit ID (or the latest undoable change)",
    "positionals": [["id", "Audit ID to revert; defaults to latest undoable change", "optional"]],
    "options": ["global", "project", "json"]
  },
  "done": {
    "description": "Record a task outcome (or close ready shards in a batch); defaults to the current task",
    "positionals": [["name", "Session name or batch prefix"]],
    "options": ["task", "project", "result", "why", "json"]
  },
  "stats": {
    "description": "Show your per-task record grouped by bro and model across projects (or one project)",
    "positionals": [],
    "options": ["project", "json"]
  },
  "review": {
    "description": "Ask another worker to review a session (auto-picks another vendor when --by is omitted)",
    "positionals": [["name", "Session to review"]],
    "options": ["project", "by", "model", "effort", "bg", "allow-nested", "json"]
  },
  "say": {
    "description": "Send a message to a named worker session (inline, --file, or stdin)",
    "positionals": [["name", "Session name"], ["message", "Message text, or '-' for stdin; omit with --file or piped stdin", "optional"]],
    "options": ["file", "brief-file", "new-task", "project", "cwd", "attach", "worktree", "title", "from", "model", "effort", "worker", "bg", "allow-nested", "json"]
  },
  "retry": {
    "description": "Retry a failed or stopped session's last prompt (or failed/stopped shards in a batch)",
    "positionals": [["name", "Session name or batch prefix"]],
    "options": ["project", "model", "effort", "worker", "bg", "allow-nested", "json"]
  },
  "map": {
    "description": "Dispatch one brief across multiple shard inputs (<prefix>-1 .. <prefix>-N)",
    "positionals": [["prefix", "Batch prefix"], ["inputs", "Shard inputs or file paths", "variadic"]],
    "options": ["brief", "brief-file", "inputs", "input", "inputs-file", "project", "cwd", "worktree", "title", "model", "effort", "worker", "bg", "allow-nested", "json"]
  },
  "ls": {
    "description": "List tickets",
    "positionals": [],
    "options": ["active", "status", "flag", "batch", "limit", "project", "json"]
  },
  "show": {
    "description": "Show a session (or batch) and its result",
    "positionals": [["name", "Session name or batch prefix"]],
    "options": ["turn", "compact", "full", "status", "project", "all", "json"]
  },
  "diff": {
    "description": "Show tracked and untracked changes for a session relative to its base commit",
    "positionals": [["name", "Session name"]],
    "options": ["stat", "project", "json"]
  },
  "clean": {
    "description": "Remove retained git worktrees (and orphaned attachment snapshots) for finished tickets",
    "positionals": [["name", "Session name or batch prefix; omit to clean all done worktrees", "optional"]],
    "options": ["dry-run", "delete-branch", "force", "project", "json"]
  },
  "watch": {
    "description": "Watch session activity",
    "positionals": [],
    "options": ["project"]
  },
  "wait": {
    "description": "Wait for a session turn (defaults to latest) or a batch to finish",
    "positionals": [["name", "Session name or batch prefix"], ["turn", "Positive turn number; omit for latest turn or batch", "optional"]],
    "options": ["project", "json"]
  },
  "stop": {
    "description": "Stop a session (or batch) and verify its processes stopped",
    "positionals": [["name", "Session name or batch prefix"]],
    "options": ["project", "json"]
  },
  "shutdown": {
    "description": "Stop the runner, including running and queued work",
    "positionals": [],
    "options": ["json"]
  }
}

function formatPositional([key, , mode]) {
  if (mode === 'variadic') return '[' + key + '...]'
  if (mode === 'optional') return '[' + key + ']'
  return '<' + key + '>'
}

function usage(name) {
  const command = commands[name]
  return ['broco', name, ...command.positionals.map(formatPositional),
    ...command.options.map(key => '[--' + key + (flags[key][0] ? ' ' + flags[key][0] : '') + ']')].join(' ')
}

export function commandHelp(name) {
  const command = commands[name]
  return [usage(name), command.description, '',
    ...command.positionals.map(p => '  ' + formatPositional(p) + '  ' + p[1]),
    ...command.options.map(key => '  --' + key + (flags[key][0] ? ' ' + flags[key][0] : '') + '  ' + flags[key][1]),
    '  -h, --help  Show this command help'].join('\n')
}

export function helpText() {
  return Object.keys(commands).map(commandHelp).join('\n\n')
}

export function parseCommand(argv) {
  const [cmd, ...args] = argv
  if (!cmd || ['help', '--help', '-h'].includes(cmd)) return { help: helpText() }
  if (cmd === '--version' || cmd === '-v') {
    const { values: opt, positionals } = parseArgs({
      args,
      options: { json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
      allowPositionals: true
    })
    if (opt.help) return { help: commandHelp('version') }
    if (positionals.length) throw new Error(commandHelp('version'))
    return { cmd: 'version', opt, positionals: [] }
  }
  if (!Object.hasOwn(commands, cmd)) {
    throw new Error('Unknown command "' + cmd + '"; available: ' + Object.keys(commands).join(', ') + ' (run broco --help)')
  }
  const command = commands[cmd]
  const options = Object.fromEntries(command.options.map(key => [key, {
    type: flags[key][0] ? 'string' : 'boolean', ...(MULTI_FLAGS.has(key) ? { multiple: true } : {})
  }]))
  options.help = { type: 'boolean', short: 'h' }
  const { values: opt, positionals } = parseArgs({ args, options, allowPositionals: true })
  if (opt.help) return { help: commandHelp(cmd) }
  const min = command.positionals.filter(([, , mode]) => !mode).length
  const max = command.positionals.some(([, , mode]) => mode === 'variadic') ? Infinity : command.positionals.length
  if (positionals.length < min || positionals.length > max) throw new Error(commandHelp(cmd))
  return { cmd, opt, positionals }
}

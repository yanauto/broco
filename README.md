<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/yanauto/broco/main/assets/broco-readme-logo-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/yanauto/broco/main/assets/broco-readme-logo-light.png">
    <img src="https://raw.githubusercontent.com/yanauto/broco/main/assets/broco-readme-logo-light.png" alt="broco — Let your harnesses work together." width="520">
  </picture>
</p>

<p align="center">
  Formerly <code>opus-manager</code> (v0.4) · Apache-2.0 · <a href="README.zh-CN.md">中文</a> · <a href="https://broco.yanauto.me/">Website</a> · <a href="https://broco.yanauto.me/docs/">Docs</a> · <a href="CHANGELOG.md">Changelog</a>
</p>

**Let your harnesses work together.** Stay in whichever coding agent you already have open, and delegate to the rest on your machine — Claude Code, Codex, Cursor, Pi, OpenCode, and [Antigravity](https://broco.yanauto.me/docs/workers/#agy) (API/Enterprise). Run parallel git worktrees, ask another model family for a cold diff review, and route around 5-hour quota limits using your existing logins.

<p align="center">
  <a href="https://broco.yanauto.me/#watch">
    <img src="https://broco.yanauto.me/assets/media/broco-demo-preview-en.gif" alt="broco 32-second demo: never let an AI grade its own homework — cross-vendor blind review and quota-aware routing" width="760">
  </a>
  <br>
  <sub>32-second demo · <a href="https://broco.yanauto.me/#watch">Watch in 1080p with audio on broco.yanauto.me →</a></sub>
</p>

## Get started

Requires macOS, Linux, or Windows 11, Git (Git for Windows on Windows 11), and two or more coding CLIs you already signed into locally. The one-line installer brings its own Node runtime when needed; installing via `npm` requires Node.js 22.13+.

**One-line installer (recommended):**

macOS / Linux:

```sh
curl -fsSL https://broco.yanauto.me/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://broco.yanauto.me/install.ps1 | iex
```

The installer brings its own Node 24 LTS runtime when needed (or reuses Node 22.13+ on `PATH`), installs into its own folder (`~/.local/share/broco` and `~/.local/bin/broco` on macOS/Linux; `%LOCALAPPDATA%\broco` on Windows), needs no admin rights, and leaves existing Node/npm untouched. Interactive shells run `broco setup` automatically; in non-interactive shells, run `broco setup` afterward. Re-run the same command to upgrade in place.

**Already on Node 22.13+?**

```sh
npm install -g @yanauto/broco
broco setup
```

### Install options

Both installers support environment overrides (and flags `--no-setup`, `--version <ver>`, `--uninstall`, `--purge`, `--help` on Unix; `-NoSetup`, `-Version <ver>`, `-Uninstall`, `-Purge` on Windows):

- `BROCO_INSTALL_DIR`: override install root (default `~/.local/share/broco` on Unix, `%LOCALAPPDATA%\broco` on Windows); `BROCO_BIN_DIR` overrides the Unix shim folder (default `~/.local/bin`).
- `BROCO_NODE_MIRROR` / `BROCO_NPM_REGISTRY`: mirror overrides; for users in mainland China, both installers automatically fall back to `https://npmmirror.com/mirrors/node` and `https://registry.npmmirror.com` on download failure.
- `BROCO_VERSION`: install a pinned `@yanauto/broco` version or dist-tag (default `latest`).
- `BROCO_NO_SETUP=1`: skip post-install `broco setup` and print `Next: broco setup` (useful for AI agents and CI).
- `BROCO_FORCE_RUNTIME=1`: always download the private Node 24 LTS runtime into `<root>/runtime/` instead of reusing `node` on `PATH`.

### Uninstall

macOS / Linux:

```sh
curl -fsSL https://broco.yanauto.me/install.sh | sh -s -- --uninstall
```

Windows (PowerShell):

```powershell
& ([scriptblock]::Create((irm https://broco.yanauto.me/install.ps1))) -Uninstall
```

Removes the install root, shim, and Windows User `Path` entry while keeping `~/.broco/` data intact (append `--purge` or `-Purge` alongside uninstall — or set `BROCO_UNINSTALL=1` and `BROCO_PURGE=1` — to remove `~/.broco/` too). Installed via npm? Run `npm uninstall -g @yanauto/broco`.

### What `broco setup` does

`broco setup` completes four steps in one pass:

1. Detects the coding harnesses already installed and signed in on your machine.
2. Asks you once to confirm your global allowlist (never enables workers silently).
3. Prints a live quota-aware roster immediately.
4. Installs one open `SKILL.md` into `~/.agents/skills/broco/` and links or syncs it into your detected local hosts (**Claude Code**, **Codex**, **Cursor**, **Antigravity**, **OpenCode**, and **Pi** — linking `~/.pi/agent/skills/broco` and respecting `PI_CODING_AGENT_DIR`).

**Native Windows 11 support:** Runs directly in PowerShell, Windows Terminal, or `cmd` (WSL2 also works via the Linux backend) using Windows Named Pipes (`\\.\pipe\broco-*`), direct `.exe` and npm `.cmd` CLI resolution without shell quoting issues, a pinned `~/.agents/skills/broco/broco.cmd` launcher, and NTFS junctions for Pi skills (no administrator privileges required). See [Windows 11 notes & troubleshooting](https://broco.yanauto.me/docs/#windows-11-notes).

Then go straight back to your current harness and ask in plain language:

> See which harness has quota headroom, fix the `verifyToken()` expiry bug in a worktree, then have another vendor review the diff.

**No per-repo `init` required (L0).** `broco` works in any directory right after `setup` using your global allowlist. Ticket state stays in `~/.broco/`, leaving your repository untouched unless you explicitly opt into per-project policy with `broco init`.

## Symmetric collaboration

Any host harness can delegate to any allowed worker — including calling `claude` itself from Codex, Cursor, Antigravity, OpenCode, or Pi.

| Worker | Integration & Inputs | Follow-up during a turn |
| --- | --- | --- |
| `claude` | Native `claude -p --output-format stream-json` + `--resume` via stdin (`text`, `image`, `pdf` via `--add-dir` + `Read`; rejects `audio`/`video`) | Queues for the next turn |
| `codex` | Native Codex app-server + live 5h/weekly quota (`text`, `image`, reported `audio`) | Injects when the turn accepts steering; otherwise queues |
| `agy` | Native Antigravity CLI via stdin + `/usage` multi-group quotas (`text`, `image`, `audio`, `video`, `pdf`). **Warning:** Google consumer plans (Free, AI Plus, Pro, Ultra) prohibit third-party agents from driving `agy` and accounts have been suspended; use only with a Gemini API key or Gemini Enterprise / Google Cloud project, at your own risk ([details](https://broco.yanauto.me/docs/workers/#agy)). | Queues for the next turn |
| `cursor-agent` | Native Cursor CLI with structured events and session ID resume | Queues for the next turn |
| `pi:<provider>` | pi RPC with explicit per-provider permission (`text`, `image`) | Injects when pi confirms delivery; otherwise queues |
| `custom:<name>` | Trial-tested new-session and resume command templates | Queues; native step events and cache are unavailable |

- **Official local CLIs using your existing logins.** `broco` spawns the official CLIs you already signed into as isolated local subprocesses, keeping state in `~/.broco/` without touching other CLIs' configs.
- **Safe prompts and secret redaction.** Prompts stream over `stdin` so task text stays out of process arguments, and secret patterns are redacted before worker streams are stored in SQLite.
- **Recursion guard (`BROCO_IN_WORKER=1`).** Every worker process inherits `BROCO_IN_WORKER=1`; `broco` refuses nested worker-to-worker dispatch by default unless explicitly overridden with `--allow-nested`.

## When two harnesses beat one

- **Cross-vendor code review.** Once your main harness finishes a patch, hand the git diff to a different model family cold, with fresh eyes on the diff alone.
- **Quota-aware handoff.** When your primary CLI approaches its 5-hour cap, send test fixes or refactors to another signed-in harness with headroom and keep your session moving.
- **Borrow another harness’s strengths.** Stay in your terminal while sending screenshots, PDFs, audio, video, or model-specific work to whichever local CLI fits best across Claude, Gemini, Codex, Cursor, and Pi.
- **Parallel worktree batches.** Fan out repetitive audits, migrations, or multi-module edits in isolated git worktrees so several tasks move forward while you stay focused in your main session.

---

## Agent CLI reference

> Commands below are run by your agent via the skill — you don't need to memorize them.

### Check health and live quotas

```sh
broco status --json
broco roster --json
broco roster --worker codex --json --full
```

`status` checks runner health, active/queued tickets, batches, proxies, and cleanable worktrees without starting an offline daemon. `roster` reads permitted model families, login state, input capabilities, user notes, rules, and live quotas (`avoid` and `plentiful`) over a shared 45s cache (`--refresh` forces a re-probe; `--global` inspects global defaults explicitly).

### Dispatch, wait, diff, cross-vendor review, and clean

```sh
broco say auth-fix - --worker pi:zai --worktree --bg --json <<'EOF'
Fix the failing `verifyToken()` expiry test and cover `$REFRESH_TOKEN` edge cases.
EOF
broco wait auth-fix --json
broco diff auth-fix --stat
broco review auth-fix --bg --json
broco wait auth-fix-review-... --json
broco done auth-fix --result pass --why "Token expiry and refresh tests green."
broco clean auth-fix --delete-branch
```

- **`say`** accepts inline text, `--file <path>`, or `stdin` (`-` or piped input; on Windows PowerShell or `cmd`, pass `--file <path>` or pipe `@' ... '@` instead of `<<'EOF'`) so multi-line markdown and backticks need no shell escaping. Reuse a name to continue its session; pick a new name to run in parallel. Use `--cwd DIR` to run in another directory while keeping permissions and tickets in the current project, `--attach FILE` for confirmed media, `--new-task` after `done`, and `--from OLD_NAME` to hand off cleanly when `contextWarning` fires at 60% of a model's context window.
- **`wait`** is event-driven (0ms wakeup, no SQLite polling) and returns `reply`, `task`, `cwd`, `worktree`, `branch`, and `changedFiles`.
- **`diff`** inspects tracked and untracked changes against the ticket's base commit.
- **`review`** defaults to cross-vendor blind review: omitting `--by` automatically selects a permitted worker from a different vendor with available quota headroom — for example reviewing a `codex` patch with `claude`, or a `pi:zai` patch with `claude` (or pass `--by claude`, `--by codex`, etc. explicitly).
- **`done` & `clean`** record outcomes (`pass`, `rework`, `fail`, `blocked`) and remove retained worktrees and branches safely (`--dry-run` previews first).

### Sharded batch fan-out with `map`

Apply one brief across many files or inputs (`<prefix>-1 .. <prefix>-N`) regulated by an isolated FIFO concurrency pool:

```sh
broco map x-tag --brief-file brief.md --inputs shard-*.jsonl --worker pi:deepseek --effort high --bg --json
broco wait x-tag --json
broco retry x-tag --bg --json
broco show x-tag --status error,review --full --json
broco done x-tag --result pass --why "All shards verified."
broco clean x-tag --delete-branch
```

`map` accepts `--brief`, `--brief-file <path|->`, `--input`, `--inputs`, `--inputs-file <path|->` (lines or JSON array), and `{input}`, `{index}`, `{count}`, `{name}` placeholders. `wait`, `show`, `retry`, `stop`, `done`, and `clean` all accept a batch prefix (`retry <prefix>` retries only failed or stopped shards).

### Optional per-repo policy (L1 `init`)

Only needed when a repository requires its own strict allowlist (for example blocking a specific vendor in a private repo), an independent concurrency cap, repo-specific rules, or explicit heavy manager mode:

```sh
broco init --allow claude,codex,pi:deepseek,pi:zai --default-worker pi:zai --concurrency 4
broco init --manager-mode
broco uninit
```

`init` writes `.broco/` and maintains a marked `<!-- broco:start -->` section in `AGENTS.md` by default without altering surrounding text (`--host` supports `auto|agents|claude|codex|cursor|agy|opencode|pi`). It touches `CLAUDE.md` only when the repo already has one or when `--host claude` is passed (`--no-agents-md` / `--no-claude-md` skip markers; `broco uninit` releases idle workers, unregisters the repo, and strips only the marked section). Project policy strictly overrides global defaults when present.

## Built for daily power use

### Agent-first settings and one-command undo

Your agent can adjust global or per-project settings directly via CLI. Every change takes effect on subsequent dispatches, writes an audit entry in your local timezone (configurable via `BROCO_TZ` or `TZ`), and prints a one-command undo:

```sh
broco set concurrency 6
broco set default-worker pi:zai
broco allow claude,codex,pi:deepseek,pi:zai --default-worker pi:zai
broco deny cursor-agent
broco defaults pi:zai --model zai/glm-5.3 --effort high
broco note pi:deepseek "Fast and inexpensive; good for batch map jobs"
broco rules --add "Run tests before finishing"
broco hide codex gpt-5.6-sol
broco audit --limit 10
broco undo
```

Open the local board anytime with `broco ui` (or `broco ui --no-open`; port auto-restores across restarts) to monitor live `map` progress bars, queue positions, multi-task histories, context warnings, and one-click **Undo**.

### Loopback credential proxies

Give a worker a temporary `127.0.0.1` URL that injects an auth header into specific upstream paths without exposing the secret to the worker process:

```sh
broco proxy-open --upstream https://api.example.com \
  --path /v1/models --path /v1/chat/completions \
  --header Authorization --value-env EXAMPLE_API_KEY --value-prefix 'Bearer ' \
  --max-requests 150 --ttl 1800 --json
broco proxy-list --json
broco proxy-close PROXY_ID --json
```

Secrets live in runner memory only, bind strictly to `127.0.0.1`, reject `--path /` and 3xx redirects, and enforce path-segment prefixes and request/TTL caps.

### Tracked task pass rates (`stats`)

```sh
broco stats --json
broco stats --project . --json
```

Aggregates real per-task pass/rework/fail/blocked outcomes grouped by worker and model across projects.

### Upgrading from `cc-bro` or `opus-manager`

`broco` is the continuation of `opus-manager` (v0.4) and `cc-bro`. After installing `broco`:

1. Wait for any active work you want to preserve (`cc-bro status` if still installed).
2. Run `broco shutdown` (cleanly stops legacy runners across older protocols and `~/.cc-bro` sockets) followed by `broco setup --migrate-cc-bro` (or `broco setup` for a fresh start).
3. `broco setup --migrate-cc-bro` losslessly copies existing `~/.cc-bro/` state into `~/.broco/` while preserving your projects, settings, and ticket history without deleting `~/.cc-bro/`.

See the [upgrade guide](https://broco.yanauto.me/docs/upgrade/) for details.

## Development

From source:

```sh
npm ci --prefix ui
npm run prepack
npm test
```

[Apache-2.0 license](LICENSE)

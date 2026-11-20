# Command reference

Most commands work in any directory immediately after `broco setup` using your global policy (L0), or target a specific project from anywhere via `--project PATH`. Run `broco COMMAND --help` for the exact syntax of your installed version.

## Setup, status, and optional per-repo init

| Command | Behavior |
| --- | --- |
| `broco setup [--allow IDS] [--default-worker ID] [--yes] [--migrate-cc-bro] [--json]` | Detect local CLIs, confirm global allowlist, print live quota roster, migrate legacy `~/.cc-bro/` with `--migrate-cc-bro` if found, write the launcher (`broco.cmd` on Windows), and install `~/.agents/skills/broco/SKILL.md` into detected hosts (linking `~/.pi/agent/skills/broco` via symlink on POSIX or NTFS junction on Windows, respecting `PI_CODING_AGENT_DIR`). |
| `broco status [--project PATH] [--all] [--json]` | Inspect runner health, uptime, board URL, active proxies, active/queued tickets, batches, and cleanable worktrees without starting an offline runner or creating implicit L0 projects. |
| `broco init [--project DIR] [--allow IDS] [--default-worker ID] [--concurrency N] [--host auto\|agents\|claude\|codex\|cursor\|agy\|opencode\|pi] [--manager-mode] [--no-agents-md] [--json]` | Optional L1 per-repo policy: write `.broco/` and maintain a marked section in `AGENTS.md` (or `CLAUDE.md` when `AGENTS.md` is absent and `CLAUDE.md` exists, or with `--host claude`). |
| `broco uninit [--project DIR] [--host auto\|agents\|claude\|codex\|cursor\|agy\|opencode\|pi] [--no-agents-md] [--json]` | Release idle workers, unregister the repo, remove `.broco/` (and legacy `.cc-bro/project-id`), and strip the marked section. |
| `broco version [--json]` | Print `broco` version and commit without starting an offline runner (alias: `broco --version`). |

## Live roster

```sh
broco roster [--global] [--worker ID] [--full] [--refresh] [--project PATH] [--json]
```

Returns compact permitted model families, live quotas (`avoid`, `plentiful`, `tightGroups`), input capabilities, task `record`, notes, and rules over a 45s shared cache. Denied workers list only `id` and `allowed:false`. Pass `--worker ID --full` for exact variants, older models, and token limits.

## Dispatch, batch fan-out, inspect, review, and clean

```text
broco say NAME [MESSAGE|-] [--file PATH] [--worker ID] [--model MODEL] [--effort LEVEL] [--attach FILE] [--worktree | --cwd DIR] [--from NAME] [--new-task] [--title TITLE] [--bg] [--json]
broco map PREFIX [INPUTS...] [--brief TEXT | --brief-file PATH|-] [--inputs LIST] [--input ITEM] [--inputs-file PATH|-] [--worker ID] [--model MODEL] [--effort LEVEL] [--worktree | --cwd DIR] [--bg] [--json]
broco wait NAME [TURN] [--json]
broco retry NAME [--worker ID] [--model MODEL] [--effort LEVEL] [--bg] [--json]
broco diff NAME [--stat] [--json]
broco review NAME [--by ID] [--model MODEL] [--effort LEVEL] [--bg] [--json]
broco done NAME [--task N] [--result pass|rework|fail|blocked] [--why TEXT] [--json]
broco clean [NAME] [--dry-run] [--delete-branch] [--force] [--json]
```

- `say` reads inline text, `--file PATH`, or `stdin` (`-` or piped input) so prompts never leak in `ps`. Workers run with `BROCO_IN_WORKER=1` to prevent nested recursion unless explicitly overridden (`--allow-nested`).
- `map` expands `{input}`, `{index}`, `{count}`, and `{name}` across `<prefix>-1 .. <prefix>-N`. `wait`, `show`, `retry`, `stop`, `done`, and `clean` all accept a batch prefix.
- `review` omits `--by` to automatically choose a permitted worker from a different vendor with available quota.
- Use repeated `say --attach FILE` to send confirmed [media attachments](model-inputs.md).

## Monitor, inspect, and stop

| Command | Behavior |
| --- | --- |
| `broco ls [--active] [--status LIST] [--flag error\|stopped] [--batch PREFIX] [--limit N] [--json]` | List tickets without flooding agent context. |
| `broco show NAME [--compact] [--turn N] [--status LIST] [--full] [--all] [--json]` | Show a session or batch summary, specific turn, or full conversation history. |
| `broco stats [--project PATH] [--json]` | Show tracked per-task pass/rework/fail/blocked counts by worker and model. |
| `broco watch [--project PATH]` | Stream live project activity in the terminal. |
| `broco ui [--no-open] [--json]` | Open the local board or print its URL. |
| `broco stop NAME [--json]` | Stop a named session (or batch) and verify processes exited. |
| `broco shutdown [--json]` | Gracefully stop the local runner (compatible with older `cc-bro` runner protocols). |

## Agent-first settings and audit undo

```text
broco set <concurrency|default-worker> VALUE [--global] [--project PATH] [--json]
broco allow WORKERS [--default-worker ID] [--global] [--project PATH] [--json]
broco deny WORKERS [--global] [--project PATH] [--json]
broco defaults WORKER [--model ID] [--effort LEVEL] [--clear] [--global] [--project PATH] [--json]
broco note WORKER [TEXT] [--clear] [--global] [--project PATH] [--json]
broco rules [--add TEXT] [--rm TEXT] [--clear] [--worker ID] [--override] [--global] [--project PATH] [--json]
broco hide WORKER MODELS [--global] [--project PATH] [--json]
broco unhide WORKER MODELS [--global] [--project PATH] [--json]
broco audit [--global | --all] [--project PATH] [--limit N] [--json]
broco undo [AUDIT_ID] [--global] [--project PATH] [--json]
```

## Loopback credential proxies

```text
broco proxy-open --upstream ORIGIN --path PREFIX --header NAME (--value-env VAR | --value-command CMD) [--value-prefix TEXT] --max-requests N --ttl SECONDS [--json]
broco proxy-list [--json]
broco proxy-close PROXY_ID [--json]
```

Secrets stay in runner memory only, bind strictly to `127.0.0.1`, reject `--path /` and 3xx redirects, and enforce path-segment prefixes and request/TTL caps.

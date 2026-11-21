# Your first ticket

Start in any repository right after [installing `broco`](installation.md) and running `broco setup` — no `broco init` needed. Try a read-only check first, or isolate a real edit in a git worktree and get a cross-vendor review.

## 1. Dispatch from your existing host chat (recommended)

Open your usual coding harness (**Claude Code**, **Codex**, **Cursor**, **Antigravity**, **OpenCode**, or **Pi**) in any project directory and ask in plain language:

> Check who has quota, find where the auth tests live without editing files, or fix `verifyToken()` expiry in an isolated worktree and get a cross-vendor review.

The installed `SKILL.md` guides your agent to inspect `broco roster --json`, dispatch a worker, wait via event-driven notifications without polling, inspect `broco diff`, and close the ticket cleanly.

## 2. Or drive the CLI directly

To verify the flow yourself from a terminal:

```sh
broco status
broco roster
broco say test-map "Locate the tests and tell me how to run one. Do not edit files." --bg --json
```

`--bg` returns a receipt immediately with `name` and `turn`. A new name (`test-map`) starts a fresh persistent session; reusing the same name continues that native session. For multi-line prompts containing markdown, backticks, or `$VAR`, pass `--file prompt.md` or pipe via `stdin` (`-`; on Windows PowerShell or `cmd`, use `--file prompt.md` or pipe `@' ... '@` instead of `<<'EOF'`):

```sh
broco say auth-fix - --worker agy --worktree --bg --json <<'EOF'
Fix the failing `verifyToken()` expiry test and cover `$REFRESH_TOKEN` edge cases.
EOF
```

## 3. Wait, inspect diff, review, accept, and clean

```sh
broco wait auth-fix --json
broco diff auth-fix --stat
broco review auth-fix --bg --json
broco done auth-fix --result pass --why "Expiry and refresh tests pass."
broco clean auth-fix --delete-branch
```

- `wait` wakes immediately on turn completion (event-driven, no SQLite polling) and returns `reply`, `task`, `cwd`, `worktree`, `branch`, and `changedFiles`.
- `review` omits `--by` to automatically pick an allowed worker from a different vendor with available quota headroom (or specify `--by claude`, `--by codex`, etc.).
- `clean` safely removes retained worktrees after you merge or preserve changes (`--dry-run` previews first).

Open [the board](board.md) with `broco ui` anytime to watch tickets, batches, and audit history live.

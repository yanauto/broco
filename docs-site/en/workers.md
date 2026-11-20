# Workers and login

`broco` connects all your signed-in local harnesses symmetrically: any host agent can delegate to `claude`, `codex`, `agy`, `cursor-agent`, `pi:<provider>`, or a trial-tested `custom:<name>`. Every built-in worker runs as an isolated local subprocess of the official CLI using your existing login. Read [the roster](roster.md) before dispatching.

## Native Claude (`claude`)

Use `claude` as the worker ID to summon Claude Code from Codex, Cursor, Antigravity, OpenCode, Pi, or the terminal using your existing local login:

```sh
claude --version
```

`broco` invokes `claude -p --output-format stream-json` with `--resume` for follow-up turns, passes prompts over `stdin` (never exposed in `ps`), classifies errors uniformly (`quota`, `region`, `policy`, `network`, `auth`, `context`), and redacts secrets before writing streams to SQLite. Follow-ups sent while a turn is running queue for the next turn.

To prevent infinite worker-to-worker loops, the runner injects `BROCO_IN_WORKER=1` into every worker process. `broco` refuses nested dispatch inside a worker by default unless explicitly overridden with `--allow-nested`.

## Native Codex (`codex`)

Use `codex` to run your installed Codex CLI via its native app-server and live 5h/weekly quota endpoint (`account/rateLimits/read`):

```sh
npm install -g @openai/codex
codex login
codex login status
```

When a turn accepts steering, a second `say` injects into the running turn; otherwise it queues. If app-server is unavailable before submission, `broco` falls back to `codex exec`.

## Antigravity (`agy`) and Cursor (`cursor-agent`)

Use `agy` and `cursor-agent` for native structured events and session ID resume. Follow-ups during an active turn queue for the next turn.

- **`agy`**: passes prompts via `stdin`, reads multi-group quotas via `/usage` (including secondary model-group alerts), and supports all five input modalities (`text`, `image`, `audio`, `video`, `pdf`). Check models with `agy models`.
- **`cursor-agent`**: sign in with `cursor-agent login`, check status with `cursor-agent status`, and list models with `cursor-agent --list-models`.

## pi (`pi:<provider>`)

Choose `pi:<provider>` to run inside `pi` RPC with explicit per-provider permissions:

```sh
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi
```

Inside `pi`, run `/login` to connect your provider (for example `pi:openai-codex` or `pi:deepseek`). A native `codex` login does not replace `pi`’s own login, and each `pi:<provider>` must be allowed separately. Verify without printing credentials:

```sh
pi auth check --provider openai-codex --no-refresh
pi --list-models
```

## Choose per ticket

```sh
broco say inspect-a "Audit error paths in src/auth.ts." --worker claude --bg --json
broco say inspect-b "Audit error paths in src/auth.ts." --worker codex --bg --json
```

A session name stays bound to its worker; you can switch `--model` or `--effort` between completed turns. For Gemini CLI, OpenCode, or another program, configure a trial-tested [custom template](custom-cli.md).

A listed model can still hit quota, region, or plan limits. `broco` surfaces structured `problem.class` errors; it never silently switches vendors or spends credits without instruction.

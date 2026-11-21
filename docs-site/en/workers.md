# Workers and login

`broco` connects all your signed-in local harnesses symmetrically: any host agent can delegate to `claude`, `codex`, `cursor-agent`, `pi:<provider>`, `custom:<name>`, or [`agy`](#agy) (note: consumer Google plans prohibit third-party agents driving `agy`). Every built-in worker runs as an isolated local subprocess of the official CLI using your existing login. Read [the roster](roster.md) before dispatching.

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

## Cursor (`cursor-agent`)

Use `cursor-agent` for native structured events and session ID resume. Follow-ups during an active turn queue for the next turn. Sign in with `cursor-agent login`, check status with `cursor-agent status`, and list models with `cursor-agent --list-models`.

## agy

> [!WARNING]
> Google's consumer plans (Free, Google AI Plus, Pro, and Ultra) do not allow third-party agents (such as Claude Code or Codex) to drive the Antigravity CLI (`agy`), and accounts have been suspended for doing so. `broco` prints a non-blocking warning in `broco setup`, `broco roster`, and on the first `agy` dispatch in a session without disabling `agy` — use `agy` only with a Gemini API key or a Gemini Enterprise / Google Cloud project, at your own risk.

When used with a Gemini API key or Gemini Enterprise / Google Cloud project, `agy` passes prompts via `stdin`, reads multi-group quotas via `/usage` (including secondary model-group alerts), and supports all five input modalities (`text`, `image`, `audio`, `video`, `pdf`). Follow-ups during an active turn queue for the next turn. Check models with `agy models`.

## pi (`pi:<provider>`)

Choose `pi:<provider>` to run inside `pi` RPC with explicit per-provider permissions:

```sh
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi
```

Inside `pi`, run `/login` to connect your provider (for example `pi:deepseek`, `pi:zai` for Zhipu GLM, or `pi:openai-codex`). A native `codex` login does not replace `pi`’s own login, and each `pi:<provider>` must be allowed separately. When passing `--model` explicitly for a `pi:<provider>` worker, include the provider prefix shown in `broco roster` (such as `zai/glm-5.3` or `deepseek/deepseek-flash`). Verify without printing credentials:

```sh
pi auth check --provider deepseek --no-refresh
pi --list-models
```

Across macOS, Linux, and Windows, `pi` workers run directly with isolated session storage (`~/.broco/sessions`) and stripped host-session environment variables (macOS `sandbox-exec` is used only in isolated `.sandbox` profile runs to fence `~/.pi`).

## Choose per ticket

```sh
broco say inspect-a "Audit error paths in src/auth.ts." --worker pi:zai --model zai/glm-5.3 --bg --json
broco say inspect-b "Audit error paths in src/auth.ts." --worker claude --bg --json
```

A session name stays bound to its worker; you can switch `--model` or `--effort` between completed turns. For Gemini CLI, OpenCode, or another program, configure a trial-tested [custom template](custom-cli.md).

A listed model can still hit quota, region, or plan limits. `broco` surfaces structured `problem.class` errors; it never silently switches vendors or spends credits without instruction.

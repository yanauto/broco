# Settings and undo

Configure global defaults or per-project overrides directly through the CLI — immediately applied on subsequent dispatches, logged with timestamps in your local timezone, and reversible in one command via `broco undo`. Open **Settings** in `broco ui` to inspect live detection, active settings, and audit history with one-click **Undo**.

## Agent-first CLI configuration

Every setting command accepts `--global` or `--project PATH` (plus `--json`) and never edits another CLI’s native config files:

```sh
broco set concurrency 6
broco set default-worker agy
broco allow claude,codex,agy --default-worker agy
broco deny cursor-agent
broco defaults agy --model gemini-4-argon --effort high
broco note agy "High headroom plan; good for batch map jobs"
broco rules --add "Run tests before finishing"
broco hide codex gpt-5.6-sol
broco unhide codex gpt-5.6-sol
broco audit --limit 10
broco undo
```

- **Audit & Undo**: Every mutation writes an audit record (using `BROCO_TZ`, `TZ`, or your local system timezone) and prints the exact `broco undo <id>` command. Running bare `broco undo` reverts the latest undoable change in scope.
- **Inheritance**: Global notes, defaults, hidden models, and rules apply everywhere unless overridden for a registered project. Project rules append to global rules by default (`--override` replaces them).
- **Visibility**: Hidden model families (including their effort and speed variants) disappear from `broco roster` and are rejected by explicit dispatch, defaults, and queued starts.

## Detection, login, and the Settings view

Run `broco ui` and open **Settings** in the header to inspect detected executables, versions, effective defaults, and audit history:

- **Detection** is strictly read-only: Claude Code checks CLI availability and login state; Codex reads app-server `model/list`, `config/read`, `account/read`, and rate limits; `pi` runs non-generating RPC queries and `auth check --no-refresh`; `agy` reads `models`, `/model`, `/effort`, and `/usage`; Cursor reads `models` and `status`. Credential file values are never read and session histories are never inspected.
- **Explicit login**: Authentication stays inside each CLI’s own login flow (`claude`, `codex login`, `agy`, `cursor-agent login`, or `pi` `/login`). `broco` never collects or stores provider API keys.
- **Custom templates**: Add other non-interactive CLIs as `custom:name` via [Custom CLI templates](custom-cli.md).

# The worker roster

Before dispatching or reviewing, run `broco roster --json`. The host agent reads live quotas, permitted models, input capabilities, task records, notes, and rules so it chooses the right CLI without guessing.

The default output is compact in both text and JSON, backed by a shared 45-second probe cache (`--refresh` forces a re-probe; `--global` inspects global defaults outside a registered repo). Denied workers contain only their ID and `allowed:false`, even with `--full`, and skip subprocess probing. If an allowed worker is missing or signed out, top-level `warnings` prints the exact install or sign-in command.

```sh
broco roster
broco roster --global
broco roster --worker codex --json
broco roster --worker codex --json --full
broco say investigate "Explain the failing test." --worker codex --model MODEL_FROM_ROSTER --effort low --bg --json
```

## Live quotas and operational signals

- **`quota`**: Codex (`account/rateLimits/read`) and `agy` (`/usage`) report live 5-hour and weekly headroom, flagging `avoid` when tight, `plentiful` when wide open, and `tightGroups` for secondary `agy` model buckets. CLIs without a usage endpoint show `unreported` and rely on error-derived cooldown tracking (`recentProblem`).
- **`record`**: Real per-task pass/rework/fail counts from `broco done`. Once a model has 3+ non-blocked tasks, your own record outranks catalog grades.
- **`capabilities.input`**: Confirmed intersection of model capability and CLI transport (`text`, `image`, `audio`, `video`, `pdf`). Check for `true` before `--attach`.

## Compact and detailed views

Each current model family takes one row: a real detected model ID, confirmed inputs, tier/grade, reported effort choices, and one sentence. Effort and fast variants share a row (`variantCount`, `fast`). For `agy`, multi-effort families fold under their base family ID and map `--effort` automatically.

Models labeled `previous generation`, `superseded`, or `being retired` in the catalog fold into `olderModels`. Use `--full` (optionally with `--worker ID`) for exact variants, older models, token limits, and full catalog metadata. Hidden models stay hidden in both modes.

## Allowlist, notes, rules, and overrides

- The allowlist is a hard boundary checked at dispatch and before queued work starts.
- Agent-first CLI commands update `defaults`, `note`, `rules`, `hide`, and `unhide` immediately for subsequent dispatches, with full audit history and one-command `broco undo`. See [Settings and undo](settings.md).
- Built-in `lib/model-catalog.json` ships in the package. Optional `~/.broco/models.json` (or `$BROCO_HOME/models.json`) merges overrides by exact model `id`, plus root `picks` and `effort_advice`:

```json
{"models":[{"id":"gpt-6.1-sol","summary":{"en":"Our default coder."},"grade":"Team preferred"}]}
```

Catalog entries older than 60 days or missing a valid `as_of` are flagged stale. Advisory catalog grades never override user notes, rules, or your own `stats`. See [Capabilities and media](model-inputs.md).

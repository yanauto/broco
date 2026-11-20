# Global and repo policy

`broco` starts with a zero-config global allowlist confirmed during `broco setup` (L0). Add a per-repository policy with `broco init` (L1) only when a specific repo needs stricter boundaries, its own concurrency pool, or heavy manager mode.

## L0: Global policy (zero `init`, zero dotfiles)

During `broco setup`, you confirm the exact global allowlist once (for example `claude,codex,agy,cursor-agent`). Every `pi:<provider>` requires its own explicit ID — allowing `codex` does not grant `pi:openai-codex`.

In any directory without `.broco/`, commands use your global allowlist, global default worker, and global concurrency cap automatically. Ticket state is stored under `~/.broco/` keyed by `realpath(gitRoot || cwd)` so repositories stay completely clean.

Adjust global policy anytime without touching repos:

```sh
broco allow claude,codex,agy --default-worker agy --global
broco deny cursor-agent --global
broco set concurrency 4 --global
```

## L1: Optional per-repo policy (`broco init`)

Use `broco init` when a repo needs hard local overrides — for instance restricting a private repository to specific vendors, capping concurrency, adding repo rules, or opting into explicit manager mode:

```sh
broco init --allow claude,codex --default-worker codex --concurrency 4
broco init --manager-mode
```

- Project allowlists strictly override global policy once configured.
- `init` writes a self-ignored `.broco/` identity marker and maintains a marked `<!-- broco:start -->` section in `AGENTS.md` by default without altering surrounding content.
- `CLAUDE.md` is updated only when the repository already contains one or when `--host claude` is explicitly passed (`--no-agents-md` and `--no-claude-md` skip marker edits).
- Run `broco uninit` to release idle workers, unregister the repo, remove `.broco/`, and strip only the marked `broco` section.

## Changing policy safely

Use `broco allow`, `broco deny`, `broco set default-worker`, or `broco set concurrency` (with `--global` or `--project PATH`). Every policy mutation records an audit entry and prints a one-command `broco undo`. Running turns are unaffected by revocation; queued turns are re-checked before starting. Existing named sessions keep their bound worker. See [Settings and undo](settings.md).

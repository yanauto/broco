# Upgrading and migrating

`broco` v1.0.0 is the direct evolution of `opus-manager` (v0.4) and `cc-bro` (0.4.x). Upgrading preserves your projects, policies, named sessions, and ticket history.

## Upgrading from `cc-bro` (0.4.x) or `opus-manager`

1. If you have active turns you want to finish, check `cc-bro status` and wait for them to complete.
2. Install `broco`, stop any legacy runner, and run `broco setup`:

```sh
npm install -g @yanauto/broco
broco shutdown
broco setup --migrate-cc-bro
```

`broco shutdown` cleanly stops older `cc-bro` runners across previous protocols (including legacy `~/.cc-bro` socket paths).

Running `broco setup --migrate-cc-bro` losslessly copies your existing `~/.cc-bro/` state into `~/.broco/` without deleting `~/.cc-bro/` — keeping your registered projects, allowlists, defaults, notes, rules, stats, and ticket history intact while installing the new multi-host `SKILL.md` into `~/.agents/skills/broco/` and your detected coding agents.

### What changed in 1.0.0

- **Package & paths**: CLI command `broco`, data directory `~/.broco/` (`$BROCO_HOME`), optional per-repo directory `.broco/`, and environment variables `BROCO_*` (including `BROCO_TZ` for timezone overrides and `BROCO_IN_WORKER=1` for recursion protection).
- **L0 zero-`init`**: You no longer need `init` in every repository; global policy works everywhere without creating dotfiles. Existing `.broco/` or migrated per-repo policies continue to override global defaults.
- **Built-in `claude` worker**: Native `claude` is now a symmetric worker alongside `codex`, `agy`, `cursor-agent`, `pi:<provider>`, and `custom:<name>`. Confirm whether you want `claude` in your global allowlist during `broco setup`.
- **Default cross-vendor `review`**: `broco review <name>` now auto-selects a different-vendor worker with quota headroom when `--by` is omitted.
- **Local timezone**: Timestamps follow `BROCO_TZ` → `TZ` → your system timezone instead of hardcoding `Asia/Shanghai`.

## Upgrading from 0.3.x or 0.2.x

Install `broco`, let any active work finish, run `broco shutdown`, then run `broco setup`. Existing 0.2/0.3 policies, sessions, and tickets migrate into `~/.broco/` without broadening permissions. Scripts expecting full model metadata from `roster --json` should pass `--full`.

## Upgrading from 0.1.0 (legacy manager rooms)

Version 0.2.0 retired separate manager rooms. Keep any notes in old 0.1.0 manager folders for reference, install `broco`, run `broco shutdown` and `broco setup`, and work directly inside your real repository chats. See [Your first ticket](quickstart.md).

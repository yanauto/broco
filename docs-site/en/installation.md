# Installation

Install `broco` once on your machine to let your coding harnesses work together. Run `broco setup` to confirm your global allowlist and install one open `SKILL.md` into your local hosts — no per-repo `init` required.

## What you need

Use macOS or Linux with Node.js 24 or newer and at least two AI CLIs you already signed into locally (for example Claude Code, Codex, Antigravity `agy`, Cursor Agent, or `pi`). Git is required for isolated worktrees and custom-template trials.

```sh
node --version
```

## Install the CLI and open skill

```sh
npm install -g broco
broco setup
```

`broco setup` does four things in one pass:

1. Detects the AI CLIs already installed and signed in on your machine.
2. Asks you once to confirm your global allowlist (never enables workers silently).
3. Prints a live quota-aware roster on the spot.
4. Installs one open `SKILL.md` into `~/.agents/skills/broco/` and links or syncs it into your detected host harnesses (**Claude Code**, **Codex**, **Cursor**, **Antigravity**, **OpenCode**, and **Pi** — linking `~/.pi/agent/skills/broco` and respecting `PI_CODING_AGENT_DIR`).

Run `broco setup` again after upgrading `broco` or switching Node installations. If an open chat does not pick up the skill right away, reopen that host session.

## L0 zero-init vs optional L1 init

Right after `broco setup`, you can return to any host agent chat in any directory and start dispatching with natural language. `broco` stores ticket history under `~/.broco/` keyed by `realpath(gitRoot || cwd)` — it adds no dotfiles to your repository and does not edit `CLAUDE.md` or `AGENTS.md`.

Only run `broco init` when a specific repository needs its own strict allowlist, concurrency cap, repo rules, or heavy manager mode (`--manager-mode`). See [Global and repo policy](allowlist.md).

## When two harnesses beat one

- **Cross-vendor code review.** Once your main harness finishes a patch, hand the git diff to a different model family cold, with fresh eyes on the diff alone.
- **Quota-aware handoff.** When your primary CLI approaches its 5-hour cap, send test fixes or refactors to another signed-in harness with headroom and keep your session moving.
- **Borrow another harness’s strengths.** Stay in your terminal while sending screenshots, PDFs, audio, video, or model-specific work to whichever local CLI fits best across Claude, Gemini, Codex, Cursor, and Pi.
- **Parallel worktree batches.** Fan out repetitive audits, migrations, or multi-module edits in isolated git worktrees so several tasks move forward while you stay focused in your main session.

## Next steps

Check [Workers and login](workers.md) to verify your CLIs, or jump straight to [Your first ticket](quickstart.md). Upgrading from `cc-bro` or `opus-manager`? Read [Upgrading](upgrade.md).

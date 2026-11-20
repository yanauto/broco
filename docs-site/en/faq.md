# Frequently asked questions

Quick answers to common setup, architecture, and runtime questions.

## Do I need to run `broco init` in every repository?

No. After `broco setup`, L0 mode works in every directory immediately using your global allowlist — adding no hidden dotfiles to your repository and making no changes to `CLAUDE.md` or `AGENTS.md`. Only run `broco init` (L1) when a specific repo needs a stricter allowlist, its own concurrency limit, repo-specific rules, or `--manager-mode`. See [Global and repo policy](allowlist.md).

## How does broco authenticate with each CLI?

`broco` spawns the official local CLIs you are already signed into as isolated subprocesses. Each harness keeps using its own local login and native configuration without separate API keys or proxy layers.

## Can a worker recursively summon another worker?

Not by default. When the runner launches any worker subprocess, it injects `BROCO_IN_WORKER=1`. If a worker attempts to call `broco say`, `broco map`, `broco review`, or `broco retry`, `broco` refuses nested dispatch unless `--allow-nested` is explicitly passed.

## Why is a signed-in worker “not allowed”?

Login and permission are separate boundaries. Confirming your allowlist during `broco setup` (or via `broco allow`) prevents accidental dispatch to a CLI you did not authorize. Each `pi:<provider>` (`pi:openai-codex`, `pi:deepseek`, etc.) is its own distinct ID.

## How does quota reading work?

Quota reading is best-effort per CLI: `codex` (`account/rateLimits/read`) and `agy` (`/usage`) report live 5-hour and weekly usage windows (`avoid`, `plentiful`, and `agy` secondary model-group alerts). CLIs without a usage endpoint show `unreported` and fall back to error-derived cooldown tracking (`recentProblem`).

## How are timestamps formatted?

`broco` resolves your timezone dynamically in order: `BROCO_TZ` → `TZ` → system timezone → `UTC`. Set `BROCO_TZ=Asia/Tokyo` or `BROCO_TZ=America/New_York` if you want a fixed display timezone across CLI, audit logs, and board timelines.

## I closed my host agent chat. Did the worker stop?

No. The local runner keeps executing active turns and batches independently. Reopen any chat or terminal and run `broco status`, `broco ls --active`, `broco show NAME --compact`, or `broco wait NAME`. To cancel one session, run `broco stop NAME`.

## Why can’t the reviewer see my uncommitted edits?

A `--worktree` starts from committed `HEAD`. Check the writer’s branch with `broco diff NAME`, wait for any queued follow-up turns to complete, and keep the writer’s worktree stable while `broco review` runs. See [Worktrees and review](review-worktree.md).

## What platforms and setups does broco support?

`broco` runs natively on macOS, Linux, and Windows 11 (PowerShell, Windows Terminal, and `cmd`, plus WSL2 via the Linux backend) with Node.js 24+ and Git, and works best when you have two or more signed-in coding harnesses on the same machine (Claude Code, Codex, Cursor, Antigravity, OpenCode, or Pi). On native Windows, the runner uses Named Pipes (`\\.\pipe\broco-*`), resolves `.exe` and npm `.cmd` CLIs directly, writes a `broco.cmd` skill launcher, and links Pi skills via admin-free NTFS junctions. For quick single-file edits inside the same model family, your current host’s built-in subagent is usually fastest.

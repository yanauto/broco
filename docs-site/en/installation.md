# Installation

Install `broco` once on your machine to let your coding harnesses work together. Run `broco setup` to confirm your global allowlist and install one open `SKILL.md` into your local hosts — no per-repo `init` required.

## What you need

Use macOS, Linux, or Windows 11 with Node.js 24 or newer (required for built-in `node:sqlite`), Git (Git for Windows on Windows 11), and at least two AI CLIs you already signed into locally (for example Claude Code, Codex, Antigravity `agy`, Cursor Agent, or `pi`). Git is required for isolated worktrees and custom-template trials.

```sh
node --version
```

## Install the CLI and open skill

```sh
npm install -g @yanauto/broco
broco setup
```

`broco setup` does four things in one pass:

1. Detects the AI CLIs already installed and signed in on your machine.
2. Asks you once to confirm your global allowlist (never enables workers silently).
3. Prints a live quota-aware roster on the spot.
4. Installs one open `SKILL.md` into `~/.agents/skills/broco/` and links or syncs it into your detected host harnesses (**Claude Code**, **Codex**, **Cursor**, **Antigravity**, **OpenCode**, and **Pi** — linking `~/.pi/agent/skills/broco` and respecting `PI_CODING_AGENT_DIR`).

Run `broco setup` again after upgrading `broco` or switching Node installations. If an open chat does not pick up the skill right away, reopen that host session.

## Windows 11 notes

- **Native shells vs WSL2:** `broco` runs natively in PowerShell (`pwsh` and Windows PowerShell 5.1), Windows Terminal, and `cmd`, storing state in `%USERPROFILE%\.broco` over Windows Named Pipes (`\\.\pipe\broco-*`). WSL2 runs independently via the Linux backend with its own Linux Node.js 24+, `~/.broco/`, and Linux-installed CLIs — run `broco` in the same environment where your coding CLIs live.
- **Pinned launcher & PowerShell `ExecutionPolicy`:** `broco setup` writes `%USERPROFILE%\.agents\skills\broco\broco.cmd` so agent hosts invoke Node directly without hitting PowerShell `.ps1` restrictions (in PowerShell, prefix a quoted launcher path with `& `, e.g. `& "C:\Users\you\.agents\skills\broco\broco.cmd" roster --json`). If typing `broco` interactively in PowerShell hits a `PSSecurityException` on npm’s global `broco.ps1` shim, run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` or call `broco.cmd`.
- **Direct CLI & shim resolution:** Prioritizes `PATHEXT` to resolve `.exe` binaries and unwrap npm `.cmd`/`.bat` Node shims directly to `node.exe` without shell quoting issues, falling back cleanly via `ComSpec` (`cmd.exe`) for non-Node `.cmd`/`.bat` wrappers (such as `.cmd` launchers that delegate to PowerShell scripts).
- **Multi-line prompts in PowerShell & `cmd`:** POSIX `<<'EOF'` heredocs do not exist in PowerShell or `cmd`. Pass `--file prompt.md` (works in every shell) or pipe a single-quoted PowerShell here-string (`@' ... '@ | broco say NAME - --bg --json`).
- **Admin-free Pi skill links & worker isolation:** Links `%USERPROFILE%\.pi\agent\skills\broco` via an NTFS directory junction without administrator privileges (with a `SKILL.md` copy fallback if restricted). Across macOS, Linux, and Windows, normal `pi` workers run directly with isolated session paths (`~/.broco/sessions`) and stripped host-session variables (macOS `sandbox-exec` is used only in isolated `.sandbox` profile runs to fence `~/.pi`).

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

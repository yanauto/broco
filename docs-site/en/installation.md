# Installation

Install `broco` once on your machine to let your coding harnesses work together. Run `broco setup` to confirm your global allowlist and install one open `SKILL.md` into your local hosts — no per-repo `init` required.

## What you need

- **OS:** macOS (`arm64` / `x64`), Linux (`x64` / `arm64` glibc), or Windows 11 (`x64` / `arm64`).
- **Node.js:** Automatically bundled when missing or older than 22.13.0 by the one-line installer; installing directly via `npm` requires **Node.js 22.13+** (for built-in `node:sqlite`).
- **Git:** Required for isolated worktrees and custom-template trials (Git for Windows on Windows 11).
- **Local CLIs:** At least two AI CLIs you already signed into locally (for example Claude Code, Codex, Antigravity `agy`, Cursor Agent, OpenCode, or `pi`).

## Install the CLI and open skill

### One-line installer (recommended)

macOS / Linux:

```sh
curl -fsSL https://broco.yanauto.me/install.sh | sh
```

Windows (PowerShell 5.1 or PowerShell 7):

```powershell
irm https://broco.yanauto.me/install.ps1 | iex
```

What the installer does:

- Reuses `node` on `PATH` if it is `22.13.0` or newer; otherwise downloads the official Node 24 LTS archive, verifies its SHA-256 checksum, and extracts it privately into `<install-root>/runtime/`.
- Installs `@yanauto/broco` into `<install-root>/app/` without touching your existing Node installation or global npm prefix, and requires no administrator privileges.
- Places the entry point at `~/.local/bin/broco` on macOS/Linux (default root `~/.local/share/broco`) or `<install-root>\bin\broco.cmd` on Windows (default root `%LOCALAPPDATA%\broco`, appended to your User `Path` and current session). Unix never edits your shell rc files; if `~/.local/bin` is not on `PATH`, it prints the exact `export PATH=...` line.
- Runs `broco setup` automatically in interactive shells (or prints `Next: broco setup` in non-interactive shells). Re-run the same command anytime to upgrade in place.

### Already on Node 22.13+? (npm)

```sh
node --version
npm install -g @yanauto/broco
broco setup
```

`broco setup` does four things in one pass:

1. Detects the AI CLIs already installed and signed in on your machine.
2. Asks you once to confirm your global allowlist (never enables workers silently).
3. Prints a live quota-aware roster on the spot.
4. Installs one open `SKILL.md` into `~/.agents/skills/broco/` and links or syncs it into your detected host harnesses (**Claude Code**, **Codex**, **Cursor**, **Antigravity**, **OpenCode**, and **Pi** — linking `~/.pi/agent/skills/broco` and respecting `PI_CODING_AGENT_DIR`).

Run `broco setup` again after upgrading `broco` or switching Node installations. If an open chat does not pick up the skill right away, reopen that host session.

## Install options

Both installers support environment variables (and flags `--uninstall`, `--purge`, `--no-setup`, `--version <ver>`, `--help` on Unix; `-Uninstall`, `-Purge`, `-NoSetup`, `-Version <ver>` on Windows):

| Option | Behavior |
| --- | --- |
| `BROCO_INSTALL_DIR` | Override install root (`~/.local/share/broco` on Unix, `%LOCALAPPDATA%\broco` on Windows). |
| `BROCO_BIN_DIR` | Override Unix shim directory (default `~/.local/bin`). |
| `BROCO_VERSION` | Install a pinned `@yanauto/broco` version or dist-tag (default `latest`). |
| `BROCO_NODE_MIRROR` | Override Node download base (default `https://nodejs.org/dist`, auto-falls back to `https://npmmirror.com/mirrors/node` on failure). |
| `BROCO_NPM_REGISTRY` | Override npm registry (default `https://registry.npmjs.org`, auto-falls back to `https://registry.npmmirror.com` on failure). |
| `BROCO_FORCE_RUNTIME=1` | Always download the private Node 24 LTS runtime into `<install-root>/runtime/` instead of reusing `node` on `PATH`. |
| `BROCO_NO_SETUP=1` | Skip running `broco setup` after install and print `Next: broco setup`. |
| `BROCO_PACKAGE` | Install from a local `.tgz` tarball path (for offline or CI testing). |
| `BROCO_UNINSTALL=1` | Uninstall `broco`; pair with `BROCO_PURGE=1` to also delete `~/.broco/`. |

> [!TIP]
> Users in mainland China do not need manual mirror configuration unless preferred — both installers automatically fall back to `npmmirror.com` for Node archives and npm packages when the default upstream fails.

## AI agents installing broco

> [!NOTE]
> When an AI coding agent installs `broco` on behalf of a user, skip interactive `/dev/tty` prompts with `BROCO_NO_SETUP=1` and run `broco setup` explicitly with `--allow` and `--yes`:

macOS / Linux:

```sh
curl -fsSL https://broco.yanauto.me/install.sh | BROCO_NO_SETUP=1 sh
"$HOME/.local/bin/broco" setup --allow claude,codex,agy --yes --json
```

Windows (PowerShell):

```powershell
$env:BROCO_NO_SETUP = '1'
irm https://broco.yanauto.me/install.ps1 | iex
& "$env:LOCALAPPDATA\broco\bin\broco.cmd" setup --allow claude,codex,agy --yes --json
```

Invoking `"$HOME/.local/bin/broco"` on Unix (or `BROCO_BIN_DIR`) and `"$env:LOCALAPPDATA\broco\bin\broco.cmd"` on Windows (or `BROCO_INSTALL_DIR`) works immediately across separate agent tool calls even before the parent host refreshes its `PATH`.

## Uninstall

macOS / Linux:

```sh
curl -fsSL https://broco.yanauto.me/install.sh | sh -s -- --uninstall
```

Windows (PowerShell):

```powershell
& ([scriptblock]::Create((irm https://broco.yanauto.me/install.ps1))) -Uninstall
```

Both commands remove the install root, entry shim, and Windows User `Path` entry while preserving `~/.broco/` ticket history and settings. Append `--purge` alongside `--uninstall` (`-Uninstall -Purge` on Windows, or set both `BROCO_UNINSTALL=1` and `BROCO_PURGE=1`) to remove `~/.broco/` as well. If you installed via npm, run `npm uninstall -g @yanauto/broco`.

## Windows 11 notes

- **Native shells vs WSL2:** `broco` runs natively in PowerShell (`pwsh` and Windows PowerShell 5.1), Windows Terminal, and `cmd`, storing state in `%USERPROFILE%\.broco` over Windows Named Pipes (`\\.\pipe\broco-*`). WSL2 runs independently via the Linux backend with its own Linux Node.js 22.13+ (or Unix installer), `~/.broco/`, and Linux-installed CLIs — run `broco` in the same environment where your coding CLIs live.
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

# Changelog

## 1.1.0

### English

Released 2026-11-20 — Native Windows 11 support alongside macOS and Linux in one `@yanauto/broco` package.

- **Windows Platform Adapter & Named Pipes IPC**:
  - Added native Windows 11 runner lifecycle, process tree reaping, browser/terminal helpers, and Windows Named Pipe (`\\.\pipe\broco-*`) transport across PowerShell, Windows Terminal, and `cmd` (with WSL2 supported via the Linux backend).
  - Kept macOS Seatbelt (`sandbox-exec`) protection for `~/.pi` scoped to macOS isolated `.sandbox` runs; across macOS, Linux, and Windows, normal `pi` workers run directly with isolated session and profile environment variables.
- **Cross-Platform CLI & Shim Resolver**:
  - Resolves `.exe` executables and npm `.cmd`/`.bat` Node shims directly without shell quoting issues, prioritizing `PATHEXT` entries over extensionless POSIX shims and falling back cleanly via `ComSpec` for non-Node `.cmd`/`.bat` wrappers (including `.cmd` launchers for PowerShell scripts).
- **Windows Launcher & Admin-Free Pi Skill Linking**:
  - `broco setup` writes a `broco.cmd` launcher, supports Windows `PATH` sanitization (`;` delimiter and drive letters), and links Pi skills (`~/.pi/agent/skills/broco`) via NTFS directory junctions without administrator privileges (falling back to copying `SKILL.md` when restricted).
- **Windows CI Coverage**:
  - Expanded GitHub Actions CI to run the test suite on both `ubuntu-latest` and `windows-latest` with Node.js 24.

### 简体中文

2026-11-20 发布 —— 在同一个 `@yanauto/broco` 包内提供原生 Windows 11 支持，完整覆盖 macOS、Linux 与 Windows 三平台。

- **Windows 平台适配器与命名管道通信**：
  - 新增原生 Windows 11 后台生命周期、进程树清理、浏览器／终端拉起与 Windows 命名管道（`\\.\pipe\broco-*`）传输，原生支持 PowerShell、Windows Terminal 与 `cmd`（WSL2 继续通过 Linux 后端运行）。
  - macOS Seatbelt（`sandbox-exec`）仅用于 macOS 下的 `.sandbox` 隔离运行以保护个人 `~/.pi`；在 macOS、Linux 与 Windows 三端，常规 `pi` 工人均通过隔离的会话目录与环境变量直接运行。
- **跨平台 CLI 与垫片解析器**：
  - 按 `PATHEXT` 优先直接解析 `.exe` 可执行文件与 npm `.cmd`/`.bat` Node 垫片，避开无后缀 POSIX 脚本并消除 shell 引号转义问题；遇到非 Node 的自定义 `.cmd`/`.bat` 包装脚本（含调用 PowerShell 脚本的 `.cmd` 启动器）时经 `ComSpec` 安全回退。
- **Windows 启动器与免管理员权限 Pi 技能挂载**：
  - `broco setup` 在 Windows 下生成 `broco.cmd` 启动器、支持分号分隔与盘符路径的 `PATH` 净化，并通过 NTFS 目录联接（junction）挂载 Pi 技能目录（`~/.pi/agent/skills/broco`），无需管理员权限（受限环境自动回退为复制 `SKILL.md`）。
- **Windows CI 矩阵**：
  - GitHub Actions CI 升级为在 `ubuntu-latest` 与 `windows-latest`（Node.js 24）双平台同步运行全量测试。

## 1.0.0

### English

`opus-manager` / `cc-bro` is now **`broco`** — a cross-harness collaboration CLI that lets your local coding agents work together using your existing official CLI logins.

- **L0 Zero-`init` Start & Multi-Host Open Skill**:
  - `broco setup` detects installed, signed-in CLIs on your machine, asks you once to confirm a global allowlist (never enables workers silently), prints a live quota-aware roster immediately, and installs one open `SKILL.md` into `~/.agents/skills/broco/` with automatic host syncing for **Claude Code**, **Codex**, **Cursor**, **Antigravity**, **OpenCode**, and **Pi** (linking `~/.pi/agent/skills/broco` and respecting `PI_CODING_AGENT_DIR`).
  - Works in any directory immediately after `setup` using your global policy — state stays in `~/.broco/` keyed by `realpath(gitRoot || cwd)`, leaving your repositories untouched.
  - Optional L1 `broco init` remains available for per-repo strict allowlists, concurrency caps, repo rules, or heavy manager mode (`--manager-mode`). `init` defaults to maintaining a marked `AGENTS.md` section (`--host` supports `auto|agents|claude|codex|cursor|agy|opencode|pi`) and touches `CLAUDE.md` only when already present or when `--host claude` is specified.
- **Built-in Symmetric `claude` Worker & Recursion Guard**:
  - Added native `claude` worker adapter (`claude -p --output-format stream-json` + `--resume`, stdin prompt passing, unified failure classification, and secret redaction) alongside `codex`, `agy`, `cursor-agent`, `pi:<provider>`, and `custom:<name>`. Any host agent can now dispatch to any worker symmetrically.
  - Added hard recursion protection: every worker subprocess inherits `BROCO_IN_WORKER=1`, and `broco` refuses nested worker-to-worker dispatch by default unless explicitly overridden with `--allow-nested`.
- **Default Cross-Vendor Blind Review**:
  - `broco review <name>` now makes `--by` optional: when omitted, it automatically picks a permitted worker from a different vendor with available quota headroom.
- **Dynamic Local Timezone & Brand Refresh**:
  - Replaced hardcoded `Asia/Shanghai` timestamps with dynamic local timezone resolution (`BROCO_TZ` → `TZ` → system timezone → `UTC`) across CLI output, audit entries, proxy expiry, and the local board.
  - Shipped the 16-bit pixel broccoli visual identity across the README, website, docs, favicons, and local board.
- **Unified Naming & Lossless Migration**:
  - Renamed package, CLI, data directory, project marker, and env vars to `broco`, `~/.broco/`, `.broco/`, and `BROCO_*`.

#### Upgrade from `cc-bro` (0.4.x) or `opus-manager`

Wait for any active work you want to keep (`cc-bro status` if still installed), install `broco`, then run `broco shutdown` and `broco setup`. `broco setup` detects existing `~/.cc-bro/` state and running legacy runners and walks you through lossless migration to `~/.broco/` without disturbing ticket history. See the [upgrade guide](docs-site/en/upgrade.md).

### 简体中文

`opus-manager` / `cc-bro` 正式演进为 **`broco`** v1.0.0——跨 harness 本地协作 CLI，让你当前正在用的 coding agent 直接复用本机其他已登录官方 CLI 一起干活。

- **L0 免 `init` 开箱直跑与多宿主开放 Skill**：
  - `broco setup` 一次完成本机 CLI 探测、全局允许名单单步确认（绝不静默全放行）、实时额度花名册输出，以及将开放 `SKILL.md` 写入 `~/.agents/skills/broco/` 并同步挂载到 **Claude Code**、**Codex**、**Cursor**、**Antigravity**、**OpenCode**、**Pi**（同时为 Pi 链接 `~/.pi/agent/skills/broco` 并支持 `PI_CODING_AGENT_DIR`）。
  - 装完即在任意目录按全局策略开跑，工单按 `realpath(gitRoot || cwd)` 归档于 `~/.broco/`，项目仓库保持原样。
  - 保留可选 L1 `broco init` 用于私密仓硬隔离名单、独立并发上限、项目规矩或显式重度经理模式（`--manager-mode`）；优先维护 `AGENTS.md` 标记段（`--host` 支持 `auto|agents|claude|codex|cursor|agy|opencode|pi`），无 `AGENTS.md` 且已有 `CLAUDE.md` 或显式传入 `--host claude` 时改为维护 `CLAUDE.md`。
- **内置全对称 `claude` 工人与防递归保护**：
  - 新增原生 `claude` 适配器（`claude -p --output-format stream-json` + `--resume`，stdin 传题、统一失败分类与凭据脱敏），与 `codex`、`agy`、`cursor-agent`、`pi:<厂商>`、`custom:<名称>` 全对称互调。
  - runner 启动工人进程强制注入 `BROCO_IN_WORKER=1`，默认拒绝工人嵌套派单（除非显式 `--allow-nested`）。
- **默认跨模型盲审**：
  - `broco review <名字>` 支持省略 `--by`，自动优先挑选与原单不同厂商且额度宽裕的已放行工人。
- **动态本机时区与像素西兰花视觉**：
  - 移除硬编码 `Asia/Shanghai`，按 `BROCO_TZ` → `TZ` → 系统时区 → `UTC` 动态显示 CLI、审计日志、凭据代理与看板时间。
  - 全面换装 16-bit 戴安全帽像素西兰花视觉体系（README、官网、文档、favicon 与本地看板）。
- **统一更名与无损迁移**：
  - 包名、命令、数据目录、项目标记与环境变量统一迁至 `broco`、`~/.broco/`、`.broco/` 与 `BROCO_*`。

#### 从 `cc-bro`（0.4.x）或 `opus-manager` 升级

先确认需保留的在跑任务已完成，安装 `broco` 后运行 `broco shutdown` 和 `broco setup`。`broco setup` 自动探测本机 `~/.cc-bro/` 数据和旧版后台进程，提供一步无损迁移至 `~/.broco/`，完整保留项目与工单历史。详见[升级指南](docs-site/zh/upgrade.md)。

## 0.4.1

### English

- **Agent-First CLI Ergonomics**:
  - `say` reads multi-line or backtick-heavy prompts from `--file <path>`, `--file -`, or `stdin` (`-` or piped input) without shell-escaping friction or `ps` argv exposure.
  - Added `cc-bro status [--project PATH] [--all] [--json]` to inspect runner health, protocol compatibility, web URL, active credential proxies, active/queued tickets, batches and cleanable worktrees without auto-starting an offline runner.
  - Added `cc-bro diff <name> [--stat] [--json]` (tracked + untracked changes against the ticket's base commit) and `cc-bro clean [name|prefix] [--dry-run] [--delete-branch] [--force] [--json]` (safe worktree + orphaned attachment cleanup).
  - Added context-saving filters on `ls` (`--active`, `--status`, `--flag`, `--batch`, `--limit`) and `show` (`--compact`, `--turn`, plus batch `--status` and `--full`), batch-level `cc-bro retry <prefix>` for failed/stopped shards, `map --inputs-file <path|->`, `roster --global`, `stats --project`, `init --project`, `~/` path expansion, and `--json` across `setup`, `ui`, and `shutdown`.
- **Runtime, SQLite & Lifecycle Optimization**:
  - Event-driven `/wait` wakes immediately (0ms) via microtask-coalesced `Projects` notifications instead of 140ms SQLite polling, returning `task`, `cwd`, `worktree`, `branch` and `changedFiles` alongside the turn result.
  - Rewrote `Store.ticketRows`, `batchDetail` and `ticketRecords` into constant-count batched SQLite queries (`BEGIN IMMEDIATE` write transactions, indexed timelines, microtask-coalesced queue/SSE broadcasts, bulk `{ type: 'tickets' }` SSE frames, and async live `git` file tracking) — 150-shard `map` + board queries run in ~260ms.
  - Orphan-free worker and service lifecycle: `SIGTERM`/`SIGINT` aborts and reaps active workers while preserving queued turns; `done`, `uninit` and a 10-minute idle timer release idle `pi` RPC processes; `0700` UID-verified socket directory with seamless `0.4.0` legacy socket upgrade guard; Linux `/proc` platform backend; full secret redaction across native/stream/template workers; and sanitized `PATH` / `npm_config_prefix` handling in `setup` and `install-local.sh`.
- **Board UI & Quota Polish**:
  - Upgraded the Svelte 5 board (`100dvh` independent column scroll, 50-card Done cap, search and batch/outcome filters) with live `map` batch progress bars, `[index/count]` shard badges and sibling shard switcher, queue badges, multi-task history, collapsed `Asia/Shanghai` (`UTC+8`) timelines, problem/context callouts, accurate `runningCount` pulse, auto-restored `web_port` across runner restarts, `agy` secondary-group quota warnings, and full `agy` catalog `picks`.

#### Upgrade from 0.4.0 or earlier

Check `cc-bro status`, let active work you want to keep finish, then run `cc-bro shutdown` and `cc-bro setup`. Version `0.4.1` uses runner protocol `14` (`cc-bro shutdown` cleanly stops protocols `4`–`13`, including `0.4.0` legacy `/tmp` sockets).

### 简体中文

- **面向 Agent 的 CLI 易用性升级**：
  - `say` 支持 `--file <路径>`、`--file -` 及 `stdin`（`-`／管道／heredoc）读取多行或含反引号与 `$` 变量的复杂提示词，免除 shell 转义困扰且不在 `ps` 暴露题面。
  - 新增 `cc-bro status [--project 路径] [--all] [--json]`，在不额外拉起未启动服务的前提下查看后台健康度、协议兼容性、看板地址、凭据代理、在跑／排队单、批次进度与可清理 worktree。
  - 新增 `cc-bro diff <名字> [--stat] [--json]`（对比基线提交查看跟踪与未跟踪改动）与 `cc-bro clean [名字|前缀] [--dry-run] [--delete-branch] [--force] [--json]`（安全清理已完成 worktree 与孤立附件快照）。
  - `ls` 新增 `--active`、`--status`、`--flag`、`--batch`、`--limit` 过滤；`show` 新增 `--compact`、`--turn` 及批次 `--status`／`--full`；新增批次级 `cc-bro retry <前缀>`、`map --inputs-file`、`roster --global`、`stats --project`、`init --project`、`~/` 路径展开，以及 `setup`／`ui`／`shutdown` 的 `--json` 输出。
- **后台性能、SQLite 与进程生命周期治理**：
  - `/wait` 改为微任务合并的事件驱动即刻唤醒（0ms，告别 140ms SQLite 轮询），直接返回 `task`、`cwd`、`worktree`、`branch` 与 `changedFiles`。
  - `Store.ticketRows`、`batchDetail` 与 `ticketRecords` 重写为常数次批量 SQL 查询（`BEGIN IMMEDIATE` 写事务、时间线索引、队列与 SSE 微任务合并、`>4` 变更合并推送 `tickets` 帧、异步 `git` 改动统计），150 分片并发查询耗时约 260ms。
  - 无孤儿进程生命周期：`SIGTERM`/`SIGINT` 干净中止并回收在跑子进程且保留排队单；`done`、`uninit` 与 10 分钟空闲定时器自动回收空闲 `pi` 进程；`0700` UID 校验套接字目录并兼容 `0.4.0` 旧套接字平滑升级；新增 Linux `/proc` 平台支持、全通道凭据脱敏，以及 `setup`／`install-local.sh` 环境净化。
- **看板界面与额度体验**：
  - Svelte 5 看板全面适配 `0.4.x`（`100dvh` 独立分栏滚动、Done 折叠、搜索与批次／结果筛选、`map` 分片进度条与兄弟分片切换、排队名次、多任务历史、折叠北京时间 `UTC+8` 活动流、故障与上下文告警、准确的 `runningCount` 呼吸灯、重启自动恢复端口、`agy` 副组额度告警及全类别模型 `picks`）。

#### 从 0.4.0 及更早版本升级

先用 `cc-bro status` 确认任务状态，等需保留的在跑任务完成后执行 `cc-bro shutdown` 和 `cc-bro setup`（`0.4.1` 使用协议 `14`，`shutdown` 兼容协议 `4`–`13` 及旧 `/tmp` 套接字）。

## 0.4.0

### English

- Added per-project FIFO concurrency pools (`--concurrency`, `cc-bro set concurrency`), sharded batch fan-out (`cc-bro map`), `cc-bro retry`, optional turn on `wait`, native `agy` stdin prompts + `/usage` quota + 5-modality attachments, direct Agent-First configuration commands (`set`, `allow`, `deny`, `defaults`, `note`, `rules`, `hide`, `unhide`) with `Asia/Shanghai` audit log and `cc-bro undo`, `init`/`uninit` `CLAUDE.md` markers, `cc-bro --version`, runner crash/signal recovery tracking, and loopback credential proxies (`proxy-open`, `proxy-list`, `proxy-close`).

### 简体中文

- 新增按项目隔离的先来先跑并发池（`--concurrency`、`cc-bro set concurrency`）、`cc-bro map` 批量分片派发、`cc-bro retry`、省略轮次的 `wait`、`agy` 原生 stdin 传题与 `/usage` 额度及五模态附件、Agent 直接配置命令与北京时间审计撤回（`audit`／`undo`）、`init`/`uninit` 自动维护 `CLAUDE.md`、`cc-bro --version`、后台生命周期恢复记录，以及本地回环凭据代理（`proxy-open`、`proxy-list`、`proxy-close`）。

## 0.3.1

### English

- The roster discovers all installed, signed-in CLI models and pi providers. Project permissions still apply. Hide model families globally or per project to remove them from the manager's roster and reject dispatch, including queued starts.
- Model descriptions, tiers, grades and task picks ship in the package. Override entries by ID in `~/.cc-bro/models.json`. The skill checks input capabilities first, honors user notes and rules, and flags research older than 60 days.
- Model inputs are intersected with the CLI's actual transport. CLI-reported context and output limits take precedence over catalog API ceilings; missing data stays unknown. `say --attach` delivers supported images through native Codex or pi, with snapshots preserved for queued turns.
- Each bro can have a global default model and effort, with project overrides. The roster and Settings show effective defaults; subsequent dispatches use them without changing other CLI settings.
- Text and JSON rosters are compact by default. Denied bros contain only ID and permission; effort/fast variants share one row, and catalog-labeled older models are folded. Use `--full` for exact variants, limits and full metadata, or `--worker ID` to inspect one bro. Notes and rules remain intact.
- Bilingual Docs cover model capabilities, attachments, catalog overrides, hiding, defaults and compact queries.

#### Upgrade from 0.3.0

Install `cc-bro@0.3.1`, then run `cc-bro shutdown` and `cc-bro setup` to refresh the runner and skill. Let work you want to finish complete first: shutdown stops running and queued turns across all projects on that runner. Existing settings, sessions and tickets are preserved. **JSON consumers should use `roster --json --full` when they need detailed model fields.** Denied bros no longer expose models even in full mode; user-hidden models stay hidden. See the [upgrade guide](docs-site/en/upgrade.md).

### 简体中文

- 花名册自动发现已安装、已登录 CLI 的全部模型与 pi 厂商，仍遵守项目允许名单。可按 bro 全局隐藏模型系列，项目可覆盖；隐藏后从经理花名册移除，派单和排队开跑均拒绝。
- 随包提供模型简介、定位、档次和任务 picks，可在 `~/.cc-bro/models.json` 按 ID 覆盖。skill 先核对输入能力，用户备注和规矩优先，研究超过 60 天提醒更新。
- 输入能力取模型与当前 CLI 通道的交集；CLI 实报上下文和输出上限优先于目录 API 上限，缺数保留 unknown。`say --attach` 可通过原生 Codex 或 pi 交付支持的图片，并保存排队轮次的附件快照。
- 每个 bro 可设全局默认模型和档位，项目可覆盖。花名册与配置页显示生效值，下次派活使用新配置，不改其他 CLI 的设置。
- 文本和 JSON 花名册默认紧凑：未允许的 bro 只列名字和权限，档位／fast 变体合并一行，目录标记的旧型号折叠。`--full` 查询具体变体、上限和完整元数据，`--worker ID` 只查一个 bro；用户备注和规矩完整保留。
- 中英文 Docs 补齐模型能力、附件、目录覆盖、隐藏、默认值和紧凑查询。

#### 从 0.3.0 升级

安装 `cc-bro@0.3.1`，再执行 `cc-bro shutdown`、`cc-bro setup` 更新服务和技能。想做完的单先等完成；停机会停止该服务下所有项目的运行单和排队单。原有设置、会话和工单保留。**依赖模型详细字段的 JSON 调用方改用 `roster --json --full`。** 完整模式也不展示未允许 bro 的模型，用户隐藏项仍不出现，详见[升级指南](docs-site/zh/upgrade.md)。

## 0.3.0

### English

- A live project roster exposes permitted CLIs, models, effort levels, detected defaults, login, capabilities, rules and user notes. The Claude Code skill reads it before choosing a bro. `say` and `review` accept `--effort` and can change models between completed turns.
- Built-in agy and cursor-agent workers join native Codex and pi. They resume by explicit session ID and queue active follow-ups. Cache is shown only when the CLI reports it. Every backend can use worktrees and participate in linked reviews.
- Custom CLI templates provide new-session and resume commands, reply/ID extraction and optional model/effort arguments. A real two-turn memory trial is required before saving. Gemini CLI and OpenCode are editable, degraded presets rather than unverified full adapters.
- The board has global and project Settings: read-only detection, install/update/login commands opened in Terminal, allowlists, defaults, notes and rules. Manager-proposed notes need user confirmation. Settings are stored only in cc-bro; credential-file values and other CLI configuration are untouched.
- The website adds bilingual roster, custom CLI and Settings guides.

#### Upgrade from 0.2.0

Install `cc-bro@0.3.0`, then use the new `cc-bro shutdown` and rerun `cc-bro setup`. Wait first if you want active work to finish: shutdown cancels running and queued turns across the runner’s projects. Existing 0.2 policies, named sessions and ticket history are preserved; no new workers are allowed automatically. The old-runner shutdown path remains compatible with 0.1.0 and M2. See the [upgrade guide](docs-site/en/upgrade.md).

### 简体中文

- 新增实时项目花名册，列出允许的 CLI、模型、档位、检测默认值、登录、能力、规矩和用户备注。Claude Code 技能先读花名册再派活。`say` 和 `review` 支持 `--effort`，完成一轮后可换模型。
- 内置 agy、cursor-agent，与原生 Codex、pi 并列。按明确会话 ID 续聊，运行中追加要求排到下一轮。CLI 有上报才显示缓存。各后端都可使用 worktree、互为关联审查者。
- 自定义 CLI 模板支持新对话、续聊、回复／ID 提取、可选模型和档位参数，保存前必须通过真实两轮记忆试跑。Gemini CLI 和 OpenCode 是可编辑降级预设，不冒充已验证的全功能适配器。
- 看板新增全局／项目配置：只读检测、在终端打开安装／升级／登录命令、允许名单、默认值、备注和规矩。经理提议的备注必须用户确认。配置只存在 cc-bro，不读凭据文件值，不写其他 CLI 配置。
- 官网新增中英花名册、自定义 CLI、配置页指南。

#### 从 0.2.0 升级

安装 `cc-bro@0.3.0`，用新版执行 `cc-bro shutdown` 后重跑 `cc-bro setup`。想让在跑的任务完成就先等待；停机会取消服务所有项目的运行单和排队单。保留 0.2 原有权限、具名会话和工单历史，不自动放行新工人。旧服务停机仍兼容 0.1.0、M2，详见[升级指南](docs-site/zh/upgrade.md)。

## 0.2.0

### English

#### Breaking: the manager room is gone

Open Claude Code in the project itself. The separate manager folder, its local skill and the board’s provider settings were part of 0.1.0. The new user-level skill delegates from the chat you already use. The new registry does not import 0.1.0 tickets or manager notes.

#### Workers and tickets

- Choose native Codex or a pi provider for each ticket. Register the allowed worker IDs and a default per project. Native Codex and pi using a Codex subscription are separate choices.
- Reuse a name to continue a session; use different names to run in parallel. A follow-up receipt says whether it reached the current turn, was queued for the next turn or was rejected.
- Start a ticket in a Git worktree or ask a different worker to review a completed turn. The board shows the branch, changed files, steps, linked reviews and reported input cache hits. Acceptance leaves the branch and worktree intact.

#### Upgrade from 0.1.0

1. Let any work you want to keep running finish. If you have notes in a manager room, keep that folder for reference.
2. Install with `npm install -g cc-bro@0.2.0`. If an old runner is active, use the new `cc-bro shutdown`. It stops running and queued work across that runner’s projects; unfinished turns do not resume automatically. Files already written stay on disk.
3. Run `cc-bro setup`. In the actual project root, run `cc-bro init` and choose allowed workers and a default. Open Claude Code there and type `/cc-bro`. The old ticket database stays on disk.

See the [upgrade walkthrough](docs-site/en/upgrade.md).

### 简体中文

#### 不兼容：移除经理室

直接在项目里打开 Claude Code。0.1.0 的独立经理室、目录里的技能和看板中的厂商设置都已移除。新版把技能装到用户目录，由你正在使用的对话派单。新登记库不会导入 0.1.0 的工单或经理笔记。

#### 工人与工单

- 每张单可选原生 Codex 或一个 pi 厂商。每个项目分别登记允许的工人和默认工人。原生 Codex 和通过 pi 使用 Codex 订阅是两个独立选项。
- 同名续会话，不同名可并行。运行中追加要求，回执明确显示已注入当轮、排到下一轮或被拒。
- 可以用独立 Git worktree 写单，也可以让另一个工人审查已完成的轮次。看板展示分支、改动文件、步骤、关联审查单和工人上报的输入缓存命中率。收单时保留分支和 worktree。

#### 从 0.1.0 升级

1. 想让旧单做完就先等它们结束。经理室里有用的笔记可留在原文件夹查阅。
2. 运行 `npm install -g cc-bro@0.2.0`。若旧服务仍在运行，用新版执行 `cc-bro shutdown`。这会停止该服务所有项目的运行单和排队单；未完成的轮次不会自动续跑，已经写入的文件保留。
3. 运行 `cc-bro setup`。进入实际项目根目录运行 `cc-bro init`，选好允许的工人和默认工人。在这里打开 Claude Code，输入 `/cc-bro`。旧工单数据库保留在磁盘上。

详见[升级指南](docs-site/zh/upgrade.md)。

## 0.1.0

### English

The first macOS preview paired each project with a separate Claude Code manager room. Named pi workers ran in the project and continued working when the manager chat closed.

- The setup board could install pi, connect a provider using a key or subscription, and set the default worker model.
- Tickets moved through Queued, Working, Review and Done. The CLI could send follow-ups, show history, wait for a turn or stop a worker. The local board showed progress across projects.

### 简体中文

首个 macOS 预览版为每个项目建立独立的 Claude Code 经理室。具名 pi 工人在项目里执行任务，关闭经理对话后仍能继续工作。

- 可在引导看板安装 pi、用密钥或订阅连接厂商，并设置默认工人模型。
- 工单经过排队、进行中、待验收、已完成四列。命令行支持插话、查看历史、等待轮次和停止工人；本机看板可以查看多个项目的进度。

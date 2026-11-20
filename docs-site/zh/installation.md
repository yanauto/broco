# 安装

在本机安装一次 `broco`，让不同 harness 里的 AI 一起干活。执行一次 `broco setup` 确认全局允许名单并装好开放 `SKILL.md`——无需逐个项目运行 `init`，直接在你现有的主 Agent 对话框里开用。

## 准备环境

需要 macOS、Linux 或 Windows 11、Node.js 24+（内置 `node:sqlite` 所需）、Git（Windows 11 需安装 Git for Windows），以及至少两个你已在本机登录好的 AI CLI（例如 Claude Code、Codex、Antigravity `agy`、Cursor Agent 或 `pi`）。独立 worktree 与自定义模板试跑均依赖 Git。

```sh
node --version
```

## 安装 CLI 与开放 Skill

```sh
npm install -g @yanauto/broco
broco setup
```

`broco setup` 一次完成四件事：

1. 自动探测本机已安装且已登录的 AI CLI。
2. 一步请你确认全局允许名单（绝不静默全放行）。
3. 当场打印带实时额度状态的花名册。
4. 将开放 `SKILL.md` 安装至 `~/.agents/skills/broco/`，并自动同步挂载到已探测到的宿主 harness（**Claude Code**、**Codex**、**Cursor**、**Antigravity**、**OpenCode**、**Pi**——同时为 Pi 链接 `~/.pi/agent/skills/broco` 并支持 `PI_CODING_AGENT_DIR`）。

升级 `broco` 或切换 Node 版本后重新执行一次 `broco setup` 即可。若已打开的对话框未立即读到技能，重开该会话即可生效。

## Windows 11 说明

- **原生终端与 WSL2 边界**：`broco` 原生运行于 PowerShell（`pwsh` 与 Windows PowerShell 5.1）、Windows Terminal 及 `cmd`，状态保存在 `%USERPROFILE%\.broco`，通过 Windows 命名管道（`\\.\pipe\broco-*`）通信。WSL2 则作为独立 Linux 环境通过 Linux 后端运行，拥有各自独立的 Node.js 24+、`~/.broco/` 与 CLI——请在你的编程 CLI 实际安装所在的一侧运行 `broco`。
- **固定启动器与 PowerShell 执行策略**：`broco setup` 会生成 `%USERPROFILE%\.agents\skills\broco\broco.cmd`，让宿主 Agent 直接调用 Node，避开 PowerShell `.ps1` 执行策略限制（在 PowerShell 中调用带引号路径需加 `& ` 前缀，例如 `& "C:\Users\you\.agents\skills\broco\broco.cmd" roster --json`）。若在 PowerShell 手动敲 `broco` 遇到 npm 全局 `broco.ps1` 的 `PSSecurityException` 拦截，执行 `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` 或改调 `broco.cmd` 即可。
- **直接解析 CLI 与垫片**：优先按 `PATHEXT` 直接解析 `.exe` 可执行文件并将 npm `.cmd`/`.bat` Node 垫片直连至 `node.exe`，免除 shell 引号转义问题；遇到非 Node 的 `.cmd`/`.bat` 包装脚本（如内部调用 PowerShell 脚本的 `.cmd` 启动器）时经 `ComSpec`（`cmd.exe`）平滑回退。
- **PowerShell 与 `cmd` 下的多行题面**：Windows PowerShell 与 `cmd` 不支持 POSIX `<<'EOF'` heredoc。请使用全平台通用的 `--file prompt.md`，或在 PowerShell 中用单引号 here-string 管道（`@' ... '@ | broco say 名字 - --bg --json`）。
- **免管理员挂载 Pi 技能与工人隔离**：使用 NTFS 目录联接（junction）链接 `%USERPROFILE%\.pi\agent\skills\broco`，无需管理员权限（受限环境自动回退为复制 `SKILL.md`）。在 macOS、Linux 与 Windows 三端，常规 `pi` 工人均使用独立的会话目录（`~/.broco/sessions`）并剥离宿主环境变量直接运行（macOS `sandbox-exec` 仅在内部 `.sandbox` 隔离模式下用于保护个人 `~/.pi`）。

## L0 免 `init` 与可选 L1 `init`

跑完 `broco setup` 后，回到任意目录的主 Agent 对话框即可用自然语言直接派活。`broco` 按 `realpath(gitRoot || cwd)` 把工单历史存放在 `~/.broco/`，不会在你的项目仓库里建立隐藏目录，也不会改动 `CLAUDE.md` 或 `AGENTS.md`。

只有当某个特定仓库需要独立硬隔离名单、专属并发上限、项目规矩或显式重度经理模式（`--manager-mode`）时，才需要按需运行 `broco init`。详见[全局与项目策略](allowlist.md)。

## 什么时候让它们一起干活

- **写完代码，换一家盲审。** 主力 harness 改完代码后，直接把 git diff 交给另一家模型独立审读，只看真实改动，更容易挑出边界漏洞和回归风险。
- **主力快撞限额，顺手接力。** 当前主力接近 5 小时限额时，把补测试、重构等任务顺手交给余量充足的另一个 harness，手头进度不断档。
- **借用另一家的模态与专长。** 留在当前终端里，遇到截图、PDF、音视频分析或特定模型强项时，随手交给 Claude、Gemini、Codex、Cursor 或 Pi 里最顺手的那一个。
- **多文件任务，独立分支并行。** 批量审计、多模块迁移或重复改造，拆成多个独立 git worktree 并行推进，不打断主会话的节奏。

## 下一步

查看[工人选择与登录](workers.md)核对 CLI 登录状态，或直接前往[第一张工单](quickstart.md)。从 `cc-bro` 或 `opus-manager` 升级？请读[升级与迁移](upgrade.md)。

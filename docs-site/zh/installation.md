# 安装

在本机安装一次 `broco`，让不同 harness 里的 AI 一起干活。执行一次 `broco setup` 确认全局允许名单并装好开放 `SKILL.md`——无需逐个项目运行 `init`，直接在你现有的主 Agent 对话框里开用。

## 准备环境

- **系统平台**：macOS（`arm64` / `x64`）、Linux（`x64` / `arm64` glibc）或 Windows 11（`x64` / `arm64`）。
- **Node.js**：使用一行安装脚本时，若本机缺失或低于 22.13.0 会自动自带独立 Node 运行时；改用 `npm` 直接安装则需要 **Node.js 22.13+**（内置 `node:sqlite` 所需）。
- **Git**：独立 worktree 与自定义模板试跑均依赖 Git（Windows 11 需安装 Git for Windows）。
- **本机编程 CLI**：至少两个你已在本机登录好的 AI CLI（例如 Claude Code、Codex、Antigravity `agy`、Cursor Agent、OpenCode 或 `pi`）。

## 安装 CLI 与开放 Skill

### 一行脚本安装（推荐）

macOS / Linux：

```sh
curl -fsSL https://broco.yanauto.me/install.sh | sh
```

Windows（PowerShell 5.1 或 PowerShell 7）：

```powershell
irm https://broco.yanauto.me/install.ps1 | iex
```

安装脚本会完成以下动作：

- 若 `PATH` 上已有 `22.13.0` 及以上版本的 `node`，直接复用；否则下载官方 Node 24 LTS 压缩包、校验 SHA-256 后解压至私有目录 `<安装根目录>/runtime/`。
- 将 `@yanauto/broco` 安装进 `<安装根目录>/app/`，保持本机原有 Node 与全局 npm 前缀原样，全程免管理员权限。
- 在 macOS/Linux 上写入入口 `~/.local/bin/broco`（默认安装根目录 `~/.local/share/broco`），在 Windows 上写入 `<安装根目录>\bin\broco.cmd`（默认安装根目录 `%LOCALAPPDATA%\broco`）并追加到用户 `Path` 及当前会话。Unix 脚本绝不改写你的 shell rc 文件；若 `~/.local/bin` 不在 `PATH` 中，会直接打印应添加的 `export PATH=...` 行。
- 交互终端下会自动继续运行 `broco setup`；非交互环境会提示 `Next: broco setup`。随时重复执行同一条命令即可原地升级。

### 本机已有 Node 22.13+？（npm）

```sh
node --version
npm install -g @yanauto/broco
broco setup
```

`broco setup` 一次完成四件事：

1. 自动探测本机已安装且已登录的 AI CLI。
2. 一步请你确认全局允许名单（绝不静默全放行）。
3. 当场打印带实时额度状态的花名册。
4. 将开放 `SKILL.md` 安装至 `~/.agents/skills/broco/`，并自动同步挂载到已探测到的宿主 harness（**Claude Code**、**Codex**、**Cursor**、**Antigravity**、**OpenCode**、**Pi**——同时为 Pi 链接 `~/.pi/agent/skills/broco` 并支持 `PI_CODING_AGENT_DIR`）。

升级 `broco` 或切换 Node 版本后重新执行一次 `broco setup` 即可。若已打开的对话框未立即读到技能，重开该会话即可生效。

## 安装选项

两条安装脚本均支持以下环境变量（也支持 `--uninstall`、`--purge`、`--no-setup`、`--version <版本>`、`--help`；Windows 对应 `-Uninstall`、`-Purge`、`-NoSetup`、`-Version <版本>`）：

| 选项 | 作用 |
| --- | --- |
| `BROCO_INSTALL_DIR` | 自定义安装根目录（Unix 默认 `~/.local/share/broco`，Windows 默认 `%LOCALAPPDATA%\broco`）。 |
| `BROCO_BIN_DIR` | 自定义 Unix 入口目录（默认 `~/.local/bin`）。 |
| `BROCO_VERSION` | 安装指定的 `@yanauto/broco` 版本号或 dist-tag（默认 `latest`）。 |
| `BROCO_NODE_MIRROR` | 覆盖 Node 下载源（默认 `https://nodejs.org/dist`，失败时自动回退至 `https://npmmirror.com/mirrors/node`）。 |
| `BROCO_NPM_REGISTRY` | 覆盖 npm 源（默认 `https://registry.npmjs.org`，失败时自动回退至 `https://registry.npmmirror.com`）。 |
| `BROCO_FORCE_RUNTIME=1` | 强制在 `<安装根目录>/runtime/` 下载独立 Node 24 LTS 运行时，跳过复用 `PATH` 上的 `node`。 |
| `BROCO_NO_SETUP=1` | 安装完成后跳过自动运行 `broco setup`，仅输出 `Next: broco setup`。 |
| `BROCO_PACKAGE` | 指定本地 `.tgz` 压缩包路径（适合离线安装或 CI 测试）。 |
| `BROCO_UNINSTALL=1` | 卸载 `broco`；配合 `BROCO_PURGE=1` 时同步删除 `~/.broco/`。 |

> [!TIP]
> 中国大陆用户通常无需手动配镜像——当默认官方源下载失败时，两条安装脚本都会自动回退到 `npmmirror.com` 拉取 Node 与 npm 包。

## 由 AI Agent 自动安装 broco

> [!NOTE]
> 如果由编程 Agent 替用户执行安装，请务必传入 `BROCO_NO_SETUP=1` 跳过 `/dev/tty` 交互确认，再显式调用带 `--allow` 与 `--yes` 的 `broco setup`：

macOS / Linux：

```sh
curl -fsSL https://broco.yanauto.me/install.sh | BROCO_NO_SETUP=1 sh
"$HOME/.local/bin/broco" setup --allow claude,codex,agy --yes --json
```

Windows（PowerShell）：

```powershell
$env:BROCO_NO_SETUP = '1'
irm https://broco.yanauto.me/install.ps1 | iex
& "$env:LOCALAPPDATA\broco\bin\broco.cmd" setup --allow claude,codex,agy --yes --json
```

在 Unix 下直接调用 `"$HOME/.local/bin/broco"`（或 `BROCO_BIN_DIR`）、在 Windows 下直接调用 `"$env:LOCALAPPDATA\broco\bin\broco.cmd"`（或 `BROCO_INSTALL_DIR`），即使宿主进程尚未刷新 `PATH`，也能在连续多次工具调用中直接跑通。

## 卸载

macOS / Linux：

```sh
curl -fsSL https://broco.yanauto.me/install.sh | sh -s -- --uninstall
```

Windows（PowerShell）：

```powershell
& ([scriptblock]::Create((irm https://broco.yanauto.me/install.ps1))) -Uninstall
```

两条卸载命令都会移除安装根目录、入口脚本与 Windows 用户 `Path` 条目，同时保留 `~/.broco/` 内的工单历史与策略。如需连同 `~/.broco/` 一并删除，在卸载命令后追加 `--purge`（Windows 为 `-Uninstall -Purge`，或同时设置 `BROCO_UNINSTALL=1` 与 `BROCO_PURGE=1`）。若通过 npm 安装，执行 `npm uninstall -g @yanauto/broco`。

## Windows 11 说明

- **原生终端与 WSL2 边界**：`broco` 原生运行于 PowerShell（`pwsh` 与 Windows PowerShell 5.1）、Windows Terminal 及 `cmd`，状态保存在 `%USERPROFILE%\.broco`，通过 Windows 命名管道（`\\.\pipe\broco-*`）通信。WSL2 则作为独立 Linux 环境通过 Linux 后端运行，拥有各自独立的 Linux Node.js 22.13+（或通过 Unix 脚本安装）、`~/.broco/` 与 CLI——请在你的编程 CLI 实际安装所在的一侧运行 `broco`。
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

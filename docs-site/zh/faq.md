# 常见问题

快速解答关于安装、权限、额度与运行机制的常见问题。

## 每个代码仓库都要跑一次 `broco init` 吗？

不需要。跑完一次 `broco setup` 后，L0 模式在任意目录直接沿用全局允许名单——不往仓库塞隐藏目录，也不改 `CLAUDE.md` 或 `AGENTS.md`。只有特定仓库需要更严格名单、独立并发上限、项目规矩或 `--manager-mode` 时才按需运行 `broco init`（L1）。详见[全局与项目策略](allowlist.md)。

## broco 如何与各家 CLI 认证？

`broco` 以隔离本地子进程直接运行你已经登录好的官方 CLI，沿用各家原生的登录态与配置，无需额外 API Key 或中转代理。

## 工人会递归再派给另一个工人造成无限套娃吗？

默认不会。runner 启动任何工人子进程时都会强制注入 `BROCO_IN_WORKER=1`。若工人在内部再次调用 `broco say`、`map`、`review` 或 `retry`，`broco` 会默认拒绝嵌套派单（除非显式传入 `--allow-nested`）。

## 工人明明登录了，为什么还是提示“未允许”？

登录状态与放行权限相互独立。通过 `broco setup`（或 `broco allow`）显式确认名单，防止误派给未授权的 CLI。每个 `pi:<厂商>`（如 `pi:openai-codex`、`pi:deepseek`）都是独立 ID。

## 实时额度是怎么读取的？

按各 CLI 原生能力尽力读取：`codex`（`account/rateLimits/read`）与 `agy`（`/usage`，仅限 API Key / 企业版——见[风险提示](../workers/#agy)）直接上报 5 小时与周额度（`avoid`、`plentiful` 及 `agy` 副组告警）。无额度接口的 CLI 标为 `unreported`，结合报错自动维护冷却状态（`recentProblem`）。

## 个人 Google 订阅方案能安全使用 Antigravity（`agy`）吗？

不能。Google 消费者订阅（Free、AI Plus、Pro、Ultra）禁止由第三方 Agent 驱动 Antigravity CLI，已有封号先例。`broco` 保留支持且不强制拦截，如需使用请自行承担风险，且仅建议配合 Gemini API Key 或 Gemini Enterprise / Google Cloud 项目使用。详见[工人选择与登录（`#agy`）](../workers/#agy)。

## 时间显示按什么时区？

`broco` 按 `BROCO_TZ` → `TZ` → 系统时区 → `UTC` 动态解析。如需固定显示时区，设置 `BROCO_TZ=Asia/Shanghai` 或其他 IANA 时区即可，CLI、审计记录与看板保持一致。

## 关掉主 Agent 对话框，正在跑的工人会停吗？

不会。本机 runner 独立继续执行在跑轮次与分片队列。重开任意对话或终端，用 `broco status`、`broco ls --active`、`broco show 名字 --compact` 或 `broco wait 名字` 即可接回；要终止某单用 `broco stop 名字`。

## 为什么审查者看不到我未提交的改动？

`--worktree` 从已提交的 `HEAD` 拉出独立工作区。先用 `broco diff 名字` 核对改动、等排队中的插话跑完，并在 `broco review` 期间保持该工作区稳定。详见[独立工作区与审查](review-worktree.md)。

## 支持哪些平台与使用环境？

`broco` 原生支持 macOS、Linux 与 Windows 11（PowerShell、Windows Terminal 与 `cmd`，WSL2 可通过 Linux 后端运行），需要 Git，适合在同一台电脑上装有两个及以上已登录编程 harness（Claude Code、Codex、Cursor、Pi、OpenCode，或配合 API/企业版使用的 Antigravity——见 [`#agy`](../workers/#agy)）的开发工作流。一行安装脚本会在需要时自带 Node 24 LTS 运行时（免管理员权限），通过 `npm` 安装则支持 Node.js 22.13+。原生 Windows 下通过命名管道（`\\.\pipe\broco-*`）通信、直接解析 `.exe` 与 npm `.cmd` CLI、生成 `broco.cmd` 技能启动器并通过免管理员权限的 NTFS 目录联接挂载 Pi 技能。同模型族内的几行快速小改，直接用当前宿主自带的 subagent 通常最轻快。

## 一行安装脚本会改动本机原有的 Node 或 npm 吗？

不会。当 `PATH` 中的 `node` 已达到 22.13.0 及以上（且未设置 `BROCO_FORCE_RUNTIME`）时，安装脚本会直接只读复用；否则仅在私有目录 `<安装根目录>/runtime/`（Unix 为 `~/.local/share/broco/runtime`，Windows 为 `%LOCALAPPDATA%\broco\runtime`）中解压独立的 Node 24 LTS 运行时，并用 `--prefix` 将 `@yanauto/broco` 装入 `<安装根目录>/app/`，保持全局 npm 前缀与 shell 配置文件原样。

## 如何卸载 broco？

在 macOS/Linux 上运行 `curl -fsSL https://broco.yanauto.me/install.sh | sh -s -- --uninstall`，在 Windows PowerShell 上运行 `& ([scriptblock]::Create((irm https://broco.yanauto.me/install.ps1))) -Uninstall`。卸载默认保留 `~/.broco/` 中的工单历史与策略；如需一并删除，在卸载命令后追加 `--purge` / `-Purge`（或同时设置 `BROCO_UNINSTALL=1` 与 `BROCO_PURGE=1`）。若通过 npm 安装，执行 `npm uninstall -g @yanauto/broco`。

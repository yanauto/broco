# 安装

在本机安装一次 `broco`，让不同 harness 里的 AI 一起干活。执行一次 `broco setup` 确认全局允许名单并装好开放 `SKILL.md`——无需逐个项目运行 `init`，直接在你现有的主 Agent 对话框里开用。

## 准备环境

需要 macOS 或 Linux、Node.js 24+，以及至少两个你已在本机登录好的 AI CLI（例如 Claude Code、Codex、Antigravity `agy`、Cursor Agent 或 `pi`）。使用独立 worktree 和自定义模板试跑需要 Git。

```sh
node --version
```

## 安装 CLI 与开放 Skill

```sh
npm install -g broco
broco setup
```

`broco setup` 一次完成四件事：

1. 自动探测本机已安装且已登录的 AI CLI。
2. 一步请你确认全局允许名单（绝不静默全放行）。
3. 当场打印带实时额度状态的花名册。
4. 将开放 `SKILL.md` 安装至 `~/.agents/skills/broco/`，并自动同步挂载到已探测到的宿主 harness（**Claude Code**、**Codex**、**Cursor**、**Antigravity**、**OpenCode**、**Pi**——同时为 Pi 链接 `~/.pi/agent/skills/broco` 并支持 `PI_CODING_AGENT_DIR`）。

升级 `broco` 或切换 Node 版本后重新执行一次 `broco setup` 即可。若已打开的对话框未立即读到技能，重开该会话即可生效。

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

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/broco-readme-logo-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="assets/broco-readme-logo-light.png">
    <img src="assets/broco-readme-logo-light.png" alt="broco — 不同 harness 里的 AI，一起干活。" width="520">
  </picture>
</p>

<p align="center">
  原 <code>opus-manager</code> (v0.4) · Apache-2.0 · <a href="README.md">English</a> · <a href="https://broco.yanauto.me/?lang=zh">官网</a> · <a href="https://broco.yanauto.me/zh/docs/">文档</a> · <a href="CHANGELOG.md">更新日志</a>
</p>

**不同 harness 里的 AI，一起干活。** 留在你此刻正在用的 harness 里，直接叫本机其他 AI 一起干活（Claude Code、Codex、Cursor、Antigravity、OpenCode、Pi）。各自拉独立 worktree 并行改代码、换另一家模型盲审 diff，主力快撞额度时顺手交接，全程复用本机已登录的官方 CLI。

## 快速上手

需要 macOS、Linux 或 Windows 11、Node.js 24+、Git（Windows 11 需安装 Git for Windows），以及至少两个你已在本机登录好的编程 CLI。

```sh
npm install -g @yanauto/broco
broco setup
```

`broco setup` 一次完成四件事：

1. 自动探测本机已安装且已登录的编程 harness。
2. 一步请你确认全局放行名单（绝不静默全放行）。
3. 当场打印带实时额度状态的花名册。
4. 将一份开放 `SKILL.md` 装入 `~/.agents/skills/broco/`，并自动同步挂载到已探测到的宿主 harness（**Claude Code**、**Codex**、**Cursor**、**Antigravity**、**OpenCode**、**Pi**——同时为 Pi 链接 `~/.pi/agent/skills/broco` 并支持 `PI_CODING_AGENT_DIR`）。

**原生支持 Windows 11**：直接在 PowerShell、Windows Terminal 或 `cmd` 中运行（WSL2 也可通过 Linux 后端独立使用），通过 Windows 命名管道（`\\.\pipe\broco-*`）通信，直接解析 `.exe` 与 npm `.cmd` CLI 且免除 shell 引号转义问题，生成固定的 `~/.agents/skills/broco/broco.cmd` 启动器，并通过 NTFS 目录联接挂载 Pi 技能（无需管理员权限）。详见 [Windows 11 环境与排障说明](docs-site/zh/installation.md#windows-11-说明)。

装完直接回到你当前的 harness，像平时一样说自然语言：

> 看看哪家额度宽裕，拉个 worktree 修好 `verifyToken()` 过期问题，再叫另一家模型盲审一下 diff。

**免 `init` 开箱直跑（L0）。** 跑完一次 `setup`，在任意目录都能直接按全局策略协作——任务状态统一放在 `~/.broco/`，项目仓库保持原样。只有当某个仓库需要单独锁定可用 harness 与并发上限时，才按需运行 `broco init`。

## 全对称协作能力

任意宿主 harness 都可以把任务交给任意已放行协作者——包括从 Codex、Cursor、Antigravity、OpenCode 或 Pi 里把原生 `claude` 叫来干活或盲审。

| 工人 | 接入方式与输入能力 | 运行中追加要求 |
| --- | --- | --- |
| `claude` | 原生 `claude -p --output-format stream-json` + `--resume`，stdin 传题（经 `--add-dir` 与 `Read` 支持 `text`、`image`、`pdf`，拒绝音视频） | 排到下一轮 |
| `codex` | 原生 Codex app-server + 实时 5h／周额度（`text`、`image`、上报 `audio`） | 当前轮支持时注入，否则排队 |
| `agy` | 原生 Antigravity CLI（stdin 传题 + `/usage` 多组额度，支持 `text/image/audio/video/pdf`） | 排到下一轮 |
| `cursor-agent` | 原生 Cursor CLI，结构化事件、按会话 ID 续聊 | 排到下一轮 |
| `pi:<厂商>` | pi RPC，按厂商单独放行（`text`、`image`） | pi 确认当轮投递时注入，否则排队 |
| `custom:<名称>` | 两轮试跑通过的新会话／续聊命令模板 | 排队；无原生步骤和缓存读数 |

- **直连本机官方 CLI，复用现有登录态。** `broco` 以隔离本地子进程直接运行你已登录的官方 CLI，运行状态统一保存在 `~/.broco/`，不改动其他 CLI 的配置文件。
- **安全传题与落库脱敏。** 提示词经 `stdin` 传递，不会暴露在系统进程命令行参数里；写入 SQLite 前对凭据模式自动脱敏。
- **防递归保护（`BROCO_IN_WORKER=1`）。** runner 启动每个子进程时注入 `BROCO_IN_WORKER=1`，确保协作者专注完成当前任务，默认拒绝嵌套派单（除非显式传入 `--allow-nested`）。

## 什么时候让它们一起干活

- **写完代码，换一家盲审。** 主力 harness 改完代码后，直接把 git diff 交给另一家模型独立审读，只看真实改动，更容易挑出边界漏洞和回归风险。
- **主力快撞限额，顺手接力。** 当前主力接近 5 小时限额时，把补测试、重构等任务顺手交给余量充足的另一个 harness，手头进度不断档。
- **借用另一家的模态与专长。** 留在当前终端里，遇到截图、PDF、音视频分析或特定模型强项时，随手交给 Claude、Gemini、Codex、Cursor 或 Pi 里最顺手的那一个。
- **多文件任务，独立分支并行。** 批量审计、多模块迁移或重复改造，拆成多个独立 git worktree 并行推进，不打断主会话的节奏。

---

## Agent CLI 参考

> 以下 CLI 命令均由主 Agent 通过 Skill 自动调用，你不需要记忆或手动敲它们。

### 查健康度与实时花名册

```sh
broco status --json
broco roster --json
broco roster --worker codex --json --full
```

`status` 在不拉起未启动后台的前提下检查 runner 状态、在跑／排队单、批次、活跃代理与可清理 worktree。`roster` 展示允许的模型家族、登录状态、输入能力、用户备注、规矩以及实时额度（`avoid`、`plentiful` 与 `agy` 副组额度告警），复用 45 秒共享缓存（`--refresh` 强制重探，`--global` 查看全局默认）。

### 派单、等待、看 diff、跨模型盲审与清理

```sh
broco say auth-fix - --worker agy --worktree --bg --json <<'EOF'
修复 `verifyToken()` 过期测试，并覆盖 `$REFRESH_TOKEN` 边界场景。
EOF
broco wait auth-fix --json
broco diff auth-fix --stat
broco review auth-fix --bg --json
broco wait auth-fix-review-... --json
broco done auth-fix --result pass --why "Token 过期与刷新测试通过。"
broco clean auth-fix --delete-branch
```

- **`say`** 支持行内文本、`--file <路径>` 或 `stdin`（`-`／管道／heredoc；Windows PowerShell 或 `cmd` 下请改用 `--file <路径>` 或 `@' ... '@` 管道替代 `<<'EOF'`），含多行代码块、反引号和 `$` 变量时无需转义。同名续聊、异名并行；可用 `--cwd 目录` 跨目录施工，`--attach 文件` 传确认支持的附件，`--new-task` 开启新任务；当上下文触及 60% 阈值出现 `contextWarning` 时，空闲后用 `--from 旧名字` 无损交接。
- **`wait`** 为事件驱动即刻唤醒（0ms，无 SQLite 轮询），直接返回 `reply`、`task`、`cwd`、`worktree`、`branch` 和 `changedFiles`。
- **`diff`** 相对基线提交查看跟踪与未跟踪的全部改动。
- **`review`** 默认跨模型盲审：省略 `--by` 时，自动从允许名单中挑选与原单不同厂商且额度宽裕的工人（也可显式指定 `--by claude`、`--by codex` 等）。
- **`done` 与 `clean`** 登记单次结果（`pass`／`rework`／`fail`／`blocked`），合并后安全清理残留 worktree 与分支（可先 `--dry-run` 预览）。

### `map` 批量分片并发

一份需求套到几十个文件或输入分片上（`<前缀>-1 .. <前缀>-N`），按独立 FIFO 并发上限排队跑完：

```sh
broco map x-tag --brief-file brief.md --inputs shard-*.jsonl --worker agy --effort high --bg --json
broco wait x-tag --json
broco retry x-tag --bg --json
broco show x-tag --status error,review --full --json
broco done x-tag --result pass --why "全部分片校验通过。"
broco clean x-tag --delete-branch
```

支持 `--brief`、`--brief-file <路径|->`、`--input`、`--inputs`、`--inputs-file <路径|->`（按行或 JSON 数组）及 `{input}`、`{index}`、`{count}`、`{name}` 占位符。`wait`、`show`、`retry`、`stop`、`done`、`clean` 均直接接受批次前缀（`retry <前缀>` 只重跑失败或已停止的分片）。

### 按需启用项目级策略（L1 `init`）

只有当某个仓库需要独立硬隔离名单（如私密仓库禁某家厂商）、独立并发上限、项目规矩或重度经理模式时再启用：

```sh
broco init --allow claude,codex,agy,pi:deepseek --default-worker agy --concurrency 4
broco init --manager-mode
broco uninit
```

`init` 写入 `.broco/`，优先维护 `AGENTS.md` 中的 `<!-- broco:start -->` 标记段，不动原有内容（`--host` 支持 `auto|agents|claude|codex|cursor|agy|opencode|pi`）；无 `AGENTS.md` 且仓库已有 `CLAUDE.md`，或显式传入 `--host claude` 时改为维护 `CLAUDE.md`（可用 `--no-agents-md`／`--no-claude-md` 跳过，`broco uninit` 释放空闲工人、注销项目并干净剥离标记段）。存在项目配置时严格覆盖全局策略。

## 重度日常进阶能力

### Agent 自治配置与一键撤回

主 Agent 可直接用 CLI 调整全局或项目配置，立即对后续派单生效，按本机时区（支持 `BROCO_TZ` / `TZ` 覆盖）写入审计日志并返回一键撤回命令：

```sh
broco set concurrency 6
broco set default-worker agy
broco allow claude,codex,agy --default-worker agy
broco deny cursor-agent
broco defaults agy --model gemini-4-argon --effort high
broco note agy "额度宽裕，适合并发 map 任务"
broco rules --add "交付前先跑通测试"
broco hide codex gpt-5.6-sol
broco audit --limit 10
broco undo
```

随时用 `broco ui`（或 `broco ui --no-open`，后台重启后自动恢复原端口）打开本机看板，查看 `map` 实时分片进度、排队名次、任务历史、上下文告警，以及带一键**撤回**的只读配置页。

### 本地回环凭据代理

给工人发放临时 `127.0.0.1` 地址，在指定上游路径自动注入认证头而不向工人暴露真实密钥：

```sh
broco proxy-open --upstream https://api.example.com \
  --path /v1/models --path /v1/chat/completions \
  --header Authorization --value-env EXAMPLE_API_KEY --value-prefix 'Bearer ' \
  --max-requests 150 --ttl 1800 --json
broco proxy-list --json
broco proxy-close PROXY_ID --json
```

密钥只驻留后台进程内存，严格绑定 `127.0.0.1`，拒绝根路径 `/` 与 3xx 重定向，强制校验路径段前缀、请求次数上限和有效期。

### 实战战绩统计（`stats`）

```sh
broco stats --json
broco stats --project . --json
```

按工人与模型汇总跨项目或单项目的真实任务通过率与返工记录。

### 从 `cc-bro` 或 `opus-manager` 平滑升级

`broco` 由 `opus-manager`（v0.4）与 `cc-bro` 演进而来。安装 `broco` 后：

1. 先确认是否有需要跑完的旧任务（可运行旧版 `cc-bro status` 查看）。
2. 执行 `broco shutdown`（平滑停止旧协议后台及 `~/.cc-bro` 套接字）和 `broco setup --migrate-cc-bro`（或直接 `broco setup` 全新开始）。
3. `broco setup --migrate-cc-bro` 会将本机 `~/.cc-bro/` 无损复制迁移至 `~/.broco/`，完整保留项目策略、会话与工单历史且不删除原目录。

详见[升级指南](docs-site/zh/upgrade.md)。

## 从源码开发

```sh
npm ci --prefix ui
npm run prepack
npm test
```

[Apache-2.0 许可证](LICENSE)

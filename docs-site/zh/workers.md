# 工人选择与登录

`broco` 让本机已登录的各个 harness 全对称互通：任意主 Agent 都可以按需把任务交给 `claude`、`codex`、`cursor-agent`、`pi:<厂商>`、`custom:<名称>` 或 [`agy`](#agy)（注意：Google 消费者订阅禁止由第三方 Agent 驱动 `agy`）。所有内置协作者均以隔离本地子进程直接运行本机官方 CLI，复用你现有的登录态。派活前先读[工人花名册](roster.md)。

## 原生 Claude（`claude`）

用 `claude` 作为工人 ID，让 Codex、Cursor、Antigravity、OpenCode、Pi 或终端直接复用你本机的 Claude Code 登录来干活或盲审：

```sh
claude --version
```

`broco` 通过 `claude -p --output-format stream-json` 与 `--resume` 续聊，使用 `stdin` 传题（绝不暴露在 `ps` 进程参数里），接入统一失败分类（`quota`/`region`/`policy`/`network`/`auth`/`context`）与落库前凭据脱敏。运行中追加要求排到下一轮。

为防止工人之间循环互叫，runner 启动每个工人进程时强制注入 `BROCO_IN_WORKER=1`，默认拒绝嵌套派单（除非显式 `--allow-nested`）。

## 原生 Codex（`codex`）

用 `codex` 调用本机 Codex CLI 的原生 app-server 与实时 5h／周额度接口（`account/rateLimits/read`）：

```sh
npm install -g @openai/codex
codex login
codex login status
```

当轮支持插话时第二次 `say` 直接注入，否则排队。若提交前 app-server 不可用，`broco` 自动回退至 `codex exec`。

## Cursor（`cursor-agent`）

`cursor-agent` 支持结构化步骤事件与会话 ID 续聊，运行中插话排到下一轮：用 `cursor-agent login` 登录、`cursor-agent status` 核对状态、`cursor-agent --list-models` 查看模型。

## agy

> [!WARNING]
> Google 消费者订阅方案（Free、Google AI Plus、Pro、Ultra）不允许由第三方 Agent（如 Claude Code、Codex）驱动 Antigravity CLI（`agy`），且已有封号先例。`broco` 会在 `broco setup`、`broco roster` 以及单次会话首次派单给 `agy` 时输出非拦截风险提示，不会禁用 `agy`——如需启用请自担风险，且仅建议配合 Gemini API Key 或 Gemini Enterprise / Google Cloud 项目使用。

配合 Gemini API Key 或 Gemini Enterprise / Google Cloud 项目使用时，`agy` 经 `stdin` 传题，通过 `/usage` 读取多组实时额度（含副组模型额度告警），支持 `text`、`image`、`audio`、`video`、`pdf` 全部五类输入，运行中插话排到下一轮。可用 `agy models` 查看模型。

## pi（`pi:<厂商>`）

用 `pi:<厂商>` 走 `pi` RPC，并按厂商单独授权：

```sh
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi
```

进入 `pi` 后输入 `/login` 连接所需厂商（如 `pi:deepseek`、智谱 GLM 对应的 `pi:zai`，或 `pi:openai-codex`）。原生 `codex` 登录不替代 `pi` 的登录，每个 `pi:<厂商>` 也需分别放行。为 `pi:<厂商>` 显式传 `--model` 时，请带上 `broco roster` 中显示的厂商前缀（例如 `zai/glm-5.3` 或 `deepseek/deepseek-flash`）。以下命令只检查状态不打印凭据：

```sh
pi auth check --provider deepseek --no-refresh
pi --list-models
```

在 macOS、Linux 与 Windows 三端，`pi` 工人均使用独立的会话目录（`~/.broco/sessions`）并剥离宿主会话环境变量直接运行（macOS `sandbox-exec` 仅在内部 `.sandbox` 隔离模式下用于保护个人 `~/.pi`）。

## 按单自由搭配

```sh
broco say inspect-a "检查 src/auth.ts 的错误处理分支。" --worker pi:zai --model zai/glm-5.3 --bg --json
broco say inspect-b "检查 src/auth.ts 的错误处理分支。" --worker claude --bg --json
```

一个名字始终绑定其初始工人，但完成一轮后可在下轮切换 `--model` 或 `--effort`。Gemini CLI、OpenCode 或其他 CLI 请使用试跑验证后的[自定义 CLI 模板](custom-cli.md)。

列表里的模型仍可能受额度、地区或套餐权限限制。`broco` 如实返回结构化 `problem.class` 报错，绝不静默切厂商或替你花钱。

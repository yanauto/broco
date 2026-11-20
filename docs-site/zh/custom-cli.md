# 自定义 CLI 模板

接入自定义 CLI 需要具备三项能力：非交互启动新会话、按明确会话 ID 续聊，以及可解析的最终回复与会话 ID。在[配置与撤回](settings.md)页面将其登记为 `custom:名称`。Gemini CLI 与 OpenCode 预设均为可编辑起点，并非预验收内置适配器——请先自行安装登录，再按本机版本微调模板。

模板由可执行文件与 JSON 参数数组构成，`broco` 直接拉起可执行文件、不经 shell 解释，含空格、引号或特殊符号的提示词都能原样传递。可用占位符为 `{prompt}`、`{session}`、`{model}`、`{effort}` 与 `{cwd}`。

```json
{
  "command": "my-agent",
  "newArgs": ["--json", "--prompt", "{prompt}"],
  "resumeArgs": ["--json", "--resume", "{session}", "--prompt", "{prompt}"],
  "modelArgs": ["--model", "{model}"],
  "effortArgs": ["--effort", "{effort}"],
  "stdin": "",
  "format": "json",
  "reply": {"path": "reply"},
  "session": {"path": "session_id"}
}
```

`modelArgs` 与 `effortArgs` 为可选项，仅在显式指定时追加。推荐使用 `"stdin": "{prompt}"` 经标准输入传题，防止提示词出现在 `ps` 进程列表里。新会话与续聊命令都必须接收提示词，且续聊必须包含 `{session}`。

`jsonl` 模式使用点分路径与可选等值条件（`when`）提取最后一条匹配事件；`text` 模式使用正则首个捕获组（如 `{"regex":"Reply: (.+)"}` 与 `{"regex":"Session: (.+)"}`）。非零退出、输出格式异常或会话 ID 漂移均判本轮失败。

## 强制两轮记忆试跑

保存前必须通过**测试新会话 + 续聊**：`broco` 在 `$BROCO_HOME` 下的临时目录发起两次真实调用，要求 CLI 不调用工具，并验证第二轮能准确复述第一轮的随机口令且会话 ID 保持一致。通过后获得 15 分钟保存授权，改动模板需重新试跑。

自定义工人标记为**降级（Degraded）**能力等级：支持具名续聊、排队插话、`stop`、独立 git worktree、`diff` 与跨模型审查，但不提供原生步骤流、运行中注入和缓存读数；落库前同样执行凭据脱敏。

可选的 `versionArgs` 与 `actions`（`login`/`install`/`upgrade`）用于展示版本和显式打开官方命令。切勿在模板中硬编码任何凭据。

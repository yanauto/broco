# 配置与撤回

直接通过 CLI 调整全局或项目配置——立即对后续派单生效，按本机时区写入审计记录，并可用一条 `broco undo` 完整撤回。在 `broco ui` 页头打开**配置**可随时查看检测状态、当前生效配置与带一键**撤回**的审计流。

## Agent 自治配置命令

所有配置命令均支持 `--global` 或 `--project 路径`（以及 `--json`），绝不改写其他 CLI 的原生配置文件：

```sh
broco set concurrency 6
broco set default-worker pi:zai
broco allow claude,codex,pi:deepseek,pi:zai --default-worker pi:zai
broco deny cursor-agent
broco defaults pi:zai --model zai/glm-5.3 --effort high
broco note pi:deepseek "速度快、成本低，适合并发 map 分片任务"
broco rules --add "交付前先跑通测试"
broco hide codex gpt-5.6-sol
broco unhide codex gpt-5.6-sol
broco audit --limit 10
broco undo
```

- **审计与撤回**：每次改动写入审计记录（时区按 `BROCO_TZ` → `TZ` → 系统时区解析），并打印精确的 `broco undo <id>`。直接运行 `broco undo` 撤回该作用域下最新一条可撤回改动。
- **继承与覆盖**：全局备注、默认值、隐藏模型与规矩在未设项目覆盖时自动继承；项目规矩默认追加在全局规矩之后（加 `--override` 替换）。
- **隐藏模型**：被隐藏的模型家族（含对应档位与 fast 变体）立即从 `broco roster` 消失，且在显式派单、默认选择与排队启动时均被拒绝。

## 只读检测、登录与看板配置页

运行 `broco ui` 点击页头**配置**，可查看本机检测到的 CLI、版本号、生效默认值与审计记录：

- **纯只读检测**：Claude Code 检查 CLI 可用性与登录状态；Codex 通过 app-server 查 `model/list`、`config/read`、`account/read` 与实时额度；`pi` 走非生成式 RPC 查询与 `auth check --no-refresh`；`agy`（见[风险提示](../workers/#agy)，仅限 API Key / Enterprise）查 `models`、`/model`、`/effort` 与 `/usage`；Cursor 查 `models` 与 `status`。绝不读取凭据文件明文，不翻查会话历史。
- **显式登录**：鉴权始终由各 CLI 自行完成（`claude`、`codex login`、`cursor-agent login`、`pi` `/login`，或配合 Gemini API Key / 企业版项目的 `agy`），`broco` 不收集也不保存任何 API Key。
- **自定义模板**：其他非交互 CLI 可登记为 `custom:名称`，详见[自定义 CLI 模板](custom-cli.md)。

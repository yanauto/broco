# 模型能力与附件

选模型前先核对它经当前 CLI 实际能接收的输入类型。派发媒体附件前查看 `broco roster --json` 中的 `capabilities.input`：`true` 表示模型与 `broco` 当前通道均确认支持，`false` 表示至少一方不支持，`unknown` 表示尚无实测依据。单看模型 API 文档不足以保证 CLI 通道支持。

## 发送附件

```sh
broco roster --json
broco say visual-check "分析这张截图里的页面布局问题。" --worker codex --model MODEL_FROM_ROSTER --attach ./screen.png --bg --json
broco wait visual-check
broco done visual-check --result pass --why "布局检查完成。"
```

多次传 `--attach` 可附带多个文件，路径按发送终端所在目录解析（自动展开 `~/`）。接单前文件会被快照复制到 `broco` 项目数据目录，避免排队轮次受原文件改动影响。单次最多 8 个附件，单文件上限 20 MiB，总计上限 32 MiB。带附件的运行中插话会排到下一轮；未确认或不支持的输入类型会在派单前直接拒绝。

## 各通道支持的输入与限制

| CLI / 当前通道 | 传递方式与限制 |
| --- | --- |
| `claude` print / stream-json | 经 `stdin` 传题，并通过 `--add-dir` 与 `Read` 工具支持 `text`、`image`、`pdf` 附件（拒绝 `audio` 与 `video`）。 |
| Codex app-server | 以 `localImage` 块发送图片；当选中模型上报支持音频时启用 `localAudio`。回退至 `codex exec` 时改用重复 `--image`，并拒绝音频而非静默丢弃。 |
| `agy` stdin / stream-json | 经 `stdin` 传题，支持选中模型具备的 `text`、`image`、`audio`、`video`、`pdf` 全部五类输入。 |
| `pi` RPC | 通过 `images` 内容块（`type`、base64 `data`、`mimeType`）发送图片，直接使用 `input`、`contextWindow`、`maxTokens` 精确字段。 |
| `cursor-agent` print | 无头打印适配器暂无直接媒体附件参数，媒体能力保持 `unknown`，显式附件会被拒绝。 |
| `custom:<名称>` 模板 | 模板只声明文本参数或 `stdin`，媒体能力保持 `unknown`，显式附件会被拒绝。 |

参考官方文档：[OpenAI app-server 输入文档](https://developers.openai.com/codex/app-server)、[pi RPC 文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)、[agy 无头输入文档](https://antigravity.google/docs/cli/headless)、[Cursor CLI 参数](https://cursor.com/docs/cli/reference/parameters)、[Gemini 文件工具](https://geminicli.com/docs/tools/file-system/)、[OpenCode CLI](https://opencode.ai/docs/cli/)。

## 上下文上限与目录说明

用 `broco roster --worker 工人ID --json --full` 查看 token 上限及其来源。紧凑模式保留 `capabilities.input`；同家族不同变体意见不一致时标为 `unknown`，需查看具体变体后再附媒体。

CLI 实报上限优先于目录；仅来自目录的上限标为 `catalog-api-limit`（属于 API 理论上限，不代表订阅实际额度），缺省保持 `unknown`。本地覆盖见[工人花名册](roster.md)的 `~/.broco/models.json` 说明。

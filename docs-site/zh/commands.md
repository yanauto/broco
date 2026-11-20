# 命令参考

跑完 `broco setup` 后，绝大多数命令在任意目录即可按全局策略直跑（L0）；也可在任意位置加 `--project 路径` 指定项目。运行 `broco 命令 --help` 查看当前安装版本的完整语法。

## 安装、健康检查与可选项目初始化

| 命令 | 行为 |
| --- | --- |
| `broco setup [--allow 名单] [--default-worker ID] [--yes] [--migrate-cc-bro] [--json]` | 探测本机 CLI、一步确认全局允许名单、打印实时额度花名册、支持 `--migrate-cc-bro` 无损迁移旧 `~/.cc-bro/`，并将 `~/.agents/skills/broco/SKILL.md` 同步装入检测到的宿主 harness（含为 Pi 链接 `~/.pi/agent/skills/broco` 并支持 `PI_CODING_AGENT_DIR`）。 |
| `broco status [--project 路径] [--all] [--json]` | 在不拉起未启动后台、不建隐式项目的前提下检查 runner 健康度、看板地址、凭据代理、在跑／排队单、批次与可清理 worktree。 |
| `broco init [--project 目录] [--allow 名单] [--default-worker ID] [--concurrency N] [--host auto\|agents\|claude\|codex\|cursor\|agy\|opencode\|pi] [--manager-mode] [--no-agents-md] [--json]` | 可选 L1 项目策略：写入 `.broco/`，优先维护 `AGENTS.md` 标记段（无 `AGENTS.md` 且已有 `CLAUDE.md`，或显式传入 `--host claude` 时改为维护 `CLAUDE.md`）。 |
| `broco uninit [--project 目录] [--host auto\|agents\|claude\|codex\|cursor\|agy\|opencode\|pi] [--no-agents-md] [--json]` | 释放空闲工人、注销项目、移除 `.broco/`（及残留 `.cc-bro/project-id`）并干净剥离标记段。 |
| `broco version [--json]` | 输出版本号与提交哈希，不拉起后台（别名：`broco --version`）。 |

## 实时花名册

```sh
broco roster [--global] [--worker ID] [--full] [--refresh] [--project 路径] [--json]
```

默认输出紧凑模型家族、实时额度（`avoid`、`plentiful`、`tightGroups`）、输入能力、实战 `record`、备注与规矩（45 秒共享缓存）。未放行工人只显示 `id` 与 `allowed:false`。加 `--worker ID --full` 查看精确变体、折叠旧型号与上下文上限。

## 派单、分片并发、验收、盲审与清理

```text
broco say 名字 [内容|-] [--file 路径] [--worker ID] [--model 模型] [--effort 档位] [--attach 文件] [--worktree | --cwd 目录] [--from 旧名] [--new-task] [--title 标题] [--bg] [--json]
broco map 前缀 [输入...] [--brief 文本 | --brief-file 路径|-] [--inputs 列表] [--input 单项] [--inputs-file 路径|-] [--worker ID] [--model 模型] [--effort 档位] [--worktree | --cwd 目录] [--bg] [--json]
broco wait 名字 [轮次] [--json]
broco retry 名字 [--worker ID] [--model 模型] [--effort 档位] [--bg] [--json]
broco diff 名字 [--stat] [--json]
broco review 名字 [--by ID] [--model 模型] [--effort 档位] [--bg] [--json]
broco done 名字 [--task N] [--result pass|rework|fail|blocked] [--why 说明] [--json]
broco clean [名字] [--dry-run] [--delete-branch] [--force] [--json]
```

- `say` 支持行内文本、`--file 路径` 或 `stdin`（`-`／管道），题面不暴露于 `ps`。所有工人进程强制注入 `BROCO_IN_WORKER=1` 防递归套娃（除非 `--allow-nested`）。
- `map` 将 `{input}`、`{index}`、`{count}`、`{name}` 展开为 `<前缀>-1 .. <前缀>-N`；`wait`、`show`、`retry`、`stop`、`done`、`clean` 均支持批次前缀。
- `review` 省略 `--by` 时自动挑选与原单不同厂商且额度宽裕的已放行工人。
- 重复使用 `say --attach 文件` 发送经确认支持的[媒体附件](model-inputs.md)。

## 查看、统计与停止

| 命令 | 行为 |
| --- | --- |
| `broco ls [--active] [--status 列表] [--flag error\|stopped] [--batch 前缀] [--limit N] [--json]` | 按需过滤列出工单，节省主 Agent 上下文。 |
| `broco show 名字 [--compact] [--turn N] [--status 列表] [--full] [--all] [--json]` | 查看单次／批次摘要、指定轮次或完整历史。 |
| `broco stats [--project 路径] [--json]` | 按工人与模型汇总真实任务的通过／返工／失败／阻塞战绩。 |
| `broco watch [--project 路径]` | 在终端实时跟踪项目活动流。 |
| `broco ui [--no-open] [--json]` | 打开本机看板或仅打印地址。 |
| `broco stop 名字 [--json]` | 停止单个具名会话（或整个批次）并确认进程已退出。 |
| `broco shutdown [--json]` | 平滑停止本机 runner（兼容旧 `cc-bro` 协议）。 |

## Agent 自治配置与审计撤回

```text
broco set <concurrency|default-worker> 值 [--global] [--project 路径] [--json]
broco allow 工人列表 [--default-worker ID] [--global] [--project 路径] [--json]
broco deny 工人列表 [--global] [--project 路径] [--json]
broco defaults 工人 [--model 模型] [--effort 档位] [--clear] [--global] [--project 路径] [--json]
broco note 工人 [内容] [--clear] [--global] [--project 路径] [--json]
broco rules [--add 规则] [--rm 规则] [--clear] [--worker ID] [--override] [--global] [--project 路径] [--json]
broco hide 工人 模型列表 [--global] [--project 路径] [--json]
broco unhide 工人 模型列表 [--global] [--project 路径] [--json]
broco audit [--global | --all] [--project 路径] [--limit N] [--json]
broco undo [审计ID] [--global] [--project 路径] [--json]
```

## 本地回环凭据代理

```text
broco proxy-open --upstream 源地址 --path 路径前缀 --header 请求头 (--value-env 环境变量 | --value-command 命令) [--value-prefix 前缀] --max-requests 次数 --ttl 秒数 [--json]
broco proxy-list [--json]
broco proxy-close 代理ID [--json]
```

凭据仅驻留后台内存，严格监听 `127.0.0.1`，拒绝 `--path /` 与 3xx 重定向，强制路径段前缀与次数／有效期限制。

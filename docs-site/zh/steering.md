# 运行中插话

要在进行中的任务里补充说明或微调要求，对同一个会话名字再发一次 `say`；要让另一项任务并发推进，则另起新名字。

```sh
broco say auth-fix "修复 token 过期测试。" --bg --json
broco say auth-fix "顺便补上刷新 token 过期的边界用例。" --bg --json
```

## 看懂第二次回执

| 状态 | 该怎么做 |
| --- | --- |
| `injected` | 工人确认已在当前轮收到插话（原生 `codex` app-server 或 `pi` RPC）。直接等该回执里的轮次。 |
| `queued` | 补充要求已排到下一轮。等回执返回的新轮次完成后再审查或验收。 |
| `rejected` | 阅读拒绝原因。若投递状态不确定，先看 `broco show auth-fix --all` 避免重复发送。 |

若原轮次已经结束，第二次 `say` 会直接在同一会话开启新一轮。若上一轮在绑定原生会话 ID 前就失败（回执带 `sessionWarning`），请用 `broco retry auth-fix --bg --json` 原样重发保存的题面与附件快照。

`claude`、`cursor-agent`、自定义模板以及 `agy`（仅建议 API Key / Enterprise 使用，详见[工人选择与登录（`#agy`）](../workers/#agy)）在运行中收到的插话均排入下一轮。轮次执行期间不允许切换 `--model` 或 `--effort`，需等本轮结束。

重开主 Agent 对话后，用 `broco ls --active --json`、`broco show auth-fix --compact --json` 与 `broco wait auth-fix --json` 即可无损接回进度。

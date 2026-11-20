# 第一张工单

跑完 `broco setup` 后在任意仓库即可直接开始，无需先运行 `broco init`。先试一张只读单，或者拉起独立 git worktree 改代码并做一次跨模型盲审。

## 1. 在现有主 Agent 对话框直接说自然语言（推荐）

在任意项目目录打开你常用的 harness（**Claude Code**、**Codex**、**Cursor**、**Antigravity**、**OpenCode** 或 **Pi**），直接说：

> 看看现在哪家额度宽裕，帮我找一下认证测试在哪里（不改文件）；或者拉个独立 worktree 修好 `verifyToken()` 过期测试，再让另一家模型盲审一遍。

装好的 `SKILL.md` 会引导主 Agent 自动查看 `broco roster --json`、按额度派单、事件驱动等待（无需轮询）、用 `broco diff` 验收改动并干净收尾。

## 2. 也可以在终端亲自试跑

```sh
broco status
broco roster
broco say test-map "找到测试所在位置并告诉我怎么跑一条，不要改文件。" --bg --json
```

`--bg` 立刻返回带 `name` 和 `turn` 的回执。新名字（`test-map`）开启新持久会话，复用同名继续原会话。遇到含多行代码、反引号或 `$VAR` 的长题面，改用 `--file prompt.md` 或经 `stdin`（`-`；Windows PowerShell 或 `cmd` 下请用 `--file prompt.md` 或 `@' ... '@` 管道替代 `<<'EOF'`）传入：

```sh
broco say auth-fix - --worker agy --worktree --bg --json <<'EOF'
修复 `verifyToken()` 过期测试，并覆盖 `$REFRESH_TOKEN` 边界场景。
EOF
```

## 3. 等待、看 diff、跨模型盲审、验收与清理

```sh
broco wait auth-fix --json
broco diff auth-fix --stat
broco review auth-fix --bg --json
broco done auth-fix --result pass --why "过期与刷新测试通过。"
broco clean auth-fix --delete-branch
```

- `wait` 采用事件驱动即刻唤醒（0ms，告别 SQLite 轮询），直接返回 `reply`、`task`、`cwd`、`worktree`、`branch` 和 `changedFiles`。
- `review` 省略 `--by` 时自动挑选与原单不同厂商且额度宽裕的已放行工人（也可显式传 `--by claude`、`--by codex` 等）。
- `clean` 在合并或保留改动后安全清理残留 worktree（可先加 `--dry-run` 预览）。

随时运行 `broco ui` 打开[本机看板](board.md)，实时查看工单、分片批次与审计撤回记录。

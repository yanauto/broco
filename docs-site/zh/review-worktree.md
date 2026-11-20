# 独立工作区、diff 与跨模型审查

当两个工人可能改动同一组文件，或你想把一笔改动隔离开单独验收时，使用 `--worktree`。改完用 `broco diff` 看完整改动，用 `broco review` 做跨模型盲审，合并后用 `broco clean` 干净收尾。

## 在独立 worktree 施工

在已有至少一次提交的 Git 仓库里，首条 `say`（或 `map`）带上 `--worktree`：

```sh
broco say auth-fix - --worker agy --worktree --bg --json <<'EOF'
修复 token 过期校验，并补上刷新 token 时钟偏差的回归测试。
EOF
broco wait auth-fix --json
broco diff auth-fix --stat
```

新分支（`broco/<名字>-...`）与 worktree 从已提交的 `HEAD` 拉出，后续同名 `say` 继续停留在同一个 worktree。`broco diff auth-fix` 相对该单基线提交展示所有跟踪与未跟踪改动（加 `--stat` 只看概览）。

## 跨模型盲审（默认换另一家模型）

```sh
broco review auth-fix --bg --json
```

省略 `--by` 时，`broco review` 会自动从允许名单里挑选与原单**不同厂商**且当前额度宽裕的工人——例如 `agy` 写的改动自动交给 `codex` 或 `claude` 盲审。也可以显式传 `--by claude`、`--by codex`、`--by agy`、`--by cursor-agent` 或 `--by pi:<厂商>`。

审查者在独立会话里拿到原单题面、最终回复与改动文件列表，并直接检视写单者的工作区。审查结束前请保持该工作区稳定。

回执返回的是**审查单自己的名字与轮次**。用 `broco wait <审查单名> --json` 拿到意见后，如需返工再发回 `auth-fix`，最后分别为写单者与审查者执行 `broco done`。

## 清理已完成 worktree

`broco` 绝不自动合并或自动删除分支。当你把改动合并或确认丢弃后：

```sh
broco clean auth-fix --dry-run
broco clean auth-fix --delete-branch
```

不传名字（`broco clean`）会统一清理所有已结单（`done`）任务残留的 worktree 与孤立附件快照；仅在确认放弃未合并或脏工作区时才加 `--force`。

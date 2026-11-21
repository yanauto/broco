# 全局与项目策略

`broco` 默认采用 L0 免 `init` 模式：装完在 `broco setup` 一步确认全局允许名单，即可在任意仓库直接开跑。只有当特定项目需要硬隔离名单、独立并发池或重度经理模式时，才按需启用 L1 `broco init`。

## L0：全局策略（免 `init`、仓库保持干净）

运行 `broco setup` 时由你显式确认全局允许名单（例如 `claude,codex,pi:deepseek,pi:zai,cursor-agent`）。每个 `pi:<厂商>` 都是独立权限，放行 `codex` 不会顺带放行 `pi:openai-codex`。

在未建立 `.broco/` 的任意目录里，命令直接沿用你的全局允许名单、默认工人与并发上限；工单记录按 `realpath(gitRoot || cwd)` 归档在 `~/.broco/`，不在代码仓库里留下隐藏目录或配置文件。

随时可调整全局策略：

```sh
broco allow claude,codex,pi:deepseek,pi:zai --default-worker pi:zai --global
broco deny cursor-agent --global
broco set concurrency 4 --global
```

## L1：按需启用项目级覆盖（`broco init`）

当某个仓库需要专属边界——比如私密项目禁用某家厂商、设置独立并发上限、补充仓库规矩或启用重度经理模式时，运行：

```sh
broco init --allow claude,codex --default-worker codex --concurrency 4
broco init --manager-mode
```

- 命中项目策略时严格覆盖全局策略。
- `init` 写入自带忽略规则的 `.broco/` 标识目录，并默认在 `AGENTS.md` 中维护 `<!-- broco:start -->` 标记段，不动原有内容。
- 仅当仓库已有 `CLAUDE.md` 或显式传入 `--host claude` 时才同步维护 `CLAUDE.md`（可用 `--no-agents-md`／`--no-claude-md` 跳过）。
- 运行 `broco uninit` 自动释放空闲工人、注销项目、删除 `.broco/` 并干净剥离标记段。

## 安全修改与一键撤回

使用 `broco allow`、`broco deny`、`broco set default-worker` 或 `broco set concurrency`（带 `--global` 或 `--project 路径`）即可立即生效，记录审计日志并返回一键 `broco undo`。收回权限不中断已在跑的轮次，排队中的轮次在启动前会重新校验。已有具名会话保持原绑定工人不变。详见[配置与撤回](settings.md)。

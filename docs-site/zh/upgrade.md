# 升级与迁移

`broco` 由 `opus-manager`（v0.4）与 `cc-bro`（0.4.x）平滑演进而来，完整保留已有项目策略、具名会话与工单历史。

## 从 1.0.x 升级

1. 如有需要保留的在跑任务，先用 `broco status` 确认并等待其完成。
2. 升级包版本、重启后台服务并刷新启动器与各宿主技能文件：

```sh
npm install -g @yanauto/broco@latest
broco shutdown
broco setup
```

原有的 `~/.broco/` 配置、允许名单、会话与工单历史保持原样。

## 从 `cc-bro`（0.4.x）或 `opus-manager` 升级

1. 如有需要跑完的在跑任务，先用旧版 `cc-bro status` 确认并等待其完成。
2. 安装 `broco`，停止旧版后台服务并运行 `broco setup`：

```sh
npm install -g @yanauto/broco
broco shutdown
broco setup --migrate-cc-bro
```

`broco shutdown` 可平滑停止旧协议的 `cc-bro` 后台进程（包括 `~/.cc-bro` 对应旧套接字目录）。

运行 `broco setup --migrate-cc-bro` 会将本机残留的 `~/.cc-bro/` 无损复制迁移至 `~/.broco/`（不删除原目录）——完整保留已登记项目、允许名单、默认值、备注、规矩、实战战绩与工单记录，同时把新版多宿主 `SKILL.md` 安装到 `~/.agents/skills/broco/` 及本机已检测到的主 Agent。

### 1.0.0 关键变化

- **命名与路径统一**：CLI 命令为 `broco`，数据目录 `~/.broco/`（`$BROCO_HOME`），可选项目标记 `.broco/`，环境变量统一 `BROCO_*`（含时区覆盖 `BROCO_TZ` 与防递归锁 `BROCO_IN_WORKER=1`）。
- **L0 免 `init`**：不再需要在每个仓库执行 `init`；全局策略在任意目录直接生效，不在仓库生成隐藏文件。已有项目配置继续严格覆盖全局默认。
- **新增内置 `claude` 工人**：原生 `claude` 与 `codex`、`agy`、`cursor-agent`、`pi:<厂商>`、`custom:<名称>` 全对称互通；在 `broco setup` 中由你决定是否放行。
- **默认跨模型盲审**：`broco review <名字>` 省略 `--by` 时自动挑选与原单不同厂商且额度宽裕的工人。
- **动态本机时区**：时间按 `BROCO_TZ` → `TZ` → 系统时区解析，不再硬编码 `Asia/Shanghai`。

## 从 0.3.x 或 0.2.x 升级

安装 `broco`，等需保留的任务完成后依次执行 `broco shutdown` 与 `broco setup`。原有 0.2/0.3 项目权限、会话与工单会一并迁入 `~/.broco/`，不自动扩大允许名单。依赖完整模型元数据的脚本请改用 `broco roster --json --full`。

## 从 0.1.0（旧经理室）升级

0.2.0 起已移除独立经理室。旧 0.1.0 经理目录中的笔记保留不动，安装 `broco` 后执行 `broco shutdown` 和 `broco setup`，直接在真实仓库的主 Agent 对话里开用即可。详见[第一张工单](quickstart.md)。

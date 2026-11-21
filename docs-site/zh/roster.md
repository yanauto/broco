# 工人花名册

每次派活或审查前运行 `broco roster --json`。主 Agent 通过实时花名册读取额度、允许模型、输入能力、实战战绩、备注与规矩，按实况选对 CLI。

文本与 JSON 默认均为紧凑视图，复用 45 秒共享探测缓存（刚登录或刚装 CLI 时加 `--refresh` 强制重探，项目外显式看全局加 `--global`）。未放行的工人只列出名字与 `allowed:false`（即使加 `--full` 也不展开，且跳过子进程探测）。若放行工人未登录或缺失，顶层 `warnings` 直接给出准确登录／安装命令。

```sh
broco roster
broco roster --global
broco roster --worker codex --json
broco roster --worker codex --json --full
broco say investigate "分析失败的测试原因。" --worker codex --model MODEL_FROM_ROSTER --effort low --bg --json
```

## 实时额度与实战信号

- **`quota`**：`codex`（`account/rateLimits/read`）与 `agy`（`/usage`，仅限 API Key / 企业版——见[风险提示](../workers/#agy)）上报实时 5 小时与周额度，紧缺标 `avoid`、充裕标 `plentiful`，并暴露 `agy` 副组额度告警 `tightGroups`。无额度接口的 CLI 标 `unreported`，结合报错自动追踪冷却状态（`recentProblem`）。
- **`record`**：来自 `broco done` 累计的真实任务通过／返工／失败统计。模型有 3 张及以上非阻塞实测单后，个人实战战绩优先于目录评级。
- **`capabilities.input`**：模型能力与当前 CLI 通道的交集（`text`/`image`/`audio`/`video`/`pdf`），加 `--attach` 前需确认为 `true`。

## 紧凑视图与完整详情

每个当前模型家族占一行，给出真实检测 ID、确认输入能力、档次评级、可用档位与一句简介。档位与 fast 变体合并展示（`variantCount`、`fast`）；[`agy`](../workers/#agy)（仅限 API Key / 企业版）的多档位家族会自动折叠至基础家族 ID 并映射 `--effort`。

目录中标记为 `previous generation`、`superseded` 或 `being retired` 的旧型号折叠进 `olderModels`。需要精确变体、旧型号、上下文上限和完整目录元数据时加 `--full`（可配合 `--worker ID`）。用户隐藏的模型在两种视图下均不出现。

## 名单、备注、规矩与本地目录覆盖

- 允许名单在派单与排队开跑前双重强校验。
- Agent 可直接通过 CLI 更新 `defaults`、`note`、`rules`、`hide`、`unhide`，立即生效且全程可 `broco undo`。详见[配置与撤回](settings.md)。
- 随包自带 `lib/model-catalog.json`，可在 `~/.broco/models.json`（或 `$BROCO_HOME/models.json`）按精确模型 `id` 覆盖条目，也可覆盖顶层 `picks` 和 `effort_advice`：

```json
{"models":[{"id":"gpt-6.1-sol","summary":{"zh":"团队默认编码模型。"},"grade":"Team preferred"}]}
```

超过 60 天或缺少有效 `as_of` 的目录条目会标记为过期提醒更新。目录评级仅供参考，始终低于用户备注、规矩与个人 `stats`。详见[能力与附件](model-inputs.md)。

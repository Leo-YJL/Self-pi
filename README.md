# pi-coding-workflow

`pi-coding-workflow` 是一个面向 Pi 的通用编码工作流包。它将任务状态、PRD 检查、上下文预算、缓存、遥测、压缩摘要和自适应路由等能力封装在 TypeScript 引擎中，同时保持 LLM 可见工具面尽可能小。

## 核心目标

- 只暴露少量、稳定的 LLM 可见工具。
- 用确定性 preflight 减少不必要的模型推理和反复询问。
- 默认返回轻量上下文，降低 token 消耗。
- 将任务状态、证据引用、缓存和遥测放到运行时产物中，而不是反复注入模型上下文。
- 支持通用项目与 Unity 项目的工作流初始化。

## LLM 可见工具

### `workflow_next`

语义只读的工作流路由工具。

它用于：

- 查找当前 active task。
- 判断下一步动作。
- 返回轻量上下文摘要。
- 返回 blocker / warning。
- 返回 `adaptiveControl`，指导下一步是执行 deterministic preflight、询问用户，还是按 research / implement / check / finish brief 继续。

默认行为：

- `includeContext` 默认为 `lite`。
- 默认不返回 PRD、manifest、workspace 的大段详情。
- 返回 `evidenceRefs`、`omitted`、`tokenBudget`、`meta` 等观测字段。

### `workflow_run`

受控的工作流执行工具。

支持动作：

- `create_from_grill`
- `create_child`
- `start_checked`
- `checkpoint`
- `finish_run`
- `archive`
- `batch`

特性：

- 默认 dry-run。
- 修改任务状态需要 `mode: "execute"`。
- `start_checked` 和 `finish_run` 会先执行确定性 preflight。
- `batch` 支持顺序执行多个确定性动作，并返回 transaction、artifact 和 rollback hints。

## Pi 命令

```text
/workflow-init --dry-run
/workflow-init --execute
/workflow-init-spec --profile generic --dry-run
/workflow-init-spec --profile unity --dry-run
/workflow-init-spec --execute --plan <plan-id>
/workflow-prd-confirm --task <task-id> --message "confirmed" --execute
```

说明：

- `/workflow-init` 初始化基础 `.workflow` 结构。
- `/workflow-init-spec` 按计划生成通用或 Unity spec。
- `/workflow-prd-confirm` 通过 Pi UI 记录 PRD 最终确认，避免让 LLM 转述人工确认。

## 工作流能力

### PRD / Manifest / Preflight

当前引擎支持：

- 解析 `.workflow/tasks/<task>/prd.md`。
- 提取 PRD kernel。
- 检测 TODO / TBD。
- 检测阻塞性开放问题。
- 检测最终确认 gate。
- 检查 Acceptance Criteria、Validation Plan、Definition of Done。
- 读取并校验 `implement.jsonl` / `check.jsonl`。
- 运行 checkpoint，例如 `git diff --check`。

### 上下文预算与缓存

`workflow_next` 默认返回 lite context，并使用：

- `evidenceRefs`
- `omitted`
- `tokenBudget`
- `meta`
- fingerprint-backed workflow cache

重复状态下可以命中 cache，减少重复读取和重复摘要。

### Adaptive Control

`workflow_next` 会返回 `adaptiveControl`：

```text
deterministic_preflight | subagent_brief | ask_user | none
```

它不会新增额外 LLM 工具，而是给出紧凑 brief，指导现有 Pi 工具和 `workflow_run` 如何继续。

推荐 agent 类型：

- `research`
- `implement`
- `check`
- `finish`
- `user`
- `none`

### Telemetry

`workflow_next` 和 `workflow_run` 会写入 schema-versioned telemetry JSONL：

```text
.workflow/.runtime/telemetry/
```

用于记录：

- token 估算
- cache hit / miss
- blocker / warning 分布
- artifact refs
- transaction 信息
- 执行耗时

### Compaction

扩展会注册 `session_before_compact` hook。

当 Pi session 中存在 workflow 状态时，会生成 workflow-aware summary，保留：

- active task
- phase / stage
- next action
- artifact refs
- read / modified files
- 最近非 tool 对话信号

## 初始化产物边界

初始化目标项目时，工作流数据位于：

```text
.workflow/
  config.json
  tasks/
  spec/
  .runtime/
```

原则：

- `.workflow/spec/**` 保存 durable project knowledge。
- `.workflow/tasks/**` 保存任务数据。
- `.workflow/.runtime/**` 保存缓存、遥测、checkpoint、transaction 等运行时产物。
- 不复制旧 Python engine。
- 不恢复旧 wrapper 命令。

## Unity Profile

Unity profile 是通用 Unity 支持，不硬编码特定项目规则。

当前可生成：

```text
.workflow/spec/modules/unity-project.md
.workflow/spec/modules/unity-assets.md
```

资源系统规则只在扫描到相关项目事实时记录，不默认假设 Addressables、YooAsset 或 AssetBundle。

## 本地开发

安装依赖后，在项目目录运行：

```bash
npm test
npm run smoke:unity-scanner
```

历史任务回放工具：

```bash
npm run replay:history -- <project-root> --variants as_is,planning,in_progress
```

该工具会把历史任务复制到临时 workspace 中运行，不会修改源项目。

## 项目结构

```text
package.json
README.md
skills/
src/
  engine/
  init/
  replay/
  safety/
  templates/
templates/
tests/
tsconfig.json
```

## 当前限制

- 不执行 Git 自动 commit / push。
- 不提供旧 Python workflow wrapper。
- 不增加额外 LLM 可见 subagent 工具。
- rollback hints 目前是建议性信息，不自动执行回滚。

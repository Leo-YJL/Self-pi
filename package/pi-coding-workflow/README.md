# pi-coding-workflow

`pi-coding-workflow` 是一个面向 Pi 的通用编码工作流包。它通过 TypeScript 引擎管理任务状态、PRD gate、manifest 校验、上下文预算、缓存、遥测、压缩摘要和自适应路由，同时保持 LLM 可见工具面简洁稳定。

## 目标

- 只暴露两个 LLM 可见工具：`workflow_next` 和 `workflow_run`。
- 将复杂工作流逻辑放在本地确定性引擎中，减少模型往返和 token 消耗。
- 支持通用项目与 Unity 项目的 `.workflow` 初始化。
- 默认返回轻量上下文，通过证据引用按需展开详情。
- 避免恢复旧 wrapper、旧 Python engine 或大量 LLM 可见命令。

## Pi package 资源

```json
{
  "pi": {
    "extensions": ["./src/index.ts"],
    "skills": ["./skills"]
  }
}
```

## LLM 可见工具

### `workflow_next`

语义只读的工作流路由工具。

它不会修改项目源码、Git、task 状态或配置；但可能更新 `.workflow/.runtime` 下的 cache、telemetry 等运行时产物。

主要返回：

- 当前 task 状态。
- 下一步建议。
- blocker / warning。
- `evidenceRefs`。
- `omitted`。
- `tokenBudget`。
- `adaptiveControl`。
- `meta`。

默认：

```json
{ "includeContext": "lite" }
```

需要更多详情时再显式请求：

```json
{ "includeContext": "task" }
```

### `workflow_run`

受控的工作流执行工具。

支持动作：

```text
create_from_grill
create_child
start_checked
checkpoint
finish_run
archive
batch
```

规则：

- 默认 `mode: "dry_run"`。
- 修改 task 状态需要 `mode: "execute"`。
- `start_checked` 和 `finish_run` 会执行确定性 preflight。
- `batch` 可顺序执行多个动作，并返回 transaction、artifact 和 rollback hints。

示例：

```json
{
  "action": "batch",
  "mode": "dry_run",
  "actions": [
    { "action": "start_checked", "task": "06-12-example" },
    { "action": "checkpoint", "task": "06-12-example", "phase": "after-implementation" }
  ]
}
```

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

- `/workflow-init` 创建基础 `.workflow` 结构。
- `/workflow-init-spec` 生成或执行 spec 初始化计划。
- `/workflow-prd-confirm` 通过 Pi UI 写入 PRD 最终确认 gate，避免让 LLM 代为转述人工确认。

## 工作流能力

### PRD / Manifest / Preflight

引擎支持：

- 解析 `.workflow/tasks/<task>/prd.md`。
- 提取 PRD kernel。
- 检测 TODO / TBD。
- 检测阻塞性开放问题。
- 检测最终确认 gate。
- 检查 Acceptance Criteria、Validation Plan、Definition of Done。
- 校验 `implement.jsonl` / `check.jsonl`。
- 执行 checkpoint，例如 `git diff --check`。

### 上下文预算与缓存

`workflow_next` 默认返回 lite context，并通过以下字段降低重复上下文成本：

- `evidenceRefs`
- `omitted`
- `tokenBudget`
- `meta`
- fingerprint-backed workflow cache

### Adaptive Control

`workflow_next` 返回 `adaptiveControl`，用于指导下一步策略：

```text
deterministic_preflight | subagent_brief | ask_user | none
```

推荐 agent 类型：

```text
research | implement | check | finish | user | none
```

它只生成简短 brief，不新增额外 LLM 可见 subagent 工具。

### Telemetry

工具调用会写入 schema-versioned telemetry JSONL：

```text
.workflow/.runtime/telemetry/
```

用于记录 token 估算、cache hit、blocker/warning、artifact refs、transaction 和耗时。

### Compaction

扩展注册了 `session_before_compact` hook。

当 Pi session 中存在 workflow 状态时，会生成 workflow-aware summary，保留 active task、下一步、artifact refs、文件操作和近期对话信号。

## 初始化产物边界

目标项目中会使用以下结构：

```text
.workflow/
  config.json
  tasks/
  spec/
  .runtime/
```

约定：

- `.workflow/spec/**` 保存长期项目知识。
- `.workflow/tasks/**` 保存任务数据。
- `.workflow/.runtime/**` 保存 cache、telemetry、checkpoint、transaction 等运行时产物。
- 初始化不会复制 engine，也不会创建旧 wrapper。

## Profile

### `generic`

通用项目 spec 骨架。

### `unity`

通用 Unity 项目 spec 骨架。

当前生成：

```text
.workflow/spec/modules/unity-project.md
.workflow/spec/modules/unity-assets.md
```

Unity profile 不默认假设具体资源系统；只有扫描到项目事实时才记录相关候选。

## 本地开发

```bash
npm test
npm run smoke:unity-scanner
```

历史任务回放：

```bash
npm run replay:history -- <project-root> --variants as_is,planning,in_progress
```

回放工具会复制历史任务到临时 workspace 中执行，不会修改源项目。

## 当前限制

- 不执行 Git 自动 commit / push。
- 不提供旧 Python workflow wrapper。
- 不增加额外 LLM 可见 subagent 工具。
- rollback hints 目前是建议信息，不自动执行回滚。

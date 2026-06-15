# pi-coding-workflow

<p align="right">
  <a href="#中文">中文</a> | <a href="#english">English</a>
</p>

<a id="中文"></a>

<details open>
<summary><strong>中文说明</strong></summary>

## 项目简介

`pi-coding-workflow` 是一个面向 Pi 的通用编码工作流包。它通过 TypeScript 引擎管理任务状态、PRD gate、manifest 校验、上下文预算、缓存、遥测、压缩摘要和自适应路由，同时保持 LLM 可见工具面简洁稳定。

## 核心目标

- 只暴露三个 LLM 可见工具：`workflow_next`、`workflow_delegate` 和 `workflow_run`。
- 将复杂工作流逻辑放在本地确定性引擎中，减少模型往返和 token 消耗。
- 默认返回轻量上下文，通过证据引用按需展开详情。
- 支持通用项目与 Unity 项目的 `.workflow` 初始化。
- 不恢复旧 wrapper、旧 Python engine 或大量 LLM 可见命令。

## Pi package 资源

```json
{
  "pi": {
    "extensions": ["./src/index.ts"],
    "skills": ["./skills"]
  }
}
```

## 安装

发布到 npm 后可通过以下方式安装：

```bash
npm install @leo-yjl/pi-coding-workflow
```

如果在 Pi 项目中使用，请按照 Pi 的 package 加载方式引入该 npm 包；工作流运行时数据会写入目标项目的 `.workflow/**`。

## LLM 可见工具

### `workflow_next`

语义只读的工作流路由工具。它不会修改项目源码、Git、task 状态或配置；但可能更新 `.workflow/.runtime` 下的 cache、telemetry 等运行时产物。

主要返回：

- 当前 task 状态
- 下一步建议
- blocker / warning
- `evidenceRefs`
- `omitted`
- `tokenBudget`
- `adaptiveControl`
- `meta`

默认：

```json
{ "includeContext": "lite" }
```

需要更多详情时再显式请求：

```json
{ "includeContext": "task" }
```


### `workflow_delegate`

受控 subagent 执行工具。仅当 `workflow_next` 的 `adaptiveControl.strategy` 推荐 `subagent_brief` 时使用。它会创建隔离的 in-memory agent session，按 `research` / `implement` / `check` / `finish` 角色执行有预算限制的子任务，并把完整过程写入 artifact，主上下文只返回 compact summary。

关键约束：

- 默认 `mode: "dry_run"`，只规划不启动 subagent。
- `execute` 使用独立短上下文，不继承主会话长历史。
- 有 `maxTurns`、`maxToolCalls`、`maxInputTokens`、`maxOutputTokens` 预算。
- 有 `writePolicy`: `report_only`、`task_files_only`、`manifest_only`。
- subagent 内部的 `workflow_run` 只能 dry-run；最终状态推进仍由主流程调用 `workflow_run`。
- 返回 `artifactRef`、`metrics`、`changedFiles`、`blockedBy`、`recommendedNext`。

常见调用：

```json
{
  "agent": "implement",
  "mode": "dry_run",
  "task": "06-14-example",
  "writePolicy": "manifest_only"
}
```

### `workflow_run`

受控的工作流执行工具。

支持动作：

```text
create_from_grill
create_child
record_grill_decision
record_round_and_update_prd
append_prd_decisions
update_prd_section
init_manifests
upsert_manifest_entry
remove_manifest_entry
sync_manifest_from_diff
list_tasks
finalize_grill
start_checked
checkpoint
finish_run
archive
reopen
batch
```

规则：

- 默认 `mode: "dry_run"`。
- 默认 `detail: "lite"`；`start_checked` / `finish_run` / `checkpoint` 的完整 preflight details 会写入 `.workflow/.runtime/preflight/*.json`，工具结果只返回 `preflightRef`。需要内联详情时显式传 `detail: "summary"` 或 `detail: "full"`。
- 修改 task 状态需要 `mode: "execute"`。
- `record_grill_decision` / `finalize_grill` 记录并收口 Stage 1 grill；所有未 finalized 的 planning task 会被 `start_checked` 阻止。
- `record_round_and_update_prd` 在一次 `workflow_run` 中记录一轮业务 decisions、更新 PRD section，并默认追加缺失的 `## Grill Decision Log` 行；这是 grill 后的低 token 默认路径。
- Stage 1 grill 现在区分 `decisionCount` 与 `askRounds`：同一轮用户问答产生的多个 decision 应共享 `roundId`，`batch` 中未显式传 `roundId` 的 `record_grill_decision` 会被视为同一轮。
- `append_prd_decisions` 会把已记录但尚未写入 PRD 的业务 decision 追加到 `## Grill Decision Log`，用于确定性固化 “grill → 写 PRD” 步骤。
- `update_prd_section` 可确定性 replace/append 指定 PRD section（如 Requirements、Acceptance Criteria、Validation Plan、Open Questions），减少手工 edit 风险。
- `init_manifests` / `upsert_manifest_entry` / `remove_manifest_entry` / `sync_manifest_from_diff` 负责确定性维护 `implement.jsonl` 和 `check.jsonl`；不要优先让 LLM 裸写 JSONL。
- `list_tasks` 可列出任务；`archive` 会在用户确认后移动已完成任务；`reopen` 可在用户确认并提供原因后把已完成任务回退到执行阶段。
- `standard` 任务至少需要 2 个业务 grill round，`complex` / `goal` 至少需要 3 个；每个业务轮次后要先更新 PRD，业务决策必须写入 PRD 的 `Grill Decision Log`，最终确认必须单独发生在最新 PRD 上。
- `start_checked` 和 `finish_run` 会执行确定性 preflight。
- 当前版本不会执行 git commit 或 push；`.workflow/config.json` 中的 git 字段是保留策略配置，不能当作自动提交开关。
- `batch` 可顺序执行多个动作，并返回 transaction、artifact 和 rollback hints；默认结果会压缩，完整 child results 写入 `.workflow/.runtime/transactions/*.json`，需要内联完整结果时传 `detail: "full"`。

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
- 检测最终确认 gate，优先识别结构化 `Status: confirmed|pending` 字段，并通过 `Confirmed PRD Hash` 防止确认后修改 PRD。
- 检查 Acceptance Criteria、Validation Plan、Definition of Done。
- 校验并通过确定性 action 维护 `implement.jsonl` / `check.jsonl`。
- 执行 checkpoint，例如 `git diff --check`。

### 上下文预算与缓存

`workflow_next` 默认返回 lite context，并通过以下字段降低重复上下文成本：

- `evidenceRefs`
- `omitted`
- `tokenBudget`
- `meta`
- fingerprint-backed workflow cache
- telemetry warnings for repeated `workflow_next` / `workflow_run` / `workflow_delegate` calls and high estimated token usage

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

用于记录 token 估算、cache hit、blocker/warning、artifact refs、transaction、delegate run 和耗时。

### Compaction

扩展注册了 `session_before_compact` hook。当 Pi session 中存在 workflow 状态时，会生成 workflow-aware summary，保留 active task、下一步、artifact refs、文件操作和近期对话信号。

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

## 开源协议

本项目采用 [MIT License](LICENSE) 开源。

你可以自由使用、复制、修改、合并、发布、分发、再授权或销售本项目代码，但需要在副本或主要部分中保留版权声明和许可声明。

## 当前限制

- 不执行 Git 自动 commit / push。
- 不提供旧 Python workflow wrapper。
- 不增加额外 LLM 可见 subagent 工具。
- rollback hints 目前是建议信息，不自动执行回滚。

</details>

<a id="english"></a>

<details>
<summary><strong>English</strong></summary>

## Overview

`pi-coding-workflow` is a generic coding workflow package for Pi. It keeps task state, PRD gates, manifest validation, context budgeting, caching, telemetry, compaction summaries and adaptive routing inside a TypeScript engine while keeping the LLM-visible tool surface small and stable.

## Goals

- Expose only three LLM-visible tools: `workflow_next`, `workflow_delegate` and `workflow_run`.
- Move complex workflow behavior into a deterministic local engine to reduce model round trips and token usage.
- Return lightweight context by default and expose detailed evidence only when requested.
- Support `.workflow` initialization for generic and Unity projects.
- Avoid restoring legacy wrappers, legacy Python engines or a large LLM-visible command surface.

## Pi package resources

```json
{
  "pi": {
    "extensions": ["./src/index.ts"],
    "skills": ["./skills"]
  }
}
```

## Installation

After the package is published to npm, install it with:

```bash
npm install @leo-yjl/pi-coding-workflow
```

When used in a Pi project, load this npm package through Pi's package mechanism. Runtime workflow data is written under `.workflow/**` in the target project.

## LLM-visible tools

### `workflow_next`

A semantic read-only workflow router. It does not mutate project source files, Git state, task status or configuration; it may update runtime cache and telemetry artifacts under `.workflow/.runtime`.

Main fields returned:

- current task state
- recommended next action
- blockers / warnings
- `evidenceRefs`
- `omitted`
- `tokenBudget`
- `adaptiveControl`
- `meta`

Default request:

```json
{ "includeContext": "lite" }
```

Request more detail only when needed:

```json
{ "includeContext": "task" }
```


### `workflow_delegate`

Controlled subagent runner. Use it only when `workflow_next` recommends `adaptiveControl.strategy=subagent_brief`. It creates an isolated in-memory agent session for `research` / `implement` / `check` / `finish`, enforces budgets, writes full details to artifacts, and returns only a compact summary to the parent context.

Key constraints:

- Defaults to `mode: "dry_run"`; dry-run plans the delegate without starting a subagent.
- `execute` uses a fresh short context instead of inheriting the parent session history.
- Budgets: `maxTurns`, `maxToolCalls`, `maxInputTokens`, `maxOutputTokens`.
- Write policies: `report_only`, `task_files_only`, `manifest_only`.
- Subagent `workflow_run` calls are dry-run only; parent workflow still owns deterministic state transitions.
- Returns `artifactRef`, `metrics`, `changedFiles`, `blockedBy`, and `recommendedNext`.

Example:

```json
{
  "agent": "implement",
  "mode": "dry_run",
  "task": "06-14-example",
  "writePolicy": "manifest_only"
}
```

### `workflow_run`

A controlled workflow actuator.

Supported actions:

```text
create_from_grill
create_child
record_grill_decision
record_round_and_update_prd
append_prd_decisions
update_prd_section
init_manifests
upsert_manifest_entry
remove_manifest_entry
sync_manifest_from_diff
list_tasks
finalize_grill
start_checked
checkpoint
finish_run
archive
reopen
batch
```

Rules:

- Defaults to `mode: "dry_run"`.
- Defaults to `detail: "lite"`; full preflight details for `start_checked` / `finish_run` / `checkpoint` are written to `.workflow/.runtime/preflight/*.json` and returned as `preflightRef`. Pass `detail: "summary"` or `detail: "full"` when inline details are needed.
- Task mutations require `mode: "execute"`.
- `record_grill_decision` / `finalize_grill` record and close Stage 1 grill; `start_checked` blocks any planning task that is not finalized.
- `record_round_and_update_prd` records one business decision round, updates PRD sections, and appends missing `## Grill Decision Log` rows in one `workflow_run` call; this is the low-token default path after a grill answer.
- Stage 1 grill now separates `decisionCount` from `askRounds`: multiple decisions from the same user interaction should share `roundId`; `record_grill_decision` items inside one `batch` share a round by default when no explicit `roundId` is provided.
- `append_prd_decisions` appends recorded business decisions that are still missing from the PRD into `## Grill Decision Log`, making the “grill → write PRD” step deterministic.
- `update_prd_section` deterministically replaces/appends a target PRD section such as Requirements, Acceptance Criteria, Validation Plan or Open Questions, reducing manual edit risk.
- `init_manifests` / `upsert_manifest_entry` / `remove_manifest_entry` / `sync_manifest_from_diff` deterministically maintain `implement.jsonl` and `check.jsonl`; prefer them over hand-written JSONL.
- `list_tasks` lists workflow tasks; `archive` moves a completed task after user confirmation; `reopen` moves a completed task back to execution after confirmation and a reason.
- `standard` tasks require at least 2 business grill rounds, while `complex` / `goal` require at least 3; the PRD must be updated after each business round, business decisions must appear in the PRD `Grill Decision Log`, and final confirmation must be separate and tied to the latest PRD.
- `start_checked` and `finish_run` run deterministic preflight checks first.
- This version does not run git commit or push; git fields in `.workflow/config.json` are reserved policy settings, not automatic commit switches.
- `batch` runs multiple actions in order and returns transaction artifacts plus rollback hints; by default child results are compacted and full results are written to `.workflow/.runtime/transactions/*.json`; pass `detail: "full"` when inline full results are needed.

## Pi commands

```text
/workflow-init --dry-run
/workflow-init --execute
/workflow-init-spec --profile generic --dry-run
/workflow-init-spec --profile unity --dry-run
/workflow-init-spec --execute --plan <plan-id>
/workflow-prd-confirm --task <task-id> --message "confirmed" --execute
```

Notes:

- `/workflow-init` creates the base `.workflow` structure.
- `/workflow-init-spec` creates or executes a spec initialization plan.
- `/workflow-prd-confirm` records the PRD final confirmation gate through Pi UI, so the LLM does not need to relay human confirmation text.

## Workflow capabilities

### PRD / Manifest / Preflight

The engine supports:

- reading `.workflow/tasks/<task>/prd.md`
- extracting the PRD kernel
- detecting TODO / TBD markers
- detecting blocking open questions
- detecting the final confirmation gate, preferring structured `Status: confirmed|pending` fields, and using `Confirmed PRD Hash` to invalidate stale confirmations after PRD edits
- checking Acceptance Criteria, Validation Plan and Definition of Done
- validating and deterministically maintaining `implement.jsonl` and `check.jsonl`
- running checkpoints such as `git diff --check`

### Context budget and cache

`workflow_next` returns lite context by default and reduces repeated context cost through:

- `evidenceRefs`
- `omitted`
- `tokenBudget`
- `meta`
- fingerprint-backed workflow cache
- telemetry warnings for repeated `workflow_next` / `workflow_run` / `workflow_delegate` calls and high estimated token usage

### Adaptive Control

`workflow_next` returns `adaptiveControl` to guide the next strategy:

```text
deterministic_preflight | subagent_brief | ask_user | none
```

Recommended agent types:

```text
research | implement | check | finish | user | none
```

It emits compact briefs only and does not add extra LLM-visible subagent tools.

### Telemetry

Tool calls write schema-versioned telemetry JSONL under:

```text
.workflow/.runtime/telemetry/
```

Telemetry records token estimates, cache hits, blockers/warnings, artifact refs, transactions, delegate runs and elapsed time.

### Compaction

The extension registers a `session_before_compact` hook. When workflow state exists in a Pi session, it emits a workflow-aware summary that preserves the active task, next action, artifact refs, file operations and recent conversation signals.

## Initialization boundaries

Target projects use this structure:

```text
.workflow/
  config.json
  tasks/
  spec/
  .runtime/
```

Conventions:

- `.workflow/spec/**` stores durable project knowledge.
- `.workflow/tasks/**` stores task data.
- `.workflow/.runtime/**` stores cache, telemetry, checkpoints, transactions and other runtime artifacts.
- Initialization does not copy the engine and does not create legacy wrappers.

## Profiles

### `generic`

Generic project spec skeleton.

### `unity`

Generic Unity project spec skeleton.

Generated files:

```text
.workflow/spec/modules/unity-project.md
.workflow/spec/modules/unity-assets.md
```

The Unity profile does not assume a specific resource system by default. Resource-system candidates are recorded only when project facts are detected.

## Local development

```bash
npm test
npm run smoke:unity-scanner
```

Historical task replay:

```bash
npm run replay:history -- <project-root> --variants as_is,planning,in_progress
```

The replay tool copies historical tasks into temporary workspaces and does not mutate the source project.

## License

This project is released under the [MIT License](LICENSE).

You may use, copy, modify, merge, publish, distribute, sublicense and sell copies of the software, provided that the copyright and license notice are included in copies or substantial portions of the software.

## Current limits

- No automatic Git commit / push.
- No legacy Python workflow wrapper.
- No extra LLM-visible subagent tools.
- Rollback hints are advisory and are not executed automatically.

</details>

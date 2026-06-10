# pi-coding-workflow 工作流完善计划

本文档用于在 `D:\YJL_AI\PI_Package\pipackage` 下开启新对话时快速恢复上下文，并继续完善 `package/pi-coding-workflow`。

## 0. 新对话启动提示

在新的 Pi 对话中，可以直接复制下面这段作为开场：

```text
请读取 D:\YJL_AI\PI_Package\pipackage\WORKFLOW_IMPROVEMENT_PLAN.md，继续完善 package/pi-coding-workflow。
当前目标是按文档优先级补齐 pi-coding-workflow 的 workflow package 能力，保持 TypeScript-only、默认 LLM 可见工具仅 workflow_next / workflow_run，并优先保证 GameBase 可用。
请先检查 git status、package tests 和当前文档，再提出本轮具体实现计划。
```

## 1. 仓库与 package 当前状态

仓库根目录：

```text
D:\YJL_AI\PI_Package\pipackage
```

当前 package 路径：

```text
D:\YJL_AI\PI_Package\pipackage\package\pi-coding-workflow
```

GameBase 当前通过项目 `.pi/settings.json` 加载：

```json
{
  "enableSkillCommands": true,
  "packages": [
    "D:/YJL_AI/PI_Package/pipackage/package/pi-coding-workflow"
  ]
}
```

`pipackage` 当前是本地 Git 仓库，初始 commit：

```text
f305c8b 初始化pipackage并加入pi-coding-workflow
```

当前没有 remote。若后续创建 GitHub 仓库，需要执行：

```powershell
cd D:\YJL_AI\PI_Package\pipackage
git remote add origin https://github.com/<user-or-org>/pipackage.git
git push -u origin main
```

## 2. 设计原则 / 不变量

### 2.1 Package / Project 边界

`pi-coding-workflow` package owns：

- workflow engine
- tools
- commands
- skills
- templates
- init / init-spec scanner
- task lifecycle implementation
- validation / context / finish orchestration

使用该 package 的项目 owns：

- `.pi/settings.json`
- `.workflow/config.json`
- `.workflow/spec/**`
- `.workflow/tasks/**`
- `.workflow/.runtime/**` 本地缓存

项目不应再复制完整 workflow engine。

### 2.2 LLM 可见工具面

默认只暴露两个 LLM-visible tools：

- `workflow_next`：只读路由和简短上下文。
- `workflow_run`：受控动作执行器，默认 dry-run。

不要把大量旧 CLI 命令直接暴露给 LLM。旧命令能力应封装进这两个工具或 `/workflow-*` 命令内部。

### 2.3 Engine 语言

第一版与后续完善保持：

- TypeScript-only。
- 不引入 Python engine。
- 不恢复旧 GameBase `.workflow/scripts/workflow.py`。
- 不在项目中恢复 `.pi/extensions/workflow/**`。

### 2.4 安全原则

- 默认 dry-run。
- Git finalize 必须先产出 plan，再 execute。
- 不 blind stage / blind commit / blind push。
- 不覆盖无关 dirty files。
- 不把 `.workflow/.runtime/**` 缓存提交进项目。

## 3. 当前 package 能力

### 3.1 已实现

当前 package 已实现：

- `workflow_next`
  - 读取 `.workflow/config.json`。
  - 检测 `.workflow/tasks/**/task.json` active task。
  - 支持 legacy GameBase task fields：
    - `flow_level` -> `flowLevel`
    - `created_at` / `updated_at` -> `createdAt` / `updatedAt`
    - `parent_task` -> `parentTask`
  - 根据 active task 返回：
    - `no_task` -> `no_task_grill`
    - `planning` -> `start_checked`
    - `in_progress` -> `implement_slice` / `checkpoint`
    - finish agent -> `finish_dry_run`
- `workflow_run`
  - `create_from_grill`
  - `create_child`
  - `start_checked`
  - `checkpoint`
  - `finish_run`
  - `archive` 占位
- `/workflow-init`
- `/workflow-init-spec`
  - `generic`
  - `unity`
  - plan-based dry-run / execute
- Unity static scanner
- Generic / Unity spec templates
- Active skills：
  - `workflow-grill`
  - `workflow-check`
  - `workflow-finish`
  - `workflow-update-spec`
  - `workflow-break-loop`
- Node test baseline

### 3.2 当前 daily flow

```text
workflow_next
  -> workflow_run create_from_grill  # no_task / intake 后创建 task
  -> workflow_run start_checked      # planning/grill -> in_progress/execute
  -> workflow_run checkpoint         # git diff --check + artifact evidence
  -> workflow_run finish_run         # in_progress/execute -> completed/finish
```

当前 `finish_run` 只标记 task completed，不执行 Git commit/push。

### 3.3 当前测试

```powershell
cd D:\YJL_AI\PI_Package\pipackage\package\pi-coding-workflow
npm test
```

当前测试数：9。

monorepo 根目录也可运行：

```powershell
cd D:\YJL_AI\PI_Package\pipackage
npm test
```

## 4. 旧 GameBase workflow 能力审计

旧 GameBase workflow 约有 41 个 CLI commands，按层次分为：

### 4.1 Primary daily path

- `next`
- `create-from-grill`
- `create-child`
- `grill-status`
- `start --checked`
- `checkpoint --profile ...`
- `finish-run`
- `list`
- `archive`

### 4.2 Runtime/internal JSON API

- `status`
- `state`
- `inject-context`
- `task-context`
- `subagent-brief`
- `prd-kernel`
- `context-budget`

### 4.3 Diagnostic / CI

- `commands`
- `validate`
- `verify`
- `budget-smoke`
- `session-usage`
- `context`
- `observe`
- `drift`
- `control`

### 4.4 Planning helpers

- `add-context`
- `list-context`
- `suggest-manifest`
- `suggest-slices`
- `context-bundle`

### 4.5 Repair / legacy

- `init`
- `create`
- `create-small-fix`
- `select-flow`
- `stage`
- `current`
- `finish`
- `journal`

这些不应原样暴露为 LLM daily tool surface，但其中很多能力需要按阶段重新封装进 package。

## 5. 完善优先级

## P0 — 已完成：基础 task route 可用性

目标：迁移后 package 不再只是 init 工具，而能识别 task 并跑基本阶段流。

已完成：

- active task discovery。
- legacy task field compatibility。
- active-task-aware `workflow_next`。
- `start_checked` dry-run / execute。
- `checkpoint` active task 绑定。
- `finish_run` dry-run / execute。
- README 和 tests 更新。

## P1 — 下一阶段建议优先做：PRD / preflight / manifest

目标：恢复旧流程中最影响任务质量的 deterministic gates 和 PRD-first 执行体验。

建议拆成一个或两个任务完成。

### P1.1 PRD Kernel

新增模块建议：

```text
src/engine/prd.ts
```

能力：

- 读取 `.workflow/tasks/<task>/prd.md`。
- 提取或生成：
  - title
  - execution contract
  - goal
  - requirements
  - acceptance criteria
  - validation plan
  - open questions
  - final confirmation
  - out-of-scope
- 输出 compact/brief/full 三种视图。
- 标记 TODO、unchecked checklist、blocking open questions。

### P1.2 Start Preflight

封装到 `workflow_run start_checked` 内部，也可作为非 LLM 命令 `/workflow-start-preflight`。

检查：

- task status 必须是 `planning`。
- stage 应为 `grill`。
- PRD 存在且无 blocking open questions。
- manifest 存在：
  - `implement.jsonl`
  - `check.jsonl`
- manifest 中的 file 均存在。
- flow level 存在。
- final confirmation 记录存在。
- dirty files 不含明显无关风险。

### P1.3 Finish Preflight

封装到 `workflow_run finish_run` dry-run 内部。

检查：

- task status 必须是 `in_progress`。
- stage 应为 `execute`。
- Acceptance Criteria checklist 全部完成或 N/A。
- Validation Plan checklist 全部完成或有 limitation。
- Definition of Done 完成。
- `git diff --check` 通过。
- dirty files 可分类。
- Git finalizer plan 可选，仅 P3 时实现。

### P1.4 Manifest helpers

新增模块建议：

```text
src/engine/manifest.ts
```

能力：

- 读取 JSONL manifest。
- 校验 `{ file, reason }`。
- 跳过 `_example` 行。
- 按 agent 返回 implement/check manifest summary。
- 给 PRD Kernel / Context Bundle 复用。

### P1.5 Context Bundle

新增模块建议：

```text
src/engine/contextBundle.ts
```

输出：

- task state
- PRD kernel
- manifest summary
- recommended next action
- warnings/blockers
- short workspace summary

该能力可以作为 `workflow_next(includeContext="task|check|finish")` 的内部上下文来源。

### P1 验收标准

- `workflow_next` 对 planning/in_progress/completed 能返回更有用的 route/context。
- `workflow_run start_checked --dry_run` 能阻止明显不完整 PRD/task。
- `workflow_run finish_run --dry_run` 能阻止 checklist 未完成 task。
- Tests 覆盖：
  - missing PRD
  - PRD TODO
  - blocking open questions
  - missing manifest file
  - unchecked finish checklist

## P2 — 上下文预算 / Pi hook / subagent 支持

目标：恢复旧流程的高价值上下文注入能力，但保持 package 化和简洁工具面。

### P2.1 Context budget

新增模块建议：

```text
src/context/budget.ts
```

能力：

- 按 `.workflow/config.json` 读取预算：
  - max file bytes
  - max total bytes
  - max files
  - estimated tokens
- 对 manifest 文件做 deterministic ordering。
- 支持 modes：
  - minimal
  - brief
  - full
  - full-with-budget
- 默认不要把动态预算数字注入 prompt，除非 warning/debug。

### P2.2 Inject context

目标替代旧 `workflow.py inject-context`。

可以做成：

- `workflow_next(includeContext="brief|task|check|finish")` 返回精简上下文。
- Pi extension hook 在 `before_agent_start` 中读取 `workflow_next` 或内部 context builder。
- 不再暴露大量 runtime tools。

### P2.3 Subagent brief

新增模块建议：

```text
src/engine/subagentBrief.ts
```

输出：

- delegated scope
- relevant PRD kernel
- allowed/forbidden actions
- manifest files
- expected output
- stop conditions

注意：默认 LLM-visible tools 仍只有 `workflow_next` / `workflow_run`。

### P2 验收标准

- GameBase active complex task 能获得 full-with-budget manifest context。
- no_task 状态下 context 自动降级 minimal。
- subagent brief 不要求子代理再读大量动态 prompt。
- Tests 覆盖预算裁剪和 no_task fallback。

## P3 — Git finalizer / adaptive control / archive

目标：恢复旧流程的安全收尾能力。必须谨慎设计。

### P3.1 Safe Git finalizer

新增模块建议：

```text
src/engine/git.ts
```

能力：

- dry-run 默认。
- 分类 dirty files：
  - in-scope
  - unrelated
  - blocked
- 检查 upstream：
  - ahead
  - behind
  - no upstream
- obey config：
  - autoCommit
  - autoPush
  - pushConfirmation
  - protectedBranches
  - allowBroadStage=false
- execute 只 stage explicit in-scope files。
- commit message 支持中文，避免 Windows 编码问题。
- push 风险必须停下并要求用户确认。

### P3.2 Adaptive control

新增模块建议：

```text
src/engine/telemetry.ts
```

能力：

- observe
- drift
- control
- reset

不需要恢复旧 CLI 形态，可以集成进 checkpoint 或 `workflow_run checkpoint`。

### P3.3 Archive / journal

保持显式用户意图才执行。

### P3 验收标准

- `finish_run --dry_run` 给出完整 Git plan。
- `finish_run --execute` 只在无 unrelated dirty、upstream 安全、策略允许时 commit/push。
- Tests 覆盖 unrelated dirty、behind upstream、no upstream、protected branch、push confirmation。

## 6. 文件结构建议

当前：

```text
package/pi-coding-workflow/src/
  artifacts/
  commands/
  context/
  engine/
  init/
  safety/
  templates/
  tools/
  types.ts
```

建议逐步演进为：

```text
src/engine/
  checkpoint.ts
  config.ts
  contextBundle.ts        # P1
  git.ts                  # P3
  manifest.ts             # P1
  prd.ts                  # P1
  route.ts
  run.ts
  task.ts
  telemetry.ts            # P3
  validate.ts

src/context/
  budget.ts               # P2
  inject.ts               # P2
  subagentBrief.ts         # P2

src/init/
  ...
```

## 7. 测试策略

继续使用 Node built-in test：

```powershell
cd D:\YJL_AI\PI_Package\pipackage\package\pi-coding-workflow
node --test --experimental-strip-types tests/*.test.ts
```

根目录：

```powershell
cd D:\YJL_AI\PI_Package\pipackage
npm test
```

测试应优先覆盖：

- temp project root
- fake Unity project
- fake workflow tasks
- no Git 或 mock Git 场景
- Windows path / slash normalization
- dry-run 不变更文件
- execute 只变更预期文件

## 8. GameBase smoke 验证

每次 package 关键改动后，至少执行：

```powershell
cd D:\YJL_AI\PI_Package\pipackage\package\pi-coding-workflow
npm test
node --experimental-strip-types --input-type=module - <<'JS'
import { workflowNext } from './src/engine/route.ts';
const result = await workflowNext('D:/YJL_AI/GameBase', { includeContext: 'brief' });
console.log(JSON.stringify(result, null, 2));
JS
```

如果修改 `/workflow-init-spec` 或 Unity scanner，额外执行 GameBase Client dry-run smoke：

```powershell
node --experimental-strip-types --input-type=module - <<'JS'
import { createInitSpecPlan } from './src/init/specPlan.ts';
const plan = await createInitSpecPlan('D:/YJL_AI/GameBase/Client', 'unity');
console.log(JSON.stringify({
  confidence: plan.project.confidence,
  unityVersion: plan.facts.unity?.version,
  hasEditorBuild: plan.operations.some(op => op.path.includes('editor-and-build')),
  unitySpecs: plan.operations.filter(op => op.path.includes('unity-')).map(op => op.path)
}, null, 2));
JS
```

## 9. Git / GitHub 操作

当前本地仓库：

```powershell
cd D:\YJL_AI\PI_Package\pipackage
git status -sb
git log --oneline -3
```

创建 GitHub remote 后：

```powershell
git remote add origin https://github.com/<user-or-org>/pipackage.git
git push -u origin main
```

如果需要代理：

```powershell
$env:HTTP_PROXY="http://127.0.0.1:7890"
$env:HTTPS_PROXY="http://127.0.0.1:7890"
$env:ALL_PROXY="http://127.0.0.1:7890"
```

## 10. 当前建议的下一项任务

建议下一个对话优先做 P1：

```text
实现 pi-coding-workflow P1：PRD Kernel、Manifest 读取、start/finish preflight、context-bundle，并扩展 workflow_next/workflow_run 的 dry-run gate。
```

建议验收：

- `workflow_run start_checked --dry_run` 能阻止缺失 PRD/manifest/final confirmation 的 task。
- `workflow_run finish_run --dry_run` 能阻止未完成 Acceptance Criteria / Validation Plan 的 task。
- `workflow_next(includeContext="task")` 能返回 PRD kernel + manifest summary。
- Tests 增加到覆盖 P1 gates。

## 11. 明确暂不做

- 不恢复 Python workflow engine。
- 不把旧 41 个命令直接变成 LLM tools。
- 不在 GameBase 项目内恢复 `.workflow/scripts`。
- 不在 GameBase 项目内恢复 `.pi/extensions/workflow`。
- 不默认启用 Git auto push。
- 不默认生成 Unity `editor-and-build.md`。

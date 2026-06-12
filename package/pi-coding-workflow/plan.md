# pi-coding-workflow 优化完善计划

生成时间：2026-06-12
项目：`D:/YJL_AI/PI_Package/pipackage/package/pi-coding-workflow`
依据：
- `E:/综合/优化/package/OPTIMIZATION_AND_COMPLETION_PLAN.md`
- `E:/综合/优化/package/PI_NATIVE_OPTIMIZATION_RECOMMENDATIONS.md`
- 当前源码、README、测试与 Pi extension 文档（extensions/compaction）

## 1. 当前已实现架构快照

### 1.1 Package / Pi 集成

- `package.json` 已声明 Pi package 资源：`pi.extensions=["./src/index.ts"]`、`pi.skills=["./skills"]`。
- `src/index.ts` 已注册两个 LLM 可见工具：
  - `workflow_next`：只读路由/上下文摘要工具。
  - `workflow_run`：受控执行工具，默认 `dry_run`。
- `src/index.ts` 已注册两个命令：
  - `/workflow-init`：初始化基础 `.workflow` 结构。
  - `/workflow-init-spec`：按 `generic` / `unity` profile 生成并执行 spec 初始化计划。

### 1.2 Engine 模块

- `src/engine/route.ts`：发现 active task，按状态输出下一步建议。
- `src/engine/run.ts`：执行 `create_from_grill`、`create_child`、`start_checked`、`checkpoint`、`finish_run`、`archive`。
- `src/engine/prd.ts`：解析 PRD kernel，识别关键章节、TODO/TBD、开放问题、最终确认与 checklist gate。
- `src/engine/manifest.ts`：读取 `implement.jsonl` / `check.jsonl`，校验 `{ file, reason }` 与文件存在性。
- `src/engine/contextBundle.ts`：组装 PRD、manifest、workspace、blocker/warning、recommended next。
- `src/engine/validate.ts`：实现 start / checkpoint / finish preflight。
- `src/engine/checkpoint.ts`、`workspace.ts`：执行 `git diff --check` 与 dirty workspace 归类。
- `src/engine/task.ts`：task 创建、读取、normalize、active task 发现，兼容部分旧 GameBase snake_case 字段。

### 1.3 初始化与 profile

- `src/init/initWorkspace.ts`：创建 `.workflow/config.json`、tasks/spec/runtime 目录，并维护 `.gitignore` 的 `.workflow/.runtime/`。
- `src/init/specPlan.ts`：dry-run 总是先写 plan artifact，execute 读取既有 plan，不重新扫描生成不同计划。
- `src/init/unityScanner.ts`：检测 Unity 项目事实，包括 Unity 版本、Packages、URP/HDRP、asmdef、入口场景、bootstrap、资源系统、生成文件候选。
- `src/init/templateCatalog.ts`：包含 generic 和 Unity spec 模板，并避免硬编码 GameBase 私有规则。

### 1.4 Skill 与测试

- 已有 skills：`workflow-grill`、`workflow-check`、`workflow-finish`、`workflow-update-spec`、`workflow-break-loop`。
- `tests/init-spec.test.ts` 覆盖：配置、路径安全、模板渲染、Unity scanner、workspace/spec init、artifact writer、workflow_next/run 路由、PRD/manifest/preflight/finish gates。
- 当前基线测试通过：`node --test --experimental-strip-types tests/*.test.ts`。

## 2. 两份优化文档的合并结论

### 2.1 已完成或部分完成

- 两工具方向已落地：只暴露 `workflow_next` / `workflow_run`。
- 初始化边界基本正确：项目中只创建 `.workflow` 数据/配置/运行时 artifact，不复制 engine。
- PRD、manifest、start/finish preflight 已有 TypeScript engine 实现。
- Unity profile 已按“通用 Unity + 检测事实”方式落地，未默认注入 Addressables/YooAsset/AssetBundle/GameBase 私有规则。

### 2.2 主要缺口

| 优先级 | 缺口 | 当前状态 | 优化方向 |
|---|---|---|---|
| P0 | 工具输出 token 预算与 lite 默认值 | `workflow_next` 默认 `brief`，仍可能返回较多 details | 改为默认 `lite`，返回 evidence/omitted/tokenBudget，详细内容需显式请求 |
| P0 | `workflow_run` 事务/批处理 | 只有单 action | 增加 `batch/actions[]`，返回统一 `nextRecommendedCall`、artifacts、meta |
| P0 | Pi session artifact/cache 适配 | tool result 只作为普通结果返回 | 在 extension 层用 `pi.appendEntry()` 记录轻量 workflow 状态，不进入 LLM 上下文 |
| P1 | context budget/cache/progressive disclosure | 有 contextBundle，但缺硬预算与观测字段 | 增加预算估算、truncated/omitted/cache 观测字段，后续再实现 fingerprint cache |
| P1 | custom compaction | 未实现 | 后续通过 `session_before_compact` 注入 workflow-aware summary，但不能丢失普通对话摘要 |
| P1 | telemetry/checkpoint schema | 有 checkpoint artifact，但 schema/轮转/回放不足 | 定义 schema、结果 meta、历史回放测试 |
| P2 | 文档矩阵 | README 有现状，缺 runtime coverage/migration/tool contract 独立文档 | 后续补 docs/ 下的覆盖矩阵和契约文档 |

## 3. 实施计划

### Phase A：立即优化工具契约、输出预算与 Pi 原生轻状态（本轮开始）

目标：优先减少默认 token、稳定工具返回结构、为后续 cache/compaction 打基础。

- [x] 创建本 `plan.md`，记录当前架构、文档分析、分阶段路线。
- [x] `workflow_next` 默认 `includeContext="lite"`：
  - 返回 `state/task/phase/nextAction/recommendedTool`。
  - 默认不返回 PRD/manifest/workspace 详情。
  - 返回 `evidenceRefs`、`omitted`、`tokenBudget`、`cache` 观测字段。
- [x] `contextBundle` 增加预算意识：
  - `lite`：仅摘要和证据引用。
  - `brief`：短摘要，不返回全文级 details。
  - `task/check/finish`：保留 details，但受预算和截断/omitted 记录约束。
- [x] `workflow_run` 返回统一结果 envelope：
  - `artifacts[]`、`nextRecommendedCall`、`meta.estimatedTokens/truncatedBytes/omittedRefs`。
  - 支持 `action="batch"` + `actions[]` 的顺序事务入口。
- [x] `src/index.ts` 在 next/run 后调用 `pi.appendEntry("pi-coding-workflow", ...)`，记录轻量状态、下一步与 artifact refs，不进入 LLM 上下文。
- [x] 更新 README 与测试。

验收：

- 默认 `workflow_next({})` 不返回 PRD/manifest 详情。
- 显式 `workflow_next({ includeContext:"task" })` 仍可拿到 PRD/manifest details。
- `workflow_run` 单 action 和 batch 均返回 `nextRecommendedCall` 与 `meta`。
- 现有测试与新增测试通过。

本轮执行结果：

- 已新增 `src/engine/contextBudget.ts`。
- 已更新 `workflow_next` 默认 lite、context budget、evidence/omitted/tokenBudget/meta。
- 已更新 `workflow_run` batch/envelope/meta/artifact/nextRecommendedCall。
- 已在 extension 层追加轻量 `pi-coding-workflow` session entry。
- 已新增测试并通过 `npm test`（17/17）。

### Phase B：减少交互轮次与 deterministic preflight

- [x] 扩展 `batch/actions[]` 的事务语义：dry-run plan、execute commit、失败停止、rollback hint。
- [x] 将 PRD final confirmation / profile 选择更多迁移到 `/workflow-*` command + `ctx.ui`。
- [ ] 将可本地判断的 check/format/manifest/PRD gate 保持在 engine 中，语义冲突再交给 LLM。

本轮继续执行结果：

- 已增强 `workflow_run action="batch"`：
  - 顶层 dry-run batch 强制所有子 action dry-run，避免误执行。
  - 顶层 execute batch 默认子 action execute，可逐项覆盖为 dry_run。
  - execute/partial batch 写入 `.workflow/.runtime/transactions/*.json`。
  - 返回 `transaction`、`rollbackHints`、transaction artifact。
- 已新增 `src/engine/prdConfirm.ts`，支持 dry-run/execute 方式 upsert PRD final confirmation。
- 已新增 `/workflow-prd-confirm` command，通过 Pi UI editor/confirm 采集和确认人工 gate，不经 LLM 转述。
- 已新增测试并通过 `npm test`（19/19）。

### Phase C：workflow manifest cache + telemetry

- [x] 引入 `.workflow/.runtime/cache/pi-workflow/context-cache.json` cache 文件。
- [x] cache key 包含 packageVersion、taskId、phase、PRD/manifest/config fingerprint、profile、detailLevel、agent、workspace fingerprint。
- [x] 记录 cache hit/miss、estimatedTokens、truncatedBytes、omittedRefs。
- [x] 定义 telemetry/checkpoint/artifact schema 与轮转策略。

本轮继续执行结果：

- 已新增 `src/engine/cache.ts`。
- `workflow_next` 的 lite/brief 调用会读写 fingerprint-backed cache。
- cache hit 会反映到 `cache.hit`、`context.tokenBudget.cacheHit`、`meta.cacheHit`。
- 已新增 `src/engine/telemetry.ts`，`workflow_next` / `workflow_run` 写入 `.workflow/.runtime/telemetry/workflow-YYYYMMDD*.jsonl`。
- telemetry 日志按 512 KiB 日文件轮转，写入失败不影响工具执行。
- checkpoint artifact 已补 `schemaVersion` / `kind` / package / passed / summary。
- 已新增 `docs/telemetry-schema.md`。
- 已新增重复调用 cache hit 与 telemetry schema 测试并通过 `npm test`（20/20）。

### Phase D：Pi custom compaction 与回放量化

- [x] 基于 Pi `session_before_compact` 增加 workflow-aware summary：active task、phase、next action、modified/read files、artifact refs、blockers/信号。
- [x] 避免无 workflow 状态时覆盖 Pi 默认 compaction；有 workflow 状态时保留 previous summary excerpt 与近期非 tool 对话信号。
- [ ] 用历史 tasks 回放 PRD-heavy、implementation-heavy、check/fix-heavy 场景，统计 LLM turns、tool calls、estimated tokens、cache hit rate、恢复成功率。

本轮继续执行结果：

- 已新增 `src/engine/compaction.ts`。
- 已在 `src/index.ts` 注册 `session_before_compact` hook。
- hook 仅在 Pi branch 内存在 `pi-coding-workflow` session entries 时返回自定义 summary；否则让 Pi 使用默认 compaction。
- summary 保留 active task、status/stage、flow level、next action、artifact refs、cache/token 信号、previous summary excerpt、近期 user/assistant 非 tool 信号、read/modified files。
- 已新增 `docs/compaction.md`。
- 已新增 compaction summary 单测并通过 `npm test`（21/21）。

### Phase E：文档与迁移治理

- [x] `docs/runtime-coverage.md`：旧 runtime → 新 TS engine 覆盖矩阵。
- [x] `docs/legacy-file-migration.md`：旧文件废弃/迁移/模板化/项目数据化决策。
- [x] `docs/tool-contract.md`：`workflow_next` / `workflow_run` schema、示例、错误码。
- [x] `docs/initialization-contract.md`：init dry-run/execute 产物契约。
- [x] `docs/telemetry-schema.md`：telemetry/checkpoint/artifact schema。
- [x] `docs/compaction.md`：workflow-aware Pi compaction 行为。

本轮继续执行结果：

- 已补齐 P2 文档矩阵并在 README 增加文档索引。
- 当前仍待后续量化的是历史 task replay metrics 与 subagent/adaptive control 策略。

## 4. 本轮优先级边界

本轮只实施 Phase A，避免一次性引入过多架构变化。以下内容暂不在本轮实现：

- 不新增 `workflow_create_task` / `workflow_check` / `workflow_finish` 等 LLM 工具。
- 不恢复旧 Python engine 或旧 wrapper/命令别名。
- 不把 GameBase 私有规则硬编码进 Unity profile。
- 不实现会替换默认对话摘要的 custom compaction，防止压缩时丢失非 workflow 上下文。
- 不实现 Git commit/push finalizer。

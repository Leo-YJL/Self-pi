# pi-coding-workflow

`pi-coding-workflow` is a generic Pi coding workflow package. It exposes only two LLM-visible workflow tools and keeps workflow complexity inside a TypeScript engine.

## Goals

- Keep Pi's core tool surface small.
- Provide `workflow_next` as a read-only route/context summary tool.
- Provide `workflow_run` as a controlled stage actuator.
- Provide `/workflow-init` for base `.workflow` structure.
- Provide `/workflow-init-spec` for plan-based `generic` / `unity` spec initialization.
- Keep Unity profile generic: no GameBase-specific Core/HotUpdate/Design/ExcelTools/YooAsset/HybridCLR rules.

## Package resources

```json
{
  "pi": {
    "extensions": ["./src/index.ts"],
    "skills": ["./skills"]
  }
}
```

## LLM-visible tools

- `workflow_next`: semantic read-only router. It does not mutate project source, Git, tasks or config; it may update `.workflow/.runtime` cache/session artifacts. It detects root active tasks from `.workflow/tasks/**/task.json`, supports both package camelCase and legacy GameBase snake_case task fields, recommends the next stage action, and defaults to `includeContext: "lite"` with `evidenceRefs`, `omitted`, `tokenBudget`, `adaptiveControl` and `meta` fields. Use `includeContext: "task" | "check" | "finish"` only when details are needed.
- `workflow_run`: controlled actuator for workflow actions. Mutating actions require `mode: "execute"`; dry-run is the default. `start_checked` and `finish_run` run deterministic preflight gates before mutating task state. Results include `nextRecommendedCall`, `artifacts` and `meta`; `action: "batch"` supports deterministic `actions[]` sequences.

Current daily flow:

```text
workflow_next  # default lite route: no PRD/manifest details unless explicitly requested
  -> workflow_run create_from_grill  # create planning task after intake
  -> workflow_run start_checked      # planning/grill -> in_progress/execute
  -> workflow_run checkpoint         # git diff --check + artifact evidence
  -> workflow_run finish_run         # in_progress/execute -> completed/finish
```

`finish_run` marks the task completed but does not run Git commit/push in package v1. Dry-run finish preflight does not require a commit message; execute still requires `message`.

Batch example:

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

In `mode: "dry_run"`, child actions are forced to dry-run even if an item requests execute. In `mode: "execute"`, child actions default to execute unless the item explicitly sets `mode: "dry_run"`.

## PRD, manifest and preflight gates

P1 task quality checks are implemented in TypeScript-only engine modules:

- `src/engine/prd.ts`: reads `.workflow/tasks/<task>/prd.md`, extracts PRD kernel sections, hashes source content, and detects TODO/TBD markers, blocking open questions, final confirmation, and checklist state.
- `src/engine/manifest.ts`: reads `implement.jsonl` / `check.jsonl`, skips `_example` rows, validates `{ file, reason }`, and checks referenced files exist.
- `src/engine/contextBundle.ts`: powers `workflow_next(includeContext="lite|brief|task|check|finish")` with task state, PRD kernel, manifest summary, workspace summary, blockers, warnings, recommended next action and budget metadata.
- `src/engine/validate.ts`: enforces start preflight and finish preflight inside `workflow_run`.

Start preflight blocks incomplete planning tasks when PRD/manifest/final confirmation gates fail. Finish preflight blocks incomplete acceptance criteria, validation plan, Definition of Done, or `git diff --check` failures.

## Pi-native state and token budget

- `workflow_run({ action: "batch", actions: [...] })` supports dry-run planning and execute transactions. Execute batches record a `.workflow/.runtime/transactions/*.json` artifact plus rollback hints for package-owned mutations such as created task directories or task status changes.
- Tool results are compact JSON by default to reduce repeated prompt tokens.
- `workflow_next` reports `evidenceRefs` and `omitted` so the LLM can ask for details only when needed.
- `workflow_next` / `workflow_run` append a lightweight `pi-coding-workflow` session entry through `pi.appendEntry()`. This keeps active task, next action, artifact refs and token-budget metadata available to Pi session state without injecting long workflow logs into LLM context.
- `workflow_next` returns `adaptiveControl`, a compact deterministic/subagent strategy. It recommends when to run workflow preflight first, when to ask the user through Pi UI, and when to follow a research/implement/check/finish brief without adding extra LLM-visible tools.
- `workflow_next` lite/brief calls use a fingerprint-backed workflow cache under `.workflow/.runtime/cache/pi-workflow/context-cache.json`. The cache key includes task state, PRD/manifest/config fingerprints, selected profile/detail/agent and a workspace fingerprint. Cache hits are reported in `cache.hit`, `tokenBudget.cacheHit` and `meta.cacheHit`.
- `workflow_next` / `workflow_run` write schema-versioned telemetry JSONL under `.workflow/.runtime/telemetry/` with 512 KiB daily file rotation.
- The extension registers a `session_before_compact` hook. When Pi compacts a session that contains `pi-coding-workflow` session entries, it emits a workflow-aware compaction summary preserving active task, phase, next action, artifact refs, file ops and recent non-tool conversation signals.

## Commands

```text
/workflow-init --dry-run
/workflow-init --execute
/workflow-init-spec --profile generic --dry-run
/workflow-init-spec --profile unity --dry-run
/workflow-init-spec --execute --plan <plan-id>
/workflow-prd-confirm --task <task-id> --message "confirmed" --execute
```

`/workflow-prd-confirm` records the PRD final confirmation gate through Pi UI (`ctx.ui.editor` + `ctx.ui.confirm`) instead of asking the LLM to relay the confirmation. This keeps human gate text out of repeated model context and writes only the durable PRD evidence.

`/workflow-init-spec` always writes a plan artifact first and execute reads that existing plan. Execute must not rescan and silently generate a different plan.

## First-version profiles

- `generic`: minimum project architecture spec skeleton.
- `unity`: generic Unity project spec and Unity asset spec.

Unity first version creates:

```text
.workflow/spec/modules/unity-project.md
.workflow/spec/modules/unity-assets.md
```

It intentionally does not create `editor-and-build.md`.

## Local tests

```bash
node --test --experimental-strip-types tests/*.test.ts
node --experimental-strip-types -e "import('./src/init/unityScanner.ts').then(()=>console.log('unity scanner import ok'))"
npm run replay:history -- "D:/YJL_AI/GameBase" --variants as_is,planning,in_progress
```

## Limits

- No Python engine.
- No compatibility aliases for old GameBase `workflow.py` commands.
- No default Addressables/YooAsset/AssetBundle rules; resource systems are detected from project facts.
- Git finalizer/auto commit/push and automatic subagent execution remain future package slices.

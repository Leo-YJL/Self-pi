# Runtime Coverage Matrix

Status: package v0.1 slice.

This matrix maps legacy workflow runtime capabilities to the current TypeScript package modules.

| Capability | Current module(s) | Status | Notes / tests |
|---|---|---|---|
| LLM-visible workflow entrypoints | `src/index.ts` | Implemented | Only `workflow_next` / `workflow_run` are registered as tools. |
| Active task discovery | `src/engine/task.ts`, `src/engine/route.ts` | Implemented | Supports package camelCase and legacy snake_case normalization. |
| Workflow route decision | `src/engine/route.ts` | Implemented | planning -> start_checked, in_progress -> implement/check/finish, completed -> archive. |
| Lite context budget | `src/engine/contextBudget.ts`, `src/engine/route.ts` | Implemented | Default `workflow_next` is `includeContext=lite`. |
| PRD kernel parsing | `src/engine/prd.ts` | Implemented | Sections, TODO/TBD, open questions, final confirmation, checklist gates. |
| PRD final confirmation command | `src/engine/prdConfirm.ts`, `src/index.ts` | Implemented | `/workflow-prd-confirm` uses Pi UI instead of LLM relay. |
| Implement/check manifest parsing | `src/engine/manifest.ts` | Implemented | JSONL `{ file, reason }`; skips examples; validates paths and existence. |
| Start preflight | `src/engine/validate.ts`, `src/engine/run.ts` | Implemented | Blocks PRD TODO/open questions/final confirmation/manifest failures. |
| Checkpoint | `src/engine/checkpoint.ts`, `src/engine/run.ts` | Implemented | Runs `git diff --check`, writes schema-versioned checkpoint artifact. |
| Finish preflight | `src/engine/validate.ts`, `src/engine/run.ts` | Implemented | Blocks incomplete acceptance criteria, validation plan, DoD, git diff issues. |
| Batch transactions | `src/engine/run.ts` | Implemented | Dry-run planning, execute transaction artifact, rollback hints. |
| Workspace dirty-file summary | `src/engine/workspace.ts` | Implemented | Classifies dirty files as in-scope/task/unrelated. |
| Workflow context cache | `src/engine/cache.ts`, `src/engine/route.ts` | Implemented | Lite/brief cache under `.workflow/.runtime/cache/pi-workflow/`. |
| Telemetry | `src/engine/telemetry.ts` | Implemented | JSONL under `.workflow/.runtime/telemetry/`, 512 KiB rotation. |
| Pi session lightweight state | `src/index.ts` | Implemented | `pi.appendEntry("pi-coding-workflow", ...)`. |
| Pi-aware compaction | `src/engine/compaction.ts`, `src/index.ts` | Implemented | Hook runs only when workflow session entries exist. |
| Base workspace init | `src/init/initWorkspace.ts` | Implemented | Creates config/tasks/spec/runtime skeleton and `.gitignore` runtime entry. |
| Plan-based spec init | `src/init/specPlan.ts`, `src/init/initSpec.ts` | Implemented | Dry-run plan artifact, execute existing plan only. |
| Unity project scanning | `src/init/unityScanner.ts` | Implemented | Generic Unity facts; no GameBase hard-coding. |
| Git commit/push finalizer | n/a | Not implemented | Reserved for future slice; package v0.1 does not commit/push. |
| Automatic rollback execution | n/a | Not implemented | Current rollback hints are advisory. |
| Historical task replay metrics | n/a | Pending | Planned PRD-heavy / implementation-heavy / check-fix replay. |
| Subagent orchestration | n/a | Pending | Strategy remains deterministic preflight first; subagent brief later. |

## Test coverage

Current local test command:

```bash
npm test
```

Covered in `tests/init-spec.test.ts`:

- config and path policy
- Unity scanner
- workspace/spec init
- artifact writer
- route and task state transitions
- PRD kernel / manifest helpers
- lite context and cache hit
- PRD final confirmation engine
- batch transaction artifacts and rollback hints
- telemetry schema
- start and finish preflight blockers

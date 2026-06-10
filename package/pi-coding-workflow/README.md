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

- `workflow_next`: read-only router. It does not mutate files, Git, tasks or config. It detects root active tasks from `.workflow/tasks/**/task.json`, supports both package camelCase and legacy GameBase snake_case task fields, and recommends the next stage action.
- `workflow_run`: controlled actuator for workflow actions. Mutating actions require `mode: "execute"`; dry-run is the default.

Current daily flow:

```text
workflow_next
  -> workflow_run create_from_grill  # create planning task after intake
  -> workflow_run start_checked      # planning/grill -> in_progress/execute
  -> workflow_run checkpoint         # git diff --check + artifact evidence
  -> workflow_run finish_run         # in_progress/execute -> completed/finish
```

`finish_run` marks the task completed but does not run Git commit/push in package v1.

## Commands

```text
/workflow-init --dry-run
/workflow-init --execute
/workflow-init-spec --profile generic --dry-run
/workflow-init-spec --profile unity --dry-run
/workflow-init-spec --execute --plan <plan-id>
```

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
```

## Limits

- No Python engine.
- No compatibility aliases for old GameBase `workflow.py` commands.
- No default Addressables/YooAsset/AssetBundle rules; resource systems are detected from project facts.
- Package v1 has lightweight task validation; full legacy PRD kernel, context-budget, subagent brief, adaptive control and Git finalizer behavior are future package slices.

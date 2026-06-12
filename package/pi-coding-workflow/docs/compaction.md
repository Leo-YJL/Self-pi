# Workflow-aware Pi Compaction

Status: package v0.1 slice.

`pi-coding-workflow` registers a Pi `session_before_compact` hook. The hook is intentionally narrow:

- If the current Pi branch has no `pi-coding-workflow` session entries, the hook returns `undefined` and Pi uses its default compaction.
- If workflow entries exist, the hook provides a deterministic workflow-aware summary instead of asking the model to summarize workflow logs.

## Preserved fields

The summary keeps:

- active task id
- status / stage / flow level
- next workflow action
- last workflow run action and mode
- workflow cache hit / estimated token metadata when available
- artifact refs and omitted refs
- previous compaction summary excerpt if available
- recent non-tool user/assistant conversation snippets
- read/modified files from Pi compaction fileOps

The summary also recommends resuming with:

```text
workflow_next({ includeContext: "lite", task: <activeTask> })
```

## Why deterministic?

The workflow state is already structured in `pi.appendEntry("pi-coding-workflow", ...)` entries. A deterministic summary avoids repeatedly sending large workflow tool results, PRD snippets and logs to the model during compaction.

## Safety notes

- The hook does not run when no workflow state has been recorded.
- It includes recent non-tool conversation snippets to avoid dropping immediate human intent.
- It includes previous compaction summary text when Pi provides one.
- The summary is not a replacement for durable project facts. Durable facts still belong in `.workflow/spec/**` and task PRDs.

## Implementation

- Hook registration: `src/index.ts`
- Summary builder: `src/engine/compaction.ts`
- Session state source: lightweight entries appended by `workflow_next` / `workflow_run` through `pi.appendEntry("pi-coding-workflow", ...)`

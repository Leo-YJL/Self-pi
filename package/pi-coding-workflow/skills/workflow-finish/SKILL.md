---
name: workflow-finish
description: Finish workflow tasks through workflow_next and workflow_run finish_run dry-run/execute.
---
# workflow-finish

Use this generic skill only for active coding workflow projects using `pi-coding-workflow`.

## Rules

- Prefer `workflow_next({ agent: "finish", includeContext: "signal" })` for low-token read-only routing and finish-gate adaptive guidance; request finish context only when evidence refs are insufficient.
- If `adaptiveControl.strategy` is `deterministic_preflight`, follow the suggested `workflow_run` call. Safe execute paths run preflight first and return blockers without mutating when gates fail; use dry-run when the user wants a preview.
- If `adaptiveControl.strategy` is `subagent_brief`, prefer the recommended `workflow_delegate` finish dry-run/execute path; otherwise follow the returned `finish` brief manually and only mark PRD checklist items complete when evidence exists.
- Prefer `workflow_run` for controlled workflow actions.
- Use `workflow_run archive` only after `finish_run` succeeds and the user explicitly confirms; use `reopen` only with explicit confirmation and a reason. `reopen` returns a completed task to `in_progress/execute`; it does not reopen Stage 1 grill.
- `reopen` is for implementation rework only, not requirements changes: after `reopen`, the task is `in_progress/execute`, Stage 1 grill stays finalized, and editing the PRD will invalidate the prior final confirmation. If requirements must change, create a new task instead of reopening; `finalize_grill` requires the `planning` state and cannot be re-entered from a reopened task.
- Maintain manifest scope with deterministic manifest actions instead of hand-written JSONL.
- Do not use deprecated prompt wrappers or legacy command aliases.
- Keep project-specific facts in the project `.workflow/spec/**` overlay.
- Preserve unrelated dirty files.

---
name: workflow-finish
description: Finish workflow tasks through workflow_next and workflow_run finish_run dry-run/execute.
---
# workflow-finish

Use this generic skill only for active coding workflow projects using `pi-coding-workflow`.

## Rules

- Prefer `workflow_next({ agent: "finish" })` for read-only routing and finish-gate adaptive guidance.
- If `adaptiveControl.strategy` is `deterministic_preflight`, run the suggested `workflow_run finish_run` dry-run before editing checklist state.
- If `adaptiveControl.strategy` is `subagent_brief`, prefer the recommended `workflow_delegate` finish dry-run/execute path; otherwise follow the returned `finish` brief manually and only mark PRD checklist items complete when evidence exists.
- Prefer `workflow_run` for controlled workflow actions.
- Do not use deprecated prompt wrappers or legacy command aliases.
- Keep project-specific facts in the project `.workflow/spec/**` overlay.
- Preserve unrelated dirty files.

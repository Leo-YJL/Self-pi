---
name: workflow-check
description: Check current diff against task context and spec; run workflow checkpoint where available.
---
# workflow-check

Use this generic skill only for active coding workflow projects using `pi-coding-workflow`.

## Rules

- Prefer `workflow_next({ agent: "check" })` for read-only routing and adaptive check guidance.
- If `adaptiveControl.strategy` is `deterministic_preflight`, run the suggested `workflow_run` preflight before free-form checking.
- If `adaptiveControl.strategy` is `subagent_brief`, follow the returned `check` brief: use evidence refs first, inspect details only when necessary, classify failures as task-related/unrelated/environment.
- Prefer `workflow_run` for controlled workflow actions.
- Do not use deprecated prompt wrappers or legacy command aliases.
- Keep project-specific facts in the project `.workflow/spec/**` overlay.
- Preserve unrelated dirty files.

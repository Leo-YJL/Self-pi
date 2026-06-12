---
name: workflow-break-loop
description: Analyze repeated failures and capture prevention rules.
---
# workflow-break-loop

Use this generic skill only for active coding workflow projects using `pi-coding-workflow`.

## Rules

- Prefer `workflow_next` for read-only routing and inspect `adaptiveControl.reasons`, blockers and stop conditions.
- If repeated failures map to a specific adaptive agent, follow that subagent brief instead of retrying the same broad action.
- Capture durable prevention rules in `.workflow/spec/**` when the loop reveals reusable project knowledge.
- Prefer `workflow_run` for controlled workflow actions.
- Do not use deprecated prompt wrappers or legacy command aliases.
- Preserve unrelated dirty files.

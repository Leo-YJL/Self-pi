---
name: workflow-update-spec
description: Capture durable project knowledge into .workflow/spec when a task creates reusable rules.
---
# workflow-update-spec

Use this generic skill only for active coding workflow projects using `pi-coding-workflow`.

## Rules

- Prefer `workflow_next` for read-only routing and use `adaptiveControl.contextRefs` to decide which evidence needs inspection.
- Update `.workflow/spec/**` only for durable project knowledge, not transient task status or runtime artifacts.
- Prefer `workflow_run` for controlled workflow actions; spec edits themselves are intentionally normal file edits because no `update_spec_section` action exists yet.
- If spec changes alter task implementation/check scope, update manifests with deterministic manifest actions.
- Do not use deprecated prompt wrappers or legacy command aliases.
- Keep project-specific facts in the project `.workflow/spec/**` overlay.
- Preserve unrelated dirty files.

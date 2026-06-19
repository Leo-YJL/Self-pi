---
name: workflow-check
description: Check current diff against task context and spec; run workflow checkpoint where available.
---
# workflow-check

Use this generic skill only for active coding workflow projects using `pi-coding-workflow`.

## Rules

- Prefer `workflow_next({ agent: "check", includeContext: "signal" })` for low-token read-only routing; request lite/task/check context only when evidence refs are insufficient.
- If `adaptiveControl.strategy` is `deterministic_preflight`, run the suggested `workflow_run` preflight before free-form checking.
- If `adaptiveControl.strategy` is `subagent_brief`, prefer the recommended `workflow_delegate` check dry-run/execute path; otherwise follow the returned `check` brief manually: use evidence refs first, inspect details only when necessary, classify failures as task-related/unrelated/environment.
- Prefer `workflow_run` for controlled workflow actions.
- Maintain `implement.jsonl` / `check.jsonl` with `workflow_run` actions (`init_manifests`, `upsert_manifest_entry`, `remove_manifest_entry`) using `mode=auto` (they run preflight first; no separate dry_run needed). For `sync_manifest_from_diff`, use dry-run candidates plus explicit entries/reasons before execute.
- When a grep/rg command is intended to prove absence, use an explicit non-failing pattern such as `rg -n "pattern" path -S || true` and state that no matches is expected.
- Do not use deprecated prompt wrappers or legacy command aliases.
- Keep project-specific facts in the project `.workflow/spec/**` overlay.
- Preserve unrelated dirty files.

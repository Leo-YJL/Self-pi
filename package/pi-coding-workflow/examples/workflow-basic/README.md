# workflow-basic walkthrough

This example documents the expected `pi-coding-workflow` happy path for a small TypeScript task.

## Flow

1. Initialize the workflow directory:

   ```text
   /workflow-init --execute
   ```

2. Create a task. `level` may be omitted when `.workflow/config.json` defines `workflow.defaultFlowLevel`:

   ```json
   { "action": "create_from_grill", "mode": "execute", "title": "Add greeting helper", "level": "simple" }
   ```

3. Record grill decisions and update the PRD with `record_round_and_update_prd`.

4. Record PRD final confirmation through the command/UI:

   ```text
   /workflow-prd-confirm --task <task-id> --message "Confirmed: proceed with the PRD." --execute
   ```

5. Initialize and fill manifests using deterministic actions, not hand-written JSONL:

   ```json
   { "action": "init_manifests", "mode": "execute", "task": "<task-id>" }
   { "action": "upsert_manifest_entry", "mode": "execute", "task": "<task-id>", "manifest": "implement", "file": "examples/workflow-basic/src/main.ts", "reason": "Implementation target" }
   { "action": "upsert_manifest_entry", "mode": "execute", "task": "<task-id>", "manifest": "check", "file": "examples/workflow-basic/tests/main.test.ts", "reason": "Validation target" }
   ```

6. Run start preflight, implement, checkpoint, finish, then archive:

   ```json
   { "action": "start_checked", "mode": "dry_run", "task": "<task-id>" }
   { "action": "start_checked", "mode": "execute", "task": "<task-id>" }
   { "action": "checkpoint", "mode": "dry_run", "task": "<task-id>", "phase": "after-implementation" }
   { "action": "finish_run", "mode": "dry_run", "task": "<task-id>" }
   { "action": "finish_run", "mode": "execute", "task": "<task-id>", "message": "Implemented and validated." }
   { "action": "archive", "mode": "execute", "task": "<task-id>", "userConfirmed": true }
   ```

## Files

- `src/main.ts` — toy implementation target.
- `tests/main.test.ts` — toy validation target.

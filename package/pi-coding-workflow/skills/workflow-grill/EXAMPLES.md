# Workflow Grill Tool Examples

These examples are illustrative. Current tool schemas and workflow engine behavior are authoritative.

## Detect workflow state

```json
{
  "includeContext": "signal"
}
```

Use with `workflow_next` before creating/selecting a task, at stage boundaries, and when blocker/adaptive feedback is needed. Request `lite`/`task` only when signal refs are insufficient. Do not call it after every PRD child update.

## Create a PRD-first grill task

Dry-run first:

```json
{
  "action": "create_from_grill",
  "mode": "dry_run",
  "title": "Add avatar upload validation",
  "level": "standard"
}
```

Then execute:

```json
{
  "action": "create_from_grill",
  "mode": "execute",
  "title": "Add avatar upload validation",
  "level": "standard"
}
```

## Default: record one round and update PRD in one call

Use `record_round_and_update_prd` after each business answer round. It records decisions, applies PRD section updates, and appends missing `## Grill Decision Log` rows in one `workflow_run` call.

```json
{
  "action": "record_round_and_update_prd",
  "mode": "execute",
  "task": "06-13-avatar-upload-validation",
  "roundId": "round-1-scope",
  "roundKind": "scope",
  "decisions": [
    {
      "decisionId": "avatar.scope.file-types",
      "decisionSource": "ask_user_question",
      "decisionSeverity": "blocking",
      "decisionSummary": "Avatar uploads accept PNG and JPEG only; GIF/WebP are out of scope.",
      "persistTo": "prd"
    },
    {
      "decisionId": "avatar.scope.legacy-behavior",
      "decisionSource": "ask_user_question",
      "decisionSeverity": "blocking",
      "decisionSummary": "Existing valid PNG/JPEG avatar uploads must continue to succeed without API response shape changes.",
      "persistTo": "prd"
    }
  ],
  "prdUpdates": [
    {
      "prdSection": "requirements",
      "prdUpdateMode": "replace",
      "prdContent": "- R1: Accept PNG and JPEG avatar uploads only.\n- R2: Reject unsupported MIME types with the existing validation error format.\n- R3: Preserve the existing response shape for valid uploads."
    },
    {
      "prdSection": "outOfScope",
      "prdUpdateMode": "replace",
      "prdContent": "- GIF/WebP avatar processing is out of scope.\n- API response shape redesign is out of scope."
    },
    {
      "prdSection": "openQuestions",
      "prdUpdateMode": "replace",
      "prdContent": "None."
    }
  ]
}
```

Notes:

- Omit `appendPrdDecisions` or set it to `true` for the normal path.
- Set `appendPrdDecisions: false` only when you intentionally maintain the decision log another way.
- Use this for business rounds only. Final confirmation still uses `/workflow-prd-confirm` plus `finalize_grill`.

## Fallback: separate decision recording

Use separate calls only when the composite action cannot express the update.

```json
{
  "action": "record_grill_decision",
  "mode": "execute",
  "task": "06-13-avatar-upload-validation",
  "roundId": "round-1-scope",
  "roundKind": "scope",
  "decisionId": "avatar.scope.file-types",
  "decisionSource": "ask_user_question",
  "decisionSeverity": "blocking",
  "decisionSummary": "Avatar uploads accept PNG and JPEG only; GIF/WebP are out of scope.",
  "persistTo": "prd"
}
```

## Fallback: update a structured PRD section

```json
{
  "action": "update_prd_section",
  "mode": "execute",
  "task": "06-13-avatar-upload-validation",
  "prdSection": "requirements",
  "prdUpdateMode": "replace",
  "prdContent": "- R1: Accept PNG and JPEG avatar uploads only.\n- R2: Reject unsupported MIME types with the existing validation error format.\n- R3: Preserve the existing response shape for valid uploads."
}
```

Common `prdSection` values:

- `executionContract`
- `goal`
- `requirements`
- `acceptanceCriteria`
- `validationPlan`
- `openQuestions`
- `outOfScope`
- `definitionOfDone`
- `architectureImpact`

## Fallback: append missing decisions to the PRD decision log

```json
{
  "action": "append_prd_decisions",
  "mode": "execute",
  "task": "06-13-avatar-upload-validation"
}
```

This writes recorded business decisions that are still missing from `## Grill Decision Log`.

## Record final PRD confirmation

After the user reviews the latest PRD and confirms it, use the command form so the hash is written by the workflow engine:

```text
/workflow-prd-confirm --task 06-13-avatar-upload-validation --message "User confirms this PRD is ready for implementation." --execute
```

Do not hand-write the confirmation hash.

## Finalize Stage 1 grill

Dry-run first:

```json
{
  "action": "finalize_grill",
  "mode": "dry_run",
  "task": "06-13-avatar-upload-validation",
  "userConfirmed": true,
  "decisionSource": "ask_user_question",
  "notes": "User confirmed the current PRD is ready for implementation."
}
```

Then execute:

```json
{
  "action": "finalize_grill",
  "mode": "execute",
  "task": "06-13-avatar-upload-validation",
  "userConfirmed": true,
  "decisionSource": "ask_user_question",
  "notes": "User confirmed the current PRD is ready for implementation."
}
```

After finalization, run `workflow_next({ "includeContext": "signal" })` and report the next recommended workflow step.

## Common finalize blockers

If `finalize_grill` fails, fix the blocker instead of forcing start:

- `grill_min_rounds_not_met`: ask another business round or verify whether the task flow level is too high.
- `prd_missing_grill_decision`: run `record_round_and_update_prd` or `append_prd_decisions` so each business `decisionId` appears literally.
- `grill_prd_revision_missing_after_round`: update the PRD after the recorded round.
- `prd_final_confirmation_missing`: run `/workflow-prd-confirm` after user review.
- `prd_changed_after_final_confirmation`: ask the user to review and confirm the latest PRD again.
- `prd_open_questions_blocking`: resolve or explicitly close open questions.
- `prd_todo_present`: replace `TODO` / `TBD` markers with concrete content.
